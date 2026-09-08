---
title: 'DW-59 — per-Wiki artifact revisions'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A successful re-template overwrites an owner-edited `schema.md` with template
      bytes and takes no revision snapshot, so DW-59's recovery path does not cover
      the other operation that destroys the same file.
    evidence: |-
      `applyScenarioTemplate` -> `seedWikiArtifacts` -> `putWikiArtifact` writes both
      artifacts with no prior read. `snapshotSeededFiles` holds the pre-seed bytes in
      memory and `restoreSeededFiles` is called only from the `catch`, so it is a
      rollback for a FAILED seed, not history: a re-template that COMMITS discards the
      snapshot and the owner's edited Schema is gone exactly as DW-59 describes. The
      recorded decision scopes read-before-write to `writeWikiArtifact`, so this is out
      of scope on the intent's own authority rather than a miss.
    location: >-
      src/lib/wikis.ts (applyScenarioTemplate / seedWikiArtifacts)
    severity: medium
  - summary: >-
      The artifact history API has no client — no Workbench surface lists or reverts
      artifact revisions, so the recovery path is unreachable from the running app.
    evidence: |-
      `grep -rn "artifact/revisions" src` returns only the route and its test. The page
      equivalent has both halves: `GET/POST /api/wiki/[slug]/revisions` plus
      `src/components/RevisionHistory.tsx` (expand -> list -> view -> revert), and
      `workbench-preview.ts` owns `ARTIFACT_WRITE_ROUTE`/`artifactWriteUrl` but gained no
      history helper. The intent named the route as the exposure surface and the spec's
      Never list excludes UI, so the API-only shape is correct for this story — the
      follow-up is wiring the Schema editor to it.
    location: >-
      src/components/workbench/PreviewColumn.tsx, src/lib/workbench-preview.ts
    severity: medium
  - summary: >-
      Artifact revisions accumulate with no cap or pruning and are walked by the backup
      scan, which throws rather than degrades at its safety limits.
    evidence: |-
      Every `writeWikiArtifact` writes a full copy under
      `tenants/<t>/wikis/<id>/revisions/<file>/` with no retention policy (deliberate —
      page revisions have none either), and `listWikiArtifactRevisions` stats every
      revision on each GET with an unbounded `Promise.all`. `src/lib/backups.ts` walks all
      of `tenants/<t>` against `MAX_BACKUP_FILES = 10_000` / `MAX_BACKUP_BYTES = 2 GB` and
      throws "Backup exceeds the safety limit" rather than degrading. Page revisions spread
      across slugs; these pile into one directory per artifact.
    location: >-
      src/lib/wiki-artifact-revisions.ts, src/lib/backups.ts:56-85
    severity: low
baseline_revision: 'b2680c9a1804fee1e5642271232ae0a1d0e7b552'
---

<intent-contract>

## Intent

**Problem:** `writeWikiArtifact` (`src/lib/wikis.ts:563`) overwrites `schema.md` with no prior read and no snapshot, so an owner's edit destroys the previous executable Schema permanently — while the page write it is modelled on (`src/lib/wiki.ts:437-448`) snapshots through `saveRevision` and `GET/POST /api/wiki/[slug]/revisions` can revert.

**Approach:** Give artifacts their own per-Wiki revision namespace at `tenants/<t>/wikis/<id>/revisions/<file>/<timestamp>.md` (plus a `.meta.json` sidecar), snapshot read-before-write inside `writeWikiArtifact`'s existing lock, and expose list / read-one / revert through a `revisions` child of the artifact route that mirrors the page revisions API. The slug-keyed `.revisions` silo in `src/lib/revisions.ts` is not touched.

## Boundaries & Constraints

