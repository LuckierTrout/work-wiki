/**
 * The Files tab's data source (Story 1.4): a bounded listing of what the kernel
 * actually has on disk for the current Wiki.
 *
 * SERVER ONLY — it reaches the storage provider, so it is imported from
 * `src/app/page.tsx` and never from a client component. The result is a flat
 * list of paths; `buildFileTree` in the client-safe `workbench-tree` module
 * does the nesting, so every ordering rule stays testable without storage.
 *
 * READ GATE. `listReadableWikiPages` is the only page-visibility filter there
 * is, and the Knowledge tab goes through it. A file listing that walked `wiki/`
 * raw would put the FILENAME of every page that filter excludes — agent-scoped
 * pages, another owner's private page in the legacy flat tree — into the same
 * column. So the caller passes the slug set that survived the filter, and the
 * `wiki/` half of what the listing admits is now EXACTLY what the read gate
 * serves. Three rules, and the gate applies all three: `wikiLeafName` for depth
 * (a direct child of the root, DW-204), `readableWikiLeaf` for "a `.md` whose
 * slug survived the filter" (DW-41), and — since DW-489 —
 * {@link electWikiLeafNames} over the SAME depth-1 entries, so where several
 * spellings of one `.md` name collide on a single slug the defeated ones neither
 * list nor read (see {@link wikiLeafFilter}). The set is a required argument,
 * not an option: omitting it must not be spellable.
 *
 * `raw/` NEEDS THE SAME GATE, from the other direction (DW-32). Every `raw/`
 * path is slug-derived — `raw/sources/<slug>/<sha>.md`, `raw/sources/<slug>.md`,
 * the silo-mirrored binary tree `raw/assets/<slug>/<file>` (DW-491), and the
 * pre-`sources` residue `raw/<slug>.md` — so passing every leaf through
 * put the FILENAME of a page the Knowledge tab hides into the tree the wiki
 * filter had just kept it out of. So the caller passes a second set, the slugs
 * its index named that the Knowledge tab does not show, and
 * {@link rawPathAllowed} refuses any `raw/` path spelling one — as a leaf, as a
 * DIRECTORY, and at the read gate. Not "everything not readable": a path whose
 * slug names no page at all is an ORPHANED source in the owner's own silo, and
 * it still lists and still reads.
 *
 * Three deliberate limits, all of them because `StorageProvider.listFiles` is
 * single-level in both providers and there is no recursive helper to add one to
 * (adding one would change the storage contract for every caller):
 *
 *   - The walk is breadth-first and depth-capped, so a pathological `raw/`
 *     nesting cannot fan out into thousands of R2 LIST calls on a page render.
 *   - It is node-capped, PER ROOT, and says so in the UI rather than silently
 *     truncating. Per root because a single cap spent entirely on `raw/` would
 *     leave `wiki/` rendering as an empty silo rather than as a truncated one.
 *   - It never `stat()`s a file. The listing carries no size or mtime and the
 *     tree renders neither, so a per-file round trip would buy nothing.
 *
 * A rejected listing degrades that subtree to empty instead of failing the
 * page: an unreadable `raw/` must not cost the owner their Knowledge tree.
 */

import { isEnoent } from "./errors";
import { logger } from "./logger";
import { RAW_ASSETS_DIR, RAW_SOURCES_DIR } from "./raw";
import { getStorage } from "./storage";
import {
  rawRelPath,
  tenantForOwner,
  tenantRawRelPath,
  tenantWikiRelPath,
  wikiRelPath,
} from "./wiki";
import { electWikiLeafNames, wikiLeafSlug } from "./wiki-file-names";
import { wikiDirPath } from "./wiki-paths";
import { WIKI_ARTIFACT_FILES } from "./wiki-scenarios";
import { readWikiArtifact } from "./wikis";
import {
  WORKBENCH_FILE_LIMIT,
  WORKBENCH_FILE_MAX_DEPTH,
  type WorkbenchSlugGate,
} from "./workbench-tree";

// One definition of each cap, declared in the client-safe module because the
// truncation sentence is derived from the node limit. Re-exported here so
// server callers keep a single import.
export { WORKBENCH_FILE_LIMIT, WORKBENCH_FILE_MAX_DEPTH };

// The read gate's name→slug half, which moved to the pure leaf module
// `wiki-file-names.ts` so `wiki.ts` could share the election with this module
// (DW-489/490). Re-exported from here because it was exported from here first:
// the preview route and both test files import it by this path and none of them
// needed to change.
export { wikiLeafSlug };

export interface WorkbenchFileListing {
  /** Tree-root-relative paths; a trailing `/` marks a directory. */
  paths: string[];
  /** True when a cap (node or depth) stopped the walk short. */
  truncated: boolean;
}

/**
 * The caller-supplied gate, plus the two caps.
 *
 * The gate is {@link WorkbenchSlugGate} itself rather than two fields restated
 * here, so a door cannot pass a `readableSlugs` derived from one knowledge tree
 * and a `hiddenSlugs` derived from another. Both are REQUIRED, so omitting
 * either is a compile error rather than a silently open root:
 *
 *   - `readableSlugs` — the slugs `listReadableWikiPages(principal)` returned
 *     and `buildKnowledgeTree` kept. Under the wiki root a leaf lists only if it
 *     is a direct child this set makes readable, so a non-`.md` leaf and
 *     anything deeper never appear — and not every such leaf lists either, since
 *     one name per slug is elected when spellings collide. Never a SUPERSET of
 *     what the gate serves, and since DW-489 not a strict subset either: the
 *     gate applies all three rules. See READ GATE and {@link wikiLeafFilter}.
 *   - `hiddenSlugs` — the slugs the index named that the Knowledge tab does not
 *     show. Under the `raw/` root a path (leaf OR directory) whose spelled slug
 *     is in this set neither lists nor reads: see {@link rawPathAllowed}.
 *
 * WHY THE CALLER DERIVES THEM. Which pages the Knowledge tab shows is a
 * rendering fact this module cannot know, and every door already holds the index
 * entries the pair comes from. Deriving it here would mean a second
 * `listWikiPages()` per listing, whose no-index fallback is a full per-page
 * frontmatter scan.
 */
export interface WorkbenchFileOptions extends WorkbenchSlugGate {
  /** Overridable only so the caps themselves are cheap to test. */
  limit?: number;
  maxDepth?: number;
}

interface Budget {
  remaining: number;
  truncated: boolean;
  maxDepth: number;
}

interface QueueItem {
  /** Storage-relative prefix passed to `listFiles`. */
  storage: string;
  /** Path as the tree shows it. */
  display: string;
  depth: number;
}

interface Listing {
  name: string;
  isDirectory: boolean;
}

