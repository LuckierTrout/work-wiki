---
title: 'Research lifecycle gates: exempt cancel-teardown from the shape guard, gate the row-in-hand read-only branches (DW-682, DW-734)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: 'cd813f8a769974f379ddf487eea1206131131884'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A cancelled project whose stored completion is malformed at `phase:
      "sources"` still cannot finalize — the DW-682 teardown exemption is
      reachable only from `phase: "page"`.
    evidence: |-
      DW-682's decision, and every row this bundle pinned, concerns a
      `cancelRequested` row at `phase: "page"`: that is the only phase whose
      commit reaches the two exempted reads. `commitResearchPage` returns at
      the `phase === "sources" || phase === "done"` check ABOVE them, and
      `drainResearchOutbox` then skips the commit for such a row
      (`!current.completion || phase === "page"` is false) and throws at the
      loop guard `requireCompletionSources(completion)`. Reconcile turns that
      throw into `deliveryBlocked: true`, after which every later sweep
      `continue`s past the row: a cancel that landed there can never finalize
      to `cancelled`, exactly the shape DW-682 describes, one phase over. Not
      caused by this change — the loop guard is DW-579/DW-652's fail-closed
      discipline and predates it — and not stranded: the row stays listable
      and DELETE still works, since `deleteRequested` sits above every guard.
      `requireCompletionSources`' own docblock says the pre-DW-652 bug moved
      rows `phase: "page"` -> `"sources"` while writing per-character garbage
      into `sources`, so the legacy population this unsticks is plausibly at
      that phase. Closing it means deciding whether the drain's own guards
      take the same teardown exemption the commit's two now do.
    location: >-
      src/lib/research-completion.ts:1088
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two research-lifecycle branches fail in opposite directions. `commitResearchPage` runs `requireCompletionSources` unconditionally above the claim CAS (`src/lib/research-completion.ts:580-582`) and again inside it (`:602`), while both cancel early-returns (`:525`, `:567`) require `!completion` — so a cancel landing on a project whose stored completion is malformed throws `ResearchCompletionShapeError` and can never reach the teardown at `:660-680` that would delete the whole completion outright, leaving the row stuck at `cancelRequested` forever (DW-682). Conversely, `reconcileResearchProjects`' done-phase branch (`src/lib/research-runtime.ts:732-751`) and `drainResearchOutbox`'s row-in-hand branches (`research-completion.ts:933-940`, `:940-947`, `:971-976`) still empty `research-leases.json`, delete the page-written receipt, and destroy an outbox plus its staged bodies on a read-only deployment (DW-734).

**Approach:** Exempt teardown from the shape guard — where the row is `cancelRequested` or `status: "cancelled"`, `commitResearchPage`'s two reads answer `null` instead of throwing for a malformed stored list, so the claim CAS runs, the `authorized` mutator declines, and the existing cancel-finalize branch deletes the completion and the outbox. Then gate each read-only leak branch-level with `assertWritable(READ_ONLY_REFUSAL.researchMutate)` exactly the way DW-680/DW-681 gated theirs — never on `deleteResearchOutbox` itself.

## Boundaries & Constraints

**Always:**
- The teardown exemption changes NOTHING for a well-shaped stored list, cancelled or not: the exempt read must return the same sources `requireCompletionSources` would have returned, and answer `null` only where that guard would have thrown. One predicate backs both, so the two notions of "valid" cannot drift.
- The exemption is scoped to `cancelRequested || status === "cancelled"`, at BOTH reads (`:580` pre-claim and `:602` in-CAS) — the CAS mutator reads its own freshly-loaded row, so it makes the decision from that row's own fields, not the pre-claim snapshot's. Gating only one leaves the other throwing and the teardown still unreachable.
- A `cancelRequested` row carrying a wrong-shaped completion finalizes: `status: "cancelled"`, `completion` gone, outbox gone, page-written marker cleared, `writeWikiPageWithSideEffects` never called.
- Every read-only gate uses `READ_ONLY_REFUSAL.researchMutate` and is a `ReadOnlyError` raised by `assertWritable`, so `isReadOnlyError` classifies it at `reconcileResearchProjects`' per-project catch and at `markResearchDeliveryBlocked`.
- Each gate sits immediately ahead of the writes in ITS OWN branch and refuses nothing else: `drainResearchOutbox`'s done-phase branch is also a pure read that returns the project when there is no outbox and no `deleteRequested`, so its gate is conditional on there being something to destroy.
- Every comment this change falsifies is corrected in the same pass — `requireCompletionSources`' docblock ("everything else that iterates or indexes a STORED `completion.sources` comes through here"), the DW-681 case comment in `read-only-store-gate.test.ts:1038-1045` listing these exact sites as still open, and `read-only.ts`'s module note, which is this codebase's registry of which entry point gates with which sentence.

**Block If:** closing DW-682 would require relaxing either `(cancelRequested || cancelled) && !completion` early return (`:525`, `:567`) — those return `null` without setting `status: "cancelled"`, so widening them would strand the row in a different way and is a different decision.

**Never:**
- Do not gate `deleteResearchOutbox`, `clearResearchStaging`, `clearPageWrittenMarker`, `deleteRetiredProjectIfLeaseGone` or anything in `research-concurrency.ts`. `deleteResearchOutbox` alone has ~20 in-flight and fail-soft call sites, several with `.catch(() => undefined)`; a throw there is DW-527's stranded run.
- Do not exempt `deleteRequested` from the shape guard. Its branches sit ABOVE the guard already, so deleting a project with a malformed completion works today.
- Do not coerce, repair or discard a malformed stored list anywhere. The exemption lets teardown DELETE the whole completion; it never writes a repaired one back for a row that is not being torn down.
- Do not widen `read-only-door-coverage.test.ts`'s `KERNEL_WRITERS` / `WRITER_EXPORTS` rolls, and do not add a gate to `commitResearchPage`'s own retire/cancel `deleteResearchOutbox` calls — a different shape, not named by this bundle.
- No route, component, schema or copy changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cancel on a malformed completion | `cancelRequested: true`; stored `completion: { phase: "page", pageSlug, sources: "https://example.com/a" }`; outbox saved | `commitResearchPage` resolves to the row with `status: "cancelled"`, no `completion`; outbox gone; `writeWikiPageWithSideEffects` never called | No error expected |
| Same row reached through the drain | as above, via `drainResearchOutbox` | drain returns the cancelled row rather than refusing; nothing ingested | No error expected |
| `status: "cancelled"` without `cancelRequested` | stored `completion` malformed at `phase: "page"`, `status: "cancelled"` | same finalization as above | No error expected |
| Malformed completion, NOT cancelled | `phase: "page"`, `sources: "https://…"`, no cancel | unchanged: refuses at the pre-claim read, nothing written forward | `ResearchCompletionShapeError`, `Research completion sources are not a list.` |
| Well-shaped list, cancelled | valid `sources` list, `cancelRequested: true` | unchanged from today — the exempt read returns that same list | No error expected |
| Read-only reconcile, done-phase row | `YOPEDIA_READONLY=1`; project `completion.phase: "done"` holding a live lease and an outbox | sweep logs `reconcile skipped read-only project <id>` and continues; lease, outbox and staged bodies all survive; whole tree byte-identical | `ReadOnlyError` / `researchMutate`, caught by the existing per-project branch |
| Read-only drain, done-phase row with an outbox | `YOPEDIA_READONLY=1`; `completion.phase: "done"`, outbox on disk | `drainResearchOutbox` throws; whole tree byte-identical; outbox still loadable | `ReadOnlyError` / `researchMutate` |
| Read-only drain, `deleteRequested` with an outbox | `YOPEDIA_READONLY=1`; `deleteRequested: true`, `deliveryAttemptId` set, `completion.phase: "sources"`, outbox on disk | throws; whole tree byte-identical, lease included | `ReadOnlyError` / `researchMutate` |
| Read-only drain, `deleteRequested` with NO outbox | same, outbox absent, page-written marker on disk | throws ahead of the lease release and the marker delete; whole tree byte-identical | `ReadOnlyError` / `researchMutate` |
| Read-only drain, done-phase row with NO outbox and no delete | `YOPEDIA_READONLY=1`; `completion.phase: "done"` only | returns the project unchanged — a pure read is not refused | No error expected |
| Writable deployment | flag unset | every path behaves exactly as before | n/a |

</intent-contract>

## Code Map

- `src/lib/research-completion.ts:76-90` -- `isCompletionSource`, the per-element predicate both the throwing guard and the new non-throwing read must share.
- `src/lib/research-completion.ts:93-152` -- `requireCompletionSources` and its docblock. The "WHAT IS NOT ROUTED THROUGH IT" paragraph (`:131-144`) claims `commitResearchPage`'s two reads always come through it — false after this change; rewrite rather than leave contradicting the code.
- `src/lib/research-completion.ts:510-524` -- `commitResearchPage` head: the `deleteRequested` (`:520`) and `(cancelRequested || cancelled) && !completion` (`:525`) early returns that sit ABOVE the guard.
- `src/lib/research-completion.ts:567-586` -- the second cancel early return and the pre-claim guarded read (`storedSources`/`sources`), the first site to exempt.
- `src/lib/research-completion.ts:588-613` -- the claim CAS mutator; `ownSources` at `:602` is the second site. It sits deliberately BELOW the phase and claim-freshness checks — keep that order.
- `src/lib/research-completion.ts:645-680` -- the `!authorized` path: `latest.deleteRequested` first, then the cancel-finalize mutator that deletes the completion, sets `status: "cancelled"` and the `Cancelled before the Page write.` progress line, then `deleteResearchOutbox` + `clearPageWrittenMarker`. This is the teardown DW-682 must make reachable.
- `src/lib/research-completion.ts:154-168` -- `deleteRetiredProjectIfLeaseGone`: `releaseResearchSlot` (ungated, writes `research-leases.json`) then `releaseExpiredResearchSlot`, then the gated `deleteResearchProject`. The reason a branch gate has to precede it.
- `src/lib/research-completion.ts:241-247` -- `clearPageWrittenMarker`, a raw `deleteFile`. `:356-362` -- `deleteResearchOutbox` = `clearResearchStaging` + a raw `deleteFile`. Both stay ungated.
- `src/lib/research-completion.ts:922-976` -- `drainResearchOutbox`'s three row-in-hand branches: done-phase (`:933`, deletes the outbox and can retire), `!outbox` + `deleteRequested` (`:940`, clears the marker and retires), and `deleteRequested` (`:971`, all three). Note the done-phase branch returns the project untouched when there is nothing to destroy.
- `src/lib/research-completion.ts:1040-1070` -- `drainOrphanOutbox`'s DW-681 gate: the exact comment shape and placement to mirror. `:14` already imports `assertWritable`/`READ_ONLY_REFUSAL`.
- `src/lib/research-runtime.ts:732-751` -- `reconcileResearchProjects`' done-phase branch: `releaseResearchSlotAndConfirmGone`, `releaseExpiredResearchSlot`, `deleteResearchOutbox`, then a gated `deleteResearchProject`. `:61` already imports the gate.
- `src/lib/research-runtime.ts:980-1002` -- the per-project catch that classifies `isReadOnlyError` into `reconcile skipped read-only project <id>`; `:323-338` -- `markResearchDeliveryBlocked` returns early for a `ReadOnlyError`, so a refused drain from `:763` writes nothing.
- `src/lib/research-runtime.ts:605-620` -- `retireResearchProject`'s entry gate, the precedent comment shape.
- `src/lib/__tests__/research-completion.test.ts:187-206` -- "rechecks cancellation after winning the claim", the closest existing model for a teardown assertion. `:824-836` -- the bad-shape `describe` and its `seedBadCompletion` helper; `:1056-1092` -- the commit-refusal case the new cancel rows must not disturb. `cancelResearchProject` is already imported (used at `:161`).
- `src/lib/__tests__/read-only-store-gate.test.ts:131-206` -- `snapshot()`/`seededSnapshot()`/`expectRefusal()`/`registryEntry()`. `:1030-1096` -- the DW-681 orphan case, whose comment at `:1038-1045` names these very branches as still open. `:460-542` -- the source-order table and its column-zero declaration probe.
- `src/lib/__tests__/research-runtime.test.ts:2337-2390` -- the DW-681 unclaimed-orphan reconcile case (real flag, `logger.warn` spy read BEFORE `mockRestore`); the new done-phase case follows it exactly. `acquireResearchSlot`, `updateResearchProject`, `saveResearchOutbox`, `loadResearchOutbox` are all already imported.
- `src/lib/read-only.ts:181-200` -- the DW-680/DW-681 paragraph of the module note, where the new gates are recorded; `:374` -- `READ_ONLY_REFUSAL.researchMutate`.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-completion.ts` -- add a non-throwing sibling of `requireCompletionSources` (answer the stored list, or `null` where the guard would throw) built on the SAME `isCompletionSource` predicate, and have `requireCompletionSources` derive its refusal from it so the two cannot diverge -- one notion of a valid stored list, two answers.
- `src/lib/research-completion.ts` -- route `commitResearchPage`'s pre-claim read (`:580`) and its in-CAS read (`:602`) through the non-throwing sibling when that row is `cancelRequested` or `cancelled`, each deciding from the row it is holding, with a comment naming the teardown below that this unblocks and why `deleteRequested` is not exempt -- a cancel must be able to finalize a row whose completion teardown would delete outright anyway (DW-682).
- `src/lib/research-completion.ts` -- rewrite the "WHAT IS NOT ROUTED THROUGH IT" paragraph of `requireCompletionSources`' docblock to record the teardown exemption and its limit (the exemption never repairs or writes a malformed list forward; it lets the value be deleted) -- the docblock currently asserts the opposite.
- `src/lib/research-completion.ts` -- gate `drainResearchOutbox`'s three row-in-hand write branches with `assertWritable(READ_ONLY_REFUSAL.researchMutate)`: the done-phase branch conditional on there being an outbox or a `deleteRequested` to act on, and the two `deleteRequested` branches at the head of the branch, each with a comment saying why the gate is on the branch and not on `deleteResearchOutbox` -- an outbox, its staged bodies, the page-written receipt and the project's lease must all survive a deployment that has refused every other write (DW-734).
- `src/lib/research-runtime.ts` -- gate `reconcileResearchProjects`' done-phase branch immediately above `releaseResearchSlotAndConfirmGone`, with a comment naming the ungated `research-concurrency.ts` release and the `deleteResearchOutbox` below it, and noting the per-project catch that classifies the refusal -- the sweep must skip the row, not empty its lease and destroy its outbox.
- `src/lib/read-only.ts` -- extend the DW-680/DW-681 paragraph of the module note with one paragraph in the same voice recording the four new branch-level gates and the rule they share (the branch gates, never the shared deleter) -- the note is the registry a future reader consults for which door carries which sentence.
- `src/lib/__tests__/research-completion.test.ts` -- add the teardown rows to the bad-shape `describe`: a `cancelRequested` row and a `status: "cancelled"` row, each with a malformed stored completion at `phase: "page"`, finalizing to `cancelled` with no completion and no outbox and no Page write; the same row reached through `drainResearchOutbox`; and a well-shaped cancelled row proving the exempt read still returns the stored list -- one test per matrix scenario, and the pair is what makes each of the two exempt reads individually load-bearing.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- add whole-tree byte-identity refusal cases for the three `drainResearchOutbox` branches (done-phase with an outbox and a staged body; `deleteRequested` with an outbox; `deleteRequested` with no outbox but a page-written marker), each seeded with a REAL lease so the byte claim is non-vacuous, plus a control that a done-phase row with nothing to destroy still returns rather than refusing; extend the source-order table with `drainResearchOutbox` before `deleteResearchOutbox(owner, id)` and `reconcileResearchProjects` before `releaseResearchSlotAndConfirmGone(`; and correct the DW-681 case comment that lists these branches as still open.
- `src/lib/__tests__/research-runtime.test.ts` -- add the reconcile done-phase case the DW-734 entry says is missing: seed a `completion.phase: "done"` project holding a live lease and an outbox, drive the sweep under the REAL `YOPEDIA_READONLY=1` flag, and assert `reconcile skipped read-only project <id>` (never `damaged project`), the lease file unchanged, and the outbox still loadable -- the existing read-only reconcile case seeds only orphans, so nothing asserted what this branch did.

