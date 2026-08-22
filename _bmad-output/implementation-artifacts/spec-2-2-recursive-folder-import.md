---
title: 'Story 2.2: Recursive folder import'
type: 'feature'
created: '2026-08-22'
status: 'done'
baseline_revision: '1987e3bad104129b4c7b03544b4adf28276677f8'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A loose-file identical re-arrival still creates an Ingest job after
      the hash writer declines the rewrite. Content-hash skip across
      distinct keys remains Story 2.7.
    evidence: |-
      Occupied tree keys now return 200 `{ queued: false }` and do not
      enqueue. `saveRawSourceFor` still returns only a path, and
      `storeAndQueue` always queues after that write. Same residual as
      spec-2-1 deferred item 2, now only on the hash door.
    location: >-
      src/app/api/workbench/intake/route.ts
    severity: medium
  - summary: >-
      `parseTask` accepts an unsanitized top-level `relativePath` up to 1000
      characters from a queue consumer.
    evidence: |-
      Intake sanitizes before write. A crafted Task posted at another door
      can still carry a long or unsanitized path on the job. The field is
      not interpolated into prompts in this story.
    location: >-
      src/lib/tasks.ts
    severity: low
  - summary: >-
      Occupied-key decline is still check-then-write, not an exclusive
      create.
    evidence: |-
      `alreadyStored` then `writeFile` can race two first arrivals onto one
      tree key. Same TOCTOU as spec-2-1 deferred item 4.
    location: >-
      src/lib/raw.ts
    severity: low
  - summary: >-
      Distinct folder names that slugify to the same segments collide on
      one tree key.
    evidence: |-
      `Energy Notes` and `energy-notes` both become `energy-notes`. The
      second arrival hits `alreadyStored` and is declined. No disambiguator
      in this story.
    location: >-
      src/lib/workbench-intake.ts
    severity: medium
  - summary: >-
      A browser-expanded folder file with an empty `webkitRelativePath`
      silently uses the 2.1 hash writer.
    evidence: |-
      Loose-file identity is empty relative path. Some engines expand the
      directory but leave the field blank, so tree identity is lost without
      a named refusal.
    location: >-
      src/lib/workbench-intake-client.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Workbench Intake stores one file at `raw/sources/<slug>/<hash>.md` and refuses any browser-expanded folder (`webkitRelativePath`, `INTAKE_FOLDER_COPY`). A nested import cannot preserve the tree, so Analysis never gets folder path as classification context (FR-40).

**Approach:** Add a Folder control and accept folder drops. Each supported file stores under `raw/sources/` at its sanitized relative path (the tree, not a hash key), auto-queues as its own job, and carries `relativePath` on the ingest Task / `IngestOptions` so 2.6 can pass `papers > energy` into Analysis. Office/ebook files in the tree fail visibly; siblings still store and queue.

## Boundaries & Constraints

**Always:**
- Folder pick and folder drop are the same door as 2.1: signed-in principal, `isReadOnly()` before staging, `saveRawSource*` / a new tree writer on the same `storeRawSource` helper (no second storage stack), silo mirror + `dataVersion` bump, `enqueueOrInline`, English copy, frozen `yopedia` / `WORKWIKI_*` ids.
- Stored paths mirror `webkitRelativePath` (includes the root folder name). Sanitize on the server: reject `..`, absolute, empty, and null-byte segments; slugify each directory segment; keep an allowlisted extension on the leaf.
- Each accepted file is one Source and one queue item. Per-item office/ebook refusal uses the same 2.1 sentences; supported text/markdown/html still land.
- Loose file pick/drop (empty `webkitRelativePath`) stays on the 2.1 hash writer. Folder-expanded files use the tree writer.
- Persist `relativePath` on the ingest Task (top-level for inline text; `staged.relativePath` already exists) and on `IngestOptions`. Do not invent Analysis/Generation UI or change SCHEMA prompts (2.6).
- Files walk must list a typical mirrored tree. Raise `WORKBENCH_FILE_MAX_DEPTH` so `raw/sources/<seg>/<seg>/file.md` is visible; refuse an arrival whose sanitized path would sit past that cap.
- Tree chrome: keep `Import / Upload`; add `Folder`. Never “Open project folder”.

