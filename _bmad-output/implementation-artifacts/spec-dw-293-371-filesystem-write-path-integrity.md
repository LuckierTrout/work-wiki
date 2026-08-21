---
title: 'DW-293 / DW-371 — bounded fsync cost and exact compare-and-set on the filesystem write path'
type: 'bugfix'
created: '2026-08-21'
baseline_revision: '28ffdbbd5ad7c2185c0e0c7a35f64cac20125810'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      `importPortableArchive`'s second loop re-encodes and rewrites every page
      the first loop already published to the same compatibility path.
    evidence: |-
      Loop 1 writes `wikiRelPath(entry.path.slice("wiki/".length))` for every
      `wiki/` manifest entry; loop 2 then reads each page back, re-encodes it and
      writes the same bytes to the same path again. Loop 2 only adds value for
      tenant pages that were NOT in the archive. Pre-existing structure, but the
      new fsync budget makes the cost legible: it is a second full batch of
      barriers for bytes just written (visible in the import budget row).
    location: >-
      src/lib/portable-archive.ts:206-234
    severity: low
  - summary: >-
      The bulk doors stop at writes, so cleanup loops keep the exact per-item
      barrier cost this work removed from the write paths.
    evidence: |-
      `deleteFile` and `removeEmbedding` gained no batch counterpart. Any loop
      that deletes per item still pays one round-trip each, and
      `removeEmbedding` still rewrites and fsyncs the whole embeddings blob per
      id — the same shape `upsertEmbedding` had before `upsertEmbeddings`
      existed. Not caused by this change; surfaced by having the write half done.
    location: >-
      src/lib/storage/types.ts
    severity: low
  - summary: >-
      The filesystem CAS's check-then-publish window is narrowed to a bare
      `rename` but is not closed.
    evidence: |-
      `writeFileIfMatch` now stages and fsyncs the replacement, re-reads the
      destination to compare an exact content hash, and only then renames — so a
      writer that lands between the comparison and the rename still loses its
      update. Closing it needs a lock or a new storage primitive, which DW-371
      scoped out and this spec's Block If names explicitly. Recorded in the
      `writeFileIfMatch` and `saveConfig` docblocks rather than hidden.
    location: >-
      src/lib/storage/filesystem.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Every whole-file write in `FilesystemStorageProvider` pays a real fsync, and the production paths that write in a loop (portable-archive import, backup create/verify, document-source preservation, vector-store rebuild) pay it once per entry with nothing bounding the total — measured as 27ms→5091ms and 35ms→4854ms suite regressions. Separately, the same provider's compare-and-set is best-effort: `readFileWithEtag` resolves `fs.readFile` and `fs.stat` through an unordered `Promise.all`, so a write landing between them yields old content with a fresh etag, and the `${mtime}-${size}` etag collides for same-millisecond equal-length rewrites — so a losing CAS can win.

**Approach:** Add a bulk-write door to `StorageProvider` that stages a batch's entries and collapses their fsyncs into one durability barrier per bounded window, plus a bulk `upsertEmbeddings` that loads and saves the embeddings blob once per flush instead of once per vector; move the four loop paths onto them and pin the result with a benchmark that asserts recorded fsync budgets. Independently, make the filesystem etag a content hash computed from the bytes actually returned, and evaluate the CAS precondition after the replacement is already staged and durable so only a `rename` separates the check from the publish. Update the docblocks that record the weaker guarantee.

## Boundaries & Constraints

**Always:**
- Per-entry whole-file atomicity is preserved everywhere: a reader sees the previous whole file or the new whole file, never a blend or a truncation. A batched entry's bytes must be fsynced before any name points at them.
- Both providers implement every interface method. `R2StorageProvider` has no fsync, so its bulk doors are bounded-concurrency fan-outs of the operations it already performs.
- Behaviour visible to existing callers is unchanged: `importPortableArchive` returns the same counts, `createOwnerBackup`/`verifyOwnerBackup` produce the same manifests and checksums, `preserveDocumentSources` returns the same `StoredDocumentSource[]` in the same order, `rebuildVectorStore` returns the same `RebuildResult` and calls `onProgress` the same number of times.
- The full existing suite (`pnpm test`) passes unchanged. No existing assertion is edited to accommodate the new shape unless it pinned the `mtime-size` etag format specifically.
- Every changed guarantee is written down where the old one was recorded, not only in the new code.

