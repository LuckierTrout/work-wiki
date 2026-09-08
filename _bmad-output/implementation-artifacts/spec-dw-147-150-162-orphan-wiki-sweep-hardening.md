---
title: 'Orphan wiki-directory sweep: a scheduled trigger, an mtime grace window, and a reclaimable half-created first Wiki'
type: 'bugfix'
created: '2026-08-19'
baseline_revision: '37728aba2fed345d97b41ba5241b483b64bd0f20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The scheduled sweep reclaims only the configured owner's tenant, so DW-147's
      condition still holds unchanged for every other tenant.
    evidence: |-
      `sweepOrphanWikiDirs` resolves one handle via `getOwnerHandle()`
      (`NEXT_PUBLIC_OWNER_HANDLE`), but `POST /api/wikis` calls
      `createWiki(principal.handle, ...)`, so any signed-in principal gets its own
      tenant and its own registry. For those tenants `deleteWiki` remains the only
      trigger. This matches the neighbouring backup block in the same route (also
      owner-only) and `src/lib/owner.ts`'s "single-owner deployment" stance, so it
      is a deliberate scope, not a bug — but the repo has an owner-enumeration
      precedent (`listSourceMonitorOwners`) and no equivalent index for Wikis.
    location: >-
      src/lib/maintenance.ts (sweepOrphanWikiDirs)
    severity: low
  - summary: >-
      The sweep has no per-pass cap, so one cron request can walk, stat and delete
      an unbounded number of candidates while holding the tenant lock.
    evidence: |-
      Every other block in `src/app/api/tasks/scan/route.ts` bounds its work
      (`.slice(0, 25)`, `listDueOutboxEvents(..., 50)`) and `scanForMaintenance`
      documents its cap as a "cost + blast-radius bound". `sweepOrphans` runs inside
      `withFileLock(wikiLockKey(owner))`, so a long pass queues every create, rename
      and delete for that tenant behind it. Bounded in practice by `MAX_WIKIS` (100)
      and by orphans being rare, which is why it is recorded rather than fixed.
    location: >-
      src/lib/wikis.ts (sweepOrphans)
    severity: low
  - summary: >-
      A future-dated mtime (clock skew, or a restored archive) makes an orphan
      permanently unsweepable, with no signal that it is leaking.
    evidence: |-
      `sweepOrphans` skips whenever `newest > Date.now() - ORPHAN_SWEEP_GRACE_MS`.
      A directory whose newest write time is in the future never satisfies that
      test, on any pass, forever. R2 reports `head.uploaded` and the filesystem
      provider reports `mtime`, neither of which is guaranteed monotonic against
      the isolate's clock. The skip is logged at `info`, so nothing escalates.
    location: >-
      src/lib/wikis.ts (sweepOrphans)
    severity: low
  - summary: >-
      A `.discarded` tombstone is never cleared, so it can outlive the condition it
      records.
    evidence: |-
      The marker is written when `discardCreatedWikiDirectory`'s `deleteDirectory`
      fails, and nothing removes it except the directory's own deletion. If a
      `writeRegistry` landed on the store but reported failure, the compensation
      runs against a directory the registry DOES name; the tombstone is then
      harmless while the registry stands (`known.has(id)` skips it) but authorises
      deletion if that `wikis.json` is later lost. Requires three unlikely faults in
      sequence, hence low.
    location: >-
      src/lib/wikis.ts (discardCreatedWikiDirectory)
    severity: low
---

<intent-contract>

## Intent

**Problem:** (DW-147) `sweepOrphanWikiDirectories` has no production caller but `deleteWiki`, and the current Wiki is undeletable, so a tenant that never deletes never reclaims a directory a `normalizeRegistry` drop or an interrupted delete orphaned. (DW-150) `withFileLock` is in-process only, so on a multi-isolate deployment isolate B's sweep can delete the directory isolate A is mid-create in — byte removal, not a lost entry. (DW-162) `sweepOrphans` bails on an empty registry, so when `discardCreatedWikiDirectory` fails on a tenant's FIRST create the bytes sit on disk until that tenant owns a Wiki *and* runs a delete.

