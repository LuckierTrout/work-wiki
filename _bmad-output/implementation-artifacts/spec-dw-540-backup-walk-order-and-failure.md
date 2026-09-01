---
title: 'Owner backups walk in priority order, bound each read, and clean up a failed copy (DW-540, DW-677, DW-678)'
type: 'bugfix'
created: '2026-08-31'
baseline_revision: '484161f4f39ebb7f4ea882c8ee8e9dddcf5c0c55'
status: 'in-progress'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `walkFiles` recurses in raw `listFiles` order, so which of the owner's data survives a truncated backup is arbitrary — one oversized `revisions/` silo can consume the whole budget and drop every `wiki/` page (DW-540). The copy loop then materialises every file that fits into one `ArrayBuffer` and holds it through `sha256` with no per-file bound, so a single large object OOMs the Workers isolate long before the 2 GiB total ceiling (DW-677); and a throw mid-loop strands the objects already written under `backups/<tenant>/<id>/files/` with no manifest and no ledger line at all (DW-678).

**Approach:** Walk in explicit priority passes — `wiki/` pages first, then the rest of the owner's live data, then append-only revision history — sorting each directory listing so the result is deterministic. Add an injectable per-file byte bound that SKIPS a file too large to materialise instead of reading it, reported through a new `file-size` truncation reason. Wrap the copy in `try/catch` so a mid-copy throw deletes the orphaned backup prefix, records a `status: "failed"` create line, and rethrows unchanged.

## Boundaries & Constraints

**Always:**
- A backup whose budget is exceeded by a lower-priority silo still contains every `wiki/` page that fits.
- `walkFiles` yields the same order for the same tree on every provider — sort each listing by name; never rely on `readdir` order.
- Append-only history is BOTH revision families: `tenants/<t>/wikis/<id>/revisions/` and `tenants/<t>/wiki/.revisions/`. The second sits inside `wiki/`, so priority is decided by directory NAME anywhere in the path, not by top-level prefix alone.
- No path is yielded twice, and a tenant that fits under every limit still backs up in full and is NOT marked `truncated`.
- `truncationReason` precedence when several limits fire: `total-bytes` > `file-count` > `file-size`.
- A rethrown copy failure keeps its original error identity (`isEnoent` and `.path` still hold).
- `truncated` stays ABSENT on a whole manifest — never `false`.

**Block If:**
- The per-file bound cannot be added without changing `createOwnerBackup`'s public signature.

**Never:**
- Do not stream or chunk the copy; a bound on the read is the whole of DW-677.
- Do not prune old or failed backups beyond the one prefix the failing run itself wrote.
- Do not touch `verifyOwnerBackup`, `backupSizeLabel`, `summarizeBackup`, or the storage providers.
- Do not reclassify `raw/` as history — it is the owner's live source material, tier 2.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Oversized history silo | Many files under `wikis/x/revisions/`, a few `wiki/` pages, `maxFiles` below the total | Every `wiki/` page is in `manifest.files`; the dropped files are revisions; `truncated`/`file-count` | No error expected |
| Deterministic order | Same tree walked twice | Identical `files` order both times, name-sorted within each directory | No error expected |
| Page history is history | Files under `wiki/.revisions/<slug>/`, `maxFiles` below the total | Plain `wiki/` pages precede `.revisions` files; each path appears exactly once | No error expected |
| File over the per-file bound | One file larger than `maxFileBytes`, everything else small | That file is never `readAsset`ed and is absent from `files`; every other file is copied; `truncated` with `truncationReason: "file-size"` | No error expected |
| Per-file bound plus byte ceiling | A skipped oversize file, then the total ceiling breaks the loop | `truncationReason` is `"total-bytes"` — the reason that stopped the copy wins | No error expected |
| Copy throws mid-loop | `stat` or `readAsset` rejects on the second file | `backups/<tenant>/<id>/` no longer exists, a `backup`/`create`/`failed` ledger line is recorded, no manifest is written | The original error is rethrown unchanged |
| Whole tenant | Everything under every limit | Every file copied, `"truncated" in manifest === false` | No error expected |

</intent-contract>

## Code Map

