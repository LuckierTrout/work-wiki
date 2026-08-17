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
 * column. So the caller passes the slug set that survived the filter, and a
 * `.md` under the wiki root appears only if its slug is in that set. The set is
 * a required argument, not an option: omitting it must not be spellable.
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
import { getStorage } from "./storage";
import {
  rawRelPath,
  tenantForOwner,
  tenantRawRelPath,
  tenantWikiRelPath,
  wikiRelPath,
} from "./wiki";
import { wikiDirPath } from "./wiki-paths";
import { WIKI_ARTIFACT_FILES } from "./wiki-scenarios";
import { readWikiArtifact } from "./wikis";
import { WORKBENCH_FILE_LIMIT, WORKBENCH_FILE_MAX_DEPTH } from "./workbench-tree";

// One definition of each cap, declared in the client-safe module because the
// truncation sentence is derived from the node limit. Re-exported here so
// server callers keep a single import.
export { WORKBENCH_FILE_LIMIT, WORKBENCH_FILE_MAX_DEPTH };

export interface WorkbenchFileListing {
  /** Tree-root-relative paths; a trailing `/` marks a directory. */
  paths: string[];
  /** True when a cap (node or depth) stopped the walk short. */
  truncated: boolean;
}

export interface WorkbenchFileOptions {
  /**
   * The slugs `listReadableWikiPages(principal)` returned. A `.md` leaf under
   * the wiki root is listed only when its slug is in here — see READ GATE.
   */
  readableSlugs: ReadonlySet<string>;
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

/** Decides whether one leaf may be listed. Directories are never filtered. */
type LeafFilter = (name: string) => boolean;

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
 * Pick which physical root backs a display root.
 *
 * `src/lib/silo.ts` documents `tenants/<tenant>/…` as the PRIMARY location for
 * an owner's pages, with the flat tree a transitional redundant copy. So the
 * silo is tried first and the flat root is used only when the silo has nothing
 * — which is what a pre-migration workspace looks like. The first listing is
 * kept and reused as the walk's level-1 seed, so preferring the silo costs no
 * extra round trip in the common case.
 *
 * A FAILED silo listing is not an empty one. Both providers answer a missing
 * prefix with an empty list, so a rejection here means unreadable — and falling
 * back on it would answer a transient error by widening what the tab shows to
 * the shared transitional tree, which is the opposite of degrading. The silo
 * stays selected and renders as the empty branch the I/O matrix asks for.
 */
async function resolveRoot(
  siloPrefix: string | null,
  flatPrefix: string,
): Promise<{ prefix: string; entries: Listing[] }> {
  if (siloPrefix) {
    const silo = await listSafely(siloPrefix);
    if (silo.failed) return { prefix: siloPrefix, entries: [] };
    const entries = visible(silo.entries);
    if (entries.length > 0) return { prefix: siloPrefix, entries };
  }
  return { prefix: flatPrefix, entries: visible((await listSafely(flatPrefix)).entries) };
}

/** Breadth-first walk of one root, appending display paths into `out`. */
async function walkRoot(
  root: { prefix: string; entries: Listing[] },
  displayRoot: string,
  out: string[],
  budget: Budget,
  allowLeaf: LeafFilter,
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
      // only contents are filtered-out leaves is omitting nothing.
      if (entries.some((e) => e.isDirectory || allowLeaf(e.name))) budget.truncated = true;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory && !allowLeaf(entry.name)) continue;
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return;
      }
      const display = `${node.display}/${entry.name}`;
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

/** `wiki/<slug>.md` is a page; everything else under the root is not. */
function wikiLeafFilter(readableSlugs: ReadonlySet<string>): LeafFilter {
  return (name) => {
    if (!name.endsWith(".md")) return true;
    // `index.md` is the generated index, not a page — it has no slug and so
    // never survives this test, which is correct: it is not the owner's writing.
    return readableSlugs.has(name.slice(0, -".md".length));
  };
}