**Acceptance Criteria:**
- Given a project whose stored completion is malformed at `phase: "page"` and whose row is `cancelRequested`, when `commitResearchPage` runs, then it resolves rather than throwing, the reread row is `status: "cancelled"` with no `completion`, the outbox is gone, and `writeWikiPageWithSideEffects` was never called.
- Given the same malformed completion on a row that is NOT cancelled, when `commitResearchPage` runs, then it still throws `ResearchCompletionShapeError` with the verbatim `Research completion sources are not a list.` and nothing is written forward.
- Given a read-only deployment, when `reconcileResearchProjects` sweeps a done-phase project holding a live lease and an outbox, then the sweep continues, `research-leases.json` still holds that slot, and the outbox is still readable through `loadResearchOutbox`.
- Given a writable deployment, when any of these paths runs, then behaviour is unchanged and the existing research suites stay green.
- Given the whole repository, when `npm test` and `npm run lint` run, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[low]` `[patch]` The new reconcile gate threw ABOVE `outboxIds.delete(project.id)`, so a refused done-phase row survived into the sweep's orphan loop and was re-drained and logged as `reconcile skipped read-only orphan outbox <id>` — the hazard `markResearchDeliveryBlocked`'s docblock names as its own reason not to throw, reintroduced one branch over. The id is now claimed out of the set as the branch's first statement, above the gate, and the reconcile case asserts no `orphan outbox` line names it. Mutation-verified: moving the claim back below the gate reddens that assertion.
  - `[low]` `[patch]` The extended per-project catch comment claimed a `drainResearchOutbox` refused at a row-in-hand branch lands there. It does not — that call site's own catch hands the error to `markResearchDeliveryBlocked`, which returns early for a `ReadOnlyError` without rethrowing. Corrected to name what actually happens.
  - `[low]` `[patch]` Both enumerations this change rewrote read as complete when they are not: the DW-681 test comment's replaced disclaimer, and the new `read-only.ts` paragraph. Reconcile's `!needsLease` and abandoned/cancelled branches still call ungated `releaseResearchSlot` / `releaseExpiredResearchSlot` / `releaseResearchSlotAndConfirmGone` / `clearResearchStaging`, and the drain still has a row-in-hand path through `commitResearchPage`'s ungated cancel/retire early returns. An explicit "still not exhaustive" note naming those shapes was restored in both places.
  - `[low]` `[patch]` The `|| project.deleteRequested` half of the done-phase drain gate was load-bearing but unpinned: narrowing the condition to `if (outbox)` left the whole suite green while a done-phase `deleteRequested` row with no outbox emptied its slot out of `research-leases.json` before the refusal arrived from the gated `deleteResearchProject`. Added the fourth byte case; mutation-verified it is now the exactly-one case that narrowing reddens.
  - `[low]` `[patch]` The exemption comment's "never writes a malformed list forward" omitted what the exempted path DOES write — the claim CAS replaces the completion with an outbox-derived one carrying `writeClaimedAt`/`writeClaimId` moments before the teardown deletes it, so a crash in that window leaves a completion the stored row never had. The intermediate write and its window are now stated; behaviour is unchanged, and is the pre-DW-652 shape the ledger decision pins.
  - `[low]` `[patch]` The in-CAS exemption comment justified itself with "a cancel can land between the two reads", an ordering that cannot fire alone — a malformed row that is not tearing down already threw at the pre-claim read, so the late-arriving case needs the row corrupted AND cancelled between the two. Rewritten to lead with the ordinary reason (already tearing down at both reads).

## Design Notes

Why the exemption answers `null` instead of skipping the read. Skipping outright would make a WELL-SHAPED cancelled row fall back to `completionSourcesFromOutbox(outbox)` where it used to use its own stored list — a silent behaviour change on a path that is not the bug. Answering the same list when the shape is fine, and `null` only where the guard would have thrown, keeps the delta to exactly the malformed case:

```ts
const tearingDown = afterSave.cancelRequested === true || afterSave.status === "cancelled";
const storedSources = afterSave.completion
  ? (tearingDown
      ? completionSourcesOrNull(afterSave.completion)
      : requireCompletionSources(afterSave.completion))
  : null;
