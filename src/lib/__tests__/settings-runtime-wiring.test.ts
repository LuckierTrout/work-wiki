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

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "DATA_DIR",
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
    expect(getWorkbenchSettings().envEmbeddingApiKeyProviders).toEqual([]);

    process.env.OPENAI_API_KEY = "sk-env";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings().envEmbeddingApiKeyProviders).toEqual(["openai"]);

    // Set-but-empty is not a credential.
    process.env.OPENAI_API_KEY = "";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-env";
    _resetConfigCache();
    await loadConfig();
    expect(getWorkbenchSettings().envEmbeddingApiKeyProviders).toEqual(["google"]);
  });

  it("keeps `hasEmbeddingApiKey` about the STORE, so Remove is never offered for an env key", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    await store({ embeddingProvider: "openai" });
    expect(getWorkbenchSettings().hasEmbeddingApiKey).toBe(false);

    await store({ embeddingProvider: "openai", embeddingApiKey: "sk-stored" });
    expect(getWorkbenchSettings().hasEmbeddingApiKey).toBe(true);
  });
});
