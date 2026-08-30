---
title: 'Research store read-only refusal (DW-527, DW-528)'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
baseline_revision: '271ee22654ac1bc1036ba823773995f3235f40a7'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The runtime's gated entry points report a mid-request read-only refusal as
      "Research project not found." instead of a refusal.
    evidence: |-
      DW-527 made the CAS return `null` when read-only, and
      `mutateResearchProject` collapses it for its fail-soft callers. Three
      GATED, throwing entry points read that `null` as "the row is gone":
      `retireResearchProject` (src/lib/research-runtime.ts:490) returns `false`,
      which `DELETE /api/research/[id]` serves as 404; `queueResearchProject`
      (:413) and `cancelResearchProject` (:437) raise
      `ResearchProjectNotFoundError`, which `POST /api/research/[id]/run` serves
      as 404. Only reachable when the flag flips between an entry point's own
      `assertWritable` and its CAS write, and nothing is written either way —
      but the owner is told a stored project does not exist. `editResearchProject`,
      `createResearchProject` and `deleteResearchProject` each convert that same
      window back into a `ReadOnlyError`; these three were left on the collapse
      because DW-527's intent names the owner-editing entry point only.
    location: >-
      src/lib/research-runtime.ts:490
    severity: medium
  - summary: >-
      A deployment that turns read-only mid-run aborts the run with "Research
      attempt was replaced" and leaves the row at `collecting`.
    evidence: |-
      `note` (src/lib/research-runtime.ts:236) and `updateResearchAttempt`
      (:312) turn a `null` from the CAS into
      `ResearchLeaseError("Research attempt for <id> was replaced.")`. Since
      DW-527 that `null` is also how a read-only refusal arrives, so a mid-run
      flip reports lease replacement rather than the deployment state, and the
      failure-marking write that would follow is refused too — the row stays
      `collecting` until the deployment is writable again and reconcile reaps
      it. Nothing is written, so this is a labelling and recovery-latency cost,
      not damage. No test flips the flag during a run.
    location: >-
      src/lib/research-runtime.ts:236
    severity: medium
  - summary: >-
      `createResearchProject` answers a mid-flip refusal with `researchMutate`
      while its own gate answers `researchCreate`.
    evidence: |-
      src/lib/research-projects.ts:571 throws
      `new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)` on the sentinel,
      three lines below a gate that throws `READ_ONLY_REFUSAL.researchCreate`.
      One door, two sentences — and `researchCreate` exists precisely because it
      says the thing `researchMutate` cannot: that nothing was created. The
      wording was pinned by this spec's own I/O matrix, so the code is correct
      as specified; the matrix row is what should have said `researchCreate`.
    location: >-
      src/lib/research-projects.ts:571
    severity: low
  - summary: >-
      Reconcile's orphan-outbox catch still calls a read-only refusal a damaged
      outbox — the sibling of the line DW-528 fixed.
    evidence: |-
      src/lib/research-runtime.ts:843 logs
      `reconcile skipped damaged orphan outbox <id>` for every fault, and
      `drainResearchOutbox` reaches the gated kernel page writers, so a
      `ReadOnlyError` lands there exactly as it lands in the per-project catch
      one loop above. DW-528's intent names the per-project catch only, so the
      orphan loop was left alone rather than swept in.
    location: >-
      src/lib/research-runtime.ts:843
    severity: low
  - summary: >-
      The read-only sentinel is distinguishable only at the CAS primitive; every
      fail-soft runtime caller still sees a plain `null`.
    evidence: |-
      `mutateResearchProject` (src/lib/research-projects.ts:649) collapses
      `RESEARCH_WRITE_REFUSED` to `null`, which is what keeps the ~30
      `research-runtime`/`research-completion` call sites unedited. So at the
      surface DW-527's intent named — "the fail-soft research-runtime callers
      can distinguish" — a refusal is still indistinguishable from a lost CAS
      race; only a direct caller of `applyResearchProjectMutation` can tell them
      apart, via `isResearchWriteRefused`. Closing that would mean editing the
      call sites one at a time, which is the larger change the ledger entry
      itself set aside.
    location: >-
      src/lib/research-projects.ts:649
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-527 — `applyResearchProjectMutation` and its wrappers are ungated, so a direct library caller (CLI, MCP, agent runtime, script) can still patch a research project's fields on a read-only deployment; the named hole is `PATCH /api/research/[id]`'s writer, `updateResearchProjectIf`. DW-528 — `reconcileResearchProjects`' per-project `catch` logs every fault as `reconcile skipped damaged project`, so a `ReadOnlyError` from the gated `deleteResearchProject` would be reported to an operator as data damage.