**Approach:** Give the sweep a scheduled trigger through the maintenance scan (a fail-soft wrapper in `maintenance.ts`, called by `/api/tasks/scan` beside `purgeStaleJobs`). Give it a safety margin: skip any candidate directory whose newest write is younger than a documented grace window measured in minutes. Keep the empty-registry bail — an existing test pins it, and lifting it would delete every Wiki of a tenant whose `wikis.json` was lost — but narrow it: under an empty registry the sweep removes only directories carrying the `.discarded` tombstone that the half-create compensation writes when its own `deleteDirectory` fails.

## Boundaries & Constraints

**Always:**
- `scanForMaintenance` stays READ-ONLY (its contract). The byte removal lives in a separate fail-soft export in `maintenance.ts` that the route calls, never inside the scan.
- The grace window is ONE exported constant with the rationale documented beside `sweepOrphans`.
- A candidate whose age cannot be determined (a `listFiles`/`stat` throw, no file and no directory stat) is SKIPPED, never swept — unknown age is treated as too young.
- The sweep stays fail-soft everywhere it already is: it never fails the delete it runs inside, and never fails the scan.
- The empty-registry pass removes ONLY tombstoned directories, and still honours the grace window.
- The tombstone write is best-effort and warn-on-failure; it never replaces the original diagnosis (`discardCreatedWikiDirectory` still never throws).
- Existing sweep tests that plant a fresh orphan must be updated to backdate its mtime, not weakened by removing the grace check.

**Block If:**
- The `wikis` or `scan-route` suites cannot be made to cover the grace window without changing `vitest.config.ts`.

