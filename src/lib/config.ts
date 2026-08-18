import type { ProviderInfo } from "./types";
import { hasEmbeddingSupport } from "./embeddings";
import { isEnoent } from "./errors";
import { VALID_PROVIDERS, DEFAULT_MODELS, isEmbeddingProvider } from "./providers";
import type { EmbeddingProvider, ProviderValue } from "./providers";
import { logger } from "./logger";
import { getDataDir } from "./paths";
import { getStorage } from "./storage";
import {
  SETTINGS_LANGUAGE_VALUE,
  canEnableVectorSearch,
  type WorkbenchSettingsPatch,
  type WorkbenchSettingsStored,
  type WorkbenchSettingsValues,
} from "./workbench-settings";

// Re-export provider constants so existing consumers can import from config
export { PROVIDER_INFO, VALID_PROVIDERS, DEFAULT_MODELS, providerLabel } from "./providers";
export type { ProviderValue } from "./providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppConfig {
  provider?: ProviderValue;
  model?: string;
  ollamaBaseUrl?: string;
  /** Optional workload-specific generation route for Knowledge Atlas
   * extraction. Credentials remain server-side environment secrets. */
  structuredKnowledgeProvider?: ProviderValue;
  structuredKnowledgeModel?: string;
  embeddingModel?: string;
  /** Override the provider used for embeddings, independent of the LLM
   *  provider. Useful when the generation provider (e.g. deepseek) has no
   *  embedding models. One of openai | google | ollama | workers-ai; any
   *  other value disables embeddings (resolves to null). */
  embeddingProvider?: EmbeddingProvider;

  // -------------------------------------------------------------------------
  // Story 1.9 — the Workbench Settings surface's own fields.
  //
  // They live in the SAME `AppConfig` written through `saveConfig`, because
  // AD-23 names the kernel store and `epic-1-context.md:27` says settings
  // persist server-side rather than in a browser-only or sidecar-local store.
  // They ride under one nested `workbench` key on the WIRE (see
  // `workbench-settings.ts`) so the legacy flat contract stays frozen, but on
  // disk they are flat keys beside the rest — one store, one JSON.
  // -------------------------------------------------------------------------

  /** Chat's generation route (Epic 3 owns the call sites). */
  chatProvider?: ProviderValue;
  chatModel?: string;
  /** Ingest's generation route (Epic 2 owns the call sites). */
  ingestProvider?: ProviderValue;
  ingestModel?: string;
  /** The `custom` provider's OpenAI-compatible endpoint and credential. */
  customBaseUrl?: string;
  customApiKey?: string;
  /**
   * Per-attempt LLM deadline in SECONDS. Absent means no deadline, which is
   * today's behaviour exactly — see `getLlmTimeoutMs`.
   */
  llmTimeoutSeconds?: number;
  /**
   * Vector search. Absent is `false`: FR-56 makes vector search opt-in, and the
   * default living in the kernel is what makes that a property of the store
   * rather than of a component that happens to render unchecked.
   */
  vectorSearchEnabled?: boolean;
  /** Optional endpoint override for the embedding provider. */
  embeddingBaseUrl?: string;
  /** Embedding credential, when it is not supplied as an env secret. */
  embeddingApiKey?: string;
  /** Firecrawl credentials, stored for Epic 6's Deep Research. */
  firecrawlApiKey?: string;
  firecrawlBaseUrl?: string;
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
  structuredKnowledgeProvider: ProviderValue | null;
  structuredKnowledgeProviderSource: SettingSource;
  structuredKnowledgeModel: string | null;
  structuredKnowledgeModelSource: SettingSource;
  structuredKnowledgeConfigured: boolean;
  readOnly: boolean;
}

export interface StructuredKnowledgeModelSettings {
  provider: ProviderValue | null;
  providerSource: SettingSource;
  model: string | null;
  modelSource: SettingSource;
  configured: boolean;
  usesPrimary: boolean;
}

