---
title: 'DW-322/DW-324: cache the dictionary alongside the Purpose, and scope the handle to the request'
type: 'refactor'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Both guidance memos are keyed by `owner`, but the files they memoize are
      addressed by TENANT, so two owner strings in one tenant key two entries
      over one file.
    evidence: |-
      `dictionaryPath` (src/lib/names-terms.ts:88) and `getCurrentWiki` both
      route the owner through `tenantForOwner` -> `ownerToTenant`, which
      lowercases and collapses punctuation. `"Alice"` and `"alice"` therefore
      occupy two `Map` slots pointing at one file: two reads instead of one, and
      two snapshots that can diverge under a single handle. Latent today —
      `owner` is one fixed string inside an `ingest()` and inside a batch
      request (`principal.handle`) — and inherited from DW-141, which set the
      owner-keying precedent. Keying on `tenantForOwner(owner)` would collapse
      both.
    location: >-
      src/lib/names-terms.ts:214
    severity: low
  - summary: >-
      `src/mcp.ts`'s batch ingest tool loops `ingestUrl` over up to
      MAX_BATCH_URLS URLs with no handle — the same one-action-N-documents shape
      DW-324 just closed for the HTTP batch route.
    evidence: |-
      `handleIngestBatch` (src/mcp.ts:526-532) calls `ingestUrl(url, {...})`
      sequentially inside a `for` loop, so every URL of one agent action
      resolves the Workspace Purpose and re-reads the dictionary from scratch.
      The remedy is now one line — add `guidanceCache: createGuidanceCache()` to
      that options literal — but DW-324 names `src/app/api/ingest/batch/route.ts`
      specifically and this spec's scope was held to the HTTP door, so the MCP
      door was deliberately not touched.
    location: >-
      src/mcp.ts:528
    severity: medium
  - summary: >-
      `IngestOptions` now carries a live, non-serializable object guarded only
      by the convention that queue task payloads are hand-written literals.
    evidence: |-
      `IngestOptions.guidanceCache` holds two `Map`s. The batch route keeps it
      out of the queue by building `enqueueTask`'s payload as a separate literal
      (src/app/api/ingest/batch/route.ts:143-150), and `tasks/run` and the agent
      ingest route do the same by hand. Nothing structural stops a future
      `enqueueTask({ kind: "ingest", ...ingestOptions })`: TypeScript does not
      excess-property-check spread properties, so it would compile and fail at
      structured-clone/JSON time. An `Omit<IngestOptions, "guidanceCache">` on
      the payload builders, or a handle passed as its own argument rather than a
      field on the data bag, would make it a compile error.
    location: >-
      src/lib/ingest.ts:1328
    severity: low
  - summary: >-
      Under a handle the dictionary ENTRY OBJECTS are shared across every caller
      of the operation; only the top-level array is copied.
    evidence: |-
      `listNamesTerms` returns `[...(await memo)]`, so a caller that sorts or
      splices its result cannot corrupt the next one (pinned by a test). The
      entries inside are the same objects, where before the memo each read
      produced fresh objects from `JSON.parse`. No caller in the repo mutates an
      entry (`canonicalizeNamesTerm`, `renderNamesTermsGuidance` and
      `applyNamesTermsToGeneratedText` all read), and the docblock says so, but
      nothing enforces it — one future `entry.aliases.push(...)` would leak into
      every later caller of that request. `Object.freeze` on resolve, or a test
      pinning the object-level invariant, would close it.
    location: >-
      src/lib/names-terms.ts:236
    severity: low
baseline_revision: '0673cfedc3092a9f8542e2006762df870d94332f'
---

<intent-contract>

## Intent

**Problem:** DW-141 gave `buildWorkspaceGuidance` a caller-owned memo, but the half beside it stayed uncached: `buildNamesTermsGuidance(owner)` (`src/lib/names-terms.ts:327`) re-reads `names-terms.json` at all three `Promise.all` pairs in `ingest.ts` (:1170, :1256, :1529), and `ingest()` reads it a fourth time at :1644 — so one document pays one profile read and up to four dictionary reads. Separately the handle is minted per `ingest()` call (`ingest.ts:1596`) with no field on `IngestOptions`, so `POST /api/ingest/batch`'s queue-unavailable fallback (`batch/route.ts:152`) resolves guidance from scratch for every URL in one HTTP request.

**Approach:** Give the dictionary the same optional caller-owned memo (keyed by `owner`, holding the promise), bundle it with the existing Workspace Purpose memo into one request-scoped `GuidanceCache` handle, thread that handle through the existing optional trailing `cache` parameters in `ingest.ts`, and let a caller supply one via a new optional `IngestOptions.guidanceCache` — which the batch route creates once per request. Callers that pass nothing behave exactly as they do today.

