/**
 * StorageProvider — abstraction over filesystem access.
 *
 * All 11 src/lib/ modules that touch the filesystem do so through Node.js `fs`.
 * This interface captures every operation they perform, grouped into five
 * categories:
 *
 *  1. Text files   — readFile, writeFile, deleteFile, listFiles, appendFile
 *  2. Assets       — writeAsset, writeAssetIfAbsent, readAsset (binary data
 *                    like downloaded images and immutable Source bytes)
 *  3. Concurrency  — readFileWithEtag, writeFileIfMatch (optimistic locking),
 *                    writeFileIfAbsent / writeAssetIfAbsent (create-only)
 *  4. Indexes      — getIndex, putIndex, incrementIndex (derived JSON blobs: config, history, counters)
 *  5. Embeddings   — upsertEmbedding, upsertEmbeddings, queryEmbeddings
 *                    (vector search)
 *  6. Bulk writes  — withBatchedWrites (an opt-in door that trades per-file
 *                    durability for one barrier per scope)
 *
 * **Design rationale:**
 *
 * - Methods operate on *paths* and *strings*, not database rows. The path is
 *   always relative to the storage root (e.g. `"wiki/javascript.md"`). The
 *   provider decides how to map that to a real location (local fs directory,
 *   R2 key prefix, KV namespace, etc.).
 *
 * - Every WHOLE-FILE write must be atomic from the caller's perspective —
 *   partial writes should never be visible. That covers the five REPLACING
 *   writes — `writeFile`, `writeAsset`, `writeFileIfMatch`, `putIndex` and
 *   `upsertEmbedding` — and it deliberately excludes `appendFile`. The
 *   filesystem provider uses write-to-tmp + rename; R2 uses single-object PUT.
 *   See the `writeFile` docblock below for exactly what that guarantee does and
 *   does not cover — the other four carry the same one, and `storage-fs.test.ts`
 *   pins it for all five by inode, so a new provider that satisfied only
 *   `writeFile` would fail them.
 *
 * - The two CREATE-ONLY writes, `writeFileIfAbsent` and `writeAssetIfAbsent`,
 *   carry the same never-partial guarantee through a different publication:
 *   they must never replace an existing object, so the filesystem provider
 *   fsyncs a complete tmp file and publishes it with `fs.link` (EEXIST answers
 *   `false` instead of overwriting) rather than `rename`, and R2 uses a
 *   conditional PUT (`etagDoesNotMatch: "*"`). Their own suites in
 *   `storage-fs.test.ts` / `storage-r2.test.ts` pin the part that matters most:
 *   of two concurrent creators exactly one wins, whole.
 *
 * - `listFiles` returns **file names only** (not full paths), filtered by a
 *   prefix directory. This matches the `readdir()` usage across the codebase.
 *
 * - `stat(p).size` MUST equal `(await readAsset(p)).byteLength` for the same
 *   `p`: the number a provider reports is the number of bytes a read of that
 *   path hands back, not a stored, compressed, encoded or padded length. This
 *   is what lets a caller substitute a cheap metadata call for a full read when
 *   all it needs is the size — `createOwnerBackup` gates its 2 GiB ceiling on
 *   one HEAD per file rather than materialising the file that does not fit. A
 *   provider that reported some other number would make that backup stop at a
 *   file that fit, or copy one it should have stopped at.
 *
 * - `withBatchedWrites` is the ONE door that trades any of the above away, and
 *   it trades only durability. Every write made through the batch writer is
 *   still published the same way an unbatched one is — tmp + rename under the
 *   same publication lock on the filesystem, a single-object PUT on R2 — so a
 *   reader still never sees a torn file and a rejected write still leaves the
 *   destination exactly as it was. What moves is WHEN the bytes are forced to
 *   stable storage: instead of one fsync per file, the scope issues one
 *   directory-level barrier per touched directory at exit. A power loss inside
 *   the scope can therefore leave a batch member present with unwritten bytes,
 *   which is why only a caller that can RE-DRIVE its whole batch from a source
 *   that outlives the crash may use it (archive import re-reads the archive,
 *   backup create re-reads the tenant, backup verification writes into a prefix
 *   that is deleted either way). Everything else keeps `writeFile`'s own fsync.
 *
 * - `appendFile` exists specifically for `log.md`, which is the only file
 *   appended to rather than overwritten.
 *
 * - Index operations (`getIndex`/`putIndex`/`incrementIndex`) are for small
 *   derived JSON objects like config, query history, and contributor profiles.
 *   They bypass the text-file layer so providers can use faster stores (KV, D1,
 *   R2 compare-and-swap) when available. `incrementIndex` is the one that must
 *   be isolate-safe: two concurrent callers both observing `n` cannot both
 *   store `n + 1`, and a stale read cannot move the stored integer backwards.
 *
 * - Embedding operations are separated because vector search has fundamentally
 *   different access patterns (nearest-neighbor queries). A filesystem provider
 *   stores them as a JSON blob; a Cloudflare provider could use Vectorize.
 *
 * This is Phase 1 of the Cloudflare deployment plan. No existing code is
 * changed to use this interface yet — that happens in subsequent issues.
 */

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

