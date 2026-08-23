import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("../embeddings", () => ({
  searchByVector: vi.fn(async () => []),
}));
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    getVectorSearchSettings: vi.fn(() => ({
      enabled: false,
      provider: null,
      baseUrl: null,
      model: null,
      hasKey: false,
    })),
    getChatModelSettings: vi.fn(() => ({
      provider: "anthropic",
      providerSource: "default",
      model: "claude-sonnet-4-5",
      modelSource: "default",
      configured: true,
      usesPrimary: true,
    })),
    loadConfigSync: vi.fn(() => ({ vectorSearchEnabled: false })),
  };
});

import { searchByVector } from "../embeddings";
import { getVectorSearchSettings, loadConfigSync } from "../config";
import { _resetStorage } from "../storage";
import { serializeFrontmatter } from "../frontmatter";
import { buildSourceEntry, serializeSources } from "../sources";
import { ensureDirectories, updateIndex, writeWikiPage } from "../wiki";
import { saveRawSource, saveRawSourceFor } from "../raw";
import {
  TITLE_MATCH_BONUS,
  assembleWikiContext,
  retrieveHits,
  scoreRetrieveDocument,
  searchWiki,
} from "../wiki-retrieve";
import { CHAT_COVERAGE_MISSING_COPY } from "../workbench-modes";
import { tokenize } from "../bm25";

const mockedVector = vi.mocked(searchByVector);
const mockedVectorSettings = vi.mocked(getVectorSearchSettings);
const mockedLoadConfig = vi.mocked(loadConfigSync);

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-retrieve-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  mockedVector.mockReset();
  mockedVector.mockResolvedValue([]);
  mockedVectorSettings.mockReturnValue({
    enabled: false,
    provider: null,
    baseUrl: null,
    model: null,
    hasKey: false,
  });
  mockedLoadConfig.mockReturnValue({ vectorSearchEnabled: false } as never);
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  if (originalRawDir === undefined) delete process.env.RAW_DIR;
  else process.env.RAW_DIR = originalRawDir;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedPages(
  pages: Array<{ slug: string; title: string; body: string }>,
) {
  for (const page of pages) {
    await writeWikiPage(page.slug, `# ${page.title}\n\n${page.body}`);
  }
  await updateIndex(
    pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      summary: page.body.slice(0, 80),
    })),
  );
}

describe("title match bonus", () => {
  it("adds +10 versus a body-only hit with the same token overlap", () => {
    const tokens = tokenize("backpropagation");
    const body = "backpropagation appears once";
    const withTitle = scoreRetrieveDocument(tokens, "Backpropagation", body);
    const bodyOnly = scoreRetrieveDocument(tokens, "Other page", body);
    expect(withTitle - bodyOnly).toBe(TITLE_MATCH_BONUS);
    expect(TITLE_MATCH_BONUS).toBe(10);
  });
});

