import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { EmbeddingModel } from "ai";
import type { Ai } from "./storage/cloudflare-types";
import { listWikiPages, readWikiPage } from "./wiki";
import { getStorage } from "./storage";
import {
  loadConfigSync,
  getEmbeddingModelOverride,
  getOllamaBaseUrl,
  envOllamaBaseUrl,
  getVectorSearchSettings,
} from "./config";
import {
  EMBEDDING_PROVIDERS,
  WORKERS_AI_EMBEDDING_DIMENSIONS,
  embeddingModelMatchesProvider,
  isEmbeddingProvider,
  type EmbeddingProvider,
} from "./providers";
import { withFileLock } from "./lock";
import { MAX_EMBED_CHARS } from "./constants";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Embedding provider detection
// ---------------------------------------------------------------------------

/**
 * Misconfiguration identities this process has already spoken about.
 *
 * The five warnings below describe *standing* misconfiguration — a stale
 * `EMBEDDING_MODEL`, an override that cannot embed, an unbound `AI` binding, a
 * corpus embedded with a model this deployment no longer uses, and an `ollama`
 * selection with no endpoint behind it (DW-401).
 * Every embed door re-enters the resolvers (`getEmbeddingModelName`,
 * `getEmbeddingModel`, `embedText`, `embedTexts`, `runWorkersAiEmbedding`), and
 * `getWorkersAiBinding` is reached from several seams, not one: `GET`/`PUT
 * /api/settings` call it once per request (DW-278), `vision.ts` calls it per
 * vision request, and `resolveEmbeddingProvider`'s Workers AI auto-detect calls
 * it from every embed door in turn. Unthrottled, a single `logger.warn`
 * therefore repeats the same sentence per page of a rebuild and per request
 * served (DW-273) — noise that buries the one line an operator needs to read.
 *
 * The state is module-level on purpose: one process (one Workers isolate) is
 * exactly the lifetime over which "you have this misconfigured" is one piece
 * of news. Keys carry the misconfiguration's *identity*, not its call site, so
 * a CHANGED misconfiguration is a new key and speaks again — the guard
 * suppresses repetition, never information.
 *
 * The trade-off that buys, stated plainly and scoped: for THREE of the five
 * identities — the stale `EMBEDDING_MODEL`, the unservable override, the
 * unbound `AI` binding — one that is fixed and then re-introduced with the
 * IDENTICAL value stays silent for the rest of the process. Nothing clears
 * those three keys, deliberately: each is env/binding state that a restart (or
 * a new isolate) already fixes, so carrying "resolved" state through every
 * resolution for them would be dead weight.
 *
 * TWO keys re-arm, and both for the same reason: the state behind them is
 * fixable IN-process, so "it is still broken" has to be askable again.
 *
 *   - `drift:<active model>` (DW-332). Drift is cleared by `rebuildVectorStore`
 *     with no restart involved — and `searchByVector` already computes the
 *     closest signal a per-QUERY door has that a rebuild has landed: a
 *     WHOLE-WINDOW model match that POSITIVELY holds an active-model-labelled
 *     vector — `kept.length === matches.length && kept.some((m) =>
 *     m.metadata.model === currentModel)`, in the same branch chain that
 *     decides whether to warn — so it re-arms that key there through
 *     `rearmWarningAbout`. Without it, a corpus that drifts, is rebuilt, and
 *     drifts again under the SAME active model would be silent for the rest of
 *     the process.
 *
 *     This is the CANONICAL statement of the gate; the re-arm branch points
 *     here rather than restating it. The gate read `kept.length > 0`
 *     (2026-08-21) and was narrowed twice by decisions dated 2026-08-22 (both
 *     narrowings landed 2026-08-29). First DW-404 added the whole-window half:
 *     `rebuildVectorStore` upserts page by page with no bulk swap, so a
 *     half-finished rebuild leaves stale and current vectors in the same
 *     window, and ONE kept match among them re-armed the key on the very
 *     condition the re-arm exists to detect the END of. What that buys is
 *     exactly this and only this: a window the filter demonstrably DROPPED
 *     something from stops counting as evidence a rebuild landed. Then DW-405
 *     added the positive-proof half, because whole-window is not evidence on
 *     its own: `modelMatches` deliberately KEEPS unlabelled legacy vectors (for
 *     RESULTS — dropping them would empty the corpus after a first deploy), so
 *     a window carried entirely by unlabelled vectors matched WHOLLY and
 *     re-armed the key on a corpus where every labelled vector was still stale.
 *     Requiring one kept vector tagged with the ACTIVE model closes that. The
 *     conjunct also subsumes DW-404's non-empty requirement, since `some` is
 *     false on an empty array; the separate `matches.length > 0` was dropped as
 *     redundant. A window holding one active-model vector BESIDE an unlabelled
 *     one still re-arms, deliberately: a legacy vector riding along with a
 *     genuinely rebuilt one is not evidence the rebuild failed.
 *
 *     The signal is still narrower than "the corpus is healthy", and the
 *     remaining gaps are LIVE, not hypothetical. `queryEmbeddings` sorts and
 *     slices to topK BEFORE the filter, so a window too small to SEE the stale
 *     vectors is a whole-window match and re-arms anyway (DW-598, open) —
 *     DW-404's own reproduction uses `topK: 1` and still oscillates under this
 *     gate exactly as it did under the old one, so neither narrowing closes
 *     that reproduction. And both narrowings cost something in the OTHER
 *     direction. `rebuildVectorStore` never DELETES, and it skips pages with
 *     empty content or a failed embed, so a stale ORPHAN vector — a deleted,
 *     renamed, or emptied page — leaves every window that contains it
 *     permanently mixed (DW-599, open); past that point this key can never
 *     re-arm for that model again, and a second genuine drift ships silent for
 *     the rest of the process. The proof conjunct has the mirror-image cost: a
 *     corpus whose vectors are ALL unlabelled can never re-arm either, so if
 *     such a corpus ever burns this key it stays burnt. That is harmless in the
 *     normal case — an all-unlabelled corpus keeps every match, so the warn
 *     branch never fires and the key is never burnt in the first place — but
 *     permanent if the key was burnt before the labels went missing.
 *
 *     What is NOT a case here: a null active model. `currentModel` is typed
 *     `string | null`, but past `searchByVector`'s `if (!queryEmbedding)`
 *     guard it cannot BE null — `embedText` and `getEmbeddingModelName` read
 *     the same `cfg` snapshot and both refuse only on a missing provider
 *     (`resolveEmbeddingModelName` returns `string`, never null), so a null
 *     model has already returned `[]` before this branch chain runs. Neither
 *     branch needs a null case; do not add one.
 *   - `ollama-endpoint:sdk-default` (DW-401). The endpoint ladder's STORE leg
 *     (`cfg.ollamaBaseUrl`) is moved by a save, so an owner who reads the line
 *     and fixes the endpoint changes the answer without restarting anything —
 *     and the evidence is read from the ladder itself, in {@link selectOllama}:
 *     `getOllamaBaseUrl(cfg)` answering a URL IS the fix having landed. Without
 *     the re-arm, an endpoint that is fixed and then broken again — the
 *     variable unset, the stored value replaced with a refused one — would fall
 *     back to the SDK default in silence for the rest of the process.
 *
 * The key is deliberately FIXED rather than carrying the endpoint that would
 * have been used: there is no such value. The misconfiguration's identity is
 * "this process is embedding against the SDK's own localhost default because
 * nothing else resolved", which is one fact however many rungs reach it.
 *
 * ONE warning in this module is left UNGUARDED on purpose and should stay that
 * way: `runWorkersAiEmbedding`'s unexpected-response-shape line. That line
 * reports a per-CALL event — *this* response did not carry a data array — and
 * the next call may well succeed, so throttling it would hide real failures
 * rather than repetition.
 *
 * `searchByVector`'s model-drift breadcrumb used to be listed beside it and no
 * longer is (DW-310). "Every stored vector was embedded with a model this
 * deployment no longer uses" is not an event: it is standing state that holds
 * until the corpus is rebuilt, and the door it was logged from is a per-QUERY
 * one, so a drifted corpus emitted the same sentence for every search anyone
 * ran. It belongs with the other three, keyed on the drifted identity — the
 * ACTIVE MODEL name. That is also why its sentence had to stop naming the
 * per-query match count: the count is a property of the query, not of the
 * misconfiguration, and keying on it would have re-armed the warning for every
 * distinct number of hits.
 */
