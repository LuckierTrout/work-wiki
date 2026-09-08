import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FilesystemStorageProvider,
  STRANDED_SCRATCH_CANDIDATE_CAP,
  STRANDED_SCRATCH_GRACE_MS,
  withFilesystemPublicationLockForTest,
  writeSyncedAndPublish,
  writeSyncedNewFile,
} from "../storage/filesystem";
import { mergeEmbeddingEntries } from "../storage/types";
import type { EmbeddingEntry } from "../storage/types";

/**
 * The merge rule, tested where it lives rather than only through a provider.
 *
 * `mergeEmbeddingEntries` is the SINGLE source of cross-provider agreement about
 * embedding order: the filesystem blob and the R2 KV fallback both run it, and
 * `upsertEmbedding` delegates to `upsertEmbeddings` so a single write and a bulk
 * write cannot disagree either. Tested only through a provider, a change to the
 * rule reads as a change to that provider's storage format.
 */
describe("mergeEmbeddingEntries", () => {
  const entry = (id: string, tag: string): EmbeddingEntry =>
    ({ id, vector: [1, 0], metadata: { tag } });
  const shape = (entries: EmbeddingEntry[]) =>
    entries.map((e) => `${e.id}:${e.metadata.tag}`);

  it("keeps stored entries in their stored positions when they are updated", () => {
    const merged = mergeEmbeddingEntries(
      [entry("a", "old-a"), entry("b", "old-b"), entry("c", "old-c")],
      [entry("c", "new-c"), entry("a", "new-a")],
    );

    // Updated in place — an update must never reorder the index.
    expect(shape(merged)).toEqual(["a:new-a", "b:old-b", "c:new-c"]);
  });

  it("lets the LAST value for a repeated incoming id win, at its FIRST position", () => {
    const merged = mergeEmbeddingEntries(
      [],
      [entry("x", "1"), entry("y", "y"), entry("x", "2"), entry("x", "3")],
    );

    expect(shape(merged)).toEqual(["x:3", "y:y"]);
  });

  it("appends ids that are not stored yet in argument order", () => {
    const merged = mergeEmbeddingEntries(
      [entry("a", "a")],
      [entry("z", "z"), entry("m", "m"), entry("a", "a2")],
    );

    expect(shape(merged)).toEqual(["a:a2", "z:z", "m:m"]);
  });

  it("collapses a stored blob that already holds one id twice", () => {
    // The store is supposed to be id-unique and nothing enforces it. Mapping
    // each slot independently would alias ONE incoming object into BOTH, leaving
    // the duplicate in place and sharing a single object between two positions.
    const merged = mergeEmbeddingEntries(
      [entry("dup", "first"), entry("keep", "keep"), entry("dup", "second")],
      [entry("dup", "incoming")],
    );

    expect(shape(merged)).toEqual(["dup:incoming", "keep:keep"]);
  });

  it("never mutates the stored array", () => {
    const stored = [entry("a", "old")];
    const snapshot = shape(stored);

    mergeEmbeddingEntries(stored, [entry("a", "new"), entry("b", "b")]);

    expect(shape(stored)).toEqual(snapshot);
  });

  it("returns the stored list unchanged for an empty incoming set", () => {
    const merged = mergeEmbeddingEntries([entry("a", "a"), entry("b", "b")], []);

    expect(shape(merged)).toEqual(["a:a", "b:b"]);
  });
});

