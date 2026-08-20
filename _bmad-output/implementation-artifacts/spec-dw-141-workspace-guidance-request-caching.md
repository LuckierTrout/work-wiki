---
title: 'DW-141: resolve the active Wiki once per request in workspace guidance'
type: 'refactor'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `buildNamesTermsGuidance` is still uncached in the exact same `Promise.all`
      pairs the DW-141 handle now covers, so one document still pays up to four
      dictionary reads while paying one profile read.
    evidence: |-
      All three sites threaded in this change pair
      `buildWorkspaceGuidance(owner, cache)` with a bare
      `buildNamesTermsGuidance(owner)`, and `ingest()` calls `listNamesTerms`
      a fourth time. `buildNamesTermsGuidance` (names-terms.ts:327) has the same
      read-per-call shape `buildWorkspaceGuidance` had. This spec's "Never"
      clause deferred it to "a different ledger entry", but no open ledger entry
      covers dictionary guidance caching, so the deferral has nowhere to land.
    location: >-
      src/lib/names-terms.ts:327
    severity: low
  - summary: >-
      A manual page merge gets neither Workspace Purpose nor Names & Terms
      guidance, while an ingest-time reconcile of the same two bodies gets both.
    evidence: |-
      `src/lib/merge.ts:204` calls `reconcilePage(into.body, from.body)` with no
      `owner`, so the guidance branch at ingest.ts:1168 is skipped entirely. The
      reconcile prompt is the same prompt in both cases, so the merged prose is
      held to a different standard depending on which door it came through. This
      change touched that signature (adding the cache parameter) without closing
      the asymmetry, which is out of DW-141's scope but worth a decision.
    location: >-
      src/lib/merge.ts:204
    severity: medium
  - summary: >-
      One HTTP request can still resolve guidance N times when it ingests N
      documents in a loop; the handle is per-`ingest()`, not per-request.
    evidence: |-
      `POST /api/ingest/batch`'s off-Workers fallback (src/app/api/ingest/batch/route.ts:152)
      loops `ingestUrl` per URL inline when the queue is unavailable, and
      `POST /api/tasks/run` drains tasks one per request. On Workers each URL is
      a separate queued request, so per-document and per-request coincide in
      production and the DW-141 remedy is met there. The inline fallback is the
      residual case: closing it needs a handle threaded through `IngestOptions`
      and the `ingestUrl`/`ingestPdf`/`ingestImage` wrappers, which is a design
      extension beyond this spec.
    location: >-
      src/app/api/ingest/batch/route.ts:152
    severity: low
  - summary: >-
      `workspace-purpose-settings.test.tsx` "adopts a recheck that answers no
      wiki at all" is flaky under full-suite load and can red an unrelated CI run.
    evidence: |-
      Observed failing once during full-suite verification for this story (the
      badge still read "not configured" when the 1s `waitFor` expired), then
      passing on re-run and passing 42/42 in isolation. It is entirely
      fetchMock-driven, touches nothing in this change, and predates it
      (introduced with DW-136/142/301). It races the mount fetch against the
      `returnToTab()` recheck.
    location: >-
      src/components/__tests__/workspace-purpose-settings.test.tsx:837
    severity: medium
baseline_revision: 'c40de974c0f427fa871d0d5fd4d51b6349d4114e'
---

<intent-contract>

## Intent

**Problem:** `buildWorkspaceGuidance(owner)` (`src/lib/workspace-guidance.ts:25`) does a `getCurrentWiki(owner)` registry read and then a `getWorkspaceProfile(owner, wiki.id)` profile read on EVERY call, with no memo, across nine call sites in eight modules. One `ingest()` of one document calls it up to three times (`buildIngestSystemPrompt`, the map/reduce REDUCE step, `reconcilePage`), so a single document pays up to six uncached storage reads for a value that cannot change mid-document.

**Approach:** Give `buildWorkspaceGuidance` an OPTIONAL caller-created cache handle that memoizes the resolved guidance per owner, and thread one such handle through the ingest pipeline so an `ingest()` run resolves the active Wiki and its profile exactly once. Callers that pass nothing behave exactly as they do today.

## Boundaries & Constraints

**Always:** The cache is created by the caller and lives only for that caller's operation — no module-level, process-global, or TTL cache. Omitting the cache argument must reproduce today's behaviour byte for byte, including the fail-soft `catch` that warns and returns `""`. The no-Wiki branch still returns `""` without reading a profile. Cache keys are the `owner` string, so two owners sharing one handle never see each other's guidance. Added parameters are optional and trailing, so every existing caller and test compiles unchanged.

**Block If:** The only way to memoize would require introducing hidden ambient state (e.g. `AsyncLocalStorage` or a module singleton) — that is a different design than this spec authorises.