**Always:**
- The revision namespace is expressed ONCE, in `src/lib/wiki-paths.ts`, alongside `wikiArtifactPath` — no second spelling of `tenants/<t>/wikis/<id>/…` anywhere.
- Revisions live UNDER `wikiDirPath(owner, wikiId)`, so `deleteWiki`, `discardCreatedWikiDirectory` and `sweepOrphans` already reclaim them with their existing `deleteDirectory` calls. No new cleanup path.
- The snapshot happens inside the SAME `withFileLock(wikiLockKey(owner))` that already wraps `putWikiArtifact`, because that key owns everything under the Wiki directory. Never take a second lock key, and never call `bumpDataVersion`/`appendToLog` from inside it (they take their own keys) — the existing tail stays outside and fail-soft.
- The snapshot is FAIL-SOFT, exactly like `writeWikiPage`: absent file (ENOENT) → no snapshot and no warning; any other read/write failure → `logger.warn` and the save proceeds. A save that reached storage is never reported as failed because history could not be recorded.
- Revert goes through `writeWikiArtifact`, so reverting snapshots the bytes it replaces and fires the same log + `dataVersion` tail.
- Revert re-runs `hasPageConventions` on the revision content and refuses with `PAGE_CONVENTIONS_REQUIRED_COPY` when it fails — a revert must not be a door around the guard the direct write enforces.
- The revisions route reuses the artifact route's gates verbatim: `getPrincipal()` → 401, `isOwnerHandle` → 403, `isEditableArtifactFile(?path=)` → the same single `NOT_EDITABLE` 400, current Wiki re-derived from `getWikiRegistry(principal.handle).currentId` (never named by the caller), `Cache-Control: private, no-store`.
- `isReadOnly()` refuses the POST (revert) only; the GET listing stays readable in a read-only deployment.

**Block If:** Nothing. The namespace, the write hook and the surface are all fixed by the recorded decision.

**Never:**
- Do not touch `src/lib/revisions.ts`, the `.revisions` slug silo, or any page route.
- Do not snapshot in `putWikiArtifact` / `seedWikiArtifacts` — create and re-template keep their existing snapshot-and-restore compensation; the recorded decision scopes read-before-write to `writeWikiArtifact`.
- Do not add UI. This story ships the storage layer and the API only.
- Do not add a retention cap, pruning, or diffing — page revisions have none.
- Do not widen `EditableArtifactFile`, and do not let the route accept a storage path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First edit of a seeded Schema | `schema.md` exists with seed bytes | Seed bytes land at `tenants/<t>/wikis/<id>/revisions/schema.md/<ts>.md`; new bytes at the artifact path | No error expected |
| Edit when the artifact is absent | `schema.md` missing | Bytes written, NO revision file, no warning | ENOENT is the first-write case |
| Snapshot write fails | storage rejects the revision write | Artifact bytes still land; `logger.warn` | Fail-soft, save reports success |
| `GET ?path=schema.md` | two revisions exist | `{ revisions: [...] }` newest first, each `{ timestamp, date, file, sizeBytes, author?, reason? }` | No error expected |
| `GET ?path=schema.md&timestamp=<ts>` | that revision exists | `{ content, revision }` | Unknown timestamp → 404; non-positive/NaN → 400 |
| `GET ?path=purpose.md` | not editable | 400 `NOT_EDITABLE` | Same body as the PUT refusal |
| `POST {action:"revert",timestamp}` | revision exists and carries page conventions | Current bytes snapshotted, revision content written, log line + `dataVersion` bump | Returns `{ ok: true, version }` |
| Revert to a conventions-less revision | revision lacks the conventions section | 400 `PAGE_CONVENTIONS_REQUIRED_COPY`, nothing written | Refused above the writer |
| Revert while read-only | `YOPEDIA_READONLY=1` | 403, nothing written | GET still answers |
| Non-owner / signed-out | any | 403 / 401 | No existence oracle |
| Wiki deleted | `deleteWiki` runs | Revision directory removed with the Wiki directory | Existing `deleteDirectory` covers it |

</intent-contract>

## Code Map

