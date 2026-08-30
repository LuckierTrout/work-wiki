---
title: 'Gate the backup byte ceiling on stat, not on a completed read (DW-542)'
type: 'refactor'
created: '2026-08-30'
status: 'done'
baseline_revision: '57edf489aa86496aad9f41e6051d3ccccd36d74d'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The backup copy loop still materialises every file that DOES fit, in full,
      and holds it through `sha256`, so one large-but-fitting object can exhaust
      the Workers isolate long before the 2 GiB total ceiling is reached.
    evidence: |-
      `createOwnerBackupUnlocked` reads each fitting file with `readAsset` into a
      whole ArrayBuffer, then hashes and writes it. There is no per-file size
      guard and no streaming/chunked copy. `MAX_BACKUP_BYTES` is 2 GiB while the
      Workers isolate memory limit is a small fraction of that, so the OOM
      arrives from a single large object rather than from the ceiling that was
      designed to stop it. DW-542 removed the wasted read of a file that does
      NOT fit; it does not bound the read of one that does.
    location: >-
      src/lib/backups.ts:176-186
    severity: low
  - summary: >-
      A throw partway through the copy loop leaves already-written backup files
      orphaned with no manifest and no ledger line, and nothing ever prunes them.
    evidence: |-
      `createOwnerBackupUnlocked` has no try/catch: when `stat` or `readAsset`
      rejects mid-copy, the files already written under
      `backups/<tenant>/<id>/files/` stay forever, `writeManifest` never runs, and
      unlike `verifyOwnerBackup` — which records a `status: "failed"` operation —
      no ledger line is recorded at all. `backups.ts` has no pruning of any kind,
      so repeated failures accumulate silently and invisibly. Pre-existing; the
      new `stat` call rejects on exactly the same path the read did.
    location: >-
      src/lib/backups.ts:139-198
    severity: low
  - summary: >-
      `buildPortableArchive` has the read-then-check shape DW-542 just replaced
      in the backup loop.
    evidence: |-
      It calls `readAsset` on each file, adds `data.byteLength` to `totalBytes`,
      and only then throws past `MAX_BYTES` — so the object that trips the 500 MB
      limit is pulled fully into memory before the failure. It throws rather than
      truncating, so its observable contract differs from the backup loop's, but
      the read-avoidance argument applies unchanged.
    location: >-
      src/lib/portable-archive.ts:89-92
    severity: low
---

<intent-contract>

## Intent

**Problem:** `createOwnerBackupUnlocked` calls `getStorage().readAsset(sourcePath)` and only *then* tests `totalBytes + data.byteLength > limits.maxBytes`, so the first object that does not fit is materialised in memory in full to copy zero bytes of it — on every backup run, worst exactly where the 2 GB production ceiling matters.

**Approach:** Ask `StorageProvider.stat(path)` for the size first and break on the byte ceiling before the read, leaving the accounting (`totalBytes` from real copied bytes), the truncation record (`truncated` / `truncationReason: "total-bytes"`), and the manifest shape byte-for-byte identical.

## Boundaries & Constraints

**Always:**
- The break condition stays `totalBytes + <size> > limits.maxBytes` — strictly `>`, never `>=`, so a tenant sitting exactly on `maxBytes` is still a whole backup.
- `totalBytes`, `BackupFileEntry.size`, and `sha256` keep coming from the bytes actually read and written (`data.byteLength` / `data`), never from `stat`'s reported size. `stat` gates; it does not account.
- `totalBytes` never exceeds `limits.maxBytes` even if `stat` under-reports what `readAsset` then returns.
- The file-count ceiling and its `truncationReason: "file-count"` precedence rule are untouched: `total-bytes` still overwrites `file-count` when the byte ceiling stops the copy earlier in the same list.
- A file listed by `walkFiles` but gone by copy time still rejects the backup (`stat` throws the same not-found identity `readAsset` did).

