import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { serializeFrontmatter } from "../frontmatter";
import { buildPortableArchive, importPortableArchive, inspectPortableArchive } from "../portable-archive";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { _resetStorage, getStorage } from "../storage";
import { listWikiPages, updateIndex, writeWikiPage } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "portable-archive-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
});

afterEach(async () => {
  // Restored HERE, not at the end of a test body: a spy installed on the
  // `getStorage()` singleton and restored only on the success path stays
  // installed for every later case in this file the moment one assertion fails.
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("portable owner archive", () => {
  it("round-trips tenant files with checksums and rebuilds compatibility paths", async () => {
    const page = serializeFrontmatter({ owner: "alice", visibility: "private", authors: ["alice"] }, "# Atlas\n\nPrivate knowledge.");
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeAsset("tenants/alice/raw/atlas/source.bin", new Uint8Array([1, 2, 3]).buffer);
    const archive = await buildPortableArchive("alice");
    expect(archive.manifest.format).toBe("workwiki-portable-archive");
    const tenantFiles = archive.manifest.files.filter((entry) => !entry.path.startsWith(".obsidian/"));
    expect(tenantFiles).toHaveLength(2);
    expect(archive.manifest.files.some((entry) => entry.path === ".obsidian/app.json")).toBe(true);
    expect((await inspectPortableArchive("alice", buffer(archive.bytes))).collisions).toHaveLength(2);

    await getStorage().deleteDirectory("tenants/alice");
    const preview = await inspectPortableArchive("alice", buffer(archive.bytes));
    expect(preview.newFiles.length).toBeGreaterThanOrEqual(2);
    const result = await importPortableArchive("alice", buffer(archive.bytes), "skip");
    expect(result.imported).toBe(archive.manifest.files.length);
    expect(result.skipped).toBe(0);
    expect(await getStorage().readFile("tenants/alice/wiki/atlas.md")).toBe(page);
    expect(await getStorage().readFile("wiki/atlas.md")).toBe(page);
  });

  it("generates .obsidian/ and keeps the frozen format string", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nPrivate knowledge.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeFile("tenants/alice/action-items.json", "[]");
    await getStorage().writeFile("tenants/alice/chat-conversations.json", "[]");
    await getStorage().writeFile("tenants/alice/todos.json", '{"items":[]}');
    await getStorage().writeFile("tenants/alice/research-projects.json", "[]");
    const archive = await buildPortableArchive("alice");
    expect(archive.manifest.format).toBe("workwiki-portable-archive");
    const names = archive.manifest.files.map((entry) => entry.path);
    expect(names).toContain(".obsidian/app.json");
    expect(names).toContain(".obsidian/appearance.json");
    expect(names).toContain(".obsidian/core-plugins.json");
    expect(names).toContain("action-items.json");
    expect(names).toContain("chat-conversations.json");
    expect(names).toContain("todos.json");
    expect(names).toContain("research-projects.json");
    expect(names.every((name) => !name.includes("todos.md"))).toBe(true);
  });

  it("excludes rebuilt and append-only wiki infrastructure from exports", async () => {
    await getStorage().writeFile("tenants/alice/wiki/index.md", "# Index\n");
    await getStorage().writeFile("tenants/alice/wiki/log.md", "audit\n");

    const archive = await buildPortableArchive("alice");
    const names = archive.manifest.files.map((entry) => entry.path);

    expect(names).not.toContain("wiki/index.md");
    expect(names).not.toContain("wiki/log.md");
  });

  it.each(["wiki/index.md", "wiki/log.md"])(
    "accepts legacy v1 infrastructure %s but leaves it untouched",
    async (infrastructurePath) => {
      await getStorage().writeFile("tenants/alice/settings.json", "{}");
      const archive = await buildPortableArchive("alice");
      const files = unzipSync(archive.bytes);
      const bytes = strToU8("attacker-controlled infrastructure\n");
      const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
      manifest.files.push({
        path: infrastructurePath,
        size: bytes.byteLength,
        sha256: await digest(buffer(bytes)),
      });
      files[`files/${infrastructurePath}`] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
      await getStorage().writeFile(`tenants/alice/${infrastructurePath}`, "tenant sentinel\n");
      await getStorage().writeFile(infrastructurePath, "global sentinel\n");

      const restored = await importPortableArchive("alice", buffer(zipSync(files)), "overwrite");

      expect(restored.skipped).toBeGreaterThanOrEqual(1);
      expect(await getStorage().readFile(`tenants/alice/${infrastructurePath}`))
        .toBe("tenant sentinel\n");
      const globalInfrastructure = await getStorage().readFile(infrastructurePath);
      expect(globalInfrastructure).not.toBe("attacker-controlled infrastructure\n");
      if (infrastructurePath === "wiki/log.md") {
        expect(globalInfrastructure).toBe("global sentinel\n");
      } else {
        expect(globalInfrastructure).toContain("# Wiki Index");
      }
    },
  );

  it("refuses to restore an archive into another owner tenant", async () => {
    await getStorage().writeFile("tenants/alice/settings.json", "{}");
    const archive = await buildPortableArchive("alice");
    await expect(inspectPortableArchive("bob", buffer(archive.bytes))).rejects.toThrow(/different owner/i);
  });

  it("round-trips a nested queries Page through ownership checks and index rebuild", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Saved answer\n\nPrivate answer.",
    );
    await getStorage().writeFile("tenants/alice/wiki/queries/saved-answer.md", page);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");

    await importPortableArchive("alice", buffer(archive.bytes), "overwrite");

    expect(await getStorage().readFile("tenants/alice/wiki/queries/saved-answer.md")).toBe(page);
    expect(await getStorage().readFile("wiki/queries/saved-answer.md")).toBe(page);
    expect(await listWikiPages({ strict: true })).toContainEqual(
      expect.objectContaining({ slug: "queries/saved-answer", owner: "alice" }),
    );
  });

  it("rejects foreign-owner Page bytes before mutating either storage path", async () => {
    const foreign = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Foreign\n\nBob.",
    );
    await getStorage().writeFile("tenants/alice/wiki/queries/foreign.md", foreign);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");

    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/owner.*archive tenant/i);
    await expect(getStorage().fileExists("tenants/alice/wiki/queries/foreign.md"))
      .resolves.toBe(false);
    await expect(getStorage().fileExists("wiki/queries/foreign.md"))
      .resolves.toBe(false);
  });

  it("refuses a nested queries Page already owned by another tenant", async () => {
    const alice = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Saved answer\n\nAlice.",
    );
    await getStorage().writeFile("tenants/alice/wiki/queries/saved-answer.md", alice);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");
    const bob = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Saved answer\n\nBob.",
    );
    await writeWikiPage("queries/saved-answer", bob);
    await updateIndex([{ slug: "queries/saved-answer", title: "Saved answer", summary: "Bob", owner: "bob" }]);

    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/another owner/i);
  });

  it("refuses an unindexed flat Page owned by another tenant", async () => {
    const alice = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Atlas\n\nAlice.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", alice);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");
    const bob = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Atlas\n\nBob's unindexed bytes.",
    );
    await writeWikiPage("atlas", bob);
    await updateIndex([]);

    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/another owner/i);
    expect(await getStorage().readFile("wiki/atlas.md")).toBe(bob);
  });

  it("preflights every Page before writing when a later canonical-only slug conflicts", async () => {
    const safe = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# A safe Page\n\nAlice.",
    );
    const conflict = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Z conflict\n\nAlice.",
    );
    await getStorage().writeFile("tenants/alice/wiki/a-safe.md", safe);
    await getStorage().writeFile("tenants/alice/wiki/z-conflict.md", conflict);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");
    const bob = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Z conflict\n\nBob's canonical-only Page.",
    );
    await getStorage().writeFile("tenants/bob/wiki/z-conflict.md", bob);

    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/another owner/i);
    await expect(getStorage().fileExists("tenants/alice/wiki/a-safe.md")).resolves.toBe(false);
    await expect(getStorage().fileExists("wiki/a-safe.md")).resolves.toBe(false);
    expect(await getStorage().readFile("tenants/bob/wiki/z-conflict.md")).toBe(bob);
  });

  it("holds the merge fence while a skip import acquires its collision snapshot", async () => {
    const archived = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Atlas\n\nArchived bytes.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", archived);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");
    const newer = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Atlas\n\nNewly committed bytes.",
    );
    const storage = getStorage();
    // The seam is the COLLISION PROBE, whichever call makes it. It used to be a
    // `readAsset`; DW-679 made it the `stat` it always should have been (the
    // probe asks "is this path occupied", not "what is in it"). Nothing about
    // what this test pins moved — the fence still has to be held from the
    // moment the snapshot is taken until the import is done with it.
    const originalStat = storage.stat.bind(storage);
    let observedMissingSnapshot!: () => void;
    let resumeSnapshot!: () => void;
    const snapshotObserved = new Promise<void>((resolve) => { observedMissingSnapshot = resolve; });
    const resume = new Promise<void>((resolve) => { resumeSnapshot = resolve; });
    let pauseOnce = true;
    vi.spyOn(storage, "stat").mockImplementation(async (target) => {
      try {
        return await originalStat(target);
      } catch (error) {
        if (
          pauseOnce
          && target === "tenants/alice/wiki/atlas.md"
          && error instanceof Error
          && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          pauseOnce = false;
          observedMissingSnapshot();
          await resume;
        }
        throw error;
      }
    });

    const importing = importPortableArchive("alice", buffer(archive.bytes), "skip");
    await snapshotObserved;
    let published = false;
    const writing = writeWikiPageWithSideEffects({
      slug: "atlas",
      title: "Atlas",
      content: newer,
      summary: "Newly committed bytes.",
      logOp: "edit",
      crossRefSource: null,
      author: "alice",
    }).then(() => { published = true; });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(published).toBe(false);
    resumeSnapshot();
    const result = await importing;
    await writing;

    expect(result.imported).toBeGreaterThanOrEqual(1);
    expect(await getStorage().readFile("tenants/alice/wiki/atlas.md")).toBe(newer);
  }, 15_000);

  // ---------------------------------------------------------------------------
  // DW-679 — bound before read
  // ---------------------------------------------------------------------------

  it("rejects past the 500 MB ceiling WITHOUT reading the file that trips it", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nSmall on disk.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    const storage = getStorage();
    const originalStat = storage.stat.bind(storage);
    vi.spyOn(storage, "stat").mockImplementation(async (target) => (
      target === "tenants/alice/wiki/atlas.md"
        ? { size: 600 * 1024 * 1024, lastModified: new Date(), isDirectory: false }
        : originalStat(target)
    ));
    // The proof: the read that used to materialise this object now never
    // happens, so making it throw cannot change the answer.
    const readAsset = vi.spyOn(storage, "readAsset").mockImplementation(async (target) => {
      throw new Error(`readAsset must not be called for ${target}`);
    });

    await expect(buildPortableArchive("alice"))
      .rejects.toThrow(/500 MB safety limit/);
    // The ceiling error, not the read's.
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("still rejects past the ceiling when stat UNDER-reports", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nSmall on disk.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    const storage = getStorage();
    const originalStat = storage.stat.bind(storage);
    // stat says zero; the bytes say 600 MB. The post-read check owns the
    // invariant, so the gate being wrong cannot let an oversized archive
    // through — `stat` gates, it never accounts.
    vi.spyOn(storage, "stat").mockImplementation(async (target) => (
      target === "tenants/alice/wiki/atlas.md"
        ? { size: 0, lastModified: new Date(), isDirectory: false }
        : originalStat(target)
    ));
    vi.spyOn(storage, "readAsset").mockImplementation(async (target) => (
      target === "tenants/alice/wiki/atlas.md"
        // Only `byteLength` is read before the ceiling test fires.
        ? ({ byteLength: 600 * 1024 * 1024 } as ArrayBuffer)
        : new ArrayBuffer(0)
    ));

    await expect(buildPortableArchive("alice"))
      .rejects.toThrow(/500 MB safety limit/);
  });

  it("probes for collisions with stat, never by reading the existing file", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nPrivate knowledge.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeAsset("tenants/alice/raw/atlas/source.bin", new Uint8Array([1, 2, 3]).buffer);
    const archive = await buildPortableArchive("alice");

    const storage = getStorage();
    const probed: string[] = [];
    const originalStat = storage.stat.bind(storage);
    vi.spyOn(storage, "stat").mockImplementation(async (target) => {
      probed.push(target);
      return originalStat(target);
    });
    const readAsset = vi.spyOn(storage, "readAsset");

    const inspection = await inspectPortableArchive("alice", buffer(archive.bytes));

    // Both tenant files are occupied, so both are collisions…
    expect(inspection.collisions).toContain("wiki/atlas.md");
    expect(inspection.collisions).toContain("raw/atlas/source.bin");
    // …and the `.obsidian/` stubs are not.
    expect(inspection.newFiles).toContain(".obsidian/app.json");
    // Every manifest entry was probed by `stat`…
    expect(probed).toContain("tenants/alice/wiki/atlas.md");
    expect(probed).toContain("tenants/alice/.obsidian/app.json");
    // …and nothing in the inspection pulled an existing object's bytes.
    expect(readAsset).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // DW-701 — a tenant path blocked by a DIRECTORY is not an ordinary collision
  // ---------------------------------------------------------------------------

  /**
   * The `readAsset` → `stat` swap (DW-679) changed what a directory answers:
   * `readAsset` raised EISDIR and failed the archive, `stat` succeeds. Without
   * the `isDirectory` check the entry became a plain collision — silently
   * SKIPPED under `collision: "skip"` — so an entry that can never be written
   * looked imported-and-fine. It has to fail loudly, and name the path.
   */
  it("rejects an archive whose tenant path is occupied by a DIRECTORY", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nPrivate knowledge.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeAsset("tenants/alice/raw/atlas/source.bin", new Uint8Array([1, 2, 3]).buffer);
    const archive = await buildPortableArchive("alice");

    // While it is still a FILE, it is an ordinary collision.
    expect((await inspectPortableArchive("alice", buffer(archive.bytes))).collisions)
      .toContain("raw/atlas/source.bin");

    // Swap the file for a directory at the same path.
    const blocked = path.join(tmpDir, "tenants", "alice", "raw", "atlas", "source.bin");
    await fs.rm(blocked);
    await fs.mkdir(blocked, { recursive: true });

    // A sentinel the archive does NOT contain, at a path the archive DOES
    // carry: asserting `page` survives would prove nothing, since `page` is
    // what the archive holds anyway. It keeps alice's frontmatter on purpose —
    // a bare body has no `owner`, which trips the import's ownership pre-check
    // and would abort the import for an unrelated reason, masking exactly the
    // regression this case exists to catch.
    const sentinel = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nEdited after the archive was built.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", sentinel);

    // `withBatchedWrites` (portable-archive.ts:336) is the ONLY write scope the
    // import opens. Spying it is what actually pins "refused BEFORE any write":
    // the sentinel alone is not discriminating, because without the directory
    // rule the import still dies — later — when `batch.writeAsset` hits the
    // directory, which can leave the sentinel intact by accident of ordering.
    const storage = getStorage();
    const batched = vi.spyOn(storage, "withBatchedWrites");

    // Inspection fails, naming the path…
    await expect(inspectPortableArchive("alice", buffer(archive.bytes)))
      .rejects.toThrow(/raw\/atlas\/source\.bin/);
    // …and so does the import, under BOTH collision policies.
    await expect(importPortableArchive("alice", buffer(archive.bytes), "skip"))
      .rejects.toThrow(/raw\/atlas\/source\.bin/);
    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/raw\/atlas\/source\.bin/);

    // The refusal happened in the probe: no write scope was ever opened, so
    // even the entry that WOULD have imported cleanly was never touched.
    expect(batched).not.toHaveBeenCalled();
    expect(await getStorage().readFile("tenants/alice/wiki/atlas.md")).toBe(sentinel);
  });

  // ---------------------------------------------------------------------------
  // DW-745 — an ANCESTOR segment that is a file leaks the host path
  // ---------------------------------------------------------------------------

  /**
   * The sibling of the directory case, one segment up. `stat` walks the WHOLE
   * path, so a regular file at `raw/atlas` makes `raw/atlas/source.bin` raise
   * ENOTDIR rather than the ENOENT the probe reads as "new file" — and the
   * probe's catch rethrew anything that was not ENOENT untouched.
   *
   * What it rethrew was the storage layer's own error, and
   * `FilesystemStorage.stat` builds its path with `this.resolve(filePath)`. So
   * `/api/archive/import`'s catch, which echoes `getErrorMessage(error)` into
   * the 500 body, handed the caller an ABSOLUTE server filesystem path — the
   * data directory's real location on the host — over an errno they could do
   * nothing with. The situation is the directory case's exactly: no write this
   * import can make will ever land at that path, so it is the same loud
   * refusal, in the archive's own vocabulary.
   */
  it("rejects an archive whose tenant path has a FILE for an ancestor, naming no host path", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nPrivate knowledge.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeAsset("tenants/alice/raw/atlas/source.bin", new Uint8Array([1, 2, 3]).buffer);
    const archive = await buildPortableArchive("alice");

    // While `raw/atlas` is still a DIRECTORY, the entry is an ordinary collision.
    expect((await inspectPortableArchive("alice", buffer(archive.bytes))).collisions)
      .toContain("raw/atlas/source.bin");

    // Collapse the folder into a regular FILE at the same path, so the entry's
    // ancestor — not the entry itself — is what blocks it.
    const ancestor = path.join(tmpDir, "tenants", "alice", "raw", "atlas");
    await fs.rm(ancestor, { recursive: true });
    await fs.writeFile(ancestor, "not a folder");

    // The same sentinel discipline as the directory case: a body the archive
    // does NOT carry, at a path it DOES, keeping alice's frontmatter so the
    // import's ownership pre-check cannot abort for an unrelated reason.
    const sentinel = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nEdited after the archive was built.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", sentinel);

    const storage = getStorage();
    const batched = vi.spyOn(storage, "withBatchedWrites");

    // Inspection and both import policies refuse, each naming the ARCHIVE-relative
    // entry path…
    for (const attempt of [
      () => inspectPortableArchive("alice", buffer(archive.bytes)),
      () => importPortableArchive("alice", buffer(archive.bytes), "skip"),
      () => importPortableArchive("alice", buffer(archive.bytes), "overwrite"),
    ]) {
      const error = await attempt().then(
        () => { throw new Error("expected a refusal"); },
        (caught: unknown) => caught as Error,
      );
      expect(error.message).toContain("raw/atlas/source.bin");
      // …and NOTHING of the host. These three are the leak itself: the errno,
      // the absolute data directory, and the tenant key the caller never named.
      expect(error.message).not.toContain("ENOTDIR");
      expect(error.message).not.toContain(tmpDir);
      expect(error.message).not.toContain("tenants/alice");
      // The errno is not lost — it rides as `cause` for the server log, which
      // is the same bargain the artifact wraps make.
      expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe("ENOTDIR");
    }

    // Refused in the PROBE: no write scope was ever opened, so even the entry
    // that would have imported cleanly was never touched.
    expect(batched).not.toHaveBeenCalled();
    expect(await getStorage().readFile("tenants/alice/wiki/atlas.md")).toBe(sentinel);
  });

  it("rejects an oversized manifest before allocating its expanded payload", async () => {
    const oversized = zipSync({
      "manifest.json": new Uint8Array(5 * 1024 * 1024 + 1),
    }, { level: 9 });

    await expect(inspectPortableArchive("alice", buffer(oversized)))
      .rejects.toThrow(/manifest exceeds the safety limit/i);
  });
});

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function digest(value: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
