import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { writeWikiPage, updateIndex, ensureDirectories, readLog } from "../wiki";
import type { IndexEntry } from "../types";
import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";
import { createWiki, writeWikiArtifact } from "../wikis";
import { loadPageConventions } from "../schema";

// Mock the LLM module so lint never calls the real API
vi.mock("../llm", () => ({
  hasLLMKey: vi.fn(() => false),
  callLLM: vi.fn(async () => "[]"),
}));

// Mock the talk module so lint doesn't need real discussion files
vi.mock("../talk", () => ({
  getDiscussionStatsForSlugs: vi.fn(async () => new Map()),
}));

import { hasLLMKey, callLLM } from "../llm";
const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedCallLLM = vi.mocked(callLLM);

// Import lint after mocking
import { lint } from "../lint";
import {
  extractCrossRefSlugs,
  extractWikiLinks,
  buildClusters,
  parseContradictionResponse,
  checkContradictions,
  parseMissingConceptResponse,
  checkMissingConceptPages,
  parseIncompleteCoverageResponse,
  checkIncompleteCoverage,
  MAX_COVERAGE_CHECKS,
  checkBrokenLinks,
} from "../lint";
import {
  saveRawSource,
  saveRawSourceFor,
  listRawSourceSnapshots,
} from "../raw";
import { logger } from "../logger";
import { serializeFrontmatter } from "../frontmatter";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;
let originalOwnerHandle: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lint-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  originalOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  // No site owner by default, so `loadPageConventions()` resolves no active
  // Wiki and every test below exercises the repo-root fallback DETERMINISTICALLY
  // — rather than inheriting whatever handle the ambient environment carries.
  // The active-Wiki block at the bottom of this file sets it deliberately.
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  _resetLocks();
  _resetStorage();

  // Default: no LLM key
  mockedHasLLMKey.mockResolvedValue(false);
  mockedCallLLM.mockReset();
  mockedCallLLM.mockResolvedValue("[]");
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
  if (originalOwnerHandle === undefined) {
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  } else {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwnerHandle;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("lint", () => {
  it("should return only LLM-skipped info issues for a clean wiki", async () => {
    // Create a page and list it in the index
    await writeWikiPage(
      "hello",
      "# Hello\n\nThis is a page with enough content to pass the empty check easily.",
    );
    const entries: IndexEntry[] = [
      { slug: "hello", title: "Hello", summary: "A greeting page" },
    ];
    await updateIndex(entries);

    const result = await lint();

    // Only the contradiction-skipped and missing-concept-page-skipped info issues (no LLM key)
    // Also filter unmigrated-page and uncited-claims — the test page has no work-wiki frontmatter/sources by design
    const nonLLMSkipped = result.issues.filter(
      (i) => i.type !== "contradiction" && i.type !== "missing-concept-page" && i.type !== "incomplete-coverage" && i.type !== "unmigrated-page" && i.type !== "uncited-claims",
    );
    expect(nonLLMSkipped).toHaveLength(0);
    expect(result.checkedAt).toBeTruthy();
  });

  it("should detect orphan pages (on disk but not in index)", async () => {
    await writeWikiPage(
      "orphan",
      "# Orphan\n\nThis page exists on disk but is not in the index file.",
    );
    // Create an empty index with no entries
    await updateIndex([]);

    const result = await lint();
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");

    expect(orphanIssues).toHaveLength(1);
    expect(orphanIssues[0].slug).toBe("orphan");
    expect(orphanIssues[0].severity).toBe("warning");
  });

  it("should detect stale index entries (in index but no file on disk)", async () => {
    await ensureDirectories();
    const entries: IndexEntry[] = [
      { slug: "ghost", title: "Ghost Page", summary: "This file was deleted" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const staleIssues = result.issues.filter((i) => i.type === "stale-index");

    expect(staleIssues).toHaveLength(1);
    expect(staleIssues[0].slug).toBe("ghost");
    expect(staleIssues[0].severity).toBe("error");
  });

  it("should detect empty pages", async () => {
    // Page with only a heading and very little content
    await writeWikiPage("empty", "# Empty Page\n\nHi.");
    const entries: IndexEntry[] = [
      { slug: "empty", title: "Empty Page", summary: "Barely anything here" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const emptyIssues = result.issues.filter((i) => i.type === "empty-page");

    expect(emptyIssues).toHaveLength(1);
    expect(emptyIssues[0].slug).toBe("empty");
    expect(emptyIssues[0].severity).toBe("warning");
  });

  it("should detect missing cross-references", async () => {
    // Page A mentions "Beta Topic" but doesn't link to it
    await writeWikiPage(
      "alpha",
      "# Alpha\n\nThis page discusses Beta Topic extensively and has enough content.",
    );
    await writeWikiPage(
      "beta",
      "# Beta Topic\n\nThis is the beta topic page with enough content to pass checks.",
    );
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha page" },
      { slug: "beta", title: "Beta Topic", summary: "Beta page" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const crossRefIssues = result.issues.filter(
      (i) => i.type === "missing-crossref",
    );

    expect(crossRefIssues.length).toBeGreaterThanOrEqual(1);
    expect(crossRefIssues[0].slug).toBe("alpha");
    expect(crossRefIssues[0].target).toBe("beta");
    expect(crossRefIssues[0].message).toContain("Beta Topic");
  });

  it("should not flag cross-references when links exist", async () => {
    await writeWikiPage(
      "alpha",
      "# Alpha\n\nThis page links to [Beta Topic](beta.md) properly with enough content.",
    );
    await writeWikiPage(
      "beta",
      "# Beta Topic\n\nThis is the beta topic page with enough content to pass checks.",
    );
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha page" },
      { slug: "beta", title: "Beta Topic", summary: "Beta page" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const crossRefIssues = result.issues.filter(
      (i) => i.type === "missing-crossref",
    );

    expect(crossRefIssues).toHaveLength(0);
  });

  it("should not flag index.md or log.md as orphan pages", async () => {
    await ensureDirectories();
    // index.md and log.md exist but shouldn't be flagged
    await updateIndex([]);
    const logPath = path.join(process.env.WIKI_DIR!, "log.md");
    await fs.writeFile(logPath, "[2024-01-01] test entry\n", "utf-8");

    const result = await lint();
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");

    expect(orphanIssues).toHaveLength(0);
  });

  it("should return a meaningful summary", async () => {
    await writeWikiPage("orphan", "# Orphan\n\nOrphan page with enough content to not be empty page.");
    await ensureDirectories();
    await updateIndex([
      { slug: "ghost", title: "Ghost", summary: "Missing file" },
    ]);

    const result = await lint();

    // Should have at least an orphan warning and a stale error
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(result.summary).toMatch(/\d+ issue/);
  });

  it("should handle an empty wiki directory gracefully", async () => {
    await ensureDirectories();

    const result = await lint();

    // Only the LLM-skipped info issues (contradiction + missing-concept-page + incomplete-coverage)
    const nonLLMSkipped = result.issues.filter(
      (i) => i.type !== "contradiction" && i.type !== "missing-concept-page" && i.type !== "incomplete-coverage",
    );
    expect(nonLLMSkipped).toHaveLength(0);
  });

  it("should NOT flag cross-refs when short title appears inside other words", async () => {
    // "AI" appears inside "maintain" and "certain" but not as a standalone word
    await writeWikiPage(
      "overview",
      "# Overview\n\nWe need to maintain certain standards across all projects in our domain.",
    );
    await writeWikiPage(
      "ai",
      "# AI\n\nArtificial intelligence is a broad field covering many topics and subtopics.",
    );
    const entries: IndexEntry[] = [
      { slug: "overview", title: "Overview", summary: "Overview page" },
      { slug: "ai", title: "AI", summary: "AI page" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const crossRefIssues = result.issues.filter(
      (i) => i.type === "missing-crossref" && i.message.includes('"AI"'),
    );

    // "AI" should NOT match inside "maintain" or "certain"
    expect(crossRefIssues).toHaveLength(0);
  });

  it("should flag cross-refs when a multi-word title appears as a phrase", async () => {
    await writeWikiPage(
      "intro",
      "# Intro\n\nThis article covers the basics of neural network architectures in depth.",
    );
    await writeWikiPage(
      "neural-network",
      "# Neural Network\n\nA neural network is a computational model inspired by biological neurons.",
    );
    const entries: IndexEntry[] = [
      { slug: "intro", title: "Intro", summary: "Intro page" },
      { slug: "neural-network", title: "Neural Network", summary: "NN page" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const crossRefIssues = result.issues.filter(
      (i) => i.type === "missing-crossref" && i.message.includes("Neural Network"),
    );

    expect(crossRefIssues).toHaveLength(1);
    expect(crossRefIssues[0].slug).toBe("intro");
    expect(crossRefIssues[0].target).toBe("neural-network");
  });

  it("should NOT flag cross-refs when short title appears as substring of another word", async () => {
    // "go" appears inside "algorithm" but not as a standalone word
    await writeWikiPage(
      "search",
      "# Search\n\nThe algorithm performs a depth-first traversal across the entire graph structure.",
    );
    await writeWikiPage(
      "go-lang",
      "# Go\n\nGo is a programming language designed at Google for systems programming.",
    );
    const entries: IndexEntry[] = [
      { slug: "search", title: "Search", summary: "Search page" },
      { slug: "go-lang", title: "Go", summary: "Go page" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const crossRefIssues = result.issues.filter(
      (i) => i.type === "missing-crossref" && i.message.includes('"Go"'),
    );

    // "Go" should NOT match inside "algorithm" — and it's under 3 chars so also filtered
    expect(crossRefIssues).toHaveLength(0);
  });

  it("should NOT flag cross-refs for 'map' inside 'bitmap'", async () => {
    await writeWikiPage(
      "graphics",
      "# Graphics\n\nBitmap images are composed of a grid of pixels and are resolution dependent.",
    );
    await writeWikiPage(
      "map",
      "# Map\n\nA map is a data structure that stores key-value pairs for efficient lookups.",
    );
    const entries: IndexEntry[] = [
      { slug: "graphics", title: "Graphics", summary: "Graphics page" },
      { slug: "map", title: "Map", summary: "Map page" },
    ];
    await updateIndex(entries);

    const result = await lint();
    const crossRefIssues = result.issues.filter(
      (i) => i.type === "missing-crossref" && i.message.includes('"Map"'),
    );

    // "map" should NOT match inside "bitmap" thanks to word-boundary matching
    expect(crossRefIssues).toHaveLength(0);
  });

  it("appends a 'lint' log entry on every pass", async () => {
    // Set up a small wiki
    await writeWikiPage(
      "alpha",
      "# Alpha\n\nAlpha is a page with enough content to pass the empty check.",
    );
    await writeWikiPage(
      "beta",
      "# Beta\n\nBeta is a page with enough content to pass the empty check.",
    );
    await updateIndex([
      { slug: "alpha", title: "Alpha", summary: "First page" },
      { slug: "beta", title: "Beta", summary: "Second page" },
    ]);

    await lint();

    const log = await readLog();
    expect(log).not.toBeNull();

    // Find the most recent lint entry by walking H2 headings from the end.
    const headings = (log ?? "")
      .split("\n")
      .filter((line) => line.startsWith("## ["));
    expect(headings.length).toBeGreaterThan(0);

    const last = headings[headings.length - 1];
    // Heading shape: "## [YYYY-MM-DD] <op> | <title>"
    expect(last).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] lint \| wiki lint pass$/);
  });

  it("should use page cache to avoid redundant disk reads", async () => {
    // Import the cache size helper to verify caching is active
    const { _getPageCacheSize } = await import("../wiki");

    // Create multiple pages so the cache has something to track
    await writeWikiPage(
      "alpha",
      "# Alpha\n\nAlpha is an important concept. See [Beta](beta.md) for more.",
    );
    await writeWikiPage(
      "beta",
      "# Beta\n\nBeta relates to [Alpha](alpha.md) and expands on gamma.",
    );
    await writeWikiPage(
      "gamma",
      "# Gamma\n\nGamma is a standalone page with enough content to pass checks.",
    );
    const entries: IndexEntry[] = [
      { slug: "alpha", title: "Alpha", summary: "Alpha concept" },
      { slug: "beta", title: "Beta", summary: "Beta concept" },
      { slug: "gamma", title: "Gamma", summary: "Gamma concept" },
    ];
    await updateIndex(entries);

    // Spy on fs.readFile to count actual disk reads for .md files
    const origReadFile = fs.readFile;
    let mdReadCount = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>) => {
        const filePath = String(args[0]);
        if (filePath.endsWith(".md")) {
          mdReadCount++;
        }
        return origReadFile.apply(fs, args);
      },
    );

    const result = await lint();
    spy.mockRestore();

    // There are 3 content pages + index.md + log.md reads.
    // Without page cache, 5 checks × 3 pages = 15 content page reads.
    // With page cache, each page is read from disk at most once = 3 content page reads.
    // Total .md reads should be significantly fewer than without cache.
    // With 3 pages and 5 reading-checks, uncached = 15+ page reads.
    // Cached: 3 unique page reads + index.md reads + log writes.
    // We assert total .md reads are well below the uncached count.
    expect(mdReadCount).toBeLessThan(15);

    // Verify the cache is cleaned up after lint completes
    expect(_getPageCacheSize()).toBe(0);

    expect(result.checkedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Contradiction detection tests
// ---------------------------------------------------------------------------

describe("extractCrossRefSlugs", () => {
  it("extracts slugs from markdown links", () => {
    const content = "See [Alpha](alpha.md) and [Beta](beta.md) for details.";
    const slugs = extractCrossRefSlugs(content);
    expect(slugs).toEqual(new Set(["alpha", "beta"]));
  });

  it("returns empty set when no links", () => {
    const slugs = extractCrossRefSlugs("No links here.");
    expect(slugs.size).toBe(0);
  });
});

describe("buildClusters", () => {
  it("groups linked pages into clusters", () => {
    const pages = [
      { slug: "a", content: "Link to [B](b.md)" },
      { slug: "b", content: "Link to [A](a.md)" },
      { slug: "c", content: "No links here, standalone page" },
    ];
    const clusters = buildClusters(pages);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toContain("a");
    expect(clusters[0]).toContain("b");
  });

  it("returns empty array when no pages link to each other", () => {
    const pages = [
      { slug: "a", content: "No links" },
      { slug: "b", content: "Also no links" },
    ];
    const clusters = buildClusters(pages);
    expect(clusters).toHaveLength(0);
  });

  it("respects maxClusterSize", () => {
    const pages = [
      { slug: "a", content: "[B](b.md) [C](c.md) [D](d.md)" },
      { slug: "b", content: "[A](a.md)" },
      { slug: "c", content: "[A](a.md)" },
      { slug: "d", content: "[A](a.md)" },
    ];
    const clusters = buildClusters(pages, 2);
    // Cluster should be capped at 2
    for (const cluster of clusters) {
      expect(cluster.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("parseContradictionResponse", () => {
  it("parses valid JSON array", () => {
    const response = '[{"pages": ["alpha", "beta"], "description": "Alpha says X, Beta says Y"}]';
    const result = parseContradictionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].pages).toEqual(["alpha", "beta"]);
    expect(result[0].description).toBe("Alpha says X, Beta says Y");
  });

  it("parses empty array", () => {
    const result = parseContradictionResponse("[]");
    expect(result).toHaveLength(0);
  });

  it("handles markdown code fences", () => {
    const response = '```json\n[{"pages": ["a", "b"], "description": "conflict"}]\n```';
    const result = parseContradictionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].pages).toEqual(["a", "b"]);
  });

  it("returns empty array for malformed JSON", () => {
    const result = parseContradictionResponse("this is not json at all");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for non-array JSON", () => {
    const result = parseContradictionResponse('{"not": "an array"}');
    expect(result).toHaveLength(0);
  });

  it("skips items missing required fields", () => {
    const response = '[{"pages": ["a"], "description": "only one page"}, {"pages": ["a", "b"], "description": "valid"}]';
    const result = parseContradictionResponse(response);
    // First item has only 1 page, should be skipped
    expect(result).toHaveLength(1);
    expect(result[0].pages).toEqual(["a", "b"]);
  });

  it("skips items with empty description", () => {
    const response = '[{"pages": ["a", "b"], "description": ""}]';
    const result = parseContradictionResponse(response);
    expect(result).toHaveLength(0);
  });
});

describe("checkContradictions", () => {
  it("returns info issue when no LLM key is configured", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await ensureDirectories();

    const issues = await checkContradictions(["some-slug"]);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("contradiction");
    expect(issues[0].severity).toBe("info");
    expect(issues[0].message).toContain("skipped");
    expect(issues[0].message).toContain("no LLM API key");
  });

  it("returns contradiction issues when LLM finds them", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    // Create two pages that link to each other
    await writeWikiPage(
      "page-a",
      "# Page A\n\nThe project was founded in 2020. See [Page B](page-b.md).",
    );
    await writeWikiPage(
      "page-b",
      "# Page B\n\nThe project was founded in 2019. See [Page A](page-a.md).",
    );
    await updateIndex([
      { slug: "page-a", title: "Page A", summary: "About the project" },
      { slug: "page-b", title: "Page B", summary: "Also about the project" },
    ]);

    mockedCallLLM.mockResolvedValueOnce(
      '[{"pages": ["page-a", "page-b"], "description": "Page A says founded in 2020, Page B says 2019"}]',
    );

    const issues = await checkContradictions(["page-a", "page-b"]);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("contradiction");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].slug).toBe("page-a");
    expect(issues[0].target).toBe("page-b");
    expect(issues[0].message).toContain("page-a");
    expect(issues[0].message).toContain("page-b");
    expect(issues[0].message).toContain("2020");
  });

  it("returns no issues when LLM finds no contradictions", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "consistent-a",
      "# Consistent A\n\nFact: water boils at 100C. See [Consistent B](consistent-b.md).",
    );
    await writeWikiPage(
      "consistent-b",
      "# Consistent B\n\nWater boils at 100 degrees Celsius. See [Consistent A](consistent-a.md).",
    );
    await updateIndex([
      { slug: "consistent-a", title: "Consistent A", summary: "Water facts" },
      { slug: "consistent-b", title: "Consistent B", summary: "Water facts" },
    ]);

    mockedCallLLM.mockResolvedValueOnce("[]");

    const issues = await checkContradictions(["consistent-a", "consistent-b"]);

    expect(issues).toHaveLength(0);
  });

  it("handles malformed LLM response gracefully", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "mal-a",
      "# Malformed A\n\nSome content. See [Malformed B](mal-b.md).",
    );
    await writeWikiPage(
      "mal-b",
      "# Malformed B\n\nSome content. See [Malformed A](mal-a.md).",
    );
    await updateIndex([
      { slug: "mal-a", title: "Malformed A", summary: "Test" },
      { slug: "mal-b", title: "Malformed B", summary: "Test" },
    ]);

    mockedCallLLM.mockResolvedValueOnce(
      "Sorry, I cannot parse these pages properly. Here's some random text.",
    );

    const issues = await checkContradictions(["mal-a", "mal-b"]);

    // Should not crash, just return empty
    expect(issues).toHaveLength(0);
  });

  it("handles LLM call failure gracefully", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "err-a",
      "# Error A\n\nSome content. See [Error B](err-b.md).",
    );
    await writeWikiPage(
      "err-b",
      "# Error B\n\nSome content. See [Error A](err-a.md).",
    );
    await updateIndex([
      { slug: "err-a", title: "Error A", summary: "Test" },
      { slug: "err-b", title: "Error B", summary: "Test" },
    ]);

    mockedCallLLM.mockRejectedValueOnce(new Error("API rate limit exceeded"));

    const issues = await checkContradictions(["err-a", "err-b"]);

    // Should not crash, just return empty
    expect(issues).toHaveLength(0);
  });

  it("returns no issues when pages have no cross-references", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "isolated-a",
      "# Isolated A\n\nThis page has no links to other pages at all.",
    );
    await writeWikiPage(
      "isolated-b",
      "# Isolated B\n\nThis page also has no links to other pages.",
    );
    await updateIndex([
      { slug: "isolated-a", title: "Isolated A", summary: "No links" },
      { slug: "isolated-b", title: "Isolated B", summary: "No links" },
    ]);

    const issues = await checkContradictions(["isolated-a", "isolated-b"]);

    // No clusters formed → no LLM calls → no issues
    expect(issues).toHaveLength(0);
    expect(mockedCallLLM).not.toHaveBeenCalled();
  });

  it("includes SCHEMA.md conventions in contradiction detection prompt", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedCallLLM.mockResolvedValue("[]");

    // Write a temporary SCHEMA.md in tmpDir so loadPageConventions picks it up
    const schemaContent = `# Wiki Schema

## Page conventions

Every page must start with a level-1 heading.

## Operations
`;
    // loadPageConventions reads SCHEMA.md via storage provider relative to
    // process.cwd(). Set DATA_DIR to tmpDir and reset storage so the
    // provider picks up the temp directory.
    const origCwd = process.cwd();
    const origDataDir = process.env.DATA_DIR;
    const schemaPath = path.join(tmpDir, "SCHEMA.md");
    await fs.writeFile(schemaPath, schemaContent, "utf-8");
    process.env.DATA_DIR = tmpDir;
    const { _resetStorage } = await import("../storage");
    _resetStorage();
    process.chdir(tmpDir);

    try {
      await writeWikiPage(
        "schema-a",
        "# Schema A\n\nContent about topic. See [Schema B](schema-b.md).",
      );
      await writeWikiPage(
        "schema-b",
        "# Schema B\n\nContent about topic. See [Schema A](schema-a.md).",
      );
      await updateIndex([
        { slug: "schema-a", title: "Schema A", summary: "Test" },
        { slug: "schema-b", title: "Schema B", summary: "Test" },
      ]);

      await checkContradictions(["schema-a", "schema-b"]);

      // The system prompt passed to callLLM should include SCHEMA.md conventions
      expect(mockedCallLLM).toHaveBeenCalled();
      const systemPromptArg = mockedCallLLM.mock.calls[0][0];
      expect(systemPromptArg).toContain("conventions (from SCHEMA.md)");
      expect(systemPromptArg).toContain("Every page must start with a level-1 heading");
    } finally {
      process.chdir(origCwd);
      if (origDataDir === undefined) {
        delete process.env.DATA_DIR;
      } else {
        process.env.DATA_DIR = origDataDir;
      }
      _resetStorage();
    }
  });

  // ── Missing concept page detection ──────────────────────────────────

  describe("parseMissingConceptResponse", () => {
    it("parses valid JSON array of concept objects", () => {
      const input = JSON.stringify([
        {
          concept: "Transformer",
          mentioned_in: ["attention", "gpt"],
          reason: "Core architecture mentioned in multiple pages",
        },
        {
          concept: "Backpropagation",
          mentioned_in: ["training", "gradients"],
          reason: "Fundamental training algorithm",
        },
      ]);
      const result = parseMissingConceptResponse(input);
      expect(result).toHaveLength(2);
      expect(result[0].concept).toBe("Transformer");
      expect(result[0].mentioned_in).toEqual(["attention", "gpt"]);
      expect(result[0].reason).toBe("Core architecture mentioned in multiple pages");
      expect(result[1].concept).toBe("Backpropagation");
    });

    it("returns empty array for malformed JSON", () => {
      expect(parseMissingConceptResponse("not json")).toEqual([]);
      expect(parseMissingConceptResponse("{invalid")).toEqual([]);
    });

    it("returns empty array for empty JSON array", () => {
      expect(parseMissingConceptResponse("[]")).toEqual([]);
    });

    it("strips markdown code fences", () => {
      const input = '```json\n[{"concept":"X","mentioned_in":["a","b"],"reason":"Y"}]\n```';
      const result = parseMissingConceptResponse(input);
      expect(result).toHaveLength(1);
      expect(result[0].concept).toBe("X");
    });

    it("filters out items with less than 2 mentioned_in entries", () => {
      const input = JSON.stringify([
        {
          concept: "Only Once",
          mentioned_in: ["single-page"],
          reason: "Mentioned in just one page",
        },
      ]);
      const result = parseMissingConceptResponse(input);
      expect(result).toEqual([]);
    });

    it("filters out items with missing fields", () => {
      const input = JSON.stringify([
        { concept: "No reason", mentioned_in: ["a", "b"] },
        { concept: "", mentioned_in: ["a", "b"], reason: "empty concept" },
        { mentioned_in: ["a", "b"], reason: "no concept field" },
      ]);
      const result = parseMissingConceptResponse(input);
      expect(result).toEqual([]);
    });
  });

  describe("checkMissingConceptPages", () => {
    it("returns info-level skip message when no LLM key is configured", async () => {
      mockedHasLLMKey.mockResolvedValue(false);
      await ensureDirectories();

      const issues = await checkMissingConceptPages(["page-a", "page-b"]);
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("missing-concept-page");
      expect(issues[0].severity).toBe("info");
      expect(issues[0].message).toContain("skipped");
      expect(mockedCallLLM).not.toHaveBeenCalled();
    });

    it("returns empty array when fewer than 2 pages exist", async () => {
      mockedHasLLMKey.mockResolvedValue(true);

      await writeWikiPage("solo", "# Solo Page\n\nJust one page with enough content.");

      const issues = await checkMissingConceptPages(["solo"]);
      expect(issues).toEqual([]);
      expect(mockedCallLLM).not.toHaveBeenCalled();
    });

    it("returns missing-concept-page issues when LLM identifies concepts", async () => {
      mockedHasLLMKey.mockResolvedValue(true);
      mockedCallLLM.mockResolvedValue(
        JSON.stringify([
          {
            concept: "Neural Networks",
            mentioned_in: ["deep-learning", "backprop"],
            reason: "Fundamental concept discussed across multiple pages",
          },
        ]),
      );

      await writeWikiPage(
        "deep-learning",
        "# Deep Learning\n\nDeep learning uses neural networks for complex tasks.",
      );
      await writeWikiPage(
        "backprop",
        "# Backpropagation\n\nBackpropagation trains neural networks using gradients.",
      );

      const issues = await checkMissingConceptPages(["deep-learning", "backprop"]);
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("missing-concept-page");
      expect(issues[0].slug).toBe("deep-learning");
      expect(issues[0].message).toContain("Neural Networks");
      expect(issues[0].severity).toBe("info");
    });

    it("returns empty array when LLM returns empty array", async () => {
      mockedHasLLMKey.mockResolvedValue(true);
      mockedCallLLM.mockResolvedValue("[]");

      await writeWikiPage(
        "page-a",
        "# Page A\n\nSome content about a specific topic that is self-contained.",
      );
      await writeWikiPage(
        "page-b",
        "# Page B\n\nAnother page with completely different content and context.",
      );

      const issues = await checkMissingConceptPages(["page-a", "page-b"]);
      expect(issues).toEqual([]);
    });

    it("handles LLM call failure gracefully", async () => {
      mockedHasLLMKey.mockResolvedValue(true);
      mockedCallLLM.mockRejectedValue(new Error("API error"));

      await writeWikiPage(
        "fail-a",
        "# Fail A\n\nContent for page A with enough text to pass checks.",
      );
      await writeWikiPage(
        "fail-b",
        "# Fail B\n\nContent for page B with enough text to pass checks.",
      );

      const issues = await checkMissingConceptPages(["fail-a", "fail-b"]);
      expect(issues).toEqual([]);
    });
  });

  it("lint result includes missing-concept-page issues when LLM is available", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    // Both checks run in parallel via Promise.all, so call order is
    // non-deterministic. Dispatch based on the system prompt content instead.
    const missingConceptResponse = JSON.stringify([
      {
        concept: "Attention Mechanism",
        mentioned_in: ["transformer", "bert"],
        reason: "Core concept in both pages",
      },
    ]);
    mockedCallLLM.mockImplementation(async (systemPrompt: string) => {
      if (systemPrompt.includes("knowledge gap detector")) {
        return missingConceptResponse;
      }
      return "[]"; // contradiction check returns empty
    });

    await writeWikiPage(
      "transformer",
      "# Transformer\n\nThe transformer architecture uses attention mechanism for sequence modeling. See [BERT](bert.md).",
    );
    await writeWikiPage(
      "bert",
      "# BERT\n\nBERT builds on the transformer with bidirectional attention mechanism. See [Transformer](transformer.md).",
    );
    await updateIndex([
      { slug: "transformer", title: "Transformer", summary: "Test" },
      { slug: "bert", title: "BERT", summary: "Test" },
    ]);

    const result = await lint();
    const conceptIssues = result.issues.filter(
      (i) => i.type === "missing-concept-page",
    );
    expect(conceptIssues.length).toBeGreaterThanOrEqual(1);
    expect(conceptIssues[0].message).toContain("Attention Mechanism");
  });

  describe("checkBrokenLinks", () => {
    it("should detect a link to a non-existent page", async () => {
      await writeWikiPage(
        "page-a",
        '# Page A\n\nThis links to [Missing Page](nonexistent.md) which does not exist.',
      );
      await updateIndex([
        { slug: "page-a", title: "Page A", summary: "Test" },
      ]);

      const issues = await checkBrokenLinks(["page-a"]);
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe("broken-link");
      expect(issues[0].slug).toBe("page-a");
      expect(issues[0].target).toBe("nonexistent");
      expect(issues[0].severity).toBe("warning");
      expect(issues[0].message).toContain("nonexistent.md");
    });

    it("should not flag links to existing pages", async () => {
      await writeWikiPage(
        "page-a",
        '# Page A\n\nThis links to [Page B](page-b.md) which exists.',
      );
      await writeWikiPage(
        "page-b",
        "# Page B\n\nThis is page B with enough content to pass checks.",
      );

      const issues = await checkBrokenLinks(["page-a", "page-b"]);
      expect(issues).toHaveLength(0);
    });

    it("should produce one issue per broken link when multiple exist", async () => {
      await writeWikiPage(
        "page-a",
        '# Page A\n\nLinks to [Gone 1](gone-one.md) and [Gone 2](gone-two.md) and [Exists](page-b.md).',
      );
      await writeWikiPage(
        "page-b",
        "# Page B\n\nThis is page B with enough content to pass checks.",
      );

      const issues = await checkBrokenLinks(["page-a", "page-b"]);
      expect(issues).toHaveLength(2);
      const targets = issues.map((i) => i.target);
      expect(targets).toContain("gone-one");
      expect(targets).toContain("gone-two");
      expect(issues.map((i) => i.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("gone-one.md"),
          expect.stringContaining("gone-two.md"),
        ]),
      );
    });

    it("should not flag links to infrastructure files (index.md, log.md)", async () => {
      await writeWikiPage(
        "page-a",
        '# Page A\n\nLinks to [Index](index.md) and [Log](log.md) which are infrastructure.',
      );

      const issues = await checkBrokenLinks(["page-a"]);
      expect(issues).toHaveLength(0);
    });
  });

  it("lint result includes broken-link issues", async () => {
    await writeWikiPage(
      "linker",
      '# Linker\n\nThis page links to [Missing](does-not-exist.md) which is broken.',
    );
    await updateIndex([
      { slug: "linker", title: "Linker", summary: "Test" },
    ]);

    const result = await lint();
    const brokenLinkIssues = result.issues.filter(
      (i) => i.type === "broken-link",
    );
    expect(brokenLinkIssues).toHaveLength(1);
    expect(brokenLinkIssues[0].slug).toBe("linker");
    expect(brokenLinkIssues[0].target).toBe("does-not-exist");
    expect(brokenLinkIssues[0].message).toContain("does-not-exist.md");
  });
});

// ---------------------------------------------------------------------------
// extractWikiLinks
// ---------------------------------------------------------------------------

describe("extractWikiLinks", () => {
  it("returns empty array when no links are present", () => {
    expect(extractWikiLinks("Just some plain text.")).toEqual([]);
  });

  it("extracts a single wiki link", () => {
    const content = "See [My Page](my-page.md) for details.";
    expect(extractWikiLinks(content)).toEqual([
      { text: "My Page", targetSlug: "my-page" },
    ]);
  });

  it("extracts multiple wiki links", () => {
    const content = "See [Alpha](alpha.md) and [Beta](beta.md) and [Gamma](gamma.md).";
    expect(extractWikiLinks(content)).toEqual([
      { text: "Alpha", targetSlug: "alpha" },
      { text: "Beta", targetSlug: "beta" },
      { text: "Gamma", targetSlug: "gamma" },
    ]);
  });

  it("handles link text with special characters", () => {
    const content = 'Check [What\'s New? (2024)](whats-new-2024.md) here.';
    expect(extractWikiLinks(content)).toEqual([
      { text: "What's New? (2024)", targetSlug: "whats-new-2024" },
    ]);
  });

  it("handles slugs with hyphens and numbers", () => {
    const content = "Link to [Page 42](some-page-42.md).";
    expect(extractWikiLinks(content)).toEqual([
      { text: "Page 42", targetSlug: "some-page-42" },
    ]);
  });

  it("does not match non-.md links", () => {
    const content = "Visit [Google](https://google.com) for search.";
    expect(extractWikiLinks(content)).toEqual([]);
  });

  it("handles empty link text", () => {
    const content = "An empty link [](target.md) here.";
    expect(extractWikiLinks(content)).toEqual([
      { text: "", targetSlug: "target" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// LintOptions — selective checks and severity filtering
// ---------------------------------------------------------------------------

describe("lint with LintOptions", () => {
  it("returns only orphan-page issues when checks: ['orphan-page']", async () => {
    // Create a page on disk that isn't in the index → orphan-page
    await writeWikiPage(
      "orphan-only",
      "# Orphan Only\n\nThis page exists on disk but is not in the index.",
    );
    // Also create a stale-index scenario: index references a page that doesn't exist
    const entries: IndexEntry[] = [
      { slug: "ghost", title: "Ghost", summary: "Does not exist on disk" },
    ];
    await updateIndex(entries);

    const result = await lint({ checks: ["orphan-page"] });

    // Should only have orphan-page issues, not stale-index
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.type).toBe("orphan-page");
    }
    // Verify stale-index is NOT included (it would be if all checks ran)
    const staleIssues = result.issues.filter((i) => i.type === "stale-index");
    expect(staleIssues).toHaveLength(0);
  });

  it("excludes info-level issues when minSeverity is 'warning'", async () => {
    // Set up LLM mock to be unavailable (which generates info issues)
    mockedHasLLMKey.mockResolvedValue(false);

    // Create two pages that mention each other's title but don't cross-link
    // → missing-crossref (info severity)
    await writeWikiPage(
      "alpha-page",
      "# Alpha Page\n\nThis page talks about Beta Page and has enough content to pass.",
    );
    await writeWikiPage(
      "beta-page",
      "# Beta Page\n\nThis page talks about Alpha Page and has enough content to pass.",
    );
    // Also create an orphan (warning) to ensure it IS included
    await writeWikiPage(
      "orphan-warn",
      "# Orphan Warn\n\nThis page is not in the index and should produce a warning.",
    );
    const entries: IndexEntry[] = [
      { slug: "alpha-page", title: "Alpha Page", summary: "Alpha" },
      { slug: "beta-page", title: "Beta Page", summary: "Beta" },
    ];
    await updateIndex(entries);

    const result = await lint({ minSeverity: "warning" });

    // No info-level issues should appear
    const infoIssues = result.issues.filter((i) => i.severity === "info");
    expect(infoIssues).toHaveLength(0);

    // There should be at least the orphan warning
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("excludes warning and info issues when minSeverity is 'error'", async () => {
    // Create orphan page (warning) and stale index entry (error)
    await writeWikiPage(
      "orphan-sev",
      "# Orphan Sev\n\nThis is an orphan page producing a warning.",
    );
    const entries: IndexEntry[] = [
      { slug: "nonexistent", title: "Ghost", summary: "Page does not exist on disk" },
    ];
    await updateIndex(entries);

    const result = await lint({ minSeverity: "error" });

    // Only error-level issues should remain
    for (const issue of result.issues) {
      expect(issue.severity).toBe("error");
    }
    // The stale-index error should be present
    const staleIssues = result.issues.filter((i) => i.type === "stale-index");
    expect(staleIssues.length).toBeGreaterThan(0);
    // The orphan warning should NOT be present
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");
    expect(orphanIssues).toHaveLength(0);
  });

  it("runs all checks when no options are provided (backwards compat)", async () => {
    // Create a scenario with both orphan and stale-index issues
    await writeWikiPage(
      "page-a",
      "# Page A\n\nThis page exists on disk with enough content to pass checks.",
    );
    const entries: IndexEntry[] = [
      { slug: "page-a", title: "Page A", summary: "Exists" },
      { slug: "page-missing", title: "Missing", summary: "Does not exist" },
    ];
    await updateIndex(entries);

    // Call with no options
    const result = await lint();

    // Should detect the stale-index issue at minimum
    const staleIssues = result.issues.filter((i) => i.type === "stale-index");
    expect(staleIssues.length).toBeGreaterThan(0);

    // checkedAt should be set
    expect(result.checkedAt).toBeTruthy();
    expect(result.summary).toBeTruthy();
  });

  it("combining checks and minSeverity filters correctly", async () => {
    // Create orphan (warning) and stale-index (error)
    await writeWikiPage(
      "orphan-combo",
      "# Orphan Combo\n\nThis orphan page should produce a warning-level issue.",
    );
    const entries: IndexEntry[] = [
      { slug: "gone", title: "Gone", summary: "Does not exist on disk" },
    ];
    await updateIndex(entries);

    // Ask for only orphan-page + stale-index, but min severity = error
    const result = await lint({
      checks: ["orphan-page", "stale-index"],
      minSeverity: "error",
    });

    // orphan-page is warning → filtered out. stale-index is error → kept.
    for (const issue of result.issues) {
      expect(issue.type).toBe("stale-index");
      expect(issue.severity).toBe("error");
    }
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("returns empty issues array when checks is empty array", async () => {
    await writeWikiPage(
      "some-page",
      "# Some Page\n\nEnough content here.",
    );
    await updateIndex([
      { slug: "some-page", title: "Some Page", summary: "A page" },
    ]);

    const result = await lint({ checks: [] });
    // No checks enabled → no issues
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkIncompleteCoverage
// ---------------------------------------------------------------------------

describe("checkIncompleteCoverage", () => {
  it("returns info issue when no LLM key is configured", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await ensureDirectories();

    const issues = await checkIncompleteCoverage(["some-slug"]);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("incomplete-coverage");
    expect(issues[0].severity).toBe("info");
    expect(issues[0].message).toContain("skipped");
    expect(issues[0].message).toContain("no LLM API key");
  });

  it("returns no issues when slug has no raw source", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "no-raw",
      "# No Raw\n\nThis page has no corresponding raw source file.",
    );
    await updateIndex([
      { slug: "no-raw", title: "No Raw", summary: "Page without raw source" },
    ]);

    const issues = await checkIncompleteCoverage(["no-raw"]);

    expect(issues).toHaveLength(0);
  });

  it("reports issues when LLM finds gaps between raw source and wiki page", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    // Create a wiki page and its corresponding raw source
    await writeWikiPage(
      "test-topic",
      "# Test Topic\n\nBasic overview of the topic.",
    );
    await updateIndex([
      { slug: "test-topic", title: "Test Topic", summary: "A topic" },
    ]);
    await saveRawSource(
      "test-topic",
      "# Test Topic\n\nBasic overview of the topic.\n\n## Advanced Details\n\nImportant statistics: 42% of users prefer X. There is also a historical context section.",
    );

    mockedCallLLM.mockResolvedValueOnce(
      '[{"gap": "Advanced statistics (42% of users prefer X) missing from wiki", "importance": "high"}]',
    );

    const issues = await checkIncompleteCoverage(["test-topic"]);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("incomplete-coverage");
    expect(issues[0].severity).toBe("info");
    expect(issues[0].slug).toBe("test-topic");
    expect(issues[0].message).toContain("test-topic");
    expect(issues[0].message).toContain("42%");
    expect(issues[0].suggestion).toBeTruthy();
  });

  it("returns no issues when LLM finds no gaps", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "complete-page",
      "# Complete Page\n\nAll information from the source is well covered here.",
    );
    await updateIndex([
      { slug: "complete-page", title: "Complete Page", summary: "Well covered" },
    ]);
    await saveRawSource(
      "complete-page",
      "# Complete Page\n\nAll information from the source is well covered here.",
    );

    mockedCallLLM.mockResolvedValueOnce("[]");

    const issues = await checkIncompleteCoverage(["complete-page"]);

    expect(issues).toHaveLength(0);
  });

  it("makes a page whose only raw is a hashed snapshot a candidate (DW-437)", async () => {
    // `listRawSources` is non-recursive BY CONTRACT, so a page whose Source
    // arrived through Workbench Intake — `raw/sources/<slug>/<id>.md` — was
    // never even considered for coverage. The caller unions the snapshot
    // listing and falls back to `readRawSourceById`, so the snapshot's content
    // is what actually reaches the comparison.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "hashed-only",
      "# Hashed Only\n\nA short overview with none of the detail.",
    );
    await updateIndex([
      { slug: "hashed-only", title: "Hashed Only", summary: "Intake arrival" },
    ]);
    await saveRawSourceFor(
      "hashed-only",
      "abc123",
      "# Hashed Only\n\nSnapshot-only detail: 91% of runs converged.",
    );

    mockedCallLLM.mockResolvedValueOnce(
      '[{"gap": "Snapshot-only detail (91% of runs converged) missing", "importance": "high"}]',
    );

    const issues = await checkIncompleteCoverage(["hashed-only"]);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("incomplete-coverage");
    expect(issues[0].slug).toBe("hashed-only");
    // The comparison saw the SNAPSHOT bytes, not an empty/flat stand-in.
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0][1]).toContain("91% of runs converged");
  });

  it("still checks a hashed-only page when the FLAT listing fails (DW-437)", async () => {
    // The mirror of the case above. Before the change the flat listing throwing
    // was `return []` — the whole check abandoned — so nothing noticed if that
    // branch came back. `listRawSources` stats every flat entry it lists, so a
    // file that vanishes between the listing and the stat is what breaks it;
    // the decoy exists purely to give that walk something to stat.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "flat-listing-broken",
      "# Flat Listing Broken\n\nA short overview with none of the detail.",
    );
    await updateIndex([
      {
        slug: "flat-listing-broken",
        title: "Flat Listing Broken",
        summary: "Intake arrival",
      },
    ]);
    await saveRawSourceFor(
      "flat-listing-broken",
      "abc123",
      "# Flat Listing Broken\n\nSnapshot-only detail: 77% of shards drifted.",
    );
    await saveRawSource("decoy-flat", "a flat source for the walk to stat");

    const storage = getStorage();
    const realStat = storage.stat.bind(storage);
    const stat = vi
      .spyOn(storage, "stat")
      .mockImplementation(async (rel: string) =>
        rel.includes("decoy-flat")
          ? Promise.reject(new Error("stat failed"))
          : realStat(rel),
      );

    mockedCallLLM.mockResolvedValueOnce(
      '[{"gap": "Snapshot-only detail (77% of shards drifted) missing", "importance": "high"}]',
    );

    let issues: Awaited<ReturnType<typeof checkIncompleteCoverage>>;
    try {
      issues = await checkIncompleteCoverage(["flat-listing-broken"]);
    } finally {
      stat.mockRestore();
    }

    expect(issues).toHaveLength(1);
    expect(issues[0].slug).toBe("flat-listing-broken");
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0][1]).toContain("77% of shards drifted");
  });

  it("still drives the check from the flat listing when the snapshot walk fails (DW-437)", async () => {
    // The two listings are unioned in SEPARATE try/catch blocks on purpose. A
    // snapshot walk that throws — an unreadable `raw/sources/<slug>/` subtree —
    // must not blank the whole check and lose the flat Sources that are right
    // there; before the union there was one listing and one `return []`.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage(
      "flat-only",
      "# Flat Only\n\nA short overview with none of the detail.",
    );
    await updateIndex([
      { slug: "flat-only", title: "Flat Only", summary: "Flat arrival" },
    ]);
    await saveRawSource(
      "flat-only",
      "# Flat Only\n\nFlat-only detail: 77% of runs converged.",
    );
    // A hashed sibling, so the snapshot walk has a subtree to descend into —
    // and therefore a place to fail. Without one the walk lists the two shared
    // roots and returns cleanly, and this test would prove nothing.
    await saveRawSourceFor("hashed-sibling", "abc123", "# Sibling\n");

    // Fail EXACTLY the one prefix only the snapshot walk reads. The two roots
    // both listings share (`raw` and `raw/sources`) keep answering, so this is
    // the snapshot walk failing and nothing else.
    const storage = getStorage();
    const listFiles = storage.listFiles.bind(storage);
    const spy = vi
      .spyOn(storage, "listFiles")
      .mockImplementation(async (prefix: string) => {
        if (prefix === "raw/sources/hashed-sibling") {
          throw new Error("snapshot walk failed");
        }
        return listFiles(prefix);
      });

    mockedCallLLM.mockResolvedValueOnce(
      '[{"gap": "Flat-only detail (77% of runs converged) missing", "importance": "high"}]',
    );

    let issues;
    try {
      // The premise, pinned: under this spy the snapshot listing really does
      // throw, so the assertions below are about recovery, not a walk that
      // quietly succeeded.
      await expect(listRawSourceSnapshots()).rejects.toThrow(
        /snapshot walk failed/,
      );
      issues = await checkIncompleteCoverage(["flat-only"]);
    } finally {
      spy.mockRestore();
    }

    expect(issues).toHaveLength(1);
    expect(issues[0].slug).toBe("flat-only");
    expect(mockedCallLLM.mock.calls[0][1]).toContain("77% of runs converged");
  });

  // The coverage budget, mirrored from `checkIncompleteCoverage`'s local
  // `MAX_RAW_CHARS`. It is not exported, and the spec forbids raising it, so
  // the rows below pin the number the check actually uses.
  const COVERAGE_MAX_RAW_CHARS = 8000;

  /**
   * Split a coverage user message back into its raw parts. Everything before
   * the `--- Wiki Page:` section is the raw side; each part is one
   * `--- Raw Source: <slug> [<label>] ---` header line followed by the
   * allocated content. Headers sit OUTSIDE the budget, so the assertions below
   * count only the content.
   */
  function coverageRawParts(
    message: string,
  ): { label: string; content: string }[] {
    const wikiAt = message.indexOf("\n\n--- Wiki Page: ");
    const rawSection = message.slice(
      0,
      wikiAt === -1 ? message.length : wikiAt,
    );
    return rawSection.split("\n\n--- Raw Source: ").map((chunk, index) => {
      const body = index === 0 ? chunk.replace(/^--- Raw Source: /, "") : chunk;
      const newline = body.indexOf("\n");
      const header = newline === -1 ? body : body.slice(0, newline);
      return {
        label: header.match(/\[(.+)\] ---$/)?.[1] ?? "",
        content: newline === -1 ? "" : body.slice(newline + 1),
      };
    });
  }

  it("compares EVERY stored Source for a page in one call (DW-571)", async () => {
    // The defect: the hashed snapshots were reached only inside the `catch` of
    // `readRawSource`, and the loop `break`s on the first that opens. A page
    // with a flat blob never had its snapshots compared at all, and a page
    // with several snapshots was judged against one of them, picked by
    // directory-listing order.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("multi-source", "# Multi Source\n\nA thin overview.");
    await updateIndex([
      { slug: "multi-source", title: "Multi Source", summary: "Several arrivals" },
    ]);
    await saveRawSource(
      "multi-source",
      "# Multi Source\n\nFlat detail: 11% of runs converged.",
    );
    await saveRawSourceFor(
      "multi-source",
      "aa11",
      "# Multi Source\n\nFirst snapshot detail: 22% of shards drifted.",
    );
    await saveRawSourceFor(
      "multi-source",
      "bb22",
      "# Multi Source\n\nSecond snapshot detail: 33% of nodes stalled.",
    );

    // A real gap payload, not `[]`: the multi-part path has to keep producing
    // issues, not merely a well-shaped prompt.
    mockedCallLLM.mockResolvedValue(
      '[{"gap": "Snapshot detail (33% of nodes stalled) missing from the page", "importance": "high"}]',
    );

    const issues = await checkIncompleteCoverage(["multi-source"]);

    // One call for the page — the cap counts calls, not Sources.
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    const message = mockedCallLLM.mock.calls[0][1];
    expect(message).toContain("11% of runs converged");
    expect(message).toContain("22% of shards drifted");
    expect(message).toContain("33% of nodes stalled");
    const flatAt = message.indexOf("--- Raw Source: multi-source [flat] ---");
    const firstSnapshotAt = message.indexOf(
      "--- Raw Source: multi-source [snapshot aa11] ---",
    );
    const secondSnapshotAt = message.indexOf(
      "--- Raw Source: multi-source [snapshot bb22] ---",
    );
    expect(flatAt).toBeGreaterThanOrEqual(0);
    // Collection order, as the rendering comment claims: the flat blob first,
    // then the snapshots as listed. Header presence alone would pass whatever
    // order the budget split happened to produce.
    expect(flatAt).toBeLessThan(firstSnapshotAt);
    expect(flatAt).toBeLessThan(secondSnapshotAt);
    expect(message).toContain("--- Wiki Page: multi-source ---");
    // The gap still becomes an issue on the multi-part path.
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("incomplete-coverage");
    expect(issues[0].slug).toBe("multi-source");
    expect(issues[0].message).toContain("33% of nodes stalled");
    expect(issues[0].suggestion).toBeTruthy();
    // A multi-part payload behind a prompt that still promises the model
    // exactly two documents is a contract nobody was told about.
    const systemPrompt = mockedCallLLM.mock.calls[0][0];
    expect(systemPrompt).toContain("One or more");
    expect(systemPrompt).toContain("raw sources");
    expect(systemPrompt).not.toContain("You will be given two documents");
  });

  it("carries every snapshot when a page has no flat Source (DW-571)", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("snapshots-only", "# Snapshots Only\n\nA thin overview.");
    await updateIndex([
      { slug: "snapshots-only", title: "Snapshots Only", summary: "Intake only" },
    ]);
    await saveRawSourceFor(
      "snapshots-only",
      "aa11",
      "# Snapshots Only\n\nFirst arrival: 44% of jobs retried.",
    );
    await saveRawSourceFor(
      "snapshots-only",
      "bb22",
      "# Snapshots Only\n\nSecond arrival: 55% of queues drained.",
    );

    mockedCallLLM.mockResolvedValue("[]");

    await checkIncompleteCoverage(["snapshots-only"]);

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    const message = mockedCallLLM.mock.calls[0][1];
    expect(message).toContain("44% of jobs retried");
    expect(message).toContain("55% of queues drained");
    expect(message).not.toContain("[flat]");
  });

  it("warns and carries on when one listed snapshot cannot be read", async () => {
    // Skipped, never fatal — but not silent either: the two listing catches in
    // this same function log rather than swallow, on the rationale that a
    // broken listing and an empty one must not look alike. A page compared
    // against a partial Source set is that same lie in a smaller shape.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("partly-readable", "# Partly Readable\n\nA thin overview.");
    await updateIndex([
      { slug: "partly-readable", title: "Partly Readable", summary: "Intake only" },
    ]);
    await saveRawSourceFor(
      "partly-readable",
      "aa11",
      "# Partly Readable\n\nReadable arrival: 66% of writes landed.",
    );
    await saveRawSourceFor(
      "partly-readable",
      "bb22",
      "# Partly Readable\n\nUnreadable arrival: 77% of writes landed.",
    );

    // The snapshot stays LISTED (the walk uses `listFiles`); only the read of
    // its bytes fails, which is the shape of a file that vanishes or turns
    // unreadable between the listing and the read.
    const storage = getStorage();
    const realReadFile = storage.readFile.bind(storage);
    const readFile = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (rel: string) =>
        rel.includes("bb22.md")
          ? Promise.reject(new Error("snapshot read failed"))
          : realReadFile(rel),
      );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    mockedCallLLM.mockResolvedValue("[]");

    // `mockRestore` clears the recorded calls too, so the warnings are copied
    // out before the spies come down.
    let warnings: string[] = [];
    try {
      await checkIncompleteCoverage(["partly-readable"]);
    } finally {
      warnings = warn.mock.calls.map((call) => `${call[0]}: ${call[1]}`);
      readFile.mockRestore();
      warn.mockRestore();
    }

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    const message = mockedCallLLM.mock.calls[0][1];
    expect(message).toContain("66% of writes landed");
    expect(message).not.toContain("77% of writes landed");
    expect(
      warnings.some(
        (warning) =>
          warning.startsWith("lint: ") &&
          warning.includes("partly-readable/bb22"),
      ),
    ).toBe(true);
  });

  it("warns when a LISTED flat Source will not open, and carries on", async () => {
    // `readRawSource` throws two different things: "this page has no flat
    // blob" — the normal shape for an Intake-only page, and silent by design —
    // and "the flat blob is listed but will not open", which is a fault. The
    // flat listing's own slug set separates them, so this failure is reported
    // in the same shape a listed-but-unreadable snapshot is.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("flat-unreadable", "# Flat Unreadable\n\nA thin overview.");
    await updateIndex([
      { slug: "flat-unreadable", title: "Flat Unreadable", summary: "Mixed arrival" },
    ]);
    await saveRawSource(
      "flat-unreadable",
      "# Flat Unreadable\n\nFlat detail: 12% of writes stalled.",
    );
    await saveRawSourceFor(
      "flat-unreadable",
      "aa11",
      "# Flat Unreadable\n\nSnapshot detail: 34% of writes stalled.",
    );

    // Only the flat blob's own key fails, at either of the two locations
    // `readRawSource` tries. The listing (`listFiles` + `stat`) still reports
    // the slug, which is exactly what makes this a fault rather than an
    // absence.
    const storage = getStorage();
    const realReadFile = storage.readFile.bind(storage);
    const readFile = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (rel: string) =>
        /^raw\/(sources\/)?flat-unreadable\.md$/.test(rel)
          ? Promise.reject(new Error("flat read failed"))
          : realReadFile(rel),
      );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    mockedCallLLM.mockResolvedValue(
      '[{"gap": "Snapshot detail (34% of writes stalled) missing", "importance": "high"}]',
    );

    let issues: Awaited<ReturnType<typeof checkIncompleteCoverage>>;
    let warnings: string[] = [];
    try {
      issues = await checkIncompleteCoverage(["flat-unreadable"]);
    } finally {
      warnings = warn.mock.calls.map((call) => `${call[0]}: ${call[1]}`);
      readFile.mockRestore();
      warn.mockRestore();
    }

    expect(
      warnings.some(
        (warning) =>
          warning.startsWith("lint: ") &&
          warning.includes("flat raw source flat-unreadable"),
      ),
    ).toBe(true);
    // The readable snapshot still reaches the single comparison...
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    const message = mockedCallLLM.mock.calls[0][1];
    expect(message).toContain("34% of writes stalled");
    expect(message).not.toContain("12% of writes stalled");
    // ...and the issue path is untouched by the failed read.
    expect(issues).toHaveLength(1);
    expect(issues[0].slug).toBe("flat-unreadable");
    expect(issues[0].message).toContain("34% of writes stalled");
  });

  it("makes no LLM call when no Source for the slug can be read", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("all-unreadable", "# All Unreadable\n\nA thin overview.");
    await updateIndex([
      { slug: "all-unreadable", title: "All Unreadable", summary: "Intake only" },
    ]);
    // No flat blob at all, so `readRawSource` throws on its own; the one
    // snapshot is listed but its bytes will not come back.
    await saveRawSourceFor(
      "all-unreadable",
      "aa11",
      "# All Unreadable\n\nDetail nobody can read.",
    );

    const storage = getStorage();
    const realReadFile = storage.readFile.bind(storage);
    const readFile = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (rel: string) =>
        rel.includes("aa11.md")
          ? Promise.reject(new Error("snapshot read failed"))
          : realReadFile(rel),
      );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let issues: Awaited<ReturnType<typeof checkIncompleteCoverage>>;
    let warnings: string[] = [];
    try {
      issues = await checkIncompleteCoverage(["all-unreadable"]);
    } finally {
      warnings = warn.mock.calls.map((call) => `${call[0]}: ${call[1]}`);
      readFile.mockRestore();
      warn.mockRestore();
    }

    expect(issues).toHaveLength(0);
    expect(mockedCallLLM).not.toHaveBeenCalled();
    // Not silent: the slug is dropped, but the snapshot that would not open is
    // still reported. Only the absent flat blob passes without a word.
    expect(
      warnings.some(
        (warning) =>
          warning.startsWith("lint: ") &&
          warning.includes("all-unreadable/aa11"),
      ),
    ).toBe(true);
    expect(
      warnings.some((warning) => warning.includes("flat raw source")),
    ).toBe(false);
  });

  it("sends byte-identical Sources once so the budget is not spent twice", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    const shared = "# Duplicate\n\nIdentical detail: 88% of replicas agreed.";
    await writeWikiPage("duplicate-source", "# Duplicate\n\nA thin overview.");
    await updateIndex([
      { slug: "duplicate-source", title: "Duplicate", summary: "Same bytes twice" },
    ]);
    await saveRawSource("duplicate-source", shared);
    await saveRawSourceFor("duplicate-source", "aa11", shared);

    mockedCallLLM.mockResolvedValue("[]");

    await checkIncompleteCoverage(["duplicate-source"]);

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    const parts = coverageRawParts(mockedCallLLM.mock.calls[0][1]);
    expect(parts).toHaveLength(1);
    expect(parts[0].label).toBe("flat");
    expect(
      mockedCallLLM.mock.calls[0][1].split("88% of replicas agreed").length - 1,
    ).toBe(1);
  });

  it("gives a lone Source the whole budget and drops what is past it", async () => {
    // Both sides on purpose: a lower bound alone would pass with truncation
    // removed entirely, and an upper bound alone would pass with no budget
    // reaching the model at all.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("lone-source", "# Lone Source\n\nA thin overview.");
    await updateIndex([
      { slug: "lone-source", title: "Lone Source", summary: "One flat blob" },
    ]);
    const marker = "PAST-THE-BUDGET";
    await saveRawSource(
      "lone-source",
      "L".repeat(COVERAGE_MAX_RAW_CHARS + 500) + marker,
    );

    mockedCallLLM.mockResolvedValue("[]");

    await checkIncompleteCoverage(["lone-source"]);

    const message = mockedCallLLM.mock.calls[0][1];
    const parts = coverageRawParts(message);
    expect(parts).toHaveLength(1);
    expect(parts[0].content).toHaveLength(COVERAGE_MAX_RAW_CHARS);
    expect(message).not.toContain(marker);
  });

  it("splits the budget evenly when every Source is oversized", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("even-split", "# Even Split\n\nA thin overview.");
    await updateIndex([
      { slug: "even-split", title: "Even Split", summary: "Four big arrivals" },
    ]);
    const big = COVERAGE_MAX_RAW_CHARS; // Every part far longer than its share.
    await saveRawSource("even-split", "F".repeat(big));
    await saveRawSourceFor("even-split", "aa11", "A".repeat(big));
    await saveRawSourceFor("even-split", "bb22", "B".repeat(big));
    await saveRawSourceFor("even-split", "cc33", "C".repeat(big));

    mockedCallLLM.mockResolvedValue("[]");

    await checkIncompleteCoverage(["even-split"]);

    const parts = coverageRawParts(mockedCallLLM.mock.calls[0][1]);
    expect(parts).toHaveLength(4);
    // Every Source represented — none starved out of the payload...
    for (const part of parts) {
      expect(part.content.length).toBeGreaterThan(0);
    }
    // ...and the total still inside the budget, a quarter each.
    const total = parts.reduce((sum, part) => sum + part.content.length, 0);
    expect(total).toBeLessThanOrEqual(COVERAGE_MAX_RAW_CHARS);
    for (const part of parts) {
      expect(part.content).toHaveLength(COVERAGE_MAX_RAW_CHARS / 4);
    }
  });

  it("redistributes the unused share of short Sources to a long one", async () => {
    // The regression a plain `MAX_RAW_CHARS / n` split would introduce: an
    // oversized flat blob beside three tiny snapshots would keep 2 000 chars
    // and leave ~5 970 of the budget unspent, so bytes that reach the model
    // today would stop reaching it.
    mockedHasLLMKey.mockResolvedValue(true);

    await writeWikiPage("need-aware", "# Need Aware\n\nA thin overview.");
    await updateIndex([
      { slug: "need-aware", title: "Need Aware", summary: "One big, three tiny" },
    ]);
    await saveRawSource("need-aware", "F".repeat(30_000));
    await saveRawSourceFor("need-aware", "aa11", "tiny-aa11.");
    await saveRawSourceFor("need-aware", "bb22", "tiny-bb22.");
    await saveRawSourceFor("need-aware", "cc33", "tiny-cc33.");

    mockedCallLLM.mockResolvedValue("[]");

    await checkIncompleteCoverage(["need-aware"]);

    const parts = coverageRawParts(mockedCallLLM.mock.calls[0][1]);
    expect(parts).toHaveLength(4);
    const flat = parts.find((part) => part.label === "flat");
    const snapshots = parts.filter((part) => part.label !== "flat");
    // The short Sources arrive whole...
    expect(snapshots).toHaveLength(3);
    for (const snapshot of snapshots) {
      expect(snapshot.content).toBe(`tiny-${snapshot.label.split(" ")[1]}.`);
    }
    // ...and the long one takes the rest, far more than an equal 2 000 share.
    expect(flat?.content.length).toBe(COVERAGE_MAX_RAW_CHARS - 30);
    const total = parts.reduce((sum, part) => sum + part.content.length, 0);
    expect(total).toBeLessThanOrEqual(COVERAGE_MAX_RAW_CHARS);
  });

  // 30 pages, each costing a page write plus a raw-source write, plus the index
  // write — every one of them a whole-file write that since DW-161 fsyncs a tmp
  // file before renaming it into place. Measured here: ~35ms before the change,
  // ~0.5s after it solo, and ~4.9s under the full parallel suite, i.e. sitting
  // right on the default 5s budget. Same situation as the query-history cap row
  // and the contributors trust-score row: the durability cost is intended, but
  // it leaves no headroom, so the row goes flaky on a loaded or slower machine
  // without an explicit budget. Only the budget moves; the cap assertion below
  // is untouched.
  it("processes at most MAX_COVERAGE_CHECKS pages per run", async () => {
    mockedHasLLMKey.mockResolvedValue(true);

    // Create more pages with raw sources than the cap
    const count = MAX_COVERAGE_CHECKS + 10;
    const slugs: string[] = [];
    for (let i = 0; i < count; i++) {
      const slug = `capped-page-${i}`;
      slugs.push(slug);
      await writeWikiPage(slug, `# Page ${i}\n\nContent for page ${i}.`);
      await saveRawSource(slug, `# Page ${i}\n\nRaw content for page ${i}.`);
    }
    await updateIndex(
      slugs.map((s, i) => ({ slug: s, title: `Page ${i}`, summary: `Page ${i}` })),
    );

    // Each LLM call returns no gaps
    mockedCallLLM.mockResolvedValue("[]");

    await checkIncompleteCoverage(slugs);

    // The LLM should have been called at most MAX_COVERAGE_CHECKS times
    expect(mockedCallLLM).toHaveBeenCalledTimes(MAX_COVERAGE_CHECKS);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// parseIncompleteCoverageResponse
// ---------------------------------------------------------------------------

describe("parseIncompleteCoverageResponse", () => {
  it("parses valid gap objects", () => {
    const result = parseIncompleteCoverageResponse(
      '[{"gap": "Missing statistics", "importance": "high"}, {"gap": "Missing context", "importance": "medium"}]',
    );
    expect(result).toHaveLength(2);
    expect(result[0].gap).toBe("Missing statistics");
    expect(result[0].importance).toBe("high");
    expect(result[1].importance).toBe("medium");
  });

  it("rejects items with invalid importance", () => {
    const result = parseIncompleteCoverageResponse(
      '[{"gap": "Something", "importance": "low"}]',
    );
    expect(result).toHaveLength(0);
  });

  it("returns empty array for malformed response", () => {
    const result = parseIncompleteCoverageResponse("This is not JSON");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty array response", () => {
    const result = parseIncompleteCoverageResponse("[]");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// disputed-page dispatch
// ---------------------------------------------------------------------------

/**
 * `checkDisputedPages` has its own unit coverage in `lint-checks.test.ts`. What
 * only this file can observe is the WIRING: the check has to be imported into
 * `lint.ts`, gated on the enabled-check set, awaited in the lightweight batch,
 * AND concatenated into the returned issues. A check that is written but not
 * spread into the result array passes every unit test and returns nothing to a
 * caller — which is the exact failure mode `disputed-page` is being restored to
 * fix (DW-76), so it is worth pinning end to end.
 */
describe("lint dispatches the disputed-page check", () => {
  async function seedDisputedAndSettled() {
    await writeWikiPage(
      "contested-page",
      serializeFrontmatter(
        { disputed: true, created: "2025-01-01" },
        "# Contested Page\n\nSources disagree about this page and it has enough body text.",
      ),
    );
    await writeWikiPage(
      "settled-page",
      serializeFrontmatter(
        { disputed: false, created: "2025-01-01" },
        "# Settled Page\n\nNothing is contested here and it has enough body text.",
      ),
    );
    const entries: IndexEntry[] = [
      { slug: "contested-page", title: "Contested Page", summary: "Contested" },
      { slug: "settled-page", title: "Settled Page", summary: "Settled" },
    ];
    await updateIndex(entries);
  }

  it("returns exactly one disputed-page warning, for the disputed slug", async () => {
    await seedDisputedAndSettled();

    const result = await lint();

    const disputed = result.issues.filter((i) => i.type === "disputed-page");
    expect(disputed).toHaveLength(1);
    expect(disputed[0].slug).toBe("contested-page");
    expect(disputed[0].severity).toBe("warning");
    expect(disputed[0].suggestion).toContain("/api/wiki/contested-page");
  });

  it("skips the check when it is not in the requested check list", async () => {
    await seedDisputedAndSettled();

    const result = await lint({ checks: ["orphan-page"] });

    expect(result.issues.filter((i) => i.type === "disputed-page")).toHaveLength(0);
  });

  it("runs nothing at all when checks is an EMPTY array", async () => {
    await seedDisputedAndSettled();

    // `lint()` branches on `options?.checks !== undefined`, so `[]` means "run
    // no checks" and `undefined` means "run all". The distinction is one
    // `?.length` truthiness refactor away from collapsing — at which point `[]`
    // would silently re-enable every check, including this one. The UI relies
    // on the current meaning: `useLint` posts `checks: []` when the user
    // deselects everything, expecting an empty result rather than a full scan.
    const result = await lint({ checks: [] });

    expect(result.issues.filter((i) => i.type === "disputed-page")).toHaveLength(0);
    expect(result.issues).toEqual([]);
  });

  it("runs the check when it is the ONLY requested check", async () => {
    await seedDisputedAndSettled();

    // The complement of the test above: asking for only `disputed-page` has to
    // reach the check, or "gated off" and "never wired in" would look identical.
    const result = await lint({ checks: ["disputed-page"] });

    expect(result.issues.map((i) => i.type)).toEqual(["disputed-page"]);
    expect(result.issues[0].slug).toBe("contested-page");
  });

  it("survives the warning severity floor", async () => {
    await seedDisputedAndSettled();

    const result = await lint({ checks: ["disputed-page"], minSeverity: "warning" });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("disputed-page");
  });
});

/**
 * DW-158 — both LLM detectors must resolve the ACTIVE Wiki's Schema.
 *
 * `checkContradictions()` and `checkMissingConceptPages()` each call
 * `loadPageConventions()` with NO argument, which is what makes the resolution
 * deployment-global (`readActiveWikiSchema` → `NEXT_PUBLIC_OWNER_HANDLE`). The
 * rest of this file never configures an owner, so pinning either detector to
 * the repo-root `SCHEMA.md` — `loadPageConventions(`${process.cwd()}/SCHEMA.md`)`
 * — passes the whole suite. These two tests are the ones that would not.
 *
 * Deliberately no `process.chdir` (unlike the root-conventions test above): the
 * contrast under test is "the active Wiki's seeded conventions" vs "the real
 * repo-root SCHEMA.md", so the root file must stay reachable for the marker
 * assertion to mean anything. `"Preserve sequence when it matters"` is the
 * `reading` Scenario Template's own prose — present in a seeded `schema.md`,
 * absent from the repo-root file.
 */
describe("lint detectors resolve the ACTIVE Wiki's Schema", () => {
  const OWNER = "alice";
  const WIKI_MARKER = "Preserve sequence when it matters";
  const PURPOSE_MARKER = "Build a lasting understanding of long-form reading";

  async function seedActiveWiki() {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER; // restored in afterEach
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
  }

  it("checkContradictions prompts with the active Wiki's conventions", async () => {
    await seedActiveWiki();
    mockedHasLLMKey.mockResolvedValue(true);
    mockedCallLLM.mockResolvedValue("[]");

    // Two mutually-linked pages, so `buildClusters` forms a cluster and the
    // detector actually reaches `callLLM`.
    await writeWikiPage(
      "active-a",
      "# Active A\n\nContent about the topic. See [Active B](active-b.md).",
    );
    await writeWikiPage(
      "active-b",
      "# Active B\n\nContent about the topic. See [Active A](active-a.md).",
    );
    await updateIndex([
      { slug: "active-a", title: "Active A", summary: "Test" },
      { slug: "active-b", title: "Active B", summary: "Test" },
    ]);

    await checkContradictions(["active-a", "active-b"]);

    expect(mockedCallLLM).toHaveBeenCalled();
    const systemPrompt = mockedCallLLM.mock.calls[0][0];
    expect(systemPrompt).toContain("conventions (from SCHEMA.md)");
    expect(systemPrompt).toContain(WIKI_MARKER);
    expect(systemPrompt).toContain(PURPOSE_MARKER);
  });

  it("checkMissingConceptPages prompts with the active Wiki's conventions", async () => {
    await seedActiveWiki();
    mockedHasLLMKey.mockResolvedValue(true);
    mockedCallLLM.mockResolvedValue("[]");

    await writeWikiPage(
      "active-c",
      "# Active C\n\nA page with enough content to be sampled by the detector.",
    );
    await writeWikiPage(
      "active-d",
      "# Active D\n\nAnother page with enough content to be sampled as well.",
    );

    await checkMissingConceptPages(["active-c", "active-d"]);

    expect(mockedCallLLM).toHaveBeenCalled();
    const systemPrompt = mockedCallLLM.mock.calls[0][0];
    expect(systemPrompt).toContain("conventions (from SCHEMA.md)");
    expect(systemPrompt).toContain(WIKI_MARKER);
    expect(systemPrompt).toContain(PURPOSE_MARKER);
  });

  it("checkIncompleteCoverage prompts with the active Wiki's Purpose", async () => {
    await seedActiveWiki();
    mockedHasLLMKey.mockResolvedValue(true);
    mockedCallLLM.mockResolvedValue("[]");
    await writeWikiPage("active-coverage", "# Active coverage\n\nA short distillation.");
    await saveRawSource("active-coverage", "# Active coverage\n\nA much fuller source.");

    await checkIncompleteCoverage(["active-coverage"]);

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    expect(mockedCallLLM.mock.calls[0][0]).toContain(PURPOSE_MARKER);
  });

  it("keeps one Purpose snapshot stable in flight and resolves the next lint fresh", async () => {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const firstPurpose = "# Shelf\n\nFirst operation Purpose marker.\n";
    const nextPurpose = "# Shelf\n\nNext operation Purpose marker.\n";
    await writeWikiArtifact(OWNER, wiki.id, "purpose.md", firstPurpose);
    mockedHasLLMKey.mockResolvedValue(true);
    await writeWikiPage(
      "cache-a",
      "# Cache A\n\nShared topic. See [Cache B](cache-b.md).",
    );
    await writeWikiPage(
      "cache-b",
      "# Cache B\n\nShared topic. See [Cache A](cache-a.md).",
    );
    await updateIndex([
      { slug: "cache-a", title: "Cache A", summary: "Shared topic" },
      { slug: "cache-b", title: "Cache B", summary: "Shared topic" },
    ]);
    await saveRawSource("cache-a", "# Cache A\n\nFull source for the shared topic.");

    let changed = false;
    mockedCallLLM.mockImplementation(async () => {
      if (!changed) {
        changed = true;
        await writeWikiArtifact(OWNER, wiki.id, "purpose.md", nextPurpose);
      }
      return "[]";
    });
    await lint({
      checks: ["contradiction", "missing-concept-page", "incomplete-coverage"],
    });

    expect(mockedCallLLM).toHaveBeenCalledTimes(3);
    for (const [systemPrompt] of mockedCallLLM.mock.calls) {
      expect(systemPrompt).toContain("First operation Purpose marker.");
      expect(systemPrompt).not.toContain("Next operation Purpose marker.");
    }

    mockedCallLLM.mockClear();
    mockedCallLLM.mockResolvedValue("[]");
    await lint({
      checks: ["contradiction", "missing-concept-page", "incomplete-coverage"],
    });
    expect(mockedCallLLM).toHaveBeenCalledTimes(3);
    for (const [systemPrompt] of mockedCallLLM.mock.calls) {
      expect(systemPrompt).toContain("Next operation Purpose marker.");
      expect(systemPrompt).not.toContain("First operation Purpose marker.");
    }
  });

  it("the repo-root SCHEMA.md does NOT carry the marker", async () => {
    // Non-vacuity guard for the two pins above: if the root file ever gained
    // this phrase, they would pass without resolving any Wiki at all.
    // Explicit path, so the env var cannot steer this either way — no owner
    // needs clearing, and the static import above is enough.
    const root = await loadPageConventions(`${process.cwd()}/SCHEMA.md`);
    expect(root).toContain("## Page conventions");
    expect(root).not.toContain(WIKI_MARKER);
  });
});