// ---------------------------------------------------------------------------
// Read-only mode detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the deployment refuses writes.
 *
 * True only when `YOPEDIA_READONLY=1` is explicitly set. This is the single
 * deployment-wide refusal every gated route consults, and it is deliberately
 * broader than its original settings-only scope: it now also gates the page
 * write route (`PUT`/`PATCH`/`DELETE /api/wiki/[slug]`), the wiki lifecycle
 * routes, and the Workbench Preview's `editable` contract (DW-37). A surface
 * that offers one of those writes mirrors this same call rather than fetching
 * the fact separately, so the affordance and the refusal cannot disagree.
 *
 * Not every page write consults it yet — `POST /api/wiki`, the revisions
 * revert path, `DELETE /api/ingest/history`, `POST /api/ingest/reingest` and
 * the stdio MCP server in `src/mcp.ts` all still write on a read-only
 * deployment (recorded, not fixed). Check before assuming a new caller is
 * covered.
 *
 * Cloud deployments leave it unset: non-secret provider preferences are safe
 * to persist because every settings write is independently owner-gated by the
 * API route, and provider credentials remain environment secrets the settings
 * API never accepts.
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
    case "custom":
      // The one provider whose credential MAY come from the store: a custom
      // endpoint is the owner's own, and there is no conventional env var name
      // for "whatever server you pointed us at". The env var still wins, so a
      // deployment that sets it keeps the secret out of the config JSON.
      // Truthiness, not nullishness: `LLM_CUSTOM_API_KEY=""` is set-but-empty,
      // and a `??` chain would hand back `""` — a value `providerIsConfigured`
      // reads as a credential while `getModel()` refuses it as missing.
      return nonEmpty(process.env.LLM_CUSTOM_API_KEY) ?? nonEmpty(loadConfigSync().customApiKey);
    default:
      return null;
  }
}

/**
 * `custom` needs BOTH halves. A key with no endpoint has nowhere to go and an
 * endpoint with no key is a request that 401s, so reporting either as
 * "configured" would promise a provider the runtime cannot construct — the
 * silently-inert save this story exists to prevent.
 */
export function providerIsConfigured(provider: string | null): boolean {
  if (provider === "ollama") return true;
  if (provider === "custom") {
    return apiKeyForProvider("custom") !== null && getCustomBaseUrl() !== null;
  }
  return apiKeyForProvider(provider) !== null;
}

/**
 * The `custom` provider's endpoint: env var first, then the store.
 *
 * Truthiness, not nullishness, for the same reason as
 * {@link apiKeyForProvider}'s `custom` branch: `LLM_CUSTOM_BASE_URL=""` must not
 * mask an endpoint the owner stored through Settings.
 */
export function getCustomBaseUrl(): string | null {
  return (
    nonEmpty(process.env.LLM_CUSTOM_BASE_URL) ?? nonEmpty(loadConfigSync().customBaseUrl)
  );
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
  let model: string | null;
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
    // `custom` carries no DEFAULT_MODELS entry on purpose, so the `?? provider`
    // fallback would report the literal string "custom" as the active model —
    // the same trap `getResolvedCredentials` guards, and the value `/api/status`
    // and the workload resolvers would inherit. There is no default to report
    // for an endpoint nobody here has seen, so report none.
    model = DEFAULT_MODELS[provider] ?? (provider === "custom" ? null : provider);
  }

  return {
    configured: providerIsConfigured(provider),
    provider,
    model,
    embeddingSupport: hasEmbeddingSupport(),
  };
}

/**
 * Resolve the model used for schema-constrained Knowledge Atlas extraction.
 *
 * A saved workload override wins. When no override is saved, extraction
 * inherits the primary provider and model exactly, preserving existing
 * behavior while allowing owners to route this stricter workload separately.
 */
export function getStructuredKnowledgeModelSettings(): StructuredKnowledgeModelSettings {
  const cfg = loadConfigSync();
  // The ladder itself lives in `workloadModelSettings` (below), which Chat and
  // Ingest also call. This function is now only "which two keys".
  return workloadModelSettings(
    cfg.structuredKnowledgeProvider,
    cfg.structuredKnowledgeModel,
  );
}

// ---------------------------------------------------------------------------
// Story 1.9 — workload model routes, and the rest of the Workbench settings
// ---------------------------------------------------------------------------

/**
 * Resolve a workload's provider/model pair, or inherit the primary one.
 *
 * ONE ladder for all three workloads — Structured Knowledge (which had it
 * first), Chat and Ingest: a saved override wins; a saved provider with no model
 * falls to that provider's default; nothing saved inherits the primary provider
 * AND model exactly. `getStructuredKnowledgeModelSettings` calls through to this
 * rather than keeping its own copy, so the three cannot drift.
 */
