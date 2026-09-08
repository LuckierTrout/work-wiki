---
title: 'DW-215 — artifact revision retention and a backup walk that degrades'
type: 'feature'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A truncated backup keeps whatever the storage walk happened to reach first, so
      which of the owner's data survives the cut is arbitrary rather than prioritised.
    evidence: |-
      `walkFiles` recurses in raw `listFiles` order and the filesystem provider returns
      `fs.readdir` order unsorted (`src/lib/storage/filesystem.ts:315-327`), so a single
      oversized silo early in the walk can consume the whole file/byte budget and every
      later prefix — including `wiki/`, the owner's actual pages — is dropped, flagged
      only as "partial". DW-215's own framing ("so a large artifact history degrades")
      reads as: the oversized history is what should fall off first. The literal
      instruction was "truncate ... instead of throwing", which this satisfies, so an
      ordering policy (walk `wiki/` before `raw/`, or exclude `revisions/` from a
      truncating pass) is a separate decision, not this story's.
    location: >-
      src/lib/backups.ts:94-120
    severity: medium
  - summary: >-
      The retention cap deletes artifact revisions silently — no surface tells the owner
      the history they are looking at is the newest 50 rather than all of them.
    evidence: |-
      The backup half carries its truncation all the way out (manifest -> `BackupSummary`
      -> `/api/system/backups` -> the health desk row). The revision half carries nothing:
      `GET /api/workbench/artifact/revisions` returns the bounded list with no `limit` or
      `truncated` sibling, and the History panel (`src/components/workbench/PreviewColumn.tsx`,
      around the `revisions.map(...)` render) shows a complete-looking list. The same
      Workbench already has `FILES_TRUNCATED_COPY` and `PREVIEW_TRUNCATED_COPY` for exactly
      this shape. The spec's Block If froze `ArtifactRevision` and the response shape, but a
      sibling response field plus a panel note would not violate it.
    location: >-
      src/components/workbench/PreviewColumn.tsx
    severity: medium
  - summary: >-
      The backup copy loop reads a file's whole contents before discovering it does not fit
      under the byte ceiling.
    evidence: |-
      `createOwnerBackupUnlocked` calls `getStorage().readAsset(sourcePath)` and only then
      tests `totalBytes + data.byteLength > limits.maxBytes`, so at the production ceiling an
      oversized object is materialised in memory in full to copy zero bytes of it — on every
      backup run. Pre-existing (the throwing version read first too), and `StorageProvider`
      already exposes `stat(path)`, which could gate the read. Not caused by DW-215; surfaced
      by reviewing the same loop.
    location: >-
      src/lib/backups.ts:155-163
    severity: low
baseline_revision: '002843ceda622c05c85084aa6052605627dcf90a'
---

<intent-contract>

## Intent

**Problem:** `saveWikiArtifactRevision` writes a full copy of the replaced artifact under `tenants/<t>/wikis/<id>/revisions/<file>/` on every `writeWikiArtifact` with no retention policy (`src/lib/wiki-artifact-revisions.ts:41` says so in as many words), and `listWikiArtifactRevisions` then `stat`s every one of them on each GET through an unbounded `Promise.all`. Unlike page revisions — which spread across slugs — these pile into ONE directory per artifact, and `src/lib/backups.ts` walks all of `tenants/<t>` and THROWS `Backup exceeds the … safety limit` at `MAX_BACKUP_FILES` / `MAX_BACKUP_BYTES`, so a long artifact history takes the owner's backup down with it.

**Approach:** Apply the recorded 2026-08-21 decision, in two independent halves. (a) Give artifact revisions a retention cap: after the snapshot lands, prune the oldest beyond `MAX_ARTIFACT_REVISIONS` (both `.md` and `.meta.json`), fail-soft; and bound the listing by picking the newest stems from the directory listing BEFORE any `stat`, so read cost is capped by the constant rather than by history length. (b) Make the backup walk and the byte accounting TRUNCATE-WITH-A-FLAG at their limits instead of throwing: the manifest records that it is partial, and the surfaces that show a backup say so.

## Boundaries & Constraints

