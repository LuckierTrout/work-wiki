---
title: 'Content-addressed binary writers onto the create-only door, and a directory signal for the archive collision probe'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
baseline_revision: '8f85003c0652d3cbc12b61ca2127fce4728929bd'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      A tenant path whose ANCESTOR segment is a file makes the archive collision
      probe rethrow a raw `ENOTDIR`, leaking the server's absolute filesystem
      path into the API error body.
    evidence: |-
      `parseArchive` stats `tenants/<t>/<entry.path>`. When an ancestor segment
      is a regular file (e.g. `tenants/alice/raw/atlas` is a file and the entry
      is `raw/atlas/source.bin`), `fs.stat` raises `ENOTDIR`, `isEnoent` answers
      false, and the `catch` rethrows it unchanged. That is the same class DW-701
      addresses — a path no write this import can ever land at — but it surfaces
      as `ENOTDIR: not a directory, stat '/abs/host/path/...'` rather than an
      archive-relative message, and `src/app/api/archive/import/route.ts:21`
      maps it to a 500 whose JSON body carries that host path. Pre-existing: the
      same rethrow predates the `readAsset` -> `stat` swap, and no test pins it.
    location: >-
      src/lib/portable-archive.ts:246
    severity: low
---

<intent-contract>

## Intent

**Problem:** FR-2's "stored bytes are never mutated" exclusivity is enforced only on the `raw.ts` arrival path: `document-sources.ts` publishes originals and extracted figures, and `fetch.ts` publishes content-addressed page images, through `writeAsset` — the provider's OVERWRITE door — so a second arrival at an already-occupied content-addressed key rewrites frozen bytes. Separately, `parseArchive`'s collision probe now uses `stat`, which succeeds on a directory where the old `readAsset` raised `EISDIR` and rethrew, so a tenant path occupied by a DIRECTORY is recorded as an ordinary collision and silently skipped under `collision: "skip"` instead of failing the import loudly.

**Approach:** Move the three CONTENT-ADDRESSED binary writers onto `writeAssetIfAbsent`, treating an occupied key as a no-op success because the key's digest makes the stored bytes identical by construction. Then widen `FileInfo` with an `isDirectory` flag that both providers populate, and have the archive probe reject an entry whose tenant path is a directory instead of filing it as a collision.

## Boundaries & Constraints

**Always:**
- An occupied content-addressed key is a SUCCESS, not an error: the caller returns the same path/record it would have returned had it created the object, and never falls back to `writeAsset`.
- A provider error from `writeAssetIfAbsent` propagates exactly as the `writeAsset` error did — visibly failing the arrival — never degrading to an overwrite.
- `FileInfo.isDirectory` is REQUIRED (not optional): both providers set it, so a new provider cannot silently omit it and re-open DW-701.
- R2 reports `isDirectory: false` unconditionally — its keyspace is flat and `head` only ever answers for a real object, so there is no directory to report.
- `stat`'s existing cross-provider size invariant is untouched.

**Block If:**
- Making a writer create-only would change which BYTES a caller's returned path resolves to (i.e. the key is not content-addressed).

**Never:**
- Do NOT migrate `downloadImages` (`src/lib/fetch.ts:543`). Its key is `assets/<slug>/<url-derived filename>` with a per-call dedup counter — NOT content-addressed. Overwrite is the intended semantics there: a later fetch of the same page refreshes a changed remote image at the same name, and a create-only door would strand the stale bytes while the rewritten markdown still pointed at them.
- Do not add a separate `isDirectory(path)` method to `StorageProvider`; the probe already calls `stat`, and a second round trip is exactly the cost DW-679 removed.
- Do not change `collision: "skip"` / `"overwrite"` handling for ordinary file collisions.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh document source | `preserveDocumentSources` with bytes whose `originals/<tenant>/<slug>/<digest>-<file>` key is absent | Object created; returned record's `originalKey` names it | No error expected |
| Re-dropped document source | Same call, key already holds bytes | Stored bytes are byte-for-byte UNCHANGED; the record still names that `originalKey` and the figures still append | No error expected |
| Re-dropped extracted figure | Same source re-preserved, `assets/<slug>/source-<digest>-<n>-<name>` occupied | Stored figure bytes unchanged; `publicPath` unchanged | No error expected |
| Re-uploaded image | `storeImageBytes` with bytes whose `assets/<slug>/<digest>-<name>` key is occupied | Stored bytes unchanged; same `{ localPath, filename }` returned | No error expected |
| Create-only door fails | Provider throws from `writeAssetIfAbsent` | The arrival fails | Error propagates to the caller; no `writeAsset` fallback |
| Archive entry vs. existing file | `tenants/<t>/<path>` is a file | Recorded in `collisions` (unchanged) | No error expected |
| Archive entry vs. directory | `tenants/<t>/<path>` is a directory | `parseArchive` REJECTS the whole archive, naming the path | Throws; inspection and import both fail loudly |
| Archive entry absent | `stat` raises ENOENT | Recorded in `newFiles` (unchanged) | No error expected |