function workloadModelSettings(
  provider: ProviderValue | undefined,
  model: string | undefined,
): StructuredKnowledgeModelSettings {
  const primary = getEffectiveProvider();
  const primaryProvider =
    typeof primary.provider === "string" && isValidProvider(primary.provider)
      ? primary.provider
      : null;
  const resolvedProvider = provider ?? primaryProvider;
  const providerSource: SettingSource = provider
    ? "config"
    : resolvedProvider
      ? "default"
      : "none";

  let resolvedModel: string | null;
  let modelSource: SettingSource;
  if (model) {
    resolvedModel = model;
    modelSource = "config";
  } else if (provider) {
    resolvedModel = DEFAULT_MODELS[provider] ?? null;
    modelSource = resolvedModel ? "default" : "none";
  } else {
    resolvedModel = primary.model;
    modelSource = resolvedModel ? "default" : "none";
  }

  return {
    provider: resolvedProvider,
    providerSource,
    model: resolvedModel,
    modelSource,
    configured: providerIsConfigured(resolvedProvider),
    usesPrimary: provider === undefined && model === undefined,
  };
}

/**
 * The model Chat runs on. Story 1.9 owns the setting; Epic 3 owns the call
 * sites — nothing in `chat.ts` reads this yet, by design
 * (`epic-1-context.md:63`).
 */
export function getChatModelSettings(): StructuredKnowledgeModelSettings {
  const cfg = loadConfigSync();
  return workloadModelSettings(cfg.chatProvider, cfg.chatModel);
}

/**
 * The model Ingest runs on. Story 1.9 owns the setting; Epic 2 owns the call
 * sites. Independent of {@link getChatModelSettings} and of the primary
 * provider — that independence is the story's headline behaviour.
 */
export function getIngestModelSettings(): StructuredKnowledgeModelSettings {
  const cfg = loadConfigSync();
  return workloadModelSettings(cfg.ingestProvider, cfg.ingestModel);
}

export interface VectorSearchSettings {
  /** The EFFECTIVE switch: the stored flag intersected with the predicate. */
  enabled: boolean;
  /** The explicit embedding provider the gate was read against. */
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
}

/**
 * The vector-search switch and the three values that gate it.
 *
 * `enabled` is the STORED flag intersected with the predicate, so a config JSON
 * hand-edited to `true` with no endpoint still reads as off — the route refuses
 * that write, and this makes the refusal hold for bytes that arrived another
 * way. Story 2.9 (embed after ingest) and Story 3.4 (search merge) are the
 * consumers; `hasEmbeddingSupport()` is deliberately NOT taught about it here.
 */
export function getVectorSearchSettings(): VectorSearchSettings {
  const cfg = loadConfigSync();
  const provider = envEmbeddingProvider() ?? nonEmpty(cfg.embeddingProvider);
  const inputs = {
    provider,
    baseUrl: nonEmpty(cfg.embeddingBaseUrl),
    model: nonEmpty(process.env.EMBEDDING_MODEL) ?? nonEmpty(cfg.embeddingModel),
    hasKey: embeddingKeyPresent(cfg, provider),
  };
  return {
    enabled: cfg.vectorSearchEnabled === true && canEnableVectorSearch(inputs),
    ...inputs,
  };
}

/** Trim-and-null: `""` and whitespace are "unset", not "set to nothing". */
function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The `EMBEDDING_PROVIDER` override, when it names a provider that can actually
 * embed. A junk value is `null` here for the same reason
 * `resolveEmbeddingProvider` refuses it rather than falling through: it is a
 * misconfiguration, not a selection.
 */
function envEmbeddingProvider(): EmbeddingProvider | null {
  const value = nonEmpty(process.env.EMBEDDING_PROVIDER);
  return value !== null && isEmbeddingProvider(value) ? value : null;
}

