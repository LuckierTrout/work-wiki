import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  saveRawSource,
  saveRawSourceFor,
  saveRawSourceBytes,
  saveRawSourceTree,
  listRawSources,
  listRawSourceSnapshots,
  readRawSource,
  readRawSourceById,
  readRawSourceBytes,
  rawSourceRelPath,
  tenantRawSourceRelPath,
  isRawSnapshotName,
} from "../raw";
import { ensureDirectories, tenantForOwner } from "../wiki";
import { getDataDir } from "../paths";
import { readDataVersion } from "../data-version";
import { getStorage } from "../storage";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// saveRawSource
// ---------------------------------------------------------------------------

describe("saveRawSource", () => {
  it("writes a file to raw/sources/<id>.md and returns the path", async () => {
    const content = "# My Source\n\nSome raw content.";
    const filePath = await saveRawSource("my-source", content);

    // Story 2.1: Source bytes live under `raw/sources/`, which is the address
    // the Workbench's silo-only raw resolve (DW-40) is built around. The flat
    // `raw/<id>.md` this used to write is never produced again.
    expect(filePath).toBe(path.join(tmpDir, "raw", "sources", "my-source.md"));
    await expect(fs.stat(path.join(tmpDir, "raw", "my-source.md"))).rejects.toThrow();

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe(content);
  });

  it("creates the raw directory if it doesn't exist", async () => {
    // raw/ should not exist yet
    await expect(
      fs.stat(path.join(tmpDir, "raw")),
    ).rejects.toThrow();

    await saveRawSource("first-source", "hello");

    const stat = await fs.stat(path.join(tmpDir, "raw"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("throws on path traversal slug", async () => {
    await expect(
      saveRawSource("../../etc/passwd", "malicious"),
    ).rejects.toThrow(/Invalid slug/);
  });

  it("throws on empty slug", async () => {
    await expect(saveRawSource("", "content")).rejects.toThrow(
      /Invalid slug/,
    );
  });

  it("throws on slug with slashes", async () => {
    await expect(
      saveRawSource("foo/bar", "content"),
    ).rejects.toThrow(/Invalid slug/);
  });

  it("leaves stored bytes alone when the same id arrives again (FR-2)", async () => {
    // This case used to assert the OPPOSITE — "overwrites an existing file with
    // the same id" — and that was the defect Story 2.1 fixes: a Source is
    // immutable once saved, so a later arrival on an occupied key must not
    // rewrite it. Distinct arrivals get distinct keys through
    // `saveRawSourceFor`'s content hash, so nothing is lost by refusing here.
    await saveRawSource("overwrite-me", "v1");
    await saveRawSource("overwrite-me", "v2");

    const filePath = path.join(tmpDir, "raw", "sources", "overwrite-me.md");
    expect(await fs.readFile(filePath, "utf-8")).toBe("v1");
  });

  it("returns the path either way, so a re-arrival is not an error", async () => {
    // `ingest` calls this on EVERY ingest of a slug, so the skip has to be
    // silent: throwing would turn a second ingest of the same page into a
    // failure, which is why immutability is enforced by declining the write
    // rather than by rejecting.
    const first = await saveRawSource("idempotent", "one");
    const second = await saveRawSource("idempotent", "two");
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// listRawSources
// ---------------------------------------------------------------------------

describe("listRawSources", () => {
  it("returns an empty array when raw/ doesn't exist", async () => {
    const result = await listRawSources();
    expect(result).toEqual([]);
  });

  it("lists files with correct slug, filename, size, and modified", async () => {
    await saveRawSource("alpha", "Alpha content");

    const sources = await listRawSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].slug).toBe("alpha");
    expect(sources[0].filename).toBe("alpha.md");
    expect(sources[0].size).toBe(Buffer.byteLength("Alpha content"));
    expect(sources[0].modified).toBeDefined();
    // modified should be a valid ISO 8601 string
    expect(new Date(sources[0].modified).toISOString()).toBe(
      sources[0].modified,
    );
  });

  it("strips extension to produce slug", async () => {
    // saveRawSource always writes .md, so the slug should have .md stripped
    await saveRawSource("my-notes", "notes content");

    const sources = await listRawSources();
    expect(sources[0].slug).toBe("my-notes");
    expect(sources[0].filename).toBe("my-notes.md");
  });

  it("sorts newest first by modified time", async () => {
    await saveRawSource("older", "old content");

    // Introduce a small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));

    await saveRawSource("newer", "new content");

    const sources = await listRawSources();
    expect(sources).toHaveLength(2);
    expect(sources[0].slug).toBe("newer");
    expect(sources[1].slug).toBe("older");
  });

  it("skips dotfiles", async () => {
    await ensureDirectories();
    const rawDir = path.join(tmpDir, "raw");

    // Write a dotfile directly (saveRawSource would reject the slug)
    await fs.writeFile(path.join(rawDir, ".hidden"), "secret");
    await saveRawSource("visible", "content");

    const sources = await listRawSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].slug).toBe("visible");
  });

  it("skips subdirectories", async () => {
    await ensureDirectories();
    const rawDir = path.join(tmpDir, "raw");

    // Create a subdirectory inside raw/
    await fs.mkdir(path.join(rawDir, "subdir"));
    await saveRawSource("file-source", "content");

    const sources = await listRawSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].slug).toBe("file-source");
  });

  it("handles multiple files correctly", async () => {
    await saveRawSource("aaa", "content a");
    await saveRawSource("bbb", "content b");
    await saveRawSource("ccc", "content c");

    const sources = await listRawSources();
    expect(sources).toHaveLength(3);
    // All slugs should be present
    const slugs = sources.map((s) => s.slug);
    expect(slugs).toContain("aaa");
    expect(slugs).toContain("bbb");
    expect(slugs).toContain("ccc");
  });
});

// ---------------------------------------------------------------------------
// readRawSource
// ---------------------------------------------------------------------------

describe("readRawSource", () => {
  it("reads content and metadata for a valid slug", async () => {
    const content = "# Hello\n\nWorld.";
    await saveRawSource("read-me", content);

    const source = await readRawSource("read-me");
    expect(source.slug).toBe("read-me");
    expect(source.filename).toBe("read-me.md");
    expect(source.content).toBe(content);
    expect(source.size).toBe(Buffer.byteLength(content));
    expect(source.modified).toBeDefined();
  });

  it("throws on invalid slug (path traversal)", async () => {
    await expect(
      readRawSource("../../etc/passwd"),
    ).rejects.toThrow(/Invalid slug/);
  });

  it("throws on empty slug", async () => {
    await expect(readRawSource("")).rejects.toThrow(/Invalid slug/);
  });

  it("throws when slug doesn't match any file", async () => {
    await ensureDirectories();

    await expect(readRawSource("nonexistent")).rejects.toThrow(
      /raw source not found/,
    );
  });

  it("keeps the FIRST content after a second arrival on the same id", async () => {
    // The read half of the immutability case above: what a reader gets back is
    // the bytes that were stored first, not the ones that arrived later.
    await saveRawSource("mutable", "version 1");
    await saveRawSource("mutable", "version 2");

    const source = await readRawSource("mutable");
    expect(source.content).toBe("version 1");
  });

  it("still reads a legacy flat raw/<slug>.md written before the move", async () => {
    // A workspace ingested before Sources moved under `raw/sources/` must keep
    // answering: the new location is tried first and the flat one second.
    await ensureDirectories();
    await fs.writeFile(path.join(tmpDir, "raw", "legacy.md"), "old bytes");

    const source = await readRawSource("legacy");
    expect(source.content).toBe("old bytes");
    expect((await listRawSources()).map((s) => s.slug)).toContain("legacy");
  });
});

// ---------------------------------------------------------------------------
// saveRawSourceFor / readRawSourceById (per-source snapshots)
// ---------------------------------------------------------------------------

describe("per-source raw snapshots", () => {
  it("round-trips a per-source snapshot at raw/<slug>/<rawId>.md", async () => {
    await ensureDirectories();
    await saveRawSourceFor("agentic-systems", "deadbeef", "raw source one");
    const got = await readRawSourceById("agentic-systems", "deadbeef");
    expect(got.content).toBe("raw source one");
    expect(got.filename).toBe("deadbeef.md");
    expect(got.slug).toBe("agentic-systems");
  });

  it("keeps multiple sources for the same slug side by side", async () => {
    await ensureDirectories();
    await saveRawSourceFor("p", "aaa111", "source A");
    await saveRawSourceFor("p", "bbb222", "source B");
    expect((await readRawSourceById("p", "aaa111")).content).toBe("source A");
    expect((await readRawSourceById("p", "bbb222")).content).toBe("source B");
  });

  it("rejects a non-hex raw id (path-traversal guard)", async () => {
    await ensureDirectories();
    await expect(saveRawSourceFor("p", "../evil", "x")).rejects.toThrow();
    await expect(readRawSourceById("p", "../../etc/passwd")).rejects.toThrow(
      /not found/,
    );
  });

  it("throws not-found for a missing snapshot", async () => {
    await ensureDirectories();
    await expect(readRawSourceById("p", "abc123")).rejects.toThrow(/not found/);
  });

  it("does not pollute the flat listRawSources() (subdirs are skipped)", async () => {
    await ensureDirectories();
    await saveRawSource("flat-one", "flat");
    await saveRawSourceFor("flat-one", "cafe01", "nested snapshot");
    const slugs = (await listRawSources()).map((s) => s.slug);
    expect(slugs).toContain("flat-one");
    // The per-source subdir is not surfaced as a flat raw source.
    expect(slugs).not.toContain("cafe01");
    expect(await listRawSourceSnapshots()).toEqual([
      {
        slug: "flat-one",
        rawId: "cafe01",
        path: "raw/sources/flat-one/cafe01.md",
      },
    ]);
  });

  it("writes the snapshot under raw/sources/<slug>/<rawId>.md", async () => {
    await ensureDirectories();
    const returned = await saveRawSourceFor("nested", "abc123", "bytes");
    expect(returned).toBe(
      path.join(tmpDir, "raw", "sources", "nested", "abc123.md"),
    );
    expect(await fs.readFile(returned, "utf-8")).toBe("bytes");
  });

  it("leaves an occupied hash key exactly as it is (FR-2)", async () => {
    // The key is a hash of the arriving bytes, so "already there" and "the same
    // bytes" are the same fact — which is what makes immutability free. Written
    // with DIFFERENT content on purpose: the assertion has to be that the stored
    // blob is untouched, not that two identical writes agree.
    await ensureDirectories();
    await saveRawSourceFor("immutable", "beef01", "first arrival");
    await saveRawSourceFor("immutable", "beef01", "second arrival");
    expect((await readRawSourceById("immutable", "beef01")).content).toBe(
      "first arrival",
    );
  });

  it("refuses the write when the create-only publication cannot complete (FR-2)", async () => {
    // Fail-open used to treat a thrown exists-check as "absent" and write
    // anyway, which rewrote an occupied key. The check-then-write pair is gone
    // (DW-438) — the store is now ONE create-only call — but the invariant is
    // the same: a provider that cannot complete it must fail visibly rather
    // than degrade to an overwrite of immutable bytes. The owner can retry.
    await ensureDirectories();
    await saveRawSourceFor("occupied", "abc123", "first arrival");
    const spy = vi.spyOn(getStorage(), "writeFileIfAbsent").mockRejectedValue(
      new Error("create failed"),
    );
    try {
      await expect(
        saveRawSourceFor("occupied", "abc123", "mutant"),
      ).rejects.toThrow(/create failed/);
    } finally {
      spy.mockRestore();
    }
    expect((await readRawSourceById("occupied", "abc123")).content).toBe(
      "first arrival",
    );
  });

  it("lets exactly one of two concurrent stores of a new key win (DW-438)", async () => {
    // The old `alreadyStored(rel)` + `writeFile(rel, …)` pair left a window in
    // which both arrivals read "absent" and the LATER write replaced the
    // earlier one's bytes — a mutation of an immutable Source (FR-2). One
    // create-only provider call closes it.
    await ensureDirectories();
    const storage = getStorage();
    const rel = rawSourceRelPath("race/abc123.md");
    const original = storage.writeFileIfAbsent.bind(storage);
    let creates = 0;
    let winnerContent: string | null = null;
    const spy = vi
      .spyOn(storage, "writeFileIfAbsent")
      .mockImplementation(async (target: string, content: string) => {
        const created = await original(target, content);
        if (target === rel && created) {
          creates++;
          winnerContent = content;
        }
        return created;
      });
    try {
      await Promise.all([
        saveRawSourceFor("race", "abc123", "first arrival"),
        saveRawSourceFor("race", "abc123", "second arrival"),
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(creates).toBe(1);
    expect((await readRawSourceById("race", "abc123")).content).toBe(
      winnerContent,
    );
  });
});

// ---------------------------------------------------------------------------
// saveRawSourceBytes (Story 7.7)
// ---------------------------------------------------------------------------

describe("saveRawSourceBytes", () => {
  it("lets exactly one of two concurrent stores of a new key win (DW-438)", async () => {
    await ensureDirectories();
    const payloads = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]),
    ];
    const results = await Promise.all(
      payloads.map((bytes) =>
        saveRawSourceBytes("race", "beef01", "bin", bytes.buffer as ArrayBuffer),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.findIndex((r) => r.created);
    expect(new Uint8Array(await readRawSourceBytes(results[winner].rel))).toEqual(
      payloads[winner],
    );
  });

  it("refuses the write when the create-only publication cannot complete (FR-2)", async () => {
    // The binary half of the same invariant the string store pins above: the
    // asset store is now ONE create-only call, and a provider that cannot
    // complete it must fail visibly rather than degrade to an overwrite of
    // immutable bytes.
    await ensureDirectories();
    const first = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const stored = await saveRawSourceBytes(
      "occupied-bin",
      "abc123",
      "bin",
      first.buffer as ArrayBuffer,
    );
    const spy = vi.spyOn(getStorage(), "writeAssetIfAbsent").mockRejectedValue(
      new Error("create failed"),
    );
    try {
      await expect(
        saveRawSourceBytes(
          "occupied-bin",
          "abc123",
          "bin",
          new Uint8Array([0, 0, 0]).buffer as ArrayBuffer,
        ),
      ).rejects.toThrow(/create failed/);
    } finally {
      spy.mockRestore();
    }
    expect(new Uint8Array(await readRawSourceBytes(stored.rel))).toEqual(first);
  });

  it("leaves an occupied binary key exactly as it is (FR-2)", async () => {
    await ensureDirectories();
    const first = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const stored = await saveRawSourceBytes(
      "immutable-bin",
      "cafe02",
      "bin",
      first.buffer as ArrayBuffer,
    );
    expect(stored.created).toBe(true);

    const second = await saveRawSourceBytes(
      "immutable-bin",
      "cafe02",
      "bin",
      new Uint8Array([0, 0, 0]).buffer as ArrayBuffer,
    );
    expect(second.created).toBe(false);
    expect(new Uint8Array(await readRawSourceBytes(stored.rel))).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// saveRawSourceTree (Story 2.2)
// ---------------------------------------------------------------------------

describe("saveRawSourceTree", () => {
  it("writes the sanitized relative path under raw/sources/", async () => {
    await ensureDirectories();
    const returned = await saveRawSourceTree("papers/energy/note.md", "# Note\n");
    expect(returned.created).toBe(true);
    expect(returned.path).toBe(
      path.join(tmpDir, "raw", "sources", "papers", "energy", "note.md"),
    );
    expect(await fs.readFile(returned.path, "utf-8")).toBe("# Note\n");
  });

  it("leaves an occupied tree key exactly as it is (FR-2)", async () => {
    await ensureDirectories();
    await saveRawSourceTree("papers/energy/note.md", "first arrival");
    const second = await saveRawSourceTree("papers/energy/note.md", "second arrival");
    expect(second.created).toBe(false);
    expect(
      await fs.readFile(
        path.join(tmpDir, "raw", "sources", "papers", "energy", "note.md"),
        "utf-8",
      ),
    ).toBe("first arrival");
  });

  it("throws on a traversal or extension-less path", async () => {
    await expect(saveRawSourceTree("../../etc/passwd", "x")).rejects.toThrow(
      /Invalid raw tree path/,
    );
    await expect(saveRawSourceTree("papers/energy", "x")).rejects.toThrow(
      /Invalid raw tree path/,
    );
  });
});

// ---------------------------------------------------------------------------
// Story 2.1 — the three things Intake hangs on: the silo mirror, the
// `dataVersion` bump, and the legacy read path.
// ---------------------------------------------------------------------------

describe("intake writes (owner option)", () => {
  const OWNER = "intake-owner";

  /** The silo key the Workbench's Files walk resolves (DW-40). */
  function siloAbs(rest: string): string {
    return path.join(
      getDataDir(),
      tenantRawSourceRelPath(tenantForOwner(OWNER), rest),
    );
  }

  afterEach(async () => {
    // Only this owner's silo. `DATA_DIR` is a temp root shared by the whole run
    // (`vitest.setup.ts`), so removing `tenants/` wholesale would reach into
    // other suites' fixtures.
    await fs.rm(path.join(getDataDir(), "tenants", tenantForOwner(OWNER)), {
      recursive: true,
      force: true,
    });
  });

  it("mirrors the bytes into the owner's silo so Files can see them", async () => {
    // Without this the arrival is invisible: `listWorkbenchFilePaths` resolves
    // `raw/` strictly inside `tenants/<tenant>/raw/` and never falls back to the
    // shared flat tree, so a Source written only to the flat key would land in a
    // Workbench that cannot list it.
    await saveRawSourceFor("mirrored", "aa11bb", "silo me", { owner: OWNER });
    expect(await fs.readFile(siloAbs("mirrored/aa11bb.md"), "utf-8")).toBe("silo me");
  });

  it("writes NO silo copy when no owner is given", async () => {
    // Ingest's own callers leave `owner` unset — they reach the silo through
    // `syncSiloForPage` after the page write. A helper that mirrored
    // unconditionally would have to invent a tenant for ownerless seed content.
    await saveRawSourceFor("unowned", "cc22dd", "flat only");
    await expect(fs.stat(siloAbs("unowned/cc22dd.md"))).rejects.toThrow();
  });

  it("repairs a missing mirror even when the flat bytes are already stored", async () => {
    // The flat key is written on the first arrival with no owner, so the silo
    // never receives it. A second arrival that skipped the mirror because the
    // flat write was declined would leave that Source invisible forever.
    await saveRawSourceFor("repaired", "ee33ff", "bytes");
    await expect(fs.stat(siloAbs("repaired/ee33ff.md"))).rejects.toThrow();

    await saveRawSourceFor("repaired", "ee33ff", "bytes", { owner: OWNER });
    expect(await fs.readFile(siloAbs("repaired/ee33ff.md"), "utf-8")).toBe("bytes");
  });

  it("repairs the mirror from the STORED bytes, bumping exactly once", async () => {
    // A tree key can be re-offered with DIFFERENT text (FR-40 path identity),
    // so the declined branch has to be said with two different bodies: the flat
    // key keeps the first arrival (FR-2), and the silo receives what is STORED
    // rather than the request body — copying the new body across would show
    // Files a Source the flat key does not hold.
    //
    // The bump is COUNTED at the provider rather than read off the counter:
    // `DATA_DIR` is a temp root shared by the whole run, so the difference of
    // two reads is not this call's bump alone.
    await saveRawSourceTree("papers/reoffered.md", "first arrival");
    await expect(fs.stat(siloAbs("papers/reoffered.md"))).rejects.toThrow();

    const bumps = vi.spyOn(getStorage(), "incrementIndex");
    let second: { path: string; created: boolean };
    let dataVersionBumps: number;
    try {
      second = await saveRawSourceTree("papers/reoffered.md", "second arrival", {
        owner: OWNER,
      });
    } finally {
      // Counted BEFORE the restore: `mockRestore()` clears the record.
      dataVersionBumps = bumps.mock.calls.filter(
        ([key]) => key === "data-version",
      ).length;
      bumps.mockRestore();
    }

    expect(second.created).toBe(false);
    expect(await fs.readFile(second.path, "utf-8")).toBe("first arrival");
    expect(await fs.readFile(siloAbs("papers/reoffered.md"), "utf-8")).toBe(
      "first arrival",
    );
    expect(dataVersionBumps).toBe(1);
  });

  it("bumps dataVersion on a new write and not on a declined one", async () => {
    // The bump is what lets `DataVersionWatcher` refresh the trees without a
    // full reload. A declined write changed nothing, so it must not move the
    // signal — a bump per attempt would re-render the shell on every re-ingest.
    const before = await readDataVersion();
    await saveRawSourceFor("bumped", "1a2b3c", "new bytes", { owner: OWNER });
    const afterWrite = await readDataVersion();
    expect(afterWrite).toBeGreaterThan(before);

    await saveRawSourceFor("bumped", "1a2b3c", "new bytes", { owner: OWNER });
    expect(await readDataVersion()).toBe(afterWrite);
  });

  it("bumps dataVersion when a declined write repairs the silo", async () => {
    // First write has no owner, so the silo is empty and the bump already
    // happened. The retry only copies the mirror — without a second bump the
    // watcher is forward-only and Files stays empty.
    await saveRawSourceFor("repaired-bump", "ee33ff", "bytes");
    const afterFirst = await readDataVersion();
    await saveRawSourceFor("repaired-bump", "ee33ff", "bytes", { owner: OWNER });
    expect(await readDataVersion()).toBeGreaterThan(afterFirst);
    expect(await fs.readFile(siloAbs("repaired-bump/ee33ff.md"), "utf-8")).toBe(
      "bytes",
    );
  });

  it("keeps the stored Source when the silo mirror fails", async () => {
    // Fail-soft: the flat key is the system of record, and a mirror that
    // rejects must not turn a Source that already landed into a failed arrival.
    // The failure is forced by putting a FILE where the silo directory has to
    // go, so `writeFile` cannot create the parent.
    const blocker = path.join(
      getDataDir(),
      tenantRawSourceRelPath(tenantForOwner(OWNER), "blocked"),
    );
    await fs.mkdir(path.dirname(blocker), { recursive: true });
    await fs.writeFile(blocker, "not a directory", "utf-8");

    const returned = await saveRawSourceFor("blocked", "9f8e7d", "kept", {
      owner: OWNER,
    });
    expect(await fs.readFile(returned, "utf-8")).toBe("kept");
  });

  it("mirrors a tree path into the owner's silo and bumps dataVersion", async () => {
    const before = await readDataVersion();
    const returned = await saveRawSourceTree("papers/energy/note.md", "tree bytes", {
      owner: OWNER,
    });
    expect(await fs.readFile(returned.path, "utf-8")).toBe("tree bytes");
    expect(await fs.readFile(siloAbs("papers/energy/note.md"), "utf-8")).toBe(
      "tree bytes",
    );
    expect(await readDataVersion()).toBeGreaterThan(before);

    const afterWrite = await readDataVersion();
    await saveRawSourceTree("papers/energy/note.md", "mutant", { owner: OWNER });
    expect(await fs.readFile(siloAbs("papers/energy/note.md"), "utf-8")).toBe(
      "tree bytes",
    );
    expect(await readDataVersion()).toBe(afterWrite);
  });

  it("repairs a missing tree silo from the stored bytes, not the request", async () => {
    await saveRawSourceTree("papers/energy/note.md", "first arrival");
    await saveRawSourceTree("papers/energy/note.md", "mutant", { owner: OWNER });
    expect(await fs.readFile(siloAbs("papers/energy/note.md"), "utf-8")).toBe(
      "first arrival",
    );
  });
});

describe("isRawSnapshotName", () => {
  // The identity the silo mirror uses to tell a page's own content-addressed
  // snapshot from a folder-import file sharing `raw/sources/<name>/`. Pinned
  // directly because getting it wrong in either direction is silent: too loose
  // carries somebody else's import into a page silo and deletes it with the
  // page, too tight leaves real arrivals unmirrored and invisible in Files.
  const hex = "c4".repeat(32);

  it("accepts a hashed snapshot at any extension saveRawSourceBytes writes", () => {
    // `.md` is what `listRawSourceSnapshots` enumerates; the binary extensions
    // are the arrivals `saveRawSourceBytes` publishes into the same namespace,
    // which the mirror must carry byte-exactly.
    expect(isRawSnapshotName(`${hex}.md`)).toBe(true);
    expect(isRawSnapshotName(`${hex}.pdf`)).toBe(true);
  });

  it("rejects names that are not <hex>.<ext>", () => {
    expect(isRawSnapshotName("note.md")).toBe(false); // a folder-import file
    expect(isRawSnapshotName("abc")).toBe(false); // no extension at all
    expect(isRawSnapshotName(".md")).toBe(false); // dotfile, empty id
    expect(isRawSnapshotName("a.b.md")).toBe(false); // the id half is not hex
    expect(isRawSnapshotName(`${hex.toUpperCase()}.md`)).toBe(false); // ids are lowercase
    expect(isRawSnapshotName(`${hex}.abcdefghi`)).toBe(false); // 9-char extension
  });

  it("accepts a SHORT all-hex name — the collision this deliberately allows", () => {
    // `beef.md` is indistinguishable by name from a real snapshot, so a folder
    // import can put one file (never a directory or a tree) into a colliding
    // page's silo, and lose it when that page is deleted. Recorded as a test so
    // that tightening the id rule — a length floor, say — is a visible diff
    // here rather than a silent behavior change in the mirror.
    expect(isRawSnapshotName("beef.md")).toBe(true);
  });
});
