---
title: 'DW-293 / DW-679 — batched write door, bulk embedding upsert, and bound-before-read on the archive paths'
type: 'refactor'
created: '2026-09-01'
status: 'in-review'
baseline_revision: '5634a670b194741dff71c7df3386eac11ddaf28d'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every whole-file write costs two real fsyncs — `writeSyncedNewFile`'s `handle.sync()` on the payload plus `candidate.sync()` on the ephemeral publication lock file — and nothing bounds that on the paths that write in a loop: `importPortableArchive` writes once (twice with the compatibility copy) per manifest entry, `createOwnerBackup`/`verifyOwnerBackup` once per asset, and `rebuildVectorStore` reloads AND rewrites AND fsyncs the whole `.indexes/embeddings.json` once per vector (measured: 100 provider writes = 200 fsyncs = 817ms on this machine). Separately `buildPortableArchive` pulls each asset fully into memory and only then tests `totalBytes > MAX_BYTES`, so the object that trips the 500 MB ceiling is materialised to copy zero bytes of it (DW-679), and `parseArchive`'s collision probe reads whole existing files to answer a yes/no question.

**Approach:** Keep the per-write fsync as the default for single writes, and add two opt-in doors for the loop paths: `withBatchedWrites`, a scope whose members are still published by tmp+rename under the same publication lock but share ONE directory-level barrier per touched directory at scope exit, and `upsertEmbeddings`, one load/merge/store for a whole set of vectors. Drop the gratuitous fsync on the lock file, which nothing ever reads. Then apply DW-542's stat-before-read gate to `buildPortableArchive` and turn the collision probe into a `stat`. Pin all of it with a benchmark that counts durability barriers and index rewrites against recorded bounds.

## Boundaries & Constraints

**Always:**
- A single `writeFile` / `writeAsset` / `writeFileIfMatch` / `putIndex` / `writeFileIfAbsent` / `writeAssetIfAbsent` / `upsertEmbedding` call outside a batch still fsyncs its own bytes before publishing the name. Unchanged behaviour, unchanged `StorageProvider` docblock guarantee.
- Every write INSIDE a batch is still published by tmp + rename under the same publication lock: a reader never observes a torn file, and a rejected write leaves the destination exactly as it was. Only the durability point moves.
- A batch ends with one directory fsync per DISTINCT directory it touched, run at scope exit whether the body resolved or threw. If the body threw, the body's error is what propagates and any barrier failure is logged and swallowed; if the body resolved, a barrier failure whose `code` is one of the platform "cannot fsync a directory" codes (`EPERM`, `EISDIR`, `EINVAL`, `EACCES`, `ENOTSUP`) is swallowed and every other barrier failure propagates.
- `upsertEmbeddings(entries)` is one load + one merge + one store for the whole set: id-keyed, last-write-wins within the set, existing entries keep their stored order, new ids append in argument order. An empty array writes nothing and issues no barrier. Single `upsertEmbedding` delegates to it so the merge rule has one implementation.
- Both providers implement the two new interface members. R2 satisfies the batch door as a pass-through (a single-object PUT is already its own barrier) and `upsertEmbeddings` as one `vectorize.upsert(...)`, or one KV load/merge/put in the fallback.
- The publication lock file keeps its `wx` create, its `STALE_LOCK_MS` reclamation and its `finally` removal. Only its `sync()` goes.
- `buildPortableArchive` gates on `stat` before `readAsset` and keeps the post-read `totalBytes` test as the invariant's owner, exactly the two-check shape `createOwnerBackupUnlocked` carries. `stat` gates; it never accounts — `manifest.files[].size`, `sha256` and `totalBytes` still come only from the bytes actually read. The gate applies only to paths actually read; a purpose override is already in memory.
- `buildPortableArchive` still THROWS past `MAX_BYTES` (it does not truncate like the backup loop), and the message is unchanged.
- `parseArchive`'s collision probe uses `stat` instead of `readAsset`, keeping the same `isEnoent` → `newFiles` / otherwise-`collisions` / rethrow-anything-else branching.
- `importPortableArchive` flushes its batch before the index reconstruction that reads those pages back.

**Block If:**
- Bounding a path would require weakening the tmp+rename publication of an individual write, or making an unbatched `writeFile` non-durable.

