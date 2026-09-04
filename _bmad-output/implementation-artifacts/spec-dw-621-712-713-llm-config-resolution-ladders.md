---
title: 'LLM config-resolution ladders read the stored facts (DW-621, DW-712, DW-713)'
type: 'bugfix'
created: '2026-09-04'
status: 'blocked'
baseline_revision: 'e92745f6760a2e12906faa66fe3271907e568dd8'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two LLM config doors answer from facts the resolvers already honour and one does not read the store at all. `chatModelForRetrieve` (`src/lib/wiki-retrieve.ts:561`) resolves the public retrieve payload's `chatModel` from `loadConfigSync()` on a route that never warms the cache, so a cold process tells an API caller a correctly configured wiki has `configured: false` (DW-712, DW-548's class). `getConfiguredModel`'s explicit-provider branch (`src/lib/llm.ts:511-516`) never reads `LLM_MODEL` or `cfg.model`, so a stored `custom` model that the primary ladder builds fine is refused with "needs a model name" at `src/lib/agent-runtime.ts:156` (DW-713). DW-621 asks `hasLLMKey` to key off `chatProvider`/`ingestProvider` too. That reading is SUPERSEDED and is not this bundle's work: the answered human decision on DW-711 (2026-09-03, `effect: build` — "Route by workload at the call sites … Resolve DW-621 the same way. Pin that a chatProvider-only store passes both gates and reaches the provider it names.") settles the fix as workload routing at the `chat.ts` / `ingest.ts` call sites, in DW-711's own story. DW-621's leg HERE is documentation only: record in code that this predicate deliberately answers for the primary route alone, and that DW-711 owns the fix.

**Approach:** Warm the config once inside `assembleWikiContext` and thread that snapshot into `chatModelForRetrieve`, following `llm.ts`'s `configSnapshot` rule that an empty answer stays unthreaded. Give `getConfiguredModel`'s explicit-provider branch the primary ladder's stored model — via `getResolvedCredentials`, not a re-typed copy — and only when the named provider IS the store's primary provider. Leave `hasLLMKey`'s answer unchanged and pin the reason in code plus a regression test that names DW-711 as the story which fixes it.

## Boundaries & Constraints

**Always:** One config generation per resolution — a snapshot that is read is threaded, never re-read. An empty `loadConfig()` answer (`{}`) must NOT be threaded; pass nothing and let the resolver's existing default read (`loadConfigSync()`) stand, exactly as `configSnapshot` in `src/lib/llm.ts:316` explains. Model ladders are derived from their single owner (`getResolvedCredentials`), never restated.

**Block If:** A fix would require `chat.ts` or `ingest.ts` to start passing `workload` to the LLM resolvers — that is Epics 2 and 3's wiring, deliberately unbuilt (`src/lib/llm.ts:453-458`), and it is DW-711's story under the 2026-09-03 decision. This bundle must not pre-empt it, and must not treat its absence as an unanswered question: it is answered, and answered elsewhere.