</intent-contract>

## Code Map

- `src/lib/storage/types.ts` -- `FileInfo` (line ~99) carries only `size` + `lastModified`; add `isDirectory`. `stat` docblock at ~line 325; `writeAssetIfAbsent` contract at ~line 404 (create-only, returns `true` for creator / `false` when occupied, THROWS rather than degrading). Header docblock section 2/3 lists the asset and create-only doors — keep it truthful.
- `src/lib/storage/filesystem.ts:528` -- `stat` returns `{ size: st.size, lastModified: st.mtime }` from `fs.stat`; `st.isDirectory()` is already in hand.
- `src/lib/storage/r2.ts:165` -- `stat` returns from `bucket.head`; `head` is null for any non-object key, so `isDirectory` is always `false`.
- `src/lib/document-sources.ts:165` -- `storage.writeAsset(originalKey, source.bytes)`; `originalKey` = `rawRelPath("originals/<tenant>/<slug>/<shortDigest>-<filename>")`, `shortDigest` = first 16 hex of the SHA-256 computed at line 159.
- `src/lib/document-sources.ts:174` -- `storage.writeAsset(rawRelPath("<RAW_ASSETS_DIR>/<slug>/source-<shortDigest>-<i+1>-<name>"), asset.bytes)`; keyed by the SOURCE digest + extraction index, so an occupied key means the same source re-extracted to the same figure.
- `src/lib/fetch.ts:663` -- `getStorage().writeAsset(rawRelPath(localPath), bytes)` inside `storeImageBytes`; its docblock already explains why the key is content-addressed (DW-693) and names `writeAsset`'s overwrite as the hazard the digest works around — update it to say the door is now create-only.
- `src/lib/fetch.ts:543` -- `downloadImages`' `writeAsset`. READ-ONLY EVIDENCE, do not change: `filename` comes from `sanitizeImageFilename(url)` plus a per-call `usedNames` counter, so the key is URL-derived and overwrite is intentional.
- `src/lib/raw.ts:191-202, 318-336` -- `publishSourceBytesFirstWrite` / `storeRawSourceBytes`: the reference shape for this migration (log-and-rethrow on provider failure, occupied ⇒ leave the bytes).
- `src/lib/portable-archive.ts:236-251` -- the collision probe; the comment block above it documents the deliberate `readAsset` → `stat` swap AND the directory regression this spec closes. Rewrite that comment to match the new behavior.
- `src/lib/errors.ts:94` -- `isEnoent`, the probe's absent-vs-error discriminator.
- `src/lib/__tests__/portable-archive.test.ts:349` -- "probes for collisions with stat, never by reading the existing file" pins that `readAsset` is not called during inspection; the new directory case must not break it.
- `src/lib/__tests__/storage-fs.test.ts:192` / `storage-r2.test.ts:408` -- `stat` suites assert per-field, not object shape, so widening `FileInfo` does not disturb them.
- `src/lib/__tests__/document-sources.test.ts` -- real `FilesystemStorageProvider` over a temp `DATA_DIR`; pre-occupying a key is a plain `getStorage().writeAsset(...)` in the test body.
- `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md:145` -- FR-2, the invariant this restores.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- add a required `isDirectory: boolean` to `FileInfo` with a docblock stating what it answers and that a flat-keyspace provider reports `false`; refresh the `stat` docblock so the directory signal is part of the contract -- a new provider must answer the question the archive probe now asks.
- `src/lib/storage/filesystem.ts` -- return `isDirectory: st.isDirectory()` from `stat` -- the fact is already in the `fs.Stats` the call fetched, at no extra syscall.
- `src/lib/storage/r2.ts` -- return `isDirectory: false` from `stat`, with a one-line comment on why the keyspace admits no other answer -- keeps the two providers' contracts explicit rather than accidental.
- `src/lib/portable-archive.ts` -- in `parseArchive`, throw naming the entry path when the successful `stat` reports a directory, before pushing to `collisions`; rewrite the probe comment so it no longer documents the swallowed-directory behavior as deliberate -- restores the loud failure the pre-DW-679 `EISDIR` rethrow gave.
- `src/lib/document-sources.ts` -- publish both the original and each extracted figure through `writeAssetIfAbsent`, ignoring the boolean with a comment explaining that an occupied content-addressed key already holds these exact bytes -- closes the FR-2 window on the document-source path.
- `src/lib/fetch.ts` -- publish `storeImageBytes` through `writeAssetIfAbsent` and update its docblock, which currently names `writeAsset`'s overwrite as the hazard the digest merely works around -- the door now enforces what the digest only made safe.
- `src/lib/__tests__/document-sources.test.ts` -- add cases for the re-dropped original and the re-dropped figure: pre-write sentinel bytes at the digest-derived key, run `preserveDocumentSources`, assert the sentinel survives and the returned record still names the key -- pins create-only publication, not just the call.
- `src/lib/__tests__/fetch.test.ts` -- add a case pre-occupying `storeImageBytes`' key and asserting the stored bytes are unchanged while the returned `localPath`/`filename` are unchanged -- pins that "occupied" is a success, not an error or a different path.
- `src/lib/__tests__/portable-archive.test.ts` -- add a case that replaces a tenant file with a DIRECTORY at the same path and asserts `inspectPortableArchive` rejects naming that path (and that a plain file collision still lands in `collisions`) -- pins DW-701's loud failure.
- `src/lib/__tests__/storage-fs.test.ts`, `src/lib/__tests__/storage-r2.test.ts` -- assert `stat` reports `isDirectory` correctly (filesystem: `false` for a file, `true` for a directory; R2: `false`) -- the cross-provider contract needs a pin in both suites.

