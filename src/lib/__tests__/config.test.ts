import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  CONFIG_UNREADABLE_COPY,
  UNSTAMPED_CONFIG_VERSION,
  loadConfig,
  readConfig,
  newConfigVersion,
  saveConfig,
  loadConfigSync,
  isValidProvider,
  isReadOnly,
  getEffectiveProvider,
  getEffectiveSettings,
  getStructuredKnowledgeModelSettings,
  getResolvedCredentials,
  getWikiDir,
  getRawDir,
  getEmbeddingModelOverride,
  getOllamaBaseUrl,
  _resetConfigCache,
  type AppConfig,
} from "../config";
import { _resetStorage, getStorage } from "../storage";
import { WRITE_CONFLICT_COPY } from "../write-precondition";

// ---------------------------------------------------------------------------
// Helpers — use a temp dir so tests don't touch the real project root
// ---------------------------------------------------------------------------

let tmpDir: string;

// Save/restore all env vars that config.ts and llm.ts check
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = [
  "DATA_DIR",
  "WIKI_DIR",
  "RAW_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_MODEL",
  "EMBEDDING_MODEL",
  "EMBEDDING_PROVIDER",
  "YOPEDIA_READONLY",
  "STORAGE_PROVIDER",
];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-cfg-"));

  // Save all env vars
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  // Clear provider env vars so config-file tests are isolated
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.LLM_MODEL;
  delete process.env.EMBEDDING_PROVIDER;

  // Point config store at the temp dir
  process.env.DATA_DIR = tmpDir;

  // Always start with a fresh cache and storage singleton
  _resetConfigCache();
  _resetStorage();
});

