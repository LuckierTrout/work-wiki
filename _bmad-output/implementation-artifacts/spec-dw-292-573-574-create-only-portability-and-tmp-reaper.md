---
title: 'Create-only portability and the stranded-scratch reaper (DW-292, DW-573, DW-574)'
type: 'bugfix'
created: '2026-08-30'
status: done
baseline_revision: '5d9a84da6739d62739509ef3c1eafab4ce0013e6'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Both filesystem create-only writes publish with `fs.link` and handle only `EEXIST`, so on a filesystem without hard links (exFAT, some FUSE/network mounts) every `writeFileIfAbsent`/`writeAssetIfAbsent` throws `EPERM`/`ENOSYS`/`EXDEV` where the old rename-based write succeeded; separately, a `.tmp-<uuid>.tmp` stranded by process death is hidden by `listFiles` and reclaimed by nothing, and neither door has fault-identity coverage on either provider.

**Approach:** Give `createOnlyWrite` a rename-based fallback for the link-less error codes (its exclusivity resting on the publication lock it already holds), add an age-thresholded scratch reaper to `FilesystemStorageProvider` that the maintenance scan runs beside the orphan sweep behind its own read-only refusal, and extend the fault-identity suites to cover the create-only door on both providers.

## Boundaries & Constraints

**Always:** `fs.link` stays the primary publication path — the fallback runs only after a link failure whose code is one of `EPERM`, `ENOSYS`, `EXDEV`, `EOPNOTSUPP`, `ENOTSUP`. `EEXIST` still returns `false` without touching the existing bytes; every other code still rethrows verbatim. The fallback runs inside the existing `withFilesystemPublicationLock` body and probes the destination before renaming, so a concurrent creator still loses. Scratch cleanup stays in `finally` and never replaces the publication error. The reaper deletes only names matching `TMP_ARTIFACT` whose `mtime` is older than the grace window, and is fail-soft per entry. New refusal sentences go in `READ_ONLY_REFUSAL` and satisfy the parity suite's shape rules (starts capital, ends `while this deployment is read-only.`, unique).

**Block If:** the rename fallback cannot be made exclusive against a concurrent creator holding the same publication lock; or the reaper cannot distinguish an in-flight write from a stranded one without a new on-disk marker.

**Never:** do not weaken `atomicWrite`; do not add the reaper to the `StorageProvider` interface (R2 has no scratch files — its create-only put is native); do not import `read-only.ts` from anything under `src/lib/storage/` (that would close a cycle through `config.ts` → `storage/index.ts`); do not put the reaper inside `scanForMaintenance`, whose contract is read-only; do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Link works | `writeFileIfAbsent` on an absent path, links supported | `true`, bytes published, no scratch left | No error expected |
| Link-less filesystem, absent | `fs.link` throws `ENOSYS`/`EPERM`/`EXDEV`, destination absent | Fallback renames tmp into place, returns `true` | No error expected |
| Link-less filesystem, occupied | Same, destination already exists | Returns `false`, existing bytes untouched, no scratch left | No error expected |
| Link fails otherwise | `fs.link` throws `EIO` | Rethrows that exact error object, no scratch left | Original error propagates |
| Fallback itself fails | Link `ENOSYS`, rename throws `ENOSPC` | Rejects with the rename error (the reason publication failed) | Rename error propagates |
| Aged scratch | `.tmp-<uuid>.tmp` with mtime older than the grace window | Removed; count returned | Per-entry failure skipped, pass continues |
| In-flight scratch | `.tmp-<uuid>.tmp` written seconds ago | Left alone; not counted | No error expected |
| Read-only deployment | `YOPEDIA_READONLY` set, reaper called directly | Throws `ReadOnlyError` with the new sentence | Refusal propagates, not swallowed |
| R2 create-only fault | mocked bucket `put` rejects | `writeFileIfAbsent`/`writeAssetIfAbsent` reject with that exact object | Original error propagates |

</intent-contract>

## Code Map

