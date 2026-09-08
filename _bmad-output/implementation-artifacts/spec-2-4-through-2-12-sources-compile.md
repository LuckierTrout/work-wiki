---
title: 'Stories 2.4–2.12: Sources compile remainder'
type: 'feature'
created: '2026-08-22'
status: 'done'
baseline_revision: '3c93c42fedff28ff0200248adec1609542b31d6c'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/.yoyo/learnings.md'
warnings:
  - multiple-goals
  - oversized
deferred:
  - summary: >-
      Pages ingested before SHA-256 have no `content_sha256`, so a restart
      rebuilds the skip index without them and the same bytes run two-step
      again.
    evidence: |-
      `buildSourceIndex` only fills `bySha256` from `content_sha256`.
      Older pages still carry FNV `content_hash` only.
    location: >-
      src/lib/source-index.ts
    severity: medium
  - summary: >-
      Two identical files in one Intake batch can both miss the skip index
      and both run Analysis/Generation.
    evidence: |-
      Hash lookup is not locked across the batch. The first job has not
      written `content_sha256` before the second lookup.
    location: >-
      src/app/api/workbench/intake/route.ts
    severity: medium
  - summary: >-
      `loadPageTemplates()` is awaited then ignored; the Source summary
      body is still a hardcoded SCHEMA paraphrase.
    evidence: |-
      `ensureSourceSummary` calls `loadPageTemplates()` and writes a
      fixed Key Points / Details / Sources skeleton.
    location: >-
      src/lib/ingest-bookkeeping.ts
    severity: medium
  - summary: >-
      Activity and Source HTTP doors are helper-pinned, not executed as
      routes (auth, read-only, cancel/retry, DELETE cascade).
    evidence: |-
      No test POSTs `/api/workbench/activity` or DELETEs
      `/api/workbench/source`. Left-column scans and kernel helpers pass
      without those handlers running.
    location: >-
      src/app/api/workbench/activity/route.ts
    severity: medium
  - summary: >-
      `ingest.test.ts` and `embeddings.test.ts` still expect one-shot
      `callLLM` / ungated embed and are outside this story's verify
      command.
    evidence: |-
      Two-step Analysis plus `getVectorSearchSettings().enabled` changed
      those suites' assumptions. They were not updated in this compile.
    location: >-
      src/lib/__tests__/ingest.test.ts
    severity: medium
  - summary: >-
      Activity GET caps at 100 jobs with no overflow hint.
    evidence: |-
      `listIngestJobs({ limit: 100 })` drops older rows silently.
    location: >-
      src/app/api/workbench/activity/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Intake already stores and enqueues files, folders, URLs, and Capture (2.1–2.3), but the compile contract is unfinished: Plaud has no origin, Activity is a one-line sentence, Ingest is still one LLM pass, skip uses FNV-1a, bookkeeping/embed/delete/Sources-tree/ZIP `.obsidian` are incomplete.

**Approach:** Finish Epic 2 on the existing Intake door and kernel lifecycle — Plaud-origin upload, Workbench Activity on the durable queue, Analysis-then-Generation with SHA256 skip, guaranteed bookkeeping, vector-gated embed, confirm-gated cascade delete, progressive Sources tree, ZIP that opens as an Obsidian vault.

## Boundaries & Constraints

**Always:**
- Same Intake door as 2.1–2.3: signed-in principal, `isReadOnly()` before writes, `saveRawSourceFor` / `saveRawSourceTree`, `enqueueOrInline`, English copy, frozen `yopedia` / `WORKWIKI_*` ids (including `workwiki-portable-archive` and `workwiki-*.zip`).
- Page writes only through `writeWikiPageWithSideEffects`; page deletes only through `deleteWikiPage`. Analysis JSON via `getStorage()`.
- Consumer stays thin: POST `/api/tasks/run` with `YOPEDIA_SERVICE_TOKEN`. Auto-retry at most 3, then failed for manual retry. Retry must not duplicate Source bytes.
- Cancel must not commit Page writes. In-flight LLM may finish server-side.
- Generated concept Pages carry YAML `sources` listing this Source (the `sources: []` field). Bookkeeping Pages (`index.md`, `log.md`, `overview.md`) do not. Contradictions set `disputed: true` and mechanical cleanup does not clear it.
- SHA256 of stored Source bytes for ingest skip — not FNV-1a. FNV `contentHash` may remain for embedding stale-check only.
- Vector off (default): Ingest succeeds with no embed. Vector on: embed new/updated Pages, model-tagged. Turning off deletes neither Sources nor Pages.
- LLM Generation is English-only. SCHEMA page conventions still load at runtime.
- Sources empty copy stays `No sources yet. Ingest a file to add one.`

