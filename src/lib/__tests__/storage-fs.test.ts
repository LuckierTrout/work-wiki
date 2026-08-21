import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BATCH_SYNC_WINDOW, FilesystemStorageProvider } from "../storage/filesystem";

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

  /** The inode of a path — the observable that separates rename from truncate. */
  async function inodeOf(rel: string): Promise<bigint> {
    const st = await fs.stat(path.join(tmpDir, rel), { bigint: true });
    return st.ino;
  }

  /** Scratch files a staged write leaves behind if it does not clean up. */
  async function tmpArtifactsIn(rel: string): Promise<string[]> {
    const entries = await fs.readdir(path.join(tmpDir, rel));
    return entries.filter((name) => /^\.tmp-.*\.tmp$/.test(name));
  }

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
  });

  // -------------------------------------------------------------------------
  // Exact compare-and-set (DW-371)
  // -------------------------------------------------------------------------

  /**
   * The etag used to be `${mtime}-${size}`, which described the file rather than
   * its bytes. Two writers could then both "win": a rewrite of the same byte
   * length inside one millisecond produced an IDENTICAL tag, and `saveConfig`
   * writes a fixed-shape JSON object, so equal length is the ordinary case.
   *
   * These rows stage that collision deliberately — write the replacement, then
   * put the mtime back to what it was — because waiting for two writes to land
   * in one millisecond is a race the suite cannot depend on. Restoring the mtime
   * is not a contrivance around the fix: it is exactly the state the old scheme
   * could not tell apart, reproduced without a timing dependency.
   */
  describe("content-hash etag", () => {
    /** Replace `rel` with equal-length content, leaving mtime and size untouched. */
    async function rewriteInPlaceKeepingMtime(rel: string, content: string): Promise<void> {
      const abs = path.join(tmpDir, rel);
      const before = await fs.stat(abs);
      await provider.writeFile(rel, content);
      const after = await fs.stat(abs);
      expect(after.size).toBe(before.size);
      await fs.utimes(abs, before.atime, before.mtime);
    }

    it("is stable across reads with no write between, and prefixed h1:", async () => {
      await provider.writeFile("etag.txt", "v1");

      const first = await provider.readFileWithEtag("etag.txt");
      const second = await provider.readFileWithEtag("etag.txt");

      expect(first.etag).toBe(second.etag);
      expect(first.etag.startsWith("h1:")).toBe(true);
    });

    it("changes when equal-length content is rewritten within one millisecond", async () => {
      await provider.writeFile("etag.txt", "AAA");
      const before = await provider.readFileWithEtag("etag.txt");
      const statBefore = await fs.stat(path.join(tmpDir, "etag.txt"));

      await rewriteInPlaceKeepingMtime("etag.txt", "BBB");

      const after = await provider.readFileWithEtag("etag.txt");
      const statAfter = await fs.stat(path.join(tmpDir, "etag.txt"));
      // The control: the pair the OLD etag was built from is byte-identical, so
      // an `mtime-size` tag would have called these two files the same version.
      expect(statAfter.mtime.getTime()).toBe(statBefore.mtime.getTime());
      expect(statAfter.size).toBe(statBefore.size);

      expect(after.content).toBe("BBB");
      expect(after.etag).not.toBe(before.etag);
    });

    it("refuses a losing CAS even when the other writer matched length and mtime", async () => {
      await provider.writeFile("cas.txt", "AAA");
      const { etag } = await provider.readFileWithEtag("cas.txt");

      // Another writer gets there first, indistinguishably to the old scheme.
      await rewriteInPlaceKeepingMtime("cas.txt", "BBB");

      expect(await provider.writeFileIfMatch("cas.txt", "CCC", etag)).toBe(false);
      // The other writer's content stands — a refused CAS writes nothing.
      expect(await provider.readFile("cas.txt")).toBe("BBB");
      expect(await tmpArtifactsIn(".")).toEqual([]);
    });

    it("publishes a winning CAS and hands back a tag that matches the new bytes", async () => {
      await provider.writeFile("cas.txt", "v1");
      const { etag } = await provider.readFileWithEtag("cas.txt");

      expect(await provider.writeFileIfMatch("cas.txt", "v2", etag)).toBe(true);

      const after = await provider.readFileWithEtag("cas.txt");
      expect(after.content).toBe("v2");
      expect(after.etag).not.toBe(etag);
      expect(await tmpArtifactsIn(".")).toEqual([]);
    });

    it("creates neither the file nor its parent directory when the path is missing", async () => {
      expect(await provider.writeFileIfMatch("absent/deep/cas.txt", "v1", "h1:whatever")).toBe(
        false,
      );

      // The cheap pre-check is what keeps this true: staging first would have
      // `mkdir -p`'d the parent before discovering there was nothing to replace.
      expect(await provider.fileExists("absent/deep/cas.txt")).toBe(false);
      await expect(fs.stat(path.join(tmpDir, "absent"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Bulk write doors (DW-293)
  // -------------------------------------------------------------------------

  describe("writeBatch", () => {
    it("lands every entry whole, mixing text and binary, with no tmp residue", async () => {
      await provider.writeBatch([
        { path: "batch/a.md", body: "alpha" },
        { path: "batch/nested/b.bin", body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer },
        { path: "batch/c.md", body: "gamma" },
      ]);

      expect(await provider.readFile("batch/a.md")).toBe("alpha");
      expect(Buffer.from(await provider.readAsset("batch/nested/b.bin"))).toEqual(
        Buffer.from([1, 2, 3]),
      );
      expect(await provider.readFile("batch/c.md")).toBe("gamma");
      expect(await tmpArtifactsIn("batch")).toEqual([]);
      expect(await tmpArtifactsIn("batch/nested")).toEqual([]);
    });

    it("replaces each destination by rename, exactly as the single-file door does", async () => {
      await provider.writeFile("batch/a.md", "old");
      const before = await inodeOf("batch/a.md");

      await provider.writeBatch([{ path: "batch/a.md", body: "new" }]);

      expect(await provider.readFile("batch/a.md")).toBe("new");
      expect(await inodeOf("batch/a.md")).not.toBe(before);
    });

    it("cleans up the whole window when one entry cannot be published", async () => {
      // A directory is a destination `rename` can never replace, so this entry
      // faults at the LAST step — after every entry in the window is staged.
      await provider.writeFile("blocked/child.md", "keep me");

      await expect(
        provider.writeBatch([
          { path: "ok-before.md", body: "before" },
          { path: "blocked", body: "nope" },
          { path: "ok-after.md", body: "after" },
        ]),
      ).rejects.toThrow();

      // Not a transaction, and the interface says so: the entries that were
      // already published stay published.
      expect(await provider.readFile("ok-before.md")).toBe("before");
      expect(await provider.readFile("ok-after.md")).toBe("after");
      // The blocked destination is untouched, and nothing scratch survives.
      expect(await provider.readFile("blocked/child.md")).toBe("keep me");
      expect(await tmpArtifactsIn(".")).toEqual([]);
      expect(await tmpArtifactsIn("blocked")).toEqual([]);
    });

    it("rejects duplicate paths before writing anything", async () => {
      await expect(
        provider.writeBatch([
          { path: "dupe/a.md", body: "first" },
          { path: "dupe/b.md", body: "other" },
          { path: "dupe/a.md", body: "second" },
        ]),
      ).rejects.toThrow(/dupe\/a\.md/);

      // "Before writing anything" is the part worth pinning: the refusal must
      // not leave half the batch on disk.
      expect(await provider.fileExists("dupe/a.md")).toBe(false);
      expect(await provider.fileExists("dupe/b.md")).toBe(false);
      expect(await provider.listFiles("dupe")).toEqual([]);
    });

    it("catches a duplicate that only two different spellings of one path share", async () => {
      await expect(
        provider.writeBatch([
          { path: "same/a.md", body: "first" },
          { path: "./same/a.md", body: "second" },
        ]),
      ).rejects.toThrow(/same\/a\.md/);
    });

    it("rejects an entry whose path is a directory prefix of another's", async () => {
      // `a` has to be a file for one entry and a directory for the other, and
      // the window stages both concurrently — so which one fails is a race
      // rather than an answer, and the pair is refused instead.
      await expect(
        provider.writeBatch([
          { path: "nest/a", body: "file" },
          { path: "nest/a/b.md", body: "child" },
        ]),
      ).rejects.toThrow(/directory prefix/);

      // …in either listed order: the ancestor may come second.
      await expect(
        provider.writeBatch([
          { path: "nest/a/b.md", body: "child" },
          { path: "nest/a", body: "file" },
        ]),
      ).rejects.toThrow(/directory prefix/);

      expect(await provider.listFiles("nest")).toEqual([]);
    });

    it("writes nothing and syncs nothing for an empty batch", async () => {
      await provider.writeBatch([]);
      expect(await provider.listFiles(".")).toEqual([]);
    });

    it("preserves the mode of an overwritten destination", async () => {
      // The batch door stages through its own helper rather than through
      // `atomicWrite`, so the mode carry-over the single-file rows pin is a
      // SECOND implementation and needs its own row.
      await provider.writeFile("secret.md", "v1");
      await fs.chmod(path.join(tmpDir, "secret.md"), 0o600);

      await provider.writeBatch([{ path: "secret.md", body: "v2" }]);

      const st = await fs.stat(path.join(tmpDir, "secret.md"));
      expect(st.mode & 0o777).toBe(0o600);
      expect(await provider.readFile("secret.md")).toBe("v2");
    });

    it("gives a new batched file the same default mode a plain write would", async () => {
      await provider.writeBatch([{ path: "plain.md", body: "batched" }]);
      await fs.writeFile(path.join(tmpDir, "control.md"), "control", "utf-8");

      const [written, control] = await Promise.all([
        fs.stat(path.join(tmpDir, "plain.md")),
        fs.stat(path.join(tmpDir, "control.md")),
      ]);
      expect(written.mode & 0o777).toBe(control.mode & 0o777);
    });

    it("spans more than one sync window without losing entries", async () => {
      // Derived from the provider's own window so raising it cannot make this
      // row stop crossing a boundary — the seam where a mis-sliced chunk would
      // silently drop or duplicate entries.
      const count = BATCH_SYNC_WINDOW * 2;
      const entries = Array.from({ length: count }, (_, i) => ({
        path: `wide/f-${i}.md`,
        body: `body-${i}`,
      }));

      await provider.writeBatch(entries);

      const names = (await provider.listFiles("wide")).map((e) => e.name);
      expect(names).toHaveLength(count);
      expect(await provider.readFile("wide/f-0.md")).toBe("body-0");
      expect(await provider.readFile(`wide/f-${count - 1}.md`)).toBe(
        `body-${count - 1}`,
      );
      expect(await tmpArtifactsIn("wide")).toEqual([]);
    });
  });

  describe("upsertEmbeddings", () => {
    it("replaces stored ids in place, appends new ones, and lets the later entry win", async () => {
      await provider.upsertEmbedding("a", [1, 0], { v: "old-a" });
      await provider.upsertEmbedding("b", [0, 1], { v: "old-b" });

      await provider.upsertEmbeddings([
        { id: "b", vector: [0, 2], metadata: { v: "new-b" } },
        { id: "c", vector: [1, 1], metadata: { v: "new-c" } },
        // Same id twice in one flush: one stored entry, holding the last value.
        { id: "c", vector: [2, 2], metadata: { v: "last-c" } },
      ]);

      expect(await provider.getEmbeddingById("a")).toEqual({
        id: "a",
        vector: [1, 0],
        metadata: { v: "old-a" },
      });
      expect(await provider.getEmbeddingById("b")).toEqual({
        id: "b",
        vector: [0, 2],
        metadata: { v: "new-b" },
      });
      expect(await provider.getEmbeddingById("c")).toEqual({
        id: "c",
        vector: [2, 2],
        metadata: { v: "last-c" },
      });
      // Three ids, not four — a repeated id must not append a second copy.
      expect(await provider.queryEmbeddings([1, 1], 10)).toHaveLength(3);
    });

    it("writes nothing for an empty flush", async () => {
      await provider.upsertEmbeddings([]);
      expect(await provider.getIndex("embeddings")).toBeNull();
    });

    it("replaces the embeddings blob by rename", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      const before = await inodeOf(".indexes/embeddings.json");

      await provider.upsertEmbeddings([{ id: "b", vector: [0, 1], metadata: {} }]);

      expect(await inodeOf(".indexes/embeddings.json")).not.toBe(before);
      expect(await tmpArtifactsIn(".indexes")).toEqual([]);
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
      const results = await provider.queryEmbeddings([1, 0], 3);
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

      const results = await provider.queryEmbeddings([1, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a");
    });

    it("updates existing embedding on upsert", async () => {
      await provider.upsertEmbedding("a", [1, 0], { v: "1" });
      await provider.upsertEmbedding("a", [0, 1], { v: "2" });

      const results = await provider.queryEmbeddings([0, 1], 1);
      expect(results[0].id).toBe("a");
      expect(results[0].metadata.v).toBe("2");
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it("returns empty array when no embeddings exist", async () => {
      const results = await provider.queryEmbeddings([1, 0], 5);
      expect(results).toEqual([]);
    });
  });

  describe("removeEmbedding", () => {
    it("removes an embedding by id", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      await provider.upsertEmbedding("b", [0, 1], {});

      await provider.removeEmbedding("a");
      const results = await provider.queryEmbeddings([1, 0], 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("b");
    });

    it("is a no-op for non-existent id", async () => {
      await provider.upsertEmbedding("a", [1, 0], {});
      await provider.removeEmbedding("nonexistent");
      const results = await provider.queryEmbeddings([1, 0], 10);
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
    // `inodeOf` / `tmpArtifactsIn` live at the suite level: the bulk-write rows
    // above pin the same two observables, and one definition keeps them meaning
    // the same thing in both places.

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

    /**
     * The fsync has NO in-process observable: remove `handle.sync()` and every
     * other row here still passes, because within one process the page cache
     * serves the same bytes either way. What it buys is crash behaviour, which
     * a unit test cannot stage — so it is pinned STRUCTURALLY instead, the way
     * `wiki-schema-edit.test.ts` pins route shape.
     *
     * Ordering is the whole point, not presence: syncing AFTER the rename would
     * publish the name before the bytes are durable, which is the exact bug the
     * sync exists to prevent.
     */
    it("fsyncs the tmp file BEFORE the rename publishes it", async () => {
      const source = await fs.readFile(
        path.resolve(__dirname, "../storage/filesystem.ts"),
        "utf8",
      );
      // Comments stripped first: this docblock and `atomicWrite`'s both discuss
      // `sync()` and the rename in prose, and a substring scan would otherwise
      // be satisfied by the explanation rather than by the code it explains.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const body = code.slice(
        code.indexOf("private async atomicWrite("),
        code.indexOf("async readFile("),
      );
      expect(body).not.toBe("");

      const sync = body.indexOf("handle.sync()");
      const rename = body.indexOf("fs.rename(tmp, absPath)");
      expect(sync).toBeGreaterThan(-1);
      expect(rename).toBeGreaterThan(-1);
      expect(sync).toBeLessThan(rename);
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
});
