---
title: 'Stories 7.1–7.8: Any document in'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_revision: 0e71858ebcd8c7900d3da26dc07c37d0062619a0
review_loop_iteration: 0
followup_review_recommended: true
context:
  - AGENTS.md
  - _bmad-output/implementation-artifacts/epic-7-context.md
  - .yoyo/learnings.md
intent_resolution: auto
intent_resolution_reason: >-
  Freeform epic-story range 7.1–7.8 from the invocation, sprint-status.yaml
  keys, and compiled epic-7-context. Planning epics.md is not the contract.
  Fast-path assumptions tagged below. Do not edit this spec's
  <intent-contract>.
warnings:
  - multiple-goals
  - oversized
deferred:
  - summary: >-
      Generic URL ingest (`fetchUrlContent` / `ingestUrl`) still Worker-parses
      `application/pdf` via unpdf when the caller uses the default allowlist.
    evidence: |-
      Pre-existing Epic 2 path. Workbench URL Intake already excludes PDF.
      The vault `{ pdfUrl }` door and leftover `source:pdf` tasks now fetch
      bytes and enqueue extract. Other callers of ingestUrl were not retargeted.
    location: >-
      src/lib/fetch.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Workbench Intake still refuses office/PDF/ebook/media, kernel JS still parses those formats on the Worker, inbound email and Plaud sit off the extract job path, and Preview/Chat dump images, AV, Mermaid, and math as filenames or raw fences.

**Approach:** Store raw bytes in the kernel, enqueue extract jobs the sidecar claims with Rust crates, then run two-step Ingest. Surface inbound email and Plaud OAuth on Settings → Intake. Render images, AV, Mermaid, and KaTeX in-place in Workbench Preview and Chat.

## Boundaries & Constraints

**Always:**
- Kernel stores raw first (`saveRawSource` / `saveRawSourceFor` / `saveRawSourceTree`, first-write-only). Extract-required arrivals enqueue an extract job before two-step Ingest. Sidecar claims the job, writes extracted text back through owner-auth kernel HTTP (`getServicePrincipal`), then kernel Ingest runs. No second vault on sidecar disk except extract temp.
- Sidecar down or missing extract credential: extract is unavailable (fail closed, same class as Chat). Source bytes stay. Activity shows extract/pending failure with `Extract is unavailable — the sidecar is down.` — never a silent drop.
- Rust extractors live under `sidecar/` and do not import `src/lib`: pdf-extract 0.12.0 (SHA256 parse cache), docx-rs 0.4.22 or ZIP+XML WordprocessingML in that same Rust process, calamine 0.36.1 (XLSX/XLS/ODS, all sheets, cell types → Markdown tables), PPTX via ZIP+XML slide-by-slide, EPUB/MOBI in the same process. Web clips stay kernel Readability + `htmlToMarkdown`. Worker JS (`document-extract` / `unpdf` / fflate) is not the v1 extract path for those binaries.
- MinerU default off. Built-in pdf-extract still runs. Enabling MinerU offers Local API first, not Cloud. Cloud shows an orange warning that documents leave the machine. Settings apply only after Save. Pane is Settings → MinerU PDF.
- Email is inbound-address only (existing Cloudflare Email Routing Worker). Not a connected mailbox. Message and/or attachments become Sources with from, received time, and subject, then auto-queue (extract job if binary). Settings → Intake shows the copyable inbound address and replaces Source Folder Auto Watch. No OS folder-watch.
- Plaud OAuth list/pull writes transcript and/or summary as Sources with `origin: "plaud"`. Meeting Todo rules still apply. Auth or incomplete pull fails closed with no partial Page writes. Do not treat Plaud action items as Todos.
- Preview: browser-renderable images show as images; click opens one lightbox (dim + image + jump-to-source to the containing Page or Source); Esc closes. Search shows an image section for hits under `wiki/media/`, `raw/assets/`, or `![]()`. Video/audio play in-pane; player failure does not delete the Source. Mermaid fences render as diagrams; `$…$` / `$$…$$` render as KaTeX. GFM tables, code, and wikilinks from 1.5 still work. Chat answers stay system sans; Preview body/headings stay Georgia.
- English-only UI and generation. Frozen `yopedia` / `WORKWIKI_*` identifiers. Page writes only through `writeWikiPageWithSideEffects`. `isReadOnly()` before writes. Successful wiki writes bump `dataVersion`. SCHEMA.md and `llm-wiki.md` are not edited.
- Plain text, markdown, and URL Intake skip extract. Parsers may run concurrently; Analysis/Generation stay serial per AD-9.

