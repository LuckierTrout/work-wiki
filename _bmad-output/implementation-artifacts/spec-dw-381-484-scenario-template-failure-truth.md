---
title: 'Re-template truth: recoverable Schema in the confirm, registry read-back on the failure path'
type: 'bugfix'
created: '2026-08-30'
baseline_revision: 'f3f56be95d84582d68585846ac765e7f98e147d3'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `createWiki`'s compensation still assumes a `writeRegistry` that threw never
      landed — the assumption DW-484 has just falsified for `applyScenarioTemplate`.
    evidence: |-
      `createWiki`'s catch reasons "no registry entry names it, so discarding the
      whole directory is the exact undo", and `discardCreatedWikiDirectory` repeats
      "The registry never named this id". A review agent drove the case against the
      repo's real temp-DATA_DIR harness with a `writeFile` spy that writes
      `wikis.json` through and THEN throws: `createWiki` rejects, and afterwards the
      stored registry contains the new entry AND `currentId` points at it, while the
      compensation has deleted that wiki's directory — a tenant whose CURRENT wiki
      has no `purpose.md`, no `schema.md` and no profile on disk, and no bump. The
      record is well-formed so `normalizeRegistry` keeps it, and `sweepOrphanWikiDirectories`
      has no directory left to reclaim, so it persists. Every existing create row
      passes because `failWritesTo` rejects WITHOUT calling through, so the registry
      those rows compare byte-for-byte never moves. `setCurrentWiki`, `renameWiki`
      and `deleteWiki` carry the milder version of the same shape: the registry moved,
      the call reported failure, and the post-lock bump was skipped by the throw.
    location: >-
      src/lib/wikis.ts (createWiki failure path; also setCurrentWiki, renameWiki, deleteWiki)
    severity: medium
  - summary: >-
      Nothing reconciles or surfaces the registry/artifact divergence DW-484 now
      detects — the bump and a server-side warning are the whole remedy.
    evidence: |-
      `registryNamesScenario` is documented "DETECTS, DOES NOT RECONCILE", which is
      what the intent asked for, but the state it detects is left standing:
      `POST /api/wikis/[id]/template` still answers a bare 500 with the original
      error, `WikiWorkbench.applyTemplate`'s catch calls `router.refresh()` only on
      an `unconfirmed` failure, and the switcher row silently re-labels itself with
      the new scenario once the 10s `DATA_VERSION_POLL_MS` watcher picks the bump up.
      So the owner is told the re-template failed while the surface goes on to say it
      succeeded. The module already has `sweepOrphanWikiDirectories` as precedent for
      a maintenance-scan repair; no owner exists for this one.
    location: >-
      src/lib/wikis.ts (applyScenarioTemplate failure tail) / src/app/api/wikis/[id]/template/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two things the re-template path says are no longer true. The confirm (`WikiWorkbench.tsx`) presents the Schema overwrite as unrecoverable, which DW-213 falsified — a committed re-template now records the replaced `schema.md` as a revision the Preview's History panel lists and reverts (DW-381). And `applyScenarioTemplate`'s failure path derives `rollbackIncomplete` from `restoreSeededFiles` alone, so a `writeRegistry` that throws *after* its bytes landed rolls back "cleanly", skips the bump, and leaves the registry naming a scenario the on-disk artifacts do not describe with nothing telling an open Preview (DW-484).

**Approach:** Split the confirm sentence so the Schema is named recoverable (History) while `purpose.md` and the Workspace Purpose are named unrecoverable, and make the nearby "irreversible" comments say the same. On the failure path, read the registry back inside the lock and carry a second fact — whether the stored scenario is now the requested one — out to the tail; bump when either that or `rollbackIncomplete` is true.

## Boundaries & Constraints

