/**
 * StorageProvider — abstraction over filesystem access.
 *
 * All 11 src/lib/ modules that touch the filesystem do so through Node.js `fs`.
 * This interface captures every operation they perform, grouped into five
 * categories:
 *
 *  1. Text files   — readFile, writeFile, deleteFile, listFiles, appendFile
 *  2. Assets       — writeAsset (overwrite), writeAssetIfAbsent (create-only),
 *                    readAsset (binary data). The rule covers ARRIVALS only —
 *                    the door bytes FIRST land through: Source bytes and the
 *                    content-addressed keys use writeAssetIfAbsent, while a key
 *                    whose bytes are meant to be refreshed in place (fetch.ts
 *                    `downloadImages`) uses writeAsset. RE-PUBLICATION of
 *                    already-frozen bytes is deliberately not covered and uses
 *                    writeAsset throughout — silo.ts `copyAsset` mirroring into
 *                    `tenants/<t>/raw/…`, portable-archive.ts import and
 *                    backups.ts restore writing through `batch.writeAsset`.
 *                    BatchWriter exposes no create-only door at all, so a
 *                    batched caller has no other choice.
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
 *   fsyncs a complete tmp file and publishes it by `fs.link` (EEXIST answers
 *   `false` instead of overwriting), falling back to a probe-then-`rename`
 *   under the publication lock where the mount has no hard links (DW-573); R2
 *   uses a conditional PUT (`etagDoesNotMatch: "*"`). Their own suites in
 *   `storage-fs.test.ts` / `storage-r2.test.ts` pin the part that matters most:
 *   of two concurrent creators exactly one wins, whole —
 *   `storage-fs-fault-identity.test.ts` pins that same property on the
 *   link-less fallback, which no real filesystem reachable from a test host
 *   can stage.
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
 *   file that fit, or copy one it should have stopped at. The same call also
 *   answers `isDirectory`, which is what lets the archive collision probe tell
 *   an occupied FILE from a tenant path blocked by a DIRECTORY without a second
 *   round trip (DW-701).
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
  /**
   * Whether the path names a DIRECTORY rather than an object whose bytes
   * `readAsset` could hand back.
   *
   * REQUIRED, not optional, so a new provider cannot silently omit it: the
   * archive collision probe (`parseArchive`) makes exactly one `stat` per
   * manifest entry and reads this flag to tell "occupied by a file, record a
   * collision" from "occupied by a directory, fail the import loudly"
   * (DW-701). A provider that left it undefined would re-open that regression,
   * because a directory would read as falsy and be filed as an ordinary
   * collision.
   *
   * A provider whose keyspace is FLAT — R2 — reports `false` unconditionally:
   * `head` only ever answers for a real object, so there is no directory for it
   * to report.
   */
  isDirectory: boolean;
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
 * A predicate over a stored vector's metadata, handed to
 * {@link StorageProvider.queryEmbeddings} to narrow the candidate set BEFORE
 * the top-K reduction.
 *
 * Metadata only — deliberately not the vector or its score. The one caller is
 * the embedding-model filter (`modelMatches`), which is a property of how a
 * vector was WRITTEN, so a predicate that could see the score would invite
 * ranking policy into a place the provider cannot honour uniformly.
 */
export type EmbeddingFilter = (metadata: Record<string, string>) => boolean;

/**
 * What {@link StorageProvider.queryEmbeddings} answers.
 *
 * `rejected` is the whole reason this is an object rather than an array: a
 * caller that gets back an EMPTY `matches` cannot otherwise tell an empty store
 * from a store whose every vector the predicate turned away, and those two
 * states mean opposite things to a drift warning (DW-598). Without the count
 * the only way to distinguish them is a second, unfiltered probe query.
 */
