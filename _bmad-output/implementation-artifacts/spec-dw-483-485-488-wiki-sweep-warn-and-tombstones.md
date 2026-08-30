---
title: 'Orphan-sweep warn dedupe, pinned cap-row clock, and the recorded tombstone residual'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `newestWriteTime` guards its mtime with `Number.isFinite` but not against
      `Date`'s +/-8.64e15 ms range, so a wild provider mtime turns the
      future-dated log line into a `RangeError` that aborts the whole sweep pass.
    evidence: |-
      `newestWriteTime` accepts any finite number (src/lib/wikis.ts:1592, :1601),
      and the future-dated branch formats it with `new Date(newest).toISOString()`
      (src/lib/wikis.ts:1688), which throws `RangeError: Invalid time value`
      outside that range. The throw escapes `sweepOrphans` — every other
      per-candidate step in that loop is deliberately fail-soft — and
      `sweepOrphanWikiDirs` swallows it as "removed 0", so a single bogus mtime
      silently stops the tenant's reclaim on every pass. Pre-existing: the same
      expression shipped with DW-290; this change only moved it into a helper.
    location: >-
      src/lib/wikis.ts:1688
    severity: low
baseline_revision: '868d2009db0103734159db88dd7e075f560ba7cb'
---

<intent-contract>

## Intent

**Problem:** Three tails of the orphan sweep. (DW-483) The DW-290 future-dated-mtime warn is emitted per candidate per pass against a condition that cannot self-clear, so one restored archive repeats the same sentence every cron tick for however long the wall clock needs to catch up — the exact noise the neighbouring `tombstonedOnly` comment argues against. (DW-485) The DW-289 cap rows plant `cap + OVERFLOW` orphans against the real system clock, so which UTC-day window `rotatingSweepWindow` hands the pass depends on the date the suite runs. (DW-488) `clearStaleDiscardTombstones` runs only on the scheduled path, which resolves a single owner, so a tenant created before the DW-159 creation gate has no clearer for its stale discard markers at all — a second residual the DW-288 SCOPE note in `maintenance.ts` never records, since it accounts only for the orphan directories.

**Approach:** Give the future-dated warn the module's established warn-once shape — a module-level record keyed on the directory AND the future date it names, re-armed when a later pass sees that directory is no longer ahead of the horizon — plus an `@internal` reset the suite calls in `beforeEach`. Pin `Date` on the two DW-289 rows that plant more than the cap, using the `vi.useFakeTimers({ toFake: ["Date"] })` recipe the DW-383 rotation rows already use. Record the tombstone residual in the SCOPE docblock rather than clearing markers inline, because the inline sweep is a user-facing request under `wikis:<tenant>` and DW-291 already settled that it must not pay the per-claimed-directory probe.

## Boundaries & Constraints

**Always:** Keep the future-dated warn's sentence byte-identical — existing rows match on its substrings. Keep the warn LEVEL and the skip behaviour: an untrusted age still never authorises a delete. Unreadable age (`null`) remains not-evidence: it neither warns nor re-arms. Bound the dedupe record by directory, not by observation, so a churning mtime cannot grow it without limit. Follow the existing `warnOnceAbout` / `_resetConfigWarnings` shape in `src/lib/config.ts` and `src/lib/embeddings.ts`. Pin the clock with `toFake: ["Date"]` only, so the file lock's real `setTimeout` waits are untouched.

**Block If:** The pinned-clock recipe cannot keep a DW-289 row green without changing what that row asserts (its counts, its cap boundary, or which log line it observes).

**Never:** Do not dedupe the grace-window INFO line — it is the benign self-clearing case and a cap row counts one per candidate reached. Do not clear discard tombstones on `deleteWiki`'s inline path. Do not widen the sweep past the configured owner, and do not build a Wiki-tenant enumeration index. Do not pin the clock for the whole `describe`, or for the rows whose candidate list is at or under the cap (`rotatingSweepWindow` returns those unchanged on any date). Do not change `SweepOrphansOptions`, the return contract, or the cap/grace/rotation constants.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Repeat pass, same future date | One orphan dated past the horizon; three scheduled passes | The future-dated WARN is emitted exactly once across all three; the directory survives every pass | No error expected |
| Future date moves further out | Warned already, then the directory's newest write is re-dated to a different future instant | Warns a second time, naming the new date | No error expected |
| Skew ends, then returns | Warned, then a pass sees the directory inside the grace window, then it is future-dated again | The middle pass logs the INFO line and no warn; the third pass warns again | No error expected |
| Unreadable age between passes | Warned, then `newestWriteTime` returns `null` | No warn and no re-arm — the record is left exactly as it was | `newestWriteTime` already warns about the unreadable age |
| Two directories both future-dated | Two future-dated orphans in one pass | Both warn — the record is per directory, not per pass | No error expected |

