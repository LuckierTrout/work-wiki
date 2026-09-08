---
title: 'Research read-only door copy: the three doors DW-527/528 missed'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
baseline_revision: '3a28c2a5d5417307d307569f960bd46783751759'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Reconcile's orphan-outbox loop deletes an UNCLAIMED orphan outbox on a
      read-only deployment, writing where the deployment promises to write
      nothing.
    evidence: |-
      `reconcileResearchProjects`' orphan loop calls `drainResearchOutbox`,
      which for a missing project row calls `drainOrphanOutbox`
      (src/lib/research-completion.ts:991-994). When `outbox.claimed !== true`
      that path calls `deleteResearchOutbox` and returns — and
      `deleteResearchOutbox` (research-completion.ts:314-321) is an ungated
      `clearResearchStaging` + `getStorage().deleteFile`, so it destroys the
      outbox on a deployment that has refused every other write. The gated
      writer DW-660 branches on is only reached for a CLAIMED outbox, so the
      new `isReadOnlyError` branch does not cover this shape at all. Reachable
      today only by a direct library caller: `GET /api/research` skips
      reconciliation when read-only and `POST /api/tasks/run` refuses, the same
      caveat DW-528's per-project branch carries.
    location: >-
      src/lib/research-completion.ts:991
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three research doors still answer a read-only refusal with the wrong sentence. `createResearchProject` converts its mid-flip sentinel to `READ_ONLY_REFUSAL.researchMutate` three lines below its own gate's `researchCreate` — one door, two sentences, and only `researchCreate` says the thing that matters here: nothing was created (DW-659). Reconcile's orphan-outbox catch logs `reconcile skipped damaged orphan outbox <id>` for a refusal, the exact mislabel DW-528 removed from the per-project catch one loop above (DW-660). And `markResearchDeliveryBlocked` stores `"Research delivery is blocked. Repair the reported lock, then retry."` for *every* drain fault, naming a lock that is not involved — and on a read-only deployment it also attempts a fence write it has no business attempting (DW-656).

**Approach:** Correct the sentence at each door, give the orphan loop the same `isReadOnlyError` branch its sibling already has, make the delivery-blocked path return early on a read-only fault instead of writing a lock-shaped fence, and pin all three with tests.

## Boundaries & Constraints

**Always:** One refusal sentence per door, served from the `READ_ONLY_REFUSAL` constant — never a re-typed literal. A read-only refusal must be distinguishable from data damage and from a lost CAS race in every log line and every stored message. On a read-only deployment nothing is written: no fence, no progress message, no tombstone.

**Block If:** A fix here would require adding a new `READ_ONLY_REFUSAL` key, or would change which HTTP status a research route serves.