**Block If:**
- Satisfying an AC requires renaming a frozen identifier, editing `SCHEMA.md` or `llm-wiki.md`, inventing a second vault, parsing office/PDF in the Worker, connecting a mailbox, treating Plaud action items as Todos, adding an in-app sheet/slide editor, or shipping OS folder-watch.
- Plaud’s public OAuth + list/transcript/summary HTTP contract cannot be resolved from current Plaud docs at implement time.

**Never:**
- Silent drop of unsupported or corrupt binaries. Partial wiki Pages from a failed Plaud pull. MinerU Cloud as the default or first offered mode. JS office/PDF parsers as the Worker extract path. Sidecar importing `src/lib`. Chinese/i18n. Capture-as-extract. Epic 8 MCP/skill/shell rewrite. Knowledge Studio as the Intake surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Binary Intake, sidecar up | PDF/DOCX/PPTX/XLSX/XLS/ODS/EPUB/MOBI via Workbench drop | Bytes in `raw/sources/`; extract job claimed; text back; two-step Ingest | Visible Activity Extract then Analysis/Generation |
| Sidecar down | Same PDF drop | Bytes stored; no extract; no compile | Activity failed: `Extract is unavailable — the sidecar is down.` |
| PDF cache hit | Same PDF SHA256 already parsed | Cache used; pdf-extract not re-run; Ingest proceeds | No error expected |
| MinerU off, complex PDF | Built-in extract empty/fails | Failure visible; built-in still ran | No Cloud upload |
| MinerU Local API | Settings saved Local API, then a PDF that needs it | Local API used after Save; documents stay on machine | Local API down → visible fail; bytes kept |
| MinerU Cloud chosen | Owner picks Cloud before Save | Orange warning that documents leave the machine; applies only after Save | Unsaved Cloud is not used |
| DOCX structure | Heading 1, list, table | Extracted Markdown has a heading, a list, and a table | Corrupt DOCX fails visibly |
| PPTX slides | Multi-slide deck | Slide-by-slide Markdown; Source summary navigable by slide | No slide editor |
| Spreadsheet | XLSX/XLS/ODS, multiple sheets | All sheets as Markdown tables; cell types preserved | No sheet editor |
| EPUB/MOBI | Valid ebook | Metadata, chapters, body become ingest-ready text; auto-queue | Corrupt/unsupported fails visibly |
| Inbound email | Message + binary attachment at inbound address | Sources with from/received/subject; extract job for the binary; auto-queue | Not a mailbox; unsupported attach skipped/named, not silent |
| Plaud pull | OAuth connected; pick a recording | Transcript and/or summary stored as Plaud-origin Sources; auto-queue | Incomplete/auth fail: no Page writes |
| Image Preview | png/jpg/gif/webp/svg in Preview | Image shown; click lightbox; Esc closes; jump-to-source docks the Page/Source | Filename-only is a fail |
| Search images | Hits in `wiki/media/`, `raw/assets/`, or `![]()` | Results include an image section | Non-image hits stay in the existing list |
| AV Preview | video/audio Source selected | In-pane player; Source remains if player fails; Ingest still runs when the pipeline allows | Player error does not delete |
| Mermaid/KaTeX | Page or Chat with ` ```mermaid ` and `$…$` / `$$…$$` | Diagram + KaTeX, not raw fences; GFM/wikilinks still work | Chat sans; Preview Georgia |

</intent-contract>

## Context

- Epic 2 already stores text Intake and compiles two-step. Workbench Intake (`src/lib/workbench-intake.ts`) still refuses office/PDF/ebook. Vault `/api/ingest/document` and `/api/ingest/pdf` plus `src/app/api/tasks/run/route.ts` still call `extractDocumentTextAsync` on the Worker.
- `sidecar/server.mjs` is Chat-only on `127.0.0.1:19828`. It must stay free of `src/lib`. Extract is a new sidecar capability that claims kernel jobs.
- Email Worker + `POST /api/email/ingest` already exist. 7.5 is Workbench Settings → Intake (copyable inbound address, no folder-watch) and routing attachments through extract jobs instead of Worker parse.
- Plaud upload + `origin: "plaud"` + meeting Todos already exist. 7.6 adds OAuth list/pull only.
- `MarkdownRenderer` already has remark-math, rehype-katex, and Mermaid. PreviewBody and ChatCanvas deliberately do not. VaultExplorer has a lightbox that must not become the Workbench surface (jump-to-source docks Preview).
- Activity maps `extracting` to `"Analysis"` today (`workbench-activity.ts:62-70`). Extract must be its own visible row state.

## Intent Resolution

- **Locked:** Widen Workbench Intake to the extract formats in the I/O matrix (plus browser-renderable images and AV). Text/markdown/HTML/URL still skip extract.
- **Locked:** New kernel extract job (claim + fetch bytes + complete-with-text). Sidecar poller authenticates with `getServicePrincipal` (`YOPEDIA_SERVICE_TOKEN` / `YOPEDIA_SERVICE_PRINCIPAL`). Operator docs may keep showing `WORKWIKI_URL` + `WORKWIKI_API_TOKEN` as the frozen names for the same owner-automation credential — do not invent a third token family.
- **Locked:** Stop calling `extractDocumentTextAsync` for PDF/office/ebook on `/api/tasks/run`, email ingest, and vault document/pdf doors. Those doors enqueue extract jobs. Images may still use the existing vision path when they are not extract-crate work.
- **Locked:** Activity display status adds `Extract` for extract-pending/processing. Sidecar-down copy is exactly `Extract is unavailable — the sidecar is down.`
- **Locked:** Settings → Intake: copyable inbound address (reuse `EmailIngestConfig` / existing email settings API), Plaud upload remains, Plaud OAuth list/pull added, allowed file-type grid, optional keep-parsed under `raw/parsed`. Clear the Intake `pending` sentence. No OS folder-watch copy or control.
- **Locked:** Settings → MinerU PDF: Off / Local API / Cloud / Pipeline; default Off; first enablement lands on Local API; Cloud shows orange warning; sticky Save. Clear the MinerU `pending` sentence.
- **Locked:** PDF parse cache keyed by SHA256 of source bytes. Optional `raw/parsed` keep is the Settings checkbox from the Intake mock.
- **Locked:** Chat assistant (and streamed) bodies render GFM + Mermaid + KaTeX in system sans while `[n]` stay citation buttons. PreviewBody adds the same math/diagram plugins and image/AV/lightbox without importing the article `MarkdownRenderer` chrome. Type lock unchanged.
- **[ASSUMPTION: Rust extract is a crate/binary under `sidecar/extract` invoked by the Node claim loop in `sidecar/server.mjs` — Chat stays the existing Node process; extractors are not rewritten in JS.]**
- **[ASSUMPTION: If docx-rs 0.4.22 cannot read a DOCX, the same Rust process parses WordprocessingML via ZIP+XML. The crate pin still appears in the extract workspace.]**
- **[ASSUMPTION: EPUB/MOBI use Rust crates in that same process (not Worker JS).]**
- **[ASSUMPTION: MinerU Local API base URL defaults to `http://127.0.0.1:8000` and is stored in the kernel settings store.]**
- **[ASSUMPTION: Built-in pdf-extract always runs first; MinerU runs only when enabled and built-in text is empty or the owner enabled it for the job.]**
- **[ASSUMPTION: Plaud OAuth tokens persist in the kernel settings store like other secrets; list/pull uses Plaud’s file + transcript/note endpoints equivalent to the existing Plaud MCP operations.]**
- **[ASSUMPTION: `wiki/media/` is a Search path prefix only; do not invent a new media vault. Images continue to live under `raw/assets/` and markdown `![]()`.]**
- **[ASSUMPTION: XLS is added to `DOCUMENT_FORMATS` and the email-worker allowlist so the parity test stays the single source of agreement.]**