- `src/lib/wiki-paths.ts:66-75` — `wikiArtifactPath`; add the revision-directory and revision-file addresses beside it (leaf module, no storage imports — keep it that way).
- `src/lib/wikis.ts:563-592` — `writeWikiArtifact`: the lock wraps only `putWikiArtifact`; the read-before-write snapshot goes inside that same callback. Tail (`appendToLog` + `bumpDataVersion`, lines 573-591) stays outside and fail-soft.
- `src/lib/wikis.ts:312-319` — `putWikiArtifact`, the one place artifact bytes are written; unlocked on purpose. Do not add a snapshot here.
- `src/lib/wikis.ts:996-1007` — `readWikiArtifact`, the ENOENT → null read shape to mirror.
- `src/lib/revisions.ts` — the model to mirror: `uniqueTimestamp()` monotonic stems (lines 66-74), `.meta.json` sidecar shape, `listRevisions` concurrent stat+meta, `readRevision`/`readRevisionMeta` ENOENT → null with `logger.warn` on anything else.
- `src/lib/wiki.ts:437-448` — `writeWikiPage`'s read-before-write: try/catch around `readFile` + `saveRevision`, ENOENT silent, other errors warned, write proceeds.
- `src/app/api/workbench/artifact/route.ts:73-131` — the gate ladder (`getPrincipal` → `isOwnerHandle` → `isReadOnly` → `isEditableArtifactFile` → registry `currentId`) and `NO_STORE`/`json()`/`NOT_EDITABLE` helpers to reuse.
- `src/app/api/wiki/[slug]/revisions/route.ts` — the API shape to mirror: GET list vs `?timestamp=`, POST `{action:"revert",timestamp}` with the same validation order.
- `src/lib/workbench-files.ts:298-321` — the Files tab intersects the Wiki directory listing with `WIKI_ARTIFACT_FILES` and skips directories, so a `revisions/` sibling is invisible there. Read-only evidence: no change needed.
- `src/lib/wikis.ts:893-914` (`sweepOrphans`), `:513`, `:974` — the three `deleteDirectory(wikiDirPath(...))` calls that already reclaim anything nested under a Wiki.
- `src/lib/__tests__/wiki-schema-edit.test.ts:330-400` — the existing harness (temp `DATA_DIR`, hoisted `getPrincipal` mock, `put()` helper with `If-Match`, `seed()`); reuse its shape for the new suite.
- `src/lib/wiki-scenarios.ts:57-91` — `WIKI_ARTIFACT_FILES` / `EDITABLE_ARTIFACT_FILES` / `isEditableArtifactFile`.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-paths.ts` -- add `wikiArtifactRevisionsDir(owner, wikiId, file)` → `<wikiDirPath>/revisions/<file>` and `wikiArtifactRevisionPath(owner, wikiId, file, name)` -- one expression of the namespace, in the module that already owns the layout.
- `src/lib/wiki-artifact-revisions.ts` -- NEW: `ArtifactRevision` type, `saveWikiArtifactRevision`, `listWikiArtifactRevisions`, `readWikiArtifactRevision`, `readWikiArtifactRevisionMeta`, with a monotonic timestamp and `.meta.json` sidecar mirroring `revisions.ts` -- a separate module keeps `wikis.ts` from growing a second concern and keeps the slug silo untouched.
- `src/lib/wikis.ts` -- in `writeWikiArtifact`, read the current bytes and snapshot them inside the existing `withFileLock` callback before `putWikiArtifact`; accept an optional `reason` recorded in the sidecar (author = `owner`) and appended to the existing log details line -- read-before-write is the recovery path; `reason` is what makes a revert distinguishable from an edit in the activity log.
- `src/app/api/workbench/artifact/revisions/route.ts` -- NEW: `GET` (list / read one) and `POST` (revert) reusing the artifact route's gate ladder and refusal copy -- mirrors the page revisions API without widening the write door.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- NEW: cover every I/O matrix row against a real temp `DATA_DIR` -- the snapshot is invisible when it works, so it is pinned directly.

**Acceptance Criteria:**
- Given a Wiki whose `schema.md` has been edited twice, when `listWikiArtifactRevisions` runs, then it returns two entries newest-first and the newest one's content equals the bytes the second edit replaced.
- Given a seeded Wiki, when the owner reverts to the seed revision, then the artifact bytes equal the seed, a THIRD revision holds the pre-revert edit, one `edit` log line names the revert, and `dataVersion` moved.
- Given a Wiki with revisions, when `deleteWiki` removes it, then nothing remains under `tenants/<t>/wikis/<id>/`.
- Given a revision snapshot that cannot be written, when the owner saves, then the save answers 200 with the new bytes on disk and a warning logged.

## Spec Change Log

## Review Triage Log

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 3: (high 0, medium 2, low 1)
- reject: 7: (high 0, medium 1, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `writeWikiArtifact` silenced ENOENT from BOTH the pre-write read and the snapshot write, so an R2 not-found-shaped failure on the revision write lost the history entry with no warning — the exact silent loss this story closes. Split: the read now goes through `readWikiArtifact` (null = first write, throw = warn), the snapshot has its own catch that always warns. Both still fail-soft.
  - `[medium]` `[patch]` Test gaps on behaviour only the new code has: the read-one route's hand-built payload had `date` and `reason` unasserted, the new route had no 500-shape case (the parent PUT pins one), and a corrupt sidecar, junk directory entries, a non-ENOENT read failure and cross-Wiki independence were all uncovered. Suite 18 -> 27 tests.
  - `[low]` `[patch]` The revisions route claimed "THE GATES ARE THE PARENT'S, VERBATIM" while omitting three of them (`If-Match`/`checkWritePrecondition`, the non-empty check, `PREVIEW_MAX_CHARS`). Docblock rewritten to name what is carried and why each of the three is deliberately absent; no precondition added, since the mirrored page revert has none and a revert is itself snapshotted.
  - `[low]` `[patch]` `listWikiArtifactRevisions` accepted any `Number(stem)` and then re-serialized it, so a non-canonical stem (`1e12.md`, `012.md`) listed a revision whose read answers 404. Added `canonicalStem()` requiring a safe positive integer that round-trips.
  - `[low]` `[patch]` `reason` reached both the sidecar and the `log.md` details line unnormalized: a newline would inject a line the log's `^## [date] op |` parse treats as structure, and a whitespace-only value was recorded in the sidecar while the log omitted it. Now normalized once at the writer (whitespace collapsed, trimmed, capped, empty = absent) and used for both.
  - `[low]` `[patch]` A sidecar write failing after the `.md` landed threw out of `saveWikiArtifactRevision`, so the caller warned "snapshotting failed" about a snapshot that exists and is listed. Scoped so the revision stands unattributed with its own warning.
  - `[low]` `[patch]` Two inaccurate comments: the claim that create and re-template "keep their own snapshot-and-restore compensation" (the restore runs only from the `catch`, so a SUCCESSFUL re-template still destroys an edited Schema — see the deferred entry), and the module header's serialization claim, which is per-process only (`lock.ts` is in-process, and `uniqueTimestamp` is a module-global counter).

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 0
- reject: 23: (high 0, medium 2, low 21)
- addressed_findings:
  - `[medium]` `[patch]` The corrupt-sidecar test's closing assertion compared `readWikiArtifactRevision(...)` to a second identical call, so it passed for any value including `null` — the one test in the repo standing for "a sidecar that will not parse costs attribution, not the bytes" pinned nothing. Now captures the seeded Schema before the edit and asserts the revision reads back as exactly those bytes.
  - `[low]` `[patch]` The route's `parseTimestamp` accepted any finite positive number while the library's `canonicalStem` required a round-tripping safe integer, so `?timestamp=12.5` was treated as a well-formed id and answered 404 "revision not found" rather than 400. Route now requires a positive safe integer, so both layers admit the same set; GET and POST both pinned.
  - `[low]` `[patch]` `normalizeArtifactEditReason` capped with `slice(0, 200)` on UTF-16 units, so a cut landing inside a surrogate pair would write a LONE SURROGATE into the sidecar JSON and the tenant-global `wiki/log.md`. Now truncates on code-point boundaries, pinned with an astral character straddling the cap.
  - `[low]` `[patch]` The shared gate ladder's last rung — registry with no `currentId` → 404 — was the only refusal untested on either verb. Added a test covering both.
  - `[low]` `[patch]` The `NOT_EDITABLE` sentence exists as two independent literals (parent artifact route and this child), and the child's docblock claims it carries the parent's copy "unchanged", but nothing asserted they match — a reword of one would leave the two halves of ONE allowlist refusing the same path with two different bodies. Added a cross-route test asserting the parent PUT's and the child GET's refusal bodies are deep-equal.