**Never:**
- Do not lift the `registry.wikis.length === 0` bail for untombstoned directories; do not change `readRegistry`/`normalizeRegistry`.
- No cross-process lock, no new storage-provider method, no change to `StorageProvider`.
- No new read-only gate on the sweep — the scan's existing byte-removal steps (`purgeStaleJobs`, `reconcileSilos`) carry none, and one here alone would be inconsistent.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Aged orphan | registry names ≥1 wiki; `wikis/<uuid>/` unreferenced, newest write older than the window | removed; counted; warn names the id | No error expected |
| In-flight create | same, but newest write is younger than the window | NOT removed; count excludes it; warn says it was skipped as too young | No error expected |
| Unknown age | candidate whose `listFiles`/`stat` throws | NOT removed; warn | Error swallowed per candidate; other candidates still swept |
| Lost registry | `wikis.json` missing or naming nothing; real wiki directories on disk, no tombstone | nothing removed; returns 0 | No error expected |
| Discarded half-create | empty registry; aged directory carrying `.discarded` | removed; returns 1 | No error expected |
| Failed discard | `discardCreatedWikiDirectory`'s `deleteDirectory` throws | `.discarded` written; original seed error re-thrown by `createWiki` | Tombstone write failure warns only |
| Scheduled scan | cron POSTs `/api/tasks/scan`, owner handle set | sweep runs; count in the response body | Sweep throw → warn, count 0, still 200 |
| Scan inspection / no owner | `?dry=1`, or `NEXT_PUBLIC_OWNER_HANDLE` unset | sweep does not run; count 0 | No error expected |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1018` -- `sweepOrphans(owner, registry)`: the empty-registry bail (`:1019`), the `WIKI_ID_RE`/`known`-set candidate filter, and the `deleteDirectory(wikiDirPath(...))` removal. Where the grace window and the tombstone pass land.
- `src/lib/wikis.ts:1053` -- `sweepOrphanWikiDirectories(owner)`: the exported, self-locking entry point the new scheduled caller uses as-is.
- `src/lib/wikis.ts:1098-1116` -- `deleteWiki`'s fail-soft tail: the existing in-process caller. Unchanged.
- `src/lib/wikis.ts:508-531` -- `discardCreatedWikiDirectory`: its catch is the exact DW-162 path; its warn text currently states the leftovers are not self-healing and must be re-written.
- `src/lib/wiki-paths.ts` -- `WIKI_ID_RE`, `wikisRootPath`, `wikiDirPath`. The tombstone path must hang off `wikiDirPath`, not a literal.
- `src/lib/storage/types.ts:68,135` -- `FileEntry {name,isDirectory}` (no mtime) and `stat(path): FileInfo{size,lastModified}`. Age must come from `stat` per file; R2 has no directory objects, so walk files and fall back to the directory's own `stat`.
- `src/lib/maintenance.ts:~290` -- `purgeStaleJobs`: the exact fail-soft shape the new export copies. `rebuildDerivedIndexes` shows the `await import("./x")` idiom that keeps the module graph loose.
- `src/app/api/tasks/scan/route.ts:60,79` -- `jobsPurged`, and the `!forceDry` gate the scheduled-agent/monitor/backup blocks use (they run even when `AUTONOMOUS_MAINTENANCE` is off; only the `maintain` enqueue respects `dry`).
- `src/lib/owner.ts` -- `getOwnerHandle()`: single-owner deployment; null → nothing to sweep.
- `src/lib/__tests__/wikis.test.ts:960-1035` -- `plantOrphan` and the four sweep tests, incl. `refuses to sweep against an empty registry` (pins BOTH the missing- and the present-but-empty-registry cases). `:1201` -- `re-throws the seed error…`, the test DW-162 names.
- `src/lib/__tests__/scan-route.test.ts:4-9` -- `vi.mock("@/lib/maintenance", …)` is an explicit export list; a new route import MUST be added there or the route sees `undefined`.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- export `ORPHAN_SWEEP_GRACE_MS` (15 minutes); add an internal newest-write-time helper that walks a directory's files via `listFiles`/`stat` (recursing into `revisions/`), falls back to the directory's own `stat`, and returns null when nothing can be read; in `sweepOrphans`, skip any candidate younger than the window or of unknown age (warn per skip); replace the unconditional empty-registry `return 0` with a tombstone-only pass; add the `.discarded` tombstone constant/path and write it (best-effort) from `discardCreatedWikiDirectory`'s catch; update the `sweepOrphans`, `sweepOrphanWikiDirectories`, `writeRegistry` and `discardCreatedWikiDirectory` doc comments and the half-create warn text to state what is now true.
- `src/lib/maintenance.ts` -- add `sweepOrphanWikiDirs(): Promise<number>`, a fail-soft wrapper (`purgeStaleJobs` shape) that resolves the owner via `getOwnerHandle()`, returns 0 when unset, and calls `sweepOrphanWikiDirectories` through `await import("./wikis")`; document why it is not inside `scanForMaintenance`.
- `src/app/api/tasks/scan/route.ts` -- import and call it under `!forceDry`; return the count as `orphanWikiDirsRemoved`; leave every other field untouched.
- `src/lib/__tests__/wikis.test.ts` -- add a recursive `backdate(dir)` helper (fs.utimes past the window); backdate in the existing sweep/delete tests that now trip the window; add tests for: a freshly seeded directory is unsweepable while an aged sibling is swept in the same pass, an unreadable candidate is skipped rather than swept, a tombstoned aged directory IS reclaimed under an empty registry, an untombstoned one still is not, and the failed-discard path writes the tombstone.
- `src/lib/__tests__/maintenance.test.ts` -- cover `sweepOrphanWikiDirs`: forwards the owner and returns the count, returns 0 with no owner handle, returns 0 and does not throw when the sweep rejects.
- `src/lib/__tests__/scan-route.test.ts` -- add the new export to the `@/lib/maintenance` mock; assert the sweep runs on a normal scan (with `AUTONOMOUS_MAINTENANCE` off), is skipped under `?dry=1`, and that its count is reported.

**Acceptance Criteria:**
- Given a tenant with at least one Wiki and an unreferenced `wikis/<uuid>/` directory older than the grace window, when the cron POSTs `/api/tasks/scan` with `AUTONOMOUS_MAINTENANCE` unset, then the directory is gone and the response reports it — no delete required.
- Given a tenant whose `wikis.json` is missing while real Wiki directories sit on disk, when any sweep runs, then nothing is removed and it returns 0.
- Given a first-ever create whose seed AND whose discard both failed, when a scheduled sweep runs after the grace window, then that directory alone is reclaimed even though the registry still names no Wiki.
- Given `pnpm test` and `pnpm lint`, when run at the repo root, then both pass.

## Design Notes

The empty-registry bail stays because `readRegistry` cannot distinguish "empty tenant" from "lost `wikis.json`", and `src/lib/__tests__/wikis.test.ts` pins both halves of that. The tombstone is the missing evidence: only the half-create compensation writes it, so a directory carrying one is provably unclaimed regardless of what the registry says. Residual, and documented rather than fixed here: an isolate killed BETWEEN the seed and the registry write on a first-ever create leaves an untombstoned directory the catch never ran for — still unreclaimable, still bounded by the same guard.

The window is mtime-based, not a lock: `createWiki` seeds `wikis/<id>/` before pushing the entry, so an in-flight create's directory always carries writes from seconds ago. Minutes of margin cover an isolate that is slow between the seed and the registry write; it does not pretend to be a cross-process lock.

## Verification

**Commands:**
- `pnpm test -- src/lib/__tests__/wikis.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/scan-route.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** The orphan `wikis/<uuid>/` sweep gained a scheduled trigger, a safety margin, and one narrow exception to its empty-registry bail. `POST /api/tasks/scan` now calls a fail-soft `sweepOrphanWikiDirs()` in `maintenance.ts` (a sibling of `purgeStaleJobs`, NOT inside the read-only `scanForMaintenance`), so reclamation no longer waits on a tenant happening to delete a Wiki (DW-147). `sweepOrphans` skips any candidate whose newest write is younger than `ORPHAN_SWEEP_GRACE_MS` (15 minutes) — and any candidate whose age cannot be read at all — which is what makes a scheduled caller safe beside an in-flight `createWiki` on a second isolate (DW-150). The `registry.wikis.length === 0` bail was narrowed rather than lifted: under an empty registry the sweep removes only directories carrying a `.discarded` tombstone, written best-effort by `discardCreatedWikiDirectory` when its own `deleteDirectory` fails, so a half-created FIRST Wiki is reclaimable without the tenant owning a Wiki and running a delete (DW-162) — while a lost `wikis.json` still costs no artifact.

