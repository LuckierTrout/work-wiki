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
  type VectorSearchInputs,
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
 * WHAT IT REFUSES BY ITSELF (DW-187, DW-188): PAGE AND SCHEMA WRITES, AND
 * NOTHING ELSE. The four kernel writers —
 * `writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata` and
 * `writeWikiArtifact` — call `assertWritable` in `read-only.ts`, so every page
 * create, edit, revert, delete, metadata patch and artifact save is refused no
 * matter which caller reaches it: REST, the stdio MCP server in `src/mcp.ts`,
 * the CLI, agents, ingest, lint-fix, merge and `deleteTenant` all inherit it.
 * Every API route that can reach one of those writers classifies the resulting
 * `ReadOnlyError` as 403 — pinned by `read-only-door-coverage.test.ts`.
 *
 * WHAT IT DOES *NOT* REFUSE, AND THIS LIST IS THE POINT OF THIS PARAGRAPH. The
 * gate is four functions, not a deployment-wide write lock, so a new caller
 * MUST CHECK before assuming coverage. Still writable with the flag set, unless
 * a route spells its own `isReadOnly()`: the settings store, the Wiki registry
 * and workspace profile (`/api/wikis*`, `/api/workspace-profile` — each gated
 * separately at its route), vaults, agent profiles and tokens, tasks and the
 * queue, source monitors and digests, structured knowledge and the graph, the
 * ingest ledger, ingest-job records and staged uploads, `raw/` snapshots, the
 * revision store, the operation ledger, the integration outbox, backups, and
 * `bumpDataVersion`. None of those flows through a kernel writer.
 *
 * A ROUTE SPELLS ITS OWN CHECK ONLY WHERE THE KERNEL REFUSAL ARRIVES TOO LATE
 * to shape the response — irreversible side effects already committed, or
 * expensive/failable work whose own error would mask the refusal. That is why
 * `DELETE /api/ingest/history` (swallows per-page failures and would still
 * clear ingest jobs), every `/api/ingest/*` door plus the email, agent-ingest
 * and `tasks/run` consumers (staged bytes, job records, `raw/` snapshots and
 * two LLM calls all precede the write), `POST /api/query/save` (bakes and
 * stores illustrations first) and `POST /api/lint/fix` (an LLM rewrite first)
 * each keep one. Every other door relies on the kernel plus a catch that maps
 * `isReadOnlyError` to 403. The three `/api/wiki/[slug]` gates stay because
 * each answers BEFORE the existence read, which is what keeps "unknown slug →
 * 403, no existence oracle" true (DW-37).
 *
 * DELIBERATELY OUT OF SCOPE: the `If-Match` write-precondition guard is a
 * separate open decision (DW-196).
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

/**
 * Relative path for the settings WRITE-PRECONDITION TOKEN, a sibling of the
 * config file rather than a field inside it.
 *
 * A field would make the token a pseudo-setting: `AppConfig` is spread into
 * `getWorkbenchSettings`, exported in backups, diffed field-by-field by the
 * suite, and hand-edited by owners. A sibling file keeps the config's stored
 * shape byte-identical to what it was before the guard existed, which is what
 * makes "the version is derived from NOTHING in the config" a structural fact
 * rather than a promise about which fields the hash skipped.
 */
function configVersionRelPath(): string {
  return ".llm-wiki-config.version";
}

export function getConfigPath(): string {
  return `${getDataDir()}/.llm-wiki-config.json`;
}

// ---------------------------------------------------------------------------
// Centralised env-var accessors for embedding / Ollama settings
// ---------------------------------------------------------------------------

/**
 * Returns the `EMBEDDING_MODEL` env override, or `undefined` if not set.
 *
 * Read through {@link nonEmpty}, so `EMBEDDING_MODEL=` and a whitespace-only
 * value are "unset" here exactly as they already are to
 * {@link getVectorSearchSettings} (DW-227). Without the trim the same variable
 * read as absent to the gate and as a model NAME to the resolver, which then
 * handed a blank string to the provider; and a padded id was accepted by the
 * gate (which trims) and dropped by the resolver (which did not).
 */
