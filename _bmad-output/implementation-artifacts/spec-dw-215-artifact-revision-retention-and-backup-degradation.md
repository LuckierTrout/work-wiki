---
title: 'DW-215 — artifact revision retention and backup degradation'
type: 'feature'
created: '2026-08-21'
baseline_revision: '12cab06e94076f2bd8b829ad7c1e2850a5719c18'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The bounded artifact-revision listing hides a legacy over-cap backlog with no signal
      on the wire, while the backup half says "partial" out loud at four surfaces.
    evidence: |-
      `listWikiArtifactRevisions` returns the newest MAX_ARTIFACT_REVISIONS stems and the
      route's `{ revisions }` shape carries no `total`/`hasMore`/cap field, so a client
      cannot distinguish "this artifact has 50 revisions" from "50 of 300". Pruning only
      fires on a save, so an artifact never edited again keeps a directory the reader
      silently truncates. The intent forecloses `?limit=`/pagination, so the honest
      alternative is a marker, not a knob — a decision this run had no authority to make.
    location: >-
      src/lib/wiki-artifact-revisions.ts (listWikiArtifactRevisions) and
      src/app/api/workbench/artifact/revisions/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Per-Wiki artifact revisions accumulate forever in one directory per artifact, and `listWikiArtifactRevisions` stats every one of them on each GET through an unbounded `Promise.all`; meanwhile `src/lib/backups.ts` walks all of `tenants/<t>` and **throws** at `MAX_BACKUP_FILES` / `MAX_BACKUP_BYTES`, so the growth that history causes eventually turns the owner's only recovery path off entirely rather than degrading it.

**Approach:** Give artifact revisions a retention cap enforced by fail-soft pruning inside `saveWikiArtifactRevision`, bound the listing to that same cap, and change the backup create path to stop at its two safety limits and record a truncation flag on the manifest instead of throwing — with that flag carried through the API summary to the System page, and counted as "needs attention" so a partial backup never reads as a healthy verified one.

## Boundaries & Constraints

**Always:**
- Pruning is fail-soft: `saveWikiArtifactRevision` still throws only when the revision `.md` itself cannot be written. A prune failure warns via `logger.warn` and returns normally — the snapshot landed, and the callers in `wikis.ts` would otherwise report a stored save as lost history.
- Pruning deletes only revisions this module owns: `<canonical-timestamp>.md` and its `<canonical-timestamp>.meta.json` sidecar, oldest first, keeping the newest `MAX_ARTIFACT_REVISIONS`. Non-canonical stems (`canonicalStem` → null) and unrelated files are left untouched.
- The prune runs after the revision (and its sidecar) is written, inside the caller's existing `withWikiLock` — this module still takes no lock of its own.
- The bounded listing keeps its current contract otherwise: newest first, ENOENT → `[]`, a vanished file skipped rather than failing the whole history, `ArtifactRevision` shape unchanged.
- A truncated backup is still a manifest that verifies: `verifyOwnerBackup` checks exactly the entries the manifest holds.
- `truncated` is an **optional** manifest field, so `version: 1` manifests already on disk keep parsing and a complete backup carries no flag at all.
- Module and route doc comments that currently assert "no cap, no pruning" or an unbounded listing are part of the change — this repo treats stale comments as defects.

**Block If:**
- Bounding the listing would require changing the revisions route's wire shape (`{ revisions: [...] }`) or its gate ladder.

