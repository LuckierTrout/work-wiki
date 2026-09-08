---
title: 'Research read-only CAS sentinel identity (DW-657, DW-658, DW-661)'
type: 'bugfix'
created: '2026-08-31'
baseline_revision: '94edcc86088fb19aa4445ae9e9daa13eda3a92b6'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A read-only `queueResearchProject` releases the project's research slot
      before its CAS refuses, so a refused start still mutates the deployment.
    evidence: |-
      `queueResearchProject` calls `releaseResearchSlotAndConfirmGone`
      (src/lib/research-runtime.ts:412) ahead of the CAS, and
      `research-concurrency.ts` carries no `isReadOnly`/`assertWritable` gate of
      its own. Demonstrated during review: with a project holding a real lease
      and the flag set, the call throws `ReadOnlyError` as intended, but
      `research-leases.json` goes from `[{projectId, attemptId, ...}]` to `[]`
      while the row still records that `runAttemptId`. Pre-existing — the same
      release ran before this change, which merely relabelled what the CAS then
      threw — so it is out of this bundle's scope, but it is a write on a
      deployment that refused the request, which is the invariant the research
      read-only work exists to hold. `read-only-store-gate.test.ts`'s queue case
      now excludes the lease file from its byte comparison and says why, rather
      than seeding the lease to manufacture a green whole-tree snapshot.
    location: >-
      src/lib/research-runtime.ts:412
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-527's read-only CAS sentinel is collapsed to `null` inside `mutateResearchProject` (`src/lib/research-projects.ts:649`), so five throwing research entry points mislabel a mid-request read-only refusal: `retireResearchProject` returns `false` (→ `DELETE /api/research/[id]` 404 "Research project not found."), `queueResearchProject`/`cancelResearchProject` throw `ResearchProjectNotFoundError` (→ `POST /api/research/[id]/run` 404), and `note`/`updateResearchAttempt` throw `ResearchLeaseError("Research attempt for <id> was replaced.")`. The sentinel is reachable only from `applyResearchProjectMutation`, so no runtime caller can tell a refusal from a lost CAS race (DW-661).

**Approach:** Add refusal-preserving siblings of the two fail-soft wrappers that carry `RESEARCH_WRITE_REFUSED` through instead of collapsing it, leave the collapsing originals byte-for-byte intact for their ~30 fail-soft call sites, move only the five named entry points onto the siblings and convert the sentinel there into `ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)`, and give the two doors those entry points stand behind the `isReadOnlyError` → 403 branch `PATCH` on the same file already has.

## Boundaries & Constraints

**Always:**
- `mutateResearchProject`, `updateResearchProject`, `updateResearchProjectIf` and `editResearchProject` keep their exact `Promise<ResearchProject | null>` signatures and their existing behaviour. No other mutation call site in `research-runtime.ts` is edited.
- The refusal still happens BEFORE any read, lease or write, and the CAS primitive and its fail-soft wrappers still refuse by RETURNING a value — never by throwing.
- One sentence per deployment state: reuse `READ_ONLY_REFUSAL.researchMutate`. No new refusal key, no new wording.
- `retireResearchProject` keeps its own `assertWritable` as its first statement, ahead of the CAS call.
- Every converted path is pinned by a test that reaches the CAS on a read-only deployment and asserts the stored bytes are unchanged.

**Block If:** preserving the sentinel cannot be done without changing the return type of `mutateResearchProject`/`updateResearchProjectIf` themselves, or without editing the fail-soft mutation call sites in `research-runtime.ts`/`research-completion.ts` — that is the larger change DW-661 records as set aside.