export interface EmbeddingQueryResult {
  /** Accepted matches, sorted by descending similarity, at most `topK`. */
  matches: EmbeddingMatch[];
  /**
   * How many stored vectors the `accept` predicate turned away. `0` whenever
   * no predicate was supplied. On a provider that ranks SERVER-side this is
   * window-scoped — see that provider's note.
   */
  rejected: number;
  /** Server-ranked subset only; omission means the provider filtered the full corpus. */
  candidateScope?: "window";
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
 * A stored blob that already holds an id TWICE collapses to one entry at the
 * first of the two positions. That is a repair, not a rule the callers rely on:
 * the store is supposed to be id-unique, but nothing enforces it, and mapping
 * each slot independently would alias one incoming object into both — leaving
 * the duplicate in place and, worse, sharing a single object between two slots.
 *
 * `stored` is never mutated.
 */
export function mergeEmbeddingEntries(
  stored: readonly EmbeddingEntry[],
  incoming: readonly EmbeddingEntry[],
): EmbeddingEntry[] {
  // Insertion order of a Map is first-appearance order, and `set` overwrites
  // the value without moving the key — which is precisely "position by first
  // appearance, value by last write". One Map does both halves of the job:
  // seeded from `stored` it fixes each id's position, then `incoming` overwrites
  // values in place and appends whatever is new.
  const merged = new Map<string, EmbeddingEntry>();
  for (const entry of stored) {
    // First stored occurrence wins the slot; a duplicate id is dropped rather
    // than given a second one.
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
  }
  for (const entry of incoming) merged.set(entry.id, entry);
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Batched writes
// ---------------------------------------------------------------------------

/**
 * The write door handed to a {@link StorageProvider.withBatchedWrites} body.
 *
 * Deliberately only the two REPLACING whole-file writes the bounded loop paths
 * actually use. It is not a second `StorageProvider`: the create-only doors
 * (`writeFileIfAbsent` / `writeAssetIfAbsent`) publish by link — or, on a mount
 * with no hard links, by a probe-then-`rename` held exclusive by the
 * publication lock — rather than by the plain replacing rename, and stay fully
 * synced; and no lifecycle write belongs in a scope whose members are only
 * recoverable by re-driving the whole set.
 *
 * A write made here is published exactly like its unbatched twin and rejects
 * exactly like it. Only the durability point moves — see the header docblock.
 *
 * EVERY MEMBER CALL MUST BE AWAITED BEFORE THE BODY RESOLVES. The scope has no
 * way to know about a promise the body did not await, so an un-awaited write can
 * have its rename land AFTER the barrier that was supposed to cover it — a name
 * with no barrier behind it, which is worse than either mode. The writer is
 * CLOSED when the scope exits and a member call after that throws, so the
 * mistake fails loudly rather than silently producing a non-durable write.
 */
export interface BatchWriter {
  /** {@link StorageProvider.writeFile}, durable no later than scope exit. */
  writeFile(path: string, content: string): Promise<void>;
  /** {@link StorageProvider.writeAsset}, durable no later than scope exit. */
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
export const ATOMIC_COUNTER_INDEX_KEYS = [
  "data-version",
  // `embedding-rebuild-epoch` belongs here for the same reason `data-version`
  // does, and one more. It is the evidence a completed `rebuildVectorStore`
  // leaves behind, read by a per-query door to decide whether the
  // `drift:<model>` warning may speak a second time (DW-599) — which is what
  // turns that decision from a WINDOW signal into a CORPUS one. A counter kept
  // in eventually-consistent KV would let a read observe a bump that has not
  // landed for the next isolate, or miss one that has; and KV has no
  // increment at all, so `incrementIndex` would have to fake atomicity with a
  // read-modify-write that two isolates can both lose.
  "embedding-rebuild-epoch",
] as const;

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
   * Get file metadata (size, last modified time, directory-ness).
   *
   * `size` MUST agree with `readAsset` on the same path, byte for byte, so a
   * caller that only needs the size can ask here instead of reading the whole
   * object. See the header docblock; `createOwnerBackup` depends on it.
   *
   * `isDirectory` is part of the contract, not a convenience: this is the only
   * call the archive collision probe makes per manifest entry, so a provider
   * that cannot distinguish a directory from an object here leaves the probe
   * unable to tell an ordinary collision from a tenant path blocked by a
   * directory (DW-701). A flat-keyspace provider answers `false` — see
   * {@link FileInfo.isDirectory}.
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
   * is the door EVERY immutable binary arrival goes through (FR-2), where a
   * check-then-write pair leaves a window in which the later write mutates
   * bytes that are supposed to be frozen. Two kinds of key qualify:
   *
   *  - The Source keyspace, `raw/sources/<slug>/<id>.<ext>` — an occupied key
   *    means the id was already claimed, and the stored bytes stay.
   *  - BYTE-ADDRESSED keys, where a digest OF THE STORED BYTES is folded into
   *    the key itself — `originals/<tenant>/<slug>/<digest>-<file>`
   *    (document-sources.ts) and `assets/<slug>/<digest>-<name>` (fetch.ts
   *    `storeImageBytes`). There an occupied key means the object already holds
   *    these exact bytes, so `false` is a plain no-op success (DW-572).
   *  - `assets/<slug>/source-<digest>-<n>-<name>` (document-sources.ts) is
   *    SOURCE-addressed, not byte-addressed: the digest is of the source
   *    document and `<n>` is the extraction index, so an occupied key means the
   *    same source re-extracted BY THE SAME EXTRACTOR. Its no-op-success
   *    premise holds only while extraction output is stable for a given input —
   *    see that call site for the stale-figure cost this accepts.
   *
   * A key that is NOT addressed by its content does not belong here:
   * `downloadImages` writes `assets/<slug>/<url-derived name>` and MUST
   * overwrite, because a later fetch of the same page has to refresh a changed
   * remote image at the name the rewritten markdown still points at.
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
   *
   * **The pre-slice guarantee.** When `accept` is supplied, a provider that
   * ranks LOCALLY (filesystem; the R2 KV fallback) applies it to the whole
   * candidate set BEFORE sorting and slicing, so `matches` is the top-K nearest
   * ACCEPTED vectors rather than the accepted subset of the top-K nearest. The
   * difference is not cosmetic: filtering afterwards lets a rejected vector
   * occupy a slot and hand back a window that is empty, or wholly accepted,
   * for reasons that have nothing to do with the corpus (DW-598).
   *
   * A provider that ranks SERVER-side (Vectorize) cannot express this
   * predicate remotely — see the note on its implementation for why a
   * metadata filter is the wrong tool — so it satisfies the guarantee
   * BEST-EFFORT: it over-fetches to a bounded ceiling, filters that window
   * locally, then slices to `topK`. A corpus deeper than the ceiling can still
   * return fewer than `topK` accepted matches.
   *
   * `rejected` counts the stored vectors `accept` turned away — over the whole
   * candidate set on a locally-ranking provider, over the over-fetched window
   * on a server-ranking one. It is `0` when no predicate is supplied, and
   * ranking, slicing and returned matches are then byte-identical to a call
   * that never knew about filtering.
   *
   * @param vector — the query embedding
   * @param topK — maximum number of ACCEPTED results to return
   * @param accept — optional metadata predicate applied before the top-K slice
   * @returns accepted matches sorted by descending similarity, plus the count
   *          of vectors the predicate turned away
   */
  queryEmbeddings(
    vector: number[],
    topK: number,
    accept?: EmbeddingFilter,
  ): Promise<EmbeddingQueryResult>;

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
   * **What is traded.** Per-file durability becomes durability NO LATER THAN
   * scope exit. That is the portable claim: on R2 each member is already durable
   * when its PUT resolves and the scope changes nothing, while the filesystem
   * provider defers to one directory fsync per touched directory at exit. So a
   * power loss inside a filesystem scope can leave a batch member present with
   * unwritten bytes. ONLY a caller that can re-drive its ENTIRE batch from a
   * source that outlives the crash may use this door — "redo the batch" is the
   * only recovery it offers. That is why it is opt-in and why `writeFile` and
   * every lifecycle write keep their own fsync.
   *
   * **Await every member.** A write the body does not await before resolving
   * can land after the barrier meant to cover it. The writer is closed at scope
   * exit and a later member call throws, on every provider.
   *
   * **Only the destination's own directory is barriered.** Writing into a fresh
   * nested tree creates ancestor directories (`mkdir -p`) that are NOT
   * barriered, so a crash can lose an ancestor's entry and with it the leaf's
   * name even though the leaf's own directory was synced. This is inside the
   * "re-drive the whole batch" contract — the recovery is the same — but it is
   * narrower than "one barrier per touched directory" sounds.
   *
   * **Nesting and locks.** A nested scope barriers only ITS OWN directories;
   * the outer scope's members are untouched by the inner scope's exit. And a
   * lock released inside a batch no longer implies the write it guarded is
   * durable — `importPortableArchive` takes a per-slug durable lock INSIDE the
   * scope, so that lock now protects publication ordering only, not durability.
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