```

What the exempted commit then does: the claim CAS writes a completion whose `sources` come from the outbox, the `authorized` mutator declines because the row is cancelled, and the cancel-finalize branch deletes that completion outright. Teardown never dereferences `sources`, which is the whole reason the guard was refusing for a value it would not have touched.

Why the done-phase drain gate is conditional. `if (project.completion?.phase === "done")` covers a pure read — no outbox, no `deleteRequested` — that returns the project. An unconditional gate at the head of that branch would turn a read into a refusal on a read-only deployment, which is a new bug, not a closed one.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/research-completion.test.ts` -- expected: all pass, including the new teardown rows and the untouched non-cancelled refusal rows.
- `npx vitest run src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/research-runtime.test.ts` -- expected: pass, including the new branch cases and the extended source-order table.
- `npx vitest run src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/research-completion-lifecycle.test.ts src/lib/__tests__/research-delivery.test.ts` -- expected: pass, unchanged.
- `npm test` -- expected: full suite passes with no new failures.
- `npm run lint` and `npx tsc --noEmit` -- expected: clean.
- Mutation checks, each restored afterwards: removing either exempt read reddens a teardown row; removing any one branch gate reddens exactly its own byte case.

## Auto Run Result

Status: done

**Implemented change.** The two research-lifecycle branches that failed in opposite directions now behave. TEARDOWN IS EXEMPT FROM THE SHAPE GUARD (DW-682): `commitResearchPage`'s two reads of a stored `completion.sources` — the pre-claim one and the one inside the claim CAS — take a new non-throwing sibling, `completionSourcesOrNull`, when the row they are holding is `cancelRequested` or already `status: "cancelled"`. A cancel that lands on a malformed completion at `phase: "page"` therefore reaches the claim CAS again, the `authorized` mutator declines, and the cancel-finalize branch deletes the completion outright, sets `status: "cancelled"` and drops the outbox — instead of throwing at a value teardown would never have dereferenced and stranding the row at `cancelRequested` forever. `requireCompletionSources` now DERIVES its refusal from that same sibling, so one predicate backs both answers and "a valid stored list" cannot come to mean two things; a well-shaped cancelled row is byte-for-byte unaffected, which is why the exemption answers `null` rather than skipping the read. FOUR READ-ONLY BRANCH GATES (DW-734): `reconcileResearchProjects`' done-phase branch and `drainResearchOutbox`'s three row-in-hand branches each take `assertWritable(READ_ONLY_REFUSAL.researchMutate)` at their own head — the drain's done-phase one conditional on there being an outbox or a `deleteRequested` to act on, because that branch is also a pure read. `deleteResearchOutbox`, `clearResearchStaging`, `clearPageWrittenMarker`, `deleteRetiredProjectIfLeaseGone` and `research-concurrency.ts` all stay ungated, for DW-527's reason.

