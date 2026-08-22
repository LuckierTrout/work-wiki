import {
  getRawDir,
  rawRelPath,
  tenantForOwner,
  tenantRawRelPath,
  validateSlug,
  ensureDirectories,
} from "./wiki";
import { getStorage } from "./storage";
import { bumpDataVersion } from "./data-version";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Raw source storage
// ---------------------------------------------------------------------------

/**
 * The ONE directory under `raw/` that Source bytes are written to.
 *
 * Arrival stores under `raw/sources/` (FR-41) — the address the Workbench's
 * Sources and Files surfaces are built around — while `raw/assets/` (binary
 * assets) and `raw/uploads/` (queue staging) keep their own siblings. Before
 * this, `saveRawSource` wrote a flat `raw/<slug>.md` that the Workbench's
 * silo-only raw resolve (DW-40) would never show.
 *
 * Reads still look at the legacy flat location afterwards, so a workspace
 * written before the move keeps answering; nothing WRITES there any more.
 */
export const RAW_SOURCES_DIR = "sources";

/** Storage-relative path for something under `raw/sources/`. */
export function rawSourceRelPath(rest: string): string {
  return rawRelPath(`${RAW_SOURCES_DIR}/${rest}`);
}

/** Storage-relative path for something under `tenants/<tenant>/raw/sources/`. */
export function tenantRawSourceRelPath(tenant: string, rest: string): string {
  return tenantRawRelPath(tenant, `${RAW_SOURCES_DIR}/${rest}`);
}

export interface SaveRawSourceOptions {
  /**
   * The handle whose silo the bytes are mirrored into.
   *
   * Without it only the flat `raw/sources/…` key is written, which the
   * Workbench cannot see: `listWorkbenchFilePaths` resolves `raw/` strictly
   * inside `tenants/<tenant>/raw/` and never falls back to the shared flat tree
   * (DW-40). Intake doors pass the signed-in principal so the arrival is
   * visible in Files on the next `dataVersion` refresh. Ingest's own callers
   * leave it unset — `syncSiloForPage` mirrors a page's artifacts after the
   * page write, which is the path they already go through.
   */
  owner?: string | null;
}

/**
 * Does this key already hold bytes?
 *
 * A store that cannot answer is treated as "absent" and the write proceeds —
 * the same outcome every caller had before immutability was enforced, so a
 * flaky existence check degrades to the old behaviour rather than silently
 * dropping an arrival.
 */
async function alreadyStored(rel: string): Promise<boolean> {
  try {
    return await getStorage().fileExists(rel);
  } catch (err) {
    logger.warn("raw", `existence check failed for "${rel}"; writing anyway`, err);
    return false;
  }
}

/**
 * Mirror stored Source bytes into the owner's silo. FAIL-SOFT: the flat
 * `raw/sources/…` key is the system of record, and a mirror that rejects must
 * not turn a Source that already landed into a failed arrival — the cost is a
 * Files tree that lags until the next reconcile, which is recoverable.
 */
async function mirrorSourceToSilo(
  rest: string,
  content: string,
  owner: string | null | undefined,
): Promise<void> {
  if (!owner) return;
  try {
    const rel = tenantRawSourceRelPath(tenantForOwner(owner), rest);
    // Immutable in the silo too: a re-arrival must not rewrite what is there.
    if (await alreadyStored(rel)) return;
    await getStorage().writeFile(rel, content);
  } catch (err) {
    logger.warn("raw", `silo mirror failed for raw source "${rest}"`, err);
  }
}

/**
 * Write `raw/sources/<rest>` unless it already exists, and report whether the
 * bytes are new.
 *
 * Sources are IMMUTABLE once saved (FR-2), so an existing key is left exactly
 * as it is — never rewritten, and never thrown over: `saveRawSource` is called
 * on every ingest of a slug, so refusing loudly would turn a second ingest of
 * the same page into an error. Distinct arrivals get distinct keys through
 * {@link saveRawSourceFor}'s content-hashed id, which is why "the key exists"
 * and "the same bytes are already stored" mean the same thing there.
 *
 * A NEW write bumps `dataVersion` so the Workbench's trees catch up without a
 * reload; a skipped write changes nothing and therefore bumps nothing.
 */
