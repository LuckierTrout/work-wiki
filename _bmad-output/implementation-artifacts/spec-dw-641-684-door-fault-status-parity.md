---
title: 'DW-641/684 — sibling doors give one verdict about one fault'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      PATCH /api/v1/projects/[wikiId]/reviews/[reviewId] with action
      "deep_research" still answers 500 for the contended-store fault this
      bundle made a 503 at the three /api/research siblings.
    evidence: |-
      That handler calls `createResearchProject`
      (`src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:141`) — the
      same function whose exhausted CAS in `applyResearchProjectMutation` throws
      `ResearchProjectBusyError` — and its catch is still the pre-DW-684 ladder
      `isClientInputError(error) ? 400 : 500` at `:167`, whose own comment cites
      "the `src/app/api/research/route.ts` idiom", the ladder this pass changed
      out from under it. `createResearchProject`'s docblock already names it as
      the second caller ("the Review-accept handler"). So an API agent is told
      a permanent server fault for a registry write that provably never landed
      and would succeed on an immediate retry, while the in-product door for the
      same store tells it to retry. Out of scope here: DW-684's intent
      enumerates `POST /api/research`, `PATCH` and `DELETE /api/research/[id]`
      only. Its suite would not surface it either —
      `epic8-v1-routes.test.ts:598` has a `ClientInputError` row and an EINVAL
      row and no `ResearchProjectBusyError` row, and that file mocks
      `@/lib/research-projects` with a BARE factory
      (`{ createResearchProject: vi.fn() }`), so an `instanceof` added to the
      route would evaluate against `undefined` under it; the fix needs the
      `importOriginal` spread `research-run-route.test.ts:27` uses for exactly
      this reason.
    location: >-
      src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167
    severity: low
baseline_revision: '92cae3afc1f69bdb7bfca6b48978d20823395663'
---

<intent-contract>

## Intent

**Problem:** Two families of sibling doors answer differently about the same
fault. (DW-641) `POST /api/names-terms` and `PUT /api/names-terms/[id]` end their
catches at `NamesTermConflictError ? 409 : 400`, so an EACCES, a full disk or a
lock timeout inside `createNamesTerm` / `updateNamesTerm` is reported as the
caller's bad input, while sibling `DELETE /api/names-terms/[id]` answers 500 for
the same class. (DW-684) `POST /api/research`, `PATCH` and
`DELETE /api/research/[id]` classify with `isClientInputError(error) ? 400 : 500`,
so `ResearchProjectBusyError` — transient CAS contention whose own sentence says
"retry the request." — is a retryable 503 at `POST /api/research/[id]/run` and
`POST /api/research/repair` but a permanent server fault at these three.

**Approach:** Give the Names & Terms store the typed caller-input class the
research store already throws (`ClientInputError`) so its two doors can classify
by TYPE — 403 / 409 / 400 / 500 — instead of flattening every non-conflict to
400, and add the `ResearchProjectBusyError → 503` branch to the three research
siblings. Pin each door's whole status ladder behaviourally, and correct the
`ResearchProjectBusyError` docblock that records the now-closed exclusion.

## Boundaries & Constraints

**Always:**
- Every status stays decided by TYPE alone. No regex over a message is added.
- Error MESSAGES are verbatim. Only the thrown CLASS and the returned STATUS
  change; every response body still carries the store's own sentence.
- The read-only 403 branch stays FIRST in each catch it already heads.
- The two Names & Terms doors must not regress the 400 they already give for a
  malformed request body: today `request.json()` rejecting (or a `null`/array
  body) lands in the catch and leaves as 400, and under a 500 default it would
  not. Guard the body explicitly, the `src/app/api/research/route.ts` idiom.
- New typed throws use `ClientInputError` from `src/lib/errors.ts` — do not mint
  a new class for Names & Terms.
- Behavioural coverage lands in the node suites that already own each door:
  `names-terms-routes.test.ts`, `names-terms.test.ts`, `research-route.test.ts`,
  `research-run-route.test.ts`.

**Block If:** A Names & Terms throw site turns out to be reachable both as a
caller fault and as a storage fault, so one class cannot serve both.