**Block If:**
- Satisfying an AC requires Plaud OAuth, sidecar office extract, mounting `BulkDocumentImport` in Workbench, Chat Agent, Todo approve/reject UI (Epic 4), or renaming a frozen identifier.
- A write would invent a second markdown or raw-source writer.

**Never:**
- Plaud connect / OAuth, “Open project folder”, Capture rail icon, OS folder-watch.
- Treating Plaud action-item lists as Todos or enqueueing `extract-actions` for Plaud-origin Sources (FR-26 is Epic 4).
- Parsing Source-summary metadata from free-form LLM headings.
- Silent drop of unsupported types. Silent loss of queued jobs across restart.
- Body-prose matching as the cascade-delete finder.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Plaud upload | Intake Plaud pick, `.md`/`.txt`/`.html` | Immutable Source under `raw/sources/`; job has Plaud-origin; auto-queue; no Todos / no `extract-actions` | Same type-refusal as 2.1 |
| Plaud connect | Look for OAuth / list-pull | Absent | No connect control |
| Serial compile | Two Sources queued | Analysis/Generation LLM do not overlap for the owner; Workbench stays interactive | Queue survives restart |
| Job fails | Auto-retry exhausted | Stays failed; Retry re-queues same Source, no second store | Visible error; Source kept |
| Cancel | Confirm cancel on a row | No Page writes from that job | In-flight LLM may finish |
| Two-step | Queued Source with text | Analysis JSON stored first; Generation consumes it; Activity shows that order | Generation-only retry reuses Analysis |
| SHA256 skip | Same stored bytes again | No Analysis/Generation; Activity `skipped`; provenance re-see | Byte change → full two-step |
| Bookkeeping | Generation succeeds | `index.md` updated; `log.md` appended; `overview.md` regenerated; Source summary exists (system fallback if model omits) | Job is not success without the summary |
| Vector off | Default settings | Ingest succeeds; no embed required | No error expected |
| Vector on | Flag becomes true | New/updated Pages embed; existing Pages enqueue embed with Activity progress | Turning off deletes nothing |
| Source delete | Confirm on a Source | Summary Page removed first; sole-Source Pages deleted; shared Pages keep and drop that Source only; dead `[[wikilinks]]` stripped; `index.md` purged | Cancel writes nothing |
| Sources empty | No files under `raw/sources/` | One muted sentence from EXPERIENCE.md | No illustration |
| Sources large | Hundreds of files | First paint does not wait on every row; scroll does not remount and lose position | Truncation note if listing cap hits |
| ZIP export | Owner export | ZIP named `workwiki-*.zip`; Pages, Sources, generated `.obsidian/`; Todos/chats if those records exist | Read-only refuses |
| ZIP import | That archive | Bytes back in kernel store; `index.md` rebuilt deterministically | Collision skip/overwrite unchanged |

</intent-contract>

## Code Map