**Always:**
- Pruning is FAIL-SOFT and happens AFTER the revision `.md` has landed, for the same reason the sidecar write is fail-soft (`wiki-artifact-revisions.ts:143-151`): a snapshot that succeeded must never be reported as failed. Warn through `logger.warn` under the existing `"wiki-artifact-revisions"` scope and swallow.
- `saveWikiArtifactRevision` takes NO lock — every caller already holds `wikis:<tenant>` and `withFileLock` is not reentrant. Pruning inherits that: no new lock, no new key.
- The listing's bound is applied on the FILENAME STEMS (`canonicalStem` sort, newest first) before the per-revision `stat`/sidecar work, not by slicing the built array afterwards.
- Retention cap and default listing bound are the SAME constant, so a history at the cap is shown whole and only a pre-cap backlog is ever elided.
- A truncated backup still writes its manifest, still records its operation-ledger line, and still verifies (`verifyOwnerBackup` walks `manifest.files`, which is the truncated set).
- Copy stays English-only; no frozen identifier is renamed.

**Block If:**
- Making the listing bounded would require changing `ArtifactRevision` or the shape `GET /api/workbench/artifact/revisions` returns.

**Never:**
- Do not add retention, pruning or a listing bound to PAGE revisions (`src/lib/revisions.ts`) — DW-215 is scoped to artifact revisions and the backup walk.
- Do not change `MAX_BACKUP_FILES` / `MAX_BACKUP_BYTES` values, and do not turn a truncated backup into a failed or unverified one in `system-health.ts`'s `backupStatus` — truncation is its own fact, reported as itself.
- No diffing, no compaction, no background sweep, no new route or new verb.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Snapshot below the cap | Fewer than `MAX_ARTIFACT_REVISIONS` revisions exist | New revision written; nothing pruned | No error expected |
| Snapshot at the cap | Exactly `MAX_ARTIFACT_REVISIONS` exist, a new one lands | Oldest revisions deleted so exactly `MAX_ARTIFACT_REVISIONS` remain; each deletion removes the `.md` AND its `.meta.json` | No error expected |
| Prune fails | `deleteFile` throws on an old revision | The new revision still stands and `saveWikiArtifactRevision` RESOLVES | `logger.warn`; never rethrown |
| Pre-cap backlog listed | More `.md` stems on disk than the bound | Newest `MAX_ARTIFACT_REVISIONS` returned, newest-first; `stat` called only for those | No error expected |
| Non-canonical stems present | `1e12.md`, `012.md` beside real stems | Ignored for both pruning and listing (`canonicalStem`) | No error expected |
| Backup over the file cap | Tenant holds more files than `maxFiles` | Manifest has exactly `maxFiles` entries and `truncated: true`, `truncationReason: "file-count"`; no throw | No error expected |
| Backup over the byte cap | Copying the next file would pass `maxBytes` | That file and the rest are omitted; `truncated: true`, `truncationReason: "total-bytes"`; `totalBytes` counts only what was copied | No error expected |
| Backup within limits | Small tenant | `truncated` absent from the manifest, exactly as today | No error expected |

</intent-contract>

## Code Map

