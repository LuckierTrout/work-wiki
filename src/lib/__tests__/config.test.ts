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
  detectEnvProvider,
  DEFAULT_MODELS,
  applyWorkbenchSettings,
  _resetConfigCache,
  _resetConfigWarnings,
  type AppConfig,
} from "../config";
import { _resetStorage } from "../storage";
import { logger } from "../logger";
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
  _resetConfigWarnings();
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

/**
 * The file the RETIRED two-file scheme kept the token in (DW-272).
 *
 * Named here only so the migration case can leave one lying around: a store
 * written by that scheme has a config with no embedded token and a stale sibling
 * beside it, and nothing may read the sibling ever again.
 */
const LEGACY_VERSION_FILE = ".llm-wiki-config.version";

/** The reserved key the token now rides under, INSIDE the config object. */
const VERSION_KEY = "__settingsVersion";

/** Read the stored object as it is on disk, token key and all. */
async function readRawStore(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(tmpDir, CONFIG_FILE), "utf-8"));
}

/** `saveConfig`'s token, for a save the test expects to land. */
async function stamp(config: AppConfig, ifMatch?: string | null): Promise<string> {
  const save = await saveConfig(config, ifMatch);
  if (save.status !== "ok") throw new Error(`expected the save to land, got ${save.status}`);
  return save.version;
}

