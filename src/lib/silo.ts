/**
 * Per-tenant silo utilities (tenant-silos P5a).
 *
 * Each tenant's folder `tenants/<tenant>/…` is the PRIMARY storage location
 * for that owner's pages — a self-contained vault (Obsidian-servable).
 * lifecycle.ts writes silo-primary (tenants/<tenant>/wiki/<slug>.md) and
 * readWikiPage tries the silo path first, falling back to the legacy flat
 * path during the transition (#869). A redundant flat copy is still written
 * during the transition but will be removed once flat retirement completes.
 *
 * Workbench Files/Preview isolation (DW-40): the flat tree is now wiki-only
 * for listing and reads. `raw/` resolves strictly inside the owner's silo and
 * never falls back to the shared flat `raw/` root — an empty tenant raw silo
 * is empty, not a window onto legacy shared sources. Ingest may still write a
 * transitional flat raw copy for older callers; the Workbench will not show it.
 *
 * Artifacts stored per page: wiki md, raw source, revision history, discussion
 * threads, and binary assets. The embedding vector store is internal (not part
 * of the vault) and stays global.
 */

import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import {
  wikiRelPath,
  rawRelPath,
  tenantWikiRelPath,
  tenantRawRelPath,
  tenantForOwner,
  validateTenant,
} from "./wiki";
import {
  RAW_ASSETS_DIR,
  RAW_STRUCTURAL_DIRS,
  isRawSnapshotName,
  rawSourceRelPath,
  tenantRawSourceRelPath,
} from "./raw";
import { logger } from "./logger";

