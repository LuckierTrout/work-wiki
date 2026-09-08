---
title: 'Close the two research write leaks on a read-only deployment (DW-680, DW-681)'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
baseline_revision: 'e3a1ee264d140bf9537e4ecde7524beed0828770'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Reconcile's done-phase branch and `drainResearchOutbox`'s two
      row-in-hand branches still empty `research-leases.json` and destroy an
      outbox plus its staged bodies on a read-only deployment.
    evidence: |-
      DW-680/DW-681 closed the two paths their ledger entries name, but the
      same two shapes remain at sites this bundle did not name.
      `reconcileResearchProjects`' `completion.phase === "done"` branch calls
      the ungated `releaseResearchSlotAndConfirmGone` and
      `releaseExpiredResearchSlot` (src/lib/research-runtime.ts:733-740) and
      then `deleteResearchOutbox` (:741), and `drainResearchOutbox`'s own
      done-phase (src/lib/research-completion.ts:934) and `deleteRequested`
      (:971) branches call the same ungated helper — `clearResearchStaging`
      plus a raw `deleteFile`, so the staged bodies go with the outbox. The
      new reconcile case in `research-runtime.test.ts` drives that whole sweep
      under `YOPEDIA_READONLY=1` and proves the loop runs, but seeds only
      orphans, so nothing asserts what the done-phase branch does. Same
      reachability caveat DW-681 carries: `GET /api/research` skips
      reconciliation when read-only and `POST /api/tasks/run` refuses, so this
      is a direct-library-caller and mid-sweep-flip exposure rather than a
      deployed one. Each of these sites holds a project row, which is a
      different shape from an orphan and a different decision about whether a
      refusal or a fail-soft skip is right — which is why it was not folded
      into this bundle.
    location: >-
      src/lib/research-runtime.ts:741
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two research paths still write on a deployment that has refused every other write. `queueResearchProject` retires the project's slot through `releaseResearchSlotAndConfirmGone` (and can delete a done-phase outbox) BEFORE its CAS refuses, and `research-concurrency.ts` carries no gate of its own — so a refused Run empties the project's lease from `research-leases.json` while the row still records that `runAttemptId`. Reconcile's orphan-outbox loop reaches `drainOrphanOutbox`, whose UNCLAIMED branch calls the ungated `deleteResearchOutbox` (a `clearResearchStaging` plus a raw `deleteFile`), destroying the outbox on a read-only deployment.

**Approach:** Gate each at its own entry with `assertWritable(READ_ONLY_REFUSAL.researchMutate)`, following `retireResearchProject`'s established "THE ENTRY POINT gates rather than leaning on the CAS mutator it calls first" precedent — at the top of `queueResearchProject`, and at the head of `drainOrphanOutbox`'s unclaimed branch. Then convert the `queueResearchProject` byte case in `read-only-store-gate.test.ts` from a lease-excluded comparison to a whole-tree one, and add a whole-tree case for the orphan outbox.

## Boundaries & Constraints

**Always:**
- Both gates use `READ_ONLY_REFUSAL.researchMutate` — the sentence `POST /api/research/[id]/run` and the DW-528/DW-660 reconcile branches already serve. `isReadOnlyError` must classify both, so they must be `ReadOnlyError`s raised by `assertWritable`.
- `queueResearchProject`'s gate is its FIRST statement, ahead of `getResearchProject`, exactly as `retireResearchProject`'s is — the delivery-retry branch, the done-phase `deleteResearchOutbox`, and the pre-CAS lease release all sit below it.
- `drainOrphanOutbox`'s gate refuses only the UNCLAIMED branch, immediately before its `deleteResearchOutbox`. The CLAIMED branch keeps refusing where it already does — inside `writeResearchPage` -> `writeWikiPageWithSideEffects`, carrying `pageWrite` — and its claim file is created and removed in the same call, so the tree is unchanged either way.
- The existing mid-request-flip conversions stay: `queueResearchProject`'s two `isResearchWriteRefused` -> `ReadOnlyError` sites (DW-657/DW-651) are the flag flipping BELOW the new gate and must not be removed.
- Every comment this change falsifies is corrected in the same pass — the DW-660 note in `reconcileResearchProjects`' orphan catch that says an unclaimed outbox "never reaches a gated writer", and the store-gate suite's `ENV_KEYS` note about seeding a provider credential for the queue case.

**Block If:**
- Gating either path would require changing `research-concurrency.ts`'s fail-soft release contract (`releaseResearchSlot` never throws) — it must not be touched.