## Code Map

- `src/lib/workbench-intake.ts` -- Widen `IntakeFormat` / `INTAKE_EXTENSIONS` / `INTAKE_ACCEPT_ATTR` / `classifyIntakeFile` for extract + media types; sidecar-down refusal copy. Keep extension-first classification.
- `src/lib/workbench-intake-client.ts` / `src/components/workbench/IntakeControls.tsx` -- Client picker and submit must accept the widened door; still stamp `origin=plaud` only from the Plaud pick.
- `src/app/api/workbench/intake/route.ts` -- Store raw first; enqueue extract job when `classifyIntakeFile` says extract is required; skip extract for md/txt/html/URL.
- `src/lib/document-formats.ts` -- Add `xls`; keep this the leaf allowlist. Update email-worker duplicate list + `email-ingest-allowlist-parity.test.ts`.
- `src/lib/tasks.ts` / `src/lib/ingest-jobs.ts` -- Add extract task/job kind + claim/complete fields; `extracting` remains the durable stage. Do not add a second wrangler Queue binding.
- `src/app/api/extract/**` (new) -- Owner-automation doors: list/claim pending extract jobs, fetch source bytes, POST extracted text. Auth via `getServicePrincipal`. Read-only 403s writes.
- `src/app/api/tasks/run/route.ts` -- Do not parse PDF/office/ebook here. Wait for extract complete (or fail the job). Keep Plaud `extract-actions` skip + meeting todo dispatch.
- `src/app/api/email/ingest/route.ts` / `workers/email-ingest/index.ts` -- Keep inbound-address routing. Stage attachments as Sources; enqueue extract jobs for binaries instead of `extractDocumentTextAsync`.
- `src/app/api/ingest/document/route.ts` / `src/app/api/ingest/pdf/route.ts` -- Same extract-job enqueue; stop Worker parse.
- `src/lib/document-extract.ts` -- Leave as dead Worker path or thin re-export of format tables; do not call it for Epic 7 binaries.
- `sidecar/server.mjs` -- Claim-loop + invoke Rust extract; still Chat + health only for `/api/v1` Chat. Bind stays `127.0.0.1:19828`. No `src/lib` import.
- `sidecar/extract/` (new) -- Rust crate: pdf-extract 0.12.0, docx-rs 0.4.22, calamine 0.36.1, PPTX ZIP+XML, EPUB/MOBI. SHA256 PDF cache. Temp files only.
- `src/lib/sidecar.ts` -- `probeSidecar` reused so Intake can fail closed when the sidecar is down.
- `src/lib/workbench-activity.ts` / `src/components/workbench/ActivityDock.tsx` -- Add `Extract` display status; surface sidecar-down error verbatim.
- `src/lib/workbench-settings.ts` / `src/components/workbench/SettingsCanvas.tsx` -- Implement Intake and MinerU PDF panes; clear `pending` on those two categories only (`api-mcp` stays pending).
- `src/lib/email-ingest.ts` / `src/app/api/email/settings/route.ts` / `src/components/EmailIngestSettings.tsx` -- Reuse inbound address + allowlist; Workbench Intake pane is the v1 surface (legacy `/settings` may keep working, do not invent a second config store).
- `src/lib/raw.ts` -- Optional `raw/parsed` writer when the Intake checkbox is on. First-write-only still applies to `raw/sources/`.
- `src/lib/source-meeting.ts` / `src/lib/todo-extract.ts` -- Read-only for 7.6: Plaud-origin still meeting-eligible; never copy Plaud action lists.
- `src/components/workbench/PreviewBody.tsx` / `src/lib/workbench-preview.ts` / `src/components/workbench/PreviewColumn.tsx` / `src/app/api/workbench/preview/route.ts` -- Images, lightbox+Esc, AV player, remark-math + rehype-katex + Mermaid. Keep GFM + wikilinks. Do not use VaultExplorer as the Workbench lightbox.
- `src/components/workbench/ChatCanvas.tsx` -- Render assistant markdown (Mermaid/KaTeX/GFM) in system sans; keep `[n]` citation buttons. Reuse `src/lib/mermaid.ts` / existing KaTeX CSS from `src/app/layout.tsx`.
- `src/components/workbench/SearchCanvas.tsx` / `src/lib/chat-contract.ts` / search assemble route -- Image section for `wiki/media/`, `raw/assets/`, `![]()` hits.
- `src/components/MarkdownRenderer.tsx` / `src/components/VaultExplorer.tsx` -- Reuse patterns only; do not retarget article/vault surfaces as the Workbench contract.
- Tests to rewrite (they pin the old refusals): `src/lib/__tests__/workbench-intake.test.ts`, `src/lib/__tests__/workbench-left-column.test.ts`, `src/lib/__tests__/workbench-preview.test.ts`, `src/lib/__tests__/workbench-settings.test.ts`, plus new extract-job / sidecar-claim / format / email-extract / Plaud-oauth / lightbox / search-image suites.

