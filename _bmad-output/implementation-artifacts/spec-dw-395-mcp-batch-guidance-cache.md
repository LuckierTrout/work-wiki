---
title: 'DW-395: give the MCP batch ingest door the request-scoped guidance cache'
type: 'refactor'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `describe("batch_ingest_urls")` pins `vaultId` but nothing else the MCP
      batch options literal carries — `tags` and `triggeredBy` reach the
      ingested pages and the ledger untested.
    evidence: |-
      The options literal at `src/mcp.ts:542-548` conditionally spreads `tags`,
      `owner`/`author` and `triggeredBy` into every `ingestUrl` of the batch. Of
      those, only the vault filing that happens AFTER the call has a test
      ("files each successfully ingested page into the provided vault"). A slip
      in one of the three conditional spreads — an inverted guard, a dropped
      key — would leave the whole MCP suite green. DW-395 edited this exact
      literal, which is what surfaced the gap; the gap itself predates it.
    location: >-
      src/lib/__tests__/mcp.test.ts:1591
    severity: low
  - summary: >-
      The pre-existing `mcp.test.ts` cases force the no-LLM ingest path by
      deleting only `ANTHROPIC_API_KEY`, which does not actually guarantee it.
    evidence: |-
      `hasLLMKey()` (`src/lib/llm.ts:204`) delegates to `detectEnvProvider()`
      (`src/lib/config.ts:801`), which also honours `OPENAI_API_KEY`,
      `GOOGLE_GENERATIVE_AI_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_API_KEY`,
      `OLLAMA_BASE_URL`/`OLLAMA_MODEL`, plus config-file `ollama`/`custom`
      providers. On a machine with any of those set, the sibling batch and
      ingest cases in this file silently exercise the LLM branch their comments
      say they avoid. DW-395's own new block was hardened against this (all
      seven vars cleared plus an `expect(hasLLMKey()).toBe(false)` guard); the
      cases around it were left as found.
    location: >-
      src/lib/__tests__/mcp.test.ts:1611
    severity: low
baseline_revision: '975b7dd29baf0de51eee496fd6c9764a0d787384'
---

<intent-contract>

## Intent

**Problem:** DW-324 gave `POST /api/ingest/batch` one request-scoped `GuidanceCache` so the URLs it runs inline resolve the Workspace Purpose and read the Names & Terms dictionary once per user action, but the MCP door beside it was deliberately left out of that spec's scope: `handleBatchIngest` (`src/mcp.ts:487`) loops `ingestUrl(url, {...})` over up to `MAX_BATCH_URLS` URLs with no handle, so every URL of one agent action re-resolves the Purpose and re-reads the dictionary from scratch.

**Approach:** Mint one `createGuidanceCache()` per `handleBatchIngest` call and put it on the options literal every URL of that batch already shares, exactly as the HTTP batch route does — then pin the collapse with a read-count test on the MCP path.

## Boundaries & Constraints

**Always:** One handle per `handleBatchIngest` invocation, created inside the function so its lifetime is exactly that one agent action and the next call mints its own. Every URL in the batch gets the SAME handle. Per-URL results, per-URL error isolation, the malformed-URL and `MAX_BATCH_URLS` upfront rejections, and per-URL vault filing all behave exactly as they do today. The batch's URLs all resolve to the same `owner` (the `args.owner` the caller passed, or `ingest()`'s `"system"` fallback when it passed none), so one shared owner-keyed handle never crosses two owners' data.

**Block If:** Sharing the handle across the batch would require caching beyond the single `handleBatchIngest` call (module-level, process-global, TTL), or the MCP batch path turns out to enqueue rather than run inline, so a non-serializable handle could reach a queue payload.