**Acceptance Criteria:**
- Given a content-addressed key already holding bytes, when `preserveDocumentSources` or `storeImageBytes` runs for those same bytes, then the stored object is byte-for-byte unchanged and the caller receives the same key/path it would have on creation.
- Given the storage provider throws from `writeAssetIfAbsent`, when a document source or image is stored, then the error propagates and no overwrite is attempted.
- Given a tenant path occupied by a directory, when an archive naming that path is inspected or imported, then the call rejects with an error naming the path, under both `collision: "skip"` and `"overwrite"`.
- Given a tenant path occupied by a file, when an archive is inspected, then that path is still reported in `collisions` and inspection still makes no `readAsset` call.
- Given any `StorageProvider` implementation, when `stat` succeeds, then the returned `FileInfo` carries `isDirectory` and its `size` still equals `readAsset(path).byteLength`.

## Design Notes

Why an occupied key is a no-op success rather than an error, per writer:

- `originals/<tenant>/<slug>/<shortDigest>-<filename>` — `shortDigest` is derived from `source.bytes`, so the same key implies the same bytes.
- `assets/<slug>/source-<shortDigest>-<index>-<name>` — keyed by the SOURCE digest plus the extraction index, so the same key implies the same source re-extracted to the same figure.
- `assets/<slug>/<digest>-<name>` — `digest` is of the image bytes (DW-693).

In all three the second writer would have written the bytes already present, which is precisely the case `writeAssetIfAbsent` returns `false` for. The value is discarded deliberately; leave a comment saying so, so a later reader does not mistake it for a dropped error.

