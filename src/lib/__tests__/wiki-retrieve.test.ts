import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("../embeddings", () => ({
  searchByVector: vi.fn(async () => []),
}));
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  // Declared INSIDE the factory because `vi.mock` is hoisted above every
  // module-scope const — and shared with the async read below so that a case
  // seeding one store seeds both by default. Only the DW-712 cases pull the two
  // apart, which is the whole of what a cold cache is.
  const loadConfigSync = vi.fn(() => ({ vectorSearchEnabled: false }));
  return {
    ...actual,
    loadConfigSync,
    // MOCKED TOO (DW-712). Left real, this resolved against whatever the
    // suite's temp `DATA_DIR` happened to hold, so the awaited read this file
    // now depends on was unobservable — and the cold-cache regression it exists
    // to catch was unrepresentable.
    loadConfig: vi.fn(async () => loadConfigSync()),
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
    // Wrappers over the REAL resolvers, not replacements: the DW-619 case below
    // asserts which snapshot object they were handed, which only means anything
    // if the resolution itself is the production one. Nothing else in this file
    // touches either.
    getCustomBaseUrl: vi.fn(actual.getCustomBaseUrl),
    getOllamaBaseUrl: vi.fn(actual.getOllamaBaseUrl),
  };
});

import { searchByVector } from "../embeddings";
import {
  getChatModelSettings,
  getCustomBaseUrl,
  getOllamaBaseUrl,
  getVectorSearchSettings,
  loadConfig,
  loadConfigSync,
} from "../config";
import { _resetStorage } from "../storage";
import { serializeFrontmatter } from "../frontmatter";
import { buildSourceEntry, serializeSources } from "../sources";
import { ensureDirectories, updateIndex, writeWikiPage } from "../wiki";
import { saveRawSource, saveRawSourceBytes, saveRawSourceFor } from "../raw";
import {
  TITLE_MATCH_BONUS,
  assembleWikiContext,
  retrieveHits,
  scoreRetrieveDocument,
  searchWiki,
} from "../wiki-retrieve";
import { CHAT_COVERAGE_MISSING_COPY } from "../workbench-modes";
import { tokenize } from "../bm25";
import { INTERNAL_LINK_FIXTURE, INTERNAL_LINK_TARGETS } from "./internal-link-fixture";

const mockedVector = vi.mocked(searchByVector);
const mockedVectorSettings = vi.mocked(getVectorSearchSettings);
const mockedLoadConfig = vi.mocked(loadConfigSync);
/** The AWAITED read `assembleWikiContext` takes (DW-712). */
const mockedLoadConfigAsync = vi.mocked(loadConfig);
const mockedChatModelSettings = vi.mocked(getChatModelSettings);
const mockedCustomBaseUrl = vi.mocked(getCustomBaseUrl);
const mockedOllamaBaseUrl = vi.mocked(getOllamaBaseUrl);

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;
/**
 * The two env vars the REAL `getCustomBaseUrl` / `getOllamaBaseUrl` read BEFORE
 * the store. The DW-619 cases below wrap the real resolvers, so a value
 * exported in a developer's shell would decide the endpoint they assert —
 * scrubbed per case for the same reason the other suites scrub their provider
 * keys.
 */
