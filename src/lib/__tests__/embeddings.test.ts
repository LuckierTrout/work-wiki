import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Mock the `ai` module so we never hit real API endpoints
vi.mock("ai", () => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
}));

// Mock `loadConfigSync` from config so we can control config values per test.
// The actual module does fs reads — we need a controllable mock.
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return {
    ...actual,
    loadConfigSync: vi.fn(() => ({})),
  };
});

// Mock wiki module for rebuildVectorStore tests
vi.mock("../wiki", async () => {
  const actual = await vi.importActual<typeof import("../wiki")>("../wiki");
  return {
    ...actual,
    listWikiPages: vi.fn(actual.listWikiPages),
    readWikiPage: vi.fn(actual.readWikiPage),
  };
});

// Mock the Cloudflare context. Default throws (no binding) so the suite
// behaves like a non-Workers runtime; Workers-AI tests opt in by setting a
// return value. The default is restored in beforeEach (see below).
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => {
    throw new Error("no cloudflare context");
  }),
}));

import { embed, embedMany } from "ai";
import {
  cosineSimilarity,
  contentHash,
  hasEmbeddingSupport,
  getEmbeddingModelName,
  getEmbeddingModel,
  clearEmbeddings,
  upsertEmbedding,
  removeEmbedding,
  searchByVector,
  relatedByVector,
  embedText,
  embedTexts,
  rebuildVectorStore,
  EMBEDDING_FLUSH_WINDOW,
  WORKERS_AI_EMBEDDING_DIMENSIONS,
  getWorkersAiBinding,
  _resetEmbeddingWarnings,
} from "../embeddings";
import {
  EMBEDDING_PROVIDERS,
  WORKERS_AI_EMBEDDING_DIMENSIONS as CATALOG_FROM_PROVIDERS,
  embeddingModelMatchesProvider,
  isWorkersAiEmbeddingModel,
} from "../providers";
import { logger } from "../logger";
import { getStorage, _resetStorage } from "../storage";
import { loadConfigSync } from "../config";
import { listWikiPages, readWikiPage } from "../wiki";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const DEFAULT_TEST_MODEL = "text-embedding-3-small";

/**
 * Seed an embedding through the storage provider (the new persistence layer),
 * mirroring what upsertEmbedding writes: vector + { model, contentHash }.
 */
async function seedVector(
  slug: string,
  vector: number[],
  model = DEFAULT_TEST_MODEL,
  hash = "h",
): Promise<void> {
  await getStorage().upsertEmbedding(slug, vector, { model, contentHash: hash });
}

// Cast for convenience
const mockLoadConfigSync = loadConfigSync as ReturnType<typeof vi.fn>;
const mockListWikiPages = listWikiPages as ReturnType<typeof vi.fn>;
const mockReadWikiPage = readWikiPage as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Env var save/restore — keep tests isolated
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "EMBEDDING_MODEL",
  "EMBEDDING_PROVIDER",
  "WIKI_DIR",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
  // Default: config returns empty (no config file)
  mockLoadConfigSync.mockReturnValue({});
  // Default: no Cloudflare context (non-Workers runtime). Workers-AI tests
  // override this. Re-set each test since clearAllMocks keeps implementations.
  mockGetCfContext.mockImplementation(() => {
    throw new Error("no cloudflare context");
  });
  // Misconfiguration warnings are said once per process (DW-273/DW-278), and
  // the module outlives each test — forget them so every test that asserts a
  // warning still hears it.
  _resetEmbeddingWarnings();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// Cast for convenience
const mockEmbed = embed as ReturnType<typeof vi.fn>;
const mockEmbedMany = embedMany as ReturnType<typeof vi.fn>;
const mockGetCfContext = getCloudflareContext as ReturnType<typeof vi.fn>;

/** Build a mock Workers AI binding whose run() returns the given vectors. */
function mockWorkersAi(vectors: number[][]) {
  const run = vi
    .fn()
    .mockResolvedValue({ shape: [vectors.length, vectors[0]?.length ?? 0], data: vectors });
  mockGetCfContext.mockReturnValue({ env: { AI: { run } } });
  return run;
}

/**
 * Spy on `logger.warn`, capturing calls BEFORE the restore clears them.
 * Shared by the model-resolution and warn-once suites.
 */
async function withWarnSpy<T>(
  body: () => T | Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await body();
    const warnings = warn.mock.calls
      .filter((call) => call[0] === "embeddings")
      .map((call) => String(call[1]));
    return { result, warnings };
  } finally {
    warn.mockRestore();
  }
}

/** Build a valid 1,024-dimension bge-m3/bge-large test vector. */
function workersVector(...head: number[]): number[] {
  return [...head, ...Array(Math.max(0, 1024 - head.length)).fill(0)];
}

// ---------------------------------------------------------------------------
// cosineSimilarity — pure math
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it("handles zero vectors gracefully", () => {
    const zero = [0, 0, 0];
    const v = [1, 2, 3];
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
      /dimension mismatch/i,
    );
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("computes correctly for non-unit vectors", () => {
    // cos(45°) ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 5);
  });
});

// ---------------------------------------------------------------------------
// hasEmbeddingSupport / getEmbeddingModelName
// ---------------------------------------------------------------------------

describe("hasEmbeddingSupport", () => {
  it("returns false when no keys configured", () => {
    expect(hasEmbeddingSupport()).toBe(false);
  });

  it("returns false when only Anthropic key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(hasEmbeddingSupport()).toBe(false);
  });

  it("returns true when OpenAI key is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(hasEmbeddingSupport()).toBe(true);
  });

  it("returns true when Google key is set", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
    expect(hasEmbeddingSupport()).toBe(true);
  });

  it("returns true when Ollama is configured", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/api";
    expect(hasEmbeddingSupport()).toBe(true);
  });

  it("returns true when OLLAMA_MODEL is set", () => {
    process.env.OLLAMA_MODEL = "llama3.2";
    expect(hasEmbeddingSupport()).toBe(true);
  });

  // The mirror of `detectEnvProvider`'s ollama branch (DW-370). This tail held
  // a SECOND copy of the bare presence test, so a refused `OLLAMA_BASE_URL`
  // selected `ollama` here and a whole corpus was embedded against an endpoint
  // the owner never named. Its own evidence, not the other site's.
  it("returns false when OLLAMA_BASE_URL is present but unusable", () => {
    process.env.OLLAMA_BASE_URL = "localhost:11434";
    expect(hasEmbeddingSupport()).toBe(false);
    expect(getEmbeddingModelName()).toBeNull();
  });

  it("still returns true when OLLAMA_MODEL is set beside an unusable URL", () => {
    // Only the endpoint's false signal is removed; the model name is usable on
    // its own and the SDK's default endpoint is the honest resolution.
    process.env.OLLAMA_BASE_URL = "localhost:11434";
    process.env.OLLAMA_MODEL = "llama3.2";
    expect(hasEmbeddingSupport()).toBe(true);
    expect(getEmbeddingModelName()).toBe("nomic-embed-text");
  });

  it("treats a BLANK OLLAMA_BASE_URL as unset, not as a selection", () => {
    process.env.OLLAMA_BASE_URL = "  ";
    expect(hasEmbeddingSupport()).toBe(false);
  });

  it("does not read the STORED endpoint as an env signal", () => {
    // `resolveEmbeddingProvider`'s credential tail asks the same env-only
    // question `detectEnvProvider` asks; a saved endpoint is the owner's saved
    // PROVIDER's business, one branch further up.
    mockLoadConfigSync.mockReturnValue({ ollamaBaseUrl: "http://stored-host:11434" });
    expect(hasEmbeddingSupport()).toBe(false);
  });
});

describe("getEmbeddingModelName", () => {
  it("returns null when no provider configured", () => {
    expect(getEmbeddingModelName()).toBeNull();
  });

  it("returns null when only Anthropic is configured", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getEmbeddingModelName()).toBeNull();
  });

  it("returns OpenAI default model", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
  });

  it("returns Google default model", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
    expect(getEmbeddingModelName()).toBe("gemini-embedding-001");
  });

  it("returns Ollama default model", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/api";
    expect(getEmbeddingModelName()).toBe("nomic-embed-text");
  });

  it("respects EMBEDDING_MODEL override", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBEDDING_MODEL = "text-embedding-3-large";
    expect(getEmbeddingModelName()).toBe("text-embedding-3-large");
  });

  it("prefers OpenAI over Google when both present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
  });

  it("uses config embeddingModel when env provider is set but EMBEDDING_MODEL env var is not", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockLoadConfigSync.mockReturnValue({ embeddingModel: "text-embedding-3-large" });
    expect(getEmbeddingModelName()).toBe("text-embedding-3-large");
  });

  it("EMBEDDING_MODEL env var still beats config embeddingModel with env provider", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBEDDING_MODEL = "custom-env-model";
    mockLoadConfigSync.mockReturnValue({ embeddingModel: "text-embedding-3-large" });
    expect(getEmbeddingModelName()).toBe("custom-env-model");
  });
});

// ---------------------------------------------------------------------------
// embedText / embedTexts — return null when no provider
// ---------------------------------------------------------------------------

describe("embedText / embedTexts without provider", () => {
  it("embedText returns null when no provider is configured", async () => {
    expect(await embedText("hello")).toBeNull();
  });

  it("embedTexts returns null when no provider is configured", async () => {
    expect(await embedTexts(["hello", "world"])).toBeNull();
  });
});