/**
 * WHICH embedding providers the environment already carries a credential for.
 *
 * A list rather than a boolean, because a key is only a key for the vendor it
 * belongs to: `OPENAI_API_KEY` says nothing about a Google selection, and
 * answering one flat "yes" let the vector gate pass on a credential
 * `embeddingApiKeyFor()` would then resolve to `null` at embed time. The names
 * mirror `embeddingApiKeyFor` exactly — `ollama` and `workers-ai` are keyless
 * and never appear here.
 *
 * Truthiness, not nullishness: `OPENAI_API_KEY=""` is set-but-empty, and an
 * empty string is not a credential.
 */
function envEmbeddingApiKeyProviders(): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (nonEmpty(process.env.OPENAI_API_KEY)) providers.push("openai");
  if (nonEmpty(process.env.GOOGLE_GENERATIVE_AI_API_KEY)) providers.push("google");
  return providers;
}

/**
 * Is there an embedding credential for THIS provider? The env vars count — an
 * owner whose `OPENAI_API_KEY` is already a deployment secret must not be asked
 * to paste it a second time just to satisfy the vector gate — but only for the
 * provider that var actually belongs to. A stored key is vendor-agnostic: it is
 * the one the owner typed into the field beside the provider they picked.
 */
function embeddingKeyPresent(cfg: AppConfig, provider: string | null): boolean {
  const fromEnv =
    provider !== null &&
    isEmbeddingProvider(provider) &&
    envEmbeddingApiKeyProviders().includes(provider);
  return fromEnv || nonEmpty(cfg.embeddingApiKey) !== null;
}

/**
 * The configured per-attempt LLM deadline in MILLISECONDS, or `null` for none.
 *
 * Unset is the default and means today's behaviour exactly: nothing in `llm.ts`
 * aborts today, and introducing a default deadline would newly kill long Ingest
 * and vision calls that currently succeed — a behaviour change no acceptance
 * criterion asks for.
 */
export function getLlmTimeoutMs(): number | null {
  const seconds = loadConfigSync().llmTimeoutSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.round(seconds) * 1000;
}

/**
 * The same deadline as the AI SDK's own option — or nothing at all.
 *
 * Spread into a model call INSIDE `retryWithBackoff`'s thunk, so each attempt
 * gets its own fresh deadline rather than inheriting one that expired during the
 * first try. Unset omits the key entirely, which is today's no-timeout behaviour
 * exactly.
 *
 * It lives here, beside {@link getLlmTimeoutMs}, rather than in `llm.ts`,
 * because `callLLM` is not the only door to the SDK in this repo:
 * `structured-knowledge.ts`, `action-extractor.ts` and `source-monitors.ts`
 * reach `generateText` directly. The field is labelled "LLM timeout" with no
 * scope, so a deadline that bound only `llm.ts` would be a setting that quietly
 * means something narrower than it says.
 */
export function llmTimeoutOption(): { abortSignal?: AbortSignal } {
  const ms = getLlmTimeoutMs();
  return ms === null ? {} : { abortSignal: AbortSignal.timeout(ms) };
}

export interface FirecrawlSettings {
  hasKey: boolean;
  baseUrl: string | null;
}

/**
 * Firecrawl credentials. Stored here for Epic 6's Deep Research; nothing in this
 * epic calls Firecrawl, so this is a reader with no consumer yet — which is the
 * point of storing them now.
 */
export function getFirecrawlSettings(): FirecrawlSettings {
  const cfg = loadConfigSync();
  return {
    // Truthiness, not nullishness: `FIRECRAWL_API_KEY=""` must not mask a key
    // the owner stored through Settings.
    hasKey: Boolean(
      nonEmpty(process.env.FIRECRAWL_API_KEY) ?? nonEmpty(cfg.firecrawlApiKey),
    ),
    baseUrl: nonEmpty(cfg.firecrawlBaseUrl),
  };
}

/**
 * The `workbench` half of `GET /api/settings`.
 *
 * NO STORED KEY IS EVER IN HERE — the three secrets become `has*ApiKey`
 * booleans. AD-23 puts the keys in the kernel store; it does not put them back
 * on the browser's screen.
 */
