---
title: 'Rename bumps the refresh signal; the orphan sweep is bounded per pass'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      `deleteWiki` removes a Wiki's `purpose.md` and `schema.md` outright and moves no
      `dataVersion`, so a Preview open on those artifacts in a second client keeps rendering
      bytes whose Wiki is gone.
    evidence: |-
      DW-209 established the rule this change generalises: a registry operation that also moves
      bytes a Preview renders must bump, because a non-current Wiki's operations change no
      `currentWikiId` and the Workbench's selection-reset effect never fires. `deleteWiki`
      (src/lib/wikis.ts) meets that description exactly — it deletes the artifact directory —
      and still carries no tail. `WikiSwitcher.tsx` calls `router.refresh()` itself, which
      covers the client that performed the delete but not any other open client.
      Pre-existing; surfaced by generalising the rule, not caused by it.
    location: >-
      src/lib/wikis.ts (deleteWiki)
    severity: medium
  - summary: >-
      A sweep candidate whose age cannot be read is skipped but still consumes one of the
      per-pass cap slots on every pass, so enough of them could starve the tail of the list.
    evidence: |-
      `ORPHAN_SWEEP_CANDIDATE_CAP` truncates the candidate list before `newestWriteTime`, and an
      unreadable age is treated as too young — a deliberate skip that never clears on its own if
      the underlying storage error is permanent. The tombstone half of this shape was closed
      during review (the probe now resolves before the cap); the age half cannot be, because
      reading the age IS the expensive walk the cap exists to bound. Related to DW-290, which
      records the future-mtime variant of the same permanently-unsweepable candidate.
    location: >-
      src/lib/wikis.ts (sweepOrphans / ORPHAN_SWEEP_CANDIDATE_CAP)
    severity: low
baseline_revision: 'f244c8eb440f755d4ac6b0b3c4a3d4e7e3d56e1e'
---

<intent-contract>

## Intent

**Problem:** Two writer-side invariants in `src/lib/wikis.ts` are missing. (DW-209) `renameWiki` rewrites `purpose.md`'s heading through `retitlePurpose` under the tenant lock but moves no `dataVersion`, so a Preview left open on that artifact keeps the old heading until the owner reselects or reloads — and because a rename changes no `currentWikiId`, the Workbench's selection-reset effect does not fire either. (DW-289) `sweepOrphans` builds its candidate list with no cap and then walks, stats and deletes every entry inside `withWikiLock(owner)`, queueing every create, rename and delete for that tenant behind it — unlike every other block in `POST /api/tasks/scan`, which bounds its work (`.slice(0, 25)`, `listDueOutboxEvents(..., 50)`).

**Approach:** Give `renameWiki` the same fail-soft `bumpDataVersion()` tail its siblings at `createWiki` and `applyScenarioTemplate` already have — outside the lock, on the committed path only. Cap the sweep's candidate list to a per-pass bound and log the truncation, so a pass is bounded by the cap rather than by however many orphan directories exist, and the next cron tick picks up the remainder.

## Boundaries & Constraints

**Always:**
- The bump fires OUTSIDE `withWikiLock`: `bumpDataVersion` takes `DATA_VERSION_LOCK` and `withFileLock` is not reentrant, so nesting them would introduce a lock ordering nothing else in the repo uses.
- The bump is fail-soft (`try`/`catch` + `logger.warn`) and fires ONLY when the locked body returned a record. An unknown id (`null`) and a rejected name (throws before the lock) must leave the counter untouched.
- The sweep's cap is applied to the CANDIDATE list, before any `newestWriteTime` walk, tombstone probe or `deleteDirectory` — capping the removals instead would leave the unbounded walk in place.
- Truncation is reported through `logger.warn` naming how many candidates were deferred. The sweep's return value stays `Promise<number>` = directories removed; `sweepOrphanWikiDirs` and `orphanWikiDirsRemoved` in the scan route are unchanged.
- Every existing sweep guard survives untouched: the grace window, unknown-age skip, empty-registry/tombstone rule, and per-candidate fail-soft catches.

