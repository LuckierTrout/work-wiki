/**
 * R2StorageProvider — Cloudflare R2/KV/Vectorize-backed implementation of
 * the StorageProvider interface.
 *
 * Maps the abstract storage operations to Cloudflare's services:
 *   - Text files + assets → R2 Bucket
 *   - Derived indexes → KV Namespace
 *   - Embeddings → Vectorize Index (optional, falls back to KV)
 *
 * R2 is a flat key-value store, so "directories" are simulated using
 * key prefixes and the R2 `list()` delimiter feature.
 */

import type {
  StorageProvider,
  BatchWrite,
  FileInfo,
  FileWithEtag,
  FileEntry,
  EmbeddingMatch,
  EmbeddingEntry,
} from "./types";

import type {
  CloudflareEnv,
  R2Bucket,
  KVNamespace,
  VectorizeIndex,
} from "./cloudflare-types";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** R2 list() returns at most 1000 keys per call. */
const R2_LIST_PAGE_SIZE = 1000;

/** KV key prefix for index entries. */
const INDEX_PREFIX = "_idx:";

/** KV key for fallback embedding store when Vectorize is unavailable. */
const EMBEDDINGS_KV_KEY = "_idx:embeddings";

/**
 * How many of a {@link R2StorageProvider.writeBatch}'s PUTs are in flight at
 * once.
 *
 * R2 HAS NO FSYNC, so the batch door buys something different here than it does
 * on the filesystem: there are no durability barriers to collapse, only network
 * round-trips to overlap. Each entry is the same single-object PUT `writeFile`
 * and `writeAsset` already perform, with the same per-object atomicity — the
 * batch just stops the caller's loop from paying for them one at a time.
 *
 * Bounded rather than "all of them" because a Worker's subrequest budget and
 * its open-connection limit are both finite, and an archive import can carry
 * thousands of entries.
 */
const BATCH_PUT_CONCURRENCY = 16;

/**
 * The largest batch handed to Vectorize in one `upsert`.
 *
 * Vectorize caps how many vectors a single mutation may carry, so an unbounded
 * flush would fail wholesale on a large rebuild. Splitting here keeps the door's
 * contract (one flush, later entry wins) while staying inside that ceiling.
 */
const VECTORIZE_UPSERT_LIMIT = 1000;

/**
 * The key two `BatchWrite` paths must agree on to count as the same destination.
 *
 * The filesystem provider compares RESOLVED paths, so `"a/b.md"` and
 * `"./a/b.md"` are one file there and the batch is refused. R2 keys are opaque
 * strings, so without this the same batch would be accepted and silently
 * last-write-win — one interface answering two ways about the same input, which
 * is exactly what the duplicate refusal exists to prevent. Used for the CHECK
 * only: what is stored is still the caller's key verbatim.
 */
