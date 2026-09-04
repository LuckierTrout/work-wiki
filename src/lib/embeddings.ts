import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { EmbeddingModel } from "ai";
import type { Ai } from "./storage/cloudflare-types";
import { listWikiPages, readWikiPage } from "./wiki";
import { getStorage } from "./storage";
import type { EmbeddingEntry } from "./storage";
import { isAtomicCounterIndexKey } from "./storage/types";
import { narrowIndexInteger } from "./storage/index-integer";
import {
  loadConfigSync,
  getEmbeddingModelOverride,
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
 * `embedding-rebuild-epoch` — how many times {@link rebuildVectorStore} has
 * COMPLETED with at least one page embedded, on this store, ever.
 *
 * The same module shape as `data-version.ts` (a logical key, an
 * `isAtomicCounterIndexKey` assertion at import time, a fail-soft reader, a
 * fail-soft bump over the provider-atomic `incrementIndex`) and for the same
 * reason: an in-process `getIndex`/`putIndex` pair is isolate-local, so two
 * Workers isolates can both read `n` and both store `n + 1`, and an
 * eventually-consistent read can store a value LOWER than what is there.
 *
 * What it exists for: the `drift:<active model>` warning re-arms on evidence
 * that a rebuild has landed, and a per-query door has no other way to learn
 * that. Every window-shaped proxy for it is a property of ONE query's window,
 * which is why the previous proxies failed in both directions (DW-598, DW-599)
 * — see {@link warnedMisconfigurations}. A counter that only a completed
 * rebuild moves is corpus-level evidence, and it is monotonic, so a read that
 * observes it moving FORWARD past a recorded value cannot be a stale read.
 *
 * Never decremented, never reset, never compared for equality by anything that
 * matters — only `>` against a value recorded earlier in the same process.
 */
export const EMBEDDING_REBUILD_EPOCH_KEY = "embedding-rebuild-epoch";

if (!isAtomicCounterIndexKey(EMBEDDING_REBUILD_EPOCH_KEY)) {
  throw new Error(
    `EMBEDDING_REBUILD_EPOCH_KEY ${JSON.stringify(EMBEDDING_REBUILD_EPOCH_KEY)} is not in ATOMIC_COUNTER_INDEX_KEYS`,
  );
}

/**
 * The current epoch, or `0` when it has never been written or cannot be read.
 *
 * `0` is deliberately indistinguishable from "absent" and from "the read
 * failed", and it never propagates — a config-store hiccup must not turn a
 * search into an error. What a degraded read costs depends on WHICH read
 * degraded, and both directions are real:
 *
 *   · At RE-ARM time, `0` is below every value ever recorded, so the key stays
 *     burnt and a genuine second drift goes unsaid until a read that can reach
 *     the counter.
 *   · At BURN time, `0` is recorded as the watermark, so the next read that
 *     CAN reach a real epoch sees it as movement and re-arms with no rebuild
 *     behind it — costing ONE extra drift line.
 *
 * The second is the same side of DW-310's trade this module takes everywhere:
 * a suppressed second outage is the failure the throttle exists to prevent, and
 * an extra line is cheap beside it. Recording `null` on a failed burn read
 * would trade it for the opposite — a key nothing can ever clear, which is
 * precisely DW-599.
 *
 * Narrowed through {@link narrowIndexInteger}, the same "what a stored counter
 * is worth" rule `incrementIndex` itself applies, so a hand-edited `"x"`, a
 * `1.5` or a `-1` reads as `0` here exactly as it does there.
 */
async function readRebuildEpoch(): Promise<number> {
  try {
    return narrowIndexInteger(
      await getStorage().getIndex<unknown>(EMBEDDING_REBUILD_EPOCH_KEY),
    );
  } catch (err) {
    logger.warn(
      "embeddings",
      "rebuild-epoch read failed; treating as no rebuild observed",
      err,
    );
    return 0;
  }
}

/**
 * Raise the epoch by exactly one and return what was stored.
 *
 * Fail-soft on the same terms as `bumpDataVersion`: a store that rejects is
 * warned about and answered with `0`, never thrown. The caller is the tail of a
 * rebuild whose vectors have ALREADY landed, and turning a successful rebuild
 * into a failed one to report a counter problem would be the wrong trade — the
 * cost of a lost bump is one drift line that stays unsaid.
 */
async function bumpRebuildEpoch(): Promise<number> {
  try {
    return await getStorage().incrementIndex(EMBEDDING_REBUILD_EPOCH_KEY);
  } catch (err) {
    logger.warn(
      "embeddings",
      "rebuild-epoch bump failed; the drift warning stays burnt",
      err,
    );
    return 0;
  }
}

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
 *   - `drift:<active model>` (DW-332). Drift is cleared by
 *     `rebuildVectorStore` with no restart involved, so the key has to be able
 *     to re-arm in-process. The evidence it re-arms on is a PERSISTED REBUILD
 *     EPOCH: `rebuildVectorStore` raises {@link EMBEDDING_REBUILD_EPOCH_KEY} by
 *     one when it completes having embedded at least one page, the epoch
 *     observed at BURN time is recorded beside the key in this Map, and a later
 *     read re-arms when a freshly-read epoch is STRICTLY GREATER than the
 *     recorded one. That is the WHOLE gate — there is no conjunct about the
 *     window at all, not even "the accepted window is non-empty": a read that
 *     returns nothing still knows a rebuild landed, and gating on the window
 *     would leave the key wedged for a corpus that is rebuilt and re-drifts
 *     before any read happens to return something, which is DW-599 in a
 *     narrower form. Every burnt key is therefore consulted on every read
 *     through either door, warn branch included, and the re-arm runs BEFORE the
 *     warn so a rebuild that landed since the burn makes the current read's own
 *     drift a NEW piece of news rather than a suppressed repeat. Without the
 *     re-arm, a
 *     corpus that drifts, is rebuilt, and drifts again under the SAME active
 *     model would be silent for the rest of the process.
 *
 *     This is the CANONICAL statement of the gate; both doors' branches point
 *     here rather than restating it. The gate read `kept.length > 0`
 *     (2026-08-21), was narrowed to a WHOLE-WINDOW match (DW-404) and then to
 *     require a POSITIVELY active-model-labelled vector in it (DW-405), and
 *     those window-composition conjuncts are now GONE — replaced, not joined.
 *     Every one of them was a property of ONE query's window, and a window is
 *     not the corpus:
 *
 *       · DW-598. `queryEmbeddings` sorted and sliced to topK BEFORE the model
 *         filter ran, so a window too small to SEE the stale vectors was a
 *         whole-window match and re-armed anyway; DW-404's own reproduction
 *         (`topK: 1`, alternating tags) oscillated under both narrowings. That
 *         half is fixed at the PROVIDER: the filter is now an `accept`
 *         predicate handed to `queryEmbeddings` and applied BEFORE the top-K
 *         reduction, so the window a door judges is the top-K nearest ACCEPTED
 *         vectors and the provider reports how many it turned away. The warn
 *         reads `matches.length === 0 && rejected > 0` — an empty window with
 *         nothing rejected is an empty STORE, which is not drift.
 *
 *       · DW-599. `rebuildVectorStore` never DELETES, and skips pages with
 *         empty content or a failed embed, so one stale ORPHAN vector — a
 *         deleted, renamed or emptied page — leaves every window containing it
 *         permanently mixed. Any re-arm that also demanded a whole-window match
 *         therefore stayed wedged for the rest of the process, and a second
 *         genuine drift shipped silent. The epoch is corpus-level evidence that
 *         an orphan cannot contradict, which is exactly why the window
 *         conjuncts are replaced rather than kept as an additional AND: keeping
 *         them would re-open this. The mirror-image cost the proof conjunct had
 *         — an all-unlabelled corpus that could never re-arm — goes with them.
 *
 *     The comparison is STRICTLY GREATER, never inequality: `incrementIndex` is
 *     monotonic, so a read holding a stale (lower) epoch cannot re-arm, and a
 *     read that another query burnt underneath sees its own epoch equal to the
 *     recorded one. A failed or unparseable epoch read is `0`, which likewise
 *     can only ever fail to re-arm. And the epoch is read only in the two
 *     states that need it — about to burn, or already burnt — never on the
 *     common healthy read, so this costs no storage round-trip per query on a
 *     process that has never seen drift.
 *
 *     The residue, stated once here rather than papered over. A provider that
 *     ranks SERVER-side (Vectorize) cannot evaluate `accept` remotely — a
 *     metadata filter would drop unlabelled legacy vectors from what the door
 *     RETURNS, not merely from what it judges — so it over-fetches to a bounded
 *     ceiling and filters locally; on a corpus deeper than that ceiling the
 *     window is best-effort and `rejected` is window-scoped. The epoch is read
 *     AFTER the query resolves, so a rebuild that completes in that gap has its
 *     bump recorded as the BURN's own watermark: the key then stays burnt
 *     through the whole of the rebuild that was already running, and clears
 *     only on the NEXT one — erring toward silence, for one cycle. (The mirror
 *     case, a burn whose epoch read failed and recorded `0`, errs toward
 *     speaking and costs one extra line; see {@link readRebuildEpoch}.)
 *     Concurrent interleaving of a burn and a bump is NOT closed here (DW-602).
 *
 *     A BURNT key costs one epoch read per read through either door until it
 *     clears — the gate has to ask "has a rebuild landed since?" on every read,
 *     and the answer only lives in storage. A healthy read on a key that was
 *     never burnt issues NONE, which is the common case and the one that had to
 *     stay free.
 *
 *     TWO doors share this key (DW-406): `searchByVector`, the query path, and
 *     `relatedByVector`, the page-render path behind `findSimilarPages`. They
 *     warn on the same condition and re-arm on the same gate, and key on the
 *     ACTIVE MODEL and nothing else, so drift is ONE piece of news however it
 *     is found — a deployment whose only vector traffic is related-page
 *     lookups still hears it, and a rebuild proven out through either door
 *     re-arms the key the other burnt. `relatedByVector` reads both branches
 *     off the window with the anchor's own vector already dropped: the anchor
 *     was vetted by that door's stale-anchor early return, so counting it would
 *     let a page vouch for a corpus it is the only current member of. That
 *     early return warns too — on a fully drifted corpus every anchor is stale,
 *     so control never reaches the window and the door would otherwise be mute
 *     in precisely the case the second door exists for.
 *
 *     Sharing one key costs one accepted FALSE POSITIVE, which only the render
 *     door can produce, and which the epoch does not change. A stale ORPHAN
 *     anchor — a renamed or re-embedded page whose old vector
 *     `rebuildVectorStore` never deletes — is a stale anchor on an otherwise
 *     healthy corpus, so its early return burns the process-wide key on ONE
 *     page's evidence and suppresses the line a later genuine drift would have
 *     spoken until the next rebuild bumps the epoch. `searchByVector` cannot
 *     produce it: its warn requires the provider to have rejected every
 *     candidate. Accepted deliberately — a burnt key costs a suppressed line,
 *     not a wrong answer, and giving the two doors separate keys would cost
 *     drift being one piece of news.
 *
 *     What is NOT a case here: a null active model. `currentModel` is typed
 *     `string | null`, but past `searchByVector`'s `if (!queryEmbedding)`
 *     guard it cannot BE null — `embedText` and `getEmbeddingModelName` read
 *     the same `cfg` snapshot and both refuse only on a missing provider
 *     (`resolveEmbeddingModelName` returns `string`, never null), so a null
 *     model has already returned `[]` before this branch chain runs. In
 *     `relatedByVector` null IS reachable — it embeds nothing, so no guard
 *     refuses first — and needs no case either, because `modelMatches` is true
 *     against a null model: the stale-anchor return never fires, `accept`
 *     degrades to accept-all so nothing is ever rejected, and the warn's
 *     `rejected > 0` conjunct therefore cannot hold. `drift:null` is
 *     structurally unspeakable — do not add a branch to say so.
 *   - `ollama-endpoint:sdk-default` (DW-401, repointed by DW-70). The embedding
 *     endpoint (`cfg.embeddingBaseUrl`) is STORE-ONLY and moved by a save, so an
 *     owner who reads the line and fills the field in changes the answer without
 *     restarting anything — and the evidence is read from the same helper the
 *     call is built from, in {@link selectOllama}: {@link embeddingBaseUrlOf}
 *     answering a URL IS the fix having landed. Without the re-arm, an endpoint
 *     that is saved and then cleared again would fall back to the SDK default in
 *     silence for the rest of the process.
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
/**
 * Key → the rebuild epoch observed when that key was burnt.
 *
 * A Map rather than a Set because the drift key's re-arm needs to compare
 * "what has happened since" against "what had happened when we spoke", and
 * membership alone cannot express that. `null` is the value for the four
 * identities that carry no epoch — they are env/binding state, not corpus
 * state — and is distinct from `undefined`, which means the key was never
 * burnt at all. `has`/`get` therefore both still answer "have we spoken about
 * this", and the epoch rides along only where it means something.
 */
const warnedMisconfigurations = new Map<string, number | null>();

/**
 * Emit `message` the first time `key` is seen; later repeats are silent.
 *
 * `observedEpoch` is recorded beside the key for the identities whose re-arm is
 * epoch-gated (`drift:<model>`), and left `null` for the rest. It is read at
 * the CALL SITE rather than here so the epoch belongs to the same read that
 * decided to warn, and so a warn on a path with no epoch to speak of does not
 * pay a storage round-trip to record one.
 */
function warnOnceAbout(
  key: string,
  message: string,
  observedEpoch: number | null = null,
): void {
  if (warnedMisconfigurations.has(key)) return;
  warnedMisconfigurations.set(key, observedEpoch);
  logger.warn("embeddings", message);
}

/**
 * Re-arm an epoch-gated key if — and only if — a rebuild has completed since it
 * was burnt.
 *
 * `observedEpoch` is the caller's own freshly-read epoch; the comparison is
 * STRICTLY GREATER against the epoch recorded at burn time. Monotonicity is
 * what makes that sound: `incrementIndex` only ever moves the counter forward,
 * so a read holding a stale (lower) epoch cannot re-arm, a read that another
 * query burnt underneath sees its own epoch EQUAL to the recorded one, and a
 * degraded `0` from a failed read is below every value that was ever recorded.
 * The gate can fail to speak; it cannot speak on nothing.
 *
 * A key that was never burnt (`undefined`) is a silent no-op, so a caller can
 * call this unconditionally on its healthy path. A key burnt with a `null`
 * epoch — one of the non-drift identities — is never re-armed here, which is
 * correct: those have no corpus-level evidence of ending, and the one that does
 * re-arm off other evidence uses {@link rearmWarningAbout}.
 *
 * See {@link warnedMisconfigurations} for why the epoch REPLACED the
 * window-composition conjuncts this gate used to carry rather than joining
 * them (DW-598, DW-599).
 */
function rearmDriftIfRebuilt(key: string, observedEpoch: number): void {
  const epochAtBurn = warnedMisconfigurations.get(key);
  if (epochAtBurn == null) return;
  if (observedEpoch > epochAtBurn) warnedMisconfigurations.delete(key);
}

/**
 * Forget `key` so the NEXT occurrence of this identity speaks again —
 * UNCONDITIONALLY, whatever epoch the key was burnt with.
 *
 * The counterpart to `warnOnceAbout` for a misconfiguration whose evidence of
 * ending is the caller's OWN answer rather than a corpus-level counter: an
 * Ollama endpoint that starts resolving again after a save (DW-401), re-armed
 * in {@link selectOllama} off the ladder's own answer. Embedding-model drift
 * does NOT come through here — its evidence is a rebuild that a per-query door
 * cannot observe directly, so it goes through {@link rearmDriftIfRebuilt} and
 * its epoch comparison instead.
 *
 * Deleting a key that was never set is a silent no-op, so a caller can re-arm
 * unconditionally on its success path without first asking whether it ever
 * warned. Named rather than an inline `.delete` at the call site so the Map
 * keeps exactly three mutators plus the test-only reset, all greppable
 * from here.
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
 * THE EMBEDDING ENDPOINT — the one rule, read by everything that has an opinion
 * about it (DW-70).
 *
 * The stored `embeddingBaseUrl` (Settings → Embeddings → "Embedding endpoint"),
 * trimmed, or `undefined` when it is absent, blank or whitespace-only. That is
 * the same treatment `openai` and `google` have always given the field, and now
 * `ollama` gives it too.
 *
 * THE SPLIT THIS MAKES: `ollamaBaseUrl` / `OLLAMA_BASE_URL` — the ladder in
 * `getOllamaBaseUrl` in `config.ts` — is the CHAT/GENERATION endpoint and is not read
 * here. Before this, the "Embedding endpoint" field accepted a value that no
 * code path read under `ollama` while the chat endpoint quietly served the
 * embedding call, so two settings overlapped and one of them went nowhere.
 * `OLLAMA_BASE_URL` remains a provider-DETECTION signal (see
 * {@link envOllamaBaseUrl} and `detectEnvProvider`) — this split is about which
 * endpoint the embedding CALL uses, not about which provider is selected.
 *
 * The consequence, accepted deliberately: an `OLLAMA_BASE_URL`-only deployment
 * that embeds today stops reaching that endpoint and falls to the SDK default.
 * `embeddingBaseUrl` is store-only (no env feeder), so {@link selectOllama}'s
 * warning is the migration path — it names the field to fill in.
 *
 * ONE READER, so {@link selectOllama}'s warn condition and the `baseURL`
 * {@link _createEmbeddingModel} hands `createOllama` cannot disagree: a warning
 * that describes a different endpoint than the call is worse than no warning.
 *
 * NO URL VALIDATION, on purpose: this is one flat unvalidated field and
 * `openai`/`google` already pass it through raw. One field, one treatment.
 */
function embeddingBaseUrlOf(cfg: ReturnType<typeof loadConfigSync>): string | undefined {
  const stored = cfg.embeddingBaseUrl;
  return typeof stored === "string" && stored.trim().length > 0 ? stored.trim() : undefined;
}

/**
 * The endpoint `createOllama()` uses when it is handed no `baseURL` at all.
 *
 * Copied from the SDK rather than imported because it is not exported
 * (`ollama-ai-provider-v2`, `createOllama`'s `baseURL` default). It is named
 * here for ONE purpose — saying out loud, in {@link selectOllama}, where the
 * embeddings actually went — and nothing resolves against it: the fall-through
 * in {@link _createEmbeddingModel} is still `createOllama()` with no argument
 * whenever {@link embeddingBaseUrlOf} is `undefined`, so a future change to the
 * SDK's default changes the behaviour and this constant only mis-names it in a
 * log line.
 *
 * SINCE DW-70 the fact it describes is the EMBEDDING endpoint's absence, not the
 * chat ladder's: a deployment with `OLLAMA_BASE_URL` set and nothing in the
 * Embedding endpoint field lands here, and the warning is what tells it so.
 */
const OLLAMA_SDK_DEFAULT_BASE_URL = "http://127.0.0.1:11434/api";

/**
 * Return `ollama`, and say so when there is no endpoint behind it (DW-401).
 *
 * DW-370 taught the auto-detect rung that a REFUSED `OLLAMA_BASE_URL` must not
 * select `ollama` — but that only covers the rung that reads the variable to
 * decide. An EXPLICIT selection (`EMBEDDING_PROVIDER=ollama`, or the stored
 * `embeddingProvider`, or a stored generation provider of `ollama`) does not
 * consult the endpoint at all, so a deployment with no saved endpoint resolved
 * `ollama`, reached `createOllama()` with no `baseURL`, and embedded its whole
 * corpus against the SDK's own localhost default — silently, and successfully,
 * if something happened to be listening there.
 *
 * IT ASKS {@link embeddingBaseUrlOf}, THE SAME HELPER `_createEmbeddingModel`
 * BUILDS THE CALL FROM (DW-70). It used to ask `getOllamaBaseUrl` — which is now
 * the chat/generation ladder and not what the embedding call reads — so leaving
 * it there would have produced the one thing worse than silence: a sentence
 * describing an endpoint other than the one being dialled.
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
  if (embeddingBaseUrlOf(cfg) === undefined) {
    warnOnceAbout(
      key,
      "Ollama is the selected embedding provider, but no embedding endpoint is " +
        "saved (Settings → Embeddings → \"Embedding endpoint\" is empty), so " +
        `embeddings are going to the SDK's own default, ` +
        `${OLLAMA_SDK_DEFAULT_BASE_URL}. OLLAMA_BASE_URL is the chat endpoint ` +
        "and is not read here — save an Embedding endpoint if that default is " +
        "not where Ollama is listening.",
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
 * The MODEL half of {@link getEmbeddingResolution}, and nothing else — the same
 * single walk of the same ladder, with `cfg` handed straight through. Provider
 * is resolved by {@link resolveEmbeddingProvider} (override → Workers AI
 * auto-detect → LLM provider). Model name resolution:
 *   1. `EMBEDDING_MODEL` env var (highest priority)
 *   2. `config.embeddingModel` from config file
 *   3. Provider-specific default
 *
 * A caller that needs the PROVIDER as well comes through
 * `getEmbeddingResolution` instead of calling this door and then a second one —
 * the two settings resolvers do, since DW-616. This function is for the callers
 * that only ever wanted the name.
 *
 * @param cfg OPTIONAL, defaulting to `loadConfigSync()` and passed straight to
 *   {@link getEmbeddingResolution}, which documents what handing one in buys
 *   (DW-313). Passing nothing is byte-identical to the behaviour before the
 *   parameter existed.
 */
export function getEmbeddingModelName(
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): string | null {
  return getEmbeddingResolution(cfg).model;
}

/**
 * BOTH halves of the embed path's answer — which provider embeds, and which
 * model it embeds with — from ONE walk of the ladder (DW-616).
 *
 * {@link getEmbeddingModelName} is this function's `.model`, so the two can
 * never disagree. A caller that needs the pair must come through here rather
 * than calling the model door and then asking again for the provider: the
 * ladder reads `process.env` and the config snapshot on every leg, so two calls
 * are two resolutions that merely agree today.
 *
 * The PROVIDER is exported at all because it cannot be re-derived by anyone
 * holding only the served config. `resolveEmbeddingProvider` has a Workers AI
 * auto-detect leg that fires with BOTH `EMBEDDING_PROVIDER` and
 * `config.embeddingProvider` unset — the normal shape of a Workers deployment —
 * so an env→store ladder walked anywhere else answers `null` on exactly the
 * deployments the provider matters most for.
 *
 * `provider` is null exactly when nothing embeds, which is the same condition
 * `model` is null under: the model is resolved FROM the provider, so there is
 * no state where one is set and the other is not.
 *
 * @param cfg OPTIONAL, and defaulting to `loadConfigSync()` — which is what
 *   every caller outside the two settings resolvers wants, so passing nothing
 *   is byte-identical to calling it with no snapshot in hand. What passing one
 *   buys is "resolve against THIS snapshot": `loadConfigSync()` is a 5 s-TTL
 *   cache, so a caller that already read it and then asks this door for the
 *   rest of its answer can otherwise be told about a different snapshot than
 *   the one it is describing (DW-313). `getEffectiveSettings` and
 *   `getWorkbenchSettings` both hold a `cfg` and both pass it — through this
 *   door since DW-616 — which is how their "what is set" and "what is in
 *   effect" halves are guaranteed to be about the same config. It is threaded
 *   all the way through the provider and key resolution, not just the model
 *   lookup.
 */
export function getEmbeddingResolution(
  cfg: ReturnType<typeof loadConfigSync> = loadConfigSync(),
): { provider: EmbeddingProvider | null; model: string | null } {
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) return { provider: null, model: null };
  return { provider, model: resolveEmbeddingModelName(provider, cfg) };
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
 * EVERY non-binding provider honours the stored `embeddingBaseUrl` (Story 1.9's
 * "endpoint" half of the vector gate) through {@link embeddingBaseUrlOf} —
 * additive, so with nothing stored the option is omitted entirely and each
 * provider resolves to its own default exactly as before.
 *
 * `ollama` JOINED THEM IN DW-70. It used to read `getOllamaBaseUrl(cfg)` — the
 * chat/generation ladder — which made the "Embedding endpoint" field a value no
 * `ollama` code path read, and made `OLLAMA_BASE_URL` do double duty. The two
 * settings no longer overlap: chat/generation reads `ollamaBaseUrl` /
 * `OLLAMA_BASE_URL`, embeddings read `embeddingBaseUrl`. The known migration
 * cost is that an `OLLAMA_BASE_URL`-ONLY DEPLOYMENT NOW NEEDS AN EMBEDDING
 * ENDPOINT SAVED; until it is, the call is argument-free and {@link selectOllama}
 * says so once, naming the field to fill in.
 *
 * `workers-ai` is untouched by that and stays untouched: its transport is the
 * Cloudflare `AI` binding, not a URL, and it is not constructed here at all.
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
  const embeddingBaseUrl = embeddingBaseUrlOf(cfg);
  const baseUrlOption = embeddingBaseUrl ? { baseURL: embeddingBaseUrl } : {};
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
      // THE SAME ENDPOINT `openai` and `google` read, off the same `cfg`
      // snapshot (DW-70/DW-313) — `embeddingBaseUrl`, not the chat ladder.
      //
      // The argument-free fall-through is preserved VERBATIM (DW-401): with no
      // Embedding endpoint saved, `createOllama()` is called with nothing and
      // the SDK uses its own default. `OLLAMA_SDK_DEFAULT_BASE_URL` stays
      // log-only — it is never substituted here — so what an owner reads in the
      // warning and what the call does remain one fact.
      //
      // Spelled as its own branch rather than `createOllama({...baseUrlOption})`
      // because `createOllama({})` and `createOllama()` are not identical to
      // read, and "no argument at all" is the behaviour pinned by
      // `settings-runtime-wiring.test.ts`.
      const ollama = embeddingBaseUrl
        ? createOllama({ baseURL: embeddingBaseUrl })
        : createOllama();
      return ollama.embedding(modelName);
    }
    default:
      return null;
  }
}