**Never:**
- Do not batch `src/lib/raw.ts`'s ingest arrival. Its flat key and its silo mirror live in two DIFFERENT directories, so a per-directory barrier is two barriers for two writes — zero saving for a real widening of the create-only door. Record it, do not build it.
- Do not thread the batch door through `runPageLifecycleOp`, `updateIndexUnsafe`, `appendFile`, or any lifecycle write.
- Do not make the benchmark wall-clock. Milliseconds under a parallel suite are noise; the recorded bound is a count.
- Do not change the `listFiles` tmp filter, the `writeSyncedNewFile` / `writeSyncedAndPublish` default signatures' behaviour, or `MAX_BYTES` / `MAX_FILES`.
- No new dependency, no `syncfs`, no `F_FULLFSYNC`, no streaming copy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unbatched write | one `writeFile` on the fs provider | exactly 1 fsync; destination holds the complete new bytes | No error expected |
| Batch across directories | 12 writes into 3 directories | exactly 3 fsyncs; all 12 readable and whole | No error expected |
| Batch body throws | 2 writes land, then the body throws | the body's error propagates unchanged, both files readable, no `.tmp-*.tmp` left, barrier still ran | Body error wins over barrier error |
| Bulk upsert merge | `upsertEmbeddings` with a new id, a duplicate id twice, and an id already stored | one index rewrite; stored order preserved, last value wins, new id appended | No error expected |
| Bulk upsert empty | `upsertEmbeddings([])` | no write, no barrier, index bytes untouched | No error expected |
| Archive oversize gate | a tenant file that would pass `MAX_BYTES`, whose `readAsset` throws if called | `buildPortableArchive` rejects with the 500 MB message — proving the read never happened | Ceiling error, not the read's |
| Archive stat under-reports | `stat` reports 0 for a file whose bytes pass the ceiling | still rejects with the 500 MB message | Post-read check owns it |
| Collision probe | an archive entry whose tenant path exists | listed in `collisions`; `readAsset` never called for the probe | ENOENT → `newFiles`; other errors rethrow |

</intent-contract>

## Code Map