**Never:**
- Do not add retention, pruning, or a cap to page revisions (`src/lib/revisions.ts`) — this entry is about the artifact silo only.
- Do not add pagination, a `?limit=` parameter, diffing, or dedupe to the revisions route.
- Do not change `MAX_BACKUP_FILES` / `MAX_BACKUP_BYTES` values, bump the manifest `version`, or make `portable-archive.ts` degrade — its throws are a separate decision.
- Do not let a truncated backup be recorded as a **failed** operation; it succeeded partially, and the flag is how that is said.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save under the cap | Artifact has fewer than `MAX_ARTIFACT_REVISIONS` revisions | New revision written; nothing pruned | No error expected |
| Save over the cap | Artifact already has `MAX_ARTIFACT_REVISIONS` revisions | New revision written; the oldest revision `.md` **and** its sidecar are deleted; directory holds exactly `MAX_ARTIFACT_REVISIONS` | No error expected |
| Prune fails | Storage `deleteFile`/`listFiles` throws during pruning | `saveWikiArtifactRevision` resolves; `logger.warn` names the artifact and Wiki | Swallowed — the revision already landed |
| Listing over the cap | Directory holds more revision files than the cap (legacy backlog) | Newest `MAX_ARTIFACT_REVISIONS` returned, newest first; older ones not stat-ed | No error expected |
| Backup at the file limit | Tenant holds more files than `maxFiles` | Manifest holds exactly `maxFiles` entries and `truncated: ["file-count"]` | No throw |
| Backup at the byte limit | Next file would push `totalBytes` past `maxBytes` | Copy stops before that file; `totalBytes` stays ≤ `maxBytes`; `truncated` includes `"total-bytes"` | No throw |
| Complete backup | Tenant is inside both limits | Manifest has no `truncated` field; summary/UI unchanged from today | No error expected |
| Truncated backup verified | Latest backup verified but truncated | `getSystemHealth().status === "attention"`; System page row shows a partial marker | No error expected |

</intent-contract>

## Code Map