const warnedMisconfigurations = new Set<string>();

/** Emit `message` the first time `key` is seen; later repeats are silent. */
function warnOnceAbout(key: string, message: string): void {
  if (warnedMisconfigurations.has(key)) return;
  warnedMisconfigurations.add(key);
  logger.warn("embeddings", message);
}

/**
 * Forget `key` so the NEXT occurrence of this identity speaks again.
 *
 * The counterpart to `warnOnceAbout`, for the misconfigurations a caller can
 * see EVIDENCE of ending from inside the process: embedding-model drift,
 * cleared by a corpus rebuild (DW-332) — see the re-arm branch in
 * `searchByVector` for how strong that evidence is and is not — and an Ollama
 * endpoint that starts resolving again after a save (DW-401), re-armed in
 * {@link selectOllama} off the ladder's own answer. Deleting a key
 * that was never set is a silent no-op, so a caller can re-arm unconditionally
 * on its success path without first asking whether it ever warned. Named rather
 * than an inline `.delete` at the call site so the Set keeps exactly two
 * mutators plus the test-only reset, all greppable from here.
 */
function rearmWarningAbout(key: string): void {
  warnedMisconfigurations.delete(key);
}

/**
 * Forget every recorded misconfiguration so the next occurrence warns again.
 *
 * Mirrors `_resetStorage`/`_resetLocks`/`_resetConfigCache`: without it the
 * first test to assert a warning would silence it for every test after. There
 * is no central reset registry in `vitest.setup.ts`, so it is wired into the
 * `beforeEach` of each suite that asserts these warnings — a suite that asserts
 * one without calling it is order-dependent.
 * @internal
 */
export function _resetEmbeddingWarnings(): void {
  warnedMisconfigurations.clear();
}

/**
 * Default embedding models per provider. Can be overridden with the
 * `EMBEDDING_MODEL` env var.
 */
const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
  ollama: "nomic-embed-text",
  // Workers AI BGE-M3: multilingual (strong CJK/Chinese), 1024-dim.
  "workers-ai": "@cf/baai/bge-m3",
};

/**
 * Fixed output widths for Workers AI embedding models supported here.
 *
 * A RE-EXPORT, not a copy: the table lives in `providers.ts` so the client-safe
 * vector gate can test membership against the same object the dimension check
 * below reads. Existing importers of this name are unaffected.
 */
export { WORKERS_AI_EMBEDDING_DIMENSIONS };

/**
 * Return the Cloudflare Workers AI binding if available, else null.
 *
 * `getCloudflareContext()` throws when called outside the Workers request
 * scope (local CLI, Node tests) — that case is expected and stays silent. But
 * being on the Workers runtime with the `AI` binding *unbound* is a
 * misconfiguration, not "no embeddings", so we surface it with a warning
 * rather than silently degrading to BM25-only search.
 */
export function getWorkersAiBinding(): Ai | null {
  let env: { AI?: Ai };
  try {
    ({ env } = getCloudflareContext() as { env: { AI?: Ai } });
  } catch {
    // Expected off the Workers runtime — silent by design.
    return null;
  }
  if (!env.AI) {
    // One fixed key: there is only one way for the binding to be missing, and
    // the off-Workers `catch` above returns before reaching here, so a silent
    // local run never consumes it — a later real Workers miss can still speak.
    warnOnceAbout(
      "binding:workers-ai",
      "On the Workers runtime but the AI binding is not bound — embeddings " +
        "will fall back to the LLM provider or be disabled. Check the `ai` " +
        "binding in wrangler.jsonc.",
    );
    return null;
  }
  return env.AI;
}