**Block If:**
- Closing the CAS check-then-write window would require a lock, a new storage primitive, or a change to `StorageProvider`'s consumers beyond `config.ts` and `graphify-jobs.ts`. That window is out of scope; narrow it and record it.

**Never:**
- Do not weaken tear-freedom to buy throughput: a batch must not rename an entry whose bytes are not yet on disk.
- Do not make the batch transactional across entries, and do not claim it is.
- Do not change `appendFile`, the `.tmp-<uuid>.tmp` naming convention, or the `listFiles` filter.
- Do not add a wall-clock threshold to the benchmark — millisecond budgets are flaky under a parallel suite; count fsyncs.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Batch write | `writeBatch` with N entries (text and binary mixed) | Every entry lands whole at its path; total `FileHandle.sync()` calls ≤ N and sync barriers ≤ `ceil(N / BATCH_SYNC_WINDOW)`; no `.tmp-*.tmp` residue | No error expected |
| Batch entry faults | One entry's destination is an existing directory | The call rejects with that entry's error; no tmp residue anywhere in the batch; entries already renamed stay renamed | Original error propagates unchanged (identity preserved, as `atomicWrite` already guarantees) |
| Duplicate paths in a batch | Two entries with the same `path` | Rejects before any file is written | `Error` naming the duplicated path |
| Empty batch | `writeBatch([])` | Resolves, writes nothing, syncs nothing | No error expected |
| Bulk embedding upsert | `upsertEmbeddings` with K entries, some ids already stored | Blob loaded once and saved once; existing ids replaced in place, new ids appended; later entry wins within one call | No error expected |
| Etag stability | Same file read twice with no write between | Identical etag, prefixed `h1:` | No error expected |
| Same-millisecond equal-length rewrite | File rewritten with different content of the same byte length within one millisecond | `readFileWithEtag` returns a DIFFERENT etag than before the rewrite | No error expected |
| Losing CAS | `writeFileIfMatch` with an etag captured before another writer replaced the file | Returns `false`; destination keeps the other writer's content; no tmp residue | No error expected |
| CAS on missing file | `writeFileIfMatch` on a path that does not exist | Returns `false`; no file and no parent directory created | ENOENT swallowed; any other error propagates |
| Winning CAS | Etag still current | Returns `true`; destination replaced by rename | No error expected |

</intent-contract>

## Code Map