- `src/lib/storage/filesystem.ts` -- `TMP_ARTIFACT` (~line 44) and `LOCK_DIR` own the scratch-name convention; `createOnlyWrite` (~line 393) is the single create-only body both `writeFileIfAbsent` (~line 444) and `writeAssetIfAbsent` (~line 458) delegate to; `atomicWriteUnlocked` (~line 248) is the shape to mirror for cleanup-never-replaces-the-error; `listFiles` (~line 314) is what hides scratch from every caller. `withFilesystemPublicationLock` (~line 63) is a real lockfile (`fs.open(…,"wx")`), so it is cross-process — the same exclusion `writeFileIfMatch` (~line 466) already rests its read-compare-write on.
- `src/lib/read-only.ts` -- `READ_ONLY_REFUSAL` table (~line 175) and `assertWritable` (~line 361); `wikiDirectorySweep` (~line 234) is the precedent for a sentence with no route literal to mirror, and the module docblock (~line 96) names it as such.
- `src/lib/maintenance.ts` -- `sweepOrphanWikiDirs` (~line 360) is the fail-soft wrapper shape to copy: `await import(...)` for a loose graph, `logger.error` + `return 0` on failure, and a docblock saying why it sits outside `scanForMaintenance`.
- `src/lib/wikis.ts` -- `ORPHAN_SWEEP_GRACE_MS` (~line 1608, 15 min) and `sweepOrphanWikiDirectories` (~line 2247) show the mtime-grace and `assertWritable`-before-work patterns.
- `src/lib/storage/index.ts` -- `isFilesystemStorage()` (~line 115) already exists and is currently unused; it is the provider probe the wrapper needs.
- `src/app/api/tasks/scan/route.ts` -- the `!forceDry` blocks at ~line 195-215, the log line and the JSON response body are where the reaper joins; its handler docblock enumerates the response fields.
- `src/lib/__tests__/storage-fs-fault-identity.test.ts` -- mocks `node:fs/promises` through a `control` object (`rmError`/`closeError`/`writeError`); extend with `linkError`/`renameError`.
- `src/lib/__tests__/storage-fs.test.ts` -- real-fs create-only rows (~line 233-335), including the `/^\.tmp-.*\.tmp$/` no-scratch assertion to reuse.
- `src/lib/__tests__/storage-r2.test.ts` -- `createMockEnv()` (~line 280) and the create-only describes (~line 519-575); build a local env whose `put` rejects.
- `src/lib/__tests__/maintenance.test.ts` -- `sweepOrphanWikiDirs` suite (~line 389) shows tmpdir + `_resetStorage()` setup and the backdating helper via `fs.utimes`.
- `src/lib/__tests__/scan-route.test.ts` -- `vi.mock("@/lib/maintenance", ...)` factory (~line 4) must gain the new export or the route import fails.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the orphan-sweep row (~line 344) is the template for "this sentence mirrors no route"; the exhaustive loops (~line 546, 583, 594) constrain the new sentence's shape and uniqueness.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/filesystem.ts` -- add a module-level set of link-less error codes (typed `ReadonlySet<string>`; do NOT wrap it in `Object.freeze`, which does not freeze a Set's contents and would only mislead) and a rename-based fallback inside `createOnlyWrite`'s link `catch`: on a link-less code, `fs.stat` the destination and return `false` when it exists, otherwise `fs.rename(tmp, abs)` and return `true`; keep `EEXIST` → `false` and every other code rethrown. **The probe must treat only `ENOENT` as "absent"** — any other `stat` error (`EACCES`, `EIO`, `ELOOP`, …) rethrows verbatim. A probe that swallows every error answers "absent" for a destination it merely could not read, and the `fs.rename` that follows would REPLACE the published bytes and return `true`, breaking the create-only contract's "the existing bytes never touched either way" on the one path that exists to preserve it. Document that the fallback's exclusivity comes from the publication lock plus the probe rather than from the link primitive, and that a failing rename's error is what propagates. -- DW-573: a link-less filesystem must still serve every Source arrival.
- `src/lib/storage/filesystem.ts` -- export `STRANDED_SCRATCH_GRACE_MS` and `STRANDED_SCRATCH_CANDIDATE_CAP`, and add a public `reapStrandedScratchFiles(olderThanMs?)` that walks `basePath` recursively (skipping `LOCK_DIR`), removes files matching `TMP_ARTIFACT` whose `mtime` is older than the window, returns the count, and swallows per-entry failures. Docblock the grace window as the in-flight-write guard, since `mtime` tracks the last byte written. -- DW-292: nothing reclaims scratch stranded by process death.
- `src/lib/read-only.ts` -- add `READ_ONLY_REFUSAL.scratchFileReap` ("Stranded scratch files cannot be reclaimed while this deployment is read-only.") and extend the docblock paragraph about sentences with no route literal to name it beside `wikiDirectorySweep`. -- One owner per server sentence.
- `src/lib/maintenance.ts` -- add exported `reapStrandedScratchFiles()`: `assertWritable(READ_ONLY_REFUSAL.scratchFileReap)` BEFORE the try so a direct library caller meets the refusal, then `isFilesystemStorage()` guard, dynamic-import the provider class, `instanceof` narrow, call it; `logger.error` + `return 0` on any fault. Docblock why it is outside `scanForMaintenance` and why the gate is here rather than in the storage layer — but do NOT claim the dynamic import keeps the module graph loose: `maintenance.ts` already statically imports `./storage`, which statically imports `./filesystem`, so the provider module is eagerly in the graph either way. State the real reason (mirroring `sweepOrphanWikiDirs`' shape and avoiding a named-export dependency on a class this module only narrows against). -- The scheduled trigger the reaper needs.
- `src/app/api/tasks/scan/route.ts` -- call it under the same `!forceDry` gate beside `sweepOrphanWikiDirs`, add `scratchFilesReaped` to the log line and response body, and extend the handler docblock's field list. -- `?dry=1` stays the one true inspection switch.
- `src/lib/__tests__/storage-fs.test.ts` -- add real-fs rows for the link fallback: link-less code with an absent destination publishes and returns `true`; with an occupied destination returns `false` and leaves the bytes; both leave no scratch. -- Covers the I/O matrix's fallback rows.
- `src/lib/__tests__/storage-fs-fault-identity.test.ts` -- extend the `control` mock with `linkError`/`renameError`/`statError` and add a `createOnlyWrite` describe: a non-`EEXIST`, non-link-less link failure propagates the exact object with no scratch left; an `rm` that cannot unlink does not replace it; a failing fallback rename propagates the rename error; **a fallback probe whose `stat` fails with a non-`ENOENT` code propagates that error and leaves the destination's bytes exactly as they were** (the row that pins the probe is not a silent overwrite). This suite also hosts the fallback's behaviour rows (see the Spec Change Log): give `writeAssetIfAbsent` its own occupied-destination and error-identity rows rather than trusting it shares a body with the string door — the same argument the suite already makes for binary payloads. -- DW-574 on the filesystem provider.
- `src/lib/__tests__/storage-r2.test.ts` -- add rows where the mock bucket's `put` rejects and both create-only doors reject with that exact object. Every assertion in this describe uses `.rejects.toBe(fault)` — object identity is the whole point of a fault-identity suite, and `toBeInstanceOf(Error)` would pass against a re-wrapped error. Pin the fault-vs-already-exists contrast on BOTH doors, not just the string one. -- DW-574 on R2.
- `src/lib/__tests__/maintenance.test.ts` -- add a `reapStrandedScratchFiles` suite: an aged scratch file is reaped and counted, a fresh one survives, a read-only deployment throws the sentence, and a walk failure returns 0. -- Covers the reaper's matrix rows.
- `src/lib/__tests__/storage-fs.test.ts` -- pin the walk's own fault behaviour at the provider level, which a wrapper test that mocks the whole method cannot reach: a candidate whose `stat` or `rm` fails is SKIPPED while the rest of the pass still reaps and counts (the matrix's "per-entry failure skipped, pass continues" cell), an unreadable subdirectory is skipped while an unreadable base path REJECTS, and a pass stops at `STRANDED_SCRATCH_CANDIDATE_CAP` candidates with the remainder reclaimed by the next pass (import the constant; do not hardcode 500). Mutating any of these three behaviours must fail a test — that is the bar. -- The cap and the fail-soft contract are load-bearing and were previously assertable only by reading the docblock.
- `src/lib/__tests__/scan-route.test.ts` -- add the new export to the `@/lib/maintenance` mock factory and add rows for the reported count and for `?dry=1` suppression. Name each row for the configuration it actually sets up — a row asserting `enabled: false` is the maintenance-OFF case and must not be titled "a normal scan" when a sibling row exists for the enabled production configuration. -- Keeps the route contract pinned.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add a row asserting the reap sentence mirrors no route literal and is distinct from `wikiDirectorySweep`. Read sources through the file's existing `libSource(file)` helper rather than re-inlining `readFile(path.resolve(__dirname, ...))`. If an import-cycle tripwire is added, scan the whole of `src/lib/storage/` (not just `filesystem.ts`) and match every spelling that would close the cycle — `../read-only`, `@/lib/read-only`, and a dynamic `import("...read-only")` — or the tripwire does not assert the invariant it claims. Do not hand-write pairwise `not.toBe` checks that the suite's exhaustive uniqueness loop already covers. -- The new key joins the one-owner rule.