/**
 * Resolve which provider to use for embeddings — independent of the LLM
 * provider, so generation can run on a provider with no embedding models
 * (e.g. deepseek) while embeddings run on Workers AI.
 *
 * Priority:
 *   1. Explicit override — `EMBEDDING_PROVIDER` env var, then
 *      `config.embeddingProvider`. An override that isn't embedding-capable
 *      is rejected (returns null) and warned about — it does NOT fall through.
 *   2. Workers AI auto-detect — on the CF runtime with the `AI` binding bound.
 *   3. The LLM provider detected from env vars, if embedding-capable; otherwise
 *      `config.provider` only when it is `ollama` (the one keyless provider —
 *      other config providers need an env-var API key, handled by step 3a).
 */
function resolveEmbeddingProvider(
  cfg: ReturnType<typeof loadConfigSync>,
): EmbeddingProvider | null {
  // BOTH legs read through `nonEmpty` (DW-333) — the same trim-and-null, in the
  // same env-over-store order, that `getVectorSearchSettings` applies to this
  // very pair. WHICH value wins is unchanged whenever `EMBEDDING_PROVIDER` is
  // really set: the environment still takes precedence over the store, and a
  // padded ` openai ` resolves to the provider the gate already reads it as.
  // What changes is blank. A whitespace-only `EMBEDDING_PROVIDER=" "` used to
  // be TRUTHY here, so it shadowed a perfectly good stored selection and was
  // then refused in a sentence quoting the blank — an instruction about a value
  // the owner cannot see. Blank is now "unset": the store wins, and with
  // nothing stored resolution falls through to auto-detect exactly as an absent
  // variable does. The env read stays lifted into a local so the refusal can
  // still say where the value it is refusing came from (DW-311).
  const envOverride = nonEmpty(process.env.EMBEDDING_PROVIDER);
  const override = envOverride ?? nonEmpty(cfg.embeddingProvider);
  if (override !== null) {
    // Inside this branch `override` is non-null, so it came from the
    // environment exactly when `envOverride` is: `??` falls through on `null`
    // only, and a blank variable is `null` here and never gets in.
    const source: "env" | "stored" = envOverride !== null ? "env" : "stored";
    if (!isEmbeddingProvider(override)) {
      // Keyed on the SOURCE and the rejected string: swapping one bad override
      // for another bad one is a different misconfiguration, and so is the same
      // bad string arriving from the other feeder — the two have different
      // remedies, so letting whichever came first silence the other would leave
      // an owner reading an instruction they cannot follow (DW-311).
      warnOnceAbout(
        `provider-override:${source}:${override}`,
        source === "env"
          ? `EMBEDDING_PROVIDER="${override}" is not embedding-capable ` +
              `(valid: ${EMBEDDING_PROVIDERS.join(", ")}); embeddings are disabled. ` +
              "Fix the override or unset it to auto-detect."
          : `The embedding provider saved in Settings, "${override}", is not ` +
              `embedding-capable (valid: ${EMBEDDING_PROVIDERS.join(", ")}); ` +
              "embeddings are disabled. Choose a supported embedding provider " +
              "in Settings.",
      );
      return null;
    }
    if (override === "workers-ai") {
      return getWorkersAiBinding() ? override : null;
    }
    if (override === "ollama") return selectOllama(cfg);
    return embeddingApiKeyFor(override, cfg) ? override : null;
  }

  // Auto-select Workers AI when its binding is available.
  if (getWorkersAiBinding()) return "workers-ai";

  // Prefer the owner's saved generation provider when it can also embed.
  if (cfg.provider && isEmbeddingProvider(cfg.provider)) {
    if (cfg.provider === "ollama") return selectOllama(cfg);
    if (embeddingApiKeyFor(cfg.provider, cfg)) return cfg.provider;
  }

  // Otherwise use any available embedding-capable credential. Do not reuse
  // generation-provider auto-detection here because an Anthropic key can be
  // first while a valid OpenAI or Google embedding key also exists.
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  // The same "usable, not merely present" rule `detectEnvProvider` applies
  // (DW-370), through the same function — this was the second copy of the bare
  // presence test, and a refused `OLLAMA_BASE_URL` selecting `ollama` here
  // embedded a whole corpus against an endpoint the owner never named.
  // `OLLAMA_MODEL` remains an independent, usable signal.
  if (envOllamaBaseUrl() !== undefined || nonEmpty(process.env.OLLAMA_MODEL) !== null) {
    return selectOllama(cfg);
  }

  return null;
}

/**
 * The endpoint `createOllama()` uses when it is handed no `baseURL` at all.
 *
 * Copied from the SDK rather than imported because it is not exported
 * (`ollama-ai-provider-v2`, `createOllama`'s `baseURL` default). It is named
 * here for ONE purpose — saying out loud, in {@link selectOllama}, where the
 * embeddings actually went — and nothing resolves against it: the fall-through
 * in {@link _createEmbeddingModel} is still `createOllama()` with no argument,
 * so a future change to the SDK's default changes the behaviour and this
 * constant only mis-names it in a log line.
 */
const OLLAMA_SDK_DEFAULT_BASE_URL = "http://127.0.0.1:11434/api";

/**
 * Return `ollama`, and say so when there is no endpoint behind it (DW-401).
 *
 * DW-370 taught the auto-detect rung that a REFUSED `OLLAMA_BASE_URL` must not
 * select `ollama` — but that only covers the rung that reads the variable to
 * decide. An EXPLICIT selection (`EMBEDDING_PROVIDER=ollama`, or the stored
 * `embeddingProvider`, or a stored generation provider of `ollama`) does not
 * consult the endpoint at all, so a deployment with no `OLLAMA_BASE_URL` and no
 * saved endpoint resolved `ollama`, reached `createOllama()` with no `baseURL`,
 * and embedded its whole corpus against the SDK's own localhost default —
 * silently, and successfully, if something happened to be listening there.
 *
 * LOG-ONLY, deliberately: the return value is `"ollama"` on every path, exactly
 * as each rung returned before. The endpoint ladder's fall-through is a real
 * resolution and stays one — this makes it AUDIBLE, it does not move it, and it
 * does not hand `createOllama` a URL the ladder refused.
 *
 * ONE helper rather than a check at each rung, because all three rungs reach
 * the same place: the auto-detect tail can get here on `OLLAMA_MODEL` alone,
 * beside an `OLLAMA_BASE_URL` the ladder threw away. Warning on two of the
 * three would be an asymmetry with no rule behind it.
 *
 * The key re-arms off the ladder's own answer — see the census above for why
 * this identity is one of the two that may, and what the evidence is.
 */
