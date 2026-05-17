import type { ProviderInfo } from "./types";
import { hasEmbeddingSupport } from "./embeddings";
import { isEnoent } from "./errors";
import { VALID_PROVIDERS, DEFAULT_MODELS } from "./providers";
import { logger } from "./logger";
import { getDataDir } from "./paths";
import { getStorage } from "./storage";

// Re-export provider constants so existing consumers can import from config
export { PROVIDER_INFO, VALID_PROVIDERS, DEFAULT_MODELS, providerLabel } from "./providers";
export type { ProviderValue } from "./providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppConfig {
  provider?: "anthropic" | "openai" | "google" | "ollama";
  apiKey?: string;
  model?: string;
  ollamaBaseUrl?: string;
  embeddingModel?: string;
}

/** Describes where each setting was resolved from. */
export type SettingSource = "env" | "config" | "default" | "none";

export interface EffectiveSettings {
  provider: string | null;
  providerSource: SettingSource;
  model: string | null;
  modelSource: SettingSource;
  configured: boolean;
  embeddingSupport: boolean;
  embeddingModel: string | null;
  embeddingModelSource: SettingSource;
  maskedApiKey: string | null;
  apiKeySource: SettingSource;
  ollamaBaseUrl: string | null;
  ollamaBaseUrlSource: SettingSource;
}

// ---------------------------------------------------------------------------
// Valid providers (for validation)
// ---------------------------------------------------------------------------

export function isValidProvider(p: string): p is AppConfig["provider"] & string {
  return VALID_PROVIDERS.has(p);
}

// ---------------------------------------------------------------------------
// Data / directory helpers — re-exported from paths.ts to avoid circular deps
// ---------------------------------------------------------------------------

export { getDataDir, getWikiDir, getRawDir } from "./paths";

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

/** Relative path for config file within the storage root. */
function configRelPath(): string {
  return ".llm-wiki-config.json";
}

export function getConfigPath(): string {
  return `${getDataDir()}/.llm-wiki-config.json`;
}

// ---------------------------------------------------------------------------
// Centralised env-var accessors for embedding / Ollama settings
// ---------------------------------------------------------------------------

/** Returns the `EMBEDDING_MODEL` env override, or `undefined` if not set. */
export function getEmbeddingModelOverride(): string | undefined {
  return process.env.EMBEDDING_MODEL;
}

/**
 * Returns the effective Ollama base URL.
 * Priority: `OLLAMA_BASE_URL` env var → config file `ollamaBaseUrl` → `undefined`.
 */
export function getOllamaBaseUrl(): string | undefined {
  const cfg = loadConfigSync();
  return process.env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl ?? undefined;
}

// ---------------------------------------------------------------------------
// Async config I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse the config file. Returns `{}` if the file doesn't exist.
 * Also populates the sync cache as a side effect so that subsequent
 * `loadConfigSync()` calls return the up-to-date config.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await getStorage().readFile(configRelPath());
    const data = JSON.parse(raw) as AppConfig;
    _configCache = { data, ts: Date.now() };
    return data;
  } catch (err) {
    if (!isEnoent(err)) {
      logger.warn("config", "load config failed:", err);
    }
    return {};
  }
}

/**
 * Write config JSON via storage provider.
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await getStorage().writeFile(
    configRelPath(),
    JSON.stringify(config, null, 2) + "\n",
  );
  // Invalidate the sync cache so subsequent reads see the new data
  _configCache = null;
}

// ---------------------------------------------------------------------------
// Sync cached reads (for hot-path in llm.ts)
// ---------------------------------------------------------------------------

let _configCache: { data: AppConfig; ts: number } | null = null;
const CACHE_TTL_MS = 5_000;

/**
 * Synchronous config read with in-memory cache (5 s TTL).
 * Returns cached data if available, otherwise returns `{}`.
 *
 * The cache is populated by `loadConfig()` and `saveConfig()`. If neither
 * has been called yet, this returns `{}` (same as "file doesn't exist").
 * This is safe because:
 *   - LLM calls use env vars as the primary config source
 *   - The config file is optional — `{}` is the documented default
 *   - The app's startup sequence calls `loadConfig()` before any LLM call
 */
export function loadConfigSync(): AppConfig {
  const now = Date.now();
  if (_configCache && now - _configCache.ts < CACHE_TTL_MS) {
    return _configCache.data;
  }
  // Cache cold — return empty config. The cache will be populated
  // by the next async loadConfig() call.
  _configCache = { data: {}, ts: now };
  return {};
}

/** Expose cache reset for testing. */
export function _resetConfigCache(): void {
  _configCache = null;
}

// ---------------------------------------------------------------------------
// Key masking
// ---------------------------------------------------------------------------

/**
 * Mask an API key for display: show first 3 and last 6 chars.
 * Returns `null` for falsy input.
 */
export function maskApiKey(key: string | undefined | null): string | null {
  if (!key) return null;
  if (key.length <= 12) return "****";
  return key.slice(0, 3) + "..." + key.slice(-6);
}

// ---------------------------------------------------------------------------
// Effective provider resolution
// ---------------------------------------------------------------------------

/**
 * Detect the active provider from env vars alone (same logic as the original
 * `getProviderInfo()` in llm.ts).
 *
 * Exported so that `embeddings.ts` and `llm.ts` can reuse it rather than
 * duplicating the env-var sniffing logic.
 */
export function detectEnvProvider(): {
  provider: string | null;
  apiKey: string | null;
} {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return { provider: "google", apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY };
  }
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    return { provider: "ollama", apiKey: null };
  }
  return { provider: null, apiKey: null };
}

