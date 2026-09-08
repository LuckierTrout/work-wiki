---
title: 'Config: one read per resolution, and a true loadConfigSync docblock'
type: 'refactor'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `src/lib/llm.ts` resolves one model client out of several independent
      entries into the 5 s config cache — the same straddle DW-334 closed inside
      `config.ts`.
    evidence: |-
      `hasLLMKey` (src/lib/llm.ts:231-242) reads `const cfg = loadConfigSync()`
      and then asks `providerIsConfigured("custom")` without passing it, and
      `getConfiguredModel`'s explicit-provider / workload path
      (src/lib/llm.ts:392-451) calls `getChatModelSettings()` /
      `getIngestModelSettings()`, `apiKeyForProvider(provider)` and
      `getCustomBaseUrl()` / `getOllamaBaseUrl()` as separate reads before
      handing all of them to one `createOpenAI({apiKey, baseURL}).chat(model)`.
      That path bypasses `getResolvedCredentials`, which this story did close.
      The optional `cfg` parameters added here make each of these a
      one-argument fix.
    location: >-
      src/lib/llm.ts:231-242, src/lib/llm.ts:392-451
    severity: medium
  - summary: >-
      `chatModelForRetrieve` builds one `chatModel` answer from two or three
      config-cache entries.
    evidence: |-
      `src/lib/wiki-retrieve.ts:543-549` calls `getChatModelSettings()` and then
      `getCustomBaseUrl()` (or `getOllamaBaseUrl()`) with no shared snapshot, and
      puts `provider` / `model` / `configured` on `AssembledContext`. Same shape
      as the legs closed here; both resolvers now take a `cfg`.
    location: >-
      src/lib/wiki-retrieve.ts:543-549
    severity: low
  - summary: >-
      The settings payload straddles an `await`, and three of its resolvers
      still take no `cfg`.
    evidence: |-
      `src/app/api/settings/route.ts` resolves `getEffectiveSettings()` and then
      `getWorkbenchSettings(...)` after an async hop; `getWorkbenchSettings`
      makes its own `loadConfigSync()` read and calls `getFirecrawlSettings()`,
      `getResearchSettings()` and `getVectorSearchSettings()`, none of which
      accepts a snapshot. One HTTP response can therefore describe two config
      generations across the two panes it renders.
    location: >-
      src/app/api/settings/route.ts, src/lib/config.ts:getWorkbenchSettings
    severity: low
baseline_revision: '1a08bc7720c3cee8485b8479eddd104e8ec48a7a'
---

<intent-contract>

## Intent