**Block If:**
- Satisfying an AC requires Activity (2.5), two-step Analysis UI (2.6), SHA256 skip UI (2.7), cascade delete (2.10), sidecar extract, or mounting `BulkDocumentImport`.
- A write would rename a frozen identifier.

**Never:**
- OS folder-watch, “Open project folder”, or treating a directory as one Source.
- Overwriting an occupied tree key (FR-2). Empty directories are not invented (browsers omit them).
- Routing folder files through `/api/ingest/document` or widening that allowlist.
- Changing Knowledge|Files labels, rail order, or Preview type.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nested folder | Pick or drop `papers/energy/note.md` (+ other supported files) | Bytes at `raw/sources/papers/energy/note.md` (silo-visible); one job per file; Task/`IngestOptions` carry `papers/energy/note.md` | No error expected |
| Office in tree | Folder also has `deck.pptx` | PPTX refused with 2.1 sentence; no Source/job for it; `.md`/`.txt`/`.html` siblings still store and queue | Per-item; never silent |
| Mixed drop | Loose `a.md` plus expanded `notes/b.md` | `a.md` uses hash key; `notes/b.md` uses tree path; both queue | Folder refusal copy is gone |
| Empty folder | Directory picker or drop yields no files | No Source; visible sentence on the Folder action | No invented Source |
| Traversal | Client sends `relativePath=../../etc/passwd` | 400; no write | Same class as other malformed intake |
| Past depth cap | Relative path deeper than listable Files depth | That file refused visibly; shallower siblings still store | Named failure |
| Re-import | Same relative path already occupied | First bytes unchanged; no overwrite | Distinct arrival does not mutate |
| Read-only / unsigned | `YOPEDIA_READONLY` / no session | 403 / 401; no staging | Existing copy |
| Tenant isolation | Owner A folder import; B empty silo | B's Files `raw/` stays empty | No flat fallback |

</intent-contract>

## Code Map

- `src/lib/workbench-intake.ts:147-148,326-338` -- `INTAKE_FOLDER_COPY` still says folders cannot be added; `intakeSourceSlug` strips directory parts. Replace the sentence; add `INTAKE_FOLDER_LABEL` (`Folder`); add sanitizer + listable-depth helper for a relative path (do not reuse slug-only `intakeSourceSlug` as the stored key).
- `src/lib/workbench-intake-client.ts:69-92,151-162` -- `partitionIntakeFiles` skips `webkitRelativePath`. Stop skipping; send `relativePath` on the multipart (vault pattern at `BulkDocumentImport.tsx:182-184` — do not mount that component). `submitIntakeFiles` must not append `folderRefusedOutcome`.
- `src/lib/raw.ts:109-176` -- `storeRawSource(rest)` already writes any `raw/sources/<rest>` and mirrors/bumps. `saveRawSourceFor` still requires one slug + hex id. Add a tree writer (`saveRawSourceTree` or equivalent) that takes a sanitized relative path with extension, still refuses overwrite, still takes `{ owner }`.
- `src/app/api/workbench/intake/route.ts:127-133,207-208` -- File door always hashes. When `relativePath` is present and valid, write via the tree helper and pass that path into the Task / ingest options; missing `relativePath` keeps the 2.1 hash path. One arrival per request stays.
- `src/lib/ingest.ts:1266+` -- `IngestOptions` has no `relativePath`. `ingestDocument` already accepts it (`:490`) but this door must not call it. Add optional `relativePath` on `IngestOptions`; persist only — do not change the Generation prompt (2.6).
- `src/lib/tasks.ts:49-56,74` -- `staged.relativePath` exists; inline `content` tasks have no sibling field. Add optional top-level `relativePath` on kind `ingest` so a small folder file is not forced through staging just to carry context.
- `src/lib/workbench-tree.ts:43` -- `WORKBENCH_FILE_MAX_DEPTH = 4` hides `raw/sources/a/b/file.md` (depth 5). Raise so a mirrored tree lists; `isListablePath` (`workbench-files.ts:445`) uses the same cap.
- `src/components/workbench/IntakeControls.tsx:85-102` -- Single file input; tests ban `webkitdirectory` on **this** input (`workbench-left-column.test.ts:679-681`). Add a second hidden directory input + Folder button; keep Import / Upload unchanged. Do not put `webkitdirectory` on the existing picker.
- `src/components/workbench/Workbench.tsx` -- Shell drop already posts through `submitIntakeFiles`; once the client accepts expanded files, drop works. Overlay/busy/empty-list behavior stays.
- `src/lib/__tests__/workbench-intake.test.ts` -- Flip folder-skip cases to store+queue; add tree path, office-in-tree, traversal, depth-cap, mixed drop. Keep 2.1 hash cases for loose files.
- `src/lib/__tests__/workbench-left-column.test.ts:656-681` -- Expect Folder label; still ban “Open project folder”; `webkitdirectory` allowed only on the new input.
- `src/lib/__tests__/raw.test.ts`, `workbench-tree.test.ts` -- Tree write, no overwrite, silo + bump; Files lists `raw/sources/papers/energy/note.md`; empty silo isolation unchanged.
- `src/components/BulkDocumentImport.tsx` -- Pattern reference only.