afterEach(async () => {
  // Restore env vars
  for (const key of ENV_KEYS) {
    const val = savedEnv[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  _resetConfigCache();
  _resetStorage();

  // Clean up temp dir
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("returns {} when config file is missing", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual({});
  });

  it("returns parsed config from file", async () => {
    // Write config via saveConfig so storage provider is used
    await saveConfig({ provider: "openai", model: "gpt-4o" });
    _resetConfigCache();
    const cfg = await loadConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// readConfig — the honest read (DW-192) and the opaque stamp (DW-197)
// ---------------------------------------------------------------------------

const CONFIG_FILE = ".llm-wiki-config.json";
const VERSION_FILE = ".llm-wiki-config.version";

const FAULT = "the storage provider is unavailable";

/**
 * Reject every `writeFile` to a path ending in `suffix`; pass the rest through.
 *
 * The path-conditional `writeFile` spy `wikis.test.ts` already uses to observe
 * half-finished multi-file writes. Faulting ONE of `saveConfig`'s two writes is
 * the only way the order between them is observable at all — a test that reads
 * the source text instead passes for a `Promise.all` that has no order, and
 * fails for a refactor that changed nothing.
 */
function failWritesTo(suffix: string, message = FAULT) {
  const storage = getStorage();
  const write = storage.writeFile.bind(storage);
  return vi
    .spyOn(storage, "writeFile")
    .mockImplementation(async (target: string, content: string) => {
      if (target.endsWith(suffix)) return Promise.reject(new Error(message));
      return write(target, content);
    });
}

describe("readConfig", () => {
  it("answers `ok` with `{}` and the sentinel for a store with no files", async () => {
    // ABSENT is not broken: an empty config is the documented default, and a
    // first save has to be able to land against it.
    const read = await readConfig();
    expect(read).toEqual({
      status: "ok",
      config: {},
      version: UNSTAMPED_CONFIG_VERSION,
    });
  });

  it("answers `ok` with the config and the STORED token after a save", async () => {
    const stamped = await saveConfig({ provider: "openai" });
    const read = await readConfig();
    expect(read).toEqual({
      status: "ok",
      config: { provider: "openai" },
      version: stamped,
    });
  });

  it("answers the SENTINEL for a config with no token file", async () => {
    // Hand-written, restored from a backup, or created before this scheme.
    await saveConfig({ provider: "openai" });
    await fs.rm(path.join(tmpDir, VERSION_FILE));
    _resetConfigCache();
    const read = await readConfig();
    expect(read).toMatchObject({
      status: "ok",
      config: { provider: "openai" },
      version: UNSTAMPED_CONFIG_VERSION,
    });
  });

  it("treats an EMPTY token file as unstamped, so the next save heals it", async () => {
    await saveConfig({ provider: "openai" });
    await fs.writeFile(path.join(tmpDir, VERSION_FILE), "\n", "utf-8");
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({
      status: "ok",
      config: { provider: "openai" },
      version: UNSTAMPED_CONFIG_VERSION,
    });
    // …and the next save stamps a real one rather than leaving it broken.
    const healed = await saveConfig({ provider: "openai" });
    expect(healed).not.toBe(UNSTAMPED_CONFIG_VERSION);
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({ status: "ok", version: healed });
  });

  it("treats a MALFORMED token as unstamped rather than locking the owner out", async () => {
    // The token travels in `If-Match`, which carries one quoted value with no
    // embedded quote. A stamp holding a quote or a newline could never be sent
    // back, so honouring it verbatim would answer every save 428 forever with
    // no path out from any surface the owner can see.
    for (const corrupt of ['s1:"quoted"', "s1:not-hex", "w1:2-0000000000000000", "garbage\nlines"]) {
      await saveConfig({ provider: "openai" });
      await fs.writeFile(path.join(tmpDir, VERSION_FILE), corrupt + "\n", "utf-8");
      _resetConfigCache();
      expect(await readConfig()).toMatchObject({
        status: "ok",
        version: UNSTAMPED_CONFIG_VERSION,
      });
    }
  });

  it("answers `unreadable` for a config that is not valid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, CONFIG_FILE), "{ not json", "utf-8");
    _resetConfigCache();
    const read = await readConfig();
    expect(read.status).toBe("unreadable");
  });

  it("answers `unreadable` for JSON that is not an object", async () => {
    // `"x"`, `[]` and `null` are all valid JSON and none of them is a config;
    // spreading one into a merge base loses the whole store just as surely as
    // a read error does.
    for (const body of ['"x"', "[1,2]", "null", "42"]) {
      await fs.writeFile(path.join(tmpDir, CONFIG_FILE), body, "utf-8");
      _resetConfigCache();
      expect((await readConfig()).status).toBe("unreadable");
    }
  });

  it("answers `unreadable` when the CONFIG reads but the TOKEN does not", async () => {
    // A directory where the token file should be: the read fails with EISDIR,
    // which is not ENOENT, so the version the route would serve is a guess.
    await saveConfig({ provider: "openai" });
    await fs.rm(path.join(tmpDir, VERSION_FILE));
    await fs.mkdir(path.join(tmpDir, VERSION_FILE));
    _resetConfigCache();
    const read = await readConfig();
    expect(read.status).toBe("unreadable");
  });

  it("keeps `loadConfig`'s lossy `{}` contract for the same broken store", async () => {
    // ~50 call sites want defaults and cannot act on the difference. Only the
    // settings route needs it, and it calls `readConfig`.
    await fs.writeFile(path.join(tmpDir, CONFIG_FILE), "{ not json", "utf-8");
    _resetConfigCache();
    expect(await loadConfig()).toEqual({});
  });

  it("owns the unreadable sentence in ONE module, typed at no route site", async () => {
    // One wording for one fact, beside the read that produces it. A route that
    // typed its own would drift the moment a second door needed the same
    // refusal, and it is deliberately NOT the write-conflict wording: nothing
    // is known to have changed here.
    expect(typeof CONFIG_UNREADABLE_COPY).toBe("string");
    expect(CONFIG_UNREADABLE_COPY.length).toBeGreaterThan(0);
    expect(CONFIG_UNREADABLE_COPY).not.toBe(WRITE_CONFLICT_COPY);
    const route = await fs.readFile(
      path.join(process.cwd(), "src/app/api/settings/route.ts"),
      "utf-8",
    );
    expect(route).toContain("CONFIG_UNREADABLE_COPY");
    // The SENTENCE itself is nowhere in the route — only the constant's name.
    expect(route).not.toContain(CONFIG_UNREADABLE_COPY.slice(0, 40));
  });
});

describe("the settings precondition token", () => {
  it("ROTATES on every save, and is what the store then holds", async () => {
    const first = await saveConfig({ provider: "openai" });
    const second = await saveConfig({ provider: "openai" });
    // Same config, different token: nothing about the content produces it.
    expect(second).not.toBe(first);
    _resetConfigCache();
    const read = await readConfig();
    expect(read).toMatchObject({ status: "ok", version: second });
  });

  it("is derived from NOTHING in the config", async () => {
    // Two stores differing only in a stored API key can hold the same token —
    // which is only possible because no field contributes to it. A
    // content-derived version could not do this, and that is the AD-23 leak.
    const stamped = await saveConfig({ firecrawlApiKey: "fc-one" });
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ firecrawlApiKey: "fc-two" }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();
    const read = await readConfig();
    expect(read).toMatchObject({
      status: "ok",
      config: { firecrawlApiKey: "fc-two" },
      version: stamped,
    });

    // …and no stored value appears anywhere in a token.
    expect(stamped).not.toContain("fc-one");
    expect(newConfigVersion()).not.toBe(newConfigVersion());
    expect(newConfigVersion().startsWith("s1:")).toBe(true);
  });

  it("writes the TOKEN FILE BEFORE the config file", async () => {
    // The order is the safety property, and the only way to observe it is to
    // BREAK the second write and look at what the store is left holding. A
    // half-completed save must leave a token nobody holds — every open draft is
    // refused and recovers by reloading — rather than a token that still
    // matches a config which has already changed, which is the silent lost
    // update the guard exists to catch.
    const before = await saveConfig({ provider: "openai" });

    const spy = failWritesTo(CONFIG_FILE);
    try {
      await expect(saveConfig({ provider: "google" })).rejects.toThrow(FAULT);
    } finally {
      spy.mockRestore();
    }

    _resetConfigCache();
    const read = await readConfig();
    // The config write never landed, so the store still holds the old values…
    expect(read).toMatchObject({ status: "ok", config: { provider: "openai" } });
    // …but the token ALREADY moved, so the draft that was seeded before this
    // half-save can no longer match. That is the recoverable direction.
    expect(read).not.toMatchObject({ version: before });
  });

  it("lives in a SIBLING FILE, never inside the config", async () => {
    // `AppConfig` is spread into `getWorkbenchSettings`, exported in backups
    // and diffed field-by-field by the suite. The config's stored shape stays
    // exactly the fields it had.
    await saveConfig({ provider: "openai" });
    const raw = await fs.readFile(path.join(tmpDir, CONFIG_FILE), "utf-8");
    expect(JSON.parse(raw)).toEqual({ provider: "openai" });
    expect(raw).not.toContain("s1:");
    expect(
      (await fs.readFile(path.join(tmpDir, VERSION_FILE), "utf-8")).trim(),
    ).toMatch(/^s1:[0-9a-f]{32}$/);
  });

  it("PRIMES the sync cache with what it wrote", async () => {
    // It used to null the cache, which left `loadConfigSync` answering `{}` for
    // the whole 5 s TTL after every save — i.e. env-detected providers
    // immediately after the owner selected one.
    await saveConfig({ provider: "openai", model: "gpt-4o" });
    expect(loadConfigSync()).toMatchObject({ provider: "openai", model: "gpt-4o" });
  });
});

// ---------------------------------------------------------------------------
// saveConfig + loadConfig round-trip
// ---------------------------------------------------------------------------

describe("saveConfig / loadConfig round-trip", () => {
  it("persists and reads back the full config", async () => {
    const config: AppConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      structuredKnowledgeProvider: "openai",
      structuredKnowledgeModel: "gpt-4o",
      embeddingModel: "text-embedding-3-small",
    };
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
  });

  it("overwrites existing config", async () => {
    await saveConfig({ provider: "openai" });
    await saveConfig({ provider: "google" });
    const loaded = await loadConfig();
    expect(loaded.provider).toBe("google");
  });
});

// ---------------------------------------------------------------------------
// loadConfigSync
// ---------------------------------------------------------------------------

describe("loadConfigSync", () => {
  it("returns {} when config file is missing", () => {
    const cfg = loadConfigSync();
    expect(cfg).toEqual({});
  });

  it("reads config from cache after loadConfig primes it", async () => {
    await saveConfig({ provider: "openai", model: "gpt-4o" });
    // Prime the cache via async loadConfig
    await loadConfig();
    const cfg = loadConfigSync();
    expect(cfg.provider).toBe("openai");
  });

  it("caches results within TTL", async () => {
    await saveConfig({ provider: "openai" });
    // Prime the cache via async loadConfig
    await loadConfig();

    const first = loadConfigSync();
    expect(first.provider).toBe("openai");

    // Write a different value. `saveConfig` now PRIMES the cache with what it
    // wrote rather than nulling it, so the sync read would already see
    // "google" here — reset explicitly to exercise the cold-cache path below.
    await saveConfig({ provider: "google" });
    _resetConfigCache();

    // Cache is cold, so loadConfigSync returns {}
    const second = loadConfigSync();
    expect(second).toEqual({});

    // After priming with loadConfig, we get the new value
    await loadConfig();
    const third = loadConfigSync();
    expect(third.provider).toBe("google");
  });

  it("returns {} when cache is cold (no prior loadConfig)", () => {
    // This is the new behavior: cold cache returns {} instead of reading disk
    const cfg = loadConfigSync();
    expect(cfg).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// isValidProvider
// ---------------------------------------------------------------------------

describe("isValidProvider", () => {
  it("accepts valid providers", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("openai")).toBe(true);
    expect(isValidProvider("google")).toBe(true);
    expect(isValidProvider("ollama-cloud")).toBe(true);
    expect(isValidProvider("ollama")).toBe(true);
  });

  it("rejects invalid providers", () => {
    expect(isValidProvider("mistral")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("ANTHROPIC")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Merge priority: saved provider selection > env auto-detection fallback
// ---------------------------------------------------------------------------

describe("getEffectiveProvider — merge priority", () => {
  it("returns not configured when neither env nor config set", () => {
    const info = getEffectiveProvider();
    expect(info.configured).toBe(false);
    expect(info.provider).toBeNull();
  });

  it("uses config selection but remains unconfigured without credentials", async () => {
    await saveConfig({ provider: "openai", model: "gpt-4o-mini" });
    // Prime the sync cache so loadConfigSync returns data
    await loadConfig();

    const info = getEffectiveProvider();
    expect(info.configured).toBe(false);
    expect(info.provider).toBe("openai");
    expect(info.model).toBe("gpt-4o-mini");
  });

  it("saved provider selection wins when another provider key also exists", async () => {
    await saveConfig({ provider: "openai" });
    await loadConfig();
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
    process.env.OPENAI_API_KEY = "sk-openai-env-key";

    const info = getEffectiveProvider();
    expect(info.provider).toBe("openai");
    expect(info.configured).toBe(true);
  });

  it("supports selecting Google while several provider credentials coexist", async () => {
    await saveConfig({ provider: "google", model: "gemini-2.0-flash" });
    await loadConfig();
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
    process.env.OPENAI_API_KEY = "sk-openai-env-key";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-env-key";

    const info = getEffectiveProvider();
    expect(info).toMatchObject({
      provider: "google",
      model: "gemini-2.0-flash",
      configured: true,
    });
  });

  it("LLM_MODEL env var wins over config file model", async () => {
    await saveConfig({ provider: "openai", model: "gpt-4o-mini" });
    await loadConfig();
    process.env.LLM_MODEL = "gpt-4-turbo";

    const info = getEffectiveProvider();
    expect(info.model).toBe("gpt-4-turbo");
  });

  it("uses default model when neither env nor config specify one", async () => {
    await saveConfig({ provider: "anthropic" });
    await loadConfig();

    const info = getEffectiveProvider();
    expect(info.model).toBe("claude-sonnet-4-20250514");
  });
});

// ---------------------------------------------------------------------------
// getEffectiveSettings — source annotations
// ---------------------------------------------------------------------------

describe("getEffectiveSettings", () => {
  it("reports source as 'none' when apiKey only set via config file (no longer supported)", async () => {
    await saveConfig({ provider: "openai" });
    await loadConfig();

    const settings = getEffectiveSettings();
    expect(settings.providerSource).toBe("config");
    // API keys from config file are no longer supported — source should be 'none'
    expect(settings.apiKeySource).toBe("none");
    expect(settings.hasApiKey).toBe(false);
  });

  it("reports source as 'env' when set via env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key-1234567890";

    const settings = getEffectiveSettings();
    expect(settings.providerSource).toBe("env");
    expect(settings.apiKeySource).toBe("env");
  });

  it("reports the saved provider and its matching key with multiple keys present", async () => {
    await saveConfig({ provider: "google", model: "gemini-2.0-flash" });
    await loadConfig();
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key-1234567890";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-env-key";

    const settings = getEffectiveSettings();
    expect(settings.provider).toBe("google");
    expect(settings.providerSource).toBe("config");
    expect(settings.apiKeySource).toBe("env");
    expect(settings.hasApiKey).toBe(true);
    expect(settings.configured).toBe(true);
  });

  it("detects Ollama Cloud from OLLAMA_API_KEY", () => {
    process.env.OLLAMA_API_KEY = "ollama-test-key";

    const settings = getEffectiveSettings();
    expect(settings.provider).toBe("ollama-cloud");
    expect(settings.providerSource).toBe("env");
    expect(settings.model).toBe("gpt-oss:120b");
    expect(settings.hasApiKey).toBe(true);
    expect(settings.ollamaBaseUrl).toBe("https://ollama.com/api");
  });

  it("reports source as 'none' when nothing is set", () => {
    const settings = getEffectiveSettings();
    expect(settings.providerSource).toBe("none");
    expect(settings.apiKeySource).toBe("none");
    expect(settings.configured).toBe(false);
  });

  it("reports model source as 'default' when using defaults", async () => {
    await saveConfig({ provider: "anthropic" });
    await loadConfig();

    const settings = getEffectiveSettings();
    expect(settings.modelSource).toBe("default");
    expect(settings.model).toBe("claude-sonnet-4-20250514");
  });

  it("reports an env-set embedding model as 'env'", () => {
    process.env.EMBEDDING_MODEL = "text-embedding-3-large";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBe("text-embedding-3-large");
    expect(settings.embeddingModelSource).toBe("env");
  });

  it("does NOT report a whitespace-only EMBEDDING_MODEL as env-sourced (DW-227)", () => {
    // Reporting `"   "` as the env-sourced model told the owner a model name
    // that nothing would ever embed with, on a surface whose whole job is to
    // say where the effective value came from.
    process.env.EMBEDDING_MODEL = "   ";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModelSource).not.toBe("env");
    expect(settings.embeddingModelSource).toBe("none");
    expect(settings.embeddingModel).toBeNull();
  });

  it("does NOT report a whitespace-only STORED embedding model as config-sourced", async () => {
    // The config leg of the same DW-227 split. A blank stored value is reachable
    // from a pre-change flat write or a hand-edited config, and reporting it as
    // the config-sourced model contradicts `resolveEmbeddingModelName`, which
    // trims it away and embeds with the provider default.
    await saveConfig({ embeddingModel: "   " });
    await loadConfig();

    const settings = getEffectiveSettings();
    expect(settings.embeddingModelSource).not.toBe("config");
    expect(settings.embeddingModelSource).toBe("none");
    expect(settings.embeddingModel).toBeNull();
  });

  it("lets the STORED embedding model win over a blank env override", async () => {
    await saveConfig({ embeddingModel: "nomic-embed-text" });
    await loadConfig();
    process.env.EMBEDDING_MODEL = " ";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBe("nomic-embed-text");
    expect(settings.embeddingModelSource).toBe("config");
  });
});

// ---------------------------------------------------------------------------
// Structured Knowledge workload routing
// ---------------------------------------------------------------------------

describe("getStructuredKnowledgeModelSettings", () => {
  it("inherits the primary provider and model when no workload override exists", async () => {
    await saveConfig({ provider: "ollama-cloud", model: "gpt-oss:120b" });
    await loadConfig();
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";

    expect(getStructuredKnowledgeModelSettings()).toEqual({
      provider: "ollama-cloud",
      providerSource: "default",
      model: "gpt-oss:120b",
      modelSource: "default",
      configured: true,
      usesPrimary: true,
    });
  });

  it("routes extraction independently through its configured provider and model", async () => {
    await saveConfig({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      structuredKnowledgeProvider: "openai",
      structuredKnowledgeModel: "gpt-4o",
    });
    await loadConfig();
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    process.env.OPENAI_API_KEY = "openai-key";

    expect(getStructuredKnowledgeModelSettings()).toEqual({
      provider: "openai",
      providerSource: "config",
      model: "gpt-4o",
      modelSource: "config",
      configured: true,
      usesPrimary: false,
    });
  });

  it("uses the workload provider default when only that provider is selected", async () => {
    await saveConfig({
      provider: "ollama-cloud",
      structuredKnowledgeProvider: "openai",
    });
    await loadConfig();
    process.env.OPENAI_API_KEY = "openai-key";

    const settings = getStructuredKnowledgeModelSettings();
    expect(settings.model).toBe("gpt-4o");
    expect(settings.modelSource).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// getResolvedCredentials
// ---------------------------------------------------------------------------

describe("getResolvedCredentials", () => {
  it("returns null provider when nothing configured", () => {
    const creds = getResolvedCredentials();
    expect(creds.provider).toBeNull();
    expect(creds.apiKey).toBeNull();
  });

  it("resolves credentials from config file (provider + model only, no apiKey)", async () => {
    await saveConfig({ provider: "openai", model: "gpt-4o-mini" });
    await loadConfig();

    const creds = getResolvedCredentials();
    expect(creds.provider).toBe("openai");
    // API key no longer comes from config — must be set via env
    expect(creds.apiKey).toBeNull();
    expect(creds.model).toBe("gpt-4o-mini");
  });

  it("env api key is the only source for api keys", async () => {
    await saveConfig({ provider: "openai" });
    await loadConfig();
    process.env.OPENAI_API_KEY = "sk-env-key";

    const creds = getResolvedCredentials();
    expect(creds.apiKey).toBe("sk-env-key");
  });

  it("uses the credential matching the saved provider when multiple keys exist", async () => {
    await saveConfig({ provider: "openai", model: "gpt-4o-mini" });
    await loadConfig();
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
    process.env.OPENAI_API_KEY = "sk-openai-env-key";

    const creds = getResolvedCredentials();
    expect(creds).toMatchObject({
      provider: "openai",
      apiKey: "sk-openai-env-key",
      model: "gpt-4o-mini",
    });
  });

  it("resolves ollama base url from config", async () => {
    await saveConfig({ provider: "ollama", ollamaBaseUrl: "http://myhost:11434/api" });
    await loadConfig();

    const creds = getResolvedCredentials();
    expect(creds.provider).toBe("ollama");
    expect(creds.ollamaBaseUrl).toBe("http://myhost:11434/api");
    expect(creds.apiKey).toBeNull();
  });

  it("resolves Ollama Cloud credentials from the server secret", () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";

    const creds = getResolvedCredentials();
    expect(creds).toMatchObject({
      provider: "ollama-cloud",
      apiKey: "ollama-cloud-key",
      model: "gpt-oss:120b",
      ollamaBaseUrl: "https://ollama.com/api",
    });
  });

  it("detects deepseek from DEEPSEEK_API_KEY with its default model", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-key";

    const creds = getResolvedCredentials();
    expect(creds.provider).toBe("deepseek");
    expect(creds.apiKey).toBe("sk-ds-key");
    // Falls back to DEFAULT_MODELS["deepseek"] when no override is set.
    expect(creds.model).toBe("deepseek-v4-flash");
  });

  it("honors LLM_MODEL override for deepseek (e.g. v4-pro)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-key";
    process.env.LLM_MODEL = "deepseek-v4-pro";

    const creds = getResolvedCredentials();
    expect(creds.provider).toBe("deepseek");
    expect(creds.model).toBe("deepseek-v4-pro");
  });
});

// ---------------------------------------------------------------------------
// getWikiDir / getRawDir — centralised directory resolution
// ---------------------------------------------------------------------------

describe("getWikiDir", () => {
  it("returns default path when no WIKI_DIR env var set", () => {
    delete process.env.WIKI_DIR;
    const dir = getWikiDir();
    expect(dir).toBe(path.join(tmpDir, "wiki"));
  });

  it("respects WIKI_DIR env override", () => {
    process.env.WIKI_DIR = "/custom/wiki-path";
    const dir = getWikiDir();
    expect(dir).toBe("/custom/wiki-path");
  });
});

describe("getRawDir", () => {
  it("returns default path when no RAW_DIR env var set", () => {
    delete process.env.RAW_DIR;
    const dir = getRawDir();
    expect(dir).toBe(path.join(tmpDir, "raw"));
  });

  it("respects RAW_DIR env override", () => {
    process.env.RAW_DIR = "/custom/raw-path";
    const dir = getRawDir();
    expect(dir).toBe("/custom/raw-path");
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingModelOverride
// ---------------------------------------------------------------------------

describe("getEmbeddingModelOverride", () => {
  it("returns undefined when EMBEDDING_MODEL is not set", () => {
    delete process.env.EMBEDDING_MODEL;
    expect(getEmbeddingModelOverride()).toBeUndefined();
  });

  it("returns the env value when EMBEDDING_MODEL is set", () => {
    process.env.EMBEDDING_MODEL = "text-embedding-ada-002";
    expect(getEmbeddingModelOverride()).toBe("text-embedding-ada-002");
  });

  it("treats an EMPTY EMBEDDING_MODEL as unset (DW-227)", () => {
    // `EMBEDDING_MODEL=` in a compose file is a variable someone declared and
    // left blank, not a model called "". The vector gate has always read it
    // this way; the resolver used to hand the blank string to the provider.
    process.env.EMBEDDING_MODEL = "";
    expect(getEmbeddingModelOverride()).toBeUndefined();
  });

  it("treats a WHITESPACE-ONLY EMBEDDING_MODEL as unset", () => {
    process.env.EMBEDDING_MODEL = "   ";
    expect(getEmbeddingModelOverride()).toBeUndefined();
  });

  it("TRIMS a padded value, so the gate and the resolver see one string", () => {
    // DW-221: the gate trims, so a padded value used to be accepted there and
    // dropped by the resolver, which compared the raw string.
    process.env.EMBEDDING_MODEL = "  @cf/baai/bge-m3  ";
    expect(getEmbeddingModelOverride()).toBe("@cf/baai/bge-m3");
  });
});

// ---------------------------------------------------------------------------
// getOllamaBaseUrl
// ---------------------------------------------------------------------------

describe("getOllamaBaseUrl", () => {
  it("returns undefined when neither env nor config set", () => {
    expect(getOllamaBaseUrl()).toBeUndefined();
  });

  it("returns env var value when OLLAMA_BASE_URL is set", () => {
    process.env.OLLAMA_BASE_URL = "http://env-host:11434";
    expect(getOllamaBaseUrl()).toBe("http://env-host:11434");
  });

  it("returns config file value when env var is not set", async () => {
    await saveConfig({ ollamaBaseUrl: "http://config-host:11434" });
    // Prime cache so loadConfigSync picks it up
    await loadConfig();
    expect(getOllamaBaseUrl()).toBe("http://config-host:11434");
  });

  it("env var wins over config file value", async () => {
    await saveConfig({ ollamaBaseUrl: "http://config-host:11434" });
    await loadConfig();
    process.env.OLLAMA_BASE_URL = "http://env-host:11434";
    expect(getOllamaBaseUrl()).toBe("http://env-host:11434");
  });
});

// ---------------------------------------------------------------------------
// isReadOnly
// ---------------------------------------------------------------------------

describe("isReadOnly", () => {
  it("returns false by default", () => {
    delete process.env.YOPEDIA_READONLY;
    delete process.env.STORAGE_PROVIDER;
    expect(isReadOnly()).toBe(false);
  });

  it("returns true when YOPEDIA_READONLY=1", () => {
    process.env.YOPEDIA_READONLY = "1";
    expect(isReadOnly()).toBe(true);
  });

  it("returns false when YOPEDIA_READONLY is set to something other than 1", () => {
    process.env.YOPEDIA_READONLY = "0";
    expect(isReadOnly()).toBe(false);
  });

  it("does not become read-only merely because storage is Cloudflare R2", () => {
    process.env.STORAGE_PROVIDER = "cloudflare-r2";
    expect(isReadOnly()).toBe(false);
  });

  it("returns false when STORAGE_PROVIDER=fs", () => {
    process.env.STORAGE_PROVIDER = "fs";
    expect(isReadOnly()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEffectiveSettings — readOnly flag
// ---------------------------------------------------------------------------

describe("getEffectiveSettings readOnly", () => {
  it("includes readOnly: false by default", () => {
    delete process.env.YOPEDIA_READONLY;
    delete process.env.STORAGE_PROVIDER;
    const s = getEffectiveSettings();
    expect(s.readOnly).toBe(false);
  });

  it("includes readOnly: true when YOPEDIA_READONLY=1", () => {
    process.env.YOPEDIA_READONLY = "1";
    const s = getEffectiveSettings();
    expect(s.readOnly).toBe(true);
  });
});