**Block If:** `pnpm test` reveals a pin on the three-bump count in `src/lib/wikis.ts` that cannot be updated to four without changing behaviour elsewhere.

**Never:** Do not change `renameWiki`'s return type, `retitlePurpose`'s fail-soft contract, or the read-only gate ordering. Do not add a second lock key to either path. Do not make the sweep persist a cursor or any resume state. Do not touch `deleteWiki`, `setCurrentWiki` or `seedWikiArtifacts` — they still write nothing a Preview renders. Do not remove `WikiSwitcher.tsx`'s own `router.refresh()`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rename commits | Known id, valid name | Registry name + `updatedAt` move, `purpose.md` heading retitled, `dataVersion` +1 | No error expected |
| Rename, unknown id | Id absent from registry | Returns `null`, writes nothing, `dataVersion` unchanged | No error expected |
| Rename, rejected name | Blank / non-string / >80 chars | Throws `ClientInputError` before the lock, `dataVersion` unchanged | Throws to caller |
| Retitle fails, rename stands | `writeFile` rejects for `purpose.md` | Rename returns the record, heading stays stale, `dataVersion` still +1 | Warned inside `retitlePurpose` |
| Bump fails | Counter store unavailable | Rename still returns the record | `logger.warn`, swallowed |
| Sweep at or under the cap | ≤ cap candidates | Unchanged behaviour: every candidate considered, aged orphans removed | Per-candidate fail-soft |
| Sweep over the cap | > cap candidates | Only the first `cap` are walked/removed; a warn names how many were deferred; count returned reflects only what this pass removed | Next scheduled pass continues |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1296-1325` — `renameWiki`. Currently `return withWikiLock(owner, async () => {...})`. Needs the `createWiki` shape (`src/lib/wikis.ts:1044-1097`): capture the result, `if (!renamed) return null;`, then the fail-soft bump, then return. `applyScenarioTemplate:1129-1188` is the second copy of that tail.
- `src/lib/wikis.ts:1228-1258` — `retitlePurpose` docblock. Its "NO `dataVersion` BUMP EITHER … logged as DW-209" paragraph becomes false; the reason it is not `writeWikiArtifact` (deadlock + a wrong activity-log line) stays true.
- `src/lib/wikis.ts:1342` — `ORPHAN_SWEEP_GRACE_MS`; the new cap constant belongs beside it, exported for the test.
- `src/lib/wikis.ts:1432-1505` — `sweepOrphans`. `candidates` is built at :1435-1439; the `tombstonedOnly` warn at :1440 and the `for (const name of candidates)` walk at :1452 follow it.
- `src/app/api/tasks/scan/route.ts:90,146,165-172` — the bounded siblings (`slice(0, 25)`, `listDueOutboxEvents(..., 50)`) and the sweep's only scheduled call site; read-only reference, no edit.
- `src/components/workbench/DataVersionWatcher.tsx:17-31` — comment names rename as the remaining DW-209 gap; must move to the create/re-template exception paragraph.
- `src/lib/__tests__/workbench-data-version.test.ts:703-820` — two pins: the file-granular allowlist (unchanged) and "has exactly three sites inside wikis.ts, each outside the tenant lock", which becomes four and adds `renameWiki` to the `bodyOf` loop and to the comment's roster.
- `src/lib/__tests__/wikis.test.ts:344-420` — the DW-49 bump describe block; the rename rows belong in the same shape (every row starts from a non-zero counter). `:838-950` rename tests, `:1041+` sweep tests with `plantOrphan`/`ageDirectory` helpers.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- add the fail-soft `bumpDataVersion()` tail to `renameWiki` after the lock, on the committed path only -- so a Preview open on `purpose.md` is told its heading moved (DW-209).
- `src/lib/wikis.ts` -- export a per-pass candidate cap beside `ORPHAN_SWEEP_GRACE_MS` and apply it in `sweepOrphans` before the walk, warning when candidates are deferred -- so one cron tick cannot hold the tenant lock across an unbounded walk (DW-289).
- `src/lib/wikis.ts` -- update `retitlePurpose`'s docblock and `renameWiki`'s own so neither still describes rename as bump-less; document the cap's rationale and its residual (a repeatedly-skipped candidate keeps occupying a slot) on the sweep.
- `src/components/workbench/DataVersionWatcher.tsx` -- comment only: rename joins create and re-template as a registry operation that also reaches this watcher.
- `src/lib/__tests__/wikis.test.ts` -- add executed rows for the I/O Matrix: rename bumps once, unknown id and rejected name do not, a failed retitle still bumps, a failed bump still returns the record; and a sweep planted with more than the cap removes exactly the cap in one pass and the remainder on the next.
- `src/lib/__tests__/workbench-data-version.test.ts` -- update the wikis.ts bump-site pin from three to four, adding `renameWiki` to the asserted bodies and correcting the roster comment.

**Acceptance Criteria:**
- Given a Preview open on a Wiki's `purpose.md`, when that Wiki is renamed, then `dataVersion` moves forward exactly once so the watcher refetches.
- Given a rename that writes nothing (unknown id, or a name the parser rejects), when it returns or throws, then `dataVersion` is unchanged.
- Given a tenant with more orphan candidates than the cap, when one sweep pass runs, then it considers at most `cap` candidates, logs how many were deferred, and a subsequent pass reclaims the rest.
- Given `pnpm test` and `pnpm lint`, when run after the change, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 2: (high 0, medium 1, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` Both cap tests planted only AGED orphans, so "walked" and "removed" coincided and a mutation replacing the candidate slice with `if (removed >= CAP) break;` — the unbounded in-lock walk DW-289 was filed against — passed the whole suite. Added a test that plants `CAP + 3` YOUNG orphans and counts the per-candidate grace-window `logger.info` lines, asserting `removed === 0` with exactly `CAP` probes; mutation-verified to fail under the removal-cap shape.
  - `[low]` `[patch]` The cap sat above the tombstone filter, so in `tombstonedOnly` mode untombstoned directories — which are skipped on every pass forever — consumed slots and could permanently starve a tombstoned DW-162 directory sorting after them. The probe now resolves over the full candidate list before the cap (a single `fileExists` each, unlike the recursive age walk the cap exists to bound); new test pins reclamation from position 26 of 26 against an empty registry.
  - `[low]` `[patch]` `sweepOrphans`' docblock claimed the cap bounds "the walk this function performs" — false for the `listFiles` enumeration, which still lists every entry under `wikis/` inside the lock. Narrowed to the per-candidate walk and stated the enumeration explicitly.
  - `[low]` `[patch]` The cap constant justified 25 as "the dominant bound in the scan route"; the route's three bounds are 10, 25 and 50. Reworded to name all three and justify 25 among them.
  - `[low]` `[patch]` `deleteWiki`'s docblock said leftovers are "exactly what the sweep reclaims on the next delete", now true only up to the cap on a user-facing request path. Qualified.
  - `[low]` `[patch]` The bump-site pin's rewritten roster claimed the absent functions "write nothing a Preview renders", which is false for `putWikiArtifact`, `seedWikiArtifacts` and `retitlePurpose` (their callers carry the tail) and for the two that delete such bytes. Split into the three real groups.
  - `[low]` `[patch]` Test name `warns about no truncation when …` asserted the absence of a warn; renamed to say so.
  - `[low]` `[patch]` Two Code Map anchors were wrong against `baseline_revision`; corrected to `renameWiki` 1296-1325 and `ORPHAN_SWEEP_GRACE_MS` 1342.