The `stat` widening is preferred over an `isDirectory(path)` method because the probe already makes exactly one `stat` per manifest entry, and DW-679's whole point was removing a second trip per entry.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/document-sources.test.ts src/lib/__tests__/fetch.test.ts src/lib/__tests__/portable-archive.test.ts src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/storage-r2.test.ts` -- expected: all pass, including the new create-only and directory-collision cases
- `pnpm exec tsc --noEmit` -- expected: no errors (confirms both providers satisfy the widened `FileInfo`)
- `pnpm test` -- expected: no new failures across both projects

## Auto Run Result

Status: done

**Implemented change.** The three CONTENT-ADDRESSED binary writers now publish through the provider's create-only door, closing FR-2's "stored bytes are never mutated" window outside `raw.ts` (DW-572); and `FileInfo` gained a required `isDirectory` flag so the archive collision probe can tell an occupied FILE from a tenant path blocked by a DIRECTORY and reject the archive loudly instead of filing it as an ordinary collision (DW-701).

**Files changed.**
- `src/lib/document-sources.ts` -- the original and each extracted figure publish via `writeAssetIfAbsent`; comments state exactly what each key is addressed by.
- `src/lib/fetch.ts` -- `storeImageBytes` publishes via `writeAssetIfAbsent`; docblock updated. `downloadImages` deliberately left on `writeAsset` (URL-derived key, refresh semantics).
- `src/lib/storage/types.ts` -- required `FileInfo.isDirectory`; `stat` and `writeAssetIfAbsent` contracts and the header's asset-door rule brought in line with what the repo actually does.
- `src/lib/storage/filesystem.ts` -- `isDirectory: st.isDirectory()` from the `Stats` already fetched.
- `src/lib/storage/r2.ts` -- `isDirectory: false`; the keyspace is flat.
- `src/lib/portable-archive.ts` -- `parseArchive` rejects an entry whose tenant path is a directory, naming the path, before recording a collision.
- `src/lib/__tests__/{document-sources,fetch,portable-archive,storage-fs,storage-r2}.test.ts` -- create-only publication, failure propagation without overwrite fallback, the directory rejection under both collision policies, the `downloadImages` overwrite exclusion, and `isDirectory` on both providers.

**Review findings breakdown.** 5 patches applied (2 medium, 3 low), 1 item deferred (low), 5 items rejected. Rejected: a truncated-digest key collision and a partial-object-at-an-occupied-key hazard (both contradicted by the providers' documented never-partial guarantee, and neither caused by this change); a probe-to-write TOCTOU whose recovery is re-running the import, as that function already documents; the still-open check-then-write windows in `silo.ts` `copyAsset` and `illustration.ts`, which the ledger entries do not name; and the archive route's coarse 500 mapping, which treats every archive state rejection alike and predates this change.

**Follow-up review recommendation.** Patched findings by severity: high 0, medium 2, low 3. Score: no high-severity patch, so `followup_review_recommended: false`.

**Verification performed.**
- `pnpm exec tsc --noEmit` -- exit 0, no output (both providers satisfy the widened `FileInfo`; only two implementations exist).
- `pnpm exec vitest run --project node` over the five touched suites -- 5 files, 234 passed.
- `pnpm test` -- 372 files, 9293 passed, 1 skipped, 0 failures.
- Every I/O matrix row is covered by a case that ran and passed in the runs above; the new discriminating assertions were mutation-verified (the fix reverted, the test observed to fail, then restored).

**Residual risks.**
- The extracted-figure key is addressed by the SOURCE digest plus the extraction index, not by the figure bytes. Freezing it means that if `document-extract.ts` ever produces different output for an unchanged source, the stored figure stays while the record and the "Source figures" markdown are rewritten with the new metadata. This is documented at the call site as the accepted cost; the fix, if it ever bites, is an extractor version in the key rather than reopening the overwrite door.
- The create-only door ships the whole body before the precondition can reject it, so a re-dropped large document now pays a full write where `writeAsset` also did — no regression, but the cost does not shrink.
- The directory rejection surfaces as a generic `Error`, like every other `parseArchive` rejection, so the archive import route answers 500 rather than 400. That mapping is unchanged by this work and applies equally to its sibling rejections.