**Never:**
- Do not change `DELETE /api/names-terms/[id]`'s mapping — the ledger names it as
  the door that is already right.
- Do not add 404 / 409 branches to the three research siblings. DW-684 names the
  `ResearchProjectBusyError` split alone; `ResearchProjectNotFoundError` and
  `ResearchProjectConflictError` keep the statuses they have at those doors.
- Do not touch `POST /api/research/[id]/run` or `POST /api/research/repair`.
- Do not change any `READ_ONLY_REFUSAL` sentence, any route's inline 403 literal,
  or any `assertWritable` placement.
- Do not add a `Retry-After` header.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Storage fault on a Names & Terms create/update | `createNamesTerm` / `updateNamesTerm` rejects with a plain `Error` (EACCES, full disk, lock timeout) | 500, body `{ error: <message> }` | Was 400 |
| Caller's bad input at a Names & Terms door | `parseNamesTermInput` or `cleanInput` refuses (bad kind, blank canonical, non-list aliases, non-text field, bad email), or the 500-entry cap is hit | 400, message unchanged | `ClientInputError` |
| Malformed / non-object body at a Names & Terms door | body is `{ not json`, `null`, or `[]` | 400 with an explicit sentence | Guarded before the parse |
| Name clash on a Names & Terms create/update | `NamesTermConflictError` | 409, unchanged | Classified after the 403 branch |
| Flag flips mid-request at a Names & Terms door | writer throws `ReadOnlyError` | 403 with the kernel's own sentence, unchanged | 403 branch stays first |
| Storage fault on a Names & Terms delete | `deleteNamesTerm` rejects with a plain `Error` | 500, unchanged | Door already correct |
| Contended registry CAS at a research sibling | `createResearchProject` / `editResearchProject` / `retireResearchProject` throws `ResearchProjectBusyError` | 503, body carries the store's sentence (POST also keeps `availableProviders`) | Was 500 |
| Untyped fault carrying the same words | `new Error("Research projects were busy; retry the request.")` at any of the three | 500 | Type-only classification |
| Caller-input fault at a research sibling | `ClientInputError` | 400, unchanged | Existing branch |
| Storage fault at a research sibling | `new Error("EINVAL: invalid argument, open '…'")` | 500, unchanged | Existing branch |

</intent-contract>

## Code Map

- `src/lib/names-terms.ts` — the class change. Plain-`Error` throws to retype:
  `parseNamesTermInput` :56, :58, :64, :68; `cleanInput` :123, :125, :128;
  `createNamesTerm`'s `MAX_ENTRIES` cap :337. `NamesTermConflictError` (:42) and
  the `assertWritable` calls (:333, :360, :380) stay untouched. Already imports
  from `./errors` (`isEnoent`), so adding `ClientInputError` is one name.
- `src/app/api/names-terms/route.ts:43-62` — POST. `parseNamesTermInput((await
  request.json()) as Record<string, unknown>)` sits inline at :46; the body guard
  goes ahead of it. Catch already has the 403 branch at :54.
- `src/app/api/names-terms/[id]/route.ts:30-53` — PUT, same shape. `:74-83` is
  DELETE's already-correct 500 catch — leave it.
- `src/app/api/research/route.ts:140-158` — POST catch, `isClientInputError ? 400
  : 500`. Imports `ClientInputError`/`isClientInputError` from `@/lib/errors` and
  three names from `@/lib/research-projects`; add `ResearchProjectBusyError`.
- `src/app/api/research/[id]/route.ts:82-101` (PATCH) and `:118-134` (DELETE) —
  the same two-way ladder twice; the file imports nothing from
  `@/lib/research-projects` but `editResearchProject`/`getResearchProject`.
- `src/lib/research-projects.ts:85-116` — `ResearchProjectBusyError`'s docblock.
  Its "ONE DOOR READS IT SO FAR" paragraph names these three siblings as
  deliberately 500 and calls the branch "separate work"; that becomes false.
  `applyResearchProjectMutation` (:761) throws it after `CAS_ATTEMPTS`;
  `createResearchProject` (:871), `editResearchProject` (:1042) and
  `deleteResearchProject` (:1232, reached by `retireResearchProject`,
  `src/lib/research-runtime.ts:586`) all route through it.