## Tasks & Acceptance

**Execution:**
- `src/lib/tasks.ts` / `src/lib/ingest-jobs.ts` / `src/app/api/extract/**` -- Extract job registry, claim, byte fetch, text complete; unit-test the I/O extract rows.
- `sidecar/extract/` / `sidecar/server.mjs` -- Rust crates + claim loop; PDF cache; no `src/lib`.
- `src/lib/workbench-intake.ts` / `src/lib/workbench-intake-client.ts` / `src/components/workbench/IntakeControls.tsx` / `src/app/api/workbench/intake/route.ts` / `src/app/api/ingest/document/route.ts` / `src/app/api/ingest/pdf/route.ts` / `src/app/api/email/ingest/route.ts` -- Widen door; store-then-extract-job; sidecar-down fail closed.
- `src/app/api/tasks/run/route.ts` -- Compile only after extract text is in the kernel.
- `src/lib/workbench-activity.ts` / `src/components/workbench/ActivityDock.tsx` -- `Extract` status + sidecar-down sentence.
- `src/lib/workbench-settings.ts` / `src/components/workbench/SettingsCanvas.tsx` -- Intake + MinerU PDF panes; persist in kernel store.
- `src/lib/plaud-oauth.ts` / `src/app/api/workbench/plaud/**` / `src/components/workbench/SettingsCanvas.tsx` -- OAuth list/pull on Intake; fail closed; `origin: "plaud"`; no Page writes on incomplete pull.
- `src/lib/workbench-preview.ts` / `src/components/workbench/PreviewBody.tsx` / `src/components/workbench/PreviewColumn.tsx` / `src/app/api/workbench/preview/route.ts` / `src/components/workbench/ChatCanvas.tsx` / `src/components/workbench/SearchCanvas.tsx` -- Images, lightbox, AV, Mermaid, KaTeX; type lock.
- `src/lib/document-formats.ts` + email-worker allowlist + parity test -- add `xls`.
- Tests listed in the Code Map -- pin the I/O matrix; retire Epic 2 office-refusal pins that this epic replaces.

