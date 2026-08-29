---
title: 'DW-293 — bound the per-write fsync on the paths that write in a loop'
type: 'refactor'
created: '2026-08-28'
baseline_revision: 'd426b4132d160cb017f8ef08be4283965da99344'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `FilesystemStorageProvider.atomicWriteUnlocked` fsyncs on every whole-file write, and `withFilesystemPublicationLock` fsyncs its scratch lock file on top of that — so every write costs two barriers. Nothing bounds that on the paths that write in a loop: `importPortableArchive` writes once (twice, with the compatibility copy) per archive entry, `createOwnerBackup`/`verifyOwnerBackup` once per asset, `saveRawSource*` twice per ingest arrival, and `rebuildVectorStore` rewrites AND fsyncs the whole `.indexes/embeddings.json` once per vector. Measured under the full parallel suite: contributors 27ms → 5091ms, query-history 102ms → 24204ms.

**Approach:** Keep the per-write fsync as the default for single writes, and add two doors for the loop paths: a bulk-write scope whose members are still published by tmp+rename but share ONE directory-level durability barrier at the end, and a bulk embedding upsert so a rebuild loads and stores the index once per flush instead of once per vector. Drop the gratuitous fsync on the ephemeral publication lock file. Pin all of it with a benchmark that counts durability barriers and fails when any of those paths regresses past a recorded bound.

## Boundaries & Constraints

**Always:**
- A single `writeFile` / `writeAsset` / `writeFileIfMatch` / `putIndex` / `upsertEmbedding` call outside a batch still fsyncs its own bytes before publishing the name — unchanged behaviour, unchanged docblock guarantee.
- Every write INSIDE a batch is still published by tmp + rename under the same publication lock, so a reader never observes a torn file and a rejected write still leaves the destination exactly as it was. Only the durability point moves.
- A batch ends with one `fsync` per DISTINCT directory it touched, run once at scope exit, whether the body resolved or threw. A barrier that fails on a platform where a directory cannot be opened for fsync (Windows) is swallowed; any other barrier failure propagates.
- `upsertEmbeddings(entries)` is one load + one merge + one store for the whole set, id-keyed, last-write-wins within the set, preserving the order of existing entries and appending new ids in argument order. An empty array writes nothing.
- The `StorageProvider` interface addition is implemented by BOTH providers. R2 satisfies the batch door as a pass-through (single-object PUT is already the barrier) and the bulk upsert as one Vectorize `upsert` call, or one KV load/merge/put in the fallback.
- The publication lock file keeps its `wx` create, its stale-lock reclamation and its `finally` removal. Only its `sync()` goes: a lock that survived a crash is by definition a stale lock, which `STALE_LOCK_MS` already reclaims, and nothing ever reads its contents.
- The benchmark records its bounds as named constants with the measurement that produced them, and asserts a MARGINAL bound (barriers per extra item) so unrelated fixed-cost writes on the same path cannot silently absorb a regression.

**Block If:**
- Bounding a path would require weakening the tmp+rename publication of any individual write, or making `writeFile`'s default non-durable.

**Never:**
- Do not thread the batch door through `runPageLifecycleOp`, the index writers, or any lifecycle write — the ingest reach here is the `raw/sources` flat+mirror pair and nothing more.
- Do not make the benchmark wall-clock. Milliseconds under a parallel suite are noise; the recorded bound is a count of durability barriers.
- Do not change `appendFile`, `writeFileIfAbsent`, the `listFiles` tmp filter, or the `StorageProvider` docblock guarantees for the unbatched calls.
- No new dependency, no `syncfs`, no `F_FULLFSYNC`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Single write unchanged | `writeFile("a/x.md", "hi")` outside a batch | Bytes fsynced, then renamed into place; exactly 1 barrier | Throw propagates, destination unchanged, no tmp left |
| Batch, one directory | 30 `batch.writeFile` calls under `a/` | All 30 files published; exactly 1 barrier | — |
| Batch, three directories | 30 writes spread over `a/`, `b/`, `c/` | All published; exactly 3 barriers, one per directory | — |
| Batch body throws | Body writes 2 files then throws | The 2 files stay published, the barrier still runs, the body's error propagates | Body error wins over any barrier error |
| Directory barrier unsupported | `fs.open(dir)` rejects EISDIR/EPERM/EACCES | Batch resolves normally | Swallowed; other errors propagate |
| Bulk upsert merge | `upsertEmbeddings([{id:"a"},{id:"c"}])` over stored `[a,b]` | Stored `[a',b,c]` — `a` replaced in place, `c` appended | Throw leaves the stored index untouched |
| Bulk upsert, empty | `upsertEmbeddings([])` | No read, no write, no barrier | — |
| Rebuild flush | `rebuildVectorStore` over 40 embeddable pages | Index stored at most `ceil(40/32)+1` times, every vector present at the end | A per-page embed failure still counts as skipped and does not drop the buffered flush |