- `src/lib/storage/types.ts` -- `StorageProvider` interface plus the docblocks that RECORD the guarantees. `writeFile` (:120-145) carries the atomicity contract every other write cites; `FileWithEtag` (:63-68) says the fs provider "can use mtime+size"; `readFileWithEtag` (:236-241) and `writeFileIfMatch` (:243-257) carry the CAS contract; `upsertEmbedding` (:298-310). Add `writeBatch` and `upsertEmbeddings` here with their own contracts, and correct the three stale ones.
- `src/lib/storage/filesystem.ts` -- `atomicWrite` (:123-177) is the single write helper (tmp → chmod → write → `handle.sync()` → close → rename, with cleanup that preserves error identity). `readFileWithEtag` (:268-274) is the unordered `Promise.all`; `writeFileIfMatch` (:278-297) is the stat-compare-then-write. `saveEmbeddings` (:363) / `upsertEmbedding` (:370-383) are the per-vector whole-blob rewrite. `TMP_ARTIFACT` (:41) and `listFiles` (:200) already hide scratch files.
- `src/lib/storage/r2.ts` -- `writeAsset`/`writeFile` are single PUTs (:166), `readFileWithEtag` (:197) returns the RAW etag (do not touch that), `upsertEmbedding` (:258) has a Vectorize branch and a KV-blob fallback. Both new doors need an implementation here.
- `src/lib/portable-archive.ts` -- `importPortableArchive` (:147-227): loop one writes the tenant path plus an optional compatibility path per manifest entry (:173, :188); loop two re-writes every wiki page to its flat compatibility path (:216) while also reading and parsing each page. Both are batch candidates; the counts (`imported`/`skipped`) and the owner-mismatch throws must keep their current order.
- `src/lib/backups.ts` -- `createOwnerBackupUnlocked` (:76-123) writes one asset per file (:97) while accumulating `entries` and enforcing `MAX_BACKUP_BYTES`; `verifyOwnerBackup` (:163-215) writes one asset per file into a verification prefix (:183) and reads it straight back (:184). The size-cap check must still trip before anything is written.
- `src/lib/document-sources.ts` -- `preserveDocumentSources` (:135-190) writes the original (:154) and every extracted asset (:163) per source, in a nested loop, accumulating `stored`.
- `src/lib/embeddings.ts` -- `rebuildVectorStore` (:955-1010) calls `withFileLock("vectors", () => storage.upsertEmbedding(...))` per page (:999-1001), each a whole-blob rewrite + fsync. `upsertEmbedding` (:741-767) is the single-page door and stays per-write. `EmbeddingMeta` is `{ model, contentHash }`.
- `src/lib/config.ts` -- `saveConfig` (:709-745) docblock's "HOW EXACT THAT REFUSAL IS DEPENDS ON THE BACKEND" paragraph (:673-681) states the mtime-size/unordered-pair weakness verbatim; `loadConfig`'s docblock (:631-636) claims `readFileWithEtag` "adds a `stat` beside the `readFile`". Both become false.
- `src/lib/graphify-jobs.ts:219-222` -- the other CAS consumer (read etag, `writeFileIfMatch`, retry on false). Read-only for this work: it must keep working unchanged.
- `src/lib/__tests__/storage-fs.test.ts` -- provider suite. `readFileWithEtag` (:168), `writeFileIfMatch` (:182), `atomic whole-file writes` (:318) with its `inodeOf` / `tmpArtifactsIn` helpers — the conventions new provider tests follow.
- `src/lib/__tests__/backups.test.ts:14-32`, `src/lib/__tests__/portable-archive.test.ts:9-24`, `src/lib/__tests__/document-sources.test.ts:13-34` -- the `DATA_DIR` + `_resetStorage()` harness the benchmark reuses to drive real paths.
- `vitest.config.ts` -- two projects; `src/**/__tests__/**/*.test.ts` is the node project. The benchmark is a `.test.ts` there. No bench runner exists and none is added.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- add `BatchWrite` (`{ path: string; body: string | ArrayBuffer }`), `writeBatch(entries: readonly BatchWrite[]): Promise<void>` and `upsertEmbeddings(entries: readonly EmbeddingEntry[]): Promise<void>` to `StorageProvider`, each with a docblock stating exactly what it bounds and what it does not (per-entry atomicity kept, batch NOT transactional, duplicate paths rejected, later entry wins within one embedding flush). Correct `FileWithEtag`, `readFileWithEtag` and `writeFileIfMatch` to describe the content-hash etag and the narrowed check-then-publish window -- the interface is where these guarantees are recorded, so a stale line here is the defect, not a comment.
- `src/lib/storage/filesystem.ts` -- give `atomicWrite` an optional precondition evaluated AFTER the tmp file is synced and closed and BEFORE the rename, returning whether it published; add `writeBatch` (chunks of `BATCH_SYNC_WINDOW = 32`: stage+sync every entry in the chunk concurrently, then rename them, cleaning up the whole chunk's tmp files on any failure without changing which error propagates) and `upsertEmbeddings` (one `loadEmbeddings`, merge by id, one `saveEmbeddings`); replace the etag with `h1:<sha256 of the returned bytes>` so `readFileWithEtag` is a single `readFile` with no `stat`, and rewrite `writeFileIfMatch` as cheap pre-check → stage → re-check → rename -- this is the whole of DW-371's "content hash so a losing CAS cannot win".
- `src/lib/storage/r2.ts` -- implement `writeBatch` (bounded-concurrency PUTs) and `upsertEmbeddings` (one `vectorize.upsert` with every entry, or one load/merge/put on the KV fallback), noting that R2 has no fsync so the batch buys concurrency rather than durability -- the interface must be satisfiable by both providers or the door is not usable from shared code.
- `src/lib/portable-archive.ts` -- collect each loop's writes and issue them through `writeBatch` after the loop's validation, preserving the existing count and throw order.
- `src/lib/backups.ts` -- accumulate the copy targets in `createOwnerBackupUnlocked` and the verification targets in `verifyOwnerBackup`, write each set through one `writeBatch`, then read back and checksum as before -- the size cap must still refuse before any byte is written.
- `src/lib/document-sources.ts` -- accumulate the original and asset writes for all sources and issue one `writeBatch` before returning, keeping `stored` in source order.
- `src/lib/embeddings.ts` -- in `rebuildVectorStore`, accumulate successful `{ id, vector, metadata }` and flush through `withFileLock("vectors", () => storage.upsertEmbeddings(batch))` every `EMBEDDING_FLUSH_WINDOW = 32` entries and once at the end, leaving the single-page `upsertEmbedding` door unchanged; document that a crash now loses at most one unflushed window of a rebuild that is re-runnable by design.
- `src/lib/__tests__/storage-write-bounds.test.ts` -- NEW. Count `FileHandle.sync()` calls by mocking `node:fs/promises` to wrap `open`, and assert a recorded `FSYNC_BUDGET` table for: `writeBatch` at N=64, `importPortableArchive`, `createOwnerBackup`, `verifyOwnerBackup`, `preserveDocumentSources`, and `upsertEmbeddings`. Each budget is a named constant with the pre-change count in a comment beside it, so a regression fails with the number it broke -- this is the "benchmark that fails past a recorded threshold" the decision asks for.
- `src/lib/__tests__/storage-fs.test.ts` -- extend with the matrix rows the provider owns: batch atomicity, batch fault cleanup, duplicate-path rejection, empty batch, bulk embedding merge, etag change under a same-millisecond equal-length rewrite, losing/winning CAS, and CAS on a missing path creating nothing.
- `src/lib/config.ts` -- rewrite the `saveConfig` docblock paragraph that records the mtime-size/unordered-pair weakness to state the guarantee that now holds and the check-then-publish window that remains, and correct `loadConfig`'s claim that the fs `readFileWithEtag` costs an extra `stat` -- DW-371 named this docblock as where the weaker guarantee is documented, so it is part of the fix, not follow-up.

**Acceptance Criteria:**
- Given a rebuild over 64 pages, when `rebuildVectorStore` runs, then the embeddings blob is written at most `ceil(64 / 32) + 1` times instead of 64.
- Given the settings save path, when `saveConfig` is called with an `ifMatch` captured before another writer replaced the config, then it returns `{ status: "conflict" }` even if the other write had the same byte length and landed in the same millisecond.
- Given `pnpm test`, when the suite runs, then it passes with no assertion edited except ones that pinned the `mtime-size` etag format, and `src/lib/__tests__/storage-write-bounds.test.ts` reports its budgets as met.
- Given a reader of `src/lib/storage/types.ts` or `src/lib/config.ts`, when they look for what the filesystem CAS guarantees, then they find the content-hash guarantee and the remaining check-then-publish window, and no surviving sentence claiming `mtime-size` or an extra `stat`.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 22: (high 1, medium 10, low 11)
- defer: 3: (high 0, medium 0, low 3)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[high]` `[patch]` `backups.ts` buffered a whole backup in memory before one `writeBatch` (peak RSS bounded only by the 2 GB cap, where the old loop streamed) — added `BACKUP_BATCH_WINDOW = 32` and flushed inside both the create and verify loops, releasing each window before the next.
  - `[medium]` `[patch]` `verifyOwnerBackup` turned a repeated verification destination into a duplicate-path throw recorded as `verificationStatus: "failed"`, and correlated the read-back positionally — accumulator is now keyed by destination and correlated by that key.
  - `[medium]` `[patch]` `writeFileIfMatch` threw `EISDIR` on a directory destination where the old `stat` compare returned `false` — `EISDIR` now degrades to `false` like `ENOENT`.
  - `[medium]` `[patch]` `etagFor` hashed the decoded UTF-8 string, so files differing only in invalid byte sequences shared a tag while the docs stated the guarantee absolutely — now hashes the raw buffer.
  - `[medium]` `[patch]` The duplicate-path refusal keyed on the resolved path in the filesystem provider and the raw string in R2, contradicting the R2 docblock's parity claim — both normalize now, with the two-spellings row added to the R2 suite.
  - `[medium]` `[patch]` `writeBatch` accepted a batch where one entry's path is a directory prefix of another's, which concurrent staging turned into a race — refused up front alongside the duplicate check.
  - `[medium]` `[patch]` The `precondition` re-check — DW-371's headline mechanism — had zero coverage; deleting it left the suite green. Added a row that lands a competing write inside the staging flush via a new `control.onSync` hook.
  - `[medium]` `[patch]` Every fsync budget equalled the pre-change count and used `toBeLessThanOrEqual`, so a path that stopped writing or stopped fsyncing passed — budgets are exact equality now, with a read-back on every row.
  - `[medium]` `[patch]` `writeBatch` re-implemented destination-mode preservation, pinned only for the single-file door — added the sibling mode row for the batch door.
  - `[medium]` `[patch]` `writeBatch`'s documented error-identity guarantee was checked only by a bare `rejects.toThrow()` — added a `rejects.toBe(fault)` row including a failing cleanup.
  - `[medium]` `[patch]` `writeBatch`'s staging-failure branch and `rebuildVectorStore`'s flush-failure branch were both unexecuted — added coverage for each on both providers.
  - `[low]` `[patch]` R2's `writeBatch` kept issuing PUTs after a fault the caller had already handled — the worker pool stops on the first rejection.
  - `[low]` `[patch]` R2's Vectorize branch did not enforce "later entry wins" and assumed callers stayed under the upsert ceiling — dedupes by id and chunks at `VECTORIZE_UPSERT_LIMIT`.
  - `[low]` `[patch]` The embeddings flush assertion was `toBeLessThanOrEqual(3)` with a comment describing calls that never happen — pinned to the exact count.
  - `[low]` `[patch]` Tests hardcoded the window sizes while the constants were module-private, so raising either made the assertions vacuous — constants exported and used.
  - `[low]` `[patch]` The budget suite hardcoded `tenants/alice` beside a `tenantForOwner`-derived seed — both derive from one helper now.
  - `[low]` `[patch]` `FileWithEtag` claimed R2 computes its etag "the same way" — corrected to describe R2's tag as opaque (MD5, or a composite for multipart).
  - `[low]` `[patch]` `portable-archive.ts`'s loop-2 comment claimed an owner mismatch aborts before any compatibility copy is published, which loop 1's batch already contradicts — corrected.
  - `[low]` `[patch]` `onProgress` no longer implies persistence and a failed flush skips its whole window — both recorded on `rebuildVectorStore`.
  - `[low]` `[patch]` `stageBatchEntry` copied `atomicWrite`'s boxed-failure and non-`finally`-close patterns without their rationale, opened the tmp outside the guarded `try`, and inlined an `rm` instead of `discardStaged` — all three reconciled.
  - `[low]` `[patch]` The interface header filed `writeBatch` under text files though every caller uses it for assets, and the CAS docblock did not record that a content-derived tag compares state rather than history — both amended.

## Design Notes

**Why not one literal fsync per batch.** `fsync` flushes one inode's dirty pages; there is no call that makes N files durable at once, and skipping the per-file sync before `rename` is exactly the delayed-allocation hazard that produces zero-length files after a crash — it would trade tear-freedom, which the whole provider is built on, for throughput. What the batch actually collapses is the number of durability BARRIERS: within a window the syncs are issued concurrently and the filesystem group-commits them, and no entry is renamed until its window's barrier has passed. That is one round-trip's worth of latency per window instead of N serialized ones, with per-entry durability intact. Say this in the docblock in these terms; do not write "one fsync per batch".

**Why the CAS re-checks after staging.** Reading the file to compare a content hash is the exact comparison DW-371 asks for, but doing it first leaves the whole write+fsync inside the window between check and publish. Staging the replacement first, then comparing, leaves only `rename`. The cheap pre-check stays so the common refusal costs one read rather than a staged write, and so a missing path still creates no parent directory.

```ts
// filesystem.ts — the shape, not the whole method
private etagFor(content: string): string {
  return `h1:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
// atomicWrite(abs, data, precondition?) → Promise<boolean>
//   ... open tmp → chmod → writeFile → sync → close ...
//   if (precondition && !(await precondition())) { await fs.rm(tmp, { force: true }); return false }
//   await fs.rename(tmp, absPath); return true
```

**Counting fsyncs in the benchmark.** `vi.mock("node:fs/promises", …)` with `importOriginal`, returning `{ ...actual, open }` where `open` wraps the real handle so `sync()` increments a `vi.hoisted()` counter. The provider imports the namespace, so the wrapper is on the only path its syncs take; `rename`/`stat`/`readFile` stay real. Reset the counter per test.

## Verification

**Commands:**
- `pnpm test` -- expected: the whole suite passes, including the new `storage-write-bounds` budgets and the extended `storage-fs` matrix rows.
- `pnpm lint` -- expected: clean.
- `npx tsc --noEmit -p tsconfig.json` -- expected: no errors; both providers satisfy the widened `StorageProvider`.
- `grep -rn "mtime-size\|mtime.getTime" src` -- expected: no hits outside a deliberate historical note.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The filesystem storage provider's write path was hardened on both axes the bundle names. `StorageProvider` gained two bulk doors — `writeBatch` and `upsertEmbeddings` — implemented on both providers; the filesystem one stages and fsyncs a window of up to `BATCH_SYNC_WINDOW = 32` entries concurrently and renames the window only after that barrier, so per-entry tear-freedom is intact while N serialized durability round-trips collapse to `ceil(N/32)`. The four loop paths (archive import, backup create, backup verify, document-source preservation) and the vector-store rebuild moved onto them. Separately, the provider's etag became a content hash (`h1:<sha256>` over raw bytes), `readFileWithEtag` is a single read with no `stat`, and `writeFileIfMatch` became pre-check → stage → re-check → rename, so a losing compare-and-set can no longer win on a same-millisecond equal-length collision or on the old unordered `readFile`/`stat` pair.

**Files changed.**
- `src/lib/storage/types.ts` — `BatchWrite`, `writeBatch` and `upsertEmbeddings` on the interface; the `FileWithEtag`, `readFileWithEtag` and `writeFileIfMatch` contracts corrected.
- `src/lib/storage/filesystem.ts` — `atomicWrite` precondition hook, `stageBatchEntry`/`discardStaged`/`writeBatch`, `upsertEmbeddings`, content-hash etag, reshaped CAS.
- `src/lib/storage/r2.ts` — bounded-concurrency `writeBatch` and a one-call `upsertEmbeddings` (Vectorize or KV blob).
- `src/lib/storage/index.ts` — factory touch-up for the widened interface.
- `src/lib/portable-archive.ts`, `src/lib/backups.ts`, `src/lib/document-sources.ts` — loop writes accumulated per window and issued through the batch door.
- `src/lib/embeddings.ts` — `rebuildVectorStore` flushes every `EMBEDDING_FLUSH_WINDOW = 32` instead of rewriting the blob per vector.
- `src/lib/config.ts` — `saveConfig`'s backend-exactness paragraph and `loadConfig`'s extra-`stat` claim rewritten.
- `src/lib/__tests__/storage-write-bounds.test.ts` (new) — per-path fsync and barrier budgets with the pre-change figures recorded beside them.
- `src/lib/__tests__/storage-fs.test.ts`, `storage-fs-fault-identity.test.ts`, `storage-r2.test.ts`, `embeddings.test.ts` — matrix rows, fault-identity rows and window assertions.

**Review findings breakdown.** 22 patches applied, 3 items deferred, 10 rejected. No intent gaps and no spec-level defects, so no loopback was needed.

**Follow-up review recommendation:** `true`. Patched findings by severity: high 1, medium 10, low 11. The high-severity patch alone sets it; the score is 3 x 10 + 1 x 11 = 41, well past 5.

**Verification performed.**
- `npx vitest run` — 272 files, 6108 tests, all passing (up from 6094 before the review patches).
- `npx eslint` — exit 0, only the repo's pre-existing `jsx-ast-utils` plugin noise.
- `npx tsc --noEmit -p tsconfig.json` — clean; both providers satisfy the widened interface.
- `grep -rn "mtime-size\|mtime.getTime" src` — six hits, every one a deliberate historical note in a docblock or a test comment explaining what the old tag could not tell apart.
- Every I/O matrix row is covered by a test that ran and passed in that suite.
- `pnpm test` / `pnpm lint` were run as `npx vitest run` / `npx eslint`: `pnpm run` fails in this working copy with "packages field missing or empty", which is a pnpm workspace-resolution problem unrelated to this change. The underlying commands are the ones `package.json` defines.

**Residual risks.**
- The compare-and-set's check-then-publish window is narrowed to a bare `rename`, not closed. Deferred above and recorded in the code.
- The batch door is deliberately not transactional across entries: a fault leaves earlier entries published. Stated on the interface and pinned by a test, but it is a real difference from the sequential loops it replaced.
- `writeBatch` refuses duplicate and directory-prefix paths, a refusal the sequential loops did not have. Present callers pre-empt it by keying their accumulators on the destination, so no reachable input changed outcome — but a future caller passing raw external paths must dedupe.
- A failed embeddings flush now charges its whole window to `skipped`, where the per-page door charged one page. Accurate on the filesystem provider (one all-or-nothing blob write) and an over-count on a provider that could land part of a window; documented on `rebuildVectorStore`.
- The benchmark counts fsyncs and barriers, not milliseconds. It cannot fail on the wall-clock suite regressions that motivated DW-293 — those come from single writes, which the recorded decision deliberately keeps fsyncing.
