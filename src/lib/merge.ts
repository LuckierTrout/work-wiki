/**
 * Merge two existing wiki pages into one — the cure for same-concept duplicates
 * that slipped past ingest dedup (e.g. an X post and the article it's about,
 * ingested under different titles). Composes existing primitives rather than
 * adding a parallel write path:
 *
 *  - {@link reconcilePage} LLM-folds the two bodies into one canonical page
 *    (escalating `disputed` on contradiction), like accumulate-and-reconcile on
 *    re-ingest — and, since DW-323, carrying the same KINDS of workspace
 *    guidance that door carries: the resolved owner's Workspace Purpose and
 *    their Names & Terms dictionary now reach the reconcile prompt here too,
 *    instead of the fold being the one prompt held to no workspace standard.
 *    PRESENCE parity only. The two doors still differ on WHICH principal
 *    supplies the standard: ingest passes the ACTING principal
 *    (`options?.owner?.trim() || actor`, `ingest.ts`), while this door passes
 *    the SURVIVOR's owner, because the merged prose lives on in the survivor's
 *    workspace and not in the actor's. Since DW-543 BOTH doors then reduce
 *    whichever principal they picked to the HUMAN behind it (`humanOwnerOf`),
 *    so an agent handle reads its human's standards instead of its own empty
 *    tenant — a guidance-only reduction that leaves storage addressing alone.
 *  - sources / contributors / authors / aliases are UNIONed; `from`'s title AND
 *    slug are recorded as aliases of `into` so a later ingest under either name
 *    converges on the survivor. NOTE: the alias URL redirect that used to
 *    forward `/wiki/<from>` is gone — that route is retired with the commons
 *    (AD-21) and no owner-scoped equivalent was rebuilt, so a link to an
 *    absorbed slug 404s. Aliases still steer ingest, not routing.
 *  - internal `[..](<from>.md)` backlinks are re-pointed to `into` BEFORE the
 *    delete (otherwise {@link deleteWikiPage} would strip them).
 *  - `from` is then hard-deleted. NOTE: its revision history and discussion
 *    threads are hard-deleted with it (no undo — same contract as
 *    `deleteWikiPage`); migrating `from`'s open threads onto `into` is a follow-up.
 */

import { logger } from "./logger";
import { hasLLMKey } from "./llm";
import { listWikiPages, readWikiPageWithFrontmatter, tenantForOwner, wikiRelPath } from "./wiki";
import { isArtifactType } from "./page-types";
import {
  reconcilePage,
  sameHumanOwner,
  mergeSourceEntry,
  computeConfidence,
  extractSummary,
} from "./ingest";
import { parseSources, serializeSources } from "./sources";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter";
import {
  writeWikiPageWithSideEffectsWhileLocked,
  deleteWikiPageWhileLocked,
  withPageLifecycleLocks,
  type PageLifecycleLockHeld,
} from "./lifecycle";
import { escapeRegex } from "./links";
import { humanOwnerOf } from "./agent-handle";
import { createGuidanceCache } from "./guidance-cache";
import { buildNamesTermsGuidance } from "./names-terms";
import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { sourceSha256 } from "./source-sha256";
import { withDurableLock } from "./lock";
import { listRevisions, readRevision } from "./revisions";

export interface MergePagesArgs {
  /** Slug of the page to absorb — deleted after the merge. */
  from: string;
  /** Slug of the surviving canonical page. */
  into: string;
  /** Actor performing the merge (handle) — for the same-owner guard + attribution. */
  actor?: string;
  /**
   * Bypass the same-human-owner guard. Set ONLY by deployment-trusted callers
   * (MCP stdio / a service principal). Actor-scoped callers (e.g. a dedup
   * cleanup) should pass `actor` and leave this false, so a cross-owner merge is
   * refused rather than silently allowed.
   */
  bypassOwnerCheck?: boolean;
}