## Boundaries & Constraints

**Always:** Every added parameter and field is optional and trailing, so all existing callers and tests compile unchanged. Omitting the handle reproduces today's behaviour exactly, including `listNamesTerms`' ENOENT-to-`[]` degrade and its sort order. Memos are keyed by `owner`, so one handle shared by two owners never crosses their data. The dictionary memo caches the ENTRIES (not the rendered string) so the fourth read at `ingest.ts:1644` is covered by the same handle. A cached `listNamesTerms` returns a fresh top-level array on every call, exactly as the uncached path does, so no caller can mutate another's result. The handle is caller-created and lives only as long as the caller's variable — no module-level, process-global, or TTL cache. `ingest()` still mints its own handle when the caller supplies none.

**Block If:** Making the batch route share one handle would require caching across HTTP requests, or the only way to reach the ingest call sites would be ambient state (`AsyncLocalStorage`, a module singleton) — both are different designs than this spec authorises.

**Never:** Do not change what guidance renders, how prompts compose it, or the dictionary's sort order. Do not add caching to the six single-call guidance sites (`query.ts`, `chat.ts`, `agent-runtime.ts`, `action-extractor.ts`, `structured-knowledge.ts`, `source-monitors.ts`) or to `expandQueryWithNamesTerms` (`names-terms.ts:299`). Do not thread a handle through `POST /api/tasks/run` or the single-ingest routes — this spec's per-request scope is the batch route only. Do not touch `merge.ts:203`'s owner-less `reconcilePage` call (a separate open concern). Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cached dictionary repeat | Owner with saved entries; one handle; `names-terms.json` bytes rewritten between two `buildNamesTermsGuidance` calls | Both calls return the FIRST guidance string; `names-terms.json` read exactly once | No error expected |
| No handle | Same state, no handle passed | Second call reflects the rewritten bytes; `names-terms.json` read twice | No error expected |
| Handle shared by list + guidance | One handle passed to `listNamesTerms` and then `buildNamesTermsGuidance` | Guidance reflects the listed entries; `names-terms.json` read exactly once | No error expected |
| Cached list is not shared state | One handle; `listNamesTerms` called twice; first result mutated (sorted/spliced) by the caller | Second result is unaffected — a distinct array with the original order | No error expected |
| Absent dictionary | Owner with no `names-terms.json`; one handle used twice | `[]` / `""` both times; one ENOENT-degraded read | ENOENT still degrades to `[]`, never throws |
| Two owners, one handle | `alice` and `bob` with different dictionaries, one shared handle | Each owner gets its OWN entries and guidance | No error expected |
| Ingest run | Owner with a Purpose + dictionary; content over `MAX_LLM_INPUT_CHARS` (forces map/reduce) | `names-terms.json` AND `workspace-profile.json` each read exactly once for the whole `ingest()`; both guidance blocks still reach the prompts | No error expected |
| Batch inline fallback | `POST /api/ingest/batch` with 3 URLs, `enqueueTask` returning `false` | All three `ingestUrl` calls receive the SAME `guidanceCache` object | Per-URL failures still reported per URL, unchanged |
| Batch queued path | Same route, `enqueueTask` returning `true` | Response unchanged (`mode: "async"`); no handle reaches the queue payload | No error expected |

</intent-contract>

## Code Map