/**
 * Is `displayPath` a DIRECT child of the `wiki/` display root? Its leaf name if
 * so, `null` otherwise — a deeper path, the bare root, a `raw/` path and a
 * root-level artifact filename all answer `null`.
 *
 * THE one spelling of that rule. It used to be three, agreeing only by
 * coincidence and by doc comments warning each other not to drift (DW-204):
 * `depth === 1` in {@link wikiLeafFilter}, `rest.length !== 1` in
 * {@link resolveWorkbenchFile}, and `segments.length === 2 && segments[0] ===
 * "wiki"` in the preview route's editable-Page slug derivation. All three call
 * this now, so the LISTING, the READ GATE and the Files tab's editable-Page
 * decision cannot disagree about what "a direct child of the wiki root" means.
 *
 * Exported for that third caller — `src/app/api/workbench/preview/route.ts` —
 * for exactly the reason {@link wikiLeafSlug} is exported: two expressions of
 * one rule is how `wiki/alpha.MD` was once gated in and then served with no
 * slug.
 *
 * An EMPTY leaf is not one: `"wiki/"` is the walk's directory marker, and
 * returning `""` for it would hand callers a falsy-but-not-null value to get
 * wrong. Every caller already refuses it downstream — `wikiLeafSlug("")` is
 * `null` and `isListablePath` rejects an empty segment outright — so this only
 * makes the answer honest at the source.
 */
export function wikiLeafName(displayPath: string): string | null {
  const segments = displayPath.split("/");
  if (segments.length !== 2 || segments[0] !== "wiki") return null;
  return segments[1].length > 0 ? segments[1] : null;
}

/** Drop a trailing extension; a leading dot is not one (`.env` keeps its name). */
function stripRawExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Is `raw/assets/<x>` the LEGACY NESTED SOURCE of a page slugged `assets`,
 * rather than the per-page binary root?
 *
 * The two trees collide on one prefix. `raw/assets/<slug>/<file>` is the binary
 * mirror, whose second segment is a page slug — but `raw/<slug>/<hash>.md` is
 * the pre-`sources` residue, and for the page slugged `assets` that residue is
 * spelled `raw/assets/<hash>.md`, identical in shape to a binary file sitting
 * directly under the root.
 *
 * A file EXTENSION is what tells them apart, and it is the same fact the
 * extension-strip above already relies on: `validateSlug` admits only lowercase
 * alphanumerics and hyphens, so a slug never contains a dot. So exactly one
 * remaining segment WITH a dot is a legacy file belonging to the page `assets`
 * — keep the head and read `assets` as the slug — while a dotless segment is a
 * per-page directory row and the head is dropped.
 *
 * Getting this backwards is a DISCLOSURE, not a cosmetic miss: dropping the
 * head unconditionally makes `rawPathSlug("raw/assets/ff00.md")` answer `ff00`,
 * so a hidden page slugged `assets` has its legacy source listed and served —
 * the DW-32 hole, merely relocated to a different slug.
 */
function isLegacyAssetsLeaf(segments: readonly string[]): boolean {
  return segments.length === 3 && segments[2].lastIndexOf(".") > 0;
}

/**
 * The page slug a `raw/` DISPLAY PATH spells, or `null` for a path that spells
 * none.
 *
 * Every writer in `raw.ts` addresses a Source by page slug —
 * `saveRawSource` writes `sources/<slug>.md`, `saveRawSourceFor` and
 * `saveRawSourceBytes` write `sources/<slug>/<rawId>.<ext>` — and the legacy
 * pre-`sources` residue (`raw/<slug>.md`, `raw/<slug>/<hash>.md`) puts the slug
 * in the very same position. So the rule is: drop `raw/`, drop a leading
 * STRUCTURAL ROOT segment (`sources`, and `assets` under the condition spelled
 * out below), and the FIRST remaining segment names the slug —
 * extension-stripped when it is the only one left, and joined with the next
 * segment when it is `queries`.
 *
 * `queries` is joined because `queries/<leaf>` is the ONE two-segment shape
 * `validateSlug` admits (`wiki.ts`); every other slug is lowercase alphanumeric
 * and hyphens with no dots and no slashes, which is what makes the
 * extension-strip unambiguous rather than a guess.
 *
 * A leading {@link RAW_SOURCES_DIR} or {@link RAW_ASSETS_DIR} segment is
 * DROPPED rather than read as a slug, because each is a fixed structural root
 * whose NEXT segment is the page slug: every Source lives under
 * `raw/sources/<slug>/…`, and `syncSiloForPage` mirrors the per-page binary
 * tree at `raw/assets/<slug>/<file>` (DW-491). Reading the root itself as a
 * spelled slug would let one page slugged `sources` blank the entire Sources
 * tree; NOT dropping `assets` did the opposite and worse — every hidden page's
 * `raw/assets/<slug>/` row derived the slug `assets`, so the directory row went
 * on announcing a page the Knowledge tab hides, which is the disclosure DW-32
 * exists to stop.
 *
 * The drop is EXCLUSIVE — one structural root is consumed, never two — so a
 * real page slugged `assets` still derives `assets` from
 * `raw/sources/assets/<hash>.md` and from the legacy flat `raw/assets.md`.
 * Sequential drops would turn the former into the slug `<hash>` and silently
 * unhide it.
 *
 * The `assets` drop carries ONE exception, because that root is the only one
 * whose prefix a real page can also occupy: `raw/assets/<hash>.md` is the
 * pre-`sources` nested residue of a page actually slugged `assets`, and it has
 * the same shape as a binary file directly under the root. The extension tells
 * them apart — see {@link isLegacyAssetsLeaf}, which is where that rule and the
 * disclosure it prevents are spelled out. `raw/assets/<slug>/…` is unambiguous
 * and always drops.
 *
 * Every OTHER first segment IS read as a slug, so `raw/parsed/…` derives
 * `parsed` — deliberately conservative, because the legacy flat shapes put a
 * real slug in exactly that position and the path alone cannot tell them apart.
 * If a hidden page were ever slugged `parsed`, that subtree is withheld: the
 * safe direction for a filter whose job is to withhold filenames, and the same
 * fail-closed direction {@link wikiLeafFilter} already takes. `raw/assets/` is
 * not conservative in that way for a reason: unlike `parsed`, that root has
 * writers putting a page slug in the segment beneath it, so reading the root as
 * the slug withholds nothing and discloses everything under it.
 *
 * Works on a DIRECTORY display path as well as a leaf, without the trailing
 * marker the walk appends — `raw/sources/agentpage` answers `agentpage`, which
 * is what lets one predicate refuse the directory row and its contents alike.
 */