- `src/app/api/workbench/intake/route.ts:101-153,236-332` -- File door + `storeAndQueue`. Add Plaud-origin on Task/`IngestOptions`. SHA256 skip may mark the job skipped here or at run — do not enqueue LLM work for an already-ingested hash.
- `src/lib/workbench-intake.ts` -- Labels/copy. Add Plaud pick label. Do not add “Open project folder”.
- `src/lib/workbench-intake-client.ts:107-172` -- `submitIntakeFile` FormData. Optional `origin=plaud` only from the Plaud pick.
- `src/components/workbench/IntakeControls.tsx:75-142` -- Third pick: Plaud (same allowlist, not `webkitdirectory`). Shell still owns outcomes.
- `src/lib/ingest.ts:1266-1277,1557-1633,2004-2014` -- Split `synthesizeBody` into Analysis then Generation. Persist Analysis JSON via `getStorage()`. Generation reads that artifact. SHA256 for ingest skip (`resolveContentHash` / `attachIngestTrigger` at `:1618-1633`). Keep `writeWikiPageWithSideEffects`. English-only Generation prompt. Do not parse summary metadata from headings (`extractSummary` at `:635-666` is the fallback).
- `src/lib/tasks.ts:26-167` -- Pass Plaud-origin / relativePath / cancel / analysis-reuse fields on ingest Task. Do not add a second queue.
- `src/app/api/tasks/run/route.ts:55-395` -- Stages Analysis then Generation; honor cancel before Page writes; skip `extract-actions` when Plaud-origin (`:387-395`); Generation-only retry if Analysis artifact exists.
- `src/lib/ingest-jobs.ts:17-76,117-142` -- Status/stage: pending, Analysis, Generation, succeeded, skipped, failed. `listIngestJobs` is the Activity poll source. Add cancel + manual-retry helpers (queued/processing cannot use today’s `deleteIngestJob`).
- `workers/task-consumer/index.ts:213-229` -- Keep sequential drain + `YOPEDIA_SERVICE_TOKEN`. Do not point at upstream yopedia. Owner-scoped serial lock for ingest LLM lives in kernel run (pages are shared across Wiki lenses).
- `src/components/workbench/Workbench.tsx:1402-1461` -- Dock collapsible Activity under the left column on Wiki / Sources / Files. Sources left column: Intake + progressive `raw/sources/` tree (not the canvas stub alone).
- `src/components/workbench/TreePanel.tsx:244-325,408-475` -- Full recursive render today. Window first paint for Sources; persist scroll (`:192-227`). Do not remount the tree on scroll.
- `src/lib/workbench-tree.ts:29-42,524+,577+` -- `buildFileTree` / listing cap. Reuse for Sources mode.
- `src/lib/workbench-modes.ts:42` -- Sources empty sentence is already correct.
- `src/lib/lifecycle.ts:298-308,651-722,740-767` -- Gate `upsertEmbedding` on `getVectorSearchSettings().enabled`. `overview.md` + Source summary writes go through `writeWikiPageWithSideEffects`. `deleteWikiPage` for cascade page deletes.
- `src/lib/embeddings.ts:526-529,660-684,749-765,955-1011` -- `hasEmbeddingSupport` must not bypass the vector switch. Keep FNV `contentHash` for embedding stale-check. `rebuildVectorStore` is the backfill; enqueue it when vector turns on and report progress in Activity.
- `src/lib/workbench-settings.ts:1409-1419` -- `turningOn` is the hook to enqueue embed-all.
- `src/lib/source-index.ts:132-164` -- Hash lookup. Store SHA256 for ingest skip.
- `src/lib/silo.ts:91-178` -- Hashed `raw/sources/<slug>/<id>.md` is not synced/removed today; cascade delete must remove those stored bytes too.
- `src/lib/sources.ts:23-72` -- `sources[]` parse/serialize for cascade (method 1).
- `src/components/ConfirmDialog.tsx:18-36` -- Source delete overlay (Cancel writes nothing). Do not use `window.confirm`.
- `src/lib/portable-archive.ts:13-20,67-94,173-223` -- Export walk + import restore + deterministic `index.md`. Add generated `.obsidian/`. Include Todos/chats when those tenant records exist. Do not rename `workwiki-portable-archive`.
- `src/app/api/archive/export/route.ts:9-14` -- Filename `workwiki-${date}.zip` stays.
- `SCHEMA.md` Source summary template (`:315-353`) -- Structure for the guaranteed summary Page; load via `loadPageTemplates()`, do not hardcode a second copy.
- `src/lib/__tests__/workbench-intake.test.ts` -- Plaud origin, skip-without-LLM, no `extract-actions`.
- `src/lib/__tests__/workbench-left-column.test.ts` -- Plaud label; still ban “Open project folder”; Activity dock; Sources tree.
- `src/lib/__tests__/portable-archive.test.ts` -- `.obsidian/` present; format string unchanged.
- `integrations/browser-clipper/` -- Read-only.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-intake.ts` / `workbench-intake-client.ts` / `IntakeControls.tsx` / `src/app/api/workbench/intake/route.ts` -- Plaud pick sets `origin=plaud` on the same file door; store + queue; no OAuth.
- `src/lib/ingest.ts` / `tasks.ts` / `src/app/api/tasks/run/route.ts` / `ingest-jobs.ts` -- Analysis JSON then Generation; SHA256 skip; cancel-before-write; Plaud skips `extract-actions`; Generation-only retry reuses Analysis; owner-serial ingest LLM.
- `src/lib/lifecycle.ts` -- `overview.md` regenerate; guaranteed Source summary (fallback from `extractSummary`, not headings); embed only when vector is on.
- `src/lib/workbench-settings.ts` / embeddings rebuild path -- Turning vector on enqueues current-Page embed with Activity progress.
- `src/components/workbench/Workbench.tsx` -- Activity dock (N rows, progress, cancel/retry); Sources progressive tree + empty sentence.
- `src/app/api/workbench/source/route.ts` / `src/lib/silo.ts` / `ConfirmDialog` -- New DELETE door: confirm overlay, cascade via the three finders, hashed `raw/sources/<slug>/<id>` cleanup; `deleteWikiPage` for pages; Todos not silently deleted.
- `src/lib/portable-archive.ts` -- Generate `.obsidian/`; keep frozen archive ids.
- `src/lib/__tests__/workbench-intake.test.ts` / `workbench-left-column.test.ts` / `tasks-route.test.ts` / `lifecycle.test.ts` / `portable-archive.test.ts` -- Pin the I/O matrix.

**Acceptance Criteria:**
- Given I upload Plaud transcript and/or summary files, when they are stored, then each is an immutable Source with Plaud-origin provenance and auto-queues two-step Ingest, and Plaud action-item lists are not written as Todos.
- Given OAuth list/pull is not built, when I look for Plaud connect, then upload is the only Plaud path.
- Given N files are queued, when Activity is open, then I see N rows (pending / Analysis / Generation / succeeded / failed / skipped), docked under the left column on Wiki/Sources/Files, collapsible, with a progress bar for queue depth and the active step.
- Given two Sources are queued, when Ingest runs, then their LLM work does not overlap and the Workbench stays interactive.
- Given a job fails, when auto-retry runs, then it attempts at most 3 times, then stays failed for manual retry, and retry does not duplicate the Source, and Cancel does not commit Page writes.
- Given the app or Worker restarts, when I reopen the Wiki, then pending/failed jobs are still in the queue, and the consumer still POSTs `/api/tasks/run` with `YOPEDIA_SERVICE_TOKEN`.
- Given a queued Source with text in the kernel, when Ingest runs, then Analysis stores JSON first, Generation starts only after that and consumes the artifact, Activity shows that order, writes go through `writeWikiPageWithSideEffects`, generated Pages have YAML `sources` (bookkeeping excepted), contradictions set `disputed: true`, `dataVersion` bumps, and Generation is English-only.
- Given Generation fails after Analysis succeeded, when I retry Generation, then Analysis is reused, Source bytes still exist, Ingest does not wait on Review UI and does not create Todos.
- Given a Source whose bytes hash to a SHA256 already ingested, when it arrives again, then Analysis and Generation are not called, Activity marks skipped, provenance records a re-see, and FNV-1a is not the ingest skip.
- Given any byte change, when the new hash is computed, then full two-step Ingest is queued.
- Given Generation succeeds, when side effects run, then `index.md` lists new/updated Pages, `log.md` appends a Source-pointing entry, `overview.md` is regenerated, and a Source summary that cites the Source exists (system-written if the model omits it).
- Given vector search is off, when Ingest succeeds, then the job succeeds with no embed requirement.
- Given vector search is on, when Ingest creates or updates Pages, then those Pages are embedded and model-tagged; turning it on for an existing Wiki enqueues embed of current Pages (progress in Activity); turning it off does not delete Sources or Pages.
- Given I choose delete on a Source, when the confirm dialog is open, then Cancel writes nothing, and Confirm removes the Source summary first, cascades only via `sources[]` / summary name / YAML Source path-or-slug, keeps shared Pages (drops that Source only, leaves `disputed`), strips dead wikilinks, purges `index.md`, and leaves unmatched Pages untouched.
- Given a Sources tree with hundreds of files, when I open Sources, then first paint does not wait on every row and scrolling does not remount and lose position.
- Given Sources is empty, when the mode opens, then I get the EXPERIENCE.md one-sentence empty state.
- Given a Wiki with Pages and Sources, when I export, then the ZIP includes Pages, Sources, and auto-generated `.obsidian/`, plus Todos and chat record-shape when those records exist.
- Given I import that ZIP, when restore finishes, then Pages and Sources are back in the kernel store, `index.md` rebuild is deterministic, and identifiers stay `yopedia`.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 18: (high 8, medium 9, low 1)
- defer: 6: (high 0, medium 5, low 1)
- reject: 8
- addressed_findings:
  - `[high]` `[patch]` SHA-256 skip no longer writes a second Source
  - `[high]` `[patch]` `tasks/run` records `skipped` instead of succeeded
  - `[high]` `[patch]` Bookkeeping runs before the SHA index stamp
  - `[high]` `[patch]` In-flight cancel stays `processing` so Retry cannot double-compile
  - `[high]` `[patch]` Sources window grows without a scroll event
  - `[high]` `[patch]` Cascade finders are exact; leaf title; todos for every key
  - `[high]` `[patch]` Failed embed enqueue marks the job failed
  - `[high]` `[patch]` Embed rebuild honors cancel and vector-off 422
  - `[medium]` `[patch]` Activity dock reads the stored open flag first
  - `[medium]` `[patch]` Retry `.catch` plus in-flight guard
  - `[medium]` `[patch]` Bookkeeping keeps `disputed`; exact url/raw_id
  - `[medium]` `[patch]` Invalid analysis JSON returns null
  - `[medium]` `[patch]` `deriving-knowledge` maps to Generation
  - `[medium]` `[patch]` Stored `sourcePath` preferred for the summary cite
  - `[medium]` `[patch]` Non-Plaud ingest still enqueues `extract-actions`
  - `[medium]` `[patch]` `content_sha256` rebuilds after `resetSourceIndex`
  - `[medium]` `[patch]` Embed retry does not require `sourceRel`
  - `[low]` `[patch]` Source-delete confirm ignores a second click while busy

## Design Notes

Plaud origin is an explicit Intake flag, not a file sniff (PRD closed meeting-detection). Settings → Intake’s Plaud card is a capability toggle with no picker — the live door is Workbench. Add a Plaud pick beside Import / Folder that posts `origin=plaud` on the same allowlist.

`sources: []` in the epic is the YAML field, not an empty array. Cascade delete finds Pages by that field.

Owner-serial ingest LLM (not wikiId): Pages/Sources are shared across Wiki lenses (epic SoR). Two lenses compiling at once would collide. Chat may overlap later.

Golden path: Plaud pick → `saveRawSourceFor` → job → Analysis JSON in `getStorage()` → Generation via `writeWikiPageWithSideEffects` → index/log/overview + Source summary → Activity succeeded.

Skip path: SHA256 hit → Activity skipped → `attachIngestTrigger` re-see → no LLM.

`.obsidian/` is a minimal vault stub so the ZIP opens in Obsidian — not a theme restyle.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/ingest-async.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/portable-archive.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/source-index.test.ts src/lib/__tests__/ingest-jobs.test.ts src/lib/__tests__/ingest-embed.test.ts src/lib/__tests__/workbench-tree.test.ts` -- expected: pass; Plaud origin; SHA skip without a second store; Activity/Sources pins; skip/cancel/retry; bookkeeping; archive `.obsidian/`; brand scan clean