**Files changed.**
- `src/lib/research-completion.ts` — `completionSourcesOrNull` and the refactored `requireCompletionSources`; the teardown exemption at both `commitResearchPage` reads; three branch gates in `drainResearchOutbox`; the docblock paragraphs the change falsified.
- `src/lib/research-runtime.ts` — the reconcile done-phase gate, with the outbox id claimed out of `outboxIds` above it so a refusal cannot be re-drained as an orphan; corrected per-project catch comment.
- `src/lib/read-only.ts` — one paragraph in the module note recording the four branch gates, the rule they share, and the limit of that enumeration.
- `src/lib/__tests__/research-completion.test.ts` — the two teardown rows (`cancelRequested` and `status: cancelled`), the same row through the drain, and the well-shaped-cancelled row that pins which list the claim CAS wrote.
- `src/lib/__tests__/read-only-store-gate.test.ts` — four whole-tree byte-identity refusal cases plus the pure-read control, two source-order table entries, and the corrected DW-681 comment.
- `src/lib/__tests__/research-runtime.test.ts` — the reconcile done-phase read-only case the DW-734 entry says was missing, driven by the real flag.

**Review findings.** 6 patched (all low), 1 deferred (low), 9 rejected. No intent gaps, no spec repairs. Follow-up review recommendation: `false` — patched severities were high 0, medium 0, low 6, so the score is 0.

