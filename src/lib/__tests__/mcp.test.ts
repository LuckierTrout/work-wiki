import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  handleSearchWiki,
  handleReadPage,
  handleListPages,
  handleCreatePage,
  handleUpdatePage,
  handleUpdateMetadata,
  handleDeletePage,
  handleMergePages,
  handleIngestUrl,
  handleBatchIngest,
  handleIngestText,
  handleIngestPdf,
  handleIngestImage,
  handleIngestXMention,
  handleQueryWiki,
  handleSaveQueryAnswer,
  handleQueryHistory,
  handleAgentContext,
  handleSeedAgent,
  handleListAgents,
  handleUpdateAgent,
  handleDeleteAgent,
  handleLintWiki,
  handleFixLintIssue,
  handleReingest,
  handleIngestHistory,
  handleDataviewQuery,
  handleListRevisions,
  handleReadRevision,
  handleRevertRevision,
  handleVaultCurate,
  handleVaultUncurate,
  handleListVaults,
  handleVaultPages,
  handleVaultCreate,
  handleVaultRename,
  handleVaultDelete,
  handleWikiGraph,
  handleMaintenanceScan,
  createMcpServer,
  STDIO_SERVICE_PRINCIPAL_ID,
} from "../../mcp";
import { isServicePrincipalId } from "../principal-id";
import { vaultIdFor, listVaults, getVault, createVault } from "../vault";
import { readWikiPageWithFrontmatter, wikiRelPath } from "../wiki";
import { _resetStorage, getStorage } from "../storage";
import { _resetConfigCache } from "../config";
import { parseFrontmatter } from "../frontmatter";
import { registerAgent } from "../agents";
import { WRITE_DENIAL, WRITE_DENIAL_REALM } from "../write-denial";

// ---------------------------------------------------------------------------
// Mock fetchUrlContent, fetchImageBytes, and storeImageBytes so no test makes
// real HTTP calls. All other exports from ../fetch (isUrl, validateUrlSafety,
// etc.) are kept.
// ---------------------------------------------------------------------------
vi.mock("../fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fetch")>();
  return {
    ...actual,
    fetchUrlContent: vi.fn(async (url: string) => ({
      title: `Mocked page for ${url}`,
      content: `Mocked content fetched from ${url}`,
    })),
    fetchImageBytes: vi.fn(async (url: string) => ({
      bytes: new ArrayBuffer(8),
      filename: url.split("/").pop() || "image.png",
      contentType: "image/png",
    })),
    storeImageBytes: vi.fn(async (_bytes: ArrayBuffer, slug: string, filename: string) => ({
      localPath: `/assets/${slug}/${filename}`,
    })),
  };
});

// Mock the X-post syndication fetch (X URLs route through ../x-post, not
// ../fetch) so no real HTTP calls hit the syndication CDN. isXPostUrl is kept.
vi.mock("../x-post", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../x-post")>();
  return {
    ...actual,
    fetchXPostContent: vi.fn(async (url: string) => ({
      title: `Mocked X post for ${url}`,
      content: `Mocked tweet text fetched from ${url}`,
    })),
  };
});

// Mock the vision module so no real vision model calls are made.
vi.mock("../vision", () => ({
  describeImage: vi.fn(async () => ({
    text: "Mocked vision description of the image.",
  })),
}));

// Mock callLLM so tests that reach the synthesis pipeline (e.g. reingest) do
// not make real API calls.  hasLLMKey is kept real so no-key fallback tests work.
vi.mock("../llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm")>();
  return {
    ...actual,
    callLLM: vi.fn(async () => "CONCEPT: Mock Page\nALIASES:\n\n# Mock Page\n\nMocked LLM synthesis."),
  };
});

import { fetchUrlContent } from "../fetch";
import { fetchXPostContent } from "../x-post";
import { AUTO_FIXABLE_CHECK_TYPES } from "../lint-types";
const mockedFetchUrlContent = vi.mocked(fetchUrlContent);
const mockedFetchXPostContent = vi.mocked(fetchXPostContent);

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  await fs.mkdir(path.join(tmpDir, "wiki"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "raw"), { recursive: true });
  _resetStorage();
  // Reset fetch mocks to default deterministic behaviour
  mockedFetchUrlContent.mockImplementation(async (url: string) => ({
    title: `Mocked page for ${url}`,
    content: `Mocked content fetched from ${url}`,
  }));
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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper — write wiki pages and index
// ---------------------------------------------------------------------------

async function writeTestPage(slug: string, content: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, "wiki", `${slug}.md`),
    content,
    "utf-8",
  );
}

