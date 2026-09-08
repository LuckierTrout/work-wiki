/**
 * R2StorageProvider — Cloudflare R2/KV/Vectorize-backed implementation of
 * the StorageProvider interface.
 *
 * Maps the abstract storage operations to Cloudflare's services:
 *   - Text files + assets → R2 Bucket
 *   - Derived indexes → KV Namespace
 *   - Atomic counters (`ATOMIC_COUNTER_INDEX_KEYS`) → R2 compare-and-swap
 *   - Embeddings → Vectorize Index (optional, falls back to KV)
 *
 * R2 is a flat key-value store, so "directories" are simulated using
 * key prefixes and the R2 `list()` delimiter feature.
 */

import type {
  StorageProvider,
  BatchWriter,
  FileInfo,
  FileWithEtag,
  FileEntry,
  EmbeddingEntry,
  EmbeddingFilter,
  EmbeddingQueryResult,
} from "./types";
import {
  ATOMIC_COUNTER_INDEX_KEYS,
  isAtomicCounterIndexKey,
  mergeEmbeddingEntries,
} from "./types";
import { narrowIndexInteger } from "./index-integer";

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

/**
 * R2 object prefix for counters that must increment across Worker isolates.
 * Distinct from the KV `_idx:` prefix so a leftover KV value can seed the
 * first compare-and-swap without the two stores writing the same key space.
 */
const ATOMIC_INDEX_R2_PREFIX = "_idx/";

/** Give up rather than livelock a request if every compare-and-swap loses. */
const INCREMENT_INDEX_MAX_ATTEMPTS = 32;

function atomicIndexR2Key(key: string): string {
  return `${ATOMIC_INDEX_R2_PREFIX}${key}`;
}

/** KV key for fallback embedding store when Vectorize is unavailable. */
const EMBEDDINGS_KV_KEY = "_idx:embeddings";

/**
 * Vectors per `vectorize.upsert` call.
 *
 * `upsertEmbeddings` takes a set of ANY size — the interface puts no cap on it,
 * and a caller is entitled to hand over a whole rebuild — while Vectorize caps
 * one request. Chunking here rather than asking callers to is the difference
 * between a large flush costing more requests and a large flush REJECTING, which
 * on the rebuild path would cost every page in it. 1000 is comfortably under
 * the documented per-request ceiling and is not load-bearing: any value that
 * fits works, and the merge that precedes it already fixed the ordering.
 */
const VECTORIZE_UPSERT_CHUNK = 1000;

/**
 * The FLOOR this branch raises a filtered Vectorize request to.
 *
 * Vectorize ranks SERVER-side, so the pre-slice guarantee cannot be met by
 * asking it for the top-K accepted vectors — see the comment on
 * `queryEmbeddings` for why a server-side metadata filter is not the answer
 * either. The branch therefore asks for a window at least this wide, filters it
 * here, and slices to the caller's `topK`. Without the floor a filtered
 * `topK: 1` would hand the single slot to whichever vector the predicate is
 * about to refuse, which is the DW-598 shape exactly.
 *
 * It is a floor, never a cap: the request is `Math.max(topK, …)`, so a caller
 * asking for more than this still gets its own width. Narrowing the door's
 * ANSWER to buy a tidier filtered window would be the worse trade — callers
 * already pass 30 (`RELATED_CANDIDATE_POOL`) and 64 (`browse.ts`).
 *
 * 20 is where the documented `topK` ceiling for `returnMetadata: "all"` sits,
 * and this branch needs the metadata to evaluate the predicate at all. A caller
 * that already asks for more than that is a PRE-EXISTING condition of this
 * branch — it requested `returnMetadata: "all"` at that width before the
 * predicate existed — which this change neither introduces nor fixes.
 */
