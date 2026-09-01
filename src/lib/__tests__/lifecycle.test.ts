import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as embeddings from "../embeddings";
import * as config from "../config";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  writeWikiPageWithSideEffects,
  deleteWikiPage,
} from "../lifecycle";
import type { WritePageOptions } from "../lifecycle";
import {
  ensureDirectories,
  readWikiPage,
  readWikiPageWithFrontmatter,
  writeWikiPage,
  listWikiPages,
  listReadableWikiPages,
  readLog,
  tenantForOwner,
} from "../wiki";
import { updateIndex } from "../wiki";
import { listRevisions, readRevisionMeta, saveRevision } from "../revisions";
import { resolveAlias, buildAliasIndex, resetAliasIndex } from "../alias-index";
import { serializeFrontmatter } from "../frontmatter";
import { getStorage, _resetStorage } from "../storage";
import { registerAgent, getAgent } from "../agents";
import { _resetLocks, _setDurableLocksForTests, withDurableLock } from "../lock";
import { getPageIndexDirtySlugs, rebuildPageIndex } from "../page-index";
import { canReadSlug } from "../authz";

// ---------------------------------------------------------------------------
// Temp directory setup — mirrors wiki.test.ts approach
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  // Isolate DATA_DIR so the per-tenant silo mirror (tenants/…, relative to the
  // data dir) and derived indexes land under tmp, not the repo cwd.
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  _setDurableLocksForTests(false);
  await ensureDirectories();
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
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  _resetStorage();
  _setDurableLocksForTests(false);
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetAliasIndex();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WritePageOptions with sensible defaults. */
function makeOpts(overrides: Partial<WritePageOptions> = {}): WritePageOptions {
  return {
    slug: "test-page",
    title: "Test Page",
    content: "# Test Page\n\nSome content.\n",
    summary: "A test page",
    logOp: "ingest",
    ...overrides,
  };
}

/** Read the raw index.md text from disk. */
async function readIndex(): Promise<string> {
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  return fs.readFile(indexPath, "utf-8");
}

// ===========================================================================
// writeWikiPageWithSideEffects
// ===========================================================================