export interface MergePagesResult {
  fromSlug: string;
  intoSlug: string;
  /** True if the merged page is left flagged `disputed` — either input was, or
   *  the fold surfaced a contradiction. */
  disputed: boolean;
  /** Other pages whose `[..](<from>.md)` links were re-pointed to `into`. */
  repointedBacklinksFrom: string[];
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A frontmatter `sources` value as a `parseSources` input — its serialized
 *  (string) form, or a hand-authored YAML list (string[]); anything else → none. */
const asSourcesInput = (
  v: string | string[] | number | boolean | undefined,
): string | string[] | undefined =>
  typeof v === "string" || Array.isArray(v) ? v : undefined;

/** Case-insensitive union of string lists, preserving first-seen order. */
function unionStrings(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list) {
      const key = s.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(s.trim());
    }
  }
  return out;
}

/** Earlier of two YYYY-MM-DD strings (ISO dates sort lexicographically). */
function earlierDate(a: unknown, b: unknown): string | undefined {
  const x = asString(a);
  const y = asString(b);
  if (x && y) return x <= y ? x : y;
  return x ?? y;
}

/** Re-point `[..](<from>.md)` links to `into` in every page that links to
 *  `from`, BEFORE `from` is deleted (delete would otherwise strip them). Uses
 *  the backlink index to find linkers; writes through the side-effecting path so
 *  the backlink/derived indexes stay consistent. Returns the slugs re-pointed. */