**Acceptance Criteria:**
- Given a PDF/office/ebook is saved via Workbench Intake and the sidecar is up, when extract runs, then the sidecar claimed a kernel extract job, wrote text back over `getServicePrincipal` HTTP, and two-step Ingest started only after that text existed, with no second vault.
- Given the sidecar is down, when I drop a PDF, then the Source bytes remain and Activity shows `Extract is unavailable — the sidecar is down.`
- Given two identical PDF byte payloads, when the second extract runs, then the SHA256 parse cache is used and pdf-extract does not re-parse.
- Given MinerU is off, when a complex layout fails, then the failure is visible and built-in extract still ran.
- Given I enable MinerU and Save, when the pane is shown, then the first mode is Local API, and choosing Cloud shows the orange leave-the-machine warning before Save applies it.
- Given a DOCX with Heading 1, a list, and a table, when extract runs, then the Markdown still has those three structures.
- Given a PPTX, when extract runs, then output is slide-by-slide and the Source summary can be navigated by slide.
- Given an XLSX/XLS/ODS workbook, when extract runs, then every sheet is a Markdown table, cell types are preserved, and no sheet editor appears.
- Given an EPUB or MOBI, when extract runs, then metadata, chapters, and body ingest, arrival auto-queues, and corrupt files fail visibly.
- Given email arrives at the inbound address, when Intake runs, then message and/or attachments are Sources with from, received time, and subject, binaries get extract jobs, and Settings → Intake shows the copyable address with no folder-watch.
- Given Plaud OAuth is connected, when I pull a recording, then transcript and/or summary are Plaud-origin Sources and auto-queue; a failed or incomplete pull writes no Pages.
- Given a browser-renderable image is in Preview, when I view it, then I see the image, click opens one lightbox, jump-to-source docks the containing Page or Source, and Esc closes it.
- Given Search hits include `wiki/media/`, `raw/assets/`, or `![]()`, when results render, then an image section appears.
- Given I select a video or audio Source, when Preview shows, then it plays in-pane, a player failure does not delete the Source, and media still Ingests when the pipeline allows.
- Given a Page or Chat message with a Mermaid fence and `$` / `$$` math, when it renders, then they are a diagram and KaTeX, GFM tables and wikilinks still work, Chat stays system sans, and Preview body stays Georgia.

