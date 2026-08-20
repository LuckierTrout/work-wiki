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
  getChatModelSettings,
  getEffectiveProvider,
  getEffectiveSettings,
  getVectorSearchSettings,
  getWorkbenchSettings,
  llmTimeoutOption,
  loadConfig,
  saveConfig,
  type AppConfig,
} from "../config";
import {
  getEmbeddingModel,
  getEmbeddingModelName,
  hasEmbeddingSupport,
} from "../embeddings";
import {
  callLLM,
  callLLMStream,
  callVisionLLM,
  getConfiguredModel,
  hasLLMKey,
} from "../llm";
import { _resetStorage } from "../storage";
import {
  SETTINGS_VECTOR_BINDING_ENV_NOTE,
  draftVectorInputs,
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
    expect(hasLLMKey()).toBe(true);

    await store({ provider: "custom", customApiKey: "sk-custom" });
    expect(hasLLMKey()).toBe(false);

    await store({ provider: "custom", customBaseUrl: "https://api.example/v1" });
    expect(hasLLMKey()).toBe(false);
  });

  it("does not report the literal string 'custom' as the active model", async () => {
    // `DEFAULT_MODELS.custom` is absent on purpose, so a `?? provider` fallback
    // would advertise a model named "custom" through /api/status and hand the
    // same string to the workload resolvers as an inherited model.
    await store({ provider: "custom", customApiKey: "s", customBaseUrl: "https://a/v1" });
    expect(getEffectiveProvider()).toMatchObject({
      configured: true,
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

    expect(hasLLMKey()).toBe(true);
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

    // …and the route, which re-runs the rule over the merged config, answers
    // with the very same sentence.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await turnVectorSearchOn());
    expect(response.status).toBe(400);
    const error = ((await response.json()) as { error: string }).error;
    expect(error).toBe(sentence);
    expect(error).toContain(
      "unset EMBEDDING_PROVIDER to choose another embedding provider",
    );
    // NOT the stored note's unconditional form — the advice this deployment
    // cannot follow while the variable is set.
    expect(error).not.toContain("or choose another embedding provider");
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
