/**
 * Tests for R2StorageProvider using mock Cloudflare bindings.
 *
 * We simulate R2, KV, and Vectorize using in-memory implementations.
 * This lets us test all the R2StorageProvider logic (pagination,
 * directory simulation, error handling, etc.) without needing a real
 * Cloudflare Workers environment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { R2StorageProvider, R2NotFoundError } from "../storage/r2";
import type { CloudflareEnv } from "../storage/cloudflare-types";
import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2ListOptions,
  R2PutOptions,
  KVNamespace,
  VectorizeIndex,
  VectorizeVector,
  VectorizeQueryOptions,
} from "../storage/cloudflare-types";

// ---------------------------------------------------------------------------
// Mock R2 Bucket — in-memory simulation
// ---------------------------------------------------------------------------

interface StoredObject {
  key: string;
  content: string | ArrayBuffer;
  size: number;
  uploaded: Date;
  /** The RAW etag, which is what R2 stores and what `onlyIf` compares. */
  etag: string;
}

/**
 * The two etag forms R2 exposes, kept DISTINCT here on purpose.
 *
 * The real `R2Object` carries a raw `etag` and an `httpEtag` that is the same
 * value quoted for a response header, and `R2Conditional.etagMatches` compares
 * the RAW one. This mock used to store a single quoted string and compare
 * `onlyIf` against the same field it had handed out, so it matched for either
 * convention and could not catch a provider that read the wrong one — which is
 * a break that only shows up on a real Workers runtime, as a compare-and-set
 * that can never succeed again.
 */
function makeR2Object(stored: StoredObject): R2Object {
  return {
    key: stored.key,
    size: stored.size,
    uploaded: stored.uploaded,
    etag: stored.etag,
    httpEtag: `"${stored.etag}"`,
  };
}

function makeR2ObjectBody(stored: StoredObject): R2ObjectBody {
  return {
    ...makeR2Object(stored),
    text: async () => {
      if (typeof stored.content === "string") return stored.content;
      return new TextDecoder().decode(stored.content);
    },
    arrayBuffer: async () => {
      if (stored.content instanceof ArrayBuffer) return stored.content;
      return new TextEncoder().encode(stored.content).buffer as ArrayBuffer;
    },
  };
}