**Block If:**
- `StorageProvider.stat` turns out not to be implemented by a provider the backup path runs on.

**Never:**
- Do not change `walkFiles`, `verifyOwnerBackup`, `writeManifest`, the ledger line, or `BackupManifest`'s shape.
- Do not add a new storage-interface method, a size cache, or a streaming/chunked copy — this is a read-avoidance gate, nothing more.
- Do not make `stat` failures non-fatal or swallow them.
- Do not relax the existing byte-ceiling boundary tests to accommodate the new gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Whole backup | Tenant fits under both ceilings | Every file copied; `truncated`/`truncationReason` ABSENT; one `stat` per file | No error expected |
| Exactly on `maxBytes` | Tenant holds exactly `maxBytes` bytes | Not truncated; `totalBytes === maxBytes` | No error expected |
| Oversized object | A file that would pass the ceiling, whose `readAsset` throws if called | `truncated: true`, `truncationReason: "total-bytes"`, `totalBytes` counts only what landed, the oversized path is absent from `files`, and the backup SUCCEEDS — proving the read never happened | No error expected; a thrown read would fail the test |
| File vanishes after walk | `walkFiles` listed a path since deleted | `createOwnerBackup` rejects, as before | Not-found error propagates from `stat` |

</intent-contract>

## Code Map

- `src/lib/backups.ts:152-170` -- `createOwnerBackupUnlocked`'s copy loop. Line 153 is the unconditional `readAsset`; 154-159 is the post-read ceiling test that sets `truncationReason = "total-bytes"` and breaks. This is the only edit site.
- `src/lib/backups.ts:40-58` -- `BackupLimits` / `DEFAULT_BACKUP_LIMITS` (10k files, 2 GiB). Injectable precisely so both truncation paths are reachable from small fixtures; tests pass tiny ceilings.
- `src/lib/backups.ts:99-119` -- `walkFiles` yields only non-directory paths, so every path handed to `stat` is a file that existed at walk time.
- `src/lib/storage/types.ts:228` -- `stat(path: string): Promise<FileInfo>`; `FileInfo` at `:67-73` is `{ size: number; lastModified: Date }`. Throws if the file does not exist.
- `src/lib/storage/filesystem.ts:354-358` -- `stat` = `fs.stat(this.resolve(path))`; `:376-378` `readAsset` = `fs.readFile(this.resolve(path))`. Same path resolution, same ENOENT identity, and `st.size === buf.byteLength`.
- `src/lib/storage/r2.ts:147-156` -- `stat` = one `bucket.head()` (`head.size`); `:187-193` `readAsset` = `bucket.get()` + `arrayBuffer()`. Both throw `R2NotFoundError`. HEAD vs GET is exactly the saving being bought.
- `src/lib/__tests__/backups.test.ts:156-231` -- the existing byte-ceiling suite: "stops before the file that would pass the byte cap", plus the `maxBytes`-exact and one-byte-under boundary pair. These must keep passing verbatim; the new case goes beside them.
- `src/lib/__tests__/backups.test.ts:17-35` -- fixture: real `FilesystemStorageProvider` over a temp `DATA_DIR`, `_resetStorage()` in both hooks. Reuse it; do not build a fake provider.
- Fault-injection idiom in this repo: `const storage = getStorage(); vi.spyOn(storage, "readAsset").mockImplementation(...)` over the singleton — see `src/lib/__tests__/review-queue.test.ts:661` and `:861`. `vi` is not yet imported by `backups.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/backups.ts` -- in `createOwnerBackupUnlocked`'s loop, `stat` the source path and break on `totalBytes + size > limits.maxBytes` BEFORE `readAsset`; keep the post-read check on `data.byteLength` as the authority that actually guards the ceiling, and comment why both exist -- the pre-read gate is the read-avoidance; the post-read one keeps `totalBytes <= maxBytes` true even when `stat` and the read disagree.
- `src/lib/__tests__/backups.test.ts` -- add a case beside the byte-ceiling suite that seeds an oversized file, spies on the storage singleton's `readAsset` to THROW for that one path, and asserts the backup still succeeds and reports `truncationReason: "total-bytes"`. Import `vi`. Also assert the whole-backup case reads every file it copies, so the gate cannot degrade into skipping files that fit.