describe("readConfig", () => {
  it("answers `ok` with `{}` and the sentinel for a store with no config", async () => {
    // ABSENT is not broken: an empty config is the documented default, and a
    // first save has to be able to land against it. No object means no etag —
    // there are no bytes to compare a write against.
    const read = await readConfig();
    expect(read).toEqual({
      status: "ok",
      config: {},
      version: UNSTAMPED_CONFIG_VERSION,
      etag: null,
    });
  });

  it("answers `ok` with the config and the STORED token after a save", async () => {
    const stamped = await stamp({ provider: "openai" });
    const read = await readConfig();
    expect(read).toMatchObject({
      status: "ok",
      config: { provider: "openai" },
      version: stamped,
    });
    // …and an etag to write against, which an existing object always has.
    expect(read.status === "ok" && read.etag).toBeTruthy();
  });

  it("answers the SENTINEL for a config with no embedded token", async () => {
    // Hand-written, restored from a backup, or written by the two-file scheme.
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ provider: "openai" }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({
      status: "ok",
      config: { provider: "openai" },
      version: UNSTAMPED_CONFIG_VERSION,
    });
  });

  it("MIGRATES a two-file store: reads it, then saves ONE object carrying a token", async () => {
    // What every deployment written by the previous scheme looks like on disk:
    // a config with no token key, and a stale sibling holding the stamp. The
    // read must succeed against it — refusing would strand the owner — and the
    // save that follows must leave one object behind.
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ provider: "openai", firecrawlApiKey: "fc-one" }, null, 2) + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(tmpDir, LEGACY_VERSION_FILE),
      "s1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "utf-8",
    );
    _resetConfigCache();

    const read = await readConfig();
    expect(read).toMatchObject({
      status: "ok",
      config: { provider: "openai", firecrawlApiKey: "fc-one" },
      // The sibling is NOT read: a migrated store is unstamped until its next
      // save, and the token it used to hold is not this scheme's to honour.
      version: UNSTAMPED_CONFIG_VERSION,
    });

    const healed = await stamp(
      { provider: "openai", firecrawlApiKey: "fc-one" },
      read.status === "ok" ? read.etag : null,
    );
    expect(healed).toMatch(/^s1:[0-9a-f]{32}$/);
    expect(await readRawStore()).toEqual({
      provider: "openai",
      firecrawlApiKey: "fc-one",
      [VERSION_KEY]: healed,
    });
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({ status: "ok", version: healed });

    // The orphan sibling is NOT swept. `config.ts` promises this — deleting a
    // file the owner did not ask about is not that module's business, and an
    // unread file costs nothing — so a future `deleteFile` cleanup should break
    // a test rather than a promise.
    expect(
      await fs.readFile(path.join(tmpDir, LEGACY_VERSION_FILE), "utf-8"),
    ).toContain("s1:aaaaaaaa");
  });

  it("treats a MALFORMED embedded token as unstamped rather than locking the owner out", async () => {
    // The token travels in `If-Match`, which carries one quoted value with no
    // embedded quote. A stamp holding a quote or a newline could never be sent
    // back, so honouring it verbatim would answer every save 428 forever with
    // no path out from any surface the owner can see.
    for (const corrupt of ['s1:"quoted"', "s1:not-hex", "w1:2-0000000000000000", "garbage\nlines", "", 42, null]) {
      await fs.writeFile(
        path.join(tmpDir, CONFIG_FILE),
        JSON.stringify({ provider: "openai", [VERSION_KEY]: corrupt }, null, 2) + "\n",
        "utf-8",
      );
      _resetConfigCache();
      expect(await readConfig()).toMatchObject({
        status: "ok",
        config: { provider: "openai" },
        version: UNSTAMPED_CONFIG_VERSION,
      });
    }

    // …and the next save HEALS it rather than leaving it broken.
    const healed = await stamp({ provider: "openai" });
    expect(healed).not.toBe(UNSTAMPED_CONFIG_VERSION);
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({ status: "ok", version: healed });
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

  it("answers `unreadable` for a storage failure that is not 'not found'", async () => {
    // A directory where the config file should be: the read fails with EISDIR,
    // which is not ENOENT, so `{}` would be a lie about a store that exists.
    await fs.mkdir(path.join(tmpDir, CONFIG_FILE));
    _resetConfigCache();
    expect((await readConfig()).status).toBe("unreadable");
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
    const first = await stamp({ provider: "openai" });
    const read = await readConfig();
    const second = await stamp(
      { provider: "openai" },
      read.status === "ok" ? read.etag : null,
    );
    // Same config, different token: nothing about the content produces it.
    expect(second).not.toBe(first);
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({ status: "ok", version: second });
  });

  it("is derived from NOTHING in the config", async () => {
    // Two stores differing only in a stored API key can hold the same token —
    // which is only possible because no field contributes to it. A
    // content-derived version could not do this, and that is the AD-23 leak.
    const stamped = await stamp({ firecrawlApiKey: "fc-one" });
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ firecrawlApiKey: "fc-two", [VERSION_KEY]: stamped }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({
      status: "ok",
      config: { firecrawlApiKey: "fc-two" },
      version: stamped,
    });

    // …and no stored value appears anywhere in a token.
    expect(stamped).not.toContain("fc-one");
    expect(newConfigVersion()).not.toBe(newConfigVersion());
    expect(newConfigVersion().startsWith("s1:")).toBe(true);
  });

  it("lives INSIDE the config object, and is STRIPPED on the way out", async () => {
    // One object, one read — no pairing for a backend to get wrong (DW-272).
    // But `AppConfig` is spread into `getWorkbenchSettings`, exported in
    // backups and diffed field-by-field by the suite, so what a caller gets
    // back is exactly the fields it stored and nothing else.
    const stamped = await stamp({ provider: "openai" });
    expect(await readRawStore()).toEqual({
      provider: "openai",
      [VERSION_KEY]: stamped,
    });
    expect(stamped).toMatch(/^s1:[0-9a-f]{32}$/);

    _resetConfigCache();
    expect(await loadConfig()).toEqual({ provider: "openai" });
    expect(loadConfigSync()).toEqual({ provider: "openai" });
    const read = await readConfig();
    expect(read.status === "ok" && read.config).toEqual({ provider: "openai" });
  });

  it("REFUSES a save whose compare-and-set lost, and writes nothing", async () => {
    // The window the route's `If-Match` check cannot see: this request read its
    // merge base, another writer landed, and this request is now about to write
    // values seeded before that save. `writeFileIfMatch` refuses instead.
    await stamp({ provider: "openai" });
    const read = await readConfig();
    expect(read.status).toBe("ok");
    const etag = read.status === "ok" ? read.etag : null;

    // The other writer lands between this request's read and its write.
    const other = await stamp({ provider: "google" });

    const lost = await saveConfig({ provider: "anthropic" }, etag);
    expect(lost).toEqual({ status: "conflict" });

    // The store still holds the OTHER writer's value, untouched.
    _resetConfigCache();
    expect(await readConfig()).toMatchObject({
      status: "ok",
      config: { provider: "google" },
      version: other,
    });
  });

  it("writes UNCONDITIONALLY with no etag, which is the FIRST save only", async () => {
    // `readConfig` answers `etag: null` exactly when there was no object to
    // read. The storage interface exposes no if-none-match, so two concurrent
    // first writes both land and the last wins — one save, on a store that has
    // never been written. It is written down rather than pretended away.
    const read = await readConfig();
    expect(read).toMatchObject({ status: "ok", etag: null });
    const version = await stamp({ provider: "openai" }, read.status === "ok" ? read.etag : null);
    expect(await readRawStore()).toEqual({ provider: "openai", [VERSION_KEY]: version });
  });

  it("STRIPS a reserved key the caller handed in, from the store AND the cache", async () => {
    // `readStoredConfig` strips it, so no ordinary caller carries one — but a
    // `PUT` body naming the key reaches the merge. Whatever it says, the token
    // written is the fresh one, and the cache is primed with the same object a
    // re-read produces rather than one carrying a key that re-read removes.
    const version = await stamp({
      provider: "openai",
      [VERSION_KEY]: "s1:cccccccccccccccccccccccccccccccc",
    } as AppConfig);

    expect(version).not.toBe("s1:cccccccccccccccccccccccccccccccc");
    expect(await readRawStore()).toEqual({
      provider: "openai",
      [VERSION_KEY]: version,
    });
    expect(loadConfigSync()).toEqual({ provider: "openai" });
    _resetConfigCache();
    expect(await loadConfig()).toEqual({ provider: "openai" });
    expect(await readConfig()).toMatchObject({ status: "ok", version });
  });

  it("PRIMES the sync cache with what it wrote", async () => {
    // It used to null the cache, which left `loadConfigSync` answering `{}` for
    // the whole 5 s TTL after every save — i.e. env-detected providers
    // immediately after the owner selected one.
    await saveConfig({ provider: "openai", model: "gpt-4o" });
    expect(loadConfigSync()).toMatchObject({ provider: "openai", model: "gpt-4o" });
    // …and NOT with the reserved key, so a sync reader sees the same shape an
    // async one does.
    expect(loadConfigSync()).not.toHaveProperty(VERSION_KEY);
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

  it("reports embeddingSupport, resolved against the same config it reports the provider from", async () => {
    // No test in this suite read `embeddingSupport` at all before, on the one
    // `ProviderInfo` object `/api/status`, `POST /api/settings/test` and the
    // `effective` field of `PUT /api/settings` all serve.
    //
    // It also has to be resolved from the `cfg` this function already read
    // rather than from a second `loadConfigSync()` (DW-313): `loadConfigSync`
    // is a 5 s-TTL cache, so re-entering it would let "which provider is
    // active" and "can it embed?" describe two different snapshots on one
    // object.
    await saveConfig({ provider: "openai", model: "gpt-4o-mini" });
    await loadConfig();
    process.env.OPENAI_API_KEY = "sk-openai-env-key";

    expect(getEffectiveProvider()).toMatchObject({
      provider: "openai",
      configured: true,
      // openai can embed, and with the key present the resolver reaches a model.
      embeddingSupport: true,
    });

    // Take the credential away and the SAME object reports both halves of the
    // new answer: still the owner's selection, no longer able to embed.
    delete process.env.OPENAI_API_KEY;
    _resetConfigCache();
    await loadConfig();
    expect(getEffectiveProvider()).toMatchObject({
      provider: "openai",
      embeddingSupport: false,
    });
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

  it("reports the ollama endpoint and its source from the ONE ladder (DW-326)", async () => {
    // The badge beside this value on `/settings` is the whole point: it has to
    // say where the endpoint that is ACTUALLY in effect came from.
    await saveConfig({ provider: "ollama", ollamaBaseUrl: "http://stored:11434" });
    await loadConfig();
    expect(getEffectiveSettings()).toMatchObject({
      ollamaBaseUrl: "http://stored:11434",
      ollamaBaseUrlSource: "config",
    });

    process.env.OLLAMA_BASE_URL = "http://from-env:11434";
    expect(getEffectiveSettings()).toMatchObject({
      ollamaBaseUrl: "http://from-env:11434",
      ollamaBaseUrlSource: "env",
    });
  });

  it("does NOT report an unusable OLLAMA_BASE_URL as the endpoint in effect", async () => {
    // `ProviderForm` renders this value beside an env/config badge. Reporting a
    // variable the runtime discards told the owner their deployment talks to an
    // endpoint nothing talks to — the same surface/runtime disagreement DW-71
    // closes for the Custom endpoint on the other Settings screen.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await saveConfig({ provider: "ollama", ollamaBaseUrl: "http://stored:11434" });
      await loadConfig();
      process.env.OLLAMA_BASE_URL = "localhost:11434";

      // The stored endpoint is what applies, and the badge says so.
      expect(getEffectiveSettings()).toMatchObject({
        ollamaBaseUrl: "http://stored:11434",
        ollamaBaseUrlSource: "config",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("reports 'none' when the STORED ollama endpoint is unusable too", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await saveConfig({ provider: "ollama", ollamaBaseUrl: "file:///etc/passwd" });
      await loadConfig();

      expect(getEffectiveSettings()).toMatchObject({
        ollamaBaseUrl: null,
        ollamaBaseUrlSource: "none",
      });
    } finally {
      warn.mockRestore();
    }
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

  // -------------------------------------------------------------------------
  // What is SET vs what is IN EFFECT (DW-274)
  //
  // `resolveEmbeddingModelName` applies `embeddingModelMatchesProvider` before
  // honouring a model name, so the model this page reports as "set" is not
  // always the model that embeds. These rows pin the second half of the answer.
  //
  // The Workers AI direction of the predicate is unreachable from this file —
  // nothing here mocks `@opennextjs/cloudflare`, so `getWorkersAiBinding()`
  // always returns null. The literal DW-274 scenario lives in
  // `settings-runtime-wiring.test.ts`, which does mock it; every row here uses
  // the other direction (a `@cf/` id under a non-Workers provider).
  // -------------------------------------------------------------------------

  it("names the model actually embedding when a STORED model is substituted", async () => {
    // Ollama cannot serve a `@cf/` id, so the resolver drops it for the ollama
    // default — while the box, and the source badge beside it, go on truthfully
    // saying what the owner stored.
    delete process.env.EMBEDDING_MODEL;
    await saveConfig({
      embeddingProvider: "ollama",
      embeddingModel: "@cf/baai/bge-m3",
    });
    await loadConfig();

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBe("@cf/baai/bge-m3");
    expect(settings.embeddingModelSource).toBe("config");
    expect(settings.embeddingModelInEffect).toBe("nomic-embed-text");
    expect(settings.embeddingModelOverridden).toBe(true);
    expect(settings.embeddingSupport).toBe(true);
  });

  it("reports no override when the set model IS the one embedding", async () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-env-key";
    process.env.EMBEDDING_MODEL = "text-embedding-3-large";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBe("text-embedding-3-large");
    expect(settings.embeddingModelSource).toBe("env");
    expect(settings.embeddingModelInEffect).toBe("text-embedding-3-large");
    expect(settings.embeddingModelOverridden).toBe(false);
  });

  it("names the provider default in effect when no model is set at all", () => {
    // Nothing is SET, so there is nothing to override — but something IS
    // embedding, and this is the field that says what.
    delete process.env.EMBEDDING_MODEL;
    process.env.OPENAI_API_KEY = "sk-env-key";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBeNull();
    expect(settings.embeddingModelSource).toBe("none");
    expect(settings.embeddingModelInEffect).toBe("text-embedding-3-small");
    expect(settings.embeddingModelOverridden).toBe(false);
  });

  it("does NOT call a model an override when nothing embeds at all", () => {
    // No key, no binding, no stored provider: `getEmbeddingModelName()` is
    // null. That is the `embeddingSupport: false` story — "your model is being
    // substituted" would be a different and untrue sentence.
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBe("text-embedding-3-small");
    expect(settings.embeddingModelSource).toBe("env");
    expect(settings.embeddingModelInEffect).toBeNull();
    expect(settings.embeddingModelOverridden).toBe(false);
    expect(settings.embeddingSupport).toBe(false);
  });

  it("reads BOTH halves off the same env-over-config winner", async () => {
    // Env and store hold DIFFERENT model names, and the env one is the
    // mismatch. Every other row sets one leg or the other, so none of them can
    // catch the two halves disagreeing about which value they are describing:
    // a reported pair built from the env leg beside an in-effect value compared
    // against the stored leg would render "nomic-embed-text is not in effect"
    // — about a value nothing is currently using — while the box shows the env
    // name. The precedence is `getEmbeddingModelOverride()` first for the
    // report and `nonEmpty(env) ?? nonEmpty(cfg)` for the resolver, and this is
    // what pins them to the same answer.
    await saveConfig({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    });
    await loadConfig();
    process.env.EMBEDDING_MODEL = "@cf/baai/bge-m3";

    const settings = getEffectiveSettings();
    // The env value wins the report, as it always did…
    expect(settings.embeddingModel).toBe("@cf/baai/bge-m3");
    expect(settings.embeddingModelSource).toBe("env");
    // …and the override the resolver weighed is that SAME env value, which
    // ollama cannot serve — so the substitution reported is the env one's, not
    // the stored one's (which ollama serves perfectly well).
    expect(settings.embeddingModelInEffect).toBe("nomic-embed-text");
    expect(settings.embeddingModelOverridden).toBe(true);
  });

  it("leaves the DW-227 whitespace answers exactly as they were", () => {
    // A blank override is "not set", on BOTH halves of the answer: the
    // resolver trims it away and embeds with the provider default, so there is
    // no substitution to report either.
    process.env.EMBEDDING_MODEL = "   ";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-env-key";

    const settings = getEffectiveSettings();
    expect(settings.embeddingModel).toBeNull();
    expect(settings.embeddingModelSource).toBe("none");
    expect(settings.embeddingModelInEffect).toBe("text-embedding-3-small");
    expect(settings.embeddingModelOverridden).toBe(false);
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

  it("resolves against a `cfg` handed in, not the cache", async () => {
    // The DW-313 shape `getEmbeddingModelName(cfg)` uses: a caller that has
    // already read the config resolves against the object it is holding, so
    // `getResolvedCredentials` cannot answer from one config and this from
    // another read a moment later.
    expect(getOllamaBaseUrl({ ollamaBaseUrl: "http://handed-in:11434" })).toBe(
      "http://handed-in:11434",
    );
  });
});

// ---------------------------------------------------------------------------
// getOllamaBaseUrl — the endpoint is CHECKED before it reaches an SDK (DW-326)
// ---------------------------------------------------------------------------

describe("getOllamaBaseUrl validation", () => {
  /** Run `body` with `logger.warn` captured, and hand back this module's lines. */
  async function withWarnSpy<T>(
    body: () => T | Promise<T>,
  ): Promise<{ result: T; warnings: string[] }> {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await body();
      return {
        result,
        warnings: warn.mock.calls
          .filter((call) => call[0] === "config")
          .map((call) => String(call[1])),
      };
    } finally {
      warn.mockRestore();
    }
  }

  it("falls THROUGH a bad stored endpoint to nothing, and warns once", async () => {
    // DW-304 made the write door refuse this; it does nothing about a value
    // stored before that rule, hand-edited in, or restored from a backup. The
    // SDK gets its own default, which is the honest reading of "unusable".
    await saveConfig({ ollamaBaseUrl: "file:///etc/passwd" });
    await loadConfig();

    const { result, warnings } = await withWarnSpy(() => getOllamaBaseUrl());

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("file:///etc/passwd");
  });

  it("falls through a bad ENV endpoint to the STORED one", async () => {
    // The env value is the one no route ever validates, and it wins at runtime.
    // Refusing it must not also throw away a stored endpoint that works.
    await saveConfig({ ollamaBaseUrl: "http://ollama.internal:11434" });
    await loadConfig();
    process.env.OLLAMA_BASE_URL = "localhost:11434";

    const { result, warnings } = await withWarnSpy(() => getOllamaBaseUrl());

    expect(result).toBe("http://ollama.internal:11434");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OLLAMA_BASE_URL");
  });

  it("answers `undefined` when BOTH are unusable, warning once for each", async () => {
    await saveConfig({ ollamaBaseUrl: "not-a-url" });
    await loadConfig();
    process.env.OLLAMA_BASE_URL = "localhost:11434";

    const { result, warnings } = await withWarnSpy(() => getOllamaBaseUrl());

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it("warns for the ENV and the STORE separately when they hold the same bad value", async () => {
    // The key is the source AND the value, not the value alone: the same string
    // in `OLLAMA_BASE_URL` and in the config are two different things to fix,
    // and an owner who only ever hears about one of them cannot fix the other.
    await saveConfig({ ollamaBaseUrl: "localhost:11434" });
    await loadConfig();
    process.env.OLLAMA_BASE_URL = "localhost:11434";

    const { result, warnings } = await withWarnSpy(() => getOllamaBaseUrl());

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(2);
    // One names the variable; the other names the store.
    expect(warnings.filter((line) => line.includes("OLLAMA_BASE_URL"))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("stored"))).toHaveLength(1);
  });

  it("warns EXACTLY ONCE however many times the same bad value is read", async () => {
    // Standing state, not an event: it holds until someone edits the store, and
    // this accessor is read on every embed and every generation.
    await saveConfig({ ollamaBaseUrl: "not-a-url" });
    await loadConfig();

    const { warnings } = await withWarnSpy(() => {
      for (let i = 0; i < 25; i += 1) getOllamaBaseUrl();
    });

    expect(warnings).toHaveLength(1);
  });

  it("treats a BLANK value as unset rather than invalid — no warning", async () => {
    // `OLLAMA_BASE_URL=` and a whitespace-only stored value mean "not
    // configured" here exactly as `EMBEDDING_MODEL=` does (DW-227). The `??`
    // chain this replaced handed `""` straight to the SDK.
    await saveConfig({ ollamaBaseUrl: "   " });
    await loadConfig();
    process.env.OLLAMA_BASE_URL = "  ";

    const { result, warnings } = await withWarnSpy(() => getOllamaBaseUrl());

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("refuses every non-http(s) shape and accepts both http and https", async () => {
    for (const bad of ["not-a-url", "/api", "localhost:11434", "file:///etc/passwd", "ftp://host/x"]) {
      expect(getOllamaBaseUrl({ ollamaBaseUrl: bad })).toBeUndefined();
    }
    for (const good of ["http://localhost:11434", "https://ollama.internal/api"]) {
      expect(getOllamaBaseUrl({ ollamaBaseUrl: good })).toBe(good);
    }
  });

  it("is the ONE ladder `getResolvedCredentials` reaches the SDK through", async () => {
    // A second copy of the ladder lived here, and it is the copy `llm.ts` hands
    // to `createOllama` — so an unchecked value bypassed every check on its way
    // to a provider.
    await saveConfig({ provider: "ollama", ollamaBaseUrl: "file:///etc/passwd" });
    await loadConfig();

    await withWarnSpy(() => {
      expect(getResolvedCredentials().ollamaBaseUrl).toBeNull();
    });

    // …and a usable stored endpoint still reaches it.
    await saveConfig({ provider: "ollama", ollamaBaseUrl: "http://myhost:11434/api" });
    await loadConfig();
    expect(getResolvedCredentials().ollamaBaseUrl).toBe("http://myhost:11434/api");
  });
});

// ---------------------------------------------------------------------------
// detectEnvProvider — a provider is selected only when the env can REACH it
// (DW-370)
// ---------------------------------------------------------------------------

describe("detectEnvProvider — the ollama branch", () => {
  /** Run `body` with `logger.warn` captured, and hand back this module's lines. */
  function withWarnSpy<T>(body: () => T): { result: T; warnings: string[] } {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      return {
        result: body(),
        warnings: warn.mock.calls
          .filter((call) => call[0] === "config")
          .map((call) => String(call[1])),
      };
    } finally {
      warn.mockRestore();
    }
  }

  it("selects ollama from a USABLE endpoint", () => {
    process.env.OLLAMA_BASE_URL = "http://host:11434";

    const { result, warnings } = withWarnSpy(() => detectEnvProvider());

    expect(result).toEqual({ provider: "ollama", apiKey: null });
    expect(warnings).toHaveLength(0);
  });

  it("selects NOTHING from an endpoint `getOllamaBaseUrl` refuses", () => {
    // The DW-370 bug: presence alone used to select `ollama` while resolution
    // ignored the same string, so the calls went to the SDK's own localhost
    // default rather than the address the owner typed.
    process.env.OLLAMA_BASE_URL = "localhost:11434";

    const { result, warnings } = withWarnSpy(() => detectEnvProvider());

    expect(result).toEqual({ provider: null, apiKey: null });
    // The endpoint is still DESCRIBED — the same sentence, from the same
    // warn-once key `getOllamaBaseUrl` uses.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OLLAMA_BASE_URL");
    expect(warnings[0]).toContain("localhost:11434");
  });

  it("still selects ollama when OLLAMA_MODEL is set beside an unusable endpoint", () => {
    // Only the endpoint's FALSE signal is removed. A model name is usable on
    // its own, and the SDK's default endpoint is then the honest resolution.
    process.env.OLLAMA_BASE_URL = "localhost:11434";
    process.env.OLLAMA_MODEL = "llama3.2";

    const { result } = withWarnSpy(() => detectEnvProvider());

    expect(result).toEqual({ provider: "ollama", apiKey: null });
    // …and the endpoint really did resolve to nothing.
    expect(withWarnSpy(() => getOllamaBaseUrl({})).result).toBeUndefined();
  });

  it("selects ollama from OLLAMA_MODEL alone", () => {
    process.env.OLLAMA_MODEL = "llama3.2";
    expect(detectEnvProvider()).toEqual({ provider: "ollama", apiKey: null });
  });

  it("treats a BLANK endpoint as unset: selects nothing, warns about nothing", () => {
    process.env.OLLAMA_BASE_URL = "   ";

    const { result, warnings } = withWarnSpy(() => detectEnvProvider());

    expect(result).toEqual({ provider: null, apiKey: null });
    expect(warnings).toHaveLength(0);
  });

  it("treats a BLANK OLLAMA_MODEL as unset too", () => {
    process.env.OLLAMA_MODEL = "  ";
    expect(detectEnvProvider()).toEqual({ provider: null, apiKey: null });
  });

  it("does not let a blank OLLAMA_MODEL become the reported model", () => {
    // `getEffectiveProvider`'s model ladder reads the same variable, and it
    // must read it the same way: with detection calling `"  "` unset, a ladder
    // on bare truthiness would report the literal string `"  "` as the active
    // model to `/api/status` and to every workload resolver.
    process.env.OLLAMA_BASE_URL = "http://host:11434";
    process.env.OLLAMA_MODEL = "  ";

    const effective = getEffectiveProvider();

    expect(effective.provider).toBe("ollama");
    expect(effective.model).toBe(DEFAULT_MODELS.ollama);
  });

  it("leaves a keyed provider alone beside an unusable endpoint", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OLLAMA_BASE_URL = "localhost:11434";

    expect(detectEnvProvider()).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-test",
    });
  });

  it("does NOT consult the stored endpoint", async () => {
    // Detection answers "what do the env vars alone select". Widening it to the
    // store would make a saved endpoint select a provider the owner never
    // saved — a different question from the one DW-370 asks, and the reason
    // this branch calls `envOllamaBaseUrl()` rather than `getOllamaBaseUrl()`.
    await saveConfig({ ollamaBaseUrl: "http://stored-host:11434" });
    await loadConfig();

    expect(getOllamaBaseUrl()).toBe("http://stored-host:11434");
    expect(detectEnvProvider()).toEqual({ provider: null, apiKey: null });
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

// ---------------------------------------------------------------------------
// applyWorkbenchSettings — clear the embedding pair on a vendor switch
// (DW-69/DW-72)
// ---------------------------------------------------------------------------

describe("applyWorkbenchSettings — embedding provider secret isolation", () => {
  /** A store holding OpenAI's endpoint and OpenAI's key. */
  const openaiStore: AppConfig = {
    chatModel: "gpt-4o",
    vectorSearchEnabled: true,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: "https://o/v1",
    embeddingApiKey: "sk-o",
  };

  it("drops the key AND the endpoint when the vendor moves", () => {
    // The bug: one stored pair served whichever vendor was selected, so this
    // save used to hand Google OpenAI's secret and point it at OpenAI's URL.
    const saved = applyWorkbenchSettings(openaiStore, { embeddingProvider: "google" });
    expect(saved.embeddingProvider).toBe("google");
    expect("embeddingApiKey" in saved).toBe(false);
    expect("embeddingBaseUrl" in saved).toBe(false);
    // The model is NOT a credential and is not cleared — nor is the switch, nor
    // any non-embedding secret.
    expect(saved.embeddingModel).toBe("text-embedding-3-small");
    expect(saved.vectorSearchEnabled).toBe(true);
    expect(saved.chatModel).toBe("gpt-4o");
  });

  it("lets a credential supplied in the SAME request win over the clear", () => {
    // Clear, then apply. The delete drops what the STORE held; the patch then
    // writes what this request carried — which is what lets one save both
    // switch vendor and land the new vendor's pair.
    const saved = applyWorkbenchSettings(openaiStore, {
      embeddingProvider: "google",
      embeddingApiKey: "g-key",
      embeddingBaseUrl: "https://g/v1",
    });
    expect(saved.embeddingApiKey).toBe("g-key");
    expect(saved.embeddingBaseUrl).toBe("https://g/v1");
  });

  it("leaves both fields byte-identical when the same provider is re-sent", () => {
    // `settingsSaveBody` sends `embeddingProvider` on EVERY save, so this is the
    // ordinary case, not an edge one. A presence test here would delete the
    // owner's key on a timeout edit.
    const saved = applyWorkbenchSettings(openaiStore, {
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
    });
    expect(saved.embeddingApiKey).toBe("sk-o");
    expect(saved.embeddingBaseUrl).toBe("https://o/v1");
  });

  it("leaves them alone for a patch that does not mention the provider", () => {
    // ABSENT means "leave it alone", which is not a move.
    const saved = applyWorkbenchSettings(openaiStore, { llmTimeoutSeconds: 30 });
    expect(saved.embeddingApiKey).toBe("sk-o");
    expect(saved.embeddingBaseUrl).toBe("https://o/v1");
  });

  it("clears on the way to auto-detect", () => {
    // The effective vendor may now resolve elsewhere entirely, so the stored
    // pair is no more trustworthy than it was for a named switch.
    const saved = applyWorkbenchSettings(openaiStore, { embeddingProvider: null });
    expect("embeddingProvider" in saved).toBe(false);
    expect("embeddingApiKey" in saved).toBe(false);
    expect("embeddingBaseUrl" in saved).toBe(false);
  });

  it("clears when a provider is chosen where the store had none", () => {
    const saved = applyWorkbenchSettings(
      { embeddingBaseUrl: "https://somewhere/v1", embeddingApiKey: "sk-?" },
      { embeddingProvider: "openai" },
    );
    expect("embeddingApiKey" in saved).toBe(false);
    expect("embeddingBaseUrl" in saved).toBe(false);
  });

  it("reads a padded stored provider as the same vendor", () => {
    // Trim-normalised on both sides: a stray space in the store must not read as
    // a vendor switch and delete a key nobody touched.
    const saved = applyWorkbenchSettings(
      { ...openaiStore, embeddingProvider: " openai " as AppConfig["embeddingProvider"] },
      { embeddingProvider: "openai" },
    );
    expect(saved.embeddingApiKey).toBe("sk-o");
    expect(saved.embeddingBaseUrl).toBe("https://o/v1");
  });

  it("does not mutate the config it was handed", () => {
    const existing: AppConfig = { ...openaiStore };
    applyWorkbenchSettings(existing, { embeddingProvider: "google" });
    expect(existing.embeddingApiKey).toBe("sk-o");
    expect(existing.embeddingBaseUrl).toBe("https://o/v1");
  });
});