## Spec Change Log

- 2026-08-25 — **Story 7.6 (Plaud OAuth list/pull) BLOCKED** under the spec's own
  `Block If`: "Plaud's public OAuth + list/transcript/summary HTTP contract cannot
  be resolved from current Plaud docs at implement time." Verified against
  `docs.plaud.ai/llms.txt` (the full published index) and the four OpenAPI specs
  it lists (`auth`, `file`, `transcription`, `transcription-model`). The entire
  published HTTP surface is **Plaud Embedded** — a partner/OEM contract for
  binding *your own* devices to *your own* app, uploading audio, and transcribing
  it. Its OAuth (`/oauth/partner/access-token` → partner token → per-user token)
  authenticates a partner application over users it minted; it does **not** grant
  a consumer's existing Plaud account, and no `list recordings` /
  `get transcript` / `get note` endpoint for such an account is published. Plaud
  routes personal-data access through the **Plaud MCP & CLI** instead, which is an
  installed client with its own auth, not an HTTP contract this app can hold
  tokens for. Implementing 7.6 would therefore require inventing an undocumented
  private API. Nothing was shipped for 7.6 — no `src/lib/plaud-oauth.ts`, no
  `/api/workbench/plaud/**`, no Settings control. The rest of Story 7.6's
  surroundings are unaffected: Plaud upload, `origin: "plaud"`, and the meeting
  Todo rules are Epic 4 features and still work, and `rememberExtractMeeting`
  carries the Plaud meeting flag across the new extract hop.

## Review Triage Log

