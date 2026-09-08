import { generateText, streamText } from "ai";
import type { FinishReason } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";
import {
  getEffectiveProvider,
  getResolvedCredentials,
  detectEnvProvider,
  loadConfig,
  apiKeyForProvider,
  getChatModelSettings,
  getCustomBaseUrl,
  getIngestModelSettings,
  getOllamaBaseUrl,
  llmTimeoutOption,
  providerIsConfigured,
  providerLabel,
  DEFAULT_MODELS,
} from "./config";
import type { AppConfig, ProviderValue } from "./config";
import { SETTINGS_LABEL, settingsPointer } from "./workbench-settings";
import { getErrorMessage } from "./errors";
import { logger } from "./logger";
import {
  LLM_MAX_RETRIES,
  LLM_RETRY_BASE_MS,
  LLM_RETRY_MAX_MS,
  LLM_MAX_OUTPUT_TOKENS,
} from "./constants";
import type { ProviderInfo } from "./types";

// Re-export ProviderInfo from types for backward compatibility
export type { ProviderInfo } from "./types";

/**
 * Where the `custom` provider's runtime refusals send the owner: the Settings
 * surface, arrow, the `llm-models` category's own nav label (DW-369).
 *
 * ONE value, DERIVED. Five throw sites below used to spell that destination out
 * as a literal, so renaming the category would have left five runtime messages
 * naming a nav row the Settings surface no longer shows — and the literal is
 * deliberately absent from this file now, including from this comment, so a
 * search for it turns up only the one place that owns it. The category half
 * comes from `SETTINGS_CATEGORIES`, through the same {@link settingsPointer} the
 * rendered Settings copy uses.
 *
 * The SHORT surface label is deliberate and is why the label is passed rather
 * than defaulted: `settingsPointer`'s default produces "Workbench Settings → …",
 * which disambiguates two Settings surfaces for a sentence RENDERED ON one of
 * them. These are runtime errors raised from the LLM call — they are not on
 * either surface, so that ambiguity does not arise and the extra word would only
 * be noise. See the doc block on `settingsPointer` in `./workbench-settings`.
 */
const LLM_MODELS_POINTER = settingsPointer("llm-models", SETTINGS_LABEL);

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/** DeepSeek's OpenAI-compatible API base URL. DeepSeek speaks the OpenAI
 *  wire format, so we reuse the `@ai-sdk/openai` provider pointed here. */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** HTTP status codes that indicate a transient / retryable failure. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Substrings in error messages that indicate a network-level transient error. */
const RETRYABLE_MESSAGES = [
  "econnreset",
  "etimedout",
  "fetch failed",
  "socket hang up",
  "network error",
  "enotfound",
  "econnrefused",
];

/**
 * Determine whether an error is transient and therefore safe to retry.
 *
 * Retryable: HTTP 429 / 5xx, network errors (ECONNRESET, ETIMEDOUT, etc.)
 * Not retryable: 400, 401, 403, missing API key, validation errors.
 *
 * Priority order:
 *   1. Explicitly non-retryable patterns (bail early)
 *   2. `.status` property (most reliable — set by fetch / AI SDK)
 *   3. Network-level error messages (ECONNRESET, ETIMEDOUT, etc.)
 *   4. HTTP status codes in the message text (last resort, tighter regex to
 *      avoid false positives from incidental numbers like "limit of 500 tokens")
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  // 1. Explicitly non-retryable patterns — bail early
  if (message.includes("no llm api key")) return false;

  // 2. Check for a `status` property FIRST (most reliable signal)
  const errWithStatus = error as Error & { status?: number };
  if (typeof errWithStatus.status === "number") {
    const s = errWithStatus.status;
    if (s >= 400 && s < 500 && s !== 429) return false;
    if (RETRYABLE_STATUS_CODES.has(s)) return true;
  }

  // 3. Check for network-level error messages
  if (RETRYABLE_MESSAGES.some((msg) => message.includes(msg))) return true;

  // 4. Last resort: look for HTTP status codes in the message, but only in
  //    patterns that look like actual HTTP status reports — not incidental
  //    numbers in limit descriptions like "limit of 500 tokens".
  //    Matches: "status: 503", "status 429", "503 error", "429 too many",
  //    "error 500", "gateway 502", "timeout 504", "unavailable 503", etc.
  const HTTP_STATUS_KEYWORDS =
    "error|too many|rate limit|overloaded|unavailable|bad gateway|gateway timeout|unauthorized|forbidden|bad request|server error|service";
  const statusPattern = new RegExp(
    `\\bstatus[:\\s]+(\\d{3})\\b|\\b(\\d{3})\\s+(?:${HTTP_STATUS_KEYWORDS})|(?:${HTTP_STATUS_KEYWORDS})\\s+(\\d{3})\\b`,
    "i",
  );
  const statusMatch = message.match(statusPattern);
  if (statusMatch) {
    const status = parseInt(statusMatch[1] || statusMatch[2] || statusMatch[3], 10);
    // 4xx codes other than 429 are NOT retryable (auth, validation, not found)
    if (status >= 400 && status < 500 && status !== 429) return false;
    if (RETRYABLE_STATUS_CODES.has(status)) return true;
  }

  return false;
}

/**
 * Add ±20 % random jitter to a delay value so retries from multiple callers
 * don't thundering-herd the provider at the same instant.
 */
function addJitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4; // 0.8 – 1.2
  return Math.round(ms * factor);
}

/**
 * Retry an async function with exponential backoff.
 *
 * Only retries on errors deemed transient by {@link isRetryableError}.
 * Non-retryable errors are thrown immediately.
 *
 * @param fn          — The async operation to attempt.
 * @param maxRetries  — Maximum number of *retry* attempts (so total attempts = maxRetries + 1).
 * @param baseMs      — Base delay before the first retry (doubles each attempt).
 * @param maxMs       — Cap on the computed delay.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = LLM_MAX_RETRIES,
  baseMs: number = LLM_RETRY_BASE_MS,
  maxMs: number = LLM_RETRY_MAX_MS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // If the error isn't transient, don't bother retrying
      if (!isRetryableError(err)) throw err;

      // If we've used all retry attempts, throw
      if (attempt === maxRetries) break;

      const rawDelay = Math.min(baseMs * 2 ** attempt, maxMs);
      const delay = addJitter(rawDelay);

      logger.warn(
        "llm",
        `Retryable error on attempt ${attempt + 1}/${maxRetries + 1}, ` +
          `retrying in ${delay}ms: ${getErrorMessage(err, String(err))}`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

/**
 * Returns true if at least one supported LLM provider is configured.
 *
 * Checks both environment variables and the config file
 * (`.llm-wiki-config.json`).  Env vars take priority but the config file
 * acts as a fallback so users can configure via the UI.
 *
 * Supported providers and their env vars:
 *   - Anthropic: ANTHROPIC_API_KEY
 *   - OpenAI:    OPENAI_API_KEY
 *   - Google:    GOOGLE_GENERATIVE_AI_API_KEY
 *   - DeepSeek:  DEEPSEEK_API_KEY (OpenAI-compatible endpoint)
 *   - Ollama Cloud: OLLAMA_API_KEY
 *   - Ollama:    OLLAMA_BASE_URL or OLLAMA_MODEL (Ollama is typically keyless,
 *                so the env vars themselves are the signal). The two are not
 *                read the same way (DW-370): OLLAMA_BASE_URL counts only when
 *                it is an ABSOLUTE http(s) URL, because a value
 *                `getOllamaBaseUrl` refuses is ignored at resolution time (with
 *                a warning) and the call would go to the SDK's own localhost
 *                default rather than the address the owner typed. OLLAMA_MODEL
 *                still counts on presence alone — a model name is usable on its
 *                own, and the SDK's default endpoint is then the honest
 *                resolution.
 *
 * Additional env vars (used by src/lib/embeddings.ts, not this module):
 *   - EMBEDDING_MODEL: override the default embedding model name for the
 *     active provider. Defaults are:
 *       OpenAI → text-embedding-3-small
 *       Google → gemini-embedding-001
 *       Ollama → nomic-embed-text
 *     Anthropic does not support embeddings.
 *     See `src/lib/embeddings.ts` for the full embedding API.
 *
 * ASYNC BECAUSE THE GATE WARMS ITSELF (DW-548). The store leg used to read
 * `loadConfigSync()`, which answers `{}` whenever the in-memory cache is not
 * warm — and re-stamps that `{}` for another `CACHE_TTL_MS` (5 s,
 * `src/lib/config.ts`) each time it does. A CLI or MCP process hits that EVERY
 * time, because nothing ran ahead of the command to warm anything, so an owner
 * who saved Ollama or Custom was told no API key was configured and watched
 * ingest, lint, vision, search and the query route all skip their LLM steps.
 *
 * WARMING AT THE GATE rather than at each `main()`. This is the one place that
 * can see the store on behalf of all ~20 call sites at once, and the 5 s TTL
 * makes a warm at process start unreliable anyway: it has expired long before a
 * multi-second `ingest` reaches its gate.
 *
 * THE ENV FAST PATH STAYS FIRST, so an env-configured deployment still answers
 * without touching storage and the gate costs it nothing.
 *
 * EVERY CALL SITE MUST `await` THIS. An un-awaited call returns a Promise, which
 * is truthy, so a negated bare call passes the gate SILENTLY — and no type-aware
 * lint rule in this repo would catch it. `llm-key-cold-config.test.ts` scans
 * `src/` for exactly that slip, which is also why this sentence does not spell
 * the offending call out: the scan reads this file too.
 *
 * IT ANSWERS FOR WHICHEVER ROUTE THE CALLER NAMES (DW-711). With no argument —
 * which is how ~20 of its consumers call it — the question is still "can the
 * PRIMARY route make a call", because that is the route every one of them takes
 * immediately after: `callLLM`, `callLLMStream` and `callVisionLLM` fall through
 * to {@link getModel} when no workload is passed, and the bare
 * `getConfiguredModel()` calls (`action-extractor.ts`, `todo-extract.ts`) pass
 * no options at all. Widening that DEFAULT to `chatProvider` / `ingestProvider`
 * was refused (DW-621) and stays refused: `analyzeSource` in `src/lib/ingest.ts`
 * gates on this function and then calls `callLLM` with no `try` around it, so a
 * gate opening for a route the caller does not take turns today's
 * empty-analysis degrade into a thrown `No LLM API key found…`.
 *
 * WITH `{workload}` it asks the workload's own question instead, from the same
 * resolver the Settings surface and the retrieve payload read
 * ({@link getChatModelSettings} / {@link getIngestModelSettings}) — so the gate
 * and the call it guards cannot answer to two different providers. That is what
 * closed DW-711: a store naming a provider ONLY through `chatProvider` used to
 * pass `ChatCanvas`'s gate (which reads the workload answer) and then be refused
 * "No LLM provider is configured." by `chat.ts` (which read this one). The two
 * call sites that pass it are `src/lib/chat.ts` and `src/lib/ingest.ts`, and
 * both hand the SAME `{workload}` to the `callLLM` they guard. `chat.ts` is the
 * IN-PROCESS chat door; a send from the live Chat surface goes to the sidecar,
 * which resolves `chatProvider`/`chatModel` through a ladder of its own
 * (`sidecar/chat-provider.mjs`) and is not in this story's scope.
 *
 * A CALLER THAT DOES NOT PASS ONE STAYS ON THE PRIMARY, and that is a decision
 * per call site rather than per file: `reconcilePage` lives in `ingest.ts` but
 * takes its workload from its caller, because `mergePages`
 * (`src/lib/merge.ts`, not a workload owner) reaches it behind the bare gate.
 *
 * AN UNSET WORKLOAD INHERITS, and inherits all the way: when the store saved no
 * override, `{workload}` re-asks the primary question — env leg included — so
 * its answer is byte-for-byte the no-argument answer. Only a store that actually
 * saved `chatProvider`/`chatModel` or `ingestProvider`/`ingestModel` can tell
 * the two calls apart. Saving the MODEL alone is such a store: `usesPrimary` is
 * false as soon as either field is set, so a "cheaper model, same provider"
 * selection routes through the override with the provider inherited.
 *
 * WHAT AN OVERRIDE COSTS WHEN IT IS UNUSABLE. The workload answer is
 * `providerIsUsable` — credentials AND a model name — where the primary
 * question asks only about credentials. So a saved override with both credential
 * halves and NO model name (`{chatProvider: "custom", customApiKey,
 * customBaseUrl}` and no `chatModel`) closes this gate, and the call site
 * refuses with its own generic sentence, where the primary route would have
 * reached `getModel` and named the actual gap — the specific missing-model
 * refusal the `custom` branch below raises. That is the trade this story buys
 * and it is deliberate: the UI
 * gate refuses that same store from that same resolver, so the owner is told no
 * by one answer rather than yes by one and no by another. The INHERITING case
 * keeps the specific sentence, because it never enters this branch.
 *
 * THE ENV FAST PATH IS SKIPPED FOR A NAMED WORKLOAD, necessarily: the override
 * lives in the store and BEATS the primary route, so an env-configured
 * deployment whose owner saved `chatProvider: "openai"` with no
 * `OPENAI_API_KEY` has to hear `false` here rather than the primary's `true`.
 * Both workload call sites make an LLM request immediately after and already
 * read the store again inside `callLLM`; the no-argument fast path — the one
 * the ~20 other consumers, several inside loops, actually pay for — is
 * untouched.
 */