**Acceptance Criteria:**
- Given a tenant whose next file would pass `maxBytes` and whose `readAsset` throws for that file, when `createOwnerBackup` runs, then it resolves with `truncated: true` and `truncationReason: "total-bytes"` rather than rejecting — the read was never attempted.
- Given a tenant that fits entirely under both ceilings, when `createOwnerBackup` runs, then no `truncated` key is present, every file is in `files`, and `readAsset` was called once per copied file.
- Given the whole existing suite, when `pnpm exec vitest run --project node src/lib/__tests__/backups.test.ts` runs, then every pre-existing case passes unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 3: (high 0, medium 0, low 3)
- reject: 5: (high 0, medium 1, low 4)
- addressed_findings:
  - `[medium]` `[patch]` The post-read ceiling check was unpinned — deleting it left the whole suite green, because `stat` and `readAsset` never disagree on the fixture provider. Added a case that spies `stat` to report `size: 0` for one path and asserts the post-read check still stops the copy with `totalBytes <= maxBytes`; mutation-confirmed it is the only failure when that branch is removed.
  - `[medium]` `[patch]` The matrix's "one `stat` per file" row was covered by no test. The whole-backup case now spies `stat` as well as `readAsset` and asserts the statted set equals the copied set exactly, once each.
  - `[low]` `[patch]` The oversize case dropped the `totalBytes === sum(files[].size)` assertion both its siblings carry — the one that catches a gate accounting `stat`'s size instead of the copied bytes. Added.
  - `[low]` `[patch]` The oversized file was a hard-coded 4,096 bytes, so fixture growth would have made it fit and failed the case for the wrong reason. It is now sized from the measurement (`bytes + 1`), oversized by construction.
  - `[low]` `[patch]` The vanished-file case passed on pre-change code and asserted only `isEnoent`. It now also asserts `readAsset` was never asked for the path and that the error names `vanished.md`, pinning `stat` as the rejecter.
  - `[low]` `[patch]` The loop comments asserted the trade away. Rewritten to name the extra `stat` per file as a real cost, the OVER-reporting direction as uncaught (a fitting tenant recorded `truncated`), and the new `stat`→read window as a second not-found path.
  - `[low]` `[patch]` Dropped the no-op `String(target)` / `String(prefix)` coercions in the spies, which would have masked a signature change.
  - `[low]` `[patch]` The loop now silently requires `stat(p).size === (await readAsset(p)).byteLength` of every provider, which `StorageProvider` never promised. Documented as a cross-provider invariant in `src/lib/storage/types.ts`, on the header list and on `FileInfo.size` / `stat()`.

## Design Notes

Two checks, not one, and that is deliberate:

```ts
for (const sourcePath of walked.files) {
  // stat is a HEAD (R2) / statx (fs); readAsset is the whole object. Ask the
  // cheap question first so the file that does not fit is never materialised.
  const { size } = await getStorage().stat(sourcePath);
  if (totalBytes + size > limits.maxBytes) { truncationReason = "total-bytes"; break; }
  const data = await getStorage().readAsset(sourcePath);
  // stat's answer is a moment old; the copied bytes are the accounting, so the
  // ceiling is re-tested against them. Normally both agree and this never fires.
  if (totalBytes + data.byteLength > limits.maxBytes) { truncationReason = "total-bytes"; break; }
  ...
}
```