describe("embedText / embedTexts with mocked provider", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });

  it("embedText returns the embedding from the AI SDK", async () => {
    mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });

    const result = await embedText("hello");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockEmbed).toHaveBeenCalledOnce();
  });

  it("embedTexts returns embeddings from the AI SDK", async () => {
    mockEmbedMany.mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });

    const result = await embedTexts(["hello", "world"]);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(mockEmbedMany).toHaveBeenCalledOnce();
  });

  it("embedText truncates text longer than MAX_EMBED_CHARS", async () => {
    mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });

    // Create a string longer than MAX_EMBED_CHARS (24_000)
    const longText = "a".repeat(30_000);
    await embedText(longText);

    expect(mockEmbed).toHaveBeenCalledOnce();
    // Inspect the `value` arg passed to embed()
    const callArgs = mockEmbed.mock.calls[0][0];
    expect(callArgs.value.length).toBe(24_000);
  });

  it("embedText does not truncate text shorter than MAX_EMBED_CHARS", async () => {
    mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });

    const shortText = "hello world";
    await embedText(shortText);

    const callArgs = mockEmbed.mock.calls[0][0];
    expect(callArgs.value).toBe(shortText);
  });

  it("embedTexts truncates each text longer than MAX_EMBED_CHARS", async () => {
    mockEmbedMany.mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });

    const longText = "b".repeat(30_000);
    const shortText = "short";
    await embedTexts([longText, shortText]);

    expect(mockEmbedMany).toHaveBeenCalledOnce();
    const callArgs = mockEmbedMany.mock.calls[0][0];
    expect(callArgs.values[0].length).toBe(24_000);
    expect(callArgs.values[1]).toBe(shortText);
  });
});

// ---------------------------------------------------------------------------
// Vector store persistence — round-trip to tmp dir
// ---------------------------------------------------------------------------