function selectOllama(cfg: ReturnType<typeof loadConfigSync>): "ollama" {
  const key = "ollama-endpoint:sdk-default";
  if (getOllamaBaseUrl(cfg) === undefined) {
    warnOnceAbout(
      key,
      "Ollama is the selected embedding provider, but no endpoint resolved " +
        "(OLLAMA_BASE_URL and the saved Ollama endpoint are both unset or were " +
        `refused), so embeddings are going to the SDK's own default, ` +
        `${OLLAMA_SDK_DEFAULT_BASE_URL}. Set OLLAMA_BASE_URL, or save an ` +
        "endpoint in Settings, if that is not where Ollama is listening.",
    );
  } else {
    // The endpoint resolves again — a save can do that mid-process — so the
    // next time it does not, this is news once more.
    rearmWarningAbout(key);
  }
  return "ollama";
}

/**
 * Resolve the API key for an embedding provider.
 *
 * Its own env var first, then the key the owner stored through Settings (Story
 * 1.9). Env still wins, so a deployment that already carries the secret keeps
 * it out of the config JSON — and with nothing stored every branch resolves
 * exactly as it did before, which is what keeps `hasEmbeddingSupport()`'s
 * current answers (and `embeddings.test.ts`) untouched.
 *
 * Without this fallback, "vector search needs an endpoint, a model and a key"
 * would store three values that no code path could ever use.
 *
 * Every leg goes through {@link nonEmpty} rather than `??`, because a
 * set-but-empty `OPENAI_API_KEY=` line short-circuits `??` to `""` and masks the
 * key the owner just stored. `config.ts`'s vector gate reads the same two env
 * vars through its own trim-and-null, so `??` here would also make the switch
 * report itself on while every embedding call resolved nothing.
 *
 * `cfg` is REQUIRED and comes from the caller rather than from
 * `loadConfigSync()` here (DW-313). All three call sites already hold a
 * snapshot, and re-entering the 5 s-TTL cache from inside a resolution meant
 * one answer could be assembled from two different snapshots — the cache can
 * expire between the caller's read and this one, which on a cold cache means
 * the key is looked for in `{}` while the provider was chosen from a real
 * config. One resolution, one snapshot.
 */
function embeddingApiKeyFor(
  provider: EmbeddingProvider,
  cfg: ReturnType<typeof loadConfigSync>,
): string | null {
  // The stored credential is ONE flat field read by both vendor branches below,
  // and it is bounded the same way the endpoint is (DW-69/DW-72): both save
  // paths delete it whenever the STORED `embeddingProvider` moves, so for a
  // vendor chosen through Settings what is read here was entered for that
  // vendor. Without that clear this line would hand `sk-…` to Google on the
  // strength of the owner having once configured OpenAI.
  //
  // The SAME two exceptions the endpoint's note above spells out apply here:
  // `EMBEDDING_PROVIDER` overrides the stored selection, and an absent stored
  // selection falls back to the detected generation provider — neither of which
  // any save moves, so on those paths a stored key can still be offered to a
  // vendor it was not entered for. Deferred follow-up, not a claim this
  // function makes.
  const stored = nonEmpty(cfg.embeddingApiKey);
  switch (provider) {
    case "openai":
      return nonEmpty(process.env.OPENAI_API_KEY) ?? stored;
    case "google":
      return nonEmpty(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ?? stored;
    default:
      return null; // ollama and workers-ai are keyless
  }
}

/** Trim-and-null: `""` and whitespace are "unset", not "set to nothing". */
function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the embedding model name for a provider.
 *
 * Priority: `EMBEDDING_MODEL` env → `config.embeddingModel` → provider default.
 *
 * The override is only honored when {@link embeddingModelMatchesProvider} says
 * the resolved provider can actually serve it — Workers AI ids must be in the
 * supported catalog, the AI-SDK providers' ids must sit outside `@cf/`. This
 * prevents a stale override left over from a previous provider (e.g.
 * `EMBEDDING_MODEL=text-embedding-3-small`) from leaking into a Workers AI
 * call (or vice versa) and producing an invalid model id.
 *
 * Both legs are read through {@link nonEmpty}, the SAME trim-and-null (and the
 * same env-over-config ordering) `getVectorSearchSettings` applies (DW-221,
 * DW-227). Without it a stored `" @cf/baai/bge-m3"` satisfied the gate — which
 * reads it trimmed — and was then dropped here for the provider default,
 * because the raw string with its leading space is not a catalog id; and a
 * whitespace-only `EMBEDDING_MODEL` read as absent to the gate while being
 * truthy enough to be sent to the provider verbatim as a model name.
 */
function resolveEmbeddingModelName(
  provider: EmbeddingProvider,
  cfg: ReturnType<typeof loadConfigSync>,
): string {
  const fallback = DEFAULT_EMBEDDING_MODELS[provider] ?? provider;
  const override =
    nonEmpty(getEmbeddingModelOverride()) ?? nonEmpty(cfg.embeddingModel);
  if (!override) return fallback;
  if (embeddingModelMatchesProvider(provider, override)) return override;

  // Mismatch — ignore the override and use the provider default, AUDIBLY.
  //
  // The settings gate refuses this combination (DW-73) on BOTH write paths now
  // — since DW-217 the legacy flat `PUT /api/settings` branch runs the same
  // rule over its post-merge config, so a flat save can no longer smuggle a
  // mismatch past it. But the gate is not the only way a value reaches here:
  // an `EMBEDDING_MODEL` env override bypasses the store entirely, and a
  // deployment with vector search OFF is never gated at all (the rule only
  // runs when the merged flag is on). So the fallback is not dead code for
  // stray bytes — it is the live behaviour on the paths the gate does not
  // cover, and it stays.
  //
  // What changes is that it stops being SILENT (DW-224, DW-226). Every embed
  // door (`getEmbeddingModelName`, `getEmbeddingModel`, `embedText`,
  // `embedTexts`, `runWorkersAiEmbedding`) routes through here, so this one
  // warning is what makes the substitution visible on the embed path itself —
  // mirroring the warning `resolveEmbeddingProvider` already emits when it
  // refuses an override. The log is not behaviour: the default is still
  // returned, exactly as before.
  //
  // Said ONCE per distinct `(provider, override)` pair (DW-273), because every
  // one of those doors would otherwise repeat it — a rebuild over N pages
  // logged it ~2N times. `fallback` is a pure function of `provider`, so it
  // adds nothing to the key.
  warnOnceAbout(
    `model:${provider}:${override}`,
    `Embedding model "${override}" cannot be served by the "${provider}" ` +
      `embedding provider; embedding with "${fallback}" instead. ` +
      "Vectors are tagged with the model that produced them, so a corpus " +
      "already embedded with a different model needs rebuilding.",
  );
  return fallback;
}

/**
 * Returns the name of the currently selected embedding model, or null if no
 * embedding-capable provider is configured.
 *
 * Provider is resolved by {@link resolveEmbeddingProvider} (override →
 * Workers AI auto-detect → LLM provider). Model name resolution:
 *   1. `EMBEDDING_MODEL` env var (highest priority)
 *   2. `config.embeddingModel` from config file
 *   3. Provider-specific default
 *
 * @param cfg OPTIONAL, and defaulting to `loadConfigSync()` — which is what
 *   every caller outside the two settings resolvers wants, so passing nothing
 *   is byte-identical to the behaviour before the parameter existed. What
 *   passing one buys is "resolve against THIS snapshot": `loadConfigSync()` is
 *   a 5 s-TTL cache, so a caller that already read it and then asks this door
 *   for the other half of its answer can otherwise be told about a different
 *   snapshot than the one it is describing (DW-313). `getEffectiveSettings`
 *   and `getWorkbenchSettings` both hold a `cfg` and both pass it, which is how
 *   their "what is set" and "what is in effect" halves are guaranteed to be
 *   about the same config.
 */
export function getEmbeddingModelName(
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): string | null {
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) return null;
  return resolveEmbeddingModelName(provider, cfg);
}