## Design Notes

The rename tail is a third copy of one shape already in this file, so copy it rather than invent one:

```ts
const renamed = await withWikiLock(owner, async () => { /* unchanged body */ });
if (!renamed) return null;             // nothing was written — nothing to refresh to
try {
  await bumpDataVersion();
} catch (error) {
  logger.warn("wikis", `the refresh signal did not move after renaming wiki "${renamed.id}"`, error);
}
return renamed;
```

It bumps even when `retitlePurpose` failed: the registry name has moved, and that name is what the switcher and the Workbench heading render, so there is genuinely something new to refetch.

The cap is a cost and blast-radius bound in the same spirit as `DEFAULT_MAINTENANCE_CAP`, not a correctness guard — orphans are rare and bounded in practice by `MAX_WIKIS` (100). 25 matches the dominant bound in the scan route. Continuation needs no cursor because removal is the progress: reclaimed directories are gone from the next pass's listing. The residual worth documenting is that a candidate which is repeatedly SKIPPED (too young, unreadable age, untombstoned) keeps occupying a slot every pass, so a large enough set of permanently-skipped candidates could starve the tail of the list.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/scan-route.test.ts` -- expected: all pass, including the new rename-bump and sweep-cap rows
- `pnpm test` -- expected: no new failures anywhere in the suite
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** Two writer-side invariants in `src/lib/wikis.ts`. (DW-209) `renameWiki` now carries the same fail-soft `bumpDataVersion()` tail `createWiki` and `applyScenarioTemplate` have: outside `withWikiLock`, on the committed path only, so a Preview left open on a renamed Wiki's `purpose.md` is told its heading moved. (DW-289) `sweepOrphans` caps its candidate list at the new exported `ORPHAN_SWEEP_CANDIDATE_CAP = 25` before any age walk or delete, warning how many candidates were deferred; in the empty-registry mode the tombstone probe resolves before the cap so a permanently-skipped directory cannot occupy a slot.