/**
 * Merge config file + env vars to produce the effective provider.
 * Priority: env vars > config file > defaults.
 */
export function getEffectiveProvider(): ProviderInfo {
  const cfg = loadConfigSync();
  const env = detectEnvProvider();

  // Resolve provider: env wins, then config
  const provider = env.provider ?? cfg.provider ?? null;
  if (!provider) {
    return {
      configured: false,
      provider: null,
      model: null,
      embeddingSupport: false,
    };
  }

  // Resolve model
  const modelOverride = process.env.LLM_MODEL;
  let model: string;
  if (modelOverride) {
    model = modelOverride;
  } else if (cfg.model) {
    model = cfg.model;
  } else if (provider === "ollama" && process.env.OLLAMA_MODEL) {
    model = process.env.OLLAMA_MODEL;
  } else {
    model = DEFAULT_MODELS[provider] ?? provider;
  }

  return {
    configured: true,
    provider,
    model,
    embeddingSupport: hasEmbeddingSupport(),
  };
}

/**
 * Full effective settings with source annotations for the settings UI.
 */
export function getEffectiveSettings(): EffectiveSettings {
  const cfg = loadConfigSync();
  const env = detectEnvProvider();

  // Provider
  let provider: string | null;
  let providerSource: SettingSource;
  if (env.provider) {
    provider = env.provider;
    providerSource = "env";
  } else if (cfg.provider) {
    provider = cfg.provider;
    providerSource = "config";
  } else {
    provider = null;
    providerSource = "none";
  }

  // API key
  let apiKey: string | null;
  let apiKeySource: SettingSource;
  if (env.apiKey) {
    apiKey = env.apiKey;
    apiKeySource = "env";
  } else if (cfg.apiKey) {
    apiKey = cfg.apiKey;
    apiKeySource = "config";
  } else {
    apiKey = null;
    apiKeySource = "none";
  }

  // Model
  let model: string | null;
  let modelSource: SettingSource;
  const modelOverride = process.env.LLM_MODEL;
  if (modelOverride) {
    model = modelOverride;
    modelSource = "env";
  } else if (cfg.model) {
    model = cfg.model;
    modelSource = "config";
  } else if (provider) {
    if (provider === "ollama" && process.env.OLLAMA_MODEL) {
      model = process.env.OLLAMA_MODEL;
      modelSource = "env";
    } else {
      model = DEFAULT_MODELS[provider] ?? null;
      modelSource = "default";
    }
  } else {
    model = null;
    modelSource = "none";
  }

  // Ollama base URL
  let ollamaBaseUrl: string | null;
  let ollamaBaseUrlSource: SettingSource;
  if (process.env.OLLAMA_BASE_URL) {
    ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
    ollamaBaseUrlSource = "env";
  } else if (cfg.ollamaBaseUrl) {
    ollamaBaseUrl = cfg.ollamaBaseUrl;
    ollamaBaseUrlSource = "config";
  } else {
    ollamaBaseUrl = null;
    ollamaBaseUrlSource = "none";
  }

  // Embedding model
  let embeddingModel: string | null;
  let embeddingModelSource: SettingSource;
  if (process.env.EMBEDDING_MODEL) {
    embeddingModel = process.env.EMBEDDING_MODEL;
    embeddingModelSource = "env";
  } else if (cfg.embeddingModel) {
    embeddingModel = cfg.embeddingModel;
    embeddingModelSource = "config";
  } else {
    embeddingModel = null;
    embeddingModelSource = "none";
  }

  return {
    provider,
    providerSource,
    model,
    modelSource,
    configured: provider !== null,
    embeddingSupport: hasEmbeddingSupport(),
    embeddingModel,
    embeddingModelSource,
    maskedApiKey: maskApiKey(apiKey),
    apiKeySource,
    ollamaBaseUrl,
    ollamaBaseUrlSource,
  };
}

// ---------------------------------------------------------------------------
// Resolved credentials for model construction (used by llm.ts)
// ---------------------------------------------------------------------------

export interface ResolvedCredentials {
  provider: string | null;
  apiKey: string | null;
  model: string | null;
  ollamaBaseUrl: string | null;
}

/**
 * Return the fully-resolved credentials for constructing an LLM model.
 * This merges env > config > defaults, intended for use from `getModel()`.
 */
export function getResolvedCredentials(): ResolvedCredentials {
  const cfg = loadConfigSync();
  const env = detectEnvProvider();

  const provider = env.provider ?? cfg.provider ?? null;
  if (!provider) {
    return { provider: null, apiKey: null, model: null, ollamaBaseUrl: null };
  }

  // API key: env wins
  let apiKey: string | null;
  if (provider === "anthropic") {
    apiKey = process.env.ANTHROPIC_API_KEY ?? cfg.apiKey ?? null;
  } else if (provider === "openai") {
    apiKey = process.env.OPENAI_API_KEY ?? cfg.apiKey ?? null;
  } else if (provider === "google") {
    apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? cfg.apiKey ?? null;
  } else {
    apiKey = null; // ollama is keyless
  }

  // Model
  const modelOverride = process.env.LLM_MODEL;
  let model: string;
  if (modelOverride) {
    model = modelOverride;
  } else if (cfg.model) {
    model = cfg.model;
  } else if (provider === "ollama" && process.env.OLLAMA_MODEL) {
    model = process.env.OLLAMA_MODEL;
  } else {
    model = DEFAULT_MODELS[provider] ?? provider;
  }

  // Ollama base URL
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl ?? null;

  return { provider, apiKey, model, ollamaBaseUrl };
}