**Never:**
- Do not edit `src/lib/research-completion.ts`, and do not touch the fail-soft mutation call sites (progress writes without an attempt id, provider-failure writes, admission/recovery writes, reconcile).
- Do not convert `queueResearchProject`'s delivery-retry `updateResearchProjectIf` — it is not one of the named returns.
- Do not add `assertWritable` inside `applyResearchProjectMutation`, `lockedMutation`, or any `mutate*`/`update*` wrapper.
- No new refusal wording, no repair/recovery route for a run stranded at `collecting`, no client copy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Retire past the route gate | read-only at the CAS, project stored | `retireResearchProject` throws `ReadOnlyError`; no tombstone, no "Deleted." label | `DELETE /api/research/[id]` → 403 `researchMutate` |
| Start a run past the route gate | read-only at the CAS, project stored | `queueResearchProject` throws `ReadOnlyError`, not `ResearchProjectNotFoundError` | `POST .../run` → 403 `researchMutate` |
| Cancel past the route gate | read-only at the CAS, project stored | `cancelResearchProject` throws `ReadOnlyError` | `POST .../run` (`action: "cancel"`) → 403 |
| Deployment flips read-only mid-run | attempt write refused | `updateResearchAttempt` and `note` throw `ReadOnlyError` carrying `researchMutate`; row stays `collecting` | refusal propagates out of `runResearchProject`; nothing written |
| Genuine lost attempt race, writable | `runAttemptId` replaced | still `ResearchLeaseError("Research attempt for <id> was replaced.")` | unchanged |
| Project genuinely absent, writable | no stored row | `retireResearchProject` → `false` → 404; queue/cancel → `ResearchProjectNotFoundError` → 404 | unchanged |
| Fail-soft caller, read-only | progress write with no attempt id | `updateResearchProject`/`updateResearchProjectIf` still return `null` and never throw | unchanged |
| Non-refusal fault at either door | `ClientInputError` / plain `Error` | 400 / 500 as today | the new branch must not widen |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` — `RESEARCH_WRITE_REFUSED`/`isResearchWriteRefused` (:380-386), `applyResearchProjectMutation` (:427, refuses at :434), `lockedMutation` (:466), `mutateResearchProject` (:635) whose last line `return isResearchWriteRefused(result) ? null : result;` (:649) is DW-661's collapse, private `mutateProject` (:691) which `updateResearchProject` (:577), `updateResearchProjectIf` (:614) and `editResearchProject` (:668) all funnel through. `createResearchProject` (:571) and `deleteResearchProject` (:806) already convert the sentinel — copy their idiom.
- `src/lib/research-runtime.ts` — `note` (:225; refusal-relevant lines :236-247), `updateResearchAttempt` (:306-320), `queueResearchProject` (:322-419, converted return at :415), `cancelResearchProject` (:423-443, converted return at :439), `retireResearchProject` (:462-, `assertWritable` at :472, CAS at :477, `if (!retired) return false;` at :498). Imports `READ_ONLY_REFUSAL, assertWritable, isReadOnlyError` at :56 — `ReadOnlyError` and `isResearchWriteRefused` must be added.
- `src/app/api/research/[id]/route.ts` — `PATCH`'s catch (:86-89) is the exact `isReadOnlyError` → 403 idiom to copy into `DELETE`'s catch (:117-120), which today is `ClientInputError ? 400 : 500` (this is also open ledger entry DW-639).
- `src/app/api/research/[id]/run/route.ts` — the type ladder in the catch (:105-114) has no read-only branch; add one ahead of it.
- `src/lib/read-only.ts` — `ReadOnlyError` (:165), `READ_ONLY_REFUSAL.researchMutate` (:285), `isReadOnlyError` (:377, matches on `err.name`).
- `src/lib/__tests__/read-only-store-gate.test.ts` — `expectRefusal`/`snapshot`/`seededSnapshot` helpers (:128-163), the mid-flip `vi.spyOn(config, "isReadOnly").mockImplementation(() => reads++ > 0)` idiom (:565), the source-order pin listing `["research-runtime", "retireResearchProject", "mutateResearchProject(owner"]` (:457) **which breaks if the call is renamed**, and the "carry no THROWING gate" list (:480-499).
- `src/lib/__tests__/research-run-route.test.ts` — mocks both runtime and store wholesale; the "403s a PATCH whose writer refuses mid-request" / foreign-`ReadOnlyError` / "does not swallow the other outcomes" trio (:461-505) is the template for the two new doors.
- `src/lib/__tests__/research-runtime.test.ts` — real store over a temp `DATA_DIR`; `project()` helper (:201), `mockedSearch`/`mockedExtract`, and the save/restore-`YOPEDIA_READONLY` idiom (:1357-1365). `research-completion.ts` and `research-concurrency.ts` carry no read-only gate, so staging and lease writes still succeed while the flag is set.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- extract the body of `mutateResearchProject` into a new exported `mutateResearchProjectOrRefusal` returning `Promise<ResearchProject | ResearchWriteRefused | null>`; make `mutateResearchProject` the collapsing wrapper over it. Split `mutateProject` the same way into a private refusal-preserving core plus a collapsing wrapper, and export `updateResearchProjectIfOrRefusal` over the core. `updateResearchProject`, `updateResearchProjectIf` and `editResearchProject` keep calling the collapsing wrapper unchanged. -- gives every fail-soft wrapper a refusal-preserving sibling, so the sentinel is no longer distinguishable only at the primitive (DW-661).
- `src/lib/research-runtime.ts` -- import `ReadOnlyError` and `isResearchWriteRefused`; move `note`, `updateResearchAttempt`, `queueResearchProject`'s final CAS, `cancelResearchProject`'s CAS and `retireResearchProject`'s CAS onto the `*OrRefusal` siblings and convert the sentinel to `throw new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)` BEFORE the existing null branch; widen `note`'s catch so it rethrows a read-only refusal instead of logging it as a failed progress update. -- each gated entry point reports the deployment state instead of "not found" / "was replaced" (DW-657, DW-658).
- `src/app/api/research/[id]/route.ts` -- add the `isReadOnlyError(error)` → 403 first branch to `DELETE`'s catch, mirroring `PATCH`'s. -- without it the newly thrown refusal leaves this door as a 500.
- `src/app/api/research/[id]/run/route.ts` -- add the same branch ahead of the status ladder. -- same reason, for start and cancel.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- update the source-order pin to the renamed call, add `mutateResearchProjectOrRefusal` to the ungated-source list, and add cases: the `*OrRefusal` siblings return `RESEARCH_WRITE_REFUSED` while their collapsing originals still return `null`; `retireResearchProject` mid-flip, `queueResearchProject` and `cancelResearchProject` on a read-only deployment each refuse with `researchMutate` and leave the tree byte-identical. -- pins DW-657 and DW-661 at the layer no route test can reach.
- `src/lib/__tests__/research-runtime.test.ts` -- add two mid-run flip cases: flipping inside the search mock so `updateResearchAttempt` is the first refused write, and flipping inside the extract mock with two fetch targets so `note` is, each asserting a `ReadOnlyError` with the `researchMutate` sentence, no "was replaced" wording, and a row still at `collecting`. -- pins DW-658, including that `note`'s catch does not swallow the refusal.
- `src/lib/__tests__/research-run-route.test.ts` -- add 403 cases for a mid-request refusal from `queueResearchProject`, `cancelResearchProject` and `retireResearchProject`, a foreign `ReadOnlyError` for each door, and controls proving the branch does not swallow `ClientInputError`/`ResearchProjectNotFoundError`/plain faults. -- pins the door half of the I/O matrix.

**Acceptance Criteria:**
- Given a read-only deployment reached past an HTTP gate, when any of the five named entry points reaches its CAS, then it reports `READ_ONLY_REFUSAL.researchMutate` and `isReadOnlyError` is true of what it throws.
- Given a writable deployment, when the same five paths run, then their behaviour, return values and error types are unchanged from before this change.
- Given the ~30 fail-soft mutation call sites, when the deployment is read-only, then they still receive `null` and no `ReadOnlyError` escapes them.

## Spec Change Log

_No loopback occurred; no amendment was needed._

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 2, low 9)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The queue-refusal case in `read-only-store-gate.test.ts` pre-seeded the lease so its whole-tree byte assertion could not see that `queueResearchProject` releases a real slot before refusing. Rewritten to hold a real lease, assert the registry bytes and the rest of the tree with the lease file excluded, and state the ungated pre-CAS release as pre-existing.
  - `[medium]` `[patch]` The "progress note is refused" case proved only a negative (no "progress update failed" log) and would have passed had the refusal come from `updateResearchAttempt`. Added the positive discriminator on the stored `progress` message, plus its mirror on the search-flip case.
  - `[low]` `[patch]` `TAVILY_API_KEY` was saved and restored but never cleared in `beforeEach`, against that suite's own rule; also corrected the comment about where the credential is read from.
  - `[low]` `[patch]` The "no THROWING gate" source pin could not see the new private `mutateProjectOrRefusal`, which now holds the patch body; regex widened and `mutateProjectOrRefusal`/`mutateProject` added.
  - `[low]` `[patch]` The new exported siblings were pinned only on their refusal branch; added writable coverage of hit, missing id and false predicate.
  - `[low]` `[patch]` Both doors' foreign-`ReadOnlyError` cases carried the same sentence their early gate serves, so a handler re-serving its own literal stayed green; they now throw a different sentence and assert the echo.
  - `[low]` `[patch]` The new cancel cases left `mockedCancel` rejecting past their block (`vi.clearAllMocks()` clears calls, not implementations); switched to one-shot rejections with a block-scoped reset.
  - `[low]` `[patch]` `read-only.ts` doc drift: the backstop-door enumeration and count now include `DELETE /api/research/[id]` and `POST /api/research/[id]/run`, and a new paragraph records the refusal-preserving siblings and the five converting entry points.
  - `[low]` `[patch]` `research-projects.ts` doc drift: `applyResearchProjectMutation`'s wrapper list and `lockedMutation`'s "two kinds of caller" note brought in step with the split.
  - `[low]` `[patch]` `note`'s docblock still headlined an unqualified fail-soft contract; narrowed to say a read-only refusal also leaves by a throw.
  - `[low]` `[patch]` The DELETE catch comment was missing a verb and a dropped "would have".

## Design Notes

The split is mechanical and one-directional: the refusal-preserving function holds the logic, the fail-soft name becomes one line over it.

```ts
export async function mutateResearchProjectOrRefusal(owner, id, mutate) { /* the existing body */ }