</intent-contract>

## Code Map

- `src/lib/storage/types.ts` -- `StorageProvider` interface + docblocks. Add `BatchWriter`, `withBatchedWrites`, `upsertEmbeddings`. The `writeFile` docblock (l.~140) is the canonical statement of what "atomic" means here; the batch door's docblock must say exactly what it trades away against it.
- `src/lib/storage/filesystem.ts` -- `atomicWriteUnlocked` (l.249) is the single write helper; `writeSyncedAndPublish` (l.155) is where the fsync lives — thread a `sync: boolean` through rather than duplicating the helper. `withFilesystemPublicationLock` (l.63) holds the lock-file `candidate.sync()` (l.83) to delete. `saveEmbeddings` (l.522) / `loadEmbeddings` (l.510) / `upsertEmbedding` (l.532) are the embedding trio.
- `src/lib/storage/r2.ts` -- `R2StorageProvider` (l.65), `upsertEmbedding` (l.342) shows the `this.vectorize` vs KV-fallback split the bulk upsert must mirror.
- `src/lib/portable-archive.ts` -- `importPortableArchive` (l.212); the manifest loop starts l.267, `writeEntry` (l.278) does the tenant write plus an optional compatibility copy, wrapped per page in `withDurableLock("page-lifecycle:…")`.
- `src/lib/backups.ts` -- `createOwnerBackup` copy loop (l.155-172), `verifyOwnerBackup` restore-verify loop (l.253-263). Both read back what they wrote; page cache serves that regardless of the barrier.
- `src/lib/raw.ts` -- `storeRawSource` (l.158) and `storeRawSourceBytes` (l.208) each do flat write + `mirrorSourceToSilo`/`mirrorSourceBytesToSilo` (l.124 / l.235). The mirrors are FAIL-SOFT by an internal try/catch — keep that catch inside the helper so batching cannot turn a mirror failure into a failed arrival.
- `src/lib/embeddings.ts` -- `rebuildVectorStore` (l.1044), its per-page `withFileLock("vectors", () => storage.upsertEmbedding(...))` at l.1090 is the accumulate-then-flush target. Single-page `upsertEmbedding` (l.828) stays as it is.
- `src/lib/lock.ts` -- `withDurableLock` (l.153) short-circuits to `fn()` on the fs provider, so archive import adds no lock writes locally. Read the l.170 comment: fsync counting is already this repo's idiom for this cost.
- `src/lib/__tests__/portable-archive.test.ts` (l.14-27) and `src/lib/__tests__/backups.test.ts` -- the `mkdtemp` + `DATA_DIR` + `_resetStorage()` fixture to reuse for the benchmark.
- `src/lib/__tests__/embeddings.test.ts` (l.55-90) -- how the suite mocks the embed provider and seeds stored vectors; reuse for the rebuild bound.
- `src/lib/__tests__/storage-fs.test.ts` -- where the provider contract is pinned; the batch door's atomicity assertions belong beside it.
- Read-only evidence: only `FilesystemStorageProvider` and `R2StorageProvider` implement `StorageProvider` (repo-wide grep). The three suites that mock `getStorage()` (`assets-route`, `todo-extract`, `workbench-epic2-routes`) touch none of these paths.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- add the `BatchWriter` interface, `withBatchedWrites<T>(fn)` and `upsertEmbeddings(entries)` to `StorageProvider`, each with a docblock stating the guarantee kept (tmp+rename publication) and the one traded (per-file durability becomes per-batch) -- the interface is the contract every provider is read against.
- `src/lib/storage/filesystem.ts` -- give `writeSyncedNewFile`/`writeSyncedAndPublish`/`atomicWriteUnlocked` an explicit "sync this file" flag defaulting to today's behaviour; implement `withBatchedWrites` as a scope that collects touched directories and fsyncs each once at exit; implement `upsertEmbeddings` as one load/merge/save; delete `candidate.sync()` from `withFilesystemPublicationLock` with a comment naming why a lock file's durability is meaningless -- one helper stays the single door for every whole-file write.
- `src/lib/storage/r2.ts` -- implement `withBatchedWrites` as a pass-through writer delegating to `this` and `upsertEmbeddings` as one `vectorize.upsert(...)` (or one KV load/merge/put) -- a single-object PUT is already its own barrier, so R2 has nothing to batch but must still satisfy the interface.
- `src/lib/portable-archive.ts` -- wrap the manifest loop in `withBatchedWrites` and route `writeEntry`'s two `writeAsset` calls through the batch writer -- one barrier for the import instead of two per entry.
- `src/lib/backups.ts` -- wrap the `createOwnerBackup` copy loop and the `verifyOwnerBackup` restore-verify loop in `withBatchedWrites` -- both write a whole set that is re-drivable from the manifest.
- `src/lib/raw.ts` -- batch the flat write and its silo mirror on the new-write path of `storeRawSource` and `storeRawSourceBytes`, passing an optional writer into the mirror helpers and leaving their fail-soft catch where it is -- halves the ingest arrival's barriers without touching the lifecycle write path.
- `src/lib/embeddings.ts` -- accumulate `{ id, vector, metadata }` in `rebuildVectorStore` and flush through `storage.upsertEmbeddings` every `EMBEDDING_FLUSH_BATCH` (32) plus once at the end, each flush under `withFileLock("vectors")` -- a rebuild stops rewriting the whole index per vector.
- `src/lib/__tests__/write-batching-bounds.test.ts` -- NEW. Count `FileHandle.prototype.sync` calls (patch the shared prototype in `beforeEach`, restore in `afterEach`) and assert the recorded bounds table for: an unbatched single write, a batch over one and over three directories, `importPortableArchive`, `createOwnerBackup`, and `rebuildVectorStore` -- measure each path at N and 3N items and assert the MARGINAL barriers per extra item, so fixed-cost writes cannot mask a regression.
- `src/lib/__tests__/storage-fs.test.ts` -- add batch-door contract cases: publication is still tmp+rename inside a batch, a throwing body still runs the barrier and propagates its own error, no tmp artifact survives, and `upsertEmbeddings` merge/order/empty semantics -- the batch door must be pinned as a correctness contract, not only as a budget.