/**
 * Returns an AI SDK embedding model for the resolved embedding provider, or
 * `null` if the provider doesn't support embeddings or is Workers AI (which
 * is called via the binding, not the AI SDK).
 *
 * Provider is resolved by {@link resolveEmbeddingProvider}; the API key comes
 * from {@link embeddingApiKeyFor} (the embedding provider's own env var, so it
 * works even when the LLM provider differs).
 *
 * @param cfg OPTIONAL, defaulting to `loadConfigSync()` — the same door
 *   {@link getEmbeddingModelName} carries, and for the same reason (DW-313).
 *   `embedText`/`embedTexts` pass the snapshot they already resolved their
 *   provider from, so the model that gets CONSTRUCTED cannot be built from a
 *   later read of the 5 s-TTL cache than the one that chose the provider.
 */
export function getEmbeddingModel(
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): EmbeddingModel | null {
  const provider = resolveEmbeddingProvider(cfg);

  // Workers AI is not an AI SDK provider — it is called via the binding in
  // {@link embedText}/{@link embedTexts}, so there is no EmbeddingModel here.
  if (!provider || provider === "workers-ai") return null;

  const modelName = resolveEmbeddingModelName(provider, cfg);
  return _createEmbeddingModel(provider, embeddingApiKeyFor(provider, cfg), modelName, cfg);
}

/**
 * Internal helper to construct an AI SDK embedding model instance.
 *
 * Ollama base URL is resolved via `getOllamaBaseUrl(cfg)` from the config layer.
 * OpenAI and Google honour a stored `embeddingBaseUrl` (Story 1.9's "endpoint"
 * half of the vector gate) — additive, so with nothing stored the option is
 * omitted entirely and both providers resolve to their own defaults exactly as
 * before.
 *
 * `cfg` is REQUIRED and comes from the caller for the same reason
 * {@link embeddingApiKeyFor}'s does (DW-313): the endpoint has to be read out of
 * the snapshot the provider and the key were resolved from, not out of whatever
 * the cache answers by the time construction happens.
 */
function _createEmbeddingModel(
  provider: string,
  apiKey: string | null,
  modelName: string,
  cfg: ReturnType<typeof loadConfigSync>,
): EmbeddingModel | null {
  // ONE flat `embeddingBaseUrl` serving whichever vendor is selected, which is
  // narrower than it looks (DW-69/DW-72): both SAVE PATHS clear
  // `embeddingBaseUrl` and `embeddingApiKey` whenever the STORED
  // `embeddingProvider` moves — `applyWorkbenchSettings` and the flat branch of
  // `PUT /api/settings`, both through `embeddingProviderChanged`. So for a
  // provider that was CHOSEN through Settings, the endpoint read here was typed
  // after that vendor was selected. The fix is deliberately not here:
  // per-provider keying would change the stored shape and need a migration,
  // which the recorded decisions rule out.
  //
  // TWO PATHS SIT OUTSIDE THAT GUARANTEE, and this comment must not be read as
  // covering them:
  //
  //   - `EMBEDDING_PROVIDER` wins over the stored field in
  //     `resolveEmbeddingProvider`, and no save can move an environment
  //     variable — so setting it can point a stored endpoint at a vendor it was
  //     never entered for.
  //   - with no provider stored and no override set, the same resolver falls
  //     back to the detected LLM provider (and to `cfg.provider` for `ollama`),
  //     which the embedding-provider select never touched.
  //
  // A config written before this change, or hand-edited, can also already hold
  // a mismatched pair — nothing migrates it. Both are recorded as deferred
  // follow-up rather than fixed here.
  const stored = cfg.embeddingBaseUrl;
  const baseUrlOption =
    typeof stored === "string" && stored.trim().length > 0
      ? { baseURL: stored.trim() }
      : {};
  switch (provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey: apiKey!, ...baseUrlOption });
      return openai.embedding(modelName);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: apiKey!, ...baseUrlOption });
      return google.embedding(modelName);
    }
    case "ollama": {
      // Resolve Ollama base URL via centralized config layer, against the SAME
      // `cfg` snapshot `embeddingBaseUrl` above is resolved from (DW-313). With
      // no argument this half answered from the 5 s cache while the other half
      // answered from the object passed in, so one function could resolve two
      // different configs — which is exactly what the accessor's parameter
      // exists to rule out.
      // The fall-through to the SDK's own default is deliberate and unchanged
      // (DW-401): a value the ladder REFUSED must not be handed to
      // `createOllama` just because something was typed. What changed is that
      // `selectOllama` has already said out loud, once, that this is where the
      // call is about to go.
      const baseURL = getOllamaBaseUrl(cfg);
      const ollama = baseURL ? createOllama({ baseURL }) : createOllama();
      return ollama.embedding(modelName);
    }
    default:
      return null;
  }
}