**Approach:** Give the CAS primitive a NON-THROWING refusal — when `isReadOnly()`, `applyResearchProjectMutation` writes nothing and returns a distinguishable sentinel, which the fail-soft wrappers collapse to the `null` their runtime callers already compensate for (a lost CAS race). Add a separate, throwing, gated owner-editing entry point that `PATCH /api/research/[id]` uses, so the owner reads the refusal sentence instead of a mislabelled 409. Add an `isReadOnlyError` branch to reconcile's per-project catch.

## Boundaries & Constraints

**Always:**
- The refusal happens BEFORE any storage read or write: no `readFileWithEtag`, no `writeFileIfMatch`, no lock lease. Refusal cases assert stored BYTES are unchanged, not just the return value.
- One sentence per deployment state: reuse `READ_ONLY_REFUSAL.researchMutate`. No new refusal key, no new wording.
- The runtime's fail-soft contract is preserved: `mutateResearchProject`, `updateResearchProject` and `updateResearchProjectIf` still return `ResearchProject | null` and never throw a `ReadOnlyError` at their ~30 `research-runtime`/`research-completion` call sites.
- `createResearchProject` and `deleteResearchProject` keep their existing `assertWritable` gate and keep THROWING; if the flag flips between that gate and the CAS call, they must throw rather than report success or a silent `false`.

**Block If:** the fail-soft collapse cannot be kept type-compatible at existing call sites without editing `research-runtime.ts`/`research-completion.ts` mutation call sites — that is a different, larger change.