**Never:** Do not change what guidance renders or how prompts compose it. Do not memoize `buildNamesTermsGuidance` (`src/lib/names-terms.ts:327`) — same shape, different ledger entry. Do not add caching to the other six call sites (`query.ts`, `chat.ts`, `agent-runtime.ts`, `action-extractor.ts`, `structured-knowledge.ts`, `source-monitors.ts`): each calls guidance once per operation. Do not cache across `ingest()` calls — one handle per document, so a Purpose saved between documents is still picked up. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cached repeat | Owner with a current Wiki + saved profile; same cache handle passed twice; profile bytes rewritten between the calls | Both calls return the FIRST guidance string; registry read once, profile read once | No error expected |
| No cache | Same state, no cache handle | Second call reflects the rewritten profile; registry and profile each read twice | No error expected |
| No Wiki | Owner with no Wiki; same cache handle twice | `""` both times; registry read once; no profile read at all | No error expected |
| Unreadable registry | `wikis.json` replaced by a directory (EISDIR); cache handle passed | `""` both times, one `logger.warn` from the first call only | Fail soft — never throws into the caller's prompt build |
| Two owners, one handle | Owners `alice` and `bob`, different current Wikis and profiles, one shared handle | Each owner gets its OWN guidance | No error expected |
| Ingest run | Owner with a current Wiki + saved Purpose; content long enough to force map/reduce | That Wiki's `workspace-profile.json` is read exactly once for the whole `ingest()` call (was twice) and the Purpose still reaches both prompts | No error expected |

</intent-contract>

## Code Map

- `src/lib/workspace-guidance.ts` -- the whole subject. `buildWorkspaceGuidance(owner)` at :25 wraps `getCurrentWiki(owner)` (:26) and `renderWorkspaceGuidance(await getWorkspaceProfile(owner, wiki.id))` (:38) in one try/catch that fail-softs to `""` (:39-48). The `if (!wiki) return ""` branch at :36 carries the DW-137 docblock — keep both the branch and the comment intact. This is where the cache type, factory, and memo go.
- `src/lib/wikis.ts:837` -- `getCurrentWiki(owner)` = `readRegistry(owner)` + find `currentId`. Read #1 per call. Not modified.
- `src/lib/workspace-profile.ts:186` -- `getWorkspaceProfile(owner, wikiId)` = `readOwnProfile` ?? empty. Read #2 per call, at `wikiProfilePath(owner, wikiId)`. Not modified.
- `src/lib/ingest.ts` -- the only module with more than one guidance call per operation. Threading points, in dependency order:
  - `:1157` `reconcilePage(existingBody, newBody, owner?)` — guidance at :1165. Also called from `src/lib/merge.ts:204` WITHOUT an owner (no guidance call there), so the new parameter must be optional and trailing.
  - `:1217` `buildIngestSystemPrompt(owner?)` — guidance at :1248. Exported; called by `src/lib/__tests__/ingest.test.ts`, `wiki-schema-source.test.ts:278`, `workspace-profile.test.ts:564` with 0 or 1 args.
  - `:1459` `synthesizeBody(title, content, owner?)` — module-private; calls `buildIngestSystemPrompt(owner)` at :1468 and the REDUCE guidance at :1520. Sole caller is `ingest()` at :1612.
  - `:1544` `ingest(...)` — the request boundary. Creates the one handle and passes it to `synthesizeBody` (:1612) and `reconcilePage` (:1901).