export async function hasLLMKey(options?: {
  workload?: LlmWorkload;
}): Promise<boolean> {
  // Fast path: check env vars via shared helper. Primary question only — see
  // the docblock's note on why a named workload cannot answer from the env.
  if (!options?.workload) {
    const env = detectEnvProvider();
    if (env.provider) return true;
  }

  // The store leg needs the STORE, and `loadConfigSync()` cannot read it on a
  // cold cache (DW-548) — so this awaits the real read.
  const cfg = await loadConfig();

  if (options?.workload) {
    // ONE resolver, not a second copy of the ladder: this is the same answer
    // `assembleWikiContext` puts in the retrieve payload and the Settings
    // surface renders, so the UI gate and this runtime gate cannot disagree.
    // `cfg` is threaded for the same reason it is below (DW-334).
    const settings =
      options.workload === "chat"
        ? getChatModelSettings(cfg)
        : getIngestModelSettings(cfg);
    // Only an ACTUAL override speaks for itself. An inheriting workload falls
    // through to the primary question — including the env leg the fast path
    // above was skipped for — which is what keeps the inherit case identical to
    // a no-argument call. Answering `settings.configured` here instead would
    // move the answer for stores that saved nothing: `configured` asks for
    // credentials AND a model name, so a `{provider: "custom", customApiKey,
    // customBaseUrl}` store with no model would flip from `true` to `false` and
    // trade `getModel`'s specific "needs a model name" for a generic refusal.
    if (!settings.usesPrimary && settings.provider) return settings.configured;
    if (detectEnvProvider().provider) return true;
  }

  // Ollama is keyless — only config-file provider path that works without env vars
  if (cfg.provider === "ollama") return true;

  // Story 1.9's `custom` provider is the other config-file path that works
  // without env vars: both its endpoint and its key may live in the store. Every
  // LLM feature in this repo gates on THIS function, so leaving it out would let
  // an owner select Custom, save it, see the deployment report itself configured
  // — and have ingest, lint, vision, search and the query route all silently
  // skip their LLM steps. `providerIsConfigured` is the one rule for "can this
  // provider actually be constructed", so it is called rather than restated.
  //
  // `cfg` is FORWARDED (DW-334): letting it re-enter `loadConfigSync()` would
  // answer the two halves of one question from two reads of a 5 s-TTL cache.
  return cfg.provider === "custom" && providerIsConfigured("custom", cfg);
}