**Always:**
- The failure path re-throws `outcome.error` unwrapped and unreplaced, exactly as today.
- The registry read-back happens INSIDE `withWikiLock` (it is a read of `wikis.json`, which the restore does not touch) and is fail-soft: it must never replace the original diagnosis.
- `applyScenarioTemplate` keeps exactly TWO `await bumpRefreshSignal(` call sites, both outside the lock — `workbench-data-version.test.ts` pins the count and the position.
- A clean rollback whose registry write did NOT land still bumps nothing.
- Confirm copy stays one paragraph in the dialog body, still names `purpose.md`, Schema and the Workspace Purpose, still says a Settings-authored purpose is replaced, and still says other wikis, Pages and Sources are unchanged.
- Every test that pins the old confirm sentence verbatim is updated to the new one.

**Block If:** none anticipated. If the registry read-back cannot be done inside the existing lock without nesting a second lock key, HALT rather than moving the bump inside the lock.

**Never:**
- Do not change `restoreSeededFiles`, `snapshotSeededFiles`, `recordRetemplatedArtifacts`, or the compensation itself.
- Do not add a `purpose.md` or profile revision (DW-213 deliberately scoped history to `EDITABLE_ARTIFACT_FILES`).
- Do not make the read-back compare `updatedAt` or attempt a repair/re-write of the registry — this path detects and signals, it does not reconcile.
- Do not extract the confirm copy into a shared constant; it is inline JSX today and `create-wiki-ui.test.ts` reads it out of the source.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Seed faults, restore complete, registry never written | `writeFile` throws on `schema.md` | Old bytes back; registry still names old scenario; NO bump | Original seed error re-thrown |
| Registry write throws WITHOUT landing | `writeFile` throws on `wikis.json` before writing | Old bytes back; registry unchanged; NO bump | Original error re-thrown |
| Registry write lands THEN reports failure (DW-484) | `writeFile` writes `wikis.json` then throws | Artifacts restored byte-identical; registry names the NEW scenario; ONE bump | Original error re-thrown; no restore warning |
| Restore incomplete (DW-210) | Seed commits, `wikis.json` throws, a restore write fails | ONE bump | Original error re-thrown; restore warning logged |
| Both: restore incomplete AND registry landed | Registry bytes land then throw, and a restore write fails | ONE bump whose reason names both facts | Original error re-thrown |
| Registry read-back itself throws | `readFile` of `wikis.json` fails on the failure path | Treated as landed → bump (over-signal is the safe side) | Warned, swallowed; original error still re-thrown |
| Bump itself fails on the landed-registry path | `bumpDataVersion` rejects | Warned, swallowed | Original error still re-thrown |
| Owner opens the re-template confirm | Writable deployment, a different scenario picked | Body names Schema as restorable from History, `purpose.md` and Workspace Purpose as not | n/a |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1141-1152` — `RetemplateOutcome`. The `failed` arm carries `error` + `rollbackIncomplete`; add a second boolean for the registry read-back and update the doc block that enumerates the three exits.
- `src/lib/wikis.ts:1200-1290` — `applyScenarioTemplate`. Locked body at ~1219; the `catch` at ~1237-1259 returns `{kind:"failed", …, rollbackIncomplete: !(await restoreSeededFiles(snapshot)) }`; the post-lock tail at ~1272-1284 bumps only on `rollbackIncomplete`. Both change. The long doc block above the function (~1153-1199) already spells out the DW-210 rationale and the over-signalling trade — extend it, do not replace it.
- `src/lib/wikis.ts:288-297` — `readRegistry`: plain read, ENOENT → empty registry, no lock of its own. Reuse it for the read-back; it re-parses the file, so it returns FRESH objects, not the mutated in-memory `wiki`.
- `src/lib/wikis.ts:542-580` — `restoreSeededFiles`, returns completeness. Unchanged, but its contract is the other half of the bump decision.
- `src/lib/wikis.ts:830-836` — `bumpRefreshSignal(after)`; `after` is a gerund phrase completing "the refresh signal did not move after …".
- `src/components/WikiWorkbench.tsx:528-534` — the `ConfirmDialog` `body` paragraph, inline JSX. The sentence to split.
- `src/components/WikiWorkbench.tsx:305` and `:460` — comments calling the operation "an irreversible rewrite" / "an irreversible overwrite". Make both truthful.
- `src/lib/wiki-scenarios.ts:77` — `EDITABLE_ARTIFACT_FILES = ["schema.md"]`. This is WHY only the Schema is recoverable; `recordRetemplatedArtifacts` (`src/lib/wikis.ts:638`) files revisions for exactly this set.
- `src/lib/workbench-preview.ts:786` — `PREVIEW_HISTORY_COPY = "History"`, the panel's visible label. The confirm must name the surface by that word.
- `src/lib/__tests__/create-wiki-ui.test.ts:179-192` — pins the confirm sentence verbatim (whitespace-collapsed source read). MUST be updated.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx:110` — comment repeating "an irreversible overwrite". Update the wording.
- `src/lib/__tests__/wikis.test.ts:2808-2975` — the re-template compensation suite: four `failWritesTo(suffix)` rows (clean rollback, asserts `readDataVersion()` unchanged), the DW-210 incomplete-restore bump test, and the "bump also fails" test. New DW-484 tests go beside them. Helpers in scope: `failWritesTo`, `warnsDuring`, `seededBytes`, `readDataVersion`, `abs(wikiRegistryPath(OWNER))`, `FAULT`.
- `src/lib/__tests__/workbench-data-version.test.ts:1209-1225` — pins `applyScenarioTemplate` at exactly 2 bump sites, both outside the lock. Do not add a third call site.
- `src/lib/__tests__/read-only-kernel-gate.test.ts:355` and `src/lib/workbench-tree.ts:106` — mention the overwrite but not its reversibility, and the copy's leading clause is unchanged, so neither needs editing. Verify rather than assume.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- Add a private fail-soft helper that answers whether the stored registry record for `wikiId` now names `scenario` (read via `readRegistry`, `warn` + return `true` on throw). Call it in `applyScenarioTemplate`'s `catch`, after `restoreSeededFiles`, and carry the answer out on the `failed` outcome as a second boolean. In the tail, bump once when either boolean is true, with a reason that names which fact(s) fired. Extend the `RetemplateOutcome` and `applyScenarioTemplate` doc blocks to state what the read-back proves and what it deliberately cannot distinguish (a re-apply of the SAME scenario reads as "landed" — over-signalling, the documented safe side).
- `src/components/WikiWorkbench.tsx` -- Split the confirm body sentence: keep the existing overwrite clause and the Settings-purpose clause, then state that the replaced Schema is kept in the Preview's History and can be restored, while `purpose.md` and the Workspace Purpose are not kept and cannot be recovered; keep the closing blast-radius clause. Reword the `:305` and `:460` comments so "irreversible" is scoped to the two halves that really are.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- Update the pinned sentence to the new copy and extend the surrounding comment to say why the two halves are named separately.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- Update the comment at the read-only click test to match the new characterisation.
- `src/lib/__tests__/wikis.test.ts` -- Add the matrix rows the suite does not yet cover: registry bytes land then the write reports failure (clean restore, registry on the new scenario, exactly one bump, no restore warning); the same shape with a restore also failing (still exactly one bump); and a read-back that itself throws (bump anyway). Assert the original `FAULT` propagates in every row.