export function rawPathSlug(displayPath: string): string | null {
  const segments = displayPath.split("/");
  if (segments[0] !== "raw") return null;
  const head = segments[1];
  const dropsHead =
    head === RAW_SOURCES_DIR ||
    (head === RAW_ASSETS_DIR && !isLegacyAssetsLeaf(segments));
  const rest = dropsHead ? segments.slice(2) : segments.slice(1);
  const first = rest[0];
  if (first === undefined || first.length === 0) return null;
  if (first === "queries" && rest.length > 1) {
    const leaf = rest.length === 2 ? stripRawExtension(rest[1]) : rest[1];
    return leaf.length > 0 ? `queries/${leaf}` : null;
  }
  const slug = rest.length === 1 ? stripRawExtension(first) : first;
  return slug.length > 0 ? slug : null;
}

/**
 * May this `raw/` display path be SHOWN or SERVED? THE one predicate answering
 * it (DW-32).
 *
 * `raw/` used to pass {@link allowEveryLeaf} unfiltered, so the filename of a
 * page the Knowledge tab hides was still spelled in the Files tree — a
 * disclosure identical to the one {@link wikiLeafFilter} exists to stop under
 * `wiki/`. The listing filter, the directory filter and
 * {@link resolveWorkbenchFile} all call THIS, rather than each restating the
 * rule, for the reason DW-41/DW-204 records: the filename, the directory name
 * and the bytes disclose the same slug, so one refusal has to cover all three.
 *
 * A path spelling NO slug (`raw/`, `raw/sources`) is allowed — there is nothing
 * to disclose — and so is a path whose slug is merely absent from the index: an
 * ORPHANED source is the owner's own file in the owner's own silo (`raw/` is
 * silo-only since DW-40), and refusing it would hide real data to protect
 * nothing. Hence a refusal SET rather than a readable-set membership test.
 */
export function rawPathAllowed(
  displayPath: string,
  hiddenSlugs: ReadonlySet<string>,
): boolean {
  if (hiddenSlugs.size === 0) return true;
  const slug = rawPathSlug(displayPath);
  return slug === null || !hiddenSlugs.has(slug);
}

/**
 * Decides whether one leaf may be listed, from the DISPLAY PATH the walk would
 * emit for it (`wiki/a.md`, `raw/sources/a/b.txt`). Directories go through
 * {@link DirFilter} instead.
 *
 * The whole path rather than the bare name, because a root's read gate can be
 * depth-sensitive — `resolveWorkbenchFile` serves only a direct child of
 * `wiki/` — so a filter that saw only the name would list leaves the Preview
 * refuses. A display path rather than a `(name, depth)` pair is what lets the
 * filter SHARE {@link wikiLeafName} with that gate instead of restating it as a
 * depth comparison (DW-204). The old numbering was its own trap: it was the
 * depth of the enumerated DIRECTORY, one LESS than the level
 * {@link WORKBENCH_FILE_MAX_DEPTH} counts for the leaf itself, so it could not
 * be compared against that constant either.
 */
type LeafFilter = (displayPath: string) => boolean;

/**
 * Decides whether one DIRECTORY may be listed and descended, from the display
 * path the walk would emit for it — WITHOUT the trailing `/` marker.
 *
 * A second filter rather than a widening of {@link LeafFilter}, because the two
 * roots need opposite answers. Under `raw/`, `raw/sources/<slug>/` spells a slug
 * in its OWN name, so a leaf-only filter would withhold the snapshot filenames
 * and leave the directory row announcing the page anyway (DW-32). Under `wiki/`
 * the only directories are structural (`wiki/query-history/`), and
 * {@link wikiLeafFilter}'s docblock records why they must keep listing — a
 * directory is a disclosure, not a previewable row. One filter stretched over
 * both would have to encode that asymmetry inside itself.
 *
 * A refused directory is a GATE decision, not truncation: nothing below it was
 * omitted for want of budget, exactly as for a refused leaf.
 */
type DirFilter = (displayPath: string) => boolean;

/**
 * The directory holding this Wiki's seeded artifacts.
 *
 * `wiki-paths.ts` owns the layout and exports this address directly, so there is
 * nothing to re-spell and nothing to derive: an earlier version of this function
 * sliced the trailing filename off `wikiArtifactPath` to avoid stating
 * `tenants/<t>/wikis/<id>` a second time, which `wikiDirPath` now does properly.
 */
function wikiArtifactDir(owner: string, wikiId: string): string {
  return wikiDirPath(owner, wikiId);
}

/**
 * One prefix listing, reporting WHETHER it failed as well as what it found.
 *
 * Both providers already answer ENOENT with an empty list, so `failed` is a
 * real error — unreadable, not absent. Callers that only render the result can
 * ignore the flag (the I/O matrix asks for an empty branch there); `resolveRoot`
 * cannot, because for it "empty" is a decision input.
 */
async function listSafely(prefix: string): Promise<{ entries: Listing[]; failed: boolean }> {
  try {
    return { entries: await getStorage().listFiles(prefix), failed: false };
  } catch (error) {
    // Degrade this branch, not the page: the other root and the Knowledge tab
    // are unaffected by one unreadable prefix.
    logger.error("workbench-files", `listFiles failed for "${prefix}"`, error);
    return { entries: [], failed: true };
  }
}

function visible(entries: Listing[]): Listing[] {
  // Dotfiles are storage bookkeeping, not the owner's files: `.indexes`,
  // `.revisions` and friends would otherwise dominate the tree.
  return entries.filter((entry) => !entry.name.startsWith("."));
}

/**
 * Prefix used only when the owner has no resolvable tenant. It must never be
 * the shared flat `raw/` tree: a guessed `raw/…` path would otherwise still
 * read legacy shared bytes even though the listing showed an empty silo.
 */
const UNRESOLVED_RAW_PREFIX = "tenants/_unresolved/raw";

/**
 * Pick which physical root backs a display root.
 *
 * DW-40: the two roots no longer share one fallback rule. `wiki/` stays
 * silo-first with a fallback to the shared flat tree so a pre-migration
 * workspace still lists pages. `raw/` is silo-only — an empty or unreadable
 * tenant raw silo never inherits filenames or bytes from the shared `raw/`
 * tree, which is what an owner whose silo has not been written yet would
 * otherwise leak. The first listing is kept and reused as the walk's level-1
 * seed, so preferring the silo costs no extra round trip in the common case.
 *
 * A FAILED silo listing is not an empty one. Both providers answer a missing
 * prefix with an empty list, so a rejection here means unreadable — and
 * falling back on it would answer a transient error by widening what the tab
 * shows to the shared transitional tree. The silo stays selected and renders
 * as the empty branch the I/O matrix asks for.
 *
 * `failed` IS REPORTED FOR THE WIKI ROOT TOO, on both returns that can carry an
 * unreadable listing — the silo-failed early return and the flat fallback.
 * `entries: []` alone cannot tell "this root holds nothing" from "we could not
 * find out", and since DW-489 {@link resolveWorkbenchFile} DECIDES on those
 * entries: without the flag a transient LIST blip would elect nothing and 404
 * every readable page in the root.
 */