/**
 * Returns true if an embedding-capable provider is configured.
 *
 * @param cfg OPTIONAL, defaulting to `loadConfigSync()`, and threaded straight
 *   through to {@link getEmbeddingModelName} — see the note there. Passing the
 *   snapshot a caller already holds is what stops "does this deployment embed?"
 *   and "with what?" from being answered about two different reads of the
 *   5 s-TTL config cache (DW-313).
 */
export function hasEmbeddingSupport(
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): boolean {
  return getEmbeddingModelName(cfg) !== null;
}

// ---------------------------------------------------------------------------
// Embed helpers
// ---------------------------------------------------------------------------

/**
 * Embed a single text string. Returns null if no embedding provider is
 * configured.
 *
 * Long texts are truncated to {@link MAX_EMBED_CHARS} before being sent to
 * the model to stay within provider token limits.
 *
 * @param cfg OPTIONAL, defaulting to `loadConfigSync()`. Passing one lets a
 *   caller that must later ASK which model did the embedding — `searchByVector`
 *   is the one — resolve both halves from the same snapshot (DW-313).
 */
export async function embedText(
  text: string,
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): Promise<number[] | null> {
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) return null;

  const truncated = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;

  if (provider === "workers-ai") {
    const vectors = await runWorkersAiEmbedding([truncated], cfg);
    return vectors?.[0] ?? null;
  }

  const model = getEmbeddingModel(cfg);
  if (!model) return null;
  const result = await embed({ model, value: truncated });
  return result.embedding;
}

/**
 * Batch-embed multiple text strings. Returns null if no embedding provider is
 * configured.
 *
 * Each text is truncated to {@link MAX_EMBED_CHARS} before being sent to the
 * model.
 *
 * @param cfg OPTIONAL, defaulting to `loadConfigSync()` — the same door
 *   {@link embedText} carries, kept here for symmetry: the two are one function
 *   in two arities, and a caller that can pin the snapshot for one should not
 *   have to know which of them it happens to be calling.
 */
export async function embedTexts(
  texts: string[],
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): Promise<number[][] | null> {
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) return null;

  const truncated = texts.map((t) =>
    t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t,
  );

  if (provider === "workers-ai") {
    return runWorkersAiEmbedding(truncated, cfg);
  }

  const model = getEmbeddingModel(cfg);
  if (!model) return null;
  const result = await embedMany({ model, values: truncated });
  return result.embeddings;
}

/**
 * Embed one or more texts via the Cloudflare Workers AI binding
 * (e.g. `@cf/baai/bge-m3`). Returns null if the binding is unavailable or the
 * response shape is unexpected.
 */