**Problem:** `getEffectiveSettings` reads `loadConfigSync()` once at the top, but its non-embedding legs (`apiKeyForProvider`'s `custom` branch, `providerIsUsable` → `providerIsConfigured` → `getCustomBaseUrl`, and `getStructuredKnowledgeModelSettings` → `workloadModelSettings` → `getEffectiveProvider`) each re-enter that 5 s-TTL cache themselves, so one answer can straddle two config generations — only the embedding half is snapshot-consistent (DW-334). Separately, `loadConfigSync`'s docblock justifies its cold-cache `{}` with "the app's startup sequence calls `loadConfig()`", a hook this repo does not have (DW-550).

**Approach:** Thread the `cfg` `getEffectiveSettings` already holds down the whole non-embedding chain using the file's existing optional-`cfg`-parameter convention (`resolveOllamaBaseUrl`, `getOllamaBaseUrl`, `getLoopbackApiSettings`), so no call site outside `config.ts` has to change; rewrite the false doc bullet to name the real per-surface warms; pin the one-read behaviour with a test that counts config-cache entries during a single resolution.

## Boundaries & Constraints

**Always:**
- Every new `cfg` parameter is optional and trailing, defaulting to today's behaviour, so existing call sites compile and behave unchanged.
- Preserve the LAZINESS of reads that are lazy today: `apiKeyForProvider` only touches the store on the `custom` branch and `getCustomBaseUrl` only when the env var is absent. A `cfg: AppConfig = loadConfigSync()` default parameter is evaluated eagerly on every call and would warm a cold cache with `{}` (starting a 5 s window) for callers that never needed the store — use `cfg?: AppConfig` with `(cfg ?? loadConfigSync())` at the point of use for those two.
- Resolver semantics are unchanged: same env-over-store precedence, same `nonEmpty` trimming, same `providerIsUsable` rules. This is threading only.
- Comment anchors that other comments/tests cite by name (`envCustomApiKey`, DW-66/DW-313/DW-402/DW-403 notes) stay accurate.

**Block If:** a threading change would require altering a resolver's precedence or return value to keep tests green — that is a behaviour change this bundle does not authorise.

**Never:**
- Do not touch the embedding legs (`embeddingModelAnswer`, `hasEmbeddingSupport`, `getEmbeddingModelName`) — DW-313 already closed those.
- Do not add a startup hook (`instrumentation.ts`, `next.config.ts`, `layout.tsx`); DW-550 is a documentation correction, not a request to build the warm the comment invented.
- Do not add test-only counters or exported instrumentation to production config state.
- Do not change `loadConfigSync`'s cold-cache `{}` answer or the 5 s TTL.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| One read per resolution | Warm cache; `Date.now` spied so it counts `loadConfigSync` entries | Exactly one config-cache entry across a whole `getEffectiveSettings()` call | No error expected |
| Generation straddle | Cache warm with `{provider:"custom", customApiKey, customBaseUrl}`; clock jumps past the 5 s TTL after the first read | Every leg still reports generation A: `provider:"custom"`, `hasApiKey:true`, `apiKeySource:"config"`, structured-knowledge inheriting the custom primary | No error expected |
| Explicit `cfg` honoured | `apiKeyForProvider("custom", {customApiKey:"sk-a"})` with a different value in the live cache | Returns `"sk-a"`, not the cached value | No error expected |
| Default preserved | Any resolver called with no `cfg`, as every site outside `config.ts` does | Same answer as before this change | No error expected |
| Lazy read preserved | Cold cache; `apiKeyForProvider("anthropic")` with `ANTHROPIC_API_KEY` set | Returns the env key without entering `loadConfigSync` at all | No error expected |

</intent-contract>

## Code Map

- `src/lib/config.ts:937-946` -- `loadConfigSync`, the 5 s-TTL cache; its docblock at `930-937` carries DW-550's false third bullet ("The app's startup sequence calls `loadConfig()` before any LLM call").
- `src/lib/config.ts:1024-1051` -- `apiKeyForProvider`; only the `custom` branch (line 1046) reads the store, via `nonEmpty(loadConfigSync().customApiKey)`. Keep that read lazy.
- `src/lib/config.ts:1058-1064` -- `providerIsConfigured`; calls `apiKeyForProvider` and `getCustomBaseUrl`. Must forward `cfg` to both.
- `src/lib/config.ts:1102-1107` -- `providerIsUsable`; calls `providerIsConfigured`. Called from `getEffectiveSettings`, `getEffectiveProvider` and `workloadModelSettings`.
- `src/lib/config.ts:1115-1119` -- `getCustomBaseUrl`; `nonEmpty(process.env.LLM_CUSTOM_BASE_URL) ?? nonEmpty(loadConfigSync().customBaseUrl)` — the store leg is lazy behind `??`; keep it so.
- `src/lib/config.ts:1129-1194` -- `getEffectiveProvider`; reads its own `cfg` and calls `providerIsUsable`. Needs the `cfg: AppConfig = loadConfigSync()` default-parameter shape.
- `src/lib/config.ts:1203-1210` -- `getStructuredKnowledgeModelSettings`, one of the three doors the intent names; delegates to `workloadModelSettings`.
- `src/lib/config.ts:1216-1262` -- `workloadModelSettings` (private); calls `getEffectiveProvider()` and `providerIsUsable` — the hop that makes the structured-knowledge leg a second AND third read today.
- `src/lib/config.ts:1274-1288` -- `getChatModelSettings` / `getIngestModelSettings`; also route through `workloadModelSettings`, so they get the same threading for their own internal consistency.
- `src/lib/config.ts:2084-2216` -- `getEffectiveSettings`; the resolution being made single-read. Re-entry points: `apiKeyForProvider(provider)` (2105), `providerIsUsable(provider, model)` (~2199), `getStructuredKnowledgeModelSettings()` (2190). Already threaded: `resolveOllamaBaseUrl(cfg)`, `embeddingModelAnswer(cfg)`, `hasEmbeddingSupport(cfg)`.
- `src/lib/config.ts:479,564,1414` -- `resolveOllamaBaseUrl` / `getOllamaBaseUrl` / `getLoopbackApiSettings`: the established `cfg: AppConfig = loadConfigSync()` convention to copy.
- `src/lib/config.ts:2242-2300` -- `getResolvedCredentials`; reads its own `cfg` then calls `apiKeyForProvider` and `getCustomBaseUrl`. Same shape as `getEffectiveSettings`, so thread it too.
- `src/lib/embeddings.ts:540-546,664-668` -- `getEmbeddingModelName` / `hasEmbeddingSupport`, already `cfg`-taking (DW-313). Read-only reference for the parameter idiom; do not modify.
- `src/app/api/status/route.ts:7` and `src/cli.ts:638` -- the two real per-surface `await loadConfig()` warms DW-550's rewritten bullet must cite. Read-only.
- `src/lib/__tests__/config.test.ts:1-135` -- suite setup: env save/restore, `_resetConfigCache()`, `withWarnSpy`. New tests go in this file; `describe("getEffectiveProvider — merge priority")` at 586 and `describe("getStructuredKnowledgeModelSettings")` at 962 are the neighbouring suites.
- `src/lib/__tests__/config.test.ts:604-633` -- the DW-313 embedding-snapshot test; the precedent this bundle's test extends to the non-embedding legs.
- Read-only evidence for DW-550: no `instrumentation.ts` exists at repo root or under `src/`, and neither `next.config.ts` nor `src/app/layout.tsx` mentions `loadConfig` (verified by search).
- Call-site evidence: every external caller of `apiKeyForProvider`, `providerIsConfigured`, `providerIsUsable`, `getCustomBaseUrl`, `getEffectiveProvider`, `getStructuredKnowledgeModelSettings`, `getChatModelSettings`, `getIngestModelSettings` (in `src/lib/llm.ts`, `src/lib/wiki-retrieve.ts`, `src/lib/structured-knowledge.ts`, `src/app/api/settings/route.ts` and tests) passes NO config argument, so trailing optional parameters are safe.
- `src/lib/config.ts:747,915,938` -- the only three `Date.now()` calls in the module, and 938 is the only one on a `getEffectiveSettings` resolution path. That is what makes a `Date.now` spy an exact count of `loadConfigSync` entries; no `Date.now` call exists in `embeddings.ts` or `paths.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` -- Rewrite the third bullet of `loadConfigSync`'s docblock (line ~936) so it states what is true: there is no startup hook; each surface warms the cache at its own call site, citing `src/app/api/status/route.ts` and `src/cli.ts`. Keep the other two bullets. -- DW-550: the false premise is what the next caller would build on.
- `src/lib/config.ts` -- Give `apiKeyForProvider` and `getCustomBaseUrl` a trailing `cfg?: AppConfig`, consumed as `(cfg ?? loadConfigSync())` at the existing store read so the read stays lazy; forward `cfg` from `providerIsConfigured` and `providerIsUsable` (same optional shape). -- DW-334: these are the doors `getEffectiveSettings`' credential legs go through.
- `src/lib/config.ts` -- Give `getEffectiveProvider`, `getStructuredKnowledgeModelSettings`, `getChatModelSettings`, `getIngestModelSettings` and the private `workloadModelSettings` a `cfg: AppConfig = loadConfigSync()` parameter (these read `cfg` unconditionally, so the default-parameter convention already used by `getOllamaBaseUrl` fits), and forward it through `workloadModelSettings` → `getEffectiveProvider` → `providerIsUsable`. -- DW-334: without this hop the structured-knowledge leg alone costs two further reads.
- `src/lib/config.ts` -- Pass the `cfg` already read at the top of `getEffectiveSettings` and of `getResolvedCredentials` into every resolver they call, and replace the DW-313-era comments that say "the embedding half" with the now-whole claim, citing DW-334. -- The behaviour this bundle exists to deliver.
- `src/lib/__tests__/config.test.ts` -- Add a `describe` covering the I/O matrix: the one-read count, the generation-straddle case, explicit-`cfg` precedence, unchanged defaults, and the preserved lazy read. Count reads by spying `Date.now` (the module's only per-resolution clock read, line 938) rather than by adding production instrumentation. -- Pins single-read resolution so a future re-entry fails loudly.

**Acceptance Criteria:**
- Given a warm config cache, when `getEffectiveSettings()` runs once, then `loadConfigSync` is entered exactly once for the whole resolution.
- Given a warm cache holding a `custom` provider with a stored key and base URL, when the clock advances past the 5 s TTL after the first read of a single `getEffectiveSettings()` call, then the returned object still describes that one generation — no field falls back to the empty-config answer.
- Given any existing caller that passes no config argument, when it calls a threaded resolver, then it returns exactly what it returned before this change.
- Given a cold cache and a non-`custom` provider, when `apiKeyForProvider` resolves an env credential, then it does not enter `loadConfigSync` and does not warm the cache with `{}`.
- Given a reader of `loadConfigSync`'s docblock, when they follow its claims to the code, then every cited warm exists (`src/app/api/status/route.ts`, `src/cli.ts`) and no claim about a startup sequence remains.

## Design Notes

Two parameter idioms, chosen per function rather than uniformly:

```ts
// Unconditional reader -> default parameter, matching getOllamaBaseUrl.
export function getEffectiveProvider(cfg: AppConfig = loadConfigSync()): ProviderInfo

// Conditional reader -> optional param, read at the point of use, so a caller
// that never reaches the store never warms a cold cache with `{}`.
export function getCustomBaseUrl(cfg?: AppConfig): string | null {
  return nonEmpty(process.env.LLM_CUSTOM_BASE_URL)
    ?? nonEmpty((cfg ?? loadConfigSync()).customBaseUrl);
}
```

The straddle test does not need to interleave real time — a `Date.now` spy that
returns an in-TTL value on its first call and a past-TTL value afterwards makes
the second and any later read fall to the cold-cache `{}`, which is precisely
the two-generation answer this change removes.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/config.test.ts` -- expected: all pass, including the new suite.
- `npx vitest run src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/settings-route.test.ts` -- expected: unchanged, proving the optional parameters broke no caller.
- `npx tsc --noEmit` -- expected: clean.
- `npm run lint` -- expected: clean.
- `npm test` -- expected: no new failures versus the pre-change baseline.

## Auto Run Result

Status: done

**Implemented change.** `getEffectiveSettings` now resolves entirely from the one `cfg` it reads at the top: the credential leg (`apiKeyForProvider`), the readiness leg (`providerIsUsable` → `providerIsConfigured` → `getCustomBaseUrl`) and the extraction leg (`getStructuredKnowledgeModelSettings` → `workloadModelSettings` → `getEffectiveProvider`) all take a snapshot instead of re-entering the 5 s-TTL cache — five entries per resolution before, one after (DW-334). `getResolvedCredentials` got the same treatment, and `getChatModelSettings` / `getIngestModelSettings` for their own internal consistency. Two parameter idioms, chosen per function: `cfg?: AppConfig` read at the point of use where the store leg is lazy (`apiKeyForProvider`, `getCustomBaseUrl`, and pass-through on `providerIsConfigured` / `providerIsUsable`), and `cfg: AppConfig = loadConfigSync()` where the read is unconditional, matching `getOllamaBaseUrl`. Every new parameter is trailing and optional, so no call site outside `config.ts` changed. `loadConfigSync`'s docblock no longer justifies its cold-cache `{}` with a startup sequence this repo does not have — verified: no `instrumentation.ts` anywhere, and neither `next.config.ts` nor `src/app/layout.tsx` mentions `loadConfig` — and now cites the two real per-surface warms, `src/app/api/status/route.ts:7` and `src/cli.ts:638` (DW-550).

**Files changed:**
- `src/lib/config.ts` — threaded `cfg` through the non-embedding resolver chain; rewrote the false `loadConfigSync` doc bullet and the cold-cache comment beneath it; made `workloadModelSettings`' `cfg` required.
- `src/lib/__tests__/config.test.ts` — new `single-read resolution` suite: per-resolution read counts, clock-straddle assertions, explicit-`cfg` precedence and semantics, unchanged defaults, and the preserved lazy read.

**Review findings:** 10 patches applied (1 medium, 9 low), 3 deferred (see frontmatter `deferred`), 7 rejected. No intent gaps, no spec repairs.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 1, low 9 → 3×1 + 1×9 = 12, which is ≥ 5.

**Verification:**
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (the three `jsx-ast-utils` notices are pre-existing, from unrelated JSX files).
- `npx vitest run` over `config`, `settings-runtime-wiring`, `workbench-settings`, `settings-route` — 497 passed.
- `npm test` — 348 files, 8091 passed / 1 skipped, no failures.
- Matrix audit: all five I/O rows are covered by tests that ran and passed in the config suite. Mutation-checked — reverting `config.ts` fails the read-count and straddle tests (5 reads observed instead of 1); re-dropping `cfg` at the chat, ingest, `getEffectiveProvider`, `getResolvedCredentials` and precedence sites each fails after the patch round, where three of those were silent before it.

**Residual risks:**
- The read counter is a proxy: it counts `Date.now()` calls, which equals `loadConfigSync` entries only while the cache's own clock read stays the sole one on a resolution path. A clock read added elsewhere on the path would produce a false alarm, not a missed regression — the safe direction, and the straddle tests assert the answer rather than the count.
- The straddle is near-unreachable at today's surfaces, since each warms the cache immediately before a fully synchronous resolution; the value delivered is the invariant and its pin, matching both ledger entries' `severity: low`.
- `src/lib/llm.ts` and `src/lib/wiki-retrieve.ts` still build one client out of several cache entries; recorded as deferred rather than fixed, since the intent scoped this to `getEffectiveSettings`.