async function writeIndex(
  entries: { title: string; slug: string; summary: string }[],
): Promise<void> {
  const lines = entries.map(
    (e) => `- [${e.title}](${e.slug}.md) — ${e.summary}`,
  );
  const content = `# Wiki Index\n\n${lines.join("\n")}\n`;
  await fs.writeFile(
    path.join(tmpDir, "wiki", "index.md"),
    content,
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// search_wiki tests
// ---------------------------------------------------------------------------

describe("search_wiki", () => {
  it("returns results for matching content", async () => {
    await writeTestPage(
      "neural-networks",
      "---\ntags: [ml]\n---\n# Neural Networks\n\nNeural networks are computing systems inspired by biological neural networks.",
    );
    await writeTestPage(
      "gradient-descent",
      "---\ntags: [ml]\n---\n# Gradient Descent\n\nGradient descent is an optimization algorithm.",
    );
    await writeIndex([
      { title: "Neural Networks", slug: "neural-networks", summary: "s" },
      { title: "Gradient Descent", slug: "gradient-descent", summary: "s" },
    ]);

    const results = await handleSearchWiki({ query: "neural" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].slug).toBe("neural-networks");
    expect(results[0].title).toBe("Neural Networks");
    expect(results[0].snippet).toBeDefined();
    expect(typeof results[0].score).toBe("number");
    expect(typeof results[0].summary).toBe("string");
  });

  it("returns empty array for no matches", async () => {
    await writeTestPage(
      "neural-networks",
      "# Neural Networks\n\nSome content about neural nets.",
    );

    const results = await handleSearchWiki({ query: "quantum-entanglement-xyz" });
    expect(results).toEqual([]);
  });

  it("respects limit parameter", async () => {
    await writeTestPage("a", "# Page A\n\nCommon topic here.");
    await writeTestPage("b", "# Page B\n\nCommon topic here.");
    await writeTestPage("c", "# Page C\n\nCommon topic here.");

    const results = await handleSearchWiki({ query: "common topic", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("scopes results to agent pages when scope is provided", async () => {
    // Create pages — one belongs to agent, one does not
    await writeTestPage("agent-identity", "# Agent Identity\n\nAgent knowledge about testing.");
    await writeTestPage("global-page", "# Global Page\n\nGlobal knowledge about testing.");
    await writeIndex([
      { title: "Agent Identity", slug: "agent-identity", summary: "s" },
      { title: "Global Page", slug: "global-page", summary: "s" },
    ]);

    // Register an agent that owns only agent-identity
    await registerAgent({
      id: "test-bot",
      name: "Test Bot",
      description: "A test agent",
      identityPages: ["agent-identity"],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Scoped search should only return agent-identity
    const scoped = await handleSearchWiki({ query: "knowledge testing", scope: "agent:test-bot" });
    expect(scoped.every((r) => r.slug === "agent-identity")).toBe(true);

    // Unscoped search should return both
    const unscoped = await handleSearchWiki({ query: "knowledge testing" });
    const slugs = unscoped.map((r) => r.slug);
    expect(slugs).toContain("agent-identity");
    expect(slugs).toContain("global-page");
  });

  it("returns all results when scope is omitted (backward compatible)", async () => {
    await writeTestPage("page-x", "# Page X\n\nUnique searchable content alpha.");
    await writeIndex([{ title: "Page X", slug: "page-x", summary: "s" }]);

    const results = await handleSearchWiki({ query: "unique searchable content alpha" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].slug).toBe("page-x");
  });

  it("returns fuzzy matches with fuzzy flag for near-miss queries", async () => {
    // Write a page with a specific term
    await writeTestPage(
      "photosynthesis",
      "# Photosynthesis\n\nPhotosynthesis is the process by which plants convert sunlight into energy.",
    );
    await writeIndex([{ title: "Photosynthesis", slug: "photosynthesis", summary: "s" }]);

    // Search with a typo — "photosynthsis" (missing 'e')
    const results = await handleSearchWiki({ query: "photosynthsis" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.slug === "photosynthesis");
    expect(match).toBeDefined();
    expect(match!.fuzzy).toBe(true);
    expect(typeof match!.summary).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// read_page tests
// ---------------------------------------------------------------------------

describe("read_page", () => {
  it("returns page content with frontmatter", async () => {
    await writeTestPage(
      "test-page",
      "---\ntags: [science]\nupdated: '2025-01-01'\n---\n# Test Page\n\nThis is test content.",
    );

    const result = await handleReadPage({ slug: "test-page" });
    expect(result.slug).toBe("test-page");
    expect(result.title).toBe("Test Page");
    expect(result.content).toContain("This is test content.");
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter.tags).toEqual(["science"]);
    expect(result.frontmatter.updated).toBe("2025-01-01");
  });

  it("throws for nonexistent slug", async () => {
    await expect(
      handleReadPage({ slug: "does-not-exist" }),
    ).rejects.toThrow("Page not found: does-not-exist");
  });
});

// ---------------------------------------------------------------------------
// list_pages tests
// ---------------------------------------------------------------------------

describe("list_pages", () => {
  it("returns all pages", async () => {
    await writeTestPage(
      "alpha",
      "---\ntags: [a]\nupdated: '2025-01-01'\n---\n# Alpha\n\nAlpha page.",
    );
    await writeTestPage(
      "beta",
      "---\ntags: [b]\nupdated: '2025-06-15'\n---\n# Beta\n\nBeta page.",
    );
    await writeIndex([
      { title: "Alpha", slug: "alpha", summary: "Alpha page" },
      { title: "Beta", slug: "beta", summary: "Beta page" },
    ]);

    const result = await handleListPages({});
    expect(result.length).toBe(2);
    // Default sort is by title
    expect(result[0].slug).toBe("alpha");
    expect(result[0].summary).toBe("Alpha page");
    expect(result[1].slug).toBe("beta");
    expect(result[1].summary).toBe("Beta page");
  });

  it("respects limit parameter", async () => {
    await writeTestPage("a", "# A\n\nPage A.");
    await writeTestPage("b", "# B\n\nPage B.");
    await writeTestPage("c", "# C\n\nPage C.");
    await writeIndex([
      { title: "A", slug: "a", summary: "Page A" },
      { title: "B", slug: "b", summary: "Page B" },
      { title: "C", slug: "c", summary: "Page C" },
    ]);

    const result = await handleListPages({ limit: 2 });
    expect(result.length).toBe(2);
  });

  it("sorts by updated when requested", async () => {
    await writeTestPage(
      "old",
      "---\nupdated: '2024-01-01'\n---\n# Old\n\nOld page.",
    );
    await writeTestPage(
      "new",
      "---\nupdated: '2025-06-15'\n---\n# New\n\nNew page.",
    );
    await writeIndex([
      { title: "Old", slug: "old", summary: "Old page" },
      { title: "New", slug: "new", summary: "New page" },
    ]);

    const result = await handleListPages({ sort: "updated" });
    expect(result.length).toBe(2);
    // Newest first
    expect(result[0].slug).toBe("new");
    expect(result[1].slug).toBe("old");
  });

  it("sorts by confidence when requested", async () => {
    await writeTestPage(
      "low-conf",
      "---\nconfidence: 0.3\nupdated: '2025-01-01'\n---\n# Low Confidence\n\nLow confidence page.",
    );
    await writeTestPage(
      "high-conf",
      "---\nconfidence: 0.9\nupdated: '2025-01-01'\n---\n# High Confidence\n\nHigh confidence page.",
    );
    await writeTestPage(
      "no-conf",
      "---\nupdated: '2025-01-01'\n---\n# No Confidence\n\nNo confidence field.",
    );
    await writeIndex([
      { title: "Low Confidence", slug: "low-conf", summary: "Low" },
      { title: "High Confidence", slug: "high-conf", summary: "High" },
      { title: "No Confidence", slug: "no-conf", summary: "None" },
    ]);

    const result = await handleListPages({ sort: "confidence" });
    expect(result.length).toBe(3);
    // Highest confidence first
    expect(result[0].slug).toBe("high-conf");
    expect(result[0].confidence).toBe(0.9);
    expect(result[1].slug).toBe("low-conf");
    expect(result[1].confidence).toBe(0.3);
    // No confidence field → sorted last (confidence defaults to 0)
    expect(result[2].slug).toBe("no-conf");
  });

  it("returns empty array when no pages exist", async () => {
    const result = await handleListPages({});
    expect(result).toEqual([]);
  });

  it("includes type and owner when present on entry", async () => {
    await writeTestPage(
      "artifact-page",
      "---\ntitle: Revenue Chart\ntype: html\nowner: alice\ntags: [chart]\nupdated: '2025-06-01'\n---\n<html><body>chart</body></html>",
    );
    await writeTestPage(
      "normal-page",
      "---\ntags: [test]\nupdated: '2025-06-01'\n---\n# Normal Page\n\nJust a normal page.",
    );
    await writeIndex([
      { title: "Revenue Chart", slug: "artifact-page", summary: "A chart" },
      { title: "Normal Page", slug: "normal-page", summary: "Just a normal page" },
    ]);

    const result = await handleListPages({});
    const artifact = result.find((p) => p.slug === "artifact-page");
    const normal = result.find((p) => p.slug === "normal-page");

    expect(artifact).toBeDefined();
    expect(artifact!.type).toBe("html");
    expect(artifact!.owner).toBe("alice");

    expect(normal).toBeDefined();
    expect(normal!.type).toBeUndefined();
    expect(normal!.owner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MCP write tools tests
// ---------------------------------------------------------------------------

describe("MCP write tools", () => {
  describe("create_page", () => {
    it("creates a new page", async () => {
      const result = await handleCreatePage({
        slug: "test-create",
        content: "# Test\n\nBody text here.",
      });

      expect(result.slug).toBe("test-create");
      expect(result.title).toBe("Test");
      expect(result.created).toBe(true);

      // Verify file exists on disk with frontmatter
      const filePath = path.join(tmpDir, "wiki", "test-create.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("---");
      expect(fileContent).toContain("title: Test");
      expect(fileContent).toContain("# Test");
      expect(fileContent).toContain("Body text here.");
    });

    it("rejects a new page that links to a same-owner slug claimed as a merged alias", async () => {
      const { writeWikiPageWithSideEffects } = await import("../lifecycle");
      await writeWikiPageWithSideEffects({
        slug: "create-survivor",
        title: "Survivor",
        content: "---\nowner: alice\naliases: [create-retired]\n---\n# Survivor\n\nCanonical Page.",
        summary: "canonical",
        logOp: "ingest",
        crossRefSource: null,
      });
      await writeWikiPageWithSideEffects({
        slug: "create-retired",
        title: "Replacement",
        content: "---\nowner: alice\n---\n# Replacement\n\nUnrelated replacement.",
        summary: "replacement",
        logOp: "ingest",
        crossRefSource: null,
      });

      await expect(handleCreatePage({
        slug: "mcp-create-linker",
        content: "# Linker\n\nSee [the old Page](create-retired.md).",
        author: "alice",
        owner: "alice",
      })).rejects.toThrow(/missing|replaced/i);
      await expect(fs.stat(path.join(tmpDir, "wiki", "mcp-create-linker.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });

    it("includes all yopedia schema fields in frontmatter", async () => {
      await handleCreatePage({
        slug: "schema-check",
        content: "# Schema Test\n\nBody.",
      });

      const filePath = path.join(tmpDir, "wiki", "schema-check.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      const { data: frontmatter } = parseFrontmatter(fileContent);

      expect(frontmatter.confidence).toBe(0.5);
      expect(frontmatter.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(frontmatter.authors).toEqual(["agent"]);
      expect(frontmatter.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(frontmatter.disputed).toBe(false);
      expect(frontmatter.contributors).toEqual([]);
      expect(frontmatter.aliases).toEqual([]);
      expect(frontmatter.tags).toEqual([]);

      // expiry should be ~90 days from today
      const today = new Date();
      const expiry = new Date(frontmatter.expiry as string);
      const diffDays = Math.round(
        (expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBeGreaterThanOrEqual(89);
      expect(diffDays).toBeLessThanOrEqual(91);
    });

    it("rejects duplicate slug", async () => {
      await handleCreatePage({
        slug: "dup-page",
        content: "# Duplicate\n\nFirst version.",
      });

      await expect(
        handleCreatePage({
          slug: "dup-page",
          content: "# Duplicate\n\nSecond version.",
        }),
      ).rejects.toThrow("Page already exists: dup-page");
    });

    /**
     * DW-496. The conflict guard above read `null` for a non-ENOENT storage
     * failure as well as for a free slug, so a provider blip made the guard
     * answer "this slug is free" for a Page that is stored.
     *
     * WHAT THE HARM ACTUALLY IS. The blip did not by itself overwrite the
     * stored Page: the `createOnly` branch of the lifecycle pipeline
     * (`src/lib/lifecycle.ts:487-497`) re-checks `storageFileExists(flatPath)`
     * and throws `LifecyclePageConflictError`, so a Page that has a flat
     * compatibility copy was still refused — but under an error naming a
     * CONFLICT rather than the storage fault that actually happened, which
     * sends the caller to fix a slug collision that does not exist. The sharper
     * residual case is a Page stored only in another tenant's silo, where that
     * flat check passes and the create does land. Either way the guard was
     * ruling on a `null` it had no right to read as an absence.
     *
     * Under `{ fresh: true, strict: true }` the read rethrows instead, and the
     * MCP caller is told the store failed. Classification, not wording, is what
     * is pinned.
     */
    it("rejects with the STORAGE error — not `Page already exists` — when the conflict read blips", async () => {
      // The Page the guard protects has to actually BE stored, or the row
      // asserts nothing about the harm its comment names.
      await handleCreatePage({
        slug: "blip-page",
        content: "# Blip\n\nThe stored bytes.",
      });
      const before = (await readWikiPageWithFrontmatter("blip-page"))!.content;

      const storage = getStorage();
      const originalRead = storage.readFile.bind(storage);
      // ONE-SHOT, and deliberately so: a spy that failed EVERY read of
      // `blip-page.md` would also break the `createOnly` re-check inside the
      // write below, so the call would reject whether or not the guard
      // rethrows — a green row that pins nothing. Failing only the guard read
      // leaves the old behaviour rejecting with `Page already exists`.
      let blipped = false;
      const readSpy = vi
        .spyOn(storage, "readFile")
        .mockImplementation(async (filePath: string) => {
          // A non-ENOENT failure: the file is there, the provider is not.
          if (!blipped && filePath.endsWith("blip-page.md")) {
            blipped = true;
            throw new Error("storage unavailable");
          }
          return originalRead(filePath);
        });

      let caught: unknown;
      try {
        await handleCreatePage({
          slug: "blip-page",
          content: "# Blip\n\nShould never land.",
        });
      } catch (err) {
        caught = err;
      } finally {
        readSpy.mockRestore();
      }

      expect(blipped).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("storage unavailable");
      // The half this row's title promises, and the half that was decorative
      // before: the caller must not be told this is a slug conflict.
      expect(message).not.toContain("already exists");

      // And the stored Page is untouched, byte for byte.
      expect((await readWikiPageWithFrontmatter("blip-page"))!.content).toBe(before);
    });

    /**
     * The FRESH half (DW-195), which `strict` cannot pin: remove `fresh: true`
     * from the guard read and every strict row above still passes. `pageCache`
     * is module-global and ref-counted around bulk scans, so one can be holding
     * a stale NEGATIVE entry — the guard's `null` — for a slug that IS stored.
     * The guard then rules the slug free and hands the request to the write,
     * where the `createOnly` re-check is the only thing left standing; it
     * answers its own conflict sentence rather than this handler's.
     */
    it("checks the conflict guard against storage while a stale page cache is open", async () => {
      const { beginPageCache, readWikiPage, serializeFrontmatter } = await import("../wiki");
      const cleanup = beginPageCache();
      try {
        // A concurrent scan looks the slug up before it exists and caches the
        // miss — `readWikiPage` seeds a negative entry on a true global miss.
        expect(await readWikiPage("mcp-cached")).toBeNull();

        // The page appears underneath it. Written DIRECTLY to the flat path,
        // bypassing `writeWikiPage` — which invalidates — because a stale entry
        // is exactly what this row is about.
        const today = new Date().toISOString().slice(0, 10);
        const storedBytes = serializeFrontmatter(
          {
            created: today,
            confidence: 0.5,
            authors: ["someone-else"],
            owner: "someone-else",
            visibility: "public",
            contributors: [],
            expiry: "2099-01-01",
            sources: [],
          },
          "# mcp-cached\n\nAlready stored by someone else.",
        );
        const flatPath = path.join(process.env.WIKI_DIR!, "mcp-cached.md");
        await fs.writeFile(flatPath, storedBytes, "utf-8");
        // The cache is genuinely stale: a cached read still answers "no page".
        expect(await readWikiPage("mcp-cached")).toBeNull();

        // THE ASSERTION THAT FAILS WITHOUT THE FRESH READ. This exact sentence
        // is the GUARD's. Off the cached entry the guard passes and the write's
        // own re-check rejects instead, with `Page "mcp-cached" already exists`.
        await expect(
          handleCreatePage({
            slug: "mcp-cached",
            content: "# Mine\n\nShould never land.",
          }),
        ).rejects.toThrow("Page already exists: mcp-cached");

        // And the other principal's bytes are intact, byte for byte.
        expect(await fs.readFile(flatPath, "utf-8")).toBe(storedBytes);
      } finally {
        cleanup();
      }
    });

    it("rejects invalid slug", async () => {
      await expect(
        handleCreatePage({
          slug: "",
          content: "# Empty Slug\n\nBody.",
        }),
      ).rejects.toThrow();

      await expect(
        handleCreatePage({
          slug: "INVALID SLUG!",
          content: "# Bad\n\nBody.",
        }),
      ).rejects.toThrow();
    });

    it("accepts tags and includes them in frontmatter", async () => {
      await handleCreatePage({
        slug: "tagged-page",
        content: "# Tagged\n\nSome body.",
        tags: ["science", "ai"],
      });

      const filePath = path.join(tmpDir, "wiki", "tagged-page.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      const { data: frontmatter } = parseFrontmatter(fileContent);
      expect(frontmatter.tags).toEqual(["science", "ai"]);
    });

    it("defaults tags to empty array when not provided", async () => {
      await handleCreatePage({
        slug: "no-tags-page",
        content: "# No Tags\n\nBody.",
      });

      const filePath = path.join(tmpDir, "wiki", "no-tags-page.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      const { data: frontmatter } = parseFrontmatter(fileContent);
      expect(frontmatter.tags).toEqual([]);
    });

    it("strips H1 heading from summary", async () => {
      await handleCreatePage({
        slug: "h1-summary-create",
        content: "# Big Heading\n\nThe actual summary text goes here.",
      });

      // The summary in the index (after the em dash) should not contain the heading
      const indexPath = path.join(tmpDir, "wiki", "index.md");
      const indexContent = await fs.readFile(indexPath, "utf-8");
      const entryLine = indexContent.split("\n").find((l: string) => l.includes("h1-summary-create"));
      expect(entryLine).toBeDefined();
      // Extract summary portion after the em dash
      const summaryMatch = entryLine!.match(/—\s*(.+)$/);
      expect(summaryMatch).toBeDefined();
      const summary = summaryMatch![1];
      expect(summary).not.toMatch(/Big Heading/);
      expect(summary).toContain("actual summary text");
    });

    it("strips caller frontmatter to prevent double frontmatter", async () => {
      const contentWithFm =
        "---\ntitle: Agent Title\ncustom_field: hello\n---\n# Created Page\n\nBody text here.";
      const result = await handleCreatePage({
        slug: "double-fm-create",
        content: contentWithFm,
      });

      expect(result.created).toBe(true);
      expect(result.title).toBe("Created Page");

      const filePath = path.join(tmpDir, "wiki", "double-fm-create.md");
      const fileContent = await fs.readFile(filePath, "utf-8");

      // Count frontmatter delimiters — exactly one block (opening + closing = 2)
      const delimiterCount = (fileContent.match(/^---$/gm) || []).length;
      expect(delimiterCount).toBe(2);

      // The body should appear exactly once
      expect(fileContent).toContain("Body text here.");
      expect(fileContent).toContain("# Created Page");

      // Caller-supplied custom field should be merged into frontmatter
      const parsed = parseFrontmatter(fileContent);
      expect(parsed.data.custom_field).toBe("hello");
    });
  });

  describe("update_page", () => {
    it("updates existing page", async () => {
      // Create first
      await handleCreatePage({
        slug: "update-me",
        content: "# Original\n\nOriginal body.",
      });

      const result = await handleUpdatePage({
        slug: "update-me",
        content: "# Updated\n\nNew body content.",
      });

      expect(result.slug).toBe("update-me");
      expect(result.title).toBe("Updated");
      expect(result.updated).toBe(true);

      // Verify file on disk has new content
      const filePath = path.join(tmpDir, "wiki", "update-me.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("# Updated");
      expect(fileContent).toContain("New body content.");
    });

    it("rejects a new link to a same-owner slug already claimed as a merged alias", async () => {
      await writeTestPage(
        "survivor",
        "---\nowner: alice\naliases: [retired-target]\n---\n# Survivor\n\nCanonical Page.",
      );
      await writeTestPage(
        "retired-target",
        "---\nowner: alice\n---\n# Replacement\n\nUnrelated replacement.",
      );
      await writeTestPage(
        "mcp-linker",
        "---\nowner: alice\n---\n# MCP linker\n\nOriginal body.",
      );
      await writeIndex([
        { title: "Survivor", slug: "survivor", summary: "canonical" },
        { title: "Replacement", slug: "retired-target", summary: "replacement" },
        { title: "MCP linker", slug: "mcp-linker", summary: "linker" },
      ]);

      await expect(handleUpdatePage({
        slug: "mcp-linker",
        content: "# MCP linker\n\nSee [the old Page](retired-target.md).",
        author: "alice",
      })).rejects.toThrow(/missing|replaced/i);
      expect((await handleReadPage({ slug: "mcp-linker" })).content)
        .not.toContain("retired-target.md");
    });

    it("404 on missing page", async () => {
      await expect(
        handleUpdatePage({
          slug: "nonexistent-page",
          content: "# Ghost\n\nBody.",
        }),
      ).rejects.toThrow("Page not found: nonexistent-page");
    });

    /**
     * The STRICT half. Without `strict: true` a non-ENOENT storage failure on
     * the merge-base read flattens to `null`, and this handler's own null
     * branch then tells the MCP caller `Page not found` — a deletion the store
     * never made, off a Page that is sitting right there. Classification is
     * what is pinned, not the provider's wording.
     */
    it("rejects with the STORAGE error — not `Page not found` — when the merge-base read blips", async () => {
      await handleCreatePage({
        slug: "blip-update",
        content: "# Blip update\n\nThe stored bytes.",
      });
      const before = (await readWikiPageWithFrontmatter("blip-update"))!.content;

      const storage = getStorage();
      const originalRead = storage.readFile.bind(storage);
      // ONE-SHOT, for the same reason as the create row above: a spy that
      // failed EVERY read of `blip-update.md` would also break the write's own
      // CAS re-read, so the call would reject whether or not the merge-base
      // read rethrows — a green row that pins nothing.
      let blipped = false;
      const readSpy = vi
        .spyOn(storage, "readFile")
        .mockImplementation(async (filePath: string) => {
          if (!blipped && filePath.endsWith("blip-update.md")) {
            blipped = true;
            throw new Error("storage unavailable");
          }
          return originalRead(filePath);
        });

      let caught: unknown;
      try {
        await handleUpdatePage({
          slug: "blip-update",
          content: "# Blip update\n\nShould never land.",
        });
      } catch (err) {
        caught = err;
      } finally {
        readSpy.mockRestore();
      }

      expect(blipped).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("storage unavailable");
      expect(message).not.toContain("Page not found");

      // And the stored Page is untouched, byte for byte.
      expect((await readWikiPageWithFrontmatter("blip-update"))!.content).toBe(before);
    });

    /**
     * The FRESH half, which `strict` cannot pin: drop `fresh: true` and the
     * strict row above still passes. `pageCache` is module-global and
     * ref-counted around bulk scans, so one can be holding a SUPERSEDED entry
     * open. Those bytes are this update's merge base (`expectedContent`) and
     * the frontmatter it merges into, so off the cached entry the merge base is
     * a file that is no longer stored — the write's CAS then refuses it and a
     * legitimate update fails as a spurious conflict for the duration of the
     * unrelated scan. The CAS is the backstop; `fresh` is the fix.
     */
    it("takes the merge base from storage while a stale page cache is open", async () => {
      const { beginPageCache, readWikiPage } = await import("../wiki");
      const cachedBytes =
        "---\ntitle: Stale Update\ncreated: '2025-01-15'\n---\n# Stale Update\n\nCached body.\n";
      await writeTestPage("mcp-stale-update", cachedBytes);

      const cleanup = beginPageCache();
      try {
        // A concurrent scan reads the Page and caches these bytes.
        expect((await readWikiPage("mcp-stale-update"))!.content).toBe(cachedBytes);

        // Newer bytes land underneath it. Written DIRECTLY to the flat path,
        // bypassing `writeWikiPage` — which invalidates — because a stale
        // entry is exactly what this row is about. `stored_marker` exists only
        // in the stored bytes.
        const storedBytes =
          "---\ntitle: Stale Update\ncreated: '2025-01-15'\nstored_marker: only-in-stored\n---\n# Stale Update\n\nStored body.\n";
        const flatPath = path.join(process.env.WIKI_DIR!, "mcp-stale-update.md");
        await fs.writeFile(flatPath, storedBytes, "utf-8");
        // The cache is genuinely stale: a cached read still answers the old bytes.
        expect((await readWikiPage("mcp-stale-update"))!.content).toBe(cachedBytes);

        // THE CALL THAT FAILS WITHOUT THE FRESH READ — and it fails HERE, not
        // at the assertions below: off the cached entry the merge base is the
        // superseded file, so the write's CAS rejects with
        // `LifecyclePageConflictError: Page "mcp-stale-update" changed`.
        await handleUpdatePage({
          slug: "mcp-stale-update",
          content: "# Stale Update\n\nBrand new body.",
        });

        // Reaching here at all is the load-bearing half; the marker then
        // confirms the merge went into the STORED bytes rather than the cached
        // ones.
        const after = await fs.readFile(flatPath, "utf-8");
        expect(after).toContain("stored_marker: only-in-stored");
        expect(after).toContain("Brand new body.");
      } finally {
        cleanup();
      }
    });

    it("preserves frontmatter", async () => {
      // Create a page with specific frontmatter
      await writeTestPage(
        "preserve-fm",
        "---\ntitle: Preserve\ntags: [science, ai]\ncreated: '2025-01-15'\nconfidence: 0.8\n---\n# Preserve\n\nOriginal body.",
      );

      const result = await handleUpdatePage({
        slug: "preserve-fm",
        content: "# Preserve Updated\n\nNew body.",
      });

      expect(result.updated).toBe(true);

      // Verify original frontmatter fields preserved
      const filePath = path.join(tmpDir, "wiki", "preserve-fm.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("tags: [science, ai]");
      expect(fileContent).toContain("confidence: 0.8");
      // The serializer outputs date strings without quotes
      expect(fileContent).toContain("created: 2025-01-15");
      // updated should be bumped to today
      const today = new Date().toISOString().slice(0, 10);
      expect(fileContent).toContain(`updated: ${today}`);
    });

    it("author attribution", async () => {
      await handleCreatePage({
        slug: "author-test",
        content: "# Author Test\n\nBody.",
      });

      const result = await handleUpdatePage({
        slug: "author-test",
        content: "# Author Test\n\nUpdated body.",
        author: "agent-alpha",
      });

      expect(result.slug).toBe("author-test");
      expect(result.updated).toBe(true);
      // The author flows through to writeWikiPageWithSideEffects
      // which stores it in the revision sidecar. We verify the call
      // succeeded without error — deeper attribution is tested in
      // lifecycle/revision tests.
    });

    it("strips H1 heading from summary on update", async () => {
      await handleCreatePage({
        slug: "h1-summary-update",
        content: "# Original Title\n\nOriginal body.",
      });

      await handleUpdatePage({
        slug: "h1-summary-update",
        content: "# Updated Heading\n\nThe updated summary text goes here.",
      });

      const indexPath = path.join(tmpDir, "wiki", "index.md");
      const indexContent = await fs.readFile(indexPath, "utf-8");
      const entryLine = indexContent.split("\n").find((l: string) => l.includes("h1-summary-update"));
      expect(entryLine).toBeDefined();
      // Extract summary portion after the em dash
      const summaryMatch = entryLine!.match(/—\s*(.+)$/);
      expect(summaryMatch).toBeDefined();
      const summary = summaryMatch![1];
      expect(summary).not.toMatch(/Updated Heading/);
      expect(summary).toContain("updated summary text");
    });

    it("strips caller frontmatter to prevent double frontmatter", async () => {
      await handleCreatePage({
        slug: "double-fm-update",
        content: "# Original\n\nOriginal body.",
      });

      // Caller sends content that already includes a YAML frontmatter block
      const contentWithFm =
        "---\ntitle: Caller Title\ntags: [extra]\n---\n# Updated\n\nNew body with frontmatter.";
      const result = await handleUpdatePage({
        slug: "double-fm-update",
        content: contentWithFm,
      });

      expect(result.updated).toBe(true);

      const filePath = path.join(tmpDir, "wiki", "double-fm-update.md");
      const fileContent = await fs.readFile(filePath, "utf-8");

      // Count frontmatter delimiters — exactly one block (opening + closing = 2)
      const delimiterCount = (fileContent.match(/^---$/gm) || []).length;
      expect(delimiterCount).toBe(2);

      // The body should appear exactly once, not duplicated
      expect(fileContent).toContain("New body with frontmatter.");
      expect(fileContent).toContain("# Updated");

      // Caller-supplied tags should be merged into frontmatter
      const parsed = parseFrontmatter(fileContent);
      expect(parsed.data.tags).toEqual(["extra"]);
    });
  });
});

// ---------------------------------------------------------------------------
// MCP write tools on a read-only deployment (DW-188)
// ---------------------------------------------------------------------------
//
// THE CLAIM NO HTTP TEST CAN MAKE. The stdio MCP server calls the kernel
// writers directly, so no route gate ever sees these calls — which is exactly
// why `isReadOnly()` being enforced door-by-door at the HTTP layer left every
// MCP write running on a read-only deployment. The gate now lives in
// `writeWikiPageWithSideEffects`, `deleteWikiPage` and `patchMetadata`, and
// these four handlers inherit it without a line of their own.

describe("MCP write tools on a read-only deployment", () => {
  let originalReadOnly: string | undefined;

  beforeEach(() => {
    // Cleared rather than inherited: every other suite in this file writes
    // pages through these same handlers, so an exported value would turn
    // hundreds of assertions red on one machine and nowhere else.
    originalReadOnly = process.env.YOPEDIA_READONLY;
    delete process.env.YOPEDIA_READONLY;
  });

  afterEach(() => {
    if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = originalReadOnly;
  });

  /** Every byte under the temp wiki dir, keyed by filename. */
  async function wikiFiles(): Promise<Record<string, string>> {
    const dir = path.join(tmpDir, "wiki");
    const names = await fs.readdir(dir);
    const out: Record<string, string> = {};
    for (const name of names) {
      out[name] = await fs.readFile(path.join(dir, name), "utf-8");
    }
    return out;
  }

  /** A refusal names read-only — "forbidden" alone would misdirect the agent. */
  async function expectReadOnlyRejection(op: () => Promise<unknown>) {
    await expect(op()).rejects.toThrow(/read-only/);
  }

  it("create_page is rejected and writes no file", async () => {
    const before = await wikiFiles();
    process.env.YOPEDIA_READONLY = "1";

    await expectReadOnlyRejection(() =>
      handleCreatePage({ slug: "ro-mcp-create", content: "# RO\n\nBody." }),
    );

    expect(await wikiFiles()).toEqual(before);
  });

  it("update_page is rejected and leaves the stored bytes alone", async () => {
    await handleCreatePage({
      slug: "ro-mcp-update",
      content: "# RO Update\n\nOriginal body.",
    });
    const before = await wikiFiles();
    process.env.YOPEDIA_READONLY = "1";

    await expectReadOnlyRejection(() =>
      handleUpdatePage({
        slug: "ro-mcp-update",
        content: "# RO Update\n\nRewritten body.",
      }),
    );

    expect(await wikiFiles()).toEqual(before);
  });

  it("update_metadata is rejected and leaves the frontmatter alone", async () => {
    await handleCreatePage({
      slug: "ro-mcp-meta",
      content: "# RO Meta\n\nBody.",
    });
    const before = await wikiFiles();
    process.env.YOPEDIA_READONLY = "1";

    await expectReadOnlyRejection(() =>
      handleUpdateMetadata({
        slug: "ro-mcp-meta",
        metadata: { confidence: 0.99 },
      }),
    );

    expect(await wikiFiles()).toEqual(before);
    expect(
      (await readWikiPageWithFrontmatter("ro-mcp-meta"))!.frontmatter.confidence,
    ).not.toBe(0.99);
  });

  it("delete_page is rejected and the page survives", async () => {
    await handleCreatePage({
      slug: "ro-mcp-delete",
      content: "# RO Delete\n\nBody.",
    });
    const before = await wikiFiles();
    process.env.YOPEDIA_READONLY = "1";

    await expectReadOnlyRejection(() =>
      handleDeletePage({ slug: "ro-mcp-delete" }),
    );

    expect(await wikiFiles()).toEqual(before);
    expect(await readWikiPageWithFrontmatter("ro-mcp-delete")).not.toBeNull();
  });

  it("all four still work with the flag unset — the control case", async () => {
    // Without this, every "rejected / unchanged" assertion above would also
    // pass against handlers that had simply stopped working.
    await handleCreatePage({ slug: "rw-mcp", content: "# RW\n\nBody." });
    expect(
      (await handleUpdatePage({ slug: "rw-mcp", content: "# RW\n\nEdited." }))
        .updated,
    ).toBe(true);
    expect(
      (await handleUpdateMetadata({ slug: "rw-mcp", metadata: { confidence: 0.9 } }))
        .updated,
    ).toBe(true);
    expect((await handleDeletePage({ slug: "rw-mcp" })).slug).toBe("rw-mcp");
    expect(await readWikiPageWithFrontmatter("rw-mcp")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MCP cross-referencing tests
// ---------------------------------------------------------------------------

describe("MCP cross-referencing", () => {
  it("create_page triggers cross-ref update on related pages", async () => {
    // Create an existing page that the cross-ref pipeline can find
    await handleCreatePage({
      slug: "existing-topic",
      content: "# Existing Topic\n\nSome content about an existing topic.",
    });

    // Mock findRelatedPages to return the existing page as related
    const searchModule = await import("../search");
    const spy = vi.spyOn(searchModule, "findRelatedPages").mockResolvedValueOnce(["existing-topic"]);

    // Create a new page — cross-ref should wire up a backlink on existing-topic
    await handleCreatePage({
      slug: "new-topic",
      content: "# New Topic\n\nContent that relates to existing topic.",
    });

    // findRelatedPages should have been called (cross-ref pipeline entered)
    expect(spy).toHaveBeenCalled();

    // The existing page should now contain a "See also" link to new-topic
    const existingContent = await fs.readFile(
      path.join(tmpDir, "wiki", "existing-topic.md"),
      "utf-8",
    );
    expect(existingContent).toContain("See also:");
    expect(existingContent).toContain("new-topic.md");

    spy.mockRestore();
  });

  it("update_page triggers cross-ref update on related pages", async () => {
    // Create two pages
    await handleCreatePage({
      slug: "related-page",
      content: "# Related Page\n\nSome related content.",
    });
    await handleCreatePage({
      slug: "page-to-update",
      content: "# Page To Update\n\nOriginal body.",
    });

    // Mock findRelatedPages to return related-page as related
    const searchModule = await import("../search");
    const spy = vi.spyOn(searchModule, "findRelatedPages").mockResolvedValueOnce(["related-page"]);

    // Update the page — cross-ref should wire up a backlink on related-page
    await handleUpdatePage({
      slug: "page-to-update",
      content: "# Page To Update\n\nUpdated body referencing related topics.",
    });

    // findRelatedPages should have been called (cross-ref pipeline entered)
    expect(spy).toHaveBeenCalled();

    // The related page should now contain a "See also" link to page-to-update
    const relatedContent = await fs.readFile(
      path.join(tmpDir, "wiki", "related-page.md"),
      "utf-8",
    );
    expect(relatedContent).toContain("See also:");
    expect(relatedContent).toContain("page-to-update.md");

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent_context tool tests
// ---------------------------------------------------------------------------

describe("agent_context tool", () => {
  /** Helper — write an agent profile JSON to the agents directory. */
  async function writeAgentProfile(profile: {
    id: string;
    name: string;
    description: string;
    identityPages: string[];
    learningPages: string[];
    socialPages: string[];
  }): Promise<void> {
    const agentsDir = path.join(tmpDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const full = {
      ...profile,
      registered: "2026-05-03",
      lastUpdated: "2026-05-03",
    };
    await fs.writeFile(
      path.join(agentsDir, `${profile.id}.json`),
      JSON.stringify(full),
      "utf-8",
    );
  }

  it("returns agent context with page content", async () => {
    await writeAgentProfile({
      id: "test-agent",
      name: "Test Agent",
      description: "An agent for testing",
      identityPages: ["identity-page"],
      learningPages: ["learnings-page"],
      socialPages: ["social-page"],
    });

    await writeTestPage("identity-page", "# Identity\n\nI am a test agent.");
    await writeTestPage("learnings-page", "# Learnings\n\nI learned things.");
    await writeTestPage("social-page", "# Social\n\nPeople are interesting.");

    const result = await handleAgentContext({ agent_id: "test-agent" });

    // Verify full agent profile (matches HTTP API shape)
    expect(result.agent.id).toBe("test-agent");
    expect(result.agent.name).toBe("Test Agent");
    expect(result.agent.description).toBe("An agent for testing");
    expect(result.agent.identityPages).toEqual(["identity-page"]);
    expect(result.agent.learningPages).toEqual(["learnings-page"]);
    expect(result.agent.socialPages).toEqual(["social-page"]);
    expect(result.agent.registered).toBe("2026-05-03");
    expect(result.agent.lastUpdated).toBe("2026-05-03");

    // Verify context sections contain page content
    expect(result.context.identity).toContain("I am a test agent.");
    expect(result.context.learnings).toContain("I learned things.");
    expect(result.context.socialWisdom).toContain("People are interesting.");

    // Verify meta
    expect(result.meta.pageCount).toBe(3);
    expect(result.meta.totalChars).toBeGreaterThan(0);
  });

  it("throws for unknown agent", async () => {
    await expect(
      handleAgentContext({ agent_id: "nonexistent-agent" }),
    ).rejects.toThrow("Agent not found");
  });

  it("handles missing wiki pages gracefully", async () => {
    await writeAgentProfile({
      id: "sparse-agent",
      name: "Sparse Agent",
      description: "Agent with missing pages",
      identityPages: ["missing-identity"],
      learningPages: ["missing-learnings"],
      socialPages: ["missing-social"],
    });

    const result = await handleAgentContext({ agent_id: "sparse-agent" });

    // Should return successfully with empty content, not crash
    expect(result.agent.id).toBe("sparse-agent");
    expect(result.context.identity).toBe("");
    expect(result.context.learnings).toBe("");
    expect(result.context.socialWisdom).toBe("");
    expect(result.meta.pageCount).toBe(0);
    expect(result.meta.totalChars).toBe(0);
  });

  it("strips YAML frontmatter from page content", async () => {
    await writeAgentProfile({
      id: "fm-agent",
      name: "Frontmatter Agent",
      description: "Agent with frontmatter pages",
      identityPages: ["fm-identity"],
      learningPages: ["fm-learnings"],
      socialPages: ["fm-social"],
    });

    // Write pages with YAML frontmatter — this is how real wiki pages look
    await writeTestPage(
      "fm-identity",
      "---\nslug: fm-identity\nauthors: [yoyo]\nconfidence: 0.9\nexpiry: 2026-12-01\n---\n# Identity\n\nI am an agent with frontmatter.",
    );
    await writeTestPage(
      "fm-learnings",
      "---\nslug: fm-learnings\ntags: [learning]\n---\n# Learnings\n\nI learned to strip frontmatter.",
    );
    await writeTestPage(
      "fm-social",
      "---\nslug: fm-social\nconfidence: 0.8\n---\n# Social\n\nPeople are great.",
    );

    const result = await handleAgentContext({ agent_id: "fm-agent" });

    // Content should NOT contain YAML frontmatter delimiters from metadata
    expect(result.context.identity).not.toMatch(/^---/m);
    expect(result.context.learnings).not.toMatch(/^---/m);
    expect(result.context.socialWisdom).not.toMatch(/^---/m);

    // Content should NOT contain frontmatter fields
    expect(result.context.identity).not.toContain("slug: fm-identity");
    expect(result.context.identity).not.toContain("confidence: 0.9");

    // Content SHOULD contain the actual body text
    expect(result.context.identity).toContain("I am an agent with frontmatter.");
    expect(result.context.learnings).toContain("I learned to strip frontmatter.");
    expect(result.context.socialWisdom).toContain("People are great.");

    expect(result.meta.pageCount).toBe(3);
  });

  it("resolves template chain for forked agents", async () => {
    // Create a base agent with pages
    const agentsDir = path.join(tmpDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    const baseProfile = {
      id: "base-agent",
      name: "Base Agent",
      description: "The base template agent",
      identityPages: ["base-identity"],
      learningPages: ["base-learnings"],
      socialPages: ["base-social"],
      registered: "2026-05-03",
      lastUpdated: "2026-05-03",
    };
    await fs.writeFile(
      path.join(agentsDir, "base-agent.json"),
      JSON.stringify(baseProfile),
      "utf-8",
    );

    // Create a forked agent with NO own pages but pointing to the base template
    const forkedProfile = {
      id: "forked-agent",
      name: "Forked Agent",
      description: "A forked per-user agent",
      template: "base-agent",
      identityPages: [] as string[],
      learningPages: [] as string[],
      socialPages: [] as string[],
      registered: "2026-05-03",
      lastUpdated: "2026-05-03",
    };
    await fs.writeFile(
      path.join(agentsDir, "forked-agent.json"),
      JSON.stringify(forkedProfile),
      "utf-8",
    );

    // Write the base agent's pages
    await writeTestPage("base-identity", "# Base Identity\n\nI am the base.");
    await writeTestPage("base-learnings", "# Base Learnings\n\nBase learned things.");
    await writeTestPage("base-social", "# Base Social\n\nBase social wisdom.");

    const result = await handleAgentContext({ agent_id: "forked-agent" });

    // Forked agent should inherit base template's pages
    expect(result.context.identity).toContain("I am the base.");
    expect(result.context.learnings).toContain("Base learned things.");
    expect(result.context.socialWisdom).toContain("Base social wisdom.");
    expect(result.meta.pageCount).toBe(3);
    expect(result.meta.totalChars).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// seed_agent tool tests
// ---------------------------------------------------------------------------

describe("seed_agent tool", () => {
  it("creates agent and returns profile", async () => {
    const result = await handleSeedAgent({
      agent_id: "new-agent",
      name: "New Agent",
      description: "A freshly seeded agent",
      sections: [
        {
          slug: "new-agent-identity",
          title: "New Agent Identity",
          type: "identity",
          content: "I am a new agent.",
        },
        {
          slug: "new-agent-learnings",
          title: "New Agent Learnings",
          type: "learnings",
          content: "I have learned nothing yet.",
        },
        {
          slug: "new-agent-social",
          title: "New Agent Social",
          type: "social",
          content: "No social wisdom yet.",
        },
      ],
    });

    // Returns AgentProfile
    expect(result.id).toBe("new-agent");
    expect(result.name).toBe("New Agent");
    expect(result.description).toBe("A freshly seeded agent");
    expect(result.identityPages).toEqual(["new-agent-identity"]);
    expect(result.learningPages).toEqual(["new-agent-learnings"]);
    expect(result.socialPages).toEqual(["new-agent-social"]);
    expect(result.registered).toBeDefined();
    expect(result.lastUpdated).toBeDefined();

    // Verify wiki pages were created
    const identityPage = await fs.readFile(
      path.join(tmpDir, "wiki", "new-agent-identity.md"),
      "utf-8",
    );
    expect(identityPage).toContain("I am a new agent.");

    // Verify agent profile JSON was created
    const profileJson = await fs.readFile(
      path.join(tmpDir, "agents", "new-agent.json"),
      "utf-8",
    );
    const profile = JSON.parse(profileJson);
    expect(profile.id).toBe("new-agent");
  });

  it("throws with missing required field", async () => {
    await expect(
      handleSeedAgent({
        agent_id: "bad-agent",
        name: "",
        description: "Has no name",
        sections: [],
      }),
    ).rejects.toThrow();
  });

  it("is idempotent — re-seeding updates existing pages", async () => {
    // First seed
    const first = await handleSeedAgent({
      agent_id: "idempotent-agent",
      name: "Idempotent Agent",
      description: "Will be seeded twice",
      sections: [
        {
          slug: "idempotent-identity",
          title: "Identity",
          type: "identity",
          content: "Version 1 content.",
        },
      ],
    });

    expect(first.id).toBe("idempotent-agent");
    const firstRegistered = first.registered;

    // Re-seed with updated content
    const second = await handleSeedAgent({
      agent_id: "idempotent-agent",
      name: "Idempotent Agent v2",
      description: "Updated description",
      sections: [
        {
          slug: "idempotent-identity",
          title: "Identity v2",
          type: "identity",
          content: "Version 2 content.",
        },
      ],
    });

    // Should preserve original registration date
    expect(second.registered).toBe(firstRegistered);
    // But update the name and description
    expect(second.name).toBe("Idempotent Agent v2");
    expect(second.description).toBe("Updated description");

    // Wiki page should have updated content
    const pageContent = await fs.readFile(
      path.join(tmpDir, "wiki", "idempotent-identity.md"),
      "utf-8",
    );
    expect(pageContent).toContain("Version 2 content.");
    expect(pageContent).not.toContain("Version 1 content.");
  });
});

// ---------------------------------------------------------------------------
// update_metadata tests
// ---------------------------------------------------------------------------

describe("update_metadata", () => {
  it("updates frontmatter without changing body", async () => {
    await handleCreatePage({
      slug: "meta-test",
      content: "# Meta Test\n\nOriginal body.",
    });

    const result = await handleUpdateMetadata({
      slug: "meta-test",
      metadata: { confidence: 0.9, tags: ["ai", "test"] },
    });

    expect(result.slug).toBe("meta-test");
    expect(result.updated).toBe(true);

    // Verify frontmatter was updated
    const filePath = path.join(tmpDir, "wiki", "meta-test.md");
    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toContain("confidence: 0.9");
    expect(fileContent).toContain("ai");
    expect(fileContent).toContain("test");

    // Verify body is unchanged
    expect(fileContent).toContain("Original body.");
  });

  it("patches a PRIVATE page's metadata via the trusted MCP path (realm-aware ACL)", async () => {
    // MCP is deployment-trusted; update_metadata must still work on a private
    // page (the write ACL admits it via a service principal). Before the fix
    // this threw NOT_OWNER because no principal was threaded through.
    const { writeWikiPageWithSideEffects, serializeFrontmatter } = await import(
      "../wiki"
    );
    await writeWikiPageWithSideEffects({
      slug: "mcp-private",
      title: "MCP Private",
      content: serializeFrontmatter(
        {
          owner: "alice",
          visibility: "private",
          authors: ["alice"],
          contributors: [],
          created: "2026-01-01",
          confidence: 0.5,
          expiry: "2099-01-01",
          sources: [],
        },
        "# MCP Private\n\nSecret body.",
      ),
      summary: "private",
      logOp: "ingest",
      crossRefSource: null,
    });

    const result = await handleUpdateMetadata({
      slug: "mcp-private",
      metadata: { confidence: 0.95 },
    });
    expect(result.updated).toBe(true);

    const fileContent = await fs.readFile(
      path.join(tmpDir, "wiki", "mcp-private.md"),
      "utf-8",
    );
    expect(fileContent).toContain("confidence: 0.95");
    expect(fileContent).toContain("Secret body.");
    expect(fileContent).toContain("visibility: private");
  });

  it("rejects lifecycle-managed fields", async () => {
    await handleCreatePage({
      slug: "meta-lifecycle",
      content: "# Lifecycle\n\nBody.",
    });

    await expect(
      handleUpdateMetadata({
        slug: "meta-lifecycle",
        metadata: { created: "2020-01-01" },
      }),
    ).rejects.toThrow("cannot update lifecycle-managed fields via PATCH: created");

    await expect(
      handleUpdateMetadata({
        slug: "meta-lifecycle",
        metadata: { authors: ["hacker"] },
      }),
    ).rejects.toThrow("cannot update lifecycle-managed fields via PATCH: authors");

    await expect(
      handleUpdateMetadata({
        slug: "meta-lifecycle",
        metadata: { sources: ["http://example.com"] },
      }),
    ).rejects.toThrow("cannot update lifecycle-managed fields via PATCH: sources");
  });

  it("throws on non-existent page", async () => {
    await expect(
      handleUpdateMetadata({
        slug: "does-not-exist",
        metadata: { confidence: 0.5 },
      }),
    ).rejects.toThrow("page not found: does-not-exist");
  });

  it("silently ignores unknown fields", async () => {
    await handleCreatePage({
      slug: "meta-unknown",
      content: "# Unknown\n\nBody.",
    });

    const result = await handleUpdateMetadata({
      slug: "meta-unknown",
      metadata: { confidence: 0.7, random_field: "ignored" },
    });

    expect(result.updated).toBe(true);

    const filePath = path.join(tmpDir, "wiki", "meta-unknown.md");
    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toContain("confidence: 0.7");
    expect(fileContent).not.toContain("random_field");
  });

  it("tracks contributor attribution", async () => {
    await handleCreatePage({
      slug: "meta-contrib",
      content: "# Contrib\n\nBody.",
      author: "alice",
    });

    const result = await handleUpdateMetadata({
      slug: "meta-contrib",
      metadata: { confidence: 0.8 },
      author: "bob",
    });

    expect(result.updated).toBe(true);

    const filePath = path.join(tmpDir, "wiki", "meta-contrib.md");
    const fileContent = await fs.readFile(filePath, "utf-8");
    const parsed = parseFrontmatter(fileContent);
    const contributors = parsed.data.contributors as string[];
    expect(contributors).toContain("bob");
  });

  it("bumps updated timestamp", async () => {
    await writeTestPage(
      "meta-updated",
      "---\ntitle: Meta Updated\ncreated: '2025-01-01'\nupdated: '2025-01-01'\n---\n# Meta Updated\n\nBody.",
    );

    await handleUpdateMetadata({
      slug: "meta-updated",
      metadata: { disputed: true },
    });

    const filePath = path.join(tmpDir, "wiki", "meta-updated.md");
    const fileContent = await fs.readFile(filePath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(fileContent).toContain(`updated: ${today}`);
    expect(fileContent).toContain("disputed: true");
  });

  it("updates multiple patchable fields at once", async () => {
    await handleCreatePage({
      slug: "meta-multi",
      content: "# Multi\n\nBody.",
    });

    await handleUpdateMetadata({
      slug: "meta-multi",
      metadata: {
        confidence: 0.6,
        disputed: true,
        aliases: ["multi-alias"],
        expiry: "2026-12-31",
        valid_from: "2025-01-01",
        supersedes: "old-multi",
      },
    });

    const filePath = path.join(tmpDir, "wiki", "meta-multi.md");
    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toContain("confidence: 0.6");
    expect(fileContent).toContain("disputed: true");
    expect(fileContent).toContain("multi-alias");
    expect(fileContent).toContain("expiry: 2026-12-31");
    expect(fileContent).toContain("valid_from: 2025-01-01");
    expect(fileContent).toContain("supersedes: old-multi");
  });
});

// ---------------------------------------------------------------------------
// delete_page tests
// ---------------------------------------------------------------------------

describe("delete_page", () => {
  it("deletes an existing page and returns confirmation", async () => {
    // Create a page first
    await handleCreatePage({
      slug: "to-delete",
      content: "# To Delete\n\nThis page will be deleted.",
    });

    // Verify it exists
    const page = await handleReadPage({ slug: "to-delete" });
    expect(page.slug).toBe("to-delete");

    // Delete it
    const result = await handleDeletePage({ slug: "to-delete" });
    expect(result.slug).toBe("to-delete");
    expect(result.removedFromIndex).toBe(true);

    // Verify it's gone
    await expect(handleReadPage({ slug: "to-delete" })).rejects.toThrow(
      "Page not found",
    );
  });

  it("throws error for non-existent slug", async () => {
    await expect(
      handleDeletePage({ slug: "does-not-exist" }),
    ).rejects.toThrow("page not found");
  });

  it("strips backlinks from other pages when deleting", async () => {
    // Create two pages, one linking to the other
    await handleCreatePage({
      slug: "target",
      content: "# Target\n\nThis is the target page.",
    });
    await handleCreatePage({
      slug: "keeper",
      content:
        "# Keeper\n\nThis page links to [Target](target.md).\n\n**See also:** [Target](target.md)",
    });

    // Delete the target
    const result = await handleDeletePage({ slug: "target" });
    expect(result.slug).toBe("target");

    // The keeper page should have had backlinks stripped
    const keeper = await handleReadPage({ slug: "keeper" });
    expect(keeper.content).not.toContain("[Target](target.md)");
  });
});

// ---------------------------------------------------------------------------
// merge_pages tests
// ---------------------------------------------------------------------------

describe("merge_pages", () => {
  it("merges one page into another, recording a slug alias, and deletes the absorbed page", async () => {
    await handleCreatePage({
      slug: "concept-a",
      content: "# Concept A\n\nThe harness loop.",
      owner: "alice",
    });
    await handleCreatePage({
      slug: "concept-a-dup",
      content: "# Concept A Dup\n\nContext window management.",
      owner: "alice",
    });

    const result = await handleMergePages({
      from: "concept-a-dup",
      into: "concept-a",
      author: "alice",
    });
    expect(result).toMatchObject({
      fromSlug: "concept-a-dup",
      intoSlug: "concept-a",
    });

    // Absorbed page is gone; the survivor records its slug as an alias.
    await expect(handleReadPage({ slug: "concept-a-dup" })).rejects.toThrow(
      "Page not found",
    );
    const into = await readWikiPageWithFrontmatter("concept-a");
    expect(into!.frontmatter.aliases as string[]).toContain("concept-a-dup");
  });

  it("attributes merge to the given author, not 'system'", async () => {
    await handleCreatePage({
      slug: "merge-auth-a",
      content: "# Auth A\n\nFirst body.",
      owner: "tester",
    });
    await handleCreatePage({
      slug: "merge-auth-b",
      content: "# Auth B\n\nSecond body.",
      owner: "tester",
    });

    await handleMergePages({
      from: "merge-auth-b",
      into: "merge-auth-a",
      author: "agent-merger",
    });

    // The survivor's revision should be attributed to "agent-merger"
    const revisions = await handleListRevisions({ slug: "merge-auth-a" });
    expect(revisions.revisions.length).toBeGreaterThanOrEqual(1);
    const mergeRevision = revisions.revisions[revisions.revisions.length - 1];
    expect(mergeRevision.author).toBe("agent-merger");
  });

  it("throws when merging a page into itself", async () => {
    await handleCreatePage({ slug: "solo", content: "# Solo\n\nBody." });
    await expect(
      handleMergePages({ from: "solo", into: "solo" }),
    ).rejects.toThrow(/into itself/);
  });
});

// ---------------------------------------------------------------------------
// ingest_url tests
// ---------------------------------------------------------------------------

describe("ingest_url", () => {
  it("rejects invalid URLs", async () => {
    await expect(
      handleIngestUrl({ url: "not-a-url" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("rejects URLs without http/https protocol", async () => {
    await expect(
      handleIngestUrl({ url: "ftp://example.com/page" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("validates URL format before calling ingest", async () => {
    // Should throw immediately for obviously bad URLs
    // (not after trying to fetch)
    await expect(
      handleIngestUrl({ url: "" }),
    ).rejects.toThrow("Invalid URL");
  });
});

// ---------------------------------------------------------------------------
// batch_ingest_urls tests
// ---------------------------------------------------------------------------

describe("batch_ingest_urls", () => {
  it("rejects malformed URLs upfront", async () => {
    await expect(
      handleBatchIngest({ urls: ["https://example.com", "not-a-url", "also-bad"] }),
    ).rejects.toThrow("Malformed URLs at indices 1, 2");
  });

  it("rejects a single malformed URL in a batch", async () => {
    await expect(
      handleBatchIngest({ urls: ["ftp://bad.com"] }),
    ).rejects.toThrow("Malformed URLs");
  });

  it("enforces MAX_BATCH_URLS limit", async () => {
    // Create an array of 21 valid URLs (MAX_BATCH_URLS is 20)
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/page-${i}`);
    await expect(
      handleBatchIngest({ urls }),
    ).rejects.toThrow("exceeds the maximum batch size of 20");
  });

  it("ingests valid URLs and returns per-URL results", async () => {
    // Unset LLM keys so ingest uses the fallback (no-LLM) path
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      // fetchUrlContent is mocked — no real HTTP calls are made.
      // The mock returns deterministic { title, content } for each URL.
      const result = await handleBatchIngest({
        urls: ["https://example.com/page-a", "https://example.com/page-b"],
      });

      expect(result.total).toBe(2);
      expect(result.succeeded + result.failed).toBe(2);
      expect(result.results).toHaveLength(2);
      // Each result should have a url field
      expect(result.results[0].url).toBe("https://example.com/page-a");
      expect(result.results[1].url).toBe("https://example.com/page-b");
      // With the mock returning valid content, both should succeed
      expect(result.succeeded).toBe(2);
      for (const r of result.results) {
        expect(r.slug).toBeTruthy();
        expect(r.error).toBeUndefined();
      }
      // Verify the mock was called for each URL
      expect(mockedFetchUrlContent).toHaveBeenCalledTimes(2);
      expect(mockedFetchUrlContent).toHaveBeenCalledWith("https://example.com/page-a");
      expect(mockedFetchUrlContent).toHaveBeenCalledWith("https://example.com/page-b");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("returns empty results for empty URL array", async () => {
    // An empty array is technically valid (0 URLs, nothing to do)
    const result = await handleBatchIngest({ urls: [] });
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("files each successfully ingested page into the provided vault", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      await createVault("tester", "batch-vault");
      const vid = vaultIdFor("tester", "batch-vault");
      const result = await handleBatchIngest({
        urls: ["https://example.com/page-a", "https://example.com/page-b"],
        vaultId: vid,
      });
      expect(result.succeeded).toBe(2);
      const vault = await getVault(vid);
      for (const r of result.results) {
        expect(vault?.slugs).toContain(r.slug);
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ingest_text tests
// ---------------------------------------------------------------------------

describe("ingest_text", () => {
  it("rejects empty content", async () => {
    await expect(
      handleIngestText({ content: "" }),
    ).rejects.toThrow("content is required and must be non-empty");
  });

  it("rejects whitespace-only content", async () => {
    await expect(
      handleIngestText({ content: "   \n\t  " }),
    ).rejects.toThrow("content is required and must be non-empty");
  });

  it("ingests valid text content and creates a wiki page", async () => {
    // Temporarily unset LLM keys so ingest uses the fallback (no-LLM) path
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "Quantum computing uses qubits to perform calculations exponentially faster than classical computers for certain problems.",
        title: "Quantum Computing",
        tags: ["science", "computing"],
      });

      expect(result.slug).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(result.summary).toBeTruthy();
      expect(result.sourceUrl).toBe("");

      // Verify the page was actually created
      const page = await handleReadPage({ slug: result.slug });
      expect(page.content).toBeTruthy();
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("auto-generates title from content when title is omitted", async () => {
    // Temporarily unset LLM keys so ingest uses the fallback (no-LLM) path
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "Machine learning is a subset of artificial intelligence that enables systems to learn from data.",
      });

      expect(result.slug).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(result.sourceUrl).toBe("");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("attributes author from owner instead of defaulting to system", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "Author attribution test content for MCP ingest handlers.",
        title: "Author Attribution Test",
        owner: "agent-contributor",
      });

      expect(result.slug).toBeTruthy();
      const page = await handleReadPage({ slug: result.slug });
      expect(page.frontmatter.authors).toContain("agent-contributor");
      expect(page.frontmatter.authors).not.toContain("system");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("falls back to system when owner is not provided", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "Fallback author test — no owner provided to MCP handler.",
        title: "Fallback Author Test",
      });

      expect(result.slug).toBeTruthy();
      const page = await handleReadPage({ slug: result.slug });
      expect(page.frontmatter.authors).toContain("system");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("passes sourceUrl through to the page frontmatter", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "Text with known provenance from an external document.",
        title: "Provenance Text Test",
        sourceUrl: "https://example.com/original-doc",
      });

      expect(result.slug).toBeTruthy();
      expect(result.sourceUrl).toBe("https://example.com/original-doc");

      // Verify the page frontmatter contains the source URL
      const page = await handleReadPage({ slug: result.slug });
      const sources = typeof page.frontmatter.sources === "string"
        ? page.frontmatter.sources
        : JSON.stringify(page.frontmatter.sources ?? "");
      expect(sources).toContain("https://example.com/original-doc");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("defaults sourceType to text when not provided with sourceUrl", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "Default source type test content.",
        title: "Default SourceType Test",
        sourceUrl: "https://example.com/default-type",
      });

      expect(result.slug).toBeTruthy();

      // The page should still work — the default sourceType is "text"
      const page = await handleReadPage({ slug: result.slug });
      const sources = typeof page.frontmatter.sources === "string"
        ? page.frontmatter.sources
        : JSON.stringify(page.frontmatter.sources ?? "");
      expect(sources).toContain("text");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("without sourceUrl continues to work as before", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestText({
        content: "No source URL regression test content for MCP.",
        title: "No SourceUrl Test",
      });

      expect(result.slug).toBeTruthy();
      expect(result.sourceUrl).toBe("");
      expect(result.title).toBeTruthy();
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ingest_pdf tests
// ---------------------------------------------------------------------------

describe("ingest_pdf", () => {
  it("rejects invalid URLs", async () => {
    await expect(
      handleIngestPdf({ pdf_url: "not-a-url" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("rejects empty URL", async () => {
    await expect(
      handleIngestPdf({ pdf_url: "" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("passes owner and triggeredBy through to ingestPdf", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestPdf({
        pdf_url: "https://example.com/doc.pdf",
        owner: "alice",
        triggeredBy: "bob",
      });

      expect(result.slug).toBeTruthy();
      expect(result.sourceUrl).toBe("https://example.com/doc.pdf");

      // Verify the page was created with the correct owner in frontmatter
      const page = await handleReadPage({ slug: result.slug });
      expect(page.content).toBeTruthy();
      expect(page.frontmatter.owner).toBe("alice");
      // triggeredBy is recorded in the sources provenance entry
      const sources = typeof page.frontmatter.sources === "string"
        ? page.frontmatter.sources
        : "";
      expect(sources).toContain("bob");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("works without owner/triggeredBy (backward-compatible)", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestPdf({
        pdf_url: "https://example.com/another.pdf",
      });

      expect(result.slug).toBeTruthy();
      expect(result.sourceUrl).toBe("https://example.com/another.pdf");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("files the ingested page into the provided vault", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      await createVault("tester", "pdf-vault");
      const vid = vaultIdFor("tester", "pdf-vault");
      const result = await handleIngestPdf({
        pdf_url: "https://example.com/vault-doc.pdf",
        owner: "tester",
        vaultId: vid,
      });
      expect(result.slug).toBeTruthy();
      const vault = await getVault(vid);
      expect(vault).toBeTruthy();
      expect(vault!.slugs).toContain(result.slug);
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ingest_image tests
// ---------------------------------------------------------------------------

describe("ingest_image", () => {
  it("rejects invalid URLs", async () => {
    await expect(
      handleIngestImage({ url: "not-a-url" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("rejects empty URL", async () => {
    await expect(
      handleIngestImage({ url: "" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("ingests an image URL and returns slug and title", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestImage({
        url: "https://example.com/photo.png",
      });

      expect(result.slug).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(result.sourceUrl).toBe("https://example.com/photo.png");
      expect(result.summary).toBeTruthy();

      // Verify the page was actually created
      const page = await handleReadPage({ slug: result.slug });
      expect(page.content).toBeTruthy();
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("passes owner and triggeredBy through to ingestImage", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestImage({
        url: "https://example.com/diagram.jpg",
        owner: "alice",
        triggeredBy: "bob",
      });

      expect(result.slug).toBeTruthy();
      expect(result.sourceUrl).toBe("https://example.com/diagram.jpg");

      // Verify the page was created with the correct owner
      const page = await handleReadPage({ slug: result.slug });
      expect(page.frontmatter.owner).toBe("alice");
      // triggeredBy is recorded in sources provenance
      const sources = typeof page.frontmatter.sources === "string"
        ? page.frontmatter.sources
        : "";
      expect(sources).toContain("bob");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("files the ingested page into the provided vault", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      await createVault("tester", "img-vault");
      const vid = vaultIdFor("tester", "img-vault");
      const result = await handleIngestImage({
        url: "https://example.com/vault-photo.png",
        owner: "tester",
        vaultId: vid,
      });
      expect(result.slug).toBeTruthy();
      const vault = await getVault(vid);
      expect(vault).toBeTruthy();
      expect(vault!.slugs).toContain(result.slug);
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("forwards tags to ingestImage", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestImage({
        url: "https://example.com/tagged-photo.png",
        tags: ["photography", "test"],
      });

      expect(result.slug).toBeTruthy();

      // Verify the page was created with the expected tags
      const page = await handleReadPage({ slug: result.slug });
      expect(page.frontmatter.tags).toEqual(
        expect.arrayContaining(["photography", "test"]),
      );
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ingest_x_mention tests
// ---------------------------------------------------------------------------

describe("ingest_x_mention", () => {
  it("rejects empty URL", async () => {
    await expect(
      handleIngestXMention({ url: "", triggered_by: "@yoyo" }),
    ).rejects.toThrow("url is required and must be a non-empty string");
  });

  it("rejects non-X URLs", async () => {
    await expect(
      handleIngestXMention({ url: "https://example.com/post", triggered_by: "@yoyo" }),
    ).rejects.toThrow("url must be an x.com or twitter.com URL");
  });

  it("rejects http non-X domain", async () => {
    await expect(
      handleIngestXMention({ url: "https://facebook.com/post/123", triggered_by: "@user" }),
    ).rejects.toThrow("url must be an x.com or twitter.com URL");
  });

  it("rejects empty triggered_by", async () => {
    await expect(
      handleIngestXMention({ url: "https://x.com/user/status/123", triggered_by: "" }),
    ).rejects.toThrow("triggered_by is required and must be a non-empty string");
  });

  it("rejects whitespace-only triggered_by", async () => {
    await expect(
      handleIngestXMention({ url: "https://x.com/user/status/123", triggered_by: "   " }),
    ).rejects.toThrow("triggered_by is required and must be a non-empty string");
  });

  it("accepts valid x.com URL and returns result shape", async () => {
    // Use no-LLM fallback path; fetchUrlContent is mocked (no real HTTP)
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestXMention({
        url: "https://x.com/user/status/123",
        triggered_by: "@yoyo",
      });
      expect(result.slug).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(typeof result.summary).toBe("string");
      expect(result.sourceUrl).toBe("https://x.com/user/status/123");
      expect(mockedFetchXPostContent).toHaveBeenCalledWith("https://x.com/user/status/123");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("accepts valid twitter.com URL and returns result shape", async () => {
    // fetchUrlContent is mocked — no real HTTP calls to twitter.com
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestXMention({
        url: "https://twitter.com/user/status/456",
        triggered_by: "@someone",
      });
      expect(result.slug).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(typeof result.summary).toBe("string");
      expect(result.sourceUrl).toBe("https://twitter.com/user/status/456");
      expect(mockedFetchXPostContent).toHaveBeenCalledWith("https://twitter.com/user/status/456");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("accepts www.x.com URL and returns result shape", async () => {
    // fetchUrlContent is mocked — no real HTTP calls to x.com
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      const result = await handleIngestXMention({
        url: "https://www.x.com/user/status/789",
        triggered_by: "@agent",
      });
      expect(result.slug).toBeTruthy();
      expect(result.title).toBeTruthy();
      expect(typeof result.summary).toBe("string");
      expect(result.sourceUrl).toBe("https://www.x.com/user/status/789");
      expect(mockedFetchXPostContent).toHaveBeenCalledWith("https://www.x.com/user/status/789");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });
});

// ---------------------------------------------------------------------------
// query_wiki tests
// ---------------------------------------------------------------------------

describe("query_wiki", () => {
  it("returns structured result with answer and sources fields on empty wiki", async () => {
    const result = await handleQueryWiki({ question: "What is AI?" });
    expect(result).toHaveProperty("answer");
    expect(result).toHaveProperty("sources");
    expect(typeof result.answer).toBe("string");
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it("returns informative message when wiki is empty", async () => {
    const result = await handleQueryWiki({ question: "Tell me about neural networks" });
    expect(result.answer).toContain("empty");
    expect(result.sources).toEqual([]);
  });

  it("returns no-API-key fallback when wiki has pages but no LLM key", async () => {
    // Write a page directly to the filesystem (avoids side effects from create)
    await writeTestPage(
      "test-topic",
      "---\ntags: [test]\n---\n# Test Topic\n\nSome content about testing.",
    );
    await writeIndex([
      {
        title: "Test Topic",
        slug: "test-topic",
        summary: "Some content about testing",
      },
    ]);

    // Temporarily clear all LLM keys so query() takes the no-key fallback path
    const savedKeys: Record<string, string | undefined> = {};
    const keyNames = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "OLLAMA_BASE_URL",
      "OLLAMA_MODEL",
    ];
    for (const k of keyNames) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }
    _resetConfigCache(); // ensure loadConfigSync doesn't return cached provider

    try {
      const result = await handleQueryWiki({ question: "What about testing?" });
      // Without an API key, it should return the "No API key" message with page list
      expect(result.answer).toContain("test-topic");
      expect(result.sources).toEqual([]);
    } finally {
      // Restore all keys
      for (const k of keyNames) {
        if (savedKeys[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedKeys[k];
        }
      }
      _resetConfigCache();
    }
  });

  it("accepts format parameter without error", async () => {
    // Verify each format value is accepted
    const formats = ["prose", "table", "slides", "html"] as const;
    for (const format of formats) {
      const result = await handleQueryWiki({
        question: "What is AI?",
        format,
      });
      expect(result).toHaveProperty("answer");
      expect(result).toHaveProperty("sources");
    }
  });

  it("defaults to prose format when not specified", async () => {
    const result = await handleQueryWiki({ question: "What is AI?" });
    // Should work without error — prose is the default
    expect(result).toHaveProperty("answer");
  });

  it("accepts scope parameter without error", async () => {
    // Even with an invalid agent scope, should return a result (not crash)
    const result = await handleQueryWiki({
      question: "What is AI?",
      scope: "agent:nonexistent-agent",
    });
    expect(result).toHaveProperty("answer");
    expect(result).toHaveProperty("sources");
    // Invalid scope returns a descriptive message
    expect(result.answer).toContain("nonexistent-agent");
  });

  it("returns scoped message for agent with no pages", async () => {
    // Register an agent with no pages
    await registerAgent({
      id: "empty-bot",
      name: "Empty Bot",
      description: "An agent with no pages",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const result = await handleQueryWiki({
      question: "anything",
      scope: "agent:empty-bot",
    });
    // Should indicate no pages found for this scope
    expect(result.answer).toContain("No pages found");
    expect(result.sources).toEqual([]);
  });

  it("works without scope (backward compatible)", async () => {
    const result = await handleQueryWiki({ question: "What is AI?" });
    expect(result).toHaveProperty("answer");
    expect(result).toHaveProperty("sources");
  });
});

// ---------------------------------------------------------------------------
// save_query_answer tests
// ---------------------------------------------------------------------------

describe("save_query_answer", () => {
  it("saves an answer as a wiki page and returns slug", async () => {
    await writeIndex([]);

    const result = await handleSaveQueryAnswer({
      question: "What is machine learning?",
      answer: "Machine learning is a subset of AI that learns from data.",
    });

    expect(result.slug).toBe("what-is-machine-learning");
    expect(result.success).toBe(true);

    // Verify the page was actually written
    const page = await handleReadPage({ slug: "what-is-machine-learning" });
    expect(page.content).toContain("Machine learning is a subset of AI");
  });

  it("uses explicit slug when provided", async () => {
    await writeIndex([]);

    const result = await handleSaveQueryAnswer({
      question: "What is deep learning?",
      answer: "Deep learning uses neural networks with many layers.",
      slug: "deep-learning-overview",
    });

    expect(result.slug).toBe("deep-learning-overview");
    expect(result.success).toBe(true);

    // Verify the page exists at the explicit slug
    const page = await handleReadPage({ slug: "deep-learning-overview" });
    expect(page.content).toContain("Deep learning uses neural networks");
  });

  it("sets proper frontmatter on saved page", async () => {
    await writeIndex([]);

    await handleSaveQueryAnswer({
      question: "What is NLP?",
      answer: "Natural language processing deals with text and language.",
    });

    const page = await handleReadPage({ slug: "what-is-nlp" });
    expect(page.frontmatter).toBeDefined();
    expect(page.frontmatter.source).toBe("query");
    expect(page.frontmatter.tags).toContain("query-answer");
    expect(page.frontmatter.confidence).toBe(0.5);
    expect(page.frontmatter.authors).toContain("system");
  });

  it("throws when question is empty", async () => {
    await expect(
      handleSaveQueryAnswer({
        question: "",
        answer: "Some answer.",
      }),
    ).rejects.toThrow("question is required");
  });

  it("throws when answer is empty", async () => {
    await expect(
      handleSaveQueryAnswer({
        question: "A question?",
        answer: "",
      }),
    ).rejects.toThrow("answer is required");
  });

  it("accepts optional sources parameter without error", async () => {
    await writeIndex([]);

    const result = await handleSaveQueryAnswer({
      question: "How does reinforcement learning work?",
      answer: "RL uses rewards to train agents.",
      sources: ["machine-learning", "ai-fundamentals"],
    });

    expect(result.slug).toBeTruthy();
    expect(result.success).toBe(true);
  });

  it("saves html artifact with format and owner", async () => {
    await writeIndex([]);

    const result = await handleSaveQueryAnswer({
      question: "Revenue chart",
      answer: "<html><body><h1>Revenue</h1></body></html>",
      format: "html",
      owner: "alice",
    });

    expect(result.slug).toBe("revenue-chart");
    expect(result.success).toBe(true);

    // Verify the saved page has type: html and owner: alice
    const page = await handleReadPage({ slug: "revenue-chart" });
    expect(page.frontmatter.type).toBe("html");
    expect(page.frontmatter.owner).toBe("alice");
  });

  it("saves slides artifact with format and owner", async () => {
    await writeIndex([]);

    const slidesContent = "---\nmarp: true\n---\n# Slide 1\n\nHello world\n\n---\n\n# Slide 2\n\nGoodbye";
    const result = await handleSaveQueryAnswer({
      question: "Intro deck",
      answer: slidesContent,
      format: "slides",
      owner: "alice",
    });

    expect(result.slug).toBe("intro-deck");
    expect(result.success).toBe(true);

    // Verify the saved page has type: slides and owner: alice
    const page = await handleReadPage({ slug: "intro-deck" });
    expect(page.frontmatter.type).toBe("slides");
    expect(page.frontmatter.owner).toBe("alice");
    // Content preserved verbatim (slides are not modified)
    expect(page.content).toContain("marp: true");
    expect(page.content).toContain("# Slide 1");
  });

  it("defaults to markdown format when format is omitted", async () => {
    await writeIndex([]);

    const result = await handleSaveQueryAnswer({
      question: "Plain markdown answer",
      answer: "This is a plain text answer.",
    });

    expect(result.success).toBe(true);

    // Verify the page does NOT have type: html
    const page = await handleReadPage({ slug: "plain-markdown-answer" });
    expect(page.frontmatter.type).not.toBe("html");
  });

  it("files saved page into vault when vaultId is provided", async () => {
    await writeIndex([]);

    await createVault("tester", "query-vault");
    const vid = vaultIdFor("tester", "query-vault");

    const result = await handleSaveQueryAnswer({
      question: "What is transfer learning?",
      answer: "Transfer learning reuses a pre-trained model on a new task.",
      vaultId: vid,
    });

    expect(result.success).toBe(true);

    const vault = await getVault(vid);
    expect(vault).toBeTruthy();
    expect(vault!.slugs).toContain(result.slug);
  });

  it("works without vaultId (no vault filing)", async () => {
    await writeIndex([]);

    const result = await handleSaveQueryAnswer({
      question: "What is zero-shot learning?",
      answer: "Zero-shot learning classifies unseen categories.",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("what-is-zero-shot-learning");
  });
});

// ---------------------------------------------------------------------------
// query_history tests
// ---------------------------------------------------------------------------

describe("query_history", () => {
  it("returns empty array when no history exists for owner", async () => {
    const result = await handleQueryHistory({ owner: "testuser" });
    expect(result).toEqual({ entries: [] });
  });

  it("throws when owner is missing", async () => {
    await expect(handleQueryHistory({ owner: "" })).rejects.toThrow(
      "owner is required",
    );
  });

  it("returns entries most-recent-first", async () => {
    // Write a query history file directly
    const { tenantForOwner } = await import("../wiki");
    const tenant = tenantForOwner("histuser");
    const histDir = path.join(tmpDir, "tenants", tenant);
    await fs.mkdir(histDir, { recursive: true });
    const entries = [
      {
        id: "a1",
        question: "First question",
        answer: "First answer",
        sources: ["page-a"],
        timestamp: "2025-01-01T00:00:00Z",
        owner: "histuser",
      },
      {
        id: "a2",
        question: "Second question",
        answer: "Second answer",
        sources: ["page-b"],
        timestamp: "2025-01-02T00:00:00Z",
        owner: "histuser",
      },
    ];
    await fs.writeFile(
      path.join(histDir, "query-history.json"),
      JSON.stringify(entries),
    );

    const result = await handleQueryHistory({ owner: "histuser" });
    expect(result.entries).toHaveLength(2);
    // Most recent first (reversed)
    expect(result.entries[0].id).toBe("a2");
    expect(result.entries[1].id).toBe("a1");
    expect(result.entries[0].question).toBe("Second question");
  });

  it("respects limit parameter", async () => {
    const { tenantForOwner } = await import("../wiki");
    const tenant = tenantForOwner("limuser");
    const histDir = path.join(tmpDir, "tenants", tenant);
    await fs.mkdir(histDir, { recursive: true });
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}`,
      question: `Question ${i}`,
      answer: `Answer ${i}`,
      sources: [],
      timestamp: `2025-01-0${i + 1}T00:00:00Z`,
      owner: "limuser",
    }));
    await fs.writeFile(
      path.join(histDir, "query-history.json"),
      JSON.stringify(entries),
    );

    const result = await handleQueryHistory({ owner: "limuser", limit: 2 });
    expect(result.entries).toHaveLength(2);
    // Most recent first
    expect(result.entries[0].id).toBe("e4");
    expect(result.entries[1].id).toBe("e3");
  });

  it("uses default limit of 20", async () => {
    const { tenantForOwner } = await import("../wiki");
    const tenant = tenantForOwner("defuser");
    const histDir = path.join(tmpDir, "tenants", tenant);
    await fs.mkdir(histDir, { recursive: true });
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `d${i}`,
      question: `Q${i}`,
      answer: `A${i}`,
      sources: [],
      timestamp: new Date(2025, 0, i + 1).toISOString(),
      owner: "defuser",
    }));
    await fs.writeFile(
      path.join(histDir, "query-history.json"),
      JSON.stringify(entries),
    );

    const result = await handleQueryHistory({ owner: "defuser" });
    expect(result.entries).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// lint_wiki tests
// ---------------------------------------------------------------------------

describe("lint_wiki", () => {
  it("returns empty issues for a clean wiki", async () => {
    await writeTestPage(
      "test-page",
      '---\ntags: [test]\nconfidence: 0.8\nexpiry: 2099-01-01\ncreated: 2025-01-01\nupdated: 2025-01-01\nauthors: [tester]\nsources: \'[{"type":"url","url":"https://example.com","fetched":"2025-01-01","triggered_by":"tester"}]\'\n---\n# Test Page\n\nSome content here.',
    );
    await writeIndex([
      { title: "Test Page", slug: "test-page", summary: "Some content here." },
    ]);

    const result = await handleLintWiki({});
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("checkedAt");
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("detects orphan pages", async () => {
    // Page exists on disk but not in index
    await writeTestPage(
      "orphan-page",
      "---\ntags: [test]\n---\n# Orphan Page\n\nThis page is not in the index.",
    );
    await writeIndex([]); // empty index

    const result = await handleLintWiki({ checks: ["orphan-page"] });
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");
    expect(orphanIssues.length).toBe(1);
    expect(orphanIssues[0].slug).toBe("orphan-page");
  });

  it("detects stale index entries", async () => {
    // Index references a page that doesn't exist on disk
    await writeIndex([
      { title: "Ghost Page", slug: "ghost-page", summary: "Not on disk." },
    ]);

    const result = await handleLintWiki({ checks: ["stale-index"] });
    const staleIssues = result.issues.filter((i) => i.type === "stale-index");
    expect(staleIssues.length).toBe(1);
    expect(staleIssues[0].slug).toBe("ghost-page");
  });

  it("scopes checks via the checks parameter", async () => {
    await writeTestPage(
      "lonely-page",
      "---\ntags: [test]\n---\n# Lonely\n\nNo index entry.",
    );
    await writeIndex([]);

    // Only run stale-index — should not find orphan-page issues
    const result = await handleLintWiki({ checks: ["stale-index"] });
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");
    expect(orphanIssues.length).toBe(0);
  });

  it("filters by minSeverity", async () => {
    // Create a setup that produces info-level issues (orphan is warning)
    await writeTestPage(
      "orphan-sev",
      "---\ntags: [test]\n---\n# Orphan\n\nOrphan page.",
    );
    await writeIndex([]);

    // With minSeverity=error, warning-level orphan issues should be excluded
    const result = await handleLintWiki({
      checks: ["orphan-page"],
      minSeverity: "error",
    });
    expect(result.issues.length).toBe(0);
  });

  it("rejects invalid check types", async () => {
    await expect(
      handleLintWiki({ checks: ["nonexistent-check"] }),
    ).rejects.toThrow("Invalid check type");
  });

  it("rejects invalid minSeverity", async () => {
    await expect(
      handleLintWiki({ minSeverity: "extreme" }),
    ).rejects.toThrow("Invalid minSeverity");
  });
});

// ---------------------------------------------------------------------------
// fix_lint_issue tests
// ---------------------------------------------------------------------------

describe("fix_lint_issue", () => {
  it("fixes an orphan page by adding it to the index", async () => {
    await writeTestPage(
      "orphan-fix",
      "---\ntags: [test]\n---\n# Orphan Fix\n\nThis page should be added to the index.",
    );
    await writeIndex([]);

    const result = await handleFixLintIssue({
      type: "orphan-page",
      slug: "orphan-fix",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("orphan-fix");
    expect(result.message).toContain("orphan-fix");
  });

  it("fixes a stale index entry by removing it", async () => {
    await writeIndex([
      { title: "Stale Entry", slug: "stale-entry", summary: "Gone." },
    ]);

    const result = await handleFixLintIssue({
      type: "stale-index",
      slug: "stale-entry",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("stale-entry");
  });

  it("fixes an empty page by deleting it", async () => {
    await writeTestPage("empty-page", "---\ntags: []\n---\n");
    await writeIndex([
      { title: "Empty Page", slug: "empty-page", summary: "" },
    ]);

    const result = await handleFixLintIssue({
      type: "empty-page",
      slug: "empty-page",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("empty-page");
  });

  it("throws for page not found", async () => {
    await writeIndex([]);
    await expect(
      handleFixLintIssue({
        type: "orphan-page",
        slug: "nonexistent-page",
      }),
    ).rejects.toThrow("Page not found");
  });

  it("throws for unsupported fix type", async () => {
    await expect(
      handleFixLintIssue({
        type: "made-up-type",
        slug: "some-page",
      }),
    ).rejects.toThrow("not supported");
  });

  it("throws for low-confidence (not auto-fixable)", async () => {
    await expect(
      handleFixLintIssue({
        type: "low-confidence",
        slug: "some-page",
      }),
    ).rejects.toThrow("cannot be auto-fixed");
  });

  it("passes target parameter for cross-ref fixes", async () => {
    // Set up source and target pages
    await writeTestPage(
      "source-page",
      "---\ntags: [test]\n---\n# Source Page\n\nSome content about a topic.",
    );
    await writeTestPage(
      "target-page",
      "---\ntags: [test]\n---\n# Target Page\n\nRelated content.",
    );
    await writeIndex([
      { title: "Source Page", slug: "source-page", summary: "Source." },
      { title: "Target Page", slug: "target-page", summary: "Target." },
    ]);

    const result = await handleFixLintIssue({
      type: "missing-crossref",
      slug: "source-page",
      target: "target-page",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("source-page");
  });

  /**
   * `missing-concept-page` with no slug at all (DW-457).
   *
   * It is the one auto-fixable type whose handler reads `message` ALONE —
   * `FIX_HANDLERS["missing-concept-page"]` never destructures `slug`, and the
   * concept name (hence the slug it writes) comes out of the message. So the
   * handler's `slug` is optional, and an absent one reaches `fixLintIssue` as
   * `""`, exactly as `POST /api/lint/fix` converts it.
   */
  it("creates the stub page for a slug-less missing-concept-page", async () => {
    await writeIndex([]);

    const result = await handleFixLintIssue({
      type: "missing-concept-page",
      message:
        'Concept "Vector Search" is mentioned in ingest, retrieval but has no dedicated page. Both describe it at length.',
    });

    expect(result.success).toBe(true);
    // The slug is DERIVED from the message's concept name — proof that no
    // caller-supplied slug was needed, or used.
    expect(result.slug).toBe("vector-search");
    const page = await readWikiPageWithFrontmatter("vector-search");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Vector Search");
  });

  it("lets a slug-requiring type answer for its own missing slug", async () => {
    // The other half of the optional-`slug` trade. `""` reaches the handler and
    // its own message names the field AND the fact that this type needs it —
    // more than a rejection over an absent property could say.
    await expect(handleFixLintIssue({ type: "orphan-page" })).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  /**
   * The stdio door records NO trigger, because it resolves no principal (DW-447).
   *
   * `author` is `"lint-fix"` at every door now, and the other three pass the
   * handle they resolved as `triggeredBy` instead. This transport is
   * unauthenticated and deployment-trusted — every handler here runs with a
   * `null` principal — so there is no handle to pass, and the log line it writes
   * must stay byte-identical to the one this fix wrote before `triggeredBy`
   * existed. Asserted on the bytes in `wiki/log.md` rather than on the arguments
   * `handleFixLintIssue` forwards, because "unchanged output" is the claim.
   */
  it("writes a log line with no trigger parenthetical — stdio resolves no principal", async () => {
    await writeTestPage(
      "orphan-untriggered",
      "---\ntags: [test]\n---\n# Orphan Untriggered\n\nNo principal asked for this.",
    );
    await writeIndex([]);

    await handleFixLintIssue({ type: "orphan-page", slug: "orphan-untriggered" });

    const log = await getStorage().readFile(wikiRelPath("log.md"));
    expect(log).toContain("auto-fix: added orphan page to index\n");
    expect(log).not.toContain("(triggered by");
  });
});

/**
 * The id this door mints for its deployment-trusted system caller (DW-614).
 *
 * `handleUpdatePage`, `handleUpdateMetadata` and `handleDeletePage` fall back to
 * this principal when no explicit one is passed, and it is now minted from
 * `servicePrincipalId` instead of three raw literals. Nothing else observes the
 * VALUE: `owner-gate-parity`, `owner-handle` and `patch-metadata` each write
 * `"service:mcp"` out as a literal, but they build their own principals with it,
 * so they pin what those readers expect and would stay green if this door
 * started minting `service:mcp-stdio`. These two rows are the only thing
 * standing between that refactor and a silent change of identity.
 */
describe("the stdio door's service principal id", () => {
  it("is exactly `service:mcp`", () => {
    // The literal the untouched suites spell from the outside. Written out here
    // deliberately rather than recomputed from `servicePrincipalId` — a test
    // that rebuilds the value the same way the source does cannot catch the
    // source changing.
    expect(STDIO_SERVICE_PRINCIPAL_ID).toBe("service:mcp");
  });

  it("is recognized as a SERVICE principal by the predicate that grants writes", () => {
    // `authz.ts` spends `isServicePrincipalId` to let this caller write anything
    // on a deployment-trusted path. An id that stopped matching would not fail
    // loudly — the stdio door would quietly lose the grant it writes with.
    expect(isServicePrincipalId(STDIO_SERVICE_PRINCIPAL_ID)).toBe(true);
  });
});

/**
 * The stdio door's own `type` gate (DW-348).
 *
 * `handleFixLintIssue` keeps `type: string` — it is the handler both transports
 * share, so the gate belongs at each door. This one is the SDK's: `type` is
 * `z.enum(AUTO_FIXABLE_CHECK_TYPES)`, and `registerTool` validates the
 * arguments against that schema before the callback is entered. The HTTP door
 * has no such layer and carries its own gate; its rows live in
 * `mcp-http.test.ts`, next to `dispatchMcp`.
 *
 * Both rows below are needed and neither implies the other: the enum is the
 * SHAPE, the transport row is the ANSWER. A schema declared correctly but
 * registered on the wrong tool, or an SDK that stopped validating, would leave
 * the first green.
 */
describe("fix_lint_issue — the stdio door", () => {
  it("narrows the registered input schema to the fixable set", () => {
    // `_registeredTools` is private in TypeScript and readable at runtime — the
    // same idiom `mcp-annotations.test.ts` and the `mcp.json` sync test use.
    const server = createMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (server as any)._registeredTools.fix_lint_issue;
    const shape = entry.inputSchema.shape ?? entry.inputSchema;

    expect([...shape.type.options]).toEqual([...AUTO_FIXABLE_CHECK_TYPES]);
  });

  it("marks slug optional in the registered input schema", () => {
    // DW-457. `missing-concept-page` reads `message` alone, so a REQUIRED slug
    // made the one slug-less fix type uncallable here — the SDK would refuse
    // the arguments before the handler could ever see them. Asked as "does the
    // field accept an absent value", which is the property that matters,
    // rather than by naming a zod wrapper class.
    const server = createMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (server as any)._registeredTools.fix_lint_issue;
    const shape = entry.inputSchema.shape ?? entry.inputSchema;

    expect(shape.slug.safeParse(undefined).success).toBe(true);
    // Still a STRING when present — optional widened the presence, not the type.
    expect(shape.slug.safeParse(7).success).toBe(false);
  });

  describe("over a real client transport", () => {
    let client: Client;
    let closeTransport: () => Promise<void>;

    beforeAll(async () => {
      const server = createMcpServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      client = new Client({ name: "fix-lint-issue-test", version: "0.0.1" });
      await client.connect(clientTransport);
      closeTransport = async () => {
        await client.close();
        await server.close();
      };
    });

    afterAll(async () => {
      await closeTransport();
    });

    it("refuses a recognized-but-not-fixable type before the handler runs", async () => {
      const result = await client.callTool({
        name: "fix_lint_issue",
        arguments: { type: "disputed-page", slug: "contested-page" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0].text;
      // WHICH refusal this is, is the whole assertion. `fixLintIssue` answers a
      // non-fixable type with "… cannot be auto-fixed …", so that sentence
      // appearing here would mean the request travelled all the way to the
      // dispatcher and the schema gate did nothing. The SDK's own validation
      // message is the proof it was stopped at the transport — and it names the
      // field, which is what an agent needs to correct its call.
      expect(text).not.toContain("cannot be auto-fixed");
      expect(text.toLowerCase()).toContain("type");
    });

    it("refuses an unknown type the same way", async () => {
      const result = await client.callTool({
        name: "fix_lint_issue",
        arguments: { type: "made-up-type", slug: "p" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0].text;
      expect(text).not.toContain("Auto-fix not supported for this issue type");
    });

    it("still lets a fixable type through to the handler — the control", async () => {
      // The gate refuses what it should and nothing else. The page is absent, so
      // the dispatcher's own "Page not found" is the proof it ran: that error
      // can only come from `fixOrphanPage`, past the schema.
      const result = await client.callTool({
        name: "fix_lint_issue",
        arguments: { type: "orphan-page", slug: "absent-from-this-wiki" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(
        "Page not found: absent-from-this-wiki",
      );
    });

    it("accepts a slug-less missing-concept-page past the schema", async () => {
      // The DW-457 claim on this transport: the SDK's validation is what used
      // to stop this call, and a schema error names `slug` without ever
      // entering the callback. The message is deliberately UNPARSEABLE, so
      // `fixMissingConceptPage` refuses at its OWN regex — an error only
      // reachable from inside the handler, which is what makes it the proof
      // that the request got past the schema.
      const result = await client.callTool({
        name: "fix_lint_issue",
        arguments: { type: "missing-concept-page", message: "no concept sentence here" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0].text;
      expect(text).toContain("Could not parse concept name");
    });

    it("lets a slug-requiring type answer for its own missing slug", async () => {
      // The cost of the widening, and why it is worth paying: `orphan-page`
      // with no slug now reaches the handler as `""` and gets a message naming
      // the field and its own requirement, instead of the SDK's report about
      // an absent property.
      const result = await client.callTool({
        name: "fix_lint_issue",
        arguments: { type: "orphan-page" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(
        "Missing required field: slug",
      );
    });

    it("advertises slug as optional to a connected client", async () => {
      // What the agent reads before composing the call. A `required` list still
      // naming `slug` would keep the type unreachable in practice.
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "fix_lint_issue")!;

      expect(tool.inputSchema.required ?? []).not.toContain("slug");
      expect(tool.inputSchema.required ?? []).toContain("type");
      // Still ADVERTISED — optional is not absent; every other type needs it.
      expect(tool.inputSchema.properties).toHaveProperty("slug");
    });

    it("advertises the fixable list to a connected client", async () => {
      // What the agent actually reads before composing a call.
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "fix_lint_issue")!;
      const type = (tool.inputSchema.properties as {
        type: { enum?: string[] };
      }).type;

      expect(type.enum).toEqual([...AUTO_FIXABLE_CHECK_TYPES]);
      // The description must not still promise types the schema now refuses.
      expect(tool.description).not.toContain("Not all issue types are auto-fixable");
      expect(tool.description).toContain("suggestion");
    });
  });
});

// ---------------------------------------------------------------------------
// reingest tests
// ---------------------------------------------------------------------------

describe("reingest", () => {
  it("throws for missing slug", async () => {
    await expect(
      handleReingest({ slug: "" }),
    ).rejects.toThrow("slug is required");
  });

  it("throws for non-existent page", async () => {
    await expect(
      handleReingest({ slug: "nonexistent-page" }),
    ).rejects.toThrow('page "nonexistent-page" not found');
  });

  it("throws for page without source_url", async () => {
    await writeTestPage(
      "no-source",
      "---\ntags: [test]\n---\n# No Source\n\nThis page has no source URL.",
    );
    await writeIndex([
      { title: "No Source", slug: "no-source", summary: "No source URL" },
    ]);

    await expect(
      handleReingest({ slug: "no-source" }),
    ).rejects.toThrow("no source URL recorded");
  });

  it("re-ingests an X post via the syndication path, pinned to its slug", async () => {
    // Unset LLM keys so ingest uses the fallback (no-LLM) path
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      await writeTestPage(
        "a-tweet",
        "---\nsource_url: https://x.com/u/status/123\n---\n# A Tweet\n\nold body.",
      );
      await writeIndex([{ title: "A Tweet", slug: "a-tweet", summary: "a tweet" }]);
      mockedFetchXPostContent.mockClear();
      mockedFetchUrlContent.mockClear();

      const result = await handleReingest({ slug: "a-tweet" });

      // Uses the X syndication fetch, NOT the plain HTML fetch (which would
      // re-capture the "Something went wrong" shell), and stays on the same slug.
      expect(mockedFetchXPostContent).toHaveBeenCalledWith("https://x.com/u/status/123");
      expect(mockedFetchUrlContent).not.toHaveBeenCalled();
      expect(result.primarySlug).toBe("a-tweet");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("passes author provenance to reingest when provided", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      await writeTestPage(
        "authored-reingest",
        "---\nsource_url: https://x.com/u/status/456\n---\n# Authored\n\nold body.",
      );
      await writeIndex([
        { title: "Authored", slug: "authored-reingest", summary: "authored" },
      ]);
      mockedFetchXPostContent.mockClear();

      const result = await handleReingest({
        slug: "authored-reingest",
        author: "testuser",
      });
      expect(result.primarySlug).toBe("authored-reingest");

      // The page should have a revision attributed to "testuser".
      const revs = await handleListRevisions({ slug: "authored-reingest" });
      expect(revs.revisions.length).toBeGreaterThan(0);
      const latest = revs.revisions[0];
      expect(latest.author).toBe("testuser");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });

  it("works without author (backwards compatible)", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCache();
    try {
      await writeTestPage(
        "no-author-reingest",
        "---\nsource_url: https://x.com/u/status/789\n---\n# NoAuthor\n\nold body.",
      );
      await writeIndex([
        { title: "NoAuthor", slug: "no-author-reingest", summary: "no author" },
      ]);
      mockedFetchXPostContent.mockClear();

      const result = await handleReingest({ slug: "no-author-reingest" });
      expect(result.primarySlug).toBe("no-author-reingest");
    } finally {
      if (savedKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
      _resetConfigCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ingest_history
// ---------------------------------------------------------------------------

describe("ingest_history", () => {
  it("returns empty array when no ledger file exists", async () => {
    const result = await handleIngestHistory({});
    expect(result).toEqual({ entries: [] });
  });

  it("returns empty array with explicit limit", async () => {
    const result = await handleIngestHistory({ limit: 10 });
    expect(result).toEqual({ entries: [] });
  });

  it("returns ledger entries when ledger exists", async () => {
    // Write a ledger file with two entries
    const dataDir = path.join(tmpDir, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const ledgerPath = path.join(dataDir, "ingest-ledger.jsonl");
    const entry1 = {
      ingest_id: "test-1",
      source_type: "url",
      source_url: "https://example.com/a",
      primary_slug: "example-a",
      related_slugs: [],
      started_at: "2025-01-01T00:00:00Z",
      finished_at: "2025-01-01T00:01:00Z",
      status: "ok",
    };
    const entry2 = {
      ingest_id: "test-2",
      source_type: "text",
      source_url: "",
      primary_slug: "pasted-text",
      related_slugs: ["related-page"],
      started_at: "2025-01-02T00:00:00Z",
      finished_at: "2025-01-02T00:01:00Z",
      status: "ok",
    };
    await fs.writeFile(
      ledgerPath,
      JSON.stringify(entry1) + "\n" + JSON.stringify(entry2) + "\n",
    );

    const result = await handleIngestHistory({});
    expect(result.entries).toHaveLength(2);
    // Most recent first
    expect(result.entries[0].ingest_id).toBe("test-2");
    expect(result.entries[1].ingest_id).toBe("test-1");
  });

  it("respects limit parameter", async () => {
    const dataDir = path.join(tmpDir, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const ledgerPath = path.join(dataDir, "ingest-ledger.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({
          ingest_id: `test-${i}`,
          source_type: "url",
          source_url: `https://example.com/${i}`,
          primary_slug: `page-${i}`,
          related_slugs: [],
          started_at: `2025-01-0${i + 1}T00:00:00Z`,
          finished_at: `2025-01-0${i + 1}T00:01:00Z`,
          status: "ok",
        }),
      );
    }
    await fs.writeFile(ledgerPath, lines.join("\n") + "\n");

    const result = await handleIngestHistory({ limit: 2 });
    expect(result.entries).toHaveLength(2);
    // Most recent first — last entry should come first
    expect(result.entries[0].ingest_id).toBe("test-4");
    expect(result.entries[1].ingest_id).toBe("test-3");
  });

  it("defaults to limit 50 when not specified", async () => {
    const dataDir = path.join(tmpDir, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const ledgerPath = path.join(dataDir, "ingest-ledger.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(
        JSON.stringify({
          ingest_id: `test-${i}`,
          source_type: "url",
          source_url: `https://example.com/${i}`,
          primary_slug: `page-${i}`,
          related_slugs: [],
          started_at: "2025-01-01T00:00:00Z",
          finished_at: "2025-01-01T00:01:00Z",
          status: "ok",
        }),
      );
    }
    await fs.writeFile(ledgerPath, lines.join("\n") + "\n");

    const result = await handleIngestHistory({});
    expect(result.entries).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// create_page author attribution tests
// ---------------------------------------------------------------------------

describe("handleCreatePage author attribution", () => {
  it("sets authors to provided author", async () => {
    await writeIndex([]);
    const result = await handleCreatePage({
      slug: "test-page",
      content: "# Test Page\n\nSome content.",
      author: "yoyo",
    });
    expect(result.created).toBe(true);

    const raw = await fs.readFile(
      path.join(tmpDir, "wiki", "test-page.md"),
      "utf-8",
    );
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.authors).toEqual(["yoyo"]);
  });

  it("defaults authors to agent when no author provided", async () => {
    await writeIndex([]);
    const result = await handleCreatePage({
      slug: "default-author",
      content: "# Default\n\nContent.",
    });
    expect(result.created).toBe(true);

    const raw = await fs.readFile(
      path.join(tmpDir, "wiki", "default-author.md"),
      "utf-8",
    );
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.authors).toEqual(["agent"]);
  });
});

// ---------------------------------------------------------------------------
// update_page contributor attribution tests
// ---------------------------------------------------------------------------

describe("handleUpdatePage contributor attribution", () => {
  it("appends author to contributors in frontmatter", async () => {
    await writeTestPage(
      "existing-page",
      "---\ntitle: Existing\nauthors: [original-author]\ncontributors: []\n---\n# Existing\n\nOriginal content.",
    );
    await writeIndex([
      { title: "Existing", slug: "existing-page", summary: "Original" },
    ]);

    await handleUpdatePage({
      slug: "existing-page",
      content: "# Existing\n\nUpdated content.",
      author: "yoyo",
    });

    const raw = await fs.readFile(
      path.join(tmpDir, "wiki", "existing-page.md"),
      "utf-8",
    );
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.contributors).toContain("yoyo");
  });

  it("does not duplicate existing contributor", async () => {
    await writeTestPage(
      "dup-page",
      "---\ntitle: Dup\nauthors: [someone]\ncontributors: [yoyo]\n---\n# Dup\n\nContent.",
    );
    await writeIndex([
      { title: "Dup", slug: "dup-page", summary: "Content" },
    ]);

    await handleUpdatePage({
      slug: "dup-page",
      content: "# Dup\n\nNew content.",
      author: "yoyo",
    });

    const raw = await fs.readFile(
      path.join(tmpDir, "wiki", "dup-page.md"),
      "utf-8",
    );
    const parsed = parseFrontmatter(raw);
    const contributors = parsed.data.contributors as string[];
    expect(contributors.filter((c) => c === "yoyo")).toHaveLength(1);
  });

  it("does not modify contributors when no author provided", async () => {
    await writeTestPage(
      "no-author-page",
      "---\ntitle: NoAuthor\nauthors: [someone]\ncontributors: [existing]\n---\n# NoAuthor\n\nContent.",
    );
    await writeIndex([
      { title: "NoAuthor", slug: "no-author-page", summary: "Content" },
    ]);

    await handleUpdatePage({
      slug: "no-author-page",
      content: "# NoAuthor\n\nUpdated.",
    });

    const raw = await fs.readFile(
      path.join(tmpDir, "wiki", "no-author-page.md"),
      "utf-8",
    );
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.contributors).toEqual(["existing"]);
  });
});

// ---------------------------------------------------------------------------
// list_agents tests
// ---------------------------------------------------------------------------

describe("list_agents", () => {
  it("returns empty array when no agents registered", async () => {
    const result = await handleListAgents();
    expect(result.agents).toEqual([]);
  });

  it("returns registered agents with id, name, description", async () => {
    await registerAgent({
      id: "agent-a",
      name: "Agent A",
      description: "First agent",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: "2025-01-01T00:00:00.000Z",
      lastUpdated: "2025-01-01T00:00:00.000Z",
    });
    await registerAgent({
      id: "agent-b",
      name: "Agent B",
      description: "Second agent",
      identityPages: ["b-identity"],
      learningPages: [],
      socialPages: [],
      registered: "2025-02-01T00:00:00.000Z",
      lastUpdated: "2025-02-01T00:00:00.000Z",
    });

    const result = await handleListAgents();
    expect(result.agents).toHaveLength(2);

    const ids = result.agents.map((a) => a.id).sort();
    expect(ids).toEqual(["agent-a", "agent-b"]);

    const agentA = result.agents.find((a) => a.id === "agent-a");
    expect(agentA).toBeDefined();
    expect(agentA!.name).toBe("Agent A");
    expect(agentA!.description).toBe("First agent");
    expect(agentA!.registered).toBe("2025-01-01T00:00:00.000Z");
    expect(agentA!.lastUpdated).toBe("2025-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// update_agent tests
// ---------------------------------------------------------------------------

describe("update_agent", () => {
  it("updates agent name and description", async () => {
    await registerAgent({
      id: "updatable",
      name: "Original Name",
      description: "Original description",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: "2025-01-01T00:00:00.000Z",
      lastUpdated: "2025-01-01T00:00:00.000Z",
    });

    const result = await handleUpdateAgent({
      agent_id: "updatable",
      name: "Updated Name",
      description: "Updated description",
    });

    expect(result.id).toBe("updatable");
    expect(result.name).toBe("Updated Name");
    expect(result.description).toBe("Updated description");
  });

  it("throws when agent does not exist", async () => {
    await expect(
      handleUpdateAgent({
        agent_id: "nonexistent",
        name: "New Name",
      }),
    ).rejects.toThrow("Agent not found: nonexistent");
  });

  it("accepts partial updates (name only)", async () => {
    await registerAgent({
      id: "partial-update",
      name: "Old Name",
      description: "Keep this",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: "2025-01-01T00:00:00.000Z",
      lastUpdated: "2025-01-01T00:00:00.000Z",
    });

    const result = await handleUpdateAgent({
      agent_id: "partial-update",
      name: "New Name",
    });

    expect(result.name).toBe("New Name");
    expect(result.description).toBe("Keep this");
  });

  it("removes pages from agent profile", async () => {
    await registerAgent({
      id: "page-remover",
      name: "Page Remover",
      description: "Test agent",
      identityPages: ["page-a", "page-b"],
      learningPages: ["page-c"],
      socialPages: [],
      registered: "2025-01-01T00:00:00.000Z",
      lastUpdated: "2025-01-01T00:00:00.000Z",
    });

    const result = await handleUpdateAgent({
      agent_id: "page-remover",
      removePages: ["page-b", "page-c"],
    });

    expect(result.identityPages).toEqual(["page-a"]);
    expect(result.learningPages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// delete_agent tests
// ---------------------------------------------------------------------------

describe("delete_agent", () => {
  it("deletes an existing agent", async () => {
    await registerAgent({
      id: "to-delete",
      name: "Delete Me",
      description: "Will be deleted",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: "2025-01-01T00:00:00.000Z",
      lastUpdated: "2025-01-01T00:00:00.000Z",
    });

    const result = await handleDeleteAgent({ agent_id: "to-delete" });
    expect(result.deleted).toBe(true);
    expect(result.agent_id).toBe("to-delete");

    // Verify agent is actually gone
    const listing = await handleListAgents();
    expect(listing.agents.find((a) => a.id === "to-delete")).toBeUndefined();
  });

  it("throws when agent does not exist", async () => {
    await expect(
      handleDeleteAgent({ agent_id: "nonexistent" }),
    ).rejects.toThrow("Agent not found: nonexistent");
  });
});

// ---------------------------------------------------------------------------
// dataview_query tests
// ---------------------------------------------------------------------------

describe("dataview_query", () => {
  beforeEach(async () => {
    // Create test pages with various frontmatter fields
    await writeTestPage(
      "alpha",
      `---
title: Alpha Page
confidence: 0.9
tags: [machine-learning, ai]
created: "2025-01-15"
authors: [yoyo]
---
# Alpha Page

Content about alpha.`,
    );
    await writeTestPage(
      "beta",
      `---
title: Beta Page
confidence: 0.3
tags: [databases]
created: "2025-02-20"
authors: [human]
---
# Beta Page

Content about beta.`,
    );
    await writeTestPage(
      "gamma",
      `---
title: Gamma Page
confidence: 0.7
tags: [machine-learning]
created: "2025-03-10"
authors: [yoyo]
disputed: true
---
# Gamma Page

Content about gamma.`,
    );
    await writeIndex([
      { title: "Alpha Page", slug: "alpha", summary: "About alpha" },
      { title: "Beta Page", slug: "beta", summary: "About beta" },
      { title: "Gamma Page", slug: "gamma", summary: "About gamma" },
    ]);
  });

  it("returns all pages when no filters are given", async () => {
    const result = await handleDataviewQuery({});
    expect(result.total).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  it("filters by a single field (confidence < 0.5)", async () => {
    const result = await handleDataviewQuery({
      filters: [{ field: "confidence", op: "lt", value: "0.5" }],
    });
    expect(result.total).toBe(1);
    expect(result.results[0].slug).toBe("beta");
  });

  it("filters with multiple conditions (AND semantics)", async () => {
    const result = await handleDataviewQuery({
      filters: [
        { field: "tags", op: "contains", value: "machine-learning" },
        { field: "confidence", op: "gte", value: "0.8" },
      ],
    });
    expect(result.total).toBe(1);
    expect(result.results[0].slug).toBe("alpha");
  });

  it("supports the contains operator on tags", async () => {
    const result = await handleDataviewQuery({
      filters: [{ field: "tags", op: "contains", value: "machine-learning" }],
    });
    expect(result.total).toBe(2);
    const slugs = result.results.map((r) => r.slug).sort();
    expect(slugs).toEqual(["alpha", "gamma"]);
  });

  it("supports the exists operator", async () => {
    const result = await handleDataviewQuery({
      filters: [{ field: "disputed", op: "exists" }],
    });
    expect(result.total).toBe(1);
    expect(result.results[0].slug).toBe("gamma");
  });

  it("sorts results by a frontmatter field ascending", async () => {
    const result = await handleDataviewQuery({
      sortBy: "confidence",
      sortOrder: "asc",
    });
    expect(result.results.map((r) => r.slug)).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
  });

  it("sorts results by a frontmatter field descending", async () => {
    const result = await handleDataviewQuery({
      sortBy: "created",
      sortOrder: "desc",
    });
    expect(result.results.map((r) => r.slug)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("respects the limit parameter", async () => {
    const result = await handleDataviewQuery({
      sortBy: "confidence",
      sortOrder: "desc",
      limit: 2,
    });
    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].slug).toBe("alpha");
    expect(result.results[1].slug).toBe("gamma");
  });

  it("throws on invalid filter operator", async () => {
    await expect(
      handleDataviewQuery({
        filters: [{ field: "confidence", op: "invalid_op", value: "0.5" }],
      }),
    ).rejects.toThrow('unknown filter op: "invalid_op"');
  });

  it("throws on missing value for non-exists operator", async () => {
    await expect(
      handleDataviewQuery({
        filters: [{ field: "confidence", op: "gt" }],
      }),
    ).rejects.toThrow('requires a value');
  });

  it("throws on invalid limit", async () => {
    await expect(
      handleDataviewQuery({ limit: -1 }),
    ).rejects.toThrow("limit must be a positive integer");
  });

  it("throws on limit exceeding maximum", async () => {
    await expect(
      handleDataviewQuery({ limit: 999 }),
    ).rejects.toThrow("limit exceeds maximum of 200");
  });

  it("combines filters, sort, and limit", async () => {
    const result = await handleDataviewQuery({
      filters: [{ field: "authors", op: "contains", value: "yoyo" }],
      sortBy: "confidence",
      sortOrder: "desc",
      limit: 1,
    });
    expect(result.total).toBe(1);
    expect(result.results[0].slug).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// list_revisions
// ---------------------------------------------------------------------------

describe("list_revisions", () => {
  it("returns empty revisions array for a page with no edits", async () => {
    await writeTestPage("test-page", "---\ntitle: Test\n---\n# Test\nHello");
    const result = await handleListRevisions({ slug: "test-page" });
    expect(result.slug).toBe("test-page");
    expect(result.revisions).toEqual([]);
  });

  it("returns revisions after a page is updated", async () => {
    // Create the page
    await writeTestPage("test-page", "---\ntitle: Test\n---\n# Test\nVersion 1");

    // Save a revision (simulates what happens before an update)
    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision("test-page", "---\ntitle: Test\n---\n# Test\nVersion 1", "yoyo", "initial save");

    const result = await handleListRevisions({ slug: "test-page" });
    expect(result.slug).toBe("test-page");
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0].slug).toBe("test-page");
    expect(result.revisions[0].author).toBe("yoyo");
    expect(result.revisions[0].reason).toBe("initial save");
    expect(typeof result.revisions[0].timestamp).toBe("number");
    expect(typeof result.revisions[0].date).toBe("string");
    expect(typeof result.revisions[0].sizeBytes).toBe("number");
  });

  it("throws for a nonexistent page", async () => {
    await expect(
      handleListRevisions({ slug: "no-such-page" }),
    ).rejects.toThrow("page not found: no-such-page");
  });

  it("throws for an invalid slug", async () => {
    await expect(
      handleListRevisions({ slug: "INVALID SLUG!" }),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("throws when slug is empty", async () => {
    await expect(
      handleListRevisions({ slug: "" }),
    ).rejects.toThrow("slug is required");
  });
});

// ---------------------------------------------------------------------------
// read_revision
// ---------------------------------------------------------------------------

describe("read_revision", () => {
  it("returns the content of a specific revision", async () => {
    const content = "---\ntitle: Test\n---\n# Test\nVersion 1";
    await writeTestPage("test-page", content);

    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision("test-page", content, "yoyo", "snapshot");

    // Get the timestamp from list
    const list = await handleListRevisions({ slug: "test-page" });
    expect(list.revisions).toHaveLength(1);
    const ts = list.revisions[0].timestamp;

    const result = await handleReadRevision({ slug: "test-page", timestamp: ts });
    expect(result.slug).toBe("test-page");
    expect(result.timestamp).toBe(ts);
    expect(result.content).toBe(content);
    expect(result.revision.timestamp).toBe(ts);
    expect(result.revision.slug).toBe("test-page");
    expect(typeof result.revision.date).toBe("string");
    expect(typeof result.revision.sizeBytes).toBe("number");
    expect(result.revision.sizeBytes).toBeGreaterThan(0);
    expect(result.revision.author).toBe("yoyo");
    expect(result.revision.reason).toBe("snapshot");
  });

  it("throws for a nonexistent page", async () => {
    await expect(
      handleReadRevision({ slug: "no-such-page", timestamp: 1234567890 }),
    ).rejects.toThrow("page not found: no-such-page");
  });

  it("throws for a nonexistent revision timestamp", async () => {
    await writeTestPage("test-page", "---\ntitle: Test\n---\n# Test\nHello");
    await expect(
      handleReadRevision({ slug: "test-page", timestamp: 9999999999999 }),
    ).rejects.toThrow("revision not found: 9999999999999");
  });

  it("throws for an invalid slug", async () => {
    await expect(
      handleReadRevision({ slug: "BAD SLUG!", timestamp: 123 }),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("throws when slug is empty", async () => {
    await expect(
      handleReadRevision({ slug: "", timestamp: 123 }),
    ).rejects.toThrow("slug is required");
  });

  it("throws for invalid timestamp values", async () => {
    await expect(
      handleReadRevision({ slug: "test-page", timestamp: -1 }),
    ).rejects.toThrow("timestamp must be a positive number");

    await expect(
      handleReadRevision({ slug: "test-page", timestamp: 0 }),
    ).rejects.toThrow("timestamp must be a positive number");
  });
});

// ---------------------------------------------------------------------------
// Visibility enforcement — private pages must not leak through MCP
// ---------------------------------------------------------------------------

describe("visibility enforcement", () => {
  const PUBLIC_PAGE = [
    "---",
    "title: Public Page",
    "owner: alice",
    "visibility: public",
    "---",
    "# Public Page",
    "",
    "This page is public.",
  ].join("\n");

  const PRIVATE_PAGE = [
    "---",
    "title: Secret Page",
    "owner: alice",
    "visibility: private",
    "---",
    "# Secret Page",
    "",
    "This page is private and should not leak.",
  ].join("\n");

  it("handleListPages excludes private pages", async () => {
    await writeTestPage("public-page", PUBLIC_PAGE);
    await writeTestPage("secret-page", PRIVATE_PAGE);
    await writeIndex([
      { title: "Public Page", slug: "public-page", summary: "Public" },
      { title: "Secret Page", slug: "secret-page", summary: "Secret" },
    ]);

    const result = await handleListPages({});
    const slugs = result.map((p) => p.slug);
    expect(slugs).toContain("public-page");
    expect(slugs).not.toContain("secret-page");
  });

  it("handleReadPage throws for a private page", async () => {
    await writeTestPage("secret-page", PRIVATE_PAGE);

    await expect(handleReadPage({ slug: "secret-page" })).rejects.toThrow(
      "Page not found: secret-page",
    );
  });

  it("handleReadPage succeeds for a public page", async () => {
    await writeTestPage("public-page", PUBLIC_PAGE);

    const result = await handleReadPage({ slug: "public-page" });
    expect(result.slug).toBe("public-page");
    expect(result.title).toBe("Public Page");
  });

  it("handleSearchWiki excludes private page content", async () => {
    await writeTestPage("public-page", PUBLIC_PAGE);
    await writeTestPage("secret-page", PRIVATE_PAGE);
    await writeIndex([
      { title: "Public Page", slug: "public-page", summary: "s" },
      { title: "Secret Page", slug: "secret-page", summary: "s" },
    ]);

    const results = await handleSearchWiki({ query: "page" });
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("public-page");
    expect(slugs).not.toContain("secret-page");
  });
});

// ---------------------------------------------------------------------------
// wiki_graph
// ---------------------------------------------------------------------------

describe("wiki_graph", () => {
  it("returns nodes and edges for commons pages", async () => {
    await writeTestPage(
      "graph-a",
      "---\ntitle: Graph A\ntags: [alpha]\n---\n# Graph A\n\nSee [Graph B](graph-b.md).",
    );
    await writeTestPage(
      "graph-b",
      "---\ntitle: Graph B\ntags: [beta, gamma]\n---\n# Graph B\n\nStands alone.",
    );
    await writeIndex([
      { title: "Graph A", slug: "graph-a", summary: "First graph page" },
      { title: "Graph B", slug: "graph-b", summary: "Second graph page" },
    ]);

    const result = await handleWikiGraph({});

    // Should have both nodes
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    const nodeA = result.nodes.find((n) => n.id === "graph-a");
    const nodeB = result.nodes.find((n) => n.id === "graph-b");
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();
    expect(nodeA!.label).toBe("Graph A");
    expect(nodeA!.tags).toEqual(["alpha"]);
    expect(nodeB!.label).toBe("Graph B");
    expect(nodeB!.tags).toEqual(["beta", "gamma"]);

    // Should have an edge from graph-a → graph-b
    const edge = result.edges.find(
      (e) => e.source === "graph-a" && e.target === "graph-b",
    );
    expect(edge).toBeDefined();

    // linkCount should be computed (inbound + outbound)
    expect(nodeA!.linkCount).toBeGreaterThanOrEqual(1);
    expect(nodeB!.linkCount).toBeGreaterThanOrEqual(1);
  });

  it("returns empty nodes/edges when no pages exist", async () => {
    const result = await handleWikiGraph({});
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// vault_curate / vault_uncurate tests
// ---------------------------------------------------------------------------

describe("vault_curate", () => {
  it("curates a public commons page into a named vault, creating it on first use", async () => {
    // Create a public commons page (no visibility = public by default)
    await writeTestPage(
      "machine-learning",
      "---\ntitle: Machine Learning\n---\n# Machine Learning\n\nML is a subset of AI.",
    );

    const result = await handleVaultCurate({
      slug: "machine-learning",
      owner: "alice",
      vault: "AI Reading",
    });
    expect(result).toEqual({
      curated: true,
      slug: "machine-learning",
      owner: "alice",
      vault: "AI Reading",
    });

    // The named vault was created and now contains the page.
    const id = vaultIdFor("alice", "AI Reading");
    const vaults = await listVaults("alice");
    expect(vaults.map((v) => v.id)).toContain(id);
    const vault = await getVault(id);
    expect(vault?.visibility).toBe("public");
    expect(vault?.slugs).toContain("machine-learning");
  });

  it("curates a public ARTIFACT (html) into a vault — parity with the UI", async () => {
    await writeTestPage(
      "explainer",
      "---\ntitle: Explainer\ntype: html\n---\n<h1>Explainer</h1>",
    );
    const result = await handleVaultCurate({
      slug: "explainer",
      owner: "alice",
      vault: "Collection",
    });
    expect(result).toMatchObject({ curated: true, slug: "explainer" });
    const vault = await getVault(vaultIdFor("alice", "Collection"));
    expect(vault?.slugs).toContain("explainer");
  });

  it("throws for a non-existent page", async () => {
    await expect(
      handleVaultCurate({ slug: "does-not-exist", owner: "alice", vault: "v" }),
    ).rejects.toThrow("Page not found: does-not-exist");
  });

  it("throws for a private page", async () => {
    await writeTestPage(
      "private-notes",
      "---\ntitle: Private Notes\nvisibility: private\n---\n# Private Notes\n\nSecret stuff.",
    );

    await expect(
      handleVaultCurate({ slug: "private-notes", owner: "alice", vault: "v" }),
    ).rejects.toThrow("Only public, non-agent pages can be curated into a vault.");
  });

  it("throws for an agent-scoped page", async () => {
    await writeTestPage(
      "agent-identity",
      "---\ntitle: Agent Identity\ntype: agent-identity\n---\n# Agent Identity\n\nAgent stuff.",
    );

    await expect(
      handleVaultCurate({ slug: "agent-identity", owner: "alice", vault: "v" }),
    ).rejects.toThrow("Only public, non-agent pages can be curated into a vault.");
  });

  it("is idempotent — curating twice keeps a single membership in the named vault", async () => {
    await writeTestPage(
      "deep-learning",
      "---\ntitle: Deep Learning\n---\n# Deep Learning\n\nNeural networks with many layers.",
    );

    const first = await handleVaultCurate({
      slug: "deep-learning",
      owner: "bob",
      vault: "ML",
    });
    expect(first.curated).toBe(true);

    const second = await handleVaultCurate({
      slug: "deep-learning",
      owner: "bob",
      vault: "ML",
    });
    expect(second.curated).toBe(true);

    const vault = await getVault(vaultIdFor("bob", "ML"));
    expect(vault?.slugs).toEqual(["deep-learning"]);
  });
});

describe("vault_uncurate", () => {
  it("uncurates a previously curated page from the named vault", async () => {
    // Create and curate a page first
    await writeTestPage(
      "transformers",
      "---\ntitle: Transformers\n---\n# Transformers\n\nAttention is all you need.",
    );

    await handleVaultCurate({
      slug: "transformers",
      owner: "alice",
      vault: "AI Reading",
    });

    const result = await handleVaultUncurate({
      slug: "transformers",
      owner: "alice",
      vault: "AI Reading",
    });
    expect(result).toEqual({
      curated: false,
      slug: "transformers",
      owner: "alice",
      vault: "AI Reading",
    });

    const vault = await getVault(vaultIdFor("alice", "AI Reading"));
    expect(vault?.slugs ?? []).not.toContain("transformers");
  });

  it("is a no-op when slug was never curated", async () => {
    const result = await handleVaultUncurate({
      slug: "never-curated",
      owner: "alice",
      vault: "AI Reading",
    });
    expect(result).toEqual({
      curated: false,
      slug: "never-curated",
      owner: "alice",
      vault: "AI Reading",
    });
  });
});

describe("list_vaults", () => {
  it("returns empty array when the owner has no vaults", async () => {
    const result = await handleListVaults({ owner: "nobody" });
    expect(result).toEqual({ vaults: [] });
  });

  it("returns vaults after curating creates them", async () => {
    await writeTestPage(
      "vault-list-page",
      "---\ntitle: Vault List Page\n---\n# Vault List Page\n\nContent.",
    );

    await handleVaultCurate({
      slug: "vault-list-page",
      owner: "lister",
      vault: "Research",
    });
    await handleVaultCurate({
      slug: "vault-list-page",
      owner: "lister",
      vault: "Favorites",
    });

    const result = await handleListVaults({ owner: "lister" });
    expect(result.vaults).toHaveLength(2);
    const names = result.vaults.map((v) => v.name);
    expect(names).toContain("Research");
    expect(names).toContain("Favorites");
    // Each vault should include the curated slug
    for (const v of result.vaults) {
      expect(v.slugs).toContain("vault-list-page");
      expect(v.owner).toBe("lister");
      expect(v.visibility).toBe("public");
    }
  });
});

describe("vault_pages", () => {
  it("returns empty slugs for a nonexistent vault", async () => {
    const result = await handleVaultPages({
      owner: "nobody",
      vault: "nonexistent",
    });
    expect(result).toEqual({
      owner: "nobody",
      vault: "nonexistent",
      slugs: [],
      pages: [],
    });
  });

  it("returns the curated slugs in a named vault", async () => {
    await writeTestPage(
      "vault-pages-a",
      "---\ntitle: Page A\n---\n# Page A\n\nContent A.",
    );
    await writeTestPage(
      "vault-pages-b",
      "---\ntitle: Page B\n---\n# Page B\n\nContent B.",
    );

    await handleVaultCurate({
      slug: "vault-pages-a",
      owner: "viewer",
      vault: "My Vault",
    });
    await handleVaultCurate({
      slug: "vault-pages-b",
      owner: "viewer",
      vault: "My Vault",
    });

    const result = await handleVaultPages({
      owner: "viewer",
      vault: "My Vault",
    });
    expect(result.owner).toBe("viewer");
    expect(result.vault).toBe("My Vault");
    expect(result.slugs).toEqual(["vault-pages-a", "vault-pages-b"]);

    // Enriched page entries should be present alongside the slug array
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ slug: "vault-pages-a", title: "Page A" });
    expect(result.pages[1]).toMatchObject({ slug: "vault-pages-b", title: "Page B" });
  });

  it("returns enriched entries with frontmatter metadata", async () => {
    await writeTestPage(
      "vault-enrich",
      "---\ntitle: Enriched\nsummary: A summary\ntags: [alpha, beta]\nconfidence: 0.9\ntype: article\nowner: viewer\n---\n# Enriched\n\nBody.",
    );
    await handleVaultCurate({
      slug: "vault-enrich",
      owner: "viewer",
      vault: "Enrich Vault",
    });

    const result = await handleVaultPages({
      owner: "viewer",
      vault: "Enrich Vault",
    });
    expect(result.pages).toHaveLength(1);
    const entry = result.pages[0];
    expect(entry.slug).toBe("vault-enrich");
    expect(entry.title).toBe("Enriched");
    expect(entry.summary).toBe("A summary");
    expect(entry.tags).toEqual(["alpha", "beta"]);
    expect(entry.confidence).toBe(0.9);
    expect(entry.type).toBe("article");
    expect(entry.owner).toBe("viewer");
  });
});

// ---------------------------------------------------------------------------
// vault_create / vault_rename / vault_delete
// ---------------------------------------------------------------------------

describe("vault_create", () => {
  it("creates a new vault and returns it", async () => {
    const result = await handleVaultCreate({ owner: "alice", name: "Research" });
    expect(result.vault).toBeDefined();
    expect(result.vault.owner).toBe("alice");
    expect(result.vault.name).toBe("Research");
    expect(result.vault.visibility).toBe("public");
    expect(result.vault.slugs).toEqual([]);

    // The vault actually exists
    const id = vaultIdFor("alice", "Research");
    const vault = await getVault(id);
    expect(vault).not.toBeNull();
    expect(vault?.name).toBe("Research");
  });

  it("is idempotent — creating the same vault twice returns the existing one", async () => {
    const first = await handleVaultCreate({ owner: "bob", name: "Notes" });
    const second = await handleVaultCreate({ owner: "bob", name: "Notes" });
    expect(first.vault.id).toBe(second.vault.id);

    // Only one vault for bob with that name
    const vaults = await listVaults("bob");
    const matching = vaults.filter((v) => v.name === "Notes");
    expect(matching).toHaveLength(1);
  });
});

describe("vault_rename", () => {
  it("renames an existing vault", async () => {
    const { vault } = await handleVaultCreate({ owner: "alice", name: "Old Name" });
    const result = await handleVaultRename({ vault_id: vault.id, name: "New Name" });
    expect(result).toEqual({ renamed: true, vault_id: vault.id, name: "New Name" });

    // Verify the rename persisted
    const updated = await getVault(vault.id);
    expect(updated?.name).toBe("New Name");
  });

  it("throws when the vault does not exist", async () => {
    await expect(
      handleVaultRename({ vault_id: "nonexistent--vault", name: "X" }),
    ).rejects.toThrow("Vault not found: nonexistent--vault");
  });
});

describe("vault operations work after vault_rename", () => {
  it("curate/uncurate/pages use renamed vault, not a duplicate", async () => {
    // Setup: create a page and curate it into a vault
    await writeTestPage(
      "rename-test-page",
      "---\ntitle: Rename Test Page\n---\n# Content",
    );
    await handleVaultCurate({
      slug: "rename-test-page",
      owner: "alice",
      vault: "Original",
    });

    // Rename the vault
    const id = vaultIdFor("alice", "Original");
    await handleVaultRename({ vault_id: id, name: "Renamed" });

    // vault_pages with new name should find the curated page
    const pages = await handleVaultPages({ owner: "alice", vault: "Renamed" });
    expect(pages.slugs).toContain("rename-test-page");

    // vault_curate with new name should add to the SAME vault (no duplicate)
    await writeTestPage(
      "rename-test-page-2",
      "---\ntitle: Rename Test Page 2\n---\n# Content 2",
    );
    await handleVaultCurate({
      slug: "rename-test-page-2",
      owner: "alice",
      vault: "Renamed",
    });
    const vaults = await listVaults("alice");
    expect(vaults).toHaveLength(1);
    expect(vaults[0].name).toBe("Renamed");
    expect(vaults[0].slugs).toContain("rename-test-page");
    expect(vaults[0].slugs).toContain("rename-test-page-2");

    // vault_uncurate with new name should work
    const uncurated = await handleVaultUncurate({
      slug: "rename-test-page",
      owner: "alice",
      vault: "Renamed",
    });
    expect(uncurated.curated).toBe(false);
    const after = await listVaults("alice");
    expect(after[0].slugs).not.toContain("rename-test-page");
    expect(after[0].slugs).toContain("rename-test-page-2");
  });
});

describe("vault_delete", () => {
  it("deletes an existing vault", async () => {
    const { vault } = await handleVaultCreate({ owner: "alice", name: "Temporary" });
    const result = await handleVaultDelete({ vault_id: vault.id });
    expect(result).toEqual({ deleted: true, vault_id: vault.id });

    // Verify the vault is gone
    const gone = await getVault(vault.id);
    expect(gone).toBeNull();
  });

  it("throws when the vault does not exist", async () => {
    await expect(
      handleVaultDelete({ vault_id: "nonexistent--vault" }),
    ).rejects.toThrow("Vault not found: nonexistent--vault");
  });

  it("does not remove the commons pages themselves", async () => {
    await writeTestPage(
      "vault-del-page",
      "---\ntitle: Vault Del Page\n---\n# Vault Del Page\n\nContent.",
    );
    const { vault } = await handleVaultCreate({ owner: "alice", name: "Doomed" });
    await handleVaultCurate({ slug: "vault-del-page", owner: "alice", vault: "Doomed" });

    // Sanity: slug is in the vault
    const before = await getVault(vault.id);
    expect(before?.slugs).toContain("vault-del-page");

    await handleVaultDelete({ vault_id: vault.id });

    // Page still exists in wiki
    const { readWikiPageWithFrontmatter: readPage } = await import("../wiki");
    const page = await readPage("vault-del-page");
    expect(page).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revert_revision
// ---------------------------------------------------------------------------

describe("revert_revision", () => {
  it("reverts a page to a previous revision through the omitted-principal stdio fallback", async () => {
    const v1Content = "---\ntitle: Test\n---\n# Test\nVersion 1";
    await writeTestPage("revert-test", v1Content);

    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision("revert-test", v1Content, "yoyo", "v1 snapshot");

    // Overwrite with v2
    await writeTestPage("revert-test", "---\ntitle: Test\n---\n# Test\nVersion 2");

    // Get the v1 timestamp
    const list = await handleListRevisions({ slug: "revert-test" });
    expect(list.revisions.length).toBeGreaterThanOrEqual(1);
    const v1Ts = list.revisions[0].timestamp;

    // Revert to v1
    const result = await handleRevertRevision({
      slug: "revert-test",
      timestamp: v1Ts,
      author: "test-agent",
    });
    expect(result.slug).toBe("revert-test");
    expect(Array.isArray(result.updatedSlugs)).toBe(true);

    // Verify the page now has v1 content
    const page = await handleReadPage({ slug: "revert-test" });
    expect(page.content).toContain("Version 1");
  });

  it("denies a public-page revert before revision lookup and preserves stored bytes", async () => {
    const current =
      "---\ntitle: Public revert\nvisibility: public\n---\n# Public revert\n\nCurrent body.";
    const storedRevision =
      "---\ntitle: Public revert\nvisibility: public\n---\n# Public revert\n\nStored revision.";
    await writeTestPage("public-revert-acl", current);

    const { listRevisions, readRevision, saveRevision } = await import(
      "../../lib/revisions"
    );
    await saveRevision(
      "public-revert-acl",
      storedRevision,
      "service:test",
      "snapshot",
    );
    const revisions = await handleListRevisions({ slug: "public-revert-acl" });
    const storedTimestamp = revisions.revisions[0].timestamp;
    const missingTimestamp = storedTimestamp + 10_000;
    const pageBefore = (await readWikiPageWithFrontmatter("public-revert-acl"))!.content;
    const revisionBefore = await readRevision("public-revert-acl", storedTimestamp);
    const revisionHistoryBefore = await listRevisions("public-revert-acl");

    await expect(
      handleRevertRevision({
        slug: "public-revert-acl",
        timestamp: missingTimestamp,
        author: "alice",
        principal: { id: "user:alice", handle: "alice" },
      }),
    ).rejects.toThrow(WRITE_DENIAL_REALM.revert);

    expect((await readWikiPageWithFrontmatter("public-revert-acl"))!.content)
      .toBe(pageBefore);
    expect(await readRevision("public-revert-acl", storedTimestamp))
      .toBe(revisionBefore);
    expect(await listRevisions("public-revert-acl")).toEqual(
      revisionHistoryBefore,
    );
  });

  it("cloaks a private non-owner denial and preserves Page and revision bytes", async () => {
    const current =
      "---\ntitle: Private revert\nowner: bob\nvisibility: private\n---\n# Private revert\n\nCurrent body.";
    const storedRevision =
      "---\ntitle: Private revert\nowner: bob\nvisibility: private\n---\n# Private revert\n\nStored revision.";
    await writeTestPage("private-revert-acl", current);

    const { listRevisions, readRevision, saveRevision } = await import(
      "../../lib/revisions"
    );
    await saveRevision(
      "private-revert-acl",
      storedRevision,
      "bob",
      "snapshot",
    );
    const revisions = await handleListRevisions({ slug: "private-revert-acl" });
    const timestamp = revisions.revisions[0].timestamp;
    const pageBefore = (await readWikiPageWithFrontmatter("private-revert-acl"))!.content;
    const revisionBefore = await readRevision("private-revert-acl", timestamp);
    const revisionHistoryBefore = await listRevisions("private-revert-acl");

    let caught: unknown;
    try {
      await handleRevertRevision({
        slug: "private-revert-acl",
        timestamp,
        author: "alice",
        principal: { id: "user:alice", handle: "alice" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("page not found: private-revert-acl");
    expect((caught as Error).message).not.toMatch(/realm|public knowledge/i);
    expect((await readWikiPageWithFrontmatter("private-revert-acl"))!.content)
      .toBe(pageBefore);
    expect(await readRevision("private-revert-acl", timestamp))
      .toBe(revisionBefore);
    expect(await listRevisions("private-revert-acl")).toEqual(
      revisionHistoryBefore,
    );
  });

  it("fails explicit null closed on a public artifact before revision lookup", async () => {
    const current =
      "---\ntitle: Null principal\nvisibility: public\ntype: html\n---\n# Null principal\n\nCurrent body.";
    const storedRevision =
      "---\ntitle: Null principal\nvisibility: public\ntype: html\n---\n# Null principal\n\nStored revision.";
    await writeTestPage("null-principal-revert", current);

    const { listRevisions, readRevision, saveRevision } = await import(
      "../../lib/revisions"
    );
    await saveRevision(
      "null-principal-revert",
      storedRevision,
      "service:test",
      "snapshot",
    );
    const revisions = await handleListRevisions({ slug: "null-principal-revert" });
    const storedTimestamp = revisions.revisions[0].timestamp;
    const missingTimestamp = storedTimestamp + 10_000;
    const pageBefore = (await readWikiPageWithFrontmatter("null-principal-revert"))!.content;
    const revisionBefore = await readRevision(
      "null-principal-revert",
      storedTimestamp,
    );
    const revisionHistoryBefore = await listRevisions("null-principal-revert");

    await expect(
      handleRevertRevision({
        slug: "null-principal-revert",
        timestamp: missingTimestamp,
        principal: null,
      }),
    ).rejects.toThrow(WRITE_DENIAL.revert);
    expect((await readWikiPageWithFrontmatter("null-principal-revert"))!.content)
      .toBe(pageBefore);
    expect(await readRevision("null-principal-revert", storedTimestamp))
      .toBe(revisionBefore);
    expect(await listRevisions("null-principal-revert")).toEqual(
      revisionHistoryBefore,
    );
  });

  it("keeps principal out of the stdio revert_revision input schema", () => {
    const server = createMcpServer();
    // `_registeredTools` is private in TypeScript and readable at runtime —
    // the same schema inspection used by the stdio argument-gate tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (server as any)._registeredTools.revert_revision;
    const shape = entry.inputSchema.shape ?? entry.inputSchema;

    expect(shape).not.toHaveProperty("principal");
  });

  it("defaults author to 'agent' when not provided", async () => {
    const content = "---\ntitle: Default\n---\n# Default\nContent";
    await writeTestPage("revert-default", content);

    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision("revert-default", content, "yoyo", "snapshot");

    const list = await handleListRevisions({ slug: "revert-default" });
    const ts = list.revisions[0].timestamp;

    // Should not throw — author defaults to "agent"
    const result = await handleRevertRevision({
      slug: "revert-default",
      timestamp: ts,
    });
    expect(result.slug).toBe("revert-default");
  });

  it("rejects a revision that restores a link to a same-owner merged alias", async () => {
    await writeTestPage(
      "revert-survivor",
      "---\nowner: alice\naliases: [revert-retired]\n---\n# Survivor\n\nCanonical Page.",
    );
    await writeTestPage(
      "revert-retired",
      "---\nowner: alice\n---\n# Replacement\n\nUnrelated replacement.",
    );
    await writeTestPage(
      "mcp-revert-linker",
      "---\nowner: alice\n---\n# MCP revert linker\n\nCurrent body.",
    );
    await writeIndex([
      { title: "Survivor", slug: "revert-survivor", summary: "canonical" },
      { title: "Replacement", slug: "revert-retired", summary: "replacement" },
      { title: "MCP revert linker", slug: "mcp-revert-linker", summary: "linker" },
    ]);
    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision(
      "mcp-revert-linker",
      "---\nowner: alice\n---\n# MCP revert linker\n\nSee [old](revert-retired.md).",
      "alice",
      "stale link snapshot",
    );
    const list = await handleListRevisions({ slug: "mcp-revert-linker" });

    await expect(handleRevertRevision({
      slug: "mcp-revert-linker",
      timestamp: list.revisions[0].timestamp,
      author: "alice",
    })).rejects.toThrow(/missing|replaced/i);
    expect((await handleReadPage({ slug: "mcp-revert-linker" })).content)
      .not.toContain("revert-retired.md");
  });

  it("throws for a nonexistent page", async () => {
    await expect(
      handleRevertRevision({ slug: "no-such-page", timestamp: 1234567890 }),
    ).rejects.toThrow("page not found: no-such-page");
  });

  /**
   * The STRICT half. Without `strict: true` a non-ENOENT storage failure on the
   * merge-base read flattens to `null` and the null branch below tells the MCP
   * caller `page not found` — a deletion the store never made.
   */
  it("rejects with the STORAGE error — not `page not found` — when the merge-base read blips", async () => {
    const stored = "---\ntitle: Blip revert\n---\n# Blip revert\n\nCurrent body.";
    await writeTestPage("blip-revert", stored);

    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision("blip-revert", "# Blip revert\n\nOld body.", "yoyo", "snapshot");
    const list = await handleListRevisions({ slug: "blip-revert" });
    const ts = list.revisions[0].timestamp;
    const before = (await readWikiPageWithFrontmatter("blip-revert"))!.content;

    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    // ONE-SHOT: failing every read of `blip-revert.md` would also break the
    // write's own CAS re-read, so the call would reject either way.
    let blipped = false;
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (filePath: string) => {
        if (!blipped && filePath.endsWith("blip-revert.md")) {
          blipped = true;
          throw new Error("storage unavailable");
        }
        return originalRead(filePath);
      });

    let caught: unknown;
    try {
      await handleRevertRevision({ slug: "blip-revert", timestamp: ts });
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
    }

    expect(blipped).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("storage unavailable");
    expect(message).not.toContain("page not found");

    // And the stored Page is untouched, byte for byte — a handler that rejected
    // only AFTER a partial write would pass every assertion above.
    expect((await readWikiPageWithFrontmatter("blip-revert"))!.content).toBe(before);
  });

  /**
   * The FRESH half, which `strict` cannot pin. These bytes wear three hats at
   * once — the merge base (`expectedContent`), the `extractTitle` fallback, and
   * the seed for `mergedFrontmatter` (title and `created` included) — so off a
   * superseded `pageCache` entry every one of them describes a file that is not
   * stored, and the write's CAS refuses the stale merge base rather than
   * landing those metadata. Every field below therefore differs between the
   * cached bytes and the stored ones, so a stale read cannot pass by accident.
   */
  it("takes the merge base and frontmatter from storage while a stale page cache is open", async () => {
    const cachedBytes =
      "---\ntitle: Cached Revert Title\ncreated: '2025-01-15'\n---\n# Cached Revert Heading\n\nCached body.\n";
    await writeTestPage("mcp-stale-revert", cachedBytes);

    // A revision with NO frontmatter block, so the handler serializes
    // `mergedFrontmatter` over it rather than restoring the snapshot verbatim —
    // and with NO H1, so `extractTitle(revisionContent, existing.title)`
    // actually falls back to the read's title instead of taking one from the
    // snapshot.
    const { saveRevision } = await import("../../lib/revisions");
    await saveRevision(
      "mcp-stale-revert",
      "Revision body with no heading of its own.\n",
      "yoyo",
      "snapshot",
    );
    const list = await handleListRevisions({ slug: "mcp-stale-revert" });
    const ts = list.revisions[0].timestamp;

    const { beginPageCache, readWikiPage } = await import("../wiki");
    const cleanup = beginPageCache();
    try {
      expect((await readWikiPage("mcp-stale-revert"))!.content).toBe(cachedBytes);

      // Newer bytes land underneath the open cache, written DIRECTLY to the
      // flat path. Title, `created`, the H1 the title fallback reads, and the
      // `stored_only` marker are ALL different from the cached copy.
      const storedBytes =
        "---\ntitle: Stored Revert Title\ncreated: '2024-06-30'\nstored_only: yes-it-is\n---\n# Stored Revert Heading\n\nStored body.\n";
      const flatPath = path.join(process.env.WIKI_DIR!, "mcp-stale-revert.md");
      await fs.writeFile(flatPath, storedBytes, "utf-8");
      expect((await readWikiPage("mcp-stale-revert"))!.content).toBe(cachedBytes);

      // THE CALL THAT FAILS WITHOUT THE FRESH READ — and it fails HERE, not at
      // the assertions below: off the cached entry the merge base is the
      // superseded file, so the write's CAS rejects with
      // `LifecyclePageConflictError: Page "mcp-stale-revert" changed`.
      await handleRevertRevision({ slug: "mcp-stale-revert", timestamp: ts });

      // Reaching here at all is the load-bearing half. The rest confirms every
      // role those bytes play was filled from STORAGE: the `mergedFrontmatter`
      // seed (title, `created`, the stored-only marker) …
      const after = await fs.readFile(flatPath, "utf-8");
      expect(after).toContain("stored_only: yes-it-is");
      expect(after).toContain("title: Stored Revert Title");
      expect(after).toContain("created: 2024-06-30");
      expect(after).not.toContain("Cached Revert Title");
      expect(after).not.toContain("2025-01-15");
      expect(after).toContain("Revision body with no heading of its own.");

      // … and the `extractTitle` fallback, whose only observable is the index
      // entry this write upserts (the reverted body carries no H1 of its own).
      const indexAfter = await fs.readFile(
        path.join(process.env.WIKI_DIR!, "index.md"),
        "utf-8",
      );
      expect(indexAfter).toContain("Stored Revert Heading");
      expect(indexAfter).not.toContain("Cached Revert Heading");
    } finally {
      cleanup();
    }
  });

  it("throws for a nonexistent revision timestamp", async () => {
    await writeTestPage(
      "revert-missing-rev",
      "---\ntitle: Test\n---\n# Test\nHello",
    );
    await expect(
      handleRevertRevision({ slug: "revert-missing-rev", timestamp: 9999999999999 }),
    ).rejects.toThrow("revision not found: 9999999999999");
  });

  it("throws for an invalid slug", async () => {
    await expect(
      handleRevertRevision({ slug: "BAD SLUG!", timestamp: 123 }),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("throws when slug is empty", async () => {
    await expect(
      handleRevertRevision({ slug: "", timestamp: 123 }),
    ).rejects.toThrow("slug is required");
  });

  it("throws for invalid timestamp values", async () => {
    await expect(
      handleRevertRevision({ slug: "test-page", timestamp: -1 }),
    ).rejects.toThrow("timestamp must be a positive number");

    await expect(
      handleRevertRevision({ slug: "test-page", timestamp: 0 }),
    ).rejects.toThrow("timestamp must be a positive number");
  });
});

// ---------------------------------------------------------------------------
// maintenance_scan
// ---------------------------------------------------------------------------

describe("maintenance_scan", () => {
  it("returns tasks with default cap", async () => {
    // Create an orphan page (on disk, not in index) so the scan has something to find
    await writeTestPage(
      "orphan-maint",
      "---\ntags: [test]\n---\n# Orphan Maintenance\n\nThis page has real content that is long enough to not be empty.",
    );
    await writeIndex([]); // empty index → orphan-maint is an orphan

    const result = await handleMaintenanceScan({});
    expect(result).toHaveProperty("tasks");
    expect(Array.isArray(result.tasks)).toBe(true);
    // Should find at least the orphan page
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.length).toBeLessThanOrEqual(10); // default cap

    // Each task has the required fields
    for (const task of result.tasks) {
      expect(task).toHaveProperty("kind");
      expect(task).toHaveProperty("op");
      expect(task).toHaveProperty("slug");
    }
  });

  it("respects a custom cap", async () => {
    // Create multiple orphan pages
    for (let i = 0; i < 5; i++) {
      await writeTestPage(
        `orphan-cap-${i}`,
        `---\ntags: [test]\n---\n# Orphan Cap ${i}\n\nThis page has real content that is long enough to not be empty.`,
      );
    }
    await writeIndex([]); // none in index → all orphans

    const result = await handleMaintenanceScan({ cap: 3 });
    expect(result.tasks.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// mcp.json manifest ↔ server drift test
// ---------------------------------------------------------------------------

describe("mcp.json manifest sync", () => {
  it("manifest tools match exactly the tools registered by createMcpServer()", async () => {
    // Read the manifest
    const manifestPath = path.resolve(__dirname, "../../../mcp.json");
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);
    const manifestTools: string[] = manifest.tools;

    // Get registered tools from the server
    // _registeredTools is private in TypeScript but accessible at runtime
    const server = createMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registeredTools = Object.keys((server as any)._registeredTools);

    const manifestSet = new Set(manifestTools);
    const serverSet = new Set(registeredTools);

    // Tools in server but missing from manifest
    const missingFromManifest = registeredTools.filter(
      (t) => !manifestSet.has(t),
    );
    // Tools in manifest but not registered in server
    const extraInManifest = manifestTools.filter((t) => !serverSet.has(t));

    if (missingFromManifest.length > 0) {
      throw new Error(
        `Server registers tools not in mcp.json (manifest is missing): ${missingFromManifest.join(", ")}`,
      );
    }

    if (extraInManifest.length > 0) {
      throw new Error(
        `mcp.json lists tools not registered by server (manifest has extras): ${extraInManifest.join(", ")}`,
      );
    }

    // Also check for duplicates in the manifest
    expect(manifestTools.length).toBe(
      manifestSet.size,
    );

    expect(manifestTools.sort()).toEqual(registeredTools.sort());
  });
});

// ---------------------------------------------------------------------------
// Realm-aware write ACL tests (handleUpdatePage / handleDeletePage)
// ---------------------------------------------------------------------------

describe("MCP write ACL", () => {
  /** Helper: create a page with specific frontmatter (owner, visibility…). */
  async function createPageWithFrontmatter(
    slug: string,
    fm: Record<string, unknown>,
    body: string,
  ) {
    const { writeWikiPageWithSideEffects, serializeFrontmatter } = await import(
      "../wiki"
    );
    await writeWikiPageWithSideEffects({
      slug,
      title: (fm.title as string) ?? slug,
      content: serializeFrontmatter(
        {
          title: slug,
          created: "2026-01-01",
          confidence: 0.5,
          expiry: "2099-01-01",
          authors: ["system"],
          contributors: [],
          ...fm,
        },
        body,
      ),
      summary: "test",
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  describe("handleUpdatePage", () => {
    it("rejects body write on commons page when principal is a regular user", async () => {
      // Commons page: public, no special type → belongsInCommons = true
      await createPageWithFrontmatter("commons-acl", {}, "# Commons\n\nBody.");

      await expect(
        handleUpdatePage({
          slug: "commons-acl",
          content: "# Commons\n\nEdited body.",
          author: "alice",
          principal: { id: "user_alice", handle: "alice" },
        }),
        // The realm sentence, owned by `src/lib/write-denial.ts` — the same one
        // `PUT /api/wiki/[slug]` and the edit screen answer for this deny.
      ).rejects.toThrow(WRITE_DENIAL_REALM.edit);
    });

    it("allows body write on commons page when principal is a service", async () => {
      await createPageWithFrontmatter("commons-service", {}, "# Commons\n\nBody.");

      const result = await handleUpdatePage({
        slug: "commons-service",
        content: "# Commons\n\nUpdated by agent.",
        author: "agent",
        principal: { id: "service:agent", handle: "agent" },
      });
      expect(result.updated).toBe(true);
    });

    it("allows body write when no principal provided (stdio MCP fallback)", async () => {
      // Stdio MCP: no principal → falls back to service:mcp → always allowed
      await createPageWithFrontmatter("commons-stdio", {}, "# Commons\n\nBody.");

      const result = await handleUpdatePage({
        slug: "commons-stdio",
        content: "# Commons\n\nStdio update.",
        author: "yoyo",
      });
      expect(result.updated).toBe(true);
    });

    it("rejects body write on private page not owned by caller", async () => {
      await createPageWithFrontmatter(
        "private-acl",
        { owner: "bob", visibility: "private" },
        "# Private\n\nSecret.",
      );

      // Alice tries to edit Bob's private page — cloaked as not-found
      await expect(
        handleUpdatePage({
          slug: "private-acl",
          content: "# Private\n\nHacked!",
          author: "alice",
          principal: { id: "user_alice", handle: "alice" },
        }),
      ).rejects.toThrow("Page not found: private-acl");
    });

    it("allows body write on own private page", async () => {
      await createPageWithFrontmatter(
        "private-own",
        { owner: "alice", visibility: "private" },
        "# My Page\n\nMy content.",
      );

      const result = await handleUpdatePage({
        slug: "private-own",
        content: "# My Page\n\nEdited content.",
        author: "alice",
        principal: { id: "user_alice", handle: "alice" },
      });
      expect(result.updated).toBe(true);
    });
  });

  describe("handleDeletePage", () => {
    it("rejects deletion of private page not owned by caller", async () => {
      await createPageWithFrontmatter(
        "private-del",
        { owner: "bob", visibility: "private" },
        "# Private Del\n\nSecret.",
      );

      // Alice tries to delete Bob's private page — cloaked as not-found
      await expect(
        handleDeletePage({
          slug: "private-del",
          author: "alice",
          principal: { id: "user_alice", handle: "alice" },
        }),
      ).rejects.toThrow("page not found: private-del");
    });

    it("allows owner to delete own private page", async () => {
      await createPageWithFrontmatter(
        "private-del-own",
        { owner: "bob", visibility: "private" },
        "# My Private\n\nMy stuff.",
      );

      const result = await handleDeletePage({
        slug: "private-del-own",
        author: "bob",
        principal: { id: "user_bob", handle: "bob" },
      });
      expect(result.slug).toBe("private-del-own");
      expect(result.removedFromIndex).toBe(true);
    });

    it("rejects deletion of commons page by regular user", async () => {
      await createPageWithFrontmatter(
        "commons-del",
        {},
        "# Commons Del\n\nPublic knowledge.",
      );

      await expect(
        handleDeletePage({
          slug: "commons-del",
          author: "alice",
          principal: { id: "user_alice", handle: "alice" },
        }),
        // Same table, delete verb: one deny, one sentence, every surface.
      ).rejects.toThrow(WRITE_DENIAL_REALM.delete);
    });

    it("allows deletion when no principal provided (stdio MCP fallback)", async () => {
      await createPageWithFrontmatter(
        "commons-del-stdio",
        {},
        "# Commons Stdio\n\nBody.",
      );

      const result = await handleDeletePage({
        slug: "commons-del-stdio",
        author: "yoyo",
      });
      expect(result.slug).toBe("commons-del-stdio");
      expect(result.removedFromIndex).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// handleDeletePage: an UNREADABLE page is not an ABSENT one (DW-691)
// ---------------------------------------------------------------------------

/**
 * The MCP mirror of the REST delete ACL DW-496 hardened. Its own comment
 * claimed parity with that surface while the read underneath it was still
 * optionless, so a non-ENOENT storage failure came back as `null` and was
 * reported as `page not found: <slug>` for a page that is stored.
 *
 * Classification is what is pinned: a store fault rejects with the storage
 * failure and never with the absence sentence, a genuine absence still says
 * `page not found`, and neither deletes anything.
 */
describe("handleDeletePage — unreadable ≠ absent (DW-691)", () => {
  async function seed(
    slug: string,
    fm: Record<string, unknown> = {},
  ): Promise<void> {
    const { writeWikiPageWithSideEffects, serializeFrontmatter } = await import(
      "../wiki"
    );
    await writeWikiPageWithSideEffects({
      slug,
      title: slug,
      content: serializeFrontmatter(
        {
          title: slug,
          created: "2026-01-01",
          confidence: 0.5,
          expiry: "2099-01-01",
          authors: ["system"],
          contributors: [],
          ...fm,
        },
        `# ${slug}\n\nStored bytes.`,
      ),
      summary: "test",
      logOp: "ingest",
      crossRefSource: null,
    });
  }

  it("rejects with the STORAGE error — not `page not found` — when the ACL read blips", async () => {
    await seed("mcp-del-blip");
    const before = (await readWikiPageWithFrontmatter("mcp-del-blip"))!.content;

    // A non-ENOENT failure on `<slug>.md`: the file is there, the provider is
    // not. Every other path (the page index included) is served for real.
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (filePath: string) => {
        if (filePath.endsWith("mcp-del-blip.md")) {
          throw new Error("storage unavailable");
        }
        return originalRead(filePath);
      });

    let caught: unknown;
    try {
      await handleDeletePage({ slug: "mcp-del-blip", author: "system" });
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("storage unavailable");
    expect(message).not.toContain("page not found");

    // And the stored page is untouched, byte for byte.
    expect((await readWikiPageWithFrontmatter("mcp-del-blip"))!.content).toBe(
      before,
    );
  });

  it("still rejects `page not found` for a slug with no stored file", async () => {
    // ENOENT stays `null` under strict, so a genuine absence is unchanged.
    await expect(
      handleDeletePage({ slug: "mcp-del-absent", author: "system" }),
    ).rejects.toThrow("page not found: mcp-del-absent");
  });

  it("decides the delete ACL against storage while a stale page cache is open", async () => {
    // FRESH is the half `strict` cannot pin, and it needs its own row: strip
    // `fresh: true` from the source read and every blip row above still passes,
    // because a `pageCache` hit is answered before `storage.readFile` is ever
    // reached. `pageCache` is module-global and ref-counted around bulk scans,
    // so one can be holding a superseded entry open when this call arrives —
    // and this handler decides a DELETE from the frontmatter the read returns.
    const { beginPageCache, readWikiPage } = await import("../wiki");
    await seed("mcp-del-cached", { owner: "bob", visibility: "private" });

    const cleanup = beginPageCache();
    try {
      // A concurrent scan populates the cache.
      const cached = (await readWikiPage("mcp-del-cached"))!;
      expect(cached.content).toContain("owner: bob");

      // The page changes hands underneath it. Written DIRECTLY, bypassing
      // `writeWikiPage` — which invalidates — because a stale entry is exactly
      // what this row is about.
      const stored = cached.content.replace("owner: bob", "owner: carol");
      expect(stored).not.toBe(cached.content);
      await fs.writeFile(cached.path, stored, "utf-8");
      // The cache is genuinely stale: a cached read still serves the old owner.
      expect((await readWikiPage("mcp-del-cached"))!.content).toBe(
        cached.content,
      );

      // THE ASSERTION THAT FAILS WITHOUT THE FRESH READ. The ACL sees the
      // STORED frontmatter — a private page owned by carol — and cloaks it as
      // not-found. Off the cached entry it reads `owner: bob`, authorizes, and
      // deletes a page that now belongs to another principal.
      await expect(
        handleDeletePage({
          slug: "mcp-del-cached",
          author: "bob",
          principal: { id: "user_bob", handle: "bob" },
        }),
      ).rejects.toThrow("page not found: mcp-del-cached");

      // Nothing was deleted: the later bytes are intact, byte for byte.
      expect(await fs.readFile(cached.path, "utf-8")).toBe(stored);
    } finally {
      cleanup();
    }
  });
});