describe("vector store persistence (storage provider)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embeddings-test-"));
    process.env.WIKI_DIR = tmpDir;
    process.env.DATA_DIR = tmpDir;
    _resetStorage();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("getEmbeddingById returns null when nothing is stored", async () => {
    expect(await getStorage().getEmbeddingById("missing")).toBeNull();
  });

  it("round-trips a vector + metadata through the provider", async () => {
    await seedVector("test-page", [0.1, 0.2, 0.3], DEFAULT_TEST_MODEL, "abc123");
    const got = await getStorage().getEmbeddingById("test-page");
    expect(got).not.toBeNull();
    expect(got!.vector).toEqual([0.1, 0.2, 0.3]);
    expect(got!.metadata.model).toBe(DEFAULT_TEST_MODEL);
    expect(got!.metadata.contentHash).toBe("abc123");
  });

  it("clearEmbeddings removes every stored vector", async () => {
    await seedVector("p1", [1, 0]);
    await seedVector("p2", [0, 1]);
    await clearEmbeddings();
    expect(await getStorage().getEmbeddingById("p1")).toBeNull();
    expect(await getStorage().getEmbeddingById("p2")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// relatedByVector — reuses a page's stored vector (no embedding call)
// ---------------------------------------------------------------------------

describe("relatedByVector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embeddings-test-"));
    process.env.WIKI_DIR = tmpDir;
    process.env.DATA_DIR = tmpDir;
    _resetStorage();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedAnchorSet(model = DEFAULT_TEST_MODEL): Promise<void> {
    await seedVector("anchor", [1, 0, 0], model, "a");
    await seedVector("near", [0.9, 0.1, 0], model, "b");
    await seedVector("mid", [0.6, 0.6, 0], model, "c");
    await seedVector("far", [0, 1, 0], model, "d");
  }

  it("ranks other pages by similarity to the anchor and excludes the anchor itself", async () => {
    await seedAnchorSet();
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.OPENAI_API_KEY = "sk-test";

    const results = await relatedByVector("anchor", 10);
    expect(results.map((r) => r.slug)).toEqual(["near", "mid", "far"]);
    expect(results.some((r) => r.slug === "anchor")).toBe(false);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects topK", async () => {
    await seedAnchorSet();
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.OPENAI_API_KEY = "sk-test";

    const results = await relatedByVector("anchor", 2);
    expect(results).toHaveLength(2);
  });

  it("returns [] when the anchor has no stored vector", async () => {
    await seedAnchorSet();
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.OPENAI_API_KEY = "sk-test";

    expect(await relatedByVector("ghost", 10)).toEqual([]);
  });

  it("returns [] when the anchor's vector is from a different model (stale)", async () => {
    await seedAnchorSet("text-embedding-3-small");
    process.env.EMBEDDING_MODEL = "text-embedding-3-large"; // current model differs
    process.env.OPENAI_API_KEY = "sk-test";

    expect(await relatedByVector("anchor", 10)).toEqual([]);
  });

  it("returns [] (never throws) on a mixed-dimension store", async () => {
    // Mid model-migration the store can hold vectors of different dimensions and
    // the cosine scan throws on the mismatch. relatedByVector runs unguarded on
    // the article render path, so it must degrade, not crash.
    await seedVector("anchor", [1, 0, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("other", [1, 0], DEFAULT_TEST_MODEL, "b"); // 2-dim, mismatched
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.OPENAI_API_KEY = "sk-test";

    await expect(relatedByVector("anchor", 10)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeEmbedding
// ---------------------------------------------------------------------------

describe("removeEmbedding", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embeddings-test-"));
    process.env.WIKI_DIR = tmpDir;
    process.env.DATA_DIR = tmpDir;
    _resetStorage();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("removes the correct slug from the store", async () => {
    await seedVector("keep-me", [1, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("remove-me", [0, 1], DEFAULT_TEST_MODEL, "b");
    await seedVector("also-keep", [1, 1], DEFAULT_TEST_MODEL, "c");

    await removeEmbedding("remove-me");

    const storage = getStorage();
    expect(await storage.getEmbeddingById("remove-me")).toBeNull();
    expect(await storage.getEmbeddingById("keep-me")).not.toBeNull();
    expect(await storage.getEmbeddingById("also-keep")).not.toBeNull();
  });

  it("does nothing if the slug is not in the store", async () => {
    await seedVector("existing", [1, 0], DEFAULT_TEST_MODEL, "a");

    await removeEmbedding("nonexistent");

    expect(await getStorage().getEmbeddingById("existing")).not.toBeNull();
  });

  it("does nothing if the store does not exist", async () => {
    // Should not throw
    await removeEmbedding("whatever");
  });
});

// ---------------------------------------------------------------------------
// upsertEmbedding — with mocked embed function
// ---------------------------------------------------------------------------

describe("upsertEmbedding", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embeddings-test-"));
    process.env.WIKI_DIR = tmpDir;
    process.env.DATA_DIR = tmpDir;
    process.env.OPENAI_API_KEY = "sk-test-key";
    _resetStorage();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("skips re-embedding when contentHash and model match", async () => {
    const content = "hello world";
    const hash = contentHash(content);
    // Pre-seed with the matching hash + the current model.
    await seedVector("test-page", [0.1, 0.2], "text-embedding-3-small", hash);

    await upsertEmbedding("test-page", content);

    // embed should NOT have been called since hash + model match
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("re-embeds when the stored vector is from a different model", async () => {
    const content = "hello world";
    const hash = contentHash(content);
    // Same content hash, but a stale model → must re-embed (not skip).
    await seedVector("test-page", [0.1, 0.2], "old-model-v1", hash);
    mockEmbed.mockResolvedValue({ embedding: [0.5, 0.5] });

    await upsertEmbedding("test-page", content);

    expect(mockEmbed).toHaveBeenCalled();
    const got = await getStorage().getEmbeddingById("test-page");
    expect(got!.vector).toEqual([0.5, 0.5]);
    expect(got!.metadata.model).toBe("text-embedding-3-small");
  });

  it("adds a new entry when slug is not in store", async () => {
    await seedVector("existing", [1, 0], "text-embedding-3-small", "aaa");
    mockEmbed.mockResolvedValue({ embedding: [0.3, 0.7] });

    await upsertEmbedding("new-page", "some content");

    const got = await getStorage().getEmbeddingById("new-page");
    expect(got).not.toBeNull();
    expect(got!.vector).toEqual([0.3, 0.7]);
  });

  it("updates an existing entry when content changes", async () => {
    await seedVector("my-page", [1, 0], "text-embedding-3-small", "old-hash");
    mockEmbed.mockResolvedValue({ embedding: [0.9, 0.1] });

    await upsertEmbedding("my-page", "updated content");

    const got = await getStorage().getEmbeddingById("my-page");
    expect(got!.vector).toEqual([0.9, 0.1]);
    expect(got!.metadata.contentHash).toBe(contentHash("updated content"));
  });

  it("does nothing when no embedding provider is available", async () => {
    delete process.env.OPENAI_API_KEY;

    // Should not throw and should not store anything.
    await upsertEmbedding("test", "content");

    expect(await getStorage().getEmbeddingById("test")).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("concurrent upserts don't clobber each other", async () => {
    process.env.OPENAI_API_KEY = "sk-test-concurrent";
    mockEmbed.mockResolvedValue({ embedding: [0.5, 0.5] });

    // Fire two upserts concurrently with different slugs.
    await Promise.all([
      upsertEmbedding("page-alpha", "content alpha"),
      upsertEmbedding("page-beta", "content beta"),
    ]);

    const storage = getStorage();
    expect(await storage.getEmbeddingById("page-alpha")).not.toBeNull();
    expect(await storage.getEmbeddingById("page-beta")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchByVector — with pre-loaded store
// ---------------------------------------------------------------------------

describe("searchByVector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embeddings-test-"));
    process.env.WIKI_DIR = tmpDir;
    process.env.DATA_DIR = tmpDir;
    _resetStorage();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no embedding support", async () => {
    // No provider keys set
    const results = await searchByVector("query", 5);
    expect(results).toEqual([]);
  });

  it("returns correct ranking order", async () => {
    await seedVector("low-match", [0, 1, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("high-match", [1, 0, 0], DEFAULT_TEST_MODEL, "b");
    await seedVector("mid-match", [0.7, 0.7, 0], DEFAULT_TEST_MODEL, "c");

    process.env.OPENAI_API_KEY = "sk-test";
    // Mock embed to return a query vector closest to high-match
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const results = await searchByVector("test query", 10);

    expect(results).toHaveLength(3);
    expect(results[0].slug).toBe("high-match");
    expect(results[0].score).toBeCloseTo(1.0, 5);
    expect(results[1].slug).toBe("mid-match");
    expect(results[2].slug).toBe("low-match");
    expect(results[2].score).toBeCloseTo(0.0, 5);
  });

  it("respects topK limit", async () => {
    await seedVector("a", [1, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("b", [0.9, 0.1], DEFAULT_TEST_MODEL, "b");
    await seedVector("c", [0.5, 0.5], DEFAULT_TEST_MODEL, "c");

    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0] });

    const results = await searchByVector("test", 2);
    expect(results).toHaveLength(2);
  });

  it("returns empty array when the store is empty", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0] });

    const results = await searchByVector("test", 5);
    expect(results).toEqual([]);
  });

  it("drops matches whose stored model differs from the current model, AUDIBLY", async () => {
    // Vectors were embedded by a different model than the current provider uses.
    await seedVector("page-a", [1, 0, 0], "old-model-from-different-provider", "a");
    await seedVector("page-b", [0, 1, 0], "old-model-from-different-provider", "b");

    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(() => searchByVector("test query", 10));

    // All matches filtered out — stale model.
    expect(result).toEqual([]);
    // …and the breadcrumb that makes that diagnosable rather than looking like
    // "no matches" (DW-310). `[]` alone was satisfied by a silent drop.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("embedding-model drift");
    expect(warnings[0]).toContain('active="text-embedding-3-small"');
  });

  it("says the drift line ONCE however many queries run against the drifted corpus", async () => {
    // DW-310. The drift is STANDING state — it holds until the corpus is
    // rebuilt — but this door is per QUERY, so the unthrottled line repeated
    // itself for every search anyone ran.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    await seedVector("page-b", [0, 1, 0], "old-model", "b");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(async () => [
      await searchByVector("one", 10),
      await searchByVector("two", 10),
      await searchByVector("three", 10),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dropped every match");
    // Suppression is of repetition only — every query still answered.
    expect(result).toEqual([[], [], []]);

    // The sentence names NO match count. A count is a property of the QUERY,
    // not of the misconfiguration — it is why the line was "not literally the
    // same each time" — and keying on it would have re-armed the warning for
    // every distinct number of hits. Pinned by GROWING the drifted corpus and
    // re-arming the key: the same identity produces the byte-identical line.
    expect(warnings[0]).not.toMatch(/\b\d+ match/);
    await seedVector("page-c", [0, 0, 1], "old-model", "c");
    _resetEmbeddingWarnings();
    const bigger = await withWarnSpy(() => searchByVector("four", 10));
    expect(bigger.warnings).toEqual(warnings);
  });

  it("SPEAKS again after the corpus is REBUILT and drifts a second time", async () => {
    // DW-332. Drift is the one identity in the Set that is fixed IN-process:
    // `rebuildVectorStore` is the fix and it runs in the same isolate. Without
    // a re-arm, the ONCE throttle turns "you fixed it and broke it again" into
    // silence for the rest of the process — the second outage is the one an
    // operator has no breadcrumb for.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(async () => {
      // 1. Drifted: the line is said.
      const one = await searchByVector("one", 10);
      // 2. Rebuild — the corpus is re-embedded under the ACTIVE model, so the
      //    next query keeps a match. That kept match is the signal, and it
      //    re-arms `drift:text-embedding-3-small`.
      await removeEmbedding("page-a");
      await seedVector("page-a", [1, 0, 0], DEFAULT_TEST_MODEL, "a");
      const two = await searchByVector("two", 10);
      // 3. Drift again under the SAME active model.
      await removeEmbedding("page-a");
      await seedVector("page-a", [1, 0, 0], "old-model", "a");
      const three = await searchByVector("three", 10);
      return [one, two, three];
    });

    // Twice, not once — and the second line is byte-identical to the first,
    // because the identity that drifted is the same one.
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toBe(warnings[0]);
    expect(warnings[1]).toContain('active="text-embedding-3-small"');
    // Pin the CAUSE too, not just the effect: the middle query is the one that
    // KEPT a match, which is the only thing that re-arms. Asserting warnings
    // alone would still pass if step 2 had somehow dropped everything and the
    // second line came from somewhere else.
    expect(result[0]).toEqual([]);
    expect(result[1].map((r) => r.slug)).toEqual(["page-a"]);
    expect(result[2]).toEqual([]);
  });

  it("does NOT re-arm while the drift is still standing", async () => {
    // The re-arm is gated on a KEPT match, not on a query having run. A corpus
    // that keeps drifting has never proved itself answerable, so the throttle
    // must still hold across any number of queries.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    await seedVector("page-b", [0, 1, 0], "old-model", "b");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(async () => [
      await searchByVector("one", 10),
      await searchByVector("two", 10),
      await searchByVector("three", 10),
    ]);

    // The gate, not just the throttle: EVERY query kept nothing, which is the
    // precondition for the re-arm never having run. Without this the test is
    // satisfied by a `warnOnceAbout` that simply works, and would keep passing
    // if the re-arm gate loosened to "a query ran" or "the store had hits".
    expect(result).toEqual([[], [], []]);
    expect(warnings).toHaveLength(1);
  });

  it("re-arms ONLY the drift key — other warning FAMILIES keep theirs", async () => {
    // The Set has four key namespaces and exactly one of them re-arms. A
    // wholesale `warnedMisconfigurations.clear()` here would satisfy every
    // drift test in this file while silently un-throttling the other three
    // families — the DW-273/DW-278 noise those keys exist to suppress.
    await seedVector("kept", [1, 0, 0], DEFAULT_TEST_MODEL, "a");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });
    // On the Workers runtime with `AI` unbound → `binding:workers-ai`. Provider
    // auto-detect still lands on openai via the API key.
    mockGetCfContext.mockReturnValue({ env: {} });
    // An openai-unservable override → `model:openai:@cf/baai/bge-m3`. The
    // ACTIVE model falls back to the default the corpus was seeded with, so
    // this does not itself create drift.
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3";

    const first = await withWarnSpy(() => {
      getWorkersAiBinding();
      return getEmbeddingModelName();
    });
    expect(first.result).toBe(DEFAULT_TEST_MODEL);
    expect(first.warnings).toHaveLength(2);

    // A healthy read: `kept.length > 0`, so the re-arm runs. Both other keys
    // are already burnt, so this window is silent.
    const read = await withWarnSpy(() => searchByVector("q", 10));
    expect(read.result.map((r) => r.slug)).toEqual(["kept"]);
    expect(read.warnings).toEqual([]);

    // Re-provoke both other families: still silent. Their keys survived.
    const after = await withWarnSpy(() => {
      getWorkersAiBinding();
      getEmbeddingModelName();
    });
    expect(after.warnings).toEqual([]);
  });

  it("re-arms ONLY the read's OWN drift identity, not every drift key", async () => {
    // Two active models are two drift identities. A read that is answerable
    // under A says nothing about whether the corpus is answerable under B, so
    // B's burnt key must survive A's re-arm.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { warnings } = await withWarnSpy(async () => {
      // 1. Drift under B — B's key is burnt.
      process.env.EMBEDDING_MODEL = "text-embedding-3-large";
      await searchByVector("one", 10);
      // 2. Switch to A and give it a vector to keep: re-arms `drift:A` only.
      delete process.env.EMBEDDING_MODEL;
      await seedVector("page-b", [1, 0, 0], DEFAULT_TEST_MODEL, "b");
      const healthy = await searchByVector("two", 10);
      expect(healthy.map((r) => r.slug)).toContain("page-b");
      // 3. Back to B, which is still drifted (neither vector is tagged B).
      process.env.EMBEDDING_MODEL = "text-embedding-3-large";
      await searchByVector("three", 10);
    });

    // ONE line, from step 1. Step 3 stayed silent because B was never re-armed.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('active="text-embedding-3-large"');
  });

  it("re-arms on the SAME snapshot the filter used, never a re-derived model", async () => {
    // The mirror of the one-snapshot test below, for the DELETE. Re-deriving
    // the model after `embedText`'s round-trip can straddle the 5 s cache
    // expiry — and on the re-arm path that is worse than on the warn path: it
    // would un-burn a DIFFERENT model's key on evidence about this one.
    await seedVector("page-a", [1, 0, 0], "text-embedding-3-large", "a");
    const cfgSmall = {
      embeddingProvider: "openai",
      embeddingApiKey: "sk-stored",
      embeddingModel: "text-embedding-3-small",
    };
    const cfgLarge = { ...cfgSmall, embeddingModel: "text-embedding-3-large" };

    // 1. Burn `drift:text-embedding-3-small` — the corpus IS drifted under it.
    mockLoadConfigSync.mockReturnValue(cfgSmall);
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });
    const drifted = await withWarnSpy(() => searchByVector("one", 10));
    expect(drifted.warnings).toHaveLength(1);
    expect(drifted.warnings[0]).toContain('active="text-embedding-3-small"');

    // 2. A query whose config cache turns over mid-`embed()`: the snapshot says
    //    `-large` (and the hit is KEPT under it), while a re-read would say
    //    `-small`. The re-arm must delete `drift:text-embedding-3-large`.
    mockLoadConfigSync.mockReturnValue(cfgLarge);
    mockEmbed.mockImplementation(async () => {
      mockLoadConfigSync.mockReturnValue(cfgSmall);
      return { embedding: [1, 0, 0] };
    });
    const straddle = await withWarnSpy(() => searchByVector("two", 10));
    expect(straddle.result.map((r) => r.slug)).toEqual(["page-a"]);
    expect(straddle.warnings).toEqual([]);

    // 3. `-small` is STILL burnt. A re-derived name would have deleted it in
    //    step 2 and this genuinely-drifted read would speak a second time.
    mockLoadConfigSync.mockReturnValue(cfgSmall);
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });
    const again = await withWarnSpy(() => searchByVector("three", 10));
    expect(again.result).toEqual([]);
    expect(again.warnings).toEqual([]);
  });

  it("does NOT re-arm when the query THROWS", async () => {
    // The re-arm lives on the success path inside the `try`. A throw means no
    // read completed, so nothing was established and the burnt key stays burnt.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { warnings } = await withWarnSpy(async () => {
      await searchByVector("one", 10); // drifted → the line is said
      // A mismatched-dimension vector makes the scan throw (the mid-migration
      // case). `searchByVector` degrades to [] through its catch.
      await seedVector("bad", [1, 0], "old-model", "b");
      expect(await searchByVector("two", 10)).toEqual([]);
      await removeEmbedding("bad");
      await searchByVector("three", 10); // still drifted
    });

    // Still ONE drift line. (The catch adds its own query-failed warning to the
    // window, which is why this filters rather than counting everything.)
    expect(warnings.filter((w) => w.includes("embedding-model drift"))).toHaveLength(1);
    expect(warnings.some((w) => w.includes("query failed"))).toBe(true);
  });

  it("SPEAKS again after a REAL rebuildVectorStore, not a simulated one", async () => {
    // Every comment on this feature names `rebuildVectorStore` as the
    // in-process fix; this drives the actual function rather than hand-rolling
    // it from remove+seed. It tests THROUGH the rebuild — nothing re-arms FROM
    // it, which stays `searchByVector`'s job alone.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });
    mockListWikiPages.mockResolvedValue([
      { title: "Page A", slug: "page-a", summary: "Summary A" },
    ]);
    mockReadWikiPage.mockResolvedValue({
      slug: "page-a",
      title: "Page A",
      content: "Content A",
      path: "/fake/page-a.md",
    });

    const { warnings } = await withWarnSpy(async () => {
      await searchByVector("one", 10); // drifted → the line is said

      const rebuilt = await rebuildVectorStore();
      expect(rebuilt.embedded).toBe(1);
      expect(rebuilt.model).toBe(DEFAULT_TEST_MODEL);

      // The rebuild re-tagged the vector, so this read keeps it and re-arms.
      const healthy = await searchByVector("two", 10);
      expect(healthy.map((r) => r.slug)).toEqual(["page-a"]);

      // Drift again under the SAME active model.
      await removeEmbedding("page-a");
      await seedVector("page-a", [1, 0, 0], "old-model", "a");
      await searchByVector("three", 10);
    });

    expect(warnings.filter((w) => w.includes("embedding-model drift"))).toHaveLength(2);
  });

  it("re-arms SILENTLY on a healthy corpus that never drifted", async () => {
    // Deleting a key that was never set is a no-op: no warning, and results
    // are exactly what they were before the re-arm existed.
    await seedVector("page-a", [1, 0, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("page-b", [0, 1, 0], DEFAULT_TEST_MODEL, "b");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(async () => [
      await searchByVector("one", 10),
      await searchByVector("two", 10),
    ]);

    expect(warnings).toEqual([]);
    expect(result[0].map((r) => r.slug)).toEqual(["page-a", "page-b"]);
    expect(result[1]).toEqual(result[0]);
  });

  it("SPEAKS again when the ACTIVE MODEL changes and still drifts", async () => {
    // A changed misconfiguration is a new identity. The corpus is untouched;
    // what moved is the model the deployment now embeds with, and an owner
    // reading the log needs the new name.
    await seedVector("page-a", [1, 0, 0], "old-model", "a");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { warnings } = await withWarnSpy(async () => {
      await searchByVector("one", 10);
      await searchByVector("two", 10);
      // A second openai-servable id, so the only thing that changes is the
      // ACTIVE model — no substitution warning joins the window.
      process.env.EMBEDDING_MODEL = "text-embedding-3-large";
      await searchByVector("three", 10);
      await searchByVector("four", 10);
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('active="text-embedding-3-small"');
    expect(warnings[1]).toContain('active="text-embedding-3-large"');
  });

  it("stays SILENT when the filter keeps even one match", async () => {
    // Not drift: the corpus still holds vectors this model produced, so the
    // query is answerable and there is nothing standing to report.
    await seedVector("kept", [1, 0, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("dropped", [0, 1, 0], "old-model", "b");
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(() => searchByVector("q", 10));

    expect(result.map((r) => r.slug)).toEqual(["kept"]);
    expect(warnings).toEqual([]);
  });

  it("stays SILENT when the store returns nothing at all", async () => {
    // An empty store is not a drifted one. Warning here would fire on every
    // fresh deployment, before a single page had been embedded.
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const { result, warnings } = await withWarnSpy(() => searchByVector("q", 10));

    expect(result).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("returns [] (never throws) when the scan hits a dimension mismatch", async () => {
    await seedVector("a", [1, 0, 0], DEFAULT_TEST_MODEL, "a");
    await seedVector("b", [1, 0], DEFAULT_TEST_MODEL, "b"); // mismatched dimension
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    await expect(searchByVector("q", 10)).resolves.toEqual([]);
  });

  it("keeps `searchByVector` on ONE snapshot for both halves", async () => {
    // The caller the door exists for. `embedText` has a network round-trip
    // inside it, so two independent cache reads can straddle the 5 s expiry:
    // the query gets embedded with snapshot A's model while the filter compares
    // against snapshot B's, every hit is dropped, and the drift line fires for a
    // corpus that has not drifted — BURNING the `drift:<model>` key so a later
    // real drift under that model is silent for the rest of the process.
    //
    // Simulated by making the cache turn over DURING the embed: the mock hands
    // back a different config from the moment `embed()` resolves. A
    // `searchByVector` that re-read the cache for the filter would see the
    // second one.
    await seedVector("page-a", [1, 0, 0], "text-embedding-3-large", "a");
    mockLoadConfigSync.mockReturnValue({
      embeddingProvider: "openai",
      embeddingApiKey: "sk-stored",
      embeddingModel: "text-embedding-3-large",
    });
    mockEmbed.mockImplementation(async () => {
      // The cache expires mid-flight and now answers a DIFFERENT active model.
      mockLoadConfigSync.mockReturnValue({
        embeddingProvider: "openai",
        embeddingApiKey: "sk-stored",
        embeddingModel: "text-embedding-3-small",
      });
      return { embedding: [1, 0, 0] };
    });

    const { result, warnings } = await withWarnSpy(() => searchByVector("q", 10));

    // The vector was embedded with `text-embedding-3-large` and the filter
    // compared against `text-embedding-3-large`, so the hit is KEPT…
    expect(result.map((r) => r.slug)).toEqual(["page-a"]);
    // …and no drift was reported for a corpus that has not drifted.
    expect(warnings).toEqual([]);
  });

  it("keeps unlabelled (legacy) vectors with no model metadata", async () => {
    // Pre-migration / KV-fallback vectors may carry no `model` key. The filter
    // must NOT drop them, or the whole corpus would vanish after first deploy.
    await getStorage().upsertEmbedding("legacy", [1, 0, 0], { contentHash: "x" });
    process.env.OPENAI_API_KEY = "sk-test";
    mockEmbed.mockResolvedValue({ embedding: [1, 0, 0] });

    const results = await searchByVector("q", 10);
    expect(results.map((r) => r.slug)).toContain("legacy");
  });
});

// ---------------------------------------------------------------------------
// contentHash utility
// ---------------------------------------------------------------------------

describe("contentHash", () => {
  it("returns consistent hash for same content", () => {
    const h1 = contentHash("hello");
    const h2 = contentHash("hello");
    expect(h1).toBe(h2);
  });

  it("returns different hash for different content", () => {
    const h1 = contentHash("hello");
    const h2 = contentHash("world");
    expect(h1).not.toBe(h2);
  });

  it("returns a 16-char hex string (FNV-1a)", () => {
    const h = contentHash("test");
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingModel — basic checks (no real API calls)
// ---------------------------------------------------------------------------

describe("getEmbeddingModel", () => {
  it("returns null when no provider configured", () => {
    expect(getEmbeddingModel()).toBeNull();
  });

  it("returns null when only Anthropic is configured", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getEmbeddingModel()).toBeNull();
  });

  it("returns a model object when OpenAI is configured", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const model = getEmbeddingModel();
    expect(model).not.toBeNull();
  });

  it("returns a model object when Google is configured", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";
    const model = getEmbeddingModel();
    expect(model).not.toBeNull();
  });

  it("returns a model object when Ollama is configured", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/api";
    const model = getEmbeddingModel();
    expect(model).not.toBeNull();
  });

  it("uses config embeddingModel in env provider path when EMBEDDING_MODEL env var absent", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockLoadConfigSync.mockReturnValue({ embeddingModel: "text-embedding-3-large" });
    // Should use config embeddingModel, not the provider default
    const model = getEmbeddingModel();
    expect(model).not.toBeNull();
    // Verify the model name resolution matches
    expect(getEmbeddingModelName()).toBe("text-embedding-3-large");
  });

  it("uses config ollamaBaseUrl in env-detected Ollama path", () => {
    // Ollama detected via OLLAMA_MODEL env var (no OLLAMA_BASE_URL env var)
    process.env.OLLAMA_MODEL = "llama3.2";
    mockLoadConfigSync.mockReturnValue({ ollamaBaseUrl: "http://remote-ollama:11434/api" });
    const model = getEmbeddingModel();
    expect(model).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Config file fallback — embedding functions read config when env vars absent
// ---------------------------------------------------------------------------

describe("config file fallback for embeddings", () => {
  describe("getEmbeddingModelName", () => {
    it("returns null when config has openai provider without env key (config apiKey no longer supported)", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });
      expect(getEmbeddingModelName()).toBeNull();
    });

    it("returns null when config has google provider without env key", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "google" });
      expect(getEmbeddingModelName()).toBeNull();
    });

    it("returns Ollama default when config has ollama provider (no key needed)", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "ollama" });
      expect(getEmbeddingModelName()).toBe("nomic-embed-text");
    });

    it("returns config embeddingModel for ollama provider", () => {
      mockLoadConfigSync.mockReturnValue({
        provider: "ollama",
        embeddingModel: "mxbai-embed-large",
      });
      expect(getEmbeddingModelName()).toBe("mxbai-embed-large");
    });

    it("EMBEDDING_MODEL env var overrides config embeddingModel when env provider set", () => {
      process.env.EMBEDDING_MODEL = "custom-model";
      process.env.OPENAI_API_KEY = "sk-env-test";
      mockLoadConfigSync.mockReturnValue({
        embeddingModel: "text-embedding-3-large",
      });
      expect(getEmbeddingModelName()).toBe("custom-model");
    });

    it("env var provider takes priority over config provider", () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-env-key";
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });
      // Should use Google (env) not OpenAI (config)
      expect(getEmbeddingModelName()).toBe("gemini-embedding-001");
    });

    it("returns null when config has anthropic provider", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "anthropic" });
      expect(getEmbeddingModelName()).toBeNull();
    });

    it("returns null when config has openai provider but no env key", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });
      expect(getEmbeddingModelName()).toBeNull();
    });
  });

  describe("hasEmbeddingSupport", () => {
    it("returns false when config has openai provider without env key (config apiKey no longer supported)", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });
      expect(hasEmbeddingSupport()).toBe(false);
    });

    it("returns false when config has google provider without env key", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "google" });
      expect(hasEmbeddingSupport()).toBe(false);
    });

    it("returns true when config has ollama provider", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "ollama" });
      expect(hasEmbeddingSupport()).toBe(true);
    });

    it("returns false when config has anthropic provider", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "anthropic" });
      expect(hasEmbeddingSupport()).toBe(false);
    });

    it("returns false when config is empty", () => {
      mockLoadConfigSync.mockReturnValue({});
      expect(hasEmbeddingSupport()).toBe(false);
    });
  });

  describe("getEmbeddingModel", () => {
    it("returns null when config has openai provider without env key (config apiKey no longer supported)", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });
      const model = getEmbeddingModel();
      expect(model).toBeNull();
    });

    it("returns null when config has google provider without env key", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "google" });
      const model = getEmbeddingModel();
      expect(model).toBeNull();
    });

    it("returns a model when config has ollama provider", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "ollama" });
      const model = getEmbeddingModel();
      expect(model).not.toBeNull();
    });

    it("returns null when config has anthropic provider", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "anthropic" });
      expect(getEmbeddingModel()).toBeNull();
    });

    it("returns null when config has openai but no env key", () => {
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });
      expect(getEmbeddingModel()).toBeNull();
    });

    it("returns a model when env has openai key regardless of config", () => {
      process.env.OPENAI_API_KEY = "sk-env-key";
      mockLoadConfigSync.mockReturnValue({});
      const model = getEmbeddingModel();
      expect(model).not.toBeNull();
    });

    it("env var OpenAI key takes priority over config", () => {
      process.env.OPENAI_API_KEY = "sk-env-key";
      mockLoadConfigSync.mockReturnValue({ provider: "google" });
      // Should use OpenAI (env) not Google (config)
      const model = getEmbeddingModel();
      expect(model).not.toBeNull();
      // getEmbeddingModelName should confirm OpenAI was selected
      expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
    });

    it("uses config ollamaBaseUrl for ollama provider", () => {
      mockLoadConfigSync.mockReturnValue({
        provider: "ollama",
        ollamaBaseUrl: "http://my-ollama:11434/api",
      });
      const model = getEmbeddingModel();
      expect(model).not.toBeNull();
    });
  });

  describe("config-file-only embedding (no env vars)", () => {
    it("embedText returns null when config has openai provider but no env key (config apiKey no longer supported)", async () => {
      mockLoadConfigSync.mockReturnValue({ provider: "openai" });

      const result = await embedText("hello world");
      expect(result).toBeNull();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it("embedText returns null when config only has anthropic (no embedding support)", async () => {
      mockLoadConfigSync.mockReturnValue({ provider: "anthropic" });

      const result = await embedText("hello world");
      expect(result).toBeNull();
      expect(mockEmbed).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// rebuildVectorStore
// ---------------------------------------------------------------------------

describe("rebuildVectorStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embeddings-rebuild-"));
    process.env.WIKI_DIR = tmpDir;
    process.env.DATA_DIR = tmpDir;
    process.env.OPENAI_API_KEY = "sk-test-key";
    _resetStorage();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when no embedding provider is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    mockLoadConfigSync.mockReturnValue({});

    await expect(rebuildVectorStore()).rejects.toThrow(
      /No embedding provider configured/,
    );
  });

  it("embeds all wiki pages into the store", async () => {
    mockListWikiPages.mockResolvedValue([
      { title: "Page A", slug: "page-a", summary: "Summary A" },
      { title: "Page B", slug: "page-b", summary: "Summary B" },
    ]);
    mockReadWikiPage.mockImplementation(async (slug: string) => {
      if (slug === "page-a") {
        return { slug: "page-a", title: "Page A", content: "Content A", path: "/fake/page-a.md" };
      }
      if (slug === "page-b") {
        return { slug: "page-b", title: "Page B", content: "Content B", path: "/fake/page-b.md" };
      }
      return null;
    });

    let callCount = 0;
    mockEmbed.mockImplementation(async () => {
      callCount++;
      return { embedding: [0.1 * callCount, 0.2 * callCount] };
    });

    const result = await rebuildVectorStore();

    expect(result.total).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.model).toBe("text-embedding-3-small");

    const storage = getStorage();
    const a = await storage.getEmbeddingById("page-a");
    expect(a).not.toBeNull();
    expect(a!.metadata.model).toBe("text-embedding-3-small");
    expect(a!.metadata.contentHash).toBe(contentHash("Content A"));
    expect(await storage.getEmbeddingById("page-b")).not.toBeNull();
  });

  it("warns ONCE about a mismatched EMBEDDING_MODEL across all N pages", async () => {
    // DW-273: `rebuildVectorStore` resolves the name once and then calls
    // `embedText` per page, so a stale override logged ~2N identical lines.
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3"; // openai cannot serve it
    const slugs = ["p1", "p2", "p3"];
    mockListWikiPages.mockResolvedValue(
      slugs.map((slug) => ({ title: slug, slug, summary: slug })),
    );
    mockReadWikiPage.mockImplementation(async (slug: string) => ({
      slug,
      title: slug,
      content: `content ${slug}`,
      path: `/fake/${slug}.md`,
    }));
    mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2] });

    const { result, warnings } = await withWarnSpy(() => rebuildVectorStore());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@cf/baai/bge-m3");
    // Every page is still embedded, with the provider default.
    expect(result.embedded).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.model).toBe("text-embedding-3-small");
  });

  it("skips pages with empty content", async () => {
    mockListWikiPages.mockResolvedValue([
      { title: "Good", slug: "good", summary: "Has content" },
      { title: "Empty", slug: "empty", summary: "No content" },
    ]);
    mockReadWikiPage.mockImplementation(async (slug: string) => {
      if (slug === "good") {
        return { slug: "good", title: "Good", content: "Real content", path: "/fake/good.md" };
      }
      if (slug === "empty") {
        return { slug: "empty", title: "Empty", content: "   ", path: "/fake/empty.md" };
      }
      return null;
    });

    mockEmbed.mockResolvedValue({ embedding: [0.5, 0.5] });

    const result = await rebuildVectorStore();

    expect(result.total).toBe(2);
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(1);

    const storage = getStorage();
    expect(await storage.getEmbeddingById("good")).not.toBeNull();
    expect(await storage.getEmbeddingById("empty")).toBeNull();
  });

  it("skips pages where readWikiPage returns null", async () => {
    mockListWikiPages.mockResolvedValue([
      { title: "Missing", slug: "missing", summary: "Not found" },
    ]);
    mockReadWikiPage.mockResolvedValue(null);

    const result = await rebuildVectorStore();

    expect(result.total).toBe(1);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("upserts current pages (orphans from deleted pages are left for query-time filtering)", async () => {
    // Pre-seed an orphan (a page no longer in the index).
    await seedVector("old-page", [1, 0], "old-model", "old");

    mockListWikiPages.mockResolvedValue([
      { title: "New", slug: "new-page", summary: "Brand new" },
    ]);
    mockReadWikiPage.mockResolvedValue({
      slug: "new-page",
      title: "New",
      content: "New content",
      path: "/fake/new-page.md",
    });
    mockEmbed.mockResolvedValue({ embedding: [0.9, 0.1] });

    const result = await rebuildVectorStore();

    expect(result.embedded).toBe(1);
    const newPage = await getStorage().getEmbeddingById("new-page");
    expect(newPage).not.toBeNull();
    expect(newPage!.metadata.model).toBe("text-embedding-3-small");
    // The orphan isn't actively purged (no bulk-clear on a managed index); it's
    // harmless because reads intersect with the readable slug set.
  });

  it("calls onProgress callback", async () => {
    mockListWikiPages.mockResolvedValue([
      { title: "A", slug: "a", summary: "A" },
      { title: "B", slug: "b", summary: "B" },
    ]);
    mockReadWikiPage.mockImplementation(async (slug: string) => ({
      slug,
      title: slug.toUpperCase(),
      content: `Content for ${slug}`,
      path: `/fake/${slug}.md`,
    }));
    mockEmbed.mockResolvedValue({ embedding: [0.5, 0.5] });

    const progress: Array<[number, number]> = [];
    await rebuildVectorStore((done, total) => {
      progress.push([done, total]);
    });

    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("handles empty wiki gracefully", async () => {
    mockListWikiPages.mockResolvedValue([]);

    const result = await rebuildVectorStore();

    expect(result.total).toBe(0);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(0);
  });

  /** Two full windows' worth of pages, derived so raising the window still spans one. */
  const REBUILD_PAGES = EMBEDDING_FLUSH_WINDOW * 2;

  /** Seed the mocks for a rebuild over `count` identical, embeddable pages. */
  function stageRebuild(count: number): void {
    mockListWikiPages.mockResolvedValue(
      Array.from({ length: count }, (_, i) => ({
        title: `p-${i}`,
        slug: `p-${i}`,
        summary: `p-${i}`,
      })),
    );
    mockReadWikiPage.mockImplementation(async (slug: string) => ({
      slug,
      title: slug,
      content: `content ${slug}`,
      path: `/fake/${slug}.md`,
    }));
    mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2] });
  }

  it("flushes the vector store in windows, not once per page (DW-293)", async () => {
    // The per-page door is a whole-blob load, rewrite and fsync on the
    // filesystem provider, so an N-page rebuild wrote a growing blob N times.
    stageRebuild(REBUILD_PAGES);

    const storage = getStorage();
    const bulk = vi.spyOn(storage, "upsertEmbeddings");
    const single = vi.spyOn(storage, "upsertEmbedding");

    const result = await rebuildVectorStore();

    expect(result.embedded).toBe(REBUILD_PAGES);
    expect(result.skipped).toBe(0);
    // EXACTLY the full windows. The trailing flush after the loop finds nothing
    // pending when the page count divides evenly, so it costs no write — an
    // upper bound of "windows + 1" would have hidden a per-page regression of
    // one, and would have passed with the trailing flush writing a duplicate.
    expect(bulk).toHaveBeenCalledTimes(REBUILD_PAGES / EMBEDDING_FLUSH_WINDOW);
    for (const [batch] of bulk.mock.calls) {
      expect(batch).toHaveLength(EMBEDDING_FLUSH_WINDOW);
    }
    expect(single).not.toHaveBeenCalled();

    // The budget must not have been met by storing fewer vectors.
    expect(await storage.getEmbeddingById("p-0")).not.toBeNull();
    expect(
      await storage.getEmbeddingById(`p-${REBUILD_PAGES - 1}`),
    ).not.toBeNull();
    expect(await storage.queryEmbeddings([0.1, 0.2], REBUILD_PAGES * 2)).toHaveLength(
      REBUILD_PAGES,
    );
  });

  it("flushes a partial trailing window", async () => {
    // The other half of the seam: with a remainder, the flush after the loop is
    // the only thing that stores those pages at all.
    const count = EMBEDDING_FLUSH_WINDOW + 3;
    stageRebuild(count);

    const storage = getStorage();
    const bulk = vi.spyOn(storage, "upsertEmbeddings");

    const result = await rebuildVectorStore();

    expect(result.embedded).toBe(count);
    expect(bulk).toHaveBeenCalledTimes(2);
    expect(bulk.mock.calls[1][0]).toHaveLength(3);
    expect(await storage.getEmbeddingById(`p-${count - 1}`)).not.toBeNull();
  });

  it("counts a whole window as skipped when its flush fails, and warns once", async () => {
    // The one place windowing changes `RebuildResult`: the per-page version
    // could only ever blame the page it was upserting, and this reports the
    // whole window. Skipped-but-possibly-stored is the safe direction — it
    // under-claims what the store holds, and the rebuild is re-runnable.
    const count = EMBEDDING_FLUSH_WINDOW;
    stageRebuild(count);

    const storage = getStorage();
    const fault = new Error("vector store unavailable");
    vi.spyOn(storage, "upsertEmbeddings").mockRejectedValue(fault);

    const { result, warnings } = await withWarnSpy(() => rebuildVectorStore());

    expect(result.total).toBe(count);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(count);
    // One line for the window, not one per page — the same restraint DW-273
    // asked for on the model-mismatch warning.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${count}`);
    expect(await storage.getEmbeddingById("p-0")).toBeNull();
  });

  it("skips pages where embedding throws an error", async () => {
    mockListWikiPages.mockResolvedValue([
      { title: "Good", slug: "good", summary: "Works" },
      { title: "Bad", slug: "bad", summary: "Fails" },
    ]);
    mockReadWikiPage.mockImplementation(async (slug: string) => ({
      slug,
      title: slug,
      content: `Content for ${slug}`,
      path: `/fake/${slug}.md`,
    }));

    let callIndex = 0;
    mockEmbed.mockImplementation(async () => {
      callIndex++;
      if (callIndex === 2) throw new Error("API rate limit");
      return { embedding: [0.5, 0.5] };
    });

    const result = await rebuildVectorStore();

    expect(result.total).toBe(2);
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Workers AI embeddings (@cf/baai/bge-m3) — decoupled from the LLM provider
// ---------------------------------------------------------------------------

describe("Workers AI embeddings (bge-m3)", () => {
  it("auto-selects workers-ai when the AI binding is present", () => {
    mockWorkersAi([[0.1, 0.2]]);
    // No LLM provider env / config set — binding alone drives selection.
    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");
    expect(hasEmbeddingSupport()).toBe(true);
    // It is not an AI SDK model — generation happens via the binding.
    expect(getEmbeddingModel()).toBeNull();
  });

  it("embedText calls the binding with @cf/baai/bge-m3 and returns the vector", async () => {
    const run = mockWorkersAi([workersVector(0.1, 0.2, 0.3)]);

    const vec = await embedText("你好世界");

    expect(vec).toHaveLength(1024);
    expect(vec?.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    // CLS pooling is requested for higher-quality bge-m3 embeddings.
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["你好世界"],
      pooling: "cls",
    });
    // The AI SDK embed() path must not be used for workers-ai.
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("embedTexts batches all inputs in a single binding call", async () => {
    const run = mockWorkersAi([
      workersVector(0.1, 0.2),
      workersVector(0.3, 0.4),
    ]);

    const vecs = await embedTexts(["a", "b"]);

    expect(vecs).toHaveLength(2);
    expect(vecs?.[0]).toHaveLength(1024);
    expect(vecs?.[1]).toHaveLength(1024);
    expect(vecs?.[0].slice(0, 2)).toEqual([0.1, 0.2]);
    expect(vecs?.[1].slice(0, 2)).toEqual([0.3, 0.4]);
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["a", "b"],
      pooling: "cls",
    });
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  it("explicit EMBEDDING_PROVIDER=workers-ai wins over an LLM provider", () => {
    // An embedding-capable LLM provider is configured...
    process.env.OPENAI_API_KEY = "sk-openai";
    // ...but the explicit override forces Workers AI.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    mockWorkersAi([workersVector(0.1)]);

    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");
  });

  it("honors a workers-ai EMBEDDING_MODEL override (must be a @cf/ id)", async () => {
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
    const run = mockWorkersAi([workersVector(0.5)]);

    await embedText("hi");

    expect(run).toHaveBeenCalledWith("@cf/baai/bge-large-en-v1.5", {
      text: ["hi"],
      pooling: "cls",
    });
  });

  it("ignores a non-@cf EMBEDDING_MODEL leaking into the workers-ai call", async () => {
    // A stale override from a previous OpenAI setup must NOT be passed to
    // ai.run() — it would be an invalid Workers AI model id.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    const run = mockWorkersAi([workersVector(0.5)]);

    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");
    await embedText("hi");
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
  });

  it("ignores a @cf EMBEDDING_MODEL leaking into a non-workers provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3";
    // The @cf id must not leak into OpenAI — falls back to the openai default.
    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
  });

  it("returns null from embedText when the binding is unavailable", async () => {
    // Force the workers-ai provider but leave the CF context throwing.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    expect(await embedText("hi")).toBeNull();
  });

  it("returns null when the binding response lacks a data array", async () => {
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    mockGetCfContext.mockReturnValue({
      env: { AI: { run: vi.fn().mockResolvedValue({ shape: [1] }) } },
    });
    expect(await embedText("hi")).toBeNull();
  });

  it("rejects bge-m3 vectors whose width does not match the 1,024-dimension index", async () => {
    mockWorkersAi([Array(1536).fill(0.1)]);

    await expect(embedText("dimension guard")).rejects.toThrow(
      "expected 1024, received 1536",
    );
  });

  it("refuses a @cf/ id that is not an embedding model, and falls back", async () => {
    // In the namespace, genuinely a Cloudflare model — and not something the
    // embedding binding will serve (DW-220). Before the catalog it reached
    // `ai.run()` verbatim.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
    const run = mockWorkersAi([workersVector(0.5)]);

    await embedText("hi");

    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
  });

  it("refuses the BARE @cf/ prefix rather than sending it to the binding", async () => {
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "@cf/";
    const run = mockWorkersAi([workersVector(0.5)]);

    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");
    await embedText("hi");
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
  });
});

// ---------------------------------------------------------------------------
// Model resolution: ONE trim rule, and an AUDIBLE fallback
// (DW-221 / DW-224 / DW-226 / DW-227)
// ---------------------------------------------------------------------------

describe("embedding model resolution", () => {
  it("re-exports the ONE Workers AI catalog rather than holding a copy", () => {
    // Same object, not merely equal: two tables would let the gate approve an
    // id the dimension check does not know.
    expect(WORKERS_AI_EMBEDDING_DIMENSIONS).toBe(CATALOG_FROM_PROVIDERS);
  });

  it("gives every provider a DEFAULT its own gate accepts", () => {
    // `DEFAULT_EMBEDDING_MODELS` (embeddings.ts) and the catalog (providers.ts)
    // are two tables with no compile-time link. If the workers-ai default ever
    // left the catalog, `resolveEmbeddingModelName` would return a value its own
    // predicate refuses — the fallback would be a model the gate would never let
    // an owner choose — and `WORKERS_AI_EMBEDDING_DIMENSIONS[model]` would come
    // back `undefined`, making the dimension check silently skip. The default is
    // read the only way this suite can reach it: through the resolver itself,
    // with no override set.
    const defaults: Record<string, string> = {};
    for (const provider of EMBEDDING_PROVIDERS) {
      delete process.env.EMBEDDING_MODEL;
      process.env.EMBEDDING_PROVIDER = provider;
      // Credentials/transport, so the provider actually resolves.
      process.env.OPENAI_API_KEY = "sk-openai";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";
      mockWorkersAi([workersVector(0.1)]);

      const model = getEmbeddingModelName();
      expect(model).not.toBeNull();
      defaults[provider] = model!;
      expect(embeddingModelMatchesProvider(provider, model!)).toBe(true);
    }

    // Named explicitly for the one leg that is a catalog: the Workers AI default
    // must be a KEY of the dimensions table, so the width check has a number to
    // compare against rather than `undefined`.
    expect(isWorkersAiEmbeddingModel(defaults["workers-ai"])).toBe(true);
    expect(CATALOG_FROM_PROVIDERS[defaults["workers-ai"]]).toBeGreaterThan(0);
  });

  it("honours a PADDED stored id — the gate reads it trimmed, so this must too", async () => {
    // DW-221: the gate tests `" @cf/baai/bge-m3".trim()` and lets the owner turn
    // vector search on; the resolver used to test the RAW string, fail, and
    // embed with the default. Same string on both sides now — and no warning,
    // because nothing was dropped.
    mockLoadConfigSync.mockReturnValue({ embeddingModel: " @cf/baai/bge-m3 " });
    const run = mockWorkersAi([workersVector(0.5)]);

    const { result, warnings } = await withWarnSpy(async () => {
      const name = getEmbeddingModelName();
      await embedText("hi");
      return name;
    });

    expect(result).toBe("@cf/baai/bge-m3");
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
    expect(warnings).toEqual([]);
  });

  it("treats a whitespace-only EMBEDDING_MODEL as UNSET, never as a model name", async () => {
    // DW-227: `" "` is truthy, so it used to be handed to the provider verbatim
    // as the model name — while the vector gate read the very same variable as
    // absent.
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_MODEL = "   ";

    const { result, warnings } = await withWarnSpy(() => getEmbeddingModelName());

    expect(result).toBe("text-embedding-3-small");
    // Unset is not a mismatch: nothing was dropped, so nothing is warned about.
    expect(warnings).toEqual([]);
  });

  it("lets a stored id win over a whitespace-only env override", () => {
    // The same ordering `getVectorSearchSettings` applies: `nonEmpty(env) ??
    // nonEmpty(config)`. A blank env var must not shadow the stored choice.
    process.env.EMBEDDING_PROVIDER = "ollama";
    process.env.EMBEDDING_MODEL = " ";
    mockLoadConfigSync.mockReturnValue({ embeddingModel: "mxbai-embed-large" });

    expect(getEmbeddingModelName()).toBe("mxbai-embed-large");
  });

  it("keeps env winning over a stored id when the env var is really set", () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    process.env.EMBEDDING_MODEL = "nomic-embed-text";
    mockLoadConfigSync.mockReturnValue({ embeddingModel: "mxbai-embed-large" });

    expect(getEmbeddingModelName()).toBe("nomic-embed-text");
  });

  it("WARNS once on getEmbeddingModelName when the override is dropped", async () => {
    // DW-226/224: the substitution used to be completely silent, where its
    // sibling `resolveEmbeddingProvider` has always warned.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    mockWorkersAi([workersVector(0.5)]);

    const { result, warnings } = await withWarnSpy(() => getEmbeddingModelName());

    expect(result).toBe("@cf/baai/bge-m3");
    expect(warnings).toHaveLength(1);
    // Both ids are named — the dropped one and the one actually used.
    expect(warnings[0]).toContain("text-embedding-3-small");
    expect(warnings[0]).toContain("@cf/baai/bge-m3");
    expect(warnings[0]).toContain("workers-ai");
  });

  it("WARNS on the embed path itself — embedText and embedTexts", async () => {
    // The gate never runs here: an env override bypasses the store entirely.
    // This is the path DW-224 is about — the logs are the only place the
    // substitution can show up.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    const runSingle = mockWorkersAi([workersVector(0.5)]);

    const single = await withWarnSpy(() => embedText("hi"));
    expect(runSingle).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
    expect(single.warnings).toHaveLength(1);
    expect(single.warnings[0]).toContain("text-embedding-3-small");

    // A DIFFERENT dropped id, so `embedTexts` faces a fresh misconfiguration
    // identity rather than the one the guard has already spoken for. This keeps
    // the assertion about the embedTexts door warning on its own key — no
    // test-only reset lever in the middle of it. (Throttling of the SAME key
    // across doors is asserted by "SAYS the mismatch ONCE across every embed
    // door" below.)
    process.env.EMBEDDING_MODEL = "gemini-embedding-001";
    const runBatch = mockWorkersAi([workersVector(0.5), workersVector(0.6)]);
    const batch = await withWarnSpy(() => embedTexts(["a", "b"]));
    expect(runBatch).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["a", "b"],
      pooling: "cls",
    });
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings[0]).toContain("gemini-embedding-001");
    expect(batch.warnings[0]).toContain("@cf/baai/bge-m3");
  });

  it("WARNS on the AI-SDK leg too, where getEmbeddingModel builds the model", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3";

    const { result, warnings } = await withWarnSpy(() => getEmbeddingModel());

    expect(result).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@cf/baai/bge-m3");
    expect(warnings[0]).toContain("text-embedding-3-small");
  });

  it("stays SILENT when the override is honoured", async () => {
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
    mockWorkersAi([workersVector(0.5)]);

    const { warnings } = await withWarnSpy(async () => {
      getEmbeddingModelName();
      await embedText("hi");
    });

    expect(warnings).toEqual([]);
  });

  it("is a LOG, not a behaviour change — the default is still returned", async () => {
    // Silencing the logger must not alter what gets embedded.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "@cf/";
    const run = mockWorkersAi([workersVector(0.5)]);

    const { result } = await withWarnSpy(() => embedText("hi"));

    expect(result).toHaveLength(1024);
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
  });
});