- `src/lib/names-terms.ts` -- subject #1. `readEntries(owner)` (:169) is the single `getStorage().readFile(dictionaryPath(owner))` (:88 → `tenants/<tenant>/names-terms.json`), ENOENT→`[]`. `listNamesTerms(owner)` (:186) sorts it; `buildNamesTermsGuidance(owner)` (:327) = `renderNamesTermsGuidance(await listNamesTerms(owner))`. `renderNamesTermsGuidance` (:310) already takes `readonly NamesTermEntry[]` — keep it pure and untouched. `expandQueryWithNamesTerms` (:299) also calls `listNamesTerms` — out of scope. The cache type, factory, and memo go here.
- `src/lib/workspace-guidance.ts` -- the DW-141 precedent to mirror exactly: `WorkspaceGuidanceCache` (:44), `createWorkspaceGuidanceCache()` (:47), and the memo-the-PROMISE-before-it-settles shape in `buildWorkspaceGuidance` (:100). Not modified.
- `src/lib/guidance-cache.ts` -- NEW. The one request-scoped handle composing both memos (`{ workspace, namesTerms }`) plus `createGuidanceCache()`. Lives in its own module so neither leaf module has to import the other (a cycle) and so the batch route can mint one without importing `ingest.ts`.
- `src/lib/ingest.ts` -- subject #2. Already threads `cache?: WorkspaceGuidanceCache` through `reconcilePage` (:1160), `buildIngestSystemPrompt` (:1221) and `synthesizeBody` (:1466); each of those has the bare `buildNamesTermsGuidance(owner)` beside it (:1170, :1256, :1529). `ingest()` (:1552) mints the handle at :1596 and passes it at :1626 (`synthesizeBody`) and :1920 (`reconcilePage`); its fourth dictionary read is `listNamesTerms(owner)` at :1644. `IngestOptions` (:1268) is the options bag every wrapper (`ingestUrl` :238, `ingestImage` :357, `ingestPdf` :428, `ingestDocument` :488, `ingestYouTube` :591) already spreads into `ingest()` — one new optional field threads through all of them with no wrapper edits.
- `src/app/api/ingest/batch/route.ts` -- the request boundary. `ingestOptions` is built once at :116 and reused by the inline `ingestUrl(url, ingestOptions)` at :152 inside the per-URL loop. The `enqueueTask` payload (:133) is a SEPARATE literal, so a non-serializable handle on `ingestOptions` never reaches the queue.
- `src/lib/__tests__/workspace-guidance.test.ts` -- the read-count technique to copy verbatim: temp `DATA_DIR` + `_resetLocks()`/`_resetStorage()`, then `countReads()` (:81) spying on `getStorage().readFile` AFTER the fixture is written.
- `src/lib/__tests__/names-terms.test.ts` -- existing temp-`DATA_DIR` suite (setup at :19-34). Path for assertions: `tenants/${tenantForOwner(owner)}/names-terms.json` (`tenantForOwner` is exported from `src/lib/wiki.ts:105`; `dictionaryPath` is private).
- `src/lib/__tests__/ingest.test.ts:3731` -- `describe("ingest resolves workspace guidance once per document")` already builds the fixture this needs (real `DATA_DIR`, `createWiki`, `saveWorkspaceProfile`, `mockedHasLLMKey(true)`, `LONG_CONTENT` over `MAX_LLM_INPUT_CHARS`, `countReads()`, `systemPrompts()`). Extend it — do not restate the fixture.
- `src/lib/__tests__/ingest-routes.test.ts:78` -- imports `POST as POST_BATCH`; `@/lib/ingest` is module-mocked at :7 (so the route's real ingest graph never loads) and `enqueueTask` defaults to `false` (:117) — the inline fallback is already the default path here.

## Tasks & Acceptance

**Execution:**
- `src/lib/names-terms.ts` -- export `NamesTermsCache` (`Map<string, Promise<NamesTermEntry[]>>`) and `createNamesTermsCache()`, add an optional trailing `cache` to `listNamesTerms` and `buildNamesTermsGuidance`, and memoize the sorted-entries PROMISE under `owner`, returning a fresh top-level array copy from the cached path. Document why entries (not the rendered string) are the cached unit. -- One dictionary read per owner per handle, covering the guidance pairs and the direct `listNamesTerms` call alike.
- `src/lib/guidance-cache.ts` -- NEW: the `GuidanceCache` type (`{ workspace: WorkspaceGuidanceCache; namesTerms: NamesTermsCache }`) and `createGuidanceCache()`, with a docblock on why it is caller-owned and per-operation rather than ambient. -- One handle to thread instead of two parallel parameters at every site.
- `src/lib/ingest.ts` -- retype the existing optional `cache` parameters on `reconcilePage`, `buildIngestSystemPrompt` and `synthesizeBody` to `GuidanceCache`, pass `cache?.workspace` / `cache?.namesTerms` to the two builders at :1169-70, :1255-56 and :1528-29; add `guidanceCache?: GuidanceCache` to `IngestOptions`; in `ingest()` use `options?.guidanceCache ?? createGuidanceCache()` and pass the handle to `listNamesTerms` at :1644. -- Collapses one document to one profile read and one dictionary read, and lets a caller widen the scope to its whole request.
- `src/app/api/ingest/batch/route.ts` -- create one handle per request and put it on `ingestOptions`, with a comment recording that a batch is one user action so a mid-batch Purpose/dictionary edit is deliberately not picked up. -- Closes the N-resolutions-per-request residue in the queue-unavailable fallback.
- `src/lib/__tests__/names-terms.test.ts` -- new suite covering the dictionary rows of the I/O matrix: cached repeat, no-handle, list+guidance sharing one handle, cached-list-is-a-copy, absent dictionary, and two-owners-one-handle, asserting read counts with a `getStorage().readFile` spy. -- The matrix is the contract; the read count is the only direct evidence the memo works.
- `src/lib/__tests__/ingest.test.ts` -- extend `describe("ingest resolves workspace guidance once per document")`: seed a dictionary entry, ingest `LONG_CONTENT`, and assert `names-terms.json` was read exactly once while the dictionary guidance heading still appears in a system prompt sent to `callLLM`. -- Anchors DW-322 on the outermost surface the ledger entry names.
- `src/lib/__tests__/ingest-routes.test.ts` -- add a batch case: three URLs with `enqueueTask` returning `false`, asserting every inline `ingestUrl` call got the same defined `guidanceCache` reference; and one asserting the queued path's `enqueueTask` payload carries no handle. -- Anchors DW-324 on the HTTP door the ledger entry names.

**Acceptance Criteria:**
- Given an existing caller that passes no handle (e.g. `merge.ts:203`'s `reconcilePage`, `query.ts:238`'s `buildNamesTermsGuidance`), when it runs, then its reads and results are byte-for-byte what they are today and it compiles without edits.
- Given `POST /api/ingest/batch` on the queued path, when `enqueueTask` succeeds, then the task payload is unchanged and contains no cache handle.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 4: (high 0, medium 1, low 3)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` A rejected dictionary read stayed memoized, so one transient non-ENOENT storage error on the first URL of a request-scoped batch would fail every remaining URL that would each have re-read and succeeded. `listNamesTerms` now evicts the entry when the resolution rejects (only if the map still holds that same promise), with a test that a read failing once then succeeding costs exactly two reads and memoizes only the success.
  - `[medium]` `[patch]` The DW-324 seam was unpinned: no test passed `options.guidanceCache` into the real `ingest()`, so mutating `ingest()` to ignore the field left the whole suite green. Added a case running two real `ingest()` calls with one supplied handle and asserting the dictionary and the wiki profile were each read exactly once across both documents; verified by mutation that it fails without the `??` branch.
  - `[medium]` `[patch]` DW-141's rationale for memoizing the fail-soft `""` rested on the handle being confined to one document, which DW-324 makes untrue. Behaviour unchanged; the `buildWorkspaceGuidance` docblock now states that a handle can span a request, so one transient failure strips the Purpose from every remaining document of that request with a single warn — accepted and bounded, and contrasted with the dictionary memo, which evicts.
  - `[low]` `[patch]` The batch route's comment claimed a batch-wide guarantee, but the handle is consumed only by the queue-unavailable inline fallback; on Workers each URL is its own queued request. Reworded to scope the claim to the documents the request runs itself.
  - `[low]` `[patch]` The `NamesTermsCache` docblock claimed to mirror `WorkspaceGuidanceCache` exactly. It now names the two real differences (entries vs rendered string; can reject vs fail-softs) and adds that the staleness window is about WRITES, since the dictionary mutators cannot reach a caller's handle.
  - `[low]` `[patch]` The new ingest read-count test's comment said "Four dictionary reads today" and then enumerated three; corrected to the three this fixture actually produces, noting the reconcile fourth belongs to the sibling existing-page case.

## Design Notes

`GuidanceCache` is a composite of two independently-owned memos rather than one map, because both are keyed by `owner` but hold different values — a single map would collide. Each leaf module owns the shape of its own memo; `guidance-cache.ts` only bundles them:

```ts
export interface GuidanceCache {
  workspace: WorkspaceGuidanceCache;
  namesTerms: NamesTermsCache;
}
export function createGuidanceCache(): GuidanceCache {
  return { workspace: createWorkspaceGuidanceCache(), namesTerms: createNamesTermsCache() };
}
```

A dictionary read error (anything but ENOENT) stays memoized, matching `buildWorkspaceGuidance`: today the same error would be re-thrown by each of the four reads and abort the same operation, so pinning it changes no outcome.

DW-141 said "do not cache across `ingest()` calls". DW-324 supersedes that for a caller who explicitly opts in: the batch route's handle spans the documents of ONE request, which is one user action, so an edit landing mid-batch is deliberately invisible to the rest of that batch. `ingest()` with no supplied handle keeps the per-document scope unchanged.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/names-terms.test.ts src/lib/__tests__/workspace-guidance.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/ingest-routes.test.ts` -- expected: all pass, including the pre-existing DW-141 cases untouched.
- `npx tsc --noEmit` -- expected: no errors (proves every un-migrated caller still compiles).
- `pnpm lint` -- expected: clean.
- `pnpm test` -- expected: full suite green (or only the pre-existing `workspace-purpose-settings.test.tsx` flake noted in DW-141).

## Auto Run Result

Status: done

**Summary.** DW-322: `buildNamesTermsGuidance` and `listNamesTerms` now take the same kind of optional, caller-owned memo the DW-141 handle gave `buildWorkspaceGuidance`. The cached unit is the sorted ENTRIES rather than the rendered block, so the fourth dictionary read in `ingest()` — the direct `listNamesTerms` that canonicalizes the extracted concept — is covered by the same handle as the three `Promise.all` guidance pairs. One document now costs one dictionary read and one profile read. DW-324: the two memos are bundled into one `GuidanceCache`, `IngestOptions` gained an optional `guidanceCache` field, `ingest()` uses a supplied handle when present and mints its own when not, and `POST /api/ingest/batch` creates one per HTTP request so the queue-unavailable inline fallback resolves guidance once for the whole batch instead of once per URL. The queued path is untouched — its task payload is a separate literal and a queued task resolves fresh.

**Files changed.**
- `src/lib/names-terms.ts` — `NamesTermsCache` + `createNamesTermsCache()`, read body extracted to `resolveSortedEntries`, optional trailing `cache` on `listNamesTerms` and `buildNamesTermsGuidance`; memoizes the promise, returns a fresh top-level array, evicts a rejected read.
- `src/lib/guidance-cache.ts` (new) — the composite `GuidanceCache { workspace, namesTerms }` and `createGuidanceCache()`.
- `src/lib/ingest.ts` — the three existing `cache` parameters retyped to `GuidanceCache` and split to `cache?.workspace` / `cache?.namesTerms`; `IngestOptions.guidanceCache`; `ingest()` honours a supplied handle and passes it to the fourth read.
- `src/lib/workspace-guidance.ts` — docblock only: the fail-soft-`""` rationale now states the widened scope a caller-supplied handle brings.
- `src/app/api/ingest/batch/route.ts` — one handle per request on `ingestOptions`, scoped comment.
- `src/lib/__tests__/names-terms.test.ts` — new `names and terms dictionary caching` suite (8 cases).
- `src/lib/__tests__/ingest.test.ts` — three cases added to the DW-141 guidance describe (dictionary read once per document; entry saved between two ingests still picked up; one caller-supplied handle shared across two whole documents).
- `src/lib/__tests__/ingest-routes.test.ts` — three batch-route cases (same handle across inline calls, fresh handle per request, no handle in the queued payload).

**Review findings breakdown.** 6 patches applied (medium 3, low 3); 4 items deferred (medium 1, low 3); 8 rejected; 0 intent gaps; 0 spec repairs. Details in the Review Triage Log above.

**Follow-up review recommendation:** `true`. Patched findings this pass: high 0, medium 3, low 3. Score = 3 x 3 + 1 x 3 = 12, which is >= 5. No high-severity patch.

**Verification.**
- `npx vitest run` (full suite) — 268 files, 5927 tests passed, 0 failed.
- `npx vitest run` over the four spec-named files — 319 passed.
- `npx tsc --noEmit` — clean, which is the direct evidence that every un-migrated caller of `listNamesTerms`, `reconcilePage` and `buildIngestSystemPrompt` still compiles unchanged.
- `npx next lint` — no warnings or errors.
- Mutation checks (reverted): ignoring `options.guidanceCache` in `ingest()` fails the new shared-handle test; a bare `.catch(() => {})` instead of the eviction fails the new failed-read test; minting a per-URL handle in the batch loop fails the same-handle route test.
- `pnpm vitest` / `pnpm lint` fail in this repo with `ERROR packages field missing or empty` — a pre-existing pnpm workspace-config problem unrelated to this change. `npx` runs the same binaries.

**Residual risks.**
- A request-scoped handle widens the staleness window: a Workspace Purpose or dictionary edit landing mid-batch is invisible to the remaining URLs of that batch, and a transient registry/profile failure on the first URL fail-softs the Purpose out of the rest of it with one warn. Both are deliberate — re-resolving per document is what DW-324 removes — and bounded by the request.
- The batch route allocates two empty `Map`s on the queued path that it never uses. Harmless; it keeps `ingestOptions` a single literal.
- Four incidental findings were recorded in frontmatter `deferred` rather than fixed: owner-vs-tenant memo keying, the same uncached loop in `src/mcp.ts`'s batch tool, the non-serializable field on `IngestOptions` being guarded only by convention, and dictionary entry objects being shared (not copied) under a handle.