const LLM_ENV_KEYS = ["LLM_CUSTOM_BASE_URL", "OLLAMA_BASE_URL"] as const;
let savedLlmEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-retrieve-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  savedLlmEnv = {};
  for (const key of LLM_ENV_KEYS) {
    savedLlmEnv[key] = process.env[key];
    delete process.env[key];
  }
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
  // RESET TOO, and back to answering whatever the sync mock answers (DW-712).
  // Without it a `mockResolvedValueOnce` that its own case did not consume
  // survives into the next one, where nothing would explain the store it sees.
  mockedLoadConfigAsync.mockReset();
  mockedLoadConfigAsync.mockImplementation(async () => mockedLoadConfig());
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  if (originalRawDir === undefined) delete process.env.RAW_DIR;
  else process.env.RAW_DIR = originalRawDir;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  for (const key of LLM_ENV_KEYS) {
    const value = savedLlmEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  it("expands a human-readable [[wikilink]] the same way Graph does", async () => {
    await seedPages([
      {
        slug: "seed",
        title: "Seed",
        body: "backpropagation primer. See [[Foo Bar]].",
      },
      {
        slug: "foo-bar",
        title: "Foo Bar",
        body: "unrelated filler words with no query token.",
      },
    ]);
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    expect(hits.map((hit) => hit.id)).toEqual(expect.arrayContaining(["seed", "foo-bar"]));
  });

  it("treats the shared Graph fixture as the same Chat direct-link evidence", async () => {
    await seedPages([
      {
        slug: "seed",
        title: "Seed",
        body: `backpropagation primer. ${INTERNAL_LINK_FIXTURE}`,
      },
      {
        slug: "foo-bar",
        title: "Foo Bar",
        body: "unrelated filler words with no query token.",
      },
      {
        slug: "leaf",
        title: "Leaf",
        body: "unrelated filler words with no query token.",
      },
      {
        slug: "old-name",
        title: "Old Name",
        body: "unrelated filler words with no query token.",
      },
    ]);
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    expect(hits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining(["seed", ...INTERNAL_LINK_TARGETS]),
    );
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
    await saveRawSourceFor("plaud-meet", "cafe010000000000", "hashed snapshot about backpropagation");
    const { hits } = await retrieveHits("backpropagation", { principal: null });
    expect(hits.some((hit) => hit.path === "raw/sources/plaud-meet/cafe010000000000.md")).toBe(true);
  });

  it("makes no retrieval document out of a BINARY snapshot row", async () => {
    // `listRawSourceSnapshots` describes every stored artefact since DW-569,
    // binaries included, but `readRawSourceById` builds `<slug>/<rawId>.md` and
    // opens Markdown only. An unfiltered `.pdf` row would throw into the warn
    // path on every single retrieval and contribute nothing to rank; the prose
    // comes from the extract stored beside it under the same `rawId`.
    await saveRawSourceBytes(
      "pdf-only",
      "beef020000000000",
      "pdf",
      new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer,
    );
    await saveRawSourceFor("pdf-only", "beef020000000000", "extracted prose about backpropagation");

    const { hits } = await retrieveHits("backpropagation", { principal: null });
    expect(hits.some((hit) => hit.path === "raw/sources/pdf-only/beef020000000000.md")).toBe(
      true,
    );
    expect(hits.some((hit) => hit.path.endsWith(".pdf"))).toBe(false);
    // Exactly one document per arrival, not one per stored artefact.
    expect(
      hits.filter((hit) => hit.id === "source:pdf-only:beef020000000000"),
    ).toHaveLength(1);
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

  it("resolves the whole chatModel payload from ONE config snapshot", async () => {
    // DW-619: provider, model, `configured` and `baseUrl` are four parts of one
    // answer, and they used to come from separate entries into a 5 s-TTL cache —
    // so a payload could pair one generation's provider with another's endpoint,
    // or with the cold-cache `{}`. Nothing else in this file pins that the two
    // resolvers share a snapshot, and the mismatch is invisible to a value
    // assertion whenever the two reads happen to agree.
    mockedChatModelSettings.mockClear();
    mockedCustomBaseUrl.mockClear();
    mockedOllamaBaseUrl.mockClear();
    mockedLoadConfig.mockReturnValue({
      vectorSearchEnabled: false,
      customBaseUrl: "https://api.example/v1",
    } as never);
    mockedChatModelSettings.mockReturnValueOnce({
      provider: "custom",
      providerSource: "config",
      model: "my-model",
      modelSource: "config",
      configured: true,
      usesPrimary: false,
    } as never);

    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha body" }]);
    const assembled = await assembleWikiContext("alpha", { principal: null });

    expect(assembled.chatModel).toEqual({
      provider: "custom",
      model: "my-model",
      configured: true,
      baseUrl: "https://api.example/v1",
    });
    // What this pins: the resolver is HANDED the snapshot the function holds,
    // rather than being called with no argument and left to read the store
    // itself. It does not — and under a module-mocked `loadConfigSync` that
    // returns one object it cannot — prove the two reads landed in the same
    // generation; the production straddle is what the `llm.ts` expiring-cache
    // suite covers. Reverting `getCustomBaseUrl(cfg)` to `getCustomBaseUrl()`
    // fails here, which is the regression this case exists for.
    expect(mockedChatModelSettings).toHaveBeenCalled();
    expect(mockedCustomBaseUrl).toHaveBeenCalled();
    const settingsCfg = mockedChatModelSettings.mock.calls[0][0];
    expect(settingsCfg).toBeDefined();
    expect(mockedCustomBaseUrl.mock.calls[0][0]).toBe(settingsCfg);
  });

  it("resolves an OLLAMA chatModel payload from that same snapshot", async () => {
    // The other store-backed leg of `chatModelForRetrieve`. Without this,
    // reverting `getOllamaBaseUrl(cfg)` to `getOllamaBaseUrl()` goes unnoticed.
    mockedChatModelSettings.mockClear();
    mockedCustomBaseUrl.mockClear();
    mockedOllamaBaseUrl.mockClear();
    mockedLoadConfig.mockReturnValue({
      vectorSearchEnabled: false,
      ollamaBaseUrl: "http://ollama.internal:11434",
    } as never);
    mockedChatModelSettings.mockReturnValueOnce({
      provider: "ollama",
      providerSource: "config",
      model: "llama3",
      modelSource: "config",
      configured: true,
      usesPrimary: false,
    } as never);

    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha body" }]);
    const assembled = await assembleWikiContext("alpha", { principal: null });

    expect(assembled.chatModel).toEqual({
      provider: "ollama",
      model: "llama3",
      configured: true,
      baseUrl: "http://ollama.internal:11434",
    });
    expect(mockedChatModelSettings).toHaveBeenCalled();
    expect(mockedOllamaBaseUrl).toHaveBeenCalled();
    const settingsCfg = mockedChatModelSettings.mock.calls[0][0];
    expect(settingsCfg).toBeDefined();
    expect(mockedOllamaBaseUrl.mock.calls[0][0]).toBe(settingsCfg);
  });

  it("describes the store on a COLD cache, from the awaited read (DW-712)", async () => {
    // DW-712, DW-548's class one door further out.
    // `/api/v1/projects/[wikiId]/retrieve` warms nothing, so
    // `chatModelForRetrieve`'s default `loadConfigSync()` answered
    // the cold-cache `{}` — and re-stamped it for another 5 s — telling an API
    // caller that a correctly configured wiki had `configured: false` and no
    // endpoint. The snapshot has to come from an AWAITED `loadConfig()`.
    //
    // The two reads are pulled APART here, which is the whole of what a cold
    // cache is: sync sees nothing, the awaited read is the only thing that can
    // see the store.
    mockedChatModelSettings.mockClear();
    mockedCustomBaseUrl.mockClear();
    mockedLoadConfig.mockReturnValue({} as never);
    const stored = {
      vectorSearchEnabled: false,
      customBaseUrl: "https://cold.example/v1",
    };
    mockedChatModelSettings.mockReturnValueOnce({
      provider: "custom",
      providerSource: "config",
      model: "cold-model",
      modelSource: "config",
      configured: true,
      usesPrimary: false,
    } as never);

    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha body" }]);
    // ARMED AFTER the awaited setup above: a one-shot queued before it would be
    // spent by whatever read the store first, and this case would then pass on
    // the default answer instead of the cold one it is about.
    mockedLoadConfigAsync.mockResolvedValueOnce(stored as never);
    const assembled = await assembleWikiContext("alpha", { principal: null });

    expect(assembled.chatModel).toEqual({
      provider: "custom",
      model: "cold-model",
      configured: true,
      baseUrl: "https://cold.example/v1",
    });
    // ONE generation, not two: both legs are handed the very object the awaited
    // read answered. Reverting to a bare `chatModelForRetrieve()` leaves them
    // holding the `{}` above, which is the regression this case exists for.
    expect(mockedChatModelSettings.mock.calls[0][0]).toBe(stored);
    expect(mockedCustomBaseUrl.mock.calls[0][0]).toBe(stored);
  });

  it("does NOT thread an empty awaited answer over the warm default (DW-712)", async () => {
    // The other half of the rule, copied from `configSnapshot` in `llm.ts`:
    // `loadConfig()` answers `{}` both for "no config file" and for "the store
    // could not be read", and on that second branch it does not prime the cache
    // either — so the PREVIOUS generation is still warm behind
    // `loadConfigSync()`. Threading `{}` would turn a transient read failure
    // into a payload reporting an unconfigured wiki, which is the very lie the
    // fix above removes. Passing nothing means "read it yourself".
    mockedChatModelSettings.mockClear();
    mockedCustomBaseUrl.mockClear();
    const warm = {
      vectorSearchEnabled: false,
      customBaseUrl: "https://warm.example/v1",
    };
    mockedLoadConfig.mockReturnValue(warm as never);
    mockedChatModelSettings.mockReturnValueOnce({
      provider: "custom",
      providerSource: "config",
      model: "warm-model",
      modelSource: "config",
      configured: true,
      usesPrimary: false,
    } as never);

    await seedPages([{ slug: "alpha", title: "Alpha", body: "alpha body" }]);
    mockedLoadConfigAsync.mockResolvedValueOnce({} as never);
    const assembled = await assembleWikiContext("alpha", { principal: null });

    expect(assembled.chatModel).toEqual({
      provider: "custom",
      model: "warm-model",
      configured: true,
      baseUrl: "https://warm.example/v1",
    });
    // The resolver fell to its own default read, not to the empty answer.
    expect(mockedChatModelSettings.mock.calls[0][0]).toBe(warm);
  });

  it("reads the store ONCE, above the empty-query return (DW-712)", async () => {
    // Both halves of where the read was put. The payload describes the
    // DEPLOYMENT, not the query, so an empty query is owed the same `chatModel`
    // a real one gets — which is why the read sits above the `!trimmed` return
    // rather than beside the retrieval below it. And it is ONE read: moving it
    // under the return, or resolving any leg from a second call, breaks one of
    // these two assertions.
    mockedChatModelSettings.mockClear();
    mockedLoadConfig.mockReturnValue({} as never);
    const stored = {
      vectorSearchEnabled: false,
      customBaseUrl: "https://cold.example/v1",
    };
    mockedChatModelSettings.mockReturnValueOnce({
      provider: "custom",
      providerSource: "config",
      model: "cold-model",
      modelSource: "config",
      configured: true,
      usesPrimary: false,
    } as never);

    mockedLoadConfigAsync.mockClear();
    mockedLoadConfigAsync.mockResolvedValueOnce(stored as never);
    const assembled = await assembleWikiContext("   ", { principal: null });

    expect(assembled.hits).toEqual([]);
    expect(assembled.chatModel).toEqual({
      provider: "custom",
      model: "cold-model",
      configured: true,
      baseUrl: "https://cold.example/v1",
    });
    expect(mockedLoadConfigAsync).toHaveBeenCalledTimes(1);
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