**Never:**
- Do not add `assertWritable` inside `applyResearchProjectMutation`, `lockedMutation`, `mutateResearchProject`, `updateResearchProject` or `updateResearchProjectIf` — a throw there strands an in-flight run, which is the whole reason DW-385 left them open.
- Do not change `DELETE /api/research/[id]`'s catch. Its 500-on-mid-flip is a separate, already-recorded deferred item (`spec-dw-316-319-526`), not this bundle's.
- Do not touch `research-runtime.ts` beyond reconcile's per-project catch line, and do not touch `research-completion.ts`.
- No repair/recovery route for a stranded run, no new client copy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Runtime progress write while read-only | `updateResearchProjectIf(owner, id, …, { status: "collecting" })`, `YOPEDIA_READONLY=1` | Returns `null`; stored registry bytes unchanged | No throw — caller compensates as a lost CAS race |
| Direct primitive call while read-only | `applyResearchProjectMutation(owner, mutate)`, flag set | Returns the refusal sentinel; `mutate` never invoked; bytes unchanged | `isResearchWriteRefused(result)` is `true` |
| Owner edit via library while read-only | `editResearchProject(owner, id, pred, { title })`, flag set | Throws `ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)`; bytes unchanged | `isReadOnlyError` matches |
| `PATCH /api/research/[id]` already read-only | Flag set on arrival | 403 `researchMutate` from the existing early gate | Unchanged |
| `PATCH /api/research/[id]` flag flips mid-request | Gate passed, writer refuses | 403 `researchMutate` from the catch's new first branch | Not 500, not 409 |
| `PATCH` writable, project not editable | status `collecting` | 409 "A running or finished research project cannot be edited." | Unchanged — the 403 branch must not swallow it |
| Reconcile meets a refused delete | `deleteResearchProject` throws `ReadOnlyError` inside the per-project try | `logger.warn` names a read-only skip for that project id | Loop continues to the next project |
| Reconcile meets a real fault | any other error | Existing `reconcile skipped damaged project <id>` line, unchanged | Loop continues |
| Create/delete when flag flips after their gate | sentinel returned by the CAS | Throws `ReadOnlyError(researchMutate)` | Never returns a fake project or `false` |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` -- `applyResearchProjectMutation` (l.401, exported CAS primitive, docstring l.373-400 states the DW-385 exemption and its cost verbatim), `lockedMutation` (l.427), `createResearchProject` (l.490, gates at l.501), `updateResearchProject` (l.531), `updateResearchProjectIf` (l.568), `mutateResearchProject` (l.582, the ONE place all three wrappers funnel through), `mutateProject` (l.599), `deleteResearchProject` (l.709, gates at l.718). Imports `READ_ONLY_REFUSAL, assertWritable` from `./read-only` at l.3; `isReadOnly` lives in `./config`, `ReadOnlyError` is exported from `./read-only`.
- `src/app/api/research/[id]/route.ts` -- PATCH: early `isReadOnly()` gate l.17-22, writer call l.58-66, catch l.75-83 (`ClientInputError ? 400 : 500`). DELETE l.87 — out of scope.
- `src/lib/research-runtime.ts` -- `reconcileResearchProjects` l.558; per-project catch at l.823-825 with the `reconcile skipped damaged project` warn; `deleteResearchProject` calls inside that try at l.590, l.660, l.674. `retireResearchProject` l.456 gates then calls `mutateResearchProject`. File does not currently import from `./read-only`.
- `src/lib/read-only.ts` -- `ReadOnlyError`, `assertWritable`, `isReadOnlyError`, `READ_ONLY_REFUSAL.researchMutate` (l.270). Module note l.108-115 records the CAS primitives as "deliberately left OPEN" — must be updated to describe the non-throwing refusal.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- l.471-499 pins "the research CAS primitives still WRITE on a read-only deployment" (BEHAVIOURAL, must be inverted); l.501-532 pins that those four bodies contain no `assertWritable(` (source-text; stays true and stays meaningful — keep it, retarget its comment to the new decision).
- `src/lib/__tests__/research-route.test.ts` -- owns the `/api/research/[id]` door cases and the mid-request-flip idiom introduced by DW-526 (`mockRejectedValue(new ReadOnlyError(...))`).
- `src/lib/__tests__/read-only-copy-parity.test.ts`, `read-only-door-coverage.test.ts` -- must stay green; no new copy constant is introduced.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- export `RESEARCH_WRITE_REFUSED` (a frozen sentinel value), its `ResearchWriteRefused` type and an `isResearchWriteRefused()` type guard; return it from `applyResearchProjectMutation` when `isReadOnly()` is true, before the attempt loop and before `mutate` runs -- gives the primitive a refusal that a caller can tell apart from both a result and a lost race.
- `src/lib/research-projects.ts` -- widen `lockedMutation`'s return with the sentinel; collapse it to `null` in `mutateResearchProject`; in `createResearchProject` and `deleteResearchProject` convert it to `throw new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)` -- keeps the fail-soft wrappers' signature and the two gated entry points' throwing contract.
- `src/lib/research-projects.ts` -- add exported `editResearchProject(owner, id, predicate, patch)` gated with `assertWritable(READ_ONLY_REFUSAL.researchMutate)` and a patch type narrowed to the owner fields (`title`, `question`, `queries`), delegating to the same CAS path -- the owner-editing entry point DW-527 names.
- `src/lib/research-projects.ts` -- rewrite the `applyResearchProjectMutation` docstring: the exemption is now a non-throwing refusal, the cost it named is closed, and `editResearchProject` is the owner door.
- `src/lib/read-only.ts` -- update the module note that calls the research CAS primitives "deliberately left OPEN" so it states what they now do.
- `src/app/api/research/[id]/route.ts` -- call `editResearchProject` from PATCH instead of `updateResearchProjectIf`; add `isReadOnlyError(error)` as the FIRST branch of PATCH's catch, answering 403 with the caught message -- a mid-request flip is a refusal, not a 500 and not a 409.
- `src/lib/research-runtime.ts` -- in `reconcileResearchProjects`' per-project catch, branch on `isReadOnlyError(error)` to a read-only skip warn naming the project id, else the existing damaged-project warn; add the `./read-only` import.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- invert the behavioural case to assert refusal (wrapper returns `null`, primitive returns the sentinel, stored bytes unchanged) and add cases for `editResearchProject` (throws, bytes unchanged) and for the writable control; retarget the source-text case's rationale.
- `src/lib/__tests__/research-route.test.ts` -- add PATCH mid-request-flip 403 plus controls that the branch did not swallow 400/404/409/500.
- `src/lib/__tests__/research-runtime.test.ts` -- add a reconcile case proving a `ReadOnlyError` from a refused delete logs the read-only skip, not the damaged-project line.

**Acceptance Criteria:**
- Given a read-only deployment, when any exported research CAS wrapper is called by a direct library caller, then the stored registry file is byte-identical afterwards and no lock lease was written.
- Given a read-only deployment, when the runtime's fail-soft callers mutate a project, then they receive `null` and no exception, so an in-flight run is never stranded by a throw.
- Given a deployment that turns read-only after `PATCH /api/research/[id]` passed its gate, when the writer refuses, then the response is 403 carrying `READ_ONLY_REFUSAL.researchMutate`.
- Given a read-only deployment, when `reconcileResearchProjects` meets a refused delete, then the log line names a read-only skip and reconciliation continues with the remaining projects.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 5: (high 0, medium 2, low 3)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `editResearchProject` collapsed a mid-flip refusal to `null`, which the PATCH route serves as 409 "cannot be edited" — the exact mislabel the entry point exists to prevent. It now re-reads the flag on the null path (`src/lib/research-projects.ts`), with a mid-flip case in `read-only-store-gate.test.ts` and a negative control confirming the case fails without the fix.
  - `[low]` `[patch]` `read-only.ts`'s backstop paragraph still said NINE doors; `PATCH /api/research/[id]` is the tenth. Count and list updated, and the route comment no longer calls itself "the nine-door shape".
  - `[low]` `[patch]` The rewritten `applyResearchProjectMutation` docstring dropped the fact that `GET /api/research` skips reconciliation when read-only — the reason DW-528's branch is hard to reach. Restored beside the new reconcile branch.
  - `[low]` `[patch]` `retireResearchProject`'s comment still described the CAS mutator as "deliberately open" (the DW-385 exemption this change removes). Updated to say it now refuses by returning `null`.
  - `[low]` `[patch]` The source-text case "carry no gate in their own source" now pins the absence of a THROWING gate only; renamed so its title matches the property it enforces.

## Design Notes

Why two shapes for one flag: the runtime's callers treat `null` as "lost the CAS race" and compensate, so a throw from the shared primitive turns fail-soft recovery into a stranded run (DW-385's recorded reason). The owner's PATCH cannot use that collapse — a `null` there is reported as 409 "A running or finished research project cannot be edited.", which is a lie about why the edit failed. So the primitive refuses quietly and distinguishably, and the owner-facing entry point refuses loudly.

The sentinel exists so the quiet refusal is not indistinguishable from a lost race at the primitive itself:

```ts
export const RESEARCH_WRITE_REFUSED = Object.freeze({ researchWrite: "read-only" as const });
export type ResearchWriteRefused = typeof RESEARCH_WRITE_REFUSED;
export function isResearchWriteRefused(value: unknown): value is ResearchWriteRefused {
  return value === RESEARCH_WRITE_REFUSED;
}
```

`mutateResearchProject` is the single funnel for `updateResearchProject`, `updateResearchProjectIf` and `mutateProject`, so collapsing the sentinel there covers every fail-soft caller with one line and no call-site edits.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/research-completion.test.ts src/lib/__tests__/research-delivery.test.ts src/lib/__tests__/research-completion-lifecycle.test.ts` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: no errors (proves the widened return types did not break any of the ~30 mutation call sites).
- `pnpm lint` -- expected: clean.
- `pnpm test` -- expected: full suite green.