</intent-contract>

## Code Map

- `src/lib/wikis.ts` -- the whole change surface for DW-483. `sweepOrphans` (~L1683) is the pass; the future-dated branch is inside the candidate loop at ~L1786 (`newest !== null && newest > horizon`), guarded by `horizon = now + ORPHAN_SWEEP_GRACE_MS` at ~L1777. `newestWriteTime` (~L1575) returns a stable file mtime or `null` (already warning on `null`). Put the new record + emitter + `@internal` reset next to `sweepOrphans`, mirroring `warnOnceAbout` in `src/lib/config.ts` L482-L488 and `src/lib/embeddings.ts` L155-L163 (module-level collection, one emitter, one reset — `_resetConfigWarnings` at `config.ts` L498 is the export shape to copy). `sweepOrphanWikiDirectories` (~L1943) is the scheduled entry point; `clearStaleDiscardTombstones` (~L1888) is scheduled-only by design — read its SCHEDULED SWEEPS ONLY and THE RESIDUAL paragraphs before touching anything near DW-488.
- `src/lib/maintenance.ts` -- `sweepOrphanWikiDirs` at L342, with the DW-288 SCOPE docblock immediately above it (L302-L341). Its last residual sentence ("The one honest residual today is tenants created BEFORE that gate landed…") covers orphan directories only; the tombstone residual goes beside it.
- `src/lib/__tests__/wikis.test.ts` -- `describe("the orphan-directory sweep")` at L1229. DW-289 rows to pin: L1512 (`considers at most the per-pass cap…`, plants `cap + 3` aged) and L1593 (`probes at most the cap candidates…`, plants `cap + 3` young). Leave L1563 (`…exactly at the cap`) and L1640 (tombstoned-past-the-cap, eligible list of 1) on the real clock. Copy the pinning recipe verbatim from L1849-L1890 (`vi.useFakeTimers({ toFake: ["Date"] })`, `const day0 = Date.UTC(…)`, `vi.useRealTimers()` in `finally`) — note it starts the fake clock BEFORE planting so `ageDirectory` and the sweep read the same clock. Helpers: `plantOrphan` L1230, `ageDirectory` L924 (negative `ageMs` = a future date). DW-290 rows at L1718 and L1767 must stay green. `beforeEach` at L66 is where the new reset is wired, beside `_resetLocks()` / `_resetStorage()`. Import block at L24-L44.
- `src/lib/__tests__/maintenance.test.ts` -- `describe("sweepOrphanWikiDirs …")` at L389 is where the DW-488 docblock assertion goes. The source-text assertion recipe is `src/lib/__tests__/read-only-kernel-gate.test.ts` L679-L690 (`fs.readFile(path.resolve(__dirname, "../<mod>.ts"), "utf8")`).
- Read-only evidence: the inline-vs-scheduled tombstone behaviour DW-488 documents is ALREADY pinned by `wikis.test.ts` L2000 (`leaves the marker alone on the sweep that runs inside a delete`) — DW-488's gap is only that the SCOPE note does not record it. Do not add a second behavioural row for it.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- add a module-level record of future-dated directories already reported (keyed per `owner`/directory, holding the future instant that was named), one emitter that logs the existing sentence only when that directory has no record or its record names a different instant, and one `@internal` `_resetWikiSweepWarnings()` export that clears it; call the emitter from the `newest > horizon` branch in `sweepOrphans` -- so standing state is said once per fact instead of once per pass (DW-483).
- `src/lib/wikis.ts` -- re-arm inside the candidate loop when `newest !== null && newest <= horizon`, before the age gate, and docblock why `null` is excluded -- the skew provably ended, and it ended whether the directory then aged out or is merely young; unreadable is not evidence of it ending.
- `src/lib/maintenance.ts` -- extend the DW-288 SCOPE docblock on `sweepOrphanWikiDirs` with the SECOND residual: on a pre-gate non-owner tenant a stale `.discarded` marker has no clearer at all, because `clearStaleDiscardTombstones` is scheduled-only (DW-291) and the schedule resolves one owner, whereas the orphan directories are at least reclaimed by `deleteWiki`'s inline sweep. Say it is accepted rather than fixed, and name the same widen-trigger the note already carries -- DW-488 is a documentation gap, not a behaviour gap.
- `src/lib/__tests__/wikis.test.ts` -- wire `_resetWikiSweepWarnings()` into the top-level `beforeEach`; pin `Date` on the two DW-289 overflow rows; in the young-candidate row replace "deliberately not aged" with an age INSIDE the grace window measured against the pinned clock, since a real-clock mtime read against a pinned `now` would land past the horizon and take the future-dated branch instead of the grace-window one -- keep both rows' assertions unchanged otherwise (DW-485).
- `src/lib/__tests__/wikis.test.ts` -- add rows for the I/O matrix scenarios: repeat passes emit one warn, a moved future date speaks again, a pass inside the grace window re-arms, an unreadable age neither warns nor re-arms, and two future-dated directories both warn.
- `src/lib/__tests__/maintenance.test.ts` -- add a row asserting the `sweepOrphanWikiDirs` docblock records the tombstone residual, reading `../maintenance.ts` as text -- the note is the deliverable, so it is what the row observes.

