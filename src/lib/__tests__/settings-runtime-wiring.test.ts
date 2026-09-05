/**
 * Story 1.9 — the three places a STORED setting becomes runtime behaviour.
 *
 * The settings surface and its route are covered by `workbench-settings.test.ts`;
 * this file covers the other end of the same wire, which is where the story is
 * most easily reverted without anything noticing:
 *
 *  - the `custom` provider is CONSTRUCTED (OpenAI-compatible endpoint, and
 *    `.chat()` rather than the Responses API), and refuses with a sentence when
 *    a half is missing rather than sending a request for a model called
 *    "custom";
 *  - the configured LLM timeout REACHES `generateText`/`streamText`, per
 *    attempt, and is absent entirely when unset;
 *  - the stored embedding credential and endpoint are actually READ, so
 *    "vector search needs an endpoint, a model and a key" does not store three
 *    values no code path can use.
 *
 * Every provider SDK and the `ai` module are mocked, so nothing here opens a
 * socket — the same technique (and the same reason) as `llm-deepseek.test.ts`,
 * which exists to catch exactly this class of regression for DeepSeek.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const {
  createOpenAIMock,
  createGoogleMock,
  createOllamaMock,
  generateTextMock,
  streamTextMock,
} = vi.hoisted(() => {
  /**
   * Callable (the Responses API) AND `.chat()` (Chat Completions) AND
   * `.embedding()`. An OpenAI-compatible endpoint generally does not implement
   * `/responses`, so which one the code reaches for is the assertion.
   */
  const provider = () =>
    Object.assign((id: string) => ({ id, api: "responses" }), {
      chat: vi.fn((id: string) => ({ id, api: "chat" })),
      embedding: vi.fn((id: string) => ({ id, api: "embedding" })),
    });
  return {
    createOpenAIMock: vi.fn(provider),
    createGoogleMock: vi.fn(provider),
    createOllamaMock: vi.fn(provider),
    generateTextMock: vi.fn(async () => ({ text: "ok" })),
    streamTextMock: vi.fn(() => ({ toTextStreamResponse: vi.fn() })),
  };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: createGoogleMock }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn(() => vi.fn()) }));
vi.mock("ollama-ai-provider-v2", () => ({ createOllama: createOllamaMock }));
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  embed: vi.fn(async () => ({ embedding: [0.1] })),
  embedMany: vi.fn(async () => ({ embeddings: [[0.1]] })),
}));
// The Cloudflare context `embeddings.ts` reads for the Workers AI binding. The
// default THROWS, which is precisely what the real one does off the Workers
// runtime — so every case in this file that was written without it behaves
// exactly as before, and the Workers AI case opts in by handing back a binding.
// Restored in `beforeEach`, because `clearAllMocks` keeps implementations.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => {
    throw new Error("no cloudflare context");
  }),
}));
/**
 * The route's owner gate. There is no Clerk session in a node suite, and what
 * the one route case below is about is what the route does WITH a principal;
 * ownership itself stays real, driven by `NEXT_PUBLIC_OWNER_HANDLE`.
 */
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "user_1", handle: "owner" })),
}));

import {
  _resetConfigCache,
  _resetConfigWarnings,
  apiKeyForProvider,
  getChatModelSettings,
  getEffectiveProvider,
  getEffectiveSettings,
  getFirecrawlSettings,
  getVectorSearchSettings,
  getWorkbenchSettings,
  llmTimeoutOption,
  loadConfig,
  saveConfig,
  workbenchSettingsStored,
  type AppConfig,
} from "../config";
import {
  _resetEmbeddingWarnings,
  getEmbeddingModel,
  getEmbeddingModelName,
  hasEmbeddingSupport,
} from "../embeddings";
import { logger } from "../logger";
import {
  callLLM,
  callLLMStream,
  callVisionLLM,
  getConfiguredModel,
  hasLLMKey,
} from "../llm";
import { _resetStorage, getStorage, hasVectorizeBinding } from "../storage";
import {
  SETTINGS_VECTOR_BINDING_ENV_NOTE,
  canEnableVectorSearch,
  draftVectorInputs,
  resolveEnvEmbeddingProvider,
  settingsDraftFromPayload,
  vectorSearchFieldIssue,
  vectorSearchMissingCopy,
} from "../workbench-settings";
import { readConfig } from "../config";
import { IF_MATCH_HEADER, formatIfMatch } from "../write-precondition";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const mockGetCfContext = getCloudflareContext as ReturnType<typeof vi.fn>;

/** Off the Workers runtime, which is where every case here runs by default. */
function noCloudflareContext(): never {
  throw new Error("no cloudflare context");
}

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "DATA_DIR",
  "NEXT_PUBLIC_OWNER_HANDLE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_MODEL",
  "LLM_CUSTOM_API_KEY",
  "LLM_CUSTOM_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_PROVIDER",
  "STORAGE_PROVIDER",
  // Capture's optional credential (DW-66). Cleared per case for the same reason
  // as the rest: a value exported in a developer's shell would decide whether
  // the Firecrawl key row below reports an env credential.
  "FIRECRAWL_API_KEY",
  // Deep Research (AD-18). Cleared per case for the same reason as the rest: a
  // value exported in a developer's shell would decide the provider the
  // research cases below are asserting.
  "RESEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "SERPAPI_API_KEY",
  "SERPAPI_ENGINE",
  "SEARXNG_BASE_URL",
  "SEARXNG_CATEGORIES",
];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-runtime-"));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DATA_DIR = tmpDir;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = "owner";
  vi.clearAllMocks();
  // `clearAllMocks` keeps implementations, but the nested `chat`/`embedding`
  // spies are created per call, so re-assert the factories to be safe.
  const provider = () =>
    Object.assign((id: string) => ({ id, api: "responses" }), {
      chat: vi.fn((id: string) => ({ id, api: "chat" })),
      embedding: vi.fn((id: string) => ({ id, api: "embedding" })),
    });
  createOpenAIMock.mockImplementation(provider);
  createGoogleMock.mockImplementation(provider);
  createOllamaMock.mockImplementation(provider);
  generateTextMock.mockImplementation(async () => ({ text: "ok" }));
  mockGetCfContext.mockImplementation(noCloudflareContext);
  _resetConfigCache();
  // The warn-once Sets are module state, so without these the FIRST case to hit
  // a misconfiguration silences it for every case after — and the next
  // assertion added here would be quietly order-sensitive. Same reason
  // `_resetEmbeddingWarnings` is already reset per case in the suites that
  // assert embedding warnings.
  _resetConfigWarnings();
  _resetEmbeddingWarnings();
  _resetStorage();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetConfigCache();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function store(config: AppConfig): Promise<void> {
  await saveConfig(config);
  _resetConfigCache();
  await loadConfig();
}

/**
 * A `PUT /api/settings` turning the vector switch on, carrying the write
 * precondition the store currently holds (DW-63).
 */
async function turnVectorSearchOn(): Promise<Request> {
  const read = await readConfig();
  if (read.status !== "ok") throw new Error("store is unreadable");
  return new Request("http://local/api/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      [IF_MATCH_HEADER]: formatIfMatch(read.version),
    },
    body: JSON.stringify({ workbench: { vectorSearchEnabled: true } }),
  });
}

/** The options object the last `generateText` call was given. */
function lastGenerateArgs(): Record<string, unknown> {
  const call = generateTextMock.mock.calls.at(-1) as unknown as [Record<string, unknown>];
  return call[0];
}

// ---------------------------------------------------------------------------
// The `custom` provider
// ---------------------------------------------------------------------------

const CUSTOM: AppConfig = {
  provider: "custom",
  model: "my-model",
  customApiKey: "sk-custom",
  customBaseUrl: "https://api.example/v1",
};

describe("the custom provider is visible to the gates every LLM feature asks", () => {
  it("makes hasLLMKey() true only when BOTH halves are present", async () => {
    // Every LLM feature in this repo — Chat, the query stream, ingest, lint,
    // vision, search — is behind `hasLLMKey()`. A `custom` deployment it does
    // not recognise reports itself configured and then silently skips all of
    // them, which is the silently-inert save the `custom` branch exists to
    // prevent.
    await store(CUSTOM);
    expect(await hasLLMKey()).toBe(true);

    await store({ provider: "custom", customApiKey: "sk-custom" });
    expect(await hasLLMKey()).toBe(false);

    await store({ provider: "custom", customBaseUrl: "https://api.example/v1" });
    expect(await hasLLMKey()).toBe(false);
  });

  it("does not report the literal string 'custom' as the active model", async () => {
    // `DEFAULT_MODELS.custom` is absent on purpose, so a `?? provider` fallback
    // would advertise a model named "custom" through /api/status and hand the
    // same string to the workload resolvers as an inherited model.
    await store({ provider: "custom", customApiKey: "s", customBaseUrl: "https://a/v1" });
    expect(getEffectiveProvider()).toMatchObject({
      // …and NOT configured, because there is no model to call with (DW-403).
      // Both credential halves are here, which is all `providerIsConfigured`
      // asks — but `getConfiguredModel` has nothing to construct from a
      // `null` model, so reporting readiness here promised a call that cannot
      // be made. This case used to assert `true`, which is the defect.
      configured: false,
      provider: "custom",
      model: null,
    });
    expect(getChatModelSettings().model).toBeNull();
  });

  it("attributes a STORED custom key to the config, not to the environment", async () => {
    await store(CUSTOM);
    expect(getEffectiveSettings()).toMatchObject({
      hasApiKey: true,
      apiKeySource: "config",
    });

    process.env.LLM_CUSTOM_API_KEY = "sk-env";
    _resetConfigCache();
    await loadConfig();
    expect(getEffectiveSettings().apiKeySource).toBe("env");
  });

  it("does not let an empty env var mask a stored credential", async () => {
    // `LLM_CUSTOM_API_KEY=""` is set-but-empty. A `??` chain hands back `""`,
    // which reads as a credential to the "is it configured" checks and as
    // missing to `getModel()` — configured everywhere, refusing at call time.
    process.env.LLM_CUSTOM_API_KEY = "";
    process.env.LLM_CUSTOM_BASE_URL = "";
    await store(CUSTOM);

    expect(await hasLLMKey()).toBe(true);
    await callLLM("system", "message");
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
  });
});