## Auto Run Result

Status: done

**Implemented change.** The research CAS primitive now refuses read-only by VALUE: `applyResearchProjectMutation` returns a frozen `RESEARCH_WRITE_REFUSED` sentinel before it reads, leases or writes anything, so no direct library caller — CLI, MCP, agent runtime, script — can patch a research project on a read-only deployment (DW-527's named hole at `PATCH /api/research/[id]`'s writer). `mutateResearchProject`, the single funnel behind `updateResearchProject`, `updateResearchProjectIf` and `mutateProject`, collapses the sentinel to the `null` its ~30 fail-soft runtime callers already compensate for, so no call site changed and no in-flight run is stranded by a throw. The three GATED entry points convert the sentinel back to a `ReadOnlyError` so their throwing contract survives a flag that flips after their own `assertWritable`: `createResearchProject`, `deleteResearchProject`, and the new `editResearchProject` — the owner-editing entry point `PATCH /api/research/[id]` now calls, which also re-reads the flag on a `null` return so a mid-flip refusal is not served as 409 "cannot be edited". The PATCH catch gained the `isReadOnlyError` → 403 backstop that a new throw at that door requires. For DW-528, `reconcileResearchProjects`' per-project catch now branches on `isReadOnlyError` and logs `reconcile skipped read-only project <id>` instead of reporting a refusal as data damage.