async function resolveRoot(
  kind: "wiki" | "raw",
  siloPrefix: string | null,
  flatPrefix: string,
): Promise<{ prefix: string; entries: Listing[]; failed?: boolean }> {
  if (kind === "raw") {
    if (!siloPrefix) {
      return { prefix: UNRESOLVED_RAW_PREFIX, entries: [], failed: true };
    }
    const silo = await listSafely(siloPrefix);
    if (silo.failed) return { prefix: siloPrefix, entries: [], failed: true };
    return { prefix: siloPrefix, entries: visible(silo.entries) };
  }

  if (siloPrefix) {
    const silo = await listSafely(siloPrefix);
    if (silo.failed) return { prefix: siloPrefix, entries: [], failed: true };
    const entries = visible(silo.entries);
    if (entries.length > 0) return { prefix: siloPrefix, entries };
  }
  const flat = await listSafely(flatPrefix);
  return { prefix: flatPrefix, entries: visible(flat.entries), failed: flat.failed };
}

/** Breadth-first walk of one root, appending display paths into `out`. */
async function walkRoot(
  root: { prefix: string; entries: Listing[] },
  displayRoot: string,
  out: string[],
  budget: Budget,
  allowLeaf: LeafFilter,
  allowDir: DirFilter,
): Promise<void> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return;
  }
  // The root itself is a node, so an empty `raw/` is still visibly present —
  // "no sources yet" and "the silo is missing" are different facts.
  out.push(`${displayRoot}/`);
  budget.remaining -= 1;

  const seeded = new Map<string, Listing[]>([[root.prefix, root.entries]]);
  const queue: QueueItem[] = [{ storage: root.prefix, display: displayRoot, depth: 1 }];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const seed = seeded.get(node.storage);
    const entries = seed ?? visible((await listSafely(node.storage)).entries);
    if (node.depth >= budget.maxDepth) {
      // Descending would produce level `maxDepth + 1`. Only claim truncation if
      // something down there would actually have been SHOWN — a directory whose
      // only contents are filtered-out leaves is omitting nothing — and neither
      // is one whose only contents are directories the gate refuses.
      if (
        entries.some((e) => {
          const display = `${node.display}/${e.name}`;
          return e.isDirectory ? allowDir(display) : allowLeaf(display);
        })
      ) {
        budget.truncated = true;
      }
      continue;
    }
    for (const entry of entries) {
      const display = `${node.display}/${entry.name}`;
      if (!(entry.isDirectory ? allowDir(display) : allowLeaf(display))) continue;
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return;
      }
      out.push(entry.isDirectory ? `${display}/` : display);
      budget.remaining -= 1;
      if (entry.isDirectory) {
        queue.push({
          storage: `${node.storage}/${entry.name}`,
          display,
          depth: node.depth + 1,
        });
      }
    }
  }
}

/**
 * The FILE names among a root's depth-1 entries — the election's input, spelled
 * once because {@link wikiLeafFilter} and {@link resolveWorkbenchFile} must feed
 * {@link electWikiLeafNames} exactly the same candidates from exactly the same
 * listing (DW-489). Directories are dropped: a directory named `cased.md` is not
 * a page and must not be able to defeat the file that is.
 */
function wikiLeafNamesIn(entries: readonly Listing[]): string[] {
  return entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
}

/**
 * May `wiki/<name>` be LISTED?
 *
 * A filename is a disclosure — that is this filter's reason, and it is not the
 * read gate's, which is about bytes. But the admissible set is now DERIVED from
 * the read gate rather than restated (DW-41): a row whose Preview answers
 * `PREVIEW_FAILED_COPY` reads as a broken Preview, not as a gate, and the two
 * filters had drifted far enough apart that `wiki/notes.txt`, `wiki/dump.json`
 * and the legacy shared `wiki/query-history.json` were listed as clickable rows
 * that could only fail — as were the interim per-owner
 * `wiki/query-history/<key>.json` files, a legacy location `query-history.ts`
 * still finds and migrates into the tenant silo. So the set is a SUBSET of what
 * {@link resolveWorkbenchFile} will serve: {@link wikiLeafName}, the one spelling
 * of "a direct child of the wiki root" that the gate itself now calls, and
 * {@link readableWikiLeaf} for the name — which also drops the generated
 * `index.md`, correctly, since it has no slug and is not the owner's writing.
 * Since DW-489 it is an EQUALITY, not a strict subset: the gate applies
 * {@link wikiLeafName} (depth), {@link readableWikiLeaf} (the `.md`-and-slug
 * test, which is `wikiLeafSlug` plus the slug set — the extension is NOT
 * `wikiLeafName`'s business, `wikiLeafName("wiki/notes.txt")` is `"notes.txt"`)
 * and the elected-winner rule below, all three. Derived from the gate, and now
 * coextensive with it under this root.
 *
 * Directories are never leaf-filtered, so `wiki/query-history/` itself still
 * lists: a directory is a disclosure, not a previewable row (`selectionExists`
 * in `workbench-tree.ts` refuses one for that reason), so it cannot produce the
 * refusal sentence.
 *
 * ONE LISTABLE ROW PER SLUG (DW-202/203). {@link wikiLeafSlug} is
 * case-insensitive on the extension, so on a case-SENSITIVE store `cased.md`,
 * `cased.MD` and `cased.Md` are three objects carrying the ONE slug `cased`. The
 * Preview route hands every such row that same slug, so an edit reached from any
 * of them writes `cased.md` — and the bytes previewed from the others go stale,
 * or, where no `cased.md` existed yet, a third object appears out of nowhere. So
 * exactly one name per slug is ELECTED from `rootEntries` and only that name may
 * list.
 *
 * The election itself is {@link electWikiLeafNames}, in the pure leaf module
 * `wiki-file-names.ts` — NOT restated here, because {@link resolveWorkbenchFile}
 * and `wiki.ts`'s page key now decide from the same function (DW-489/490) and
 * three copies of a total order is how they would drift apart again. That
 * docblock carries the rule and the reasons: canonical-else-lexicographic-first,
 * total rather than conditional, and a lone variant winning its own slug.
 *
 * `rootEntries` are the depth-1 entries {@link resolveRoot} already returned and
 * {@link walkRoot} is already seeded with, so the decision costs no `stat()` and
 * no extra round trip — the names alone decide it. THAT SHARING IS LOAD-BEARING:
 * the filter can only recognise a winner it saw while building the set, so it is
 * correct exactly while the names it is asked about come from the same listing.
 * Any other name FAILS CLOSED (it is absent from the set, so it does not list),
 * which is the safe direction for a filter whose job is to withhold filenames —
 * and is also why every deeper leaf is refused for a second, independent reason
 * beyond {@link wikiLeafName}.
 *
 * Dropping a defeated name is a GATE decision, not a truncation: the emit loop's
 * `continue` leaves `budget.truncated` alone, the same as every other leaf this
 * filter refuses. The admissible set therefore stays a SUBSET of what
 * {@link resolveWorkbenchFile} will serve, which is the DW-41 invariant — and
 * since DW-489 the `wiki/` half of it is an EQUALITY on this respect: the gate
 * elects over the same entries, so `wiki/cased.MD` no longer hands back its
 * bytes when the listing elected `wiki/cased.md` against it.
 */