// ---------------------------------------------------------------------------
// Provider info (metadata only — no API calls)
// ---------------------------------------------------------------------------

/**
 * Return metadata about the currently configured LLM provider without
 * constructing a model instance or making any network calls.
 *
 * Merges env vars and config file settings (env wins).
 */
export function getProviderInfo(): ProviderInfo {
  return getEffectiveProvider();
}

// ---------------------------------------------------------------------------
// Model construction (internal)
// ---------------------------------------------------------------------------

/**
 * Warm the config cache and hand back the snapshot — but ONLY when it holds
 * something.
 *
 * `loadConfig()` answers `{}` for two different situations: there is no config
 * file (ENOENT, a normal empty install) and THE STORE COULD NOT BE READ (a
 * non-ENOENT error, malformed JSON, or JSON that is not an object — see
 * `readStoredConfig`). On that second branch it does not prime the cache
 * either, so the PREVIOUS generation is still warm behind `loadConfigSync()`.
 *
 * Threading `{}` from that branch would be a behaviour change rather than a
 * threading-only one: a transient read failure would turn a working store-only
 * `ollama` / `custom` deployment into `No LLM API key found…` at the ungated
 * doors (`/api/settings/test`, `agent-runtime`, `structured-knowledge`,
 * `source-monitors`, and the `callLLM` sites in `query`, `search` and
 * `research-runtime`) for the whole 5 s window, where today the resolvers read
 * through the warm cache and absorb it. So an EMPTY answer is not a snapshot
 * worth threading: `undefined` means "read it yourself", which is exactly what
 * every one of these resolvers did before (DW-618).
 *
 * A genuinely empty SAVED config is unaffected — `loadConfigSync()` answers
 * `{}` for it too.
 */