- `src/lib/storage/types.ts` and `src/lib/raw.ts` -- the `StorageProvider` contract docs (`types.ts` ~:39 and ~:193) and `raw.ts`'s ~:123 argument for keeping Source arrivals out of a batch scope all state that the filesystem provider publishes create-only writes with `fs.link` "rather than `rename`". The fallback makes that unconditional claim false; restate it as "publishes by `fs.link`, falling back to a probe-then-`rename` under the publication lock where the mount has no hard links". `types.ts` ~:41 also points readers at `storage-fs.test.ts`/`storage-r2.test.ts` for the one-of-two-creators-wins property — add the fault-identity suite to that pointer, since the fallback's version of that row lives there. -- A contract doc a future provider author reads must not describe a mechanism the provider no longer always uses.

**Acceptance Criteria:**
- Given a filesystem whose `fs.link` fails with a link-less code, when `writeFileIfAbsent` and `writeAssetIfAbsent` are called on absent paths, then both publish their bytes whole and return `true`, and no `.tmp-*.tmp` remains.
- Given two concurrent create-only calls on one absent path while `fs.link` fails with a link-less code, when both complete, then exactly one returns `true` and the published bytes are that winner's.
- Given a stranded scratch file older than the grace window and a second one written moments ago, when the maintenance scan runs without `?dry=1`, then the aged file is gone, the fresh one remains, and the response reports the reaped count.
- Given `YOPEDIA_READONLY` is set, when `POST /api/tasks/scan` is called, then it still answers 403 with `READ_ONLY_REFUSAL.maintenanceScan` and the reaper never runs.
- Given a link-less filesystem and a destination whose `fs.stat` fails with a non-`ENOENT` code, when a create-only write is attempted, then it rejects with that stat error and the destination's existing bytes are unchanged.
- Given more stranded scratch files than `STRANDED_SCRATCH_CANDIDATE_CAP`, when the reaper runs twice, then the first pass reclaims exactly the cap and the second reclaims the remainder.
- Given one aged scratch file whose removal fails and one that can be removed, when the reaper runs, then it returns 1, removes the reachable file, and does not reject.
- Given the whole suite, when `pnpm test` runs, then every previously passing test still passes.