- `src/lib/backups.ts:95-121` -- `walkFiles`: the raw-order recursion to replace with priority passes. Pushes while `files.length < maxFiles` and sets `truncated` only on ENCOUNTERING an extra file, which is what makes a tenant sitting exactly on `maxFiles` whole. Preserve that.
- `src/lib/backups.ts:16` -- `BackupTruncationReason`; `:49-60` -- `BackupLimits` / `DEFAULT_BACKUP_LIMITS`; `:335-347` -- `backupTruncationLabel`, the ONE source of the partial sentence read by the ledger detail and the health desk.
- `src/lib/backups.ts:140-226` -- `createOwnerBackupUnlocked`: the copy loop (`:157-199`), its pre-read `stat` gate and post-read invariant re-check (DW-542), then `writeManifest` + `recordOperationSafe`. `root` (`:148`) is the prefix a failure must delete.
- `src/lib/backups.ts:270-321` -- `verifyOwnerBackup`: the shape to mirror for the failure path — `status: "failed"` via `recordOperationSafe`, cleanup in `finally` with `.catch(() => undefined)`.
- `src/lib/revisions.ts:38` -- `REVISIONS_DIR_NAME = ".revisions"`, under `wiki/`. `src/lib/wiki-artifact-revisions.ts:18` -- `tenants/<t>/wikis/<id>/revisions/<file>/`. These two names are the history tier.
- `src/lib/storage/types.ts:196,240,246,254` -- `deleteFile`/`readAsset`/`stat`/`deleteDirectory` contracts; `stat(p).size === (await readAsset(p)).byteLength` is the invariant the gate rides on. `listFiles` returns names only and answers `[]` for a missing directory on BOTH providers (`filesystem.ts:315-334`, `r2.ts:97-127`) — read-only evidence, so a priority pass may target `${prefix}/wiki` unconditionally.
- `src/lib/storage/filesystem.ts:362-364` / `src/lib/storage/r2.ts:158-177` -- `deleteDirectory` is idempotent on a missing prefix (`force: true` / empty list).
- `src/lib/operation-ledger.ts:14,95-105` -- `OperationStatus` includes `"failed"`; `recordOperationSafe` never throws. Its lock key differs from the backup lock, so calling it inside `createOwnerBackupUnlocked` cannot deadlock (already done at `:216`).
- `src/lib/__tests__/backups.test.ts` -- the suite to extend. `measureTenant` (`:110`), `seedExtras` (`:96`), `seedUnfittable` (`:240`) and `spyOnStorage` (`:204`) are the reuse points; do not hand-roll new fixtures. `:296-318` pins "stats and reads exactly the files it copies, once each" — a duplicated path would fail it.
- `src/lib/__tests__/system-health.test.ts:59-82` -- reads `truncationReason: "file-count"` from an injected `{ maxFiles: 1, maxBytes: … }`; it must keep compiling and passing.
- Read-only: nothing keys off backup ledger STATUS — `SystemHealthDesk.tsx` and `system-health.ts` read `listBackupManifests`, so a new `failed` create line changes no surface.

## Tasks & Acceptance

**Execution:**
- `src/lib/backups.ts` -- add `"file-size"` to `BackupTruncationReason` and a `maxFileBytes?: number` to `BackupLimits`, with a `MAX_BACKUP_FILE_BYTES` production default in `DEFAULT_BACKUP_LIMITS` -- optional, not required, so the suite's existing `{ maxFiles, maxBytes }` ceilings keep compiling and keep meaning "production per-file bound".
- `src/lib/backups.ts` -- rewrite `walkFiles` as three ordered passes over one recursive `visit(dir, pass, inHistory)`: `pages` rooted at `${prefix}/wiki`, `live` rooted at `prefix` skipping the top-level `wiki` entry, `history` rooted at `prefix` keeping only files at or below a history directory. Sort every listing by name; skip history subtrees in the two non-history passes -- priority order plus determinism, with the early stop at `maxFiles` intact so an over-limit tenant is never fully enumerated.
- `src/lib/backups.ts` -- in the copy loop, gate the read on `size > maxFileBytes` and `continue` (recording `file-size` only when no reason is set yet) -- a bound that skips one unreadable object beats an isolate OOM, and unlike the total ceiling it must not stop the lower-priority files behind it.
- `src/lib/backups.ts` -- wrap the copy loop and `writeManifest` in `try/catch`; on catch delete `root`, `recordOperationSafe` a `backup`/`create`/`failed` line, and rethrow the original error -- no orphaned objects, and a failure that is visible in the same ledger `verifyOwnerBackup` already writes to.
- `src/lib/backups.ts` -- add the `file-size` branch to `backupTruncationLabel` -- one source for the partial sentence; a reason with no branch would silently degrade to the generic fallback.
- `src/lib/__tests__/backups.test.ts` -- add a `describe` covering every I/O Matrix row, reusing `measureTenant` / `seedExtras` / `seedUnfittable` / `spyOnStorage` -- the matrix is the contract and none of it is observable today.

**Acceptance Criteria:**
- Given a tenant whose non-`wiki/` data alone exceeds `maxFiles`, when a backup is created, then every `wiki/` page is in `manifest.files` and the ledger detail says `partial`.
- Given a copy that throws on its second file, when the rejection propagates, then `listBackupManifests` gains no entry, `backups/<tenant>/<id>/` is gone, and `listOperations` shows a `backup` `create` line with `status: "failed"`.
- Given the full suite, when `pnpm test` runs, then every pre-existing backup and system-health assertion still passes unchanged.

## Spec Change Log

## Review Triage Log

## Design Notes

The three passes exist so the early stop survives. A single walk that bucketed by tier would have to enumerate the WHOLE tenant before it could know what the top tier held, which is exactly the unbounded work `maxFiles` was added to prevent. Ordered passes keep the bound: once `truncated` is set, later passes return without listing anything. The cost is that a tenant which FITS gets its non-`wiki/` tree listed twice — paid only when nothing is dropped.

```ts
const HISTORY_DIR_NAMES = new Set(["revisions", ".revisions"]);
// in visit(): a non-history pass never descends into history…
if (childInHistory && pass !== "history") continue;
// …and the history pass keeps only what it finds inside one.
if (inHistory !== (pass === "history")) continue;
```

The per-file bound gates only the path that actually reads: a purpose override supplies its own bytes and never calls `readAsset`, so there is no read to avoid there, and gating it on the underlying file's `stat` would measure the wrong object.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/backups.test.ts src/lib/__tests__/system-health.test.ts` -- expected: all pass, including the new cases.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm test` -- expected: the full two-project run stays green.
