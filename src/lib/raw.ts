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
import { isEnoent } from "./errors";
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

/**
 * The OPTIONAL keep of extractor output (Story 7.2's Intake checkbox).
 *
 * Not a second vault and not a Source: the system of record for a binary
 * arrival is still the immutable bytes under `raw/sources/`, and the Markdown
 * the sidecar produced is written beside them as `raw/sources/<slug>/<id>.md`
 * whether or not this keep is on. This directory is a debugging convenience —
 * "show me exactly what the parser saw" — which is why nothing reads it back.
 */
export const RAW_PARSED_DIR = "parsed";

/**
 * The structural root of the binary-asset tree under `raw/`.
 *
 * Its PER-PAGE subtree is `assets/<slug>/<file>` — images pulled out of a
 * document arrival (`preserveDocumentSources`) and images fetched for a page
 * (`fetch.ts`) land there, and `syncSiloForPage` mirrors the whole
 * `assets/<slug>` directory into the owner's tenant silo. That subtree is the
 * reason the Workbench read gate has to know this root by name: its second
 * segment is a page slug exactly as it is under {@link RAW_SOURCES_DIR}, so a
 * gate reading the FIRST segment derives `assets` and discloses every hidden
 * page's asset directory (DW-491).
 *
 * NOT everything under this root is per-page: `illustration.ts` writes
 * `assets/illustrations/<key>.jpg`, a shared cache with no slug in it. Such a
 * subtree has its first segment read as a slug anyway — the fail-closed
 * direction {@link RAW_PARSED_DIR} also takes, since the path alone cannot
 * prove a segment is not somebody's slug.
 *
 * The constant is the STORAGE-root spelling, shared by the silo mirror and that
 * read gate so the two cannot drift apart. It is deliberately NOT every
 * `assets/…` literal in the tree: `fetch.ts`, `illustration.ts`, the
 * `/api/assets` route and the vault export spell it too, but there the string
 * doubles as the MARKDOWN-FACING ref namespace (`![](assets/<slug>/<file>)`)
 * and the exported vault's layout — a separate contract that `rawRelPath` maps
 * onto this root, and that must not start moving whenever this one does.
 */
export const RAW_ASSETS_DIR = "assets";

/** Storage-relative path for something under `raw/sources/`. */
export function rawSourceRelPath(rest: string): string {
  return rawRelPath(`${RAW_SOURCES_DIR}/${rest}`);
}

