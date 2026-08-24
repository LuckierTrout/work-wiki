import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { readDataVersion } from "../data-version";
import { pruneStaleIndexEntry, writeWikiPageWithSideEffects } from "../lifecycle";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import { fixBrokenLink } from "../lint-fix";
import { getPageIndex } from "../page-index";
import { _resetStorage, getStorage } from "../storage";
import {
  beginPageCache,
  ensureDirectories,
  listWikiPages,
  readWikiPage,
  tenantForOwner,
  tenantWikiRelPath,
  updateIndex,
  wikiRelPath,
} from "../wiki";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-index-lifecycle-"));
  for (const key of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[key] = process.env[key];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const key of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetLocks();
  _resetStorage();
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedGhost(): Promise<void> {
  await updateIndex([{ slug: "ghost", title: "Ghost", summary: "stale" }]);
  await getStorage().putIndex("pages", {
    ghost: { slug: "ghost", title: "Ghost", summary: "stale" },
  });
}

describe("pruneStaleIndexEntry", () => {
  it("uses a fresh Page read before deleting an index membership", async () => {
    await seedGhost();
    const release = beginPageCache();
    try {
      expect(await readWikiPage("ghost")).toBeNull();
      await getStorage().writeFile(
        wikiRelPath("ghost.md"),
        "# Ghost\n\nRecreated outside the cached write path.\n",
      );

      await expect(pruneStaleIndexEntry("ghost")).resolves.toEqual({ removed: false });
      expect((await listWikiPages()).map((entry) => entry.slug)).toContain("ghost");
    } finally {
      release();
    }
  });

  it("removes authoritative and derived membership and bumps dataVersion", async () => {
    await seedGhost();
    const before = await readDataVersion();

    await expect(pruneStaleIndexEntry("ghost")).resolves.toEqual({ removed: true });

    expect((await listWikiPages()).map((entry) => entry.slug)).not.toContain("ghost");
    expect(await getPageIndex()).toEqual({});
    expect(await readDataVersion()).toBeGreaterThan(before);
  });

  it("keeps a successful authoritative prune when derived page-index cleanup fails", async () => {
    await seedGhost();
    const storage = getStorage();
    const originalPutIndex = storage.putIndex.bind(storage);
    const putIndex = vi.spyOn(storage, "putIndex").mockImplementation(async (key, value) => {
      if (key === "pages") throw new Error("page index unavailable");
      return originalPutIndex(key, value);
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(pruneStaleIndexEntry("ghost")).resolves.toEqual({ removed: true });

    expect((await listWikiPages()).map((entry) => entry.slug)).not.toContain("ghost");
    expect(
      warn.mock.calls.some(
        ([scope, message]) =>
          scope === "page-index" && String(message).includes("cleanup skipped for stale index"),
      ),
    ).toBe(true);
    expect(putIndex).toHaveBeenCalledWith("pages", {});
  });

  it("does not remove an index row when the Page read is indeterminate", async () => {
    await seedGhost();
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (filePath) => {
      if (filePath === wikiRelPath("ghost.md")) throw new Error("storage unavailable");
      return originalRead(filePath);
    });

    await expect(pruneStaleIndexEntry("ghost")).rejects.toThrow("storage unavailable");
    expect((await listWikiPages()).map((entry) => entry.slug)).toContain("ghost");
  });

  it("rejects a stale lifecycle transform without overwriting newer Page bytes", async () => {
    const tenant = tenantForOwner("alice");
    const original = "---\nowner: alice\n---\n\n# Linker\n\nSee [[old]].\n";
    const newer = "---\nowner: alice\n---\n\n# Linker\n\nA concurrent edit.\n";
    await getStorage().writeFile(tenantWikiRelPath(tenant, "linker.md"), original);
    await getStorage().writeFile(wikiRelPath("linker.md"), original);
    await getStorage().writeFile(tenantWikiRelPath(tenant, "linker.md"), newer);
    await getStorage().writeFile(wikiRelPath("linker.md"), newer);

    await expect(writeWikiPageWithSideEffects({
      slug: "linker",
      title: "Linker",
      content: original.replace("[[old]]", "[[new]]"),
      expectedContent: original,
      summary: "Linker",
      logOp: "edit",
      crossRefSource: null,
      author: "lint-fix",
    })).rejects.toThrow(/changed; run Lint again/);

    expect(await getStorage().readFile(tenantWikiRelPath(tenant, "linker.md"))).toBe(newer);
    expect(await getStorage().readFile(wikiRelPath("linker.md"))).toBe(newer);
  });

  it("creates a missing flat copy after a successful silo expected-content CAS", async () => {
    const tenant = tenantForOwner("alice");
    const original = "---\nowner: alice\n---\n\n# Silo Only\n\nbody\n";
    await getStorage().writeFile(tenantWikiRelPath(tenant, "silo-only.md"), original);

    await expect(
      writeWikiPageWithSideEffects({
        slug: "silo-only",
        title: "Silo Only",
        content: original,
        expectedContent: original,
        summary: "Silo Only",
        logOp: "save",
        crossRefSource: null,
        author: "alice",
      }),
    ).resolves.toMatchObject({ slug: "silo-only" });

    expect(await getStorage().readFile(wikiRelPath("silo-only.md"))).toBe(original);
    expect(await readWikiPage("silo-only")).toMatchObject({ slug: "silo-only" });
  });

  it("promotes a flat-only Page through expected-content CAS", async () => {
    const original =
      "---\ntags: [test]\n---\n# Orphan Fix\n\nThis page should be added to the index.\n";
    await getStorage().writeFile(wikiRelPath("orphan-fix.md"), original);

    await expect(
      writeWikiPageWithSideEffects({
        slug: "orphan-fix",
        title: "Orphan Fix",
        content: original,
        expectedContent: original,
        summary: "This page should be added to the index.",
        logOp: "edit",
        logDetails: () => "auto-fix: added orphan page to index",
        crossRefSource: null,
        author: "lint-fix",
      }),
    ).resolves.toMatchObject({ slug: "orphan-fix" });

    expect(await getStorage().readFile(wikiRelPath("orphan-fix.md"))).toBe(original);
    expect(
      await getStorage().readFile(
        tenantWikiRelPath(tenantForOwner(undefined), "orphan-fix.md"),
      ),
    ).toBe(original);
  });

  it("rejects a stale transform when only the flat fallback exists", async () => {
    const original = "# Old\n";
    const newer = "# Newer\n";
    await getStorage().writeFile(wikiRelPath("flat-cas.md"), newer);

    await expect(
      writeWikiPageWithSideEffects({
        slug: "flat-cas",
        title: "Flat",
        content: "# Next\n",
        expectedContent: original,
        summary: "Flat",
        logOp: "edit",
        crossRefSource: null,
        author: "lint-fix",
      }),
    ).rejects.toThrow(/changed; run Lint again/);

    expect(await getStorage().readFile(wikiRelPath("flat-cas.md"))).toBe(newer);
  });

  it("refuses to rewrite index.md when a createOnly index read fails", async () => {
    await writeWikiPageWithSideEffects({
      slug: "kept",
      title: "Kept",
      content: "# Kept\n",
      summary: "Kept",
      logOp: "save",
      crossRefSource: null,
      author: "alice",
    });
    const indexBefore = await getStorage().readFile(wikiRelPath("index.md"));
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (filePath) => {
      if (filePath === wikiRelPath("index.md")) throw new Error("index unavailable");
      return originalRead(filePath);
    });

    await expect(
      writeWikiPageWithSideEffects({
        slug: "review-page",
        title: "Review Page",
        content: "---\nowner: alice\n---\n# Review Page\n",
        summary: "Review Page",
        logOp: "save",
        crossRefSource: null,
        author: "alice",
        createOnly: true,
      }),
    ).rejects.toThrow("index unavailable");

    vi.restoreAllMocks();
    expect(await getStorage().readFile(wikiRelPath("index.md"))).toBe(indexBefore);
    expect(indexBefore).toContain("kept.md");
    expect(indexBefore).not.toContain("review-page.md");
  });

  it("fixBrokenLink cannot overwrite a competing edit after its fresh read", async () => {
    const tenant = tenantForOwner("alice");
    const tenantPath = tenantWikiRelPath(tenant, "linker.md");
    const original = "---\nowner: alice\n---\n\n# Linker\n\nSee [old](gone.md).\n";
    const newer = "---\nowner: alice\n---\n\n# Linker\n\nA competing edit.\n";
    await getStorage().putIndex("pages", {
      linker: { slug: "linker", title: "Linker", summary: "s", owner: "alice" },
    });
    await getStorage().writeFile(tenantPath, original);
    await getStorage().writeFile(wikiRelPath("linker.md"), original);
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(async (filePath, content, etag) => {
      if (filePath === tenantPath) {
        await storage.writeFile(tenantPath, newer);
      }
      return originalMatch(filePath, content, etag);
    });

    await expect(fixBrokenLink("linker", "gone")).rejects.toThrow(/changed; run Lint again/);
    expect(await storage.readFile(tenantPath)).toBe(newer);
    expect(await storage.readFile(wikiRelPath("linker.md"))).toBe(original);
  });
});