function createMockR2Bucket(): R2Bucket {
  const store = new Map<string, StoredObject>();
  let etagCounter = 0;

  return {
    async get(key: string): Promise<R2ObjectBody | null> {
      const obj = store.get(key);
      return obj ? makeR2ObjectBody(obj) : null;
    },

    async put(
      key: string,
      value: string | ArrayBuffer | ReadableStream,
      options?: R2PutOptions,
    ): Promise<R2Object | null> {
      // Handle conditional put
      if (options?.onlyIf?.etagMatches) {
        const existing = store.get(key);
        // Against the RAW etag, as R2 does. A provider that fed back `httpEtag`
        // fails here, which is the whole point of keeping the two apart.
        if (!existing || existing.etag !== options.onlyIf.etagMatches) {
          return null;
        }
      }

      const content = value as string | ArrayBuffer;
      const size =
        typeof content === "string"
          ? new TextEncoder().encode(content).length
          : content.byteLength;

      etagCounter++;
      const obj: StoredObject = {
        key,
        content,
        size,
        uploaded: new Date(),
        etag: `etag-${etagCounter}`,
      };
      store.set(key, obj);
      return makeR2Object(obj);
    },

    async delete(key: string | string[]): Promise<void> {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        store.delete(k);
      }
    },

    async head(key: string): Promise<R2Object | null> {
      const obj = store.get(key);
      return obj ? makeR2Object(obj) : null;
    },

    async list(options?: R2ListOptions): Promise<R2Objects> {
      const prefix = options?.prefix ?? "";
      const delimiter = options?.delimiter;
      const limit = options?.limit ?? 1000;

      // Collect all matching keys
      const allKeys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();

      const objects: R2Object[] = [];
      const delimitedPrefixes: string[] = [];
      const seenPrefixes = new Set<string>();

      for (const key of allKeys) {
        if (delimiter) {
          // Check if there's a delimiter after the prefix
          const rest = key.slice(prefix.length);
          const delimIdx = rest.indexOf(delimiter);
          if (delimIdx >= 0) {
            // This key is "inside a directory" — add to delimitedPrefixes
            const dp = prefix + rest.slice(0, delimIdx + 1);
            if (!seenPrefixes.has(dp)) {
              seenPrefixes.add(dp);
              delimitedPrefixes.push(dp);
            }
            continue;
          }
        }

        const obj = store.get(key)!;
        objects.push(makeR2Object(obj));
      }

      // Simulate pagination
      const startIdx = options?.cursor ? parseInt(options.cursor, 10) : 0;
      const paginatedObjects = objects.slice(startIdx, startIdx + limit);
      const truncated = startIdx + limit < objects.length;

      return {
        objects: paginatedObjects,
        delimitedPrefixes: startIdx === 0 ? delimitedPrefixes : [],
        truncated,
        cursor: truncated ? String(startIdx + limit) : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock KV Namespace — in-memory simulation
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    async get(key: string, type?: string): Promise<unknown> {
      const val = store.get(key);
      if (val === undefined) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    },

    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  } as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock Vectorize Index — in-memory simulation
// ---------------------------------------------------------------------------

function createMockVectorize(): VectorizeIndex {
  const vectors = new Map<
    string,
    { values: number[]; metadata?: Record<string, string> }
  >();

  function cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  return {
    async upsert(vecs: VectorizeVector[]): Promise<{ count: number }> {
      for (const v of vecs) {
        vectors.set(v.id, { values: v.values, metadata: v.metadata });
      }
      return { count: vecs.length };
    },

    async query(
      vector: number[],
      options: VectorizeQueryOptions,
    ) {
      const matches = Array.from(vectors.entries())
        .map(([id, v]) => ({
          id,
          score: cosineSim(vector, v.values),
          metadata: v.metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);

      return { matches, count: matches.length };
    },

    async deleteByIds(ids: string[]): Promise<{ count: number }> {
      let count = 0;
      for (const id of ids) {
        if (vectors.delete(id)) count++;
      }
      return { count };
    },

    async getByIds(ids: string[]): Promise<VectorizeVector[]> {
      const out: VectorizeVector[] = [];
      for (const id of ids) {
        const v = vectors.get(id);
        if (v) out.push({ id, values: v.values, metadata: v.metadata });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockEnv(opts?: {
  withVectorize?: boolean;
}): CloudflareEnv {
  return {
    YOPEDIA_BUCKET: createMockR2Bucket(),
    YOPEDIA_CONFIG: createMockKV(),
    YOPEDIA_VECTORIZE: opts?.withVectorize ? createMockVectorize() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("R2StorageProvider", () => {
  let env: CloudflareEnv;
  let provider: R2StorageProvider;

  beforeEach(() => {
    env = createMockEnv();
    provider = new R2StorageProvider(env);
  });

  // -------------------------------------------------------------------------
  // Text files
  // -------------------------------------------------------------------------

  describe("readFile / writeFile", () => {
    it("round-trips text content", async () => {
      await provider.writeFile("hello.txt", "world");
      const content = await provider.readFile("hello.txt");
      expect(content).toBe("world");
    });

    it("handles nested paths", async () => {
      await provider.writeFile("wiki/deep/nested.md", "content");
      const content = await provider.readFile("wiki/deep/nested.md");
      expect(content).toBe("content");
    });

    it("overwrites existing files", async () => {
      await provider.writeFile("file.txt", "v1");
      await provider.writeFile("file.txt", "v2");
      expect(await provider.readFile("file.txt")).toBe("v2");
    });

    it("throws R2NotFoundError on reading non-existent file", async () => {
      await expect(provider.readFile("nope.txt")).rejects.toThrow(
        R2NotFoundError,
      );
      await expect(provider.readFile("nope.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("deleteFile", () => {
    it("removes an existing file", async () => {
      await provider.writeFile("del.txt", "bye");
      await provider.deleteFile("del.txt");
      expect(await provider.fileExists("del.txt")).toBe(false);
    });

    it("is silent on missing files (R2 behavior)", async () => {
      // Should not throw
      await provider.deleteFile("nonexistent.txt");
    });
  });

  describe("listFiles", () => {
    it("lists files in a prefix", async () => {
      await provider.writeFile("wiki/a.md", "a");
      await provider.writeFile("wiki/b.md", "b");
      await provider.writeFile("raw/c.md", "c");

      const files = await provider.listFiles("wiki/");
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name).sort()).toEqual(["a.md", "b.md"]);
      expect(files.every((f) => !f.isDirectory)).toBe(true);
    });

    it("returns directories via delimitedPrefixes", async () => {
      await provider.writeFile("wiki/page.md", "content");
      await provider.writeFile("wiki/assets/img.png", "img");

      const files = await provider.listFiles("wiki/");
      const fileNames = files.filter((f) => !f.isDirectory).map((f) => f.name);
      const dirNames = files.filter((f) => f.isDirectory).map((f) => f.name);

      expect(fileNames).toContain("page.md");
      expect(dirNames).toContain("assets");
    });

    it("returns empty array for non-existent prefix", async () => {
      const files = await provider.listFiles("nonexistent/");
      expect(files).toEqual([]);
    });

    it("normalizes prefix without trailing slash", async () => {
      await provider.writeFile("wiki/a.md", "a");
      const files = await provider.listFiles("wiki");
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("a.md");
    });
  });

  describe("fileExists", () => {
    it("returns true for existing files", async () => {
      await provider.writeFile("exists.txt", "yes");
      expect(await provider.fileExists("exists.txt")).toBe(true);
    });

    it("returns false for missing files", async () => {
      expect(await provider.fileExists("nope.txt")).toBe(false);
    });
  });

  describe("appendFile", () => {
    it("creates file if it doesn't exist", async () => {
      await provider.appendFile("log.md", "line1\n");
      expect(await provider.readFile("log.md")).toBe("line1\n");
    });

    it("appends to existing file", async () => {
      await provider.writeFile("log.md", "line1\n");
      await provider.appendFile("log.md", "line2\n");
      expect(await provider.readFile("log.md")).toBe("line1\nline2\n");
    });
  });

  describe("stat", () => {
    it("returns size and lastModified", async () => {
      await provider.writeFile("stat.txt", "hello");
      const info = await provider.stat("stat.txt");
      expect(info.size).toBe(5);
      expect(info.lastModified).toBeInstanceOf(Date);
    });

    it("throws R2NotFoundError for missing files", async () => {
      await expect(provider.stat("nope.txt")).rejects.toThrow(R2NotFoundError);
    });
  });

  describe("deleteDirectory", () => {
    it("removes all files under a prefix", async () => {
      await provider.writeFile("revisions/page/1.md", "v1");
      await provider.writeFile("revisions/page/2.md", "v2");
      await provider.writeFile("revisions/other/1.md", "other");

      await provider.deleteDirectory("revisions/page/");

      expect(await provider.fileExists("revisions/page/1.md")).toBe(false);
      expect(await provider.fileExists("revisions/page/2.md")).toBe(false);
      // Other directory should be untouched
      expect(await provider.fileExists("revisions/other/1.md")).toBe(true);
    });

    it("is a no-op for non-existent directory", async () => {
      // Should not throw
      await provider.deleteDirectory("nonexistent/");
    });
  });

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  describe("writeAsset / readAsset", () => {
    it("round-trips binary data", async () => {
      const data = new Uint8Array([0, 1, 2, 3, 255]).buffer as ArrayBuffer;
      await provider.writeAsset("wiki/assets/img.png", data);
      const result = await provider.readAsset("wiki/assets/img.png");
      expect(new Uint8Array(result)).toEqual(new Uint8Array(data));
    });

    it("throws R2NotFoundError for missing assets", async () => {
      await expect(provider.readAsset("nope.png")).rejects.toThrow(
        R2NotFoundError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Optimistic concurrency
  // -------------------------------------------------------------------------

  describe("readFileWithEtag / writeFileIfMatch", () => {
    it("reads file with etag", async () => {
      await provider.writeFile("page.md", "content");
      const result = await provider.readFileWithEtag("page.md");
      expect(result.content).toBe("content");
      expect(result.etag).toBeTruthy();
    });

    it("writes successfully when etag matches", async () => {
      await provider.writeFile("page.md", "v1");
      const { etag } = await provider.readFileWithEtag("page.md");

      const success = await provider.writeFileIfMatch("page.md", "v2", etag);
      expect(success).toBe(true);
      expect(await provider.readFile("page.md")).toBe("v2");
    });

    it("fails when etag doesn't match", async () => {
      await provider.writeFile("page.md", "v1");

      const success = await provider.writeFileIfMatch(
        "page.md",
        "v2",
        '"wrong-etag"',
      );
      expect(success).toBe(false);
      // Original content unchanged
      expect(await provider.readFile("page.md")).toBe("v1");
    });

    it("hands back the RAW etag, not the quoted header form", async () => {
      // `R2Conditional.etagMatches` compares the raw one. Returning `httpEtag`
      // makes every conditional put compare `"abc"` against `abc`, so the second
      // compare-and-set on any object fails forever — and since DW-272 that is
      // every settings save on Workers after the first.
      await provider.writeFile("page.md", "v1");
      const { etag } = await provider.readFileWithEtag("page.md");
      expect(etag.startsWith('"')).toBe(false);
      // …and the value it hands back is exactly what a conditional put accepts.
      expect(await provider.writeFileIfMatch("page.md", "v2", etag)).toBe(true);
      // The quoted form is NOT interchangeable, which is what makes the above a
      // real assertion rather than one the mock satisfies either way.
      const quoted = await provider.readFileWithEtag("page.md");
      expect(
        await provider.writeFileIfMatch("page.md", "v3", `"${quoted.etag}"`),
      ).toBe(false);
    });

    it("throws R2NotFoundError for missing file", async () => {
      await expect(
        provider.readFileWithEtag("nope.md"),
      ).rejects.toThrow(R2NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // Derived indexes (KV)
  // -------------------------------------------------------------------------

  describe("getIndex / putIndex", () => {
    it("returns null for non-existent index", async () => {
      const result = await provider.getIndex("nonexistent");
      expect(result).toBeNull();
    });

    it("round-trips JSON data", async () => {
      const data = { foo: "bar", count: 42 };
      await provider.putIndex("config", data);
      const result = await provider.getIndex("config");
      expect(result).toEqual(data);
    });

    it("overwrites existing index", async () => {
      await provider.putIndex("key", { v: 1 });
      await provider.putIndex("key", { v: 2 });
      expect(await provider.getIndex("key")).toEqual({ v: 2 });
    });

    it("stores arrays", async () => {
      const arr = [1, 2, 3];
      await provider.putIndex("arr", arr);
      expect(await provider.getIndex("arr")).toEqual([1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // Embeddings — KV fallback (no Vectorize)
  // -------------------------------------------------------------------------

  describe("embeddings (KV fallback)", () => {
    it("upserts and queries embeddings", async () => {
      await provider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      await provider.upsertEmbedding("page2", [0, 1, 0], { hash: "b" });

      const results = await provider.queryEmbeddings([1, 0, 0], 2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("page1");
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it("removes embeddings", async () => {
      await provider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      await provider.removeEmbedding("page1");

      const results = await provider.queryEmbeddings([1, 0, 0], 5);
      expect(results).toHaveLength(0);
    });

    it("updates existing embeddings", async () => {
      await provider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      await provider.upsertEmbedding("page1", [0, 1, 0], { hash: "b" });

      const results = await provider.queryEmbeddings([0, 1, 0], 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("page1");
      expect(results[0].metadata.hash).toBe("b");
    });

    it("getEmbeddingById returns the vector + metadata, or null", async () => {
      await provider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      const got = await provider.getEmbeddingById("page1");
      expect(got).toEqual({ id: "page1", vector: [1, 0, 0], metadata: { hash: "a" } });
      expect(await provider.getEmbeddingById("missing")).toBeNull();
    });

    it("clearEmbeddings empties the KV store", async () => {
      await provider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      await provider.clearEmbeddings();
      expect(await provider.getEmbeddingById("page1")).toBeNull();
      expect(await provider.queryEmbeddings([1, 0, 0], 5)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Bulk write doors (DW-293)
  // -------------------------------------------------------------------------

  /**
   * The batch doors exist so shared code (`portable-archive.ts`, `backups.ts`,
   * `document-sources.ts`, `embeddings.ts`) has ONE way to write a set. That only
   * holds if both providers answer the same way, so the rows the filesystem
   * provider pins are pinned here too — with the one difference stated: R2 has no
   * fsync, so the batch buys concurrency rather than a collapsed barrier.
   */
  describe("writeBatch", () => {
    it("lands every entry, mixing text and binary", async () => {
      await provider.writeBatch([
        { path: "batch/a.md", body: "alpha" },
        { path: "batch/b.bin", body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer },
      ]);

      expect(await provider.readFile("batch/a.md")).toBe("alpha");
      expect(Buffer.from(await provider.readAsset("batch/b.bin"))).toEqual(
        Buffer.from([1, 2, 3]),
      );
    });

    it("spans more than one concurrency window without losing entries", async () => {
      await provider.writeBatch(
        Array.from({ length: 40 }, (_, i) => ({
          path: `wide/f-${i}.md`,
          body: `body-${i}`,
        })),
      );

      expect(await provider.listFiles("wide")).toHaveLength(40);
      expect(await provider.readFile("wide/f-0.md")).toBe("body-0");
      expect(await provider.readFile("wide/f-39.md")).toBe("body-39");
    });

    it("rejects duplicate paths before writing anything", async () => {
      await expect(
        provider.writeBatch([
          { path: "dupe/a.md", body: "first" },
          { path: "dupe/a.md", body: "second" },
        ]),
      ).rejects.toThrow(/dupe\/a\.md/);

      expect(await provider.fileExists("dupe/a.md")).toBe(false);
    });

    it("catches a duplicate that only two different spellings of one path share", async () => {
      // The filesystem provider compares RESOLVED paths, so these are one file
      // there and the batch is refused. R2 keys are opaque strings, so without a
      // normalized comparison the same batch would be accepted here and silently
      // last-write-win — one interface answering two ways about one input.
      await expect(
        provider.writeBatch([
          { path: "same/a.md", body: "first" },
          { path: "./same/a.md", body: "second" },
        ]),
      ).rejects.toThrow(/same\/a\.md/);
    });

    it("writes nothing for an empty batch", async () => {
      await provider.writeBatch([]);
      expect(await provider.listFiles("")).toEqual([]);
    });

    it("propagates a failing PUT and stops issuing the rest of the batch", async () => {
      const faultEnv = createMockEnv();
      const realPut = faultEnv.YOPEDIA_BUCKET.put.bind(faultEnv.YOPEDIA_BUCKET);
      const fault = new Error("R2 put failed");
      const attempted: string[] = [];
      faultEnv.YOPEDIA_BUCKET.put = async (key, value, options) => {
        attempted.push(key);
        if (key === "fan/f-5.md") throw fault;
        return realPut(key, value, options);
      };
      const faultProvider = new R2StorageProvider(faultEnv);

      // More entries than the concurrency window, so there is a "rest of the
      // batch" for the fault to stop.
      const entries = Array.from({ length: 60 }, (_, i) => ({
        path: `fan/f-${i}.md`,
        body: `body-${i}`,
      }));

      // Identity, not just "some error": the batch door promises the faulting
      // entry's own error, unchanged.
      await expect(faultProvider.writeBatch(entries)).rejects.toBe(fault);

      // Bounded: the PUTs already in flight may still land, but the workers must
      // not keep working through a batch whose result the caller will never see.
      expect(attempted.length).toBeLessThan(entries.length);
    });
  });

  describe("upsertEmbeddings (KV fallback)", () => {
    it("replaces stored ids, appends new ones, and lets the later entry win", async () => {
      await provider.upsertEmbedding("a", [1, 0], { v: "old-a" });

      await provider.upsertEmbeddings([
        { id: "a", vector: [0, 1], metadata: { v: "new-a" } },
        { id: "b", vector: [1, 1], metadata: { v: "first-b" } },
        { id: "b", vector: [2, 2], metadata: { v: "last-b" } },
      ]);

      expect(await provider.getEmbeddingById("a")).toEqual({
        id: "a",
        vector: [0, 1],
        metadata: { v: "new-a" },
      });
      expect(await provider.getEmbeddingById("b")).toEqual({
        id: "b",
        vector: [2, 2],
        metadata: { v: "last-b" },
      });
      expect(await provider.queryEmbeddings([1, 1], 10)).toHaveLength(2);
    });

    it("writes nothing for an empty flush", async () => {
      await provider.upsertEmbeddings([]);
      expect(await provider.getIndex("embeddings")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Embeddings — Vectorize
  // -------------------------------------------------------------------------

  describe("embeddings (Vectorize)", () => {
    let vecProvider: R2StorageProvider;

    beforeEach(() => {
      const vecEnv = createMockEnv({ withVectorize: true });
      vecProvider = new R2StorageProvider(vecEnv);
    });

    it("upserts and queries via Vectorize", async () => {
      await vecProvider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      await vecProvider.upsertEmbedding("page2", [0, 1, 0], { hash: "b" });

      const results = await vecProvider.queryEmbeddings([1, 0, 0], 2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("page1");
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it("removes via Vectorize", async () => {
      await vecProvider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      await vecProvider.removeEmbedding("page1");

      const results = await vecProvider.queryEmbeddings([1, 0, 0], 5);
      expect(results).toHaveLength(0);
    });

    it("upserts a whole batch through ONE Vectorize call", async () => {
      await vecProvider.upsertEmbeddings([
        { id: "page1", vector: [1, 0, 0], metadata: { hash: "a" } },
        { id: "page2", vector: [0, 1, 0], metadata: { hash: "b" } },
      ]);

      const results = await vecProvider.queryEmbeddings([1, 0, 0], 2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("page1");
      expect(await vecProvider.getEmbeddingById("page2")).toEqual({
        id: "page2",
        vector: [0, 1, 0],
        metadata: { hash: "b" },
      });
    });

    it("collapses a repeated id BEFORE handing the batch to Vectorize", async () => {
      // The in-memory mock happens to apply a duplicate-id payload last-wins,
      // so asserting only on the stored result would pass without the merge.
      // Real Vectorize does not define which of two mutations for one id in one
      // call survives, so what has to be pinned is the PAYLOAD: one entry per id.
      const spyEnv = createMockEnv({ withVectorize: true });
      const index = spyEnv.YOPEDIA_VECTORIZE!;
      const realUpsert = index.upsert.bind(index);
      const payloads: VectorizeVector[][] = [];
      index.upsert = async (vecs) => {
        payloads.push(vecs);
        return realUpsert(vecs);
      };
      const spyProvider = new R2StorageProvider(spyEnv);

      await spyProvider.upsertEmbeddings([
        { id: "page1", vector: [1, 0, 0], metadata: { v: "first" } },
        { id: "page2", vector: [0, 1, 0], metadata: { v: "other" } },
        { id: "page1", vector: [0, 0, 1], metadata: { v: "last" } },
      ]);

      expect(payloads).toHaveLength(1);
      expect(payloads[0].map((v) => v.id)).toEqual(["page1", "page2"]);
      expect(payloads[0][0]).toMatchObject({
        id: "page1",
        values: [0, 0, 1],
        metadata: { v: "last" },
      });
      expect(await spyProvider.getEmbeddingById("page1")).toEqual({
        id: "page1",
        vector: [0, 0, 1],
        metadata: { v: "last" },
      });
    });

    it("getEmbeddingById fetches a stored vector via getByIds", async () => {
      await vecProvider.upsertEmbedding("page1", [1, 0, 0], { model: "bge-m3", contentHash: "a" });
      const got = await vecProvider.getEmbeddingById("page1");
      expect(got).toEqual({
        id: "page1",
        vector: [1, 0, 0],
        metadata: { model: "bge-m3", contentHash: "a" },
      });
      expect(await vecProvider.getEmbeddingById("missing")).toBeNull();
    });

    it("clearEmbeddings is a best-effort no-op for Vectorize (no bulk-clear)", async () => {
      await vecProvider.upsertEmbedding("page1", [1, 0, 0], { hash: "a" });
      // Must not throw; the managed index has no bulk-clear, so the vector
      // remains and is filtered at query time by the caller.
      await expect(vecProvider.clearEmbeddings()).resolves.toBeUndefined();
      expect(await vecProvider.getEmbeddingById("page1")).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // R2NotFoundError
  // -------------------------------------------------------------------------

  describe("R2NotFoundError", () => {
    it("has ENOENT code for compatibility", () => {
      const err = new R2NotFoundError("test/path");
      expect(err.code).toBe("ENOENT");
      expect(err.message).toContain("test/path");
      expect(err.name).toBe("R2NotFoundError");
    });

    it("is an instance of Error", () => {
      const err = new R2NotFoundError("path");
      expect(err).toBeInstanceOf(Error);
    });
  });
});

// ---------------------------------------------------------------------------
// Storage factory tests for initCloudflareStorage
// ---------------------------------------------------------------------------

describe("initCloudflareStorage", () => {
  let resetStorage: () => void;
  let getStorage: () => import("../storage/types").StorageProvider;
  let initCloudflareStorage: (
    env: CloudflareEnv,
  ) => import("../storage/types").StorageProvider;

  beforeEach(async () => {
    const mod = await import("../storage");
    resetStorage = mod._resetStorage;
    getStorage = mod.getStorage;
    initCloudflareStorage = mod.initCloudflareStorage;
    resetStorage();
  });

  afterEach(() => {
    resetStorage();
  });

  it("returns an R2StorageProvider", () => {
    const env = createMockEnv();
    const storage = initCloudflareStorage(env);
    expect(storage).toBeInstanceOf(R2StorageProvider);
  });

  it("makes getStorage() return the R2 provider", () => {
    const env = createMockEnv();
    initCloudflareStorage(env);
    const storage = getStorage();
    expect(storage).toBeInstanceOf(R2StorageProvider);
  });

  it("allows re-initialization with new bindings", () => {
    const env1 = createMockEnv();
    const env2 = createMockEnv();
    const s1 = initCloudflareStorage(env1);
    const s2 = initCloudflareStorage(env2);
    expect(s1).not.toBe(s2);
    expect(getStorage()).toBe(s2);
  });
});


// ---------------------------------------------------------------------------
// The settings store, ON THE CLOUDFLARE BACKEND (DW-272)
// ---------------------------------------------------------------------------

/**
 * `readConfig` / `saveConfig` driven through `R2StorageProvider`.
 *
 * DW-272's complaint was that the scheme had NO Cloudflare coverage at all: the
 * two-file pairing it replaced could not be read atomically on R2, and the
 * compare-and-set that replaced it is the one part of the design whose
 * correctness is a property of the R2 API rather than of `config.ts`. Every
 * other test of the scheme runs on the filesystem provider or against a mocked
 * `saveConfig`, so this is the only place the two meet.
 *
 * The EXISTING mock bucket, deliberately: a bespoke harness here would be a
 * second thing to keep true to R2, and this one already models the raw/quoted
 * etag split the conditional put depends on.
 */
describe("the settings store on R2", () => {
  let resetStorage: () => void;
  let initCloudflareStorage: (
    env: CloudflareEnv,
  ) => import("../storage/types").StorageProvider;
  let config: typeof import("../config");

  beforeEach(async () => {
    const storageMod = await import("../storage");
    resetStorage = storageMod._resetStorage;
    initCloudflareStorage = storageMod.initCloudflareStorage;
    config = await import("../config");
    resetStorage();
    config._resetConfigCache();
    initCloudflareStorage(createMockEnv());
  });

  afterEach(() => {
    config._resetConfigCache();
    resetStorage();
  });

  it("round-trips the token INSIDE the one object, stripped on the way out", async () => {
    const first = await config.readConfig();
    expect(first).toMatchObject({
      status: "ok",
      config: {},
      version: config.UNSTAMPED_CONFIG_VERSION,
      // Nothing to read means nothing to write against.
      etag: null,
    });

    const saved = await config.saveConfig(
      { provider: "openai", firecrawlApiKey: "fc-secret" },
      first.status === "ok" ? first.etag : null,
    );
    expect(saved).toMatchObject({ status: "ok" });

    const read = await config.readConfig();
    expect(read).toMatchObject({
      status: "ok",
      // The reserved key never reaches a consumer.
      config: { provider: "openai", firecrawlApiKey: "fc-secret" },
      version: saved.status === "ok" ? saved.version : "",
    });
    // …and an object that exists always has an etag to write against.
    expect(read.status === "ok" && read.etag).toBeTruthy();

    // ONE object in the bucket, carrying both halves — no sibling to pair.
    const raw = JSON.parse(
      await (await import("../storage")).getStorage().readFile(".llm-wiki-config.json"),
    );
    expect(raw.__settingsVersion).toBe(saved.status === "ok" ? saved.version : "");
    expect(raw.provider).toBe("openai");
  });

  it("REFUSES a save whose compare-and-set was superseded", async () => {
    await config.saveConfig({ provider: "openai" });
    const read = await config.readConfig();
    expect(read.status).toBe("ok");
    const etag = read.status === "ok" ? read.etag : null;

    // Another writer lands between this reader's read and its write.
    const other = await config.saveConfig({ provider: "google" });
    expect(other).toMatchObject({ status: "ok" });

    const lost = await config.saveConfig({ provider: "anthropic" }, etag);
    expect(lost).toEqual({ status: "conflict" });

    // The other writer's value still stands, untouched.
    config._resetConfigCache();
    expect(await config.readConfig()).toMatchObject({
      status: "ok",
      config: { provider: "google" },
      version: other.status === "ok" ? other.version : "",
    });
  });
});