function wikiLeafFilter(
  readableSlugs: ReadonlySet<string>,
  rootEntries: readonly Listing[],
): LeafFilter {
  // One winner per slug, from the shared election over the root's own names —
  // NOT from a second expression of the read gate: `readableWikiLeaf` stays the
  // one boolean that answers "may these bytes be read" (DW-41), and is applied
  // to the name below exactly as before.
  const listable = new Set(electWikiLeafNames(wikiLeafNamesIn(rootEntries)).values());
  return (displayPath) => {
    const name = wikiLeafName(displayPath);
    return name !== null && readableWikiLeaf(name, readableSlugs) && listable.has(name);
  };
}

/**
 * The `raw/` root's filter, applied to LEAVES and DIRECTORIES alike.
 *
 * Depth-insensitive on purpose: `resolveWorkbenchFile` applies
 * {@link wikiLeafName} to the `wiki/` branch only and puts no depth bound at all
 * on the `raw/` branch, so a nested source at any listable depth both lists and
 * reads — unless {@link rawPathAllowed} refuses the slug its path spells, which
 * is the SAME predicate that branch of the read gate applies (DW-32).
 */
function rawFilter(hiddenSlugs: ReadonlySet<string>): LeafFilter & DirFilter {
  return (displayPath) => rawPathAllowed(displayPath, hiddenSlugs);
}

/**
 * `wiki/` directories are never filtered — see {@link DirFilter} and
 * {@link wikiLeafFilter} for why that asymmetry with `raw/` is load-bearing.
 */
const allowEveryDir: DirFilter = () => true;

/**
 * Every path the Files tab shows for `wikiId`, as the owner's storage has them.
 *
 * The tree's own order is `buildFileTree`'s (directories before files, each
 * alphabetically), so the rendered root reads `raw/`, `wiki/`, `purpose.md`,
 * `schema.md`. The two seeded artifacts are emitted first here only so they
 * cannot be squeezed out by a large silo, and they are shown at the tree root
 * even though they physically live under `tenants/<t>/wikis/<id>/`: they are
 * what is per-Wiki, and burying them three synthetic levels deep would make the
 * one thing that changes on a Wiki switch the hardest thing to find.
 *
 * `wiki/` and `raw/` are the owner's single silo — Pages and Sources are not
 * partitioned per Wiki (`src/lib/wikis.ts:16-17`), so both roots are the same
 * under either Wiki. That is a storage fact, not a rendering choice.
 *
 * Story 1.4's Wiki-switch acceptance criterion (`### Story 1.4` in
 * `_bmad-output/planning-artifacts/epics.md`) observes exactly that: the Files
 * tree shows that Wiki's `purpose.md` and Schema, and Pages and Sources are
 * shared. Keeping it flat and rewording the AC is DW-30's recorded decision, so
 * the AC is NOT owed partitioning work — a Wiki is a lens, and the left column
 * says so (`WIKI_SCOPE_COPY` in `workbench-tree.ts`). Repartitioning the silo
 * per Wiki is DW-17 (ingest, index, silo, graph, MCP), not a gap here.
 */
export async function listWorkbenchFilePaths(
  owner: string,
  wikiId: string | null,
  options: WorkbenchFileOptions,
): Promise<WorkbenchFileListing> {
  const budget: Budget = {
    remaining: options.limit ?? WORKBENCH_FILE_LIMIT,
    truncated: false,
    maxDepth: options.maxDepth ?? WORKBENCH_FILE_MAX_DEPTH,
  };
  const paths: string[] = [];

  if (wikiId) {
    // One listing, not one `fileExists` per artifact: the tab must not claim a
    // file the template never wrote, and this costs a single round trip.
    let dir: string | null = null;
    try {
      dir = wikiArtifactDir(owner, wikiId);
    } catch (error) {
      // An unparseable owner or id is the caller's bug, not a reason to 500 the
      // Workbench — the rest of the tree is still real.
      logger.error("workbench-files", "could not resolve the wiki artifact dir", error);
    }
    if (dir) {
      const { entries } = await listSafely(dir);
      const present = new Set(entries.filter((e) => !e.isDirectory).map((e) => e.name));
      for (const file of WIKI_ARTIFACT_FILES) {
        if (!present.has(file)) continue;
        if (budget.remaining <= 0) {
          budget.truncated = true;
          break;
        }
        paths.push(file);
        budget.remaining -= 1;
      }
    }
  }

  // The tenant silo is primary. `wiki/` still falls back to the flat tree
  // `listWikiPages()` reads, for pre-migration workspaces. `raw/` does not:
  // DW-40 retired that fallback so an empty owner silo cannot list shared
  // legacy sources.
  let siloRaw: string | null = null;
  let siloWiki: string | null = null;
  try {
    const tenant = tenantForOwner(owner);
    siloRaw = tenantRawRelPath(tenant, "");
    siloWiki = tenantWikiRelPath(tenant, "");
  } catch (error) {
    // A tenant that will not validate leaves `wiki/` on the flat root — still
    // a real tree, still gated by `readableSlugs`. It leaves `raw/` with
    // NOTHING: the raw arm answers a null silo with the unresolved sentinel
    // rather than the shared flat tree (DW-40), so an owner whose handle will
    // not resolve gets an empty `raw/`, never someone else's sources.
    logger.error("workbench-files", "could not resolve the owner's silo", error);
  }

  // `raw/` is walked first under HALF the remaining budget, then `wiki/` gets
  // everything left (never less than that half). Without the split, one large
  // silo would spend the whole cap and the other would render as an empty
  // directory — indistinguishable from a missing one.
  const rawShare = Math.max(1, Math.floor(budget.remaining / 2));
  const rawBudget: Budget = {
    remaining: rawShare,
    truncated: false,
    maxDepth: budget.maxDepth,
  };
  // ONE filter for both roles under `raw/`: a directory refused here is not
  // descended, so the snapshot filenames below it never reach the leaf test —
  // and the directory row that would otherwise announce the page is gone too.
  const rawGate = rawFilter(options.hiddenSlugs);
  await walkRoot(
    await resolveRoot("raw", siloRaw, rawRelPath("")),
    "raw",
    paths,
    rawBudget,
    rawGate,
    rawGate,
  );
  budget.remaining -= rawShare - rawBudget.remaining;
  budget.truncated = budget.truncated || rawBudget.truncated;

  // Hoisted out of the call, unlike `raw/`'s, because the filter needs the SAME
  // depth-1 entries the walk is seeded with: the canonical-row rule is decided
  // from names already in hand, never from a second listing (DW-202/203).
  const wikiRoot = await resolveRoot("wiki", siloWiki, wikiRelPath(""));
  await walkRoot(
    wikiRoot,
    "wiki",
    paths,
    budget,
    wikiLeafFilter(options.readableSlugs, wikiRoot.entries),
    allowEveryDir,
  );

  return { paths, truncated: budget.truncated };
}