/** Everything visible passes; `raw/` holds sources, not pages. */
const allowEveryLeaf: LeafFilter = () => true;

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

  // The tenant silo is primary; the flat roots — the same ones
  // `listRawSources()` and `listWikiPages()` read — are the transitional
  // fallback, so the tab cannot drift from what the kernel addresses either way.
  let siloRaw: string | null = null;
  let siloWiki: string | null = null;
  try {
    const tenant = tenantForOwner(owner);
    siloRaw = tenantRawRelPath(tenant, "");
    siloWiki = tenantWikiRelPath(tenant, "");
  } catch (error) {
    // A tenant that will not validate leaves only the flat roots. Still a real
    // tree, still gated by `readableSlugs`.
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
  await walkRoot(
    await resolveRoot(siloRaw, rawRelPath("")),
    "raw",
    paths,
    rawBudget,
    allowEveryLeaf,
  );
  budget.remaining -= rawShare - rawBudget.remaining;
  budget.truncated = budget.truncated || rawBudget.truncated;

  await walkRoot(
    await resolveRoot(siloWiki, wikiRelPath("")),
    "wiki",
    paths,
    budget,
    wikiLeafFilter(options.readableSlugs),
  );

  return { paths, truncated: budget.truncated };
}

// ---------------------------------------------------------------------------
// Reading one file back (Story 1.5)
// ---------------------------------------------------------------------------

/**
 * May the bytes of `wiki/<name>` be READ?
 *
 * Deliberately NOT {@link wikiLeafFilter}, whose first line is
 * `if (!name.endsWith(".md")) return true` — that is right for the LISTING,
 * where a non-page leaf under the wiki root is not a page and so is not the
 * thing the page gate governs. It is wrong for a read: `resolveRoot` falls back
 * to the SHARED flat `wiki/` root when the caller's silo is empty, so
 * `wiki/scratch.txt`, `wiki/dump.json` or `wiki/notes.markdown` would hand back
 * bytes that need not be the caller's. Story 1.4 disclosed such FILENAMES; this
 * would disclose their contents.
 *
 * So the read gate is the narrow one: a `.md` leaf (case-insensitively, because
 * a filesystem may not be) whose slug is in the readable set. Everything else
 * under the root is refused, including the generated `index.md`, which has no
 * slug and so never survives this test either.
 *
 * The name→slug half is {@link wikiLeafSlug}, exported because the preview route
 * has to answer the same question to decide whether a `wiki/` file selection is
 * the editable Page reached from the other tab. Two expressions of one rule is
 * exactly how `wiki/alpha.MD` was once gated in and then served with no slug.
 */
export function wikiLeafSlug(name: string): string | null {
  // Case-INSENSITIVE on the extension, exact on the slug: a filesystem need not
  // be case-sensitive, so `alpha.MD` is the same file as `alpha.md`, while the
  // slug itself is what the gate is about and is matched as written.
  if (!name.toLowerCase().endsWith(".md")) return null;
  const slug = name.slice(0, -".md".length);
  return slug.length > 0 ? slug : null;
}

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
 *   - `wiki/<name>.md` passes {@link readableWikiLeaf} first — the read gate,
 *     narrower than the listing's for the reason that function documents.
 *   - `raw/…` and `wiki/…` both resolve their root through {@link resolveRoot},
 *     so silo-first has exactly one definition — including that a FAILED silo
 *     listing keeps the silo selected instead of widening to the flat tree.
 *
 * Every rejection is the same `null`. Callers answer one indistinguishable 404
 * for all of them, so "gated out" and "absent" must not be tellable apart from
 * here either.
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
  // root is readable only when it is a `.md` whose slug survived
  // `listReadableWikiPages`.
  if (root === "wiki") {
    if (rest.length !== 1 || !readableWikiLeaf(rest[0], options.readableSlugs)) return null;
  }

  let silo: string | null = null;
  try {
    const tenant = tenantForOwner(owner);
    silo = root === "wiki" ? tenantWikiRelPath(tenant, "") : tenantRawRelPath(tenant, "");
  } catch (error) {
    logger.error("workbench-files", "could not resolve the owner's silo", error);
  }
  const flat = root === "wiki" ? wikiRelPath("") : rawRelPath("");
  const { prefix } = await resolveRoot(silo, flat);
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
