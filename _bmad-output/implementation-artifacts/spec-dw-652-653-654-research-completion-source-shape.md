---
title: 'Research completion source shape: validate elements, drop the truthiness fallbacks, pin the post-drain CAS'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
baseline_revision: 'b4097443a026aa2fbe9ef723859a246af12929b8'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A cancel that lands on a project whose stored completion is malformed can no
      longer finalize: `commitResearchPage` now refuses before the cancel-teardown
      branch that used to delete the completion and set `status: cancelled`.
    evidence: |-
      Before this change a `cancelRequested` row carrying a wrong-shaped completion at
      `phase: "page"` flowed past the `(cancelRequested || cancelled) && !completion`
      early return into the claim CAS, whose `authorized` mutator declined and dropped
      into the cancel-finalize branch (src/lib/research-completion.ts ~636-651):
      completion deleted, status `cancelled`, outbox removed. The new pre-claim shape
      guard throws first, so that teardown is unreachable and the row stays
      `cancelRequested`. Teardown never dereferences `sources` - it deletes the whole
      completion - so this door now refuses for a value it would not have touched. Not
      stranded: the `deleteRequested` branch sits above the guard, so deleting the
      project still works, and refusing loudly is this module's declared fail-closed
      discipline. Closing it means deciding whether teardown paths should be exempt
      from the shape guard.
    location: >-
      src/lib/research-completion.ts:570
    severity: low
---

<intent-contract>

## Intent

**Problem:** `requireCompletionSources` checks only `Array.isArray`, so `[null]`, `[{}]` and `["https://…"]` pass and then reach `source.url` / `meta.slug` — DW-579's opaque `TypeError` class one level down (DW-654). `commitResearchPage`'s two `completion?.sources?.length ? … : …` fallbacks (`src/lib/research-completion.ts:533`, `:553`) treat a truthy non-array as a usable list, so a stored `completion: { phase: "page", sources: "https://example.com/a" }` is PERSISTED forward to `phase: "sources"` with a `progress.message` counting the string's characters as sources, and only the drain immediately after refuses (DW-652). The post-ingest CAS guard at `:938` is reached by no test, so a later edit could strip it unnoticed (DW-653).

**Approach:** Extend `requireCompletionSources` to validate each element's dereferenced fields, route `commitResearchPage`'s two reads through it (keeping "no completion yet" as the ordinary first-commit path), and add a test that corrupts the stored row after every in-loop `checkpointSource` has finished so the post-drain CAS guard is the door that refuses.

## Boundaries & Constraints