**Never:** Do not change `hasLLMKey`'s truth value for any store. Do not write anything — docblock, comment or test name — that forbids or argues against DW-711's routing: the pin records what THIS predicate answers for (the primary route), and DW-711 changes what the call sites ASK, not this predicate. Do not change the primary provider ladder (`getResolvedCredentials`' `cfg.provider ?? env.provider`) so that a workload selection can become the primary. Do not touch `runVectorPhase`/`getVectorSearchSettings`' cold read in `src/lib/wiki-retrieve.ts:311` — same class, not this bundle's. Do not reword any existing refusal sentence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cold retrieve, store configured | Process where nothing warmed the cache; store has `chatProvider: "custom"` + `customBaseUrl` | `assembleWikiContext(...).chatModel` reports the stored provider/model/`configured` and the stored `baseUrl` | No error expected |
| Cold retrieve, empty store | `loadConfig()` answers `{}` (no config, or unreadable) | `chatModelForRetrieve` falls back to its own `loadConfigSync()` default — today's behaviour, unchanged | No error expected |
| Stored model, explicit custom provider | Store `{provider: "custom", model: "my-model", customApiKey, customBaseUrl}`; `getConfiguredModel({provider: "custom"})` | Builds a client on `my-model` — the same model `getModel()` builds | No error expected |
| Stored model belongs to another provider | Store `{provider: "anthropic", model: "claude-x"}`; `getConfiguredModel({provider: "custom", ...creds})` | Still refuses: "The Custom provider needs a model name." — `claude-x` is anthropic's | Existing refusal, unchanged |
| `LLM_MODEL` set | `LLM_MODEL=env-model`, store `{provider: "custom", ...}`; `getConfiguredModel({provider: "custom"})` | Builds on `env-model`; an explicit `options.model` still outranks it | No error expected |
| Workload-only store, LLM gate | Store `{chatProvider: "ollama"}`, no primary provider, no env keys | `hasLLMKey()` stays `false` | Callers keep degrading (empty analysis, fallback copy) instead of throwing. Pin of today's contract only — DW-711 closes the owner-visible gap at the call sites |

</intent-contract>

## Code Map

- `src/lib/wiki-retrieve.ts:552-575` -- `chatModelForRetrieve(cfg = loadConfigSync())`; DW-712 site. Called at `:583` from `assembleWikiContext` with NO argument — the cold read. `assembleWikiContext` is already `async`, so the warm read lands at its top, before the `!trimmed` early return at `:604`.
- `src/lib/llm.ts:316-318` -- `configSnapshot()`: the empty-answer rule to copy (`{}` stays unthreaded). Private to `llm.ts`; reproduce the two-line rule locally in `wiki-retrieve.ts` rather than exporting it.
- `src/lib/llm.ts:462-546` -- `getConfiguredModel`; DW-713's ladder is the `resolvedModel` assignment at `:511-516`. `cfg` (the `configSnapshot()` result, possibly `undefined`) is already in scope and already threaded to `apiKeyForProvider`/`getCustomBaseUrl`/`getOllamaBaseUrl`.
- `src/lib/config.ts:2740-2800` -- `getResolvedCredentials(cfg = loadConfigSync())`: the primary ladder that owns `LLM_MODEL` → `cfg.model` → `OLLAMA_MODEL` → `DEFAULT_MODELS[provider]`, and returns `model: null` for a `custom` with nothing stored. Already imported by `llm.ts`.
- `src/lib/llm.ts:249-271` -- `hasLLMKey`; DW-621's site. Read-only apart from the new docblock paragraph.
- `src/lib/ingest.ts:1767-1779` -- `analyzeSource`: gates on `hasLLMKey`, then calls `callLLM` with NO try/catch. The evidence that a gate answering `true` for a store the primary ladder cannot build turns a degrade into a thrown ingest failure.
- `src/lib/__tests__/wiki-retrieve.test.ts:9-35` -- module mock of `../config`; `loadConfigSync` is mocked, `loadConfig` is not yet. DW-619's snapshot-identity cases at `:407-486` are the pattern to extend.
- `src/lib/__tests__/llm.test.ts:615-760` -- the keyless-guard describe; `seedConfig`, `refusal`, `primaryRefusal` helpers. The comment at `:755-759` ("NO model-state equality on purpose … real and deferred") is DW-713's own deferral note and must be replaced, not left contradicting the fix.
- `src/lib/__tests__/llm-key-cold-config.test.ts` -- where `hasLLMKey`'s store legs are pinned; DW-621's regression test belongs beside them.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-retrieve.ts` -- import `loadConfig`; in `assembleWikiContext`, `await` it once and pass the snapshot to `chatModelForRetrieve` only when it is non-empty (otherwise pass nothing) -- DW-712: the route never warms the cache, so the payload described an empty store.
- `src/lib/llm.ts` -- in `getConfiguredModel`'s explicit-provider branch, insert the primary ladder's model between `options.model` and the `OLLAMA_MODEL`/`DEFAULT_MODELS` legs, taken from `getResolvedCredentials(cfg)` and used only when `provider` equals that call's resolved primary provider -- DW-713: derive from the owner so the two ladders cannot drift, and guard on provider identity so one provider's stored model never reaches another's client.
- `src/lib/llm.ts` -- add a paragraph to `hasLLMKey`'s docblock recording why the workload fields are NOT read here -- DW-621: state that every caller resolves through the primary ladder, name `analyzeSource` as what a `true` answer would break, and point at the chat/ingest call sites as where the real fix lands, naming DW-711 as the story that owns it under the 2026-09-03 decision.
- `src/lib/__tests__/wiki-retrieve.test.ts` -- mock `loadConfig` in the `../config` factory (defaulting to the same object `loadConfigSync` answers) and add a cold-cache case: `loadConfigSync` returns `{}`, `loadConfig` resolves a store with `customBaseUrl` -- DW-712's regression test; without it the suite's module mock hides the cold read entirely.
- `src/lib/__tests__/llm.test.ts` -- add the stored-model cases and replace the `:755-759` deferral comment with the model-state equality it disclaimed -- DW-713.
- `src/lib/__tests__/llm-key-cold-config.test.ts` -- add a case pinning that a `{chatProvider: "ollama"}`-only store still reports `hasLLMKey() === false`, with the reason in the comment -- DW-621. The comment pins THIS predicate's contract and points at DW-711; it must not read as a constraint on DW-711's call-site routing.

**Acceptance Criteria:**
- Given a process where nothing has warmed the config cache and a store selecting a chat provider, when `assembleWikiContext` runs, then the returned `chatModel` describes the stored selection and every leg of it is resolved from the one awaited snapshot.
- Given `loadConfig()` answers `{}` for an unreadable or absent store, when `assembleWikiContext` runs, then `chatModelForRetrieve` resolves from its own `loadConfigSync()` default and the payload is what it is today.
- Given a store whose primary provider is `custom` with a saved `model`, when `getConfiguredModel({provider: "custom"})` is called with both credential halves present, then it builds a client on the saved model instead of refusing.
- Given the same state, when the model gap IS real (nothing stored, no `LLM_MODEL`), then both ladders still refuse with the identical sentence.
- Given a store that names a provider only through `chatProvider` or `ingestProvider`, when any gated feature asks `hasLLMKey()`, then the answer is still `false` and the feature degrades rather than throwing — and the gate's docblock plus the new test comment record why, naming DW-711 as the story that closes the owner-visible gap.

## Spec Change Log

### 2026-09-04 — Escalation resolution (`/bmad-loop-resolve`, human present)

The dev session escalated an intent gap: the bundle intent asked for `hasLLMKey` to be
widened to read `chatProvider` / `ingestProvider`, while the answered 2026-09-03 decision on
DW-711 had already assigned that fix to DW-711's story ("Resolve DW-621 the same way"), and
the triage option the human chose said in as many words that it "subsumes DW-621's hasLLMKey
widening and should be its own story, not a sweep bundle". The spec had resolved the conflict
by inventing a third answer without saying so.

**Decision (human, 2026-09-04): supersede.** DW-621's leg in this bundle is documentation
only — the predicate's answer is unchanged and the code records that DW-711 owns the fix.
The bundle intent's "widen the gate" reading is withdrawn. DW-712 and DW-713 are unchanged.
DW-711 stays open with its decision; this bundle does not do its wiring.

The `<frozen-after-approval>` Intent, `Block If`, `Never`, the workload-store matrix row,
the DW-621 task bullets, the fifth acceptance criterion and the DW-621 design note were
amended to say this in one reading. The saved attempted patch already implements exactly
this shape (its docblock names DW-711 as where the fix lands), so it is restored rather than
re-implemented; the nine review findings in the triage log below are still to be processed.

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 1: (high 1, medium 0, low 0)
- bad_spec: 0
- patch: 9: (high 0, medium 4, low 5)
- defer: 2: (high 0, medium 0, low 2)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - none

Attempted change saved to [spec-dw-621-712-713-llm-config-resolution-ladders.attempted.patch](spec-dw-621-712-713-llm-config-resolution-ladders.attempted.patch); code reverted to `e92745f6760a2e12906faa66fe3271907e568dd8`.

The intent_gap (high) is the DW-621 leg. The nine patch findings and two defers were not
processed — the cascade makes them moot behind the gap — and are recorded here so the
re-dispatch does not have to rediscover them:
- (medium) The DW-713 stored-model leg applies to EVERY provider, not just `custom`, but all
  four new tests seed `provider: "custom"`. Narrowing the leg to `custom` keeps the whole
  suite green while an agent pinning `provider: "anthropic"` with no model silently reverts
  from `cfg.model` to `DEFAULT_MODELS.anthropic` — the divergence DW-713 exists to close, at
  the only production door (`agent-runtime.ts:156`) that can reach the branch.
- (medium) `storedModel` now outranks `OLLAMA_MODEL` for an explicitly named `ollama` /
  `ollama-cloud` provider. That IS `getResolvedCredentials`' order, but no test sets the two
  together, so the ordering can be reversed green.
- (medium) `getConfiguredModel({workload: "chat"})` now inherits the primary's model where
  `workloadModelSettings` deliberately resolves `null` (DW-403), so the retrieve payload can
  report `configured: false` for a workload call that now builds.
- (medium) `await loadConfig()` runs on every `/api/retrieve` POST — i.e. every Chat turn —
  and `readStoredConfig` bypasses `_configCache`, so this adds one unconditional storage read
  (a round-trip on the R2 provider) per request.
- (low) `getResolvedCredentials(cfg)` with `cfg === undefined` is a third independent entry
  into the 5 s-TTL cache on that branch.
- (low) The new `hasLLMKey` docblock lists `source-monitors.ts` as one of its consumers; that
  file calls `getConfiguredModel` only.
- (low) `chatModelForRetrieve`'s new docblock claims the default parameter serves "any
  synchronous caller"; no such caller exists.
- (low) `mockResolvedValueOnce` is armed before unrelated awaited setup and
  `mockedLoadConfigAsync` is not reset in `beforeEach`, so an unconsumed one-shot leaks.
- (low) A whitespace-only stored model is trimmed away here but not in `getModel`, so the two
  ladders diverge again on that input.
- (defer, low) `runVectorPhase` / `getVectorSearchSettings` still read `loadConfigSync()` cold
  in the same payload (`src/lib/wiki-retrieve.ts:311`) — pre-existing, named Never by this spec.
- (defer, low) `loadConfig()` flattens an UNREADABLE store to `{}`, so the cold path still
  reports `configured: false` for a store that exists; `readConfig()` is what
  `src/app/api/status/route.ts` uses to tell those apart.

## Design Notes

**Why DW-621 is a pin, not a change.** The gate's ~20 callers all resolve their model through the PRIMARY ladder — `callLLM`/`callLLMStream`/`callVisionLLM` → `getModel` → `getResolvedCredentials`, or `getConfiguredModel()` with no options (`action-extractor.ts:41`, `todo-extract.ts:136`, `source-monitors.ts:385`). That ladder resolves `cfg.provider ?? env.provider` and ignores `chatProvider`/`ingestProvider` entirely; nothing in `src/` passes `workload:` yet, by design. So for a store with `chatProvider: "ollama"` and no primary, a `true` answer would send `analyzeSource` (`ingest.ts:1767`, no try/catch) into `callLLM` and throw `No LLM API key found…` where it returns an empty analysis today — an ingest failure traded for a cosmetic honesty gain. The refusal at `chat.ts:866` is accurate as long as chat runs on the primary provider; making it accurate for a workload-only store is Epic 3's wiring, and the 2026-09-03 decision on DW-711 assigns that to DW-711's story: "Route by workload at the call sites … Resolve DW-621 the same way." That decision and this pin agree — the fix is at the call sites, not in this predicate — so what this bundle writes into the code is the pointer to it, not an argument against it. This bundle does not re-open the question and does not do DW-711's wiring.

**DW-713's ordering.** `options.model` stays first: it is the caller's explicit choice (an agent's model override, or the workload settings' own model) and is pinned by the existing suite. Below it, `getResolvedCredentials(cfg)` supplies exactly what the primary ladder would — `LLM_MODEL`, then `cfg.model` — and only when `provider === credentials.provider`, so `{provider: "anthropic", model: "claude-x"}` never hands `claude-x` to an OpenAI client. `custom` benefits precisely because `DEFAULT_MODELS.custom` is absent: it is the one provider with no tail to fall back on.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/llm.test.ts src/lib/__tests__/llm-key-cold-config.test.ts src/lib/__tests__/config.test.ts` -- expected: all pass, including the new cold-cache, stored-model and gate-pin cases.
- `npx tsc --noEmit` -- expected: no errors.
- `npm run lint` -- expected: no new warnings or errors.

## Auto Run Result

Status: blocked
Blocking condition: intent gap

**What was attempted.** DW-712 and DW-713 were implemented and verified; DW-621 was resolved
as a documented refusal rather than a code change. All of it is reverted; the diff is saved at
[spec-dw-621-712-713-llm-config-resolution-ladders.attempted.patch](spec-dw-621-712-713-llm-config-resolution-ladders.attempted.patch)
against baseline `e92745f6760a2e12906faa66fe3271907e568dd8`.

- `src/lib/wiki-retrieve.ts` -- DW-712: `assembleWikiContext` awaited `loadConfig()` once and
  threaded a non-empty snapshot into `chatModelForRetrieve`; `{}` stayed unthreaded.
- `src/lib/llm.ts` -- DW-713: `getConfiguredModel`'s explicit-provider branch took the primary
  ladder's model from `getResolvedCredentials(cfg)`, guarded on `provider === credentials.provider`.
- `src/lib/llm.ts` -- DW-621: docblock only, recording why the workload fields are not read.
- `src/lib/__tests__/wiki-retrieve.test.ts`, `.../llm.test.ts`, `.../llm-key-cold-config.test.ts`
  -- the cold-cache, stored-model and gate-pin cases.

**Why it is blocked.** `_bmad-output/implementation-artifacts/deferred-work.md:5870` carries an
ANSWERED human decision (2026-09-03, `effect: build`, `bundle_name: ""` — authorised but never
bundled): *"Route by workload at the call sites … Resolve DW-621 the same way. Pin that a
chatProvider-only store passes both gates and reaches the provider it names."* This bundle's
intent asks for the opposite shape — widen `hasLLMKey` to read `chatProvider` / `ingestProvider`
— and investigation ruled that out on its own evidence: every one of the gate's ~24 consumers
resolves through the PRIMARY ladder, so a `true` answer sends `analyzeSource`
(`src/lib/ingest.ts:1767`, no `try` around its `callLLM`) into a throw where it degrades today.
Neither reading is available to this run: the decision's resolution is DW-711's story, which
this run's own triage lists under `decisions`, not under bundles, and which reopens scope Epics
2 and 3 closed. The spec resolved the conflict by choosing a third answer — pinning the refusal
in a docblock and a test comment — which writes an argument into the codebase that the answered
decision has already overturned. That choice lives inside `<intent-contract>` (Intent, and the
`Block If` clause forbidding the workload wiring), so it cannot be repaired without a human.

**Unresolved questions for the orchestrator:**
1. Should DW-621 be unbundled from this bundle and ride with DW-711's answered "route by
   workload at the call sites" story, leaving DW-712 and DW-713 to be re-dispatched as a
   two-entry bundle? (The attempted patch already contains both, reviewed.)
2. If DW-621 must be resolved in this bundle, is this run authorised to do DW-711's wiring —
   `workload` threaded through the production `chat.ts` / `ingest.ts` call sites, both the
   `ChatCanvas` gate and the `chat.ts` gate reading one resolved answer — i.e. to resolve
   DW-711 as well, and to reopen scope `sprint-status.yaml` marks done for Epics 2 and 3?
3. If neither: is the documented-refusal outcome an acceptable resolution for DW-621, given it
   contradicts the 2026-09-03 decision, and should that decision be withdrawn?

**Review findings breakdown:** patches applied 0 (moot behind the intent gap); items deferred 0
recorded to frontmatter (the cascade stops before the defer branch — both are written into the
Review Triage Log instead); items rejected 5.

**Follow-up review recommendation:** false — no finding was triaged `patch` and fixed in this
pass (patched high count 0; score 0).

**Verification performed (before the revert):**
- `npx vitest run src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/llm.test.ts src/lib/__tests__/llm-key-cold-config.test.ts src/lib/__tests__/config.test.ts` — 241 passed.
- Full suite `npx vitest run` — 386 files, 9584 passed, 1 skipped.
- `npx tsc --noEmit` — clean. `npm run lint` — no errors or warnings.
- Every I/O matrix row had a covering case that ran and passed.

**Residual risks:** the working tree is back at the baseline, so DW-712 (medium — the public
retrieve API reporting `configured: false` for a configured wiki on a cold process) remains
open and unfixed. The attempted patch is reviewed but unverified against any later HEAD, and
the nine patch findings logged above are NOT applied in it.