### 2026-08-25 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 31: (high 9, medium 15, low 7)
- defer: 1: (high 0, medium 1, low 0)
- reject: 4
- addressed_findings:
  - `[high]` `[patch]` `isPreviewPayload` accepts `image`/`video`/`audio` so a 200 media Preview is `ok`, not `unreachable`
  - `[high]` `[patch]` Activity Retry re-offers an extract job instead of UTF-8-reading a binary Source
  - `[high]` `[patch]` Empty `completeExtract` text fails the extract record; it no longer stays claimed
  - `[high]` `[patch]` `failExtractJob` refuses to overwrite a `done` record
  - `[high]` `[patch]` `divertToExtract` answers 503 when enqueue reports `error`, so staging is not deleted into a Worker parse
  - `[high]` `[patch]` Email ingest surfaces an `enqueueExtract` error instead of silently omitting the attachment
  - `[high]` `[patch]` Sidecar loop takes the first complete JSON object, fails empty markdown, and throws when complete/fail HTTP is refused
  - `[high]` `[patch]` `GET /api/extract/jobs` stamps the poll heartbeat only for the service principal
  - `[high]` `[patch]` Binary Sources mirror into the owner silo (DW-40); Files and the media door can see them
  - `[medium]` `[patch]` Email `from` / `subject` / `receivedAt` survive extract into Ingest
  - `[medium]` `[patch]` `activityDisplayStatus(..., "extract")` is `Extract`; a text ingest at stage `extracting` stays `Analysis`
  - `[medium]` `[patch]` Search `![]()` hits stay in the text list; non-image paths under media roots are not thumbnails
  - `[medium]` `[patch]` Preview `<img onError>` flips the media-failed state
  - `[medium]` `[patch]` Media door honors `Range` (206/416)
  - `[medium]` `[patch]` `keepParsed` writes `raw/parsed`; default does not
  - `[medium]` `[patch]` Settings persist `mineruMode` / `intakeKeepParsed` only after Save
  - `[medium]` `[patch]` Plaud-origin extract calls `rememberExtractMeeting`
  - `[medium]` `[patch]` EPUB hrefs strip `#` / `?` before resolve
  - `[medium]` `[patch]` Missing extract bytes answer 404, not 500
  - `[medium]` `[patch]` MinerU `pipeline` is local `/file_parse` and is not treated as leaving the machine
  - `[medium]` `[patch]` `completeExtract` carries the real format (or `email`), not always `text`
  - `[medium]` `[patch]` Failed extract Activity rows carry the bytes-kept note
  - `[medium]` `[patch]` Vault `{ pdfUrl }` and leftover `source:pdf` tasks fetch bytes then enqueue extract
  - `[low]` `[patch]` Unused Plaud OAuth AppConfig fields removed
  - `[low]` `[patch]` Intake formats copy no longer claims email/API accept images/AV
  - `[low]` `[patch]` Email-ingest README names extract Sources, not the task-queue parser
  - `[low]` `[patch]` `listExtractJobs` is newest-first
  - `[low]` `[patch]` Comments for MinerU first-enablement and the Rust PDF cache
  - `[low]` `[patch]` Spec Verification command list includes the new extract/media suites
  - `[low]` `[patch]` sprint-status: 7-1…7-5, 7-7, 7-8 `done`; 7-6 and epic-7 stay backlog

## Design Notes

Kernel-queued / sidecar-claimed is the one door for browser drop, email, Plaud, and vault upload. The Worker never reaches `127.0.0.1`, so extract cannot be an inline `/api/tasks/run` parse.

Golden path: drop PDF → `raw/sources/` → extract job `queued` → sidecar claims → Rust pdf-extract (or cache) → POST text → Analysis → Generation via `writeWikiPageWithSideEffects` → Activity succeeded.

Sidecar-down path: drop PDF → `raw/sources/` → extract job fails closed → Activity `Extract` failed with the locked sentence → bytes remain.

Reuse VaultExplorer lightbox behavior (Esc, one overlay) but dock jump-to-source in the Workbench Preview column.

