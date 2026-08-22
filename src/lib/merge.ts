/**
 * Merge two existing wiki pages into one — the cure for same-concept duplicates
 * that slipped past ingest dedup (e.g. an X post and the article it's about,
 * ingested under different titles). Composes existing primitives rather than
 * adding a parallel write path:
 *
 *  - {@link reconcilePage} LLM-folds the two bodies into one canonical page
 *    (escalating `disputed` on contradiction), exactly like accumulate-and-
 *    reconcile on re-ingest — and, since DW-323, under the same owner guidance
 *    (Workspace Purpose + Names & Terms) that door carries. Which owner: see
 *    the comment on `guidanceOwner` in {@link mergePages}.
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
import { listWikiPages, readWikiPageWithFrontmatter } from "./wiki";
import { isArtifactType } from "./page-types";
import {
  reconcilePage,
  sameHumanOwner,
  mergeSourceEntry,
  computeConfidence,
  extractSummary,
} from "./ingest";
import { createGuidanceCache } from "./guidance-cache";
import { listNamesTerms } from "./names-terms";
import { parseSources, serializeSources } from "./sources";
import { serializeFrontmatter, type Frontmatter } from "./frontmatter";
import { writeWikiPageWithSideEffects, deleteWikiPage } from "./lifecycle";
import { getBacklinkIndex } from "./backlink-index";
import { escapeRegex } from "./links";
import { isPageUnreadableError } from "./page-read-failure";

export interface MergePagesArgs {
  /** Slug of the page to absorb — deleted after the merge. */
  from: string;
  /** Slug of the surviving canonical page. */
  into: string;
  /**
   * Actor performing the merge (handle) — for the same-owner guard, attribution,
   * and (DW-323) the fallback guidance principal when the survivor's frontmatter
   * names no `owner`.
   */
  actor?: string;
  /**
   * Bypass the same-human-owner guard. Set ONLY by deployment-trusted callers
   * (MCP stdio / a service principal). Actor-scoped callers (e.g. a dedup
   * cleanup) should pass `actor` and leave this false, so a cross-owner merge is
   * refused rather than silently allowed.
   *
   * Note what a cross-owner merge now implies (DW-323): the fold runs under the
   * SURVIVOR owner's Workspace Purpose and Names & Terms, so that owner's
   * profile text — which can name people, projects and roles — reaches a prompt
   * folding another owner's prose. That is the point of guiding this door, but
   * it is a real crossing and only trusted callers may open it.
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
  const index = await getBacklinkIndex();
  const candidates = index
    ? index[fromSlug] ?? []
    : (await listWikiPages()).map((e) => e.slug);
  const linkers = candidates.filter((s) => s !== fromSlug && s !== intoSlug);
  const re = new RegExp(`\\]\\(${escapeRegex(fromSlug)}\\.md\\)`, "g");
  const repointed: string[] = [];
  for (const src of linkers) {
    // FRESH (DW-379): these bytes are rewritten and written straight back
    // below, so they are a merge base. A bulk scan holding `pageCache` open
    // with a superseded entry would have this re-point revert whatever was
    // saved in between.
    let page: Awaited<ReturnType<typeof readWikiPageWithFrontmatter>>;
    try {
      page = await readWikiPageWithFrontmatter(src, { fresh: true });
    } catch (err) {
      if (!isPageUnreadableError(err)) throw err;
      // THE REFUSAL IS RE-WORDED, NOT RELAYED. `PAGE_UNREADABLE_COPY` says "so
      // nothing was changed" — a save-door sentence that is FALSE here: this
      // loop may already have re-pointed and written earlier linkers before
      // reaching `src`. The message below is the accurate one this function has
      // always thrown for an unreadable linker, and it names which page and
      // which merge. The refusal is kept as `cause` so the EIO underneath is
      // still reachable from a log line or a debugger.
      throw new Error(
        `merge aborted: backlink source "${src}" could not be read while re-pointing links from "${fromSlug}" to "${intoSlug}"`,
        { cause: err },
      );
    }
    if (!page) {
      // `src` was named as a linker by the index / page list, so `null` is not
      // the ordinary "no such page" — but it is still the only answer a
      // NON-throwing read can give for several conditions at once: a page that
      // genuinely is not there, and a slug `validateSlug` rejects (which
      // `readWikiPage` logs and answers `null` for). What it no longer covers,
      // since DW-378/DW-380, is a transient storage fault — that arrives as the
      // refusal handled just above. Note also that `fresh` bypasses `pageCache`
      // and ONLY that: a lagging `getPageIndex()` can still route this read at
      // the flat file while the write targets the silo one, exactly as
      // `ReadWikiPageOptions.fresh` documents. Abort either way, rather than let
      // the later hard-delete strip an un-re-pointed link; `from` is left intact
      // and the merge retries.
      throw new Error(
        `merge aborted: backlink source "${src}" could not be read while re-pointing links from "${fromSlug}" to "${intoSlug}"`,
      );
    }
    const updated = page.content.replace(re, `](${intoSlug}.md)`);
    if (updated === page.content) continue;
    await writeWikiPageWithSideEffects({
      slug: src,
      title: page.title,
      content: updated,
      summary: extractSummary(page.body.replace(/^#\s+.+$/m, "").trim()),
      logOp: "edit",
      crossRefSource: null, // a link re-point shouldn't re-run cross-ref
      author: actor,
    });
    repointed.push(src);
  }
  return repointed;
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
  // FRESH on both sides (DW-379). A merge folds two bodies into the survivor
  // and then HARD-DELETES `from`, so a side served from a stale `pageCache`
  // entry loses whatever was written to it in between — with no revision of it
  // anywhere, because the deleted page takes its history with it.
  const from = await readWikiPageWithFrontmatter(fromSlug, { fresh: true });
  if (!from) throw new Error(`page not found: ${fromSlug}`);
  const into = await readWikiPageWithFrontmatter(intoSlug, { fresh: true });
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

  // 1. Fold the bodies (accumulate-and-reconcile). `disputed` only escalates.
  let mergedBody = `${into.body}\n\n${from.body}`;
  let disputed =
    into.frontmatter.disputed === true || from.frontmatter.disputed === true;
  if (hasLLMKey()) {
    // DW-323: the merge door folds prose with the SAME reconcile prompt the
    // ingest door uses, so it must carry the same owner guidance. The
    // accountable owner is the SURVIVOR's — `into` is the page that keeps
    // existing, under that owner's Workspace Purpose and Names & Terms —
    // falling back to the acting principal when the survivor's frontmatter
    // names none. A cross-owner merge (trusted callers only,
    // `bypassOwnerCheck`) therefore folds under `into`'s guidance, never the
    // absorbed page's. Neither resolvable → `undefined`, and the prompt carries
    // no guidance block, exactly as before.
    //
    // Note this is NOT the same key the ingest door uses: `ingest()` keys
    // guidance on the ACTING principal, because there the actor is the one
    // writing the page. Re-ingesting into someone else's page therefore folds
    // under the ingester's Purpose, while merging into it folds under the page
    // owner's. What DW-323 makes identical across the two doors is that the
    // fold is GUIDED at all, not which principal guides it.
    //
    // The handle is passed RAW, exactly as `ingest()` passes its principal: an
    // agent handle (`alice--bot`) keys its own silo and so resolves no Wiki and
    // no guidance. Deliberate parity — the guard above collapses agents to their
    // human via `sameHumanOwner`, guidance does not, and inventing a collapse
    // here would make this door the only one that does it.
    const guidanceOwner = asString(into.frontmatter.owner) ?? actor;
    // One handle per merge: a merge is ONE operation. It states the merge's
    // guidance scope rather than leaving it implied, and it is the seam a second
    // guidance-consuming call would use. It also carries the dictionary probe
    // below into the reconcile, so that probe costs no extra read.
    const guidanceCache = createGuidanceCache();
    if (guidanceOwner) {
      // The two guidance halves fail DIFFERENTLY, and only one of them is safe
      // to leave in the fold's critical path. `buildWorkspaceGuidance` swallows
      // any read error and returns "". `listNamesTerms` RETHROWS a non-ENOENT
      // storage error — which, reaching the `catch` below, would be read as a
      // failed reconcile and cost the LLM fold entirely, leaving a crudely
      // appended survivor. An ingest can be retried against an intact page; a
      // merge hard-deletes `from`, so there is nothing left to retry against.
      // So probe the dictionary once here. On success the memo is what the
      // reconcile reads (one read, not two). On failure, pin an empty
      // dictionary in THIS handle so the reconcile renders no Names & Terms
      // block instead of re-reading and rejecting — the Purpose half still
      // reaches the prompt, and the fold still happens.
      try {
        await listNamesTerms(guidanceOwner, guidanceCache.namesTerms);
      } catch (err) {
        logger.warn(
          "merge",
          `names & terms dictionary unreadable for "${guidanceOwner}"; folding "${fromSlug}"→"${intoSlug}" without it`,
          err,
        );
        guidanceCache.namesTerms.set(guidanceOwner, Promise.resolve([]));
      }
    }
    try {
      const reconciled = await reconcilePage(
        into.body,
        from.body,
        guidanceOwner,
        guidanceCache,
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

  // 2. Build the merged frontmatter from `into`, unioning provenance.
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
  // Record `from`'s title AND slug as aliases of `into` so a later ingest under
  // that name converges here. This no longer affects routing — see the module
  // header: alias URL forwarding went with the retired commons route.
  fm.aliases = unionStrings(
    asStringArray(into.frontmatter.aliases),
    asStringArray(from.frontmatter.aliases),
    [from.title, fromSlug],
  ).filter((a) => a.toLowerCase() !== into.title.toLowerCase());
  fm.disputed = disputed;
  fm.confidence = computeConfidence(sources, disputed);
  const earliestCreated = earlierDate(
    into.frontmatter.created,
    from.frontmatter.created,
  );
  if (earliestCreated) fm.created = earliestCreated;
  // A merge re-verifies the page: bump `updated`, reset the staleness window.
  const today = new Date().toISOString().slice(0, 10);
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 90);
  fm.updated = today;
  fm.valid_from = today;
  fm.expiry = expiry.toISOString().slice(0, 10);

  // 3. Re-point backlinks BEFORE deleting `from`.
  const repointedBacklinksFrom = await repointBacklinks(
    fromSlug,
    intoSlug,
    actor,
  );

  // 4. Write the survivor. Defensive: if the folded body itself references the
  // absorbed slug, re-point that too — the delete-strip below only touches
  // OTHER pages, never the survivor.
  mergedBody = mergedBody.replace(
    new RegExp(`\\]\\(${escapeRegex(fromSlug)}\\.md\\)`, "g"),
    `](${intoSlug}.md)`,
  );
  const summary = extractSummary(mergedBody.replace(/^#\s+.+$/m, "").trim());
  await writeWikiPageWithSideEffects({
    slug: intoSlug,
    title: into.title,
    content: serializeFrontmatter(fm, mergedBody),
    summary,
    logOp: "edit",
    crossRefSource: null,
    author: actor,
  });

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
  await deleteWikiPage(fromSlug, actor);

  return { fromSlug, intoSlug, disputed, repointedBacklinksFrom };
}