**Never:** Do not edit `spec-dw-527-528-research-store-read-only-refusal.md` or any other historical spec artifact — its I/O matrix row for the create mid-flip is superseded by this spec, not rewritten. Do not touch the `.catch(() => undefined)` drain swallows at `research-runtime.ts:555` / `:557` (DW-656's second paragraph — not in this bundle's intent). Do not change `reconcile`'s control flow: `markResearchDeliveryBlocked` must not start throwing, because a throw from there would skip `outboxIds.delete(project.id)` and re-drain a live project through the orphan loop. Do not add a new refusal wording for the drain fault — the row's own `error` field already carries the fault.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create, flag flips after its own gate | `createResearchProject` passes `assertWritable`, CAS returns `RESEARCH_WRITE_REFUSED` | Throws `ReadOnlyError(READ_ONLY_REFUSAL.researchCreate)`; no project stored, no bytes moved | The gate's own sentence, not `researchMutate` |
| Create, deployment read-only on arrival | Flag set before the call | Unchanged: throws `ReadOnlyError(READ_ONLY_REFUSAL.researchCreate)` from the entry gate | Same sentence as the row above |
| Delete / edit mid-flip | Flag flips after their gate | Unchanged: `researchMutate` | Regression guard for the row above |
| Reconcile orphan outbox, read-only | Outbox with `claimed: true` and no project row; page writer refuses | Logs `reconcile skipped read-only orphan outbox <id>`; loop continues to the next orphan | Never `damaged orphan outbox` |
| Reconcile orphan outbox, real fault | Same orphan, an ordinary storage/write error | Logs `reconcile skipped damaged orphan outbox <id>` | Control: the read-only line must not swallow real damage |
| Drain blocked by a non-refusal fault | Drain throws (e.g. expired durable lock) | Row goes `status: "failed"`, `deliveryBlocked: true`, `error` = the fault, progress message `"Research delivery is blocked. Resolve the reported error, then retry."` | No lock named for a fault that is not a lock |
| Drain refused because the deployment is read-only | Drain throws `ReadOnlyError` | `markResearchDeliveryBlocked` logs a read-only skip and returns; the row is byte-identical — no `deliveryBlocked`, no `status: "failed"`, no message | Caller's own rethrow (`runResearchProject`) is unchanged |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts:588-592` -- `createResearchProject`'s mid-flip sentinel conversion. `assertWritable(READ_ONLY_REFUSAL.researchCreate)` is its own gate at `:561`; the throw at `:591` currently carries `researchMutate`. This is the ONLY line to change in this file.
- `src/lib/read-only.ts:294-308` -- the two constants. `researchCreate` ("…cannot be created…"), `researchMutate` ("…cannot be changed…"); `researchMutate`'s docstring already states that `researchCreate` "says something the others cannot: that nothing was created". Module note at `:115-129` describes create/delete converting the sentinel — add the clause naming *which* sentence create converts to. No new key.
- `src/lib/research-runtime.ts:276-305` -- `markResearchDeliveryBlocked`. Called from reconcile `:665` (swallows) and `runResearchProject` `:1479` (rethrows after). Writes via `updateResearchProjectIf`, which collapses the read-only sentinel to `null` — so today the read-only path is silent-by-accident, not by design. `isReadOnlyError` is already imported at `:59` and used at `:273` / `:893`.
- `src/lib/research-runtime.ts:903-910` -- the orphan-outbox loop. `drainResearchOutbox(owner, orphanId)` → `drainOrphanOutbox` → `writeResearchPage` → `writeWikiPageWithSideEffects` (`src/lib/lifecycle.ts:1394`, `assertWritable(READ_ONLY_REFUSAL.pageWrite)`), so a `ReadOnlyError` lands in this catch. Mirror the per-project catch at `:880-901` exactly — same branch shape, same `logger.warn` channel.
- `src/lib/__tests__/read-only-store-gate.test.ts:598-641` -- "create and delete THROW when the flag flips after their own gate". Its `createResearchProject` expectation is the pinned wording; update it to `researchCreate` and say why the two differ. Helper `expectRefusal` + `snapshot`/`seededSnapshot` are already in the file.
- `src/lib/__tests__/research-runtime.test.ts:1339-1410` -- DW-528's pair (read-only skip + "still names a DAMAGED project" control). Copy this shape for the orphan loop. `:1965-1989` is the working orphan-outbox setup (`saveResearchOutbox` with `claimed: true`, then `deleteResearchProject`). `:2012-2035` pins the delivery-blocked message with `/repair.*lock.*retry/i` — must be updated. `writeWikiPageWithSideEffects` is mocked at `:42`, so a read-only page refusal is produced with `mockedWritePage.mockRejectedValueOnce(new ReadOnlyError(READ_ONLY_REFUSAL.pageWrite))`; `ReadOnlyError` is NOT yet in the `../read-only` import at `:127`.
- `src/lib/__tests__/read-only-copy-parity.test.ts:420-440` -- the Research-desk copy parity block. Already asserts `researchCreate ≠ researchMutate`; no change expected, but it must still pass.
- `src/lib/__tests__/research-route.test.ts:136-154` -- already mocks the store rejecting with `researchCreate` for the mid-flip 403. This spec makes that mock truthful; no change expected.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- change the mid-flip throw at `:591` to `READ_ONLY_REFUSAL.researchCreate` and rewrite the comment above it to state why the door's two refusal paths must carry one sentence -- a create that never happened must not be reported with "cannot be changed".
- `src/lib/read-only.ts` -- extend the DW-527 paragraph in the module note so it names `researchCreate` for create and `researchMutate` for delete, and records DW-659 -- the note is the one place a reader learns which sentence a converted sentinel carries.
- `src/lib/research-runtime.ts` -- in `markResearchDeliveryBlocked`, return early on `isReadOnlyError(error)` after a `logger.warn` naming the read-only skip, and change the stored progress message to `"Research delivery is blocked. Resolve the reported error, then retry."`; add a docstring recording both -- a refusal must not leave an operator-cleared fence behind, and the sentence must point at the `error` the row actually carries.
- `src/lib/research-runtime.ts` -- give the orphan-outbox catch the `isReadOnlyError` branch its per-project sibling has, logging `reconcile skipped read-only orphan outbox <id>` -- DW-528's fix, applied to the loop it did not name.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- update the create expectation in the mid-flip case to `researchCreate`, and assert in that same case that the create and delete sentences are NOT the same string -- pinning both halves stops a future "unify them" edit from re-merging the two.
- `src/lib/__tests__/research-runtime.test.ts` -- import `ReadOnlyError`; add a read-only orphan-outbox case and its damaged-orphan control; add a read-only drain case asserting the row is untouched; update the `/repair.*lock.*retry/i` expectation to the new sentence -- one test per matrix row that this change moves.