/**
 * Returns true if an embedding-capable provider is configured.
 *
 * @param cfg OPTIONAL, defaulting to `loadConfigSync()`, and threaded through
 *   {@link getEmbeddingModelName} to {@link getEmbeddingResolution} — which is
 *   where the note lives. Passing the snapshot a caller already holds is what
 *   stops "does this deployment embed?" and "with what?" from being answered
 *   about two different reads of the 5 s-TTL config cache (DW-313).
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

/**
 * How many vectors {@link rebuildVectorStore} accumulates before one store.
 *
 * The number trades two bounded risks against each other. Larger batches mean
 * fewer index rewrites (the whole point) but a bigger blast radius: a rejected
 * flush costs every page in it, and the pending array holds every vector in it
 * in memory. 32 keeps a rebuild's rewrites proportional to N/32 while keeping
 * both of those small enough to shrug at. It is not tuned to any provider's
 * request limit — the R2 provider chunks its own Vectorize requests — so it is
 * safe to move.
 *
 * EXPORTED for `write-batching-bounds.test.ts`, which derives the recorded
 * rewrite bound from it. A hand-copied 32 in the test would let this constant
 * change while the bound it is supposed to express silently did not.
 */
export const EMBEDDING_FLUSH_BATCH = 32;

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
 * The key does re-arm, on exactly one signal and no conjunct beside it: a
 * PERSISTED REBUILD EPOCH strictly greater than the one recorded when the key
 * was burnt (DW-332; the window-composition conjuncts DW-404 and DW-405 added
 * were REPLACED by the epoch, closing DW-598 and DW-599). A completed
 * `rebuildVectorStore` is what moves that counter, so this is corpus-level
 * evidence a per-query door can actually see, and it is what makes
 * rebuild-then-re-drift under the same model audible a second time — including
 * when no read in between returned anything. The residue it does not close is
 * spelled out once, on `warnedMisconfigurations`.
 *
 * The model filter itself now travels DOWN into the provider as an `accept`
 * predicate, so it is applied before the top-K slice and this door judges the
 * top-K nearest ACCEPTED vectors rather than the accepted subset of the top-K
 * nearest. That is DW-598's half of the fix and it lives at the provider, not
 * here.
 *
 * The re-arm is subject to this same one-snapshot rule, and for a sharper
 * reason than the warn: it must use the SAME `currentModel` the filter compared
 * against, never a second `getEmbeddingModelName()` read, because a re-derived
 * name straddling the expiry would re-arm a DIFFERENT identity than the one
 * this read said anything about — un-burning some other model's key on evidence
 * that has nothing to do with it.
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
    // The model filter goes DOWN to the provider so it narrows the candidate
    // set BEFORE the top-K slice (DW-598). `rejected` is how many stored
    // vectors it turned away, which is the only thing that tells an EMPTY
    // STORE (nothing to rank) apart from a FULLY DRIFTED one (everything
    // ranked, everything refused).
    const { matches, rejected } = await getStorage().queryEmbeddings(
      queryEmbedding,
      topK,
      (metadata) => modelMatches(metadata, currentModel),
    );
    const driftKey = `drift:${currentModel}`;
    // If the store held vectors but the filter refused ALL of them, the active
    // model name has drifted from what every stored vector was embedded with —
    // vector search is silently disabled until a re-embed/rebuild. Leave a
    // breadcrumb so that's diagnosable rather than looking like "no matches".
    //
    // Said ONCE per drifted ACTIVE MODEL per process (DW-310). The drift is
    // standing state — it holds for every query until the corpus is rebuilt —
    // but this is a per-query door, so an unthrottled line repeated itself for
    // every search anyone ran against a drifted corpus. The key is the active
    // model name and nothing else: the query is not part of the identity, and
    // neither is how many hits it happened to return, which is why the sentence
    // does not name a count — keying on a per-query count would have re-armed
    // the warning for every distinct number of hits and defeated the throttle.
    // An active model that CHANGES and still drifts is a new identity and
    // speaks again.
    //
    // `topK > 0` is load-bearing, not defensive. `browse.ts` computes its limit
    // as `Math.min(allowedSlugs.size, …)`, which is ZERO when a tag filter
    // matches no page — and with the predicate now applied BEFORE the slice, a
    // perfectly healthy corpus carrying one stale orphan answers a `topK: 0`
    // query with an empty window and a non-zero `rejected`. An empty window the
    // CALLER asked for is not evidence of anything, least of all drift.
    const drifted = matches.length === 0 && rejected > 0 && topK > 0;
    const burnt = warnedMisconfigurations.has(driftKey);
    if (burnt || drifted) {
      // ONE epoch read, shared by both halves. It is read only in these two
      // states — the key is already burnt, or this read is about to burn it —
      // so a healthy process that has never seen drift issues none at all.
      const epoch = await readRebuildEpoch();
      // Re-arm FIRST, and on the epoch ALONE: a rebuild that landed since the
      // burn makes this read's own drift, if it is drifted, a NEW piece of news
      // rather than a repeat. Gating the re-arm on a non-empty window instead
      // would leave DW-599 alive in a narrower form — a corpus that is rebuilt
      // and re-drifts before any read returns anything would fall into the warn
      // branch forever, where `warnOnceAbout` silently declines to speak.
      if (burnt) rearmDriftIfRebuilt(driftKey, epoch);
      // If the store held vectors and the predicate refused ALL of them, the
      // active model name has drifted from what every stored vector was
      // embedded with. The epoch goes in with the burn as the watermark a later
      // read has to beat.
      if (drifted) {
        warnOnceAbout(
          driftKey,
          "searchByVector: the model filter dropped every match " +
            `(active="${currentModel}") — likely embedding-model drift; ` +
            "rebuild embeddings.",
          epoch,
        );
      }
    }
    return matches.map((m) => ({ slug: m.id, score: m.score }));
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
 *
 * The second door onto `drift:<active model>` (DW-406). What it RETURNS is
 * untouched by that — a model mismatch is still a cache miss the caller falls
 * back from — but a deployment whose only vector traffic is page renders would
 * otherwise observe neither drift nor its recovery. The gate, what it buys,
 * what it costs, and the one false positive this door alone can produce are
 * stated once on {@link warnedMisconfigurations}; the branches below point
 * there rather than restating it.
 */