/**
 * Page `raw/sources/**` files only, with skip+take, without spending the walk
 * on `wiki/` or directory nodes.
 *
 * The Files tab listing is a mixed tree with a {@link WORKBENCH_FILE_LIMIT}
 * node cap (2,000) that also counts `raw/`, `wiki/`, and every directory.
 * `raw/` already has its own half-share, so `wiki/` cannot consume the
 * Sources budget. An implicit rescan that sliced the tab list still stopped
 * early because the tab's per-root budget and node-count paging are not a
 * Sources offset. This walk is the rescan's own listing: files under
 * `raw/sources/` only.
 *
 * THE GATE IS NOT THE CALLER'S TO COMPOSE. `hiddenSlugs` is required and
 * {@link rawPathAllowed} is applied INSIDE the walk — to the `raw/sources/*`
 * descent as well as to the leaves — while the caller's `allow` stays the SCOPE
 * filter it always was. Left to the caller, a second call site could get an
 * ungated enumeration of every hidden page's sources simply by omitting a
 * callback, which is the shape of omission DW-32 found in the tab listing.
 */
export async function listRawSourceFilePaths(
  owner: string,
  options: {
    offset?: number;
    limit: number;
    maxDepth?: number;
    /** Caller SCOPE (format, contract), never the gate — see above. */
    allow?: (displayPath: string) => boolean;
    /** {@link WorkbenchSlugGate}'s refusal set. Required, like `readableSlugs`. */
    hiddenSlugs: ReadonlySet<string>;
  },
): Promise<{
  paths: string[];
  more: boolean;
  remaining: number;
  failed: boolean;
}> {
  const skip = Math.max(0, Math.round(options.offset ?? 0));
  const take = Math.max(1, Math.round(options.limit));
  const maxDepth = options.maxDepth ?? WORKBENCH_FILE_MAX_DEPTH;
  const allow = options.allow ?? (() => true);
  // The GATE, not the scope filter: `allow` narrows to what the caller can use,
  // this refuses what no caller may see. Composed here so it cannot be omitted.
  const gated = (display: string) => rawPathAllowed(display, options.hiddenSlugs);

  let siloRaw: string | null = null;
  let failed = false;
  let nestedFailed = false;
  try {
    siloRaw = tenantRawRelPath(tenantForOwner(owner), "");
  } catch (error) {
    failed = true;
    logger.error("workbench-files", "could not resolve the owner's silo", error);
  }
  const root = await resolveRoot("raw", siloRaw, rawRelPath(""));
  if (root.failed) failed = true;

  const collected: string[] = [];
  let seen = 0;
  let remaining = 0;
  const seeded = new Map<string, Listing[]>([[root.prefix, root.entries]]);
  const queue: QueueItem[] = [
    { storage: root.prefix, display: "raw", depth: 1 },
  ];

  const underSources = (display: string) =>
    display === "raw/sources" || display.startsWith("raw/sources/");
  const towardSources = (display: string) =>
    display === "raw" ||
    underSources(display) ||
    "raw/sources".startsWith(`${display}/`);

  while (queue.length > 0) {
    const node = queue.shift()!;
    const seed = seeded.get(node.storage);
    let entries: Listing[];
    if (seed) {
      entries = seed;
    } else {
      const listed = await listSafely(node.storage);
      if (listed.failed) {
        // Skip this subdirectory. Poisoning the whole page here discarded
        // siblings and made an implicit rescan loop on the same offset.
        nestedFailed = true;
        continue;
      }
      entries = visible(listed.entries);
    }
    if (node.depth >= maxDepth) {
      // Files past the depth cap are not pageable. If the cap hides the
      // `raw/sources` branch (or anything already below it), the enumeration is
      // incomplete rather than empty: advancing an offset over an unseen
      // subtree would silently lose Sources.
      const hidesSource = entries.some((entry) => {
        const display = `${node.display}/${entry.name}`;
        // A subtree the GATE refuses is not one the cap hid: it was never
        // going to be enumerated, so the page is still complete over what the
        // caller may see.
        if (entry.isDirectory) return towardSources(display) && gated(display);
        return (
          display.startsWith("raw/sources/") && gated(display) && allow(display)
        );
      });
      if (hidesSource) nestedFailed = true;
      continue;
    }
    for (const entry of entries) {
      const display = `${node.display}/${entry.name}`;
      if (entry.isDirectory) {
        if (towardSources(display) && gated(display)) {
          queue.push({
            storage: `${node.storage}/${entry.name}`,
            display,
            depth: node.depth + 1,
          });
        }
        continue;
      }
      if (!display.startsWith("raw/sources/") || !gated(display)) continue;
      if (!allow(display)) continue;
      if (seen < skip) {
        seen += 1;
        continue;
      }
      if (collected.length < take) {
        collected.push(display);
      } else {
        remaining += 1;
      }
      seen += 1;
    }
  }
  // An offset is meaningful only over a complete ordered set. Returning the
  // readable siblings from a partial tree would both lose the unreadable
  // branch and advance the caller past an ordering we never observed.
  if (failed || nestedFailed) {
    return { paths: [], more: false, remaining: 0, failed: true };
  }
  return { paths: collected, more: remaining > 0, remaining, failed: false };
}

// ---------------------------------------------------------------------------
// Reading one file back (Story 1.5)
// ---------------------------------------------------------------------------

