---
title: 'Chat and Ingest run on the workload provider they name (DW-711)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `SETTINGS_MODEL_INHERIT_COPY` promises that leaving a workload's provider
      unset inherits "the primary provider and model", but a saved workload
      MODEL alone already overrides the model while inheriting the provider.
    evidence: |-
      `workloadModelSettings` (`src/lib/config.ts`) sets
      `usesPrimary = provider === undefined && model === undefined`, so a store
      holding only `chatModel` reports and now routes that saved model while the
      provider inherits. The sentence under both model pickers
      (`src/lib/workbench-settings.ts:333-334`) describes both halves as
      inherited. PRE-EXISTING: the resolver has reported the saved model this way
      since Story 1.9; DW-711 only made the same store also select the model a
      call uses, which raises the copy's cost without having caused it.
    location: >-
      src/lib/workbench-settings.ts:334
    severity: low
baseline_revision: '4a38ad909ca97ae6cf37fde78ff6cb660d4b9842'
---

<intent-contract>

## Intent

**Problem:** `chatProvider` / `ingestProvider` change what the UI REPORTS and never which model a call USES. No production call site passes `workload` to `getConfiguredModel` (`src/lib/llm.ts:479` says so in as many words), so Epics 2 and 3 closed with the routing unbuilt. The visible consequence is two gates answering two different questions on one send: `ChatCanvas.tsx:291` refuses on `!assembled.chatModel.configured` — the WORKLOAD answer, from `getChatModelSettings` — while `chat.ts:866` refuses on `hasLLMKey()`, the PRIMARY answer. A store holding `chatProvider: "ollama"` and no `provider` passes the first and is told "No LLM provider is configured." by the second.

**Approach:** Wire the workload route at the two call sites `config.ts:1604` and `config.ts:1615` name as Epic 3's and Epic 2's — `src/lib/chat.ts` and `src/lib/ingest.ts`. Give `callLLM` / `callLLMWithFinish` / `callLLMStream` an optional `workload`, resolved through the one ladder `getConfiguredModel` already owns, and give `hasLLMKey` an optional `workload` so the runtime gate asks the same resolver the UI gate reads. A workload with nothing saved still inherits the primary, so every existing deployment and every one of the gate's ~20 other consumers keeps today's answer byte for byte.

## Boundaries & Constraints