// ---------------------------------------------------------------------------
// Once per DISTINCT misconfiguration, not once per call (DW-273 / DW-278)
// ---------------------------------------------------------------------------

describe("misconfiguration warnings are said once", () => {
  it("SAYS the mismatch ONCE across every embed door", async () => {
    // DW-273: each door re-enters the resolver, so the same sentence used to be
    // logged once per door — and ~2N times for an N-page rebuild.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    mockWorkersAi([workersVector(0.5)]);

    const { result, warnings } = await withWarnSpy(async () => {
      const name = getEmbeddingModelName();
      await embedText("hi");
      mockWorkersAi([workersVector(0.5), workersVector(0.6)]);
      await embedTexts(["a", "b"]);
      return name;
    });

    expect(warnings).toHaveLength(1);
    // ...and it is the RIGHT sentence. A count alone would be satisfied by a
    // wrong-but-single warning, so the dropped id, the provider, and the model
    // actually used are all named.
    expect(warnings[0]).toContain("text-embedding-3-small");
    expect(warnings[0]).toContain("workers-ai");
    expect(warnings[0]).toContain("@cf/baai/bge-m3");
    // Suppression is of repetition only — every call still resolved.
    expect(result).toBe("@cf/baai/bge-m3");
    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");
  });

  it("SPEAKS again when the override CHANGES", async () => {
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    mockWorkersAi([workersVector(0.5)]);

    const { warnings } = await withWarnSpy(() => {
      getEmbeddingModelName();
      process.env.EMBEDDING_MODEL = "@cf/nope";
      getEmbeddingModelName();
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("text-embedding-3-small");
    expect(warnings[1]).toContain("@cf/nope");
  });

  it("keys on the PROVIDER too — one model id rejected by two providers warns twice", async () => {
    // The key is the misconfiguration's identity, and "@cf/baai/bge-m3 under
    // openai" is a different fact from "@cf/baai/bge-m3 under ollama".
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3";

    const { warnings } = await withWarnSpy(() => {
      process.env.EMBEDDING_PROVIDER = "openai";
      getEmbeddingModelName();
      process.env.EMBEDDING_PROVIDER = "ollama";
      getEmbeddingModelName();
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("openai");
    expect(warnings[1]).toContain("ollama");
  });

  it("SAYS an invalid EMBEDDING_PROVIDER ONCE, and still refuses both times", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_PROVIDER = "deepseek";

    const { result, warnings } = await withWarnSpy(() => [
      getEmbeddingModelName(),
      getEmbeddingModelName(),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deepseek");
    // The refusal is unchanged — it does NOT fall through to the openai key.
    expect(result).toEqual([null, null]);
  });

  it("SPEAKS again when the invalid provider override CHANGES", async () => {
    process.env.EMBEDDING_PROVIDER = "deepseek";

    const { warnings } = await withWarnSpy(() => {
      getEmbeddingModelName();
      process.env.EMBEDDING_PROVIDER = "bogus";
      getEmbeddingModelName();
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("deepseek");
    expect(warnings[1]).toContain("bogus");
  });

  it("SAYS the unbound Workers AI binding ONCE across repeated calls", async () => {
    // DW-278: `GET`/`PUT /api/settings` call this unconditionally once per
    // request, so an unbound deployment logged a line per request.
    mockGetCfContext.mockReturnValue({ env: {} });

    const { result, warnings } = await withWarnSpy(() => [
      getWorkersAiBinding(),
      getWorkersAiBinding(),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AI binding is not bound");
    // Both callers still see "no binding" — `hasWorkersAiBinding === false`.
    expect(result).toEqual([null, null]);
  });

  it("stays silent OFF the Workers runtime without consuming the binding key", async () => {
    // The off-Workers `catch` returns before the guard, so a local run cannot
    // spend the one warning a real Workers miss is owed.
    //
    // TWO spy windows, deliberately. A single window asserting "one warning
    // total" cannot fail: if the `catch` DID warn, the guard would mute the
    // real miss that follows and the window would still see exactly one line
    // with exactly this text. Only a window that ends before the runtime
    // changes can say the off-Workers path was silent.
    const off = await withWarnSpy(() => getWorkersAiBinding());
    expect(off.result).toBeNull();
    expect(off.warnings).toEqual([]);

    // Now on the Workers runtime with `AI` absent — the key is still unspent.
    mockGetCfContext.mockReturnValue({ env: {} });
    const on = await withWarnSpy(() => getWorkersAiBinding());
    expect(on.result).toBeNull();
    expect(on.warnings).toHaveLength(1);
    expect(on.warnings[0]).toContain("AI binding is not bound");
  });

  it("keeps DIFFERENT misconfiguration families from spending each other's warning", async () => {
    // One `Set`, three key namespaces: an unbound binding and a model mismatch
    // are separate facts standing at the same time, and each is owed its own
    // line. Cross-suppression here would silently drop half the diagnosis.
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3"; // openai cannot serve it
    mockGetCfContext.mockReturnValue({ env: {} }); // on Workers, AI unbound

    const { warnings } = await withWarnSpy(() => {
      expect(getWorkersAiBinding()).toBeNull();
      expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
      // Repeats of BOTH families stay silent.
      expect(getWorkersAiBinding()).toBeNull();
      expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
    });

    expect(warnings).toHaveLength(2);
    expect(warnings.filter((w) => w.includes("AI binding is not bound"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("cannot be served by"))).toHaveLength(1);
  });

  it("throttles a mismatch that arrives from the STORE, not just from env", async () => {
    // This is the path `/api/settings` actually writes: `cfg.embeddingModel`,
    // with no env var in sight. It reaches the same guard through the same key.
    mockLoadConfigSync.mockReturnValue({
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    mockWorkersAi([workersVector(0.5)]);

    const first = await withWarnSpy(() => [
      getEmbeddingModelName(),
      getEmbeddingModelName(),
    ]);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("text-embedding-3-small");
    expect(first.result).toEqual(["@cf/baai/bge-m3", "@cf/baai/bge-m3"]);

    // Changing the STORED id is a new identity and speaks again.
    mockLoadConfigSync.mockReturnValue({
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/nope",
    });
    const second = await withWarnSpy(() => getEmbeddingModelName());
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain("@cf/nope");
    expect(second.result).toBe("@cf/baai/bge-m3");
  });

  it("throttles a STORED invalid embedding provider, and speaks again when it changes", async () => {
    // `cfg.embeddingProvider` is the other stored leg of the same override.
    process.env.OPENAI_API_KEY = "sk-openai";
    mockLoadConfigSync.mockReturnValue({ embeddingProvider: "deepseek" });

    const first = await withWarnSpy(() => [
      getEmbeddingModelName(),
      getEmbeddingModelName(),
    ]);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("deepseek");
    // Still refused both times — it does NOT fall through to the openai key.
    expect(first.result).toEqual([null, null]);

    mockLoadConfigSync.mockReturnValue({ embeddingProvider: "bogus" });
    const second = await withWarnSpy(() => getEmbeddingModelName());
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain("bogus");
    expect(second.result).toBeNull();
  });

  it("names the ENV as the source of a bad provider override, with the remedy it has", async () => {
    // DW-311. The env sentence is unchanged: this deployment DOES have an
    // `EMBEDDING_PROVIDER` set, and unsetting it is a thing the owner can do.
    process.env.EMBEDDING_PROVIDER = "deepseek";

    const { result, warnings } = await withWarnSpy(() => getEmbeddingModelName());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EMBEDDING_PROVIDER="deepseek"');
    expect(warnings[0]).toContain("unset it to auto-detect");
    expect(result).toBeNull();
  });

  it("names SETTINGS as the source of a bad STORED provider, and never a variable", async () => {
    // DW-311's actual bug. `EMBEDDING_PROVIDER` was hardcoded into the sentence
    // whatever the value's origin, so an owner who chose the provider in
    // Settings — and who has no such variable anywhere — was told to unset one.
    // Since DW-273 the line is said exactly ONCE, so that may be the only thing
    // they ever read about it.
    mockLoadConfigSync.mockReturnValue({ embeddingProvider: "deepseek" });

    const { result, warnings } = await withWarnSpy(() => getEmbeddingModelName());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deepseek");
    expect(warnings[0]).toContain("Settings");
    expect(warnings[0]).not.toContain("EMBEDDING_PROVIDER");
    expect(warnings[0]).not.toContain("unset");
    // The refusal itself is untouched — only the sentence learned where the
    // value came from.
    expect(result).toBeNull();
  });

  it("treats the SAME bad value from the two sources as TWO identities", async () => {
    // The key carries the source because the two sentences carry different
    // REMEDIES. Keyed on the string alone, whichever arrived first would
    // silence the other's remedy for the life of the process — and the one
    // silenced is the one the owner can actually act on.
    mockLoadConfigSync.mockReturnValue({ embeddingProvider: "deepseek" });
    const stored = await withWarnSpy(() => getEmbeddingModelName());
    expect(stored.warnings).toHaveLength(1);
    expect(stored.warnings[0]).toContain("Settings");

    process.env.EMBEDDING_PROVIDER = "deepseek";
    const env = await withWarnSpy(() => getEmbeddingModelName());
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]).toContain('EMBEDDING_PROVIDER="deepseek"');
    // Two DIFFERENT sentences, and both were heard.
    expect(env.warnings[0]).not.toBe(stored.warnings[0]);
    // …and each is still throttled within its own identity.
    const again = await withWarnSpy(() => getEmbeddingModelName());
    expect(again.warnings).toEqual([]);
    expect(again.result).toBeNull();
  });

  it("is a LOG-only change — the SUPPRESSED call embeds identically", async () => {
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";

    await withWarnSpy(async () => {
      const first = mockWorkersAi([workersVector(0.5)]);
      await embedText("hi");
      expect(first).toHaveBeenCalledWith("@cf/baai/bge-m3", {
        text: ["hi"],
        pooling: "cls",
      });
    });

    // Second call: warning suppressed, behaviour identical.
    const second = mockWorkersAi([workersVector(0.5)]);
    const { result, warnings } = await withWarnSpy(() => embedText("hi"));

    expect(warnings).toEqual([]);
    expect(result).toHaveLength(1024);
    expect(second).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["hi"],
      pooling: "cls",
    });
  });
});

// ---------------------------------------------------------------------------
// Embedding provider decoupled from the LLM provider
// ---------------------------------------------------------------------------

describe("embedding/LLM provider decoupling", () => {
  it("keeps the saved embedding-capable provider when multiple API keys exist", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";
    mockLoadConfigSync.mockReturnValue({ provider: "google" });

    expect(getEmbeddingModelName()).toBe("gemini-embedding-001");
  });

  it("finds an embedding provider when the saved generation provider cannot embed", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";
    mockLoadConfigSync.mockReturnValue({ provider: "ollama-cloud" });

    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
  });

  it("uses the embedding provider's own key when the LLM provider differs", () => {
    // LLM generation on deepseek (no embeddings), embeddings on openai.
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.EMBEDDING_PROVIDER = "openai";

    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
    // A real AI SDK model is constructed (the openai key path works).
    expect(getEmbeddingModel()).not.toBeNull();
  });

  it("rejects an invalid EMBEDDING_PROVIDER override without falling through", () => {
    // A capable LLM provider is present and would otherwise be selected...
    process.env.OPENAI_API_KEY = "sk-openai";
    // ...but an unsupported explicit override disables embeddings entirely.
    process.env.EMBEDDING_PROVIDER = "anthropic";

    expect(getEmbeddingModelName()).toBeNull();
    expect(getEmbeddingModel()).toBeNull();
    expect(hasEmbeddingSupport()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One resolution, one snapshot — the `cfg` door (DW-313)
// ---------------------------------------------------------------------------

describe("the optional `cfg` door resolves against the snapshot it is given", () => {
  // `loadConfigSync()` is a 5 s-TTL cache, so "read it again" and "read it once
  // and pass it along" are only the same answer while the cache happens not to
  // turn over between the two reads. Every case below makes the PASSED snapshot
  // disagree with what the cache would answer, which is the only way to tell a
  // threaded `cfg` from a decorative one — a resolver that accepted the
  // parameter and then ignored it would satisfy any test where the two agree.
  const CACHED = { embeddingProvider: "openai" } as const;
  const PASSED = {
    embeddingProvider: "openai",
    embeddingApiKey: "sk-passed-in",
    embeddingModel: "text-embedding-3-large",
  } as const;

  it("follows the ARGUMENT, through the provider, the KEY and the model legs", () => {
    // The cache holds a provider with no credential anywhere, so it resolves to
    // nothing at all.
    mockLoadConfigSync.mockReturnValue({ ...CACHED });

    // The passed snapshot carries the stored key, and that is the ONLY place it
    // exists — no `OPENAI_API_KEY` is set. So an answer of anything but `null`
    // proves `embeddingApiKeyFor` read the argument rather than re-entering the
    // cache, which is the private leg the two public doors traverse.
    expect(getEmbeddingModelName(PASSED)).toBe("text-embedding-3-large");
    expect(hasEmbeddingSupport(PASSED)).toBe(true);

    // …and the model name came from the argument too: the cache's snapshot has
    // no `embeddingModel`, so a resolver reading it would have answered the
    // provider default instead.
    expect(getEmbeddingModelName(PASSED)).not.toBe("text-embedding-3-small");
  });

  it("does not touch the cache AT ALL when a snapshot is passed", () => {
    // The strongest form of the claim: not "it agreed with the argument" but
    // "it never asked". A single stray `loadConfigSync()` anywhere down the
    // path is what DW-313 is about, and it is invisible whenever the two
    // snapshots happen to match.
    mockLoadConfigSync.mockReturnValue({ ...CACHED });
    mockLoadConfigSync.mockClear();

    expect(getEmbeddingModelName(PASSED)).toBe("text-embedding-3-large");
    expect(hasEmbeddingSupport(PASSED)).toBe(true);

    expect(mockLoadConfigSync).not.toHaveBeenCalled();
  });

  it("still reads the CACHE when nothing is passed — the default is unchanged", () => {
    // The other half of the spec's claim. The parameter exists for the two
    // settings resolvers; every other caller wants "resolve against whatever is
    // current", and passing nothing has to stay byte-identical to the behaviour
    // before the parameter existed.
    mockLoadConfigSync.mockReturnValue({ ...CACHED });
    expect(getEmbeddingModelName()).toBeNull();
    expect(hasEmbeddingSupport()).toBe(false);
    expect(mockLoadConfigSync).toHaveBeenCalled();

    // Move the cache and the bare doors move with it.
    mockLoadConfigSync.mockReturnValue({ ...PASSED });
    expect(getEmbeddingModelName()).toBe("text-embedding-3-large");
    expect(hasEmbeddingSupport()).toBe(true);
  });
});
