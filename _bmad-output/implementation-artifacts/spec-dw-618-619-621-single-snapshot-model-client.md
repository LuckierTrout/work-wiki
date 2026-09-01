---
title: 'One config snapshot per model client'
type: 'bugfix'
created: '2026-09-01'
status: done
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `assembleWikiContext` resolves its `chatModel` payload from a config cache
      nothing on that route ever warms, so a cold process reports a correctly
      configured provider as `configured: false`.
    evidence: |-
      `chatModelForRetrieve` is synchronous and its only production caller,
      `src/app/api/v1/projects/[wikiId]/retrieve/route.ts:51`, never awaits
      `loadConfig()` (grepped: the file contains no `loadConfig` call). On a
      process nothing else warmed, `loadConfigSync()` answers `{}` and re-stamps
      it for another 5 s (`src/lib/config.ts:1180-1186`), so `provider`,
      `model`, `configured` and `baseUrl` all describe an empty store and the
      public retrieve API tells a caller the wiki has no chat model. This is
      DW-548's class of defect — the one that forced `hasLLMKey` to become
      async — at a different surface. PRE-EXISTING: the bare
      `getChatModelSettings()` had the same cold read before DW-619 threaded a
      snapshot through it, and DW-619 neither caused nor names it. Not covered
      by the suite, which module-mocks `loadConfigSync`.
    location: >-
      src/lib/wiki-retrieve.ts:552
    severity: medium
baseline_revision: '09133de291256e2f078ad63b313facfeb6da8089'
---

<intent-contract>

## Intent

**Problem:** `getConfiguredModel` discards its `await loadConfig()` (`src/lib/llm.ts:415`) and then re-enters the 5 s-TTL config cache for `getChatModelSettings()`/`getIngestModelSettings()`, `apiKeyForProvider(provider)`, `getCustomBaseUrl()` and `getOllamaBaseUrl()` — so one `createOpenAI({apiKey, baseURL}).chat(model)` can be built out of several config generations, and on a straddle the later legs fall to the cold-cache `{}` and refuse a correctly configured provider (DW-618). `callLLM` / `callLLMStream` / `callVisionLLM` discard the same snapshot before `getModel()`, and `chatModelForRetrieve` builds one `AssembledContext["chatModel"]` from two or three separate reads (DW-619).

**Approach:** Thread the one snapshot each door already holds through the resolvers that accept a `cfg` since DW-334, adding the same optional/default `cfg` parameter to the two remaining doors (`getResolvedCredentials`, the private `getModel`) using the conventions `config.ts` already established. This is threading only — no gate, resolver or refusal changes its answer.

**DW-621 is NOT in this bundle.** It asked for `hasLLMKey` to be widened to `cfg.chatProvider` / `cfg.ingestProvider`; an escalation established that doing so would make the gate lie. See "The DW-621 finding" under Design Notes — the reasoning is load-bearing for the `Never` below.

## Boundaries & Constraints

