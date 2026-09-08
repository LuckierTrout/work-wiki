---
title: 'Raw source listing parity and exclusive-create store path'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `listRawSourceSnapshots` emits bogus `{slug: "sources"}` rows for any flat
      Source whose filename stem is all hexadecimal.
    evidence: |-
      The walk's second root is `raw/`, whose child directory `sources` passes
      `validateSlug`, so the flat files inside it are read as that directory's
      snapshots. `RAW_ID_RE` is `/^[a-f0-9]+$/` with no length bound, so
      `raw/sources/cafe.md` yields `{slug: "sources", rawId: "cafe"}`.
      Pre-existing — `wiki-retrieve.ts` already builds a duplicate retrieval
      document from it; this change surfaces it as a bogus CLI row too.
    location: >-
      src/lib/raw.ts:348
    severity: low
  - summary: >-
      Binary Sources are still absent from every listing, so a PDF-only
      workspace keeps reporting zero Sources.
    evidence: |-
      `listRawSourceSnapshots` skips any child not ending in `.md`, and
      `listRawSources` is non-recursive, so bytes stored by `saveRawSourceBytes`
      at `raw/sources/<slug>/<id>.<ext>` appear in neither. The DW-437 decision
      named `listRawSourceSnapshots` as the listing to move the callers onto, so
      closing this needs a separate decision about what the listing's unit is.
    location: >-
      src/lib/raw.ts:369
    severity: medium
  - summary: >-
      `storeRawSource`'s silo repair falls back to mirroring the REQUEST body
      when re-reading the stored bytes fails, which its own comment forbids.
    evidence: |-
      `stored` is initialised to `content` and only replaced on a successful
      `readFile`; the surrounding comment says copying a re-offered body "would
      show Files a Source the flat key does not hold". Pre-existing — the branch
      predates this change and no test pins it.
    location: >-
      src/lib/raw.ts:199
    severity: low
  - summary: >-
      `checkIncompleteCoverage` compares only the first readable snapshot, and a
      page that also has a flat blob never has its snapshots compared at all.
    evidence: |-
      The fallback breaks on the first snapshot that opens, and `readRawSource`
      is tried first, so a page assembled from several hashed Sources is judged
      against one of them chosen by directory-listing order. The DW-437 decision
      is about candidacy and counting; which bytes reach the LLM is a separate
      question this change did not settle.
    location: >-
      src/lib/lint-checks.ts:1040
    severity: medium
  - summary: >-
      Other content-addressed binary writers still publish through the overwrite
      door, so FR-2 exclusivity holds only for the `raw.ts` path.
    evidence: |-
      `document-sources.ts` writes `raw/originals/<tenant>/<slug>/<digest>-<file>`
      and extracted assets, and `fetch.ts` writes page images, all through
      `writeAsset`. `writeAssetIfAbsent` now exists on the provider interface, so
      migrating them is cheap — but it is outside DW-438, whose location is
      `src/lib/raw.ts:116`.
    location: >-
      src/lib/document-sources.ts:156
    severity: medium
  - summary: >-
      Both create-only filesystem writes depend on `fs.link`, which some
      filesystems do not support.
    evidence: |-
      `createOnlyWrite` publishes by hard-linking a complete tmp inode and treats
      only `EEXIST` as "occupied"; on exFAT or a FUSE/network mount without hard
      links the call would fail with `EPERM`/`ENOSYS` and every Source arrival
      would throw where the old rename-based `writeAsset` succeeded. Pre-existing
      for `writeFileIfAbsent`, which has shipped on this mechanism since DW-272.
    location: >-
      src/lib/storage/filesystem.ts:397
    severity: low
  - summary: >-
      The create-only door has no fault-identity coverage on either provider.
    evidence: |-
      `storage-fs-fault-identity.test.ts` pins that a failed publication leaves
      no scratch file and propagates the original error for `atomicWrite`;
      nothing does the same for `createOnlyWrite` (a non-`EEXIST` `fs.link`
      failure, tmp cleanup on a throwing publish) or for a rejecting R2 `put`.
    location: >-
      src/lib/__tests__/storage-fs-fault-identity.test.ts
    severity: low