- `src/app/api/research/[id]/run/route.ts:124-135` — the ladder to copy the
  branch from. `src/app/api/research/repair/route.ts:69` — the second worked
  example (`error instanceof ResearchProjectBusyError ? 503 : 500`).
- `src/lib/__tests__/names-terms-routes.test.ts` — mocks `@/lib/auth` and the
  three writers with a spread-preserving factory; has `request(method, body)`,
  saves/clears `YOPEDIA_READONLY`. Its last case (:207) already pins the 409 and
  DELETE's 500; extend that describe.
- `src/lib/__tests__/names-terms.test.ts` — the real-store suite; the conflict
  case at :56 is the `rejects.toBeInstanceOf` shape to copy for the new class.
- `src/lib/__tests__/research-route.test.ts:157-190` — the POST classification
  rows (`still 500s a storage failure`, the EINVAL row); add the 503 beside them.
- `src/lib/__tests__/research-run-route.test.ts:443-453` (PATCH store-fault
  `it.each`) and `:571-583` (DELETE store-fault `it.each`) — add a row to each.
  Its `@/lib/research-projects` mock is a PARTIAL spread, so
  `ResearchProjectBusyError` is a real binding; it is already imported at :50.
- `AGENTS.md` "Test environments" — node suites are `*.test.ts` under
  `__tests__`; run with `pnpm exec vitest run --project node <path>`.
- Consumers are status-agnostic: `NamesTermsSettings.tsx` and
  `ActionInbox.tsx:134` read `error` text only, and
  `src/lib/workbench-request.ts:157` already excludes 503 from
  `UNCONFIRMED_STATUSES`, so a 503 from a research sibling is read as a verdict
  that nothing was written.

## Tasks & Acceptance

**Execution:**
- `src/lib/names-terms.ts` — import `ClientInputError` from `./errors` and throw
  it in place of `new Error(...)` at the eight caller-input sites listed in the
  Code Map, messages verbatim — the doors can only classify by type if the store
  types what is the caller's fault, the `research-projects.ts` idiom.
- `src/app/api/names-terms/route.ts` — guard the request body (reject a
  non-JSON, `null` or array body with 400 before the parse), then end the POST
  catch `NamesTermConflictError → 409`, `isClientInputError → 400`, else 500 —
  a store that cannot be written is not the owner's entry being wrong.
- `src/app/api/names-terms/[id]/route.ts` — the same guard and the same catch
  ladder in PUT; DELETE unchanged.
- `src/app/api/research/route.ts` — import `ResearchProjectBusyError` and add its
  503 branch to the POST catch, after the 400 and before the 500 fallthrough —
  contention is transient and the sentence already tells the caller to retry.
- `src/app/api/research/[id]/route.ts` — the same import and the same branch in
  both the PATCH and DELETE catches.
- `src/lib/research-projects.ts` — rewrite `ResearchProjectBusyError`'s "ONE DOOR
  READS IT SO FAR" paragraph: the run door, the repair door and the three
  siblings all answer 503, so the class now does mean 503 at every research door
  that reads it. Comment-only.
- `src/lib/__tests__/names-terms.test.ts` — pin that a bad kind, a blank
  canonical and a malformed email reject with `ClientInputError` — the source of
  truth the doors' 400 now depends on.
- `src/lib/__tests__/names-terms-routes.test.ts` — add the DW-641 rows for POST
  and PUT: a plain `Error` is 500 (was 400), a `ClientInputError` is 400, the
  `NamesTermConflictError` 409 and the `ReadOnlyError` 403 are unchanged, a
  malformed and a `null` body are still 400, and DELETE's 500 is unchanged.
- `src/lib/__tests__/research-route.test.ts` — add a `ResearchProjectBusyError`
  → 503 row for POST plus an untyped-same-sentence → 500 control.
- `src/lib/__tests__/research-run-route.test.ts` — add a `ResearchProjectBusyError`
  → 503 row (and the untyped control) to the PATCH and DELETE store-fault tables.