/** Storage-relative path for something under `raw/parsed/`. */
export function rawParsedRelPath(rest: string): string {
  return rawRelPath(`${RAW_PARSED_DIR}/${rest}`);
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
 * Publish `rel` create-only, naming the key if the provider refuses.
 *
 * A store that cannot complete must not fall back to an overwrite. The old
 * `fileExists`-then-write pair treated a failed check as "absent" and wrote
 * anyway; under FR-2 that is the worse failure, because a flaky answer on an
 * OCCUPIED key would mutate immutable bytes. The create-only door removes the
 * window entirely, and a rejection still fails visibly — the arrival fails, the
 * key is named in the log, and the owner can retry.
 *
 * THE COST THIS ACCEPTS: a create-only door ships the whole body before the
 * precondition can reject it. The filesystem provider writes and fsyncs a
 * complete tmp file before `fs.link` (or, on a link-less mount, the fallback
 * probe) answers "the name is taken", and R2 PUTs the object
 * before `etagDoesNotMatch: "*"` rejects it, so a re-drop of the same large PDF
 * now pays a full write where the old `fileExists` short-circuited. Accepted:
 * the race it closes mutates bytes the product promises never change.
 *
 * NOT A BATCH MEMBER, on purpose (DW-293). `StorageProvider.withBatchedWrites`
 * amortises one directory barrier over many writes, but an ingest arrival makes
 * exactly two — this flat key, then {@link mirrorSourceToSilo}'s copy — and
 * they live in two DIFFERENT directories, so a per-directory barrier is two
 * barriers for two writes. Nothing saved, in exchange for widening a create-only
 * door (which publishes by `fs.link`, falling back to a probe-then-`rename`
 * under the publication lock where the mount has no hard links, and stays fully
 * synced) into a scope whose members are only recoverable by re-driving the
 * whole set.
 */
async function publishSourceFirstWrite(
  rel: string,
  content: string,
): Promise<boolean> {
  try {
    return await getStorage().writeFileIfAbsent(rel, content);
  } catch (err) {
    logger.warn("raw", `create-only write failed for "${rel}"; refusing to overwrite`, err);
    throw err;
  }
}

/** The binary twin of {@link publishSourceFirstWrite}; same contract and cost. */
async function publishSourceBytesFirstWrite(
  rel: string,
  bytes: ArrayBuffer,
): Promise<boolean> {
  try {
    return await getStorage().writeAssetIfAbsent(rel, bytes);
  } catch (err) {
    logger.warn("raw", `create-only write failed for "${rel}"; refusing to overwrite`, err);
    throw err;
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
): Promise<boolean> {
  if (!owner) return false;
  try {
    const rel = tenantRawSourceRelPath(tenantForOwner(owner), rest);
    // Immutable in the silo too: a re-arrival must not rewrite what is there,
    // and the create-only door decides that in ONE operation — a separate
    // existence check would leave a window where two mirrors of the same key
    // both saw "absent" and the loser's write replaced the winner's bytes.
    return await getStorage().writeFileIfAbsent(rel, content);
  } catch (err) {
    logger.warn("raw", `silo mirror failed for raw source "${rest}"`, err);
    return false;
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
 * reload. A skipped write that only repairs a missing silo copy also bumps —
 * the Files tree just gained a key the watcher would otherwise never see. A
 * skipped write that changed nothing bumps nothing.
 *
 * "Does it exist?" and "write it" are ONE provider call (`writeFileIfAbsent`),
 * never a check followed by a write. The pair left a window in which two
 * concurrent arrivals on the same absent key both read "absent" and the later
 * write replaced the earlier one's bytes — precisely the mutation FR-2
 * forbids. A provider that cannot complete the create-only call THROWS and the
 * arrival fails visibly, which is deliberate: degrading to an overwrite on a
 * flaky provider is the worse failure, and the owner can retry.
 */
async function storeRawSource(
  rest: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<boolean> {
  await ensureDirectories();
  const rel = rawSourceRelPath(rest);
  const created = await publishSourceFirstWrite(rel, content);
  if (!created) {
    // Occupied (FR-2): leave the bytes. Still repair the mirror — the flat
    // bytes exist, and a silo that never received them would leave the Source
    // invisible forever. The first write already bumped; without a second bump
    // here the watcher is forward-only and Files stays empty after a
    // fail-then-repair.
    //
    // Mirror the STORED bytes, not the request body. A tree key can be
    // re-offered with different text (FR-40 path identity); copying the new
    // body into the silo would show Files a Source the flat key does not hold.
    let stored = content;
    try {
      stored = await getStorage().readFile(rel);
    } catch (err) {
      logger.warn("raw", `could not re-read "${rel}" for silo repair`, err);
    }
    const repaired = await mirrorSourceToSilo(rest, stored, options?.owner);
    if (repaired) await bumpDataVersion();
    return false;
  }
  await mirrorSourceToSilo(rest, content, options?.owner);
  await bumpDataVersion();
  return true;
}

/**
 * The binary twin of {@link storeRawSource}.
 *
 * A PDF, a DOCX or a JPEG is not text and must not be round-tripped through a
 * UTF-8 string on the way to storage — `writeFile` would mangle every byte that
 * is not valid UTF-8, and the sidecar would then be handed a corrupt document
 * to parse. `writeAssetIfAbsent` is the provider's create-only binary door, and
 * this keeps the rest of the arrival contract identical: first-write-only, silo
 * mirror, one `dataVersion` bump — with the existence decision and the
 * publication fused into one operation for the reason {@link storeRawSource}
 * documents.
 *
 * THE SILO MIRROR IS NOT OPTIONAL HERE, despite an earlier comment on this
 * function claiming "Files resolves binaries through the flat key". It does
 * not: {@link resolveWorkbenchFile} resolves `raw/` strictly inside
 * `tenants/<tenant>/raw/` and never falls back to the shared flat tree (DW-40),
 * the same rule the string writer above mirrors for. Without this a stored
 * image was invisible in Files and its bytes unreachable through the media
 * door — the two things Story 7.7 exists to provide.
 */
async function storeRawSourceBytes(
  rest: string,
  bytes: ArrayBuffer,
  options?: SaveRawSourceOptions,
): Promise<boolean> {
  await ensureDirectories();
  const rel = rawSourceRelPath(rest);
  const created = await publishSourceBytesFirstWrite(rel, bytes);
  if (!created) {
    // Occupied (FR-2): leave the bytes. Repair a missing mirror even when the
    // flat bytes are already there, for the reason {@link storeRawSource}
    // documents: the watcher is forward-only, so a mirror that failed once
    // would otherwise never land.
    const repaired = await mirrorSourceBytesToSilo(rest, bytes, options?.owner);
    if (repaired) await bumpDataVersion();
    return false;
  }
  await mirrorSourceBytesToSilo(rest, bytes, options?.owner);
  await bumpDataVersion();
  return true;
}

/**
 * The binary twin of {@link mirrorSourceToSilo} — same fail-soft contract, and
 * `writeAssetIfAbsent` rather than `writeFileIfAbsent` because a PNG is not a
 * UTF-8 string.
 *
 * The bytes are mirrored from the CALLER's buffer rather than re-read from the
 * flat key: this writer is first-write-only over a content-addressed name, so
 * the buffer in hand and the stored object are the same bytes by construction.
 */
async function mirrorSourceBytesToSilo(
  rest: string,
  bytes: ArrayBuffer,
  owner: string | null | undefined,
): Promise<boolean> {
  if (!owner) return false;
  try {
    const rel = tenantRawSourceRelPath(tenantForOwner(owner), rest);
    // Create-only, for the same reason {@link mirrorSourceToSilo} is.
    return await getStorage().writeAssetIfAbsent(rel, bytes);
  } catch (err) {
    logger.warn("raw", `silo mirror failed for raw source bytes "${rest}"`, err);
    return false;
  }
}

/**
 * Save the immutable BYTES of one binary arrival at
 * `raw/sources/<slug>/<rawId>.<ext>`.
 *
 * `rawId` is the SHA-256 of those bytes, which is what makes a re-drop of the
 * same PDF land on the key it already occupies instead of minting a second
 * snapshot — and what lets the extracted Markdown sit beside it at
 * `<slug>/<rawId>.md` without a separate identity to keep in sync.
 */
export async function saveRawSourceBytes(
  slug: string,
  rawId: string,
  ext: string,
  bytes: ArrayBuffer,
  options?: SaveRawSourceOptions,
): Promise<{ path: string; rel: string; created: boolean }> {
  validateSlug(slug);
  if (!RAW_ID_RE.test(rawId)) {
    throw new Error("Invalid raw id: must be a hex hash");
  }
  if (!/^[a-z0-9]{1,8}$/.test(ext)) {
    throw new Error("Invalid raw source extension");
  }
  const rest = `${slug}/${rawId}.${ext}`;
  const created = await storeRawSourceBytes(rest, bytes, options);
  return {
    path: `${getRawDir()}/${RAW_SOURCES_DIR}/${rest}`,
    rel: rawSourceRelPath(rest),
    created,
  };
}

/** Read stored binary Source bytes back for the extract-bytes door. */
export async function readRawSourceBytes(rel: string): Promise<ArrayBuffer> {
  return getStorage().readAsset(rel);
}

/**
 * Keep a copy of what the extractor produced under `raw/parsed/`.
 *
 * FAIL-SOFT by contract: the caller has already written the extracted text to
 * the Source location that Ingest reads, so a rejected keep must not turn a
 * successful extract into a failed one.
 */
export async function saveParsedMarkdown(
  slug: string,
  rawId: string,
  content: string,
): Promise<string | null> {
  try {
    validateSlug(slug);
    if (!RAW_ID_RE.test(rawId)) return null;
    await ensureDirectories();
    const rel = rawParsedRelPath(`${slug}/${rawId}.md`);
    await getStorage().writeFile(rel, content);
    return rel;
  } catch (error) {
    logger.warn("raw", `parsed keep failed for "${slug}/${rawId}"`, error);
    return null;
  }
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

export interface RawSourceSnapshot {
  slug: string;
  rawId: string;
  /** Workbench path, e.g. `raw/sources/<slug>/<rawId>.md`. */
  path: string;
}

/**
 * Recursive walk of hashed `raw/sources/<slug>/<hex>.md` snapshots.
 *
 * {@link listRawSources} stays non-recursive — that is the browse contract,
 * and the Workbench Sources surface built on it is unchanged: snapshots never
 * appear as extra rows THERE. Every caller that needs the hashed arrivals too
 * unions this listing in itself: Chat/Search retrieval (`wiki-retrieve.ts`),
 * the CLI's `list --raw` / `status`, and the `incomplete-coverage` lint check
 * (DW-437). A caller that unions must also decide what to do about the slug
 * `ingest()` writes BOTH ways — see `listRawSourceRows` in `src/cli.ts`.
 */
export async function listRawSourceSnapshots(): Promise<RawSourceSnapshot[]> {
  const roots: Array<{ prefix: string; pathPrefix: string }> = [
    { prefix: rawSourceRelPath(""), pathPrefix: `raw/${RAW_SOURCES_DIR}` },
    { prefix: rawRelPath(""), pathPrefix: "raw" },
  ];
  const snapshots: RawSourceSnapshot[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const entries = await listPrefix(root.prefix);
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      try {
        validateSlug(entry.name);
      } catch {
        continue;
      }
      const children = await listPrefix(`${root.prefix}/${entry.name}`);
      for (const child of children) {
        if (child.isDirectory || !child.name.endsWith(".md")) continue;
        const rawId = child.name.slice(0, -3);
        if (!RAW_ID_RE.test(rawId)) continue;
        const key = `${entry.name}/${rawId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        snapshots.push({
          slug: entry.name,
          rawId,
          path: `${root.pathPrefix}/${entry.name}/${child.name}`,
        });
      }
    }
  }
  return snapshots;
}

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
 * Save a folder-import Source at `raw/sources/<relative>`, where `relative`
 * is already a sanitized tree path with an extension (`papers/energy/note.md`).
 *
 * Same helper as {@link saveRawSourceFor}: no overwrite, optional `{ owner }`
 * silo mirror, `dataVersion` bump. Folder identity is the relative path
 * (FR-40); a re-import of the same tree lands on an occupied key and must
 * not rewrite.
 */
export async function saveRawSourceTree(
  relativePath: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<{ path: string; created: boolean }> {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid raw tree path");
  }
  const leaf = segments[segments.length - 1];
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) {
    throw new Error("Invalid raw tree path");
  }
  for (const dir of segments.slice(0, -1)) {
    validateSlug(dir);
  }
  validateSlug(leaf.slice(0, dot));
  const created = await storeRawSource(relativePath, content, options);
  return {
    path: `${getRawDir()}/${RAW_SOURCES_DIR}/${relativePath}`,
    created,
  };
}

/** Read the stored bytes at a folder-import path, or null if missing. */
export async function readRawSourceTree(
  relativePath: string,
): Promise<string | null> {
  try {
    return await getStorage().readFile(rawSourceRelPath(relativePath));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
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

/**
 * Remove stored Source bytes at `raw/sources/<rest>` and the owner's silo copy.
 *
 * Used by cascade delete to drop ONE source's hashed key
 * (`raw/sources/<slug>/<id>.md`) while the page it belongs to lives on.
 * {@link removeSiloForPage} covers the other case: when the whole page goes it
 * clears the entire per-page hashed silo directory in one `deleteDirectory`
 * (DW-435). The two are not redundant — this one is per-source and also
 * deletes the FLAT bytes; that one is per-page and silo-only.
 */
export async function deleteRawSourceBytes(
  rest: string,
  owner?: string,
): Promise<void> {
  const storage = getStorage();
  try {
    await storage.deleteFile(rawSourceRelPath(rest));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (owner) {
    try {
      await storage.deleteFile(tenantRawSourceRelPath(tenantForOwner(owner), rest));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  await bumpDataVersion();
}
