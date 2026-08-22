import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  saveRawSource,
  saveRawSourceFor,
  listRawSources,
  readRawSource,
  readRawSourceById,
  tenantRawSourceRelPath,
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

  it("refuses the write when existence cannot be confirmed (FR-2)", async () => {
    // Fail-open used to treat a thrown exists-check as "absent" and write
    // anyway, which rewrote an occupied key. A flaky HEAD must not mutate
    // immutable bytes — the arrival fails and the owner can retry.
    await ensureDirectories();
    await saveRawSourceFor("occupied", "abc123", "first arrival");
    const spy = vi.spyOn(getStorage(), "fileExists").mockRejectedValue(
      new Error("head failed"),
    );
    try {
      await expect(
        saveRawSourceFor("occupied", "abc123", "mutant"),
      ).rejects.toThrow(/head failed/);
    } finally {
      spy.mockRestore();
    }
    expect((await readRawSourceById("occupied", "abc123")).content).toBe(
      "first arrival",
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
});