**Acceptance Criteria:**
- Given a writable deployment, when `createNamesTerm` or `updateNamesTerm`
  rejects with a class that is neither `NamesTermConflictError`,
  `ReadOnlyError` nor `ClientInputError`, then the door answers 500 and
  `DELETE /api/names-terms/[id]` answers 500 for that same class — one verdict
  from the one store.
- Given a writable deployment, when `createResearchProject`,
  `editResearchProject` or `retireResearchProject` throws
  `ResearchProjectBusyError`, then `POST /api/research`, `PATCH` and
  `DELETE /api/research/[id]` each answer 503 — the status
  `POST /api/research/[id]/run` already answers for that class.
- Given any door touched here, when the caught value is an untyped `Error` whose
  message reads like a refusal, then the status is 500 — no message decides one.
- Given the full suite, when `pnpm test` runs, then it passes with no new
  failures.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` `src/lib/research-projects.ts` — the rewritten `ResearchProjectBusyError` docblock asserted "EVERY RESEARCH DOOR READS IT AS 503", which the v1 `deep_research` door falsifies. Narrowed to the four doors that do answer 503 and added a paragraph naming the one that still answers 500 and why it was outside this bundle. Comment-only.
  - `[low]` `[patch]` `src/lib/__tests__/names-terms-routes.test.ts` — every new 400 row injected a `ClientInputError` at the mocked writer, so the end-to-end 400 held only by transitivity; the suite's mock spreads the original, leaving `parseNamesTermInput` live. Added a four-row table sending well-formed object bodies the REAL parse refuses, asserting 400 with the parse's own sentence and that neither writer was called.
  - `[low]` `[patch]` `src/lib/__tests__/research-run-route.test.ts` — the research half of "pin the parity" was three independent per-door literals while the names-terms half had a real cross-verb control. Added one test driving PATCH and DELETE with the same `ResearchProjectBusyError` and asserting both answer 503.

Rejected as noise (not recorded in `deferred`): matching `ResearchProjectBusyError` structurally (`err.name`) instead of `instanceof` — the two pre-existing doors that answer 503 both use `instanceof`, and inventing an `isResearchProjectBusyError` would change a repo-wide contract nothing asked for; the same argument aimed at `NamesTermConflictError` under the new 500 default (the catch already used `instanceof` and the route comment records the choice); that `request.json()`'s catch also swallows an aborted or truncated stream (the verbatim `POST /api/research` idiom, and the old blanket 400 did the same); adding a `ClientInputError` rung to `DELETE /api/names-terms/[id]` (no such class can reach it, and the intent names that door as already right); extracting the duplicated JSON-body guard into a helper and pinning its two sentences with a copy-parity test (the repo copies these idioms by convention — the DW-316 pass rejected the same suggestion for the 403 branch); that the tests now pin an absolute store path inside a 500 body (messages pass through unchanged at every sibling door, and the same string leaked as a 400 before); adding 404/409 rungs for `ResearchProjectNotFoundError`/`ResearchProjectConflictError` at the three siblings (DW-684 names the Busy split alone); returning `deleted: true` on a contended DELETE (`retireResearchProject` re-tombstones on retry, and 503 is precisely the "nothing landed" verdict); "pin the parity" as a source scan over every door (a change of its own, already recorded against read-only treatment by the sibling entry in `spec-dw-316-319-526`); and the I/O matrix's parenthetical "(POST also keeps `availableProviders`)", which describes a field `POST /api/research`'s catch never carried — the Always clause "only the thrown CLASS and the returned STATUS change" settles it as a no-op.

## Design Notes

The research branch, copied from `src/app/api/research/[id]/run/route.ts`:

```ts
if (isReadOnlyError(error)) { /* 403, unchanged */ }
const status = isClientInputError(error)
  ? 400
  : error instanceof ResearchProjectBusyError
    ? 503
    : 500;
```

The Names & Terms ladder, which is the workspace-profile fix (DW-319) applied to
a second store — flatten nothing, classify by type:

```ts
if (isReadOnlyError(error)) { /* 403, unchanged */ }
const status = error instanceof NamesTermConflictError
  ? 409
  : isClientInputError(error)
    ? 400
    : 500;