const VECTORIZE_FILTERED_TOPK = 20;

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
      // The keyspace is flat and `head` only answers for a real object, so
      // there is no directory here to report.
      isDirectory: false,
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

  async writeFileIfAbsent(path: string, content: string): Promise<boolean> {
    const result = await this.bucket.put(path, content, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    return result !== null;
  }

  /**
   * The binary twin of {@link writeFileIfAbsent}: the same native create-only
   * conditional put, handed the `ArrayBuffer` instead of a string.
   *
   * `etagDoesNotMatch: "*"` is R2's "only if nothing is there" — one round
   * trip that both tests and publishes, so concurrent creators cannot both
   * win. A HEAD-then-`put` pair would reintroduce exactly the race this
   * exists to close.
   */
  async writeAssetIfAbsent(path: string, data: ArrayBuffer): Promise<boolean> {
    const result = await this.bucket.put(path, data, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    return result !== null;
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
    if (isAtomicCounterIndexKey(key)) {
      const obj = await this.bucket.get(atomicIndexR2Key(key));
      if (obj) {
        try {
          return JSON.parse(await obj.text()) as T;
        } catch {
          return null;
        }
      }
    }
    const value = await this.kv.get(`${INDEX_PREFIX}${key}`, "json");
    return (value as T) ?? null;
  }

  async putIndex<T = unknown>(key: string, value: T): Promise<void> {
    if (isAtomicCounterIndexKey(key)) {
      await this.bucket.put(atomicIndexR2Key(key), JSON.stringify(value));
      return;
    }
    await this.kv.put(`${INDEX_PREFIX}${key}`, JSON.stringify(value));
  }

  async incrementIndex(key: string): Promise<number> {
    if (!isAtomicCounterIndexKey(key)) {
      throw new Error(
        `incrementIndex is only defined for atomic counter keys (${ATOMIC_COUNTER_INDEX_KEYS.join(", ")}); got ${JSON.stringify(key)}`,
      );
    }

    const r2Key = atomicIndexR2Key(key);
    const kvKey = `${INDEX_PREFIX}${key}`;

    for (let attempt = 0; attempt < INCREMENT_INDEX_MAX_ATTEMPTS; attempt++) {
      const obj = await this.bucket.get(r2Key);
      let current: number;
      let result: Awaited<ReturnType<R2Bucket["put"]>>;

      if (obj) {
        try {
          current = narrowIndexInteger(JSON.parse(await obj.text()));
        } catch {
          current = 0;
        }
        result = await this.bucket.put(r2Key, JSON.stringify(current + 1), {
          onlyIf: { etagMatches: obj.etag },
        });
      } else {
        current = narrowIndexInteger(await this.kv.get(kvKey, "json"));
        result = await this.bucket.put(r2Key, JSON.stringify(current + 1), {
          onlyIf: { etagDoesNotMatch: "*" },
        });
      }

      if (result) return current + 1;
    }

    throw new Error(
      `incrementIndex(${key}) exhausted ${INCREMENT_INDEX_MAX_ATTEMPTS} compare-and-swap attempts`,
    );
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

    for (const atomic of ATOMIC_COUNTER_INDEX_KEYS) {
      if (!atomic.startsWith(prefix) || keys.includes(atomic)) continue;
      if (await this.bucket.head(atomicIndexR2Key(atomic))) {
        keys.push(atomic);
      }
    }

    return keys;
  }

  // -------------------------------------------------------------------------
  // Embeddings / vector search
  // -------------------------------------------------------------------------

  /**
   * One vector, through the bulk door — the same delegation the filesystem
   * provider makes, for the same reason: one implementation of the merge rule
   * means a single upsert and a bulk upsert cannot disagree.
   */
  async upsertEmbedding(
    id: string,
    vector: number[],
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.upsertEmbeddings([{ id, vector, metadata }]);
  }

  /**
   * The whole set in one operation.
   *
   * Vectorize's `upsert` already takes an ARRAY, so the bulk door is what that
   * API wanted all along; the set is de-duplicated first (`mergeEmbeddingEntries`
   * against an empty base) so a repeated id inside one call resolves to the
   * last value here rather than however the managed index happens to order
   * two writes of one id in a single request. The KV fallback collapses to one
   * load / merge / put, which is where the real saving is: it is the branch
   * that otherwise rewrote the whole blob per vector.
   *
   * An empty set does nothing at all.
   */
  async upsertEmbeddings(entries: EmbeddingEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (this.vectorize) {
      const vectors = mergeEmbeddingEntries([], entries).map((entry) => ({
        id: entry.id,
        values: entry.vector,
        metadata: entry.metadata,
      }));
      // Chunked, so a set larger than the per-request ceiling costs more
      // requests rather than rejecting the whole flush. De-duplication happened
      // above, so no id can straddle two chunks and land twice.
      for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_CHUNK) {
        await this.vectorize.upsert(vectors.slice(i, i + VECTORIZE_UPSERT_CHUNK));
      }
      return;
    }
    // Fallback: store in KV as a JSON blob (same approach as filesystem)
    const stored = await this.loadEmbeddingsFromKV();
    await this.kv.put(
      EMBEDDINGS_KV_KEY,
      JSON.stringify(mergeEmbeddingEntries(stored, entries)),
    );
  }

  /**
   * Two branches, and only one of them can honour the pre-slice guarantee
   * exactly.
   *
   * The KV fallback ranks locally over a blob it already holds in memory, so it
   * mirrors the filesystem provider precisely: filter, then score, sort and
   * slice.
   *
   * Vectorize ranks SERVER-side. When `accept` is supplied this branch
   * over-fetches to {@link VECTORIZE_FILTERED_TOPK}, filters that window here,
   * and slices to `topK` — so `rejected` is WINDOW-SCOPED, not corpus-scoped: it
   * counts what the over-fetched window turned away and says nothing about
   * vectors ranked below it. A corpus deeper than the ceiling can therefore
   * still hand back fewer than `topK` accepted matches, and the caller's drift
   * gate is stated in those terms rather than pretending otherwise (see
   * `warnedMisconfigurations` in `embeddings.ts`).
   *
   * A server-side metadata filter is NOT the fix, and is deliberately not used.
   * The only caller's predicate is "the vector's model is the active one OR the
   * vector carries no model at all" — unlabelled legacy vectors are KEPT on
   * purpose, since dropping them empties the corpus after a first deploy.
   * Vectorize's filter grammar is `$eq/$ne/$lt/$lte/$gt/$gte/$in/$nin` over a
   * field with no existence operator, and a vector missing the filtered field
   * is excluded, so every expressible approximation would drop the legacy
   * vectors from what this door RETURNS, not merely from what the caller
   * judges. That is a change to the answer, which the caller forbids.
   */
  async queryEmbeddings(
    vector: number[],
    topK: number,
    accept?: EmbeddingFilter,
  ): Promise<EmbeddingQueryResult> {
    if (this.vectorize) {
      const result = await this.vectorize.query(vector, {
        topK: accept ? Math.max(topK, VECTORIZE_FILTERED_TOPK) : topK,
        returnMetadata: "all",
      });
      const window = result.matches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: (m.metadata as Record<string, string>) ?? {},
      }));
      if (!accept) return { matches: window, rejected: 0 };
      const kept = window.filter((m) => accept(m.metadata));
      return {
        matches: kept.slice(0, topK),
        rejected: window.length - kept.length,
      };
    }

    // Fallback: brute-force cosine similarity in KV. Local ranking, so the
    // predicate narrows the candidate set BEFORE the sort and slice — exactly
    // as the filesystem provider does.
    const entries = await this.loadEmbeddingsFromKV();
    const candidates = accept
      ? entries.filter((e) => accept(e.metadata))
      : entries;
    const scored = candidates.map((e) => ({
      id: e.id,
      score: cosineSimilarity(vector, e.vector),
      metadata: e.metadata,
    }));
    scored.sort((a, b) => b.score - a.score);
    return {
      matches: scored.slice(0, topK),
      rejected: entries.length - candidates.length,
    };
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
  // Batched writes
  // -------------------------------------------------------------------------

  /**
   * A pass-through — R2 has nothing to batch.
   *
   * The filesystem door exists because a whole-file write there costs a real
   * fsync, and a loop of them costs one each. An R2 write is a single-object
   * PUT: it is already its own barrier, it is already atomic, and it is already
   * acknowledged as durable when it resolves. There is no per-write cost to
   * defer and therefore nothing a scope could amortise.
   *
   * It is implemented anyway because the door is part of the
   * {@link StorageProvider} contract, and a caller must be able to take it
   * without asking which provider it is talking to. On this provider the
   * "trade" the interface describes simply is not made: every batch member is
   * as durable as if it had been written alone.
   */
  async withBatchedWrites<T>(fn: (batch: BatchWriter) => Promise<T>): Promise<T> {
    // Closed at scope exit even though nothing here is deferred, because the
    // CONTRACT must not differ per provider: a body that leaks the writer has
    // to fail the same way on both, or the bug is found only in production.
    let closed = false;
    const guard = (filePath: string): void => {
      if (!closed) return;
      throw new Error(
        `withBatchedWrites: the batch writer was used after its scope exited (${filePath}). ` +
          "Every write must be awaited inside the body.",
      );
    };
    const batch: BatchWriter = {
      writeFile: async (filePath, content) => {
        guard(filePath);
        await this.writeFile(filePath, content);
      },
      writeAsset: async (filePath, data) => {
        guard(filePath);
        await this.writeAsset(filePath, data);
      },
    };
    try {
      return await fn(batch);
    } finally {
      closed = true;
    }
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