- `src/lib/__tests__/workspace-profile.test.ts:432` -- `describe("guidance follows the active wiki")` already pins no-Wiki (:434), DW-137 legacy (:459), unreadable-registry fail-soft (:477) and pointer-swap (:502) against a real temp `DATA_DIR`. Keep them passing untouched; reuse its `beforeEach` shape (temp `DATA_DIR`, `_resetLocks()`, `_resetStorage()`) for the new suite.
- `src/lib/__tests__/ingest.test.ts:3341` -- `describe("ingest ledger")` shows the ingest-with-`DATA_DIR` setup (temp `DATA_DIR`/`WIKI_DIR`/`RAW_DIR`, `_resetStorage()`). `hasLLMKey`/`callLLM` are module-mocked at :50; `mockedHasLLMKey.mockReturnValue(true)` turns on the guidance path. `MAX_LLM_INPUT_CHARS` is `12_000` (`src/lib/constants.ts:37`), so content over that forces the map/reduce branch and hence two guidance calls today.
- Read-count technique already used in this repo: `vi.spyOn(getStorage(), "readFile")` (see `src/lib/__tests__/maintenance.test.ts:551`, `wiki-artifact-revisions.test.ts:384`). Count calls whose path matches `wikiProfilePath(owner, wikiId)` / `wikiRegistryPath(owner)`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workspace-guidance.ts` -- export a `WorkspaceGuidanceCache` type plus a `createWorkspaceGuidanceCache()` factory, and add an optional trailing `cache` parameter to `buildWorkspaceGuidance`. Move today's body into a private resolver; when a cache is supplied, memoize the resolver's PROMISE under `owner` so concurrent and sequential callers share one resolution. Document why the handle is caller-owned rather than ambient, and why a fail-soft `""` is cached too. -- One resolution per owner per request without any global state.
- `src/lib/ingest.ts` -- add the same optional trailing `cache` parameter to `reconcilePage` (:1157), `buildIngestSystemPrompt` (:1217) and `synthesizeBody` (:1459), forwarding it to `buildWorkspaceGuidance`; in `ingest()` (:1544) create one handle and pass it at :1612 and :1901. -- Collapses up to three resolutions per document to one, and is the only module that needs threading.
- `src/lib/__tests__/workspace-guidance.test.ts` -- new suite covering every row of the I/O matrix except the ingest row: cached repeat, no-cache, no-Wiki, unreadable registry, and two-owners-one-handle. Assert read counts with a `getStorage().readFile` spy against a real temp `DATA_DIR`. -- The matrix is the contract; the read count is the only direct evidence the memo works.
- `src/lib/__tests__/ingest.test.ts` -- add the ingest-run test: create a Wiki, save a Workspace Purpose, enable the LLM mock, ingest content longer than `MAX_LLM_INPUT_CHARS`, and assert `workspace-profile.json` was read exactly once while the Purpose still appears in the system prompt passed to `callLLM`. -- Anchors the acceptance on the outermost surface the ledger entry names.

**Acceptance Criteria:**
- Given an owner whose Wiki has a saved Workspace Purpose, when `buildWorkspaceGuidance` is called with a cache handle, the profile file is then rewritten with a different purpose, and it is called again with the SAME handle, then both calls return identical guidance and `getStorage().readFile` was called exactly once for the registry path and exactly once for that Wiki's profile path.
- Given the same owner and state, when `buildWorkspaceGuidance` is called twice with NO cache handle and the profile is rewritten in between, then the second call returns the rewritten purpose — the uncached path is unchanged.
- Given an owner with a current Wiki, a saved Workspace Purpose and source content longer than `MAX_LLM_INPUT_CHARS`, when `ingest()` runs that content for that owner, then that Wiki's `workspace-profile.json` is read exactly once for the whole call and the Purpose text is still present in the system prompt handed to `callLLM`.
- Given the existing suites, when `pnpm test` runs, then `workspace-profile.test.ts`, `workspace-profile-backfill.test.ts`, `wikis.test.ts`, `ingest.test.ts` and `merge.test.ts` pass with no edits to their existing cases.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 4: (high 0, medium 2, low 2)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[low]` `[patch]` `workspace-guidance.test.ts` two-owners case proved nothing about the memo (string value-equality, no read assertions) — added per-owner registry/profile read counts.
  - `[low]` `[patch]` Nothing pinned that `createWorkspaceGuidanceCache()` returns a FRESH handle — added a case resolving one owner through two handles and asserting the second re-reads.
  - `[low]` `[patch]` The new `ingest.test.ts` describe's `afterEach` used a blanket `vi.restoreAllMocks()` and never restored `mockedHasLLMKey` to the file default — narrowed to the storage spy plus explicit default restoration.
  - `[low]` `[patch]` `LONG_CONTENT` hardcoded `30` as its own sentence length, so editing the sentence could silently drop below the map/reduce threshold — derived from the literal's `.length` and trimmed 3x to 1.5x.
  - `[low]` `[patch]` `(await listWikiPages())[0].slug` threw an unhelpful TypeError if the first ingest wrote no page — asserted the list length first.
  - `[low]` `[patch]` The between-ingests case asserted only the new Purpose's presence — added the negative assertion that the superseded Purpose appears in no system prompt.

## Design Notes

Caller-owned handle, not ambient context: an `AsyncLocalStorage` scope would memoize everywhere for free, but hides the lifetime from the call site, leans on `node:async_hooks` under `nodejs_compat`, and would silently span a long bulk-import run where a mid-run Purpose save should still be seen. An explicit handle is exactly as wide as the function that made it.

Cache the PROMISE, not the string, so the `Promise.all` pairs at `ingest.ts:1164`, `:1246`, `:1518` share one in-flight resolution. `buildWorkspaceGuidance` never rejects (the `catch` returns `""`), so a memoized promise cannot poison the request.

Shape:

```ts
export type WorkspaceGuidanceCache = Map<string, Promise<string>>;
export function createWorkspaceGuidanceCache(): WorkspaceGuidanceCache {
  return new Map();
}
export async function buildWorkspaceGuidance(
  owner: string,
  cache?: WorkspaceGuidanceCache,
): Promise<string> {
  if (!cache) return resolveWorkspaceGuidance(owner);
  const memo = cache.get(owner);
  if (memo) return memo;
  const pending = resolveWorkspaceGuidance(owner);
  cache.set(owner, pending);
  return pending;
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workspace-guidance.test.ts src/lib/__tests__/workspace-profile.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/workspace-profile-backfill.test.ts src/lib/__tests__/wiki-schema-source.test.ts` -- expected: all pass, new cases included
- `npx tsc --noEmit` -- expected: no new type errors
- `pnpm lint` -- expected: clean
- `pnpm test` -- expected: full suite green

## Auto Run Result

Status: done

### Implemented change

`buildWorkspaceGuidance` gained an optional, caller-created `WorkspaceGuidanceCache` handle that memoizes the resolved guidance per owner; `ingest()` creates one handle per document and threads it through synthesis, the map/reduce REDUCE step and reconcile-on-merge. A long document that lands on an existing page went from six storage reads for guidance to two. Every caller that passes no handle is byte-for-byte unchanged, including the DW-137 no-Wiki branch and the fail-soft `catch`.

### Files changed

- `src/lib/workspace-guidance.ts` -- added `WorkspaceGuidanceCache` and `createWorkspaceGuidanceCache()`; moved the existing body verbatim into a private `resolveWorkspaceGuidance`; `buildWorkspaceGuidance(owner, cache?)` memoizes the promise (not the string) so concurrent callers join one resolution.
- `src/lib/ingest.ts` -- optional trailing `cache?` on `reconcilePage`, `buildIngestSystemPrompt` and `synthesizeBody`; `ingest()` creates the single per-document handle and passes it at both call paths.
- `src/lib/__tests__/workspace-guidance.test.ts` (new, 296 lines) -- read-count assertions against a real temp `DATA_DIR` for cached repeat, concurrent sharing, uncached repeat, no-Wiki, fail-soft warn-once, two-owners-one-handle, and fresh-handle-re-reads.
- `src/lib/__tests__/ingest.test.ts` -- new describe pinning one profile read per `ingest()` across map/reduce and reconcile, with the Purpose still reaching the system prompt, plus the negative case that a Purpose saved between two ingests is picked up.

### Review findings breakdown

- Patches applied: 6 (all low severity, all in the new tests) — see the Review Triage Log entry above.
- Items deferred: 4 (2 medium, 2 low) — recorded in frontmatter `deferred`.
- Items rejected: 13 — deliberate documented design choices (per-document snapshot semantics, memoizing the fail-soft `""`, no ambient/branded cache type), cosmetic prose nits, and test-refactor preferences that would have added brittleness (e.g. asserting a registry read count inside `ingest()`, where `loadPageConventions` reads the site owner's registry under the separate DW-19 invariant).

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 0, low 6. Score = 3x0 + 1x6 = 6, which is at or above the threshold of 5.

### Verification performed

- `npx vitest run` (full suite): 256 files / 5478 tests passed.
- Targeted run of the seven suites named in `## Verification`: 374 passed.
- `npx tsc --noEmit`: clean.
- `npx eslint` on all four changed files: clean.
- `pnpm lint` / `pnpm test` could not run: an empty `/Users/christianlee/pnpm-workspace.yaml` makes every `pnpm` invocation fail with `packages field missing or empty`, including `pnpm --version`. Pre-existing and environment-level, unrelated to this change; `npx vitest` / `npx eslint` are the same binaries the scripts invoke.
- Matrix test audit: all six I/O matrix rows are covered by tests that ran and passed.
- Mutation checks confirmed the new tests are not vacuous: dropping the handle at each of the three ingest call sites, hoisting it to a module-level singleton, memoizing after the promise settles, and keying the memo by a constant instead of `owner` each produce failures.

### Residual risks

- A transient read failure during the first guidance resolution memoizes the fail-soft `""` for the rest of that document instead of only that one prompt. Deliberate and documented: the conditions that reach the `catch` (a damaged registry, an unreadable profile) are persistent rather than transient, and re-reading would only re-warn.
- The handle's per-operation lifetime is a convention the type does not enforce — `WorkspaceGuidanceCache` is a plain `Map`, so a caller could hold one at module scope and recreate the process-global the design rejects. The docblock states the rule; nothing structural prevents breaking it.
- Guidance is now a per-document snapshot: switching the active Wiki mid-ingest means the reconcile prompt still uses the Wiki resolved at the start of that document. Intended, and pinned by the between-ingests test.