async function runWorkersAiEmbedding(
  texts: string[],
  cfg: ReturnType<typeof loadConfigSync>,
): Promise<number[][] | null> {
  const ai = getWorkersAiBinding();
  if (!ai) return null;

  const model = resolveEmbeddingModelName("workers-ai", cfg);
  // `pooling: "cls"` — Cloudflare recommends CLS pooling for bge-m3; the
  // default ("mean") produces lower-quality embeddings.
  const result = await ai.run(model, { text: texts, pooling: "cls" });
  if (!Array.isArray(result?.data)) {
    logger.warn(
      "embeddings",
      `Workers AI embedding (${model}) returned an unexpected response ` +
        "shape (no data array) — treating as no embedding:",
      result,
    );
    return null;
  }

  if (result.data.length !== texts.length) {
    throw new Error(
      `Workers AI embedding (${model}) returned ${result.data.length} vectors ` +
        `for ${texts.length} inputs.`,
    );
  }

  const dimensions = result.data[0]?.length ?? 0;
  if (
    dimensions === 0 ||
    result.data.some(
      (vector) => !Array.isArray(vector) || vector.length !== dimensions,
    )
  ) {
    throw new Error(
      `Workers AI embedding (${model}) returned empty or inconsistent vectors.`,
    );
  }

  const expectedDimensions = WORKERS_AI_EMBEDDING_DIMENSIONS[model];
  if (expectedDimensions && dimensions !== expectedDimensions) {
    throw new Error(
      `Workers AI embedding dimension mismatch for ${model}: ` +
        `expected ${expectedDimensions}, received ${dimensions}.`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute a fast, deterministic hex hash of content — used to detect stale
 * embeddings (not for security). Uses FNV-1a which is pure JS and works in
 * any runtime (Node.js, Cloudflare Workers, browsers).
 *
 * Returns a 16-char hex string (two 32-bit FNV-1a hashes: one from the start,
 * one from the end of the string, concatenated for better distribution).
 */
export function contentHash(content: string): string {
  // FNV-1a 32-bit
  const fnv1a = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };

  // Two passes for better collision resistance on content-change detection:
  // forward hash + reverse hash concatenated
  const fwd = fnv1a(content);
  const rev = fnv1a(content.split("").reverse().join(""));
  return fwd.toString(16).padStart(8, "0") + rev.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Vector store persistence
// ---------------------------------------------------------------------------
//
// Vectors live in the StorageProvider's embedding store (Cloudflare Vectorize
// in production, KV brute-force when Vectorize is unbound, a local JSON file in
// dev/tests). Each vector carries `EmbeddingMeta` in its metadata: `model` (to
// drop vectors from a stale embedding model on read) and `contentHash` (to skip
// re-embedding unchanged content on write).

/** Per-vector metadata persisted alongside the embedding. */
interface EmbeddingMeta extends Record<string, string> {
  model: string;
  contentHash: string;
}

/** Drop matches whose stored model differs from the active one (stale vectors). */
function modelMatches(metadata: Record<string, string>, model: string | null): boolean {
  // Unknown active model or unlabelled legacy vector → don't filter it out.
  return !model || !metadata.model || metadata.model === model;
}

/**
 * Log a failed vector query at the right severity. A dimension mismatch is
 * BENIGN — it's the expected throw mid model-migration, while the store still
 * holds vectors of the previous dimension — so it warns. Anything else (an
 * unbound/misconfigured Vectorize binding, an outage, a quota error) means
 * vector search is actually down and silently degrading to BM25, so it escalates
 * to error to reach the log sink rather than whisper.
 */
function logVectorQueryFailure(fn: string, err: unknown): void {
  const benign = err instanceof Error && /dimension mismatch/i.test(err.message);
  logger[benign ? "warn" : "error"]("embeddings", `${fn} query failed:`, err);
}

/** Remove every stored embedding (used by the admin content reset). */
export async function clearEmbeddings(): Promise<void> {
  await withFileLock("vectors", async () => {
    await getStorage().clearEmbeddings();
  });
}

// ---------------------------------------------------------------------------
// Vector store operations
// ---------------------------------------------------------------------------

/**
 * Embed content for a wiki page and upsert it into the vector store.
 *
 * Skips re-embedding when the stored vector already has the same contentHash AND
 * was produced by the current embedding model; otherwise re-embeds and upserts
 * (with `{ model, contentHash }` metadata). A model change is handled per-entry:
 * stale-model vectors are simply re-embedded as pages are touched, and dropped
 * from reads in the meantime (see {@link searchByVector}/{@link relatedByVector}).
 */
export async function upsertEmbedding(
  slug: string,
  content: string,
): Promise<void> {
  return withFileLock("vectors", async () => {
    // The provider check alone must not bypass the vector switch.
    if (!getVectorSearchSettings().enabled) return;
    const modelName = getEmbeddingModelName();
    if (!modelName) return; // No embedding support

    const hash = contentHash(content);

    // Skip when the stored vector already matches this content AND model — same
    // optimization as before, now via a single id lookup instead of a full scan.
    const existing = await getStorage().getEmbeddingById(slug);
    if (
      existing &&
      existing.metadata.contentHash === hash &&
      existing.metadata.model === modelName
    ) {
      return;
    }

    const embedding = await embedText(content);
    if (!embedding) return;

    const meta: EmbeddingMeta = { model: modelName, contentHash: hash };
    await getStorage().upsertEmbedding(slug, embedding, meta);
  });
}

/**
 * Remove a slug's embedding from the vector store.
 */
export async function removeEmbedding(slug: string): Promise<void> {
  return withFileLock("vectors", async () => {
    await getStorage().removeEmbedding(slug);
  });
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Compute the cosine similarity between two vectors.
 * Returns a value in [-1, 1] where 1 = identical, 0 = orthogonal, -1 = opposite.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

/**
 * Embed the query text, then compute cosine similarity against all stored
 * vectors and return the top-K results sorted by score (descending).
 *
 * Returns an empty array if no embedding support is available, the store
 * is empty, or the store was built with a different embedding model (stale
 * embeddings would produce meaningless similarity scores).
 *
 * ONE config snapshot, read here and passed to BOTH halves (DW-313). This is
 * the caller the `cfg` doors exist for, and the drift key below is only
 * trustworthy because of it: `embedText` has a network round-trip inside it, so
 * two independent reads of the 5 s-TTL cache can straddle an expiry easily. The
 * query would then be embedded with the model from one snapshot while the filter
 * compared against the model from another, every hit would be dropped, and the
 * drift line would fire for a corpus that has not drifted. Before the throttle
 * that mis-fire corrected itself on the next query; now it would BURN the
 * `drift:<model>` key, and a later REAL drift under that same active model
 * would be silent until something re-armed it. The model that embedded and the
 * model the filter compares against have to come from the same read.
 *
 * The key does re-arm, on exactly one signal: a read from which the model
 * filter dropped NOTHING and which kept at least one vector labelled with the
 * ACTIVE model (DW-332, narrowed by decisions dated 2026-08-22: DW-404 from
 * "keeps at least one match", then DW-405 to require that positive proof). That is the
 * closest a per-query door gets to "a rebuild has landed", and it is what makes
 * rebuild-then-re-drift under the same model audible a second time. It is not
 * corpus proof and does not claim to be — topK slicing runs BEFORE the filter,
 * one stale orphan can wedge the key shut for good, and an all-unlabelled
 * corpus can never re-arm at all; the residue is spelled out once, on
 * `warnedMisconfigurations`. That delete is subject to this same one-snapshot
 * rule, and for a sharper reason than the warn: it must use the SAME
 * `currentModel` the filter compared against, never a second
 * `getEmbeddingModelName()` read, because a
 * re-derived name straddling the expiry would re-arm a DIFFERENT identity than
 * the one this read said anything about — un-burning some other model's key on
 * evidence that has nothing to do with it.
 */
export async function searchByVector(
  query: string,
  topK: number = 10,
): Promise<Array<{ slug: string; score: number }>> {
  const cfg = loadConfigSync();
  const queryEmbedding = await embedText(query, cfg);
  if (!queryEmbedding) return [];

  const currentModel = getEmbeddingModelName(cfg);
  // A query can throw on a dimension mismatch (e.g. mid model-migration, when
  // the store still holds vectors of the previous dimension). Degrade to "no
  // vector results" rather than propagating — callers fuse/fall back on [].
  try {
    const matches = await getStorage().queryEmbeddings(queryEmbedding, topK);
    const kept = matches.filter((m) => modelMatches(m.metadata, currentModel));
    // If the store returned hits but the model filter dropped ALL of them, the
    // active model name has drifted from what every stored vector was embedded
    // with — vector search is silently disabled until a re-embed/rebuild. Leave
    // a breadcrumb so that's diagnosable rather than looking like "no matches".
    //
    // Said ONCE per drifted ACTIVE MODEL per process (DW-310). The drift is
    // standing state — it holds for every query until the corpus is rebuilt —
    // but this is a per-query door, so an unthrottled line repeated itself for
    // every search anyone ran against a drifted corpus. The key is the active
    // model name and nothing else: the query is not part of the identity, and
    // neither is how many hits it happened to return, which is why the sentence
    // no longer names `matches.length` — keying on a per-query count would have
    // re-armed the warning for every distinct number of hits and defeated the
    // throttle. An active model that CHANGES and still drifts is a new identity
    // and speaks again.
    if (kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)) {
      // Re-arm (DW-332; narrowed by decisions dated 2026-08-22, first by
      // DW-404 and then by DW-405). Both conjuncts are load-bearing: a
      // WHOLE-WINDOW match the model filter dropped NOTHING from, which
      // POSITIVELY holds a vector labelled with the active model. The second conjunct also carries
      // DW-404's non-empty half — `some` is false on an empty array, of which
      // `kept.length === matches.length` is vacuously true — which is why
      // there is no separate `matches.length > 0` here any more.
      //
      // Read off `kept` rather than `matches`: the two are interchangeable
      // only because the first conjunct already forces them equal elementwise,
      // and reading the proof off `kept` keeps this branch talking about what
      // the filter KEPT, exactly as the warn branch below does.
      //
      // The state this turns on is INVISIBLE to the type system: `EmbeddingMeta`
      // declares `model: string`, but `queryEmbeddings` hands back
      // `Record<string, string>` and legacy vectors genuinely carry no `model`
      // key, so on those this comparison is `undefined === string` at runtime.
      // The types say unlabelled cannot happen; the corpus says otherwise.
      //
      // What each conjunct buys, what it costs, and the residue neither closes
      // are stated once on `warnedMisconfigurations` rather than restated here.
      rearmWarningAbout(`drift:${currentModel}`);
    } else if (kept.length === 0 && matches.length > 0) {
      // Spelled out rather than left as a bare `else`: since the two
      // narrowings above (DW-404, then DW-405) the branches are no longer
      // complementary, and TWO kinds of window have to fall through BOTH of
      // them. A MIXED window — which legitimately returned results — fails the
      // re-arm's first conjunct and is not empty of kept matches. A
      // whole-window UNLABELLED read fails only the second (`kept.length ===
      // matches.length` holds, `some` does not) and likewise kept matches. A
      // bare `else` would warn "the filter dropped every match" about both,
      // which is false of each.
      warnOnceAbout(
        `drift:${currentModel}`,
        "searchByVector: the model filter dropped every match " +
          `(active="${currentModel}") — likely embedding-model drift; ` +
          "rebuild embeddings.",
      );
    }
    return kept.map((m) => ({ slug: m.id, score: m.score }));
  } catch (err) {
    logVectorQueryFailure("searchByVector", err);
    return [];
  }
}

/**
 * Find pages most similar to an EXISTING page, reusing its already-stored
 * vector — no embedding call, so it's cheap enough to run on every page render.
 *
 * Returns top-K other pages by cosine similarity (descending). Returns an empty
 * array if there's no store, the page has no stored vector, or the store was
 * built with a different model (stale embeddings → meaningless scores). Does NOT
 * enforce visibility — callers must filter to readable pages.
 */
export async function relatedByVector(
  slug: string,
  topK: number = 10,
): Promise<Array<{ slug: string; score: number }>> {
  const self = await getStorage().getEmbeddingById(slug);
  if (!self) return [];

  const currentModel = getEmbeddingModelName();
  if (!modelMatches(self.metadata, currentModel)) return [];

  // Over-fetch by one to absorb the page's own vector, then drop it. A query can
  // throw on a dimension mismatch (mixed-dimension store mid model-migration);
  // this runs unguarded on the article render path (findSimilarPages), so
  // degrade to "no related pages" rather than failing the page.
  try {
    const matches = await getStorage().queryEmbeddings(self.vector, topK + 1);
    return matches
      .filter((m) => m.id !== slug && modelMatches(m.metadata, currentModel))
      .slice(0, topK)
      .map((m) => ({ slug: m.id, score: m.score }));
  } catch (err) {
    logVectorQueryFailure("relatedByVector", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Full vector store rebuild
// ---------------------------------------------------------------------------

export interface RebuildResult {
  total: number;
  embedded: number;
  skipped: number;
  model: string;
}

/**
 * Re-embed every wiki page and upsert it into the vector store. Used to backfill
 * after provisioning the index or switching embedding models.
 *
 * Upserts in place; it does NOT delete first, so embeddings for pages that no
 * longer exist are left behind — harmless, since every read intersects results
 * with the caller's readable/scoped slug set, so an orphan can't surface.
 *
 * Throws if no embedding provider is configured.
 *
 * @param onProgress Optional callback invoked after each page is processed.
 */
export async function rebuildVectorStore(
  onProgress?: (done: number, total: number) => void,
): Promise<RebuildResult> {
  if (!getVectorSearchSettings().enabled) {
    throw new Error("Vector search is off.");
  }
  const modelName = getEmbeddingModelName();
  if (!modelName) {
    throw new Error(
      "No embedding provider configured. Set up OpenAI, Google, Ollama, or " +
        "Cloudflare Workers AI (bind AI for @cf/baai/bge-m3) in Settings.",
    );
  }

  const entries = await listWikiPages();
  const total = entries.length;
  const storage = getStorage();

  let embedded = 0;
  let skipped = 0;

  // Upsert every current page. This overwrites in place; embeddings for pages
  // that no longer exist are left untouched (no bulk-clear on a managed index),
  // but they're harmless — every read intersects results with the caller's
  // readable/scoped slug set, so an orphan vector can never surface.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const page = await readWikiPage(entry.slug);

    if (!page || !page.content || page.content.trim().length === 0) {
      skipped++;
      onProgress?.(i + 1, total);
      continue;
    }

    try {
      const embedding = await embedText(page.content);
      if (!embedding) {
        skipped++;
        onProgress?.(i + 1, total);
        continue;
      }

      const meta: EmbeddingMeta = {
        model: modelName,
        contentHash: contentHash(page.content),
      };
      await withFileLock("vectors", () =>
        storage.upsertEmbedding(entry.slug, embedding, meta),
      );
      embedded++;
    } catch (err) {
      logger.warn("embeddings", `embed page "${entry.slug}" failed:`, err);
      skipped++;
    }

    onProgress?.(i + 1, total);
  }

  return { total, embedded, skipped, model: modelName };
}