describe("the custom provider reaches the runtime", () => {
  it("builds it through createOpenAI at the owner's base URL, via Chat Completions", async () => {
    await store(CUSTOM);

    await callLLM("system", "message");

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
    // `.chat()`, NOT the default callable: the provider's default targets
    // OpenAI's Responses API (`/responses`), which an OpenAI-COMPATIBLE server
    // generally does not implement. Same assertion, same reason, as the
    // DeepSeek sibling.
    const provider = createOpenAIMock.mock.results[0].value;
    expect(provider.chat).toHaveBeenCalledWith("my-model");
  });

  it("prefers the env credential over the stored one", async () => {
    process.env.LLM_CUSTOM_API_KEY = "sk-env";
    await store(CUSTOM);

    await callLLM("system", "message");

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-env",
      baseURL: "https://api.example/v1",
    });
  });

  it("names the missing half instead of constructing a broken model", async () => {
    await store({ provider: "custom", model: "my-model", customApiKey: "sk-custom" });
    await expect(callLLM("s", "m")).rejects.toThrow(/needs a base URL/);

    await store({ provider: "custom", model: "my-model", customBaseUrl: "https://e/v1" });
    await expect(callLLM("s", "m")).rejects.toThrow(/needs an API key/);

    expect(createOpenAIMock).not.toHaveBeenCalled();
  });

  it("refuses rather than requesting a model literally called `custom`", async () => {
    // `DEFAULT_MODELS.custom` is deliberately absent, and the resolver's
    // `?? provider` fallback would otherwise send the provider's own NAME as a
    // model id to a server that has never heard of it.
    await store({
      provider: "custom",
      customApiKey: "sk-custom",
      customBaseUrl: "https://api.example/v1",
    });

    await expect(callLLM("s", "m")).rejects.toThrow(/needs a model name/);
    expect(createOpenAIMock).not.toHaveBeenCalled();
  });

  it("builds it the same way through getConfiguredModel", async () => {
    await store(CUSTOM);

    await getConfiguredModel({ provider: "custom", model: "another-model" });

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
    expect(createOpenAIMock.mock.results[0].value.chat).toHaveBeenCalledWith(
      "another-model",
    );
  });

  it("routes a workload to its own provider and model, leaving the other inheriting", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    await store({
      provider: "openai",
      model: "gpt-4o",
      chatProvider: "custom",
      chatModel: "chat-model",
      customApiKey: "sk-custom",
      customBaseUrl: "https://api.example/v1",
    });

    await getConfiguredModel({ workload: "chat" });
    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });

    // Ingest was never configured, so it inherits the primary route — no
    // baseURL, and the default callable rather than `.chat()`.
    createOpenAIMock.mockClear();
    await getConfiguredModel({ workload: "ingest" });
    expect(createOpenAIMock).toHaveBeenLastCalledWith({ apiKey: "sk-openai" });
  });
});