## Design Notes

The fallback, in shape (inside the existing lock, after `writeSyncedNewFile`):

```ts
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return false;
  if (!LINKLESS_CODES.has(code ?? "")) throw error;
  // No hard links here. The publication lock is a real lockfile, so the
  // probe-then-rename below is exclusive against every creator that takes it.
  // ONLY ENOENT means "absent". Any other stat error rethrows: answering
  // "absent" for a destination we merely could not read would let the rename
  // below replace published bytes and report success.
  const occupied = await fs.stat(abs).then(
    () => true,
    (e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    },
  );
  if (occupied) return false;
  await fs.rename(tmp, abs);
  return true;
}
```

`fs.rename` still publishes atomically, so the fallback loses only the lock-independent exclusivity of `link` — not the whole-or-nothing guarantee. The reaper keys on `mtime` rather than birthtime because `mtime` is the time of the last byte written: an in-flight write's scratch is always seconds old, and the grace window is a generous margin over that, in the same spirit as `ORPHAN_SWEEP_GRACE_MS`.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-fs-fault-identity.test.ts src/lib/__tests__/storage-r2.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/scan-route.test.ts src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm lint` -- expected: no new errors

## Spec Change Log

- **Link-fallback behaviour rows moved from `storage-fs.test.ts` to `storage-fs-fault-identity.test.ts`.** The Tasks list placed the fallback's success/occupied rows in the real-fs suite, which cannot host them: no filesystem reachable from the test host answers `link(2)` with a link-less code, and `vi.spyOn` cannot patch a single export of an ESM namespace (`Cannot spy on export 'link'. Module namespace is not configurable in ESM`). All fallback rows therefore live in the fault-identity suite, whose passthrough mock leaves everything but `link`/`rename` as the real `node:fs/promises`, so bytes really land and the no-scratch assertions really read the directory. `storage-fs.test.ts` instead gained the reaper's real-fs provider rows, which it can host. Matrix coverage is unchanged; only the file placement differs.