**Files changed.**
- `src/lib/wikis.ts` — `ORPHAN_SWEEP_GRACE_MS`, the `newestWriteTime` walk, the grace/unknown-age skip, the tombstone-only empty-registry pass, the `.discarded` marker and its write from the half-create compensation, plus per-candidate error isolation and rewritten doc comments.
- `src/lib/maintenance.ts` — `sweepOrphanWikiDirs()`, the fail-soft scheduled entry point.
- `src/app/api/tasks/scan/route.ts` — calls it under `!forceDry`, reports `orphanWikiDirsRemoved`, and documents what `AUTONOMOUS_MAINTENANCE` does and does not gate.
- `src/lib/__tests__/wikis.test.ts` — the `ageDirectory` helper and the grace-window, unknown-age, tombstone, per-candidate-failure and half-create cases.
- `src/lib/__tests__/maintenance.test.ts` — the wrapper's owner forwarding, no-owner no-op, and fail-soft behaviour.
- `src/lib/__tests__/scan-route.test.ts` — the sweep runs on a normal scan and with the flag on, and is suppressed by `?dry=1`.

**Review findings.** 12 patches applied (0 high, 4 medium, 8 low), 4 items deferred (all low, in frontmatter `deferred`), 8 rejected. No intent gaps and no spec repairs; `review_loop_iteration` stayed 0.

**Follow-up review recommendation:** true. Patched counts: high 0, medium 4, low 8 → score `3 × 4 + 1 × 8 = 20`, at or above the threshold of 5.

**Verification.** `npx vitest run` — 249 files / 5282 tests, all passing (baseline 5275; +7). `npx tsc --noEmit` — clean. `npx eslint` — exit 0 (three pre-existing `jsx-ast-utils` notices, unrelated). Every row of the I/O & Edge-Case Matrix has a covering test that ran and passed, and the four riskiest branches were mutation-checked (the `stat(dir)` fallback, the tombstone-probe catch, the per-candidate delete catch, and unknown-age-as-sweepable each fail exactly their intended tests).

**Residual risks.**
- An isolate killed BETWEEN the seed and the registry write on a first-ever create leaves an UNTOMBSTONED directory (the compensation's catch never ran), still unreclaimable until the tenant owns a Wiki. Documented in the `sweepOrphans` doc comment; the safe side of the guard.
- The grace window is a margin, not a cross-process lock: an isolate suspended for longer than 15 minutes between the seed and the registry write would still lose the race.
- The window also delays `deleteWiki`'s own sweep for leftovers written in the last 15 minutes; the next scheduled pass reclaims them.
- On R2 a candidate directory holding no file objects has no readable age (no directory object) and is skipped indefinitely; on the filesystem provider the directory's own `stat` covers that case.
- The four deferred items in frontmatter (owner-only tenant scope, no per-pass cap, future-dated mtimes, uncleared tombstones).