**Acceptance Criteria:**
- Given a future-dated orphan already reported in an earlier pass, when a later pass reaches it again with the same newest write, then no further warn is emitted and the directory is still skipped rather than removed.
- Given a scheduled sweep whose candidate list holds two directories dated past the horizon, when the pass runs, then each one is named in its own warn.
- Given the suite is run on any calendar date, when the two DW-289 overflow rows execute, then their per-pass window is fixed by the pinned clock and their existing count, survivor and deferral assertions all hold.
- Given the DW-290 and DW-291 rows already in `wikis.test.ts`, when the change lands, then every one of them still passes unmodified.
- Given a reader of `sweepOrphanWikiDirs`, when they read its SCOPE docblock, then it records the stale-tombstone residual on pre-gate non-owner tenants as accepted, distinctly from the orphan-directory residual it already records.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 0, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[low]` `[patch]` `reportedFutureDatedWrites` never evicted a key for a directory that stopped being an orphan (deleted out of band, or re-claimed by a restored `wikis.json`), so its "bounded by the tenant's directory count" claim was false — added `pruneFutureDatedWarnings(owner, found)` on both sweep paths, corrected the docblock, and committed a row that fails without the prune.
  - `[low]` `[patch]` The docblock promised "once, ever" from module state that is per-isolate — added the ONCE MEANS ONCE PER ISOLATE paragraph naming the same bound `config.ts` and `embeddings.ts` accept.
  - `[low]` `[patch]` Nothing pinned that the record is deliberately SHARED with `deleteWiki`'s inline sweep (the only path reaching pre-gate non-owner tenants, so gating on `scheduled` would silence them) — added a row asserting the inline sweep says it once and the scheduled pass behind it does not repeat.
  - `[low]` `[patch]` The re-arm's placement before the age gate was justified for both branches but only the young one was tested — added a row covering the pass that RECLAIMS the directory.
  - `[low]` `[patch]` The five new DW-483 rows name specific directory ids on the real clock, which is DW-485's own hazard; they are safe only while planting fewer than the cap — recorded that constraint on the section header.
  - `[low]` `[patch]` The DW-488 docblock row failed open: a renamed end anchor made `indexOf` return -1 and `slice(start, -1)` match nearly the whole module — both anchors are now asserted, and the semantic checks are scoped to the new paragraph rather than the whole SCOPE block.
  - `[low]` `[patch]` `clearStaleDiscardTombstones` documented a different residual and had no pointer to the one now recorded against it — added a back-pointer naming DW-488 and `sweepOrphanWikiDirs`.
  - `[low]` `[patch]` `stampDirectory`'s docblock understated the bug it fixed (the old `ageDirectory` re-read `Date.now()` at every level of its own recursion, so one call left a nested tree holding several instants), and `ageDirectory`'s load-bearing negative-`ageMs` convention was undocumented — both corrected.

## Design Notes

The dedupe record is a `Map` from `${owner}/${name}` to the future instant that was reported, not a `Set` of observations: keying on the instant alone would let a directory whose mtime churns grow the collection without bound, while dropping the instant from the key would leave the operator holding a date that has since moved. `config.ts`'s docblock states the rule this follows — the key is the identity AND the value, because the sentence names the value.

```ts
const reportedFutureDatedWrites = new Map<string, number>();