/** Minimal file metadata returned by stat-like operations. */
export interface FileInfo {
  /**
   * File size in bytes — the SAME count `readAsset` on that path returns as
   * `byteLength`, never a stored or encoded length. See the cross-provider
   * invariant in this file's header docblock.
   */
  size: number;
  /** Last modified time (ISO string or Date) */
  lastModified: Date;
}

/** A file's content paired with an opaque version tag for optimistic concurrency. */
export interface FileWithEtag {
  content: string;
  /** Opaque version identifier. Filesystem provider can use mtime+size;
   *  R2 uses the object's etag. */
  etag: string;
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

/** Entry returned by `listFiles`. */
export interface FileEntry {
  /** File name (not full path), e.g. "javascript.md" */
  name: string;
  /** Whether this entry is a directory (true) or a file (false).
   *  Matches the `withFileTypes: true` usage in raw.ts. */
  isDirectory: boolean;
}

// ---------------------------------------------------------------------------
// Embedding types — the storage-layer vector representation
// ---------------------------------------------------------------------------

/** Metadata stored alongside each embedding vector. */
export interface EmbeddingEntry {
  /** Unique identifier — typically the wiki page slug */
  id: string;
  /** The embedding vector */
  vector: number[];
  /** Opaque metadata (e.g. content hash for staleness detection) */
  metadata: Record<string, string>;
}

/** A single result from a nearest-neighbor query. */
export interface EmbeddingMatch {
  id: string;
  score: number;
  metadata: Record<string, string>;
}

/**
 * Merge a set of incoming embeddings into a stored list, id-keyed.
 *
 * ONE implementation for the rule every provider's bulk upsert states: within
 * the incoming set the LAST value for an id wins, entries already stored keep
 * their stored position (an update rewrites in place), and ids not stored yet
 * append in the order they first appear in the argument. Two providers spelling
 * that for themselves is exactly how a filesystem rebuild and a KV rebuild end
 * up with differently ordered indexes for the same input.
 *
 * `stored` is never mutated.
 */
export function mergeEmbeddingEntries(
  stored: readonly EmbeddingEntry[],
  incoming: readonly EmbeddingEntry[],
): EmbeddingEntry[] {
  // Insertion order of a Map is first-appearance order, and `set` overwrites
  // the value without moving the key — which is precisely "position by first
  // appearance, value by last write".
  const latest = new Map<string, EmbeddingEntry>();
  for (const entry of incoming) latest.set(entry.id, entry);
  const merged = stored.map((entry) => latest.get(entry.id) ?? entry);
  const already = new Set(stored.map((entry) => entry.id));
  for (const [id, entry] of latest) {
    if (!already.has(id)) merged.push(entry);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Batched writes
// ---------------------------------------------------------------------------

/**
 * The write door handed to a {@link StorageProvider.withBatchedWrites} body.
 *
 * Deliberately only the two REPLACING whole-file writes the bounded loop paths
 * actually use. It is not a second `StorageProvider`: the create-only doors
 * (`writeFileIfAbsent` / `writeAssetIfAbsent`) publish by link rather than
 * rename and stay fully synced, and no lifecycle write belongs in a scope whose
 * members are only recoverable by re-driving the whole set.
 *
 * A write made here is published exactly like its unbatched twin and rejects
 * exactly like it. Only the durability point moves — see the header docblock.
 */
export interface BatchWriter {
  /** {@link StorageProvider.writeFile}, published now, made durable at scope exit. */
  writeFile(path: string, content: string): Promise<void>;
  /** {@link StorageProvider.writeAsset}, published now, made durable at scope exit. */
  writeAsset(path: string, data: ArrayBuffer): Promise<void>;
}

/**
 * Logical index keys whose Worker store is an R2 compare-and-swap object, not
 * KV. `getIndex` / `putIndex` / `incrementIndex` must share that object so a
 * seed, a read and a bump cannot disagree about the integer.
 *
 * KV (`YOPEDIA_CONFIG`) is eventually consistent and has no increment. R2's
 * `onlyIf.etagMatches` / `etagDoesNotMatch` is the isolate-safe primitive this
 * repo already uses for files.
 */
export const ATOMIC_COUNTER_INDEX_KEYS = ["data-version"] as const;

export function isAtomicCounterIndexKey(
  key: string,
): key is (typeof ATOMIC_COUNTER_INDEX_KEYS)[number] {
  return (ATOMIC_COUNTER_INDEX_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// StorageProvider interface
// ---------------------------------------------------------------------------

export interface StorageProvider {
  // -------------------------------------------------------------------------
  // Text files
  // -------------------------------------------------------------------------

  /**
   * Read a text file.
   * @param path — relative path, e.g. "wiki/javascript.md"
   * @returns file content as a UTF-8 string
   * @throws if the file does not exist
   */
  readFile(path: string): Promise<string>;

  /**
   * Write a text file atomically.
   * Creates parent directories as needed.
   *
   * **What atomic means here.** A reader of `path` sees either the previous
   * whole file or the new whole file, never a blend and never a truncated one:
   * the filesystem provider writes a sibling tmp file and `rename`s it over the
   * destination, R2 does a single-object PUT. A rejected write therefore leaves
   * the destination exactly as it was — callers may treat a throw as "these
   * bytes never landed".
   *
   * **What it does not mean.** It is not crash-durability of the write itself.
   * The filesystem provider fsyncs the tmp file's contents but not the parent
   * directory (an fsync of a directory is not portable), so a power loss can
   * still lose the newest bytes and leave the PREVIOUS whole file in place.
   * Losing the newest bytes is a state callers can reason about; reading a torn
   * file is not, and that is the one this rules out.
   *
   * It is also not a lock. Two concurrent writes to one path both succeed and
   * the last rename wins — use `writeFileIfMatch` when the previous content
   * matters.
   *
   * @param path — relative path
   * @param content — UTF-8 string content
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Delete a single file.
   * @param path — relative path
   * @throws if the file does not exist (provider-dependent)
   */
  deleteFile(path: string): Promise<void>;

  /**
   * List files in a directory.
   *
   * A provider MUST NOT surface its own internal scratch artifacts here — the
   * tmp files a write-to-tmp + rename implementation creates are the provider's
   * business, and a caller that sees one treats it as content (`sweepOrphans`
   * would read it as a stray page). The filesystem provider filters its
   * `.tmp-<uuid>.tmp` files for exactly this reason. Everything the caller
   * actually stored must be returned, dot-prefixed names included: `.discarded`
   * is a real marker the orphan sweep depends on.
   *
   * @param prefix — directory path, e.g. "wiki/" or "raw/"
   * @returns array of entries with name and type info
   */
  listFiles(prefix: string): Promise<FileEntry[]>;

  /**
   * Check whether a file exists.
   * @param path — relative path
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * Append content to a file. Creates the file if it doesn't exist.
   * Used specifically for `log.md` (append-only activity log).
   *
   * DELIBERATELY OUTSIDE the whole-file atomicity contract that `writeFile` and
   * the four writes below carry: an append cannot be tmp-and-renamed without
   * reading the entire file back, which defeats the point of appending. A torn
   * append can therefore leave a partial final line, and readers of `log.md`
   * must tolerate one.
   *
   * @param path — relative path
   * @param content — text to append
   */
  appendFile(path: string, content: string): Promise<void>;

  /**
   * Get file metadata (size, last modified time).
   *
   * `size` MUST agree with `readAsset` on the same path, byte for byte, so a
   * caller that only needs the size can ask here instead of reading the whole
   * object. See the header docblock; `createOwnerBackup` depends on it.
   *
   * @param path — relative path
   * @returns FileInfo
   * @throws if the file does not exist
   */
  stat(path: string): Promise<FileInfo>;

  /**
   * Delete a directory and all its contents recursively.
   * Used by revisions.ts to clean up a page's revision history.
   * No-op if the directory doesn't exist.
   * @param path — relative directory path
   */
  deleteDirectory(path: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Assets (binary data)
  // -------------------------------------------------------------------------

  /**
   * Write binary data (e.g. a downloaded image).
   * Creates parent directories as needed.
   *
   * Atomic on the same terms as `writeFile` — see that docblock for what the
   * guarantee does and does not cover.
   *
   * @param path — relative path, e.g. "wiki/assets/img.png"
   * @param data — binary content
   */
  writeAsset(path: string, data: ArrayBuffer): Promise<void>;

  /**
   * Read binary data.
   * @param path — relative path
   * @returns the binary content
   * @throws if the asset does not exist
   */
  readAsset(path: string): Promise<ArrayBuffer>;

  // -------------------------------------------------------------------------
  // Optimistic concurrency
  // -------------------------------------------------------------------------

  /**
   * Read a file along with an opaque version tag.
   * Use the returned etag with `writeFileIfMatch` to implement
   * compare-and-swap semantics.
   * @param path — relative path
   */
  readFileWithEtag(path: string): Promise<FileWithEtag>;

  /**
   * Create a whole file only when the path does not exist. The existence check
   * and publication are one provider operation, so concurrent creators cannot
   * both win. Returns `true` for the creator and `false` when the path exists.
   */
  writeFileIfAbsent(path: string, content: string): Promise<boolean>;

  /**
   * The binary twin of `writeFileIfAbsent`, with the identical create-only
   * contract: the existence check and the publication are ONE provider
   * operation, so two concurrent creators of the same absent key cannot both
   * win, and an occupied key is left byte-for-byte as it is.
   *
   * `writeAsset` would round-trip through the provider's overwrite door; this
   * is the door immutable binary arrivals (`raw/sources/<slug>/<id>.<ext>`,
   * FR-2) go through, where a check-then-write pair leaves a window in which
   * the later write mutates bytes that are supposed to be frozen.
   *
   * Returns `true` for the creator and `false` when the path exists. A
   * provider that cannot complete the call THROWS rather than degrading to an
   * overwrite: the arrival fails visibly and the owner can retry.
   */
  writeAssetIfAbsent(path: string, data: ArrayBuffer): Promise<boolean>;

  /**
   * Write a file only if the current version matches the given etag.
   * Returns `true` if the write succeeded, `false` if the etag didn't match
   * (meaning someone else wrote to the file since you read it).
   *
   * When it does write, the write is atomic on the same terms as `writeFile` —
   * see that docblock. (The compare-and-swap itself is not atomic against a
   * concurrent writer on every provider; the atomicity here is about the file's
   * bytes, not about the check-then-write pair.)
   *
   * @param path — relative path
   * @param content — new content
   * @param etag — etag from a prior `readFileWithEtag` call
   */
  writeFileIfMatch(path: string, content: string, etag: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Derived indexes (small JSON objects)
  // -------------------------------------------------------------------------

  /**
   * Retrieve a derived index by key.
   * @param key — logical key, e.g. "config", "query-history", "vector-store"
   * @returns the parsed JSON value, or `null` if the key doesn't exist
   */
  getIndex<T = unknown>(key: string): Promise<T | null>;

  /**
   * Store a derived index.
   *
   * Atomic on the same terms as `writeFile` — see that docblock. A half-written
   * index is unparseable JSON, so this matters even though the value is derived.
   *
   * @param key — logical key
   * @param value — JSON-serializable value
   */
  putIndex<T = unknown>(key: string, value: T): Promise<void>;

  /**
   * Raise a stored integer by exactly one and return what was stored.
   *
   * The increment is provider-atomic: two callers that both observe `n` cannot
   * both store `n + 1`, and a stale read cannot write a value lower than what
   * is already there. Absent, non-integer, negative or non-finite stored values
   * count as `0`, so the first successful increment stores `1`.
   *
   * This is a stronger guarantee than `getIndex` + `putIndex` under an
   * in-process lock. The filesystem provider serializes the read-modify-write
   * on the index file; the Cloudflare provider compare-and-swaps an R2 object
   * (KV is eventually consistent and has no increment).
   *
   * @param key — logical key of the counter
   */
  incrementIndex(key: string): Promise<number>;

  /**
   * List index keys that start with a given prefix.
   * Returns the logical key names (without internal prefixes like `_idx:`).
   * Useful for discovering all indexes of a certain type (e.g. all vault
   * indexes via `listIndexKeys("vaults:")`).
   * @param prefix — logical key prefix, e.g. "vaults:"
   * @returns matching key names
   */
  listIndexKeys(prefix: string): Promise<string[]>;

  // -------------------------------------------------------------------------
  // Embeddings / vector search
  // -------------------------------------------------------------------------

  /**
   * Insert or update an embedding vector with associated metadata.
   *
   * However the provider stores the vectors, the update must be atomic on the
   * same terms as `writeFile` — a provider that keeps them in one blob (as the
   * filesystem one does) must not leave that blob torn by a failed upsert.
   *
   * @param id — unique identifier (typically a wiki page slug)
   * @param vector — the embedding vector
   * @param metadata — key-value metadata (e.g. `{ contentHash: "abc123" }`)
   */
  upsertEmbedding(
    id: string,
    vector: number[],
    metadata: Record<string, string>,
  ): Promise<void>;

  /**
   * Insert or update a WHOLE SET of embeddings as one store operation.
   *
   * The point of it: a provider that keeps its vectors in one blob (as the
   * filesystem one does) otherwise reloads, rewrites and fsyncs that entire
   * blob once per vector, so a rebuild of N pages costs N full index rewrites.
   * This is one load, one merge and one store for the set.
   *
   * Merge rule, identical on every provider (see {@link mergeEmbeddingEntries}):
   * id-keyed, the LAST value for a repeated id in `entries` wins, entries that
   * are already stored keep their stored position, and new ids append in the
   * order they first appear. An EMPTY array writes nothing at all — no store,
   * no barrier, the stored bytes untouched.
   *
   * Atomic on the same terms as {@link upsertEmbedding}: the set lands whole or
   * not at all, and a failed call must not leave a torn index behind.
   *
   * @param entries — the vectors to insert or update
   */
  upsertEmbeddings(entries: EmbeddingEntry[]): Promise<void>;

  /**
   * Find the nearest neighbors to a query vector.
   * @param vector — the query embedding
   * @param topK — maximum number of results to return
   * @returns matches sorted by descending similarity score
   */
  queryEmbeddings(vector: number[], topK: number): Promise<EmbeddingMatch[]>;

  /**
   * Fetch a single stored embedding (vector + metadata) by id, or null when it
   * isn't present. Used to reuse a page's own vector (related-pages) and to skip
   * re-embedding unchanged content (contentHash compare) without a similarity scan.
   */
  getEmbeddingById(id: string): Promise<EmbeddingEntry | null>;

  /**
   * Remove an embedding by id.
   * No-op if the id doesn't exist.
   * @param id — the identifier to remove
   */
  removeEmbedding(id: string): Promise<void>;

  /**
   * Remove ALL embeddings (content reset). On a managed index that lacks a
   * bulk-clear primitive this may be best-effort — see the provider's note —
   * but it must never throw.
   */
  clearEmbeddings(): Promise<void>;

  // -------------------------------------------------------------------------
  // Batched writes
  // -------------------------------------------------------------------------

  /**
   * Run `fn` with a {@link BatchWriter} whose writes share ONE durability
   * barrier, issued when the scope exits.
   *
   * **What is kept.** Every write made through `batch` is published exactly as
   * its unbatched twin is — tmp + rename under the same publication lock on the
   * filesystem, a single-object PUT on R2. A reader never observes a torn file,
   * a rejected write leaves its destination byte-for-byte as it was, and a write
   * that resolved is immediately READABLE (the name is published; only the
   * flush to stable storage is deferred).
   *
   * **What is traded.** Per-file durability becomes per-batch. A directory
   * fsync makes the NAMES durable, not the file contents, so a power loss
   * inside the scope can leave a batch member present with unwritten bytes.
   * ONLY a caller that can re-drive its ENTIRE batch from a source that
   * outlives the crash may use this door — "redo the batch" is the only
   * recovery it offers. That is why it is opt-in and why `writeFile` and every
   * lifecycle write keep their own fsync.
   *
   * **Scope, not ambient state.** Only writes made through the passed `batch`
   * are affected; a concurrent unrelated `writeFile` in the same process still
   * fsyncs its own bytes.
   *
   * **Exit.** The barrier runs whether the body resolved or threw. If the body
   * threw, the BODY's error propagates and a barrier failure is logged and
   * swallowed — the body's error is the one the caller can act on. If the body
   * resolved, a barrier failure propagates, except for the platform codes that
   * mean "this filesystem cannot fsync a directory", which are swallowed.
   *
   * A provider whose single write is already its own barrier (R2) satisfies
   * this as a pass-through.
   *
   * @param fn — the body; whatever it returns is returned here
   */
  withBatchedWrites<T>(fn: (batch: BatchWriter) => Promise<T>): Promise<T>;
}