## Tasks & Acceptance

**Execution:**
- `src/lib/raw.ts` -- Tree writer on `storeRawSource` for sanitized `raw/sources/<relative>` with extension; no overwrite; `{ owner }` mirror + bump -- FR-40 path identity hangs here.
- `src/lib/workbench-intake.ts` -- Folder label/copy; relative-path sanitize + depth check; retire “cannot be added yet”.
- `src/lib/workbench-intake-client.ts` -- Accept expanded files; POST `relativePath`; drop the folder-refusal outcome.
- `src/app/api/workbench/intake/route.ts` -- Honor valid `relativePath` via the tree writer; keep hash writer for loose files; put path on Task/`IngestOptions`.
- `src/lib/ingest.ts` / `src/lib/tasks.ts` -- Optional `relativePath` on options and inline ingest tasks (staged already has it).
- `src/lib/workbench-tree.ts` -- Raise Files depth cap so mirrored trees list.
- `src/components/workbench/IntakeControls.tsx` -- Folder control + directory input; Import / Upload unchanged.
- `src/lib/__tests__/workbench-intake.test.ts` -- I/O matrix: tree path, office-in-tree, mixed, traversal, depth, empty folder.
- `src/lib/__tests__/raw.test.ts` / `workbench-tree.test.ts` / `workbench-left-column.test.ts` -- Writer + listing + Folder chrome; folder-copy ban and silo isolation hold.