Calamine 0.36 reads XLS/XLSX/ODS via `open_workbook` + `sheet_names` + typed `Data` cells — emit one Markdown table per sheet.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/email-ingest-allowlist-parity.test.ts src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/extract-jobs.test.ts src/lib/__tests__/extract-loop.test.ts src/lib/__tests__/preview-media-and-rich-text.test.ts src/lib/__tests__/epic7-settings-surface.test.ts src/lib/__tests__/extract-doors.test.ts src/lib/__tests__/ingest-pdf-route.test.ts src/lib/__tests__/fetch.test.ts` -- expected: pass; widened Intake; extract-job enqueue; sidecar-down copy; Intake/MinerU panes; email binaries not Worker-parsed; Preview/Chat mermaid+katex pins; brand scan clean. The added suites cover the kernel extract registry (claim races, terminal-state rules, keep-parsed, silo mirror), the sidecar claim loop (JSON framing, MinerU escalation, the one-way import rule), media Preview/lightbox/Search, the Settings surface, the extract HTTP doors (heartbeat stamp, vanished Source, `Range`, binary Retry), and vault `{ pdfUrl }` fetch-then-extract (no Worker `unpdf`).
- `pnpm exec tsc --noEmit` -- expected: no new errors
- `cargo test --manifest-path sidecar/extract/Cargo.toml` -- expected: pass for PDF cache, DOCX/PPTX/sheet/ebook fixtures (skip if the crate is invoked only via integration fixtures documented in the extract tests)

## Auto Run Result

Status: done

**Summary:** Stories 7.1–7.8 store extract-required arrivals in the kernel first, enqueue sidecar-claimed Rust extract jobs, then run two-step Ingest. Settings → Intake shows the inbound address and keep-parsed; Settings → MinerU PDF defaults Off and first-enables Local API. Preview and Chat render images, AV, Mermaid, and KaTeX. Story 7.6 is blocked: Plaud publishes no consumer OAuth list/pull HTTP contract.

**Files:**
- `src/lib/extract-dispatch.ts` / `extract-jobs.ts` / `extract-heartbeat.ts` / `extract-auth.ts` / `extract-settings.ts` — store-then-queue, claim/complete/fail, service-only heartbeat
- `src/app/api/extract/**` — owner-automation doors for the sidecar poller
- `sidecar/extract/` / `extract-loop.mjs` / `mineru.mjs` — Rust pdf-extract, docx, calamine, PPTX, EPUB/MOBI; claim loop; no `src/lib`
- `src/lib/workbench-intake.ts` / intake + vault document/pdf + email + `tasks/run` — widen the door; enqueue extract; `{ pdfUrl }` fetches bytes then extracts
- `src/lib/raw.ts` — first-write-only bytes plus owner-silo mirror so Files and Preview can see binaries
- `src/lib/workbench-activity.ts` / Activity dock — `Extract` status, sidecar-down sentence, bytes-kept note
- `src/lib/workbench-settings.ts` / `SettingsCanvas.tsx` — Intake + MinerU PDF panes; Plaud stays upload-only
- `PreviewBody.tsx` / `PreviewLightbox.tsx` / `ChatBody.tsx` / `search-images.ts` / `src/app/api/workbench/media/` — images, lightbox, AV, Mermaid, KaTeX, Search image section
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 7-1…7-5, 7-7, 7-8 `done`; 7-6 and epic-7 stay backlog
- Tests: extract-jobs, extract-loop, extract-doors, preview-media, epic7-settings-surface, intake/email/tasks/pdf-route

**Review:** 31 patches applied (9 high, 15 medium, 7 low). 1 deferred. 4 findings rejected (Chat lightbox — 7.7 is Preview; URL Intake refusing PDF links — Always: URL skips extract; DOCX emphasis beyond heading/list/table; must implement Plaud OAuth given Block If).

**Follow-up review:** `true` — 9 high patched findings (score `3 × 15 medium + 7 low = 52`).

**Verification:**
- Spec vitest list plus `ingest-pdf-route` and `fetch`: **839 passed**
- `pnpm exec tsc --noEmit`: clean
- `cargo test --manifest-path sidecar/extract/Cargo.toml`: **31 passed** (23 unit + 8 fixtures)
- UI: Preview/Chat/Settings behaviour is pinned by mounted suites. No live sidecar + R2 golden-path browser pass in this run.

**Residual risks:** Story 7.6 remains unimplemented. Generic `ingestUrl` still Worker-parses PDFs (deferred). No live extract golden path against a running sidecar was exercised here.