/**
 * May the bytes of `wiki/<name>` be READ?
 *
 * The narrow one: a `.md` leaf (case-insensitively, because a filesystem may
 * not be) whose slug is in the readable set. Everything else under the root is
 * refused, including the generated `index.md`, which has no slug and so never
 * survives this test either. `resolveRoot` still falls back to the SHARED
 * flat `wiki/` root when the caller's silo is empty, so `wiki/scratch.txt`,
 * `wiki/dump.json` or `wiki/notes.markdown` would otherwise hand back bytes
 * that need not be the caller's. `raw/` has no such fallback (DW-40).
 *
 * {@link wikiLeafFilter} — the LISTING filter — now DERIVES its admissible set
 * from this predicate (DW-41), so the Files tab can no longer show a `wiki/`
 * row this gate would refuse. Derives, and — under this root, since DW-489 —
 * now EQUALS: the three rules the listing applies are the three
 * {@link resolveWorkbenchFile} applies, so "listed" and "readable" are one
 * answer rather than two that happen to agree.
 *
 * THE ELECTED-WINNER RULE WAS THE LAST GAP (DW-489). The listing showed only
 * the elected spelling of a slug while this gate served
 * every spelling, so a deep link or a selection restored from `workbench-state`
 * could preview `wiki/cased.MD` — with slug `cased` and `editable: true` — while
 * a save landed on `wiki/cased.md`, one object previewed and another written.
 * {@link resolveWorkbenchFile} now applies {@link electWikiLeafNames} to the
 * depth-1 entries {@link resolveRoot} already returned, so a defeated spelling
 * answers the same indistinguishable `null` every other refusal answers. The
 * case-INSENSITIVE store is untouched by that: there `listFiles` returns ONE
 * name for the Page, whatever casing was written, so that name wins its own slug
 * and keeps listing and reading.
 *
 * Note the DIRECTION of this predicate's own reach: it decides a NAME, not an
 * object, and it stays deliberately case-insensitive on the extension. The
 * election is what picks among the names it admits, and it lives in
 * `wiki-file-names.ts` rather than here because `wiki.ts` shares it (DW-490).
 *
 * The two are still two functions, and still must be: their REASONS differ.
 * The listing's is that a FILENAME is a disclosure;
 * this one's is that BYTES from a possibly-shared flat root are a larger one.
 * Re-unifying them into a single function is refused for that reason — one
 * function would make the narrower reason invisible, and the next widening of
 * the listing (a Files tab that showed sizes, say, or a per-Wiki partition per
 * DW-17) would silently widen the read too. Derive, do not merge.
 *
 * The name→slug half is {@link wikiLeafSlug}, which now lives in the pure leaf
 * module `wiki-file-names.ts` and is RE-EXPORTED from here (see the re-export
 * near the top). It is exported because the preview route has to answer the same
 * question to decide whether a `wiki/` file selection is the editable Page
 * reached from the other tab. Two expressions of one rule is exactly how
 * `wiki/alpha.MD` was once gated in and then served with no slug.
 */
function readableWikiLeaf(name: string, readableSlugs: ReadonlySet<string>): boolean {
  const slug = wikiLeafSlug(name);
  return slug !== null && readableSlugs.has(slug);
}

/**
 * Is this string shaped like a path the walk above could have emitted?
 *
 * Checked BEFORE anything touches storage, and by shape rather than by
 * canonicalisation: `..`, an absolute path, a backslash and an empty segment are
 * all rejected outright instead of normalised into something that looks safe.
 * A leading dot is rejected for the same reason `visible()` filters it — the
 * walk never shows a dotfile, so a read of one is not a read of a listed path.
 */
function isListablePath(displayPath: string): boolean {
  if (typeof displayPath !== "string" || displayPath.length === 0) return false;
  if (displayPath.includes("\\") || displayPath.includes("\0")) return false;
  if (displayPath.startsWith("/")) return false;
  const segments = displayPath.split("/");
  if (segments.length > WORKBENCH_FILE_MAX_DEPTH) return false;
  return segments.every((segment) => segment.length > 0 && !segment.startsWith("."));
}

function isArtifactFile(name: string): name is (typeof WIKI_ARTIFACT_FILES)[number] {
  return (WIKI_ARTIFACT_FILES as readonly string[]).includes(name);
}

/** One storage read, degrading a missing or unreadable key to null. */
async function readSafely(key: string): Promise<string | null> {
  try {
    return await getStorage().readFile(key);
  } catch (error) {
    if (!isEnoent(error)) {
      logger.error("workbench-files", `readFile failed for "${key}"`, error);
    }
    return null;
  }
}

/**
 * What a display path resolves to, once it has passed validation and the gate.
 *
 * Two shapes because the two live in different places: a seeded artifact is
 * addressed by `readWikiArtifact` (the Always clause names that function, and
 * it is the one definition of the `tenants/<t>/wikis/<id>/` layout), while a
 * `wiki/` or `raw/` leaf is an ordinary storage key under a silo-first root.
 */
type ResolvedWorkbenchFile =
  | { kind: "artifact"; file: (typeof WIKI_ARTIFACT_FILES)[number] }
  | { kind: "key"; key: string };

/**
 * Validate, gate, and resolve a DISPLAY path — the path the Files tab prints,
 * which is not the storage key that holds the bytes (`spec-1-4` deferred
 * entry 2).
 *
 * This is the resolver that gap asked for, and it lives beside the walk that
 * produced the path so the two share one definition of every rule:
 *
 *   - `purpose.md` / `schema.md` are shown at the tree ROOT but physically live
 *     at `tenants/<t>/wikis/<id>/<file>`, so they resolve through
 *     `readWikiArtifact` — and without a current Wiki they resolve to nothing.
 *   - `wiki/<name>.md` passes {@link wikiLeafName} and then
 *     {@link readableWikiLeaf} — the read gate, and the same two predicates
 *     {@link wikiLeafFilter} derives the LISTING's admissible set from, for the
 *     reason that function documents. {@link wikiLeafName} is why the listing is
 *     depth-bounded too: one function, called by both, rather than this branch's
 *     old `rest.length !== 1` and a matching `depth === 1` over there (DW-204).
 *     It then passes {@link electWikiLeafNames} over the root's own depth-1
 *     entries, which is the third shared rule (DW-489) and the only one that
 *     cannot be decided before the root is resolved — see below.
 *   - `raw/…` and `wiki/…` both resolve their root through {@link resolveRoot},
 *     so each root has exactly one definition — including that a FAILED silo
 *     listing keeps the silo selected instead of widening to the flat tree,
 *     and that `raw/` never falls back when the silo is merely empty.
 *
 * Every rejection is the same `null`. Callers answer one indistinguishable 404
 * for all of them, so "gated out" and "absent" must not be tellable apart from
 * here either — including the newest refusal, a `wiki/` spelling the listing
 * elected against, which withholds only paths the listing never emitted and so
 * cannot be an existence oracle for anything.
 */