**Files changed.**
- `src/lib/research-projects.ts` — sentinel + type guard, the non-throwing refusal in the CAS primitive, sentinel→`ReadOnlyError` at create/delete, new gated `editResearchProject`, rewritten DW-385 exemption prose.
- `src/lib/read-only.ts` — module note updated: the CAS primitives refuse by value, and the backstop door count is now ten.
- `src/app/api/research/[id]/route.ts` — PATCH calls `editResearchProject` and answers a mid-request flip 403. DELETE untouched.
- `src/lib/research-runtime.ts` — reconcile's read-only skip line; `retireResearchProject`'s now-false comment about the "deliberately open" CAS corrected.
- `src/lib/__tests__/read-only-store-gate.test.ts` — the "still WRITE while read-only" case inverted to a refusal case; sentinel case; `editResearchProject` throw case; writable control; mid-flip case for create, delete and edit.
- `src/lib/__tests__/research-run-route.test.ts` — PATCH retargeted to `editResearchProject`; mid-request-flip 403, foreign-`ReadOnlyError`-by-name 403, and a control that 400/404/409/500 are not swallowed.
- `src/lib/__tests__/research-runtime.test.ts` — reconcile logs a read-only skip for a refused delete (two rows, proving loop continuation), plus a control that a non-refusal fault still names a damaged project.

**Review findings.** 5 patches applied (1 medium, 4 low — see the Review Triage Log), 5 deferred (2 medium, 3 low — see frontmatter `deferred`), 6 rejected: `DELETE /api/research/[id]`'s mid-flip 500 (already tracked as DW-639), the sentinel's identity check versus the module's `err.name` doctrine (the sentinel is produced and consumed inside one module instance and its guard travels with it), reconcile's dead `changed` flag, a now-unused `vi.fn()` in a mock factory, this spec's Code Map naming `research-route.test.ts` where the `/api/research/[id]` door cases actually live in `research-run-route.test.ts`, and the deferred-work ledger being unedited (this run is forbidden to touch it).

**Follow-up review recommendation:** true. Patched this pass: 1 medium, 4 low → 3 × 1 + 1 × 4 = 7, which is ≥ 5.

**Verification performed.**
- `pnpm exec vitest run --project node` over the 11 read-only/research suites — 338 passed, 1 skipped.
- `pnpm exec tsc --noEmit` — clean, which is what proves the widened CAS return type broke none of the ~30 mutation call sites.
- `pnpm lint` — clean.
- `pnpm test` — 354 files, 8310 passed, 1 skipped.
- Negative controls: removing the `editResearchProject` null re-check turns its mid-flip case red; the implementation agent ran the same controls for the sentinel, the route branch and the reconcile branch (3, 2 and 1 failures respectively), restoring and re-verifying each.
- Every I/O matrix row is covered by a case that ran and passed in the runs above.

**Residual risks.**
- A mid-flip `deleteResearchProject` takes `withResearchProjectLifecycleFence` before reaching the CAS, so on the R2 provider a durable lock lease can be written by a call that then refuses. Narrow (the gate one line above answers every non-flip case) and the lease expires on its own, so it was not treated as a hole.
- `reconcileResearchProjects` still drives ungated helpers — lease release, outbox delete, staging clear — before it reaches the refused delete, so a mid-sweep flip mutates that state and only then logs the read-only skip. Pre-existing and outside both ledger entries.
- One deviation from this spec's own **Never**: the `retireResearchProject` fix was comment-only but does sit outside reconcile's catch in `research-runtime.ts`. It was applied because this change is what made that comment false.