**Acceptance Criteria:**
- Given the fs provider, when a single `writeFile` runs outside any batch, then exactly one durability barrier is issued and the destination holds the complete new bytes.
- Given a batch that publishes files into three directories, when the scope exits, then exactly three barriers are issued regardless of how many files were written.
- Given an archive with 4 page entries and the same archive with 12, when each is imported, then the barrier count grows by at most the recorded marginal bound per extra entry.
- Given 40 embeddable pages, when `rebuildVectorStore` runs, then every page's vector is queryable afterwards and the embeddings index is stored no more than `ceil(40/32)+1` times.
- Given a batch body that throws after two writes, when the scope unwinds, then the body's error propagates unchanged, the two files are readable, and no `.tmp-*.tmp` remains.
- Given `pnpm test`, when the full suite runs, then it passes and `write-batching-bounds.test.ts` reports the bounds table.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why a scope, not a `writeBatch(entries[])`.** The loop paths interleave per-item work between writes — a `withDurableLock` per page in the archive import, a checksum read-back per file in backup verification. A scope leaves those loops shaped as they are; a collect-everything-first call would force each caller to restructure and to hold every payload in memory at once.

**Why the batch writer is a parameter, not ambient state.** Deferring fsync for "whatever writes happen during this scope" would also catch a concurrent unrelated request's write in the same Next.js process. Only writes made through the handle passed to the body are batched.

**What the batch trades.** Publication stays atomic: tmp + rename, same lock, so no reader sees a torn file and no failed write disturbs the destination. What moves is the durability point — a crash mid-batch can leave any subset of the batch's files unrecovered, and on a delayed-allocation filesystem a renamed member may be present with unwritten bytes. Every caller wired here re-drives its whole set from a manifest (archive import, backup create/verify) or is a first-write-only content-addressed arrival whose mirror already self-repairs (`raw/sources`), so "redo the batch" is the recovery for all of them. That is why the door is opt-in and `writeFile` keeps its own fsync.

```ts
await getStorage().withBatchedWrites(async (batch) => {
  for (const entry of manifest.files) {
    await batch.writeAsset(dest(entry), bytes(entry));
  }
}); // one fsync per touched directory, here
```

**Why the bound is counted, not timed.** The DW numbers (27ms → 5091ms) came from a parallel suite where wall-clock is dominated by contention. The invariant underneath them is "one barrier per write"; a count is deterministic, and the marginal form (barriers at 3N minus barriers at N, over 2N) is stable against fixed-cost writes on the same path.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/write-batching-bounds.test.ts` -- expected: pass, with every recorded bound met.
- `pnpm exec vitest run --project node src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-r2.test.ts src/lib/__tests__/portable-archive.test.ts src/lib/__tests__/backups.test.ts src/lib/__tests__/embeddings.test.ts src/lib/__tests__/raw.test.ts` -- expected: all pass.
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: no type errors (both providers satisfy the widened interface).