**Acceptance Criteria:**
- Given I import a nested folder, when Intake finishes storing, then stored paths under `raw/sources/` mirror the relative tree, each file is its own queue item, and that relative path is on the ingest Task/`IngestOptions` for Analysis/Generation later.
- Given the folder contains unsupported office binaries, when those files are considered, then each fails visibly as in 2.1, and supported text/markdown/HTML files still queue.
- Given the tree header, when I look at Intake chrome, then I see Import / Upload and Folder, and never “Open project folder”.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 2, medium 3, low 4)
- defer: 5: (high 0, medium 3, low 2)
- reject: 10
- addressed_findings:
  - `[high]` `[patch]` Occupied tree key still queued Ingest of the new body; `saveRawSourceTree` now reports `created` and the route skips enqueue when false
  - `[high]` `[patch]` Silo repair mirrored the request body; declined writes re-read the stored key and copy those bytes
  - `[medium]` `[patch]` Folder `<input accept>` hid office files; directory picker no longer sets `accept`
  - `[medium]` `[patch]` Backslash `webkitRelativePath` failed sanitize; normalize `\` to `/` then split
  - `[medium]` `[patch]` Non-string `relativePath` form field hashed; route answers 400 with `INTAKE_BAD_PATH_COPY`
  - `[low]` `[patch]` Folder button now shows `INTAKE_BUSY_COPY` while storing
  - `[low]` `[patch]` `INTAKE_DROP_COPY` invites folders as well as files
  - `[low]` `[patch]` `webkitdirectory` is set in the Folder input's attach callback, not only an effect
  - `[low]` `[patch]` Tests pin 6-segment refuse, non-allowlisted leaf, Folder chrome, empty Folder pick, silo-from-stored, occupied no-enqueue

## Design Notes

2.1 hash keys stay for loose files so a second `notes.md` does not collide. Folder identity is the relative path (FR-40); a re-import of the same tree hits `alreadyStored` and must not rewrite.

`webkitRelativePath` is `papers/energy/note.md` — keep the root folder segment. The route must not trust the field blindly; sanitize to the same shape the client computed.

Do not call `ingest()`'s LLM with the path in this story. Putting `relativePath` on the Task is what “later receive” means until 2.6.

Golden path: Folder pick or folder drop → `webkitRelativePath` → sanitize → `saveRawSourceTree` → silo + bump → `enqueueOrInline` with `relativePath` → `requestDataVersionCheck`. Files shows `raw/sources/papers/energy/note.md`.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/raw.test.ts src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: pass; tree paths list; Folder present; no “Open project folder”; brand scan clean
- `pnpm exec vitest run src/lib/__tests__/ingest-document-route.test.ts` -- expected: pass (vault document door unchanged)

## Auto Run Result

Status: done

**Summary:** Workbench Intake accepts a Folder pick and folder drop. Each supported file stores under `raw/sources/` at its sanitized relative tree path, auto-queues as its own Ingest job, and carries `relativePath` on the Task / `IngestOptions`. Loose files stay on the 2.1 hash writer. Occupied tree keys keep the first bytes and do not enqueue the new body. Files depth cap is 5 so a typical mirrored tree lists.

**Files:**
- `src/lib/workbench-intake.ts` — Folder label/copy, path sanitizer, listable-depth check, backslash normalize
- `src/lib/workbench-intake-client.ts` — accept expanded files; POST `relativePath`
- `src/lib/raw.ts` — `saveRawSourceTree`; silo repair from stored bytes; `created` flag
- `src/app/api/workbench/intake/route.ts` — tree writer vs hash writer; skip enqueue when not created; 400 on non-string path
- `src/lib/ingest.ts` / `src/lib/tasks.ts` / `src/app/api/tasks/run/route.ts` — optional `relativePath`; not interpolated into prompts
- `src/lib/workbench-tree.ts` — Files depth cap 5
- `src/components/workbench/IntakeControls.tsx` — Folder control; directory input without `accept`; attach-time `webkitdirectory`
- `src/components/workbench/Workbench.tsx` — empty Folder pick says `INTAKE_FOLDER_COPY`
- `src/app/globals.css` — Import / Upload + Folder row
- Tests: `workbench-intake`, `raw`, `workbench-tree`, `workbench-left-column`, `workbench-preview`, `tasks`

**Review:** 9 patches applied (2 high, 3 medium, 4 low). 5 deferred. 10 rejected (LLM prompt this story, `.DS_Store`/`__MACOSX`, writer re-check of extension, vestigial `partitionIntakeFiles`, unbounded recursion vs cap-5, batch-size/cancel, extra wiki walk depth, verification omitting preview/tasks as a gap, empty spec change/triage logs, Folder-as-one-job).

**Follow-up review recommended:** true — patched high 2, medium 3, low 4; score `3×3 + 1×4 = 13` (≥ 5) and high patches.

**Verification:**
- Spec command 1 plus `ingest-document-route`, `tasks`, `workbench-preview`: 474 passed (8 files)

**Residual risks:** Same-bytes skip is still 2.7; slugify collisions share one tree key; empty `webkitRelativePath` on an expanded folder still hashes; TOCTOU on exclusive create.