baseline_revision: '8d8abab99794d9f63f1857616821c71351c7bf7f'
---

<intent-contract>

## Intent

**Problem:** Two raw-store gaps opened by hashed Intake arrivals. (DW-437) `listRawSources` is non-recursive by contract, so the CLI's `list --raw` / `status` and the `incomplete-coverage` lint check never see hashed `raw/sources/<slug>/<id>.md` arrivals. (DW-438) `storeRawSource` / `storeRawSourceBytes` check `alreadyStored(rel)` and then write as two separate steps, so two concurrent stores of the same new key can both pass the check and the later write wins, mutating bytes FR-2 declares immutable.

**Approach:** Move the callers, not the helper: point the CLI listing and the lint check at `listRawSourceSnapshots` *in addition to* `listRawSources`, exactly as `wiki-retrieve.ts:251-295` already does, leaving `listRawSources` and its documented browse contract untouched. For the store path, replace check-then-write with a single create-only provider call: `writeFileIfAbsent` already exists on `StorageProvider`, so only its binary twin `writeAssetIfAbsent` has to be added and implemented for the filesystem and R2 providers.

## Boundaries & Constraints

**Always:** `listRawSources` keeps its exact signature, non-recursive behaviour and docblock. Flat `raw/sources/<id>.md` sources stay visible everywhere they are visible today — snapshots are added, never substituted. Every new/changed store path stays first-write-only: an occupied key is left byte-for-byte as it is (FR-2). A provider that cannot complete the create-only call still fails visibly (throws) rather than degrading to overwrite. `writeAssetIfAbsent` is documented on `StorageProvider` with the same create-only contract as `writeFileIfAbsent`.

**Block If:** the create-only publication cannot be expressed on either provider without a new dependency or a behaviour change to an existing method.

**Never:** do not make `listRawSources` recursive. Do not change `readRawSource`'s flat resolve, the `/api/raw` route, or the Workbench raw page. Do not add a second `alreadyStored`-style read before a create-only write "for safety". Do not touch `saveParsedMarkdown` (deliberately overwrite-capable) or `RAW_PARSED_DIR`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLI list, hashed only | `raw/sources/alpha/abc123.md` exists, no flat sources | `list --raw` prints a row for `alpha` with filename `abc123.md` | No error expected |
| CLI list, mixed | flat `raw/sources/note.md` + hashed `alpha/abc123.md` | both rows printed, sorted by slug; no row lost | No error expected |
| CLI status count | 1 flat + 2 hashed snapshots | `Raw sources:\t3` | No error expected |
| Lint coverage, hashed slug | page `alpha` exists; only `raw/sources/alpha/abc123.md` | `alpha` is a coverage candidate and its snapshot content is compared | Unreadable snapshot: skip that slug, no throw |
| Lint listing failure | `listRawSourceSnapshots` throws | flat listing still drives the check | Swallow, `[]` for that source |
| Concurrent new-key store | two `saveRawSourceFor(slug, id, ...)` for an absent key, same tick | exactly one reports `created`; stored bytes are the winner's, unchanged by the loser | No error expected |
| Concurrent new-key bytes store | two `saveRawSourceBytes` for an absent key, same tick | exactly one reports `created`; stored bytes are the winner's | No error expected |
| Create-only call rejects | provider `writeFileIfAbsent` / `writeAssetIfAbsent` throws | the arrival fails; occupied bytes untouched | Error propagates to the caller |
| Occupied key re-store | key already holds bytes | returns `created: false`, bytes untouched, silo mirror still repaired, one `dataVersion` bump only when the repair wrote | No error expected |

</intent-contract>

## Code Map