- `src/lib/storage/types.ts:139-430` -- the `StorageProvider` interface and its header docblock, which is where the atomicity contract is stated (`:21-33`) and where the two new members and their traded guarantee must be documented. `EmbeddingEntry` at `:110-117`.
- `src/lib/storage/filesystem.ts:62-117` -- `withFilesystemPublicationLock`. Line 81 `await candidate.sync()` is the gratuitous lock-file fsync to delete; the `wx` create at `:74` is what actually provides exclusion and `:93-95` reclaims by `mtimeMs`, never by contents.
- `src/lib/storage/filesystem.ts:127-152` -- `writeSyncedNewFile` / `writeSyncedAndPublish`, both exported and imported by `storage-fs.test.ts:5-10`. Their default must stay "sync then publish"; add an explicit opt-out parameter.
- `src/lib/storage/filesystem.ts:249-293` -- `atomicWriteUnlocked`: mode carry-over, tmp `.tmp-<uuid>.tmp` in the destination's own directory, cleanup that must not change which error propagates. The batch writer reuses it with the sync suppressed.
- `src/lib/storage/filesystem.ts:395-437` -- `createOnlyWrite`, the `fs.link` publication behind `writeFileIfAbsent` / `writeAssetIfAbsent`. Stays fully synced; named here so it is visibly out of scope.
- `src/lib/storage/filesystem.ts:534-598` -- `loadEmbeddings` / `saveEmbeddings` / `upsertEmbedding`: the load-modify-store-fsync per vector this replaces.
- `src/lib/storage/r2.ts:358-376` -- `upsertEmbedding`, with the Vectorize branch (`upsert` already takes an ARRAY) and the KV blob fallback; `:447-460` `loadEmbeddingsFromKV`.
- `src/lib/portable-archive.ts:88-98` -- `buildPortableArchive`'s read-then-check loop (DW-679's site). `:184-192` -- `parseArchive`'s bound check followed by the `readAsset` collision probe. `:271-311` -- `importPortableArchive`'s per-entry `writeEntry` (tenant write + optional compatibility write) inside a per-slug `withDurableLock`; `:314-352` -- the index reconstruction that reads those pages back, so the flush must precede it.
- `src/lib/backups.ts:157-198` -- `createOwnerBackupUnlocked`'s copy loop, already carrying DW-542's stat gate; the `writeAsset` at `:192` is the batch member. `:270-292` -- `verifyOwnerBackup`'s write-then-read-back loop into the disposable `restore-verification/` prefix.
- `src/lib/embeddings.ts:1199-1259` -- `rebuildVectorStore`; the per-page `withFileLock("vectors", () => storage.upsertEmbedding(...))` at `:1246-1248` is the accumulate-then-flush target. Single-page `upsertEmbedding` at `:912-941` stays as it is.
- `src/lib/lock.ts:153-172` -- `withDurableLock` short-circuits to `fn()` on the fs provider, so the archive import's per-slug locks add no writes locally. `withFileLock` is NOT reentrant (`:22-34`) — distinct keys only.
- `_bmad-output/implementation-artifacts/spec-dw-542-backup-oversize-read-avoidance.md` -- the two-check stat gate and its Design Notes; `buildPortableArchive` must copy that shape, not invent one.
- `_bmad-output/implementation-artifacts/spec-dw-293-batched-fsync-write-paths.md` -- a plan-only artifact stranded at `status: in-review` by an interrupted run (committed in `a7c6aebb` with no code). This spec supersedes it; do not implement from it and do not edit it.
- `src/lib/__tests__/storage-fs.test.ts:1-23` -- `mkdtemp` + direct `FilesystemStorageProvider` fixture; the batch door's contract cases belong here. `src/lib/__tests__/backups.test.ts:17-35` and `src/lib/__tests__/portable-archive.test.ts` -- the `DATA_DIR` + `_resetStorage()` fixture the benchmark reuses. `src/lib/__tests__/embeddings.test.ts` -- how the embed provider is mocked.
- Read-only evidence: repo-wide grep confirms only `FilesystemStorageProvider` and `R2StorageProvider` implement `StorageProvider`, so widening the interface breaks no test double. `vitest.config.ts:88-92` collects `src/**/__tests__/**/*.test.ts` into the `node` project.
- Barrier-counting idiom (verified on this machine): open any file, take `Object.getPrototypeOf(handle)`, replace `sync` with a counting wrapper, restore afterwards. A directory fsync (`fs.open(dir, "r")` then `sync()`) succeeds on darwin in ~3ms.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- add `BatchWriter`, `withBatchedWrites<T>(fn)` and `upsertEmbeddings(entries)` to `StorageProvider`, each documenting the guarantee kept (tmp+rename publication) and the one traded (per-file durability becomes per-batch, so only a caller that can re-drive its whole batch may use it) -- the interface is the contract every provider is read against.
- `src/lib/storage/filesystem.ts` -- thread an explicit "sync the payload" flag (default `true`) through `writeSyncedNewFile` / `writeSyncedAndPublish` / `atomicWriteUnlocked`; implement `withBatchedWrites` as a scope that publishes through the same locked atomic write with the flag off, collects touched directories, and fsyncs each once at exit; implement `upsertEmbeddings` as one load/merge/save with `upsertEmbedding` delegating to it; delete `candidate.sync()` from `withFilesystemPublicationLock` with a comment naming why a lock file's contents are never read -- one helper stays the single door for every whole-file write.
- `src/lib/storage/r2.ts` -- implement `withBatchedWrites` as a pass-through writer delegating to `this.writeFile` / `this.writeAsset`, and `upsertEmbeddings` as one `vectorize.upsert(...)` or one KV load/merge/put -- a single-object PUT is already its own barrier, so R2 has nothing to batch but must still satisfy the interface.
- `src/lib/portable-archive.ts` -- (a) `buildPortableArchive`: `stat` the source and test the ceiling before `readAsset`, keeping the post-read test, in DW-542's two-check shape; (b) `parseArchive`: replace the collision-probe `readAsset` with `stat`; (c) `importPortableArchive`: wrap the manifest loop in `withBatchedWrites` and route `writeEntry`'s two writes through the batch writer, flushing before the index reconstruction.
- `src/lib/backups.ts` -- wrap `createOwnerBackupUnlocked`'s copy loop and `verifyOwnerBackup`'s restore-verify loop in `withBatchedWrites`, leaving the ceiling accounting, the truncation record, the checksum read-backs and the `finally` cleanup exactly as they are -- both write a set that is re-drivable, and the verification prefix is deleted at the end regardless.
- `src/lib/embeddings.ts` -- accumulate `{ id, vector, metadata }` in `rebuildVectorStore` and flush through `storage.upsertEmbeddings` every `EMBEDDING_FLUSH_BATCH` (32) and once at the end, each flush under `withFileLock("vectors")`; count a page as `embedded` only after its flush succeeds and as `skipped` when the flush rejects, logging the failure the way the per-page catch already does -- a rebuild stops rewriting the whole index per vector without letting one bad flush kill the run.
- `src/lib/__tests__/write-batching-bounds.test.ts` -- NEW. Count `FileHandle.prototype.sync` calls (patch in `beforeEach`, restore in `afterEach`) and assert a table of named recorded bounds for: an unbatched single write, a batch over one and over three directories, `importPortableArchive`, `createOwnerBackup`, and `rebuildVectorStore`. Measure the loop paths at N and 3N items and assert the MARGINAL barriers per extra item, so fixed-cost writes on the same path cannot absorb a regression. Record beside each constant the measurement that produced it.
- `src/lib/__tests__/storage-fs.test.ts` -- add batch-door contract cases (publication is still tmp+rename inside a batch; a throwing body propagates its own error and leaves no tmp artifact; the directory barrier still runs) and `upsertEmbeddings` merge/order/empty cases -- the door must be pinned as a correctness contract, not only as a budget.
- `src/lib/__tests__/portable-archive.test.ts` -- add the DW-679 cases: a file that would pass `MAX_BYTES` whose `readAsset` throws still rejects with the ceiling message; a `stat` that under-reports still rejects; the collision probe never calls `readAsset`.