describe("FilesystemStorageProvider", () => {
  let tmpDir: string;
  let provider: FilesystemStorageProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-storage-test-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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

    it("creates parent directories automatically", async () => {
      await provider.writeFile("a/b/c/deep.md", "nested");
      const content = await provider.readFile("a/b/c/deep.md");
      expect(content).toBe("nested");
    });

    it("overwrites existing files", async () => {
      await provider.writeFile("file.txt", "v1");
      await provider.writeFile("file.txt", "v2");
      expect(await provider.readFile("file.txt")).toBe("v2");
    });

    it("throws on reading non-existent file", async () => {
      await expect(provider.readFile("nope.txt")).rejects.toThrow();
    });
  });

  describe("deleteFile", () => {
    it("removes an existing file", async () => {
      await provider.writeFile("del.txt", "bye");
      await provider.deleteFile("del.txt");
      expect(await provider.fileExists("del.txt")).toBe(false);
    });

    it("throws on deleting a non-existent file", async () => {
      await expect(provider.deleteFile("nope.txt")).rejects.toThrow();
    });
  });

  describe("listFiles", () => {
    it("returns files and directories", async () => {
      await provider.writeFile("dir/a.md", "a");
      await provider.writeFile("dir/b.md", "b");
      await provider.writeFile("dir/sub/c.md", "c");

      const entries = await provider.listFiles("dir");
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.md", "b.md", "sub"]);

      const subDir = entries.find((e) => e.name === "sub");
      expect(subDir?.isDirectory).toBe(true);

      const file = entries.find((e) => e.name === "a.md");
      expect(file?.isDirectory).toBe(false);
    });

    it("returns empty array for non-existent directory", async () => {
      const entries = await provider.listFiles("nope");
      expect(entries).toEqual([]);
    });
  });

  describe("fileExists", () => {
    it("returns true for existing files", async () => {
      await provider.writeFile("exists.txt", "yes");
      expect(await provider.fileExists("exists.txt")).toBe(true);
    });

    it("returns false for non-existent files", async () => {
      expect(await provider.fileExists("nope.txt")).toBe(false);
    });
  });

  describe("appendFile", () => {
    it("creates a new file if it does not exist", async () => {
      await provider.appendFile("log.md", "line1\n");
      expect(await provider.readFile("log.md")).toBe("line1\n");
    });

    it("appends to an existing file", async () => {
      await provider.writeFile("log.md", "line1\n");
      await provider.appendFile("log.md", "line2\n");
      expect(await provider.readFile("log.md")).toBe("line1\nline2\n");
    });

    it("creates parent directories", async () => {
      await provider.appendFile("deep/nested/log.md", "content");
      expect(await provider.readFile("deep/nested/log.md")).toBe("content");
    });
  });

  describe("stat", () => {
    it("returns correct size and lastModified", async () => {
      const content = "hello world";
      await provider.writeFile("stat.txt", content);
      const info = await provider.stat("stat.txt");
      expect(info.size).toBe(Buffer.byteLength(content, "utf-8"));
      expect(info.lastModified).toBeInstanceOf(Date);
      // Should be recent
      expect(Date.now() - info.lastModified.getTime()).toBeLessThan(5000);
    });

    it("throws on non-existent file", async () => {
      await expect(provider.stat("nope.txt")).rejects.toThrow();
    });

    // DW-701: the archive collision probe reads this flag to tell an ordinary
    // collision from a tenant path blocked by a directory. `stat` SUCCEEDS on a
    // directory, so without the flag the two are indistinguishable.
    it("reports isDirectory false for a file and true for a directory", async () => {
      await provider.writeFile("dir-probe/a.md", "a");
      expect((await provider.stat("dir-probe/a.md")).isDirectory).toBe(false);
      expect((await provider.stat("dir-probe")).isDirectory).toBe(true);
    });
  });

  describe("deleteDirectory", () => {
    it("removes a directory recursively", async () => {
      await provider.writeFile("rm-dir/a.md", "a");
      await provider.writeFile("rm-dir/sub/b.md", "b");
      await provider.deleteDirectory("rm-dir");
      expect(await provider.fileExists("rm-dir/a.md")).toBe(false);
      expect(await provider.fileExists("rm-dir")).toBe(false);
    });

    it("is a no-op for non-existent directory", async () => {
      // Should not throw
      await provider.deleteDirectory("nope-dir");
    });
  });

  // -------------------------------------------------------------------------
  // Assets (binary)
  // -------------------------------------------------------------------------

  describe("writeAsset / readAsset", () => {
    it("round-trips binary data", async () => {
      const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
      await provider.writeAsset("img.bin", data.buffer as ArrayBuffer);
      const result = await provider.readAsset("img.bin");
      const resultArr = new Uint8Array(result);
      expect(resultArr).toEqual(data);
    });

    it("creates parent directories for assets", async () => {
      const data = new Uint8Array([42]).buffer as ArrayBuffer;
      await provider.writeAsset("assets/deep/pic.png", data);
      const result = await provider.readAsset("assets/deep/pic.png");
      expect(new Uint8Array(result)[0]).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // Optimistic concurrency
  // -------------------------------------------------------------------------

  describe("readFileWithEtag", () => {
    it("returns content and a consistent etag", async () => {
      await provider.writeFile("etag.txt", "v1");
      const result = await provider.readFileWithEtag("etag.txt");
      expect(result.content).toBe("v1");
      expect(typeof result.etag).toBe("string");
      expect(result.etag.length).toBeGreaterThan(0);

      // Same content, same etag (no modifications)
      const result2 = await provider.readFileWithEtag("etag.txt");
      expect(result2.etag).toBe(result.etag);
    });
  });

  describe("writeFileIfMatch", () => {
    it("succeeds when etag matches", async () => {
      await provider.writeFile("cas.txt", "v1");
      const { etag } = await provider.readFileWithEtag("cas.txt");
      const ok = await provider.writeFileIfMatch("cas.txt", "v2", etag);
      expect(ok).toBe(true);
      expect(await provider.readFile("cas.txt")).toBe("v2");
    });

    it("fails when etag does not match", async () => {
      await provider.writeFile("cas.txt", "v1");
      const ok = await provider.writeFileIfMatch("cas.txt", "v2", "bogus-etag");
      expect(ok).toBe(false);
      // Original content unchanged
      expect(await provider.readFile("cas.txt")).toBe("v1");
    });

    it("fails for non-existent file", async () => {
      const ok = await provider.writeFileIfMatch("nope.txt", "v1", "any");
      expect(ok).toBe(false);
    });

    it("serializes a competing normal write ahead of stale CAS publication", async () => {
      const competitor = new FilesystemStorageProvider(tmpDir);
      await provider.writeFile("cas.txt", "v1");
      const { etag } = await provider.readFileWithEtag("cas.txt");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const entered = new Promise<void>((resolve) => { locked = resolve; });
      const holder = withFilesystemPublicationLockForTest(tmpDir, "cas.txt", async () => {
        locked();
        await gate;
      });
      await entered;
      const competingWrite = competitor.writeFile("cas.txt", "competing");
      await Promise.resolve();
      const staleCas = provider.writeFileIfMatch("cas.txt", "stale", etag);
      release();
      await holder;
      await competingWrite;
      await expect(staleCas).resolves.toBe(false);
      await expect(provider.readFile("cas.txt")).resolves.toBe("competing");
    });
  });

  describe("writeFileIfAbsent", () => {
    it("allows exactly one concurrent creator and publishes one whole value", async () => {
      const values = ["first", "second"];
      const results = await Promise.all(
        values.map((value) => provider.writeFileIfAbsent("create.txt", value)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.findIndex(Boolean);
      expect(await provider.readFile("create.txt")).toBe(values[winner]);
      expect(
        (await fs.readdir(tmpDir)).filter((name) => /^\.tmp-.*\.tmp$/.test(name)),
      ).toEqual([]);
    });

    it("does not replace a file that already exists", async () => {
      await provider.writeFile("create.txt", "already here");

      await expect(
        provider.writeFileIfAbsent("create.txt", "replacement"),
      ).resolves.toBe(false);

      await expect(provider.readFile("create.txt")).resolves.toBe("already here");
      expect(
        (await fs.readdir(tmpDir)).filter((name) => /^\.tmp-.*\.tmp$/.test(name)),
      ).toEqual([]);
    });

    it("keeps a write or sync error ahead of a later close error", async () => {
      const writeError = new Error("write failed first");
      const closeError = new Error("close failed later");
      const handle = {
        writeFile: vi.fn().mockRejectedValue(writeError),
        sync: vi.fn(),
        close: vi.fn().mockRejectedValue(closeError),
      };

      await expect(writeSyncedNewFile(handle, "bytes")).rejects.toBe(writeError);
      expect(handle.close).toHaveBeenCalledOnce();
    });
  });

  describe("writeAssetIfAbsent", () => {
    it("allows exactly one concurrent creator and publishes one whole value", async () => {
      // The reason this primitive exists: immutable Source bytes (FR-2) are
      // stored with ONE call, so two arrivals on the same absent key cannot
      // both see "absent" and let the loser's bytes land last.
      const values = [
        new Uint8Array([1, 2, 3]),
        new Uint8Array([9, 9, 9, 9]),
      ];
      const results = await Promise.all(
        values.map((value) =>
          provider.writeAssetIfAbsent("create.bin", value.buffer as ArrayBuffer),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.findIndex(Boolean);
      expect(
        new Uint8Array(await provider.readAsset("create.bin")),
      ).toEqual(values[winner]);
      expect(
        (await fs.readdir(tmpDir)).filter((name) => /^\.tmp-.*\.tmp$/.test(name)),
      ).toEqual([]);
    });

    it("does not replace an asset that already exists", async () => {
      const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await provider.writeAsset("create.bin", original.buffer as ArrayBuffer);

      await expect(
        provider.writeAssetIfAbsent(
          "create.bin",
          new Uint8Array([0, 0]).buffer as ArrayBuffer,
        ),
      ).resolves.toBe(false);

      expect(new Uint8Array(await provider.readAsset("create.bin"))).toEqual(
        original,
      );
      expect(
        (await fs.readdir(tmpDir)).filter((name) => /^\.tmp-.*\.tmp$/.test(name)),
      ).toEqual([]);
    });

    it("round-trips bytes that are not valid UTF-8", async () => {
      // The whole point of the binary door: a lone 0xFF through the string
      // writer comes back as U+FFFD.
      const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
      await expect(
        provider.writeAssetIfAbsent("raw.bin", bytes.buffer as ArrayBuffer),
      ).resolves.toBe(true);
      expect(new Uint8Array(await provider.readAsset("raw.bin"))).toEqual(bytes);
    });

    it("creates parent directories for a nested key", async () => {
      const bytes = new Uint8Array([7, 7, 7]);
      await expect(
        provider.writeAssetIfAbsent(
          "nested/deep/asset.bin",
          bytes.buffer as ArrayBuffer,
        ),
      ).resolves.toBe(true);
      expect(
        new Uint8Array(await provider.readAsset("nested/deep/asset.bin")),
      ).toEqual(bytes);
    });
  });

  // -------------------------------------------------------------------------
  // Derived indexes
  // -------------------------------------------------------------------------

  describe("getIndex / putIndex", () => {
    it("round-trips a JSON object", async () => {
      const data = { name: "test", items: [1, 2, 3] };
      await provider.putIndex("mykey", data);
      const result = await provider.getIndex("mykey");
      expect(result).toEqual(data);
    });

    it("returns null for non-existent key", async () => {
      const result = await provider.getIndex("nope");
      expect(result).toBeNull();
    });

    it("overwrites existing index", async () => {
      await provider.putIndex("k", { v: 1 });
      await provider.putIndex("k", { v: 2 });
      expect(await provider.getIndex("k")).toEqual({ v: 2 });
    });

    it("stores indexes in .indexes directory", async () => {
      await provider.putIndex("config", { ok: true });
      const abs = path.join(tmpDir, ".indexes", "config.json");
      const raw = await fs.readFile(abs, "utf-8");
      expect(JSON.parse(raw)).toEqual({ ok: true });
    });
  });

  describe("incrementIndex", () => {
    it("stores 1 on the first bump and keeps counting from there", async () => {
      await expect(provider.incrementIndex("data-version")).resolves.toBe(1);
      await expect(provider.getIndex("data-version")).resolves.toBe(1);
      await expect(provider.incrementIndex("any-counter")).resolves.toBe(1);
    });

    it("never lets concurrent increments collapse", async () => {
      const n = 16;
      const values = await Promise.all(
        Array.from({ length: n }, () => provider.incrementIndex("data-version")),
      );
      expect(new Set(values).size).toBe(n);
      await expect(provider.getIndex("data-version")).resolves.toBe(n);
    });
  });

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  describe("upsertEmbedding + queryEmbeddings", () => {
    it("returns nearest neighbors sorted by score", async () => {
      // Simple 2D vectors for easy reasoning
      await provider.upsertEmbedding("a", [1, 0], { label: "right" });
      await provider.upsertEmbedding("b", [0, 1], { label: "up" });
      await provider.upsertEmbedding("c", [1, 1], { label: "diagonal" });

      // Query with [1, 0] — should match "a" best, then "c", then "b"
      const { matches: results, rejected } = await provider.queryEmbeddings([1, 0], 3);
      expect(rejected).toBe(0);
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe("a");
      expect(results[0].score).toBeCloseTo(1.0);
      expect(results[0].metadata.label).toBe("right");

      expect(results[1].id).toBe("c");
      // cos([1,0], [1,1]) = 1/sqrt(2) ≈ 0.707
      expect(results[1].score).toBeCloseTo(1 / Math.sqrt(2));

      expect(results[2].id).toBe("b");
      expect(results[2].score).toBeCloseTo(0);
    });

    it("respects topK limit", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      await provider.upsertEmbedding("b", [0, 1], {});
      await provider.upsertEmbedding("c", [1, 1], {});

      const { matches: results } = await provider.queryEmbeddings([1, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a");
    });

    it("updates existing embedding on upsert", async () => {
      await provider.upsertEmbedding("a", [1, 0], { v: "1" });
      await provider.upsertEmbedding("a", [0, 1], { v: "2" });

      const { matches: results } = await provider.queryEmbeddings([0, 1], 1);
      expect(results[0].id).toBe("a");
      expect(results[0].metadata.v).toBe("2");
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it("returns empty array when no embeddings exist", async () => {
      const results = await provider.queryEmbeddings([1, 0], 5);
      expect(results).toEqual({ matches: [], rejected: 0 });
    });

    // -----------------------------------------------------------------------
    // The pre-slice filter (DW-598)
    // -----------------------------------------------------------------------

    it("applies `accept` BEFORE the top-K slice, so a rejected vector never takes the slot", async () => {
      // The DW-598 shape in miniature: the NEAREST vector is the one the
      // predicate refuses. Filtering after the slice would hand back an empty
      // window on a corpus that holds a perfectly good accepted vector one rank
      // down; filtering before it hands back that vector.
      await provider.upsertEmbedding("stale", [1, 0], { model: "old" });
      await provider.upsertEmbedding("current", [1, 1], { model: "new" });

      const { matches, rejected } = await provider.queryEmbeddings(
        [1, 0],
        1,
        (metadata) => metadata.model === "new",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe("current");
      expect(rejected).toBe(1);
    });

    it("counts every turned-away vector in `rejected`, not just the ones in the window", async () => {
      await provider.upsertEmbedding("a", [1, 0], { model: "old" });
      await provider.upsertEmbedding("b", [1, 1], { model: "old" });
      await provider.upsertEmbedding("c", [0, 1], { model: "old" });

      const { matches, rejected } = await provider.queryEmbeddings(
        [1, 0],
        1,
        (metadata) => metadata.model === "new",
      );
      // A fully drifted store: nothing accepted, but the count says vectors
      // were there — which is what tells this apart from an empty store.
      expect(matches).toEqual([]);
      expect(rejected).toBe(3);
    });

    it("reports `rejected: 0` on an empty store even with a predicate that accepts nothing", async () => {
      const { matches, rejected } = await provider.queryEmbeddings([1, 0], 5, () => false);
      expect(matches).toEqual([]);
      expect(rejected).toBe(0);
    });

    it("ranks and slices identically with an accept-all predicate and with none", async () => {
      await provider.upsertEmbedding("a", [1, 0], { model: "new" });
      await provider.upsertEmbedding("b", [0, 1], { model: "new" });
      await provider.upsertEmbedding("c", [1, 1], { model: "new" });

      const unfiltered = await provider.queryEmbeddings([1, 0], 2);
      const acceptAll = await provider.queryEmbeddings([1, 0], 2, () => true);
      expect(acceptAll).toEqual(unfiltered);
      expect(unfiltered.rejected).toBe(0);
    });
  });

  describe("removeEmbedding", () => {
    it("removes an embedding by id", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      await provider.upsertEmbedding("b", [0, 1], {});

      await provider.removeEmbedding("a");
      const { matches: results } = await provider.queryEmbeddings([1, 0], 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("b");
    });

    it("is a no-op for non-existent id", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      await provider.removeEmbedding("nonexistent");
      const { matches: results } = await provider.queryEmbeddings([1, 0], 10);
      expect(results).toHaveLength(1);
    });
  });
  // -------------------------------------------------------------------------
  // Atomic whole-file writes (DW-161)
  // -------------------------------------------------------------------------

  /**
   * The provider promises (`storage/types.ts`) that a caller never sees a
   * partial file. What makes that true is that every whole-file write lands on
   * a sibling tmp file and is `rename`d over the destination, so the
   * destination name only ever points at a COMPLETE file. These rows assert the
   * mechanism, not just the outcome: a bare `fs.writeFile` passes every
   * round-trip assertion above while still truncating in place.
   */
  describe("atomic whole-file writes", () => {
    /** The inode of a path — the observable that separates rename from truncate. */
    async function inodeOf(rel: string): Promise<bigint> {
      const st = await fs.stat(path.join(tmpDir, rel), { bigint: true });
      return st.ino;
    }

    /** Scratch files `atomicWrite` leaves behind if it does not clean up. */
    async function tmpArtifactsIn(rel: string): Promise<string[]> {
      const entries = await fs.readdir(path.join(tmpDir, rel));
      return entries.filter((name) => /^\.tmp-.*\.tmp$/.test(name));
    }

    it("replaces the destination by rename, not by truncating it in place", async () => {
      await provider.writeFile("a.md", "old");
      const before = await inodeOf("a.md");

      await provider.writeFile("a.md", "new");

      expect(await provider.readFile("a.md")).toBe("new");
      expect(await inodeOf("a.md")).not.toBe(before);
    });

    it("leaves a reader holding the old file seeing the old bytes", async () => {
      await provider.writeFile("a.md", "old");
      // Opened BEFORE the write: it holds the old inode, which a rename leaves
      // intact and a truncate would blow away underneath it.
      const reader = await fs.open(path.join(tmpDir, "a.md"), "r");
      try {
        await provider.writeFile("a.md", "brand new and longer");
        expect((await reader.readFile("utf-8"))).toBe("old");
      } finally {
        await reader.close();
      }
      expect(await provider.readFile("a.md")).toBe("brand new and longer");
    });

    it("leaves no tmp residue after a successful write", async () => {
      await provider.writeFile("dir/a.md", "one");
      await provider.writeFile("dir/a.md", "two");

      expect(await fs.readdir(path.join(tmpDir, "dir"))).toEqual(["a.md"]);
      expect(await tmpArtifactsIn("dir")).toEqual([]);
    });

    it("cleans up and leaves the destination untouched when the write cannot complete", async () => {
      // A directory is a destination `rename` can never replace (its emptiness
      // is irrelevant — renaming a file onto ANY directory fails), so this
      // faults at the LAST step, after the tmp file already exists. The child
      // file is what gives the untouched-destination assertion something to
      // check.
      await provider.writeFile("blocked/child.md", "keep me");

      await expect(provider.writeFile("blocked", "nope")).rejects.toThrow();

      expect(await fs.readdir(path.join(tmpDir, "blocked"))).toEqual(["child.md"]);
      expect(await provider.readFile("blocked/child.md")).toBe("keep me");
      expect(await tmpArtifactsIn(".")).toEqual([]);
    });

    it("preserves the mode of an overwritten file", async () => {
      await provider.writeFile("secret.md", "v1");
      await fs.chmod(path.join(tmpDir, "secret.md"), 0o600);

      await provider.writeFile("secret.md", "v2");

      const st = await fs.stat(path.join(tmpDir, "secret.md"));
      expect(st.mode & 0o777).toBe(0o600);
      expect(await provider.readFile("secret.md")).toBe("v2");
    });

    it("gives a new file the same default mode a plain write would", async () => {
      await provider.writeFile("plain.md", "atomic");
      await fs.writeFile(path.join(tmpDir, "control.md"), "control", "utf-8");

      const [written, control] = await Promise.all([
        fs.stat(path.join(tmpDir, "plain.md")),
        fs.stat(path.join(tmpDir, "control.md")),
      ]);
      expect(written.mode & 0o777).toBe(control.mode & 0o777);
    });

    it("never blends or truncates under concurrent writes to one path", async () => {
      const contents = Array.from({ length: 10 }, (_, i) => `content-${i}`.repeat(200));

      await Promise.all(contents.map((c) => provider.writeFile("hot.md", c)));

      // No lock is promised, so which one wins is undefined — that it is exactly
      // ONE of them, whole, is the guarantee.
      expect(contents).toContain(await provider.readFile("hot.md"));
      expect(await tmpArtifactsIn(".")).toEqual([]);
    });

    it("hides tmp artifacts from listFiles while keeping other dot-entries", async () => {
      await provider.writeFile("dir/page.md", "content");
      // `.discarded` is the control: a real marker `sweepOrphans` depends on, so
      // the filter must be tmp-shaped, not "anything dot-prefixed".
      await fs.writeFile(path.join(tmpDir, "dir", ".discarded"), "", "utf-8");
      await fs.writeFile(
        path.join(tmpDir, "dir", ".tmp-11111111-2222-3333-4444-555555555555.tmp"),
        "leftover from a crash",
        "utf-8",
      );

      const names = (await provider.listFiles("dir")).map((e) => e.name).sort();
      expect(names).toEqual([".discarded", "page.md"]);
    });

    it("replaces by rename for writeAsset too", async () => {
      await provider.writeAsset("img.bin", new Uint8Array([1, 2, 3]).buffer);
      const before = await inodeOf("img.bin");

      await provider.writeAsset("img.bin", new Uint8Array([9]).buffer);

      expect(await inodeOf("img.bin")).not.toBe(before);
      expect(Buffer.from(await provider.readAsset("img.bin"))).toEqual(Buffer.from([9]));
      expect(await tmpArtifactsIn(".")).toEqual([]);
    });

    it("replaces by rename for a matching writeFileIfMatch", async () => {
      await provider.writeFile("cas.md", "v1");
      const before = await inodeOf("cas.md");
      const { etag } = await provider.readFileWithEtag("cas.md");

      expect(await provider.writeFileIfMatch("cas.md", "v2", etag)).toBe(true);

      expect(await inodeOf("cas.md")).not.toBe(before);
      expect(await provider.readFile("cas.md")).toBe("v2");
      expect(await tmpArtifactsIn(".")).toEqual([]);
    });

    it("replaces by rename for putIndex", async () => {
      await provider.putIndex("cfg", { v: 1 });
      const before = await inodeOf(".indexes/cfg.json");

      await provider.putIndex("cfg", { v: 2 });

      expect(await inodeOf(".indexes/cfg.json")).not.toBe(before);
      expect(await provider.getIndex("cfg")).toEqual({ v: 2 });
      expect(await tmpArtifactsIn(".indexes")).toEqual([]);
    });

    it("replaces by rename for upsertEmbedding", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      const before = await inodeOf(".indexes/embeddings.json");

      await provider.upsertEmbedding("b", [0, 1], {});

      expect(await inodeOf(".indexes/embeddings.json")).not.toBe(before);
      expect(await provider.getEmbeddingById("b")).not.toBeNull();
      expect(await tmpArtifactsIn(".indexes")).toEqual([]);
    });

    it("fsyncs the tmp file BEFORE the rename publishes it", async () => {
      const events: string[] = [];
      const handle = {
        writeFile: vi.fn(async () => { events.push("write"); }),
        sync: vi.fn(async () => { events.push("sync"); }),
        close: vi.fn(async () => { events.push("close"); }),
      };
      await writeSyncedAndPublish(handle, "bytes", async () => { events.push("rename"); });
      expect(events).toEqual(["write", "sync", "close", "rename"]);
    });

    it("keeps listIndexKeys free of tmp artifacts", async () => {
      await provider.putIndex("cfg", { v: 1 });
      await fs.writeFile(
        path.join(tmpDir, ".indexes", ".tmp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp"),
        "leftover",
        "utf-8",
      );

      expect(await provider.listIndexKeys("")).toEqual(["cfg"]);
    });
  });

  // -------------------------------------------------------------------------
  // Batched writes
  // -------------------------------------------------------------------------

  describe("withBatchedWrites", () => {
    /** Scratch files a batched write leaves behind if it does not clean up. */
    async function tmpArtifactsIn(rel: string): Promise<string[]> {
      const entries = await fs.readdir(path.join(tmpDir, rel));
      return entries.filter((name) => /^\.tmp-.*\.tmp$/.test(name));
    }

    async function inodeOf(rel: string): Promise<bigint> {
      const st = await fs.stat(path.join(tmpDir, rel), { bigint: true });
      return st.ino;
    }

    it("returns the body's value and leaves every member readable and whole", async () => {
      const answer = await provider.withBatchedWrites(async (batch) => {
        await batch.writeFile("batch/a.md", "alpha");
        await batch.writeAsset("batch/b.bin", new Uint8Array([1, 2, 3]).buffer);
        return "returned";
      });

      expect(answer).toBe("returned");
      expect(await provider.readFile("batch/a.md")).toBe("alpha");
      expect([...new Uint8Array(await provider.readAsset("batch/b.bin"))])
        .toEqual([1, 2, 3]);
      expect(await tmpArtifactsIn("batch")).toEqual([]);
    });

    it("still publishes by rename inside a batch, never by truncating in place", async () => {
      // The guarantee the batch KEEPS. Only durability moves; a member is still
      // a new inode renamed over the destination, so a reader holding the old
      // file still sees the old whole bytes rather than a torn new one.
      await provider.writeFile("batch/a.md", "old");
      const before = await inodeOf("batch/a.md");
      const reader = await fs.open(path.join(tmpDir, "batch", "a.md"), "r");
      try {
        await provider.withBatchedWrites(async (batch) => {
          await batch.writeFile("batch/a.md", "brand new and longer");
        });
        expect((await reader.readFile("utf-8"))).toBe("old");
      } finally {
        await reader.close();
      }

      expect(await provider.readFile("batch/a.md")).toBe("brand new and longer");
      expect(await inodeOf("batch/a.md")).not.toBe(before);
      expect(await tmpArtifactsIn("batch")).toEqual([]);
    });

    it("makes a member readable immediately, before the scope exits", async () => {
      // Deferring the fsync does NOT defer the publication: callers like the
      // backup verifier write and then read the same path back inside the body.
      await provider.withBatchedWrites(async (batch) => {
        await batch.writeAsset("batch/round.bin", new Uint8Array([9]).buffer);
        expect([...new Uint8Array(await provider.readAsset("batch/round.bin"))])
          .toEqual([9]);
      });
    });

    it("propagates the body's own error, keeps the writes that landed, and leaves no tmp artifact", async () => {
      const boom = new Error("body gave up");
      await expect(provider.withBatchedWrites(async (batch) => {
        await batch.writeFile("batch/one.md", "1");
        await batch.writeFile("batch/two.md", "2");
        throw boom;
      })).rejects.toBe(boom);

      expect(await provider.readFile("batch/one.md")).toBe("1");
      expect(await provider.readFile("batch/two.md")).toBe("2");
      expect(await tmpArtifactsIn("batch")).toEqual([]);
    });

    /**
     * Count fsyncs by kind while `fn` runs.
     *
     * `FileHandle` is not exported and `node:fs/promises` is an ESM namespace
     * that cannot be spied on, so the seam is the PROTOTYPE every handle shares:
     * open one file, take its prototype, wrap `sync`. The wrapper asks the
     * handle whether it is a directory, which is what separates a batch's
     * directory barrier from a per-file payload fsync.
     */
    async function countSyncs<T>(fn: () => Promise<T>): Promise<{
      result: T;
      files: number;
      directories: number;
    }> {
      const probePath = path.join(tmpDir, ".sync-probe");
      const probe = await fs.open(probePath, "w");
      const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
      await probe.close();
      await fs.rm(probePath, { force: true });
      const original = proto.sync;
      let files = 0;
      let directories = 0;
      proto.sync = async function patched(this: fs.FileHandle) {
        if ((await this.stat()).isDirectory()) directories += 1;
        else files += 1;
        return original.call(this);
      };
      try {
        const result = await fn();
        return { result, files, directories };
      } finally {
        proto.sync = original;
      }
    }

    it("issues one directory barrier per distinct directory and no per-file fsync", async () => {
      const counted = await countSyncs(() =>
        provider.withBatchedWrites(async (batch) => {
          await batch.writeFile("d1/a.md", "a");
          await batch.writeFile("d1/b.md", "b");
          await batch.writeFile("d2/c.md", "c");
          await batch.writeAsset("d3/d.bin", new Uint8Array([4]).buffer);
        }),
      );

      // Three distinct directories, four members: three barriers, zero payload
      // fsyncs. Unbatched, the same four writes cost four payload fsyncs.
      expect(counted.directories).toBe(3);
      expect(counted.files).toBe(0);
      expect(await provider.readFile("d1/b.md")).toBe("b");
      expect(await provider.readFile("d2/c.md")).toBe("c");
    });

    it("barriers the whole scope once, however many members share a directory", async () => {
      const counted = await countSyncs(() =>
        provider.withBatchedWrites(async (batch) => {
          for (let i = 0; i < 12; i++) await batch.writeFile(`one/f${i}.md`, `${i}`);
        }),
      );

      expect(counted.directories).toBe(1);
      expect(counted.files).toBe(0);
      for (let i = 0; i < 12; i++) {
        expect(await provider.readFile(`one/f${i}.md`)).toBe(`${i}`);
      }
    });

    it("runs the barrier even when the body throws", async () => {
      const counted = await countSyncs(async () => {
        await expect(provider.withBatchedWrites(async (batch) => {
          await batch.writeFile("d4/a.md", "a");
          throw new Error("half way");
        })).rejects.toThrow("half way");
      });

      expect(counted.directories).toBe(1);
      expect(await provider.readFile("d4/a.md")).toBe("a");
      expect(await tmpArtifactsIn("d4")).toEqual([]);
    });

    it("does not defer an UNBATCHED write's own fsync", async () => {
      // The default is untouched: a single write outside a batch still forces
      // its own bytes before publishing its name.
      const counted = await countSyncs(() => provider.writeFile("solo.md", "solo"));

      expect(counted.files).toBe(1);
      expect(counted.directories).toBe(0);
    });

    it("refuses a write issued after the scope has exited", async () => {
      // A leaked writer's write would get neither its own payload fsync nor any
      // barrier — strictly worse than either mode — so the door closes behind
      // the body and says so.
      let leaked!: Parameters<Parameters<typeof provider.withBatchedWrites>[0]>[0];
      await provider.withBatchedWrites(async (batch) => {
        leaked = batch;
        await batch.writeFile("leak/inside.md", "inside");
      });

      await expect(leaked.writeFile("leak/after.md", "after"))
        .rejects.toThrow(/used after its scope exited/);
      await expect(leaked.writeAsset("leak/after.bin", new Uint8Array([1]).buffer))
        .rejects.toThrow(/used after its scope exited/);
      // Nothing landed, and the write that WAS inside the scope is intact.
      expect(await provider.fileExists("leak/after.md")).toBe(false);
      expect(await provider.readFile("leak/inside.md")).toBe("inside");
    });

    /**
     * Make every DIRECTORY fsync reject with `code`, leaving file fsyncs alone.
     *
     * The barrier ladder — which codes are swallowed, which propagate, whether
     * the body's error still wins, whether the remaining directories are still
     * barriered — is the most intricate logic in the batch door and none of it
     * is reachable without a failing fsync, which a healthy disk will not give.
     */
    async function withFailingDirectorySync<T>(
      code: string,
      fn: () => Promise<T>,
    ): Promise<{ result: T; attempted: number }> {
      const probePath = path.join(tmpDir, ".fail-probe");
      const probe = await fs.open(probePath, "w");
      const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
      await probe.close();
      await fs.rm(probePath, { force: true });
      const original = proto.sync;
      let attempted = 0;
      proto.sync = async function patched(this: fs.FileHandle) {
        if (!(await this.stat()).isDirectory()) return original.call(this);
        attempted += 1;
        const error: NodeJS.ErrnoException = new Error(`barrier refused: ${code}`);
        error.code = code;
        throw error;
      };
      try {
        return { result: await fn(), attempted };
      } finally {
        proto.sync = original;
      }
    }

    it("propagates a barrier failure whose code is outside the swallow set", async () => {
      // EIO is a dying disk, not a filesystem declining to fsync a directory.
      // The body resolved, so this error is the only thing the caller can learn.
      const failure = withFailingDirectorySync("EIO", async () => {
        await provider.withBatchedWrites(async (batch) => {
          await batch.writeFile("eio/a.md", "a");
        });
      });

      await expect(failure).rejects.toThrow(/barrier refused: EIO/);
    });

    it.each(["EPERM", "EISDIR", "EINVAL", "EACCES", "ENOTSUP", "ENOSYS", "EOPNOTSUPP"])(
      "swallows a barrier refusal of %s — the mount will not fsync a directory",
      async (code) => {
        const { attempted } = await withFailingDirectorySync(code, async () => {
          await provider.withBatchedWrites(async (batch) => {
            await batch.writeFile(`${code}/a.md`, "a");
          });
        });

        // It TRIED — the refusal is swallowed, not skipped.
        expect(attempted).toBe(1);
        expect(await provider.readFile(`${code}/a.md`)).toBe("a");
      },
    );

    it.each(["ENOENT", "ENOTDIR"])(
      "treats %s as nothing left to barrier rather than a failure",
      async (code) => {
        // The barrier opens the directory at scope EXIT, so a body that removed
        // a directory it wrote into must not turn a successful batch into a throw.
        const { attempted } = await withFailingDirectorySync(code, async () => {
          await provider.withBatchedWrites(async (batch) => {
            await batch.writeFile(`${code}/a.md`, "a");
          });
        });

        expect(attempted).toBe(1);
      },
    );

    it("lets the body's own error win when the barrier fails too", async () => {
      const boom = new Error("body gave up");
      const failure = withFailingDirectorySync("EIO", async () => {
        await provider.withBatchedWrites(async (batch) => {
          await batch.writeFile("both/a.md", "a");
          throw boom;
        });
      });

      // Not the EIO: the body's error is the one the caller can act on.
      await expect(failure).rejects.toBe(boom);
    });

    it("still barriers the remaining directories after one of them fails", async () => {
      const { attempted } = await withFailingDirectorySync("EIO", async () => {
        await expect(provider.withBatchedWrites(async (batch) => {
          await batch.writeFile("many1/a.md", "a");
          await batch.writeFile("many2/b.md", "b");
          await batch.writeFile("many3/c.md", "c");
        })).rejects.toThrow(/barrier refused: EIO/);
      });

      // All three were attempted — the loop does not abandon the rest on the
      // first failure, and only the first failure is reported.
      expect(attempted).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Bulk embedding upsert
  // -------------------------------------------------------------------------

  describe("upsertEmbeddings", () => {
    async function storedIds(): Promise<string[]> {
      const raw = await fs.readFile(
        path.join(tmpDir, ".indexes", "embeddings.json"),
        "utf-8",
      );
      return (JSON.parse(raw) as Array<{ id: string }>).map((entry) => entry.id);
    }

    it("stores the whole set with ONE index rewrite", async () => {
      await provider.upsertEmbedding("seed", [1, 0], { v: "seed" });
      const before = await fs.stat(
        path.join(tmpDir, ".indexes", "embeddings.json"),
        { bigint: true },
      );

      await provider.upsertEmbeddings([
        { id: "a", vector: [1, 0], metadata: { v: "a" } },
        { id: "b", vector: [0, 1], metadata: { v: "b" } },
        { id: "c", vector: [1, 1], metadata: { v: "c" } },
      ]);

      const after = await fs.stat(
        path.join(tmpDir, ".indexes", "embeddings.json"),
        { bigint: true },
      );
      // One rewrite = one new inode, not three.
      expect(after.ino).not.toBe(before.ino);
      expect(await storedIds()).toEqual(["seed", "a", "b", "c"]);
    });

    it("keeps stored order, lets the last write for a repeated id win, and appends new ids in argument order", async () => {
      await provider.upsertEmbeddings([
        { id: "first", vector: [1, 0], metadata: { v: "1" } },
        { id: "second", vector: [0, 1], metadata: { v: "2" } },
      ]);

      await provider.upsertEmbeddings([
        { id: "new", vector: [1, 1], metadata: { v: "new-a" } },
        { id: "new", vector: [2, 2], metadata: { v: "new-b" } },
        { id: "first", vector: [9, 9], metadata: { v: "updated" } },
        { id: "later", vector: [3, 3], metadata: { v: "later" } },
      ]);

      // `first` stayed where it was stored; the two new ids appended in the
      // order they first appeared.
      expect(await storedIds()).toEqual(["first", "second", "new", "later"]);
      expect((await provider.getEmbeddingById("first"))!.metadata.v).toBe("updated");
      // Last write for the repeated id wins.
      expect((await provider.getEmbeddingById("new"))!.metadata.v).toBe("new-b");
      expect((await provider.getEmbeddingById("new"))!.vector).toEqual([2, 2]);
    });

    it("writes nothing at all for an empty set", async () => {
      await provider.upsertEmbedding("only", [1, 0], { v: "1" });
      const indexPath = path.join(tmpDir, ".indexes", "embeddings.json");
      const before = await fs.stat(indexPath, { bigint: true });
      const bytesBefore = await fs.readFile(indexPath, "utf-8");

      await provider.upsertEmbeddings([]);

      const after = await fs.stat(indexPath, { bigint: true });
      // Same inode AND same mtime: no rewrite happened, so no barrier could have.
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(await fs.readFile(indexPath, "utf-8")).toBe(bytesBefore);
    });

    it("leaves single upsertEmbedding on exactly the same merge rule", async () => {
      await provider.upsertEmbeddings([
        { id: "a", vector: [1, 0], metadata: { v: "a" } },
        { id: "b", vector: [0, 1], metadata: { v: "b" } },
      ]);
      await provider.upsertEmbedding("a", [5, 5], { v: "a2" });
      await provider.upsertEmbedding("c", [7, 7], { v: "c" });

      expect(await storedIds()).toEqual(["a", "b", "c"]);
      expect((await provider.getEmbeddingById("a"))!.vector).toEqual([5, 5]);
    });
  });

  // -------------------------------------------------------------------------
  // Scratch reclamation
  // -------------------------------------------------------------------------

  /**
   * The reaper's WALK, pinned at the provider against a real filesystem
   * (DW-292).
   *
   * `maintenance.test.ts` covers the wrapper, but every row there mocks or
   * drives the whole method, so none of them can see inside the pass: whether
   * one bad entry aborts it, whether an unreadable subdirectory is the same
   * thing as an unreadable base path, whether the cap is enforced at all. Those
   * three are the reaper's self-healing guarantees and each is a silent,
   * green-shipping failure if it regresses — an unremovable file that zeroed
   * every subsequent pass would look exactly like "nothing to reclaim".
   */
  describe("reapStrandedScratchFiles", () => {
    /**
     * DW-722 — one instant for the whole row, so the grace windows below are
     * arithmetic rather than a race with the wall clock.
     *
     * `plantScratch` dates its files from `Date.now()` and the reaper computes
     * `cutoff` from `Date.now()`. Left live, those are two different readings
     * with an unbounded amount of real work between them: a file planted at
     * `NOW - 1_000` against a `5_000` window is "fresh" only while fewer than
     * four seconds elapse before the walk stats it, which under a loaded
     * machine (two `vitest run`s at once) is not something the row controls.
     * Pinning the single call makes elapsed time irrelevant by construction —
     * not by widening a window or a timeout, which would only move the odds.
     *
     * Restored through this handle rather than `vi.restoreAllMocks()`: that
     * would reach past this block and unmock spies the surrounding file owns.
     */
    let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
      const frozen = Date.now();
      nowSpy = vi.spyOn(Date, "now").mockReturnValue(frozen);
    });

    afterEach(() => {
      nowSpy?.mockRestore();
      nowSpy = undefined;
    });

    /** A name matching the provider's `.tmp-<uuid>.tmp` convention. */
    function scratchName(n: number): string {
      return `.tmp-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.tmp`;
    }

    /** A scratch file dated `ageMs` into the past, at `rel` under the base. */
    async function plantScratch(rel: string, ageMs: number): Promise<string> {
      const full = path.join(tmpDir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, "half a payload");
      const when = new Date(Date.now() - ageMs);
      await fs.utimes(full, when, when);
      return full;
    }

    async function exists(target: string): Promise<boolean> {
      try {
        await fs.lstat(target);
        return true;
      } catch {
        return false;
      }
    }

    const AGED = STRANDED_SCRATCH_GRACE_MS * 2;

    it("reclaims aged scratch at any depth and leaves fresh scratch, content and lockfiles alone", async () => {
      const agedRoot = await plantScratch(scratchName(1), AGED);
      const agedNested = await plantScratch(
        path.join("wiki", "deep", scratchName(2)),
        AGED,
      );
      const fresh = await plantScratch(scratchName(3), 1_000);
      const content = path.join(tmpDir, "page.md");
      await fs.writeFile(content, "# real bytes");
      // A NAMING-DRIFT BACKSTOP, not a live hazard: `publicationLockPath`
      // names lockfiles `<sha256-hex>.lock`, which can never match
      // `TMP_ARTIFACT`, so no lockfile the provider writes today is a
      // candidate. The skip is there so that stays true by construction —
      // `.storage-locks/` belongs to the lock mechanism, which has its own
      // staleness rule in `withFilesystemPublicationLock`, and the reaper stays
      // out of it rather than resting on two naming conventions never
      // overlapping. Planting a scratch-NAMED file in there is the only way to
      // observe the directory skip at all.
      const lock = await plantScratch(
        path.join(".storage-locks", scratchName(4)),
        AGED,
      );

      await expect(provider.reapStrandedScratchFiles()).resolves.toBe(2);

      expect(await exists(agedRoot)).toBe(false);
      expect(await exists(agedNested)).toBe(false);
      expect(await exists(fresh)).toBe(true);
      expect(await exists(content)).toBe(true);
      expect(await exists(lock)).toBe(true);
    });

    it("skips a candidate whose stat fails and still reaps and counts the rest", async () => {
      // A dangling symlink wearing a scratch name: `readdir` offers it as a
      // file, `stat` follows it and answers ENOENT. Fail-soft per entry means
      // the pass steps over it rather than reporting 0 for the whole tick.
      const broken = path.join(tmpDir, scratchName(1));
      await fs.symlink(path.join(tmpDir, "nothing-here"), broken);
      const aged = await plantScratch(scratchName(2), AGED);

      await expect(provider.reapStrandedScratchFiles()).resolves.toBe(1);

      expect(await exists(aged)).toBe(false);
      expect(await exists(broken)).toBe(true);
    });

    it.skipIf(process.getuid?.() === 0)(
      "skips a candidate whose rm fails and still reaps and counts the rest",
      async () => {
        // The failure mode this guards: ONE file that cannot be unlinked —
        // a sealed directory, an immutable flag — must not zero out every
        // reclamation the same pass would otherwise have made, forever.
        const sealedDir = path.join(tmpDir, "sealed");
        const sealed = await plantScratch(path.join("sealed", scratchName(1)), AGED);
        const aged = await plantScratch(scratchName(2), AGED);
        await fs.chmod(sealedDir, 0o555);
        try {
          await expect(provider.reapStrandedScratchFiles()).resolves.toBe(1);
          expect(await exists(aged)).toBe(false);
          expect(await exists(sealed)).toBe(true);
        } finally {
          await fs.chmod(sealedDir, 0o755);
        }
      },
    );

    it.skipIf(process.getuid?.() === 0)(
      "skips an unreadable SUBDIRECTORY and still reaps and counts the rest",
      async () => {
        const closedDir = path.join(tmpDir, "closed");
        await plantScratch(path.join("closed", scratchName(1)), AGED);
        const aged = await plantScratch(scratchName(2), AGED);
        await fs.chmod(closedDir, 0o000);
        try {
          await expect(provider.reapStrandedScratchFiles()).resolves.toBe(1);
          expect(await exists(aged)).toBe(false);
        } finally {
          await fs.chmod(closedDir, 0o755);
        }
      },
    );

    it("REJECTS when the base path itself cannot be read", async () => {
      // The asymmetry that makes the per-entry skips safe. One bad entry is a
      // skip; a walk that could not start is not "nothing to reclaim", and
      // answering 0 for it would hide the fault behind a healthy-looking count
      // on every tick from here on. `maintenance.ts` catches and logs it.
      const missing = new FilesystemStorageProvider(
        path.join(tmpDir, "no-such-data-dir"),
      );

      await expect(missing.reapStrandedScratchFiles()).rejects.toThrow();
    });

    it("stops at the candidate cap and reclaims the remainder next pass", async () => {
      // DW-722 — the CAP'S BEHAVIOUR, driven through the reaper's test-only
      // `candidateCap` override rather than by planting
      // `STRANDED_SCRATCH_CANDIDATE_CAP + 3` real files. That population is
      // what turned this row into a duration failure ("Test timed out in
      // 5000ms") whenever the machine was busy — an outcome that had nothing
      // to do with whether the cap works. A small injected cap exercises the
      // identical `considered >= candidateCap` guard on the identical walk.
      //
      // The default is pinned to `STRANDED_SCRATCH_CANDIDATE_CAP` by the row
      // below, so this seam cannot silently become production's bound.
      const cap = 4;
      const overflow = 3;
      // Non-vacuity: an injected cap observes the guard only while it is BELOW
      // the shipped bound. At or above it, the planted population would be what
      // ends the walk and this row would pass with the guard deleted.
      expect(cap).toBeLessThan(STRANDED_SCRATCH_CANDIDATE_CAP);
      for (let i = 0; i < cap + overflow; i++) {
        await plantScratch(scratchName(i), AGED);
      }

      const reap = () =>
        provider.reapStrandedScratchFiles(STRANDED_SCRATCH_GRACE_MS, cap);

      await expect(reap()).resolves.toBe(cap);
      // Removal IS the progress — no cursor is persisted, so the next pass
      // simply starts on what is left.
      await expect(reap()).resolves.toBe(overflow);
      await expect(reap()).resolves.toBe(0);
    });

    /**
     * The parameter list a function DECLARES, as source text — read off the
     * RUNNING function object, never off a file on disk.
     *
     * `Function.prototype.length` cannot serve as this pin: it stops counting
     * at the first default-valued parameter, and every parameter here has a
     * default, so `.length` is 0 whatever the signature says. Reading the
     * declared list catches required, optional AND defaulted parameters alike.
     *
     * `String(fn)` is deliberately the source of truth rather than
     * `filesystem.ts` itself. The file is not what executes: the transform
     * strips the `: number` annotations and joins the parameter list onto one
     * line, so a substring match written against the file's text is a
     * false-failure waiting for a reformat, a moved file, or a dropped
     * annotation — precisely the class of spurious red DW-722 exists to remove.
     * Matching is therefore whitespace- and annotation-tolerant, and keys on
     * the `STRANDED_SCRATCH_CANDIDATE_CAP` IDENTIFIER rather than on `500`, so
     * repointing the default at some other bound fails here.
     *
     * A signature pin that can report "no parameters" for a function it failed
     * to parse is worse than no pin, so this THROWS rather than guessing —
     * `declaredParams` in `wiki-schema-source.test.ts` makes the same choice for
     * the same reason. Two forms would otherwise read as empty: a bound or
     * native function (`[native code]`, no parameter text), and an arrow with
     * one unparenthesized parameter (`async olderThanMs => { … }`), where the
     * first `(...)` in the source belongs to the BODY. This one anchors on the
     * CLASS-METHOD shorthand `reapStrandedScratchFiles` is written in, rather
     * than on the `function` keyword that helper anchors on.
     */
    function declaredParams(fn: (...args: never[]) => unknown): string[] {
      const src = String(fn);
      const declaration = src.includes("[native code]")
        ? null
        : /^(?:async\s+)?(?:function\s*)?\*?\s*[\w$]*\s*\(([^)]*)\)/.exec(src);
      if (!declaration) {
        throw new Error(
          `declaredParams: ${fn.name || "<anonymous>"} is no longer a method or ` +
            `function declaration whose parameter list can be read (source ` +
            `starts: ${src.slice(0, 60)}…). Re-express this pin for the new ` +
            `form — do not let it report an empty parameter list for a ` +
            `signature it could not parse.`,
        );
      }
      return declaration[1]
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
    }

    it("DEFAULTS its cap to STRANDED_SCRATCH_CANDIDATE_CAP, so the override is only a seam", async () => {
      // The row above proves the parameter is WIRED to the guard; this proves
      // it did not also LOWER what production runs with. Pinned at the
      // signature rather than behaviourally: reproducing it through the walk
      // means planting 500-odd files, which is the exact wall-clock cost
      // DW-722 removed. `maintenance.test.ts` pins the other half — that the
      // sole production caller passes no cap at all.
      const params = declaredParams(provider.reapStrandedScratchFiles);

      expect(params).toHaveLength(2);
      // Order matters as much as the value: production calls with NO arguments,
      // so a swapped list would silently reinterpret the window as the cap.
      expect(params[0].replace(/\s+/g, "")).toMatch(
        /^olderThanMs(?::[\w<>[\]|]+)?=STRANDED_SCRATCH_GRACE_MS$/,
      );
      expect(params[1].replace(/\s+/g, "")).toMatch(
        /^candidateCap(?::[\w<>[\]|]+)?=STRANDED_SCRATCH_CANDIDATE_CAP$/,
      );
    });

    it("honours an explicit window, so the grace period is a parameter and not a hardcode", async () => {
      // DW-722 — `1_000` against a `5_000` window is only "fresh" while the
      // clock is frozen (see the describe's `beforeEach`); it used to depend on
      // this row finishing within four real seconds of planting.
      const older = await plantScratch(scratchName(1), 10_000);
      const newer = await plantScratch(scratchName(2), 1_000);

      await expect(provider.reapStrandedScratchFiles(5_000)).resolves.toBe(1);

      expect(await exists(older)).toBe(false);
      expect(await exists(newer)).toBe(true);
    });
  });
});