async function configSnapshot(): Promise<AppConfig | undefined> {
  const cfg = await loadConfig();
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/**
 * Build the appropriate Vercel AI SDK model instance based on resolved
 * credentials.  Resolution merges env vars and the config file, with env
 * vars taking priority.
 *
 * The model name can be overridden with the `LLM_MODEL` env var, or via
 * the config file's `model` field.
 */
function getModel(cfg?: AppConfig) {
  // `cfg` is OPTIONAL and forwarded as-is: every public door into this file
  // takes a `configSnapshot()` first, and passing that snapshot on is what
  // keeps the key, the model and the base URL below one config generation
  // rather than three entries into a 5 s-TTL cache (DW-618). Omitted, the
  // resolver reads the store itself exactly as it always has.
  const creds = getResolvedCredentials(cfg);

  if (!creds.provider) {
    // The env var names STAY: this is the one refusal an operator can act on
    // without a browser, and the list is the whole of that. Only the trailing
    // destination changed (DW-630) — it used to stop at the bare surface word,
    // so the most common keyless path was the one path that named no field,
    // while the eight sibling refusals in this file all named one.
    throw new Error(
      "No LLM API key found. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, " +
        "GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY, OLLAMA_API_KEY, or " +
        "OLLAMA_BASE_URL / OLLAMA_MODEL in your environment, or configure a " +
        `provider in ${LLM_MODELS_POINTER}.`,
    );
  }

  const model = creds.model!;

  switch (creds.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: creds.apiKey! });
      return anthropic(model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: creds.apiKey! });
      return openai(model);
    }
    case "deepseek": {
      // DeepSeek exposes an OpenAI-compatible endpoint, so we reuse the
      // OpenAI provider with a custom baseURL rather than adding a new
      // dependency. Default model is deepseek-v4-flash (see DEFAULT_MODELS).
      //
      // Use `.chat()` (Chat Completions, /chat/completions) explicitly: the
      // provider's default callable targets OpenAI's Responses API
      // (/responses), which DeepSeek does not implement — it would 404.
      const deepseek = createOpenAI({
        apiKey: creds.apiKey!,
        baseURL: DEEPSEEK_BASE_URL,
      });
      return deepseek.chat(model);
    }
    case "custom": {
      // An owner-pointed OpenAI-compatible endpoint (Story 1.9) — exactly the
      // treatment `deepseek` gets above and for the same reason, including
      // `.chat()`: the provider's default callable targets OpenAI's Responses
      // API (/responses), which a compatible server generally does not
      // implement. A provider the owner can SELECT but the runtime cannot
      // CONSTRUCT would be a silently inert save, so both halves are required.
      if (!creds.customBaseUrl) {
        throw new Error(
          `The Custom provider needs a base URL. Set it in ${LLM_MODELS_POINTER}.`,
        );
      }
      if (!creds.apiKey) {
        throw new Error(
          `The Custom provider needs an API key. Set it in ${LLM_MODELS_POINTER}.`,
        );
      }
      // `DEFAULT_MODELS.custom` is deliberately absent, so there is no name to
      // fall back to. `getResolvedCredentials` returns `null` here rather than
      // the `?? provider` fallback, and this is what turns that into a sentence
      // the owner can act on instead of a request for a model called "custom".
      if (!model) {
        throw new Error(
          `The Custom provider needs a model name. Set it in ${LLM_MODELS_POINTER}.`,
        );
      }
      const custom = createOpenAI({
        apiKey: creds.apiKey,
        baseURL: creds.customBaseUrl,
      });
      return custom.chat(model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: creds.apiKey! });
      return google(model);
    }
    case "ollama": {
      const ollama = creds.ollamaBaseUrl
        ? createOllama({ baseURL: creds.ollamaBaseUrl })
        : createOllama();
      return ollama(model);
    }
    case "ollama-cloud": {
      if (!creds.apiKey) {
        // In this function's own gap-naming voice, with both halves derived
        // (DW-631). It used to hand-type the display label `providerLabel`
        // owns and name an env var instead of a field — an owner who selected
        // this provider in Settings was sent to a shell they may not have.
        //
        // DROPPING `OLLAMA_API_KEY` FROM THE SENTENCE COSTS NOTHING THE OWNER
        // COULD HAVE ACTED ON, and the no-provider throw above is NOT why: that
        // one fires only on `!creds.provider`, and reaching here means the
        // provider IS `ollama-cloud`, so its env-var list never renders for this
        // state. The reason is that the pre-switch guard in
        // `getConfiguredModel` already sends a keyless `ollama-cloud` to this
        // same derived destination (pinned in `llm.test.ts`) — so both ladders
        // now name one place to go instead of two different ones.
        throw new Error(
          `The ${providerLabel(creds.provider)} provider needs an API key. Set it in ${LLM_MODELS_POINTER}.`,
        );
      }
      const ollama = createOllama({
        baseURL: creds.ollamaBaseUrl ?? "https://ollama.com/api",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        compatibility: "strict",
      });
      return ollama(model);
    }
    default:
      throw new Error(`Unsupported provider: ${creds.provider}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Which workload a caller is resolving a model for (Story 1.9).
 *
 * Story 1.9 owns the SETTING and this resolver; Epics 2 and 3 own the call
 * sites, and DW-711 wired them: `src/lib/chat.ts` passes `{workload: "chat"}`
 * and `src/lib/ingest.ts` passes `{workload: "ingest"}`, to {@link hasLLMKey}
 * and to the `callLLM` each gate guards, so a workload's gate and its call
 * resolve through one ladder.
 *
 * NOT EVERY DOOR TAKES ONE. {@link callVisionLLM} stays on the primary
 * deliberately: vision needs a MULTIMODAL model and Story 1.9 defines no vision
 * workload, so spending an owner's text-synthesis choice on an image call would
 * refuse work that runs today. Neither `query.ts`, `search.ts`, the lint and
 * merge helpers, `knowledge-compilation.ts`, `research-runtime.ts` nor
 * `source-monitors.ts` is a workload owner either — `src/lib/config.ts` names
 * two call-site owners and these are neither.
 */
export type LlmWorkload = "chat" | "ingest";

/** Resolve the active AI SDK model for server-side agents and structured jobs. */
export async function getConfiguredModel(options?: {
  provider?: ProviderValue;
  model?: string;
  workload?: LlmWorkload;
}) {
  // KEPT, not discarded (DW-618). Every resolver below takes a snapshot, and
  // this one read is the only generation any of them should answer from: the
  // 5 s TTL can expire between two of them, and a re-entry after that falls to
  // the cold-cache `{}` — which refuses a correctly configured provider
  // halfway through building one client. `configSnapshot` rather than
  // `loadConfig` because an EMPTY answer must stay unthreaded — see its
  // docblock.
  const cfg = await configSnapshot();
  return resolveConfiguredModel(options, cfg);
}

/**
 * THE ONE LADDER, reached from two entry points (DW-711).
 *
 * This is {@link getConfiguredModel}'s whole body after its `await`, lifted out
 * unchanged so `callLLMWithFinish` and `callLLMStream` can resolve a
 * workload-routed model too. They already hold a `configSnapshot()`; calling
 * `getConfiguredModel({workload})` from them would take a SECOND one — a second
 * storage read and a second config generation, undoing DW-618 — and copying the
 * workload branch into them would be a second ladder free to drift from this
 * one.
 *
 * SYNCHRONOUS on purpose, and it can be: `apiKeyForProvider`,
 * `getResolvedCredentials`, `getChatModelSettings`, `getIngestModelSettings`,
 * `getCustomBaseUrl`, `getOllamaBaseUrl`, `getModel` and every `create*` are
 * all synchronous, so the single `await` stays at the door and one `cfg` is
 * threaded through every leg of the client built here.
 *
 * With no `provider` and no `workload` this expression IS `getModel(cfg)`,
 * which is what lets the `callLLM` family route through it without changing the
 * answer for any of its existing callers.
 */
function resolveConfiguredModel(
  options:
    | { provider?: ProviderValue; model?: string; workload?: LlmWorkload }
    | undefined,
  cfg: AppConfig | undefined,
) {
  let provider = options?.provider;
  let model = options?.model;
  if (!provider && options?.workload) {
    const settings =
      options.workload === "chat"
        ? getChatModelSettings(cfg)
        : getIngestModelSettings(cfg);
    // An UNSET workload inherits: falling through to `getModel()` IS the primary
    // route, and re-deriving it here would be a second ladder free to drift from
    // `getResolvedCredentials`'.
    if (!settings.usesPrimary && settings.provider) {
      provider = settings.provider;
      model = model ?? settings.model ?? undefined;
    }
  }

  if (provider) {
    const apiKey = apiKeyForProvider(provider, cfg);
    // `custom` is exempt for the same reason `ollama` is, though not the same
    // cause: its own case below names all three gaps in `getModel`'s order —
    // base URL, API key, model — and routing it through this generic sentence
    // reported the missing key BEFORE the missing endpoint, so one state got two
    // diagnoses depending on the ladder it arrived on (DW-632).
    if (provider !== "ollama" && provider !== "custom" && !apiKey) {
      // One of the NINE refusals this file now sends somewhere, and until
      // DW-503 the only one of them that named nowhere: this sentence used to
      // end at "server." and hand back the raw slug ("openai", "ollama-cloud"),
      // so the owner learned that something was unconfigured but neither what
      // it is called nor where the field lives. Both halves are derived —
      // `providerLabel` owns the display name and {@link LLM_MODELS_POINTER}
      // owns the destination — which is what keeps this in step with the eight
      // sibling refusals rather than beside them.
      throw new Error(
        `The ${providerLabel(provider)} provider is not configured on this server. Set it in ${LLM_MODELS_POINTER}.`,
      );
    }
    // THE STORED MODEL, TAKEN FROM ITS OWNER (DW-713). This branch used to skip
    // from `options.model` straight to `OLLAMA_MODEL`/`DEFAULT_MODELS`, reading
    // neither `LLM_MODEL` nor `cfg.model` — so a `custom` provider whose model
    // was saved in the store built fine through `getModel` and was refused
    // "needs a model name" here, at `agent-runtime`'s door. `custom` is where it
    // bites because `DEFAULT_MODELS.custom` deliberately does not exist: it is
    // the one provider with no tail to fall back to.
    //
    // DERIVED, NOT RE-TYPED: `getResolvedCredentials` owns the ladder
    // (`LLM_MODEL` → `cfg.model` → `OLLAMA_MODEL` → `DEFAULT_MODELS`), so
    // asking it is what keeps the two ladders from drifting. It is threaded the
    // same `cfg` as `apiKeyForProvider` and the base-URL accessors below, so
    // every leg of this client comes from one config generation.
    //
    // GUARDED ON PROVIDER IDENTITY: the stored model belongs to the store's
    // PRIMARY provider, so it may only be spent on that provider. Without this,
    // a store of `{provider: "anthropic", model: "claude-x"}` would hand
    // `claude-x` to an explicitly requested OpenAI or custom client.
    const credentials = getResolvedCredentials(cfg);
    const storedModel =
      provider === credentials.provider ? credentials.model : null;
    const resolvedModel =
      model?.trim() ||
      storedModel?.trim() ||
      ((provider === "ollama" || provider === "ollama-cloud")
        ? process.env.OLLAMA_MODEL
        : undefined) ||
      DEFAULT_MODELS[provider];
    switch (provider) {
      case "anthropic":
        return createAnthropic({ apiKey: apiKey! })(resolvedModel);
      case "openai":
        return createOpenAI({ apiKey: apiKey! })(resolvedModel);
      case "google":
        return createGoogleGenerativeAI({ apiKey: apiKey! })(resolvedModel);
      case "deepseek":
        return createOpenAI({ apiKey: apiKey!, baseURL: DEEPSEEK_BASE_URL }).chat(
          resolvedModel,
        );
      case "custom": {
        // No `DEFAULT_MODELS.custom` exists on purpose, so an unnamed model here
        // would reach the SDK as `undefined` and fail at the wire with a message
        // about nothing. Both halves are named instead.
        const baseURL = getCustomBaseUrl(cfg);
        if (!baseURL) {
          throw new Error(
            `The Custom provider needs a base URL. Set it in ${LLM_MODELS_POINTER}.`,
          );
        }
        // The gap the pre-switch guard used to swallow (DW-632). It sits
        // BETWEEN the two checks, not before them, because that is the order
        // `getModel` names them in — endpoint, then key, then model — and the
        // two ladders resolving one state have to reach one sentence.
        if (!apiKey) {
          throw new Error(
            `The Custom provider needs an API key. Set it in ${LLM_MODELS_POINTER}.`,
          );
        }
        if (!resolvedModel) {
          throw new Error(
            `The Custom provider needs a model name. Set it in ${LLM_MODELS_POINTER}.`,
          );
        }
        return createOpenAI({ apiKey, baseURL }).chat(resolvedModel);
      }
      case "ollama": {
        // THROUGH THE ACCESSOR (DW-326), which was a raw
        // `process.env.OLLAMA_BASE_URL` read — a third copy of the ladder, and
        // the one place an unchecked endpoint could still reach `createOllama`.
        // It also means a STORED endpoint now applies to a workload-routed
        // `ollama` call, matching what the primary path has always done: this
        // leg used to ignore `cfg.ollamaBaseUrl` entirely, so an owner who set
        // the endpoint in Settings had chat and ingest talk to localhost.
        const baseURL = getOllamaBaseUrl(cfg);
        return createOllama(baseURL ? { baseURL } : {})(resolvedModel);
      }
      case "ollama-cloud":
        return createOllama({
          baseURL: "https://ollama.com/api",
          headers: { Authorization: `Bearer ${apiKey}` },
          compatibility: "strict",
        })(resolvedModel);
    }
  }
  return getModel(cfg);
}

/**
 * Call the configured LLM provider and return the assistant's text response
 * TOGETHER WITH WHY THE MODEL STOPPED (DW-662, DW-666, DW-683).
 *
 * `generateText` reports both, and this file used to destructure `{ text }`
 * alone. A `finishReason` of `"length"` means the model was CUT at
 * `maxOutputTokens`; `"content-filter"` means it was stopped by the provider;
 * `"error"` means it died. All three produce a fragment that reads exactly like
 * a finished answer, and the two doors that commit non-streamed model output —
 * `query()` in `./query` and `synthesizeResearchBrief`'s fallback in
 * `./research-runtime` — were presenting those fragments as whole. This is the
 * same silent truncation DW-547 and DW-663 closed on the streamed paths, which
 * could see the reason because they read `fullStream`.
 *
 * A SIBLING rather than an option on {@link callLLM}. A flag would make the
 * return type conditional on an argument, and every one of the ~19 existing
 * `Promise<string>` callers would then depend on inference staying `string`.
 * Two functions with two return types is additive: {@link callLLM} delegates
 * here, so there is still exactly one `generateText` call for a non-streamed
 * request in this file, and nothing that reads only the text had to change.
 *
 * The empty-text throw lives HERE, not in the delegating wrapper, so both
 * entry points refuse an empty response identically — a caller reading the
 * finish reason must not be handed `{ text: "", finishReason: "stop" }` and
 * left to invent its own rule for it.
 *
 * Retries, the config snapshot and the deadline option are exactly
 * {@link callLLM}'s — this IS that body.
 *
 * @param options.maxOutputTokens — optional cap on output tokens (default 4096).
 * @param options.workload — route this call through Chat's or Ingest's own
 *   provider/model setting instead of the primary one. Omitted, or saved with
 *   no override, resolves exactly as before (DW-711).
 */
export async function callLLMWithFinish(
  systemPrompt: string,
  userMessage: string,
  options?: { maxOutputTokens?: number; workload?: LlmWorkload },
): Promise<{ text: string; finishReason: FinishReason }> {
  // The snapshot is FORWARDED rather than discarded (DW-618): re-entering the
  // resolver would otherwise re-enter the 5 s-TTL cache and could build one
  // client out of two config generations. Empty stays unthreaded — see
  // `configSnapshot`. With no workload this IS `getModel(cfg)`; see
  // {@link resolveConfiguredModel}.
  const cfg = await configSnapshot();
  const model = resolveConfiguredModel({ workload: options?.workload }, cfg);

  const { text, finishReason } = await retryWithBackoff(() =>
    generateText({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxOutputTokens: options?.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS,
      // Constructed inside the thunk — see `llmTimeoutOption`.
      ...llmTimeoutOption(),
    }),
  );

  if (!text) {
    throw new Error("LLM response contained no text");
  }

  return { text, finishReason };
}

/**
 * Call the configured LLM provider and return the assistant's text response.
 *
 * Automatically retries on transient errors (429, 5xx, network issues) with
 * exponential backoff. See {@link retryWithBackoff} for details.
 *
 * Requires at least one supported provider env var to be set:
 * ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
 * OLLAMA_API_KEY, or OLLAMA_BASE_URL / OLLAMA_MODEL.
 *
 * DELEGATES to {@link callLLMWithFinish} and drops the finish reason. Every
 * caller that reaches this name is one for which "the model stopped early" is
 * not a distinction it acts on — an ingest summary, a title, a classification.
 * A caller that DOES commit the text as an answer or a page should call the
 * sibling and branch, which is what `./query` and `./research-runtime` do.
 *
 * @param options.maxOutputTokens — optional cap on output tokens (default 4096).
 * @param options.workload — see {@link callLLMWithFinish} (DW-711).
 */
export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  options?: { maxOutputTokens?: number; workload?: LlmWorkload },
): Promise<string> {
  return (await callLLMWithFinish(systemPrompt, userMessage, options)).text;
}

/**
 * Describe an image using the configured LLM provider's multimodal capability
 * (e.g. DeepSeek V4, GPT-4o, Gemini). Sends the image bytes + a text prompt as
 * a single user message. Throws if the provider/model isn't multimodal or the
 * response is empty — the caller (vision.ts) handles the fallback.
 *
 * NO `workload` OPTION, deliberately (DW-711). Its sibling doors take one; this
 * one stays on the primary route because a vision call needs a MULTIMODAL model
 * and Story 1.9 defines no vision workload. `src/lib/vision.ts` runs inside
 * ingest, so routing it by the ingest setting would spend an owner's
 * text-synthesis choice on an image call and refuse work that runs today.
 *
 * @param mediaType — e.g. "image/jpeg"; helps the provider; inferred if omitted.
 */
export async function callVisionLLM(
  prompt: string,
  image: ArrayBuffer | Uint8Array,
  options?: { maxOutputTokens?: number; mediaType?: string },
): Promise<string> {
  // Forwarded, not discarded — see `callLLM` (DW-618).
  const cfg = await configSnapshot();
  const model = getModel(cfg);
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);

  const { text } = await retryWithBackoff(() =>
    generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: bytes, mediaType: options?.mediaType },
          ],
        },
      ],
      maxOutputTokens: options?.maxOutputTokens ?? 512,
      // Constructed inside the thunk — see `llmTimeoutOption`.
      ...llmTimeoutOption(),
    }),
  );

  if (!text) {
    throw new Error("Vision LLM response contained no text");
  }
  return text;
}

/**
 * Call the configured LLM provider and return a streaming result.
 *
 * Returns a `StreamTextResult` from the Vercel AI SDK. Use
 * `.toTextStreamResponse()` to convert it into a standard `Response` for
 * HTTP streaming, or await `.text` to collect the full response.
 *
 * Requires at least one supported provider env var to be set (same as
 * {@link callLLM}).
 *
 * **Why no retry wrapper:** Unlike `generateText()` which is fully async and
 * throws on connection failure, `streamText()` returns synchronously — the
 * actual network call happens lazily when the stream is consumed. Wrapping
 * `streamText()` in `retryWithBackoff` would not catch transient connection
 * errors (429, 503, ECONNRESET, etc.) because `streamText()` itself never
 * throws; those errors only surface when reading from the returned stream.
 * Mid-stream retry would require buffering emitted tokens and reconnecting
 * the client, which is significantly more complex. The Vercel AI SDK's own
 * `maxRetries` setting (passed through `CallSettings`) handles provider-level
 * retries internally for the underlying `doStream()` call.
 *
 * **The single whole-stream deadline is FROZEN** (2026-08-21 decision, DW-64).
 * One `abortSignal` covers the entire stream, and that is the shape that was
 * chosen, not an oversight to be fixed here: a per-token deadline or a retry
 * wrapper would both be the mid-stream reconnection the paragraph above rules
 * out. What DW-64 changed is the SENTENCE, not the mechanism — when this
 * deadline fires the AI SDK closes the stream with an `{ type: "abort" }` part
 * rather than throwing, so a caller reading `textStream` sees a truncated
 * half-answer that looks finished. The owner-facing copy and the abort
 * predicates live in `src/lib/llm-deadline.ts`.
 *
 * BOTH callers map them now (DW-544). `src/app/api/query/stream/route.ts` and
 * `synthesizeResearchBrief` (`src/lib/research-runtime.ts`) each read
 * `fullStream`, which is the only place the abort is visible, so neither one
 * can end an answer early in silence. What they DO about it differs, and
 * deliberately: the route closes the body with a notice, while research fails
 * the run outright rather than committing a truncated brief as a finished wiki
 * page. Any future caller of this function has the same obligation — reading
 * `textStream` swallows the abort, and a half answer then reads as a whole one.
 *
 * NO PRODUCTION CALLER PASSES `workload` HERE YET. The option exists so the
 * three generation doors stay symmetric: a workload owner that later needs a
 * streamed answer must not have to choose between streaming and its own
 * provider, and a door that silently ignored `workload` would be worse than one
 * that never offered it. `settings-runtime-wiring.test.ts` pins it, because a
 * regression in the one line that resolves it is otherwise invisible.
 *
 * @param options.maxOutputTokens — optional cap on output tokens (default 4096).
 * @param options.workload — see {@link callLLMWithFinish} (DW-711).
 */
export async function callLLMStream(
  systemPrompt: string,
  userMessage: string,
  options?: { maxOutputTokens?: number; workload?: LlmWorkload },
) {
  // Forwarded, not discarded — see `callLLM` (DW-618).
  const cfg = await configSnapshot();
  const model = resolveConfiguredModel({ workload: options?.workload }, cfg);

  return streamText({
    model,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxOutputTokens: options?.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS,
    // One deadline for the whole stream: there is no retry thunk here (see the
    // docblock above), so nothing would give a second attempt a fresh one.
    ...llmTimeoutOption(),
  });
}