describe("assemble and search", () => {
  it("returns empty assemble and the coverage sentence when nothing matches", async () => {
    await seedPages([
      { slug: "alpha", title: "Alpha", body: "unrelated gardening notes" },
    ]);
    const assembled = await assembleWikiContext("quantum chromodynamics", {
      principal: null,
    });
    expect(assembled.coverage).toBe(false);
    expect(assembled.hits).toEqual([]);
    expect(assembled.citations).toEqual([]);
    expect(assembled.coverageMessage).toBe(CHAT_COVERAGE_MISSING_COPY);
    expect(assembled.numberedBodies).toBe("");
  });

  it("does not stuff a small wiki or fall back to first-N", async () => {
    await seedPages([
      { slug: "one", title: "One", body: "apples" },
      { slug: "two", title: "Two", body: "oranges" },
    ]);
    const { hits } = await retrieveHits("zebras", { principal: null });
    expect(hits).toEqual([]);
  });

  it("tokenizes wiki pages and raw sources, ranking a title match first", async () => {
    await seedPages([
      { slug: "other", title: "Other", body: "backpropagation shows up in the body" },
      { slug: "backpropagation", title: "Backpropagation", body: "a short note" },
    ]);
    await saveRawSource("lecture-notes", "lecture about backpropagation in class");
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    expect(hits[0]?.path).toBe("wiki/backpropagation.md");
    expect(hits.some((hit) => hit.path.startsWith("raw/sources/"))).toBe(true);
  });

  it("expands a wikilinked neighbor on the second hop", async () => {
    await seedPages([
      {
        slug: "seed",
        title: "Seed",
        body: "backpropagation primer. See [Neighbor](neighbor.md).",
      },
      {
        slug: "neighbor",
        title: "Neighbor",
        body: "unrelated filler words with no query token. See [Leaf](leaf.md).",
      },
      {
        slug: "leaf",
        title: "Leaf",
        body: "still no query token here either",
      },
    ]);
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    const ids = hits.map((hit) => hit.id);
    expect(ids).toContain("seed");
    expect(ids).toContain("neighbor");
    expect(ids).toContain("leaf");
  });

  it("expands a shared-Source neighbor ahead of a wikilink-only neighbor", async () => {
    const shared = serializeSources([
      buildSourceEntry("https://example.com/shared", "url", "system"),
    ]);
    await writeWikiPage(
      "seed",
      serializeFrontmatter(
        { title: "Seed", type: "concept", sources: shared },
        "# Seed\n\nbackpropagation primer. See [[wikilink-only]].",
      ),
    );
    await writeWikiPage(
      "overlap",
      serializeFrontmatter(
        { title: "Overlap", type: "note", sources: shared },
        "# Overlap\n\nunrelated filler words with no query token.",
      ),
    );
    await writeWikiPage(
      "wikilink-only",
      "# Wikilink Only\n\nstill no query token here either",
    );
    await updateIndex([
      { slug: "seed", title: "Seed", summary: "primer", type: "concept" },
      { slug: "overlap", title: "Overlap", summary: "shared", type: "note" },
      {
        slug: "wikilink-only",
        title: "Wikilink Only",
        summary: "link",
        type: "person",
      },
    ]);
    const { hits } = await retrieveHits("backpropagation", { principal: null, topK: 3 });
    const ids = hits.map((hit) => hit.id);
    expect(ids[0]).toBe("seed");
    expect(ids.indexOf("overlap")).toBeGreaterThan(-1);
    expect(ids.indexOf("wikilink-only")).toBeGreaterThan(-1);
    expect(ids.indexOf("overlap")).toBeLessThan(ids.indexOf("wikilink-only"));
  });

  it("surfaces a vector-phase failure and still returns tokenized hits", async () => {
    await seedPages([
      { slug: "alpha", title: "Alpha", body: "alpha body" },
    ]);
    mockedLoadConfig.mockReturnValue({ vectorSearchEnabled: true } as never);
    mockedVectorSettings.mockReturnValue({
      enabled: false,
      provider: null,
      baseUrl: null,
      model: null,
      hasKey: false,
    });
    const assembled = await assembleWikiContext("alpha", { principal: null });
    expect(assembled.coverage).toBe(true);
    expect(assembled.vectorPhase.status).toBe("failed");
    expect(assembled.hits.length).toBeGreaterThan(0);
  });

  it("merges cosine hits when vector is on, then tokenized on throw", async () => {
    await seedPages([
      { slug: "alpha", title: "Alpha", body: "alpha body" },
    ]);
    mockedVectorSettings.mockReturnValue({
      enabled: true,
      provider: "openai",
      baseUrl: "https://api.openai.com",
      model: "text-embedding-3-small",
      hasKey: true,
    });
    mockedVector.mockRejectedValueOnce(new Error("credentials invalid"));
    const assembled = await assembleWikiContext("alpha", { principal: null });
    expect(assembled.vectorPhase.status).toBe("failed");
    expect(assembled.hits.map((hit) => hit.id)).toContain("alpha");
  });

  it("keeps purpose and index out of the numbered page bodies", async () => {
    await seedPages([
      { slug: "alpha", title: "Alpha", body: "alpha body" },
      { slug: "purpose", title: "Purpose", body: "the wiki purpose statement" },
      { slug: "index", title: "Index", body: "- [Alpha](alpha.md)" },
    ]);
    const assembled = await assembleWikiContext("alpha", { principal: null });
    expect(assembled.citations.every((row) => row.path !== "wiki/purpose.md")).toBe(true);
    expect(assembled.citations.every((row) => row.path !== "wiki/index.md")).toBe(true);
    expect(assembled.systemPrompt).toContain("the wiki purpose statement");
    expect(assembled.indexSlice).toContain("Alpha");
  });

  it("respects the token budget split", async () => {
    await seedPages([
      { slug: "alpha", title: "Alpha", body: "alpha ".repeat(4000) },
    ]);
    const assembled = await assembleWikiContext("alpha", {
      principal: null,
      tokenBudget: 4000,
      history: [
        { role: "user", content: "hello ".repeat(200) },
        { role: "assistant", content: "there ".repeat(200) },
      ],
      historyDepth: 10,
    });
    expect(assembled.tokenUsage.total).toBeLessThanOrEqual(4000);
    expect(assembled.tokenUsage.budget).toBe(4000);
  });

  it("includes hashed raw/sources snapshots that the browse list skips", async () => {
    await saveRawSourceFor("plaud-meet", "cafe01", "hashed snapshot about backpropagation");
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    expect(hits.some((hit) => hit.path === "raw/sources/plaud-meet/cafe01.md")).toBe(true);
  });

  it("does not leak an apiKey on the retrieve chatModel payload", async () => {
    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha body" }]);
    const assembled = await assembleWikiContext("alpha", { principal: null });
    expect(assembled.chatModel).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        configured: true,
      }),
    );
    expect(assembled.chatModel).not.toHaveProperty("apiKey");
  });

  it("Sources-only returns source paths", async () => {
    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha concept page" }]);
    await saveRawSource("alpha-src", "alpha original transcript");
    const result = await searchWiki("alpha", {
      principal: null,
      retrievalMode: "sources",
    });
    expect(result.hits.every((hit) => hit.path.startsWith("raw/sources/"))).toBe(true);
  });

  it("excludes an oversized page so a later smaller page can fill the 60% slot", async () => {
    await seedPages([
      { slug: "huge", title: "Huge alpha", body: "alpha ".repeat(8000) },
      { slug: "tiny", title: "Tiny alpha", body: "alpha fits" },
    ]);
    const assembled = await assembleWikiContext("alpha", {
      principal: null,
      tokenBudget: 4000,
    });
    expect(assembled.coverage).toBe(true);
    expect(assembled.hits.map((hit) => hit.id)).toEqual(["tiny"]);
    expect(assembled.tokenUsage.pages).toBeLessThanOrEqual(
      Math.floor(4000 * 0.6),
    );
    expect(assembled.numberedBodies).toContain("[1] Tiny alpha");
    expect(assembled.numberedBodies).not.toContain("Huge alpha");
  });

  it("applies the 20% history cap to newest structured messages", async () => {
    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha body" }]);
    const assembled = await assembleWikiContext("alpha", {
      principal: null,
      tokenBudget: 4000,
      historyDepth: 10,
      history: [
        { role: "user", content: "old ".repeat(400) },
        { role: "assistant", content: "older ".repeat(400) },
        { role: "user", content: "newest user" },
        { role: "assistant", content: "newest assistant" },
      ],
    });
    expect(assembled.historySlice.at(-1)).toEqual({
      role: "assistant",
      content: "newest assistant",
    });
    expect(assembled.tokenUsage.history).toBeLessThanOrEqual(
      Math.floor(4000 * 0.2),
    );
    expect(assembled.historySlice.some((row) => row.content.startsWith("old "))).toBe(
      false,
    );
  });

  it("keeps distinct Source identities that share a body", async () => {
    await saveRawSource("first", "identical backpropagation transcript");
    await saveRawSource("second", "identical backpropagation transcript");
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    const sources = hits.filter((hit) => hit.kind === "source");
    expect(sources.some((hit) => hit.id === "source:first")).toBe(true);
    expect(sources.some((hit) => hit.id === "source:second")).toBe(true);
  });

  it("Search hits carry path, title, snippet, and score", async () => {
    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha concept page" }]);
    const result = await searchWiki("alpha", { principal: null });
    expect(result.hits[0]).toEqual(
      expect.objectContaining({
        path: "wiki/alpha.md",
        title: "Alpha",
        snippet: expect.any(String),
        score: expect.any(Number),
      }),
    );
  });
});
