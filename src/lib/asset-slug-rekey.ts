/**
 * One-time migration: move a FORKED page's image assets onto its own slug.
 *
 * THE SHAPE BEING REPAIRED (DW-738). `ingestImage` mints an image's storage key
 * from `slugify(title)` before `ingest()` has settled the page slug, because
 * the key is embedded in the body it hands over. When the realm-fork guard then
 * uniquifies that slug — the actor's ingest landed on another owner's PRIVATE
 * page — the new page is written at `<base>-<n>` while its image is still under
 * `assets/<base>/`. `/api/assets/[...path]` reads that first segment as the
 * page slug, so it gates the forked page's own image on the OTHER page's
 * visibility.
 *
 * BOTH ROOTS ARE REPAIRED, because both serve the bytes. The flat
 * `raw/assets/<slug>/<file>` key is what `/api/assets/[...path]` reads; the
 * per-tenant mirror `tenants/<tenant>/raw/assets/<slug>/<file>` that
 * `syncSiloForPage` produced is what the Workbench and `/api/v1` file doors
 * read, and they gate `raw/assets/<base>/…` on the BASE page. Moving only the
 * flat key would leave the base owner still listing and downloading the forked
 * page's image from their own silo, while the forked owner's tenant never
 * gained the bytes at all. So a completed re-key also mirrors the new key into
 * the FORKED page's tenant and, when the flat source key is actually reclaimed,
 * removes the base owner's tenant copy alongside it.
 *
 * `ingest()` re-keys at the source now, so nothing new arrives mis-keyed. This
 * repairs the directories a deployment already holds, and its only trigger is
 * `POST /api/tasks/scan` (see `maintenance.rekeyForkedAssets`).
 *
 * SCOPE IS DELIBERATELY THE UNIQUIFIER'S OWN SHAPE, nothing wider: a page
 * slugged `<base>-<n>` whose body references `assets/<base>/…` while a page
 * slugged `<base>` actually exists. Any looser rule ("this ref's first segment
 * isn't my slug") would sweep up hand-authored refs and legitimately shared
 * images, and the cost of missing a fork is a mis-gated image, not a broken
 * page. `assets/illustrations/<key>.jpg` is excluded outright — that first
 * segment is a fixed directory naming no page, it is a SHARED cache baked into
 * saved answers and slides, and re-keying it would break every reference to it.
 *
 * IDEMPOTENT by construction: the rewrite leaves the body pointing at
 * `assets/<slug>/…`, which no longer matches the pattern above, so a second run
 * finds nothing. FAIL-SOFT per REF, not per page: one unreadable key must not
 * cost the genuinely mis-keyed ref beside it, because "the next scan retries"
 * is false for a ref that fails deterministically — it would fail identically
 * forever, and the bytes copied for the refs before it would be orphaned.
 *
 * THE DELETE IS THE CONSERVATIVE HALF, and its guard is only as good as the
 * bodies it read. The keys are content-addressed, so a source key may
 * legitimately hold bytes the base page also embeds (two uploads of one image).
 * The old key is removed only when no page whose body this run COULD READ still
 * references it — and if ANY page's body read failed, the whole reclamation
 * phase is skipped, because a page that contributed no refs is
 * indistinguishable from a page that references the key. Copies are cheap;
 * deleting bytes a page still embeds is not.
 */

import { logger } from "./logger";
import {
  listWikiPages,
  readWikiPage,
  rawRelPath,
  tenantForOwner,
  tenantRawRelPath,
} from "./wiki";
import { assetRefPath } from "./fetch";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { getStorage } from "./storage";
import type { IndexEntry } from "./types";

/** The fixed, page-less first segment the shared illustration cache uses. */
const SHARED_ASSET_DIRS = new Set(["illustrations"]);

/**
 * The uniquifier's shape: `<base>-<n>` with a numeric tail, anchored at both
 * ends. The base group is GREEDY, and that is what makes it correct:
 * `findFreeSlug` appends `-2`, `-3`, … to a slug that may itself end in digits,
 * so `gpt-4-2` has to resolve to base `gpt-4` (greedy) rather than `gpt`
 * (lazy). The base still has to name a real page before anything is moved, so a
 * wrong split declines instead of mis-keying.
 */
const FORK_SUFFIX = /^(.+)-(\d+)$/;

/**
 * Every `assets/<dir>/<file>` reference a page body spells — and NOTHING that
 * merely contains those characters.
 *
 * The lookbehind requires the ref to start the string or follow a delimiter, so
 * an absolute URL (`https://cdn.example.com/assets/photo/pic.png`) and a
 * storage key written out in prose (`raw/assets/photo/pic.png`) are not read as
 * page refs — re-keying either would corrupt text this migration has no
 * business touching. The trailing lookahead forbids a name character or a
 * slash, which is what stops a NESTED path from being truncated into a false
 * ref: without it `assets/photo/sub/f.png` backtracks into the "file" `sub`,
 * and the copy that follows reads a key that does not exist.
 */