**Always:**
- `hasLLMKey()` WITH NO ARGUMENT is unchanged in answer and in cost: same env fast path that touches no storage, same store legs, same `false` for a workload-only store. Only an explicit `{workload}` argument changes what it asks.
- A workload with no saved override (`usesPrimary`, or a settings answer with no provider) resolves EXACTLY as today — the gate falls back to the primary question and the model falls through to `getModel(cfg)`. The change is visible only to a store that actually saved `chatProvider`/`chatModel` or `ingestProvider`/`ingestModel`.
- One ladder, derived not restated: the workload branch already lives in `getConfiguredModel`. Extract it so `callLLM` and friends reach the SAME code, never a second copy.
- One config generation per resolution: the snapshot each door already warms via `configSnapshot()` is threaded into the workload resolver, the credential resolvers and the base-URL accessors, and an EMPTY answer stays unthreaded (`configSnapshot`'s own rule, `src/lib/llm.ts:314-341`).
- Every refusal sentence in `llm.ts`, `chat.ts` and `ingest.ts` stays worded exactly as it is today, including "No LLM provider is configured." and "Hermes is unavailable and no fallback LLM is configured."
- Comment anchors that assert the routing is UNBUILT (`llm.ts:249-270`'s `hasLLMKey` docblock, `llm.ts:475-481`'s `LlmWorkload` docblock, `config.ts:69` and `config.ts:72`, `config.ts:1601-1618`, and the two test comments at `llm-key-cold-config.test.ts:144-172` and `settings-runtime-wiring.test.ts:566-569`) must be rewritten to what is true after this change. Leaving one claiming "nothing in `src/` passes `workload`" is a lie this spec creates.

**Block If:** making the two gates agree would require changing the answer for a store that saved NO workload override — that would touch the ~20 primary consumers this bundle exists to leave alone, and is a different decision from the one taken on 2026-09-03.

**Never:**
- Do not route `callVisionLLM` / `src/lib/vision.ts` by the ingest workload. Vision needs a MULTIMODAL model and Story 1.9 defines no vision workload; sending an owner's text-synthesis choice to an image call would refuse work that runs today. It stays on the primary.
- Do not route `src/lib/query.ts`, `src/app/api/query/stream/route.ts`, `src/lib/query-search.ts`, `src/lib/search.ts`, `src/lib/lint-checks.ts`, `src/lib/lint-fix.ts`, `src/lib/merge.ts`, `src/lib/knowledge-compilation.ts`, `src/lib/todo-extract.ts`, `src/lib/action-extractor.ts`, `src/lib/research-runtime.ts` or `src/lib/source-monitors.ts` by any workload. `config.ts` names two call-site owners and these are neither.
- Do not change `getConfiguredModel`'s public signature, `getModel`'s refusals, the primary ladder in `getResolvedCredentials`, or `workloadModelSettings`' resolution rules.
- Do not touch `runVectorPhase` / `getVectorSearchSettings`' cold read in `src/lib/wiki-retrieve.ts` — a separate open entry.
- Do not change `chatModelForRetrieve` or `assembleWikiContext`: the UI gate already reads the workload answer, and that is the side of the disagreement that was right.
- Do not make `hasLLMKey` non-async or drop any `await` — `llm-key-cold-config.test.ts`'s source scan is the pin.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| The DW-711 store, chat | Store `{chatProvider: "ollama", chatModel: "llama3"}`, no `provider`, no LLM env vars | `getChatModelSettings().configured` is `true` (the UI gate) AND `hasLLMKey({workload:"chat"})` is `true` (the runtime gate); `callLLM(..., {workload:"chat"})` builds an Ollama client on `llama3` | No error expected — no refusal is reached |
| The same store, primary gate | Same store | `hasLLMKey()` with no argument is still `false` | Its ~20 consumers keep degrading exactly as today |
| The DW-711 store, ingest | Store `{ingestProvider: "custom", ingestModel: "m", customApiKey, customBaseUrl}` | `hasLLMKey({workload:"ingest"})` is `true`; `analyzeSource` runs and `callLLM` builds the custom client on `m` | No error expected |
| Workload saved but unusable | Store `{chatProvider: "openai"}`, `OPENAI_API_KEY` unset | `hasLLMKey({workload:"chat"})` is `false`; `chat.ts` refuses with the unchanged "No LLM provider is configured."; ingest's equivalent degrades rather than throwing | Existing refusal / existing degrade |
| Nothing saved for the workload | Store `{provider: "custom", model: "m", customApiKey, customBaseUrl}`, no `chatProvider`/`chatModel` | `hasLLMKey({workload:"chat"})` equals `hasLLMKey()`, and `callLLM(..., {workload:"chat"})` builds the identical client `callLLM(...)` builds | No error expected |
| Workload chosen while a primary exists | Store `{provider:"anthropic", model:"m", ingestProvider:"ollama", ingestModel:"llama3"}`, `ANTHROPIC_API_KEY` set | Ingest runs on `ollama`/`llama3`, not on the primary — the setting selects the model a call uses | No error expected |
| Cold cache under an expiring TTL | Any workload-routed store, clock past the 5 s TTL on every read after the warm | Key, base URL and model all come from the one warmed generation | No error expected |

</intent-contract>

## Code Map

- `src/lib/llm.ts:230-296` — `hasLLMKey` (docblock from 230, body at 272). Docblock currently argues at length that the workload fields are NOT read here and names DW-711 as the story that fixes it at the call sites; body is env fast path → `await loadConfig()` → `cfg.provider === "ollama"` → `cfg.provider === "custom" && providerIsConfigured("custom", cfg)`. Gains an optional `{workload}`; the no-argument answer and the storage-free env fast path must both survive.
- `src/lib/llm.ts:314-341` — `configSnapshot()`: the empty-answer rule (`{}` stays unthreaded). Reuse, do not restate.
- `src/lib/llm.ts:351-464` — private `getModel(cfg?)`. The primary route. Unchanged.
- `src/lib/llm.ts:475-482` — `LlmWorkload` docblock: "Nothing in `ingest.ts` or `chat.ts` passes `workload` yet, deliberately … rewiring them here would pre-empt two stories." This story IS those two stories' wiring; rewrite it.
- `src/lib/llm.ts:485-619` — `getConfiguredModel`. `await configSnapshot()` at 494, then a FULLY SYNCHRONOUS body: the workload branch at 498-509 (`getChatModelSettings`/`getIngestModelSettings`, `!settings.usesPrimary && settings.provider`), the explicit-provider switch at 511-616, and `return getModel(cfg)` at 618. Extracting everything after the await into a private sync `resolveConfiguredModel(options, cfg)` is what lets the `callLLM` family reach one ladder. Verified sync: `apiKeyForProvider`, `getResolvedCredentials`, `getChatModelSettings`, `getCustomBaseUrl`, `getOllamaBaseUrl`, `getModel` and every `create*` are all synchronous.
- `src/lib/llm.ts:653-687` — `callLLMWithFinish`; `const cfg = await configSnapshot(); const model = getModel(cfg);` then `retryWithBackoff(generateText)`. One of the three doors that gain `workload`.
- `src/lib/llm.ts:700-706` — `callLLM`, a pass-through to `callLLMWithFinish`; widen its `options` type with it.
- `src/lib/llm.ts:716-746` — `callVisionLLM`: same shape, deliberately NOT widened (see `Never`).
- `src/lib/llm.ts:792-810` — `callLLMStream`; same `configSnapshot()` + `getModel(cfg)` pair.
- `src/lib/config.ts:1554-1600` — `workloadModelSettings`: `usesPrimary` is `provider === undefined && model === undefined`; `configured` is `providerIsUsable(resolvedProvider, resolvedModel, cfg)`. This is the answer both gates must share. Read-only.
- `src/lib/config.ts:1601-1618` — `getChatModelSettings` / `getIngestModelSettings` docblocks: "Epic 3 owns the call sites — nothing in `chat.ts` reads this yet, by design" and Epic 2's twin. Rewrite both. `src/lib/config.ts:69,72` carry the same claim on the `AppConfig` fields.
- `src/lib/config.ts:1392-1400` — `providerIsUsable`: credentials AND a model name; `custom` has no `DEFAULT_MODELS` entry, so it needs a stored model to be usable. This is why an inheriting workload can be `configured: false` where `hasLLMKey()` is `true`, and why the fallback-to-primary rule in the gate matters.
- `src/lib/chat.ts:855-870` — `generateChatAnswer`'s tail: `hermesConfigured()` branch with a `hasLLMKey()` fallback gate at 862 and `callLLM` at 863; the native branch's gate at 866 and `callLLM` at 867. All four are the chat call site. Reached only through `addChatTurn` (`chat.ts:880`), which has NO production caller today (`workbench-epic3.test.ts:270` pins the route away from it) — the live Chat surface drives the sidecar. Wire it anyway: it is the file `config.ts` names, it is exported and tested, and the disagreement is real in it.
- `src/lib/ingest.ts:1118-1140` — `adjudicateMerge`: gate at 1124 (returns `null` → fork), `callLLM` at 1134.
- `src/lib/ingest.ts:1350-1372` — `reconcilePage`'s `callLLM` at 1369; its gate is the caller's `canReconcileWithLlm` at 2513.
- `src/lib/ingest.ts:1793-1812` — `analyzeSource`: gate at 1798 (returns `emptyIngestAnalysis`), `callLLM` at 1809. NO `try` around the call — the reason the gate must stay a degrade, not become a throw.
- `src/lib/ingest.ts:1884-1962` — `synthesizeBody`: gate at 1892 (falls back to `generateFallbackPage`), `callLLM` at 1907, the map call at 1922 and the reduce call at 1956.
- `src/lib/ingest.ts:2513` — `const canReconcileWithLlm = await hasLLMKey();`, the reconcile gate.
- `src/lib/wiki-retrieve.ts:554-586` — `chatModelForRetrieve`, the UI gate's source. READ-ONLY: it already asks `getChatModelSettings`. `assembleWikiContext:588-614` warms the config and threads it.
- `src/components/workbench/ChatCanvas.tsx:291-295` — `if (!assembled.chatModel.configured) setError(CHAT_MODEL_MISSING_COPY)`. READ-ONLY; this is the gate that was already right.
- `src/lib/__tests__/llm-key-cold-config.test.ts:144-172` — "still refuses a WORKLOAD-only selection", whose comment says DW-711 fixes this at the call sites. Extend, and rewrite the comment.
- `src/lib/__tests__/llm-key-cold-config.test.ts:340-445` — the `hasLLMKey\s*\(` / `await\s+hasLLMKey\s*\(` source scan. An argument does not break it; a dropped `await` still fails it.
- `src/lib/__tests__/settings-runtime-wiring.test.ts:205-250` — `store()`, `CUSTOM`, and the mocked provider SDKs (`createOpenAIMock`, `createOllamaMock`) whose constructor arguments are directly assertable. `:384-410` is the existing workload-routing case; `:412-442` is `underAnExpiringCache`; `:566-569` carries the stale "nothing in `src/` passes `workload`" comment.
- `src/lib/__tests__/ingest.test.ts:70-73,141-143` — `vi.mock("../llm", …)` with `hasLLMKey`/`callLLM` spies and the `ingest()` drivers. Where the ingest call-site pin goes; an argument change needs no mock change.
- `src/lib/__tests__/query-search.test.ts:1-60` and `src/lib/__tests__/chat-store.test.ts:20-36` — the two halves of the recipe for a chat call-site pin: module-mock `../llm`, temp `DATA_DIR` + `_resetStorage()`, `writeWikiPage`/`ensureDirectories` to seed a readable page, `createChatConversation` then `addChatTurn`.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm.ts` — Extract everything after `await configSnapshot()` in `getConfiguredModel` into a private synchronous `resolveConfiguredModel(options, cfg)` and have `getConfiguredModel` call it; its signature, behaviour and every refusal stay identical. Give `callLLMWithFinish`, `callLLM` and `callLLMStream` an optional `options.workload?: LlmWorkload` and resolve their model through `resolveConfiguredModel({ workload: options?.workload }, cfg)` instead of `getModel(cfg)` — with no workload that expression IS `getModel(cfg)`, which is what keeps every existing caller unchanged. Leave `callVisionLLM` on `getModel`. — One ladder, reached from the doors chat and ingest actually call.
- `src/lib/llm.ts` — Give `hasLLMKey` an optional `{ workload?: LlmWorkload }`. With no workload: today's function, env fast path first and no storage read. With one: read the store, take `getChatModelSettings(cfg)` / `getIngestModelSettings(cfg)`, and answer `settings.configured` ONLY when the workload actually overrides (`!settings.usesPrimary && settings.provider`); otherwise answer the primary question exactly as the no-argument call does. Rewrite the docblock: the predicate now answers for whichever route the caller names, the default is still the primary, and the DW-711 paragraph describing the disagreement as unfixed is replaced by what closed it. — The runtime gate and the UI gate reach one resolver for the store that broke.
- `src/lib/chat.ts` — Pass `{ workload: "chat" }` to both `hasLLMKey` calls and both `callLLM` calls in `generateChatAnswer`. Sentences unchanged. — Epic 3's call site.
- `src/lib/ingest.ts` — Pass `{ workload: "ingest" }` to all four `hasLLMKey` calls (`adjudicateMerge`, `analyzeSource`, `synthesizeBody`, the `canReconcileWithLlm` read) and add `workload: "ingest"` to the options of all six `callLLM` calls (`adjudicateMerge`, `reconcilePage`, `analyzeSource`, `synthesizeBody`'s single-chunk, map and reduce calls). — Epic 2's call site; a gate and the call it guards must not answer to different providers.
- `src/lib/config.ts` — Rewrite the four stale claims: the `chatProvider` / `ingestProvider` field comments at `:69` and `:72`, and the `getChatModelSettings` / `getIngestModelSettings` docblocks that say the call sites are unwired. Record which files read them and that an unset workload still inherits the primary. No behaviour change in this file. — A comment asserting the opposite of the code is the defect this bundle is closing, one layer down.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — Add a DW-711 suite over the real config store and the mocked SDKs covering every matrix row: the chat and ingest workload-only stores reaching the provider they name through `callLLM`; `hasLLMKey()` still `false` beside `hasLLMKey({workload})` `true` on the same store; the unusable-workload row `false`; the inherit row proving `{workload:"chat"}` and no workload build the identical client; the workload-beats-primary row; and one workload-routed `callLLM` under `underAnExpiringCache`. Rewrite the stale `:566-569` comment. — Without these the wiring is assertable only through mocks that cannot see a provider.
- `src/lib/__tests__/llm-key-cold-config.test.ts` — Extend the workload-only case: the bare `hasLLMKey()` stays `false` for both a `chatProvider`- and an `ingestProvider`-only store, and `hasLLMKey({workload})` now answers `true` for the matching one and still `false` for the other. Rewrite the comment to record the closed shape and why the bare answer must not move. — The decision not to widen the DEFAULT is still the pin; only the named-workload answer changed.
- `src/lib/__tests__/ingest.test.ts` — Add a case asserting `ingest()` reaches `hasLLMKey` and `callLLM` with `{ workload: "ingest" }` (the existing `../llm` module mock already records both). — The call-site wiring, pinned where a revert is green otherwise.
- `src/lib/__tests__/chat-workload-routing.test.ts` (new) — Module-mock `../llm`, seed a temp `DATA_DIR` wiki with one readable page, create a conversation and drive `addChatTurn`, asserting `hasLLMKey` and `callLLM` were both called with `{ workload: "chat" }`. — The chat half of the same pin; `generateChatAnswer` is not exported, so `addChatTurn` is the door.

**Acceptance Criteria:**
- Given a store holding only `chatProvider: "ollama"` and `chatModel: "llama3"` with no LLM env vars, when the Chat send path runs, then the payload ChatCanvas gates on (`assembleWikiContext(...).chatModel.configured`) and the runtime gate (`hasLLMKey({workload:"chat"})`) both answer `true` and the send reaches an Ollama client built on `llama3` — one resolved answer, no refusal between them.
- Given any store that saved no workload override, when `hasLLMKey({workload})` or a workload-routed `callLLM` runs, then the answer and the constructed client are identical to the no-workload call — proven by a test that would fail if the workload branch changed the inheriting case.
- Given the ~20 consumers that call `hasLLMKey()` with no argument, when the store names a provider only through `chatProvider` or `ingestProvider`, then the gate still answers `false` and they still degrade rather than throw.
- Given an env-configured deployment, when `hasLLMKey()` is called with no argument, then it still answers without touching storage.
- Given `pnpm test`, `pnpm lint` and `npx tsc --noEmit` are run, then all pass. `pnpm build` is NOT a criterion: it fails identically at the baseline commit for the unrelated `node:timers/promises` reason recorded in `spec-dw-618-619-621-single-snapshot-model-client.md`. Confirm that at the baseline before excusing it.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `reconcilePage` hardcoded `workload: "ingest"`, but it has a
    SECOND caller — `mergePages` (`src/lib/merge.ts:560`), gated by the
    argument-less `hasLLMKey()` at `:456`, a file this spec's `Never` names as not
    a workload owner. That recreated the very gate/call disagreement this story
    closes: with `{provider:"anthropic", ingestProvider:"openai"}` and no
    `OPENAI_API_KEY`, merge's gate opens and the fold throws into its own catch,
    which silently appends the two bodies. Made the route caller-supplied
    (`options.workload`), passed `"ingest"` from `ingest()` only, left `merge.ts`
    on the primary, corrected the comment that claimed both callers ask the same
    workload, and added a `merge.test.ts` case that fails if the hardcoding
    returns.
  - `[medium]` `[patch]` The model-only override was unpinned. `usesPrimary` is
    `provider === undefined && model === undefined`, so a store saving only
    `chatModel` IS an override on both new paths — yet replacing
    `!settings.usesPrimary && settings.provider` with
    `settings.providerSource === "config" && settings.provider` at both sites left
    the entire suite green. Added a `settings-runtime-wiring` case proving the two
    doors build different models from one store, and an `llm-key-cold-config` case
    for the gate; both red under that mutation.
  - `[low]` `[patch]` The new docblocks read as though the owner-visible chat
    disagreement is closed everywhere. It is closed in `src/lib/chat.ts`, which no
    production caller reaches — a real send drives the sidecar, whose
    `chat-provider.mjs` runs its own `chatProvider || env || "anthropic"` ladder
    and never reads `config.provider`. Reworded in `config.ts`, `llm.ts` and
    `chat.ts` to name the in-process door and put the sidecar's ladder out of
    scope.
  - `[low]` `[patch]` A saved override with both custom credential halves and no
    model name closes the workload gate and yields the generic refusal where the
    primary route names the actual gap. Newly reachable and unrecorded; the
    `hasLLMKey` docblock now records the trade and what the gate agreement buys.
  - `[low]` `[patch]` `callLLMStream`'s new `workload` had no caller and no test, so
    a regression in that one line was invisible. Added a case and a docblock note
    that the option exists to keep the three doors symmetric.
  - `[low]` `[patch]` The Hermes case's `for (const call of mockedCallLLM.mock.calls)`
    passed vacuously on zero calls. Added a call-count assertion.

Rejected (6, all low by consequence): the `workload === "chat" ? … : …` ternary
having no default for a hypothetical third `LlmWorkload` member (pre-existing
shape, closed union); `getChatModelSettings`' default parameter firing when
`configSnapshot()` answers `undefined` (that IS `configSnapshot`'s documented
rule, and an empty store carries no override); `analyzeSource`'s un-guarded
`callLLM` racing the 5 s TTL against its gate (pre-existing window, unchanged in
width); the absence of a negative pin that `callVisionLLM` stays un-routed (an
explicit `Never`, reasoned in the docblock); the residual gate disagreement for a
`custom` primary with no model, where the UI refuses and the runtime would pass
(the safe direction, chosen and documented); and the observation that the routing
rides on `callLLM` rather than on `getConfiguredModel`'s own signature (both reach
`resolveConfiguredModel` — a mechanism preference).

## Design Notes

**Why the gate falls back to the primary when the workload inherits.** `getChatModelSettings().configured` is `providerIsUsable(provider, model, cfg)` — credentials AND a model name. `hasLLMKey()` asks only the credential question. For a store of `{provider: "custom", customApiKey, customBaseUrl}` with no model the two disagree: `configured` is `false` (no `DEFAULT_MODELS.custom`) while the gate is `true` and `getModel` throws the specific "The Custom provider needs a model name." Making an inheriting workload answer `configured` would replace that sentence with a generic refusal and would change the answer for stores that saved nothing — the `Block If`. Falling back to the primary question keeps the inherit case byte-identical and closes exactly the direction DW-711 names: the UI passing where the runtime refuses, which can only happen when a workload override IS saved.

**Why the extraction rather than a second call to `getConfiguredModel`.** `callLLMWithFinish` already holds a `configSnapshot()`. Calling `getConfiguredModel({workload})` from it would take a second one — a second storage read and a second config generation, undoing DW-618. The body after that await is already synchronous, so lifting it into `resolveConfiguredModel(options, cfg)` gives both entry points one ladder and one snapshot:

```ts
const cfg = await configSnapshot();
const model = resolveConfiguredModel({ workload: options?.workload }, cfg);
```

**The gate now costs a storage read on the chat and ingest paths for env-configured deployments**, where the env fast path used to answer for free. Both paths make an LLM request immediately after and already read the store again inside `callLLM`; `extractStructuredKnowledge` has the same `await loadConfig()` + settings + `getConfiguredModel` shape today. The no-argument fast path is untouched, which is what the ~20 other consumers — several inside loops — actually pay for.

**`addChatTurn` has no production caller.** The live Chat surface posts `chatTurnRequest` to the sidecar; `generateChatAnswer` is the retired in-process generation. The ledger's "same click" narrative is therefore imprecise about the runtime, but `chat.ts` is the file `config.ts:1604` names as Epic 3's call site, the disagreement is real in its code, and leaving it unwired would leave the entry re-mintable. Wire it; do not resurrect or retire it.

## Verification

**Commands:**
- `pnpm test` — expected: full suite green, including `settings-runtime-wiring`, `llm-key-cold-config`, `llm`, `ingest`, `chat-workload-routing` and `wiki-retrieve`.
- `pnpm lint` — expected: no new errors or warnings.
- `npx tsc --noEmit` — expected: exit 0; this is what type-checks the widened `hasLLMKey` and `callLLM` signatures against every existing call site.
- Targeted single-argument reverts (drop `{workload:"chat"}` from one `chat.ts` call, drop `workload: "ingest"` from one `ingest.ts` call, narrow the gate's fallback) — expected: each turns a new case red, so none of them is vacuous.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Chat and Ingest now run on the workload provider they name (DW-711). `hasLLMKey`
takes an optional `{workload}` and answers that workload's own question from
`getChatModelSettings` / `getIngestModelSettings` — the same resolver the retrieve
payload `ChatCanvas` gates on reads — so the runtime gate and the UI gate cannot
refuse each other's stores. `getConfiguredModel`'s post-`await` body was lifted
into a private synchronous `resolveConfiguredModel(options, cfg)`, which
`callLLMWithFinish`, `callLLM` and `callLLMStream` now resolve through, so a
workload-routed call reaches one ladder from the one snapshot the door already
warms (DW-618 preserved). `src/lib/chat.ts` passes `{workload: "chat"}` on both
gates and both calls; `src/lib/ingest.ts` passes `{workload: "ingest"}` on its
four gates and six calls, with `reconcilePage`'s route supplied by its caller so
`mergePages` — not a workload owner — stays on the primary. A workload that saved
nothing inherits the primary all the way, env leg included, so the bare gate's
~20 consumers and every existing deployment are unchanged.

### Files changed

- `src/lib/llm.ts` — `hasLLMKey(options?: {workload})`; private `resolveConfiguredModel`; `workload` on the three `callLLM*` doors; `callVisionLLM` deliberately left on the primary; four docblocks rewritten.
- `src/lib/chat.ts` — `{workload: "chat"}` on both gates and both `callLLM` calls in `generateChatAnswer`; both refusal sentences unchanged.
- `src/lib/ingest.ts` — `{workload: "ingest"}` on four gates and six calls; `reconcilePage` gained `options.workload` so its two callers keep their own routes.
- `src/lib/config.ts` — the four stale "the call sites are unwired" claims rewritten. No behaviour change.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — a DW-711 suite over the real store and mocked SDKs covering every matrix row, plus the model-only override, the `callLLMStream` route and a workload-routed client under an expiring cache.
- `src/lib/__tests__/llm-key-cold-config.test.ts` — the bare gate still `false` for a workload-only store beside the named answer's `true`; inherit-equals-primary; a credential-less override; an env key not answering for an override.
- `src/lib/__tests__/ingest.test.ts` — a workload-discriminating gate mock proving every `callLLM` `ingest.ts` makes carries the workload.
- `src/lib/__tests__/merge.test.ts` — the fold `mergePages` makes names no workload, matching its own bare gate.
- `src/lib/__tests__/chat-workload-routing.test.ts` (new) — `addChatTurn` drives both branches and the frozen refusal, asserting the gate and the call name one workload.

### Review findings breakdown

Patches applied: 6 (0 high, 2 medium, 4 low). Items deferred: 1 (low). Items
rejected: 6 (all low) — chiefly pre-existing shapes and the two trades this
spec's Design Notes and the code's own docblocks choose explicitly.

### Follow-up review recommendation

`false`. Patched findings by severity: high 0, medium 2, low 4. No high-severity
patch, so no further pass is recommended; the two mediums were fixed and pinned
in this pass.

### Verification performed

- `npx tsc --noEmit` — exit 0, both before and after the patch pass. This is what type-checks the widened `hasLLMKey` and `callLLM` signatures against every existing call site.
- `pnpm lint` — clean; only the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from baseline.
- `pnpm test` — 398/398 files, 9938 passed, 1 skipped, 0 failed.
- `pnpm build` not run, per the acceptance criterion: it fails identically at the baseline commit for the unrelated `node:timers/promises` reason, confirmed by stashing the diff and rebuilding.
- Non-vacuity: targeted reverts confirmed red then restored for each of the routed `chat.ts` and `ingest.ts` calls, the gate's inherit fallback, the env-fast-path guard, `callLLMStream`'s resolver line, `reconcilePage`'s caller-supplied route, and the `usesPrimary` override test at both `llm.ts` sites.
- Matrix audit: all seven rows covered by cases that ran and passed in the full-suite output.

### Residual risks

- The live Chat surface drives the sidecar, not `chat.ts`. `sidecar/chat-provider.mjs` reads `chatProvider`/`chatModel` first — so a `chatProvider`-only store already reached the provider it names there — but it runs a SECOND ladder that never reads `config.provider` and defaults to `anthropic`, so the "unset inherits the primary exactly" rule this story establishes in-process does not hold across it. Out of scope here and unpinned.
- The chat and ingest gates now cost one storage read on env-configured deployments, where the env fast path used to answer for free. Both paths make an LLM request immediately after and already read the store again inside `callLLM`; the no-argument fast path is untouched.
- `callLLMStream`'s `workload` has no production caller. It exists so the three doors stay symmetric, and is now pinned by a test rather than by prose alone.