**Acceptance Criteria:**
- Given a re-template whose `wikis.json` bytes land and whose write then throws, when `applyScenarioTemplate` rejects, then the artifact files are byte-identical to before the call, the stored registry record names the requested scenario, and `dataVersion` has moved by exactly one.
- Given the same call, when the caller inspects the rejection, then it is the original error unwrapped — the read-back neither replaces nor wraps it.
- Given a re-template that faults before any registry bytes land and whose restore is complete, when it rejects, then `dataVersion` is unchanged.
- Given the registry read-back itself throws on the failure path, when the call rejects, then a warning is logged, the original error still propagates, and `dataVersion` has moved by exactly one.
- Given an owner opens the Change Scenario Template confirm, when they read the body, then it names the replaced Schema as restorable from History and `purpose.md` and the Workspace Purpose as unrecoverable, and still says other wikis, Pages and Sources are unchanged.
- Given the module source, when `workbench-data-version.test.ts` runs, then `applyScenarioTemplate` still has exactly two `bumpRefreshSignal` call sites and both are outside the wiki lock.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 2: (high 0, medium 1, low 1)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[low]` `[patch]` `registryNamesScenario` answered "did not land" when the record was ABSENT — `readRegistry` turns ENOENT into an empty registry and `normalizeRegistry` silently drops a malformed entry, so `?.scenario === scenario` collapsed "unknown" into "unchanged", the exact under-signal the helper's own fail-soft paragraph disclaims. Split into a three-way answer: absent → warn + landed, present-and-different → not landed, present-and-equal → landed.
  - `[low]` `[patch]` The read-back ran unconditionally in the `catch`, so a seed fault — the majority of failures — could still put "a registry write that landed" in the log for a write never issued. Added `registryWriteAttempted`, set immediately before `writeRegistry`, gating the read-back; rewrote the read-back-throws test so the write is genuinely attempted.
  - `[medium]` `[patch]` The detected divergence was logged nowhere — every other degradation in the module warns, and the first new test actively pinned the silence. Added a `logger.warn` on positive detection, phrased as the observation ("the restored artifacts may describe a different one") rather than the inference, and updated that test to assert the warning instead of the silence.
  - `[low]` `[patch]` The `RetemplateOutcome` docblock cited `confirmDisabled={pendingScenario === current?.scenario}` as if it closed the same-scenario false positive; the route parses only and library/MCP callers have no guard. Softened to name it a client-side courtesy and state that a direct caller does take the branch.
  - `[low]` `[patch]` The confirm's "History" was joined to `PREVIEW_HISTORY_COPY` by nothing. `create-wiki-ui.test.ts` now imports the constant and asserts the pinned sentence contains it, so renaming the panel fails there.
  - `[medium]` `[patch]` The new owner-facing safety sentence was guarded only by a whitespace-collapsed grep over `WikiWorkbench.tsx` source, which would pass with the paragraph moved outside the dialog subtree. Added a DOM row to `create-wiki-flow.test.tsx` asserting the RENDERED dialog contains it.
  - `[low]` `[patch]` The composed bump reason — the whole justification for two booleans rather than one renamed flag — was asserted by nothing. The landed-registry bump-fails row now captures the warn and pins that the reason names the registry fact and NOT the (clean) rollback.

## Design Notes

Shape of the failure outcome — two independent facts, one bump:

```ts
type RetemplateOutcome =
  | { kind: "unknown" }
  | { kind: "applied"; wiki: WikiRecord }
  | { kind: "failed"; error: unknown; rollbackIncomplete: boolean; registryLanded: boolean };