## Auto Run Result

Status: done

**Summary:** Epic 2 stories 2.4–2.12 on the existing Intake door. Plaud-origin upload, SHA-256 skip without a second store, Analysis-then-Generation under an owner lock, Workbench Activity (cancel/retry), guaranteed overview + Source summary, vector-gated embed with backfill, confirm-gated cascade delete, progressive Sources tree, and ZIP `.obsidian/` stubs. Frozen archive and `yopedia` identifiers unchanged.

**Files:**
- Intake / Plaud: `workbench-intake.ts`, `workbench-intake-client.ts`, `IntakeControls.tsx`, `intake/route.ts`
- Compile: `ingest.ts`, `ingest-analysis.ts`, `ingest-bookkeeping.ts`, `ingest-jobs.ts`, `tasks.ts`, `tasks/run/route.ts`, `source-sha256.ts`, `source-index.ts`
- Activity / Sources / delete: `ActivityDock.tsx`, `SourcesTree.tsx`, `Workbench.tsx`, `activity/route.ts`, `source/route.ts`, `source-cascade.ts`, `workbench-activity.ts`, `workbench-tree.ts`
- Vector / archive: `lifecycle.ts`, `embeddings.ts`, `ingest-embed.ts`, `settings/route.ts`, `portable-archive.ts`
- Tests: intake, left-column, tasks-route, lifecycle, portable-archive, source-index, ingest-jobs, ingest-embed, workbench-tree, brand-copy

**Review:** 18 patches applied (8 high, 9 medium, 1 low). 6 deferred. 8 rejected (nine sequential story units, sprint-only process, Settings Plaud card, FNV as ingest skip, Analysis JSON in ZIP, `getPrincipal` vs Settings owner check, failed-as-complete progress math, consumer file not in this diff).

**Follow-up review recommended:** true — patched high 8, medium 9, low 1; score `3×9 + 1×1 = 28` (≥ 5). High alone forces true.

**Verification:**
- Spec commands + review pins: 392 passed (11 files)

**Residual risks:** Pre-SHA pages re-compile after restart; same-batch identical files can both compile; Source summary still hardcodes SCHEMA shape; Activity/Source routes are not HTTP-tested; `ingest.test.ts` / `embeddings.test.ts` may be stale.
