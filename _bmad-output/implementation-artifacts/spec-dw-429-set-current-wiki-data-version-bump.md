---
title: 'DW-429/DW-518: a Wiki switch moves the refresh signal'
type: 'bugfix'
created: '2026-09-01'
baseline_revision: 'b19be38a742d2280e99f6272a72d78d5f4d94041'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `setCurrentWiki` is the last kernel writer in `src/lib/wikis.ts` with no `dataVersion` tail, on the recorded rationale that a switch "writes nothing a Preview renders" and that the selection change is its own refresh trigger. That rationale only covers the tab that issued the switch: which Wiki is current decides which `purpose.md`/`schema.md` every read resolves, so ANOTHER open tab — and any surface not keyed on the switcher's own `router.refresh()` — goes on rendering the previous Wiki's artifacts until the owner reloads.

**Approach:** Give `setCurrentWiki` the same fail-soft `bumpRefreshSignal(...)` tail `renameWiki` and `deleteWiki` carry — outside `wikis:<tenant>`, only when the locked body returned a record — and reverse the recorded no-bump exemption in the source-scan guard that pins which writers bump.

## Boundaries & Constraints

**Always:**
- The bump goes at the function tail, OUTSIDE `withWikiLock`. `bumpDataVersion` takes `DATA_VERSION_LOCK` and `withFileLock` is not reentrant, so a bump inside the locked body nests two lock keys.
- Go through the existing private `bumpRefreshSignal` helper — never call `bumpDataVersion` directly from a writer, and never re-type the fail-soft `try`/`catch`.
- Fail-soft: `wikis.json` is already written by the time the tail runs, so a counter that did not move must never turn a landed switch into a rejected one.
- An unknown id (locked body returned `null`) must NOT bump, and neither must a read-only refusal — `assertWritable` still runs before the lock, so it throws before anything can bump.
- `setCurrentWiki`'s return type and read-only gate ordering stay exactly as they are.

**Block If:** Nothing. The human decision on DW-429/DW-518 ("Bump at the kernel tail") selects the approach; no further judgement call is open.