describe("writeWikiPageWithSideEffects", () => {
  it("resumes side effects when Page bytes landed before the lifecycle receipt", async () => {
    const content = "# Recovered Page\n\nThe Page bytes landed first.\n";
    // Production create order is silo first, flat compatibility copy second.
    // Seed only the silo to reproduce a crash between those two writes.
    await writeWikiPage("recovered-page", content, undefined, undefined, "yopedia");
    const receiptPath = "lifecycle-receipts/recovered-page.json";
    const options = makeOpts({
      slug: "recovered-page",
      title: "Recovered Page",
      content,
      summary: "Recovered lifecycle",
      createOnly: true,
      idempotency: { key: "research-recovered-page-v1", receiptPath },
    });

    await writeWikiPageWithSideEffects(options);
    await writeWikiPageWithSideEffects(options);

    expect((await listWikiPages()).filter((entry) => entry.slug === "recovered-page"))
      .toHaveLength(1);
    expect(await fs.readFile(path.join(process.env.WIKI_DIR!, "recovered-page.md"), "utf-8"))
      .toBe(content);
    expect(await getStorage().readFile(receiptPath)).toContain("research-recovered-page-v1");
    expect((await readLog())?.match(/ingest \| Recovered Page/g)).toHaveLength(1);
  });

  // 1. Creates page file
  it("creates the wiki page file with correct content", async () => {
    const opts = makeOpts();
    await writeWikiPageWithSideEffects(opts);

    const page = await readWikiPage("test-page");
    expect(page).not.toBeNull();
    expect(page!.content).toBe(opts.content);
    expect(page!.slug).toBe("test-page");
  });

  // 2. Creates index entry
  it("creates an index entry with slug, title, and summary", async () => {
    await writeWikiPageWithSideEffects(makeOpts());

    const index = await readIndex();
    expect(index).toContain("test-page.md");
    expect(index).toContain("Test Page");
    expect(index).toContain("A test page");
  });

  // 3. Updates existing index entry (no duplicates)
  it("updates existing index entry without creating duplicates", async () => {
    await writeWikiPageWithSideEffects(makeOpts());
    await writeWikiPageWithSideEffects(
      makeOpts({ summary: "Updated summary" }),
    );

    const index = await readIndex();
    // Should only have one line with "test-page"
    const matches = index.match(/test-page\.md/g);
    expect(matches).toHaveLength(1);
    // Should have the updated summary
    expect(index).toContain("Updated summary");
    expect(index).not.toContain("A test page");
  });

  // Embedding: skipped for saved html artifacts, run for normal pages.
  it("embeds a normal page but SKIPS embedding for an html artifact", async () => {
    vi.spyOn(config, "getVectorSearchSettings").mockReturnValue({
      enabled: true,
      provider: null,
      baseUrl: null,
      model: null,
      hasKey: false,
    });
    const spy = vi.spyOn(embeddings, "upsertEmbedding").mockResolvedValue();

    await writeWikiPageWithSideEffects(makeOpts({ slug: "normal-page" }));
    expect(spy).toHaveBeenCalledWith("normal-page", expect.any(String));

    spy.mockClear();
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "html-artifact",
        content: serializeFrontmatter(
          { type: "html" },
          "<!doctype html><html><body>chart</body></html>",
        ),
      }),
    );
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("does not embed when vector search is off", async () => {
    vi.spyOn(config, "getVectorSearchSettings").mockReturnValue({
      enabled: false,
      provider: null,
      baseUrl: null,
      model: null,
      hasKey: false,
    });
    const spy = vi.spyOn(embeddings, "upsertEmbedding").mockResolvedValue();
    await writeWikiPageWithSideEffects(makeOpts({ slug: "no-embed" }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // 4. Appends to log
  it("appends an entry to log.md with correct operation", async () => {
    await writeWikiPageWithSideEffects(
      makeOpts({ logOp: "ingest" }),
    );

    const log = await readLog();
    expect(log).not.toBeNull();
    expect(log).toContain("ingest");
    expect(log).toContain("Test Page");
  });

  it("appends log with different operations", async () => {
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "page-a", title: "Page A", logOp: "edit" }),
    );

    const log = await readLog();
    expect(log).toContain("edit");
    expect(log).toContain("Page A");
  });

  // 5. Cross-referencing — when crossRefSource mentions an existing page
  // (Note: cross-referencing depends on LLM via findRelatedPages, which
  //  returns [] when no LLM key is set. We test updateRelatedPages directly
  //  by pre-creating pages and relying on the null-skip path.)
  it("skips cross-referencing when crossRefSource is null", async () => {
    // Create an existing page
    await writeWikiPage("existing", "# Existing\n\nContent.\n");
    await updateIndex([
      { title: "Existing", slug: "existing", summary: "An existing page" },
    ]);

    await writeWikiPageWithSideEffects(
      makeOpts({ crossRefSource: null }),
    );

    // The existing page should NOT have been modified with a See also
    const existingPage = await readWikiPage("existing");
    expect(existingPage).not.toBeNull();
    expect(existingPage!.content).not.toContain("See also");
  });

  // 6. Skip cross-ref when null — updatedSlugs should be empty
  it("returns empty updatedSlugs when crossRefSource is null", async () => {
    const result = await writeWikiPageWithSideEffects(
      makeOpts({ crossRefSource: null }),
    );
    expect(result.updatedSlugs).toEqual([]);
  });

  // 7. Custom logDetails
  it("uses logDetails callback and includes its return value in the log", async () => {
    await writeWikiPageWithSideEffects(
      makeOpts({
        crossRefSource: null,
        logDetails: ({ updatedSlugs }) =>
          `custom-detail: updated ${updatedSlugs.length} pages`,
      }),
    );

    const log = await readLog();
    expect(log).not.toBeNull();
    expect(log).toContain("custom-detail: updated 0 pages");
  });

  it("logDetails receives updatedSlugs from cross-ref phase", async () => {
    let receivedSlugs: string[] | undefined;
    await writeWikiPageWithSideEffects(
      makeOpts({
        crossRefSource: null,
        logDetails: ({ updatedSlugs }) => {
          receivedSlugs = updatedSlugs;
          return "details";
        },
      }),
    );
    expect(receivedSlugs).toBeDefined();
    expect(Array.isArray(receivedSlugs)).toBe(true);
  });

  // 8. Validates slug
  it("rejects empty slug", async () => {
    await expect(
      writeWikiPageWithSideEffects(makeOpts({ slug: "" })),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("rejects path traversal slug", async () => {
    await expect(
      writeWikiPageWithSideEffects(makeOpts({ slug: "../etc" })),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("rejects uppercase slug", async () => {
    await expect(
      writeWikiPageWithSideEffects(makeOpts({ slug: "UpperCase" })),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("rejects slug with path separators", async () => {
    await expect(
      writeWikiPageWithSideEffects(makeOpts({ slug: "a/b" })),
    ).rejects.toThrow(/invalid slug/i);
  });

  // Additional write tests
  it("returns the correct slug", async () => {
    const result = await writeWikiPageWithSideEffects(makeOpts());
    expect(result.slug).toBe("test-page");
  });

  it("handles multiple pages in index correctly", async () => {
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "alpha", title: "Alpha", summary: "First", crossRefSource: null }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "beta", title: "Beta", summary: "Second", crossRefSource: null }),
    );

    const index = await readIndex();
    expect(index).toContain("alpha.md");
    expect(index).toContain("beta.md");
    expect(index).toContain("Alpha");
    expect(index).toContain("Beta");
  });

  it("preserves existing index entries when adding new pages", async () => {
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "first", title: "First", summary: "One", crossRefSource: null }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "second", title: "Second", summary: "Two", crossRefSource: null }),
    );

    const entries = await listWikiPages();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.slug)).toContain("first");
    expect(entries.map((e) => e.slug)).toContain("second");
  });

  it("serializes shared index read-modify-write across simulated Worker isolates", async () => {
    _setDurableLocksForTests(true);
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    let releaseRead!: () => void;
    let firstIndexRead!: () => void;
    const paused = new Promise<void>((resolve) => { firstIndexRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    let indexReads = 0;
    vi.spyOn(storage, "readFile").mockImplementation(async (rel) => {
      if (String(rel).endsWith("index.md")) {
        indexReads += 1;
        if (indexReads === 1) {
          firstIndexRead();
          await release;
        }
      }
      return originalRead(rel);
    });

    const first = writeWikiPageWithSideEffects(
      makeOpts({ slug: "isolate-one", title: "Isolate One", crossRefSource: null }),
    );
    await paused;
    _resetLocks();
    const second = writeWikiPageWithSideEffects(
      makeOpts({ slug: "isolate-two", title: "Isolate Two", crossRefSource: null }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(indexReads).toBe(1);

    releaseRead();
    await Promise.all([first, second]);
    const slugs = (await listWikiPages()).map((entry) => entry.slug);
    expect(slugs).toEqual(expect.arrayContaining(["isolate-one", "isolate-two"]));
  }, 15_000);

  it("serializes one Page and its derived metadata across simulated Worker isolates", async () => {
    const initial = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Shared\n\nInitial.",
    );
    await writeWikiPageWithSideEffects(makeOpts({
      slug: "same-page", title: "Shared", content: initial, summary: "Initial", crossRefSource: null,
    }));
    _setDurableLocksForTests(true);
    const research = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Research title\n\nResearch body.",
    );
    const owner = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Owner title\n\nOwner body.",
    );
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    let paused!: () => void;
    let release!: () => void;
    const atIndex = new Promise<void>((resolve) => { paused = resolve; });
    const continueIndex = new Promise<void>((resolve) => { release = resolve; });
    let pauseOnce = true;
    vi.spyOn(storage, "readFile").mockImplementation(async (rel) => {
      if (pauseOnce && String(rel).endsWith("index.md")) {
        pauseOnce = false;
        paused();
        await continueIndex;
      }
      return originalRead(rel);
    });

    const first = writeWikiPageWithSideEffects(makeOpts({
      slug: "same-page", title: "Research title", content: research,
      summary: "Research summary", expectedContent: initial, crossRefSource: null,
    }));
    await atIndex;
    _resetLocks();
    let ownerFinished = false;
    const second = writeWikiPageWithSideEffects(makeOpts({
      slug: "same-page", title: "Owner title", content: owner,
      summary: "Owner summary", expectedContent: research, crossRefSource: null,
    })).then((value) => {
      ownerFinished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ownerFinished).toBe(false);

    release();
    await Promise.all([first, second]);
    expect((await readWikiPage("same-page"))?.content).toBe(owner);
    expect((await listWikiPages()).find((entry) => entry.slug === "same-page"))
      .toMatchObject({ title: "Owner title", summary: "Owner summary", owner: "alice", visibility: "private" });
  }, 15_000);

  it("rejects a stale flat merge base when the authoritative silo has newer bytes", async () => {
    const initial = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Page\n\nInitial.\n",
    );
    await writeWikiPageWithSideEffects(makeOpts({
      slug: "stale-flat",
      title: "Page",
      content: initial,
      crossRefSource: null,
      createOnly: true,
    }));
    const ownerEdit = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Page\n\nOwner edit.\n",
    );
    await getStorage().writeFile("tenants/alice/wiki/stale-flat.md", ownerEdit);
    const staleAutomation = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Page\n\nStale automation.\n",
    );

    await expect(writeWikiPageWithSideEffects(makeOpts({
      slug: "stale-flat",
      title: "Page",
      content: staleAutomation,
      crossRefSource: null,
      expectedContent: initial,
    }))).rejects.toThrow(/changed/i);
    expect(await getStorage().readFile("tenants/alice/wiki/stale-flat.md"))
      .toBe(ownerEdit);
  });

  it("prefers the globally indexed owner over a caller's crash-recovery hint", async () => {
    const bob = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Shared slug\n\nBob committed this Page.\n",
    );
    await writeWikiPageWithSideEffects(makeOpts({
      slug: "shared-owner",
      title: "Shared slug",
      content: bob,
      crossRefSource: null,
      createOnly: true,
    }));
    await rebuildPageIndex();

    const aliceOrphan = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Shared slug\n\nAlice crash-left orphan.\n",
    );
    await getStorage().writeFile("tenants/alice/wiki/shared-owner.md", aliceOrphan);

    const page = await readWikiPageWithFrontmatter("shared-owner", {
      fresh: true,
      strict: true,
      owner: "alice",
    });
    expect(page?.frontmatter.owner).toBe("bob");
    expect(page?.body).toContain("Bob committed this Page");
    expect(page?.body).not.toContain("Alice crash-left orphan");
  });

  it("recovers a crash-left silo that neither the index nor the flat path knows", async () => {
    // The POSITIVE twin of the case above, and the branch DW-432's ingest-
    // history orphan listing stands on. Every other owner-hint case in this
    // repo names an already-committed slug and asserts the hint must NOT
    // displace it; none proves the hint ever resolves anything. Break this
    // branch and that listing silently becomes a no-op for its primary orphan
    // class — a first write whose silo landed before its flat copy and index
    // entry did — with nothing going red.
    const orphan = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Crash left\n\nAlice's silo landed; the flat copy never did.\n",
    );
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/wiki/silo-only.md`,
      orphan,
    );
    await rebuildPageIndex();

    // The drift is real, not a fixture shortcut: no index row, no flat copy.
    expect((await listWikiPages()).map((e) => e.slug)).not.toContain(
      "silo-only",
    );
    await expect(
      getStorage().fileExists("wiki/silo-only.md"),
    ).resolves.toBe(false);

    const page = await readWikiPageWithFrontmatter("silo-only", {
      fresh: true,
      strict: true,
      owner: "alice",
    });

    expect(page?.frontmatter.owner).toBe("alice");
    expect(page?.body).toContain("Alice's silo landed");

    // …and it stays invisible WITHOUT the hint, which is what makes the hint —
    // rather than some other fallback — the thing this case actually pins.
    await expect(
      readWikiPageWithFrontmatter("silo-only", { fresh: true, strict: true }),
    ).resolves.toBeNull();
  });

  it("leaves no global Page when authoritative create fails and succeeds on retry", async () => {
    const content = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Partial\n\nRetryable publication.\n",
    );
    const options = makeOpts({
      slug: "partial-create",
      title: "Partial",
      content,
      crossRefSource: null,
      createOnly: true,
    });
    const storage = getStorage();
    const originalCreate = storage.writeFileIfAbsent.bind(storage);
    let failSilo = true;
    const createSpy = vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(
      async (target, body) => {
        if (failSilo && target === "tenants/alice/wiki/partial-create.md") {
          throw new Error("silo unavailable");
        }
        return originalCreate(target, body);
      },
    );

    await expect(writeWikiPageWithSideEffects(options)).rejects.toThrow("silo unavailable");
    await expect(storage.fileExists("wiki/partial-create.md")).resolves.toBe(false);
    await expect(readWikiPage("partial-create", { fresh: true, strict: true }))
      .resolves.toBeNull();

    failSilo = false;
    await expect(writeWikiPageWithSideEffects(options)).resolves.toMatchObject({
      slug: "partial-create",
    });
    createSpy.mockRestore();
    expect((await readWikiPageWithFrontmatter("partial-create", {
      fresh: true,
      strict: true,
    }))?.frontmatter.owner).toBe("alice");
  });

  it("compensates a new silo when the global slug claim is already held", async () => {
    const alice = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Shared\n\nAlice.\n",
    );
    const storage = getStorage();
    const originalCreate = storage.writeFileIfAbsent.bind(storage);
    let injectClaim = true;
    const createSpy = vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(async (target, body) => {
      const created = await originalCreate(target, body);
      if (injectClaim && target === "tenants/alice/wiki/claimed-create.md") {
        injectClaim = false;
        await storage.writeFile(
          "wiki/claimed-create.md",
          serializeFrontmatter({ owner: "bob", visibility: "private" }, "# Shared\n\nBob.\n"),
        );
      }
      return created;
    });
    const options = makeOpts({
      slug: "claimed-create",
      title: "Shared",
      content: alice,
      crossRefSource: null,
      createOnly: true,
    });

    await expect(writeWikiPageWithSideEffects(options)).rejects.toThrow(/already exists/i);
    await expect(storage.fileExists("tenants/alice/wiki/claimed-create.md"))
      .resolves.toBe(false);

    await storage.deleteFile("wiki/claimed-create.md");
    await expect(writeWikiPageWithSideEffects(options)).resolves.toMatchObject({
      slug: "claimed-create",
    });
    createSpy.mockRestore();
  });

  it("fails a slug authorization check closed when its authoritative silo cannot be read", async () => {
    const content = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Private\n\nSecret Page.\n",
    );
    await writeWikiPageWithSideEffects(makeOpts({
      slug: "authz-read-failure",
      title: "Private",
      content,
      crossRefSource: null,
      createOnly: true,
    }));
    await rebuildPageIndex();

    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (target) => {
      if (target === "tenants/alice/wiki/authz-read-failure.md") {
        throw new Error("injected authoritative read failure");
      }
      return originalRead(target);
    });

    await expect(canReadSlug("authz-read-failure", null)).resolves.toBe(false);
  });

  it("crossRefSource defaults to content when undefined", async () => {
    // Without an LLM key, findRelatedPages returns []. We just verify
    // it doesn't throw and completes successfully (exercising the
    // undefined → use content path).
    const result = await writeWikiPageWithSideEffects(
      makeOpts({ crossRefSource: undefined }),
    );
    expect(result.slug).toBe("test-page");
    expect(result.updatedSlugs).toEqual([]);
  });
});

// ===========================================================================
// deleteWikiPage
// ===========================================================================

describe("deleteWikiPage", () => {
  // 9. Deletes page file
  it("removes the wiki page file from disk", async () => {
    await writeWikiPage("to-delete", "# To Delete\n\nContent.\n");
    await updateIndex([
      { title: "To Delete", slug: "to-delete", summary: "Will be deleted" },
    ]);

    await deleteWikiPage("to-delete");

    const page = await readWikiPage("to-delete");
    expect(page).toBeNull();
  });

  // 10. Removes index entry
  it("removes the slug from index.md", async () => {
    await writeWikiPage("removeme", "# Remove Me\n\nBye.\n");
    await updateIndex([
      { title: "Keep", slug: "keep", summary: "Stays" },
      { title: "Remove Me", slug: "removeme", summary: "Goes away" },
    ]);
    // Also create the "keep" page so it exists
    await writeWikiPage("keep", "# Keep\n\nStaying.\n");

    await deleteWikiPage("removeme");

    const index = await readIndex();
    expect(index).not.toContain("removeme");
    expect(index).toContain("keep");
  });

  // 11. Returns removedFromIndex: true
  it("returns removedFromIndex: true when slug was in index", async () => {
    await writeWikiPage("indexed", "# Indexed\n\nContent.\n");
    await updateIndex([
      { title: "Indexed", slug: "indexed", summary: "In the index" },
    ]);

    const result = await deleteWikiPage("indexed");
    expect(result.removedFromIndex).toBe(true);
  });

  // 12. Returns removedFromIndex: false when slug wasn't in index
  it("returns removedFromIndex: false when slug was not in index", async () => {
    await writeWikiPage("unindexed", "# Unindexed\n\nContent.\n");
    // Don't add to index, but ensure index exists
    await updateIndex([]);

    const result = await deleteWikiPage("unindexed");
    expect(result.removedFromIndex).toBe(false);
  });

  // 13. Strips backlinks from other pages
  it("strips backlinks to the deleted page from other pages", async () => {
    await writeWikiPage("page-a", "# Page A\n\nSee [Target](target.md).\n");
    await writeWikiPage("target", "# Target\n\nI'm the target.\n");
    await updateIndex([
      { title: "Page A", slug: "page-a", summary: "Has a link" },
      { title: "Target", slug: "target", summary: "The target" },
    ]);

    await deleteWikiPage("target");

    const pageA = await readWikiPage("page-a");
    expect(pageA).not.toBeNull();
    expect(pageA!.content).not.toContain("target.md");
    expect(pageA!.content).not.toContain("[Target]");
  });

  // 14. Returns strippedBacklinksFrom list
  it("returns strippedBacklinksFrom with correct slugs", async () => {
    await writeWikiPage(
      "linker",
      "# Linker\n\nPoints to [Victim](victim.md).\n",
    );
    await writeWikiPage("victim", "# Victim\n\nAbout to be deleted.\n");
    await writeWikiPage("bystander", "# Bystander\n\nNo links here.\n");
    await updateIndex([
      { title: "Linker", slug: "linker", summary: "Has link" },
      { title: "Victim", slug: "victim", summary: "Target" },
      { title: "Bystander", slug: "bystander", summary: "Innocent" },
    ]);

    const result = await deleteWikiPage("victim");
    expect(result.strippedBacklinksFrom).toContain("linker");
    expect(result.strippedBacklinksFrom).not.toContain("bystander");
  });

  it("serializes target recreation after delete backlink cleanup", async () => {
    await writeWikiPage("linker", "# Linker\n\nSee [Target](target.md).\n");
    await writeWikiPage("target", "# Target\n\nOld target.\n");
    await updateIndex([
      { title: "Linker", slug: "linker", summary: "Has link" },
      { title: "Target", slug: "target", summary: "Target" },
    ]);

    let releaseLinker!: () => void;
    let markLinkerHeld!: () => void;
    const linkerHeld = new Promise<void>((resolve) => { markLinkerHeld = resolve; });
    const held = withDurableLock("page-lifecycle:linker", async () => {
      markLinkerHeld();
      await new Promise<void>((resolve) => { releaseLinker = resolve; });
    });
    await linkerHeld;

    const deleting = deleteWikiPage("target");
    while (await readWikiPage("target", { fresh: true })) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const recreating = writeWikiPageWithSideEffects({
      slug: "target",
      title: "Target",
      content: "# Target\n\nRecreated target.\n",
      summary: "Recreated",
      logOp: "edit",
      crossRefSource: null,
      createOnly: true,
    });
    releaseLinker();
    await held;
    const result = await deleting;
    await recreating;

    expect((await readWikiPage("target"))!.content).toContain("Recreated target");
    expect((await readWikiPage("linker"))!.content).not.toContain("target.md");
    expect(result.strippedBacklinksFrom).toContain("linker");
  }, 15_000);

  it("retries backlink stripping against a concurrent owner edit", async () => {
    await writeWikiPage("linker", "# Linker\n\nSee [Target](target.md).\n");
    await writeWikiPage("target", "# Target\n\nOld target.\n");
    await updateIndex([
      { title: "Linker", slug: "linker", summary: "Has link" },
      { title: "Target", slug: "target", summary: "Target" },
    ]);

    let releaseLinker!: () => void;
    let markLinkerHeld!: () => void;
    const linkerHeld = new Promise<void>((resolve) => { markLinkerHeld = resolve; });
    const held = withDurableLock("page-lifecycle:linker", async () => {
      markLinkerHeld();
      await new Promise<void>((resolve) => { releaseLinker = resolve; });
    });
    await linkerHeld;

    const deleting = deleteWikiPage("target");
    while (await readWikiPage("target", { fresh: true })) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await writeWikiPage(
      "linker",
      "# Linker\n\nOwner edit retained [Target](target.md).\n",
    );
    releaseLinker();
    await held;
    const result = await deleting;

    const linker = await readWikiPage("linker");
    expect(linker!.content).toContain("Owner edit retained");
    expect(linker!.content).not.toContain("target.md");
    expect(result.strippedBacklinksFrom).toContain("linker");
  }, 15_000);

  it("fails closed for a nested slug after a page-index sync failure", async () => {
    const publicContent = serializeFrontmatter(
      { owner: "alice", visibility: "public" },
      "# Secret\n\nSensitive body.\n",
    );
    await writeWikiPageWithSideEffects({
      slug: "queries/secret",
      title: "Secret",
      content: publicContent,
      summary: "Sensitive",
      logOp: "edit",
      crossRefSource: null,
      createOnly: true,
    });
    await rebuildPageIndex();

    const storage = getStorage();
    const originalWrite = storage.writeFile.bind(storage);
    const writeSpy = vi.spyOn(storage, "writeFile").mockImplementation(
      async (target, content) => {
        if (target === "derived-indexes/pages.json") {
          throw new Error("page index unavailable");
        }
        return originalWrite(target, content);
      },
    );
    const privateContent = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Secret\n\nSensitive body.\n",
    );
    await writeWikiPageWithSideEffects({
      slug: "queries/secret",
      title: "Secret",
      content: privateContent,
      summary: "Sensitive",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: publicContent,
    });
    writeSpy.mockRestore();

    expect(await getPageIndexDirtySlugs()).toContain("queries/secret");
    expect((await listReadableWikiPages(null)).map((entry) => entry.slug))
      .not.toContain("queries/secret");
    expect((await listReadableWikiPages({ id: "alice-id", handle: "alice" }))
      .map((entry) => entry.slug)).toContain("queries/secret");
  });

  it("keeps the privacy dirty marker when page-index sync cannot read its base", async () => {
    const publicContent = serializeFrontmatter(
      { owner: "alice", visibility: "public" },
      "# Secret Read\n\nSensitive body.\n",
    );
    await writeWikiPageWithSideEffects({
      slug: "secret-read",
      title: "Secret Read",
      content: publicContent,
      summary: "Sensitive",
      logOp: "edit",
      crossRefSource: null,
      createOnly: true,
    });
    await rebuildPageIndex();

    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    let pageIndexReads = 0;
    const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (target) => {
      if (target === "derived-indexes/pages.json" && ++pageIndexReads === 2) {
        throw new Error("page index read unavailable");
      }
      return originalRead(target);
    });
    const privateContent = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Secret Read\n\nSensitive body.\n",
    );
    await writeWikiPageWithSideEffects({
      slug: "secret-read",
      title: "Secret Read",
      content: privateContent,
      summary: "Sensitive",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: publicContent,
    });
    readSpy.mockRestore();

    expect((await listReadableWikiPages(null)).map((entry) => entry.slug))
      .not.toContain("secret-read");
  });

  it("does not expose a stale public flat copy during a later page-index outage", async () => {
    const publicContent = serializeFrontmatter(
      { owner: "alice", visibility: "public" },
      "# Index Outage\n\nPublic body.\n",
    );
    await writeWikiPageWithSideEffects({
      slug: "index-outage",
      title: "Index Outage",
      content: publicContent,
      summary: "Public",
      logOp: "edit",
      crossRefSource: null,
      createOnly: true,
    });
    await rebuildPageIndex();

    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    const matchSpy = vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => {
        if (target === "wiki/index-outage.md") return false;
        return originalMatch(target, content, etag);
      },
    );
    const privateContent = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Index Outage\n\nPrivate body.\n",
    );
    await writeWikiPageWithSideEffects({
      slug: "index-outage",
      title: "Index Outage",
      content: privateContent,
      summary: "Private",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: publicContent,
    });
    matchSpy.mockRestore();

    expect(await storage.readFile("wiki/index-outage.md")).toBe(publicContent);
    expect(await getPageIndexDirtySlugs()).not.toContain("index-outage");

    const originalRead = storage.readFile.bind(storage);
    let failIndexOnce = true;
    const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (target) => {
      if (target === "derived-indexes/pages.json" && failIndexOnce) {
        failIndexOnce = false;
        throw new Error("transient page-index outage");
      }
      return originalRead(target);
    });

    expect((await listReadableWikiPages(null)).map((entry) => entry.slug))
      .not.toContain("index-outage");
    failIndexOnce = true;
    const direct = await readWikiPageWithFrontmatter("index-outage", { fresh: true });
    expect(direct?.frontmatter.visibility).toBe("private");
    expect(direct?.body).toContain("Private body");
    readSpy.mockRestore();
  });

  // 14b. Backlink-strip revisions carry author="system"
  it("creates a revision with author 'system' when stripping backlinks", async () => {
    await writeWikiPage(
      "linker2",
      "# Linker2\n\nPoints to [Gone](gone-page.md).\n",
    );
    await writeWikiPage("gone-page", "# Gone\n\nAbout to be deleted.\n");
    await updateIndex([
      { title: "Linker2", slug: "linker2", summary: "Has link" },
      { title: "Gone", slug: "gone-page", summary: "Target" },
    ]);

    await deleteWikiPage("gone-page");

    const revs = await listRevisions("linker2");
    expect(revs.length).toBeGreaterThanOrEqual(1);
    const meta = await readRevisionMeta("linker2", revs[0].timestamp);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("system");
    expect(meta!.reason).toBe("backlink strip");
  });

  // 15. Tolerates already-deleted file
  // deleteWikiPage reads the page first (to get the title), so it throws
  // "page not found" if the file is already gone. This is the expected
  // behavior — the ENOENT tolerance in runPageLifecycleOp is a safety net
  // for race conditions (file deleted between readWikiPage and fs.unlink).
  it("throws when the page file does not exist", async () => {
    await updateIndex([]);
    await expect(deleteWikiPage("nonexistent")).rejects.toThrow(
      /page not found/i,
    );
  });

  // 16. Deletes revisions
  it("cleans up revision files for the deleted slug", async () => {
    await writeWikiPage("rev-page", "# Rev Page\n\nVersion 1.\n");
    await updateIndex([
      { title: "Rev Page", slug: "rev-page", summary: "Has revisions" },
    ]);

    // Create some revisions (add small delay to ensure distinct timestamps)
    await saveRevision("rev-page", "# Rev Page\n\nOld version.\n");
    await new Promise((r) => setTimeout(r, 15));
    await saveRevision("rev-page", "# Rev Page\n\nOlder version.\n");
    await saveRevision("rev-page", "# Rev Page\n\nTenant version.\n", undefined, undefined, "yopedia");

    // Verify revisions exist
    const revsBefore = await listRevisions("rev-page");
    expect(revsBefore.length).toBeGreaterThanOrEqual(1);
    expect(await listRevisions("rev-page", "yopedia")).toHaveLength(1);

    await deleteWikiPage("rev-page");

    // Revisions should be gone
    const revsAfter = await listRevisions("rev-page");
    expect(revsAfter).toHaveLength(0);
    expect(await listRevisions("rev-page", "yopedia")).toHaveLength(0);
  });

  it("keeps the Page retryable when required tenant revision erasure fails", async () => {
    await writeWikiPage("rev-page", "# Rev Page\n\nVersion 1.\n");
    await updateIndex([
      { title: "Rev Page", slug: "rev-page", summary: "Has revisions" },
    ]);
    await saveRevision("rev-page", "# Rev Page\n\nTenant history.\n", undefined, undefined, "yopedia");
    const storage = getStorage();
    const originalDeleteDirectory = storage.deleteDirectory.bind(storage);
    let failTenantCleanup = true;
    vi.spyOn(storage, "deleteDirectory").mockImplementation(async (target) => {
      if (failTenantCleanup && target === "tenants/yopedia/wiki/.revisions/rev-page") {
        failTenantCleanup = false;
        throw new Error("tenant revision store unavailable");
      }
      return originalDeleteDirectory(target);
    });

    await expect(deleteWikiPage("rev-page"))
      .rejects.toThrow(/tenant revision store unavailable/i);
    expect(await readWikiPage("rev-page", { fresh: true, strict: true })).not.toBeNull();
    expect(await listRevisions("rev-page", "yopedia")).toHaveLength(1);

    await deleteWikiPage("rev-page");
    expect(await readWikiPage("rev-page", { fresh: true, strict: true })).toBeNull();
    expect(await listRevisions("rev-page", "yopedia")).toHaveLength(0);
  });

  // 17. Validates slug
  it("rejects empty slug on delete", async () => {
    await expect(deleteWikiPage("")).rejects.toThrow(/invalid slug/i);
  });

  it("rejects path traversal slug on delete", async () => {
    await expect(deleteWikiPage("../etc")).rejects.toThrow(/invalid slug/i);
  });

  it("rejects uppercase slug on delete", async () => {
    await expect(deleteWikiPage("BadSlug")).rejects.toThrow(/invalid slug/i);
  });

  // Additional delete tests
  it("appends a delete entry to the log", async () => {
    await writeWikiPage("logged", "# Logged\n\nContent.\n");
    await updateIndex([
      { title: "Logged", slug: "logged", summary: "Will be logged" },
    ]);

    await deleteWikiPage("logged");

    const log = await readLog();
    expect(log).not.toBeNull();
    expect(log).toContain("delete");
    expect(log).toContain("Logged");
  });

  it("log details include stripped backlinks count", async () => {
    await writeWikiPage(
      "ref-page",
      "# Ref Page\n\nLinks to [Gone](gone.md).\n",
    );
    await writeWikiPage("gone", "# Gone\n\nBye.\n");
    await updateIndex([
      { title: "Ref Page", slug: "ref-page", summary: "Has ref" },
      { title: "Gone", slug: "gone", summary: "Going away" },
    ]);

    await deleteWikiPage("gone");

    const log = await readLog();
    expect(log).toContain("stripped backlinks from 1 page(s)");
  });

  it("returns the correct slug in the result", async () => {
    await writeWikiPage("my-page", "# My Page\n\nContent.\n");
    await updateIndex([
      { title: "My Page", slug: "my-page", summary: "My page" },
    ]);

    const result = await deleteWikiPage("my-page");
    expect(result.slug).toBe("my-page");
  });
});

// ===========================================================================
// stripBacklinksTo (tested indirectly via deleteWikiPage)
// ===========================================================================

describe("stripBacklinksTo (via deleteWikiPage)", () => {
  // 18. Strips markdown links
  it("removes [text](slug.md) links from other pages", async () => {
    await writeWikiPage(
      "source",
      "# Source\n\nRead more at [My Target](my-target.md) for details.\n",
    );
    await writeWikiPage("my-target", "# My Target\n\nTarget content.\n");
    await updateIndex([
      { title: "Source", slug: "source", summary: "Has link" },
      { title: "My Target", slug: "my-target", summary: "Target" },
    ]);

    await deleteWikiPage("my-target");

    const source = await readWikiPage("source");
    expect(source).not.toBeNull();
    expect(source!.content).not.toContain("my-target.md");
    expect(source!.content).not.toContain("[My Target]");
  });

  // 19. Cleans empty See also lines
  it("removes empty See also line when the only link is deleted", async () => {
    await writeWikiPage(
      "host",
      "# Host\n\nContent.\n\n**See also:** [Only Link](only-link.md)\n",
    );
    await writeWikiPage("only-link", "# Only Link\n\nTarget.\n");
    await updateIndex([
      { title: "Host", slug: "host", summary: "Has see also" },
      { title: "Only Link", slug: "only-link", summary: "Only" },
    ]);

    await deleteWikiPage("only-link");

    const host = await readWikiPage("host");
    expect(host).not.toBeNull();
    expect(host!.content).not.toContain("See also:");
    expect(host!.content).not.toContain("only-link.md");
  });

  // 20. Fixes orphaned commas
  it("collapses orphaned commas when middle link is removed", async () => {
    await writeWikiPage(
      "hub",
      "# Hub\n\nText.\n\n**See also:** [A](a.md), [B](b.md), [C](c.md)\n",
    );
    await writeWikiPage("a", "# A\n\nContent A.\n");
    await writeWikiPage("b", "# B\n\nContent B.\n");
    await writeWikiPage("c", "# C\n\nContent C.\n");
    await updateIndex([
      { title: "Hub", slug: "hub", summary: "Hub page" },
      { title: "A", slug: "a", summary: "A" },
      { title: "B", slug: "b", summary: "B" },
      { title: "C", slug: "c", summary: "C" },
    ]);

    await deleteWikiPage("b");

    const hub = await readWikiPage("hub");
    expect(hub).not.toBeNull();
    // Should not have double commas
    expect(hub!.content).not.toContain(", ,");
    // Should still link to A and C
    expect(hub!.content).toContain("[A](a.md)");
    expect(hub!.content).toContain("[C](c.md)");
  });

  // 21. Collapses excessive blank lines
  it("collapses 3+ blank lines into 2", async () => {
    // Create a page with a link that, when removed, would leave multiple blank lines
    await writeWikiPage(
      "spacey",
      "# Spacey\n\nParagraph one.\n\n[Gone](gone.md)\n\n\n\nParagraph two.\n",
    );
    await writeWikiPage("gone", "# Gone\n\nContent.\n");
    await updateIndex([
      { title: "Spacey", slug: "spacey", summary: "Has spaces" },
      { title: "Gone", slug: "gone", summary: "Going away" },
    ]);

    await deleteWikiPage("gone");

    const spacey = await readWikiPage("spacey");
    expect(spacey).not.toBeNull();
    // Should not have 3+ consecutive newlines
    expect(spacey!.content).not.toMatch(/\n{3,}/);
  });

  it("cleans up when the first link is removed from See also", async () => {
    await writeWikiPage(
      "ref",
      "# Ref\n\nText.\n\n**See also:** [First](first.md), [Second](second.md)\n",
    );
    await writeWikiPage("first", "# First\n\nContent.\n");
    await writeWikiPage("second", "# Second\n\nContent.\n");
    await updateIndex([
      { title: "Ref", slug: "ref", summary: "Reference" },
      { title: "First", slug: "first", summary: "First" },
      { title: "Second", slug: "second", summary: "Second" },
    ]);

    await deleteWikiPage("first");

    const ref = await readWikiPage("ref");
    expect(ref).not.toBeNull();
    // Should cleanly have just second left, no leading comma
    expect(ref!.content).toContain("**See also:** [Second](second.md)");
    expect(ref!.content).not.toMatch(/\*\*See also:\*\*\s*,/);
  });

  it("handles multiple backlinks across different pages", async () => {
    await writeWikiPage(
      "page-x",
      "# Page X\n\nLinks to [Target](target.md).\n",
    );
    await writeWikiPage(
      "page-y",
      "# Page Y\n\nAlso links to [Target](target.md).\n",
    );
    await writeWikiPage("target", "# Target\n\nTarget content.\n");
    await updateIndex([
      { title: "Page X", slug: "page-x", summary: "X" },
      { title: "Page Y", slug: "page-y", summary: "Y" },
      { title: "Target", slug: "target", summary: "Target" },
    ]);

    const result = await deleteWikiPage("target");

    expect(result.strippedBacklinksFrom).toContain("page-x");
    expect(result.strippedBacklinksFrom).toContain("page-y");
    expect(result.strippedBacklinksFrom).toHaveLength(2);

    // Both pages should no longer link to target
    const px = await readWikiPage("page-x");
    const py = await readWikiPage("page-y");
    expect(px!.content).not.toContain("target.md");
    expect(py!.content).not.toContain("target.md");
  });
});

// ===========================================================================
// Alias index integration — lifecycle write updates alias index
// ===========================================================================

describe("lifecycle write triggers alias index update", () => {
  it("page with aliases is resolvable via resolveAlias after write", async () => {
    // Build the alias index first (so the cached index exists)
    await buildAliasIndex();

    // Write a page with aliases via the lifecycle pipeline
    const content = serializeFrontmatter(
      {
        created: "2026-01-01",
        updated: "2026-01-01",
        aliases: ["ReactJS", "React.js"],
      },
      "# React\n\nA JavaScript library for building user interfaces.\n",
    );

    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "react",
        title: "React",
        content,
        summary: "A JavaScript library for building user interfaces",
      }),
    );

    // The alias index should be updated without a full rebuild
    const result1 = await resolveAlias("ReactJS");
    expect(result1).toBe("react");

    const result2 = await resolveAlias("React.js");
    expect(result2).toBe("react");

    const result3 = await resolveAlias("React");
    expect(result3).toBe("react");
  });

  it("page without aliases still registers title in alias index", async () => {
    await buildAliasIndex();

    const content = "# Vue\n\nA progressive JavaScript framework.\n";
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "vue",
        title: "Vue",
        content,
        summary: "A progressive JavaScript framework",
      }),
    );

    const result = await resolveAlias("Vue");
    expect(result).toBe("vue");
  });

  it("page without frontmatter still registers title in alias index", async () => {
    await buildAliasIndex();

    // No frontmatter at all — should still register title
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "svelte",
        title: "Svelte",
        content: "# Svelte\n\nCybernetically enhanced web apps.\n",
        summary: "Cybernetically enhanced web apps",
      }),
    );

    const result = await resolveAlias("Svelte");
    expect(result).toBe("svelte");
  });
});

// ---------------------------------------------------------------------------
// Per-tenant silo mirror (P5a) — every write/delete mirrors the page into
// tenants/<tenant>/, keeping each silo a live vault.
// ---------------------------------------------------------------------------
describe("per-tenant silo mirror", () => {
  it("mirrors a written page into its owner's silo (tenants/<tenant>/wiki)", async () => {
    await writeWikiPageWithSideEffects({
      slug: "alpha",
      title: "Alpha",
      content: serializeFrontmatter(
        { owner: "Alice", visibility: "public" },
        "# Alpha\n\nBody.",
      ),
      summary: "first",
      logOp: "ingest",
      crossRefSource: null,
    });

    // Owner "Alice" → tenant "alice" (lowercased).
    const mirrored = await getStorage().readFile(
      "tenants/alice/wiki/alpha.md",
    );
    expect(mirrored).toContain("# Alpha");
    expect(mirrored).toContain("owner: Alice");
  });

  it("ownerless pages mirror into the yopedia silo", async () => {
    await writeWikiPageWithSideEffects({
      slug: "seed",
      title: "Seed",
      content: "# Seed\n\nNo owner.",
      summary: "seed",
      logOp: "ingest",
      crossRefSource: null,
    });
    expect(
      await getStorage().fileExists("tenants/yopedia/wiki/seed.md"),
    ).toBe(true);
  });

  it("deleting a page removes it from its silo", async () => {
    await writeWikiPageWithSideEffects({
      slug: "doomed",
      title: "Doomed",
      content: serializeFrontmatter({ owner: "bob" }, "# Doomed\n\nBye."),
      summary: "x",
      logOp: "ingest",
      crossRefSource: null,
    });
    expect(
      await getStorage().fileExists("tenants/bob/wiki/doomed.md"),
    ).toBe(true);

    await deleteWikiPage("doomed");
    expect(
      await getStorage().fileExists("tenants/bob/wiki/doomed.md"),
    ).toBe(false);
  });

  it("backlink-strip syncs the stripped page's silo copy", async () => {
    // Page B links to page A. Deleting A should strip the backlink from B
    // AND sync B's silo copy so silo-primary reads see the stripped content.
    const contentB = serializeFrontmatter(
      { owner: "carol" },
      "# Page B\n\nSee [Page A](page-a.md).\n",
    );
    const contentA = serializeFrontmatter(
      { owner: "carol" },
      "# Page A\n\nTarget page.\n",
    );

    await writeWikiPageWithSideEffects({
      slug: "page-b",
      title: "Page B",
      content: contentB,
      summary: "links to A",
      logOp: "ingest",
      crossRefSource: null,
    });
    await writeWikiPageWithSideEffects({
      slug: "page-a",
      title: "Page A",
      content: contentA,
      summary: "target",
      logOp: "ingest",
      crossRefSource: null,
    });

    // Verify B's silo has the backlink before deletion.
    const siloBefore = await getStorage().readFile(
      "tenants/carol/wiki/page-b.md",
    );
    expect(siloBefore).toContain("page-a.md");

    // Delete page A — this strips the backlink from page B.
    await deleteWikiPage("page-a");

    // Flat copy of B should no longer reference page-a.
    const flatB = await readWikiPage("page-b");
    expect(flatB).not.toBeNull();
    expect(flatB!.content).not.toContain("page-a.md");

    // Silo copy of B should ALSO no longer reference page-a.
    const siloAfter = await getStorage().readFile(
      "tenants/carol/wiki/page-b.md",
    );
    expect(siloAfter).not.toContain("page-a.md");
  });
});

// ===========================================================================
// Recent-trail action labeling — ingested vs re-ingested
// ===========================================================================
describe("recent trail action labeling", () => {
  it("labels a first ingest 'ingested' and a re-ingest 're-ingested'", async () => {
    const { getRecentIndex } = await import("../recent-index");
    // Seed an empty-but-present index so the incremental push isn't a no-op.
    await getStorage().putIndex("recent", []);

    await writeWikiPageWithSideEffects(
      makeOpts({ author: "alice", content: "# Test Page\n\nv1." }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ author: "alice", content: "# Test Page\n\nv2, re-ingested." }),
    );

    const idx = (await getRecentIndex()) ?? [];
    const entries = idx.filter((e) => e.slug === "test-page");
    const actions = entries.map((e) => e.action);
    expect(actions).toHaveLength(2);
    // Exactly one of each — an inverted ternary would yield two of one label.
    expect(actions.filter((a) => a === "ingested")).toHaveLength(1);
    expect(actions.filter((a) => a === "re-ingested")).toHaveLength(1);
    // The push is gated by belongsInCommons, so a public page is flagged commons.
    expect(entries.every((e) => e.commons === true)).toBe(true);
  });

  it("folds an automation author (lint-fix) into the agent on the incremental push", async () => {
    const { getRecentIndex } = await import("../recent-index");
    await getStorage().putIndex("recent", []);

    await writeWikiPageWithSideEffects(
      makeOpts({ author: "lint-fix", content: "# Test Page\n\nv1." }),
    );

    const idx = (await getRecentIndex()) ?? [];
    const ev = idx.find((e) => e.slug === "test-page");
    expect(ev).toBeDefined();
    // Raw "lint-fix" must not leak into the live "Recent" strip — it reads as yoyo.
    expect(ev!.actor).toBe("yoyo");
    expect(ev!.isAgent).toBe(true);
  });

  it("labels a manual edit 'edited', not re-ingested", async () => {
    const { getRecentIndex } = await import("../recent-index");
    await getStorage().putIndex("recent", []);

    await writeWikiPageWithSideEffects(
      makeOpts({ author: "alice", content: "# Test Page\n\nv1." }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ author: "alice", logOp: "edit", content: "# Test Page\n\nedited." }),
    );

    const idx = (await getRecentIndex()) ?? [];
    const actions = idx
      .filter((e) => e.slug === "test-page")
      .map((e) => e.action);
    expect(actions).toContain("ingested");
    expect(actions).toContain("edited");
    expect(actions).not.toContain("re-ingested");
  });

  it("a delete prunes the page from BOTH the global and the owner's per-tenant index", async () => {
    const { getRecentIndex } = await import("../recent-index");
    await getStorage().putIndex("recent", []);
    await getStorage().putIndex("recent:tester", []); // owner tester's profile index

    // An owned, public commons page → its event routes to recent:tester + global.
    const content = serializeFrontmatter(
      { title: "Owned Page", owner: "tester" },
      "# Owned Page\n\nv1.",
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "owned-page", title: "Owned Page", author: "tester", content }),
    );
    expect((await getRecentIndex("tester"))?.some((e) => e.slug === "owned-page")).toBe(true);
    expect((await getRecentIndex())?.some((e) => e.slug === "owned-page")).toBe(true);

    // Delete → pruned from BOTH; the per-tenant key is derived from prevContent's owner.
    await deleteWikiPage("owned-page");
    expect((await getRecentIndex("tester"))?.some((e) => e.slug === "owned-page")).toBe(false);
    expect((await getRecentIndex())?.some((e) => e.slug === "owned-page")).toBe(false);
  });

  it("fans a write out to a CONTRIBUTOR's index, not just the owner's", async () => {
    const { getRecentIndex } = await import("../recent-index");
    await getStorage().putIndex("recent", []);
    await getStorage().putIndex("recent:owner-x", []);
    await getStorage().putIndex("recent:contrib-y", []);

    // Owned by owner-x with contrib-y as a contributor → the page shows on BOTH
    // profiles (slugsForOwner matches owner + contributors), so its activity must
    // reach BOTH per-tenant indexes — else contrib-y's profile trail goes stale.
    const content = serializeFrontmatter(
      { title: "Shared Page", owner: "owner-x", contributors: ["contrib-y"] },
      "# Shared Page\n\nv1.",
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "shared-page", title: "Shared Page", author: "owner-x", content }),
    );

    expect((await getRecentIndex("owner-x"))?.some((e) => e.slug === "shared-page")).toBe(true);
    expect((await getRecentIndex("contrib-y"))?.some((e) => e.slug === "shared-page")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent page cleanup on delete
// ---------------------------------------------------------------------------

describe("agent page cleanup on delete", () => {
  it("removes a deleted slug from an agent's learningPages", async () => {
    // 1. Register an agent with a slug in learningPages.
    const agentProfile = {
      id: "test-agent",
      name: "Test Agent",
      description: "Agent for lifecycle test",
      owner: "tester",
      identityPages: [],
      learningPages: ["test-page"],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    await registerAgent(agentProfile);

    // 2. Create the wiki page via the lifecycle pipeline.
    const content = serializeFrontmatter(
      { title: "Test Page", owner: "tester" },
      "# Test Page\n\nContent.",
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "test-page", title: "Test Page", content }),
    );

    // Verify agent has the slug before delete.
    const before = await getAgent("test-agent");
    expect(before?.learningPages).toContain("test-page");

    // 3. Delete the page via the lifecycle pipeline.
    await deleteWikiPage("test-page");

    // 4. Verify the agent profile no longer references the slug.
    const after = await getAgent("test-agent");
    expect(after).not.toBeNull();
    expect(after!.learningPages).not.toContain("test-page");
  });

  it("removes a slug from multiple page lists and multiple agents", async () => {
    const slug = "shared-page";

    // Agent A has it in identityPages and learningPages.
    await registerAgent({
      id: "agent-a",
      name: "Agent A",
      description: "First agent",
      owner: "owner-a",
      identityPages: [slug, "other-page"],
      learningPages: [slug],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Agent B has it only in socialPages.
    await registerAgent({
      id: "agent-b",
      name: "Agent B",
      description: "Second agent",
      owner: "owner-b",
      identityPages: [],
      learningPages: [],
      socialPages: [slug],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Create and delete the page.
    const content = serializeFrontmatter(
      { title: "Shared Page", owner: "owner-a" },
      "# Shared Page\n\nContent.",
    );
    await writeWikiPageWithSideEffects(
      makeOpts({ slug, title: "Shared Page", content }),
    );
    await deleteWikiPage(slug);

    const agentA = await getAgent("agent-a");
    expect(agentA!.identityPages).not.toContain(slug);
    expect(agentA!.identityPages).toContain("other-page");
    expect(agentA!.learningPages).not.toContain(slug);

    const agentB = await getAgent("agent-b");
    expect(agentB!.socialPages).not.toContain(slug);
  });
});

describe("Stories 2.4–2.12 compile remnants", () => {
  it("regenerates overview.md and writes a Source summary that cites the Source", async () => {
    const { runIngestBookkeeping } = await import("../ingest-bookkeeping");
    await writeWikiPageWithSideEffects(
      makeOpts({ slug: "alpha", title: "Alpha", summary: "First concept" }),
    );
    await runIngestBookkeeping({
      owner: "alice",
      actor: "alice",
      sourceTitle: "Standup",
      sourceText: "We agreed to ship the digest on Friday.",
      sourcePath: "raw/sources/standup/abc.md",
      sourceType: "text",
    });
    const overview = await readWikiPage("overview");
    expect(overview?.content).toContain("# Overview");
    expect(overview?.content).toContain("[[alpha]]");
    expect(overview?.content).not.toMatch(/^sources:/m);
    const pages = await listWikiPages();
    const summary = pages.find((entry) => entry.title.includes("source summary"));
    expect(summary).toBeTruthy();
    const body = await readWikiPage(summary!.slug);
    expect(body?.content).toContain("raw/sources/standup/abc.md");
    expect(body?.content).toContain("We agreed to ship the digest on Friday.");
  });

  it("keeps disputed true when rewriting an existing source summary", async () => {
    const { runIngestBookkeeping } = await import("../ingest-bookkeeping");
    await runIngestBookkeeping({
      owner: "alice",
      actor: "alice",
      sourceTitle: "Standup",
      sourceText: "first",
      sourcePath: "raw/sources/standup/abc.md",
      sourceType: "text",
      rawId: "abc",
    });
    const pages = await listWikiPages();
    const summary = pages.find((entry) => entry.title.includes("source summary"));
    expect(summary).toBeTruthy();
    const existing = await readWikiPage(summary!.slug);
    const { serializeFrontmatter } = await import("../frontmatter");
    const { parseFrontmatter } = await import("../frontmatter");
    const parsed = parseFrontmatter(existing!.content);
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: summary!.slug,
        title: summary!.title,
        content: serializeFrontmatter(
          { ...parsed.data, disputed: true, type: "summary" },
          parsed.body,
        ),
      }),
    );
    await runIngestBookkeeping({
      owner: "alice",
      actor: "alice",
      sourceTitle: "Standup",
      sourceText: "second",
      sourcePath: "raw/sources/standup/abc.md",
      sourceType: "text",
      rawId: "abc",
    });
    const rewritten = await readWikiPage(summary!.slug);
    expect(rewritten?.content).toContain("disputed: true");
    expect(rewritten?.content).toContain("second");
  }, 15_000);

  it("bookkeeping cites options.sourcePath when ingest is given one", async () => {
    const { ingest } = await import("../ingest");
    await ingest("Hello notes", "# Hello\n\nBody of the note.", {
      owner: "alice",
      author: "alice",
      sourceType: "text",
      sourcePath: "raw/sources/custom/real.md",
    });
    const pages = await listWikiPages();
    const summary = pages.find((entry) => entry.title.includes("source summary"));
    expect(summary).toBeTruthy();
    const body = await readWikiPage(summary!.slug);
    expect(body?.content).toContain("raw/sources/custom/real.md");
    expect(body?.content).not.toMatch(/raw\/sources\/hello-notes\//);
  });

  it("loadIngestAnalysis returns null on invalid JSON", async () => {
    const { loadIngestAnalysis } = await import("../ingest-analysis");
    await getStorage().writeFile("ingest-analysis/job-bad.json", "{not-json");
    expect(await loadIngestAnalysis("job-bad")).toBeNull();
  });

  it("cascades Source delete: summary first, sole page gone, shared page kept, prose ignored", async () => {
    const { cascadeDeleteSource } = await import("../source-cascade");
    const { serializeSources, buildSourceEntry } = await import("../sources");
    const { rawSourceRelPath } = await import("../raw");
    const { proposeActionItems, listActionItems } = await import("../action-items");
    const path = "raw/sources/meet/deadbeef.md";
    await getStorage().writeFile(rawSourceRelPath("meet/deadbeef.md"), "# Meet\n");
    const cited = serializeSources([
      buildSourceEntry(path, "text", "alice", "deadbeef"),
    ]);
    const shared = serializeSources([
      buildSourceEntry(path, "text", "alice", "deadbeef"),
      buildSourceEntry("raw/sources/other/keep.md", "text", "alice", "keep"),
    ]);
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "meet-summary",
        title: "Meet — source summary",
        content: serializeFrontmatter(
          { type: "summary", sources: cited, owner: "alice" },
          "# Meet — source summary\n",
        ),
      }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "sole",
        title: "Sole",
        content: serializeFrontmatter(
          { sources: cited, owner: "alice" },
          "# Sole\n",
        ),
      }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "shared",
        title: "Shared",
        content: serializeFrontmatter(
          { sources: shared, disputed: true, owner: "alice" },
          "# Shared\n",
        ),
      }),
    );
    await writeWikiPageWithSideEffects(
      makeOpts({
        slug: "prose-only",
        title: "Prose Only",
        content: serializeFrontmatter(
          { owner: "alice" },
          `# Prose\n\nSee ${path} in the body.\n`,
        ),
      }),
    );
    await proposeActionItems("alice", [
      { title: "Follow up", sourceSlug: path },
    ]);
    const { enqueueTodoCandidates, listTodos } = await import("../todos");
    await enqueueTodoCandidates("alice", {
      wikiId: "current",
      sourceId: path,
      pageSlug: "meet-summary",
      candidates: [{ title: "Send recap", rationale: "Asked in the meeting." }],
    });

    const result = await cascadeDeleteSource({ owner: "alice", path });
    expect(result.deletedPages[0]).toBe("meet-summary");
    expect(result.deletedPages).toContain("sole");
    expect(result.updatedPages).toContain("shared");
    expect(await readWikiPage("meet-summary")).toBeNull();
    expect(await readWikiPage("sole")).toBeNull();
    expect(await readWikiPage("prose-only")).toMatchObject({
      content: expect.stringContaining("raw/sources/meet/deadbeef.md"),
    });
    const kept = await readWikiPage("shared");
    expect(kept?.content).toContain("keep.md");
    expect(kept?.content).toContain("disputed: true");
    expect(kept?.content).not.toContain("deadbeef");
    const todos = await listActionItems("alice");
    expect(todos[0]?.sourceMissing).toBe(true);
    const kernelTodos = await listTodos("alice");
    expect(kernelTodos).toHaveLength(1);
    expect(kernelTodos[0]?.sourceMissing).toBe(true);
    expect(kernelTodos[0]?.title).toBe("Send recap");
    await expect(
      getStorage().readFile(rawSourceRelPath("meet/deadbeef.md")),
    ).rejects.toThrow();
  }, 20_000);

  it("retries a failed job without storing Source bytes again", async () => {
    const { createIngestJob, retryIngestJob } = await import("../ingest-jobs");
    const { saveIngestAnalysis, loadIngestAnalysis } = await import(
      "../ingest-analysis"
    );
    const { sourceSha256 } = await import("../source-sha256");
    const { contentHash } = await import("../embeddings");
    const digest = await sourceSha256("same bytes");
    expect(digest).toHaveLength(64);
    expect(digest).not.toBe(contentHash("same bytes"));
    await createIngestJob({
      jobId: "job-retry-1",
      owner: "alice",
      title: "Meet",
      sourceRel: "raw/sources/meet/abc.md",
    });
    const { updateIngestJob } = await import("../ingest-jobs");
    await updateIngestJob("job-retry-1", { status: "failed", error: "LLM timeout" });
    await saveIngestAnalysis("job-retry-1", {
      entities: ["Ada"],
      concepts: [],
      arguments: [],
      existingLinks: [],
      tensions: [],
      recommendedStructure: "one page",
    });
    const retried = await retryIngestJob("job-retry-1", "alice");
    expect(retried?.status).toBe("queued");
    expect(retried?.sourceRel).toBe("raw/sources/meet/abc.md");
    expect(retried?.reuseAnalysis).toBe(true);
    expect((await loadIngestAnalysis("job-retry-1"))?.entities).toEqual(["Ada"]);
  });

  it("deletes a folder-imported Source by stored path, not by leaf name", async () => {
    const { cascadeDeleteSource } = await import("../source-cascade");
    const { saveRawSourceTree } = await import("../raw");
    const { ingest } = await import("../ingest");
    const stored = await saveRawSourceTree(
      "papers/energy/note.md",
      "# Energy notes\n\nGrid facts.\n",
      { owner: "alice" },
    );
    await ingest("Energy notes", "# Energy notes\n\nGrid facts.\n", {
      owner: "alice",
      author: "alice",
      sourceType: "text",
      sourcePath: stored.path,
      relativePath: "papers/energy/note.md",
    });
    const pages = await listWikiPages();
    const concept = pages.find(
      (entry) =>
        entry.slug !== "overview" &&
        entry.slug !== "index" &&
        entry.slug !== "log" &&
        !entry.title.includes("source summary"),
    );
    expect(concept).toBeTruthy();
    await cascadeDeleteSource({ owner: "alice", path: stored.path });
    expect(await readWikiPage(concept!.slug)).toBeNull();
    await expect(
      getStorage().readFile("raw/sources/papers/energy/note.md"),
    ).rejects.toThrow();
  }, 15_000);

  it("does not offer Retry while a job is automatically retrying", async () => {
    const { createIngestJob, retryIngestJob, updateIngestJob } =
      await import("../ingest-jobs");
    await createIngestJob({ jobId: "job-auto-1", owner: "alice", title: "Meet" });
    await updateIngestJob("job-auto-1", { status: "retrying", error: "LLM timeout" });
    expect(await retryIngestJob("job-auto-1", "alice")).toBeNull();
  });

  it("fails a tracked compile when Analysis is not valid JSON", async () => {
    const llm = await import("../llm");
    const hasKey = vi.spyOn(llm, "hasLLMKey").mockResolvedValue(true);
    const call = vi
      .spyOn(llm, "callLLM")
      .mockResolvedValue("# Not JSON\n\nWiki body.");
    const { ingest } = await import("../ingest");
    await expect(
      ingest("Meet", "# Meet\n\nNotes.", {
        owner: "alice",
        author: "alice",
        jobId: "job-analysis-1",
      }),
    ).rejects.toThrow(/Analysis did not return valid JSON/);
    hasKey.mockRestore();
    call.mockRestore();
  });
});