- `src/lib/wiki-artifact-revisions.ts` -- the whole of half (a). `saveWikiArtifactRevision:157` (add prune tail), `listWikiArtifactRevisions:205` (bound before the `Promise.all` at :227), `canonicalStem:124` (reuse for both), header comment `:41-42` ("What it does NOT copy is retention: page revisions have no cap, no pruning and no diffing, and neither does this") is now FALSE and must be rewritten.
- `src/lib/wiki-paths.ts` -- `wikiArtifactRevisionPath` / `wikiArtifactRevisionsDir`, the only path spellings; reuse, do not inline.
- `src/lib/storage/types.ts:171` -- `deleteFile(path)`; "throws if the file does not exist (provider-dependent)", so a missing sidecar must not fail a prune. `listFiles:187`, `stat:216`.
- `src/lib/wikis.ts:654,1011` -- the two `saveWikiArtifactRevision` callers, both already inside `withWikiLock`. Read-only: they must keep compiling unchanged.
- `src/app/api/workbench/artifact/revisions/route.ts:222` -- the GET calls `listWikiArtifactRevisions(owner, wikiId, file)`; keep that call site as-is by giving the new bound a DEFAULT.
- `src/lib/backups.ts` -- half (b). `MAX_BACKUP_FILES:29`, `MAX_BACKUP_BYTES:30`, `walkFiles:56-68` (throws at :63-65), `createOwnerBackupUnlocked:77-124` (throws at :92-94), `BackupManifest:14-25`, `BackupSummary:27`, `createOwnerBackup:126` (note its existing defaulted-param seam sibling `isOwnerBackupDue:158`, `intervalMs = …` — same convention for injectable limits).
- `src/app/api/system/backups/route.ts:34` -- maps `/limit|invalid/i` on the message to 400. Once the walk no longer throws for size, that branch only covers `Invalid backup id`; leave it alone, it is still correct.
- `src/lib/system-health.ts:41-46,98` -- `backupStatus` derives from `verificationStatus` only. Untouched by design; `BackupSummary` inherits any new manifest field for free.
- `src/components/SystemHealthDesk.tsx:223` -- `{backup.fileCount} files · {sizeLabel(backup.totalBytes)}`; the one place an owner reads a backup's size, so the partial flag belongs on this line.
- `src/lib/__tests__/backups.test.ts` -- 51 lines, `DATA_DIR` tmpdir harness; extend here.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- the DW-59/213/214 suite; extend here.
- Read-only callers of `listWikiArtifactRevisions` that must keep their 3-arg form: `src/lib/__tests__/read-only-kernel-gate.test.ts:279`, `src/lib/__tests__/wiki-schema-edit.test.ts:656,676`.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-artifact-revisions.ts` -- export `MAX_ARTIFACT_REVISIONS = 50`; add a private `pruneArtifactRevisions(owner, wikiId, file)` that lists the dir, keeps the newest `MAX_ARTIFACT_REVISIONS` canonical stems and `deleteFile`s the rest plus their `.meta.json` (each deletion individually tolerant of ENOENT); call it from `saveWikiArtifactRevision` after the `.md` write inside a `try/catch` that only `logger.warn`s; add an optional `limit = MAX_ARTIFACT_REVISIONS` parameter to `listWikiArtifactRevisions` and apply it to the sorted canonical stems BEFORE the `Promise.all`. -- One directory per artifact grows without bound and is read in full on every GET.
- `src/lib/wiki-artifact-revisions.ts` -- rewrite the header's retention paragraph (`:37-42`) to state the cap, the prune's fail-soft position and the listing bound, and why page revisions still have none. -- The comment currently asserts the opposite of the new behaviour.
- `src/lib/backups.ts` -- add `BackupLimits { maxFiles; maxBytes }` and `DEFAULT_BACKUP_LIMITS` built from the existing constants; make `walkFiles` stop at `maxFiles` and report truncation instead of throwing; make the copy loop stop before a file that would pass `maxBytes` instead of throwing; add optional `truncated?: true` and `truncationReason?: "file-count" | "total-bytes"` to `BackupManifest`; thread an optional `limits = DEFAULT_BACKUP_LIMITS` through `createOwnerBackup`/`createOwnerBackupUnlocked`; say so in the `recordOperationSafe` detail. -- A large artifact history must degrade the backup, not fail it.
- `src/components/SystemHealthDesk.tsx` -- append a partial marker to the `{fileCount} files · {size}` line when `backup.truncated`, naming which limit stopped it. -- An owner reading "verified" must not believe a partial backup is whole.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- add cases for: pruning to exactly the cap (sidecars gone with their revisions), a prune failure leaving the new revision intact and resolving, a listing bounded to the newest `MAX_ARTIFACT_REVISIONS` over a larger on-disk backlog, and non-canonical stems ignored by both. -- The I/O matrix's revision rows.
- `src/lib/__tests__/backups.test.ts` -- add cases driving `createOwnerBackup` with small injected `limits` for both truncation reasons, plus an untruncated backup whose manifest has no `truncated` field, and a verify pass over a truncated manifest. -- The I/O matrix's backup rows, without materialising 10k files or 2 GB.

**Acceptance Criteria:**
- Given an artifact with `MAX_ARTIFACT_REVISIONS` stored revisions, when `writeWikiArtifact` snapshots one more, then the directory holds exactly `MAX_ARTIFACT_REVISIONS` `.md` files, the newest is the one just written, and no orphan `.meta.json` remains for a pruned revision.
- Given a revisions directory holding more revisions than the bound, when the Workbench History panel lists them through `GET /api/workbench/artifact/revisions`, then it receives the newest `MAX_ARTIFACT_REVISIONS` newest-first and the response shape is byte-for-byte the shape it received before this change.
- Given a tenant whose file count or byte total exceeds the backup limits, when `createOwnerBackup` runs, then it RESOLVES with a manifest that is marked truncated and names which limit stopped it, the operation ledger records a succeeded backup that says it is partial, and `verifyOwnerBackup` over that manifest passes.
- Given a tenant within both limits, when `createOwnerBackup` runs, then the manifest is identical in shape to one produced before this change — no `truncated`, no `truncationReason`.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 5, low 3)
- defer: 3: (high 0, medium 2, low 1)
- reject: 14: (high 0, medium 2, low 12)
- addressed_findings:
  - `[medium]` `[patch]` `pruneArtifactRevisions` deleted `${ts}.md` before its `.meta.json`, so a non-ENOENT sidecar failure stranded that sidecar forever (stems are discoverable only through the `.md`) — deletion order reversed, sidecar first.
  - `[medium]` `[patch]` The prune rethrew on the first non-ENOENT failure, aborting the sweep of every older revision, so one undeletable file would let the directory grow without bound — every doomed stem is now attempted, failures collected, one error thrown at the end.
  - `[medium]` `[patch]` `MAX_ARTIFACT_REVISIONS`'s value was unpinned: the suite stayed green with the cap at 3, which silently destroys 47 more revisions per artifact — added `expect(MAX_ARTIFACT_REVISIONS).toBe(50)`.
  - `[medium]` `[patch]` The backup file-cap test truncated only because the shared fixture happened to seed two files, and nothing covered a tenant at EXACTLY `maxFiles` / `maxBytes` — measured the tenant off disk and added both boundary cases plus a one-under mirror, asserting `truncated` is absent.
  - `[medium]` `[patch]` `getSystemHealth` reported `status: "healthy"` for a verified-but-partial backup, quieter than the pre-change failure (which was `backupStatus: "missing"`) — truncation now participates in `needsAttention`, with `backupStatus` and its union untouched.
  - `[low]` `[patch]` Three surfaces named one condition two ways (`total-bytes` on the manifest and ledger, `total-size` in the desk) and the marker was deletable while the suite stayed green — one `backupTruncationLabel()` beside `backupSizeLabel`, a neutral fallback for an unknown reason, and unit tests plus a `summarizeBackup` pass-through assertion.
  - `[low]` `[patch]` `slice(0, Math.max(0, limit))` turned a `NaN` limit into a silently empty history — added a `boundedLimit` guard for non-finite and fractional values.
  - `[low]` `[patch]` Three untested branches (below-cap prunes nothing, the sidecar-less ENOENT path the catch exists for, a non-default `limit`) and the desk's standing "copy your owner silo byte-for-byte" copy, now false for a truncated backup — tests added and the sentence amended.

## Design Notes

The listing bound is what makes the read cheap, and it only works because the ORDER is knowable without I/O: the filename stem IS the timestamp (`canonicalStem`), so the newest `N` can be chosen from the `listFiles` result and only those get a `stat` + sidecar read. Slicing the built array instead would keep the unbounded `Promise.all` and fix nothing.

```ts
const stems = entries
  .filter((e) => !e.isDirectory && e.name.endsWith(".md"))
  .map((e) => canonicalStem(e.name.slice(0, -3)))
  .filter((t): t is number => t !== null)
  .sort((a, b) => b - a)
  .slice(0, limit);