- `src/lib/raw.ts:104-116` -- `alreadyStored`; the read half of the racy pair. Its "a store that cannot answer must not write" rationale must survive on the replacement.
- `src/lib/raw.ts:118-136` -- `mirrorSourceToSilo`; `alreadyStored` + `writeFile`, fail-soft (`return false` on throw).
- `src/lib/raw.ts:152-181` -- `storeRawSource`; `alreadyStored(rel)` then `writeFile(rel, content)`. The `false` branch re-reads the STORED bytes for silo repair and bumps only when the repair wrote — that ordering must be preserved.
- `src/lib/raw.ts:208-227` -- `storeRawSourceBytes`; the binary twin, `writeAsset`.
- `src/lib/raw.ts:229-252` -- `mirrorSourceBytesToSilo`; binary fail-soft mirror.
- `src/lib/raw.ts:337-372` -- `listRawSourceSnapshots` returns `{ slug, rawId, path }` over `raw/sources/<slug>/<hex>.md` and the legacy `raw/<slug>/<hex>.md` root, deduped by `slug/rawId`.
- `src/lib/raw.ts:556-592` -- `listRawSources`; READ-ONLY in this story. Its docblock states the non-recursive browse contract.
- `src/lib/raw.ts:470-489` -- `readRawSourceById(slug, rawId)`; the reader for a hashed snapshot. Throws "not found".
- `src/lib/wiki-retrieve.ts:251-295` -- the union pattern to mirror: flat listing in one try/catch, snapshots in a second, each source read failure logged and skipped.
- `src/cli.ts:539-556` -- `runList(raw)`; prints `${slug}\t${filename}` sorted by slug.
- `src/cli.ts:558-596` -- `runStatus()`; prints `Raw sources:\t${sources.length}`.
- `src/lib/lint-checks.ts:11` -- imports `{ listRawSources, readRawSource }` from `./raw`.
- `src/lib/lint-checks.ts:951-1005` -- `checkIncompleteCoverage`; builds `rawSlugsOnDisk` from `listRawSources()`, then reads each sampled slug with `readRawSource(slug)`.
- `src/lib/storage/types.ts:260-282` -- `writeFileIfAbsent` already declared with the create-only contract; `writeAssetIfAbsent` goes beside it (assets section is at `:227-249`).
- `src/lib/storage/filesystem.ts:397-424` -- `writeFileIfAbsent`: publication lock, `ensureParent`, `fs.open(tmp,"wx")`, `writeSyncedNewFile`, `fs.link(tmp, abs)` → `EEXIST` means `false`, tmp removed in `finally`. The exact shape `writeAssetIfAbsent` copies.
- `src/lib/storage/filesystem.ts:136-153` -- `writeSyncedNewFile(handle, content: string | Buffer)`; already binary-capable, no change needed.
- `src/lib/storage/filesystem.ts:370-374` -- `writeAsset` (`Buffer.from(data)` through `atomicWriteUnlocked`).
- `src/lib/storage/r2.ts:225-230` -- `writeFileIfAbsent`: `bucket.put(path, content, { onlyIf: { etagDoesNotMatch: "*" } })`, `result !== null`. `writeAssetIfAbsent` is the same call with the `ArrayBuffer`.
- `src/lib/storage/index.ts:64-125` -- only two implementations exist (`R2StorageProvider`, `FilesystemStorageProvider`); no other class implements `StorageProvider`, and tests spy on the real providers rather than hand-rolling fakes.
- `src/lib/__tests__/raw.test.ts:338-357` -- "refuses the write when existence cannot be confirmed (FR-2)" spies on `fileExists` to reject. That spy target disappears with `alreadyStored`; the test must be re-pointed at the create-only primitive, keeping the same invariant.
- `src/lib/__tests__/storage-fs.test.ts:233-255` and `src/lib/__tests__/storage-r2.test.ts:519-538` -- the `writeFileIfAbsent` suites ("allows exactly one concurrent creator", "does not replace a pre-existing object") to mirror for assets. The R2 mock bucket (`storage-r2.test.ts:74-120`) already honours `onlyIf.etagDoesNotMatch: "*"` for `ArrayBuffer` values.
- `src/lib/__tests__/cli.test.ts:435-515` -- `runList(true)` and `runStatus()` output assertions to extend.
- `src/lib/__tests__/lint-checks.test.ts` -- existing `checkIncompleteCoverage` coverage.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/types.ts` -- declare `writeAssetIfAbsent(path: string, data: ArrayBuffer): Promise<boolean>` in the optimistic-concurrency block beside `writeFileIfAbsent`, documenting it as the binary twin with the identical create-only contract -- the interface is the only place the two providers are held to the same shape.
- `src/lib/storage/filesystem.ts` -- implement `writeAssetIfAbsent` as the byte-for-byte analogue of `writeFileIfAbsent` (publication lock, `ensureParent`, `fs.open(tmp,"wx")`, `writeSyncedNewFile(handle, Buffer.from(data))`, `fs.link` publish, `EEXIST` → `false`, tmp cleanup in `finally`) -- hard-linking a complete inode is what makes the create exclusive without a second read.
- `src/lib/storage/r2.ts` -- implement `writeAssetIfAbsent` via `bucket.put(path, data, { onlyIf: { etagDoesNotMatch: "*" } })`, returning `result !== null` -- R2 expresses create-only natively; anything else reintroduces the race.
- `src/lib/raw.ts` -- rewrite `storeRawSource`, `storeRawSourceBytes`, `mirrorSourceToSilo` and `mirrorSourceBytesToSilo` to publish through the create-only primitives instead of `alreadyStored` + write, delete the now-unused `alreadyStored`, and carry its FR-2 "must not degrade to overwrite" rationale onto the new call sites -- one provider operation closes the check-then-write window. Preserve the existing `false`-branch behaviour exactly: re-read the stored bytes for the string mirror repair, mirror the caller's buffer for the binary one, and bump `dataVersion` only when a repair actually wrote.
- `src/cli.ts` -- in `runList(true)` and `runStatus()`, union `listRawSources()` rows with `listRawSourceSnapshots()` rows (snapshot filename `<rawId>.md`), each in its own try/catch as `wiki-retrieve.ts` does -- the CLI is the caller that moves; the helper's browse contract does not.
- `src/lib/lint-checks.ts` -- in `checkIncompleteCoverage`, add snapshot slugs to `rawSlugsOnDisk` and fall back to `readRawSourceById(slug, rawId)` when `readRawSource(slug)` finds nothing -- adding a slug the reader cannot open would silently `continue` and change nothing observable.
- `src/lib/__tests__/storage-fs.test.ts`, `src/lib/__tests__/storage-r2.test.ts` -- add `writeAssetIfAbsent` suites mirroring the `writeFileIfAbsent` ones (single concurrent winner; pre-existing object not replaced) -- the primitive's whole value is the concurrency guarantee.
- `src/lib/__tests__/raw.test.ts` -- re-point the "refuses the write when existence cannot be confirmed" test at the create-only primitive, and add concurrent-store cases for `saveRawSourceFor` and `saveRawSourceBytes` asserting exactly one `created` and untouched winner bytes -- covers the DW-438 matrix rows.
- `src/lib/__tests__/cli.test.ts` -- add hashed-only and mixed listing cases plus the `status` count -- covers the DW-437 CLI matrix rows.
- `src/lib/__tests__/lint-checks.test.ts` -- add a case where a page's only raw is a hashed snapshot and assert it becomes a coverage candidate whose snapshot content reaches the comparison -- covers the DW-437 lint matrix row.

**Acceptance Criteria:**
- Given a workspace whose only Sources are hashed `raw/sources/<slug>/<id>.md` arrivals, when `listRawSources()` is called directly, then it still returns `[]` and its signature and docblock are unchanged.
- Given `StorageProvider`, when the interface is inspected, then `writeAssetIfAbsent` is declared beside `writeFileIfAbsent` and both `R2StorageProvider` and `FilesystemStorageProvider` implement it with no `any`-cast or optional-method escape.
- Given the store path, when `src/lib/raw.ts` is inspected, then no raw-source write is preceded by a separate existence check, and `alreadyStored` no longer exists.
- Given a key that already holds bytes and a silo copy that is missing, when the same key is stored again, then the call returns `created: false`, the stored bytes are unchanged, the silo receives the STORED bytes (not the request body), and `dataVersion` bumps exactly once.
- Given `pnpm test` and `pnpm lint`, when run at the repo root, then both pass with no new failures.

## Design Notes

`writeFileIfAbsent` already exists on `StorageProvider` (`types.ts:267`) with implementations in both providers, so DW-438's ledger note that "the storage layer offers no exclusive-create primitive today" is stale for the string path — only the binary path is genuinely missing one.

Shape for the string store, mirrored for bytes with `writeAssetIfAbsent`:

```ts
const created = await getStorage().writeFileIfAbsent(rel, content);
if (!created) {
  // Occupied (FR-2): leave the bytes, repair the mirror from what is STORED.
  let stored = content;
  try { stored = await getStorage().readFile(rel); } catch (err) { logger.warn(...); }
  if (await mirrorSourceToSilo(rest, stored, options?.owner)) await bumpDataVersion();
  return false;
}
```

A throwing `writeFileIfAbsent` propagates, which is the same fail-visible outcome `alreadyStored` gave: the arrival fails and the owner retries, rather than an overwrite of immutable bytes.

## Verification

**Commands:**
- `pnpm test` -- expected: full vitest suite green, including the new `writeAssetIfAbsent`, raw concurrency, CLI listing and lint coverage cases.
- `pnpm lint` -- expected: clean, no new warnings (notably no unused-import left behind by removing `alreadyStored`).
- `pnpm exec tsc --noEmit` -- expected: clean; both providers satisfy the widened `StorageProvider`.

## Spec Change Log

_No bad_spec loopback occurred; nothing amended._

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 2, medium 3, low 4)
- defer: 7: (high 0, medium 3, low 4)
- reject: 6: (high 0, medium 2, low 4)
- addressed_findings:
  - `[high]` `[patch]` The `raw.ts` bump-placement guard in `workbench-data-version.test.ts` went vacuous — it anchored on the literal strings `writeAsset(rel, bytes)` / `writeFile(rel, content)`, which the create-only rewrite renamed, so both `indexOf` calls answered `-1` and every placement assertion passed against it. Re-anchored on the new publication calls and added `toBeGreaterThan(-1)` on each anchor so a future rename fails loudly; mutation-checked that the guard now bites.
  - `[high]` `[patch]` `listRawSourceRows` double-counted every normally-ingested page: `ingest()` writes BOTH the flat blob (`src/lib/ingest.ts:1953`) and the per-source snapshot (`src/lib/ingest.ts:2012`) for the same slug, so the plain concatenation roughly doubled `Raw sources:` and printed two rows per page. The flat row is now dropped for any slug that has snapshots; slugs without snapshots keep theirs, and a page with three distinct snapshots still counts three. Both overlap shapes tested.
  - `[medium]` `[patch]` `listRawSourceSnapshots`'s docblock claimed snapshots never appear "as extra rows in the Sources list" and the new CLI docblock repeated it while printing exactly those rows. Both corrected: `listRawSources` and the Workbench Sources surface are unchanged; the CLI listing unions.
  - `[medium]` `[patch]` Deleting `alreadyStored` also deleted its raw-scoped diagnostic, leaving a refused publication with no breadcrumb. Added `publishSourceFirstWrite` / `publishSourceBytesFirstWrite`, which log the refused key and rethrow, and recorded the cost the create-only door accepts (the whole body ships before the precondition can reject it).
  - `[medium]` `[patch]` Verification gaps in the code this change wrote: the CLI warnings were emitted but never asserted, the snapshot-listing-throws direction was untested, `runStatus` had no failing-listing case, and only one of the two deliberately symmetric lint catches was pinned. All four added; the lint one was mutation-checked against restoring `return []`.
  - `[low]` `[patch]` `storage/types.ts` header lists did not mention `writeAssetIfAbsent` in either the assets or the concurrency category.
  - `[low]` `[patch]` The `saveRawSourceBytes` concurrency assertion read `results[0].rel` while comparing against `payloads[winner]`; now `results[winner].rel`.
  - `[low]` `[patch]` The two new `checkIncompleteCoverage` catches swallowed silently in a file that routes every other swallowed failure through `logger.warn("lint", ...)`; both now warn.
  - `[low]` `[patch]` `writeAssetIfAbsent` was a line-for-line copy of `writeFileIfAbsent`; both now delegate to one private `createOnlyWrite(filePath, string | Buffer)` so the EEXIST branch, tmp cleanup and rethrow cannot drift apart.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

DW-437 moved the callers, not the helper: `listRawSources` keeps its signature, its non-recursive walk and its browse contract, while the CLI listing and the `incomplete-coverage` lint check union it with `listRawSourceSnapshots` so hashed `raw/sources/<slug>/<id>.md` Intake arrivals are counted. The CLI drops a slug's flat row when that slug has snapshots, because `ingest()` writes both keys for one page. Lint additionally falls back to `readRawSourceById`, so a snapshot-only slug is not merely counted as a candidate and then skipped.

DW-438 closed the check-then-write window: the store path is now one create-only provider call. `StorageProvider.writeFileIfAbsent` already existed (the ledger's "the storage layer offers no exclusive-create primitive today" was stale for the string path), so the genuinely missing primitive was its binary twin `writeAssetIfAbsent`, added to the interface and implemented for both providers. `alreadyStored` is gone; its FR-2 rationale lives on the two publication helpers that replaced it.

### Files changed

- `src/lib/storage/types.ts` -- declares `writeAssetIfAbsent`; header category lists updated.
- `src/lib/storage/filesystem.ts` -- one private `createOnlyWrite(path, string | Buffer)` publishing by `fs.link`; both `writeFileIfAbsent` and `writeAssetIfAbsent` delegate.
- `src/lib/storage/r2.ts` -- `writeAssetIfAbsent` via `put(..., { onlyIf: { etagDoesNotMatch: "*" } })`.
- `src/lib/raw.ts` -- `alreadyStored` removed; both stores and both silo mirrors publish create-only through `publishSourceFirstWrite` / `publishSourceBytesFirstWrite`, which name a refused key and rethrow.
- `src/cli.ts` -- private `listRawSourceRows()` unions both listings with per-listing try/catch and drops the flat row for slugs that have snapshots; `runList(true)` and `runStatus()` use it.
- `src/lib/lint-checks.ts` -- `checkIncompleteCoverage` unions both listings into its candidate set, keeps a slug to rawId map, and falls back to `readRawSourceById`.
- `src/lib/__tests__/{raw,cli,cli-status-config-load,lint,storage-fs,storage-r2,workbench-data-version}.test.ts` -- new create-only, concurrency, listing, coverage and guard-anchor cases.

### Review findings breakdown

Patches applied 9 (high 2, medium 3, low 4). Deferred 7. Rejected 6.

### Follow-up review recommendation

`true`. Patched severities: high 2, medium 3, low 4. Score = 3 x 3 + 1 x 4 = 13, and the high count is non-zero — either alone sets the flag.

### Verification performed

- `pnpm exec tsc --noEmit` -- clean.
- `pnpm lint` -- clean (the three `TSNonNullExpression` notices are pre-existing `jsx-ast-utils` noise from untouched JSX).
- Touched suites (`raw`, `cli`, `cli-status-config-load`, `lint`, `storage-fs`, `storage-r2`, `workbench-data-version`) -- 7 files, 401 tests, all passing.
- `pnpm test` -- 327 files passed / 13 failed; the 13 are exactly the `src/components/workbench/__tests__/*.tsx` jsdom suites that fail on `window.localStorage` being undefined. Confirmed pre-existing by stashing this change and reproducing the identical 13 files / 229 tests at `8d8abab9`.
- Mutation checks: perturbing the `raw.ts` publication call fails the re-anchored `workbench-data-version` guard, and restoring `return []` on the lint flat-listing catch fails the new mirror test — both new guards bite.

### Residual risks

- The 13 pre-existing broken workbench DOM suites mask any regression inside those files; nothing here touches component code.
- The lint flat-listing failure is induced through a scoped `stat` rejection, the only way to break `listRawSources` without also breaking `listRawSourceSnapshots` (both walk the same prefix) — realistic, but narrower than "the listing is unavailable".
- A re-arrival now pays a full body write before the create-only precondition rejects it. Deliberate and documented on `publishSourceFirstWrite`; the race it closes mutates bytes FR-2 promises never change.
- Seven deferred findings are recorded in frontmatter, three of them medium: binary Sources still missing from every listing, lint comparing only one snapshot per page, and the other content-addressed binary writers still using the overwrite door.
