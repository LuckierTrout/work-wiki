import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { sourceSha256 } from "../source-sha256";
import {
  getPageIndex,
  getPageIndexDirtySlugs,
  markPageIndexDirty,
  clearPageIndexDirty,
  syncPageIndexForPage,
  removePageIndexForSlug,
  rebuildPageIndex,
} from "../page-index";
import {
  listWikiPages,
  scanWikiPagesUncached,
  ensureDirectories,
  writeWikiPage,
} from "../wiki";
import { _resetLocks, _setDurableLocksForTests } from "../lock";
import { _resetStorage, getStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-index-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _setDurableLocksForTests(true);
  _resetStorage();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _setDurableLocksForTests(false);
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a page with frontmatter + register it in index.md. */
async function createPage(slug: string, frontmatter: string, title = slug) {
  await ensureDirectories();
  await writeWikiPage(slug, `---\n${frontmatter}\n---\n\n# ${title}\n\nBody.`);
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch {
    /* none */
  }
  const line = `- [${title}](${slug}.md) — ${title} summary`;
  await fs.writeFile(
    indexPath,
    existing ? `${existing.trimEnd()}\n${line}\n` : `# Wiki Index\n\n${line}\n`,
    "utf-8",
  );
}

describe("page-index", () => {
  it("getPageIndex returns null when the key is absent (not seeded)", async () => {
    await createPage("a", "owner: alice\ntags: [x]");
    expect(await getPageIndex()).toBeNull();
  });

  it("recovers a nested legacy marker whose leaf starts with the current prefix", async () => {
    await getStorage().writeFile(
      "derived-indexes/pages-dirty/queries/v2-secret",
      "1",
    );
    const dirty = await getPageIndexDirtySlugs();
    expect(dirty).toContain("queries/v2-secret");
    expect(dirty).not.toContain("1");
  });

  it("clears a root marker without unlinking the directory for nested legacy markers", async () => {
    await getStorage().writeFile(
      "derived-indexes/pages-dirty/queries/v2-secret",
      "1",
    );
    await markPageIndexDirty("queries");
    expect(await getPageIndexDirtySlugs()).toEqual(
      new Set(["queries", "queries/v2-secret"]),
    );

    await expect(clearPageIndexDirty("queries")).resolves.toBeUndefined();
    expect(await getPageIndexDirtySlugs()).toEqual(
      new Set(["queries/v2-secret"]),
    );
  });

  it("does not clear a current marker when an unrelated legacy-prefix slug completes", async () => {
    const victim = "private-victim";
    await markPageIndexDirty(victim);

    await clearPageIndexDirty(`v2-${await sourceSha256(victim)}`);

    expect(await getPageIndexDirtySlugs()).toEqual(new Set([victim]));
  });

  it("recovers and retains a previous-release marker until old writers drain", async () => {
    const slug = "rolling-private";
    await getStorage().writeFile(
      `derived-indexes/pages-dirty/v2-${await sourceSha256(slug)}`,
      slug,
    );

    expect(await getPageIndexDirtySlugs()).toEqual(new Set([slug]));
    await clearPageIndexDirty(slug);
    expect(await getPageIndexDirtySlugs()).toEqual(new Set([slug]));
  });

  it("does not clear a previous-release marker through its colliding raw slug", async () => {
    const victim = "rolling-victim";
    const collidingSlug = `v2-${await sourceSha256(victim)}`;
    await getStorage().writeFile(
      `derived-indexes/pages-dirty/${collidingSlug}`,
      victim,
    );

    await clearPageIndexDirty(collidingSlug);

    expect(await getPageIndexDirtySlugs()).toEqual(new Set([victim]));
  });

  it("syncPageIndexForPage / remove NO-OP until the index is seeded", async () => {
    await createPage("a", "owner: alice");
    await syncPageIndexForPage({ slug: "a", title: "A", summary: "s", owner: "alice" });
    await removePageIndexForSlug("a");
    expect(await getPageIndex()).toBeNull();
  });

  it("listWikiPages fast-path (seeded) equals the per-page scan", async () => {
    await createPage("a", "owner: alice\ntags: [ml, ai]\ntype: note", "Alpha");
    await createPage("b", "owner: bob\nvisibility: private\nconfidence: 0.5", "Beta");

    const scan = await scanWikiPagesUncached();
    await rebuildPageIndex();
    expect(await getPageIndex()).not.toBeNull();

    const fast = await listWikiPages();
    // Same entries (order by index.md), same enriched fields.
    expect(fast).toEqual(scan);
    // Spot-check enrichment came through the index, not just base fields.
    const beta = fast.find((e) => e.slug === "b");
    expect(beta?.visibility).toBe("private");
    expect(beta?.owner).toBe("bob");
    expect(beta?.confidence).toBe(0.5);
  });

  it("returns a null-prototype index so a prototype-named slug reads as a miss", async () => {
    await createPage("a", "owner: alice", "Alpha");
    await rebuildPageIndex();

    const idx = await getPageIndex();
    expect(idx).not.toBeNull();
    // Real entries still resolve...
    expect(idx!["a"]?.owner).toBe("alice");
    // ...while a slug naming an `Object.prototype` member reads `undefined`
    // rather than an inherited function. Callers (`tenantForSlug`,
    // `wikiPageExists`, `readWikiPage`) index this map directly, so the miss
    // has to come from the map itself (DW-232).
    expect(Object.getPrototypeOf(idx!)).toBeNull();
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect((idx as Record<string, unknown>)[key]).toBeUndefined();
    }
    // The map still serializes and enumerates exactly as before.
    expect(Object.keys(idx!)).toEqual(["a"]);
    expect(JSON.parse(JSON.stringify(idx))).toEqual({ a: idx!["a"] });
  });

  it("falls back to the scan when the index is unseeded (identical result)", async () => {
    await createPage("a", "owner: alice\ntags: [x]", "Alpha");
    // No rebuild → index absent → listWikiPages must equal the scan.
    expect(await getPageIndex()).toBeNull();
    expect(await listWikiPages()).toEqual(await scanWikiPagesUncached());
  });

  it("after seeding, sync upserts and remove drops an entry", async () => {
    await createPage("a", "owner: alice", "Alpha");
    await rebuildPageIndex();

    await syncPageIndexForPage({ slug: "a", title: "Alpha", summary: "s", owner: "carol" });
    expect((await getPageIndex())?.["a"]?.owner).toBe("carol");

    await removePageIndexForSlug("a");
    expect((await getPageIndex())?.["a"]).toBeUndefined();
  });

  it("preserves concurrent metadata updates across simulated Worker isolates", async () => {
    await createPage("a", "owner: alice\nvisibility: private", "Alpha");
    await createPage("b", "owner: bob\nvisibility: private", "Beta");
    await rebuildPageIndex();
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    let firstRead!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => { firstRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reads = 0;
    vi.spyOn(storage, "readFile").mockImplementation(async (rel) => {
      const value = await originalRead(rel);
      if (String(rel) === "derived-indexes/pages.json") {
        reads += 1;
        if (reads === 1) {
          firstRead();
          await release;
        }
      }
      return value;
    });

    const first = syncPageIndexForPage({
      slug: "a", title: "Alpha", summary: "A", owner: "alice", visibility: "private",
    });
    await started;
    _resetLocks();
    const second = syncPageIndexForPage({
      slug: "b", title: "Beta", summary: "B", owner: "bob", visibility: "private",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(1);
    releaseRead();
    await Promise.all([first, second]);

    expect((await getPageIndex())?.a).toMatchObject({ owner: "alice", visibility: "private" });
    expect((await getPageIndex())?.b).toMatchObject({ owner: "bob", visibility: "private" });
  });
});