export async function mutateResearchProject(owner, id, mutate): Promise<ResearchProject | null> {
  const result = await mutateResearchProjectOrRefusal(owner, id, mutate);
  return isResearchWriteRefused(result) ? null : result;
}
```

At each entry point the conversion goes ahead of the existing null branch, so "gone" and "refused" stop sharing one answer:

```ts
const retired = await mutateResearchProjectOrRefusal(owner, id, (current) => { /* … */ });
if (isResearchWriteRefused(retired)) throw new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate);
if (!retired) return false;
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/research-projects.test.ts` -- expected: all pass, including the updated source-order pin
- `pnpm lint` -- expected: no new errors
- `npx tsc --noEmit` -- expected: clean; the union return types must not leak into any unedited call site
- `pnpm test` -- expected: full suite green

## Auto Run Result

Status: done

**Implemented change.** DW-527's read-only CAS sentinel is no longer collapsed on every path out of the store. `research-projects.ts` gains a refusal-preserving sibling for each fail-soft wrapper — exported `mutateResearchProjectOrRefusal` and `updateResearchProjectIfOrRefusal` over a private `mutateProjectOrRefusal` — while `mutateResearchProject`, `updateResearchProject`, `updateResearchProjectIf` and `editResearchProject` keep their exact signatures and their collapse, so none of the ~30 fail-soft call sites in `research-runtime`/`research-completion` was edited. The five throwing entry points the bundle names — `note`, `updateResearchAttempt`, `queueResearchProject`, `cancelResearchProject`, `retireResearchProject` — now take the siblings and convert `RESEARCH_WRITE_REFUSED` into `ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)` ahead of their existing null branch, so a mid-request refusal stops arriving as "Research project not found." or "Research attempt for <id> was replaced.". The two doors those entry points stand behind gained the `isReadOnlyError` → 403 first branch `PATCH` on the same file already carried, without which the newly thrown refusal would have left as a 500.

**Files changed.**
- `src/lib/research-projects.ts` — the wrapper split, plus the docblocks that describe the collapse.
- `src/lib/research-runtime.ts` — the five conversions; `note`'s catch now rethrows a refusal instead of logging it as a failed progress update.
- `src/app/api/research/[id]/route.ts` — `DELETE`'s catch classifies a read-only refusal as 403 (this also closes open ledger entry DW-639).
- `src/app/api/research/[id]/run/route.ts` — the same branch ahead of the status ladder, for start and cancel.
- `src/lib/read-only.ts` — module note brought in step: the backstop-door enumeration and the research-CAS topology paragraph.
- `src/lib/__tests__/read-only-store-gate.test.ts` — source pins updated and widened; new cases for the siblings (refusal and non-refusal outcomes) and for the three refusing entry points.
- `src/lib/__tests__/research-runtime.test.ts` — a mid-run flip block: one case where `updateResearchAttempt` is the first refused write, one where `note` is, and a writable control that still reports a genuine lease race.
- `src/lib/__tests__/research-run-route.test.ts` — 403 cases, foreign-`ReadOnlyError` cases and non-swallow controls for `DELETE`, start and cancel.

**Review findings.** 11 patched (2 medium, 9 low), 1 deferred (low), 11 rejected. 0 intent gaps, 0 spec repairs. Rejected as out of scope or unfounded: the sibling CAS call sites the intent does not name (`queueResearchProject`'s delivery-retry write, the admission claim, `commitResearchPage`'s write claim), a shared conversion helper (the inline idiom matches `createResearchProject`/`deleteResearchProject`), the absence of a route→runtime end-to-end test (this repo's door suites mock the lib by convention), and a claim that `note` newly kills a run on a refusal — it already threw `ResearchLeaseError` on that path before this change, so only the label moved.

**Follow-up review.** Patched severities: high 0, medium 2, low 9. Score = 3 × 2 + 1 × 9 = 15, which is ≥ 5, so `followup_review_recommended: true`.

**Verification.**
- `npx tsc --noEmit` — clean; the union return types leak into no unedited call site.
- `pnpm lint` — no errors (only the repo's pre-existing `jsx-ast-utils` notices).
- The four named suites — 247 passed, 1 skipped.
- `pnpm test` — 354 files, 8394 passed, 1 skipped.
- Non-vacuity: each production change was reverted in isolation and the tests that claim to pin it confirmed failing, and each amended assertion was confirmed failing under an injected regression of the exact behaviour it names.
- One full-suite run between the patch pass and the final one reported 5 failures in `research-runtime.test.ts`, led by a 5000 ms timeout on the pre-existing "logs a read-only skip" case. It did not reproduce: that file passes alone (117) and the next full run was green (8394). Consistent with machine load against the 5 s per-test timeout, not with the change.

**Residual risks.**
- `POST /api/tasks/run` already classifies `isReadOnlyError` as 403. Before this change a mid-run flip left `runResearchProject` as a `ResearchLeaseError` and fell through to that route's transient-retry 5xx, so the queue redelivered the `run-research` task; it now matches the 403 branch and the task is not redelivered. Recovery falls to `reconcileResearchProjects`, which is the path DW-658's own text names, and retrying a read-only deployment would have failed again — but the redelivery behaviour for that task did change and no test exercises it.
- DW-658's second symptom is unchanged by design: the run's failure-marking write is refused too, so the row stays `collecting` with no owner-visible error until the deployment is writable and reconcile reaps it. The spec forbids a repair route; the new tests pin this state rather than fix it.
- DW-661 is closed at the layer the bundle intent names — a refusal is now distinguishable above the primitive, and the five gated entry points distinguish it. The ~30 fail-soft call sites still see a plain `null`, which is the larger change the ledger entry itself set aside.
- The one deferred item above: a read-only `queueResearchProject` still releases the project's lease before the CAS refuses.