**Acceptance Criteria:**
- Given a writable deployment, when `createResearchProject` runs normally, then it still creates the project — the refusal wording change moves no happy path.
- Given `POST /api/research` on a deployment that flips read-only after the route gate, when the store refuses, then the 403 body carries the same sentence the route's own early gate would have served.
- Given a reconcile pass over two orphan outboxes on a read-only deployment, when both page writes are refused, then both are logged as read-only skips and the loop still reaches the second — no line calls either outbox damaged.
- Given a project whose drain is refused because the deployment is read-only, when reconcile handles that fault, then the stored row is unchanged in every field an operator reads, and the next writable run is not gated behind an explicit Retry.

## Spec Change Log

_No bad_spec loopback occurred; this log is empty._

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 16: (high 0, medium 0, low 16)
- addressed_findings:
  - `[low]` `[patch]` `markResearchDeliveryBlocked`'s docstring said "Reconcile's caller swallows what this returns" — reconcile IS the caller. Rephrased to name `reconcileResearchProjects` and its `outboxIds.delete`, and to name `runResearchProject` as the rethrowing caller.
  - `[low]` `[patch]` The docstring did not say when the new early return actually fires. Added a `WHICH PROJECTS ACTUALLY REACH THE EARLY RETURN` paragraph: both callers pass through `ensureResearchDeliveryAttempt`, whose mint collapses to `null` on a store-wide read-only deployment, so the branch fires for a project that already carries a `deliveryAttemptId` and for the mid-flip page-writer-only shape.
  - `[low]` `[patch]` The orphan-catch comment claimed the drain always reaches the gated page writer. Qualified to CLAIMED outboxes, noting that `drainOrphanOutbox` deletes an unclaimed one without reaching a writer.
  - `[low]` `[patch]` `read-only.ts`'s new paragraph claimed to be "the one place a reader learns which sentence a converted sentinel carries" (false alongside the `research-projects.ts` comment) and mis-anchored its rationale so it read as the reason create differs from delete. Rewritten as its own paragraph about agreement WITHIN one door.
  - `[low]` `[patch]` The "names no lock" guard let "locks", "locking", "lockfile" and "lock-holder" through — exactly the likely rewordings. Widened the pattern's tail.
  - `[low]` `[patch]` No test covered `runResearchProject`, the fence's other caller, whose rethrow the docstring calls load-bearing. Added a case asserting the refusal is rethrown and the row is not fenced; mutation-checked by removing the early return and confirming the test fails.

## Design Notes

The two doors' sentences are load-bearing and must stay distinct: `researchCreate` is "Research projects cannot be created…", `researchMutate` is "…cannot be changed…". A caller who sees "cannot be changed" from a create has to go looking for the project it thinks it changed. `read-only.ts`'s own docstring already argues this; DW-659 is only that `createResearchProject`'s second refusal path never got the memo.

The orphan branch is a verbatim mirror, not a new idea:

```ts
} catch (error) {
  if (isReadOnlyError(error)) {
    logger.warn("research", `reconcile skipped read-only orphan outbox ${orphanId}`, error);
  } else {
    logger.warn("research", `reconcile skipped damaged orphan outbox ${orphanId}`, error);
  }
}
```

The delivery-blocked early return is the "gate" half. Without it, a flag that flips back to writable between the drain's throw and the fence write would store `deliveryBlocked: true` with a read-only sentence as `error` — a fence only an explicit Retry clears, for a fault that was never about the row. Returning early makes "read-only wrote nothing" a property of this function rather than an accident of `updateResearchProjectIf` collapsing the CAS sentinel to `null`.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-completion.test.ts` -- expected: all pass, including the new read-only orphan/drain cases and their damage controls.
- `pnpm lint` -- expected: no new errors.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `rg -n "Repair the reported lock" src` -- expected: no matches.


## Auto Run Result

Status: done