```

Two booleans rather than one renamed flag: DW-210's `rollbackIncomplete` means "a restore entry failed", DW-484's means "the registry moved under a reported failure". They are different observations with different remedies, and collapsing them would lose which one the log line should name. The tail composes ONE reason from whichever fired, so the pinned two-call-site count is untouched.

Why `readRegistry` and not the in-memory `registry`: the locked body mutates `wiki.scenario` in place before the seed, so the closed-over object always shows the new scenario. `readRegistry` re-reads and re-parses `wikis.json`, so it reports what is actually stored.

What the read-back deliberately cannot tell apart: re-applying a wiki's CURRENT scenario. The stored record already names it, so the read-back answers "landed" even when the write never ran. That is over-signalling — one spurious refetch of bytes that did not change — which is the same side of the trade DW-210's doc block already argues for, and the UI's `confirmDisabled={pendingScenario === current?.scenario}` keeps the owner off that path anyway.

The confirm's Schema-is-recoverable claim is unqualified even though `recordRetemplatedArtifacts` is fail-soft. Qualifying pre-action copy with "unless recording the revision also fails" would trade a true sentence for an unreadable one; the fail-soft warning is the place that says a history did not move.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/workbench-data-version.test.ts src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- expected: all pass, including the new DW-484 rows.
- `pnpm lint` -- expected: no new errors.
- `pnpm vitest run` -- expected: no regression against the pre-change baseline.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Made the re-template path truthful in the two places it had stopped being so. DW-381: the destructive confirm's one paragraph now separates the halves it destroys — the replaced Schema is named as kept in the Preview's History and restorable (DW-213 files it as a revision), while `purpose.md` and the Workspace Purpose are named as not kept and unrecoverable; two nearby comments that called the whole operation "irreversible" were rescoped to match. DW-484: `applyScenarioTemplate`'s failure path no longer derives the `dataVersion` bump from `restoreSeededFiles` alone. It reads `wikis.json` back inside the lock it already holds and carries a second fact — whether the stored record now names the requested scenario — out to the tail, which bumps once when either fact fired and names whichever did. The original error is still re-thrown unwrapped, and a clean rollback whose registry write did not land still bumps nothing.

**Files changed.**
- `src/lib/wikis.ts` -- new private fail-soft `registryNamesScenario` (three-way: absent → landed, present-and-different → not landed, present-and-equal → landed + warn); `registryWriteAttempted` gating the read-back to failures where the write was actually issued; `RetemplateOutcome.failed` gains `registryLanded`; the tail composes one reason from the two facts. Docblocks extended, not replaced.
- `src/components/WikiWorkbench.tsx` -- the `ConfirmDialog` body sentence split; the `applyTemplate` backstop comment and the Change-template button comment rescoped.
- `src/lib/__tests__/wikis.test.ts` -- four new rows beside the existing compensation suite (registry landed then reported failure; landed AND incomplete restore; read-back itself throws; the landed-registry bump itself fails).
- `src/lib/__tests__/create-wiki-ui.test.ts` -- the pinned confirm sentence updated, plus an assertion tying its "History" to `PREVIEW_HISTORY_COPY`.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- a DOM row asserting the rendered dialog carries the new sentence.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- comment rescoped to match.

**Review findings.** 7 patches applied (2 medium, 5 low), 2 deferred (1 medium, 1 low — see frontmatter `deferred`), 9 rejected, 0 intent gaps, 0 spec repairs. Follow-up review recommended: **true** — patched severities were 0 high, 2 medium, 5 low, scoring 3×2 + 1×5 = 11, at or above the threshold of 5.

**Verification.**
- `pnpm vitest run` over the five spec'd files: 223 passed, 0 failed.
- `pnpm vitest run` (full): 354 files, 8374 passed, 1 skipped, 0 failed.
- `pnpm lint`: clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from baseline).
- `npx tsc --noEmit`: clean.
- Matrix audit: every I/O row has a covering row that ran and passed — the three `failWritesTo` seed rows and the `wikis.json` row for the two no-bump cases, and the four new rows for the landed, both-facts, read-back-throws and bump-fails cases. The confirm row is covered by both the source pin and the new DOM row.
- Negative check: the implementation agent stashed `wikis.ts` and re-ran the new rows — the landed-registry row failed on the bump count and the read-back row on the missing warning, so neither is vacuous.

**Residual risks.**
- The read-back's predicate is "the stored record equals the REQUESTED scenario", not "the record changed". Re-applying a Wiki's current scenario through the route or a library caller therefore takes a spurious bump when the call fails; the cost is one refetch of bytes that did not change, and the docblock now states plainly that `confirmDisabled` is a client-side courtesy rather than a gate.
- The composed bump reason is observable only through `bumpRefreshSignal`'s own failure warning, and `bumpDataVersion` swallows its failures today. The test that pins the reason therefore drives that swallow's `logger.warn` to throw — an admitted seam, documented in the test, whose assertions keep holding unchanged if `bumpDataVersion` ever stops swallowing.
- The divergence is detected and announced but not repaired; see the second `deferred` entry.