**Files changed.**
- `../../src/lib/wikis.ts` — the rename tail, the cap constant and its application in `sweepOrphans`, and the docblocks for `renameWiki`, `retitlePurpose`, `sweepOrphans` and `deleteWiki`.
- `../../src/components/workbench/DataVersionWatcher.tsx` — comment only: rename joins create and re-template as a registry operation that reaches this watcher.
- `../../src/lib/__tests__/wikis.test.ts` — five rename-bump rows and four sweep-cap rows (over cap, exactly at cap, probe-count bound, tombstoned-past-the-cap).
- `../../src/lib/__tests__/workbench-data-version.test.ts` — the wikis.ts bump-site pin goes three → four with `renameWiki` added to the asserted bodies.

**Review findings.** 8 patches applied (1 medium, 7 low), 2 items deferred (1 medium, 1 low), 11 rejected. No intent gaps and no spec repairs; `review_loop_iteration` stayed 0.

**Follow-up review recommendation:** true. Patched findings this pass: high 0, medium 1, low 7 → score 3×1 + 1×7 = 10, which is ≥ 5.

**Verification.**
- `npx vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/scan-route.test.ts` — 171 passed.
- `npx vitest run` (the `pnpm test` script; `pnpm` itself fails in this sandbox with "packages field missing or empty" regardless of the change) — 264 files, 5844 passed, no new failures.
- `npx eslint` — exit 0. `npx tsc --noEmit` — exit 0.
- Every I/O Matrix row is covered by a named test that ran and passed. Two mutation checks were performed and reverted: neutering the bump body and the candidate slice failed exactly the intended rows, and the removal-cap shape failed only the new probe-count test.

**Residual risks.**
- A candidate whose age cannot be read is skipped yet still consumes a cap slot each pass; the tombstone half of that shape was closed during review, the age half cannot be because reading the age is the walk the cap bounds. Recorded in frontmatter `deferred`.
- The cap bounds the per-candidate walk, not the `listFiles` enumeration, which still lists every entry under `wikis/` inside the lock. Documented at the constant.
- `deleteWiki`'s inline sweep now carries the same per-pass bound, so a delete reclaims at most 25 leftovers and the rest wait for a cron tick or a later delete.
- Nothing new executes the render chain (watcher → route → Preview effect) with a rename in the loop; the rename's link is pinned at the store surface, and the chain itself is covered by the pre-existing create/re-template rows.