**Implemented change.** The DW-527/528 read-only wording sweep now covers the three research doors it missed. `createResearchProject`'s mid-flip sentinel conversion throws `READ_ONLY_REFUSAL.researchCreate` — the sentence its own `assertWritable` gate serves — instead of `researchMutate`, so a create that never happened is no longer reported as a project that "cannot be changed" (DW-659); `POST /api/research`'s 403 backstop carries that sentence verbatim, so the route's early gate and its kernel backstop finally agree. Reconcile's orphan-outbox catch gained the `isReadOnlyError` branch its per-project sibling has had since DW-528, logging `reconcile skipped read-only orphan outbox <id>` rather than calling a refusal data damage (DW-660). And `markResearchDeliveryBlocked` no longer fences a row for a read-only refusal at all — it logs `skipped read-only delivery block for <id>` and returns before it reads or writes — while the fence it still raises for real faults says `"Research delivery is blocked. Resolve the reported error, then retry."`, pointing at the `error` field the row actually carries instead of at a lock that may not be involved (DW-656).

**Files changed.**
- `src/lib/research-projects.ts` — the mid-flip throw at the create door now carries `researchCreate`, with a comment recording why one door must answer with one sentence.
- `src/lib/read-only.ts` — a new module-note paragraph naming which sentence each converted sentinel carries, and why the requirement is agreement within a door rather than uniformity across doors.
- `src/lib/research-runtime.ts` — `markResearchDeliveryBlocked` gained a docstring, an `isReadOnlyError` early return with a warn, and the lock-free progress sentence; the orphan-outbox catch gained the read-only branch.
- `src/lib/__tests__/read-only-store-gate.test.ts` — the mid-flip create expectation moved to `researchCreate`, plus a distinctness assertion on the two constants.
- `src/lib/__tests__/research-runtime.test.ts` — four new cases (read-only orphan skip with its damaged-orphan control; a refused drain that must not fence, driven through reconcile; the same refusal rethrown by `runResearchProject`), and the fence-sentence expectation updated with a widened "names no lock" guard.

**Review findings breakdown.** 6 patches applied (all low): docstring caller naming; docstring reachability paragraph; orphan-comment qualification for unclaimed outboxes; `read-only.ts` paragraph rewrite; widened lock-word guard; the missing `runResearchProject` rethrow test. 1 item deferred (low) — see frontmatter `deferred`. 16 items rejected, chiefly: ledger edits (forbidden by the invocation), `isReadOnlyError` not unwrapping `cause` and the log spies being `warn`-scoped (both match the DW-528 sibling this change was told to mirror), the fence sentence not being a `READ_ONLY_REFUSAL` constant (progress messages are inline throughout this file by convention), and several out-of-scope pre-existing paths.

**Follow-up review recommendation.** Patched this pass: high 0, medium 0, low 6. Score = 3x0 + 1x6 = 6, which is >= 5, so `followup_review_recommended: true`.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-completion.test.ts` — 234 passed, 1 skipped, 0 failed.
- `pnpm vitest run` (full suite) — 354 files, 8398 passed, 1 skipped.
- `pnpm exec tsc --noEmit` — clean. `pnpm lint` — no errors (three pre-existing `jsx-ast-utils` advisory lines only).
- `rg -n "Repair the reported lock" src` — no matches.
- Matrix audit: every one of the seven I/O rows has a covering test that ran and passed. The new `runResearchProject` case was mutation-checked — removing the early return makes it fail.

**Residual risks.**
- An intent-alignment reviewer reported an intermittent failure of the new "does NOT fence" case (empty warn list) and of neighbouring fence tests, seen while three reviewer sessions ran vitest concurrently in this working tree. It did not reproduce: 6 sequential runs of the file, 3 concurrent runs of the file, and two full-suite runs were all green, and the reviewer could not reproduce it either after bisecting in an isolated worktree. Recorded rather than resolved.
- DW-656's ledger entry also names the `.catch(() => undefined)` drain swallows at `research-runtime.ts:555` and `:557`, which let cancel and retire silently no-op against a corrupt completion. This bundle's intent narrowed DW-656 to the sentence and the gate, so those swallows are untouched and are NOT resolved by this change. Flagged here because closing DW-656 would otherwise retire the only record of them.
- `spec-dw-527-528-research-store-read-only-refusal.md:129` still shows `Throws ReadOnlyError(researchMutate)` for the create mid-flip. That row is superseded by this spec's matrix, not rewritten — historical spec artifacts are left frozen, as prior sweeps on this branch did.