**Never:** Do not put the handle on a queued task payload — it is a live, non-serializable object. Do not change the shape of `GuidanceCache`, `createGuidanceCache()`, or either leaf memo. Do not add a handle to the single-document MCP handlers (`handleIngestUrl`, `handleIngestText`, `handleIngestPdf`, `handleIngestImage`, `handleIngestXMention`, `handleReingest`) — `ingest()` already mints one per document there, and widening those is a different scope decision. Do not touch `src/lib/mcp-http.ts` (it only forwards args). Do not change what guidance renders or the dictionary's sort order. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Batch of N URLs, owner with a dictionary | `handleBatchIngest({ urls: [a, b], owner })`, owner has `names-terms.json` | `names-terms.json` read exactly ONCE for the whole batch (twice before this change); both URLs still ingest and return their slugs | Per-URL failures still reported per URL, unchanged |
| Fresh handle per agent action | Two successive `handleBatchIngest` calls, dictionary entry created between them | The second call reflects the new entry — no handle spans two calls | No error expected |
| One failing URL mid-batch | 2 URLs, the first `ingestUrl` throws | The second URL still ingests and still shares the same handle; `failed: 1`, `succeeded: 1` | The thrown error is recorded on that URL's result only |
| No owner supplied | `handleBatchIngest({ urls: [a, b] })` with no `owner` | Unchanged results; both URLs share the handle under `ingest()`'s `"system"` owner fallback | No error expected |
| Upfront rejections | Malformed URL, or more than `MAX_BATCH_URLS` URLs | Throws before any handle is used — behaviour byte-identical to today | Existing throw messages unchanged |

</intent-contract>

## Code Map

- `src/mcp.ts` -- the subject. `handleBatchIngest` (:487) validates upfront (batch-size :500, malformed :507), then loops `for (const url of urls)` (:525) calling `ingestUrl(url, { ...tags, ...owner/author, ...triggeredBy })` (:527-531) inside a per-URL `try/catch` that records `{ url, slug }` or `{ url, error }`. The options literal at :527-531 is rebuilt per iteration — the fix is to hoist ONE `createGuidanceCache()` above the loop and spread/add it into that literal so every iteration gets the same object. Import line to extend: :70 (`from "./lib/ingest"`) is NOT where the factory lives — add a new import of `createGuidanceCache` from `./lib/guidance-cache`. `handleBatchIngest` is the ONLY multi-document loop in this file; the other ingest handlers are one document each.
- `src/lib/guidance-cache.ts` -- `createGuidanceCache()` (:50) returns `{ workspace, namesTerms }`. Read-only here; its docblock's "Scope today" paragraph (:27-30) names `ingest()` and the HTTP batch route and should gain the MCP batch door so the file keeps telling the truth about who mints handles.
- `src/app/api/ingest/batch/route.ts:116-135` -- the precedent to mirror exactly: `ingestOptions` built ONCE outside the loop with `guidanceCache: createGuidanceCache()` (:134), with the `enqueueTask` payload kept as a SEPARATE literal (:143-150) so the handle cannot reach the queue. The MCP path has no queue at all — it is inline-only — so that hazard does not arise here.
- `src/lib/ingest.ts:1328` -- `IngestOptions.guidanceCache?: GuidanceCache`, already optional and already spread through `ingestUrl` (:238) into `ingest()`. `ingest()` adopts a supplied handle at :1610 (`options?.guidanceCache ?? createGuidanceCache()`); owner resolves at :1599 as `options?.owner?.trim() || actor`, with `actor` defaulting to `"system"`. No change needed in this file.
- `src/lib/__tests__/mcp.test.ts:1591` -- `describe("batch_ingest_urls")`. The fixture is already right: `beforeEach` (:119-135) points `WIKI_DIR`/`RAW_DIR`/`DATA_DIR` at a fresh temp dir and calls `_resetStorage()`; `../fetch`'s `fetchUrlContent` is mocked (:60) to return deterministic content per URL; `callLLM` is mocked (:98) while `hasLLMKey` stays real, which is why the existing multi-URL cases delete `ANTHROPIC_API_KEY` + `_resetConfigCache()` around themselves. Extend this describe — do not restate the fixture.
- `src/lib/__tests__/ingest.test.ts:3800-3812` -- the read-count technique to copy: spy on `getStorage().readFile` AFTER the fixture is written, collect targets, count by relative path. Dictionary path is `tenants/${tenantForOwner(owner)}/names-terms.json`; `tenantForOwner` is exported from `src/lib/wiki.ts:105`, `createNamesTerm` from `src/lib/names-terms.ts`.
- `src/lib/__tests__/ingest-routes.test.ts:646-711` -- the HTTP-door version of these assertions (same handle to every call, fresh handle per request, never in the queue payload). Those tests module-mock `@/lib/ingest`; `mcp.test.ts` does NOT, so the MCP assertions must be made on the OBSERVABLE read count through the real ingest graph rather than on call-argument identity.
- `src/lib/mcp-http.ts:240` -- forwards args into `handleBatchIngest`; read-only evidence that no caller passes a handle in, so minting inside the function is the only reachable seam.