async function copyText(src: string, dst: string): Promise<boolean> {
  const storage = getStorage();
  let content: string;
  try {
    content = await storage.readFile(src);
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  await storage.writeFile(dst, content);
  return true;
}

async function copyAsset(src: string, dst: string): Promise<boolean> {
  const storage = getStorage();
  let data: ArrayBuffer;
  try {
    data = await storage.readAsset(src);
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  await storage.writeAsset(dst, data);
  return true;
}

async function listSafe(prefix: string) {
  try {
    return await getStorage().listFiles(prefix);
  } catch (e) {
    if (isEnoent(e)) return [];
    throw e;
  }
}

async function deleteSafe(path: string): Promise<void> {
  try {
    await getStorage().deleteFile(path);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

async function deleteDirSafe(path: string): Promise<void> {
  try {
    await getStorage().deleteDirectory(path);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

/**
 * Mirror the PAGE-OWNED entries of one hashed directory into the silo, and
 * return how many were copied.
 *
 * "Page-owned" is `isRawSnapshotName` — a content-addressed `<hex>.<ext>`,
 * where `<hex>` is a digest at one of the two lengths the writers mint (16 or
 * 64; see `RAW_ID_RE` in `raw.ts`), so an import file with a short hex stem
 * like `2024.pdf` is NOT page-owned and is not mirrored (DW-744) —
 * because `raw/sources/<name>/` is SHARED: `saveRawSourceFor`/
 * `saveRawSourceBytes` address it by page slug while `saveRawSourceTree`
 * addresses it by folder-import root, so a page slugged like an import root
 * would otherwise pull that import's top-level files — possibly another
 * owner's — into its silo (DW-611). Subdirectories are skipped for the same
 * reason the assets loop skips them (imports nest), dotfiles because
 * `.DS_Store` is not a Source and mirroring one would make it Workbench-visible
 * in Files.
 *
 * `copyAsset`, not `copyText`: `saveRawSourceBytes` publishes PDFs/DOCX/JPEGs
 * into the same namespace as the extracted `.md`, and a UTF-8 round-trip would
 * mangle them.
 *
 * The mirrored-name Set is a COST BOUND, not a concurrency guarantee: it keeps
 * a re-sync from re-copying keys that never change, the same bound the revision
 * and asset loops carry for the Workers subrequest budget. It is NOT the
 * create-only door `mirrorSourceToSilo`/`storeRawSourceBytes` use
 * (`writeFileIfAbsent`/`writeAssetIfAbsent`) — `copyAsset` ends in an
 * unconditional `writeAsset`, so the check-then-write window is open here. That
 * is safe precisely because the names are content-addressed: a racing mirror
 * writes byte-identical bytes to the key it already occupies.
 *
 * The FLAT side is listed FIRST and the silo side is not listed AT ALL when no
 * page-owned candidate survives, so a slug with no hashed tree under this root
 * pays one missing-directory listing and stops — the bound that keeps calling
 * this for two roots from doubling every flat-only page's sync cost.
 */
async function mirrorHashedTree(
  flatPrefix: string,
  siloPrefix: string,
): Promise<number> {
  const candidates = (await listSafe(flatPrefix)).filter(
    (f) =>
      !f.isDirectory && !f.name.startsWith(".") && isRawSnapshotName(f.name),
  );
  if (candidates.length === 0) return 0;
  const mirrored = new Set((await listSafe(siloPrefix)).map((f) => f.name));
  let copied = 0;
  for (const f of candidates) {
    if (mirrored.has(f.name)) continue;
    if (await copyAsset(`${flatPrefix}/${f.name}`, `${siloPrefix}/${f.name}`))
      copied++;
  }
  return copied;
}

/**
 * Remove one page's snapshots from a silo hashed directory, and the directory
 * itself only when nothing foreign was left in it.
 *
 * The recursive `deleteDirectory` this replaces was correct only while the
 * directory belonged to one page. It does not: a page slugged like a
 * folder-import root shares `raw/sources/<name>/` with that import, so deleting
 * the page took the whole import tree — another owner's, possibly — with it
 * (DW-611). Deleting the page-owned FILES individually is the narrowest
 * cleanup that still leaves no silo ghost behind for the reverse-orphan pass
 * to trip over.
 *
 * A directory holding anything this mirror would never have written — an import
 * file, a subdirectory, a dotfile — survives with that content intact.
 */
async function removeHashedTree(siloPrefix: string): Promise<void> {
  const entries = await listSafe(siloPrefix);
  // Nothing there — including the common case of a directory that never
  // existed. Return before `deleteDirSafe`: `removeSiloForPage` calls this at
  // BOTH roots, so falling through would issue two recursive deletes against
  // absent prefixes on every page delete, and on R2 a recursive delete is a
  // prefix sweep, not a no-op.
  if (entries.length === 0) return;
  let foreign = 0;
  for (const f of entries) {
    if (
      !f.isDirectory &&
      !f.name.startsWith(".") &&
      isRawSnapshotName(f.name)
    ) {
      await deleteSafe(`${siloPrefix}/${f.name}`);
    } else {
      foreign++;
    }
  }
  if (foreign === 0) await deleteDirSafe(siloPrefix);
}

/**
 * Mirror every per-page artifact for one slug into its tenant silo (idempotent
 * — overwrites). Reads from flat (the write primary), so call AFTER the flat
 * write completes. Returns the count of artifacts copied.
 */
export async function syncSiloForPage(
  slug: string,
  tenant: string,
): Promise<number> {
  validateTenant(tenant);
  let n = 0;
  // wiki page + raw source
  if (await copyText(wikiRelPath(`${slug}.md`), tenantWikiRelPath(tenant, `${slug}.md`)))
    n++;
  // Sources live at `raw/sources/<slug>.md` (Story 2.1). The legacy flat
  // `raw/<slug>.md` is copied too — not as a duplicate, as the pre-move
  // location: a workspace ingested before the move has bytes only there, and a
  // sync that assumed one address would silently stop mirroring for it. Each
  // copy is skipped when its source is absent, so a slug written after the move
  // costs one missing-file check rather than a second write.
  //
  // Neither address covers Workbench Intake's per-slug HASHED tree
  // `raw/sources/<slug>/<rawId>.<ext>`, mirrored below (DW-435) — nor the
  // legacy hashed root `raw/<slug>/<rawId>.<ext>`, which DW-435 left unmirrored
  // and DW-610 now covers too. That root is a REAL source location:
  // `readRawSourceById` falls back to it and `listRawSourceSnapshots`
  // enumerates it, so a workspace whose arrivals predate the move had them
  // invisible in Files forever (`raw/` resolves silo-only, DW-40).
  if (
    await copyText(
      rawSourceRelPath(`${slug}.md`),
      tenantRawSourceRelPath(tenant, `${slug}.md`),
    )
  )
    n++;
  if (await copyText(rawRelPath(`${slug}.md`), tenantRawRelPath(tenant, `${slug}.md`)))
    n++;

  // Hashed arrivals, at BOTH roots, through one helper — see
  // `mirrorHashedTree` for what counts as page-owned and why the flat side is
  // listed first.
  //
  // Modern: raw/sources/<slug>/<rawId>.<ext> (DW-435).
  n += await mirrorHashedTree(
    rawSourceRelPath(slug),
    tenantRawSourceRelPath(tenant, slug),
  );
  // Legacy: raw/<slug>/<rawId>.<ext> (DW-610), mirrored ADDRESS-PRESERVINGLY
  // into `tenants/<t>/raw/<slug>/` — the same convention the legacy flat
  // `raw/<slug>.md` copy above uses. It keeps the silo a faithful picture of
  // the flat tree for a future flat retirement, and `listWorkbenchFilePaths`
  // walks the whole silo `raw/` root, so visibility in Files does not depend on
  // the modern spelling.
  //
  // SKIPPED for a slug naming a structural root under `raw/` — `raw/sources/`,
  // `raw/assets/`, `raw/parsed/`, `raw/uploads/`, `raw/originals/` hold other
  // pages' and other owners' content, and the path alone cannot tell a real
  // page slugged `assets` from the root itself. When it cannot, WITHHOLD: read
  // the name as a root and mirror nothing, rather than pull a shared tree into
  // one page's silo. `rawPathSlug` withholds under the same principle and the
  // opposite direction — see `RAW_STRUCTURAL_DIRS` for why the two are not one
  // rule. The page's MODERN tree (`raw/sources/assets/…`) is unaffected.
  if (!RAW_STRUCTURAL_DIRS.has(slug)) {
    n += await mirrorHashedTree(
      rawRelPath(slug),
      tenantRawRelPath(tenant, slug),
    );
  }

  // Revision history + assets are IMMUTABLE (append-only, never rewritten), so
  // copy only the ones not already mirrored. This bounds a per-write sync to the
  // new files instead of re-copying the whole (unbounded) history each time —
  // critical on the Workers runtime (subrequest budget). One list of the silo
  // side does the diff; the migration's first run (empty silo) still copies all.

  // revision history: wiki/.revisions/<slug>/{<ts>.md,<ts>.meta.json}
  const revRel = `.revisions/${slug}`;
  const mirroredRevs = new Set(
    (await listSafe(tenantWikiRelPath(tenant, revRel))).map((f) => f.name),
  );
  for (const f of await listSafe(wikiRelPath(revRel))) {
    if (f.isDirectory || mirroredRevs.has(f.name)) continue;
    if (
      await copyText(
        wikiRelPath(`${revRel}/${f.name}`),
        tenantWikiRelPath(tenant, `${revRel}/${f.name}`),
      )
    )
      n++;
  }

  // discussion threads: discuss/<slug>.json (mutable — always overwrite)
  if (
    await copyText(
      `discuss/${slug}.json`,
      `tenants/${tenant}/discuss/${slug}.json`,
    )
  )
    n++;

  // binary assets: raw/assets/<slug>/<file> (immutable — copy only new)
  const assetRel = `${RAW_ASSETS_DIR}/${slug}`;
  const mirroredAssets = new Set(
    (await listSafe(tenantRawRelPath(tenant, assetRel))).map((f) => f.name),
  );
  for (const f of await listSafe(rawRelPath(assetRel))) {
    if (f.isDirectory || mirroredAssets.has(f.name)) continue;
    if (
      await copyAsset(
        rawRelPath(`${assetRel}/${f.name}`),
        tenantRawRelPath(tenant, `${assetRel}/${f.name}`),
      )
    )
      n++;
  }
  return n;
}

/** Options for {@link removeSiloForPage}. */
export interface RemoveSiloForPageOptions {
  /**
   * Keep the page's silo raw Sources (both flat addresses and both hashed
   * trees) while still clearing the wiki md, discuss thread, revisions and
   * assets.
   *
   * Set by the merge-absorb delete (DW-609): `mergePages` unions the absorbed
   * page's sources into the SURVIVOR's frontmatter before hard-deleting the
   * absorbed page through the shared delete branch, so removing those bytes
   * would destroy provenance the survivor now claims. A plain discard leaves
   * this off and clears the whole silo.
   */
  preserveRawSources?: boolean;
}

/** Remove every per-page artifact for one slug from its tenant silo. */
export async function removeSiloForPage(
  slug: string,
  tenant: string,
  options?: RemoveSiloForPageOptions,
): Promise<void> {
  validateTenant(tenant);
  const preserveRawSources = options?.preserveRawSources === true;
  await Promise.all([
    deleteSafe(tenantWikiRelPath(tenant, `${slug}.md`)),
    deleteSafe(`tenants/${tenant}/discuss/${slug}.json`),
    deleteDirSafe(tenantWikiRelPath(tenant, `.revisions/${slug}`)),
    deleteDirSafe(tenantRawRelPath(tenant, `${RAW_ASSETS_DIR}/${slug}`)),
    // Raw-Source arms. Skipped wholesale when the caller preserves Sources —
    // a merge-absorb delete hands them to the survivor rather than dropping
    // them.
    ...(preserveRawSources
      ? []
      : [
          deleteSafe(tenantRawSourceRelPath(tenant, `${slug}.md`)),
          deleteSafe(tenantRawRelPath(tenant, `${slug}.md`)),
          // Hashed arrivals mirrored by syncSiloForPage (DW-435/DW-610) —
          // without this a deleted page leaves Sources in the silo for
          // reverse-orphan cleanup to trip over. SELECTIVE, not a recursive
          // directory delete: the directory may be shared with a folder import
          // (DW-611). Same structural-root skip as the mirror, so a page
          // slugged `assets` cannot delete out of `tenants/<t>/raw/assets/`.
          removeHashedTree(tenantRawSourceRelPath(tenant, slug)),
          ...(RAW_STRUCTURAL_DIRS.has(slug)
            ? []
            : [removeHashedTree(tenantRawRelPath(tenant, slug))]),
        ]),
  ]);
}

// ---------------------------------------------------------------------------
// Silo reconciliation — verify and repair silo consistency
// ---------------------------------------------------------------------------

/** Summary returned by {@link reconcileSilos}. */
export interface ReconcileResult {
  total: number;
  /** Pages whose silo wiki md was MISSING when the pass reached them. */
  synced: number;
  /** Pages whose silo wiki md existed but had stale content. */
  stale: number;
  /**
   * Pages whose silo wiki md already matched flat.
   *
   * NOT "nothing was done": every page is synced (DW-608), and this counter
   * only says which of the three states the md was in. A page counted here can
   * still have had a Source, a revision, a discussion thread or an asset
   * repaired by that sync.
   */
  alreadyCurrent: number;
  /** Silo pages with no corresponding index entry — cleaned up. */
  removed: number;
  errors: string[];
}

/** Infrastructure slugs that are not real pages — never synced to silos. */
const SKIP = new Set(["index", "log"]);

/**
 * Scan every page in the flat index and re-sync its tenant silo. This closes
 * the gap left by fail-soft silo mirrors — a page whose mirror write failed
 * silently is repaired here, for EVERY artifact the silo holds and not just the
 * wiki md whose state the counters report (DW-608).
 *
 * Designed to run at the END of {@link rebuildDerivedIndexes} (it reads from
 * flat, so all indexes should be fresh first) and is also available for the
 * admin migrate endpoint.
 */
export async function reconcileSilos(): Promise<ReconcileResult> {
  const { listWikiPages } = await import("./wiki");
  const pages = await listWikiPages();
  const storage = getStorage();
  const result: ReconcileResult = {
    total: 0,
    synced: 0,
    stale: 0,
    alreadyCurrent: 0,
    removed: 0,
    errors: [],
  };

  for (const page of pages) {
    if (SKIP.has(page.slug)) continue;
    result.total++;
    const tenant = tenantForOwner(page.owner);
    try {
      const flatPath = wikiRelPath(`${page.slug}.md`);
      const siloPath = tenantWikiRelPath(tenant, `${page.slug}.md`);
      // The md comparison is now purely a CLASSIFIER for the counters below,
      // not a gate (DW-608). `lifecycle.ts` writes flat and silo from the
      // identical content, so a live page always compared equal and the sync
      // never ran — which meant a Source, revision, thread or asset that
      // arrived AFTER the md was mirrored could never be repaired by a routine
      // reconcile, the one job this pass exists to do.
      const exists = await storage.fileExists(siloPath);
      let bucket: "synced" | "stale" | "alreadyCurrent";
      if (!exists) {
        bucket = "synced";
      } else {
        const flatContent = await storage.readFile(flatPath);
        const siloContent = await storage.readFile(siloPath);
        bucket = flatContent !== siloContent ? "stale" : "alreadyCurrent";
      }
      // Unconditional. The per-page cost is a handful of listings against a
      // silo that is usually already complete, and it is affordable HERE
      // specifically: the only production caller is the tail of
      // `rebuildDerivedIndexes` (admin/rebuild, fail-soft), never a request hot
      // path. `syncSiloForPage`'s own copy-only-new bound is what keeps that
      // cost from growing with history — which is why the answer is not an
      // opt-out parameter on the sync.
      await syncSiloForPage(page.slug, tenant);
      result[bucket]++;
    } catch (e) {
      result.errors.push(`${page.slug}: ${String(e)}`);
      logger.warn("silo", `reconcile failed for "${page.slug}":`, e);
    }
  }

  // ── Reverse pass: find silo files with no index entry (ghosts) ──
  const pageSlugs = new Set(pages.map((p) => p.slug));
  try {
    const tenantDirs = await listSafe("tenants");
    for (const td of tenantDirs) {
      if (!td.isDirectory) continue;
      const tenant = td.name;
      let wikiPrefix: string;
      try {
        wikiPrefix = tenantWikiRelPath(tenant, "");
      } catch {
        continue; // invalid tenant dir name — skip
      }
      let siloFiles: Awaited<ReturnType<typeof listSafe>>;
      try {
        siloFiles = await listSafe(wikiPrefix);
      } catch {
        continue;
      }
      for (const f of siloFiles) {
        if (f.isDirectory || !f.name.endsWith(".md")) continue;
        const slug = f.name.replace(/\.md$/, "");
        if (SKIP.has(slug)) continue;
        if (pageSlugs.has(slug)) continue;
        try {
          await removeSiloForPage(slug, tenant);
          result.removed++;
        } catch (e) {
          result.errors.push(`reverse-orphan ${tenant}/${slug}: ${String(e)}`);
          logger.warn("silo", `reverse-orphan cleanup failed for "${tenant}/${slug}":`, e);
        }
      }
    }
  } catch (e) {
    logger.warn("silo", "reverse-orphan scan failed:", e);
  }

  return result;
}