function warnOnceAboutFutureDatedWrite(owner: string, name: string, newest: number): void {
  const key = `${owner}/${name}`;
  if (reportedFutureDatedWrites.get(key) === newest) return;
  reportedFutureDatedWrites.set(key, newest);
  logger.warn("wikis", /* the existing sentence, unchanged */);
}
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/maintenance.test.ts` -- expected: all rows pass, including the untouched DW-290, DW-291 and DW-383 rows.
- `pnpm vitest run src/lib/__tests__/wikis.test.ts -t "orphan-directory sweep"` -- expected: green; run it twice to confirm nothing leaks between passes via the new module-level record.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit` -- expected: no new type errors.

## Auto Run Result

Status: done

**Implemented change.** Three tails of the orphan-directory sweep. DW-483: the future-dated-mtime skip is now said once per fact rather than once per pass — a module-level `Map` keyed `${owner}/${name}` holding the instant that was reported, re-armed when a later pass reads an age at or inside the horizon, pruned each pass against the current orphan list, and reset in tests through a new `@internal` `_resetWikiSweepWarnings()`. The sentence, the WARN level and the skip itself are unchanged: dedupe changes what is said, never what is done. DW-485: `Date` is pinned on the two DW-289 rows that plant more than the cap, so which UTC-day window `rotatingSweepWindow` hands the pass no longer depends on the run date. DW-488: the stale-tombstone residual on pre-gate non-owner tenants is recorded in the DW-288 SCOPE docblock as accepted — the behavioural alternative was rejected because DW-291 already settled that `deleteWiki`'s inline sweep must not pay a probe per registry-claimed directory under `wikis:<tenant>`.

**Files changed.**
- `src/lib/wikis.ts` -- warn-once record, emitter, re-arm, prune and `_resetWikiSweepWarnings`; the future-dated branch now routes through the emitter; back-pointer from `clearStaleDiscardTombstones` to the DW-488 residual.
- `src/lib/maintenance.ts` -- the SECOND RESIDUAL paragraph in the `sweepOrphanWikiDirs` SCOPE docblock. Documentation only, no behaviour change.
- `src/lib/__tests__/wikis.test.ts` -- `_resetWikiSweepWarnings` in `beforeEach`; `stampDirectory` extracted from `ageDirectory`; the two DW-289 overflow rows pinned; eight new DW-483 rows.
- `src/lib/__tests__/maintenance.test.ts` -- one row asserting the SCOPE docblock records the tombstone residual distinctly from the orphan-directory one.

**Review findings.** 8 patches applied (all low), 1 deferred (low — a `RangeError` reachable from an out-of-range provider mtime, pre-existing since DW-290), 12 rejected. No intent gaps and no spec repairs.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 0, low 8. Score = 3x0 + 1x8 = 8, which is at or above 5.

**Verification.**
- `npx vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/maintenance.test.ts` -- 128 passed. Every pre-existing DW-289, DW-290, DW-291 and DW-383 row passes unmodified.
- `npx vitest run src/lib/__tests__/wikis.test.ts -t "orphan-directory sweep"` run twice -- 35 passed both times, so the new module-level record leaks nothing between passes.
- `npx tsc --noEmit` -- exit 0. `pnpm lint` -- no errors (three pre-existing `jsx-ast-utils` notices only).
- Matrix audit: all five I/O rows are covered by rows that ran and passed -- `says a standing future-dated write once, not once per pass`, `speaks again when the future date moves further out`, `re-arms once a pass sees the directory back inside the grace window`, `neither warns nor re-arms on an age it could not read`, `names each future-dated directory, not just the first one in the pass`.
- Mutation-checked: removing the dedupe guard, the re-arm, the prune, or the intervening absent-directory pass each fails exactly the row that claims it.

**Residual risks.**
- The dedupe is per-isolate. On a deployment that recycles the isolate between cron ticks the standing fact is said again after each recycle — documented in the record's docblock rather than solved, since persisting log bookkeeping to storage costs more than the noise it removes.
- The DW-488 row asserts prose. A meaning-preserving reword of the SCOPE paragraph fails it, and if the residual is ever actually closed on the inline path the note becomes false while the row stays green.
- The five real-clock DW-483 rows stay calendar-safe only while they plant fewer than `ORPHAN_SWEEP_CANDIDATE_CAP` directories; the section header records that constraint, but nothing enforces it.