export function getEmbeddingModelOverride(): string | undefined {
  return nonEmpty(process.env.EMBEDDING_MODEL) ?? undefined;
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
 * What `GET`/`PUT /api/settings` ANSWER when the settings store cannot be read.
 *
 * ONE sentence, owned here beside the read that produces the condition, never
 * typed at a route or a render site. It is deliberately NOT the write-conflict
 * wording: nothing is known to have changed and nothing was refused for being
 * stale — the store simply could not be opened, so the honest thing to say is
 * "temporary, try again", not "someone else edited this".
 *
 * The recovery half is the conflict copy's, word for word, because the owner's
 * situation is identical: a draft is on screen, reloading destroys it, and
 * copying it out first is the only thing that saves it.
 *
 * IT REACHES THE OWNER ON `PUT`, AND ONLY THERE. Both surfaces relay the
 * server's `{ error }` verbatim on a refused save, so this is the sentence a
 * refused save shows. On `GET` it is the route's honest BODY and nothing
 * renders it: `fetchWorkbenchSettings` maps every non-ok response to the same
 * `failed`, and `useSettings.fetchSettings` throws its own fixed string — both
 * deliberately, because a read must grant no oracle, and a body that told a
 * reader which way the read failed would be one. That asymmetry is the design,
 * not a gap: the write is the verb the owner is owed an explanation for.
 */
export const CONFIG_UNREADABLE_COPY =
  "The settings store could not be read, so nothing was changed. This is usually temporary — copy anything you have unsaved, then reload and try again.";

/**
 * The version a store that has a config but has never been stamped reports.
 *
 * ONE fixed sentinel rather than `null`, so a first save through the API can
 * still land: a store written by hand, restored from a backup, or created
 * before this scheme existed has a config and no token, and refusing every save
 * against it would strand the owner with no way through except deleting a file
 * they cannot see.
 *
 * ITS OWN RESIDUAL. While a store is unstamped, two surfaces hold this same
 * constant, so a save from either matches and neither is refused — the guard is
 * off between them. The window is the FIRST save only: {@link saveConfig}
 * stamps a real token every time, so the second surface through is checked
 * against a real one.
 *
 * THE LARGER RESIDUAL, WHICH IS NOT LIMITED TO UNSTAMPED STORES. The stamp
 * tracks SAVES, not bytes, so a hand edit of `.llm-wiki-config.json` leaves the
 * version standing — on a stamped store just as much as on an unstamped one —
 * and a draft seeded before that edit saves straight over it. The
 * content-derived version this replaced DID move for a hand edit and refused
 * that save. Losing that is the price paid to get `firecrawlApiKey`,
 * `customApiKey` and `embeddingApiKey` out of the value served on a boundary
 * AD-23 says no secret material crosses: a version computed over the store is a
 * function of everything in it, and there is no version that is both derived
 * from the bytes and independent of the secrets among them. The guard is
 * defined over writes THROUGH THE API, which is what it was always able to
 * check; editing the file underneath a running app was never a supported way to
 * change settings. It is not closed; it is bounded and written down.
 *
 * `s1:` names the scheme, the same way `w1:` does in `write-precondition.ts`,
 * so a token from a future scheme can never be mistaken for a match.
 */
export const UNSTAMPED_CONFIG_VERSION = "s1:unstamped";

/**
 * A fresh settings precondition token.
 *
 * DERIVED FROM NOTHING IN THE CONFIG. Not a hash of the file, not of the parsed
 * object, not of any subset of fields that happens to exclude the secrets
 * today. `firecrawlApiKey`, `customApiKey` and `embeddingApiKey` live in this
 * store, and AD-23 says no secret material crosses the settings boundary — a
 * content-derived version is exactly that material, re-encoded. A random token
 * cannot leak what it does not read, and it answers the only question the guard
 * asks ("is this the same store state the draft was seeded from") just as well.
 *
 * 32 hex characters out of `crypto.randomUUID()`: available identically in
 * node, in the browser and in the Worker, and wide enough that two saves never
 * collide.
 */
export function newConfigVersion(): string {
  return `s1:${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * The settings store as it actually is: readable, or not.
 *
 * `unreadable` is the case {@link loadConfig} cannot express. It answers `{}`
 * for an ABSENT config and for a FAILED read alike, which is right for the ~50
 * consumers that just want defaults and wrong for the one that merges a patch
 * into what it read: a transient storage error would make `{}` the merge base
 * and write away every stored field, including the three API keys.
 */
export type ConfigRead =
  | { status: "ok"; config: AppConfig; version: string }
  | { status: "unreadable"; error: unknown };

/** Is this parsed JSON something `AppConfig` could be? */
function isPlainConfigObject(value: unknown): value is AppConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The config half of {@link readConfig}: parse the file, or say it is broken.
 *
 * ENOENT is `ok` with `{}` — an absent config is the documented default and has
 * always been. Everything else is `unreadable`: a parse error, a non-object
 * parse (`null`, `[]`, `"x"` — all valid JSON, none of them a config), and any
 * storage failure that is not "not found".
 */
async function readStoredConfig(): Promise<
  { status: "ok"; config: AppConfig } | { status: "unreadable"; error: unknown }
> {
  let raw: string;
  try {
    raw = await getStorage().readFile(configRelPath());
  } catch (err) {
    if (isEnoent(err)) return { status: "ok", config: {} };
    logger.warn("config", "load config failed:", err);
    return { status: "unreadable", error: err };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("config", "load config failed:", err);
    return { status: "unreadable", error: err };
  }
  if (!isPlainConfigObject(parsed)) {
    const err = new Error("config file does not hold a JSON object");
    logger.warn("config", "load config failed:", err);
    return { status: "unreadable", error: err };
  }
  _configCache = { data: parsed, ts: Date.now() };
  return { status: "ok", config: parsed };
}

/**
 * Every shape a stored token may legitimately have.
 *
 * The sentinel, or exactly what {@link newConfigVersion} produces — there is no
 * third. Anything else in the file was not written by this module.
 */
function isStoredConfigVersion(value: string): boolean {
  return value === UNSTAMPED_CONFIG_VERSION || /^s1:[0-9a-f]{32}$/.test(value);
}

/**
 * The token half of {@link readConfig}.
 *
 * ENOENT is the UNSTAMPED store, which is `ok` with the sentinel. Any other
 * READ FAILURE is `unreadable`, and it has to be: answering the sentinel for a
 * storage error would let a save land against a store whose real token nobody
 * checked, which is the lost update the guard exists to catch.
 *
 * A file that READS but does not hold a token is a different fact, and it
 * answers the SENTINEL rather than `unreadable`. The token travels in `If-Match`
 * and `parseIfMatch` accepts one quoted value with no embedded quote, so a
 * stamp corrupted to contain a quote, a newline, or anything else the header
 * cannot carry would make every save 428 forever, with no path out that does not
 * involve deleting a file the owner cannot see from any surface. `unreadable`
 * would be the same lockout wearing a 503. The sentinel is the recoverable
 * answer: the owner's next save lands and stamps a real token, so a corrupted
 * stamp SELF-HEALS. The cost is the unstamped window's cost, once — and a
 * lockout with no way out is worse than one save that goes unchecked. It is
 * logged, because a token nothing in this module could have written means
 * something else is writing that file.
 */
async function readStoredVersion(): Promise<
  { status: "ok"; version: string } | { status: "unreadable"; error: unknown }
> {
  let raw: string;
  try {
    raw = await getStorage().readFile(configVersionRelPath());
  } catch (err) {
    if (isEnoent(err)) return { status: "ok", version: UNSTAMPED_CONFIG_VERSION };
    logger.warn("config", "load config version failed:", err);
    return { status: "unreadable", error: err };
  }
  const version = raw.trim();
  if (!isStoredConfigVersion(version)) {
    // A present-but-empty file is the ordinary case of this — a half-written
    // stamp — and is not worth a distinct answer.
    if (version.length > 0) {
      logger.warn("config", "config version file does not hold a token; treating as unstamped");
    }
    return { status: "ok", version: UNSTAMPED_CONFIG_VERSION };
  }
  return { status: "ok", version };
}

/**
 * Read the config AND the precondition token it is guarded by, honestly.
 *
 * This is the read the settings route runs, and the only one that can tell
 * "there is no config" from "the config could not be read". Both files must
 * answer: a readable config beside an unreadable token is still `unreadable`,
 * because the version the route would serve and compare would be a guess.
 *
 * THE TOKEN IS READ FIRST, and the order is the safety property — the read side
 * of the one {@link saveConfig} spells on the write side, inverted for the same
 * reason. Two files cannot be read in one instant, so a concurrent save can
 * always land between them, and the only question is WHICH mismatched pair this
 * function can produce.
 *
 * Token first can only ever yield (STALE token, fresh config): the surface is
 * seeded from current values labelled with a version the store no longer holds,
 * so its next `PUT` is refused 412 for a change that did happen. A false
 * refusal, recovered by reloading.
 *
 * Config first yields (stale config, FRESH token): the surface is seeded from
 * SUPERSEDED values wearing the current version, its next `PUT` MATCHES, and it
 * writes those superseded values over the save that just landed. That is the
 * silent lost update the whole guard exists to catch, reintroduced by the order
 * of two reads. As on the write side: a refusal nobody expected is recoverable,
 * a silent overwrite is not.
 *
 * Populates the sync cache exactly as {@link loadConfig} does, so callers can
 * still reach `getWorkbenchSettings()`/`getEffectiveProvider()` right after.
 */
export async function readConfig(): Promise<ConfigRead> {
  const version = await readStoredVersion();
  if (version.status === "unreadable") return version;
  const config = await readStoredConfig();
  if (config.status === "unreadable") return config;
  return { status: "ok", config: config.config, version: version.version };
}

/**
 * Read and parse the config file. Returns `{}` if the file doesn't exist, if it
 * cannot be read, or if it does not hold a JSON OBJECT — the last of those is
 * new: `null`, `[1,2,3]` and `"x"` are all valid JSON and used to be cast to
 * `AppConfig` and handed to every caller verbatim, so a `.length` or a spread
 * met something that was not a config. Also populates the sync cache as a side
 * effect so that subsequent `loadConfigSync()` calls return the up-to-date
 * config.
 *
 * THE LOSSY WRAPPER over {@link readConfig}'s config half, kept at exactly its
 * old signature and its old `{}`-on-failure contract because ~50 call sites
 * depend on both. Only the settings route needs to tell absent from broken, and
 * it calls `readConfig` instead. It reads the config file ONLY: a caller that
 * wants defaults has no use for the token, and making every one of those ~50
 * reads pay a second storage round-trip — or degrade to `{}` because a file
 * they never look at failed to open — would be a cost and a regression for a
 * fact they do not consume.
 */
export async function loadConfig(): Promise<AppConfig> {
  const read = await readStoredConfig();
  return read.status === "ok" ? read.config : {};
}

/**
 * Write config JSON via storage provider, and STAMP a fresh precondition token.
 *
 * THE TOKEN FILE IS WRITTEN FIRST, and the order is the safety property. If the
 * config write then fails, the served token matches no open draft: every
 * surface is refused, nothing was silently overwritten, and the owner recovers
 * by reloading. The reverse order would leave a token that still matches a
 * config which had already changed — a save that should have been refused
 * lands, which is precisely the lost update this guard exists to catch. A
 * refusal nobody expected is recoverable; a silent overwrite is not.
 *
 * Returns the token it stamped, so the route answers the version the store now
 * holds without a second read. It also PRIMES the sync cache with what it just
 * wrote (it used to null it, which left `loadConfigSync` answering `{}` for the
 * whole 5 s TTL after every save, i.e. env-detected providers immediately after
 * the owner selected one).
 *
 * EVERY SAVE ROTATES, INCLUDING ONE THAT CHANGED NOTHING. The token is a fact
 * about writes, not about content, so a no-op save — the owner pressing Save on
 * an untouched form — invalidates the other Settings surface's draft, and that
 * surface is answered 412 for a change nobody made. The content-derived version
 * moved only when content moved and would not have. This is the same trade as
 * the residual in {@link UNSTAMPED_CONFIG_VERSION}, in the other direction: the
 * stamp errs toward refusing, and a false refusal costs one reload, where the
 * derived version's cost was the secrets.
 *
 * See {@link UNSTAMPED_CONFIG_VERSION} for what this does not close.
 */
export async function saveConfig(config: AppConfig): Promise<string> {
  const version = newConfigVersion();
  const storage = getStorage();
  await storage.writeFile(configVersionRelPath(), version + "\n");
  await storage.writeFile(
    configRelPath(),
    JSON.stringify(config, null, 2) + "\n",
  );
  _configCache = { data: { ...config }, ts: Date.now() };
  return version;
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
  const envProvider = envEmbeddingProvider();
  const provider = envProvider ?? nonEmpty(cfg.embeddingProvider);
  const envModel = nonEmpty(process.env.EMBEDDING_MODEL);
  const inputs: VectorSearchInputs = {
    provider,
    baseUrl: nonEmpty(cfg.embeddingBaseUrl),
    model: envModel ?? nonEmpty(cfg.embeddingModel),
    hasKey: embeddingKeyPresent(cfg, provider),
    // The same `??` above, read as a question about origin.
    modelOrigin: envModel !== null ? "env" : "stored",
    // …and the same question about the provider (DW-281). Nothing on this
    // caller's answer turns on it — the binding leg it selects a note for is
    // never applied here (`hasWorkersAiBinding: null`) — but the field has no
    // default, precisely so a constructor cannot forget it and quietly claim
    // the store owns a value the environment forces.
    providerOrigin: envProvider !== null ? "env" : "stored",
    // NOT KNOWN HERE, and deliberately left that way (DW-225).
    //
    // `getWorkersAiBinding()` lives in `embeddings.ts`, which imports THIS
    // module; the one edge this file already has in that direction
    // (`hasEmbeddingSupport`) is as far as that cycle is allowed to go, and
    // `getVectorSearchSettings` is a SYNC CACHE READ that any code path may call
    // off a Workers request scope, where `getCloudflareContext()` throws and the
    // answer would be a misleading `false` rather than "unknown". So this caller
    // takes no runtime parameter and spells the third state instead: `null`
    // applies no binding leg, which is this function's answer today exactly.
    // Nothing is lost by it — the embed path refuses independently, since
    // `resolveEmbeddingProvider` returns `null` for `workers-ai` with no
    // binding. The ROUTE, which is always inside a request, is the one caller
    // that passes the real fact in.
    hasWorkersAiBinding: null,
  };
  return {
    // The four DECLARED fields, named rather than spread: the two inputs above
    // that exist only for the gate must not leak onto `VectorSearchSettings`,
    // where a consumer could read `hasWorkersAiBinding: null` as "no binding".
    enabled: cfg.vectorSearchEnabled === true && canEnableVectorSearch(inputs),
    provider: inputs.provider,
    baseUrl: inputs.baseUrl,
    model: inputs.model,
    hasKey: inputs.hasKey,
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
 *
 * `hasWorkersAiBinding` arrives as a PARAMETER rather than being read here
 * (DW-225): it is `getWorkersAiBinding() !== null`, which only makes sense
 * inside a Workers request scope and lives in `embeddings.ts`. The route reads
 * it once and hands it to both this resolver and
 * {@link workbenchSettingsStored}, so both halves of the one vector rule see the
 * same fact. It is required, with no default, because neither default is safe:
 * `true` would enable the switch on a deployment with no binding and `false`
 * would refuse `workers-ai` on Workers itself.
 */
export function getWorkbenchSettings(
  hasWorkersAiBinding: boolean,
): WorkbenchSettingsValues {
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
    // The RUNTIME fact the browser cannot ask for, passed in by the route.
    hasWorkersAiBinding,
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
 *
 * `hasWorkersAiBinding` is the same runtime fact the payload carries, and it
 * comes from the same one read in the route — see {@link getWorkbenchSettings}.
 * If these two disagreed, the browser and the route would answer the vector rule
 * differently for the same deployment, which is precisely what this seam exists
 * to rule out.
 */
export function workbenchSettingsStored(
  cfg: AppConfig,
  hasWorkersAiBinding: boolean,
): WorkbenchSettingsStored {
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
    hasWorkersAiBinding,
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

  // Embedding model.
  //
  // Through the same accessor the resolver uses (DW-227), so a blank or
  // whitespace-only `EMBEDDING_MODEL` is reported as "not set from env" rather
  // than as an env-sourced model name nothing would ever embed with.
  //
  // BOTH legs are trimmed, not just the env one: a stored `"   "` (reachable
  // from a pre-change flat write or a hand-edited config) would otherwise be
  // reported as a config-sourced model name while `resolveEmbeddingModelName`
  // trims it away and embeds with the provider default — the same split, one
  // leg over. Every sibling reader of this key (`getVectorSearchSettings`,
  // `getWorkbenchSettings`, `workbenchSettingsStored`) already uses `nonEmpty`.
  const envEmbeddingModel = getEmbeddingModelOverride();
  const storedEmbeddingModel = nonEmpty(cfg.embeddingModel);
  let embeddingModel: string | null;
  let embeddingModelSource: SettingSource;
  if (envEmbeddingModel) {
    embeddingModel = envEmbeddingModel;
    embeddingModelSource = "env";
  } else if (storedEmbeddingModel) {
    embeddingModel = storedEmbeddingModel;
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
