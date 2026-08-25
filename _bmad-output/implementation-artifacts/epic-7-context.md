# Epic 7 Context: Any document in

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Office, PDF, and ebook files become ingest-ready text through one sidecar extract path, while inbound email and Plaud OAuth join the same kernel vault as upload and Capture. Preview then shows images, audio/video, Mermaid, and math in the Workbench so those formats are usable without leaving the shell. This is the P1 “any document in” surface: binaries no longer fail as unsupported, and every arrival still auto-queues two-step Ingest.

## Stories

- Story 7.1: Sidecar claims kernel extract jobs
- Story 7.2: PDF extract, cache, and MinerU
- Story 7.3: DOCX, PPTX, and spreadsheet extract
- Story 7.4: EPUB/MOBI extract
- Story 7.5: Inbound email Intake
- Story 7.6: Plaud OAuth list and pull
- Story 7.7: Image lightbox and AV player
- Story 7.8: Mermaid and KaTeX in Preview

## Requirements & Constraints

**One vault, visible failures.** PDF, DOCX, PPTX, XLSX/XLS/ODS, EPUB/MOBI, images, and audio/video either extract and Ingest or fail visibly — never a silent drop. Source bytes stay in the kernel even when extract or compile fails. Sidecar down: extract is unavailable (same fail-closed as Chat); stored bytes remain.

**Structured extract, not a dump.** PDF keeps text/layout with a SHA256 parse cache so identical bytes are not re-parsed. DOCX preserves headings, emphasis, lists, and tables as Markdown. PPTX is slide-by-slide so the Source summary can be navigated by slide. Spreadsheets keep cell types, include every sheet, and emit Markdown tables — no in-app sheet or slide editor. Ebooks yield metadata, chapters, and body. Web clips stay clean main-content Markdown in the kernel; they are not a sidecar crate.

**MinerU is optional and private-first.** Default off; built-in PDF extract still runs. Complex-layout failure is visible. If enabled, first mode is Local API, not Cloud. A Cloud choice must warn that documents leave the machine. Settings apply only after Save.

**Email and Plaud arrive the same way.** Inbound address only — not a connected mailbox and not a mail client. Message and/or attachments become Sources with from, received time, and subject, then auto-queue (extract job if binary). Plaud OAuth list/pull is the P1 path beside existing upload; transcript and/or summary land as Sources with Plaud-origin provenance so meeting Todo rules still apply. Auth or incomplete pull fails closed with no partial Page writes. Do not treat Plaud action items as Todos. PPT/PDF/office stay off for Todo Candidates unless the Source is Plaud-origin or marked meeting.

**Media and math are usable in-place.** Browser-renderable images show in Preview (not filename-only); click opens a lightbox with jump-to-source; Esc closes. Search shows an image section for hits under `wiki/media/`, `raw/assets/`, or `![]()`. Video/audio play in-pane; player failure does not delete the Source; media still Ingests via transcript/description when the pipeline allows. Mermaid fences render as diagrams; `$…$` / `$$…$$` render as KaTeX. Existing GFM tables, code, and wikilinks keep working. English-only UI and generation.

**Device and Intake.** Binary extract requires the sidecar on the same machine as the browser. Other Clerk sessions may still use tree, Preview, and search. Intake replaces OS folder-watch; auto-queue on arrival stays always on. Extract/parsers may run ahead of the serial Ingest Generation slot.

## Technical Decisions

**Kernel queues; sidecar claims.** Raw bytes go to `raw/sources/` first. If extract is required, the kernel enqueues an extract job. The sidecar claims it, writes extracted text back through owner-auth kernel HTTP, then kernel two-step Ingest runs. Sidecar disk is extract temp only — no second vault. Browser drop may send bytes to the sidecar but must still POST raw + text into the kernel. Plain text, markdown, and URL Intake skip extract.

**Rust extractors in the sidecar.** Use pdf-extract 0.12.0 (cached), docx-rs 0.4.22, calamine 0.36.1, PPTX via ZIP+XML, EPUB/MOBI in the same process. Do not put JS office parsers in the Worker. The sidecar lives at `sidecar/` and does not import `src/lib` or compile Pages. Web clips stay kernel Readability + existing htmlToMarkdown.

**Settings and provenance.** MinerU and Intake settings persist in the kernel store. Optional keep of parsed Markdown under `raw/parsed`. Successful wiki writes still bump dataVersion. Display copy is work-wiki; runtime identifiers stay `yopedia`.

## UX & Interaction Patterns

Settings → Intake: copyable inbound address, Plaud upload plus OAuth list/pull, allowed file-type grid. Settings → MinerU PDF: Cloud / Local API / Pipeline; orange warning callout if Cloud uploads documents; sticky Save. Activity must show extract/pending failure, not a silent skip.

Lightbox is one overlay (dim + image + jump-to-source); Esc closes; no second modal. Preview body and headings stay Georgia; Chat answers and chrome stay system sans. Preview remains view-first (confirm-gated markdown escape hatch, no WYSIWYG). Empty canvases stay one muted sentence.

## Cross-Story Dependencies

7.1 is the job path: 7.2–7.4 implement format extractors on it; 7.5 and 7.6 enqueue through the same door (binaries need extract before compile). 7.7 and 7.8 are Preview/Search/Chat rendering and can proceed without extract crates, but media Ingest still uses the Epic 2 arrival contract.

Depends on Epic 2 Intake, serial queue, SHA256 skip, Activity, two-step compile, and Plaud upload. Epic 4’s Plaud-or-marked-meeting Candidate rule applies to 7.6 pulls. Epic 1 already ships GFM, wikilinks, type lock, and Settings chrome; 7.8 only adds Mermaid/KaTeX. Does not wait on Epic 6 or Epic 8.