**Never:**
- Do not touch `putWikiArtifact`, `seedWikiArtifacts`, `retitlePurpose` or `sweepOrphanWikiDirectories` — their exemptions are unchanged and for different reasons.
- Do not edit the deferred-work ledger (`deferred-work.md` / `deferred-work-archive.md`); the orchestrator records resolution.
- Do not change `WikiSwitcher.tsx` or `PUT /api/wikis/current`; the client's own `router.refresh()` stays.
- Do not widen `bumpRefreshSignal`'s visibility (it must stay non-exported).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Switch lands | Two Wikis exist, B current | `setCurrentWiki(owner, A)` returns A's record, `currentId` is A, `dataVersion` is `before + 1` | No error expected |
| Unknown id | Registry has no such id | Returns `null`, `dataVersion` unchanged | No error expected |
| Counter store down | `putIndex` rejects | The switch still resolves with A's record and `currentId` is A; `dataVersion` unchanged; `data-version` logs `bump failed; the signal did not move` | Swallowed by `bumpDataVersion`; never propagated |
| Read-only deployment | `YOPEDIA_READONLY=1` | `ReadOnlyError(READ_ONLY_REFUSAL.wikiSwitch)` before the lock; no registry write and no bump | Refusal propagates unchanged |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1508-1542` -- `setCurrentWiki`: docblock (`NON-DESTRUCTIVE … wikis.json is the ONLY file this writes`) plus the body, which today is a bare `return withWikiLock(owner, async () => { … })`. Restructure to the `renameWiki` shape.
- `src/lib/wikis.ts:1604-1660` -- `renameWiki`: the exact tail shape to copy — `const renamed = await withWikiLock(...); if (!renamed) return null; await bumpRefreshSignal(...); return renamed;` — plus the docblock paragraph explaining outside-the-lock/fail-soft/only-on-a-record.
- `src/lib/wikis.ts:814-849` -- `bumpRefreshSignal(after)`: the one private fail-soft helper. `after` completes "the refresh signal did not move after …", so it is a GERUND phrase. Its docblock's "SIX TIMES" tally and caller list are already stale (seven calls across six writers today) and must be corrected to the post-change reality.
- `src/lib/__tests__/workbench-data-version.test.ts:1163-1273` -- the guard `has one bump helper inside wikis.ts, called from six writers outside the tenant lock`. Three things move: the `it(...)` title, the `setCurrentWiki` exemption rationale in the long comment (currently ~:1178-1183, "`setCurrentWiki` is the only one that genuinely writes nothing a Preview renders"), and the counts — `expect(source.match(/await bumpRefreshSignal\(/g)).toHaveLength(7)` at ~:1217, the `[name, calls]` table at ~:1222-1229, and `expect(counted).toBe(7)` at ~:1271. NOTE: the DW-429 ledger text names lines 1067-1071/1088-1089 and a count of 6; those coordinates are stale (DW-518 records this) — use the current lines and the current counts.
- `src/lib/__tests__/workbench-data-version.test.ts:96-135` -- `readSource` / `stripComments` / `topLevelFunctionBody`. The lock-close probe looks for `"\n  });\n"` or `"\n  );\n"` at the function's top indent AFTER `withWikiLock(owner`, so the restructured body must keep its `withWikiLock` close at two-space indent.
- `src/lib/__tests__/wikis.test.ts:352-508` -- `describe("create, re-template and rename move the refresh signal (DW-49, DW-57, DW-209)")`. Behavioural home for the new rows; copy the shape of `bumps exactly once per rename`, `does not bump for a rename of an unknown wiki id`, and `still resolves a rename when the counter store rejects putIndex` (`BUMP_FAILED_WARN` is declared at :529).
- `src/lib/read-only.ts:250-259` -- `READ_ONLY_REFUSAL.wikiSwitch` docblock states "A switch writes ONE file — `wikis.json` — and nothing else". Correct the now-false half; the refusal sentence itself is character-pinned elsewhere and must not change.
- `src/lib/__tests__/wikis-routes.test.ts:481-485` -- the same now-false claim in a comment above the 403 case. Comment only; the assertions are unaffected (`setCurrentWiki` is mocked there).

**Read-only evidence — nothing existing regresses:**
- `read-only-kernel-gate.test.ts:404` (`setCurrentWiki — the pointer and every registry byte survive`) snapshots `tmpDir` (which contains `.indexes/`) BEFORE `YOPEDIA_READONLY=1` and the call refuses ahead of the lock, so no bump happens on that path.
- `wikis.test.ts:1154`, `:1192` (`deleteWiki` bump rows), `wiki-schema-edit.test.ts:836,842,855` and `wiki-artifact-revisions.test.ts:650` all call `setCurrentWiki` BEFORE their `readDataVersion()` baseline, or in cases that read no counter at all.
- `src/lib/__tests__/read-only-kernel-gate.test.ts:510` asserts the switch succeeds but takes no post-call tree snapshot.
- `_bmad-output/implementation-artifacts/spec-dw-209-289-wiki-rename-refresh-and-sweep-cap.md:61` carries a "do not touch `setCurrentWiki`" fence. That was DW-209's own scope boundary (`deleteWiki` has since been un-fenced by DW-382); the recorded human decision on DW-429 supersedes it.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- in `setCurrentWiki`, bind the `withWikiLock` result to a const, return `null` when it is null, then `await bumpRefreshSignal(...)` with a gerund phrase naming the switch (e.g. `` `switching to wiki "${switched.id}"` ``) before returning the record -- gives another open tab the only signal it can get that every artifact read now resolves against a different Wiki.
- `src/lib/wikis.ts` -- rewrite the `setCurrentWiki` docblock's `NON-DESTRUCTIVE` paragraph so it states what the switch writes AND that it now carries the bump, with the reason (a switch changes which Wiki every `purpose.md`/`schema.md` read resolves; only the switching tab gets the client-side refresh) -- the old paragraph is the exact claim being reversed.
- `src/lib/wikis.ts` -- correct `bumpRefreshSignal`'s docblock tally and caller list to the post-change reality -- it is already stale and the change makes it more so.
- `src/lib/__tests__/workbench-data-version.test.ts` -- update the guard: title, the `setCurrentWiki` exemption rationale (replace it with why it now bumps, keeping the other three exemptions intact), the module-wide `bumpRefreshSignal` count, the `[name, calls]` table (add `setCurrentWiki`), and the `counted` total -- this suite is the only thing that pins WHICH writers bump.
- `src/lib/__tests__/wikis.test.ts` -- add three rows to the refresh-signal describe covering the matrix: bumps exactly once per switch (asserting `currentId` really moved), does not bump for an unknown id, and still resolves the switch with the counter store rejecting `putIndex` (asserting the `data-version` warn) -- the source scan cannot observe behaviour.
- `src/lib/read-only.ts` -- amend the `wikiSwitch` docblock's "writes ONE file … and nothing else" clause; leave the refusal string byte-identical -- a false comment about the function being changed.
- `src/lib/__tests__/wikis-routes.test.ts` -- amend the same claim in the comment above the `PUT /api/wikis/current` 403 case -- same reason; no assertion changes.

**Acceptance Criteria:**
- Given a tenant with two Wikis and a non-zero `dataVersion`, when `setCurrentWiki` switches to the non-current one, then it resolves with that Wiki's record, `getWikiRegistry(owner).currentId` is that id, and `readDataVersion()` is exactly `before + 1`.
- Given the `dataVersion` guard suite, when `pnpm exec vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` runs, then the writer table names seven functions, the module-wide `await bumpRefreshSignal(` count matches the sum of the per-body counts, and every counted site is asserted to fall after the `withWikiLock` close.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures — in particular the read-only kernel-gate snapshot rows, which must still see zero bytes move on a refused switch.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 0, low 12)
- defer: 0
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[low]` `[patch]` `(DW-429)` already marks the unrelated unconfirmed-write-latch bug in five in-tree files; every marker added by this change was retagged `(DW-518)`, with `(DW-518, implementing DW-429's recorded decision)` on first mention in `setCurrentWiki`'s docblock.
  - `[low]` `[patch]` The guard comment in `workbench-data-version.test.ts` still read "the whole reason the five above are callers"; now seven.
  - `[low]` `[patch]` The same comment's opening ("a module with seven exported writers") collided with the retitled "seven writers"; restated as eight exported writers, seven of which bump (count verified by grep).
  - `[low]` `[patch]` "WHY A HELPER RATHER THAN EIGHT COPIES" enumerated three tickets reaching seven, not eight — `canonicalizeWikiPurpose` carries no ticket marker in-tree, so the per-ticket enumeration was dropped for the total.
  - `[low]` `[patch]` The new fail-soft row sat above the `// The counter store is down` divider and read `BUMP_FAILED_WARN` from below its declaration; moved beside its three siblings.
  - `[low]` `[patch]` The docblock above `BUMP_FAILED_WARN` still said the tail "reads identically at all three call sites" and located the unreachable `catch` in `createWiki`/`applyScenarioTemplate`; corrected to one `catch` in `bumpRefreshSignal` reached through eight call sites across seven writers.
  - `[low]` `[patch]` `does not bump for a switch to an unknown wiki id` claimed `current` never moved without asserting it; now asserts `currentId`.
  - `[low]` `[patch]` The spec matrix's read-only row was only implied by a whole-tree snapshot; `read-only-kernel-gate.test.ts`'s switch case now captures `readDataVersion()` before the refusal and asserts it unchanged.
  - `[low]` `[patch]` A switch to the already-current Wiki still writes and still bumps, costing the acting tab one redundant refresh, and nothing said so; recorded as deliberate in `setCurrentWiki`'s docblock (mirrors `renameWiki` on a same-name rename; the counter is monotonic and consumers forward-only). No short-circuit added — the reviewer's proposed behaviour change was rejected as beyond the intent.
  - `[low]` `[patch]` `DataVersionWatcher.tsx`'s docblock asserted the opposite of the new behaviour ("switch and delete still move nothing" — delete has bumped since DW-382); rewritten, comments only, conclusion kept with the true reason.
  - `[low]` `[patch]` The reflowed read-only-gate comment in `wikis.ts` left an 89-char line among ~78-char neighbours; re-wrapped.
  - `[low]` `[patch]` `bumpRefreshSignal`'s docblock split `{@link applyScenarioTemplate}` across a line break; re-flowed.

Rejected: `dataVersion` being one global rather than tenant-scoped counter (pre-existing and shared by every writer in the module); the rationale being stated in both the docblock and the guard comment (this repo's established convention for that guard); strengthening the DW-21 test to assert the counter moved (duplicates the new row); the absence of a client-side test that a moved counter makes a non-switching tab re-resolve (the intent and the human decision name the kernel tail as the surface, and `DataVersionWatcher` carries its own coverage); and the `dw_ids: DW-429` / open-entry-is-DW-518 bookkeeping mismatch (ledger edits are the orchestrator's, and this run is forbidden them).

## Design Notes

The tail, mirroring `renameWiki`:

```ts
  assertWritable(READ_ONLY_REFUSAL.wikiSwitch);
  const switched = await withWikiLock(owner, async () => {
    /* unchanged body */
  });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (!switched) return null;
  await bumpRefreshSignal(`switching to wiki "${switched.id}"`);
  return switched;
```

Why the old exemption was wrong rather than merely conservative: it reasoned from BYTES ("`wikis.json` is not a file a Preview renders"), but the Workbench resolves artifacts through the `current` pointer, so moving the pointer changes what every artifact read ANSWERS without changing a single artifact byte. "The selection change is its own refresh trigger" holds only in the tab that drove the switcher.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` -- expected: all pass, including the writer-count guard.
- `pnpm exec vitest run --project node src/lib/__tests__/wikis.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/wiki-artifact-revisions.test.ts` -- expected: all pass; the three new switch rows appear.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm test` -- expected: no new failures against the pre-change baseline.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `setCurrentWiki` now carries the same fail-soft `bumpRefreshSignal(...)` tail `renameWiki` and `deleteWiki` carry — outside `wikis:<tenant>`, fired only when the locked body returned a record — reversing the recorded no-bump exemption per the human decision on DW-429/DW-518. The old exemption reasoned from BYTES ("a switch writes no artifact"), but the Workbench resolves artifacts THROUGH the `current` pointer, and the switcher's `router.refresh()` reaches only the tab that drove the switch; another open tab had no way to learn its reads now resolve against a different Wiki.

**Files changed.**
- `src/lib/wikis.ts` — the `setCurrentWiki` tail, its rewritten docblock (why it bumps, outside-the-lock/fail-soft/only-on-a-record, and the deliberate already-current no-op), and `bumpRefreshSignal`'s corrected tally.
- `src/lib/__tests__/workbench-data-version.test.ts` — the source-scan guard that pins WHICH writers bump: title, exemption rationale, call count 7 to 8, writer table, `counted` total.
- `src/lib/__tests__/wikis.test.ts` — three behavioural rows (bumps once per switch, no bump on an unknown id, still resolves with the counter store rejecting) plus a retitled DW-21 case.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` — the refused switch now explicitly asserts the counter did not move.
- `src/components/workbench/DataVersionWatcher.tsx` — docblock only; its claim that a switch and a delete move no `dataVersion` was false.
- `src/lib/read-only.ts`, `src/lib/__tests__/wikis-routes.test.ts` — the "writes ONE file and nothing else" claim, corrected. The refusal string is byte-identical.

**Review findings breakdown.** 12 patches applied (all low severity), 0 deferred, 5 rejected. No intent gap and no spec defect; no review loopback.

**Follow-up review recommendation:** true. Patched severities: high 0, medium 0, low 12. Score = 3 x 0 + 1 x 12 = 12, which is at or above 5.

**Verification performed.**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` — 61/61 passed.
- `pnpm exec vitest run --project node` over `wikis`, `read-only-kernel-gate`, `wikis-routes`, `wiki-schema-edit`, `wiki-artifact-revisions` and `workbench-data-version` — 323/323 passed, 6 files.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm test` — 359 files, 8731 passed / 1 skipped, 0 failures.
- Matrix audit: all four I/O rows are covered by tests that ran and passed — the switch, unknown-id and rejecting-`putIndex` rows in `wikis.test.ts`, and the read-only row in `read-only-kernel-gate.test.ts`.

**Residual risks.**
- The `dataVersion` counter is global rather than tenant-scoped, so one owner's switch moves the number every tenant's Workbench polls. Pre-existing and shared with every other writer in the module; this change adds one more event to it.
- A switch to the Wiki that is already current still writes and still bumps, costing the acting tab one redundant server render on top of `WikiSwitcher`'s own `router.refresh()`. Deliberate and documented; a short-circuit was judged beyond the intent.
- The bundle's `dw_ids` names DW-429, which the ledger shows as done and archived; the open entry directing this kernel tail is DW-518. The ledger was not edited, per the invocation.