**Never:**
- Do not gate `deleteResearchOutbox` itself. It has ~20 call sites inside in-flight delivery and fail-soft recovery paths; a throw there strands a run, the same reason DW-527 left the CAS primitives refusing by return.
- Do not add an `assertWritable` to `research-concurrency.ts` or to any research CAS primitive in `research-projects.ts` — `read-only-store-gate.test.ts` pins the absence of a throwing gate in the latter on purpose.
- Do not widen `read-only-door-coverage.test.ts`'s `KERNEL_WRITERS` / `WRITER_EXPORTS` rolls; the run route already carries both treatments.
- No route, component, or copy changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Queue refused, project holds a real lease | `YOPEDIA_READONLY=1`; project with `runAttemptId` and a live slot in `research-leases.json` | `queueResearchProject` throws; whole data tree byte-identical INCLUDING the lease file; row still `draft`, still holding its `runAttemptId`, no `provider` | `ReadOnlyError` / `READ_ONLY_REFUSAL.researchMutate` |
| Queue refused, delivery-retry branch | `YOPEDIA_READONLY=1`; project `deliveryBlocked: true`, `completion.phase: "page"` | Throws before the retry write; tree byte-identical; still blocked, no new `deliveryAttemptId` | `ReadOnlyError` / `researchMutate` |
| Orphan outbox drained, UNCLAIMED | `YOPEDIA_READONLY=1`; outbox file with no `claimed`, no project row, one `staging-<id>-*.md` body beside it | `drainResearchOutbox` throws; outbox JSON and staging body both still on disk, whole tree byte-identical | `ReadOnlyError` / `researchMutate` |
| Reconcile sweeps that orphan | `YOPEDIA_READONLY=1`; same orphan | `reconcileResearchProjects` logs "reconcile skipped read-only orphan outbox" and continues; nothing deleted | Caught by the existing `isReadOnlyError` branch |
| Writable deployment | Flag unset | Both paths behave exactly as before | n/a |

</intent-contract>

## Code Map

