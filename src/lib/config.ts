import type { ProviderInfo } from "./types";
import { hasEmbeddingSupport } from "./embeddings";
import { isEnoent } from "./errors";
import { VALID_PROVIDERS, DEFAULT_MODELS } from "./providers";
import type { EmbeddingProvider } from "./providers";
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
  provider?:
    | "anthropic"
    | "openai"
    | "google"
    | "deepseek"
    | "ollama-cloud"
    | "ollama";
  model?: string;
  ollamaBaseUrl?: string;
  embeddingModel?: string;
  /** Override the provider used for embeddings, independent of the LLM
   *  provider. Useful when the generation provider (e.g. deepseek) has no
   *  embedding models. One of openai | google | ollama | workers-ai; any
   *  other value disables embeddings (resolves to null). */
  embeddingProvider?: EmbeddingProvider;
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
  hasApiKey: boolean;
  apiKeySource: SettingSource;
  ollamaBaseUrl: string | null;
  ollamaBaseUrlSource: SettingSource;
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Read-only mode detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the instance should reject settings writes.
 *
 * True only when `YOPEDIA_READONLY=1` is explicitly set. Cloud deployments
 * can safely persist non-secret provider preferences because every settings
 * write is independently owner-gated by the API route. Provider credentials
 * remain environment secrets and are never accepted by the settings API.
 */
export function isReadOnly(): boolean {
  return process.env.YOPEDIA_READONLY === "1";
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
 *   - LLM calls await `loadConfig()` before resolving the active provider
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
// Effective provider resolution
// ---------------------------------------------------------------------------

/**
 * Detect a fallback provider from env vars alone. This is used only when the
 * owner has not saved a provider selection yet.
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
  if (process.env.DEEPSEEK_API_KEY) {
    return { provider: "deepseek", apiKey: process.env.DEEPSEEK_API_KEY };
  }
  if (process.env.OLLAMA_API_KEY) {
    return { provider: "ollama-cloud", apiKey: process.env.OLLAMA_API_KEY };
  }
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    return { provider: "ollama", apiKey: null };
  }
  return { provider: null, apiKey: null };
}

/** Return the server-side credential for a specific provider. */
export function apiKeyForProvider(provider: string | null): string | null {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ?? null;
    case "openai":
      return process.env.OPENAI_API_KEY ?? null;
    case "google":
      return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null;
    case "deepseek":
      return process.env.DEEPSEEK_API_KEY ?? null;
    case "ollama-cloud":
      return process.env.OLLAMA_API_KEY ?? null;
    default:
      return null;
  }
}

function providerIsConfigured(provider: string | null): boolean {
  return provider === "ollama" || apiKeyForProvider(provider) !== null;
}

/**
 * Merge the owner's saved selection with server credentials.
 * Priority: saved provider selection > env auto-detection fallback.
 *
 * Environment variables provide credentials, not preference. This allows an
 * installation to keep several provider keys and switch between them in the
 * Settings UI without whichever secret is checked first taking over.
 */
export function getEffectiveProvider(): ProviderInfo {
  const cfg = loadConfigSync();
  const env = detectEnvProvider();

  const provider = cfg.provider ?? env.provider ?? null;
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
  } else if (
    (provider === "ollama" || provider === "ollama-cloud") &&
    process.env.OLLAMA_MODEL
  ) {
    model = process.env.OLLAMA_MODEL;
  } else {
    model = DEFAULT_MODELS[provider] ?? provider;
  }

  return {
    configured: providerIsConfigured(provider),
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
  if (cfg.provider) {
    provider = cfg.provider;
    providerSource = "config";
  } else if (env.provider) {
    provider = env.provider;
    providerSource = "env";
  } else {
    provider = null;
    providerSource = "none";
  }

  // API key — env only
  const envApiKey = apiKeyForProvider(provider);
  const apiKeySource: SettingSource = envApiKey ? "env" : "none";

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
    if (
      (provider === "ollama" || provider === "ollama-cloud") &&
      process.env.OLLAMA_MODEL
    ) {
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
  if (provider === "ollama-cloud") {
    ollamaBaseUrl = "https://ollama.com/api";
    ollamaBaseUrlSource = "default";
  } else if (process.env.OLLAMA_BASE_URL) {
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
    configured: providerIsConfigured(provider),
    embeddingSupport: hasEmbeddingSupport(),
    embeddingModel,
    embeddingModelSource,
    hasApiKey: envApiKey !== null,
    apiKeySource,
    ollamaBaseUrl,
    ollamaBaseUrlSource,
    readOnly: isReadOnly(),
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
 * The saved provider selection chooses which environment credential to use;
 * env auto-detection remains the fallback when no preference has been saved.
 */
export function getResolvedCredentials(): ResolvedCredentials {
  const cfg = loadConfigSync();
  const env = detectEnvProvider();

  const provider = cfg.provider ?? env.provider ?? null;
  if (!provider) {
    return { provider: null, apiKey: null, model: null, ollamaBaseUrl: null };
  }

  // API keys remain server-side environment secrets.
  const apiKey = apiKeyForProvider(provider);

  // Model
  const modelOverride = process.env.LLM_MODEL;
  let model: string;
  if (modelOverride) {
    model = modelOverride;
  } else if (cfg.model) {
    model = cfg.model;
  } else if (
    (provider === "ollama" || provider === "ollama-cloud") &&
    process.env.OLLAMA_MODEL
  ) {
    model = process.env.OLLAMA_MODEL;
  } else {
    model = DEFAULT_MODELS[provider] ?? provider;
  }

  // Ollama base URL
  const ollamaBaseUrl =
    provider === "ollama-cloud"
      ? "https://ollama.com/api"
      : process.env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl ?? null;

  return { provider, apiKey, model, ollamaBaseUrl };
}