## Design Notes

Why a sibling namespace rather than the slug silo: `revisions.ts` keys everything by `validateSlug`ed page slug under `wiki/.revisions/`, and an artifact has no slug. Nesting under the Wiki directory instead means the lock that already serializes artifact writes also serializes their history, and every existing directory delete reclaims it — no new cleanup, no new lock order, no orphan class.

`revisions/` is deliberately NOT dot-prefixed like `.revisions`: the dotfile filter in `workbench-files.ts` only guards the `raw/`/`wiki/` walk, while the Wiki-artifact branch intersects with `WIKI_ARTIFACT_FILES` and skips directories outright, so the directory is already invisible to the tree.

The route is a `revisions` CHILD of the artifact route rather than more verbs on `PUT /api/workbench/artifact`: the recorded decision says "mirroring the page revisions API", and that API is `GET/POST /api/wiki/[slug]/revisions`. `?path=` stays the target selector so both halves share one allowlist.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/revisions.test.ts` -- expected: all pass
- `pnpm test` -- expected: full suite green, no pre-existing failures introduced
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit` -- expected: no type errors

## Auto Run Result

Status: done
Pass: follow-up review of an already-`done` spec (`review_loop_iteration` 0, no loopback).

**Summary of implemented change.** DW-59 gives the one editable Wiki artifact (`schema.md`) its own per-Wiki revision history. `writeWikiArtifact` now reads the current bytes and snapshots them inside the lock it already holds, into `tenants/<t>/wikis/<id>/revisions/<file>/<timestamp>.md` plus a `.meta.json` sidecar; `GET/POST /api/workbench/artifact/revisions` lists, reads one, and reverts through the same writer, mirroring the page revisions API. This pass reviewed that shipped change again and applied five patches; no spec amendment and no code re-derivation were needed.