- `src/lib/wiki-artifact-revisions.ts` -- the whole revision silo. `saveWikiArtifactRevision` (L157) writes `${timestamp}.md` then the optional `${timestamp}.meta.json`; `listWikiArtifactRevisions` (L205) lists the dir and runs one `stat` + one meta read per `.md` in an unbounded `Promise.all`; `canonicalStem` (L124) is the stem→timestamp filter that must gate what pruning may delete. The module doc comment L37–42 states "What it does NOT copy is retention: page revisions have no cap, no pruning and no diffing, and neither does this" — that sentence is now false.
- `src/lib/revisions.ts` L224–270 (`listRevisionAuthors`) -- **the reuse pattern for both halves**: one `listFiles`, build a `Set` of sidecar timestamps and an array of `.md` stems from that single listing, sort desc, `slice(0, max)`, and only then pay per-item reads. Copy this shape; do not invent a second one.
- `src/lib/wiki-paths.ts` L97–120 -- `wikiArtifactRevisionsDir` / `wikiArtifactRevisionPath`; every prune delete goes through the path helper, never a hand-joined string.
- `src/lib/wikis.ts` L641 and L962 -- the two `saveWikiArtifactRevision` callers (re-template snapshot, and the pre-overwrite snapshot in `writeWikiArtifact`). Both already wrap the call in a fail-soft `try` whose warning says "the replaced bytes are not in this wiki's history" — a prune throw would fire that misleading line, which is why pruning must not throw. No change needed in this file.
- `src/app/api/workbench/artifact/revisions/route.ts` L222 -- `json({ revisions: await listWikiArtifactRevisions(...) })`. Wire shape and gates stay exactly as they are; only the doc comment gains the retention sentence if it claims completeness.
- `src/lib/backups.ts` -- `MAX_BACKUP_FILES`/`MAX_BACKUP_BYTES` (L30–31); `walkFiles` (L69–81) recurses per level and throws once `files.length > MAX_BACKUP_FILES` (note the per-level check is also not a global bound); `createOwnerBackupUnlocked` (L90–160) throws at `totalBytes > MAX_BACKUP_BYTES` **after** adding the file's length, copies through a `BACKUP_BATCH_WINDOW`-sized `pending` map, and closes with `recordOperationSafe(... detail: \`${entries.length} files; ${totalBytes} bytes\`)`. `now: Date = new Date()` (L92) is the existing default-parameter convention for testability — follow it for the limits.
- `src/lib/backups.ts` L28 `BackupSummary = Omit<BackupManifest, "files"> & { fileCount }` and L294 `summarizeBackup` -- a new optional manifest field reaches the API and UI for free; no edit needed beyond the interface.
- `src/lib/system-health.ts` L40–66 -- `backupStatus` and the `needsAttention` disjunction; L98 emits `backup: { latest, status }`.
- `src/components/SystemHealthDesk.tsx` L223 -- the backup row's receipt line `{backup.fileCount} files · {sizeLabel(backup.totalBytes)}`; L6 imports `BackupSummary`. This is the outermost surface the flag has to reach.
- `src/lib/__tests__/backups.test.ts` (51 lines) -- temp `DATA_DIR`, two seeded tenant files (`wiki/plan.md` text + `raw/plan/source.bin` binary), `_resetStorage()`. Extend here.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` (991 lines) -- temp `DATA_DIR`/`WIKI_DIR`/`RAW_DIR`, hoisted `getPrincipal` mock, `createWiki` seed, `OWNER = "yuanhao"`, `schemaSaying()` helper. Extend here.
- `src/lib/__tests__/storage-write-bounds.test.ts` L246 and `src/lib/__tests__/system-health.test.ts` L39 -- existing `createOwnerBackup` callers; the new limits parameter must be defaulted so they keep compiling unchanged.
- `src/lib/storage/types.ts` -- `deleteFile(path)` L236, `listFiles(prefix)` L252 are the two storage calls pruning needs; the filesystem provider's `listFiles` returns `[]` on ENOENT (L419–423).

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-artifact-revisions.ts` -- add an exported `MAX_ARTIFACT_REVISIONS = 50`; add a private fail-soft `pruneWikiArtifactRevisions(owner, wikiId, file)` that lists the dir once, keeps the newest `MAX_ARTIFACT_REVISIONS` canonical stems, and deletes the rest plus only those sidecars the same listing proved exist; call it at the end of `saveWikiArtifactRevision`; bound `listWikiArtifactRevisions` to the newest `MAX_ARTIFACT_REVISIONS` stems **before** any `stat`/meta read -- the ledger's two revision complaints (unbounded growth, unbounded per-GET fan-out) are the same directory listing read twice.
- `src/lib/wiki-artifact-revisions.ts` -- rewrite the module doc comment's retention paragraph (L37–42) and `listWikiArtifactRevisions`' "Every revision of `file`" doc to state the cap, that pruning is oldest-first and fail-soft, and that page revisions still have none -- the old text now asserts the opposite of the code.
- `src/lib/backups.ts` -- add `BackupTruncationReason` / an optional `truncated?: BackupTruncationReason[]` on `BackupManifest`; make `walkFiles` take a global file budget and return `{ files, truncated }` instead of throwing; give `createOwnerBackupUnlocked`/`createOwnerBackup` a defaulted `limits` parameter, stop the copy loop **before** the file that would cross `maxBytes`, set `truncated` on the manifest, and name the truncation in the `recordOperationSafe` detail -- degrade-with-a-flag is the decision, and the existing per-level file check is not even a global bound today.
- `src/lib/system-health.ts` -- treat a truncated latest backup as `needsAttention` -- the throw this replaces was the operator's only signal, so removing it without one would trade a loud failure for a silent one.
- `src/components/SystemHealthDesk.tsx` -- render a partial marker on the backup row's receipt line when `backup.truncated` is present -- a flag nobody can see is not a flag.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- cover the I/O matrix's four revision rows: prune at the cap (including sidecar removal and that the newest survive), no prune under it, a prune failure that still resolves and warns, and a listing bounded below a hand-written over-cap directory.
- `src/lib/__tests__/backups.test.ts` -- cover the four backup rows using small injected `limits`: file-count truncation, byte truncation (`totalBytes` ≤ `maxBytes`, offending file absent from `files`), a complete backup carrying no `truncated` field, and that a truncated manifest still verifies.
- `src/lib/__tests__/system-health.test.ts` -- pin that a verified-but-truncated latest backup yields `status: "attention"`.
- `src/components/__tests__/system-health-partial-backup.test.tsx` -- mount `SystemHealthDesk` against a truncated summary and pin the partial marker, the named limits, and its absence on a complete backup -- the matrix's last row ends on screen, not in the snapshot.