async function repointBacklinks(
  fromSlug: string,
  intoSlug: string,
  actor: string | undefined,
): Promise<string[]> {
  // Fast path: the precomputed backlink index names the linkers directly. When
  // it's absent (fresh store / not yet built), fall back to scanning every page
  // for the link — a merge is infrequent, so the O(pages) scan is acceptable and
  // keeps the re-point correct rather than silently stripping links on delete.
  // Merge correctness cannot trust the fail-soft backlink index. This path is
  // rare, so scan every current Page and let expected-content CAS fence edits.
  const physical = async (
    prefix: string,
    relative = "",
  ): Promise<Array<{ slug: string; content: string }>> => {
    const pages: Array<{ slug: string; content: string }> = [];
    for (const entry of await getStorage().listFiles(prefix)) {
      if (entry.name.startsWith(".")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        pages.push(...await physical(`${prefix}/${entry.name}`, path));
      } else if (path.endsWith(".md")) {
        const slug = path.slice(0, -3);
        if (slug !== "index" && slug !== "log") {
          pages.push({ slug, content: await getStorage().readFile(`${prefix}/${entry.name}`) });
        }
      }
    }
    return pages;
  };
  const physicalPages = new Map<string, { content: string; tenant?: string }>();
  const tenants = await getStorage().listFiles("tenants");
  for (const tenantEntry of tenants) {
    if (!tenantEntry.isDirectory || tenantEntry.name.startsWith(".")) continue;
    let pages: Array<{ slug: string; content: string }>;
    try {
      pages = await physical(`tenants/${tenantEntry.name}/wiki`);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const page of pages) {
      const owner = pageSnapshot(page.content, page.slug).frontmatter.owner;
      if (tenantForOwner(typeof owner === "string" ? owner : undefined) !== tenantEntry.name) {
        throw new Error(`merge aborted: canonical Page "${page.slug}" is stored under the wrong tenant`);
      }
      const previous = physicalPages.get(page.slug);
      if (previous?.tenant && previous.tenant !== tenantEntry.name) {
        throw new Error(`merge aborted: Page "${page.slug}" exists in multiple tenant silos`);
      }
      physicalPages.set(page.slug, { content: page.content, tenant: tenantEntry.name });
    }
  }
  for (const page of await physical(wikiRelPath(""))) {
    if (!physicalPages.has(page.slug)) physicalPages.set(page.slug, { content: page.content });
  }
  const candidates = [...new Set([
    ...(await listWikiPages({ strict: true })).map((e) => e.slug),
    ...physicalPages.keys(),
  ])];
  const linkers = candidates.filter((s) => s !== fromSlug && s !== intoSlug);
  const re = new RegExp(`(\\]\\()${escapeRegex(fromSlug)}\\.md(?=[#)\\s])`, "g");
  const repointed: string[] = [];
  for (const src of linkers) {
    const physicalPage = physicalPages.get(src);
    const page = physicalPage
      ? { slug: src, ...pageSnapshot(physicalPage.content, src) }
      : await readWikiPageWithFrontmatter(src, { fresh: true, strict: true });
    if (!page) {
      // The authoritative physical scan above completed successfully, so an
      // index-only candidate is a stale derived row rather than an unread Page.
      // Skip it; the merge's own delete/index cleanup will converge the row.
      continue;
    }
    const updated = page.content.replace(re, `$1${intoSlug}.md`);
    if (updated === page.content) continue;
    await withPageLifecycleLocks([src], (held) =>
      writeWikiPageWithSideEffectsWhileLocked({
        slug: src,
        title: page.title,
        content: updated,
        summary: extractSummary(page.body.replace(/^#\s+.+$/m, "").trim()),
        logOp: "edit",
        crossRefSource: null, // a link re-point shouldn't re-run cross-ref
        author: actor,
        expectedContent: page.content,
      }, held));
    repointed.push(src);
  }
  return repointed;
}

interface MergeOperationReceipt {
  version: 1;
  /** Unique generation for this exact lifecycle, retained across Retry only. */
  generation: string;
  fromSlug: string;
  intoSlug: string;
  fromContent: string;
  intoContent: string;
  mergedContent: string;
  summary: string;
  disputed: boolean;
  completedAt?: string;
}

function pageSnapshot(content: string, slug: string) {
  const parsed = parseFrontmatter(content);
  return {
    content,
    frontmatter: parsed.data,
    body: parsed.body,
    title: parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug,
  };
}

async function survivorDescendsFromMergedContent(
  slug: string,
  currentContent: string,
  mergedContent: string,
  tenant: string,
): Promise<boolean> {
  if (currentContent === mergedContent) return true;
  const mergedGeneration = pageSnapshot(mergedContent, slug).frontmatter.merge_generation;
  if (typeof mergedGeneration === "string") {
    const currentGeneration = pageSnapshot(currentContent, slug).frontmatter.merge_generation;
    if (currentGeneration === mergedGeneration) return true;
    // A normal edit preserves the marker. Only another completed merge is
    // allowed to advance it and prove ancestry through revision history; an
    // unmarked same-owner recreation must not inherit stale revisions.
    if (typeof currentGeneration !== "string") return false;
  }
  for (const revisionTenant of [tenant, undefined]) {
    for (const revision of await listRevisions(slug, revisionTenant)) {
      if (await readRevision(slug, revision.timestamp, revisionTenant) === mergedContent) return true;
    }
  }
  return false;
}

async function validateCanonicalPageStorage(): Promise<void> {
  const seen = new Map<string, string>();
  const scan = async (prefix: string, tenant: string, relative = ""): Promise<void> => {
    for (const entry of await getStorage().listFiles(prefix)) {
      if (entry.name.startsWith(".")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await scan(`${prefix}/${entry.name}`, tenant, path);
      } else if (path.endsWith(".md")) {
        const slug = path.slice(0, -3);
        if (["index", "log"].includes(slug)) continue;
        const content = await getStorage().readFile(`${prefix}/${entry.name}`);
        const owner = pageSnapshot(content, slug).frontmatter.owner;
        if (tenantForOwner(typeof owner === "string" ? owner : undefined) !== tenant) {
          throw new Error(`merge aborted: canonical Page "${slug}" is stored under the wrong tenant`);
        }
        const previousTenant = seen.get(slug);
        if (previousTenant && previousTenant !== tenant) {
          throw new Error(`merge aborted: Page "${slug}" exists in multiple tenant silos`);
        }
        seen.set(slug, tenant);
      }
    }
  };
  for (const tenantEntry of await getStorage().listFiles("tenants")) {
    if (!tenantEntry.isDirectory || tenantEntry.name.startsWith(".")) continue;
    try {
      await scan(`tenants/${tenantEntry.name}/wiki`, tenantEntry.name);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

async function readMergeReceipt(path: string): Promise<MergeOperationReceipt | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(path)) as MergeOperationReceipt;
    if (
      parsed.version !== 1
      || typeof parsed.generation !== "string"
      || typeof parsed.fromSlug !== "string"
      || typeof parsed.intoSlug !== "string"
      || typeof parsed.fromContent !== "string"
      || typeof parsed.intoContent !== "string"
      || typeof parsed.mergedContent !== "string"
      || typeof parsed.summary !== "string"
      || typeof parsed.disputed !== "boolean"
      || (parsed.completedAt !== undefined && typeof parsed.completedAt !== "string")
    ) {
      throw new Error("merge operation receipt is invalid");
    }
    return parsed;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Merge `from` into `into`: fold the bodies, union provenance, re-point
 * backlinks, then delete `from`. `into` survives as the canonical page. Throws
 * on an invalid merge (same page, missing side, artifact target, public→private,
 * or a cross-owner merge without `bypassOwnerCheck`). Takes a single named
 * object so the two slugs can't be silently swapped at a call site.
 */
export async function mergePages({
  from: fromSlug,
  into: intoSlug,
  actor,
  bypassOwnerCheck = false,
}: MergePagesArgs): Promise<MergePagesResult> {
  if (fromSlug === intoSlug) {
    throw new Error("cannot merge a page into itself");
  }
  // One merge coordinator at a time. Pair locks alone can deadlock when two
  // disjoint merges later acquire one another's backlink Pages.
  return withDurableLock("merge-pages", () =>
    withPageLifecycleLocks([fromSlug, intoSlug], (held) => mergePagesWhileSourceLocked({
      from: fromSlug,
      into: intoSlug,
      actor,
      bypassOwnerCheck,
    }, held)));
}

async function mergePagesWhileSourceLocked({
  from: fromSlug,
  into: intoSlug,
  actor,
  bypassOwnerCheck = false,
}: MergePagesArgs, sourceLock: PageLifecycleLockHeld): Promise<MergePagesResult> {

  const operationId = await sourceSha256(`${fromSlug}\u0000${intoSlug}`);
  const operationPath = `derived-indexes/merge-operations/${operationId}.json`;
  let receipt = await readMergeReceipt(operationPath);
  if (receipt?.completedAt) {
    const recreated = await readWikiPageWithFrontmatter(
      fromSlug,
      { fresh: true, strict: true },
    );
    if (!recreated) {
      await getStorage().deleteFile(operationPath).catch(() => undefined);
      await getStorage()
        .deleteFile(`${operationPath}.${receipt.generation}.survivor`)
        .catch(() => undefined);
      await getStorage()
        .deleteFile(`${operationPath}.${receipt.generation}.delete`)
        .catch(() => undefined);
      // LEGACY receipt: nothing mints this any more — the contributor-index
      // decrement it guarded was removed with the index's last reader (DW-126).
      // The delete stays only to reap files older deployments left behind.
      await getStorage()
        .deleteFile(`${operationPath}.${receipt.generation}.delete.contributor`)
        .catch(() => undefined);
      return {
        fromSlug,
        intoSlug,
        disputed: receipt.disputed,
        repointedBacklinksFrom: [],
      };
    }
    // A completed generation survived best-effort cleanup and the absorbed
    // slug has since been recreated. Retire the stale marker and start a new
    // immutable generation from the current Pages.
    await getStorage().deleteFile(operationPath);
    await getStorage()
      .deleteFile(`${operationPath}.${receipt.generation}.survivor`)
      .catch(() => undefined);
    await getStorage()
      .deleteFile(`${operationPath}.${receipt.generation}.delete`)
      .catch(() => undefined);
    // LEGACY receipt — see above: nothing writes it since DW-126; the delete
    // only reaps what older deployments left behind.
    await getStorage()
      .deleteFile(`${operationPath}.${receipt.generation}.delete.contributor`)
      .catch(() => undefined);
    receipt = null;
  }
  let from = receipt
    ? pageSnapshot(receipt.fromContent, fromSlug)
    : await readWikiPageWithFrontmatter(fromSlug, { fresh: true, strict: true });
  if (!from) {
    throw new Error(`page not found: ${fromSlug}`);
  }
  let into = receipt
    ? pageSnapshot(receipt.intoContent, intoSlug)
    : await readWikiPageWithFrontmatter(intoSlug, { fresh: true, strict: true });
  if (!into) throw new Error(`page not found: ${intoSlug}`);

  // Guard: the survivor must be a normal markdown page — reconciling into an
  // HTML/slides artifact would corrupt its markup.
  const intoType = asString(into.frontmatter.type);
  if (isArtifactType(intoType)) {
    throw new Error(
      `cannot merge into artifact page "${intoSlug}" (type=${intoType})`,
    );
  }
  // Guard: same human owner unless a deployment-trusted caller opted out.
  if (
    !bypassOwnerCheck &&
    (!sameHumanOwner(actor, from.frontmatter.owner) ||
      !sameHumanOwner(actor, into.frontmatter.owner))
  ) {
    throw new Error(
      `merge requires the same owner for "${fromSlug}" and "${intoSlug}" (or a trusted caller)`,
    );
  }
  // Guard: never pull a public page into a private one (yanks it from commons).
  const fromVisibility = asString(from.frontmatter.visibility) ?? "public";
  const intoVisibility = asString(into.frontmatter.visibility) ?? "public";
  if (fromVisibility !== "private" && intoVisibility === "private") {
    throw new Error(
      `cannot merge public page "${fromSlug}" into private page "${intoSlug}"`,
    );
  }

  if (!receipt) {
    // Reject canonical storage drift before publishing immutable merge inputs.
    // Otherwise a repair plus an intervening Page edit could strand a stale
    // receipt that no future retry is allowed to retire.
    await validateCanonicalPageStorage();
    // Fold exactly once. The durable operation receipt below preserves this
    // plan across backlink/delete failures, so Retry never folds the absorbed
    // Page into an already-merged survivor a second time.
    let mergedBody = `${into.body}\n\n${from.body}`;
    let disputed =
      into.frontmatter.disputed === true || from.frontmatter.disputed === true;
    if (await hasLLMKey()) {
      try {
        // Whose workspace standards govern the fold (DW-323). The merged prose
        // is written to the SURVIVOR and lives on in ITS owner's wiki, so that
        // owner's Workspace Purpose and Names & Terms dictionary are the ones
        // with a claim on it — not the actor's, who under `bypassOwnerCheck`
        // may be a service principal (`src/mcp.ts` passes `actor: "system"`) or
        // another human whose conventions have no standing on a page they do
        // not own. `actor` is the FALLBACK, not the default: it is the only
        // principal in scope when the survivor's frontmatter names no owner,
        // and it is already what the same-owner guard above compares against.
        //
        // BOTH sides go through `asString`. A blank/non-string frontmatter
        // `owner` falls through to `actor`, and a blank `actor` falls through
        // to `undefined` rather than becoming an empty principal — which
        // `ownerToTenant` would silently collapse onto the DEFAULT tenant,
        // handing the default silo's Purpose and dictionary to a fold that
        // named no principal at all. Both absent ⇒ `undefined` ⇒ today's
        // unguided prompt.
        //
        // Whichever side wins is then reduced to the HUMAN behind it (DW-543).
        // A Workspace Purpose and a Names & Terms dictionary belong to a
        // PERSON, not to each of that person's agents: a survivor owned by
        // `alice--yoyo` must read alice's standards, exactly as the same-owner
        // guard above already treats the two handles as one owner. The
        // reduction is guidance-only — nothing about where the survivor is
        // stored, who it is attributed to, or which silo it lives in changes,
        // because `ownerToTenant` deliberately keeps the `--<agent>` suffix.
        const guidancePrincipal =
          asString(into.frontmatter.owner) ?? asString(actor);
        let guidanceOwner = guidancePrincipal
          ? humanOwnerOf(guidancePrincipal)
          : undefined;
        // One handle for THIS merge only — never hoisted, never shared across
        // merges — so a Purpose or dictionary edit saved between two merges is
        // still picked up by the next one.
        const guidance = createGuidanceCache();
        if (guidanceOwner) {
          try {
            // Probe the dictionary BEFORE the fold, through the EXACT call the
            // fold makes. Guidance is an ADDITION to a prompt: losing it must
            // degrade the prompt, never the operation. `buildWorkspaceGuidance`
            // honours that with its own `catch`; its dictionary sibling does
            // not, and it can throw at EITHER of two layers:
            //
            //   - `listNamesTerms` → `readEntries` ENOENT-degrades to `[]` but
            //     RETHROWS everything else — the `JSON.parse` SyntaxError from
            //     a corrupt `names-terms.json`.
            //   - `renderNamesTermsGuidance` then dereferences `entry.aliases`
            //     on entries nothing filtered (`resolveSortedEntries` only
            //     skips FREEZING a null/non-object element), so a file that
            //     PARSES but holds a `null` or a field-less entry throws only
            //     at the RENDER layer.
            //
            // Probing `listNamesTerms` alone would miss that second case, so
            // this probes `buildNamesTermsGuidance` — read + sort + render,
            // exactly what `reconcilePage` consumes.
            //
            // `reconcilePage` awaits both guidance halves in one `Promise.all`
            // before it calls the model, so an unprobed rejection would land in
            // the `catch` below, whose raw body concatenation is then written
            // into `MergeOperationReceipt.mergedContent` — the merge's
            // linearization point, replayed verbatim by any Retry and never
            // re-folded, with `from` already deleted. A damaged dictionary
            // would permanently ship an unfolded, double-titled survivor.
            //
            // On success this costs nothing: `listNamesTerms` memoizes the read
            // under the shared handle, so `reconcilePage` reuses it instead of
            // reading twice, and the second render is a pure function over
            // those cached entries. On failure we drop the WHOLE owner, so the
            // Purpose goes with the dictionary — a deliberately coarse degrade,
            // since the only way to keep one without the other is to compose
            // the prompt here and duplicate `reconcilePage`.
            await buildNamesTermsGuidance(guidanceOwner, guidance.namesTerms);
          } catch (err) {
            logger.warn(
              "merge",
              `names & terms unreadable for "${guidanceOwner}"; folding "${fromSlug}"→"${intoSlug}" unguided`,
              err,
            );
            guidanceOwner = undefined;
          }
        }
        // `emptyFallback: "throw"`. At THIS door `from.body` is the ABSORBED
        // page's body, and `mergedBody` is written over the SURVIVOR at the end
        // of this function before `from` is hard-deleted. The ingest-door
        // default (`"new"`) would hand back `from.body` on an empty fold,
        // silently replacing the survivor's prose with the absorbed page's —
        // and because `mergedBody` goes into the receipt, that substitution is
        // the merge's linearization point, replayed verbatim by any Retry and
        // undoable only by hand. Throwing drops into the `catch` below, which
        // keeps the appended-bodies default — the same degrade a reconcile API
        // error already gets, and lossless.
        const reconciled = await reconcilePage(
          into.body,
          from.body,
          guidanceOwner,
          guidance,
          { emptyFallback: "throw" },
        );
        mergedBody = reconciled.body;
        if (reconciled.disputed) disputed = true;
      } catch (err) {
        logger.warn(
          "merge",
          `reconcile failed for "${fromSlug}"→"${intoSlug}"; appending bodies`,
          err,
        );
      }
    }

    const fm: Frontmatter = { ...into.frontmatter };
    let sources = parseSources(asSourcesInput(into.frontmatter.sources));
    for (const s of parseSources(asSourcesInput(from.frontmatter.sources))) {
      sources = mergeSourceEntry(sources, s);
    }
    fm.sources = serializeSources(sources);
    fm.source_count = sources.length;
    fm.contributors = unionStrings(
      asStringArray(into.frontmatter.contributors),
      asStringArray(from.frontmatter.contributors),
    );
    fm.authors = unionStrings(
      asStringArray(into.frontmatter.authors),
      asStringArray(from.frontmatter.authors),
    );
    fm.aliases = unionStrings(
      asStringArray(into.frontmatter.aliases),
      asStringArray(from.frontmatter.aliases),
      [from.title, fromSlug],
    ).filter((alias) => alias.toLowerCase() !== into!.title.toLowerCase());
    fm.disputed = disputed;
    fm.confidence = computeConfidence(sources, disputed);
    const earliestCreated = earlierDate(into.frontmatter.created, from.frontmatter.created);
    if (earliestCreated) fm.created = earliestCreated;
    const today = new Date().toISOString().slice(0, 10);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 90);
    const generation = crypto.randomUUID();
    fm.updated = today;
    fm.valid_from = today;
    fm.expiry = expiry.toISOString().slice(0, 10);
    fm.merge_generation = generation;
    mergedBody = mergedBody.replace(
      new RegExp(`(\\]\\()${escapeRegex(fromSlug)}\\.md(?=[#)\\s])`, "g"),
      `$1${intoSlug}.md`,
    );
    const summary = extractSummary(mergedBody.replace(/^#\s+.+$/m, "").trim());
    const candidate: MergeOperationReceipt = {
      version: 1,
      generation,
      fromSlug,
      intoSlug,
      fromContent: from.content,
      intoContent: into.content,
      mergedContent: serializeFrontmatter(fm, mergedBody),
      summary,
      disputed,
    };

    // The receipt is the linearization point for the immutable merge inputs.
    // Recheck both Pages immediately before publishing it.
    const [freshFrom, freshInto] = await Promise.all([
      readWikiPageWithFrontmatter(fromSlug, { fresh: true, strict: true }),
      readWikiPageWithFrontmatter(intoSlug, { fresh: true, strict: true }),
    ]);
    if (freshFrom?.content !== from.content || freshInto?.content !== into.content) {
      throw new Error("merge input changed while the merge plan was being prepared");
    }
    const created = await getStorage().writeFileIfAbsent(
      operationPath,
      JSON.stringify(candidate, null, 2),
    );
    receipt = created ? candidate : await readMergeReceipt(operationPath);
    if (!receipt) throw new Error("merge operation receipt disappeared");
    from = pageSnapshot(receipt.fromContent, fromSlug);
    into = pageSnapshot(receipt.intoContent, intoSlug);
  }

  if (receipt.fromSlug !== fromSlug || receipt.intoSlug !== intoSlug) {
    throw new Error("merge operation receipt does not match this request");
  }
  const [currentFrom, currentInto] = await Promise.all([
    readWikiPageWithFrontmatter(fromSlug, { fresh: true, strict: true }),
    readWikiPageWithFrontmatter(intoSlug, { fresh: true, strict: true }),
  ]);
  await validateCanonicalPageStorage();
  if (!currentFrom) {
    if (!currentInto) throw new Error("merge survivor disappeared after the absorbed Page was deleted");
    const originalSurvivor = pageSnapshot(receipt.intoContent, intoSlug);
    const currentOwner = typeof currentInto.frontmatter.owner === "string"
      ? currentInto.frontmatter.owner
      : undefined;
    const originalOwner = typeof originalSurvivor.frontmatter.owner === "string"
      ? originalSurvivor.frontmatter.owner
      : undefined;
    if (
      tenantForOwner(currentOwner) !== tenantForOwner(originalOwner)
      || !await survivorDescendsFromMergedContent(
        intoSlug,
        currentInto.content,
        receipt.mergedContent,
        tenantForOwner(originalOwner),
      )
    ) {
      throw new Error(`merge aborted: survivor Page "${intoSlug}" was replaced after the absorbed Page was deleted`);
    }
    await deleteWikiPageWhileLocked(
      fromSlug,
      sourceLock,
      actor,
      receipt.fromContent,
      {
        key: `merge-delete:${receipt.generation}`,
        receiptPath: `${operationPath}.${receipt.generation}.delete`,
      },
      true,
      // Merge-absorb, not a discard: the survivor's frontmatter already claims
      // this page's sources (step 3 unioned them), so the delete-time silo
      // cleanup must leave its raw Sources alone (DW-609).
      true,
    );
    await repointBacklinks(fromSlug, intoSlug, actor);
    await completeMergeOperation(operationPath, receipt);
    return { fromSlug, intoSlug, disputed: receipt.disputed, repointedBacklinksFrom: [] };
  }
  if (currentFrom.content !== receipt.fromContent) {
    throw new Error(`merge aborted: absorbed Page "${fromSlug}" changed`);
  }
  if (
    !currentInto
    || (currentInto.content !== receipt.intoContent && currentInto.content !== receipt.mergedContent)
  ) {
    throw new Error(`merge aborted: survivor Page "${intoSlug}" changed`);
  }

  await writeWikiPageWithSideEffectsWhileLocked({
    slug: intoSlug,
    title: into.title,
    content: receipt.mergedContent,
    summary: receipt.summary,
    logOp: "edit",
    crossRefSource: null,
    author: actor,
    expectedContent: receipt.intoContent,
    idempotency: {
      key: `merge-survivor:${receipt.generation}`,
      receiptPath: `${operationPath}.${receipt.generation}.survivor`,
    },
  }, sourceLock);

  // 4. Re-point backlinks only after the survivor is durable, and before
  // deleting `from`. A later linker failure leaves two valid Pages rather than
  // links that point away from the still-existing absorbed Page.
  const repointedBacklinksFrom = await repointBacklinks(
    fromSlug,
    intoSlug,
    actor,
  );

  // A fold that leaves the survivor disputed used to auto-open a talk
  // reconciliation thread here. Removed with the other two call sites (DW-230):
  // the talk HTTP surfaces are retired, so nothing could read it. The survivor's
  // `disputed` frontmatter still records the contradiction, and `mergePages`
  // still returns `disputed` to its caller.

  // 5. Delete the absorbed page (hard delete — its revisions + discussions go
  // with it; see the module note).
  logger.info(
    "merge",
    `merged "${fromSlug}" into "${intoSlug}" — deleting "${fromSlug}" (its revisions + discussion threads are hard-deleted)`,
  );
  await deleteWikiPageWhileLocked(
    fromSlug,
    sourceLock,
    actor,
    receipt.fromContent,
    {
      key: `merge-delete:${receipt.generation}`,
      receiptPath: `${operationPath}.${receipt.generation}.delete`,
    },
    true,
    // Merge-absorb, not a discard: the survivor's frontmatter already claims
    // this page's sources (step 3 unioned them), so the delete-time silo
    // cleanup must leave its raw Sources alone (DW-609).
    true,
  );
  // Catch a linker edit that landed after the pre-delete repoint snapshot.
  for (const slug of await repointBacklinks(fromSlug, intoSlug, actor)) {
    if (!repointedBacklinksFrom.includes(slug)) repointedBacklinksFrom.push(slug);
  }
  await completeMergeOperation(operationPath, receipt);

  return { fromSlug, intoSlug, disputed: receipt.disputed, repointedBacklinksFrom };
}

async function completeMergeOperation(
  operationPath: string,
  receipt: MergeOperationReceipt,
): Promise<void> {
  await getStorage().writeFile(operationPath, JSON.stringify({
    ...receipt,
    completedAt: new Date().toISOString(),
  }, null, 2));
  await getStorage().deleteFile(operationPath).catch(() => undefined);
  await getStorage()
    .deleteFile(`${operationPath}.${receipt.generation}.survivor`)
    .catch(() => undefined);
  await getStorage()
    .deleteFile(`${operationPath}.${receipt.generation}.delete`)
    .catch(() => undefined);
  // LEGACY receipt — see `mergePages`: nothing writes it since DW-126; the
  // delete only reaps what older deployments left behind.
  await getStorage()
    .deleteFile(`${operationPath}.${receipt.generation}.delete.contributor`)
    .catch(() => undefined);
}