```

`isClientInputError` (structural on `err.name`) rather than `instanceof`, for
the duplicated-module-graph reason its docblock states; `NamesTermConflictError`
keeps `instanceof`, which is what the existing catch already uses.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/names-terms-routes.test.ts src/lib/__tests__/names-terms.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-run-route.test.ts` -- expected: all pass, including the new rows.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: clean over the touched files.
- `pnpm test` -- expected: full suite green, no new failures.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two families of sibling doors now give one verdict about
one fault. DW-641: the Names & Terms store types its caller-input refusals as
`ClientInputError`, so `POST /api/names-terms` and `PUT /api/names-terms/[id]`
classify by type — 403 refusal, 409 clash, 400 the caller's input, 500 everything
else — instead of flattening every non-conflict into the owner's bad input, and
both doors guard the request body ahead of the parse so the 400 they used to give
by accident for an unreadable body is now given on purpose. DW-684:
`POST /api/research`, `PATCH` and `DELETE /api/research/[id]` gained the
`ResearchProjectBusyError → 503` rung the run and repair doors already had.

**Files changed.**
- `src/lib/names-terms.ts` -- eight caller-input throws retyped to `ClientInputError`, messages verbatim; docblocks on `parseNamesTermInput`/`cleanInput` record why the class is load-bearing.
- `src/app/api/names-terms/route.ts` -- POST: pre-parse body guard, then the 409/400/500 type ladder behind the existing 403.
- `src/app/api/names-terms/[id]/route.ts` -- PUT: the same guard and ladder; DELETE untouched.
- `src/app/api/research/route.ts` -- POST catch gained the 503 rung.
- `src/app/api/research/[id]/route.ts` -- PATCH and DELETE catches gained the same rung.
- `src/lib/research-projects.ts` -- `ResearchProjectBusyError` docblock: four doors answer 503, and the one v1 door that still answers 500 is named. Comment-only.
- `src/lib/__tests__/names-terms.test.ts` -- store-seam pins: `cleanInput`'s three refusals, `parseNamesTermInput`'s four, and the 500-entry cap all `ClientInputError`.
- `src/lib/__tests__/names-terms-routes.test.ts` -- per-door status tables for POST and PUT, a three-verb storage-fault control, an untyped-message control, body-shape 400s, live-parse 400s, and a PUT 404 control.
- `src/lib/__tests__/research-route.test.ts` -- POST 503 row plus the untyped-same-sentence 500 control.
- `src/lib/__tests__/research-run-route.test.ts` -- 503 and untyped-500 rows in the PATCH and DELETE store-fault tables, plus one cross-verb 503 parity test.

**Review findings breakdown.** 3 patches applied (all low), 1 item deferred
(low), 10 rejected. See the Review Triage Log above.

**Follow-up review recommendation.** false. Patched findings by severity: high 0,
medium 0, low 3. Score: no high-severity patch, so no further pass is warranted.

**Verification performed.**
- `pnpm exec vitest run --project node` over the four target suites -- 149 passed.
- `pnpm exec tsc --noEmit` -- exit 0, no errors.
- `pnpm lint` -- no errors (only the three pre-existing `jsx-ast-utils` warnings in unrelated files).
- `pnpm test` -- 369 files, 9121 passed, 1 skipped, 0 failures.
- Matrix audit: every I/O row is covered by a test that ran and passed in the output above.

**Residual risks.**
- The two Names & Terms doors now default to 500, so any future untyped
  `throw new Error` added to that store's validation path would silently become a
  server fault. The `parseNamesTermInput`/`cleanInput` docblocks flag it, and
  `names-terms.test.ts` fails if the existing sites revert.
- The 503 rung matches `ResearchProjectBusyError` with `instanceof`, copying the
  run and repair doors. Under a duplicated module graph it would degrade to 500 —
  the failure mode `isClientInputError` is structural to avoid. Considered and
  kept for consistency with the two doors that came first; a structural
  classifier would be a repo-wide change of its own.
- The I/O matrix's parenthetical "(POST also keeps `availableProviders`)"
  describes a field `POST /api/research`'s catch never carried. Read as a no-op,
  as the Always clause requires; no body field was added.