async function resolveWorkbenchFile(
  owner: string,
  wikiId: string | null,
  displayPath: string,
  options: WorkbenchFileOptions,
): Promise<ResolvedWorkbenchFile | null> {
  if (!isListablePath(displayPath)) return null;
  const segments = displayPath.split("/");

  // A seeded artifact — the only thing in the tree that is genuinely per-Wiki.
  if (segments.length === 1) {
    if (!wikiId || !isArtifactFile(segments[0])) return null;
    return { kind: "artifact", file: segments[0] };
  }

  const [root, ...rest] = segments;
  if (root !== "wiki" && root !== "raw") return null;

  // The gate, applied before the root is even resolved: a leaf under the wiki
  // root is readable only when it is a DIRECT child (`wikiLeafName`, the one
  // spelling of that rule — DW-204) that is a `.md` whose slug survived
  // `listReadableWikiPages`.
  //
  // HOISTED because the election below needs this exact value. Re-deriving the
  // leaf down there (as `rest[0]`, say) would be a SECOND expression of "which
  // segment is the leaf" in the one module whose history is two expressions of
  // one rule drifting until `wiki/alpha.MD` was gated in and then served with
  // no slug. Non-null exactly when this is a gated-in wiki leaf, which is also
  // what tells the election below that it has something to decide.
  let wikiLeaf: string | null = null;
  if (root === "wiki") {
    wikiLeaf = wikiLeafName(displayPath);
    if (wikiLeaf === null || !readableWikiLeaf(wikiLeaf, options.readableSlugs)) return null;
  }

  // The `raw/` half of the gate (DW-32), and the SAME predicate the listing
  // filter applies — the filename, the directory name and the bytes disclose
  // the same slug, so one refusal covers all three. Depth-insensitive, unlike
  // the `wiki/` branch: a source may be nested at any listable depth, and the
  // slug it spells is in the same position either way.
  if (root === "raw" && !rawPathAllowed(displayPath, options.hiddenSlugs)) {
    return null;
  }

  let silo: string | null = null;
  try {
    const tenant = tenantForOwner(owner);
    silo = root === "wiki" ? tenantWikiRelPath(tenant, "") : tenantRawRelPath(tenant, "");
  } catch (error) {
    logger.error("workbench-files", "could not resolve the owner's silo", error);
  }
  const flat = root === "wiki" ? wikiRelPath("") : rawRelPath("");
  const { prefix, entries, failed } = await resolveRoot(root, silo, flat);
  if (root === "raw" && (prefix === UNRESOLVED_RAW_PREFIX || !silo)) return null;

  // ONE ROW PER SLUG, AT THE GATE TOO (DW-489). The listing elects one spelling
  // of a slug from the root's depth-1 entries; serving a defeated spelling here
  // is what let a deep link preview `wiki/cased.MD` and save `wiki/cased.md`.
  //
  // Decided from the entries `resolveRoot` ALREADY returned — the same value
  // `listWorkbenchFilePaths` hands `wikiLeafFilter`, reduced to a set of elected
  // names by the SAME expression that filter uses — so the two answers are
  // identical BY CONSTRUCTION rather than by agreement, and at no `stat()`, no
  // second listing and no extra storage call. It has to sit here rather than
  // beside the gate above for exactly that reason: the entries do not exist
  // until the root is resolved.
  //
  // AN UNREADABLE LISTING FAILS OPEN, and this is the one place in this module
  // where that is the safe direction. A rejected `listFiles` yields `entries:
  // []`, which would elect nothing and turn a transient R2 LIST blip into a 404
  // on EVERY page in the root — perfectly readable by key, and readable again a
  // second later. That is `listSafely`'s "degrade this branch, not the page"
  // pointed at the page, and the same failure `readWikiPage`'s strict mode
  // exists to prevent: absence reported for a blip is what authorizes a
  // destructive fix. Failing open discloses NOTHING, because this election is
  // not the security gate — `readableWikiLeaf` above is (DW-41), and it has
  // already run. All the election does is pick among spellings of a slug the
  // caller may already read, so an indeterminate candidate set can only serve a
  // sibling casing of a permitted page, never a page the gate would withhold.
  //
  // On a case-INSENSITIVE store this changes nothing: `listFiles` returns ONE
  // name for the Page, so that name wins its own slug and still reads.
  if (wikiLeaf !== null && !failed) {
    const listable = new Set(electWikiLeafNames(wikiLeafNamesIn(entries)).values());
    if (!listable.has(wikiLeaf)) return null;
  }

  return { kind: "key", key: `${prefix}/${rest.join("/")}` };
}

/**
 * Read the bytes behind a display path, or null for anything refused, absent or
 * unreadable — see {@link resolveWorkbenchFile} for the rules.
 */
export async function readWorkbenchFile(
  owner: string,
  wikiId: string | null,
  displayPath: string,
  options: WorkbenchFileOptions,
): Promise<{ content: string } | null> {
  const resolved = await resolveWorkbenchFile(owner, wikiId, displayPath, options);
  if (!resolved) return null;
  if (resolved.kind === "artifact") {
    try {
      const content = await readWikiArtifact(owner, wikiId!, resolved.file);
      return content === null ? null : { content };
    } catch (error) {
      logger.error("workbench-files", `artifact read failed for "${displayPath}"`, error);
      return null;
    }
  }
  const content = await readSafely(resolved.key);
  return content === null ? null : { content };
}

/**
 * Read the RAW BYTES behind a display path (Story 7.7).
 *
 * The byte twin of {@link readWorkbenchFile}, and it exists because an image or
 * an audio file is not a string: `readFile` decodes UTF-8, which corrupts a PNG
 * on the way through. It goes through the SAME {@link resolveWorkbenchFile}, so
 * the media door's reach is identical to the Preview's by construction rather
 * than by two validators that agree today.
 *
 * Artifacts are refused outright rather than re-encoded. They are always `.md`,
 * so a media request naming one is asking for something that does not exist.
 */
export async function readWorkbenchFileBytes(
  owner: string,
  wikiId: string | null,
  displayPath: string,
  options: WorkbenchFileOptions,
): Promise<ArrayBuffer | null> {
  const resolved = await resolveWorkbenchFile(owner, wikiId, displayPath, options);
  if (!resolved || resolved.kind !== "key") return null;
  try {
    return await getStorage().readAsset(resolved.key);
  } catch (error) {
    if (!isEnoent(error)) {
      logger.error("workbench-files", `readAsset failed for "${displayPath}"`, error);
    }
    return null;
  }
}

/**
 * Does a display path name a file the caller may read — WITHOUT buffering it?
 *
 * For a format the Preview cannot render (a PDF, an image, an extensionless
 * blob) the answer is a sentence, not bytes. Reading the file first and then
 * discarding it would pull an arbitrarily large object through the Worker to
 * decide something its NAME already decided. The path still goes through the
 * same validation and the same gate, so an unsupported format outside the
 * caller's reach is still refused rather than described.
 */
export async function workbenchFileExists(
  owner: string,
  wikiId: string | null,
  displayPath: string,
  options: WorkbenchFileOptions,
): Promise<boolean> {
  const resolved = await resolveWorkbenchFile(owner, wikiId, displayPath, options);
  if (!resolved) return false;
  try {
    // Artifacts are always `.md`, so this branch is not reachable from the
    // unsupported path today; it is here so the function is total.
    if (resolved.kind === "artifact") {
      return (await readWikiArtifact(owner, wikiId!, resolved.file)) !== null;
    }
    return await getStorage().fileExists(resolved.key);
  } catch (error) {
    logger.error("workbench-files", `existence check failed for "${displayPath}"`, error);
    return false;
  }
}