## Tasks & Acceptance

**Execution:**
- `src/mcp.ts` -- import `createGuidanceCache` from `./lib/guidance-cache`; in `handleBatchIngest`, hoist `const guidanceCache = createGuidanceCache();` above the per-URL loop and add `guidanceCache` to the `ingestUrl` options literal, with a comment naming the scope (one agent action) as the HTTP route's does -- collapses N Purpose resolutions and N dictionary reads per agent action to one.
- `src/lib/guidance-cache.ts` -- extend the "Scope today" paragraph to name the MCP batch ingest tool alongside the HTTP batch route -- keeps the module's stated handle-minting inventory accurate.
- `src/lib/__tests__/mcp.test.ts` -- extend `describe("batch_ingest_urls")` with the I/O matrix cases: one dictionary read for a two-URL batch, a fresh handle per call (an entry saved between two calls is picked up), and the handle surviving a mid-batch per-URL failure -- pins the collapse on the MCP door, which today's tests do not observe at all.

**Acceptance Criteria:**
- Given an owner with a saved Names & Terms dictionary, when `handleBatchIngest` ingests two URLs in one call, then the ingest results are unchanged from today (both URLs succeed with slugs, `total`/`succeeded`/`failed` as before) and the batch's URLs are demonstrably served by one shared handle rather than one per URL.
- Given the existing MCP and ingest-route suites, when the change is applied, then no existing test changes behaviour — every added parameter stays optional and no call signature changes.

## Spec Change Log