const ASSET_REF = /(?<![^\s("'[])assets\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._\-/])/g;

/** Every distinct `assets/<dir>/<file>` reference in one body. */
function assetRefsIn(content: string): Set<string> {
  const refs = new Set<string>();
  for (const m of content.matchAll(ASSET_REF)) refs.add(m[0]);
  return refs;
}

/** Split `assets/<dir>/<file>` back into its two parts. */
function splitRef(ref: string): { dir: string; file: string } | null {
  const parts = ref.split("/");
  if (parts.length !== 3 || parts[0] !== "assets") return null;
  return { dir: parts[1], file: parts[2] };
}

/**
 * The per-tenant mirror address for one asset ref, or `null` when the entry
 * names no owner (a legacy index row) — there is no tenant to mirror into then,
 * and guessing one would write into somebody else's silo.
 */
function tenantAssetPath(owner: string | undefined, ref: string): string | null {
  if (!owner || owner.trim() === "") return null;
  try {
    return tenantRawRelPath(tenantForOwner(owner), ref);
  } catch {
    // `validateTenant` refused the derived tenant — nothing to mirror.
    return null;
  }
}

/** A source ref this run copied, and where its tenant twin lives. */
interface MovedRef {
  /** `assets/<base>/<file>` — the pre-fork key. */
  from: string;
  /** The base page's owner, for the tenant copy that shadows `from`. */
  baseOwner: string | undefined;
}

/**
 * Re-key every already-forked page's image directory onto the page's own slug.
 *
 * Returns the number of ASSETS re-keyed (not pages rewritten) — 0 on an empty
 * or already-migrated deployment, which is what every scan after the first one
 * reports.
 */
export async function rekeyForkedPageAssets(): Promise<number> {
  const entries: IndexEntry[] = await listWikiPages();
  if (entries.length === 0) return 0;
  const entryBySlug = new Map(entries.map((e) => [e.slug, e]));

  // CANDIDATES FIRST, bodies second. The delete guard below wants every page's
  // refs, but that is a full-corpus uncached read, and a migrated deployment
  // would otherwise pay it on every scan forever just to discover there is
  // nothing to do. The slug shape is free — it comes from the index rows
  // already in hand — so the common "nothing to repair" answer costs no page
  // reads at all.
  const candidates = entries.filter((entry) => {
    const forked = FORK_SUFFIX.exec(entry.slug);
    if (!forked) return false;
    const base = forked[1];
    return base !== entry.slug && entryBySlug.has(base);
  });
  if (candidates.length === 0) return 0;

  const bodies = new Map<string, string>();
  /**
   * Did any body read FAIL (as opposed to answering "no such page")? The delete
   * guard cannot distinguish a page that references nothing from a page whose
   * refs it never saw, so one failure disarms reclamation entirely.
   */
  let readFailed = false;

  async function loadBody(slug: string): Promise<void> {
    if (bodies.has(slug)) return;
    try {
      const page = await readWikiPage(slug, { fresh: true, strict: true });
      if (page) bodies.set(slug, page.content);
    } catch (err) {
      readFailed = true;
      logger.warn("asset-rekey", `skipping unreadable page "${slug}"`, err);
    }
  }

  // The candidates' own bodies decide whether there is any work at all.
  for (const entry of candidates) await loadBody(entry.slug);

  /** `slug → [refs to move]`, for the candidates that actually have any. */
  const work = new Map<string, string[]>();
  for (const entry of candidates) {
    const content = bodies.get(entry.slug);
    if (content === undefined) continue;
    const base = FORK_SUFFIX.exec(entry.slug)![1];
    const stale = [...assetRefsIn(content)].filter((ref) => {
      const parts = splitRef(ref);
      return (
        parts !== null && parts.dir === base && !SHARED_ASSET_DIRS.has(parts.dir)
      );
    });
    if (stale.length > 0) work.set(entry.slug, stale);
  }
  if (work.size === 0) return 0;

  // Only now is the full-corpus read earned: something is going to move, so the
  // delete guard needs to know which OTHER pages still spell these keys.
  for (const entry of entries) await loadBody(entry.slug);

  const refsByPage = new Map<string, Set<string>>();
  for (const [slug, content] of bodies) refsByPage.set(slug, assetRefsIn(content));

  const storage = getStorage();
  let rekeyed = 0;
  const movedFrom: MovedRef[] = [];

  for (const entry of candidates) {
    const stale = work.get(entry.slug);
    if (!stale) continue;
    const content = bodies.get(entry.slug)!;
    const base = FORK_SUFFIX.exec(entry.slug)![1];

    let rewritten = content;
    const movedThisPage: string[] = [];
    /** New keys to mirror into this page's tenant once the rewrite lands. */
    const mirror: Array<{ key: string; bytes: ArrayBuffer }> = [];

    for (const ref of stale) {
      const file = splitRef(ref)!.file;
      const target = assetRefPath(entry.slug, file);
      try {
        const bytes = await storage.readAsset(rawRelPath(ref));
        // Content-addressed keys — an occupied destination already holds these
        // exact bytes, so create-only is the right door (FR-2).
        await storage.writeAssetIfAbsent(rawRelPath(target), bytes);
        const tenantPath = tenantAssetPath(entry.owner, target);
        if (tenantPath) mirror.push({ key: tenantPath, bytes });
        rewritten = rewritten.split(ref).join(target);
        movedThisPage.push(ref);
      } catch (err) {
        // JUST THIS REF. Abandoning the page would make a deterministically
        // unreadable key (a ref to bytes nobody stored) permanently block the
        // repair of the mis-keyed ref beside it, on every scan, forever.
        logger.warn("asset-rekey", `asset copy failed for ${ref}`, err);
      }
    }
    if (movedThisPage.length === 0) continue;

    try {
      await writeWikiPageWithSideEffects({
        slug: entry.slug,
        title: entry.title,
        content: rewritten,
        summary: entry.summary,
        logOp: "edit",
        logDetails: () => `re-keyed forked page assets off "${base}"`,
        // No cross-ref pass: this rewrites an asset path, not prose, and
        // re-linking here would be an unattended content edit.
        crossRefSource: null,
        author: "system",
        revisionReason: "forked-asset re-key",
        expectedContent: content,
      });
    } catch (err) {
      // The page still points at the originals, so the copies made above are
      // inert and the next scan retries.
      logger.warn("asset-rekey", `page rewrite failed for "${entry.slug}"`, err);
      continue;
    }

    // Only AFTER the rewrite lands: the silo mirrors what the page says, so
    // seeding a tenant for a rewrite that then failed would plant bytes no page
    // references. Fail-soft — the flat key is what `/api/assets/[...path]`
    // reads, and `syncSiloForPage` re-mirrors on the page's next write anyway.
    for (const { key, bytes } of mirror) {
      try {
        await storage.writeAssetIfAbsent(key, bytes);
      } catch (err) {
        logger.warn("asset-rekey", `tenant mirror failed for ${key}`, err);
      }
    }

    // The rewrite landed — this page no longer references the old keys.
    refsByPage.set(entry.slug, assetRefsIn(rewritten));
    rekeyed += movedThisPage.length;
    for (const ref of movedThisPage) {
      movedFrom.push({ from: ref, baseOwner: entryBySlug.get(base)?.owner });
    }
  }

  if (readFailed) {
    // Disarmed, deliberately: see the docblock. The copies stand and the next
    // scan reclaims once every body is readable again.
    logger.warn(
      "asset-rekey",
      "skipping reclamation — at least one page body could not be read",
    );
  } else {
    // Reclaim the pre-fork keys nothing references any more. Deliberately after
    // EVERY rewrite: two forked pages can share one source directory, and a
    // per-page delete would strand the second one's read.
    const seen = new Set<string>();
    for (const moved of movedFrom) {
      if (seen.has(moved.from)) continue;
      seen.add(moved.from);
      if ([...refsByPage.values()].some((refs) => refs.has(moved.from))) continue;
      try {
        await storage.deleteFile(rawRelPath(moved.from));
      } catch (err) {
        // The bytes are already readable at the new key, so an orphaned copy is
        // the worst case — never a reason to fail the migration.
        logger.warn("asset-rekey", `could not remove stale key ${moved.from}`, err);
        continue;
      }
      // The flat key is gone, so the BASE owner's silo copy of it is the last
      // place serving the forked page's image off the base page's slug — and
      // the Workbench/`/api/v1` doors read exactly that root. Only reached when
      // the flat delete succeeded, so this can never outlive its own guard.
      const tenantPath = tenantAssetPath(moved.baseOwner, moved.from);
      if (!tenantPath) continue;
      try {
        // Existence-checked rather than delete-and-swallow: a deployment that
        // never mirrored has no tenant copy, and turning that ordinary state
        // into a warning on every reclaimed key would train the log to be
        // ignored.
        if (!(await storage.fileExists(tenantPath))) continue;
        await storage.deleteFile(tenantPath);
      } catch (err) {
        logger.warn("asset-rekey", `could not remove tenant copy ${tenantPath}`, err);
      }
    }
  }

  if (rekeyed > 0) {
    logger.info("asset-rekey", `re-keyed ${rekeyed} forked page asset(s)`);
  }
  return rekeyed;
}