**Verification.**
- `npx tsc --noEmit` — clean. `npm run lint` — clean (only the pre-existing `jsx-ast-utils` notices).
- `npx vitest run src/lib/__tests__/research-completion.test.ts src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/research-runtime.test.ts` — 240 pass, 1 skipped.
- `npx vitest run` over the adjacent read-only and research suites (door-coverage, copy-parity, kernel-gate, completion-lifecycle, delivery) — pass, unchanged.
- `npm test` — 388 files, 9770 pass, 1 skipped, no failures.
- Mutation checks, each restored: removing either exempt read reddens all three teardown rows; replacing the exempt read with an outright skip reddens only the well-shaped case; removing any one of the four gates reddens exactly its own byte case; narrowing the done-phase drain gate to `if (outbox)` reddens only the fourth byte case; moving the reconcile id-claim back below the gate reddens the reconcile case's orphan-line assertion.
- Matrix audit: all eleven I/O rows are covered by tests that ran and passed.

**Residual risks.**
- The exemption is reachable only from `phase: "page"`, because the phase check sits above both reads. A cancelled row whose malformed completion sits at `phase: "sources"` still refuses at the drain's own loop guard — recorded in frontmatter `deferred`; pre-existing, and the row stays listable and deletable.
- Reconcile's other branches (`!needsLease`, abandoned/cancelled) and `commitResearchPage`'s own retire/cancel `deleteResearchOutbox` calls remain ungated on a read-only deployment. Out of this bundle's scope by the intent, and now said so explicitly in both the test comment and the `read-only.ts` note rather than left implied.
- On the exempted teardown path the claim CAS briefly writes an outbox-derived completion before deleting it, so a crash in that window leaves the row holding a completion the stored value never had, with a claim that ages out. This is the pre-DW-652 behaviour the ledger decision pins, and it is now stated in the code comment.
- Same reachability caveat DW-681 carries: `GET /api/research` skips reconciliation when read-only and `POST /api/tasks/run` refuses, so the four new gates answer a direct-library-caller or mid-sweep-flip, not a deployed route.
