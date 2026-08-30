---
title: 'Create-only portability and the stranded-scratch reaper (DW-292, DW-573, DW-574)'
type: 'bugfix'
created: '2026-08-30'
status: 'in-review'
baseline_revision: '57edf489aa86496aad9f41e6051d3ccccd36d74d'
review_loop_iteration: 0
followup_review_recommended: false
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
- `src/lib/storage/filesystem.ts` -- add a module-level frozen set of link-less error codes and a rename-based fallback inside `createOnlyWrite`'s link `catch`: on a link-less code, `fs.stat` the destination and return `false` when it exists, otherwise `fs.rename(tmp, abs)` and return `true`; keep `EEXIST` → `false` and every other code rethrown. Document that the fallback's exclusivity comes from the publication lock plus the probe rather than from the link primitive, and that a failing rename's error is what propagates. -- DW-573: a link-less filesystem must still serve every Source arrival.
- `src/lib/storage/filesystem.ts` -- export `STRANDED_SCRATCH_GRACE_MS` and `STRANDED_SCRATCH_CANDIDATE_CAP`, and add a public `reapStrandedScratchFiles(olderThanMs?)` that walks `basePath` recursively (skipping `LOCK_DIR`), removes files matching `TMP_ARTIFACT` whose `mtime` is older than the window, returns the count, and swallows per-entry failures. Docblock the grace window as the in-flight-write guard, since `mtime` tracks the last byte written. -- DW-292: nothing reclaims scratch stranded by process death.
- `src/lib/read-only.ts` -- add `READ_ONLY_REFUSAL.scratchFileReap` ("Stranded scratch files cannot be reclaimed while this deployment is read-only.") and extend the docblock paragraph about sentences with no route literal to name it beside `wikiDirectorySweep`. -- One owner per server sentence.
- `src/lib/maintenance.ts` -- add exported `reapStrandedScratchFiles()`: `assertWritable(READ_ONLY_REFUSAL.scratchFileReap)` BEFORE the try so a direct library caller meets the refusal, then `isFilesystemStorage()` guard, dynamic-import the provider class, `instanceof` narrow, call it; `logger.error` + `return 0` on any fault. Docblock why it is outside `scanForMaintenance` and why the gate is here rather than in the storage layer. -- The scheduled trigger the reaper needs.
- `src/app/api/tasks/scan/route.ts` -- call it under the same `!forceDry` gate beside `sweepOrphanWikiDirs`, add `scratchFilesReaped` to the log line and response body, and extend the handler docblock's field list. -- `?dry=1` stays the one true inspection switch.
- `src/lib/__tests__/storage-fs.test.ts` -- add real-fs rows for the link fallback: link-less code with an absent destination publishes and returns `true`; with an occupied destination returns `false` and leaves the bytes; both leave no scratch. -- Covers the I/O matrix's fallback rows.
- `src/lib/__tests__/storage-fs-fault-identity.test.ts` -- extend the `control` mock with `linkError`/`renameError` and add a `createOnlyWrite` describe: a non-`EEXIST`, non-link-less link failure propagates the exact object with no scratch left; an `rm` that cannot unlink does not replace it; a failing fallback rename propagates the rename error. -- DW-574 on the filesystem provider.
- `src/lib/__tests__/storage-r2.test.ts` -- add rows where the mock bucket's `put` rejects and both create-only doors reject with that exact object. -- DW-574 on R2.
- `src/lib/__tests__/maintenance.test.ts` -- add a `reapStrandedScratchFiles` suite: an aged scratch file is reaped and counted, a fresh one survives, a read-only deployment throws the sentence, and a walk failure returns 0. -- Covers the reaper's matrix rows.
- `src/lib/__tests__/scan-route.test.ts` -- add the new export to the `@/lib/maintenance` mock factory and add rows for the reported count and for `?dry=1` suppression. -- Keeps the route contract pinned.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add a row asserting the reap sentence mirrors no route literal and is distinct from `wikiDirectorySweep`. -- The new key joins the one-owner rule.

**Acceptance Criteria:**
- Given a filesystem whose `fs.link` fails with a link-less code, when `writeFileIfAbsent` and `writeAssetIfAbsent` are called on absent paths, then both publish their bytes whole and return `true`, and no `.tmp-*.tmp` remains.
- Given two concurrent create-only calls on one absent path while `fs.link` fails with a link-less code, when both complete, then exactly one returns `true` and the published bytes are that winner's.
- Given a stranded scratch file older than the grace window and a second one written moments ago, when the maintenance scan runs without `?dry=1`, then the aged file is gone, the fresh one remains, and the response reports the reaped count.
- Given `YOPEDIA_READONLY` is set, when `POST /api/tasks/scan` is called, then it still answers 403 with `READ_ONLY_REFUSAL.maintenanceScan` and the reaper never runs.
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
  if (await fs.stat(abs).then(() => true, () => false)) return false;
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