The pre-read gate is a pure optimisation; the post-read test remains the invariant's owner. That is what makes this change safe to reason about: nothing downstream of the loop can observe a difference, because the condition that ultimately decides the break is still evaluated on the bytes that were actually read.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/backups.test.ts` -- expected: all cases pass, including the new oversized-read-avoidance case and the untouched `maxBytes` boundary pair.
- `pnpm lint` -- expected: no new errors.
- `pnpm exec tsc --noEmit` -- expected: no new type errors.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `createOwnerBackupUnlocked` now asks `StorageProvider.stat(path)` for a file's size and breaks on the byte ceiling BEFORE calling `readAsset`, so the object that does not fit is no longer materialised in full to copy zero bytes of it. The post-read check on `data.byteLength` is retained as the invariant's owner: `stat` gates, it never accounts, so `totalBytes`, each entry's `size` and its `sha256` still come only from the bytes actually read, and `totalBytes <= maxBytes` holds even when `stat` under-reports. The manifest shape, the `file-count` → `total-bytes` precedence, `walkFiles`, `writeManifest`, `verifyOwnerBackup` and the ledger line are untouched.

**Files changed.**
- `src/lib/backups.ts` -- the `stat` gate in the copy loop, plus the two comment blocks explaining why both ceiling checks exist and what the gate does not defend.
- `src/lib/__tests__/backups.test.ts` -- four new cases and a `spyOnStorage` helper over the storage singleton: the oversized object whose read throws, the `stat`-under-reports case that pins the post-read check, the whole-backup mirror asserting one stat and one read per copied file, and the vanished-file rejection.
- `src/lib/storage/types.ts` -- documents `stat(p).size === (await readAsset(p)).byteLength` as a cross-provider invariant, naming this gate as its dependent.

**Review findings breakdown.** 8 patches applied, 3 items deferred, 5 rejected, 0 intent gaps, 0 spec defects. The five rejections were all scope expansions the intent itself excludes: skipping the oversized file and continuing rather than breaking (the intent says "break"); carrying sizes through `FileEntry`/`listFiles` to avoid the extra HEAD (the intent says "Consult `StorageProvider.stat(path)`"); treating a mid-copy ENOENT as `continue` (the spec's Always keeps the rejection); "fixing" the `total-bytes` over `file-count` precedence, which is the intended semantics; and renaming a test to diverge from its sibling's established wording.

**Follow-up review recommendation:** `true`. Patched findings only: high 0, medium 2, low 6 → 3 x 2 + 1 x 6 = 12, which is >= 5.

**Verification performed.**
- `pnpm exec vitest run --project node src/lib/__tests__/backups.test.ts` -- 17/17 pass; the 13 pre-existing cases, including the `maxBytes`-exact and one-byte-under boundary pair, are unmodified.
- Mutation checks, both directions: removing the pre-read `stat` gate fails 3 of the new cases; removing the post-read check fails exactly the `stat`-under-reports case. Neither half is vacuous. Source restored and confirmed.
- `pnpm exec tsc --noEmit` -- clean. `pnpm lint` -- clean (only the three pre-existing `jsx-ast-utils` notices).
- `pnpm test` (full suite) -- 354/354 files, 8378 passed, 1 skipped. An earlier run had one failure in `research-runtime.test.ts` (a 5s `testTimeout` under full-suite load); it passes alone and in the clean full run, and shares no module with this change.
- Matrix audit: all four I/O rows are covered by a case that ran and passed.

**Residual risks.**
- The gate defends the under-reporting direction only. If a provider's `stat` OVER-reports, a tenant that would have fit is recorded `truncated: "total-bytes"` — conservative and visible, but wrong. Both shipped providers report the read length exactly (`fs.stat().size`, `head.size`), and `src/lib/storage/types.ts` now states the requirement, but no test exercises the over-report direction.
- Every backup run now pays one extra `stat` per file (an R2 HEAD on the Workers path, up to 10,000 per daily run) to avoid at most one wasted read. No test observes the round-trip count beyond "once each".
- The three deferred items above are real and untouched by this change: the unbounded per-file read, the orphaned files and missing ledger line on a mid-copy throw, and the same read-then-check shape still standing in `buildPortableArchive`.