export async function relatedByVector(
  slug: string,
  topK: number = 10,
): Promise<Array<{ slug: string; score: number }>> {
  const self = await getStorage().getEmbeddingById(slug);
  if (!self) return [];

  const currentModel = getEmbeddingModelName();
  const driftKey = `drift:${currentModel}`;
  if (!modelMatches(self.metadata, currentModel)) {
    // On a fully drifted corpus EVERY anchor is stale, so control never reaches
    // the window below — without this line the render path stays mute in
    // exactly the case that made it worth wiring up (DW-406). Keyed on the
    // ACTIVE MODEL, the same identity `searchByVector` uses, so drift is one
    // piece of news whichever door finds it; see `warnedMisconfigurations`.
    //
    // The epoch is read once and used for BOTH halves, in the same order the
    // window branches below use: re-arm first, then burn. Re-arming here is
    // what bounds the one false positive this door alone can produce (a stale
    // ORPHAN anchor on a healthy corpus) — a rebuild that lands after such a
    // burn clears it on the very next render, where before DW-599 the key
    // stayed shut for the rest of the process. Without the re-arm on THIS
    // path the orphan is rendered on every page view, so control would never
    // reach a branch that could clear it.
    const epoch = await readRebuildEpoch();
    rearmDriftIfRebuilt(driftKey, epoch);
    warnOnceAbout(
      driftKey,
      "relatedByVector: the anchor's own vector is from another model " +
        `(active="${currentModel}") — likely embedding-model drift; ` +
        "rebuild embeddings.",
      epoch,
    );
    return [];
  }

  // Over-fetch by one to absorb the page's own vector, then drop it. A query can
  // throw on a dimension mismatch (mixed-dimension store mid model-migration);
  // this runs unguarded on the article render path (findSimilarPages), so
  // degrade to "no related pages" rather than failing the page.
  try {
    // The model filter travels down as `accept`, so it narrows the candidate
    // set BEFORE the top-K slice (DW-598) — the anchor's own vector is the only
    // thing this door still drops locally, and only because the provider
    // predicate sees metadata, not ids.
    const { matches, rejected } = await getStorage().queryEmbeddings(
      self.vector,
      topK + 1,
      (metadata) => modelMatches(metadata, currentModel),
    );
    // The drift gate has to be read off the window MINUS the anchor. The anchor
    // was already vetted by the early return above, so counting it as evidence
    // would let a page vouch for a corpus it is the only current member of.
    const others = matches.filter((m) => m.id !== slug);
    // The same shape as `searchByVector`, including the `topK > 0` conjunct:
    // this door queries for `topK + 1`, so at `topK: 0` the anchor eats the
    // only slot, `others` is empty and `rejected` can be non-zero on a corpus
    // that has not drifted at all. An empty window the caller asked for is not
    // evidence of anything.
    const drifted = others.length === 0 && rejected > 0 && topK > 0;
    const burnt = warnedMisconfigurations.has(driftKey);
    if (burnt || drifted) {
      // The canonical gate, shaped exactly as `searchByVector`'s (DW-332,
      // re-anchored on the rebuild epoch by DW-598/DW-599): one epoch read,
      // re-arm on the epoch alone, then burn. What it buys and costs is stated
      // once on `warnedMisconfigurations`; both doors re-arm the SAME key, so a
      // rebuild observed on a page render un-burns the line a search would
      // otherwise never say again.
      const epoch = await readRebuildEpoch();
      if (burnt) rearmDriftIfRebuilt(driftKey, epoch);
      if (drifted) {
        warnOnceAbout(
          driftKey,
          "relatedByVector: the model filter dropped every match " +
            `(active="${currentModel}") — likely embedding-model drift; ` +
            "rebuild embeddings.",
          epoch,
        );
      }
    }
    return others.slice(0, topK).map((m) => ({ slug: m.id, score: m.score }));
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

  // Vectors accumulated since the last flush. A provider that keeps its
  // embeddings in one blob rewrote and fsynced that whole blob once per vector,
  // so a rebuild of N pages cost N full index rewrites; a flush of up to
  // EMBEDDING_FLUSH_BATCH is one.
  let pending: EmbeddingEntry[] = [];

  /**
   * Store what has accumulated, and settle those pages' counters.
   *
   * A page counts as `embedded` only once its flush has SUCCEEDED — before that
   * its vector exists only in this array — and as `skipped` when the flush
   * rejects, logged exactly as the per-page catch below logs its own failure.
   * The batch is cleared before the store so a rejected flush cannot be retried
   * implicitly by the next one: one bad flush costs its own pages and no more,
   * which is the same fail-soft shape the per-page loop already had.
   */
  const flushPending = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      await withFileLock("vectors", () => storage.upsertEmbeddings(batch));
      embedded += batch.length;
    } catch (err) {
      logger.warn(
        "embeddings",
        `embed flush failed for ${batch.length} page(s) ` +
          `(${batch.map((item) => item.id).join(", ")}):`,
        err,
      );
      skipped += batch.length;
    }
  };

  // Upsert every current page. This overwrites in place; embeddings for pages
  // that no longer exist are left untouched (no bulk-clear on a managed index),
  // but they're harmless — every read intersects results with the caller's
  // readable/scoped slug set, so an orphan vector can never surface.
  //
  // The `finally` is what makes accumulating safe. `readWikiPage` and
  // `onProgress` sit OUTSIDE the per-page catch — deliberately, since a caller's
  // progress callback throwing is the caller's bug — so a throw there escapes
  // the loop entirely. Without the tail flush running on that path, up to
  // EMBEDDING_FLUSH_BATCH − 1 vectors that were already embedded would be
  // discarded, where the per-vector code this replaced had already stored them.
  try {
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
        pending.push({ id: entry.slug, vector: embedding, metadata: meta });
        if (pending.length >= EMBEDDING_FLUSH_BATCH) await flushPending();
      } catch (err) {
        logger.warn("embeddings", `embed page "${entry.slug}" failed:`, err);
        skipped++;
      }

      onProgress?.(i + 1, total);
    }
  } finally {
    // The tail — whatever did not fill a whole batch, on every exit path.
    // `flushPending` swallows its own failure, so this cannot replace an error
    // already on its way out.
    await flushPending();
  }

  // The rebuild is over and whatever landed has landed. Raise the persisted
  // epoch so the `drift:<model>` warning may speak again about a corpus that
  // drifts AFTER this point (DW-599) — a per-query door has no other way to
  // observe that a rebuild completed, and every window-shaped proxy for it was
  // wrong in one direction or the other. See `warnedMisconfigurations`.
  //
  // Gated on `embedded > 0`: a rebuild that stored nothing — every page empty,
  // every embed refused, every flush rejected — changed no vector, so it is not
  // evidence of anything and must not un-burn a warning.
  //
  // Fail-soft and AFTER the tail flush, in that order for a reason: the never-
  // delete contract and the per-page/per-flush fail-soft behaviour above are
  // untouched, and a counter that will not increment must not turn a rebuild
  // whose vectors are already stored into a rejected one. The cost of a lost
  // bump is one drift line that stays unsaid.
  //
  // OUTSIDE the `try/finally`, deliberately. `readWikiPage` and `onProgress`
  // sit outside the per-page catch, so a throw from either escapes the loop:
  // the `finally` still flushes and those vectors DO land, but this line never
  // runs. That is the intended reading of the counter — it means a rebuild
  // COMPLETED, not that some vectors were written — and its cost is named
  // rather than hidden: after such a throw the corpus may be partly re-embedded
  // while the drift key stays burnt until the next rebuild that finishes.
  if (embedded > 0) await bumpRebuildEpoch();

  return { total, embedded, skipped, model: modelName };
}
