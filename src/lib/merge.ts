/**
 * Merge two existing wiki pages into one — the cure for same-concept duplicates
 * that slipped past ingest dedup (e.g. an X post and the article it's about,
 * ingested under different titles). Composes existing primitives rather than
 * adding a parallel write path:
 *
 *  - {@link reconcilePage} LLM-folds the two bodies into one canonical page
 *    (escalating `disputed` on contradiction), exactly like accumulate-and-
 *    reconcile on re-ingest.
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
import { parseSources, serializeSources } from "./sources";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter";
import {
  writeWikiPageWithSideEffects,
  deleteWikiPageWhileLocked,
  withPageLifecycleLock,
  type PageLifecycleLockHeld,
} from "./lifecycle";
import { getBacklinkIndex } from "./backlink-index";
import { escapeRegex } from "./links";
import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { sourceSha256 } from "./source-sha256";

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
  const index = await getBacklinkIndex();
  const candidates = index
    ? index[fromSlug] ?? []
    : (await listWikiPages()).map((e) => e.slug);
  const linkers = candidates.filter((s) => s !== fromSlug && s !== intoSlug);
  const re = new RegExp(`\\]\\(${escapeRegex(fromSlug)}\\.md\\)`, "g");
  const repointed: string[] = [];
  for (const src of linkers) {
    const page = await readWikiPageWithFrontmatter(src);
    if (!page) {
      // `src` was named as a linker by the index / page list, so a null read is
      // NOT an expected "no such page" — `readWikiPage` also collapses transient
      // storage faults to null. Abort rather than let the later hard-delete
      // strip an un-re-pointed link; `from` is left intact and the merge retries.
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
      expectedContent: page.content,
    });
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
  return withPageLifecycleLock(fromSlug, (held) => mergePagesWhileSourceLocked({
    from: fromSlug,
    into: intoSlug,
    actor,
    bypassOwnerCheck,
  }, held));
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
    // Fold exactly once. The durable operation receipt below preserves this
    // plan across backlink/delete failures, so Retry never folds the absorbed
    // Page into an already-merged survivor a second time.
    let mergedBody = `${into.body}\n\n${from.body}`;
    let disputed =
      into.frontmatter.disputed === true || from.frontmatter.disputed === true;
    if (hasLLMKey()) {
      try {
        const reconciled = await reconcilePage(into.body, from.body);
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
    fm.updated = today;
    fm.valid_from = today;
    fm.expiry = expiry.toISOString().slice(0, 10);
    mergedBody = mergedBody.replace(
      new RegExp(`\\]\\(${escapeRegex(fromSlug)}\\.md\\)`, "g"),
      `](${intoSlug}.md)`,
    );
    const summary = extractSummary(mergedBody.replace(/^#\s+.+$/m, "").trim());
    const candidate: MergeOperationReceipt = {
      version: 1,
      generation: crypto.randomUUID(),
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
  if (!currentFrom) {
    if (currentInto?.content !== receipt.mergedContent) {
      throw new Error("merge survivor changed after the absorbed Page was deleted");
    }
    await getStorage().deleteFile(operationPath).catch(() => undefined);
    await getStorage()
      .deleteFile(`${operationPath}.${receipt.generation}.survivor`)
      .catch(() => undefined);
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

  await writeWikiPageWithSideEffects({
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
  });

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
  await deleteWikiPageWhileLocked(fromSlug, sourceLock, actor, receipt.fromContent);
  await getStorage().deleteFile(operationPath).catch(() => undefined);
  await getStorage()
    .deleteFile(`${operationPath}.${receipt.generation}.survivor`)
    .catch(() => undefined);

  return { fromSlug, intoSlug, disputed: receipt.disputed, repointedBacklinksFrom };
}