**Acceptance Criteria:**
- Given an artifact whose revision directory already holds `MAX_ARTIFACT_REVISIONS` revisions, when `writeWikiArtifact` snapshots one more, then the directory holds exactly `MAX_ARTIFACT_REVISIONS` revision `.md` files, the newest save is among them, the oldest one and its `.meta.json` are gone, and the write itself resolves normally.
- Given storage that throws on delete, when `saveWikiArtifactRevision` prunes, then the call resolves without throwing, the new revision is readable through `readWikiArtifactRevision`, and `logger.warn` is called with the `"wiki-artifact-revisions"` scope.
- Given a revision directory hand-populated with more than `MAX_ARTIFACT_REVISIONS` canonical revisions, when `listWikiArtifactRevisions` runs, then it returns exactly `MAX_ARTIFACT_REVISIONS` entries, newest first, and no `stat` is issued for the excluded stems.
- Given a tenant holding more files than the injected `maxFiles`, when `createOwnerBackup` runs, then it resolves with a manifest whose `files` length equals `maxFiles` and whose `truncated` contains `"file-count"`, and no error is thrown.
- Given a tenant whose files exceed the injected `maxBytes`, when `createOwnerBackup` runs, then `totalBytes` is ≤ `maxBytes`, every entry in `files` was actually copied to its `backupPath`, and `truncated` contains `"total-bytes"`.
- Given a tenant inside both limits, when `createOwnerBackup` runs, then the manifest has no `truncated` property and `summarizeBackup` output is byte-identical in shape to today's.
- Given the latest backup verified but truncated, when `getSystemHealth` runs, then `status` is `"attention"`, and when `SystemHealthDesk` renders that summary, then the backup row shows a partial marker alongside the file count.

## Design Notes

Prune and bounded-list are the same primitive read twice — copy `listRevisionAuthors`' shape (one `listFiles`, stems + sidecar `Set`, sort desc, slice) rather than writing two different walks:

```ts
const stems: number[] = [], sidecars = new Set<number>();
for (const entry of entries) {
  if (entry.isDirectory) continue;
  if (entry.name.endsWith(".meta.json")) { const t = canonicalStem(entry.name.slice(0, -".meta.json".length)); if (t !== null) sidecars.add(t); }
  else if (entry.name.endsWith(".md")) { const t = canonicalStem(entry.name.slice(0, -3)); if (t !== null) stems.push(t); }
}
stems.sort((a, b) => b - a);            // newest first
// prune: stems.slice(MAX_ARTIFACT_REVISIONS)   list: stems.slice(0, MAX_ARTIFACT_REVISIONS)
```

The walk's budget must be **global**, not per recursion level, and "full" is only truncation when a **file** was actually left out — a tenant of exactly `max` files is complete even if the listing still has a directory to descend into, so the check sits on the push, not at the top of the loop:

```ts
async function walkInto(prefix: string, files: string[], max: number): Promise<boolean> {
  for (const entry of await getStorage().listFiles(prefix)) {
    const child = `${prefix}/${entry.name}`;
    if (entry.isDirectory) { if (await walkInto(child, files, max)) return true; }
    else {
      if (files.length >= max) return true;            // a real file was left out
      files.push(child);
    }
  }
  return false;
}
```

