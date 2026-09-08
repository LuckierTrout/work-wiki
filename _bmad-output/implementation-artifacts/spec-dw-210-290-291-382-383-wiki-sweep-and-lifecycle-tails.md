---
title: 'Wiki orphan sweep and lifecycle tails: nothing leaks silently'
type: 'bugfix'
created: '2026-08-27'
status: done
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The DW-290 future-dated-mtime warn fires on every sweep pass for as long as the
      clock has not caught up, with no dedupe or rate limit.
    evidence: |-
      A future-dated directory stays a candidate on every pass, so the new warn repeats
      indefinitely — potentially for months after a restored archive. This is the same
      noise pattern the neighbouring `tombstonedOnly` comment in `sweepOrphans` argues
      against ("warning about it every few minutes would train the operator to ignore
      the line that matters"). Not caused by the escalation itself, which is correct;
      caused by pairing a per-pass warn with a condition that cannot clear on its own.
    location: >-
      src/lib/wikis.ts (sweepOrphans, future-dated skip branch)
    severity: low
  - summary: >-
      A registry write that reports failure after its bytes actually landed leaves the
      registry on the new scenario and the artifacts on the old, with a "clean" rollback
      and therefore no bump.
    evidence: |-
      `applyScenarioTemplate` decides to bump from `restoreSeededFiles`'s completeness
      alone. If `writeRegistry` throws after the store accepted the bytes, every restore
      succeeds, `rollbackIncomplete` is false, and no bump fires -- yet the registry now
      names a scenario the artifacts do not describe. Detecting it needs a registry
      read-back on the failure path, which neither DW-210 nor this spec's matrix asks
      for. Same family as the DW-291 "landed but reported failure" shape.
    location: >-
      src/lib/wikis.ts (applyScenarioTemplate failure path)
    severity: low
  - summary: >-
      The pre-existing DW-289 cap rows became calendar-dependent when the per-pass window
      started rotating on a UTC-day clock.
    evidence: |-
      Those rows plant `cap + OVERFLOW` orphans against the real system clock, so WHICH
      window a pass takes now varies with the date the suite runs. They pass on any date
      today because every assertion is a count or spans all planted directories, but any
      future row in that `describe` that names a specific directory would be flaky by
      calendar. Pinning the clock for the whole `describe` is its own piece of work --
      the block has ~20 rows that depend on real time for `ageDirectory` and the file
      lock's waits.
    location: >-
      src/lib/__tests__/wikis.test.ts (the orphan-directory sweep, DW-289 cap rows)
    severity: low
baseline_revision: 'f771e9db06c1b13d085276cada946d48a43209ee'
---

<intent-contract>

## Intent

**Problem:** Five tails in `src/lib/wikis.ts` leak quietly. `sweepOrphans` skips any candidate whose newest write is in the future (clock skew, restored archive) forever at `logger.info` (DW-290); its per-pass cap always truncates the SAME head of the candidate list, so permanently-skipped candidates starve the tail (DW-383); `discardCreatedWikiDirectory`'s `.discarded` tombstone is never cleared once the registry does name the id (DW-291); `deleteWiki` moves artifact bytes with no `bumpDataVersion` tail, so another client's open Preview keeps rendering a deleted Wiki (DW-382); and `applyScenarioTemplate`'s failure path re-throws after a `restoreSeededFiles` compensation that warns-and-swallows per entry, leaving changed bytes with no bump at all (DW-210).

**Approach:** Keep every existing safety rule (never delete on an unreadable or unverifiable age; fail-soft compensation) and change only what is observable: escalate the future-dated skip to `warn`, rotate the per-pass candidate window on a **UTC-day** clock after a **stable id sort** so no candidate is starved no matter how often the caller samples the clock, clear a stale tombstone from a registry-claimed directory on scheduled sweeps, give `deleteWiki` the same fail-soft bump tail its siblings carry, and let an incomplete restore report itself so `applyScenarioTemplate` bumps before re-throwing.

## Boundaries & Constraints

**Always:**
- `bumpDataVersion()` runs OUTSIDE `withWikiLock` (it takes `DATA_VERSION_LOCK`; `withFileLock` is not reentrant) and is fail-soft — a failed bump never turns a landed write into a reported failure.
- A directory is removed only when its age is READ and is older than `ORPHAN_SWEEP_GRACE_MS`. Unknown age and future-dated age both still SKIP.
- Every per-candidate failure stays per-candidate: one bad directory never aborts a pass, and the sweep never fails the `deleteWiki` it runs inside.
- Per-pass work under `wikis:<tenant>` stays bounded by `ORPHAN_SWEEP_CANDIDATE_CAP`; the tombstone reclaim adds no cost to the user-facing `deleteWiki` path.
- Eligible orphan ids and claimed-directory ids are sorted stably by id before the window is taken, so coverage does not depend on `listFiles` order.
- The rotation clock is one UTC day (`Math.floor(now / 86_400_000)`), not `ORPHAN_SWEEP_GRACE_MS`. Grace stays only the delete-age gate and the forward-skew tolerance.
- `restoreSeededFiles` still NEVER THROWS and still attempts every entry independently.

**Block If:** A change would require deleting bytes on an age that could not be verified, or persisting sweep cursor state.

**Never:** Do not raise/lower `ORPHAN_SWEEP_GRACE_MS` or `ORPHAN_SWEEP_CANDIDATE_CAP`. Do not use `ORPHAN_SWEEP_GRACE_MS` as the rotation bucket width. Do not persist a sweep cursor. Do not parse or import the cron schedule. Do not make `deleteWiki`'s byte-removal steps fail-hard. Do not touch `WIKI_DISCARD_TOMBSTONE`'s write site semantics in `discardCreatedWikiDirectory`. Do not re-point `currentId`. No new exported symbols beyond what tests need.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Future-dated orphan | aged orphan whose newest write is > now + grace | Not removed; ONE `logger.warn` naming the future date and that the bytes stay until the clock passes it | No throw; pass continues |
| Ordinary young orphan | newest write within grace (including small forward skew ≤ grace) | Not removed; `logger.info` as today | No throw |
| Starved tail | more eligible candidates than the cap, head permanently unsweepable | After a stable id sort, the considered window ROTATES by the cap once per UTC day, so every candidate is eventually considered by the daily scheduled sweep (and by any caller that runs at least once a day). Two calls inside the same UTC day see the same window. | Truncation `warn` still names the deferred count |
| Stale tombstone | scheduled sweep; `wikis/<id>/.discarded` exists and the registry NAMES `<id>` | Tombstone deleted; `logger.warn` records the clear; directory untouched | Probe/delete failure warns per directory, pass continues |
| Tombstone on delete path | `deleteWiki`'s inline sweep | No claimed-directory probing at all | n/a |
| Delete a Wiki | known, non-current id | Registry entry + directory removed AND `dataVersion` bumped exactly once | Bump failure warns; delete still reports success |
| Delete unknown/current id | unknown id → null; current id → `ClientInputError` | No bump | Error propagates unchanged |
| Re-template restore fails | seed/registry write throws AND ≥1 entry of `restoreSeededFiles` fails | `dataVersion` bumped once, THEN the original error re-thrown | Bump failure warns; original error still re-thrown |
| Re-template restore clean | seed/registry write throws, restore fully succeeds | NO bump; original error re-thrown | Unchanged |

</intent-contract>

## Code Map

- `src/lib/wikis.ts` -- the only file that changes.
  - `:61` `import { bumpDataVersion } from "./data-version"` -- already present.
  - `:535-570` `restoreSeededFiles(snapshot): Promise<void>` -- per-entry try/catch that warns; the only caller is `applyScenarioTemplate`'s catch at `:1175`. Change signature to report completeness.
  - `:683-686` `WIKI_DISCARD_TOMBSTONE = ".discarded"` + `wikiDiscardTombstonePath(owner, id)` -- reuse both; do NOT re-spell the literal.
  - `:706-748` `discardCreatedWikiDirectory` -- the ONLY writer of the tombstone. Unchanged.
  - `:1001-1009`, `:1094-1101`, `:1190-1197`, `:1353-1360` -- four identical fail-soft `bumpDataVersion` tails (`writeWikiArtifact`, `createWiki`, `applyScenarioTemplate`, `renameWiki`). Warn text is `the refresh signal did not move after <phrase>` in every one; no test asserts these strings (`grep "refresh signal did not move" src/`).
  - `:1134-1198` `applyScenarioTemplate` -- `withWikiLock` callback whose catch calls `restoreSeededFiles(snapshot)` then re-throws; the tail sits after the lock.
  - `:1327-1364` `renameWiki` -- the reference shape for a fail-soft post-lock tail (DW-209).
  - `:1386` `ORPHAN_SWEEP_GRACE_MS` (15 min), `:1417` `ORPHAN_SWEEP_CANDIDATE_CAP` (25) -- both exported and imported by the suite.
  - `:1434-1467` `newestWriteTime` -- returns null on any unreadable descendant and already warns.
  - `:1519-1637` `sweepOrphans(owner, registry)` -- computes `known`, `entries = listFiles(wikisRootPath(owner))`, `found` (uuid-shaped, `!known.has`), the `tombstonedOnly` probe over the FULL list, `eligible.slice(0, CAP)` at `:1577`, the truncation warn, then `cutoff = Date.now() - GRACE` at `:1586` and the per-candidate loop at `:1588-1635`.
  - `:1645-1656` `sweepOrphanWikiDirectories` -- the SCHEDULED entry (cron `POST /api/tasks/scan` via `sweepOrphanWikiDirs` in `src/lib/maintenance.ts:318`); takes the lock and calls `sweepOrphans`.
  - `:1686-1730` `deleteWiki` -- both byte-removal steps fail-soft inside the lock; returns `wiki` or `null`; throws `ClientInputError` for the current Wiki. No tail today.
- `src/lib/__tests__/wikis.test.ts` -- real temp-`DATA_DIR` filesystem provider (no storage mocks by default). Helpers already in file: `plantOrphan`, `ageDirectory`, `exists`, `wikiDir`, `abs`, `readDataVersion`/`DATA_VERSION_KEY`, and the `vi.spyOn(logger, "warn"|"info")` idiom. Existing suites to extend: `"the orphan-directory sweep"` (`:1151`), `"deleting a wiki"` (`:1059`), `"create, re-template and rename move the refresh signal (DW-49, DW-57, DW-209)"` (`:345`).
- Read-only evidence: the DW-289 cap rows at `:1434`, `:1485`, `:1515`, `:1566` of the suite must keep passing — rotation is a no-op when `eligible.length <= CAP`, and with 28 aged orphans any window still removes exactly CAP.
- `src/lib/storage/types.ts:171,193` -- `deleteFile(path)`, `fileExists(path)` are the provider methods the tombstone clear uses.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- extract the four duplicated fail-soft bump tails into one private `bumpRefreshSignal(after: string)` helper (`logger.warn("wikis", \`the refresh signal did not move after ${after}\`, error)`) and call it from `writeWikiArtifact`, `createWiki`, `applyScenarioTemplate` and `renameWiki` with the SAME phrases they warn with today -- one idiom, so the two new tails below do not become a fifth and sixth copy.
- `src/lib/wikis.ts` -- add the `bumpRefreshSignal` tail to `deleteWiki`, outside the lock, only when the locked body returned a record (DW-382); document why a delete is a Preview-visible byte move exactly as `renameWiki` does.
- `src/lib/wikis.ts` -- make `restoreSeededFiles` return whether EVERY entry was restored, and have `applyScenarioTemplate` bump (outside the lock, fail-soft) before re-throwing when it was not (DW-210). The lock body must not bump; carry the fact out to the post-lock scope.
- `src/lib/wikis.ts` -- in `sweepOrphans`, compute `now` once, and split the skip branch so a `newest` beyond `now + ORPHAN_SWEEP_GRACE_MS` warns (naming the future timestamp and that the directory cannot age out until the clock passes it) while everything else keeps today's `info` (DW-290).
- `src/lib/wikis.ts` -- replace `eligible.slice(0, CAP)` with a rotating window over a stably id-sorted list whose start advances by `CAP` per UTC day (`Math.floor(now / 86_400_000)`), modulo the eligible length, and is 0 when the list fits the cap (DW-383). No persisted cursor. Do not key the start on `ORPHAN_SWEEP_GRACE_MS`.
- `src/lib/wikis.ts` -- on SCHEDULED sweeps only, clear a `.discarded` tombstone from directories the registry DOES name, bounded by the same rotating window; warn once per cleared directory and warn-and-continue on probe/delete failure (DW-291). Thread the mode through a `sweepOrphans` option that `sweepOrphanWikiDirectories` sets and `deleteWiki` does not.
- `src/lib/__tests__/wikis.test.ts` -- add rows covering every I/O Matrix scenario above, using the existing helpers and spy idioms; assert `readDataVersion` deltas for the two new bumps and `logger` call text for the two new warns.

**Acceptance Criteria:**
- Given an aged orphan whose newest write is dated far in the future, when a sweep runs, then it is not removed, `logger.warn` fires naming the future date, and no `logger.info` grace-window line is emitted for it.
- Given more eligible candidates than `ORPHAN_SWEEP_CANDIDATE_CAP` and a head that can never be swept, when successive sweeps run on successive UTC days, then every candidate is eventually considered rather than only the first `CAP` on every pass. Two sweeps on the same UTC day consider the same window.
- Given a directory the registry names that carries `.discarded`, when the scheduled sweep runs, then the tombstone file is gone, the directory and its artifacts are untouched, and the same tombstone is left alone by a sweep running inside `deleteWiki`.
- Given a known non-current Wiki, when `deleteWiki` succeeds, then `readDataVersion` has advanced by exactly one; and given an unknown id, then it has not moved.
- Given a re-template whose registry write fails and whose restore leaves at least one file unrestored, when `applyScenarioTemplate` re-throws, then `readDataVersion` has advanced by one; and given a fully successful restore, then it has not moved and the original error is still what propagates.
- Given `pnpm test`, when the suite runs, then every pre-existing row — the DW-289 cap rows especially — still passes.

## Spec Change Log

- 2026-08-27 -- Review patch correction to the Design Notes sketch above: the stable sort must compare by CODE UNIT, not `localeCompare`. `localeCompare` with no locale is ICU collation keyed on the runtime's default locale, and `WIKI_ID_RE` accepts uppercase hex, so two isolates sweeping the same tenant could take different windows on the same UTC day -- which breaks the contract's own "two calls inside the same UTC day see the same window". The contract text ("sorted stably by id") is unchanged; only the sketch's comparator was wrong.
- 2026-08-27 -- Re-dispatched by the orchestrator against the bundle intent `.bmad-loop/runs/20260826-224036-f3da/bundles/wikis-orphan-sweep-and-lifecycle-tails/intent.md`. Same five DW ids, same slug, so this resumes THIS spec rather than opening a `-2`: the human intent-gap resolution above is the contract and must not be re-derived. Tree clean apart from this spec and the saved patch; HEAD still `f771e9db06c1b13d085276cada946d48a43209ee`; `bumpRefreshSignal` absent from `src/lib/wikis.ts`, so no implementation is in the tree.
- 2026-08-27 -- Human resolution of the review intent-gap: "every candidate is eventually considered" is measured on the **deployed daily sweep**, not on consecutive 15-minute grace buckets. Rotation is cadence-independent inside a UTC day: stable id sort, then `start = (floor(now / 86_400_000) * CAP) % n`. `ORPHAN_SWEEP_GRACE_MS` stays 15 minutes and is only the delete-age / forward-skew gate. Do not restore `patch-dw-210-290-291-382-383-wiki-sweep-and-lifecycle-tails.patch` — that attempt keyed rotation on the grace window. Known-bad state avoided: `gcd(96 * CAP, n) > CAP` freezing the window at `n = 100` (`MAX_WIKIS`) under `0 6 * * *`.
- 2026-08-27 -- Resumed after an aborted run left this spec at `in-review` with no implementation in the tree (`git status` clean apart from this file; `bumpRefreshSignal` absent from `src/lib/wikis.ts`). Status reset to `ready-for-dev`; plan unchanged and still anchored to `baseline_revision` f771e9db06c1b13d085276cada946d48a43209ee, which is HEAD.

## Design Notes

Rotation, stateless, cadence-independent inside a UTC day (DW-383). Removal is still the progress; rotation only fixes the case where nothing is removable. Sort first — `listFiles` order is not a storage contract.

```ts
const sorted = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // code unit, not localeCompare
const day = Math.floor(now / 86_400_000);
const start = sorted.length > ORPHAN_SWEEP_CANDIDATE_CAP
  ? (day * ORPHAN_SWEEP_CANDIDATE_CAP) % sorted.length
  : 0;
const window = sorted.length > ORPHAN_SWEEP_CANDIDATE_CAP
  ? Array.from({ length: ORPHAN_SWEEP_CANDIDATE_CAP },
      (_, i) => sorted[(start + i) % sorted.length])
  : sorted;
```

Stable within a UTC day (repeated deletes the same day behave identically), advances by exactly `CAP` per day, so full coverage in `ceil(n / CAP)` days with nothing persisted and no cron parse. Share it as one private helper and use it for both the orphan candidates and the claimed-directory tombstone scan. Do not key `day` on `ORPHAN_SWEEP_GRACE_MS`.

Why the tombstone clear is scheduled-only: `deleteWiki` is a user-facing request path holding `wikis:<tenant>`, and clearing needs one `fileExists` per registry-claimed directory — up to `CAP` extra round trips on a path that today costs one `listFiles` in the healthy case. The cron tick already tolerates the full walk, and DW-291's fault requires three unlikely failures in sequence, so a few minutes' delay costs nothing.

Why DW-290 warns rather than sweeps: the age gates a delete, so an unverifiable age must never authorise one. `now + ORPHAN_SWEEP_GRACE_MS` is the tolerance — a write dated further ahead than the whole grace window cannot be ordinary jitter between a provider clock (`head.uploaded` / `mtime`) and the isolate's.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/wikis.test.ts` -- expected: all rows pass, including the pre-existing DW-289 cap rows.
- `pnpm test` -- expected: both projects green.
- `pnpm exec tsc --noEmit` -- expected: no errors (the `restoreSeededFiles` return-type change is caught here if a caller was missed).
- `pnpm exec eslint src/lib/wikis.ts src/lib/__tests__/wikis.test.ts` -- expected: clean.

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 1: (high 1, medium 0, low 0)
- bad_spec: 2: (high 0, medium 2, low 0)
- patch: 7: (high 0, medium 1, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 2: (high 0, medium 0, low 2)
- addressed_findings:
  - none

Attempted change saved to [patch-dw-210-290-291-382-383-wiki-sweep-and-lifecycle-tails.patch](patch-dw-210-290-291-382-383-wiki-sweep-and-lifecycle-tails.patch); `src/` reverted to `f771e9db06c1b13d085276cada946d48a43209ee`. Lower-severity findings were triaged but not actioned: `intent_gap` cascades, so patch and bad_spec repairs are moot until the contract question below is settled.

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 3, low 10)
- defer: 2: (high 0, medium 0, low 2)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `rotatingSweepWindow` sorted with `localeCompare`, a locale-dependent ICU collation, while its docblock argued from byte order — two isolates could take different same-day windows. Swapped to a code-unit comparator; the R2-lexicographic and pre-cap probe comments were reworded to match.
  - `[medium]` `[patch]` `deleteWiki`'s docblock promised it bumps even when `deleteDirectory` failed, and no test pinned it. The existing degraded-delete row now asserts `readDataVersion` moved by one.
  - `[medium]` `[patch]` The rotating window over registry-CLAIMED directories was never exercised above the cap, so both of its stated properties were mutation-invisible. Added a row over a 30-entry registry asserting the per-pass probe bound and that a marker outside day 0's window is cleared on the day its window comes round.
  - `[low]` `[patch]` The truncation warn still said `deferring N to the next sweep`; under rotation the deferred candidates wait for a later UTC day. Reworded, and the two DW-289 rows asserting the old text updated.
  - `[low]` `[patch]` The `workbench-data-version` comment justifying why `sweepOrphanWikiDirectories` does not bump claimed it only touches unreferenced directories, which DW-291 made false. Restated around the marker being a file nothing renders.
  - `[low]` `[patch]` That same comment said "two DIFFERENT reasons" while still listing three groups. Restored to three.
  - `[low]` `[patch]` One `catch` in `clearStaleDiscardTombstones` reported a delete failure for a probe that never answered. Split into two `try` blocks with distinct sentences; added a row for the probe-throws branch, which had no coverage.
  - `[low]` `[patch]` `applyScenarioTemplate`'s docblock claimed the `rollbackIncomplete` bump proves the disk moved; the flag only proves a restore entry failed. Softened, and the over-signalling trade named.
  - `[low]` `[patch]` DW-291's residual — `claimed` is empty exactly when the registry is lost, the state the marker is dangerous in — was undocumented. Added to the docblock.
  - `[low]` `[patch]` `ORPHAN_SWEEP_ROTATION_MS` was private, so the suite hardcoded `24 * 60 * 60 * 1000`. Exported (permitted: "beyond what tests need") and imported.
  - `[low]` `[patch]` The rotation row used `n = cap + 5`, so `ceil(n / cap) = 2` and the wrap boundary never ran. Added an `n = 2 * cap + 5` row proving three days are needed and sufficient.
  - `[low]` `[patch]` `claimedDirectories` was computed on every pass including `deleteWiki`'s inline sweep, which never reads it. Now computed only under `options.scheduled`.
  - `[low]` `[patch]` The rewritten local `bodyOf` had become a duplicate of the file's own `topLevelFunctionBody`. Deleted in favour of the shared helper.

Rejected without action: the DW-290 warn's repetition (already recorded in this spec's `deferred` before this pass); `logger.warn` itself throwing outside the `try`; a window freeze under a sweep cadence of every k>1 UTC days (the human resolution above fixed the measured surface as the DAILY scheduled sweep); the `bumpRefreshSignal` extraction being "unrequested" (this spec's Tasks mandate it); `bumpRefreshSignal`'s `catch` being unreachable because `bumpDataVersion` already swallows (documented defence in depth); and the absence of a client/API-surface test for the refresh bridge (pre-existing, and the matrix states the expectation at the library surface).

## Auto Run Result

Status: done

### Implemented change

Five quiet leaks in `src/lib/wikis.ts` now report themselves, with every existing safety rule intact — nothing is deleted on an age that could not be read or verified, and every compensation stays fail-soft.

- **DW-290** — `sweepOrphans` reads the clock once and derives both `cutoff = now - GRACE` and `horizon = now + GRACE`. A candidate whose newest write is beyond the horizon now warns, naming the future timestamp and that the bytes stay until the clock passes it; a small forward skew inside grace keeps today's `info`. Neither is ever removed.
- **DW-383** — `eligible.slice(0, CAP)` is replaced by `rotatingSweepWindow`: a code-unit sort, then a window of `CAP` starting at `(floor(now / ORPHAN_SWEEP_ROTATION_MS) * CAP) % n`, wrapping, and the identity when `n <= CAP`. Two passes inside one UTC day see the same window; a permanently unsweepable head can no longer starve the tail. Nothing is persisted and the cron schedule is never parsed.
- **DW-291** — scheduled sweeps only (`sweepOrphanWikiDirectories` sets the flag; `deleteWiki`'s inline sweep does not) clear a `.discarded` marker from directories the registry DOES name, through the same rotating window. Probe and clear failures each warn with their own sentence and the pass continues.
- **DW-382** — `deleteWiki` carries the same fail-soft bump tail its siblings do, outside the lock, only when the locked body returned a record. It bumps even when the directory removal failed, since the registry entry is gone either way.
- **DW-210** — `restoreSeededFiles` reports whether every entry was restored (still never throws, still attempts each entry). `applyScenarioTemplate`'s locked body returns a private outcome union instead of throwing through the lock, so the post-lock scope bumps on an incomplete rollback and then re-throws the original error unwrapped. A clean rollback still bumps nothing.

The four pre-existing duplicated bump tails were extracted into one private `bumpRefreshSignal(after)` and re-pointed, so DW-382 and DW-210 did not become a fifth and sixth copy.

### Files changed

- `src/lib/wikis.ts` — all five fixes, plus `bumpRefreshSignal`, `rotatingSweepWindow`, `clearStaleDiscardTombstones`, the `RetemplateOutcome` union, and the newly exported `ORPHAN_SWEEP_ROTATION_MS`.
- `src/lib/__tests__/wikis.test.ts` — rows for every I/O-matrix scenario, plus the review-added rows for the claimed-directory window bound, the three-day rotation cycle, the probe-throws branch, and the bump on a failed directory removal.
- `src/lib/__tests__/workbench-data-version.test.ts` — the source-shape guard on where the bump lives, rewritten for the helper extraction (see the deviation below).

### Review findings

- **Patches applied: 13** (medium 3, low 10) — see the triage log above. Follow-up score `3 x 3 + 1 x 10 = 19`, no high, so `followup_review_recommended: true`.
- **Deferred: 2** — a registry write that reports failure after landing, and the DW-289 cap rows' new calendar dependence. Both added to frontmatter `deferred` alongside the DW-290 warn-repetition entry recorded in the prior pass.
- **Rejected: 6** — enumerated at the end of the triage log.
- **intent_gap: 0, bad_spec: 0.**

### Verification

Run by this session after the patch pass, not only reported by the implementer:

- `pnpm exec vitest run --project node src/lib/__tests__/wikis.test.ts` — 94 passed.
- `pnpm test` — 327 files, 7520 passed, 1 skipped.
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm exec eslint src/lib/wikis.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts` — clean, exit 0.

Matrix test audit: all nine I/O-matrix rows map to named tests that ran and passed. The clean-rollback no-bump row is covered by the four pre-existing `restores all three files when a re-template faults on <file>` rows, each of which asserts `readDataVersion()` is unmoved. Every new behaviour was mutation-checked — reverting rotation to `slice`, unbounding or `slice`-ing the marker loop, collapsing the probe/clear `catch`, guarding the delete tail on `removedBytes`, disabling the tombstone clear, forcing `rollbackIncomplete` false, collapsing the future-dated branch, and alternating the window instead of advancing it each fail exactly the intended rows and nothing else.

### Deviation from an acceptance criterion

The AC "every pre-existing row still passes" could not hold literally. `workbench-data-version.test.ts`'s guard `has exactly four sites inside wikis.ts, each outside the tenant lock` asserts `source.match(/bumpDataVersion\s*\(/g)` has length 4 — a source-shape assertion that this spec's own mandated `bumpRefreshSignal` extraction directly contradicts, and a file the Code Map did not list. The row was rewritten rather than relaxed, and now pins strictly more: exactly one `bumpDataVersion(` in the module, inside a non-exported helper whose body matches the fail-soft `try`/`catch` + `logger.warn("wikis"` shape; exactly six `await bumpRefreshSignal(` calls; per-body counts for the five writers; and EVERY call site, not just the first, positioned after the wiki lock's close.

### Residual risks

- The DW-290 warn repeats on every pass while the clock has not caught up — recorded in `deferred`, and the reason the escalation is a warn rather than a delete.
- Rotation guarantees coverage per UTC DAY, so it depends on the deployed daily cron tick. A tenant swept only every k>1 days would see a coarser cycle. This is the surface the human intent-gap resolution fixed; it is not re-litigated here.
- DW-291 narrows rather than closes its window: `claimed` is empty exactly when the registry is lost, so the clear only helps when a scheduled sweep runs between the bad half-create and the loss. Documented in the code.
- `bumpRefreshSignal`'s own `catch` is unreachable today because `bumpDataVersion` already swallows storage failures; it is deliberate defence in depth and is pinned only by the source-shape guard.