function batchKey(key: string): string {
  const segments: string[] = [];
  for (const segment of key.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class R2StorageProvider implements StorageProvider {
  private readonly bucket: R2Bucket;
  private readonly kv: KVNamespace;
  private readonly vectorize: VectorizeIndex | undefined;

  constructor(env: CloudflareEnv) {
    this.bucket = env.YOPEDIA_BUCKET;
    this.kv = env.YOPEDIA_CONFIG;
    this.vectorize = env.YOPEDIA_VECTORIZE;
  }

  // -------------------------------------------------------------------------
  // Text files
  // -------------------------------------------------------------------------

  async readFile(path: string): Promise<string> {
    const obj = await this.bucket.get(path);
    if (!obj) {
      throw new R2NotFoundError(path);
    }
    return obj.text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.bucket.put(path, content);
  }

  /**
   * See {@link StorageProvider.writeBatch}. On R2 a batch is a bounded-concurrency
   * fan-out of the PUTs this provider already performs — nothing is staged,
   * because nothing needs to be: a single-object PUT is already the whole-file
   * publish that the filesystem provider needs a tmp file and a rename to
   * achieve.
   *
   * Not a transaction, for the same reason as on the filesystem: the PUTs are
   * independent, so a fault leaves the ones that already landed in place. The
   * duplicate-path refusal is enforced here too, so shared callers get one
   * answer from both providers rather than a rejection on one and a silent
   * last-write-wins on the other.
   */
  async writeBatch(entries: readonly BatchWrite[]): Promise<void> {
    if (entries.length === 0) return;

    const seen = new Set<string>();
    for (const entry of entries) {
      const key = batchKey(entry.path);
      if (seen.has(key)) {
        throw new Error(`writeBatch: duplicate path in one batch: ${entry.path}`);
      }
      seen.add(key);
    }

    let next = 0;
    // Once one PUT has rejected, the call is already going to reject with that
    // error, so every further PUT is a write the caller will never be told
    // about. Stopping bounds "a fault leaves the ones that already landed in
    // place" to the ones that were in flight when it happened, instead of
    // letting the rest of the batch keep landing behind a rejected promise.
    let faulted = false;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < entries.length; index = next++) {
        if (faulted) return;
        const entry = entries[index];
        try {
          await this.bucket.put(entry.path, entry.body);
        } catch (error) {
          faulted = true;
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BATCH_PUT_CONCURRENCY, entries.length) }, worker),
    );
  }

  async deleteFile(path: string): Promise<void> {
    // R2 delete is silent on missing keys, matching the interface contract
    await this.bucket.delete(path);
  }

  async listFiles(prefix: string): Promise<FileEntry[]> {
    // Ensure prefix ends with "/" for directory listing
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

    const entries: FileEntry[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.bucket.list({
        prefix: normalizedPrefix,
        delimiter: "/",
        cursor,
        limit: R2_LIST_PAGE_SIZE,
      });

      // Files: extract the name portion after the prefix
      for (const obj of result.objects) {
        const name = obj.key.slice(normalizedPrefix.length);
        // Skip empty names (the prefix itself) or nested entries
        if (name && !name.includes("/")) {
          entries.push({ name, isDirectory: false });
        }
      }

      // Directories: delimitedPrefixes are full prefixes like "wiki/assets/"
      for (const dp of result.delimitedPrefixes) {
        const name = dp.slice(normalizedPrefix.length).replace(/\/$/, "");
        if (name) {
          entries.push({ name, isDirectory: true });
        }
      }

      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);

    return entries;
  }

  async fileExists(path: string): Promise<boolean> {
    const head = await this.bucket.head(path);
    return head !== null;
  }

  async appendFile(path: string, content: string): Promise<void> {
    // R2 has no native append — read-modify-write
    const existing = await this.bucket.get(path);
    const oldContent = existing ? await existing.text() : "";
    await this.bucket.put(path, oldContent + content);
  }

  async stat(path: string): Promise<FileInfo> {
    const head = await this.bucket.head(path);
    if (!head) {
      throw new R2NotFoundError(path);
    }
    return {
      size: head.size,
      lastModified: head.uploaded,
    };
  }

  async deleteDirectory(dirPath: string): Promise<void> {
    // R2 is flat — "delete directory" means delete all keys with this prefix
    const normalizedPrefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    let cursor: string | undefined;

    do {
      const result = await this.bucket.list({
        prefix: normalizedPrefix,
        cursor,
        limit: R2_LIST_PAGE_SIZE,
      });

      if (result.objects.length > 0) {
        const keys = result.objects.map((obj) => obj.key);
        await this.bucket.delete(keys);
      }

      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
  }

  // -------------------------------------------------------------------------
  // Assets (binary data)
  // -------------------------------------------------------------------------

  async writeAsset(path: string, data: ArrayBuffer): Promise<void> {
    await this.bucket.put(path, data);
  }

  async readAsset(path: string): Promise<ArrayBuffer> {
    const obj = await this.bucket.get(path);
    if (!obj) {
      throw new R2NotFoundError(path);
    }
    return obj.arrayBuffer();
  }

  // -------------------------------------------------------------------------
  // Optimistic concurrency
  // -------------------------------------------------------------------------

  /**
   * THE RAW `etag`, NOT `httpEtag`.
   *
   * `httpEtag` is the RFC-9110 QUOTED form, for putting in a response header;
   * `R2Conditional.etagMatches` takes the raw one. Feeding the quoted value back
   * into `writeFileIfMatch` compares `"abc"` against `abc`, which a strict
   * runtime never matches — so every compare-and-set after the first would fail
   * forever. Since DW-272 the settings save depends on this pair, and a
   * permanently-losing CAS there means no save on Workers ever lands again, with
   * no path out from any surface the owner can see.
   *
   * Safe because this etag is opaque to every caller and is never emitted as an
   * HTTP header: `config.ts` and `graphify-jobs.ts` are the only readers, and
   * both hand it straight back to {@link writeFileIfMatch}.
   */
  async readFileWithEtag(path: string): Promise<FileWithEtag> {
    const obj = await this.bucket.get(path);
    if (!obj) {
      throw new R2NotFoundError(path);
    }
    return {
      content: await obj.text(),
      etag: obj.etag,
    };
  }

  async writeFileIfMatch(
    path: string,
    content: string,
    etag: string,
  ): Promise<boolean> {
    // R2 conditional put: returns null if the condition fails
    const result = await this.bucket.put(path, content, {
      onlyIf: { etagMatches: etag },
    });
    return result !== null;
  }

  // -------------------------------------------------------------------------
  // Derived indexes (KV-backed)
  // -------------------------------------------------------------------------

  async getIndex<T = unknown>(key: string): Promise<T | null> {
    const value = await this.kv.get(`${INDEX_PREFIX}${key}`, "json");
    return (value as T) ?? null;
  }

  async putIndex<T = unknown>(key: string, value: T): Promise<void> {
    await this.kv.put(`${INDEX_PREFIX}${key}`, JSON.stringify(value));
  }

  async listIndexKeys(prefix: string): Promise<string[]> {
    const kvPrefix = `${INDEX_PREFIX}${prefix}`;
    const keys: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.kv.list({
        prefix: kvPrefix,
        cursor,
        limit: 1000,
      });
      for (const k of result.keys) {
        // Strip the internal `_idx:` prefix to return logical key names.
        keys.push(k.name.slice(INDEX_PREFIX.length));
      }
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return keys;
  }

  // -------------------------------------------------------------------------
  // Embeddings / vector search
  // -------------------------------------------------------------------------

  async upsertEmbedding(
    id: string,
    vector: number[],
    metadata: Record<string, string>,
  ): Promise<void> {
    if (this.vectorize) {
      await this.vectorize.upsert([{ id, values: vector, metadata }]);
    } else {
      // Fallback: store in KV as a JSON blob (same approach as filesystem)
      const entries = await this.loadEmbeddingsFromKV();
      const idx = entries.findIndex((e) => e.id === id);
      const entry = { id, vector, metadata };
      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
      await this.kv.put(EMBEDDINGS_KV_KEY, JSON.stringify(entries));
    }
  }

  /**
   * See {@link StorageProvider.upsertEmbeddings}. Vectorize has a native bulk
   * door, so the batch goes out as `upsert` calls of at most
   * {@link VECTORIZE_UPSERT_LIMIT} vectors. The KV fallback keeps every vector in
   * a single blob, so it loads and puts that blob once per call instead of once
   * per vector — the same collapse the filesystem provider makes.
   *
   * BOTH BRANCHES COLLAPSE A REPEATED ID FIRST. The interface promises the later
   * entry wins within one flush, and handing Vectorize two mutations for one id
   * in a single call leaves which of them survives up to the service — so the
   * batch is reduced to one entry per id, holding the last value, before either
   * branch sees it. Splitting a reduced batch across `upsert` calls is then safe:
   * no id spans two of them.
   */
  async upsertEmbeddings(entries: readonly EmbeddingEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const merged = new Map<string, EmbeddingEntry>();
    for (const { id, vector, metadata } of entries) {
      merged.set(id, { id, vector, metadata });
    }

    if (this.vectorize) {
      const vectors = [...merged.values()].map((entry) => ({
        id: entry.id,
        values: entry.vector,
        metadata: entry.metadata,
      }));
      for (let at = 0; at < vectors.length; at += VECTORIZE_UPSERT_LIMIT) {
        await this.vectorize.upsert(vectors.slice(at, at + VECTORIZE_UPSERT_LIMIT));
      }
      return;
    }

    const stored = await this.loadEmbeddingsFromKV();
    const positions = new Map(stored.map((entry, index) => [entry.id, index]));
    for (const entry of merged.values()) {
      const at = positions.get(entry.id);
      if (at === undefined) {
        positions.set(entry.id, stored.length);
        stored.push(entry);
      } else {
        stored[at] = entry;
      }
    }
    await this.kv.put(EMBEDDINGS_KV_KEY, JSON.stringify(stored));
  }

  async queryEmbeddings(
    vector: number[],
    topK: number,
  ): Promise<EmbeddingMatch[]> {
    if (this.vectorize) {
      const result = await this.vectorize.query(vector, {
        topK,
        returnMetadata: "all",
      });
      return result.matches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: (m.metadata as Record<string, string>) ?? {},
      }));
    }

    // Fallback: brute-force cosine similarity in KV
    const entries = await this.loadEmbeddingsFromKV();
    const scored = entries.map((e) => ({
      id: e.id,
      score: cosineSimilarity(vector, e.vector),
      metadata: e.metadata,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async getEmbeddingById(id: string): Promise<EmbeddingEntry | null> {
    if (this.vectorize) {
      const got = await this.vectorize.getByIds([id]);
      const v = got?.[0];
      return v
        ? { id: v.id, vector: v.values, metadata: v.metadata ?? {} }
        : null;
    }
    const entries = await this.loadEmbeddingsFromKV();
    const e = entries.find((x) => x.id === id);
    return e ? { id: e.id, vector: e.vector, metadata: e.metadata } : null;
  }

  async removeEmbedding(id: string): Promise<void> {
    if (this.vectorize) {
      await this.vectorize.deleteByIds([id]);
    } else {
      const entries = await this.loadEmbeddingsFromKV();
      const filtered = entries.filter((e) => e.id !== id);
      await this.kv.put(EMBEDDINGS_KV_KEY, JSON.stringify(filtered));
    }
  }

  async clearEmbeddings(): Promise<void> {
    if (this.vectorize) {
      // Vectorize has no bulk-clear primitive (deleting by id needs the full id
      // list, which we don't track). After a content reset every page is gone,
      // so orphaned vectors are filtered out at query time anyway — a full purge
      // means recreating the index. Best-effort no-op here, by design — but log
      // it so a caller (admin reset) isn't silently reporting success for a clear
      // the managed index didn't actually perform.
      logger.warn(
        "storage",
        "clearEmbeddings: Vectorize has no bulk-clear; vectors left in place " +
          "(filtered at query time). Recreate the index to fully purge.",
      );
      return;
    }
    await this.kv.put(EMBEDDINGS_KV_KEY, JSON.stringify([]));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadEmbeddingsFromKV(): Promise<
    Array<{ id: string; vector: number[]; metadata: Record<string, string> }>
  > {
    const data = await this.kv.get(EMBEDDINGS_KV_KEY, "json");
    if (!data) return [];
    return data as Array<{
      id: string;
      vector: number[];
      metadata: Record<string, string>;
    }>;
  }
}

// ---------------------------------------------------------------------------
// Error class for missing R2 objects
// ---------------------------------------------------------------------------

/**
 * Error thrown when an R2 object is not found. Mimics Node.js ENOENT
 * errors so existing error-handling code (`isEnoent()`) continues to work.
 */
export class R2NotFoundError extends Error {
  readonly code = "ENOENT";

  constructor(path: string) {
    super(`ENOENT: no such file or directory, open '${path}'`);
    this.name = "R2NotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity (for KV fallback when Vectorize is unavailable)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