The byte check moves from "add, then throw if over" to "stop if adding would go over", so `totalBytes` and `files` always describe bytes that were really copied. `truncated` is an array because both limits can be reached in one run (walk first, then copy); push `"file-count"` before `"total-bytes"` so the order is deterministic.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/backups.test.ts src/lib/__tests__/system-health.test.ts src/lib/__tests__/storage-write-bounds.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures versus the pre-change baseline
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit -p tsconfig.json` -- expected: no errors

## Auto Run Result

Status: done
Baseline: `12cab06e94076f2bd8b829ad7c1e2850a5719c18`

**Implemented change.** Per-Wiki artifact revisions now have a retention cap (`MAX_ARTIFACT_REVISIONS = 50`) enforced by a fail-soft, oldest-first prune at the end of every `saveWikiArtifactRevision`, and `listWikiArtifactRevisions` applies the same cap to filename-derived stems *before* it pays a `stat` per entry — so a legacy over-cap directory costs one listing rather than an unbounded fan-out. The backup create path no longer throws at its two safety limits: the walk carries a global file budget and stops when a file would be left out, the copy loop stops before the file that would cross `maxBytes`, and the manifest records `truncated: ["file-count" | "total-bytes"]`. That flag rides `summarizeBackup` to the API, turns `getSystemHealth` to `attention`, and shows on the System page as "partial — stopped at the … limit" on the backup row, the restore-check card, and the create receipt — the replacement for the operator signal the removed throw used to provide.

**Files changed.**
- `src/lib/wiki-artifact-revisions.ts` — `MAX_ARTIFACT_REVISIONS`, `partitionRevisionEntries`, fail-soft per-revision `pruneWikiArtifactRevisions`, bounded listing, rewritten retention docs.
- `src/lib/backups.ts` — `BackupTruncationReason` / optional `truncated` on the manifest, `BackupLimits` + `DEFAULT_BACKUP_LIMITS`, global-budget `walkInto`/`walkFiles`, stop-before-crossing byte check, truncation named in the operation-ledger detail, `backupTruncationCopy()`.
- `src/lib/system-health.ts` — a truncated latest backup joins the `needsAttention` disjunction.
- `src/components/SystemHealthDesk.tsx` — partial marker on the backup row, the restore-check card, and the create receipt.
- `src/app/api/workbench/artifact/revisions/route.ts` — doc only: the listing is retention-bounded, deliberately not paginated, and what that leaves true of a pre-retention directory.
- `src/app/api/system/backups/route.ts` — dropped the now-unreachable `/limit/` → 400 mapping.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts`, `src/lib/__tests__/backups.test.ts`, `src/lib/__tests__/system-health.test.ts`, `src/components/__tests__/system-health-partial-backup.test.tsx` (new) — the matrix rows plus the review's boundary and ordering pins.

**Review findings breakdown.** 14 patches applied (medium 7, low 7); 1 item deferred (low — the bounded revision listing hides a legacy backlog with no signal on the wire); 18 rejected (either out of scope on the intent's own authority — page-revision parity, `portable-archive.ts`, a config knob or migration for the cap, the orchestrator-owned ledger — or noise: a pack-what-fits byte policy the matrix forecloses, validation for an internal test seam, and races whose outcome is identical to the pre-change behaviour).

**Follow-up review recommendation:** `true`. Patched counts: high 0, medium 7, low 7 → score = 3 × 7 + 1 × 7 = 28, which is ≥ 5.

**Verification.**
- `npx vitest run` — 275 files / 6280 tests passed (baseline before this change: 274 / 6268).
- `npx tsc --noEmit -p tsconfig.json` — exit 0.
- `npx eslint` — exit 0 (only pre-existing `jsx-ast-utils` `TSNonNullExpression` notices). `pnpm lint` fails on this checkout with `ERROR packages field missing or empty`; confirmed identical on a clean `HEAD` via `git stash`, so it is a pre-existing pnpm wrapper issue, not this change.
- Matrix audit: all eight I/O rows are covered by tests that ran and passed, plus the review's added exact-fit, convergence, ordering and foreign-file pins.

**Residual risks.**
- Pruning is prospective: it fires only on the next save of that artifact, so an artifact never edited again keeps its pre-retention backlog on disk. The disk-space half of DW-215 is therefore fixed lazily; what bounds the backup walk over such a directory is the degrade half, not the cap.
- The byte limit stops at the first file that would cross it rather than packing what still fits, so one large file early in the walk order can leave a manifest with very few (in the extreme, zero) entries. Such a backup still records `succeeded` and verifies `passed` — `verifyOwnerBackup` checks the entries a manifest holds — and is distinguishable only by `truncated`, the health `attention` term, and the System-page copy.
- The first save against a very deep legacy directory issues its deletes sequentially inside the caller's `wikis:<tenant>` lock.