// ---------------------------------------------------------------------------
// One config generation per model client (DW-618)
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a clock that advances 10 minutes per read AFTER the first: the
 * first read answers the real `t0`, and every read after it is another 10
 * minutes on. That is enough — the entry `loadConfig()` stamps is written from
 * one read and can only be checked by a LATER one, so it is always past the 5 s
 * TTL by the time anything could answer from it.
 *
 * The DW-334 idiom in `config.test.ts` counts `loadConfigSync` entries with a
 * frozen clock; that cannot be used here, because the code under test awaits
 * `loadConfig()` itself and would freeze its own priming write into the count.
 * An always-advancing clock asks the question the other way round: code that
 * threads its snapshot never re-enters the cache and is unaffected, while code
 * that re-enters gets the cold-cache `{}` and refuses. The straddle is
 * otherwise invisible — it needs the cache to expire between two resolvers,
 * which no real-time test can arrange.
 *
 * Safe because `loadConfig()`'s read path makes exactly one clock call
 * (`config.ts`'s cache write); the only other `Date.now()` reachable from here
 * is in the filesystem provider's WRITE lock loop, which no case below enters.
 */
async function underAnExpiringCache<T>(fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  let n = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => t0 + n++ * 600_000);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

describe("one model client is built out of one config generation", () => {
  it("builds a workload-routed custom client from the snapshot the door already holds", async () => {
    // The workload branch reads FOUR resolvers — the workload settings, the
    // key, the base URL and (on the primary fallthrough) the credentials — and
    // used to enter the cache once per resolver. On a straddle the later legs
    // answered from `{}`, so a correctly configured endpoint refused with
    // "needs a base URL" halfway through building one client.
    process.env.OPENAI_API_KEY = "sk-openai";
    await store({
      provider: "openai",
      model: "gpt-4o",
      chatProvider: "custom",
      chatModel: "chat-model",
      customApiKey: "sk-custom",
      customBaseUrl: "https://api.example/v1",
    });

    await underAnExpiringCache(() => getConfiguredModel({ workload: "chat" }));

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
    expect(createOpenAIMock.mock.results.at(-1)!.value.chat).toHaveBeenCalledWith(
      "chat-model",
    );
  });

  it("builds an ingest-routed client from that generation too", async () => {
    // The chat case alone leaves `getIngestModelSettings(cfg)` unpinned: the
    // one existing ingest case runs on a warm cache, so reverting that
    // argument would stay green.
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    await store({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      ingestProvider: "custom",
      ingestModel: "ingest-model",
      customApiKey: "sk-custom",
      customBaseUrl: "https://api.example/v1",
    });

    await underAnExpiringCache(() => getConfiguredModel({ workload: "ingest" }));

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
    expect(createOpenAIMock.mock.results.at(-1)!.value.chat).toHaveBeenCalledWith(
      "ingest-model",
    );
  });

  it("carries a workload-routed Ollama endpoint across the same expiry", async () => {
    // `getOllamaBaseUrl` is the other store-backed leg of that branch: a
    // re-entry here dropped the owner's endpoint and pointed chat at localhost.
    await store({
      provider: "anthropic",
      chatProvider: "ollama",
      chatModel: "llama3",
      ollamaBaseUrl: "http://ollama.internal:11434",
    });

    await underAnExpiringCache(() => getConfiguredModel({ workload: "chat" }));

    expect(createOllamaMock).toHaveBeenLastCalledWith({
      baseURL: "http://ollama.internal:11434",
    });
  });

  it("builds the primary custom client from that one generation too", async () => {
    await store(CUSTOM);

    await underAnExpiringCache(() => getConfiguredModel());

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
    expect(createOpenAIMock.mock.results.at(-1)!.value.chat).toHaveBeenCalledWith(
      "my-model",
    );
  });

  it("does the same for callLLM, which discarded the identical snapshot", async () => {
    await store(CUSTOM);

    await underAnExpiringCache(() => callLLM("system", "message"));

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
  });

  it("does the same for callLLMStream", async () => {
    await store(CUSTOM);

    await underAnExpiringCache(async () => {
      await callLLMStream("system", "message");
    });

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
  });

  it("does the same for callVisionLLM", async () => {
    await store(CUSTOM);

    await underAnExpiringCache(() =>
      callVisionLLM("describe", new Uint8Array([1, 2, 3])),
    );

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
  });

  it("builds an EXPLICIT provider/model client from that generation", async () => {
    // The production-reachable shape: nothing in `src/` passes `workload`, but
    // `agent-runtime.ts` and `structured-knowledge.ts` both call this with an
    // explicit `{provider, model}` — so this is the branch a real deployment
    // straddles, and it reads the key and the base URL as two resolvers.
    await store(CUSTOM);

    await underAnExpiringCache(() =>
      getConfiguredModel({ provider: "custom", model: "explicit-model" }),
    );

    expect(createOpenAIMock).toHaveBeenLastCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://api.example/v1",
    });
    expect(createOpenAIMock.mock.results.at(-1)!.value.chat).toHaveBeenCalledWith(
      "explicit-model",
    );
  });

  it("does not turn an UNREADABLE store into a refusal while the cache is warm", async () => {
    // `loadConfig()` answers `{}` for an unreadable store as well as for an
    // absent one, and on that branch it does NOT prime the cache — the previous
    // generation is still warm. Threading that `{}` would refuse a working
    // store-only deployment for the whole 5 s window at the doors that are not
    // behind `hasLLMKey()` (`/api/settings/test`, `agent-runtime`,
    // `structured-knowledge`, `source-monitors`), which is a behaviour change,
    // not the threading this bundle authorises. `configSnapshot()` is what
    // keeps an empty answer unthreaded.
    await store(CUSTOM);
    const read = vi
      .spyOn(getStorage(), "readFileWithEtag")
      .mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
    try {
      await callLLM("system", "message");
      expect(createOpenAIMock).toHaveBeenLastCalledWith({
        apiKey: "sk-custom",
        baseURL: "https://api.example/v1",
      });

      createOpenAIMock.mockClear();
      await getConfiguredModel();
      expect(createOpenAIMock).toHaveBeenLastCalledWith({
        apiKey: "sk-custom",
        baseURL: "https://api.example/v1",
      });
    } finally {
      read.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The Ollama endpoint — one ladder, checked before it reaches the SDK (DW-326)
// ---------------------------------------------------------------------------

/**
 * The options object the last `createOllama` call was given.
 *
 * `undefined` is a real answer: `getModel()`'s ollama leg calls `createOllama()`
 * with no argument at all when there is no endpoint, where `getConfiguredModel`
 * passes `{}`. Both mean the same thing to the SDK — use its own default — so
 * the assertions below look at `baseURL` rather than at the object's shape.
 */
function lastOllamaArgs(): Record<string, unknown> | undefined {
  const call = createOllamaMock.mock.calls.at(-1) as unknown as [
    Record<string, unknown> | undefined,
  ];
  return call[0];
}

describe("the Ollama endpoint reaches every SDK construction through one ladder", () => {
  it("hands a STORED endpoint to the primary path AND to a routed workload", async () => {
    // `getConfiguredModel`'s `ollama` leg read `process.env.OLLAMA_BASE_URL`
    // raw, so it ignored `cfg.ollamaBaseUrl` entirely: an owner who set the
    // endpoint in Settings had the primary path talk to their server and chat
    // talk to localhost.
    await store({
      provider: "ollama",
      model: "llama3",
      ollamaBaseUrl: "http://ollama.internal:11434",
      chatProvider: "ollama",
      chatModel: "llama3",
    });

    await callLLM("system", "message");
    expect(lastOllamaArgs()?.baseURL).toBe("http://ollama.internal:11434");

    createOllamaMock.mockClear();
    await getConfiguredModel({ workload: "chat" });
    expect(lastOllamaArgs()?.baseURL).toBe("http://ollama.internal:11434");
  });

  it("gives the SDK NO endpoint when the stored one is not a usable URL", async () => {
    // DW-304 refuses this at the write door; it does nothing about a value
    // stored before that rule, hand-edited in, or restored from a backup. The
    // SDK falls to its own default rather than being handed `file://`.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await store({
        provider: "ollama",
        model: "llama3",
        ollamaBaseUrl: "file:///etc/passwd",
        chatProvider: "ollama",
        chatModel: "llama3",
      });

      await callLLM("system", "message");
      expect(lastOllamaArgs()?.baseURL).toBeUndefined();

      createOllamaMock.mockClear();
      await getConfiguredModel({ workload: "chat" });
      expect(lastOllamaArgs()?.baseURL).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls THROUGH an unusable OLLAMA_BASE_URL to the stored endpoint", async () => {
    // The env value is the one no route ever validates, and it wins at runtime.
    // Refusing it must not also throw away a stored endpoint that works.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.OLLAMA_BASE_URL = "localhost:11434";
      await store({
        provider: "ollama",
        model: "llama3",
        ollamaBaseUrl: "http://ollama.internal:11434",
      });

      await callLLM("system", "message");
      expect(lastOllamaArgs()?.baseURL).toBe("http://ollama.internal:11434");
    } finally {
      warn.mockRestore();
    }
  });

  it("gives the EMBEDDING leg no endpoint either when none resolves (DW-401)", async () => {
    // The claim the DW-401 warning must not quietly break: naming
    // `http://127.0.0.1:11434/api` in a log line must NOT turn it into the
    // value handed to `createOllama`. The SDK is mocked here, so this is the
    // only place the argument itself is observable — `embeddings.test.ts` runs
    // against the real provider and can see the model was built, not what it
    // was built with.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await store({ embeddingProvider: "ollama" });

      expect(getEmbeddingModel()).not.toBeNull();
      // No argument at all, exactly as before the warning existed.
      expect(lastOllamaArgs()?.baseURL).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT hand the embedding leg the CHAT endpoint (DW-70)", async () => {
    // The split, pinned where the argument is observable. `ollamaBaseUrl` is a
    // perfectly USABLE URL here — before DW-70 this leg dialled it, which is
    // what made the "Embedding endpoint" field inert under ollama and made one
    // variable mean two things. The embedding call now reads `embeddingBaseUrl`
    // and nothing else, so with none saved the construction is argument-free
    // and the DW-401 sentence speaks.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await store({
        embeddingProvider: "ollama",
        ollamaBaseUrl: "http://ollama.internal:11434",
      });

      expect(getEmbeddingModel()).not.toBeNull();
      expect(lastOllamaArgs()?.baseURL).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("hands the embedding leg a USABLE stored EMBEDDING endpoint, unchanged", async () => {
    // …and the positive control, so the two assertions above cannot both pass
    // on a leg that never reaches `createOllama` at all.
    await store({
      embeddingProvider: "ollama",
      embeddingBaseUrl: "http://embed.internal:11434",
    });

    expect(getEmbeddingModel()).not.toBeNull();
    expect(lastOllamaArgs()?.baseURL).toBe("http://embed.internal:11434");
  });

  it("sends chat and embeddings to DIFFERENT endpoints when both are stored", async () => {
    // The whole point of the split, in one case: two settings, two endpoints,
    // neither borrowing the other's. A regression that re-merged them would
    // still pass both cases above if it picked the wrong single winner
    // consistently — this one cannot be satisfied by any single value.
    await store({
      provider: "ollama",
      model: "llama3",
      ollamaBaseUrl: "http://chat.internal:11434",
      embeddingProvider: "ollama",
      embeddingBaseUrl: "http://embed.internal:11434",
    });

    await callLLM("system", "message");
    expect(lastOllamaArgs()?.baseURL).toBe("http://chat.internal:11434");

    createOllamaMock.mockClear();
    expect(getEmbeddingModel()).not.toBeNull();
    expect(lastOllamaArgs()?.baseURL).toBe("http://embed.internal:11434");
  });
});

// ---------------------------------------------------------------------------
// The configured LLM timeout
// ---------------------------------------------------------------------------

describe("the configured LLM timeout reaches the provider call", () => {
  const OPENAI: AppConfig = { provider: "openai", model: "gpt-4o" };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-openai";
  });

  it("is ABSENT when unset, so today's no-deadline behaviour is unchanged", async () => {
    await store(OPENAI);

    await callLLM("system", "message");
    // The key must not be present at all — `abortSignal: undefined` is not the
    // same thing to every SDK version, and "no deadline" is the default this
    // story deliberately preserves.
    expect("abortSignal" in lastGenerateArgs()).toBe(false);

    await callVisionLLM("prompt", new Uint8Array([1]));
    expect("abortSignal" in lastGenerateArgs()).toBe(false);

    await callLLMStream("system", "message");
    const streamArgs = streamTextMock.mock.calls.at(-1) as unknown as [
      Record<string, unknown>,
    ];
    expect("abortSignal" in streamArgs[0]).toBe(false);
  });

  it("rides on all three call sites when configured", async () => {
    await store({ ...OPENAI, llmTimeoutSeconds: 60 });

    await callLLM("system", "message");
    expect(lastGenerateArgs().abortSignal).toBeInstanceOf(AbortSignal);

    await callVisionLLM("prompt", new Uint8Array([1]));
    expect(lastGenerateArgs().abortSignal).toBeInstanceOf(AbortSignal);

    await callLLMStream("system", "message");
    const streamArgs = streamTextMock.mock.calls.at(-1) as unknown as [
      Record<string, unknown>,
    ];
    expect(streamArgs[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("gives every RETRY its own deadline rather than an already-expired one", async () => {
    await store({ ...OPENAI, llmTimeoutSeconds: 60 });
    // One transient failure, then success — so `retryWithBackoff` runs the thunk
    // twice. A signal constructed OUTSIDE the thunk would be the same object on
    // both attempts, and would already be counting down (or expired) on the
    // second.
    const transient = Object.assign(new Error("fetch failed"), { status: 503 });
    generateTextMock
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ text: "ok" });

    await callLLM("system", "message");

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const first = (generateTextMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    const second = (generateTextMock.mock.calls[1] as unknown as [Record<string, unknown>])[0];
    expect(first.abortSignal).toBeInstanceOf(AbortSignal);
    expect(second.abortSignal).toBeInstanceOf(AbortSignal);
    expect(second.abortSignal).not.toBe(first.abortSignal);
  }, 15_000);

  it("is the SDK's own option, present only when a deadline is configured", async () => {
    await store({ ...OPENAI });
    expect(llmTimeoutOption()).toEqual({});

    await store({ ...OPENAI, llmTimeoutSeconds: 30 });
    const option = llmTimeoutOption();
    expect(option.abortSignal).toBeInstanceOf(AbortSignal);
    // A fresh signal each call — that is what makes per-attempt deadlines work.
    expect(llmTimeoutOption().abortSignal).not.toBe(option.abortSignal);
  });

  it("reaches the three sibling modules that call the SDK directly", async () => {
    // `callLLM` is not the only door to `generateText` in this repo. The field
    // is labelled "LLM timeout" with no scope, so a deadline that bound only
    // `llm.ts` would be a setting that quietly means something narrower than it
    // says. Source-scanned because driving these three modules end to end would
    // need their whole dependency graph; the option they spread is executed
    // above.
    const files = [
      "action-extractor.ts",
      "structured-knowledge.ts",
      "source-monitors.ts",
    ];
    for (const file of files) {
      const source = await fs.readFile(
        path.join(process.cwd(), "src", "lib", file),
        "utf-8",
      );
      expect(source, `${file} must import the shared deadline`).toMatch(
        /import \{[^}]*\bllmTimeoutOption\b[^}]*\} from "\.\/config"/,
      );
      expect(source, `${file} must spread it into its SDK call`).toContain(
        "...llmTimeoutOption(),",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The stored embedding credential and endpoint
// ---------------------------------------------------------------------------

describe("the stored embedding credential and endpoint are read", () => {
  it("resolves an embedding provider from a key that exists only in the store", async () => {
    // Without this fallback, "vector search needs an endpoint, a model and a
    // key" would store three values no code path could use.
    await store({ embeddingProvider: "openai", embeddingApiKey: "sk-stored" });

    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
    expect(getEmbeddingModel()).not.toBeNull();
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "sk-stored" });
  });

  it("still lets the environment win", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    await store({ embeddingProvider: "openai", embeddingApiKey: "sk-stored" });

    getEmbeddingModel();

    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "sk-env" });
  });

  it("does not let an empty env var mask the stored embedding key", async () => {
    // The LLM side of this trap is pinned above; this is the embedding twin.
    // `??` would short-circuit on a blank `OPENAI_API_KEY=` line and hand `""`
    // to the SDK, while `config.ts`'s vector gate — which reads the same var
    // through its own trim-and-null — went on reporting the switch as on.
    process.env.OPENAI_API_KEY = "";
    await store({
      embeddingProvider: "openai",
      embeddingApiKey: "sk-stored",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://embed.example/v1",
      vectorSearchEnabled: true,
    });

    expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
    expect(getEmbeddingModel()).not.toBeNull();
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-stored",
      baseURL: "https://embed.example/v1",
    });
    // The two answers agree: the gate is not on for a key nothing can reach.
    expect(getVectorSearchSettings().enabled).toBe(true);
    expect(hasEmbeddingSupport()).toBe(true);
  });

  it("lets an ENABLED Workers AI gate imply the owner's own model embeds (DW-73)", async () => {
    // The end-to-end form of what `embeddingModelMatchesProvider` exists to
    // guarantee. `workbench-settings.test.ts` pins the gate and
    // `embeddings.test.ts` pins the resolver, but nothing crossed the two for
    // `workers-ai` over a real stored config — which is the ONE provider where
    // the namespace rule can bite, and the one this file had no case for.
    //
    // The id is deliberately NOT `@cf/baai/bge-m3`: that is the Workers AI
    // DEFAULT, so a resolver that dropped the stored value would still return
    // it and the assertion would pass while the bug shipped.
    mockGetCfContext.mockReturnValue({ env: { AI: { run: vi.fn() } } });
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-large-en-v1.5",
    });

    expect(getVectorSearchSettings().enabled).toBe(true);
    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-large-en-v1.5");
  });

  it("keeps the gate and the resolver agreeing when the namespace does NOT match", async () => {
    // The other half of the same equivalence, and the state DW-73 exists for:
    // the gate reads off, and the resolver substitutes the provider default
    // rather than embedding with the id the owner typed. Both halves come from
    // the one shared predicate, so a change to it breaks this pair together
    // instead of letting the two surfaces drift apart quietly.
    mockGetCfContext.mockReturnValue({ env: { AI: { run: vi.fn() } } });
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });

    expect(getVectorSearchSettings().enabled).toBe(false);
    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");
  });

  it("says WHICH model embeds when EMBEDDING_MODEL is being substituted (DW-274)", async () => {
    // The literal DW-274 deployment: Workers AI (auto-detected from the bound
    // `AI` binding) with `EMBEDDING_MODEL=text-embedding-3-small` in the
    // environment. `/settings` used to render that env value in its locked
    // "from env" box and stop there, while `embedText` ran on `@cf/baai/bge-m3`
    // — the one surface whose job is "what is in effect and where did it come
    // from" answering wrongly.
    //
    // This is the only file that can reach the state: it mocks
    // `@opennextjs/cloudflare`, so the Workers AI leg of
    // `embeddingModelMatchesProvider` is reachable here and nowhere else.
    mockGetCfContext.mockReturnValue({ env: { AI: { run: vi.fn() } } });
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({});

    // The embed path — the fact the page has to agree with.
    expect(getEmbeddingModelName()).toBe("@cf/baai/bge-m3");

    const settings = getEffectiveSettings();
    // What is SET, unchanged: this is what the locked box shows and what the
    // source badge is about.
    expect(settings.embeddingModel).toBe("text-embedding-3-small");
    expect(settings.embeddingModelSource).toBe("env");
    // What is IN EFFECT — the half that was missing.
    expect(settings.embeddingModelInEffect).toBe("@cf/baai/bge-m3");
    expect(settings.embeddingModelOverridden).toBe(true);
    expect(settings.embeddingSupport).toBe(true);
    // …and WHICH PROVIDER is embedding (DW-616). This is the case the browser
    // provably cannot derive: `EMBEDDING_PROVIDER` is unset and nothing is
    // stored, so an env→store ladder walked in the page answers `null` while
    // the resolver auto-detects Workers AI from the binding. `/settings`' one
    // infrastructure sentence hangs off this field, so it is served or it is
    // wrong.
    expect(process.env.EMBEDDING_PROVIDER ?? null).toBeNull();
    expect(settings.embeddingProviderInEffect).toBe("workers-ai");

    // And ALL of them ride at the TOP LEVEL of the legacy object, so the route's
    // `...settings` spread carries them with no route change (DW-63).
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body.embeddingModel).toBe("text-embedding-3-small");
    expect(body.embeddingModelInEffect).toBe("@cf/baai/bge-m3");
    expect(body.embeddingProviderInEffect).toBe("workers-ai");
    expect(body.embeddingModelOverridden).toBe(true);
  });

  it("does the same for Google", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";
    await store({ embeddingProvider: "google", embeddingApiKey: "g-stored" });

    getEmbeddingModel();

    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "g-stored" });
  });

  it("is inert with nothing stored, so every existing branch resolves as before", async () => {
    await store({ embeddingProvider: "openai" });
    // No key anywhere: the override branch refuses rather than falling through.
    expect(getEmbeddingModelName()).toBeNull();
    expect(getEmbeddingModel()).toBeNull();
    expect(createOpenAIMock).not.toHaveBeenCalled();
  });

  it("passes a stored endpoint to OpenAI and to Google, and omits it when unset", async () => {
    await store({
      embeddingProvider: "openai",
      embeddingApiKey: "sk-stored",
      embeddingBaseUrl: "  https://embed.example/v1  ",
    });
    getEmbeddingModel();
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-stored",
      baseURL: "https://embed.example/v1",
    });

    await store({
      embeddingProvider: "google",
      embeddingApiKey: "sk-stored",
      embeddingBaseUrl: "https://embed.example/v1",
    });
    getEmbeddingModel();
    expect(createGoogleMock).toHaveBeenCalledWith({
      apiKey: "sk-stored",
      baseURL: "https://embed.example/v1",
    });

    // Unset: the option is absent entirely, not present-and-undefined.
    createOpenAIMock.mockClear();
    await store({ embeddingProvider: "openai", embeddingApiKey: "sk-stored" });
    getEmbeddingModel();
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "sk-stored" });
  });

  it("reports WHICH providers the environment carries an embedding key for", async () => {
    // The vector gate's key leg is per vendor, because `embeddingApiKeyFor` is:
    // an `OPENAI_API_KEY` resolves nothing for a Google selection, so serving
    // one flat "an env key exists" boolean let the switch turn on for a
    // provider that then embeds nothing.
    await store({});
    expect(getWorkbenchSettings(false).envEmbeddingApiKeyProviders).toEqual([]);

    process.env.OPENAI_API_KEY = "sk-env";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings(false).envEmbeddingApiKeyProviders).toEqual(["openai"]);

    // Set-but-empty is not a credential.
    process.env.OPENAI_API_KEY = "";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-env";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings(false).envEmbeddingApiKeyProviders).toEqual(["google"]);
  });

  it("keeps `hasEmbeddingApiKey` about the STORE, so Remove is never offered for an env key", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    await store({ embeddingProvider: "openai" });
    expect(getWorkbenchSettings(false).hasEmbeddingApiKey).toBe(false);

    await store({ embeddingProvider: "openai", embeddingApiKey: "sk-stored" });
    expect(getWorkbenchSettings(false).hasEmbeddingApiKey).toBe(true);
  });

  it("splits the CUSTOM key into a stored half and an env half (DW-66)", async () => {
    // The row that was wrong: `hasCustomApiKey` used to be
    // `apiKeyForProvider("custom") !== null` — the OR of the two — so an
    // env-only deployment read "A key is stored." and got a `Remove` that
    // deletes nothing from the store and cannot touch the variable. Pressing it
    // changed neither the credential nor the sentence.
    await store({});
    expect(getWorkbenchSettings(false).hasCustomApiKey).toBe(false);
    expect(getWorkbenchSettings(false).envCustomApiKey).toBe(false);

    // Env only: no `Remove`, and the row says where the key comes from.
    process.env.LLM_CUSTOM_API_KEY = "sk-env";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings(false).hasCustomApiKey).toBe(false);
    expect(getWorkbenchSettings(false).envCustomApiKey).toBe(true);
    // …and the RESOLVER is untouched. This is a reporting split, not a
    // precedence change: env still wins at runtime.
    expect(apiKeyForProvider("custom")).toBe("sk-env");

    // Both halves: `Remove` is offered again, because there IS a stored key for
    // it to delete — and the env sentence still applies.
    await store({ customApiKey: "sk-stored" });
    expect(getWorkbenchSettings(false).hasCustomApiKey).toBe(true);
    expect(getWorkbenchSettings(false).envCustomApiKey).toBe(true);
    expect(apiKeyForProvider("custom")).toBe("sk-env");

    // Set-but-empty is not a credential, and must not mask the stored key.
    process.env.LLM_CUSTOM_API_KEY = "";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings(false).hasCustomApiKey).toBe(true);
    expect(getWorkbenchSettings(false).envCustomApiKey).toBe(false);
    expect(apiKeyForProvider("custom")).toBe("sk-stored");
  });

  it("splits the FIRECRAWL key the same way, and leaves the OR alone (DW-66)", async () => {
    await store({});
    expect(getWorkbenchSettings(false).hasFirecrawlApiKey).toBe(false);
    expect(getWorkbenchSettings(false).envFirecrawlApiKey).toBe(false);

    process.env.FIRECRAWL_API_KEY = "fc-env";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings(false).hasFirecrawlApiKey).toBe(false);
    expect(getWorkbenchSettings(false).envFirecrawlApiKey).toBe(true);
    // The OR is unchanged — there IS a credential, which is what `hasKey` has
    // always answered. Nothing in production reads it since this row stopped
    // (DW-66); it is asserted here so a later edit to the halves cannot quietly
    // change the answer it still computes from the same two reads.
    expect(getFirecrawlSettings().hasKey).toBe(true);

    await store({ firecrawlApiKey: "fc-stored" });
    expect(getWorkbenchSettings(false).hasFirecrawlApiKey).toBe(true);
    expect(getWorkbenchSettings(false).envFirecrawlApiKey).toBe(true);

    // `FIRECRAWL_API_KEY=""` is set-but-empty: not a credential, and it must not
    // mask the key the owner stored through Settings.
    process.env.FIRECRAWL_API_KEY = "";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings(false).hasFirecrawlApiKey).toBe(true);
    expect(getWorkbenchSettings(false).envFirecrawlApiKey).toBe(false);
    expect(getFirecrawlSettings().hasKey).toBe(true);
  });

  it("reports the Cloudflare AI binding as the route reads it (DW-225)", () => {
    // The payload's one RUNTIME fact. `getWorkbenchSettings` does not read it
    // itself — `config.ts` is a sync cache read that any path may call off a
    // Workers request scope, where `getCloudflareContext()` throws and the
    // answer would be a misleading `false` rather than "unknown". So the route
    // reads `getWorkersAiBinding() !== null` once and hands it in, and this is
    // what "hands it in" means.
    expect(getWorkbenchSettings(true).hasWorkersAiBinding).toBe(true);
    expect(getWorkbenchSettings(false).hasWorkersAiBinding).toBe(false);
  });

  it("refuses a workers-ai deployment with no binding, end to end through the route", async () => {
    // The DW-225 state: nothing about the stored config is wrong — the provider
    // is explicit and the id is supported — but off the Workers runtime
    // `resolveEmbeddingProvider` returns `null` forever, so a switch the gate
    // let the owner turn on would embed nothing. `getCloudflareContext` throws
    // here by default, exactly as it does on Docker.
    mockGetCfContext.mockImplementation(noCloudflareContext);
    await store({ embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" });
    // The embed path already refuses on its own — this is the fact the gate was
    // disagreeing with.
    expect(hasEmbeddingSupport()).toBe(false);

    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await turnVectorSearchOn());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "the Cloudflare AI binding",
    );

    // Bound, and the very same request lands — the only thing that changed is
    // the runtime fact the route reads.
    mockGetCfContext.mockReturnValue({ env: { AI: { run: vi.fn() } } });
    const bound = await PUT(await turnVectorSearchOn());
    expect(bound.status).toBe(200);
  });

  it("says the unbound-binding line ONCE across repeated GET and PUT (DW-278)", async () => {
    // The AMPLIFYING SEAM. `route.ts` calls `getWorkersAiBinding()`
    // unconditionally once per request in both `GET` (:90) and `PUT` (:127), so
    // an unbound Workers deployment logged one WARN per settings request on a
    // path that previously logged nothing at all. `settings-route.test.ts`
    // structurally cannot cover this — it `vi.mock`s the whole embeddings
    // module — but this file imports the real route and drives the Cloudflare
    // context, so the assertion belongs here.
    //
    // Reset first: the guard is module state that outlives a test, and nothing
    // in this file's `beforeEach` clears it.
    _resetEmbeddingWarnings();
    // ON the Workers runtime with `AI` absent — the misconfiguration, as
    // distinct from `noCloudflareContext` (not on Workers), which stays silent.
    mockGetCfContext.mockReturnValue({ env: {} });

    const { GET, PUT } = await import("@/app/api/settings/route");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const first = await GET();
      const second = await GET();
      // The switch is refused without a binding (DW-225), which is beside the
      // point here: `PUT` reads the binding at the top of the handler, before
      // any validation, so the seam is exercised either way.
      await PUT(await turnVectorSearchOn());
      await PUT(await turnVectorSearchOn());

      const unbound = warn.mock.calls.filter(
        (call) =>
          call[0] === "embeddings" &&
          String(call[1]).includes("AI binding is not bound"),
      );
      expect(unbound).toHaveLength(1);

      // Four reads of the runtime fact, and the throttle changed none of them.
      for (const response of [first, second]) {
        const body = (await response.json()) as {
          workbench: { hasWorkersAiBinding: boolean };
        };
        expect(body.workbench.hasWorkersAiBinding).toBe(false);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("names the VARIABLE when EMBEDDING_PROVIDER forces the unbound selection (DW-281)", async () => {
    // The same refusal, with the one way out the owner has. The stored note
    // offers "choose another embedding provider", which is advice this
    // deployment cannot follow: `EMBEDDING_PROVIDER` wins over the stored
    // selection in every feeder, so a provider picked in Settings changes
    // nothing and the switch stays refused forever. End to end, because the
    // origin is derived rather than served — the route computes it from the
    // same `envEmbeddingProvider` the payload already carries.
    mockGetCfContext.mockImplementation(noCloudflareContext);
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    await store({ embeddingModel: "@cf/baai/bge-m3" });

    // The browser's half sees the env origin off the payload alone.
    const payload = getWorkbenchSettings(false);
    expect(payload.envEmbeddingProvider).toBe("workers-ai");
    const inputs = draftVectorInputs(settingsDraftFromPayload(payload), payload);
    expect(inputs.providerOrigin).toBe("env");
    const sentence = vectorSearchMissingCopy(inputs);
    expect(sentence).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_ENV_NOTE}`,
    );
    // …and the complaint rides on the PROVIDER SELECT, described but not
    // marked: the select is not what is wrong.
    expect(vectorSearchFieldIssue(inputs, "provider")).toEqual({
      copy: sentence,
      invalid: false,
    });

    // …and the route, which re-runs the rule over the merged config, refuses
    // over the same leg and carries the same NOTE. The frame is the switched-on
    // one, because the request sends the flag on (DW-330) — the sentence above
    // is the hint beside an UNTICKED box, which is the state the surface is in
    // before Save is pressed and not after.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await turnVectorSearchOn());
    expect(response.status).toBe(400);
    const error = ((await response.json()) as { error: string }).error;
    expect(error).toBe(
      `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_BINDING_ENV_NOTE}`,
    );
    expect(error).toContain(
      "unset EMBEDDING_PROVIDER to choose another embedding provider",
    );
    // NOT the stored note's unconditional form — the advice this deployment
    // cannot follow while the variable is set.
    expect(error).not.toContain("or choose another embedding provider");
  });

  it("serves a JUNK EMBEDDING_PROVIDER as no PINNED provider, but as a REFUSED one to the rule (DW-398)", async () => {
    // `envEmbeddingProviderPair()` filters through `isEmbeddingProvider`, so an
    // unsupported variable never reaches the browser as a SELECTION — it
    // arrives on that field as `null`. That is the boundary the settings
    // surface's env pin sits on (DW-398): `SettingsCanvas` pins on this field,
    // so a junk value leaves the provider select editable, which is what the
    // owner needs once they correct the variable and the STORE becomes the
    // thing that applies.
    process.env.EMBEDDING_PROVIDER = "deepseek";
    await store({ embeddingProvider: "openai", embeddingModel: "text-embedding-3-small" });

    const payload = getWorkbenchSettings(false);
    expect(payload.envEmbeddingProvider).toBeNull();
    // …and the stored selection is what the editable box still holds, unshadowed.
    expect(payload.embeddingProvider).toBe("openai");
    // NOT "no variable at all" (DW-508): the rejected string rides beside the
    // filtered field, which is the only owner-visible signal that the
    // deployment set something the resolver refuses.
    expect(payload.envEmbeddingProviderInvalid).toBe("deepseek");

    // The PIN and the RULE are different questions (DW-552). The pin is off,
    // per the paragraph above; the rule re-JOINS the two fields, so the value
    // the gate is read against is the one the runtime actually resolves —
    // filtering it here is what let the browser offer a switch on a provider
    // that never embeds. These two lines are the ones this deployment's fix
    // makes true; the RUNTIME's matching refusal is pinned on a store with the
    // flag actually set by "REFUSES a junk EMBEDDING_PROVIDER at the runtime
    // gate, as the resolver does (DW-509)" below, which is the stronger read —
    // asserting `enabled` here, where nothing ever stored `true`, would pass
    // with the whole join reverted.
    const inputs = draftVectorInputs(settingsDraftFromPayload(payload), payload);
    expect(inputs.provider).toBe("deepseek");
    expect(inputs.providerOrigin).toBe("env");
  });

  it("reports no invalid value when EMBEDDING_PROVIDER is unset, blank or supported (DW-508)", async () => {
    // The three states that must NOT produce a sentence. `nonEmpty` is the same
    // trim-and-null `resolveEmbeddingProvider` reads the variable through, so a
    // whitespace-only variable is "unset" here exactly as it is there — and a
    // supported one is a SELECTION, described by the pinned sentence instead.
    await store({ embeddingProvider: "openai" });

    delete process.env.EMBEDDING_PROVIDER;
    expect(getWorkbenchSettings(false).envEmbeddingProviderInvalid).toBeNull();

    process.env.EMBEDDING_PROVIDER = "   ";
    const blank = getWorkbenchSettings(false);
    expect(blank.envEmbeddingProviderInvalid).toBeNull();
    // …and with BOTH halves null there is nothing for the rule's join to take,
    // so the stored selection still owns the gate (DW-552). Pinned here rather
    // than left to follow from the two nulls: a blank variable is the one state
    // where "set" and "unset" could plausibly have parted.
    const blankInputs = draftVectorInputs(settingsDraftFromPayload(blank), blank);
    expect(blankInputs.provider).toBe("openai");
    expect(blankInputs.providerOrigin).toBe("stored");

    process.env.EMBEDDING_PROVIDER = "google";
    const pinned = getWorkbenchSettings(false);
    expect(pinned.envEmbeddingProviderInvalid).toBeNull();
    expect(pinned.envEmbeddingProvider).toBe("google");
  });

  it("reads the SAME variable into both constructors, the join and the runtime", async () => {
    // ONE fact, four variable states, three readers (DW-552/DW-638).
    //
    // The two constructors used to spell the invalid half with two
    // INDEPENDENTLY WRITTEN expressions — `envProviderRaw !== null &&
    // envProvider === null ? envProviderRaw : null` in `getWorkbenchSettings`,
    // `envProvider === null ? nonEmpty(process.env.EMBEDDING_PROVIDER) : null`
    // in `workbenchSettingsStored` — meant to be the same read and held equal by
    // this test and by nothing else. Both now call one
    // `envEmbeddingProviderPair()` over the module's one
    // `envEmbeddingProviderRaw()`, so the exclusivity the `??` join depends on
    // is structural rather than pinned; this test is what says the collapse
    // changed no answer. The BROWSER gets the first constructor, the ROUTE runs
    // the second.
    //
    // And the stronger claim, which is the whole seam: `filtered ?? invalid`
    // equals the RAW variable in every state. `getVectorSearchSettings` reads it
    // raw (DW-509) and is the answer the other two are aligned TO, so the join
    // is only correct while that equality holds — the third reader below checks
    // it against the running gate rather than against an expectation.
    //
    // The flag is STORED ON, so `getVectorSearchSettings().enabled` is the
    // predicate alone and the verdict half of the criterion has something to
    // measure: with it off, `enabled` is `false` in all four states and every
    // state agrees for the wrong reason.
    const cfg: AppConfig = {
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://o/v1",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-o",
    };
    await store(cfg);

    const states: Array<{
      name: string;
      set: string | undefined;
      /** What the RAW read keeps — and therefore what the join must answer. */
      raw: string | null;
      /** What the filter threw away, which is the `invalid` half alone. */
      expected: string | null;
    }> = [
      { name: "unset", set: undefined, raw: null, expected: null },
      // The trim-and-null both sides read the variable through: a whitespace-only
      // variable is "unset" to each, not "set to junk" to one and unset to the other.
      { name: "whitespace only", set: "   ", raw: null, expected: null },
      { name: "junk", set: "deepseek", raw: "deepseek", expected: "deepseek" },
      // A SUPPORTED value lands on the filtered field instead, so the invalid
      // twin is null on both — the exclusivity the `??` join depends on.
      { name: "supported", set: "google", raw: "google", expected: null },
    ];

    for (const state of states) {
      if (state.set === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = state.set;

      const payload = getWorkbenchSettings(false);
      const stored = workbenchSettingsStored(cfg, false);
      const fromPayload = payload.envEmbeddingProviderInvalid;
      const fromStored = stored.envEmbeddingProviderInvalid;
      expect({ state: state.name, fromPayload, fromStored }).toEqual({
        state: state.name,
        fromPayload: state.expected,
        fromStored: state.expected,
      });

      // The JOIN over each half, against the raw variable. One expression feeds
      // both feeders now, so this is the pin that the one expression is the
      // RIGHT one rather than merely the only one.
      expect({
        state: state.name,
        browser: resolveEnvEmbeddingProvider(
          payload.envEmbeddingProvider,
          payload.envEmbeddingProviderInvalid,
        ),
        route: resolveEnvEmbeddingProvider(
          stored.envEmbeddingProvider,
          stored.envEmbeddingProviderInvalid,
        ),
      }).toEqual({ state: state.name, browser: state.raw, route: state.raw });

      // …and the PROVIDER all three end up gating on. The runtime reads the
      // variable raw and the store holds a complete `openai` config, so an unset
      // or blank variable falls through to it and any other value shadows it —
      // in the browser exactly as in `getVectorSearchSettings`.
      const runtime = getVectorSearchSettings();
      const browser = draftVectorInputs(settingsDraftFromPayload(payload), payload);
      expect({
        state: state.name,
        runtime: runtime.provider,
        browser: browser.provider,
        origin: browser.providerOrigin,
      }).toEqual({
        state: state.name,
        runtime: state.raw ?? "openai",
        browser: state.raw ?? "openai",
        origin: state.raw === null ? "stored" : "env",
      });

      // …and the GATE VERDICT, which is the half of the criterion the provider
      // assertions above cannot reach: two feeders may name the same provider
      // and still disagree about whether it can be switched on. Pinned as an
      // EQUALITY between the runtime's intersected flag and the browser's
      // predicate rather than against a literal per state, so the row says the
      // two agree rather than restating what each answers.
      expect({ state: state.name, runtime: runtime.enabled }).toEqual({
        state: state.name,
        runtime: canEnableVectorSearch(browser),
      });
      // …and the verdict genuinely VARIES across the four states, or the
      // equality above would hold for a gate that answered a constant. `junk`
      // is the state that must refuse: it is the only one whose provider the
      // first leg does not recognise.
      expect({ state: state.name, enabled: runtime.enabled }).toEqual({
        state: state.name,
        enabled: state.name !== "junk",
      });
    }
  });

  it("REFUSES a junk EMBEDDING_PROVIDER at the runtime gate, as the resolver does (DW-509)", async () => {
    // `getVectorSearchSettings` used to read the FILTERED env value, so junk
    // fell through to the stored provider: every leg met, `enabled: true`, and
    // a switch reporting itself satisfied on a provider `resolveEmbeddingProvider`
    // returns `null` for. Nothing embedded, and nothing said so.
    //
    // The ladder now matches the resolver's line for line — raw env, then store
    // — and `vectorSearchMissingLegs`' first leg makes the refusal.
    process.env.EMBEDDING_PROVIDER = "deepseek";
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingApiKey: "sk-o",
      embeddingModel: "text-embedding-3-small",
    });

    const settings = getVectorSearchSettings();
    // The value the gate was actually read against, not a shadowed one: the
    // reported provider is what the resolver saw and refused.
    expect(settings.provider).toBe("deepseek");
    expect(settings.enabled).toBe(false);
    // …and the resolver agrees, which is the whole point of the alignment:
    // `getEmbeddingModelName` returns `null` exactly when
    // `resolveEmbeddingProvider` refuses, so nothing embeds.
    expect(getEmbeddingModelName()).toBeNull();
    expect(getEmbeddingModel()).toBeNull();
    // The DECLARED shape is untouched — the gate-only inputs must not leak.
    expect(Object.keys(settings).sort()).toEqual([
      "baseUrl",
      "enabled",
      "hasKey",
      "model",
      "provider",
    ]);
  });

  it("treats a BLANK EMBEDDING_PROVIDER as unset at the runtime gate", async () => {
    // The half the raw read must not change: `nonEmpty` still trims, so a
    // whitespace-only variable does not shadow a perfectly good stored
    // selection — the store wins and the origin says so (DW-333).
    process.env.EMBEDDING_PROVIDER = "   ";
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingApiKey: "sk-o",
      embeddingBaseUrl: "https://o/v1",
      embeddingModel: "text-embedding-3-small",
    });

    const settings = getVectorSearchSettings();
    expect(settings.provider).toBe("openai");
    expect(settings.enabled).toBe(true);
    // The origin follows the same raw read, so it still reports the store.
    const payload = getWorkbenchSettings(false);
    const inputs = draftVectorInputs(settingsDraftFromPayload(payload), payload);
    expect(inputs.providerOrigin).toBe("stored");
  });

  it("reports the provider ORIGIN from config.ts too, without leaking it (DW-281)", async () => {
    // `getVectorSearchSettings` constructs its own `VectorSearchInputs`, and the
    // field has no default — so this is the caller that would silently claim the
    // store owns a value the environment forces. Its DECLARED shape is unchanged:
    // the gate-only inputs must not reach a consumer that could misread them.
    process.env.EMBEDDING_PROVIDER = "workers-ai";
    await store({ vectorSearchEnabled: true, embeddingModel: "@cf/baai/bge-m3" });
    const settings = getVectorSearchSettings();
    expect(Object.keys(settings).sort()).toEqual([
      "baseUrl",
      "enabled",
      "hasKey",
      "model",
      "provider",
    ]);
    expect(settings.provider).toBe("workers-ai");
    // `hasWorkersAiBinding` is `null` here, so the binding leg is not applied —
    // this caller answers exactly as it did before either origin existed.
    expect(settings.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Vectorize binding is a fact this deployment RESOLVES (DW-715)
// ---------------------------------------------------------------------------
//
// `hasVectorizeBinding()` is the only NEW statement of fact DW-715 introduces,
// and it is the one thing the rest of that change's suites structurally cannot
// reach. `settings-route.test.ts` replaces the helper with `vi.fn(() => false)`;
// the component and page suites hand the answer in as a prop or a fabricated
// payload. So inverting the read (`== null` for `!= null`) or misspelling the
// binding key leaves every one of them green while `/settings` renders the exact
// false infrastructure claim the entry exists to remove: "…with a
// 1,024-dimensional Vectorize index" on a deployment that has no index.
//
// This file is where it belongs, for the reason its `hasWorkersAiBinding`
// siblings above already give: it mocks `@opennextjs/cloudflare` and drives the
// REAL route, so the Cloudflare env is an input rather than a stub of the answer.

describe("the Vectorize binding is read from the runtime and served", () => {
  /**
   * A Cloudflare env as OpenNext hands it over.
   *
   * `YOPEDIA_BUCKET` and `YOPEDIA_CONFIG` are always present because
   * `getOpenNextCloudflareEnv()` refuses to claim an object is a `CloudflareEnv`
   * without BOTH — the R2 provider cannot be constructed otherwise, so a
   * deployment missing them has no index it could use either way. The one field
   * that varies between cases is the one under test.
   *
   * These are opaque handles here, never called: nothing in a settings read
   * touches the bucket, and `detectProvider()` still answers `fs` under node
   * (there is no `caches.default`), so the config store stays the temp dir this
   * file's `beforeEach` builds.
   */
  function cfEnv(extra: Record<string, unknown> = {}) {
    return { env: { YOPEDIA_BUCKET: {}, YOPEDIA_CONFIG: {}, ...extra } };
  }

  it("answers true only when YOPEDIA_VECTORIZE is actually bound", () => {
    // The helper, directly — the seam every other suite mocks away. Inverting
    // the predicate flips both of these at once.
    mockGetCfContext.mockReturnValue(cfEnv({ YOPEDIA_VECTORIZE: { query: vi.fn() } }));
    expect(hasVectorizeBinding()).toBe(true);

    mockGetCfContext.mockReturnValue(cfEnv());
    expect(hasVectorizeBinding()).toBe(false);
  });

  it("answers false off Workers, and on a Workers env with no storage bindings", () => {
    // The two other routes to `false` the helper's docblock names, stated so a
    // future short-circuit cannot quietly turn either into `true`. Off Workers
    // `getCloudflareContext()` THROWS — exactly what it does on Docker.
    mockGetCfContext.mockImplementation(noCloudflareContext);
    expect(hasVectorizeBinding()).toBe(false);

    // On Workers, but the env is not a `CloudflareEnv` at all. A Vectorize
    // handle sitting on it changes nothing: without the bucket and the KV
    // namespace there is no deployment here to have an index.
    mockGetCfContext.mockReturnValue({ env: { YOPEDIA_VECTORIZE: { query: vi.fn() } } });
    expect(hasVectorizeBinding()).toBe(false);
  });

  it("rides the GET body as a boolean, resolved from the SAME env", async () => {
    // End to end through the real route, the way `embeddingProviderInEffect` is
    // pinned above: the env is the input, and the served field is the assertion.
    const { GET } = await import("@/app/api/settings/route");

    mockGetCfContext.mockReturnValue(cfEnv({ YOPEDIA_VECTORIZE: { query: vi.fn() } }));
    const bound = (await (await GET()).json()) as Record<string, unknown>;
    expect(bound.hasVectorizeBinding).toBe(true);

    // The SAME env with the one binding removed — the only thing that changed
    // is the runtime fact the route reads.
    mockGetCfContext.mockReturnValue(cfEnv());
    const unbound = (await (await GET()).json()) as Record<string, unknown>;
    expect(unbound.hasVectorizeBinding).toBe(false);
    // A BOOLEAN, not an absent field: `EmbeddingSettings` treats absent as
    // "nobody answered" and drops the clause either way, so a route that served
    // `undefined` here would look correct on screen while silently retiring the
    // "no index is bound" sentence this deployment has earned.
    expect(typeof unbound.hasVectorizeBinding).toBe("boolean");
  });

  it("is INDEPENDENT of the AI binding, in both directions", async () => {
    // The whole premise of DW-715: the hint used to state the index off the
    // resolved Workers AI provider alone. Both bindings are optional and neither
    // implies the other, so the route has to answer them separately.
    const { GET } = await import("@/app/api/settings/route");

    // Workers AI bound, no index — the deployment the old sentence lied about.
    mockGetCfContext.mockReturnValue(cfEnv({ AI: { run: vi.fn() } }));
    const aiOnly = (await (await GET()).json()) as Record<string, unknown>;
    expect(aiOnly.embeddingProviderInEffect).toBe("workers-ai");
    expect(aiOnly.hasVectorizeBinding).toBe(false);
    expect((aiOnly.workbench as { hasWorkersAiBinding: boolean }).hasWorkersAiBinding).toBe(
      true,
    );

    // …and the mirror image: an index bound with no Workers AI binding at all.
    mockGetCfContext.mockReturnValue(cfEnv({ YOPEDIA_VECTORIZE: { query: vi.fn() } }));
    const indexOnly = (await (await GET()).json()) as Record<string, unknown>;
    expect(indexOnly.hasVectorizeBinding).toBe(true);
    expect(
      (indexOnly.workbench as { hasWorkersAiBinding: boolean }).hasWorkersAiBinding,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One config, one answer about it (DW-312 / DW-313)
// ---------------------------------------------------------------------------

describe("both Settings surfaces answer the substitution question the same way", () => {
  it("agrees on the model IN EFFECT and on the overridden flag, for the same config", async () => {
    // DW-312. `getEffectiveSettings` feeds the flat `/settings` page and
    // `getWorkbenchSettings` feeds the Workbench canvas. Before this they
    // resolved the question from different places — one through
    // `getEmbeddingModelName`, the other not at all — so one deployment told an
    // owner two different things depending on which Settings screen they opened.
    process.env.OPENAI_API_KEY = "sk-env";

    // A substitution IS running: openai cannot serve a `@cf/` id, so the
    // resolver embeds with its own default instead.
    await store({ embeddingProvider: "openai", embeddingModel: "@cf/baai/bge-m3" });
    const substituting = getEffectiveSettings();
    expect(substituting.embeddingModel).toBe("@cf/baai/bge-m3");
    expect(substituting.embeddingModelInEffect).toBe("text-embedding-3-small");
    expect(substituting.embeddingModelOverridden).toBe(true);
    // THE DW-616 deployment, from the resolver rather than from a fixture: the
    // `@cf/` id is pinned and the provider embedding it is openai. `/settings`
    // reads this field to decide whether the Workers AI / Vectorize sentence is
    // true, and here it is not — the model id alone would have said it was.
    expect(substituting.embeddingProviderInEffect).toBe("openai");
    expect(getWorkbenchSettings(false)).toMatchObject({
      embeddingModelInEffect: substituting.embeddingModelInEffect,
      embeddingModelOverridden: substituting.embeddingModelOverridden,
    });

    // …and NOT running: the id is one the provider serves, so both surfaces
    // report the same model with nothing to announce.
    await store({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
    });
    const settled = getEffectiveSettings();
    expect(settled.embeddingModelInEffect).toBe("text-embedding-3-small");
    expect(settled.embeddingModelOverridden).toBe(false);
    expect(getWorkbenchSettings(false)).toMatchObject({
      embeddingModelInEffect: settled.embeddingModelInEffect,
      embeddingModelOverridden: settled.embeddingModelOverridden,
    });

    // …and with NOTHING embedding at all, the flag is false rather than "the
    // model you set is being substituted" — a different story entirely.
    delete process.env.OPENAI_API_KEY;
    await store({ embeddingProvider: "openai", embeddingModel: "@cf/baai/bge-m3" });
    const dark = getEffectiveSettings();
    expect(dark.embeddingSupport).toBe(false);
    expect(dark.embeddingModelInEffect).toBeNull();
    // Null EXACTLY when nothing embeds, which is the one condition the model
    // half is null under too — the model is resolved FROM the provider, so
    // there is no state where one is reported and the other is not (DW-616).
    expect(dark.embeddingProviderInEffect).toBeNull();
    expect(dark.embeddingModelOverridden).toBe(false);
    expect(getWorkbenchSettings(false)).toMatchObject({
      embeddingModelInEffect: null,
      embeddingModelOverridden: false,
    });
  });

  it("resolves BOTH halves against the same snapshot on a COLD cache (DW-313)", async () => {
    // `loadConfigSync()` is a 5 s-TTL cache that answers `{}` when cold. Both
    // resolvers open by reading it once; the question is whether the rest of
    // their answer is resolved against THAT read or against a fresh one. A
    // stored model reported from one snapshot beside an in-effect model
    // resolved from `{}` is a "set but not in effect" note about a substitution
    // that is not happening.
    process.env.OPENAI_API_KEY = "sk-env";
    await store({ embeddingProvider: "openai", embeddingModel: "@cf/baai/bge-m3" });

    // Cold: nothing has primed the cache, so the snapshot every leg sees is
    // `{}` — no stored model, and the env-detected openai default embedding.
    _resetConfigCache();
    const cold = getEffectiveSettings();
    expect(cold.embeddingModel).toBeNull();
    expect(cold.embeddingModelSource).toBe("none");
    expect(cold.embeddingModelInEffect).toBe("text-embedding-3-small");
    // Nothing is SET, so nothing is being substituted — the note is withheld
    // rather than describing an override the empty snapshot does not contain.
    expect(cold.embeddingModelOverridden).toBe(false);
    expect(cold.embeddingSupport).toBe(true);

    _resetConfigCache();
    expect(getWorkbenchSettings(false)).toMatchObject({
      embeddingModel: null,
      embeddingModelInEffect: "text-embedding-3-small",
      embeddingModelOverridden: false,
    });
  });

  it("SERVES the pair on the real route, GET and PUT (DW-312)", async () => {
    // End to end, because the library seam cannot see the wire. `route.ts` is
    // what puts `getWorkbenchSettings`'s object under `workbench`, and
    // `settings-route.test.ts` structurally cannot cover this — it mocks the
    // whole embeddings module, so the resolution it would be asserting is the
    // mock's. This file imports the real route and the real resolvers.
    process.env.OPENAI_API_KEY = "sk-env";
    await store({ embeddingProvider: "openai", embeddingModel: "@cf/baai/bge-m3" });

    const { GET, PUT } = await import("@/app/api/settings/route");
    const read = (await (await GET()).json()) as {
      embeddingModelInEffect: string | null;
      embeddingModelOverridden: boolean;
      workbench: {
        embeddingModel: string | null;
        embeddingModelInEffect: string | null;
        embeddingModelOverridden: boolean;
      };
    };
    // The stored id is still what the canvas box edits…
    expect(read.workbench.embeddingModel).toBe("@cf/baai/bge-m3");
    // …and beside it, what this deployment actually embeds with.
    expect(read.workbench.embeddingModelInEffect).toBe("text-embedding-3-small");
    expect(read.workbench.embeddingModelOverridden).toBe(true);
    // The flat page's own fields, on the same body, answering identically —
    // which is the whole of DW-312 as an owner would experience it.
    expect(read.embeddingModelInEffect).toBe(read.workbench.embeddingModelInEffect);
    expect(read.embeddingModelOverridden).toBe(read.workbench.embeddingModelOverridden);

    // …and a landed SAVE re-seeds them, because `PUT` serves the payload back
    // from a cache `saveConfig` has just re-primed. The save moves the stored id
    // to one openai CAN serve, so the substitution stops on the same response
    // that performed the write.
    const current = await readConfig();
    if (current.status !== "ok") throw new Error("store is unreadable");
    const saved = await PUT(
      new Request("http://local/api/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [IF_MATCH_HEADER]: formatIfMatch(current.version),
        },
        body: JSON.stringify({
          workbench: { embeddingModel: "text-embedding-3-small" },
        }),
      }),
    );
    expect(saved.status).toBe(200);
    const after = (await saved.json()) as {
      workbench: { embeddingModelInEffect: string | null; embeddingModelOverridden: boolean };
    };
    expect(after.workbench.embeddingModelInEffect).toBe("text-embedding-3-small");
    expect(after.workbench.embeddingModelOverridden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Deep Research provider, store and environment together (AD-18)
// ---------------------------------------------------------------------------
//
// `research-providers.test.ts` drives the resolver over a hand-built settings
// snapshot; this is the other half — that the SNAPSHOT is what the store and the
// environment actually produce, and that what crosses the wire carries booleans
// rather than keys. The two would agree on a bug in `getResearchSettings`
// otherwise.

describe("the Deep Research provider resolves from the same config the surface serves", () => {
  it("serves presence booleans and never a stored key (AD-23)", async () => {
    await store({
      researchProvider: "serpapi",
      tavilyApiKey: "tvly-stored",
      serpApiKey: "serp-stored",
      serpApiEngine: "bing",
      searxngBaseUrl: "https://searx.example",
      searxngCategories: "general,news",
    });

    const payload = getWorkbenchSettings(false);
    expect(payload).toMatchObject({
      researchProvider: "serpapi",
      hasTavilyApiKey: true,
      hasSerpApiKey: true,
      serpApiEngine: "bing",
      searxngBaseUrl: "https://searx.example",
      searxngCategories: "general,news",
      envResearchProvider: null,
      envResearchProviders: [],
    });
    // The whole serialized payload, because a leak is a leak wherever it rides.
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("tvly-stored");
    expect(wire).not.toContain("serp-stored");
  });

  it("resolves the stored selection, and refuses it when its key is missing", async () => {
    const { resolveResearchProvider, selectResearchProvider } = await import(
      "../research-providers"
    );

    // Selected with no credential: a THROW naming the provider, even though
    // another provider's key is sitting right there. No silent fallback.
    await store({ researchProvider: "searxng", tavilyApiKey: "tvly-stored" });
    expect(selectResearchProvider()).toBe("searxng");
    expect(() => resolveResearchProvider()).toThrow(/SearXNG/);

    // …and with SearXNG's own credential — its instance URL — it runs.
    await store({
      researchProvider: "searxng",
      tavilyApiKey: "tvly-stored",
      searxngBaseUrl: "https://searx.example",
    });
    expect(resolveResearchProvider()).toBe("searxng");
  });

  it("lets RESEARCH_PROVIDER win over the store, and says so on the wire", async () => {
    await store({ researchProvider: "tavily", tavilyApiKey: "tvly-stored" });
    process.env.RESEARCH_PROVIDER = "searxng";
    process.env.SEARXNG_BASE_URL = "https://env-searx.example";
    _resetConfigCache();
    await loadConfig();

    const { resolveResearchProvider } = await import("../research-providers");
    expect(resolveResearchProvider()).toBe("searxng");
    expect(getWorkbenchSettings(false)).toMatchObject({
      // The STORED selection is still what the box edits…
      researchProvider: "tavily",
      // …and the env override is served beside it, so the surface can say which
      // one will actually run. `Remove` is never offered for a variable no
      // route can delete, which is why the env URL rides in its own field.
      envResearchProvider: "searxng",
      envSearxngBaseUrl: "https://env-searx.example",
      searxngBaseUrl: null,
      envResearchProviders: ["searxng"],
    });
  });

  it("fails closed on a RESEARCH_PROVIDER nobody can correct in Settings", async () => {
    await store({ researchProvider: "tavily", tavilyApiKey: "tvly-stored" });
    process.env.RESEARCH_PROVIDER = "firecrawl";
    _resetConfigCache();
    await loadConfig();

    const { resolveResearchProvider } = await import("../research-providers");
    expect(() => resolveResearchProvider()).toThrow(/unsupported value/i);
    expect(getWorkbenchSettings(false).envResearchProvider).toBeNull();
    expect(getWorkbenchSettings(false).envResearchProviderInvalid).toBe("firecrawl");
  });

  it("takes an env key over a stored one, field by field", async () => {
    await store({ researchProvider: "tavily" });
    process.env.TAVILY_API_KEY = "tvly-env";
    process.env.SERPAPI_ENGINE = "duckduckgo";
    _resetConfigCache();
    await loadConfig();

    const { getResearchSettings } = await import("../config");
    expect(getResearchSettings()).toMatchObject({
      tavilyApiKey: "tvly-env",
      serpApiEngine: "duckduckgo",
    });
    // `hasTavilyApiKey` stays about the STORE, so Remove is never offered for a
    // key this route cannot delete — the rule the embedding key already follows.
    expect(getWorkbenchSettings(false)).toMatchObject({
      hasTavilyApiKey: false,
      envResearchProviders: ["tavily"],
    });
  });

  it("defaults the SerpApi engine to the value it used to hardcode", async () => {
    await store({ researchProvider: "serpapi", serpApiKey: "serp-stored" });
    const { getResearchSettings } = await import("../config");
    expect(getResearchSettings().serpApiEngine).toBe("google");
  });
});