- **Review pass 1 (bad_spec): the fallback probe swallowed every `stat` error, plus four verification/doc gaps.** Triggering findings: (1) the Design Notes sketch and the `filesystem.ts` task both prescribed `await fs.stat(abs).then(() => true, () => false)`, which answers "absent" for a destination that merely could not be read — the `fs.rename` that follows then REPLACES published bytes and returns `true`, violating the intent-contract's "existing bytes never touched either way" on the one path that exists to preserve it; (2) the reaper's per-entry fail-soft and its base-path-vs-subdirectory error asymmetry had no provider-level test — mutation-testing showed rethrowing per-entry keeps all suites green, and a single unremovable file would then silently zero every subsequent pass; (3) `STRANDED_SCRATCH_CANDIDATE_CAP` was exported but never asserted, so deleting the cap guard shipped green while its sibling `ORPHAN_SWEEP_CANDIDATE_CAP` is pinned; (4) `storage/types.ts` and `raw.ts` state that create-only publication uses `fs.link` "rather than `rename`", which the fallback makes false.

  **Amended:** the `filesystem.ts` task and the Design Notes sketch now require `ENOENT`-only absence with every other stat code rethrown; the test tasks now require provider-level rows for per-entry skip, base-vs-subdirectory asymmetry and the cap; a new task covers the `types.ts`/`raw.ts` doc claims; and smaller corrections were folded in (no misleading `Object.freeze` on a `Set`, an accurate dynamic-import rationale, `toBe(fault)` over `toBeInstanceOf(Error)` on R2, binary-door parity on the fallback rows, `libSource()` reuse and a whole-directory multi-spelling import-cycle tripwire, and honest test names). Three acceptance criteria were added for the newly pinned behaviours.

  **Known-bad state avoided:** a create-only door that silently overwrites an existing published file whenever the destination is unreadable, and a reaper whose two self-healing guarantees are carried by comments alone.

  **KEEP (must survive re-derivation):** `LINKLESS_CODES` = `EPERM`/`ENOSYS`/`EXDEV`/`EOPNOTSUPP`/`ENOTSUP` and its docblock reasoning, with `link` tried first on every call and `EEXIST` → `false`; the fallback inside the existing `withFilesystemPublicationLock` body with scratch cleanup in `finally` that never replaces the publication error; `STRANDED_SCRATCH_GRACE_MS` = 1h with its WHY-A-WINDOW / WHY-MTIME / WHY-WIDER-THAN-`ORPHAN_SWEEP_GRACE_MS` docblock; `STRANDED_SCRATCH_CANDIDATE_CAP` = 500 with its cost-bound and no-cursor rationale; the reaper skipping `LOCK_DIR`, fail-soft per entry, base-path `readdir` failure propagating; `READ_ONLY_REFUSAL.scratchFileReap`'s exact sentence and the docblock paragraph naming it beside `wikiDirectorySweep`; the `maintenance.ts` wrapper shape (`assertWritable` before the try, `isFilesystemStorage()` guard, `instanceof` narrow, `logger.error` + `return 0`); the route wiring under `!forceDry` with `scratchFilesReaped` in the log line, the response body and the handler docblock; the test placement recorded in the entry above; and every row that already passed across the six suites.

## Review Triage Log

### 2026-09-01 — Review pass