- `src/lib/research-runtime.ts:405` -- `queueResearchProject`. First statement is `const project = await getResearchProject(...)`; the pre-CAS writes are `deleteResearchOutbox` at :479 (done-phase) and `releaseResearchSlotAndConfirmGone` at :488. `assertWritable`/`READ_ONLY_REFUSAL` are already imported at :61.
- `src/lib/research-runtime.ts:586-596` -- `retireResearchProject`'s entry gate and its comment: the exact precedent and comment shape to mirror.
- `src/lib/research-runtime.ts:~984-1008` -- `reconcileResearchProjects`' orphan-outbox catch. Its DW-660 comment asserts an unclaimed outbox "never reaches a gated writer: `drainOrphanOutbox` deletes it and returns" — false after this change; the branch itself is already correct and now covers this shape too.
- `src/lib/research-completion.ts:1041-1047` -- `drainOrphanOutbox`; the unclaimed branch is `if (outbox.claimed !== true) { await deleteResearchOutbox(owner, id); return; }`.
- `src/lib/research-completion.ts:356-362` -- `deleteResearchOutbox` = `clearResearchStaging` + a raw `getStorage().deleteFile`, both ungated. Leave it ungated.
- `src/lib/research-completion.ts:1-34` -- imports; there is NO `./read-only` import yet, add one.
- `src/lib/research-completion.ts:248,382` -- `saveResearchOutbox` (test seed for an orphan) and `listResearchOutboxIds`. Outbox path is `tenants/<t>/research-outbox/<id>.json`, staging bodies are `staging-<id>-<slug>-<sha>.md` in the same dir.
- `src/lib/read-only.ts:225,421` -- `READ_ONLY_REFUSAL.researchMutate` and `assertWritable`. The module note at :100-200 is the place the DW-385/527/657/659/661 reasoning is recorded.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- the suite to change. `snapshot()`/`seededSnapshot()`/`expectRefusal()`/`registryEntry()` helpers at :112-198; `withoutLeases()` at :203 (single use, at :862); the `queueResearchProject` case at :823-869 with the exclusion rationale to replace; the `ENV_KEYS` `TAVILY_API_KEY` note at :63-72 and its per-case seed at :844; the source-order describe at :461-518 whose `[module, fn, after]` table is where the new ordering pins go.
- `src/app/api/research/[id]/run/route.ts:32,97` -- unchanged: early `isReadOnly()` gate plus `isReadOnlyError` catch. Confirms `researchMutate` is the sentence this door already serves.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-runtime.ts` -- add `assertWritable(READ_ONLY_REFUSAL.researchMutate)` as the first statement of `queueResearchProject`, with a comment naming what sits below it (the done-phase `deleteResearchOutbox`, the pre-CAS `releaseResearchSlotAndConfirmGone`, and `research-concurrency.ts` carrying no gate of its own) and noting the DW-657/DW-651 sentinel conversions below remain the mid-request-flip backstop -- a refused Run must not empty the project's lease while the row still records that attempt.
- `src/lib/research-runtime.ts` -- correct the DW-660 parenthetical in `reconcileResearchProjects`' orphan catch so it says the unclaimed shape now refuses at `drainOrphanOutbox`'s own gate rather than "never reaches a gated writer" -- the comment would otherwise document the exact hole this change closes as still open.
- `src/lib/research-completion.ts` -- import `assertWritable`/`READ_ONLY_REFUSAL` from `./read-only` and gate `drainOrphanOutbox`'s unclaimed branch immediately before `deleteResearchOutbox`, with a comment saying why the gate is here and not on `deleteResearchOutbox` (in-flight fail-soft call sites) and why the claimed branch is untouched -- an unclaimed orphan outbox must survive a read-only deployment.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- rewrite the `queueResearchProject` refusal case to assert whole-tree byte-identity (keeping the real-lease seed, which is what makes the claim non-vacuous), replace the exclusion rationale with what the gate now owns, delete the now-unused `withoutLeases` helper, and reconcile the `TAVILY_API_KEY` seed and its `ENV_KEYS` note with the gate now refusing ahead of provider resolution.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- add a refusal case for an UNCLAIMED orphan outbox: seed an outbox with no project row plus one `staging-<id>-*.md` body, flip the flag, assert `drainResearchOutbox` refuses with `researchMutate` and the whole tree is byte-identical, and read the outbox back through `loadResearchOutbox` to show it survived.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- extend the source-order table with `queueResearchProject` before `releaseResearchSlotAndConfirmGone(owner` and `drainOrphanOutbox` before `deleteResearchOutbox(owner, id)`, generalising the declaration probe to match a non-exported `async function` and adding `research-completion.ts` to the sources map -- a gate moved below the write it guards would pass the byte cases only by accident of ordering.

**Acceptance Criteria:**
- Given a read-only deployment and a project holding a live research slot, when `queueResearchProject` is called, then it throws a `ReadOnlyError` carrying `READ_ONLY_REFUSAL.researchMutate` and `research-leases.json` still contains that project's slot with its original `attemptId`.
- Given a read-only deployment and an unclaimed orphan outbox with no project row, when `reconcileResearchProjects` sweeps, then the sweep continues past it and the outbox file is still readable through `loadResearchOutbox`.
- Given a writable deployment, when either path runs, then behaviour is unchanged and the existing research suites stay green.
- Given the whole repository, when `npm test` and `npm run lint` run, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` The new entry gate made both existing read-only queue cases stop at the door, leaving `queueResearchProject`'s two `isResearchWriteRefused` -> `ReadOnlyError` conversions (DW-657, DW-651) pinned by nothing — deleting both left the whole suite green. Added two mid-request-flip cases in the suite's own `vi.spyOn(config, "isReadOnly")` idiom, one per conversion; each conversion now fails exactly one case when removed (verified by mutation).
  - `[low]` `[patch]` The delivery-retry case's comment still said "WHOLE-TREE byte-identity here, unlike the case above" after the case above became whole-tree. Corrected.
  - `[low]` `[patch]` The new orphan case claimed DW-681's path was "the last research path that still wrote on a read-only deployment, and the only one whose write DESTROYED data" — false. Rewritten to name the path DW-681 names and to list the row-in-hand sites that still delete.
  - `[low]` `[patch]` `drainOrphanOutbox`'s new comment asserted the claimed branch leaves the tree unchanged, with nothing pinning it. Added a claimed-orphan case asserting the refusal carries `pageWrite` (asserted distinct from `researchMutate`) and the whole tree is byte-identical.
  - `[low]` `[patch]` `read-only.ts`'s module note — this codebase's registry of which entry point gates with which sentence — did not record either new gate, and its DW-661 paragraph still described `queueResearchProject` as refusing only by sentinel conversion. Added one paragraph in the existing voice.
  - `[low]` `[patch]` The generalised declaration probe in the source-order table was unanchored, so a mention of a function name in a comment could in principle be mistaken for its declaration. Anchored at column zero with the `m` flag.

## Design Notes

Why the gate goes at the ENTRY and not on the shared writer, in both cases: `retireResearchProject` (research-runtime.ts:586) already records the reasoning verbatim — the function writes through deliberately ungated machinery before it reaches anything gated, so "read-only means nothing changed" only holds if the door refuses first. `deleteResearchOutbox` is the mirror image: it is called from ~20 sites inside in-flight delivery, several with `.catch(() => undefined)`, so a throw there is DW-527's stranded-run failure mode rather than a gate.

Shape to mirror, at the top of `queueResearchProject`:

```ts
export async function queueResearchProject(owner, id) {
  // Deployment read-only (DW-680). THE ENTRY POINT gates: the writes below run
  // ahead of the CAS — the done-phase `deleteResearchOutbox` and, at the last
  // statement before the mutation, `releaseResearchSlotAndConfirmGone`, whose
  // `research-concurrency.ts` carries no gate of its own. ...
  assertWritable(READ_ONLY_REFUSAL.researchMutate);
```

The `isResearchWriteRefused` conversions further down stay: this gate answers a deployment already read-only on arrival, those answer the flag flipping mid-request, and both carry the same sentence so the caller cannot tell which flag read lost.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/read-only-store-gate.test.ts` -- expected: all cases pass, including the rewritten whole-tree `queueResearchProject` case, the new orphan-outbox case, and the extended source-order table.
- `npx vitest run src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts` -- expected: pass, unchanged.
- `npx vitest run src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/research-completion.test.ts src/lib/__tests__/research-completion-lifecycle.test.ts` -- expected: pass; the writable paths are untouched.
- `npm test` -- expected: full suite passes with no new failures.
- `npm run lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** Both research paths that still wrote on a read-only deployment now refuse at their own entry, each carrying `READ_ONLY_REFUSAL.researchMutate`. `queueResearchProject` gates as its first statement, above the done-phase `deleteResearchOutbox`, the delivery-retry write and the pre-CAS `releaseResearchSlotAndConfirmGone` — so a refused Run no longer empties the project's slot out of `research-leases.json` while the row goes on recording that `runAttemptId`. `drainOrphanOutbox`'s UNCLAIMED branch gates immediately before `deleteResearchOutbox`, so an orphan outbox and its staged bodies survive a deployment that has refused every other write. `deleteResearchOutbox` itself stays ungated (~20 in-flight and fail-soft call sites), and `research-concurrency.ts` is untouched.

**Files changed.**
- `src/lib/research-runtime.ts` — entry gate on `queueResearchProject`; corrected the DW-660 parenthetical in `reconcileResearchProjects`' orphan catch that claimed an unclaimed outbox never reaches a gated writer.
- `src/lib/research-completion.ts` — first `assertWritable` in the module, on `drainOrphanOutbox`'s unclaimed branch, with the reasoning for its placement.
- `src/lib/read-only.ts` — one paragraph in the module note recording both gates and the `pageWrite`/`researchMutate` divergence between the claimed and unclaimed orphan branches.
- `src/lib/__tests__/read-only-store-gate.test.ts` — queue case converted to whole-tree byte-identity (lease included) and `withoutLeases` deleted; new unclaimed-orphan and claimed-orphan whole-tree cases; two mid-request-flip cases pinning the two sentinel conversions; two entries added to the source-order table with the declaration probe generalised to private functions and anchored at column zero.
- `src/lib/__tests__/research-runtime.test.ts` — reconcile case driving the unclaimed-orphan shape with the real flag, pinning the "reconcile skipped read-only orphan outbox" line for both orphans and that neither was dropped.

**Review findings.** 6 patched (1 medium, 5 low), 1 deferred (low), 4 rejected. No intent gaps, no spec repairs. Follow-up review recommendation: `false` — no patched finding was high severity.

**Verification.**
- `npx vitest run src/lib/__tests__/read-only-store-gate.test.ts` — 30/30 pass (was 27).
- `npm test` — 369 files, 9147 pass, 1 skipped, no failures.
- `npm run lint` — exit 0. `npx tsc --noEmit` — clean.
- Mutation checks, each restored afterwards: removing `drainOrphanOutbox`'s gate reddens the reconcile case; removing either of `queueResearchProject`'s two sentinel conversions reddens exactly one mid-flip case.
- Matrix audit: all five I/O rows are covered by tests that ran and passed — the two queue-at-the-gate cases, the unclaimed-orphan drain case, the new reconcile sweep case, and the pre-existing writable-path research suites.

**Residual risks.**
- The MAIN CAS mid-flip case deliberately cannot assert whole-tree identity: once the entry gate passes, the ungated `releaseResearchSlotAndConfirmGone` genuinely runs. That is the cost of the flip window, not of the gate, and the case says so.
- Row-in-hand siblings of both shapes remain ungated (reconcile's done-phase branch and `drainResearchOutbox`'s done-phase / `deleteRequested` branches). Recorded in frontmatter `deferred`; direct-library-caller and mid-sweep-flip exposure only, since `GET /api/research` skips reconciliation when read-only and `POST /api/tasks/run` refuses.
- `queueResearchProject` is now an entry-gated writer of the same shape as `retireResearchProject` but is not registered in `read-only-door-coverage.test.ts`'s rolls (excluded by the spec's Never clause). Its only route already carries both treatments; a future route importing it would not be scanned.
