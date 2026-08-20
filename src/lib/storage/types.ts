/**
 * StorageProvider — abstraction over filesystem access.
 *
 * All 11 src/lib/ modules that touch the filesystem do so through Node.js `fs`.
 * This interface captures every operation they perform, grouped into five
 * categories:
 *
 *  1. Text files   — readFile, writeFile, deleteFile, listFiles, appendFile
 *  2. Assets       — writeAsset, readAsset (binary data like downloaded images)
 *  3. Concurrency  — readFileWithEtag, writeFileIfMatch (optimistic locking)
 *  4. Indexes      — getIndex, putIndex (derived JSON blobs: config, history, etc.)
 *  5. Embeddings   — upsertEmbedding, queryEmbeddings (vector search)
 *
 * **Design rationale:**
 *
 * - Methods operate on *paths* and *strings*, not database rows. The path is
 *   always relative to the storage root (e.g. `"wiki/javascript.md"`). The
 *   provider decides how to map that to a real location (local fs directory,
 *   R2 key prefix, KV namespace, etc.).
 *
 * - Every WHOLE-FILE write must be atomic from the caller's perspective —
 *   partial writes should never be visible. That covers `writeFile`,
 *   `writeAsset`, `writeFileIfMatch`, `putIndex` and `upsertEmbedding`, and it
 *   deliberately excludes `appendFile`. The filesystem provider uses
 *   write-to-tmp + rename; R2 uses single-object PUT. See the `writeFile`
 *   docblock below for exactly what that guarantee does and does not cover —
 *   the other four carry the same one, and `storage-fs.test.ts` pins it for all
 *   five, so a new provider that satisfied only `writeFile` would fail them.
 *
 * - `listFiles` returns **file names only** (not full paths), filtered by a
 *   prefix directory. This matches the `readdir()` usage across the codebase.
 *
 * - `appendFile` exists specifically for `log.md`, which is the only file
 *   appended to rather than overwritten.
 *
 * - Index operations (`getIndex`/`putIndex`) are for small derived JSON
 *   objects like config, query history, and contributor profiles. They bypass
 *   the text-file layer so providers can use faster stores (KV, D1) when
 *   available.
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
  /** File size in bytes */
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
}