export function getWorkbenchSettings(): WorkbenchSettingsValues {
  const cfg = loadConfigSync();
  const firecrawl = getFirecrawlSettings();
  const envProvider = envEmbeddingProvider();
  return {
    chatProvider: cfg.chatProvider ?? null,
    chatModel: cfg.chatModel ?? null,
    ingestProvider: cfg.ingestProvider ?? null,
    ingestModel: cfg.ingestModel ?? null,
    customBaseUrl: nonEmpty(cfg.customBaseUrl),
    hasCustomApiKey: apiKeyForProvider("custom") !== null,
    llmTimeoutSeconds:
      typeof cfg.llmTimeoutSeconds === "number" ? cfg.llmTimeoutSeconds : null,
    // The owner's STORED decision, NOT `getVectorSearchSettings().enabled`. The
    // save body always carries this field back, so serving the intersected value
    // would let an unrelated edit rewrite a stored `true` to `false` the moment
    // one leg was momentarily missing.
    vectorSearchEnabled: cfg.vectorSearchEnabled === true,
    embeddingProvider: cfg.embeddingProvider ?? null,
    embeddingModel: nonEmpty(cfg.embeddingModel),
    embeddingBaseUrl: nonEmpty(cfg.embeddingBaseUrl),
    // The STORED key only. An env credential is reported by
    // `envEmbeddingApiKeyProviders` instead, because it belongs to one vendor
    // and because `Remove` must not be offered for a key this route cannot
    // delete. One stored key serves whichever provider the owner picks, so the
    // browser can still answer the vector gate for a provider it has changed
    // but not yet saved.
    hasEmbeddingApiKey: nonEmpty(cfg.embeddingApiKey) !== null,
    // What a save cannot change and what wins at runtime, served apart from the
    // editable fields so the browser can feed the vector predicate exactly what
    // the route feeds it.
    envEmbeddingProvider: envProvider,
    envEmbeddingModel: nonEmpty(process.env.EMBEDDING_MODEL),
    envEmbeddingApiKeyProviders: envEmbeddingApiKeyProviders(),
    firecrawlBaseUrl: firecrawl.baseUrl,
    hasFirecrawlApiKey: firecrawl.hasKey,
    language: SETTINGS_LANGUAGE_VALUE,
    readOnly: isReadOnly(),
  };
}

/**
 * The state a `workbench` patch is validated AGAINST, read from a config object
 * rather than from the sync cache.
 *
 * The route needs this for the config it is about to write — the legacy branches
 * of the same `PUT` may have already moved `embeddingModel` — so it cannot use
 * `getWorkbenchSettings()`, which reads the cache. One expression of "what the
 * vector rule sees" for both.
 */
export function workbenchSettingsStored(cfg: AppConfig): WorkbenchSettingsStored {
  return {
    vectorSearchEnabled: cfg.vectorSearchEnabled === true,
    // The CONFIG halves — what a patch can move.
    embeddingProvider: nonEmpty(cfg.embeddingProvider),
    embeddingBaseUrl: nonEmpty(cfg.embeddingBaseUrl),
    embeddingModel: nonEmpty(cfg.embeddingModel),
    hasEmbeddingApiKey: nonEmpty(cfg.embeddingApiKey) !== null,
    // …and the ENV halves, which it cannot, kept apart so the merge answers
    // identically to the browser's own `draftVectorInputs`.
    envEmbeddingProvider: envEmbeddingProvider(),
    envEmbeddingModel: nonEmpty(process.env.EMBEDDING_MODEL),
    envEmbeddingApiKeyProviders: envEmbeddingApiKeyProviders(),
  };
}

/**
 * Merge one validated `workbench` patch onto an existing config.
 *
 * ABSENT leaves a key untouched; `null` and `""` delete it. That distinction is
 * the whole reason the secrets are three-state on the client: a save that
 * quietly cleared a key the owner never touched would be the worst outcome on
 * this surface, and it is decided here, once, for every field.
 *
 * Returns a NEW object — `saveConfig` writes whatever it is handed, and mutating
 * the caller's `existing` would leave the sync cache holding the merged value
 * whether or not the write landed.
 */
