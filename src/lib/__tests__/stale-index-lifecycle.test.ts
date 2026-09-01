import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { readDataVersion } from "../data-version";
import { pruneStaleIndexEntry, writeWikiPageWithSideEffects } from "../lifecycle";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import { fixBrokenLink, fixEmptyPage, fixLintIssue } from "../lint-fix";
import { getPageIndex } from "../page-index";
import { _resetStorage, getStorage } from "../storage";
import {
  beginPageCache,
  ensureDirectories,
  listWikiPages,
  readWikiPage,
  readWikiPageWithFrontmatter,
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

/**
 * The two lint fixes that write NO page (DW-447).
 *
 * `stale-index` and `empty-page` mint no revision, so their wiki-log detail
 * line is the only durable record they leave — and therefore the only place the
 * handle of whoever ASKED for the fix can land. Real storage here, not a spy on
 * `appendToLog`: the claim is about the bytes that reach `wiki/log.md`, and
 * `contributors.ts` / `normalizeActor` never reading them is precisely why this
 * is a safe home for a human's handle.
 */
describe("the trigger on the page-less lint fixes", () => {
  const readLogFile = () => getStorage().readFile(wikiRelPath("log.md"));

  it("stamps `stale-index` with the trigger and leaves it off when there is none", async () => {
    await seedGhost();
    await expect(pruneStaleIndexEntry("ghost", "alice")).resolves.toEqual({
      removed: true,
    });

    expect(await readLogFile()).toContain(
      "auto-fix: removed stale index entry for ghost (triggered by alice)",
    );

    // Same op, no principal — the stdio-MCP / CLI shape. Byte-identical to what
    // this fix logged before a trigger could be recorded at all.
    await seedGhost();
    await expect(pruneStaleIndexEntry("ghost")).resolves.toEqual({ removed: true });

    const log = await readLogFile();
    expect(log).toContain("auto-fix: removed stale index entry for ghost\n");
    expect(log.match(/\(triggered by/g) ?? []).toHaveLength(1);
  });

  it("stamps an `empty-page` delete with the trigger, without touching its author", async () => {
    await getStorage().writeFile(wikiRelPath("hollow.md"), "# Hollow\n");
    await updateIndex([{ slug: "hollow", title: "Hollow", summary: "empty" }]);

    await expect(fixEmptyPage("hollow", undefined, "alice")).resolves.toMatchObject({
      success: true,
      slug: "hollow",
    });

    // The delete's own detail line, suffixed by the SAME formatter the
    // page-writing fixes use — one owner, so the two cannot drift apart.
    expect(await readLogFile()).toMatch(
      /deleted · stripped backlinks from \d+ page\(s\) \(triggered by alice\)/,
    );
  });

  it("leaves an `empty-page` delete line untouched when no principal was resolved", async () => {
    await getStorage().writeFile(wikiRelPath("hollow.md"), "# Hollow\n");
    await updateIndex([{ slug: "hollow", title: "Hollow", summary: "empty" }]);

    await expect(fixEmptyPage("hollow")).resolves.toMatchObject({ success: true });

    expect(await readLogFile()).not.toContain("(triggered by");
  });
});

/**
 * THE INVARIANT THE WHOLE CHANGE EXISTS FOR, end to end (DW-447).
 *
 * Every other row in this bundle observes one hop — a forwarded argument, a
 * `logDetails` closure invoked against a mocked write. None of them can say
 * whether the human's handle stays OUT of the places attribution actually reads.
 * This one drives a triggered fix through real storage and then sweeps the
 * whole wiki tree: `alice` must appear in `log.md` and nowhere else.
 *
 * A tree-wide sweep rather than a list of named fields, because the failure
 * mode is a handle reaching somewhere nobody thought to assert about — the
 * revision `.meta.json` sidecar and the page's `contributors` are the two
 * `contributors.ts` reads today, but the frontmatter, the index and the
 * derived indices are all written on this same path.
 */
describe("a triggered fix keeps the human out of attribution", () => {
  /** Every file under the wiki tree, relative to it, with its bytes. */
  async function readWikiTree(): Promise<Map<string, string>> {
    const root = process.env.WIKI_DIR!;
    const out = new Map<string, string>();
    async function walk(dir: string, prefix: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(full, rel);
        else out.set(rel, await fs.readFile(full, "utf8"));
      }
    }
    await walk(root, "");
    return out;
  }

  it("logs the trigger, and leaks it into no other file in the wiki", async () => {
    // An orphan: on disk, absent from `index.md`. `fixOrphanPage` reads it,
    // writes it back through the lifecycle pipeline (minting a revision of the
    // previous bytes) and adds the index entry.
    const body = "---\ncontributors: []\n---\n\n# Orphan E2E\n\nBody text.\n";
    await getStorage().writeFile(wikiRelPath("orphan-e2e.md"), body);
    await updateIndex([{ slug: "other", title: "Other", summary: "unrelated" }]);

    await expect(
      fixLintIssue("orphan-page", "orphan-e2e", undefined, undefined, undefined, "alice"),
    ).resolves.toMatchObject({ success: true, slug: "orphan-e2e" });

    const tree = await readWikiTree();

    // (a) The trigger really is on the log line — read from the file, not from
    // a closure this test invoked itself.
    expect(tree.get("log.md")).toContain(
      "auto-fix: added orphan page to index (triggered by alice)",
    );

    // (b) The revision sidecar names the MACHINE. `contributors.ts` reads this
    // field; a handle here is a trust-score entry for an edit alice never wrote.
    const sidecars = [...tree].filter(([name]) => name.endsWith(".meta.json"));
    expect(sidecars.length).toBeGreaterThan(0);
    for (const [, raw] of sidecars) {
      expect(JSON.parse(raw)).toMatchObject({ author: "lint-fix" });
    }

    // (c) And nowhere else at all. `log.md` is the ONE file allowed to name her.
    const leaked = [...tree]
      .filter(([name, content]) => name !== "log.md" && content.includes("alice"))
      .map(([name]) => name);
    expect(leaked).toEqual([]);

    // The control for (c): the sweep is looking at real files with real
    // content, so an empty `leaked` means something.
    expect(tree.size).toBeGreaterThan(1);
    expect(await readWikiPageWithFrontmatter("orphan-e2e")).toMatchObject({
      frontmatter: { contributors: [] },
    });
  });

  it("writes no trigger anywhere when no principal was resolved — the control", async () => {
    const body = "---\ncontributors: []\n---\n\n# Orphan E2E\n\nBody text.\n";
    await getStorage().writeFile(wikiRelPath("orphan-e2e.md"), body);
    await updateIndex([{ slug: "other", title: "Other", summary: "unrelated" }]);

    await expect(fixLintIssue("orphan-page", "orphan-e2e")).resolves.toMatchObject({
      success: true,
    });

    const tree = await readWikiTree();
    expect(tree.get("log.md")).toContain("auto-fix: added orphan page to index");
    expect(tree.get("log.md")).not.toContain("(triggered by");
  });
});