```

Pruning is deliberately a WRITE-TIME sweep of the same directory rather than a bound derived from the listing: the listing no longer sees past the bound, so it cannot be the thing that names what to delete.

`BackupLimits` as a defaulted parameter follows `isOwnerBackupDue`'s existing `intervalMs = 24 * 60 * 60 * 1_000` seam — it keeps the two production constants untouched while making both truncation paths reachable from a test that writes four small files.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/backups.test.ts` -- expected: all pass, including the new cases.
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/system-health.test.ts src/lib/__tests__/scan-route.test.ts` -- expected: unchanged, all pass (the existing 3-arg `listWikiArtifactRevisions` callers and the backup consumers).
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm test` -- expected: the full two-project run is green.

## Auto Run Result

Status: done
Blocking condition: none

**What was implemented.** Both halves of DW-215's recorded 2026-08-21 decision, independently.
(a) Artifact revisions gained a retention cap: `MAX_ARTIFACT_REVISIONS = 50` is both the prune
threshold and the default listing bound, so a history at the cap is shown whole and only a
backlog written before the cap existed is ever elided. `saveWikiArtifactRevision` prunes as a
fail-soft tail once the revision and its sidecar are on disk — a snapshot that landed is never
reported as failed because the housekeeping behind it did not — and the prune deletes the
sidecar before its `.md`, attempts every doomed stem, and reports failures once at the end.
`listWikiArtifactRevisions` applies its bound to the filename STEMS before any `stat`, which is
what makes the read cost the constant rather than the history: the stem is the timestamp, so the
newest N are knowable from `listFiles` alone.
(b) The backup walk and the byte accounting now truncate with a flag instead of throwing. The
manifest carries `truncated?: true` / `truncationReason`, ABSENT (not `false`) on a whole backup
so an old manifest and a complete one stay the same shape; a truncated backup still writes its
manifest, still records a succeeded ledger line that names itself partial, and still verifies.
The limits became an injectable defaulted parameter — the seam `isOwnerBackupDue`'s `intervalMs`
already established — so both truncation paths are reachable without materialising 10k files or
2 GB. The two production constants are unchanged.