export function applyWorkbenchSettings(
  existing: AppConfig,
  patch: WorkbenchSettingsPatch,
): AppConfig {
  const updated: AppConfig = { ...existing };

  const setText = <K extends keyof AppConfig>(
    key: K,
    value: string | null | undefined,
  ): void => {
    if (value === undefined) return;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (value === null || trimmed.length === 0) {
      delete updated[key];
    } else {
      (updated as Record<string, unknown>)[key as string] = trimmed;
    }
  };

  setText("chatProvider", patch.chatProvider);
  setText("chatModel", patch.chatModel);
  setText("ingestProvider", patch.ingestProvider);
  setText("ingestModel", patch.ingestModel);
  setText("customBaseUrl", patch.customBaseUrl);
  setText("customApiKey", patch.customApiKey);
  setText("embeddingProvider", patch.embeddingProvider);
  setText("embeddingModel", patch.embeddingModel);
  setText("embeddingBaseUrl", patch.embeddingBaseUrl);
  setText("embeddingApiKey", patch.embeddingApiKey);
  setText("firecrawlBaseUrl", patch.firecrawlBaseUrl);
  setText("firecrawlApiKey", patch.firecrawlApiKey);

  if (patch.llmTimeoutSeconds !== undefined) {
    if (patch.llmTimeoutSeconds === null) {
      delete updated.llmTimeoutSeconds;
    } else if (typeof patch.llmTimeoutSeconds === "number") {
      updated.llmTimeoutSeconds = patch.llmTimeoutSeconds;
    }
    // A string never reaches here: `validateWorkbenchSettingsPatch` refuses one
    // with a sentence, which is why the patch type admits it at all.
  }

  if (patch.vectorSearchEnabled !== undefined) {
    // `false` is stored explicitly rather than deleted: the default is already
    // false, but an owner who turned it OFF should read back as having done so
    // rather than as never having decided.
    updated.vectorSearchEnabled = patch.vectorSearchEnabled;
  }

  return updated;
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

  // API key — env, except for `custom`, whose credential MAY come from the
  // store (Story 1.9). Attributing a stored key to the environment would have
  // the legacy page's source badge point the owner at a variable nobody set.
  const resolvedApiKey = apiKeyForProvider(provider);
  const apiKeySource: SettingSource = !resolvedApiKey
    ? "none"
    : provider === "custom" && !nonEmpty(process.env.LLM_CUSTOM_API_KEY)
      ? "config"
      : "env";

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

  const structuredKnowledge = getStructuredKnowledgeModelSettings();

  return {
    provider,
    providerSource,
    model,
    modelSource,
    configured: providerIsConfigured(provider),
    embeddingSupport: hasEmbeddingSupport(),
    embeddingModel,
    embeddingModelSource,
    hasApiKey: resolvedApiKey !== null,
    apiKeySource,
    ollamaBaseUrl,
    ollamaBaseUrlSource,
    structuredKnowledgeProvider: structuredKnowledge.provider,
    structuredKnowledgeProviderSource: structuredKnowledge.providerSource,
    structuredKnowledgeModel: structuredKnowledge.model,
    structuredKnowledgeModelSource: structuredKnowledge.modelSource,
    structuredKnowledgeConfigured: structuredKnowledge.configured,
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
  /** The `custom` provider's OpenAI-compatible endpoint; null for every other. */
  customBaseUrl: string | null;
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
    return {
      provider: null,
      apiKey: null,
      model: null,
      ollamaBaseUrl: null,
      customBaseUrl: null,
    };
  }

  // API keys remain server-side environment secrets.
  const apiKey = apiKeyForProvider(provider);

  // Model
  const modelOverride = process.env.LLM_MODEL;
  let model: string | null;
  if (modelOverride) {
    model = modelOverride;
  } else if (cfg.model) {
    model = cfg.model;
  } else if (
    (provider === "ollama" || provider === "ollama-cloud") &&
    process.env.OLLAMA_MODEL
  ) {
    model = process.env.OLLAMA_MODEL;
  } else if (provider === "custom") {
    // `custom` has no `DEFAULT_MODELS` entry on purpose, and the `?? provider`
    // fallback below would resolve the literal string "custom" as a model NAME —
    // which reaches the owner's endpoint as a request for a model nobody has.
    // `null` here is what lets `getModel()` name the gap instead.
    model = null;
  } else {
    model = DEFAULT_MODELS[provider] ?? provider;
  }

  // Ollama base URL
  const ollamaBaseUrl =
    provider === "ollama-cloud"
      ? "https://ollama.com/api"
      : process.env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl ?? null;

  return {
    provider,
    apiKey,
    model,
    ollamaBaseUrl,
    customBaseUrl: provider === "custom" ? getCustomBaseUrl() : null,
  };
}
