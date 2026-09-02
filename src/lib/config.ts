import path from "node:path";
import type { ProviderInfo } from "./types";
import { getEmbeddingResolution, hasEmbeddingSupport } from "./embeddings";
import { isEnoent } from "./errors";
import { VALID_PROVIDERS, DEFAULT_MODELS, isEmbeddingProvider } from "./providers";
import type { EmbeddingProvider, ProviderValue } from "./providers";
import { logger } from "./logger";
import { getDataDir } from "./paths";
import { sourceSha256 } from "./source-sha256";
import { getStorage } from "./storage";
import { LOOPBACK_TOKEN_ENV, type LoopbackTokenSource } from "./v1-contract";
import {
  SETTINGS_LANGUAGE_VALUE,
  canEnableVectorSearch,
  embeddingProviderChanged,
  flatTextFieldAction,
  isAbsoluteHttpUrl,
  isMinerUMode,
  isResearchProviderId,
  ollamaBaseUrlRefusedCopy,
  DEFAULT_SERPAPI_ENGINE,
  type ResearchProviderId,
  type VectorSearchInputs,
  type WorkbenchSettingsPatch,
  type WorkbenchSettingsStored,
  type WorkbenchSettingsValues,
} from "./workbench-settings";
import { LOOPBACK_MCP_ENTRY } from "./workbench-api-mcp-settings";

// Re-export provider constants so existing consumers can import from config
export { PROVIDER_INFO, VALID_PROVIDERS, DEFAULT_MODELS, providerLabel } from "./providers";
export type { ProviderValue } from "./providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppConfig {
  provider?: ProviderValue;
  model?: string;
  /**
   * Ollama's CHAT / GENERATION endpoint — see {@link getOllamaBaseUrl}, which
   * layers `OLLAMA_BASE_URL` over it. Embeddings do NOT read this field: they
   * read {@link AppConfig.embeddingBaseUrl} (DW-70).
   */
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
  /**
   * Optional endpoint override for the embedding provider — the one field every
   * non-binding embedding provider reads, `ollama` included since DW-70. It is
   * store-only (no env feeder) and unvalidated; `workers-ai` ignores it, having
   * the Cloudflare `AI` binding for transport.
   */
  embeddingBaseUrl?: string;
  /** Embedding credential, when it is not supplied as an env secret. */
  embeddingApiKey?: string;
  /**
   * Firecrawl credentials — an optional CAPTURE credential.
   *
   * Not a Deep Research provider: research searches through Tavily / SerpApi /
   * SearXNG (AD-18). The three fields below are the research ones.
   */
  firecrawlApiKey?: string;
  firecrawlBaseUrl?: string;
  /**
   * Deep Research (Epic 6 / AD-18). One provider is selected and used; there is
   * no fallback to another when its credential is missing, because a silent
   * substitution would search somewhere the owner did not choose.
   *
   * Absent `researchProvider` means the default (`tavily`), which is what makes
   * "unset" a working configuration on a deployment that only supplies
   * `TAVILY_API_KEY`.
   */
  researchProvider?: string;
  tavilyApiKey?: string;
  serpApiKey?: string;
  /** SerpApi's search engine, e.g. `google`. Absent means the default. */
  serpApiEngine?: string;
  /** The SearXNG instance to query. SearXNG needs no key, only this. */
  searxngBaseUrl?: string;
  /** Comma-separated SearXNG categories. Absent means the instance's default. */
  searxngCategories?: string;

  // -------------------------------------------------------------------------
  // Epic 7 — Intake and MinerU PDF (Stories 7.2 / 7.5).
  //
  // Read through `./extract-settings`, which is where the defaults and the
  // fail-closed normalization live. Nothing else should read these keys
  // directly: `mineruMode` in particular has a default (`off`) that matters,
  // and a second reader that treated absent as "whatever was configured" is
  // how an optional Cloud upload becomes an accidental one.
  // -------------------------------------------------------------------------

  /** Keep the sidecar's extracted Markdown under `raw/parsed/` too. */
  intakeKeepParsed?: boolean;
  /** `off` | `local` | `cloud` | `pipeline`. Absent (and invalid) means `off`. */
  mineruMode?: string;
  /** Base URL for MinerU's Local API. Absent means `http://127.0.0.1:8000`. */
  mineruLocalBaseUrl?: string;
  /** Credential for MinerU Cloud / Pipeline. Never leaves the server. */
  mineruApiKey?: string;

  // -------------------------------------------------------------------------
  // Epic 8 — the loopback door and the Skills that ride through it
  // (Stories 8.1 / 8.6).
  //
  // Read through `getLoopbackApiSettings` / `skillEnabled`, which is where the
  // fail-closed defaults live. Nothing else should touch these keys directly:
  // `apiEnabled` and `allowUnauthenticated` are both `false` when absent, and a
  // second reader that treated absent as "whatever was configured" is how an
  // opt-in local API becomes an open one.
  // -------------------------------------------------------------------------

  /** Is the loopback `/api/v1` data plane switched on? Absent means NO. */
  apiEnabled?: boolean;
  /**
   * May a local caller skip the token? Absent means NO, and that is the whole
   * point — unauthenticated access is never the default, it is a decision the
   * owner makes on the API + MCP pane and sees an orange warning for.
   */
  allowUnauthenticated?: boolean;
  /**
   * The token Settings generated. Never served — the payload answers
   * `hasLoopbackApiToken` and `loopbackTokenSource`, the same AD-23 rule the
   * three provider credentials follow. `LLM_WIKI_API_TOKEN` wins over it.
   */
  loopbackApiToken?: string;
  /**
   * Filesystem Skill enablement: skill id → boolean (Story 8.6).
   *
   * ABSENT FROM THE MAP MEANS ENABLED. A newly scanned `SKILL.md` is usable
   * without a visit to Settings — "scanned without reinstall" is the acceptance
   * criterion — so the map records DECISIONS, not an inventory. An inventory
   * would go stale the moment the owner added a folder, and every new Skill
   * would silently arrive switched off.
   */
  skillEnablement?: Record<string, boolean>;

  // NO PLAUD OAUTH KEYS (Story 7.6 is blocked). Five of them were declared
  // here — client id, client secret, access and refresh tokens, an expiry —
  // for a connected-account flow that has no endpoint to connect to: Plaud
  // publishes no account-level API, and the documented OAuth belongs to a
  // partner platform with no "list my recordings". Declared-but-unwritten
  // secret names are not free: they read as a feature that exists, and the
  // first person to see them will wire something to them. Plaud recordings
  // arrive by upload; see `SETTINGS_INTAKE_PLAUD_COPY`.
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
   * {@link getEmbeddingResolution} — the same door `embedText` goes through
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
   * The PROVIDER half of the same in-effect answer — which embedding provider
   * this deployment actually embeds through (DW-616). Null exactly when
   * {@link EffectiveSettings.embeddingModelInEffect} is, because the model is
   * resolved from the provider.
   *
   * Served because it cannot be re-derived by the browser. `/settings` renders
   * one sentence about the embedding INFRASTRUCTURE — the Workers AI /
   * Vectorize dimensions note — and the only inputs the browser held were
   * `EMBEDDING_PROVIDER` and the stored provider; the resolver's Workers AI
   * auto-detect leg fires with both of them unset, which is the normal shape of
   * the deployment that sentence is true of. Gating in the browser would
   * therefore drop the sentence on exactly those deployments.
   *
   * Resolved from the SAME snapshot and the SAME single resolution as
   * `embeddingModelInEffect` (see {@link embeddingModelAnswer}), so the pair
   * cannot describe different config generations.
   */
  embeddingProviderInEffect: EmbeddingProvider | null;
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
  /**
   * Why the endpoint above is not the one the owner set — the FULL env→store
   * ladder's refusal, or `null` when nothing was refused (DW-402).
   *
   * Scoped to the ladder that produced `ollamaBaseUrl`, which is what makes it
   * a different field from {@link ProviderInfo.ollamaBaseUrlIssue}: that one is
   * env-only, because the object it rides on describes what the environment
   * alone selects. Here a stored endpoint the resolver threw away is reported
   * as such, naming the STORE rather than the variable.
   *
   * `null` on the `ollama-cloud` branch, which never walks the ladder at all.
   *
   * It DESCRIBES: the value is a sentence to render, not a validation failure.
   * Nothing blocks a save on it.
   */
  ollamaBaseUrlIssue: string | null;
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
 *
 * THE TOKEN IS BOUND TO THE BYTES IT WAS STAMPED FOR (DW-372), by
 * {@link CONFIG_DIGEST_KEY} beside it. On its own this key is a plain field, so
 * anything that round-trips the object verbatim — a pre-DW-272 build's save, a
 * hand edit, a restore — carried the stamp forward over content it never
 * stamped, and the guard went on believing a store state that had moved. The
 * digest makes the read REFUSE such a stamp; see {@link UNSTAMPED_CONFIG_VERSION}.
 */
const CONFIG_VERSION_KEY = "__settingsVersion";

/**
 * The RESERVED key the token's BINDING to the config bytes is stored under
 * (DW-372) — a SHA-256 of the canonical serialization of the config with both
 * reserved keys removed.
 *
 * WHY A SECOND KEY AND NOT A CONTENT-DERIVED TOKEN. AD-23 forbids serving any
 * function of `firecrawlApiKey`, `customApiKey` or `embeddingApiKey`, and a
 * version computed over this store is exactly that. So the two jobs are split:
 * what is SERVED stays the opaque random `s1:` token {@link newConfigVersion}
 * makes, and what BINDS it to the bytes is this digest, which is stored beside
 * it and never crosses the response boundary. A version *computed over* the
 * store cannot be served; one merely *checked against* it never leaves the
 * server.
 *
 * WHY A SECOND KEY AND NOT A SECOND FILE. Same reason as
 * {@link CONFIG_VERSION_KEY}: one object, one round-trip, no pair for a backend
 * to get wrong.
 *
 * CANONICAL, so key order alone is not a change: `.llm-wiki-config.json` is
 * hand-editable and an editor that re-serialized it must not be reported as an
 * edit nobody made. {@link canonicalConfigJson} sorts every object's keys.
 *
 * Stripped exactly as the token is — on the way out of
 * {@link readStoredConfig} and off whatever a caller hands {@link saveConfig} —
 * so no consumer, backup or cache ever sees it.
 */