- intent_gap: 0
- bad_spec: 4: (high 0, medium 3, low 1)
- patch: 7: (high 0, medium 0, low 7)
- defer: 0
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[bad_spec]` `createOnlyWrite`'s link-less fallback probed the destination with `fs.stat(abs).then(() => true, () => false)`, so a non-`ENOENT` stat failure read as "absent" and the following `fs.rename` replaced published bytes while returning `true`. Spec task and Design Notes sketch amended to require `ENOENT`-only absence; every other stat code rethrows. Code reverted and re-derived.
  - `[medium]` `[bad_spec]` The reaper's per-entry fail-soft and its base-path-vs-subdirectory error asymmetry had no provider-level test (the wrapper row mocks the whole method); mutation-testing confirmed rethrowing per-entry keeps every suite green. Spec test tasks amended to require those rows in `storage-fs.test.ts`.
  - `[medium]` `[bad_spec]` `storage/types.ts` and `raw.ts` state that create-only publication uses `fs.link` "rather than `rename`", which the fallback makes false. New spec task covers those contract docs.
  - `[low]` `[bad_spec]` `STRANDED_SCRATCH_CANDIDATE_CAP` was exported but never asserted — deleting the cap guard shipped green, unlike its pinned sibling `ORPHAN_SWEEP_CANDIDATE_CAP`. Spec test tasks amended to require a cap row that imports the constant.
  - `[low]` `[patch]` `Object.freeze(new Set(...))` does not freeze a Set's contents; the guarantee was the `ReadonlySet` type alone. Misleading `freeze` dropped.
  - `[low]` `[patch]` The wrapper's docblock claimed `await import(...)` keeps the module graph loose, but `maintenance.ts` statically imports `./storage`, which statically imports `./filesystem`. Rationale corrected.
  - `[low]` `[patch]` The R2 "keeps a fault distinguishable" row used `.rejects.toBeInstanceOf(Error)` in a fault-IDENTITY suite; changed to `.rejects.toBe(fault)` and the contrast pinned on both doors.
  - `[low]` `[patch]` `writeAssetIfAbsent` had only a happy-path row on the fallback; given its own occupied-destination and error-identity rows.
  - `[low]` `[patch]` The parity test re-inlined `readFile(path.resolve(__dirname, ...))` instead of the file's own `libSource()` helper.
  - `[low]` `[patch]` The import-cycle tripwire matched one spelling in one file while claiming a `src/lib/storage/`-wide invariant; widened to the directory and to every spelling that would close the cycle.
  - `[low]` `[patch]` A scan-route row titled "on a normal scan" asserted the maintenance-OFF configuration while a sibling row covered the enabled one; renamed for what it sets up.

### 2026-09-01 — Review pass (2)

- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 0
- reject: 23: (high 0, medium 0, low 23)
- addressed_findings:
  - `[medium]` `[patch]` The fallback's stated exclusivity source — the cross-process publication lockfile — was unpinned. Both creators in the concurrency row enter `withFilesystemPublicationLock`, whose first act is `withFileLock`, an in-process promise chain (`src/lib/lock.ts:69`); a reviewer bypassed lockfile creation entirely and every row in the suite still passed. Added `control.onRename`, which fires inside the fallback's publication window, and a row asserting `.storage-locks/` holds exactly `sha256(abs).lock` at that moment and is empty afterwards. The concurrency row's comment no longer claims what it cannot show.
  - `[low]` `[patch]` The fallback's probe used `fs.stat`, which follows symlinks, so a DANGLING symlink at the destination read as absent and the `fs.rename` replaced it returning `true`, where `fs.link` answers `EEXIST` → `false` — the one create-only contract divergence between the primary and fallback publications. Switched to `fs.lstat` (`link(2)` never follows its newpath), ENOENT-only absence unchanged, plus a dangling-symlink row.
  - `[low]` `[patch]` `maintenance.ts`'s non-filesystem short-circuit (`isFilesystemStorage()` false → `0`) is the one branch only the wrapper suite can cover, and it had no row while its two reaping rows duplicated provider-level ones. Added it, asserting `logger.error` was never called so the `0` is not vacuous.
  - `[low]` `[patch]` The LOCK_DIR row's comment claimed a reaper without the skip "would start deleting locks out from under live writers", but `publicationLockPath` names lockfiles `<sha256-hex>.lock`, which can never match `TMP_ARTIFACT`. Guard and row kept; comment corrected to name the skip as a naming-drift backstop.

## Auto Run Result

Status: done

**Implemented change.** `createOnlyWrite` still publishes by `fs.link` on every call, but a refusal whose code is in `LINKLESS_CODES` (`EPERM`/`ENOSYS`/`EXDEV`/`EOPNOTSUPP`/`ENOTSUP`) now selects a probe-then-`rename` fallback inside the publication lock it already holds, so a mount without hard links serves every Source arrival instead of throwing (DW-573). `EEXIST` still answers `false`; every other code still rethrows verbatim; the probe treats only `ENOENT` as absent and uses `lstat`, so it asks about the name rather than what it points at. `FilesystemStorageProvider.reapStrandedScratchFiles` walks the data directory for `.tmp-<uuid>.tmp` files older than a one-hour grace window and reclaims them — the only thing that ever reclaims scratch a dead process stranded, which `listFiles` hides from every caller (DW-292) — gated by `READ_ONLY_REFUSAL.scratchFileReap` through a fail-soft `maintenance.ts` wrapper the scan route calls beside the orphan sweep. Fault-identity coverage now spans the create-only door on both providers (DW-574).

**Files changed.**
- `src/lib/storage/filesystem.ts` -- `LINKLESS_CODES`, the probe-then-`rename` fallback in `createOnlyWrite`, and `reapStrandedScratchFiles` with `STRANDED_SCRATCH_GRACE_MS` / `STRANDED_SCRATCH_CANDIDATE_CAP`.
- `src/lib/read-only.ts` -- `READ_ONLY_REFUSAL.scratchFileReap` and the docblock paragraph naming it beside `wikiDirectorySweep`.
- `src/lib/maintenance.ts` -- the fail-soft `reapStrandedScratchFiles()` wrapper, `assertWritable` before the try.
- `src/app/api/tasks/scan/route.ts` -- the reaper under the `!forceDry` gate, `scratchFilesReaped` in the log line, the response body and the handler docblock.
- `src/lib/storage/types.ts`, `src/lib/raw.ts` -- the create-only contract docs restated as link-with-fallback.
- `src/lib/__tests__/storage-fs-fault-identity.test.ts` -- the fallback's behaviour and fault-identity rows, the lockfile-held-across-publication row, the dangling-symlink row.
- `src/lib/__tests__/storage-fs.test.ts` -- provider-level reaper rows: per-entry skip, base-vs-subdirectory asymmetry, the candidate cap.
- `src/lib/__tests__/storage-r2.test.ts` -- `.rejects.toBe(fault)` rows on both create-only doors.
- `src/lib/__tests__/maintenance.test.ts` -- the wrapper suite, including the non-filesystem short-circuit.
- `src/lib/__tests__/scan-route.test.ts` -- reported count, `?dry=1` suppression, rows named for the configuration they set up.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the mirrors-no-route row and the directory-wide import-cycle tripwire.

**Review findings.** Pass 1: 4 bad_spec (spec amended, code re-derived), 7 patches, 14 rejects. Pass 2: 4 patches applied (1 medium, 3 low), 0 deferred, 23 rejected.

**Follow-up review recommendation:** `true`. This pass patched 1 medium and 3 low findings; 3 x 1 + 1 x 3 = 6, which is 5 or more.

**Verification.**
- `pnpm vitest run` over the six touched suites -- 6 files, 263 passed.
- `pnpm test` -- 359 files, 8769 passed, 1 skipped (the skip is pre-existing).
- `pnpm lint` -- no errors (only the pre-existing `jsx-ast-utils` notices).
- `npx tsc --noEmit` -- clean.
- Matrix test audit: all nine I/O matrix rows are covered by tests that ran and passed.
- Mutation-checked: removing the cap guard, rethrowing per-entry, collapsing the base-path rejection to a skip, swallowing every probe error, dropping the `occupied` branch, reverting `lstat` to `stat`, bypassing lockfile creation in `withFilesystemPublicationLock`, deleting the `isFilesystemStorage()` guard, and adding a `../read-only` import under `src/lib/storage/` each turn a test red.

**Residual risks.**
- No test host can present a filesystem that actually refuses `link(2)`, so the fallback is staged by injecting a link-less errno into a mocked `node:fs/promises` on a real POSIX tmpdir. What is pinned is that the branch is taken and behaves, including that the on-disk lockfile is held across its probe/rename window -- not that a real exFAT or FUSE mount serves an arrival end to end.
- Two `storage-fs.test.ts` rows use `chmod` and are `it.skipIf(process.getuid?.() === 0)`, so they self-skip as root and would lose their force on Windows. They ran in every pass here.
- The reaper's separation of a stranded scratch file from a live write's rests entirely on the one-hour `mtime` window, as the intent contract accepted. A write suspended past that window would have its scratch reclaimed underneath it.
