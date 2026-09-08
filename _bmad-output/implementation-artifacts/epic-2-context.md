# Epic 2 Context: Sources compile

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn Intake into a compiled wiki: text, URLs, folders, Capture, and Plaud uploads store as immutable Sources and auto-queue two-step Ingest. Activity shows skip, cancel, and retry; every success leaves bookkeeping and a Source summary; delete cascades cleanly; ZIP is the backup path. Knowledge compounds across arrivals instead of being re-derived from raw files each time.

## Stories

- Story 2.1: Upload, drag-drop, and URL Intake
- Story 2.2: Recursive folder import
- Story 2.3: Capture URL or clip
- Story 2.4: Plaud transcript and summary upload
- Story 2.5: Serial durable queue and Activity
- Story 2.6: Two-step Analysis then Generation
- Story 2.7: SHA256 skip cache
- Story 2.8: Index, Log, Overview, Source summary
- Story 2.9: Embed after Ingest only when vector is on
- Story 2.10: Confirm-gated cascade Source delete
- Story 2.11: Progressive Sources view
- Story 2.12: ZIP export and import

## Requirements & Constraints

**Arrival always compiles.** Upload, drag-drop, folder import, Capture, and Plaud upload store under `raw/sources/` and enqueue two-step Ingest — no second “process this” click, no OS folder-watch. A batch of N files is N jobs; failures are per-item. HTML URLs become main-content Markdown via Readability + existing `htmlToMarkdown` (not Turndown).

**Sources are immutable; Pages accumulate.** Ingest never mutates stored bytes. Generated Pages carry YAML `sources: []` (bookkeeping Pages excepted). New material merges into existing concept Pages. Contradictions set `disputed: true` and stay visible; mechanical cleanup must not clear it.

**Two-step compile.** Analysis runs first (entities, concepts, arguments, links to existing Pages, tensions, recommended structure) and is stored with the job. Generation starts only after Analysis succeeds and must consume that artifact. Generation-only retry reuses Analysis. LLM Generation is English-only. SCHEMA page conventions load into the Ingest prompt at runtime.

**Visible, durable queue.** Per Wiki, Analysis/Generation LLM work is serial (Chat may overlap later). Queue survives restart. Auto-retry at most 3, then stay failed for manual retry. Retry must not duplicate the Source. Cancel must not commit Page writes (in-flight LLM may finish server-side). Unsupported or office/ebook types fail visibly — never a silent drop. This epic does not run sidecar extract.

**Skip unchanged bytes.** Hash with SHA256 (not the fork’s FNV-1a). Same hash: no LLM, Activity shows skipped, provenance records a re-see. Any byte change re-queues full two-step Ingest.

**Success includes bookkeeping.** On Generation success: update `index.md`, append `log.md`, regenerate `overview.md` every time, bump `dataVersion` so trees/Preview refresh without a full reload. Always write a Source summary that cites the Source (system fallback if the model omits it); do not parse summary metadata from free-form LLM headings. Ingest may persist Review items with proposed search queries; it must not wait on Review UI and must not create Todos.

**Plaud and Capture.** Transcript and/or summary are Sources with Plaud-origin provenance. Do not treat Plaud action-item lists as Todos. Upload is the only Plaud path here. Capture (bookmarklet, share, or in-app URL) stores clean Markdown with the captured URL; empty or blocked Capture fails on that action and invents no Source. Unsigned Capture fails closed.

**Folder import.** Stored paths mirror the relative tree. The relative path is classification context for Analysis/Generation. Unsupported binaries fail visibly; supported text/markdown still queues.

**Embed is optional.** Vector search stays off by default; Ingest succeeds with no embed. When on, new/updated Pages embed automatically and are model-tagged. Turning vector on for an existing Wiki enqueues embed of current Pages (progress in Activity); turning it off does not delete Sources or Pages.

**Cascade delete.** Confirm-gated. Always remove the Source summary first. Related Pages are found only by (1) `sources: []`, (2) Source-summary name, or (3) YAML field values that are that Source path/slug — not body prose. Sole-Source Pages delete; shared Pages keep and drop that Source from `sources: []` only. Strip dead `[[wikilinks]]` to deleted Pages; purge those Pages from `index.md`. Unmatched Pages are untouched. Linked Todos (when they exist later) show source-missing — they are not silently deleted.

**ZIP backup.** Export Pages, Sources, and auto-generated `.obsidian/`; include Todos and chat record-shape when those records exist. Import restores into the kernel store. Rebuilding `index.md` from current Pages is deterministic. Every queued job ends in success, skip, cancel, or explicit failure after retries — never disappeared. Sources persist even when compile fails. Export is owner-initiated.

## Technical Decisions

**Kernel compiles.** Two-step Ingest stays in the TypeScript kernel once text is in `getStorage()`. Page writes go only through `writeWikiPageWithSideEffects`; deletes through `deleteWikiPage`; Source bytes through `saveRawSource` / `saveRawSourceFor`. Do not add a second markdown or raw-source writer.

**Queue.** Durable Cloudflare Queues. Thin consumer POSTs this fork’s `/api/tasks/run` with `YOPEDIA_SERVICE_TOKEN` (2xx ack, 4xx poison-ack, 5xx retry). Do not point the consumer at upstream yopedia. Deep Research later has its own queue and must not share this serial Ingest LLM slot. Intake fetch/store may run ahead of serial compile.

**SoR and identity.** Canonical bytes live in the kernel store. Runtime identifiers stay `yopedia`; display copy is work-wiki. Pages and Sources are shared across the operator’s Wikis (a Wiki is a lens). Office/PDF/ebook extract, inbound email, and Plaud OAuth are later; if extract is someday required, bytes still land in the kernel first.

## UX & Interaction Patterns

Sources mode is a progressive `raw/sources/` tree with Import / Upload / Folder / URLs — never “Open project folder.” Capture is not a rail icon. Large trees paint the visible window first; scrolling must not remount the tree and lose position. Empty canvases: one muted sentence plus optional one primary; no illustration or emoji.

Activity docks under the left column on Wiki, Sources, and Files, and is collapsible. One row per file: pending / Analysis / Generation / succeeded / skipped / failed, plus a progress bar for queue depth and the active step. Failed rows show an error and retry; copy states the Source is stored. SHA256 hits show skipped. Workbench stays interactive while Ingest runs.

Drag-drop onto the shell stores and auto-queues. Source delete uses a single confirm overlay; Cancel writes nothing. Compact frontmatter may show `sources: []` and `disputed` when set.

## Cross-Story Dependencies

Intake (2.1–2.4) only stores and enqueues; Activity/queue (2.5), two-step compile (2.6), skip cache (2.7), and bookkeeping (2.8) are the compile contract every arrival must hit. Embed (2.9) must not gate success when vector is off. Delete (2.10) and ZIP (2.12) use the same lifecycle/store as Ingest writes.

Depends on Epic 1: Workbench, dual models, vector-off default, runtime SCHEMA, `dataVersion` refresh. Must not extract or auto-approve Todos (Epic 4). Review UI, Graph, and Lint are later. Save-to-Wiki, Deep Research, email, and API/MCP reuse this auto-queue contract. Office extract and Plaud OAuth stay out of this epic.