_No spec amendments — no `bad_spec` finding was raised._

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 2: (high 0, medium 0, low 2)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` The new test block's no-LLM premise was stated in a comment but not enforced — deleting only `ANTHROPIC_API_KEY` leaves six other provider signals that flip `hasLLMKey()`, and with `OPENAI_API_KEY` set the `"system"` fallback case passed even with the fix removed. Fixed: all seven `detectEnvProvider` env vars are saved/cleared/restored and the block asserts `expect(hasLLMKey()).toBe(false)`, which also catches the config-file `ollama`/`custom` paths no env deletion reaches.
  - `[medium]` `[patch]` The exact read-count assertions rode on process-global dedup state — `cachedIndex` (`src/lib/source-index.ts:28`) survives `_resetStorage()` and this file never reset it, while three of the four new tests reused `page-a`/`page-b` from the tests above them. Fixed: `resetSourceIndex()` + `resetAliasIndex()` in the block's `beforeEach`, and a unique `dw395-*` URL prefix per test.
  - `[low]` `[patch]` The `guidance-cache.ts` "Scope today" rewrite flattened the HTTP door's inline-only qualifier ("Both batch doors scope the handle to one user or agent action"), contradicting that route's own comment that enqueued URLs resolve guidance fresh. Fixed: the paragraph is now a three-item list that keeps the inline-only distinction and notes the MCP door has no queue at all.
  - `[low]` `[patch]` `recordReads()` reassigned the shared `readSpy` binding unguarded, so a second call in one test would double-wrap `readFile` and orphan a spy past the `afterEach`. Fixed: it throws if a spy is already installed.

## Design Notes

The whole change is one hoisted `const` plus one field, because DW-322/DW-324 already built the seam: `IngestOptions.guidanceCache` is optional and trailing, `ingestUrl` already spreads its options into `ingest()`, and `ingest()` already prefers a supplied handle over minting one. The only judgement is SCOPE, and the MCP door answers it the same way the HTTP door did: one `handleBatchIngest` call is one agent action, so a dictionary edit landing mid-batch is deliberately invisible to the rest of that batch, and the next agent action mints a fresh handle and sees it.

The MCP door is strictly simpler than the HTTP one in the way that matters for safety: it has no queue path, so the "never let a live object reach a serialized task payload" hazard that forced the HTTP route to keep two separate literals does not exist here — every URL runs inline.

```ts
// ONE guidance memo for this whole batch (DW-395), mirroring the HTTP batch
// door: one agent action, one consistent set of guidance.
const guidanceCache = createGuidanceCache();
for (const url of urls) {
  const result = await ingestUrl(url, { ...tags, ...owner, ...triggeredBy, guidanceCache });
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/mcp.test.ts` -- expected: all `batch_ingest_urls` cases pass, including the new read-count cases.
- `pnpm vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/ingest-routes.test.ts` -- expected: green, proving the shared seam and the HTTP door are untouched.
- `pnpm lint` -- expected: no new errors.

## Auto Run Result

Status: done

**Implemented change.** `handleBatchIngest` (the MCP `batch_ingest_urls` tool) now mints ONE `createGuidanceCache()` above its per-URL loop and hands it to every `ingestUrl` of the batch, so a single agent action resolves the active Wiki's Workspace Purpose and reads the owner's Names & Terms dictionary once instead of once per URL — the scope `POST /api/ingest/batch` already had for its inline URLs (DW-324). The handle is created inside the function, so the next tool call mints its own and sees any edit that landed in between. Every URL at this door runs inline (no queue), so the live, non-serializable handle never has a payload to leak into.

**Files changed.**
- `src/mcp.ts` -- import `createGuidanceCache`; hoist one handle above the batch loop and pass it in the `ingestUrl` options literal, with a comment naming the scope. +14 lines, no signature or control-flow change.
- `src/lib/guidance-cache.ts` -- docblock only: "Scope today" now enumerates all three scopes, keeping the HTTP door's inline-only qualifier explicit and noting the MCP door has no queue.
- `src/lib/__tests__/mcp.test.ts` -- new `describe("request-scoped guidance cache")` nested in `describe("batch_ingest_urls")`: four tests asserting `getStorage().readFile` counts for `tenants/<tenant>/names-terms.json` through the REAL ingest graph (this file does not module-mock `@/lib/ingest`, so the handle is not observable as a call argument the way it is at the HTTP door). Covers every I/O matrix row: one read per two-URL batch, a fresh handle per call picking up an entry saved in between, the handle surviving a mid-batch per-URL failure, and the `"system"` owner fallback. The upfront malformed-URL and `MAX_BATCH_URLS` rejections are covered by the three pre-existing cases in the same describe.

**Review findings breakdown.** 4 patches applied (2 medium, 2 low) — see the Review Triage Log for each. 2 items deferred (both low, both pre-existing, recorded in frontmatter `deferred`). 12 items rejected, chiefly requests to also assert the `workspace` half of the composite handle and to exercise the LLM branch here (that half is already pinned against the real `ingest()` at `src/lib/__tests__/ingest.test.ts:3870`, and these tests prove the composite object itself is shared), plus suggestions that contradict the intent's own scope decision (re-minting the handle mid-batch to bound staleness) or restate design already argued in `src/lib/workspace-guidance.ts:94-109` (a fail-soft `""` Purpose is memoized on purpose).

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 2, low 2 -> score = 3x2 + 1x2 = 8, which is >= 5.

**Verification performed.**
- `./node_modules/.bin/vitest run src/lib/__tests__/mcp.test.ts` -- 230/230 pass, including the 4 new cases.
- `./node_modules/.bin/vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/ingest-routes.test.ts` -- 298/298 pass, so the shared `IngestOptions` seam and the HTTP door are untouched.
- `./node_modules/.bin/eslint` -- exit 0; `tsc --noEmit` clean.
- Negative control, run before and after the patches: removing `guidanceCache` from the options literal makes all four new tests fail with `expected 2 to be 1`, in a clean environment AND with `OPENAI_API_KEY` set. The reverse mutation — hoisting the handle to module scope — fails the freshness test. The tests are load-bearing, not decorative.
- The spec's Verification section names `pnpm vitest` / `pnpm lint`; `pnpm` cannot run in this repo on this machine (a stray `/Users/christianlee/pnpm-workspace.yaml` makes it error `packages field missing or empty`), so the same commands were run through `./node_modules/.bin/`. Pre-existing and unrelated to this change.

**Residual risks.**
- The four new tests observe the CONSEQUENCE (storage read counts) rather than handle identity, so they are coupled to the storage path layout and to the no-LLM ingest branch. That branch is now enforced by an explicit `hasLLMKey()` guard, but a future change adding a second unconditional dictionary read on it would need the `toBe(1)` expectations updated — they would still correctly distinguish a shared handle from a per-URL one.
- Widening the scope to a whole batch means a Names & Terms or Workspace Purpose edit made while a batch of up to `MAX_BATCH_URLS` documents is in flight is invisible to the rest of that batch. That is the intent's explicit trade (one agent action = one consistent set of guidance) and matches the HTTP door, but the window here can be minutes of sequential ingests.
- The deferred-work ledger still lists DW-395 as open; this session did not touch it, per the invocation.