**Acceptance Criteria:**
- Given the fs provider, when the same 12 files are written first individually and then inside one batch over one directory, then the individual run issues 12 barriers and the batched run issues 1, and both leave byte-identical files.
- Given 40 embeddable pages, when `rebuildVectorStore` runs, then every page's vector is queryable afterwards and the embeddings index is stored at most `ceil(40/32) + 1` times.
- Given an archive imported at N entries and at 3N entries, when each import completes, then the barrier count grows by no more than the recorded marginal bound per extra entry, and every entry's bytes are present and readable.
- Given `pnpm test`, when the full suite runs, then it passes with no pre-existing case modified to accommodate these changes.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why a scope, not a `writeBatch(entries[])`.** The loop paths interleave per-item work between writes — a `withDurableLock` per page in the archive import, a checksum read-back per file in backup verification, ceiling accounting in the backup copy. A scope leaves those loops shaped as they are; a collect-everything-first call would force each caller to restructure and to hold every payload in memory at once.

**Why the writer is a parameter, not ambient state.** Deferring fsync for "whatever writes happen during this scope" would also catch a concurrent unrelated request's write in the same Next.js process. Only writes made through the handle passed to the body are batched.

**What the batch actually trades.** Publication stays atomic: tmp + rename, same lock, so no reader sees a torn file and no failed write disturbs the destination. What moves is durability — a directory fsync makes the NAMES durable, not the file contents, so a power loss mid-batch can leave a batch member present with unwritten bytes. Every caller wired here re-drives its whole set (archive import from the archive bytes, backup create from the tenant, backup verify into a prefix that is deleted anyway), so "redo the batch" is the recovery for all of them. That is exactly why the door is opt-in and `writeFile` keeps its own fsync.

```ts
await getStorage().withBatchedWrites(async (batch) => {
  for (const entry of inspection.manifest.files) {
    await batch.writeAsset(dest(entry), bytes(entry));
  }
}); // one fsync per touched directory, here
```

**Why the bound is counted, not timed.** The DW numbers (contributors 27ms → 5091ms) came from a parallel suite where wall-clock is dominated by contention. The invariant underneath them is "two barriers per write"; a count is deterministic across machines, and the marginal form (barriers at 3N minus barriers at N, over 2N) is stable against fixed-cost writes on the same path.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/write-batching-bounds.test.ts` -- expected: pass, every recorded bound met.
- `pnpm exec vitest run --project node src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-r2.test.ts src/lib/__tests__/storage-fs-fault-identity.test.ts src/lib/__tests__/portable-archive.test.ts src/lib/__tests__/backups.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/raw.test.ts` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: no type errors; both providers satisfy the widened interface.
- `pnpm lint` -- expected: no new errors.
- `pnpm test` -- expected: full suite green.