**Files changed.**
- `src/lib/wiki-artifact-revisions.ts` — `MAX_ARTIFACT_REVISIONS`, `sortedCanonicalStems`, `pruneArtifactRevisions`, the prune tail on `saveWikiArtifactRevision`, the bounded `listWikiArtifactRevisions` with its `boundedLimit` guard, and a rewritten retention paragraph in the header (the old one asserted the opposite).
- `src/lib/backups.ts` — `BackupLimits` / `DEFAULT_BACKUP_LIMITS`, truncating `walkFiles`, a copy loop that stops before the file that would pass the byte ceiling, `truncated` / `truncationReason` on the manifest, and `backupTruncationLabel()` as the one owner-facing spelling of the partial marker.
- `src/lib/system-health.ts` — a truncated latest backup participates in `needsAttention`; `backupStatus` and its union untouched.
- `src/components/SystemHealthDesk.tsx` — the backup row renders `backupTruncationLabel()`, and the panel's standing "byte-for-byte" sentence no longer claims a completeness a truncated snapshot does not have.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` — retention, fail-soft pruning, the stat-counted bounded listing, non-canonical stems, the constant pin, and the below-cap / sidecar-less / explicit-limit branches.
- `src/lib/__tests__/backups.test.ts` — both truncation reasons, the exact-`maxFiles` and exact-`maxBytes` boundaries, an untruncated manifest with no `truncated` key on disk, verify over a truncated manifest, and the label plus `summarizeBackup` pass-through.
- `src/lib/__tests__/system-health.test.ts` — a verified-but-partial backup reports `attention`.

**Review findings breakdown.** 8 patched (medium 5, low 3), 3 deferred (see frontmatter `deferred`), 14 rejected, 0 intent gaps, 0 spec repairs. Four layers ran in parallel: blind hunter, edge-case hunter, verification-gap, intent-alignment.

**Follow-up review recommendation:** true. Patched counts by severity: high 0, medium 5, low 3. Score = 3 x 5 + 1 x 3 = 18, which is >= 5.

**Verification performed.**
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/backups.test.ts` — 59 passed.
- `pnpm exec vitest run --project node src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/system-health.test.ts src/lib/__tests__/scan-route.test.ts` — 100 passed.
- `pnpm exec tsc --noEmit` — exit 0, no output.
- `pnpm exec vitest run --project node` (whole node project) — 277 files, 6855 passed, 1 skipped.
- `pnpm test` is NOT green, and not because of this change. 13 `dom`-project files under `src/components/workbench/__tests__/` fail with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage.clear()` in `beforeEach`. I ran the whole `dom` project twice — once with this change and once with it stashed onto `002843ce` — and the failing file lists are IDENTICAL (same 13 files). Nothing in this change touches that directory. That environment problem is pre-existing and separate.

**Residual risks.**
- Pruning fires only on the next write of that artifact, exactly as the intent specifies ("pruning at the write"). A DORMANT artifact whose history predates the cap keeps every file under `tenants/<t>` indefinitely; the bounded listing and the truncating backup walk contain the symptoms, but the bytes stay on disk until someone edits that Schema again. A background sweep was out of scope by the intent's own wording.
- Because the cap and the listing bound are the same number, the read bound can never bind once the prune has run. Its test therefore seeds a 60-deep backlog straight to disk. In steady state the GET's cost reduction comes entirely from the write-side prune, which is the intended arrangement, not a gap.
- The three deferred items in the frontmatter — arbitrary truncation ORDER, the revision half's silent history loss, and the read-before-size-check in the copy loop — are real and left for later focused attention.