**Always:**
- New `cfg` parameters follow the file's conventions exactly: `cfg: AppConfig = loadConfigSync()` where the function reads the store unconditionally (`getResolvedCredentials`), `cfg?: AppConfig` forwarded as-is where the callee already takes one. No call site outside the three changed source files has to change.
- Resolver semantics are unchanged: same env-over-store precedence, same `nonEmpty` trimming, same refusal sentences (`LLM_MODELS_POINTER`) in the same order. This is threading only.
- `hasLLMKey` is UNTOUCHED, body and comment. It already forwards its `cfg` into `providerIsConfigured` (DW-618's first named leg, closed by DW-548), so there is nothing left in it for this bundle to thread.
- Comment anchors other comments and tests cite by name (DW-326, DW-369, DW-503, DW-548, DW-334) stay accurate; the DW-334 note in `getResolvedCredentials` that defers this work must be rewritten, not left claiming an open follow-up this spec closes.

**Block If:** threading a `cfg` would require changing a resolver's precedence, refusal wording, or return value to keep existing tests green — that is a behaviour change this bundle does not authorise.

**Never:**
- Do not widen `hasLLMKey` to `cfg.chatProvider`, `cfg.ingestProvider` or `cfg.structuredKnowledgeProvider`. The gate answers "can the PRIMARY route make a call", and every one of its ~25 consumers takes that route immediately after. Widening it makes it return `true` for stores `getResolvedCredentials` still resolves to `provider: null`, so `getModel()` throws `No LLM API key found…` (`src/lib/llm.ts:302`) where those consumers today skip gracefully. Measured, not predicted — see Design Notes.
- Do not touch `runVectorPhase`'s `loadConfigSync()` / `getVectorSearchSettings()` pair in `wiki-retrieve.ts` — `getVectorSearchSettings` takes no snapshot; that is a separate open ledger entry.
- Do not thread `llmTimeoutOption()`; it answers a different question from the model client.
- Do not change `loadConfigSync`'s cold-cache `{}` answer or the 5 s TTL, and do not add a startup hook.
- Do not export `chatModelForRetrieve`, and do not add test-only counters or instrumentation to production config state.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workload client, cache expires after the warm | Stored `chatProvider:"custom"`, `chatModel`, `customApiKey`, `customBaseUrl`; clock advanced past the TTL on every read after `loadConfig()` | `getConfiguredModel({workload:"chat"})` builds `createOpenAI({apiKey, baseURL}).chat(chatModel)` from that one generation | No error expected |
| Primary client, cache expires after the warm | Stored `provider:"custom"`, `model`, both custom halves; same clock | `getConfiguredModel()` (and `callLLM`) build the same client from that one generation | No error expected |
| Chat-only workload selection, gate unchanged | Stored `{chatProvider:"ollama"}`, no provider env vars, no `provider` | `hasLLMKey()` is `false`, exactly as today — the primary route this gate speaks for cannot construct a client from that store | No error expected; consumers keep skipping |
| Workload provider that needs an env key | Stored `{chatProvider:"openai"}`, `OPENAI_API_KEY` unset | `getConfiguredModel({workload:"chat"})` still refuses with the unchanged "not configured on this server" sentence | Existing throw, unchanged |
| Retrieve chat-model payload | `getChatModelSettings` resolves `custom`; store holds `customBaseUrl` | `assembleWikiContext(...).chatModel` carries provider, model, `configured` and `baseUrl` resolved from ONE snapshot object | No error expected |

</intent-contract>

## Code Map

- `src/lib/llm.ts:248-271` — `hasLLMKey`. READ-ONLY for this bundle. Env fast path, then `const cfg = await loadConfig()`, then `cfg.provider === "ollama"` (258) and `cfg.provider === "custom" && providerIsConfigured("custom", cfg)` (270). DW-618's first named leg (forwarding `cfg` into `providerIsConfigured`) is ALREADY closed here, and DW-621's field widening was dropped from the bundle — nothing in this function changes.
- `src/lib/llm.ts:299-390` — private `getModel()`; calls `getResolvedCredentials()` with no snapshot and builds every provider's client from it. Needs an optional `cfg` to forward.
- `src/lib/llm.ts:409-499` — `getConfiguredModel`. `await loadConfig()` at 415 (result discarded); `getChatModelSettings()`/`getIngestModelSettings()` at 420-421; `apiKeyForProvider(provider)` at 432; `getCustomBaseUrl()` at 466; `getOllamaBaseUrl()` at 484; `return getModel()` at 498.
- `src/lib/llm.ts:518-519, 552-553, 627-628` — `callLLM`, `callVisionLLM`, `callLLMStream`; each is `await loadConfig(); const model = getModel();` — the same discarded snapshot, one argument each.
- `src/lib/llm.ts:1-31` — import block; `AppConfig` is not imported yet (`import type { ProviderValue } from "./config"` at 21 is the place to add it).
- `src/lib/config.ts:2575-2645` — `getResolvedCredentials()`; reads its own `loadConfigSync()` and already forwards that `cfg` to `apiKeyForProvider`, `getOllamaBaseUrl`, `getCustomBaseUrl`. Needs the `cfg: AppConfig = loadConfigSync()` default-parameter shape. Its docblock at ~2597-2603 carries the "Closing that is a follow-up" note that this spec closes.
- `src/lib/config.ts:672, 1413` — `getOllamaBaseUrl` / `getEffectiveProvider`: the `cfg: AppConfig = loadConfigSync()` convention to copy for unconditional readers.
- `src/lib/config.ts:1282, 1392` — `apiKeyForProvider` / `getCustomBaseUrl`: the `cfg?: AppConfig` + `(cfg ?? loadConfigSync())` convention for LAZY store reads; both already take a snapshot, so `llm.ts` only has to pass one.
- `src/lib/config.ts:1581, 1592` — `getChatModelSettings` / `getIngestModelSettings`, already `cfg: AppConfig = loadConfigSync()`.
- `src/lib/config.ts:37, 63-69` — `AppConfig`, with `chatProvider` (68) and `ingestProvider` (70) as independent workload selections beside `provider`. Context only: no production caller routes by them (see Design Notes).
- `src/lib/wiki-retrieve.ts:543-556` — `chatModelForRetrieve()`; `getChatModelSettings()`, then `getCustomBaseUrl()` or `getOllamaBaseUrl()`, no shared snapshot. Called once from `assembleWikiContext` at 565, before any other config read on that path.
- `src/lib/wiki-retrieve.ts:22-28` — config import block; `loadConfigSync` is already imported (used by `runVectorPhase` at 303, which is OUT of scope).
- `src/lib/__tests__/settings-runtime-wiring.test.ts:208-212, 233-240, 249-263, 381-402` — `store()` helper, the `CUSTOM` fixture, the existing `hasLLMKey` both-halves case, and the workload-routing case. Every provider SDK is mocked (`createOpenAIMock`, `createOllamaMock`), so the constructed client's `{apiKey, baseURL}` is directly assertable. New DW-618 cases go here; the existing `hasLLMKey` case stays exactly as it is.
- `src/lib/__tests__/config.test.ts:2072-2130` — the DW-334 `withClockSpy` / `frozen` / `jumpsAfterFirstRead` idiom: a `Date.now` spy counts `loadConfigSync` entries without production instrumentation. Read-only precedent for the clock technique.
- `src/lib/storage/filesystem.ts:190-227` — the only other `Date.now()` on any path reached here, and it is in the WRITE lock loop; `loadConfig()`'s read path makes exactly one clock call (`src/lib/config.ts:924`). That is what makes an always-advancing clock spy safe around `getConfiguredModel`.
- `src/lib/__tests__/wiki-retrieve.test.ts:9-29, 59-79` — `vi.mock("../config")` factory (mocks `getChatModelSettings`, `getVectorSearchSettings`, `loadConfigSync`) and the `beforeEach` that re-primes only the vector/loadConfig mocks. `getCustomBaseUrl`/`getOllamaBaseUrl` are NOT mocked yet and are used nowhere else in that file.
- `src/lib/__tests__/llm-key-cold-config.test.ts` — scans `src/` for un-awaited `hasLLMKey` calls. Read-only constraint: the function stays async.
- `src/lib/__tests__/llm.test.ts:604-714` — the keyless-guard suite; the refusal wording DW-503 owns must keep passing verbatim.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` — Give `getResolvedCredentials` a `cfg: AppConfig = loadConfigSync()` parameter (default-parameter convention: it reads the store unconditionally) and use it in place of its internal read. Rewrite the DW-334 paragraph in its docblock that says `getConfiguredModel`'s explicit-provider / workload branch "bypasses this function" and that closing it "is a follow-up" — that follow-up is closed here. — DW-618: this is the door `getModel()` resolves through.
- `src/lib/llm.ts` — Import `type AppConfig`. Give the private `getModel` an optional `cfg` forwarded to `getResolvedCredentials`, and change `getConfiguredModel` to keep the snapshot it warms and pass it to `getChatModelSettings`, `getIngestModelSettings`, `apiKeyForProvider`, `getCustomBaseUrl`, `getOllamaBaseUrl` and `getModel`. Do the same one-argument change in `callLLM`, `callLLMStream` and `callVisionLLM`, which discard the identical snapshot before `getModel()`. The snapshot comes from a private `configSnapshot()` helper, NOT from `await loadConfig()` raw: `loadConfig()` answers `{}` both for an absent config and for a store it could not read, and only the second of those leaves the previous generation warm behind `loadConfigSync()` — so an empty answer must stay unthreaded or a transient read failure becomes a refusal. See the Spec Change Log. — DW-618: one client must come from one generation.
- `src/lib/wiki-retrieve.ts` — Give `chatModelForRetrieve` a `cfg: AppConfig = loadConfigSync()` parameter and pass it to `getChatModelSettings`, `getCustomBaseUrl` and `getOllamaBaseUrl`; import `type AppConfig`. Leave `runVectorPhase` alone. — DW-619: provider, model, `configured` and `baseUrl` are one answer.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — Add a DW-618 suite that runs `getConfiguredModel` (workload route and primary route) and `callLLM` under a `Date.now` spy whose every read after the first lands past the 5 s TTL, asserting the SDK mock was constructed with the stored `{apiKey, baseURL}` and model. Add NO `hasLLMKey` cases — the gate is out of scope and its existing coverage is the pin. — The straddle is invisible to every existing assertion.
- `src/lib/__tests__/wiki-retrieve.test.ts` — Add `getCustomBaseUrl` and `getOllamaBaseUrl` to the `../config` mock factory as `vi.fn` wrappers over the real implementations, and a DW-619 case asserting `assembleWikiContext(...).chatModel` reports a `custom` provider with its `baseUrl`, and that the snapshot object handed to `getChatModelSettings` is the SAME object handed to `getCustomBaseUrl`. — Nothing else pins that the two resolvers share a snapshot.

**Acceptance Criteria:**
- Given a store holding only `chatProvider: "ollama"` and no LLM env vars, when `hasLLMKey()` is called, then it still returns `false` — unchanged from the baseline. Pinned by a case in `src/lib/__tests__/llm-key-cold-config.test.ts` (see the Spec Change Log; no existing suite covered a workload-only store). No `hasLLMKey` case is added to `settings-runtime-wiring.test.ts`.
- Given the config cache goes stale immediately after `getConfiguredModel` warms it, when a workload or primary `custom` client is resolved, then the key, base URL and model handed to the SDK all come from the stored generation rather than from the cold-cache `{}`.
- Given no argument is passed, when any changed function is called from an existing call site, then its answer is identical to today's.
- Given `pnpm test`, `pnpm lint` and `npx tsc --noEmit` are run, then all pass. (`pnpm build` is NOT a criterion here: it fails identically at the baseline commit — `UnhandledSchemeError: node:timers/promises` reached through `src/lib/storage/filesystem.ts` → `storage/index.ts` → `backups.ts` → `src/components/SystemHealthDesk.tsx`, a node-only module pulled into a client component. Verified by stashing this diff and rebuilding at `09133de2`. `tsc --noEmit` buys the half that matters here — the new `cfg` parameters type-checked against every existing call site.)

## Design Notes

Three sibling call sites (`callLLM`, `callLLMStream`, `callVisionLLM`) are included with `getConfiguredModel` even though DW-618 names only the latter: they are the same `await loadConfig(); getModel()` straddle, in the same file, one argument each, and fixing only one of four would leave the entry immediately re-mintable.

The DW-334 clock spy counts `loadConfigSync` entries but cannot be used directly across an `async` function that itself calls `loadConfig()`. Use an ALWAYS-ADVANCING clock instead — every read is 10 minutes after the previous one — so the cache `loadConfig()` stamps is stale by the time any `loadConfigSync()` would read it. Under it the fixed code never re-enters the cache at all, and the pre-fix code falls to `{}` and refuses:

```ts
const t0 = Date.now();
let n = 0;
const clock = vi.spyOn(Date, "now").mockImplementation(() => t0 + n++ * 600_000);
try {
  await getConfiguredModel({ workload: "chat" });
} finally {
  clock.mockRestore();
}
expect(createOpenAIMock).toHaveBeenLastCalledWith({ apiKey: "sk-custom", baseURL: "https://api.example/v1" });
```

### The DW-621 finding

DW-621 asked for `hasLLMKey` to be widened to `cfg.chatProvider` / `cfg.ingestProvider`. A dev session implemented it, measured the result, and escalated; the escalation was resolved on 2026-09-01 by dropping DW-621 from this bundle. The reasoning, recorded here because the `Never` above depends on it:

- The gate has ~25 consumers (`chat.ts`, `ingest.ts`, `lint-checks.ts`, `lint-fix.ts`, `vision.ts`, `search.ts`, `query.ts`, `query-search.ts`, `merge.ts`, `knowledge-compilation.ts`, `todo-extract.ts`, `action-extractor.ts`, `research-runtime.ts`, the query-stream and settings-test routes). Every one of them then takes the PRIMARY route — `callLLM` / `callLLMStream` / `callVisionLLM` / bare `getConfiguredModel()` — which resolves `cfg.provider ?? env.provider ?? null` and throws `No LLM API key found…` on `null` (`src/lib/llm.ts:302`). Widening the gate therefore replaces a graceful skip with a hard throw at ~20 of them.
- DW-621's premise — "the resolvers honour them" — is true of the resolvers and false of the runtime. **No production call site passes `workload` to `getConfiguredModel`**; only tests do. The two epics that were to wire it (Epic 2 Ingest, Epic 3 Chat) are `done` in `sprint-status.yaml` and shipped without it. `getChatModelSettings` is read in production from exactly two places: `llm.ts:421`, reachable only through a `workload` argument nobody passes, and `wiki-retrieve.ts:544`, which only REPORTS the chat model on `AssembledContext`.
- So a `chatProvider`-only store is not a working configuration today, and the gate's `false` is honest. The real gap is that workload routing was never wired at the call sites — a separate, larger change, filed as its own ledger entry rather than smuggled in behind a one-line predicate.

The rejected alternative, for the record: having `getResolvedCredentials` fall back to `cfg.chatProvider` / `cfg.ingestProvider` when `cfg.provider` is unset. It makes the gate's `true` honest, but the "primary" then means whichever workload field the fallback checks first, so ingest would run on the chat provider whenever the two differ — and it changes `getProviderInfo`, `/api/status` and the Settings payload with it.

## Spec Change Log

- **2026-09-01 — the threaded snapshot must not be `loadConfig()`'s raw answer.**
  Review found that following the `llm.ts` task bullet literally regressed a
  refusal, which the Approach and the Block If both forbid. `loadConfig()`
  returns `{}` for an absent config AND for a store it could not read
  (`config.ts:874-901`, `:1036-1039`), and only the `ok` branch primes the cache
  (`:924`). Threading the unreadable `{}` therefore turned a transient store
  read failure into `No LLM API key found…` at every ungated door — the owner's
  `/api/settings/test` button, `agent-runtime`, `structured-knowledge`,
  `source-monitors` — where the resolvers' own `loadConfigSync()` had absorbed
  it from the still-warm generation. Fixed with a private `configSnapshot()`
  helper in `llm.ts` that returns `undefined` for an empty answer, so the
  resolvers fall back to their own cached read exactly as before while every
  real config still resolves from one generation. The task bullet above was
  amended to record the mechanism; a regression case in
  `settings-runtime-wiring.test.ts` rejects `readFileWithEtag` over a warm cache
  and pins that both `callLLM` and `getConfiguredModel()` still build the
  client.

- **2026-09-01 — matrix row 3 needed a new pin after all.** The acceptance
  criterion said the `{chatProvider:"ollama"}` → `hasLLMKey() === false` row was
  "asserted by the existing suites rather than by a new case". It was not: no
  suite stored a workload-only selection and asked the gate. `llm.test.ts`'s
  `hasLLMKey` block is env-only, and `llm-key-cold-config.test.ts` covered
  `provider`-keyed stores exclusively. One case was added to
  `src/lib/__tests__/llm-key-cold-config.test.ts` — the real-store, cold-cache
  gate suite — asserting `false` for a `chatProvider`-only and an
  `ingestProvider`-only store, so the escalation's decision NOT to widen the
  gate is pinned by a test rather than by prose. `hasLLMKey` itself is still
  untouched, and no case was added to `settings-runtime-wiring.test.ts`, as the
  task list requires.

## Verification

**Commands:**
- `pnpm test` — expected: full suite green, including `settings-runtime-wiring`, `wiki-retrieve`, `llm`, `llm-key-cold-config` and `config`.
- `pnpm lint` — expected: no new errors or warnings.
- `npx tsc --noEmit` — expected: exit 0 (type-checks the new `cfg` parameters against every existing call site). Used INSTEAD of `pnpm build`, which is broken at the baseline commit for an unrelated reason — see the acceptance criterion above.

## Escalation Resolution — 2026-09-01

The 2026-09-01 dev session escalated CRITICAL on an intent gap: DW-621 asked for
`hasLLMKey` to be widened to the workload provider fields, and the widening it
implemented made the gate return `true` for stores every one of the gate's ~25
consumers still refuses — trading graceful degradation for a thrown
`No LLM API key found`. Two readings were defensible and the intent chose
between neither.

**Decision (human, `/bmad-loop-resolve`):** narrow the bundle to DW-618 and
DW-619. `hasLLMKey` is not touched. The gate's `false` for a workload-only store
is CORRECT, because no production call site routes by `workload` — see "The
DW-621 finding" in Design Notes for the evidence. DW-621 was removed from this
bundle's `dw_ids` so it stays open rather than being closed by a bundle that
does not change it, and the underlying user-visible defect it points at (the
`ChatCanvas` / `chat.ts` gate disagreement) was filed as its own ledger entry.

The saved attempt is kept as evidence only —
[spec-dw-618-619-621-single-snapshot-model-client.attempted.patch](spec-dw-618-619-621-single-snapshot-model-client.attempted.patch),
against `09133de291256e2f078ad63b313facfeb6da8089`. It is NOT restored: it
carries the rejected widening and its tests, so this story re-drives from
scratch against the narrowed intent above. Its DW-618/DW-619 hunks are correct
and were verified green (`pnpm test` 8819 passed, `pnpm lint` 0, `npx tsc
--noEmit` 0); `pnpm build` failed there and fails identically at the baseline
commit, for the unrelated `node:timers/promises` reason the acceptance criterion
records.

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 1, medium 3, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[high]` `[patch]` `loadConfig()` answers `{}` both for an absent config and for a store it could not read, and only the readable branch primes the cache — so threading the raw answer turned a transient read failure into `No LLM API key found…` at the ungated doors, a refusal changing its answer. Added a private `configSnapshot()` in `llm.ts` that leaves an empty answer unthreaded, plus a regression case that rejects `readFileWithEtag` over a warm cache.
  - `[medium]` `[patch]` `getIngestModelSettings(cfg)` was threaded but unpinned — reverting that one argument left the suite green. Added an ingest-routed case under `underAnExpiringCache`.
  - `[medium]` `[patch]` No expiring-cache case covered the production-reachable entry point (`agent-runtime` and `structured-knowledge` pass explicit `{provider, model}`; nothing in production passes `workload`). Added one.
  - `[medium]` `[patch]` The DW-619 case called the real `getCustomBaseUrl`, which reads `LLM_CUSTOM_BASE_URL` first, in a suite that scrubs no LLM env vars — reproducibly red with that variable exported. Added a scrub/restore pair.
  - `[low]` `[patch]` `mockedOllamaBaseUrl` was declared and cleared but never asserted, leaving the `ollama` leg of `chatModelForRetrieve` unpinned. Added the ollama case.
  - `[low]` `[patch]` `mock.calls[0][0]` threw a masking `TypeError` when the resolver was never called. Both identity assertions now assert `toHaveBeenCalled()` first.
  - `[low]` `[patch]` The DW-619 identity comment claimed to rule out two same-generation cache reads, which a module-mocked `loadConfigSync` cannot. Reworded to what it actually pins.
  - `[low]` `[patch]` `underAnExpiringCache`'s docblock said the clock advances on EVERY read when the first returns `t0`; the DW-621 comment gave a one-sided rationale. Both corrected, the latter now naming DW-711.
  - `[low]` `[patch]` The spec's Tasks and Acceptance sections contradicted the added `hasLLMKey` pin and prescribed the raw-`loadConfig()` mechanism. Both amended, with Spec Change Log entries.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

One config snapshot per model client (DW-618, DW-619). `getConfiguredModel`,
`callLLM`, `callVisionLLM` and `callLLMStream` now keep the snapshot they warm
and thread it through `getChatModelSettings` / `getIngestModelSettings`,
`apiKeyForProvider`, `getCustomBaseUrl`, `getOllamaBaseUrl` and
`getResolvedCredentials`, so one `createOpenAI({apiKey, baseURL}).chat(model)`
is built from one config generation instead of several entries into a 5 s-TTL
cache. `chatModelForRetrieve` does the same for the `AssembledContext`
chat-model payload. `hasLLMKey` is untouched: DW-621 was dropped from the bundle
by the 2026-09-01 escalation resolution, and the decision is now pinned by a
test rather than by prose alone.

### Files changed

- `src/lib/config.ts` — `getResolvedCredentials(cfg: AppConfig = loadConfigSync())`; the DW-334 docblock paragraph that deferred this work rewritten to record it closed.
- `src/lib/llm.ts` — `type AppConfig` imported; private `configSnapshot()` helper; `getModel(cfg?)` forwards to `getResolvedCredentials`; the four public doors thread one snapshot.
- `src/lib/wiki-retrieve.ts` — `chatModelForRetrieve(cfg: AppConfig = loadConfigSync())` passes one snapshot to all three legs. `runVectorPhase` untouched, per the intent.
- `src/lib/__tests__/settings-runtime-wiring.test.ts` — `underAnExpiringCache` helper plus nine DW-618 cases (workload chat and ingest, ollama endpoint, primary, explicit-provider, `callLLM`, `callLLMStream`, `callVisionLLM`, and the unreadable-store regression).
- `src/lib/__tests__/wiki-retrieve.test.ts` — `getCustomBaseUrl` / `getOllamaBaseUrl` added to the `../config` mock as wrappers over the real implementations; LLM env vars scrubbed; two DW-619 cases (custom and ollama).
- `src/lib/__tests__/llm-key-cold-config.test.ts` — one case pinning that a `chatProvider`- or `ingestProvider`-only store still leaves `hasLLMKey()` `false`.

### Review findings breakdown

Patches applied: 9 (1 high, 3 medium, 5 low). Items deferred: 1 (medium).
Items rejected: 10 — chiefly proposals the intent's `Never` list forecloses
(`llmTimeoutOption`, `runVectorPhase`), and signature preferences the spec
prescribes explicitly (`cfg?` on `getModel`, the default parameter on
`chatModelForRetrieve`).

### Follow-up review recommendation

`true`. Patched findings by severity: high 1, medium 3, low 5. Score
`3 x 3 + 1 x 5 = 14`, at or above the threshold of 5 — and a high-severity patch
sets the flag on its own.

### Verification performed

- `npx tsc --noEmit` — exit 0. This is what type-checks every new `cfg` parameter against every existing call site.
- `pnpm lint` — exit 0 (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from baseline).
- `pnpm test` — 358/359 files, 8820 passed, 1 skipped. The single failure, `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP…`, is a load-dependent flake in an I/O-heavy case this change does not touch: it was reproduced at the baseline commit by stashing all of `src` and re-running the full suite (identical single FAIL, 8808 passed), it passes in isolation (95/95), and one full run with the change was completely green.
- All new cases confirmed red at the baseline and green with the change, plus targeted single-argument reverts for the `getIngestModelSettings` and `getOllamaBaseUrl` legs, so none of them is vacuous.
- `pnpm build` was not run, per the acceptance criterion: it fails identically at the baseline commit for the unrelated `node:timers/promises` reason.
- Matrix audit: all five rows covered by cases that ran and passed. Row 3 needed a new pin — see the Spec Change Log.

### Residual risks

- `underAnExpiringCache` is coupled to `loadConfig()`'s read path making exactly one `Date.now()` call. A future clock call there would make the helper coarser; it can only advance the clock, never rewind, so it cannot produce a false green.
- `configSnapshot()` uses emptiness as the proxy for "not worth threading", because `loadConfig()` does not expose the `unreadable` status to its callers. A genuinely empty saved config is unaffected — the resolvers' own `loadConfigSync()` answers `{}` for it too — but a caller wanting the distinction would need `readStoredConfig`'s status surfaced.
- `chatModelForRetrieve`'s new parameter has no production caller; the single-snapshot property there rests on its default. The cold-cache defect that leaves is recorded in `deferred`.
