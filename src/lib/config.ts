import type { ProviderInfo } from "./types";
import { getEmbeddingModelName, hasEmbeddingSupport } from "./embeddings";
import { isEnoent } from "./errors";
import { VALID_PROVIDERS, DEFAULT_MODELS, isEmbeddingProvider } from "./providers";
import type { EmbeddingProvider, ProviderValue } from "./providers";
import { logger } from "./logger";
import { getDataDir } from "./paths";
import { getStorage } from "./storage";
import {
  SETTINGS_LANGUAGE_VALUE,
  canEnableVectorSearch,
  embeddingProviderChanged,
  isAbsoluteHttpUrl,
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
  /**
   * The model this deployment ACTUALLY embeds with, resolved through
   * {@link getEmbeddingModelName} — the same door `embedText` goes through
   * (DW-274). Null when nothing embeds, which is exactly when
   * `embeddingSupport` is false.
   *
   * It is a SECOND field rather than a correction to `embeddingModel` because
   * the two answer different questions: `embeddingModel`/`embeddingModelSource`
   * say what is set and where, and this says what is in effect. The reasoning
   * lives on {@link embeddingModelAnswer}, the one helper BOTH Settings
   * resolvers derive this pair from (DW-312).
   */
  embeddingModelInEffect: string | null;
  /**
   * True when a model IS reported, something IS in effect, and they differ —
   * i.e. the reported model is being substituted on the embed path. False when
   * nothing is set (nothing to override) and false when nothing embeds (the
   * `embeddingSupport: false` story, not an override story).
   */
  embeddingModelOverridden: boolean;
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
 * The RESERVED key the settings write-precondition token is stored under, inside
 * the config object itself (DW-272).
 *
 * It used to be a sibling file, `.llm-wiki-config.version`, on the reasoning
 * that a field would make the token a pseudo-setting. What a second file
 * actually bought was a PAIRING no backend can keep consistent: two objects, two
 * round-trips, and on R2 no way to read them in one instant — so `readConfig`
 * had to order its two reads to choose WHICH mismatched pair it could produce.
 * One object has no pair to get wrong.
 *
 * The pseudo-setting worry is answered by STRIPPING rather than by separation:
 * {@link readStoredConfig} lifts this key out before returning, so `AppConfig`
 * as handed to its ~50 consumers — spread into `getWorkbenchSettings`, exported
 * in backups, diffed field-by-field by the suite — is exactly the fields it
 * always was. And "derived from NOTHING in the config" survives unchanged,
 * because it was never about WHERE the token lived: {@link newConfigVersion}
 * reads no field to make one.
 *
 * The double underscore marks it as not-a-setting to an owner reading the file,
 * and no `AppConfig` field can collide with it.
 *
 * A store written by the two-file scheme still reads: it has no such key, so it
 * answers the sentinel and the next save writes one object carrying a real
 * token. The orphan `.llm-wiki-config.version` is simply never read again — no
 * sweep, because deleting files an owner did not ask about is not this module's
 * business, and an unread file costs nothing.
 */
const CONFIG_VERSION_KEY = "__settingsVersion";

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
 * Misconfigurations already reported, so standing state is said ONCE.
 *
 * The same shape as `warnOnceAbout` in `embeddings.ts` — a module-level `Set`
 * keyed on the misconfiguration's identity — and a deliberate COPY rather than
 * an import: `embeddings.ts` imports this module, so importing it back would
 * close a cycle. An unusable Ollama endpoint is standing state, not an event:
 * it holds until someone edits the store or the environment, and
 * `getOllamaBaseUrl()` is read on every embed and every generation, so logging
 * per read would emit the same sentence thousands of times for one typo.
 *
 * The KEY is the source AND the value, because the sentence names where the
 * value came from: the same bad string in the environment and in the store are
 * two different things to fix, and an owner who only ever hears about one of
 * them cannot fix the other.
 */
const warnedEndpoints = new Set<string>();

/** Emit `message` the first time `key` is seen; later repeats are silent. */
function warnOnceAbout(key: string, message: string): void {
  if (warnedEndpoints.has(key)) return;
  warnedEndpoints.add(key);
  logger.warn("config", message);
}

/**
 * Forget every reported endpoint so the next occurrence warns again.
 *
 * Mirrors `_resetEmbeddingWarnings`: without it the first test to assert a
 * warning would silence it for every test after, and the warn-once COUNT is
 * exactly what these tests are about. Wired into the `beforeEach` of the suite
 * that asserts them.
 * @internal
 */
export function _resetConfigWarnings(): void {
  warnedEndpoints.clear();
}

/**
 * Returns the effective Ollama base URL.
 * Priority: `OLLAMA_BASE_URL` env var → config file `ollamaBaseUrl` → `undefined`.
 *
 * THE ONE PLACE THAT LADDER IS SPELLED (DW-326). `getResolvedCredentials` and
 * `getConfiguredModel` used to re-derive it, which is how a stored endpoint
 * applied on one path and not the other, and how a value that never passed a
 * URL check reached `createOllama`.
 *
 * VALIDATED HERE rather than only at the write door. DW-304 made
 * `PUT /api/settings` refuse an endpoint that is not an absolute `http(s)` URL,
 * which closes the door for values stored FROM NOW ON — it does nothing about a
 * value stored before that rule existed, one hand-edited into the config, or
 * `OLLAMA_BASE_URL` itself, which no route ever sees. A read-side check is the
 * only one all three pass through.
 *
 * AN UNUSABLE VALUE FALLS THROUGH; it does not throw. Throwing here would take
 * down every embed and every generation on a deployment whose only fault is a
 * typo in a variable the SDK has a working default for. So an unusable env value
 * falls to the stored one, an unusable stored value falls to `undefined`, and
 * `createOllama()` uses its own default — the same outcome as setting nothing,
 * which is the honest reading of "this endpoint cannot be used".
 *
 * BLANK IS UNSET, not invalid: `OLLAMA_BASE_URL=` and a whitespace-only stored
 * value mean "not configured" here exactly as `EMBEDDING_MODEL=` does to
 * {@link getEmbeddingModelOverride} (DW-227), and there is nothing to warn
 * about. The `??` chain this replaced handed `""` straight to the SDK.
 *
 * `cfg` is a PARAMETER defaulting to the sync cache, the DW-313 shape
 * `getEmbeddingModelName(cfg)` already uses, so a caller that has already read
 * the config resolves against the object it is holding rather than against
 * whatever the cache answers a moment later.
 */
export function getOllamaBaseUrl(cfg: AppConfig = loadConfigSync()): string | undefined {
  const fromEnv = nonEmpty(process.env.OLLAMA_BASE_URL);
  if (fromEnv !== null) {
    if (isAbsoluteHttpUrl(fromEnv)) return fromEnv;
    warnOnceAbout(
      `ollama-endpoint:env:${fromEnv}`,
      `OLLAMA_BASE_URL is not an absolute http(s) URL (${fromEnv}); ignoring it.`,
    );
  }
  const stored = nonEmpty(cfg.ollamaBaseUrl);
  if (stored !== null) {
    if (isAbsoluteHttpUrl(stored)) return stored;
    warnOnceAbout(
      `ollama-endpoint:config:${stored}`,
      `the stored Ollama endpoint is not an absolute http(s) URL (${stored}); ignoring it.`,
    );
  }
  return undefined;
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
 * still land: a store written by hand, restored from a backup, or written by the
 * two-file scheme this replaced has a config and no embedded token, and refusing
 * every save against it would strand the owner with no way through except
 * editing a file they cannot see from any surface.
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
  | {
      status: "ok";
      config: AppConfig;
      version: string;
      /**
       * The STORAGE layer's version of the bytes just read, for
       * {@link saveConfig}'s compare-and-set. `null` when there was nothing to
       * read, which is the one case a write cannot be conditional on.
       *
       * INTERNAL, and never served. R2's etag is an MD5 of the object's bytes,
       * and those bytes hold `customApiKey`, `embeddingApiKey` and
       * `firecrawlApiKey` — a content-derived value crossing the settings
       * boundary is exactly the AD-23 leak {@link newConfigVersion} exists to
       * avoid. It travels from `readConfig` to `saveConfig` inside one request
       * and appears in no response body.
       */
      etag: string | null;
    }
  | { status: "unreadable"; error: unknown };

/** Is this parsed JSON something `AppConfig` could be? */
function isPlainConfigObject(value: unknown): value is AppConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the config object: its settings, its embedded token, and its etag.
 *
 * ENOENT is `ok` with `{}` and the sentinel — an absent config is the documented
 * default and has always been, and its etag is `null` because there are no bytes
 * to compare against. Everything else is `unreadable`: a parse error, a
 * non-object parse (`null`, `[]`, `"x"` — all valid JSON, none of them a
 * config), and any storage failure that is not "not found". `isEnoent` covers
 * R2 too — `R2NotFoundError` sets `code = "ENOENT"` for exactly this.
 *
 * `readFileWithEtag` rather than `readFile`, on every read including the ~50
 * that only want defaults: it is the SAME single round-trip, the etag rides
 * along on both providers, and one read door means `loadConfig` and `readConfig`
 * cannot answer differently about the same store.
 *
 * THE TOKEN IS LIFTED AND STRIPPED. A missing key is the unstamped store, and so
 * is a key holding something {@link isStoredConfigVersion} does not recognise:
 * the token travels in `If-Match`, which carries one quoted value with no
 * embedded quote, so honouring a corrupted stamp verbatim would answer every
 * save 428 forever with no path out from any surface the owner can see. The
 * sentinel is the recoverable answer — the next save stamps a real one, so a
 * corrupted stamp SELF-HEALS — and it is logged, because a token nothing in this
 * module could have written means something else is writing that file.
 */
async function readStoredConfig(): Promise<
  | { status: "ok"; config: AppConfig; version: string; etag: string | null }
  | { status: "unreadable"; error: unknown }
> {
  let raw: string;
  let etag: string;
  try {
    const file = await getStorage().readFileWithEtag(configRelPath());
    raw = file.content;
    etag = file.etag;
  } catch (err) {
    if (isEnoent(err)) {
      return { status: "ok", config: {}, version: UNSTAMPED_CONFIG_VERSION, etag: null };
    }
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
  const stored = (parsed as Record<string, unknown>)[CONFIG_VERSION_KEY];
  let version = UNSTAMPED_CONFIG_VERSION;
  if (typeof stored === "string" && isStoredConfigVersion(stored)) {
    version = stored;
  } else if (stored !== undefined) {
    logger.warn("config", "config does not hold a usable version token; treating as unstamped");
  }
  const config = { ...(parsed as Record<string, unknown>) };
  delete config[CONFIG_VERSION_KEY];
  _configCache = { data: config as AppConfig, ts: Date.now() };
  return { status: "ok", config: config as AppConfig, version, etag };
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
 * Read the config AND the precondition token it is guarded by, honestly.
 *
 * This is the read the settings route runs, and the only one that can tell
 * "there is no config" from "the config could not be read".
 *
 * ONE OBJECT, ONE ROUND-TRIP (DW-272). It used to read a config file and a
 * sibling token file, and two files cannot be read in one instant: a concurrent
 * save could always land between them, so the only question was WHICH mismatched
 * pair the order produced, and R2 gave no way to make the pair atomic at all.
 * The token now rides INSIDE the object, so there is no pair — what this returns
 * is one snapshot of one store, on every backend.
 *
 * It also returns that snapshot's ETAG, which {@link saveConfig} uses to close
 * the read-modify-write window inside a single request. The etag is INTERNAL and
 * is never served; see {@link ConfigRead}.
 *
 * Populates the sync cache exactly as {@link loadConfig} does, so callers can
 * still reach `getWorkbenchSettings()`/`getEffectiveProvider()` right after.
 */
export async function readConfig(): Promise<ConfigRead> {
  return readStoredConfig();
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
 * THE LOSSY WRAPPER over {@link readConfig}, kept at exactly its old signature
 * and its old `{}`-on-failure contract because ~50 call sites depend on both.
 * Only the settings route needs to tell absent from broken, or needs the token
 * and the etag at all, and it calls `readConfig` instead.
 *
 * It is ONE storage read, not the two the sibling-file scheme made every caller
 * pay: since DW-272 the token lives inside the object, so a caller that wants
 * only the settings no longer opens a second file for a fact it does not
 * consume — nor degrades to `{}` because that file failed to open. The
 * `AppConfig` it gets back is the stored fields alone; the reserved key is
 * stripped before it leaves {@link readStoredConfig}.
 *
 * On R2 that read is also the same single round-trip `readFile` was, since the
 * etag rides on the object. On the filesystem provider `readFileWithEtag` adds a
 * `stat` beside the `readFile`, so these ~50 defaults-only reads pay one extra
 * local syscall each for an etag they do not use — cheaper than the second file
 * open it replaced, and the price of having ONE read door that cannot answer
 * differently to `loadConfig` and `readConfig`.
 */
export async function loadConfig(): Promise<AppConfig> {
  const read = await readStoredConfig();
  return read.status === "ok" ? read.config : {};
}

/**
 * The outcome of a settings write.
 *
 * `conflict` is the compare-and-set that LOST: the stored object changed between
 * the caller's read and this write, so nothing was written and the caller's
 * merge base is stale. It is a distinct answer rather than a thrown error
 * because it is an expected outcome on a store two surfaces write, and the route
 * turns it into the 412 the owner is owed.
 */
export type ConfigSave = { status: "ok"; version: string } | { status: "conflict" };

/**
 * Write the config, STAMPING a fresh precondition token inside the same object.
 *
 * ONE WRITE (DW-272). It used to write a token file and then the config file,
 * and to lean on that ORDER for its safety: a half-finished save left a token
 * nobody held, which refuses every open draft, rather than a token that still
 * matched a config which had already moved. One object needs no order — there is
 * no interleaving to be safe about, and no way for the pair to end up
 * disagreeing at all.
 *
 * `ifMatch` IS THE COMPARE-AND-SET, and it closes a different window from the
 * route's `If-Match` check. That check compares the OWNER'S draft token against
 * the store and refuses a draft seeded before someone else's save. It cannot see
 * a save that lands after this request read its merge base and before this
 * request writes it back — a read-modify-write inside one request — and that
 * save would be silently overwritten. `writeFileIfMatch` refuses instead, and
 * this answers `conflict` so the route can say so.
 *
 * HOW EXACT THAT REFUSAL IS DEPENDS ON THE BACKEND. On R2 it is exact: the
 * conditional put is evaluated server-side against the object's own etag, so a
 * losing writer cannot win. On the filesystem provider the etag is `mtime-size`
 * and `readFileWithEtag` pairs a `readFile` with a `stat`, so a concurrent
 * rewrite landing in the same millisecond at the same byte length produces a
 * MATCHING etag and the losing save is allowed through — and the check-then-write
 * is not one atomic step there either. That is a narrower window than the one
 * this closes, on the deployment shape (one local process) least likely to have
 * two concurrent writers at all; it is bounded and written down, not closed.
 *
 * WITHOUT an etag it writes unconditionally, and that is the FIRST write only:
 * `readConfig` returns `etag: null` exactly when there was no object to read.
 * Two concurrent first writes both land and the last wins. The storage interface
 * exposes no if-none-match, so the window cannot be closed from here; it is one
 * save on a store that has never been written, and it is written down rather
 * than pretended away.
 *
 * Returns the token it stamped, so the route answers the version the store now
 * holds without a second read. It also PRIMES the sync cache with what it just
 * wrote (it used to null it, which left `loadConfigSync` answering `{}` for the
 * whole 5 s TTL after every save, i.e. env-detected providers immediately after
 * the owner selected one) — with the CALLER'S object, not the stamped one, so
 * the cache holds exactly what `loadConfig` would hand back.
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
 * A REFUSED SAVE WRITES NOTHING. See {@link UNSTAMPED_CONFIG_VERSION} for what
 * this does not close.
 */
export async function saveConfig(
  config: AppConfig,
  ifMatch?: string | null,
): Promise<ConfigSave> {
  const version = newConfigVersion();
  // The reserved key is THIS function's to write, so strip whatever the caller
  // handed in before anything reads the object. `readStoredConfig` already
  // strips it, so no ordinary caller carries one — but a `PUT` body naming the
  // key reaches the merge, and without this the cache below would be primed with
  // a key a re-read removes, which is the sync/async disagreement stripping
  // exists to prevent. Stripping here also means a body cannot forge a token or
  // unstamp the store: whatever it says, the value written is the fresh one.
  const stored = { ...config };
  delete (stored as Record<string, unknown>)[CONFIG_VERSION_KEY];
  const body =
    JSON.stringify({ ...stored, [CONFIG_VERSION_KEY]: version }, null, 2) + "\n";
  const storage = getStorage();
  // EXPLICITLY a non-empty string, not truthiness. `undefined`, `null` and `""`
  // all mean the same thing here — "no version to compare against, write
  // unconditionally" — and the point of spelling it out is that this is now a
  // decision rather than a coincidence of `if (ifMatch)`. The only value that
  // legitimately reaches it is `readConfig`'s `etag: null`, i.e. the first write
  // into a store that has never held an object. An empty STRING would mean a
  // storage provider answered something unusable; neither shipped provider can,
  // and if one ever did this would degrade to the first-write case rather than
  // sending `""` to a compare-and-set that cannot interpret it.
  if (typeof ifMatch === "string" && ifMatch.length > 0) {
    const wrote = await storage.writeFileIfMatch(configRelPath(), body, ifMatch);
    if (!wrote) return { status: "conflict" };
  } else {
    await storage.writeFile(configRelPath(), body);
  }
  _configCache = { data: stored, ts: Date.now() };
  return { status: "ok", version };
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
    // The `cfg` read at the top of this function, not a fresh one (DW-313).
    // `loadConfigSync()` is a 5 s-TTL cache, so re-entering it here would let
    // "which provider is active" and "can it embed?" describe two different
    // snapshots — on one `ProviderInfo` object, served by `/api/status`,
    // `POST /api/settings/test` and the `effective` field of `PUT /api/settings`.
    embeddingSupport: hasEmbeddingSupport(cfg),
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
 * The WHOLE embedding-model answer, derived from ONE config snapshot.
 *
 * Four values, two questions. `model`/`source` say what is SET and where it
 * came from; `inEffect`/`overridden` say what this deployment actually embeds
 * with and whether that differs. Both Settings surfaces answer both questions,
 * and they answer them from HERE rather than from two expressions that agree
 * today (DW-312): the flat `/settings` page and the Workbench canvas were
 * telling an owner different things about the same config, because only
 * `getEffectiveSettings` carried the second half.
 *
 * `cfg` is a PARAMETER, and every leg below resolves against it — including
 * `getEmbeddingModelName(cfg)`, which threads it all the way through the
 * provider and key resolution (DW-313). `loadConfigSync()` is a 5 s-TTL cache,
 * so a helper that re-read it per leg could describe a snapshot its caller
 * never saw — on a cold cache, "set to X from config" beside "in effect: the
 * provider default", i.e. a substitution that is not happening.
 *
 * WHAT IS SET (`model`/`source`)
 *
 * Read through the same accessor the resolver uses (DW-227), so a blank or
 * whitespace-only `EMBEDDING_MODEL` is reported as "not set from env" rather
 * than as an env-sourced model name nothing would ever embed with.
 *
 * BOTH legs are trimmed, not just the env one: a stored `"   "` (reachable
 * from a pre-change flat write or a hand-edited config) would otherwise be
 * reported as a config-sourced model name while `resolveEmbeddingModelName`
 * trims it away and embeds with the provider default — the same split, one
 * leg over. Every sibling reader of this key (`getVectorSearchSettings`,
 * `getWorkbenchSettings`, `workbenchSettingsStored`) already uses `nonEmpty`.
 *
 * WHAT IS IN EFFECT (`inEffect`/`overridden`, DW-274)
 *
 * The pair above does not say what embeds: `resolveEmbeddingModelName` applies
 * `embeddingModelMatchesProvider` before honouring the value, so on a Workers
 * AI deployment with `EMBEDDING_MODEL=text-embedding-3-small` the pair above is
 * truthfully "env, text-embedding-3-small" while `embedText` runs on
 * `@cf/baai/bge-m3`. A surface whose whole job is "what is in effect and where
 * did it come from" has to be able to say both.
 *
 * Read through `getEmbeddingModelName()` — the resolver's own door, the one
 * every embed path uses — and NOT by re-applying the predicate here. A rule
 * stated twice is two rules that agree today. (The resolver's mismatch warning
 * is throttled once per `(provider, override)` per process (DW-273), so a
 * settings read cannot make it spam.)
 *
 * The reported pair is deliberately left alone rather than replaced with the
 * resolved name: `useSettings` seeds the editable model input from
 * `embeddingModel` whenever the source is `config`, so a provider default
 * leaking into it would put a value the owner never chose into their box — and
 * the next save would write it into the store.
 *
 * `overridden` is true only when a model IS reported, something IS in effect,
 * and they differ. False when nothing is set (nothing to override) and false
 * when nothing embeds (the `embeddingSupport: false` story, not an override
 * story).
 */
function embeddingModelAnswer(cfg: AppConfig): {
  model: string | null;
  source: SettingSource;
  inEffect: string | null;
  overridden: boolean;
} {
  const envEmbeddingModel = getEmbeddingModelOverride();
  const storedEmbeddingModel = nonEmpty(cfg.embeddingModel);
  let model: string | null;
  let source: SettingSource;
  if (envEmbeddingModel) {
    model = envEmbeddingModel;
    source = "env";
  } else if (storedEmbeddingModel) {
    model = storedEmbeddingModel;
    source = "config";
  } else {
    model = null;
    source = "none";
  }

  const inEffect = getEmbeddingModelName(cfg);
  return {
    model,
    source,
    inEffect,
    overridden: model !== null && inEffect !== null && inEffect !== model,
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
  // Resolved from the `cfg` already read above, through the ONE helper
  // `getEffectiveSettings` uses (DW-312/DW-313) — so the two Settings surfaces
  // cannot answer "is the model I set being substituted?" differently.
  const embedding = embeddingModelAnswer(cfg);
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
    // What this deployment is EMBEDDING with right now, and whether that is a
    // substitution for the model above (DW-312). Not editable, and not a key:
    // one model name and one boolean. The canvas cannot derive either — the
    // resolver's `embeddingModelMatchesProvider` rule runs server-side over the
    // env and the store together — so the answer is served rather than computed
    // in the browser.
    embeddingModelInEffect: embedding.inEffect,
    embeddingModelOverridden: embedding.overridden,
    // What a save cannot change and what wins at runtime, served apart from the
    // editable fields so the browser can feed the vector predicate exactly what
    // the route feeds it.
    envEmbeddingProvider: envProvider,
    envEmbeddingModel: nonEmpty(process.env.EMBEDDING_MODEL),
    // The THIRD variable that wins over a box on this surface (DW-71), served
    // for the same reason as the two above and read through the same `nonEmpty`
    // that `getCustomBaseUrl()` resolves it with — so a blank or whitespace-only
    // `LLM_CUSTOM_BASE_URL` is "unset" to the sentence exactly as it is to the
    // resolver, rather than announcing an override that is not happening.
    envCustomBaseUrl: nonEmpty(process.env.LLM_CUSTOM_BASE_URL),
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

  // CLEAR ON SWITCH, decided from `existing` BEFORE any mutation (DW-69/DW-72).
  //
  // One `embeddingApiKey` and one `embeddingBaseUrl` serve whichever vendor is
  // selected, so a save that moves `embeddingProvider` from `openai` to `google`
  // would otherwise hand Google OpenAI's secret and point it at OpenAI's
  // endpoint — while the surface still read "A key is stored." and the vector
  // gate still passed on the strength of the old vendor's credential. The store
  // is what makes the shared read correct: the fields stay FLAT (no per-provider
  // keying, no migration), and they are simply dropped when the vendor moves.
  //
  // A VALUE comparison, never presence: `settingsSaveBody` sends
  // `embeddingProvider` on every save, so presence would clear the key on an
  // unrelated timeout edit. Absent from the patch means "leave it alone", which
  // is not a move — hence the `undefined` arm below reads `existing`.
  //
  // CLEAR, THEN APPLY. The delete drops what the STORE held; the `setText` calls
  // below then write whatever THIS request explicitly carried. That order is
  // what lets one save both switch vendor and supply the new credential.
  const embeddingProviderSwitched = embeddingProviderChanged(
    existing.embeddingProvider ?? null,
    patch.embeddingProvider === undefined
      ? existing.embeddingProvider ?? null
      : patch.embeddingProvider,
  );
  if (embeddingProviderSwitched) {
    // …and the derived `hasEmbeddingApiKey` flag follows for free: every payload
    // builder reads it off the store.
    delete updated.embeddingApiKey;
    delete updated.embeddingBaseUrl;
  }

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

  // Ollama base URL — REPORTED FROM THE ONE LADDER (DW-326).
  //
  // This used to spell the ladder itself, on a truthiness check and with no URL
  // check at all, which made it the last place the flat `/settings` page could
  // disagree with the runtime: `ProviderForm` renders this value beside an
  // env/config badge, so an unusable `OLLAMA_BASE_URL` was shown as the endpoint
  // in effect while `getOllamaBaseUrl()` discarded it and the SDK fell to its own
  // default. That is the same shape DW-71 closes for the Custom endpoint on the
  // other surface, and a settings screen that names an endpoint nothing talks to
  // is worse than one that says "none".
  //
  // The SOURCE is derived from WHICH leg survived, not re-walked: the resolver
  // takes the env value only when it is usable, so comparing the answer against
  // the env leg read the same way (`nonEmpty`, so a padded variable matches) is
  // what keeps the badge honest when the env value was the one thrown away.
  let ollamaBaseUrl: string | null;
  let ollamaBaseUrlSource: SettingSource;
  if (provider === "ollama-cloud") {
    ollamaBaseUrl = "https://ollama.com/api";
    ollamaBaseUrlSource = "default";
  } else {
    ollamaBaseUrl = getOllamaBaseUrl(cfg) ?? null;
    if (ollamaBaseUrl === null) {
      ollamaBaseUrlSource = "none";
    } else if (ollamaBaseUrl === nonEmpty(process.env.OLLAMA_BASE_URL)) {
      ollamaBaseUrlSource = "env";
    } else {
      ollamaBaseUrlSource = "config";
    }
  }

  // Embedding model — BOTH halves of the answer, from the one snapshot read at
  // the top of this function (DW-274, DW-312, DW-313). The reasoning for each
  // leg lives on {@link embeddingModelAnswer}, which is also what
  // `getWorkbenchSettings` calls, so the two Settings surfaces cannot drift
  // into describing the same config differently.
  const embedding = embeddingModelAnswer(cfg);

  const structuredKnowledge = getStructuredKnowledgeModelSettings();

  return {
    provider,
    providerSource,
    model,
    modelSource,
    configured: providerIsConfigured(provider),
    // The SAME `cfg` every other half of this answer is resolved against
    // (DW-313) — "does this deployment embed?" and "with what?" are one
    // question, and a second read of the 5 s-TTL cache could answer them about
    // two different snapshots.
    embeddingSupport: hasEmbeddingSupport(cfg),
    embeddingModel: embedding.model,
    embeddingModelSource: embedding.source,
    embeddingModelInEffect: embedding.inEffect,
    embeddingModelOverridden: embedding.overridden,
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

  // Ollama base URL, through the ONE accessor that spells the ladder (DW-326).
  // This copy used to re-derive it — `process.env.OLLAMA_BASE_URL ??
  // cfg.ollamaBaseUrl` — and it is the copy that reaches `createOllama` via
  // `llm.ts`, so an unusable value bypassed every check on its way to the SDK.
  // Called with the `cfg` already read above rather than letting the accessor
  // take the cache, so both halves of this function answer from one object.
  const ollamaBaseUrl =
    provider === "ollama-cloud"
      ? "https://ollama.com/api"
      : getOllamaBaseUrl(cfg) ?? null;

  return {
    provider,
    apiKey,
    model,
    ollamaBaseUrl,
    customBaseUrl: provider === "custom" ? getCustomBaseUrl() : null,
  };
}