**Files changed** (whole story; this pass touched the last three):
- `src/lib/wiki-paths.ts` — the revision-directory and revision-file addresses, spelled once beside `wikiArtifactPath`.
- `src/app/api/workbench/artifact/revisions/route.ts` — the history API; this pass tightened `parseTimestamp` to a positive safe integer so the route and `canonicalStem` admit the same ids.
- `src/lib/wiki-artifact-revisions.ts` — save / list / read / read-meta, mirroring `revisions.ts`.
- `src/lib/wikis.ts` — read-before-write snapshot inside the existing lock, plus the optional `reason`; this pass made the reason cap code-point-safe.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` — the suite; this pass fixed a self-comparing assertion and added coverage for the canonical-timestamp rule, the astral-character cap, the `currentId`-missing 404 on both verbs, and cross-route refusal-body equality. 27 → 29 tests.

**Review findings breakdown.** 5 patches applied (medium 1, low 4); 0 items deferred; 23 rejected (medium 2, low 21). The two rejected mediums — the re-template path that still overwrites an edited Schema without a snapshot, and the absence of any UI client for the new route — are already recorded in this spec's `deferred` list from the previous pass and were not re-added. The rest were noise, deliberate mirrors of the parent artifact route that the intent required be carried verbatim (the 403 copy, the read-only-before-path gate order, the 500 body shape), or restatements of exclusions the intent itself makes (no retention cap, no pruning, no dedupe).

**Follow-up review recommendation: true.** Patched this pass: high 0, medium 1, low 4. Score = 3 × 1 + 1 × 4 = 7, which is ≥ 5.

**Verification performed.**
- `npx vitest run src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/revisions.test.ts` — 4 files, 171 tests, all pass.
- `npx vitest run` (full suite) — 227 files, 4781 tests, all pass; no pre-existing failures introduced.
- `npx eslint` — exit 0. (The repeated `jsx-ast-utils` "TSNonNullExpression could not be resolved" notices are pre-existing and unrelated to this change.)
- `npx tsc --noEmit` — exit 0.
- TOOLING NOTE: the `pnpm`-prefixed forms this spec's Verification section names (`pnpm test`, `pnpm lint`, `pnpm vitest run`) fail in this environment with `ERROR packages field missing or empty` — a pnpm workspace-resolution problem in the sandbox, not a repository or code defect. The `npx` equivalents above run the identical binaries and configs.

**Residual risks.**
- The two deferred mediums stand unchanged: a SUCCESSFUL re-template still replaces an owner-edited `schema.md` with template bytes and takes no snapshot (the existing `restoreSeededFiles` runs only from the failure `catch`), and no Workbench surface calls the new route, so the recovery path is reachable only by hand-crafted requests.
- The snapshot's ordering and read-before-write guarantees are PER PROCESS (`withFileLock` is in-process; `uniqueTimestamp` is a module-global counter) — the same exposure page revisions already carry, closed for both by whichever story gives the deployment a cross-process lock.
- Revisions still have no retention cap or pagination, and the listing stats every revision in one unbounded `Promise.all`; this is recorded in the `deferred` list and is deliberate parity with page revisions.