**Always:**
- Fail closed. Never coerce a bad shape to `[]` or repair it on disk — refusing is not repairing (DW-297 discipline already recorded in the helper's docblock).
- One error class, `ResearchCompletionShapeError`, for both failure modes; the non-array message stays verbatim `Research completion sources are not a list.` (three existing tests pin it).
- Element validation covers exactly the fields this module dereferences: `url`, `title`, `slug`, `sha` must be strings; `jobId`, `error` must be a string or `undefined`; `ingested` must be a boolean or `undefined`. Unknown extra keys stay allowed.
- The first-commit path — no `completion` on the row at all — must still commit normally, as must a completion holding an empty list.

**Block If:** the post-drain CAS guard at `:938` proves unreachable from the public `drainResearchOutbox` API without mocking module internals — decide with a human whether to delete it instead of pinning it.

**Never:**
- Do not add per-element validation to `isResearchProject` / `parseRegistry` in `src/lib/research-projects.ts`. That guard refuses the WHOLE registry file, so one corrupt nested completion would make every project for that owner unlistable and undeletable.
- Do not change `checkpointSource`'s unguarded read-back at `:720`, the `:709` guard, or the `:925` loop guard.
- No new exported API, no behaviour change for well-shaped rows.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Well-shaped list | `completion.sources` a list of full source objects | drain reaches `phase: "done"` exactly as today | No error expected |
| Element is a bare string | `sources: ["https://example.com/a"]` | drain refuses before any Ingest | `ResearchCompletionShapeError`, message `Research completion source 0 is invalid.` |
| Element is `null` or `{}` | `sources: [null]` / `sources: [{}]` | drain refuses | same, index-named |
| Optional field wrong type | `sources: [{url,title,slug,sha, ingested: "yes"}]` | drain refuses | same |
| Truthy non-array at `phase: "page"` | `completion: { phase: "page", sources: "https://example.com/a" }`, outbox saved | `commitResearchPage` refuses; row keeps `phase: "page"`, no Page write, no `Ingesting 21 sources.` message | `ResearchCompletionShapeError`, message `…are not a list.` |
| First commit | no `completion` on the row | commits normally to `phase: "sources"` | No error expected |
| Corruption after the drain loop | valid list; a concurrent writer replaces `sources` with a string after every `checkpointSource` has finished | the post-ingest CAS refuses; the corrupt value stays on disk, `status` never moves to `complete` | `ResearchCompletionShapeError` |

</intent-contract>

## Code Map

- `src/lib/research-completion.ts:50-108` -- `ResearchCompletionShapeError` + `requireCompletionSources`. The docblock's "WHAT IT CHECKS, AND THE LIMIT IT ACCEPTS" paragraph (`:83-91`) and its claim about the `commitResearchPage` fallbacks (`:96-104`) both go stale with this change and must be rewritten, not left contradicting the code.
- `src/lib/research-completion.ts:533-535` -- `const sources = afterSave.completion?.sources?.length ? … : await completionSourcesFromOutbox(outbox)`. This `sources` is what `markResearchPageWritten` counts for `Ingesting N sources.` (`:695`).
- `src/lib/research-completion.ts:553` -- the same fallback inside the claim mutator; this is the write that persists the bad value forward. Guarded checks (`phase`, claim freshness) run above it and must stay above it.
- `src/lib/research-completion.ts:709` / `:925` / `:938` -- the three existing guard sites: `checkpointSource`'s mutator, the drain loop, and the post-ingest CAS. Only `:938` is unpinned.
- `src/lib/research-projects.ts:123-137` -- `ResearchCompletionSource` / `ResearchCompletion`; `:253-270` `isResearchProject` (structural only, deliberately); `:332-336` `parseRegistry` throws for the whole file — the reason element validation belongs here, not there.
- `src/lib/__tests__/research-completion.test.ts:813-1000` -- the existing `describe("a stored completion whose sources are not a list")` block. New rows belong here; its `seedBadCompletion` helper and the `it.each` table are the reuse points.
- `src/lib/__tests__/research-completion.test.ts:1-95` -- mocks (`../lifecycle`, `../raw`, `../tasks`) and the per-test `tmpDir` + `getStorage()` singleton. `vi.spyOn(getStorage(), "writeFile")` is the seam for the DW-653 row; `vi.restoreAllMocks()` in `afterEach` already cleans it. Registry path is `tenants/alice/research-projects.json` (`src/lib/research-projects.ts:172`).

## Tasks & Acceptance

**Execution:**
- `src/lib/research-completion.ts` -- add a per-element predicate and call it from `requireCompletionSources` after the `Array.isArray` check, throwing `ResearchCompletionShapeError` with an index-named message -- closes DW-654 at the door that dereferences the elements.
- `src/lib/research-completion.ts` -- replace both `completion?.sources?.length` fallbacks (`:533`, `:553`) with a guarded read that treats only "no `completion` at all" as the first-commit path -- closes DW-652 so the bad value is refused before it is written forward.
- `src/lib/research-completion.ts` -- rewrite the two stale docblock paragraphs on `requireCompletionSources` to state what is now checked, why the registry guard is still structural-only, and that `commitResearchPage` no longer persists a truthy non-array forward.
- `src/lib/__tests__/research-completion.test.ts` -- extend the existing bad-shape `describe` with the I/O matrix rows: element-shape refusals (`["https://…"]`, `[null]`, `[{}]`, wrong-typed optional), the `commitResearchPage` refusal at `phase: "page"`, and the post-drain CAS row -- one test per matrix scenario.

**Acceptance Criteria:**
- Given a stored `completion: { phase: "page", pageSlug, sources: "https://example.com/a" }` and a saved outbox, when `commitResearchPage` runs, then it rejects with `ResearchCompletionShapeError`, `mockedWritePage` is not called, and the reread row still has `phase: "page"` with `sources` byte-identical to the string.
- Given a project whose completion sources are a valid two-source list and an outbox holding both bodies, when a concurrent writer replaces `completion.sources` with a string after the last `checkpointSource` write, then `drainResearchOutbox` rejects with `ResearchCompletionShapeError`, both Ingests were dispatched first (`enqueueTask` called twice), and `status` is not `complete`.
- Given a project whose completion sources are a proper list, when it drains, then it still reaches `phase: "done"` — no well-shaped row changes behaviour.

## Spec Change Log

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The new in-CAS guard in `commitResearchPage`'s claim mutator was reached by no test — reverting it alone left every research suite green, re-creating the exact DW-653 defect this bundle closes. Added a test that corrupts the registry between the pre-claim read and the CAS re-read via the `readFileWithEtag` seam; mutation-verified that reverting the guard now fails only that test.
  - `[low]` `[patch]` The commit door was pinned only for a truthy non-array; reverting the pre-claim read to the old truthiness test stayed green. Added commit-door rows for `sources` absent and `sources: null`, plus a fresh-foreign-claim row that reaches the pre-claim guard alone (the CAS guard sits below the claim-freshness check).
  - `[low]` `[patch]` Every element-shape row seeded a single-element list, so `findIndex` replaced by a hard-coded `0` would have passed. Added a `[well-shaped, bad]` row asserting index 1, a wrong-typed required field, and a nested-array element.
  - `[low]` `[patch]` The guard's acceptance side was unpinned. The positive drain case now carries the optional fields and an unknown extra key and asserts the key survives the round-trip.
  - `[low]` `[patch]` `ResearchCompletionShapeError`'s class docblock described only the non-array refusal; rewritten to cover both.
  - `[low]` `[patch]` `isResearchProject`'s docblock — the place DW-654 pointed at — carried no record of the decision; added a `WHERE THE NESTED completion.sources CHECK LIVES` paragraph with the `parseRegistry` blast-radius reason. Doc only, no validation added there.
  - `[low]` `[patch]` The comment above the original `it.each` still described the deleted `completion?.sources?.length` fallbacks; rewritten to describe current code.
  - `[low]` `[patch]` The post-ingest CAS test's `not.toBe("complete")` was a weak negative; replaced with phase, status, unrepaired value and surviving outbox.
  - `[low]` `[patch]` The commit-refusal test did not assert the outbox survives; added, matching the sibling drain test's contract.

## Design Notes

Why the element check lives here and not in `isResearchProject`: `parseRegistry` refuses the entire registry when any entry fails that guard, so validating a nested `completion.sources` there would turn one half-written row into "this owner has no readable projects" — worse than the failure being fixed. Refusing at the consuming boundary stops the one operation that would act on the bad value while the row stays listable and deletable.

Shape of the guarded read in `commitResearchPage` (both sites follow this form — `null` is the ordinary first commit, an empty list still falls back to the outbox):

```ts
const stored = afterSave.completion ? requireCompletionSources(afterSave.completion) : null;
const sources = stored?.length ? stored : await completionSourcesFromOutbox(outbox);
```

The DW-653 seam: spy on `getStorage().writeFile`, and after the real registry write whose parsed content shows every stored source `ingested: true`, write a corrupt registry through the captured original. That lands strictly after the final in-loop `checkpointSource` and strictly before the post-ingest CAS re-read, which is exactly the window `:938` protects.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/research-completion.test.ts` -- expected: all pass, including the new rows.
- `npx vitest run src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/research-completion-lifecycle.test.ts src/lib/__tests__/research-delivery.test.ts src/lib/__tests__/research-projects.test.ts` -- expected: green; no well-shaped completion regressed.
- `npx tsc --noEmit` -- expected: no new errors.
- `npm run lint` -- expected: clean for the touched files.

## Auto Run Result

Status: done

**Implemented change.** `requireCompletionSources` now validates every ELEMENT of a stored `completion.sources`, not just the list (DW-654), refusing by index with the same `ResearchCompletionShapeError`; the non-array message stays verbatim. `commitResearchPage`'s two `completion?.sources?.length ? … : …` fallbacks are gone (DW-652) — both reads guard first and fall back second, so only "no `completion` on the row at all" or an empty stored list still takes the outbox path, and a truthy non-array is refused instead of written forward with a progress message counting the string's characters. The post-ingest CAS guard is now reached by a test (DW-653), as is the new in-CAS guard the change introduced.

**Files changed.**
- `src/lib/research-completion.ts` — `isCompletionSource` predicate; element check in `requireCompletionSources`; guarded reads at both `commitResearchPage` sites; docblocks rewritten on the error class and the guard (what is checked, why the element check lives here, what is still not routed through it).
- `src/lib/research-projects.ts` — docblock only: `isResearchProject` now records where the nested `completion.sources` check lives and why it is not here.
- `src/lib/__tests__/research-completion.test.ts` — 7 new cases in the existing bad-shape `describe`: the element-shape table (bare string, `null`, `{}`, nested array, wrong-typed required field, wrong-typed optional, `[good, bad]` asserting index 1), three commit-door refusals (truthy non-array, `sources` absent, `sources: null`), the pre-claim-guard row under a foreign fresh claim, the in-CAS corruption row, the post-ingest CAS corruption row, and an acceptance row carrying optionals plus an unknown key.

**Review findings.** 9 patched (1 medium, 8 low), 1 deferred (low — see frontmatter `deferred`), 11 rejected. Patched-severity score `3 × 1 + 1 × 8 = 11` (≥ 5), so `followup_review_recommended: true`.

**Verification.**
- `npx vitest run src/lib/__tests__/research-completion.test.ts` — 48 passed.
- `npx vitest run` over `research-runtime`, `research-completion-lifecycle`, `research-delivery`, `research-projects` — 183 passed, 1 skipped.
- `npx tsc --noEmit` — clean. `npm run lint` — clean (three pre-existing `jsx-ast-utils` warnings from untouched JSX files).
- Matrix audit: every I/O row has a covering test that ran and passed. Each new guard was mutation-checked: reverting the post-ingest CAS guard, the in-CAS guard, the pre-claim guard, or the element check each fails exactly the test that pins it.

**Residual risks.**
- The two corruption tests hold spies on `storage.readFileWithEtag` / `storage.writeFileIfMatch`. If registry persistence moves off those methods the seam stops firing; both tests assert their latch before anything else, so that fails loudly rather than passing vacuously.
- `isCompletionSource` is a second validator for a type declared in `research-projects.ts`. Nothing enforces that a new field on `ResearchCompletionSource` reaches it; the cross-references now added to both docblocks are the only link.
- Element validation now runs once per source per `checkpointSource` rather than once per drain. Source lists are small and bounded, so this is not measurable, but it is no longer an `O(1)` guard.