const CONFIG_DIGEST_KEY = "__settingsDigest";

/**
 * The config, serialized so that key ORDER is not content.
 *
 * Every plain object is re-emitted with its keys sorted, recursively (the
 * replacer runs again over the object it returns). Arrays keep their order,
 * because in an array order IS content.
 */
function canonicalConfigJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/**
 * The digest stored under {@link CONFIG_DIGEST_KEY} for a config object.
 *
 * SHA-256 through {@link sourceSha256} — the house helper, already the digest
 * every stored Source is identified by. Reused rather than re-rolled: a second
 * `crypto.subtle` + hex loop in this file would be a copy that can only drift
 * from it. `source-sha256.ts` imports NOTHING, so there is no cycle back into
 * this module, and the helper is available identically in node, the browser and
 * the Worker with no new dependency.
 *
 * The caller passes the config with BOTH reserved keys already removed: the
 * digest cannot be a function of itself, and the token must be free to rotate
 * without moving it.
 */
async function configDigest(config: AppConfig): Promise<string> {
  return sourceSha256(canonicalConfigJson(config));
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
 * Misconfigurations already reported, so standing state is said ONCE.
 *
 * The same shape as `warnOnceAbout` in `embeddings.ts` — a module-level `Set`
 * keyed on the misconfiguration's identity — and a deliberate COPY rather than
 * an import: `embeddings.ts` imports this module, so importing it back would
 * close a cycle. An unusable Ollama endpoint is standing state, not an event:
 * it holds until someone edits the store or the environment, and
 * `getOllamaBaseUrl()` is read on every generation (and, through
 * `resolveEmbeddingProvider`'s detection rung, on every embed), so logging per
 * read would emit the same sentence thousands of times for one typo.
 *
 * The KEY is the source AND the value, because the sentence names where the
 * value came from: the same bad string in the environment and in the store are
 * two different things to fix, and an owner who only ever hears about one of
 * them cannot fix the other.
 *
 * IT ALSO KEYS THE SETTINGS STAMP (DW-372), for the same reason and not by
 * coincidence. A token frozen over moved bytes is standing state too: it holds
 * on every cache-miss read of {@link readStoredConfig} until someone saves
 * settings once, and every store written before that change holds a real token
 * with no digest beside it — so an install that has not saved yet would repeat
 * the line on every read forever. The key there is the stored token AND the
 * stored digest, by the same rule: a different frozen pair is a different fact
 * and still gets said. The name is now narrower than what the Set holds; it is
 * left alone rather than churned across the endpoint call sites it also serves.
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
 * An Ollama endpoint ladder's answer: what it resolved, and why it threw
 * anything away (DW-402).
 *
 * The refusal is a VALUE here rather than a second code path. Before this, a
 * refused endpoint left nothing behind but a `logger.warn` line, so every
 * owner-facing surface could only report the ABSENCE — an empty box beside a
 * `none` badge, and a help panel still advertising the variable the deployment
 * had already rejected. Returning the sentence beside the URL lets each surface
 * say what the server already knew.
 *
 * `issue` is `null` whenever nothing was refused, which includes "nothing was
 * set" (blank is unset, not invalid) and "the leg never ran". It is NOT an
 * error channel: `url` is still the honest resolution and callers that only
 * want the URL read `.url` and are unaffected.
 */
export interface OllamaBaseUrlAnswer {
  /** The endpoint to use, or `undefined` when the ladder resolved to nothing. */
  url: string | undefined;
  /** {@link ollamaBaseUrlRefusedCopy} for the value this ladder discarded. */
  issue: string | null;
}

/**
 * The env leg's answer: `OLLAMA_BASE_URL` if usable, plus why it was not.
 *
 * The whole of {@link envOllamaBaseUrl}'s behaviour lives here — same
 * `nonEmpty` reading, same `isAbsoluteHttpUrl` rule, same warn-once key, same
 * sentence — and that function is now a `.url` view over this one, so the two
 * cannot answer differently.
 */
export function envOllamaBaseUrlAnswer(): OllamaBaseUrlAnswer {
  const fromEnv = nonEmpty(process.env.OLLAMA_BASE_URL);
  if (fromEnv === null) return { url: undefined, issue: null };
  if (isAbsoluteHttpUrl(fromEnv)) return { url: fromEnv, issue: null };
  // ONE sentence, warned and REPORTED. Composing a second wording for the
  // surfaces would be two explanations of one fact, free to drift apart.
  const issue = ollamaBaseUrlRefusedCopy("env", fromEnv);
  warnOnceAbout(`ollama-endpoint:env:${fromEnv}`, issue);
  return { url: undefined, issue };
}

/**
 * The full env→store ladder's answer: {@link getOllamaBaseUrl}'s URL, plus the
 * refusal that produced it.
 *
 * A LEG THAT NEVER RAN CONTRIBUTES NO REASON. The env answer is returned
 * outright when it carries a URL, so a store that was never consulted cannot
 * complain about a value nothing read. Only when the env leg yields no URL is
 * the store walked, and then the reported reason is the ENV one if there was a
 * refusal there — that is the value that would have won — and the store's
 * otherwise.
 *
 * Both refusals are still WARNED independently, under their own keys: the same
 * bad string in the variable and in the config are two different things to fix,
 * and reporting only one of them to the screen must not silence the other in
 * the log.
 */
export function resolveOllamaBaseUrl(cfg: AppConfig = loadConfigSync()): OllamaBaseUrlAnswer {
  const fromEnv = envOllamaBaseUrlAnswer();
  if (fromEnv.url !== undefined) return fromEnv;
  const stored = nonEmpty(cfg.ollamaBaseUrl);
  if (stored === null) return { url: undefined, issue: fromEnv.issue };
  if (isAbsoluteHttpUrl(stored)) return { url: stored, issue: fromEnv.issue };
  const issue = ollamaBaseUrlRefusedCopy("config", stored);
  warnOnceAbout(`ollama-endpoint:config:${stored}`, issue);
  return { url: undefined, issue: fromEnv.issue ?? issue };
}

/**
 * `OLLAMA_BASE_URL` when it is USABLE, and `undefined` when it is not.
 *
 * The env leg of {@link getOllamaBaseUrl}, extracted so that "is the
 * environment's Ollama endpoint usable" is asked in ONE place (DW-370).
 * `detectEnvProvider` and `resolveEmbeddingProvider`'s credential tail both used
 * to answer it with `process.env.OLLAMA_BASE_URL` alone, so a typo'd
 * `localhost:11434` SELECTED `ollama` while this function REFUSED the same
 * string — the provider resolved and the endpoint did not, and the call went to
 * the SDK's own localhost default instead of the address the owner typed.
 * Restating the `isAbsoluteHttpUrl` check at a detection site would only move
 * the disagreement one edit away; calling the same rule means the two cannot
 * drift.
 *
 * Sharing it also shares the warn-once KEY, so a typo'd endpoint is described
 * once per process no matter how many resolvers ask about it.
 *
 * ENV ONLY, deliberately: this answers nothing about `cfg.ollamaBaseUrl`. See
 * the note on {@link detectEnvProvider}'s ollama branch for why detection must
 * not widen to the store.
 *
 * THE URL HALF of {@link envOllamaBaseUrlAnswer} (DW-402). The rule moved into
 * that function and this one delegates, so the signature, the answer for every
 * input and the warn-once key are all exactly what they were; a caller that
 * also wants to SAY why the value was refused reads the answer instead.
 */
export function envOllamaBaseUrl(): string | undefined {
  return envOllamaBaseUrlAnswer().url;
}

/**
 * Returns the effective Ollama base URL FOR CHAT / GENERATION.
 * Priority: `OLLAMA_BASE_URL` env var → config file `ollamaBaseUrl` → `undefined`.
 *
 * NOT THE EMBEDDING ENDPOINT (DW-70). Embeddings read the stored
 * `embeddingBaseUrl` — Settings → Embeddings → "Embedding endpoint" — through
 * `embeddings.ts`'s `embeddingBaseUrlOf`, on the same terms as `openai` and
 * `google`. This ladder used to serve both legs, which made one field describe
 * two endpoints and made the Embedding endpoint field inert under `ollama`. The
 * consumers left are `getResolvedCredentials` and `getConfiguredModel`, i.e.
 * everything that generates text.
 *
 * `OLLAMA_BASE_URL` is still a provider-DETECTION signal on top of that (see
 * {@link envOllamaBaseUrl}, `detectEnvProvider` and `resolveEmbeddingProvider`'s
 * auto-detect rung, DW-370): it can still cause `ollama` to be SELECTED as the
 * embedding provider. What it no longer does is decide where that embedding call
 * is sent.
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
 *
 * The env leg lives in {@link envOllamaBaseUrl} because the two auto-detection
 * sites need exactly that half of this ladder and nothing else (DW-370). This
 * function's behaviour is unchanged by the move: the same fall-through, the
 * same warn-once key, the same answer for every input.
 *
 * THE URL HALF of {@link resolveOllamaBaseUrl} (DW-402), on the same terms as
 * the env leg above: the ladder itself moved, this signature and every answer
 * it gives did not. `getResolvedCredentials` and the embedding resolvers want
 * only the URL and keep calling this; the two Settings payloads want the reason
 * too and call the resolver.
 */
export function getOllamaBaseUrl(cfg: AppConfig = loadConfigSync()): string | undefined {
  return resolveOllamaBaseUrl(cfg).url;
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
 * THE OTHER WAY A STORE READS AS UNSTAMPED: ITS BYTES MOVED UNDER ITS STAMP
 * (DW-372). The token is stored beside a digest of the config it was stamped
 * for ({@link CONFIG_DIGEST_KEY}), and {@link readStoredConfig} honours the
 * token only while that digest still matches what it recomputes. So anything
 * that changed the config without going through {@link saveConfig} — a
 * pre-DW-272 build's save that round-tripped the reserved key verbatim, a hand
 * edit, a partial restore — reads as unstamped rather than as the frozen token
 * it used to keep serving. That errs the safe way: a draft holding the old
 * token is refused 412 instead of landing over content the guard never saw, and
 * the next save re-stamps, so it SELF-HEALS. A key re-order is not such a
 * change — the digest is canonical over sorted keys, so an editor that
 * re-serialized the file is not reported as an edit nobody made.
 *
 * AND IT WIDENS THE RESIDUAL DIRECTLY ABOVE, WHICH IS THE PRICE. Reading a
 * moved store as unstamped does not only refuse the stale draft — it puts the
 * store into the state this constant names, where BOTH surfaces hold this one
 * sentinel, both match, and neither save is refused. So detecting the event also
 * switches the cross-surface guard OFF until the next save re-stamps. That state
 * used to be rare (a first-ever save, a restored backup); it is now entered by
 * every hand edit, every rollback-era save, and ONCE by every already-deployed
 * store the moment this change ships, since none of them carry a digest yet.
 * The trade is deliberate: one save's worth of no-guard, against a stale draft
 * landing silently over content nothing checked. Refusing outright was the other
 * option and it strands an owner with no path through from any surface they can
 * see, which is the whole reason this sentinel exists.
 *
 * THE INTERMEDIATE BUILD. A build from after DW-272 but before this change
 * strips only {@link CONFIG_VERSION_KEY}, so on a rollback to one of those
 * {@link CONFIG_DIGEST_KEY} survives into the `AppConfig` handed to consumers
 * and is written back as an ordinary field — visible in a backup, and spread
 * wherever the config is. That is the whole cost, and it is cosmetic.
 *
 * Rolling FORWARD needs no migration, because the surviving key still means
 * exactly what it meant: the digest of the settings as of the last save THIS
 * build made. If the intermediate build changed anything, it no longer matches
 * what this one recomputes, so the store reads unstamped and the next save
 * strips the key and re-stamps the pair — the DW-372 answer, self-healing. If it
 * changed nothing, the digest still describes the bytes and the token it stamped
 * is honoured, which is also the right answer. Either way the key stops being an
 * ordinary field the moment this build saves.
 *
 * WHAT THIS COSTS AND WHY IT IS NOT THE AD-23 LEAK. The digest is a function of
 * every byte in the store, `firecrawlApiKey`, `customApiKey` and
 * `embeddingApiKey` included — which is precisely why it is STORED and never
 * SERVED. The version that crosses the boundary is still the opaque random
 * `s1:` token, derived from nothing in the config; the digest only decides
 * whether that token is still true. A content-derived version had to be served
 * to work at all, and that is the difference.
 *
 * THE RESIDUAL THAT REMAINS. A hand edit that restores the config to exactly
 * the bytes a standing token was stamped for is indistinguishable from no edit,
 * and a hand edit that rewrites the config AND its digest together forges a
 * stamp the read accepts. Both require an actor with write access to the store,
 * which is the owner. The guard is defined over writes THROUGH THE API; editing
 * the file underneath a running app was never a supported way to change
 * settings.
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
 *
 * AND SO IS A REAL TOKEN WHOSE BYTES MOVED (DW-372). A well-formed stamp is
 * honoured only while {@link CONFIG_DIGEST_KEY} still matches the digest
 * recomputed over the stripped config, so a store changed by anything other
 * than {@link saveConfig} answers the sentinel instead of a token that is no
 * longer true of it. Recoverable the same way — the next save re-stamps — and
 * warn-logged for the same reason.
 *
 * WHAT THE CHECK COSTS, ACCURATELY. A STAMPED store — which is the common case,
 * every install that has saved settings once — pays one SHA-256 over the whole
 * config on every read that misses the 5 s cache. An UNSTAMPED one pays nothing,
 * because there is no token to bind and the recompute is skipped. That is a hash
 * of a few kilobytes against a storage round-trip this function has already
 * made, so it is stated here rather than sold as free.
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
  const storedDigest = (parsed as Record<string, unknown>)[CONFIG_DIGEST_KEY];
  // BOTH reserved keys come off before anything else looks at the object: the
  // digest is computed over the settings alone, and that is also the shape every
  // consumer and the cache below are owed.
  const config = { ...(parsed as Record<string, unknown>) };
  delete config[CONFIG_VERSION_KEY];
  delete config[CONFIG_DIGEST_KEY];
  // THE CACHE IS PRIMED HERE, BEFORE ANY `await` — the ordering is load-bearing.
  //
  // The digest recompute below is asynchronous, and anything between this
  // function's last read and its cache write is a window a concurrent
  // `saveConfig` can land in. `saveConfig` primes the cache with what it just
  // wrote; if this read primed AFTER awaiting, it would resume holding the
  // PRE-save object and overwrite that with stale settings for the whole 5 s
  // TTL — `loadConfigSync()` answering the values the owner had just replaced,
  // which is exactly the staleness priming exists to prevent. Priming from the
  // bytes this read actually parsed, synchronously, keeps the window at zero.
  //
  // The version decision below touches nothing the cache holds, so nothing is
  // lost by settling it afterwards.
  _configCache = { data: config as AppConfig, ts: Date.now() };
  let version = UNSTAMPED_CONFIG_VERSION;
  if (typeof stored === "string" && isStoredConfigVersion(stored)) {
    if (stored === UNSTAMPED_CONFIG_VERSION) {
      // The sentinel is not a stamp, so there is nothing for a digest to bind —
      // and no digest to recompute.
      version = UNSTAMPED_CONFIG_VERSION;
    } else {
      // THE RECOMPUTE CANNOT BE ALLOWED TO REJECT. `loadConfig` promises its ~50
      // callers `{}` for a store it could not read and a config for one it
      // could; a throw escaping from here would be neither — it would reject the
      // promise and break that contract for a reason that has nothing to do with
      // the store's readability. A digest that could not be computed leaves the
      // store UNSTAMPED, which is the recoverable degradation (the next save
      // re-stamps, and a stale draft is refused rather than allowed through).
      // `unreadable` would be the wrong answer too: the settings parsed fine and
      // every consumer that only wants defaults should still get them.
      let recomputed: string | null = null;
      try {
        recomputed = await configDigest(config as AppConfig);
      } catch (err) {
        warnOnceAbout(
          `settings-digest-failed:${stored}`,
          `could not verify the settings version stamp; treating as unstamped: ${String(err)}`,
        );
      }
      if (typeof storedDigest === "string" && storedDigest === recomputed) {
        version = stored;
      } else if (recomputed !== null) {
        // DW-372: the token is well-formed but is not true of these bytes — a
        // pre-DW-272 build round-tripped it, or the file was edited underneath
        // it. The sentinel is the recoverable answer; the next save re-stamps.
        //
        // WARN-ONCE, because this is standing STATE and not an event: it holds
        // on every cache-miss read until someone saves settings, and every store
        // that predates this change holds a real token with no digest beside it,
        // so an unpatched install would otherwise repeat the line forever. Keyed
        // on the pair actually found, so a DIFFERENT frozen stamp still speaks.
        warnOnceAbout(
          `settings-stamp-stale:${stored}:${String(storedDigest)}`,
          "config changed underneath its version stamp; treating as unstamped",
        );
      }
    }
  } else if (stored !== undefined) {
    logger.warn("config", "config does not hold a usable version token; treating as unstamped");
  }
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
  // BOTH reserved keys are THIS function's to write, so strip whatever the
  // caller handed in before anything reads the object. `readStoredConfig`
  // already strips them, so no ordinary caller carries one — but a `PUT` body
  // naming either key reaches the merge, and without this the cache below would
  // be primed with a key a re-read removes, which is the sync/async
  // disagreement stripping exists to prevent. Stripping here also means a body
  // cannot forge a token, forge a binding, or unstamp the store: whatever it
  // says, the pair written is the freshly computed one.
  const stored = { ...config };
  delete (stored as Record<string, unknown>)[CONFIG_VERSION_KEY];
  delete (stored as Record<string, unknown>)[CONFIG_DIGEST_KEY];
  // The digest BINDS the token to these bytes (DW-372), so it is computed over
  // the stripped object — the same shape `readStoredConfig` recomputes over —
  // and stored beside the token, never served.
  const digest = await configDigest(stored);
  const body =
    JSON.stringify(
      { ...stored, [CONFIG_VERSION_KEY]: version, [CONFIG_DIGEST_KEY]: digest },
      null,
      2,
    ) + "\n";
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
 *   - Each surface warms the cache at its OWN call site, because this repo has
 *     no startup hook to warm it globally (DW-550): `src/app/api/status/
 *     route.ts` awaits a config read per request immediately before
 *     `getProviderInfo()`, and `src/cli.ts` does the same before
 *     `getEffectiveSettings()`. Both go through `readConfig()` rather than
 *     `loadConfig()` (DW-549/DW-622) — the two warm this cache identically on
 *     the ok path, and only `readConfig()` can also SAY that the store was
 *     unreadable rather than absent. A caller that reaches a resolver on a cold
 *     cache gets `{}` — the empty-config answer — not a stale one.
 */
export function loadConfigSync(): AppConfig {
  const now = Date.now();
  if (_configCache && now - _configCache.ts < CACHE_TTL_MS) {
    return _configCache.data;
  }
  // Cache cold — `{}` is the answer, and it may be the STANDING answer. Nothing
  // warms this for you (DW-550): a surface that wants the file on disk awaits
  // `loadConfig()` at its own call site, and a caller that never does keeps
  // getting `{}` for the life of the process. The entry is still written so the
  // TTL bounds how often a cold path retries.
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
  // A USABLE endpoint, not merely a present one (DW-370). `OLLAMA_BASE_URL`
  // holding something `getOllamaBaseUrl` refuses — `localhost:11434`, say —
  // used to select `ollama` here while resolution ignored the value, so the
  // calls went to the SDK's own localhost default rather than the address the
  // owner typed, and nothing on the surface said so.
  //
  // `OLLAMA_MODEL` stays an INDEPENDENT signal: a model name is usable on its
  // own, so set alone (or set beside an unusable URL) it still selects
  // `ollama`, and the SDK's default endpoint is then the honest resolution.
  // Only the endpoint's false signal is removed.
  //
  // ENV ONLY: `cfg.ollamaBaseUrl` is deliberately not consulted. This function
  // answers "what do the environment variables alone select", and widening it
  // to the store would make a saved endpoint select a provider the owner never
  // saved — a different question from the one DW-370 asks.
  if (envOllamaBaseUrl() !== undefined || nonEmpty(process.env.OLLAMA_MODEL) !== null) {
    return { provider: "ollama", apiKey: null };
  }
  return { provider: null, apiKey: null };
}

/**
 * The `LLM_CUSTOM_API_KEY` half of the custom provider's credential, or `null`.
 *
 * ONE door for the variable (DW-66). Three places need this answer — the
 * resolver below, the flat page's source badge in `getEffectiveSettings`, and
 * the Settings payload's `envCustomApiKey` boolean — and before this helper the
 * first two spelled the read themselves. A fourth spelling on the payload would
 * have been a rule stated four times, which is four rules that agree today: the
 * moment one of them dropped the `nonEmpty` trim, the row would announce an env
 * credential the resolver refuses.
 *
 * Truthiness, not nullishness: `LLM_CUSTOM_API_KEY=""` is set-but-empty, and an
 * empty string is not a credential — `getModel()` refuses it as missing, so it
 * must not mask a key the owner stored either.
 */
function envCustomApiKey(): string | null {
  return nonEmpty(process.env.LLM_CUSTOM_API_KEY);
}

/**
 * Return the server-side credential for a specific provider.
 *
 * `cfg` is OPTIONAL and read only where the store is actually consulted (the
 * `custom` branch below), NOT a `cfg: AppConfig = loadConfigSync()` default
 * parameter (DW-334). A default parameter is evaluated on EVERY call, so an
 * `anthropic` resolution — which never touches the store — would make a cache
 * write on behalf of a caller that never reaches it, pinning the `{}` entry and
 * its TTL earlier than that caller's own first store read would have. (It could
 * not HIDE a config loaded later: `readStoredConfig` and `saveConfig` both
 * assign `_configCache` unconditionally, ignoring the TTL.) Callers that hold a
 * snapshot (`getEffectiveSettings`, `getResolvedCredentials`,
 * `providerIsConfigured`) pass it so the whole resolution answers from one
 * config generation; everyone else passes nothing and gets today's behaviour.
 *
 * A `cfg` passed here is a WHOLE config generation, not a field-level override —
 * see the note on {@link getStructuredKnowledgeModelSettings}.
 */
export function apiKeyForProvider(
  provider: string | null,
  cfg?: AppConfig,
): string | null {
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
      // reads as a credential while `getModel()` refuses it as missing. That
      // reading lives in {@link envCustomApiKey}, which the Settings payload
      // reads too, so the surface and this resolver cannot drift.
      return envCustomApiKey() ?? nonEmpty((cfg ?? loadConfigSync()).customApiKey);
    default:
      return null;
  }
}

/**
 * `custom` needs BOTH halves. A key with no endpoint has nowhere to go and an
 * endpoint with no key is a request that 401s, so reporting either as
 * "configured" would promise a provider the runtime cannot construct — the
 * silently-inert save this story exists to prevent.
 *
 * `cfg` is forwarded to BOTH halves (DW-334): the key and the endpoint are one
 * question, so resolving them against two reads of a 5 s-TTL cache could report
 * `custom` unconfigured because the second read fell to `{}`.
 */
export function providerIsConfigured(provider: string | null, cfg?: AppConfig): boolean {
  if (provider === "ollama") return true;
  if (provider === "custom") {
    return (
      apiKeyForProvider("custom", cfg) !== null && getCustomBaseUrl(cfg) !== null
    );
  }
  return apiKeyForProvider(provider, cfg) !== null;
}

/**
 * Can this deployment actually MAKE the call — credentials AND a model name
 * (DW-403)?
 *
 * {@link providerIsConfigured} asks the credential question and keeps asking
 * exactly that; `hasCustomProvider` in `llm.ts` still wants that answer alone.
 * But a provider is only usable when a model name also resolves, and for
 * `custom` there is no default to fall back on — so a `custom` selection with
 * both credential halves set and no model reported itself READY while
 * `extractStructuredKnowledge` refused it on `!selection.model` and
 * `getConfiguredModel` had nothing to construct. The extraction section's
 * badge went green for a configuration extraction will not run.
 *
 * KEYED OFF {@link DEFAULT_MODELS}, NOT OFF THE LITERAL `"custom"`: the rule is
 * "a provider this repo has no default model for must be handed one". Today
 * `custom` is the only such entry — `providers.ts` withholds it on purpose,
 * because an owner-supplied endpoint serves whatever model names its operator
 * chose — but a second default-less provider would otherwise reopen the same
 * hole at three call sites at once.
 *
 * `model` is the one each caller ALREADY resolved, not a fresh derivation: the
 * three sites run three different ladders (primary, workload, settings payload)
 * and each must judge readiness against its own answer. It is read through
 * {@link nonEmpty} because `llm.ts` resolves the model through `.trim()`, so a
 * whitespace-only stored model is no model at all.
 *
 * `Object.hasOwn`, NOT `DEFAULT_MODELS[provider] !== undefined`. That map is a
 * `Record<string, string>`, so a bare index walks the prototype: `provider`
 * values of `"constructor"`, `"toString"` or `"valueOf"` all resolve to a
 * function and would short-circuit this to "has a default model, needs none"
 * — readiness granted to a provider with no model at all. `cfg.provider` comes
 * off disk, and this is now the exported rule three sites ask, so the lookup
 * asks about the map's OWN keys rather than about everything an object
 * inherits. `providerIsConfigured` happens to reject those names first today;
 * that is a second gate's behaviour, not this predicate's contract.
 */
export function providerIsUsable(
  provider: string | null,
  model: string | null,
  cfg?: AppConfig,
): boolean {
  if (!providerIsConfigured(provider, cfg)) return false;
  if (provider !== null && Object.hasOwn(DEFAULT_MODELS, provider)) return true;
  return nonEmpty(model) !== null;
}

/**
 * The `custom` provider's endpoint: env var first, then the store.
 *
 * Truthiness, not nullishness, for the same reason as
 * {@link apiKeyForProvider}'s `custom` branch: `LLM_CUSTOM_BASE_URL=""` must not
 * mask an endpoint the owner stored through Settings.
 *
 * `cfg` is OPTIONAL and read at the point of use, for the same reason as
 * {@link apiKeyForProvider} (DW-334): the store leg sits behind `??`, so a
 * deployment that sets the variable never reaches it, and an eagerly-evaluated
 * default parameter would make a cache write — pinning the `{}` entry and its
 * TTL — on behalf of a caller that never asked the store anything.
 */
export function getCustomBaseUrl(cfg?: AppConfig): string | null {
  return (
    nonEmpty(process.env.LLM_CUSTOM_BASE_URL) ??
    nonEmpty((cfg ?? loadConfigSync()).customBaseUrl)
  );
}

/**
 * Merge the owner's saved selection with server credentials.
 * Priority: saved provider selection > env auto-detection fallback.
 *
 * Environment variables provide credentials, not preference. This allows an
 * installation to keep several provider keys and switch between them in the
 * Settings UI without whichever secret is checked first taking over.
 *
 * `cfg` is a DEFAULT PARAMETER, the convention {@link getOllamaBaseUrl} already
 * uses, because this function reads the store unconditionally — there is no
 * lazy leg to protect. A caller that already holds a snapshot
 * (`workloadModelSettings`) passes it so the whole answer describes one config
 * generation (DW-334).
 */
export function getEffectiveProvider(cfg: AppConfig = loadConfigSync()): ProviderInfo {
  const env = detectEnvProvider();

  const provider = cfg.provider ?? env.provider ?? null;
  if (!provider) {
    return {
      configured: false,
      provider: null,
      model: null,
      embeddingSupport: false,
      // THE case this field exists for (DW-402): a deployment whose only Ollama
      // signal is an endpoint the resolver refused selects no provider at all,
      // so "no provider configured" is the whole of what `/api/status` used to
      // say about a variable the owner had already set.
      ollamaBaseUrlIssue: envOllamaBaseUrlAnswer().issue,
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
    nonEmpty(process.env.OLLAMA_MODEL) !== null
  ) {
    // Through `nonEmpty`, not bare truthiness: `detectEnvProvider` reads the
    // same variable that way, so `OLLAMA_MODEL="  "` would otherwise be unset
    // to detection and reported here as the active model — the string `"  "`
    // going out through `/api/status` and every workload resolver (DW-370).
    model = nonEmpty(process.env.OLLAMA_MODEL);
  } else {
    // `custom` carries no DEFAULT_MODELS entry on purpose, so the `?? provider`
    // fallback would report the literal string "custom" as the active model —
    // the same trap `getResolvedCredentials` guards, and the value `/api/status`
    // and the workload resolvers would inherit. There is no default to report
    // for an endpoint nobody here has seen, so report none.
    model = DEFAULT_MODELS[provider] ?? (provider === "custom" ? null : provider);
  }

  return {
    // The MODEL is part of the question (DW-403): a `custom` selection with
    // both credential halves and no model name resolves `model: null` two lines
    // up, and reporting it configured promised `/api/status` a provider
    // `getConfiguredModel` cannot construct. Against the `cfg` this function
    // holds (DW-334), so the credential question and the provider question
    // cannot straddle two generations of the 5 s-TTL cache.
    configured: providerIsUsable(provider, model, cfg),
    provider,
    model,
    // ENV LEG ONLY, matching what this object describes (DW-402). `ProviderInfo`
    // is what the ENVIRONMENT selects — `detectEnvProvider` does not consult the
    // store, by DW-370's own design note — so pairing it with a complaint about
    // a stored endpoint would answer a question this object does not ask. The
    // full ladder's reason rides on `EffectiveSettings` instead.
    ollamaBaseUrlIssue: envOllamaBaseUrlAnswer().issue,
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
 *
 * A PASSED `cfg` IS THE WHOLE CONFIG GENERATION, not a field-level override —
 * the contract every `cfg` parameter added by DW-334 shares. This function
 * forwards it into `getEffectiveProvider(cfg)`, so an object carrying only
 * `structuredKnowledgeProvider` also decides the primary this workload would
 * inherit: the two workload keys are read from the same object that answers
 * "what is the primary provider, and is it usable?". Pass a full snapshot, or
 * pass nothing and take the cache.
 */
export function getStructuredKnowledgeModelSettings(
  cfg: AppConfig = loadConfigSync(),
): StructuredKnowledgeModelSettings {
  // The ladder itself lives in `workloadModelSettings` (below), which Chat and
  // Ingest also call. This function is now only "which two keys".
  return workloadModelSettings(
    cfg.structuredKnowledgeProvider,
    cfg.structuredKnowledgeModel,
    cfg,
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
 *
 * `cfg` is threaded down to the primary resolver and the readiness predicate
 * (DW-334). Without it this ladder cost two further entries into the 5 s-TTL
 * cache — `getEffectiveProvider()` and `providerIsUsable` — so an inherited
 * workload could describe a different config generation than the caller that
 * asked for it.
 *
 * REQUIRED, not defaulted, though this function is private and every caller has
 * a snapshot to hand: a default here would let a fourth caller reintroduce that
 * second cache entry silently. Required, it cannot compile without one.
 */
function workloadModelSettings(
  provider: ProviderValue | undefined,
  model: string | undefined,
  cfg: AppConfig,
): StructuredKnowledgeModelSettings {
  const primary = getEffectiveProvider(cfg);
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
    // Against THIS ladder's model (DW-403). `structuredKnowledgeConfigured` is
    // what the extraction section's badge reads, and `extractStructuredKnowledge`
    // refuses on `!selection.model` — so a workload that inherits a `custom`
    // primary with no model must not report itself ready. Against the same
    // `cfg` the primary above was resolved from (DW-334).
    configured: providerIsUsable(resolvedProvider, resolvedModel, cfg),
    usesPrimary: provider === undefined && model === undefined,
  };
}

/**
 * The model Chat runs on. Story 1.9 owns the setting; Epic 3 owns the call
 * sites — nothing in `chat.ts` reads this yet, by design
 * (`epic-1-context.md:63`).
 */
export function getChatModelSettings(
  cfg: AppConfig = loadConfigSync(),
): StructuredKnowledgeModelSettings {
  return workloadModelSettings(cfg.chatProvider, cfg.chatModel, cfg);
}

/**
 * The model Ingest runs on. Story 1.9 owns the setting; Epic 2 owns the call
 * sites. Independent of {@link getChatModelSettings} and of the primary
 * provider — that independence is the story's headline behaviour.
 */
export function getIngestModelSettings(
  cfg: AppConfig = loadConfigSync(),
): StructuredKnowledgeModelSettings {
  return workloadModelSettings(cfg.ingestProvider, cfg.ingestModel, cfg);
}

export interface VectorSearchSettings {
  /** The EFFECTIVE switch: the stored flag intersected with the predicate. */
  enabled: boolean;
  /**
   * The explicit embedding provider the gate was read against — WHICH MAY BE A
   * VALUE THE GATE REFUSED (DW-509).
   *
   * Since the ladder above became `resolveEmbeddingProvider`'s own, a junk
   * `EMBEDDING_PROVIDER=deepseek` is reported here verbatim rather than being
   * filtered away and replaced by the stored selection. That is the point: the
   * alternative shadowed the misconfiguration behind a provider the runtime
   * never used, so this object claimed `openai` with every leg met while
   * nothing embedded. Reported unshadowed, the value names what actually has to
   * be fixed, and `enabled` below is `false` beside it.
   *
   * So a consumer must not treat this as an {@link EmbeddingProvider} id
   * without checking: `enabled` is the field that answers "is anything
   * embedding", and it is the only one every caller in the tree reads.
   */
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
  // THE RAW value, not the `isEmbeddingProvider`-filtered one (DW-509).
  //
  // This is the ladder `resolveEmbeddingProvider` reads, line for line: the raw
  // variable, then `nonEmpty(cfg.embeddingProvider)`, with the refusal made
  // once, at the gate. `envEmbeddingProviderRaw` is the module's one spelling of
  // that read (DW-638) and applies the same trim-and-null the resolver does —
  // the RAW/filtered distinction below is about the PREDICATE, not about the
  // read, so sharing the read changes nothing here. Filtered, a junk
  // `EMBEDDING_PROVIDER=deepseek` fell THROUGH to the stored provider here — so
  // this function reported `provider: "openai"` with every leg met and
  // `enabled: true`, while the embed path resolved `null` and nothing embedded.
  // The switch read as satisfied on a provider that never runs.
  //
  // No new branch is needed to refuse it: `vectorSearchMissingLegs`' first leg
  // is already `!v.provider || !isEmbeddingProvider(v.provider)`, so the junk
  // value fails the gate, and the reported `provider` stays the value the gate
  // was actually read against rather than a shadowed one.
  const envProvider = envEmbeddingProviderRaw();
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

// ---------------------------------------------------------------------------
// Epic 8 — the loopback door (Story 8.1)
// ---------------------------------------------------------------------------

export interface LoopbackApiSettings {
  enabled: boolean;
  allowUnauthenticated: boolean;
  /**
   * The token a caller must present, or `null` when none is configured.
   *
   * INTERNAL. It reaches exactly two places: the owner-automation
   * `/api/v1/loopback-settings` route the sidecar polls, and the compare inside
   * the sidecar. It is in no settings payload and no log line.
   */
  token: string | null;
  tokenSource: LoopbackTokenSource;
}

/**
 * The loopback door's four facts, resolved once.
 *
 * ENV WINS, and it wins over the STORE rather than beside it: `LLM_WIKI_API_TOKEN`
 * is how a deployment supplies the credential without it ever entering the
 * config JSON, so a store token standing behind it would be a second valid
 * password for the same door — one the owner believes they rotated when they
 * pressed Generate. `tokenSource: "env"` is what tells the surface to stop
 * offering Generate as if it mattered.
 *
 * `authRequired` is DERIVED rather than stored: it is "the API is on and unauth
 * is off", and storing it would let the two disagree.
 */
export function getLoopbackApiSettings(
  cfg: AppConfig = loadConfigSync(),
): LoopbackApiSettings {
  const fromEnv = nonEmpty(process.env[LOOPBACK_TOKEN_ENV]);
  const stored = nonEmpty(cfg.loopbackApiToken);
  const token = fromEnv ?? stored;
  return {
    enabled: cfg.apiEnabled === true,
    allowUnauthenticated: cfg.allowUnauthenticated === true,
    token,
    tokenSource: fromEnv !== null ? "env" : stored !== null ? "store" : "none",
  };
}

/**
 * Is this Skill enabled? (Story 8.6)
 *
 * ABSENT IS ENABLED — see {@link AppConfig.skillEnablement}. Only an explicit
 * `false` hides a Skill from `/skill` completion, from injection and from the
 * Agent's Skill file reads.
 */
export function skillEnabled(
  id: string,
  enablement: Record<string, boolean> | undefined,
): boolean {
  return enablement?.[id] !== false;
}

/** Trim-and-null: `""` and whitespace are "unset", not "set to nothing". */
function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * THE read of `EMBEDDING_PROVIDER` in this module (DW-638).
 *
 * Trim-and-null, exactly as `resolveEmbeddingProvider` reads it, so a
 * whitespace-only variable is "unset" to every caller here for the same reason
 * it is unset to the resolver. Four hand-written copies of this line used to
 * exist IN THIS MODULE — the runtime gate's, the filter's, and one in each of
 * the two payload constructors — which is the shape that let the filtered and
 * raw reads part company in DW-552. One spelling, so the next edit cannot move
 * one of them.
 *
 * A repo-wide grep finds a FIFTH read, and it is deliberate:
 * `resolveEmbeddingProvider` in `embeddings.ts` reads the variable itself. That
 * one is the RESOLVER's, the answer everything here is aligned TO — this module
 * imports nothing from `embeddings.ts` in that direction (see
 * `getVectorSearchSettings`' note on the cycle), so the two cannot share a
 * reader. What keeps them equal is that both spell the same trim-and-null, and
 * `settings-runtime-wiring.test.ts` pins the gate's answer against the
 * resolver's across every variable state.
 */
function envEmbeddingProviderRaw(): string | null {
  return nonEmpty(process.env.EMBEDDING_PROVIDER);
}

/**
 * The variable split into the two fields both settings feeders are served
 * (DW-508/DW-638).
 *
 * `filtered` is the `EMBEDDING_PROVIDER` override when it names a provider that
 * can actually embed — the SELECTION, and what pins the provider select. A junk
 * value is `null` there for the same reason `resolveEmbeddingProvider` refuses
 * it rather than falling through: it is a misconfiguration, not a selection.
 * `invalid` is exactly what that filter threw away, so the row can say "set to
 * junk" rather than reading as if no variable were set at all.
 *
 * The two are EXCLUSIVE BY CONSTRUCTION: one raw read, one predicate, and
 * `invalid` is the `else` of the same branch. `mergedVectorInputs` and
 * `draftVectorInputs` re-join them with `??`, which is a join rather than a
 * precedence question only because of that exclusivity — and until now the
 * exclusivity was two independently written expressions, one per constructor,
 * held equal by a test rather than by the code. `settings-runtime-wiring.test.ts`
 * still pins it; it is no longer the only thing that does.
 */
function envEmbeddingProviderPair(): {
  filtered: EmbeddingProvider | null;
  invalid: string | null;
} {
  const raw = envEmbeddingProviderRaw();
  const filtered = raw !== null && isEmbeddingProvider(raw) ? raw : null;
  return { filtered, invalid: filtered === null ? raw : null };
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
  /**
   * Is there a Firecrawl credential AT ALL — the unchanged OR of the two halves
   * below, with env first.
   *
   * NO PRODUCTION READER as of DW-66: the Settings row used to be it, and the
   * row now reads the halves instead. Retained rather than deleted because it
   * is the answer to a question that outlives this one caller — "is Capture
   * credentialled" — and because removing it would fold the env-wins precedence
   * into whichever caller asks next. Kept in step with the halves by
   * construction: all three come off the same two reads below.
   */
  hasKey: boolean;
  /**
   * The two halves of {@link FirecrawlSettings.hasKey}, apart (DW-66).
   *
   * The OR above answers "is there a credential"; the Settings row asks a
   * different question, because `Remove` deletes the STORED key and nothing
   * else — so offering it for an env-only credential is an affordance that
   * clears nothing and leaves the sentence unchanged. Splitting here rather
   * than in `getWorkbenchSettings` keeps the one `FIRECRAWL_API_KEY` read in
   * one place, the same shape `envEmbeddingApiKeyProviders` /
   * `hasEmbeddingApiKey` already use.
   */
  hasEnvKey: boolean;
  hasStoredKey: boolean;
  baseUrl: string | null;
}

/**
 * Firecrawl credentials — an optional CAPTURE credential with no Deep Research
 * role. Deep Research reads {@link getResearchSettings} instead.
 */
export function getFirecrawlSettings(
  /**
   * The snapshot to resolve against, defaulting to the cache — the same
   * optional-trailing convention {@link getLoopbackApiSettings} uses. A caller
   * composing ONE answer out of several resolvers (`getWorkbenchSettings`)
   * passes the config it already holds, so no field of that answer can describe
   * a generation another field never saw (DW-620).
   */
  cfg: AppConfig = loadConfigSync(),
): FirecrawlSettings {
  // Truthiness, not nullishness, on BOTH halves: `FIRECRAWL_API_KEY=""` is
  // set-but-empty, so it is not a credential and must not mask a key the owner
  // stored through Settings.
  const fromEnv = nonEmpty(process.env.FIRECRAWL_API_KEY);
  const fromStore = nonEmpty(cfg.firecrawlApiKey);
  return {
    hasKey: Boolean(fromEnv ?? fromStore),
    hasEnvKey: fromEnv !== null,
    hasStoredKey: fromStore !== null,
    baseUrl: nonEmpty(cfg.firecrawlBaseUrl),
  };
}

/**
 * Everything the Deep Research search leg needs, resolved once.
 *
 * ENV WINS, field by field, the same precedence every other setting here
 * follows. `provider` is `null` when NEITHER env nor store names one — the
 * caller applies {@link DEFAULT_RESEARCH_PROVIDER}, because "nothing chosen"
 * and "chosen to be Tavily" have to stay distinguishable on the Settings
 * surface (an editable select cannot show a value it did not store).
 *
 * The KEYS ride here as values rather than as booleans, unlike
 * {@link FirecrawlSettings}: this is the reader the search functions use, and a
 * second door that re-read `process.env` per provider is how the surface and
 * the run end up disagreeing about which provider is configured. Nothing serves
 * this object over HTTP — {@link getWorkbenchSettings} derives BOOLEANS from it,
 * which is the AD-23 boundary.
 */
export interface ResearchSettings {
  provider: ResearchProviderId | null;
  envProvider: ResearchProviderId | null;
  invalidEnvProvider: string | null;
  tavilyApiKey: string | null;
  serpApiKey: string | null;
  serpApiEngine: string;
  searxngBaseUrl: string | null;
  envSearxngBaseUrl: string | null;
  searxngCategories: string | null;
}

export function getResearchSettings(
  /** The snapshot to resolve against — see {@link getFirecrawlSettings}. */
  cfg: AppConfig = loadConfigSync(),
): ResearchSettings {
  const envProviderRaw = nonEmpty(process.env.RESEARCH_PROVIDER);
  const envProvider = isResearchProviderId(envProviderRaw) ? envProviderRaw : null;
  const invalidEnvProvider = envProviderRaw && !envProvider ? envProviderRaw : null;
  const storedProvider = isResearchProviderId(cfg.researchProvider)
    ? cfg.researchProvider
    : null;
  return {
    provider: envProvider ?? storedProvider,
    envProvider,
    invalidEnvProvider,
    tavilyApiKey:
      nonEmpty(process.env.TAVILY_API_KEY) ?? nonEmpty(cfg.tavilyApiKey),
    serpApiKey:
      nonEmpty(process.env.SERPAPI_API_KEY) ?? nonEmpty(cfg.serpApiKey),
    serpApiEngine:
      nonEmpty(process.env.SERPAPI_ENGINE) ??
      nonEmpty(cfg.serpApiEngine) ??
      DEFAULT_SERPAPI_ENGINE,
    searxngBaseUrl:
      nonEmpty(process.env.SEARXNG_BASE_URL) ?? nonEmpty(cfg.searxngBaseUrl),
    envSearxngBaseUrl: nonEmpty(process.env.SEARXNG_BASE_URL),
    searxngCategories:
      nonEmpty(process.env.SEARXNG_CATEGORIES) ?? nonEmpty(cfg.searxngCategories),
  };
}

/**
 * WHICH providers the ENVIRONMENT alone carries a credential for.
 *
 * Separate from {@link getResearchSettings} because it answers a different
 * question: the surface offers `Remove` only for a credential the store owns,
 * and no route can delete an environment variable.
 */
export function envResearchProviders(): ResearchProviderId[] {
  const out: ResearchProviderId[] = [];
  if (nonEmpty(process.env.TAVILY_API_KEY)) out.push("tavily");
  if (nonEmpty(process.env.SERPAPI_API_KEY)) out.push("serpapi");
  if (nonEmpty(process.env.SEARXNG_BASE_URL)) out.push("searxng");
  return out;
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
 * `getEmbeddingResolution(cfg)`, which threads it all the way through the
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
 * Read through `getEmbeddingResolution()` — the resolver's own door, the one
 * every embed path uses — and NOT by re-applying the predicate here. A rule
 * stated twice is two rules that agree today. (The resolver's mismatch warning
 * is throttled once per `(provider, override)` per process (DW-273), so a
 * settings read cannot make it spam.)
 *
 * `providerInEffect` is the OTHER half that same door returns, taken from the
 * SAME call rather than a second one (DW-616). It is here because a surface
 * that renders a claim about the embedding infrastructure — `/settings`' "this
 * deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize
 * index" — has to be told which provider is actually embedding: the browser
 * holds only the env variable and the stored value, and the resolver's Workers
 * AI auto-detect leg fires with both of those unset.
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
  providerInEffect: EmbeddingProvider | null;
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

  // ONE walk of the ladder for both halves (DW-616). `getEmbeddingResolution`
  // resolves the provider and then the model FROM it, so a second call for the
  // provider would be a second resolution over `process.env` and the snapshot —
  // two answers that agree today and describe two config generations the moment
  // anything moves between them.
  const resolution = getEmbeddingResolution(cfg);
  const inEffect = resolution.model;
  return {
    model,
    source,
    inEffect,
    providerInEffect: resolution.provider,
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
  /**
   * The inbound-email door's own stored state (Story 7.5), passed in for the
   * same reason `hasWorkersAiBinding` is: this function is SYNC and reads the
   * config cache, and the address lives in `email-ingest.ts`'s index behind an
   * async storage read. Absent — every caller but the settings route — the
   * Intake pane renders its "no inbound address" sentence, which is the honest
   * answer for a payload that was not told one.
   */
  inboundEmail?: { enabled: boolean; address: string },
  /**
   * The snapshot the whole payload resolves from, defaulting to the cache.
   *
   * This object used to make THREE entries into the 5 s-TTL cache: its own
   * `loadConfigSync()`, plus one each inside `getFirecrawlSettings` and
   * `getResearchSettings` (`embeddingModelAnswer` and `getLoopbackApiSettings`
   * already took the snapshot and entered nothing). The route then made a
   * fourth beside it for `getEffectiveSettings` — so one settings response
   * could describe two or three config generations across the panes it renders
   * (DW-620). The route already holds the config it read (`ConfigRead.config`
   * on `GET`, the merge base it just wrote on `PUT`); passing it here is what
   * makes the whole answer one generation.
   */
  cfg: AppConfig = loadConfigSync(),
): WorkbenchSettingsValues {
  // From the SAME `cfg`, not from two fresh cache entries of their own.
  const firecrawl = getFirecrawlSettings(cfg);
  const research = getResearchSettings(cfg);
  // The filtered variable and the RAW value beside it, so "set to junk" and
  // "not set" stop being the same payload (DW-508) — through the ONE pair
  // builder the route's `workbenchSettingsStored` also calls, so the two halves
  // of the seam cannot drift apart (DW-638).
  const { filtered: envProvider, invalid: envProviderInvalid } =
    envEmbeddingProviderPair();
  // Resolved from the SAME `cfg` this whole answer resolves from, through the
  // ONE helper `getEffectiveSettings` uses (DW-312/DW-313) — so the two
  // Settings surfaces cannot answer "is the model I set being substituted?"
  // differently.
  const embedding = embeddingModelAnswer(cfg);
  const loopback = getLoopbackApiSettings(cfg);
  return {
    chatProvider: cfg.chatProvider ?? null,
    chatModel: cfg.chatModel ?? null,
    ingestProvider: cfg.ingestProvider ?? null,
    ingestModel: cfg.ingestModel ?? null,
    customBaseUrl: nonEmpty(cfg.customBaseUrl),
    // The STORED key only, exactly as `hasEmbeddingApiKey` below is. An env
    // credential is reported by `envCustomApiKey` beside it, because `Remove`
    // must not be offered for a key this route cannot delete: it used to be the
    // OR of the two, so `LLM_CUSTOM_API_KEY` alone read as "A key is stored."
    // beside a Remove button that cleared nothing and left the sentence saying
    // the same thing afterwards (DW-66).
    hasCustomApiKey: nonEmpty(cfg.customApiKey) !== null,
    // The env half, through the ONE door `apiKeyForProvider` resolves it with —
    // so the row and the runtime cannot disagree about whether the variable is
    // a credential. A BOOLEAN, never the value (AD-23).
    envCustomApiKey: envCustomApiKey() !== null,
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
    // …and the value the filter refused, which the row describes WITHOUT
    // pinning on: the select stays editable on junk, because the store is what
    // applies the moment the variable is corrected (DW-398's boundary).
    envEmbeddingProviderInvalid: envProviderInvalid,
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
    // The STORED half and the ENV half apart, for the reason `hasCustomApiKey`
    // splits above (DW-66). This row used to read `firecrawl.hasKey` — the OR —
    // which is what made an env-only deployment say "A key is stored." beside a
    // `Remove` that deletes nothing. The OR itself is unchanged and still
    // computed from the same two reads; nothing in production reads it now.
    hasFirecrawlApiKey: firecrawl.hasStoredKey,
    envFirecrawlApiKey: firecrawl.hasEnvKey,
    // Deep Research. The STORED select rides in `researchProvider` and the env
    // override rides beside it, the same split the embedding pair uses and for
    // the same reason: `RESEARCH_PROVIDER` wins at run time, so folding it into
    // the editable field would show an unsaveable value in a select and persist
    // it on the next save.
    researchProvider: isResearchProviderId(cfg.researchProvider)
      ? cfg.researchProvider
      : null,
    envResearchProvider: research.envProvider,
    envResearchProviderInvalid: research.invalidEnvProvider,
    // BOOLEANS, not the keys — AD-23. `getResearchSettings` holds the values and
    // never crosses this boundary.
    hasTavilyApiKey: nonEmpty(cfg.tavilyApiKey) !== null,
    hasSerpApiKey: nonEmpty(cfg.serpApiKey) !== null,
    serpApiEngine: nonEmpty(cfg.serpApiEngine),
    // The STORED instance URL, with the env override served apart — SearXNG's
    // URL is its credential, so it follows the key rule rather than the
    // endpoint rule: `Remove` must not be offered for a variable no route can
    // delete.
    searxngBaseUrl: nonEmpty(cfg.searxngBaseUrl),
    envSearxngBaseUrl: research.envSearxngBaseUrl,
    searxngCategories: nonEmpty(cfg.searxngCategories),
    envResearchProviders: envResearchProviders(),
    // Intake and MinerU PDF (Stories 7.5 / 7.2). The email pair is SERVED from
    // the door's own store rather than copied into `AppConfig`; everything
    // below it is stored here, and the key is a boolean like every other
    // credential on this surface (AD-23).
    inboundEmailAddress: nonEmpty(inboundEmail?.address),
    inboundEmailEnabled: inboundEmail?.enabled === true,
    intakeKeepParsed: cfg.intakeKeepParsed === true,
    // `off` for an absent OR unrecognised stored value — the fail-closed
    // direction for a setting whose other modes can send documents to a third
    // party. Same rule as `getMinerUSettings`, which is what the sidecar reads.
    mineruMode: isMinerUMode(cfg.mineruMode) ? cfg.mineruMode : "off",
    mineruLocalBaseUrl: nonEmpty(cfg.mineruLocalBaseUrl),
    hasMinerUApiKey: nonEmpty(cfg.mineruApiKey) !== null,
    // The loopback door (Story 8.1), through the ONE resolver — so the pane, the
    // owner-automation route the sidecar polls and the health body cannot
    // disagree about whether the door is open. The TOKEN never crosses this
    // boundary: `hasLoopbackApiToken` is a presence boolean like every other
    // credential here (AD-23), and `loopbackTokenSource` is the one extra fact
    // the pane cannot derive — `LLM_WIKI_API_TOKEN` wins over the store, and a
    // surface that did not know would keep offering Generate as if pressing it
    // changed what callers must send.
    apiEnabled: loopback.enabled,
    allowUnauthenticated: loopback.allowUnauthenticated,
    hasLoopbackApiToken: loopback.token !== null,
    loopbackTokenSource: loopback.tokenSource,
    loopbackMcpEntry: path.resolve(process.cwd(), LOOPBACK_MCP_ENTRY),
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
  // ONE read of the filter, feeding BOTH halves below (DW-552). The two fields
  // are EXCLUSIVE — the invalid one is exactly what the filter threw away — and
  // the join in `mergedVectorInputs` relies on that exclusivity for its `??` to
  // be a join rather than a precedence question. Since DW-638 that exclusivity
  // lives inside `envEmbeddingProviderPair`, which is also what
  // `getWorkbenchSettings` builds the payload's twin from — so the two halves
  // are the same expression rather than two spellings held equal by a test.
  const { filtered: envProvider, invalid: envProviderInvalid } =
    envEmbeddingProviderPair();
  return {
    vectorSearchEnabled: cfg.vectorSearchEnabled === true,
    // The CONFIG halves — what a patch can move.
    embeddingProvider: nonEmpty(cfg.embeddingProvider),
    embeddingBaseUrl: nonEmpty(cfg.embeddingBaseUrl),
    embeddingModel: nonEmpty(cfg.embeddingModel),
    hasEmbeddingApiKey: nonEmpty(cfg.embeddingApiKey) !== null,
    // …and the ENV halves, which it cannot, kept apart so the merge answers
    // identically to the browser's own `draftVectorInputs`.
    envEmbeddingProvider: envProvider,
    // …and the value that filter threw away — now literally the same expression
    // `getWorkbenchSettings` builds the payload's twin from (DW-508/DW-552/
    // DW-638), because this one is what the ROUTE runs and the payload's is what
    // the BROWSER gets. `settings-runtime-wiring.test.ts` still pins them equal
    // across all four variable states. The route's half re-joins the two at the
    // point of use, so a junk `EMBEDDING_PROVIDER` is refused here for the same
    // reason `getVectorSearchSettings` refuses it — rather than falling through
    // to the stored provider and waving the switch on.
    envEmbeddingProviderInvalid: envProviderInvalid,
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

  /**
   * ONE decision for every text key on this patch — the SAME one the flat half
   * of a settings body gets (DW-623).
   *
   * The decision is {@link flatTextFieldAction}, in `workbench-settings.ts`;
   * only the typed mutation is local, exactly as `applyFlatTextField` splits it
   * in `src/app/api/settings/route.ts`. Every REACHABLE arm is unchanged: absent
   * keeps, `null`/`""`/whitespace-only delete, any other string stores TRIMMED.
   *
   * WHAT MOVED IS THE UNREACHABLE ARM. This closure used to collapse a
   * non-string to `""` and then read `""` as a CLEAR, so a body whose
   * `workbench` half carried a number for a text field would have ERASED the
   * stored key — while the flat half of that same body, through
   * `flatTextFieldAction`, left it untouched. Two answers to one question about
   * one stored key, and the more destructive one belonged to the surface that
   * holds the secrets. `validateWorkbenchSettingsPatch` answers 400 for a
   * non-string well above this merge and the parameter type admits none, so
   * nothing malformed reaches here; this is defence in depth BEHIND that door,
   * and leaving the key alone is the only inert thing it can do — which is why
   * the clear-on-switch decision below is routed through the SAME question
   * rather than reading `patch.embeddingProvider` raw.
   */
  const setText = <K extends keyof AppConfig>(
    key: K,
    value: string | null | undefined,
  ): void => {
    const action = flatTextFieldAction(value);
    if (action === "ignore") return;
    if (action === "delete") {
      delete updated[key];
      return;
    }
    (updated as Record<string, unknown>)[key as string] = action.store;
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
  //
  // ASKED THROUGH `flatTextFieldAction`, exactly as `setText` above is (DW-623).
  // `embeddingProviderChanged` normalises ANY non-string to `null`, so a patch
  // carrying `embeddingProvider: 42` against a stored `"openai"` reads as a move
  // to auto-detect and DELETES the key and the endpoint — a request the door
  // should have refused destroying two fields, in the same merge where the
  // non-string now leaves `embeddingProvider` itself alone. `ignore` is the
  // shared decision's word for "this says nothing about the field", which is
  // what `undefined` already meant here, so both land on `existing` together.
  //
  // NO REACHABLE ARM MOVES. `undefined` was already reading `existing`; `null`,
  // `""`, whitespace-only and every real string still reach
  // `embeddingProviderChanged` UNTRIMMED, which is what lets it apply its own
  // normalisation and read `""`/`"   "`/`null` alike as the auto-detect rung.
  const providerInput = flatTextFieldAction(patch.embeddingProvider);
  const embeddingProviderSwitched = embeddingProviderChanged(
    existing.embeddingProvider ?? null,
    providerInput === "ignore"
      ? existing.embeddingProvider ?? null
      : patch.embeddingProvider ?? null,
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
  // Deep Research. NO clear-on-switch here, deliberately, unlike the embedding
  // pair above: each provider has its OWN credential field, so moving the
  // select cannot hand Tavily's key to SerpApi. Keeping the other provider's
  // key is what lets an owner switch back without pasting it again.
  setText("researchProvider", patch.researchProvider);
  setText("tavilyApiKey", patch.tavilyApiKey);
  setText("serpApiKey", patch.serpApiKey);
  setText("serpApiEngine", patch.serpApiEngine);
  setText("searxngBaseUrl", patch.searxngBaseUrl);
  setText("searxngCategories", patch.searxngCategories);

  if (patch.llmTimeoutSeconds !== undefined) {
    if (patch.llmTimeoutSeconds === null) {
      delete updated.llmTimeoutSeconds;
    } else if (typeof patch.llmTimeoutSeconds === "number") {
      updated.llmTimeoutSeconds = patch.llmTimeoutSeconds;
    }
    // A string never reaches here: `validateWorkbenchSettingsPatch` refuses one
    // with a sentence, which is why the patch type admits it at all.
  }

  setText("mineruMode", patch.mineruMode);
  setText("mineruLocalBaseUrl", patch.mineruLocalBaseUrl);
  setText("mineruApiKey", patch.mineruApiKey);

  if (patch.intakeKeepParsed !== undefined) {
    // Stored explicitly on both arms, like `vectorSearchEnabled` above and for
    // the same reason: an owner who turned it OFF should read back as having
    // decided rather than as never having been asked.
    updated.intakeKeepParsed = patch.intakeKeepParsed;
  }

  if (patch.vectorSearchEnabled !== undefined) {
    // `false` is stored explicitly rather than deleted: the default is already
    // false, but an owner who turned it OFF should read back as having done so
    // rather than as never having decided.
    updated.vectorSearchEnabled = patch.vectorSearchEnabled;
  }

  // The loopback door (Story 8.1). Both switches store `false` explicitly, on
  // the argument above and harder: `getLoopbackApiSettings` reads absent as
  // CLOSED, so deleting the key on `false` would work — but then "the owner shut
  // the door" and "the owner has never seen this pane" would be the same stored
  // state, and the first is a decision worth reading back.
  if (patch.apiEnabled !== undefined) {
    updated.apiEnabled = patch.apiEnabled;
  }
  if (patch.allowUnauthenticated !== undefined) {
    updated.allowUnauthenticated = patch.allowUnauthenticated;
  }
  // A secret, so it rides the three-state `setText` path with the other keys:
  // absent keeps, `null`/`""` deletes, a value replaces.
  setText("loopbackApiToken", patch.loopbackApiToken);

  if (patch.skillEnablement !== undefined) {
    // MERGED key-by-key, not replaced (Story 8.6). The sidecar scans the
    // filesystem and this map records only DECISIONS — see
    // {@link AppConfig.skillEnablement} — so a patch built from a stale scan
    // must not drop the owner's decision about a Skill it did not list. Absent
    // from the map still means ENABLED, which is why nothing here has to
    // materialise an inventory.
    updated.skillEnablement = {
      ...(existing.skillEnablement ?? {}),
      ...patch.skillEnablement,
    };
  }

  return updated;
}

/**
 * Full effective settings with source annotations for the settings UI.
 */
export function getEffectiveSettings(
  /**
   * The snapshot to resolve against, defaulting to the cache. `GET`/`PUT
   * /api/settings` pass the config they already read, so the legacy half and
   * the `workbench` half of one response describe one generation (DW-620).
   */
  cfg: AppConfig = loadConfigSync(),
): EffectiveSettings {
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
  // From the `cfg` read at the top, not a fresh one (DW-334) — see the note on
  // `configured` below.
  const resolvedApiKey = apiKeyForProvider(provider, cfg);
  const apiKeySource: SettingSource = !resolvedApiKey
    ? "none"
    : provider === "custom" && !envCustomApiKey()
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
  //
  // AND THE REFUSAL RIDES ALONG (DW-402). A `none` badge beside an empty box is
  // the same sentence for "nothing was ever set" and for "what you set was
  // thrown away", and only the second one has an action attached. The resolver
  // already knows which; `resolveOllamaBaseUrl` is `getOllamaBaseUrl` with that
  // answer kept rather than dropped, so the URL and the source below are
  // resolved exactly as they were.
  let ollamaBaseUrl: string | null;
  let ollamaBaseUrlSource: SettingSource;
  let ollamaBaseUrlIssue: string | null;
  if (provider === "ollama-cloud") {
    ollamaBaseUrl = "https://ollama.com/api";
    ollamaBaseUrlSource = "default";
    // The ladder is not walked on this branch, so it has refused nothing. A
    // reason here would describe a variable that had no bearing on the endpoint
    // reported beside it.
    ollamaBaseUrlIssue = null;
  } else {
    const ollama = resolveOllamaBaseUrl(cfg);
    ollamaBaseUrl = ollama.url ?? null;
    ollamaBaseUrlIssue = ollama.issue;
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

  // The same snapshot too (DW-334). This leg used to cost THREE further reads
  // on its own — the workload ladder's `getEffectiveProvider()` and its
  // `providerIsUsable`, plus its own — so the extraction rows could describe a
  // config generation the provider rows above had never seen.
  const structuredKnowledge = getStructuredKnowledgeModelSettings(cfg);

  return {
    provider,
    providerSource,
    model,
    modelSource,
    // Against the model this function just resolved (DW-403), so the flat
    // `/settings` page and `/api/status` cannot disagree about whether a
    // default-less provider with no model name is ready.
    configured: providerIsUsable(provider, model, cfg),
    // The SAME `cfg` EVERY half of this answer is resolved against — the
    // credential, provider, endpoint and extraction legs as well as this one
    // (DW-313 closed the embedding half; DW-334 closed the rest). This function
    // enters `loadConfigSync` exactly once, so no field can describe a config
    // generation another field never saw: a second read of the 5 s-TTL cache
    // could answer them about two different snapshots.
    embeddingSupport: hasEmbeddingSupport(cfg),
    embeddingModel: embedding.model,
    embeddingModelSource: embedding.source,
    embeddingModelInEffect: embedding.inEffect,
    // The provider half, from the SAME single resolution as the model above
    // (DW-616) — `/settings` renders a sentence about the embedding
    // infrastructure and the browser cannot resolve which provider embeds.
    // Flat, beside its siblings, so the route's `...settings` spread carries it.
    embeddingProviderInEffect: embedding.providerInEffect,
    embeddingModelOverridden: embedding.overridden,
    hasApiKey: resolvedApiKey !== null,
    apiKeySource,
    ollamaBaseUrl,
    ollamaBaseUrlSource,
    ollamaBaseUrlIssue,
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
 *
 * `cfg` is a DEFAULT PARAMETER, the convention {@link getOllamaBaseUrl} and
 * {@link getEffectiveProvider} already use, because this function reads the
 * store unconditionally — there is no lazy leg to protect. A caller that
 * already holds a snapshot (`llm.ts`'s `getModel`, reached from `callLLM`,
 * `callLLMStream`, `callVisionLLM` and `getConfiguredModel`, each of which
 * awaits `loadConfig()` first) passes it so the client is built out of one
 * config generation (DW-334, DW-618).
 */
export function getResolvedCredentials(
  cfg: AppConfig = loadConfigSync(),
): ResolvedCredentials {
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

  // API keys remain server-side environment secrets. Resolved from the one
  // `cfg` this function was handed (or read once above) rather than from a
  // fresh entry into the 5 s-TTL cache (DW-334), so the key, the model and the
  // endpoint below describe one config generation — `getModel()` builds a
  // single client out of all three.
  //
  // `getConfiguredModel`'s explicit-provider / workload branch bypasses this
  // function, and it used to resolve the workload settings, the key and the
  // base URL as separate cache entries of its own. It no longer does: it
  // threads its `await loadConfig()` snapshot through those resolvers and into
  // `getModel()` here (DW-618), so BOTH routes into `llm.ts` build one client
  // from one generation.
  const apiKey = apiKeyForProvider(provider, cfg);

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
    // The `cfg` above again (DW-334): the endpoint and the key are the two
    // halves `createOpenAI` is handed together.
    customBaseUrl: provider === "custom" ? getCustomBaseUrl(cfg) : null,
  };
}