async function storeRawSource(
  rest: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<boolean> {
  await ensureDirectories();
  const rel = rawSourceRelPath(rest);
  if (await alreadyStored(rel)) {
    // Still repair the mirror: the flat bytes exist, and a silo that never
    // received them would leave the Source invisible forever.
    await mirrorSourceToSilo(rest, content, options?.owner);
    return false;
  }
  await getStorage().writeFile(rel, content);
  await mirrorSourceToSilo(rest, content, options?.owner);
  await bumpDataVersion();
  return true;
}

/**
 * Save a raw source document at `raw/sources/<id>.md` and return its path.
 * Throws on an invalid id. Existing bytes are never rewritten — see
 * {@link storeRawSource}.
 */
export async function saveRawSource(
  id: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<string> {
  validateSlug(id);
  await storeRawSource(`${id}.md`, content, options);
  return `${getRawDir()}/${RAW_SOURCES_DIR}/${id}.md`;
}

/** A per-source raw id is a hex hash — path-safe by construction. */
const RAW_ID_RE = /^[a-f0-9]+$/;

/**
 * Save the raw snapshot of ONE source of a page at
 * `raw/sources/<slug>/<rawId>.md`.
 *
 * Unlike {@link saveRawSource} (one blob per slug), this keeps every source's
 * raw separately so a page built from multiple sources can show them all — and
 * because `rawId` is a hash of the arriving bytes, it is also the writer
 * Workbench Intake uses: two different arrivals cannot collide onto one key, so
 * immutability costs nothing. `rawId` must be a hex hash; `slug` is validated
 * as a path segment.
 */
export async function saveRawSourceFor(
  slug: string,
  rawId: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<string> {
  validateSlug(slug);
  if (!RAW_ID_RE.test(rawId)) {
    throw new Error("Invalid raw id: must be a hex hash");
  }
  await storeRawSource(`${slug}/${rawId}.md`, content, options);
  return `${getRawDir()}/${RAW_SOURCES_DIR}/${slug}/${rawId}.md`;
}

/**
 * Read one per-source raw snapshot written by {@link saveRawSourceFor}.
 * Both `slug` and `rawId` are validated before any filesystem access (the slug
 * can't contain path separators; the id is a hex hash), so traversal is
 * impossible. Throws "not found" when the snapshot doesn't exist.
 *
 * The legacy flat `raw/<slug>/<rawId>.md` is tried second, so snapshots written
 * before Sources moved under `raw/sources/` still read back.
 */
export async function readRawSourceById(
  slug: string,
  rawId: string,
): Promise<RawSourceWithContent> {
  validateSlug(slug);
  if (!RAW_ID_RE.test(rawId)) {
    throw new Error(`raw source not found: ${slug}/${rawId}`);
  }
  const nested = `${slug}/${rawId}.md`;
  const found = await readFirst([rawSourceRelPath(nested), rawRelPath(nested)]);
  if (!found) {
    throw new Error(`raw source not found: ${slug}/${rawId}`);
  }
  let size = found.content.length;
  let modified = new Date().toISOString();
  try {
    const stat = await getStorage().stat(found.rel);
    size = stat.size;
    modified = stat.lastModified.toISOString();
  } catch {
    // stat is best-effort — content already read successfully.
  }
  return { slug, filename: `${rawId}.md`, size, modified, content: found.content };
}

/** First readable key in `candidates`, or null when none of them exist. */
async function readFirst(
  candidates: readonly string[],
): Promise<{ rel: string; content: string } | null> {
  for (const rel of candidates) {
    try {
      return { rel, content: await getStorage().readFile(rel) };
    } catch {
      // Missing or unreadable — try the next location.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw source browsing (read-only)
// ---------------------------------------------------------------------------

/**
 * A lightweight descriptor for a file sitting in `raw/`. `slug` is the
 * filename with the final extension stripped, matching the identity that
 * {@link saveRawSource} uses when it writes a file.
 */
export interface RawSource {
  /** Filename without the final extension. Usable as a URL path segment. */
  slug: string;
  /** Original filename including extension, e.g. `llm-wiki-pattern.md`. */
  filename: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time as an ISO 8601 string. */
  modified: string;
}

/** A raw source plus its full content. Returned by {@link readRawSource}. */
export interface RawSourceWithContent extends RawSource {
  content: string;
}

/**
 * Strip the final extension from a filename. Leading dots (dotfiles) are
 * preserved verbatim — we never treat `.hidden` as having an extension of
 * `hidden`. Returns the input unchanged when there is no extension.
 */
function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  // Guard against dotfiles (`.env`) and extension-less names (`README`).
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

/** List one prefix's files, answering `[]` for a prefix that does not exist. */
async function listPrefix(prefix: string): Promise<import("./storage").FileEntry[]> {
  try {
    return await getStorage().listFiles(prefix);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * List every Source file, newest first.
 *
 * `raw/sources/` is the write location; the legacy flat `raw/` root is listed
 * after it so a workspace written before the move still browses. A filename
 * present in both is reported once, from `raw/sources/` — that is the one the
 * readers below resolve to.
 *
 * - Non-recursive in each root: per-source snapshot subdirectories
 *   (`raw/sources/<slug>/<hash>.md`) are {@link readRawSourceById}'s, not this
 *   listing's.
 * - Skips dotfiles and subdirectories.
 * - Returns `[]` (rather than throwing) when neither root exists, so a fresh
 *   checkout with no ingested sources renders cleanly.
 */
export async function listRawSources(): Promise<RawSource[]> {
  const storage = getStorage();
  const roots: Array<{ prefix: string; entries: import("./storage").FileEntry[] }> = [
    { prefix: rawSourceRelPath(""), entries: await listPrefix(rawSourceRelPath("")) },
    { prefix: rawRelPath(""), entries: await listPrefix(rawRelPath("")) },
  ];

  const sources: RawSource[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const entry of root.entries) {
      if (entry.isDirectory) continue;
      if (entry.name.startsWith(".")) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);

      const stat = await storage.stat(`${root.prefix}/${entry.name}`);
      sources.push({
        slug: stripExtension(entry.name),
        filename: entry.name,
        size: stat.size,
        modified: stat.lastModified.toISOString(),
      });
    }
  }

  // Newest first — most-recently-ingested at the top of the browser.
  sources.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return sources;
}

/**
 * Read a single raw source by slug (the filename without its final
 * extension). Returns the file's content along with the same metadata
 * {@link listRawSources} produces.
 *
 * Safety model: we do NOT build a path from the slug directly. Instead we
 * list the Source roots, match the slug against the stripped-extension form of
 * each real entry, and only then `readFile` the matched entry. A path-traversal
 * slug like `../../etc/passwd` can never match a listed file, so it falls
 * through to the "not found" throw. The `validateSlug` guard provides a second
 * layer of defence before we ever touch the filesystem.
 *
 * `raw/sources/` is read first and the legacy flat `raw/` second, matching what
 * {@link listRawSources} reports.
 *
 * @throws {Error} when the slug is invalid or no matching file exists.
 */
export async function readRawSource(
  slug: string,
): Promise<RawSourceWithContent> {
  validateSlug(slug);

  const sources = await listRawSources();
  const match = sources.find((s) => s.slug === slug);
  if (!match) {
    throw new Error(`raw source not found: ${slug}`);
  }

  const found = await readFirst([
    rawSourceRelPath(match.filename),
    rawRelPath(match.filename),
  ]);
  if (!found) {
    throw new Error(`raw source not found: ${slug}`);
  }

  return { ...match, content: found.content };
}
