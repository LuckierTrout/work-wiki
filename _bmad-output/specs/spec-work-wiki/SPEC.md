---
id: SPEC-work-wiki
companions:
  - glossary.md
  - success-metrics.md
  - ../../planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md
  - ../../planning-artifacts/prds/prd-work-wiki-2026-08-12/addendum.md
  - ../../planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/DESIGN.md
  - ../../planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/EXPERIENCE.md
  - ../../planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# work-wiki

## Why

**Pain + vision.** After meetings, Christian's decisions live in Plaud transcripts and fading memory. He needs a **private compiled wiki** — Sources go in once, the LLM integrates them into interlinked Pages, and Chat answers from that wiki with citations — plus HITL Todos from meetings. v1 is his personal job tool (not a commons, not a desktop rewrite): nashsu/llm_wiki Workbench behavior on the existing Next.js web app, with a local Agent sidecar. Compile-once, not RAG-as-the-product.

## Capabilities

- **CAP-1**
  - **intent:** Christian can keep one or more named Wikis that only he (and his agent credentials) can read or write.
  - **success:** Unauthenticated wiki/chat/ingest/todo APIs return 401. Public commons, listing, waitlist, billing, clone-to-private, and talk routes 404.

- **CAP-2**
  - **intent:** Christian can create a Wiki from a Scenario Template so purpose and Schema exist before the first Ingest.
  - **success:** Choosing Research, Reading, Personal Growth, Business, or General yields a named Wiki with `purpose.md` and Schema that Chat can cite.

- **CAP-3**
  - **intent:** Christian can run the whole product from one Workbench: icon rail switches modes; tree and Preview dock; Activity shows Ingest; layout persists.
  - **success:** Wiki, Chat, Sources, Search, Graph, Lint, Todos, Review, Deep Research, Skills, and Settings are rail modes — not separate apps. Last-used mode survives reload. Drag-resize honors min widths in DESIGN.md.

- **CAP-4**
  - **intent:** When a Source arrives (upload, folder, email, Plaud/direct connect, API/MCP, bookmarklet/URL), the system stores it and queues Ingest without a second "process" click.
  - **success:** Arrival always enqueues. Unchanged SHA256 is skipped. OS folder-watch is not required.

- **CAP-5**
  - **intent:** The system compiles each Source with Analysis then Generation, serially per Wiki, merging into existing Pages and keeping contradictions visible.
  - **success:** Every queued Ingest ends in success, explicit failure after at most 3 retries, or cancel — never a silent drop (SM-3). Successful Ingest writes a Source summary, regenerates Overview, and sets `sources: []` on touched Pages. Contradictions set `disputed: true`.

- **CAP-6**
  - **intent:** Christian can ingest office, PDF, ebook, media, and web-clip Sources with structure preserved for the LLM.
  - **success:** PDF/DOCX/PPTX/XLSX/XLS/ODS/EPUB/MOBI either compile or fail visibly. Identical PDF bytes are not re-parsed. MinerU stays off unless he enables it.

- **CAP-7**
  - **intent:** Christian can ask the compiled Wiki in durable Conversations and get answers that cite Pages, with Save to Wiki and regenerate.
  - **success:** When coverage exists, answers use `[n]` citations that resolve to Wiki paths. Chat does not invent citations. Conversations persist across reload.

- **CAP-8**
  - **intent:** Christian can read a Page as the default, and edit markdown only after an explicit confirm.
  - **success:** Selecting a Page opens view-first Preview. Markdown edit is confirm-gated. No WYSIWYG. Next Ingest may overwrite owner edits.

- **CAP-9**
  - **intent:** After a meeting Source, Christian can approve or reject proposed Todos with due dates and links back to that meeting.
  - **success:** Candidates appear only for Plaud-origin or user-marked meeting Sources. Nothing auto-approves. Rejected and completed items persist until he deletes them. He can finish the Candidate pass in the same session (SM-1).

- **CAP-10**
  - **intent:** Christian can search Pages and Sources and open a hit in Preview.
  - **success:** A tokenized query returns ranked paths with snippets while vector search is off. Turning vector on is optional and requires embeddings config.

- **CAP-11**
  - **intent:** Christian can see Pages as a knowledge graph with Communities and Insights, and start Deep Research from a gap or bridge after confirm.
  - **success:** Isolated Pages and sparse Communities (cohesion below 0.15) surface when they exist (SM-4). Insights do not auto-run Deep Research.

- **CAP-12**
  - **intent:** Christian can lint the Wiki and apply mechanical fixes without clearing disputed claims.
  - **success:** Lint is runnable on demand. Auto-fix covers renamed-slug links, dangling slugs after delete, and index drift — not `disputed: true`.

- **CAP-13**
  - **intent:** Christian can clear Ingest-flagged Review items later without blocking compile.
  - **success:** Each item exposes only Create Page, Deep Research, and Skip. Skip resolves. Ingest completes even if Review is untouched.

- **CAP-14**
  - **intent:** Christian can run confirmed multi-query web research that becomes wiki Pages.
  - **success:** Research does not start until he confirms an editable topic and queries. Default provider is Tavily. At most 3 tasks run at once. Missing credentials fail visibly with no silent fallback.

- **CAP-15**
  - **intent:** Christian can let an external agent (Claude Code / Codex) read the Wiki through a local token API and the llm-wiki skill.
  - **success:** Loopback binds `127.0.0.1:19828` only. Stock skill is read-only except rescan. If the sidecar is down, the agent sees connection refused — not a hallucinated wiki. Cloud Chat is not a second Agent.

- **CAP-16**
  - **intent:** Christian can ZIP export/import the Wiki and rebuild `index.md` deterministically.
  - **success:** Import restores a Wiki Chat can cite. Same Pages yield the same `index.md`. Export includes `.obsidian/` recommended config (SM-5).

- **CAP-17**
  - **intent:** Christian can set Chat and Ingest models independently and tune retrieval without making vector search mandatory.
  - **success:** Changing Ingest model does not alter an in-flight Chat turn. Vector cannot turn on without endpoint, key, and model. Off remains valid.

## Constraints

- UI and LLM Generation are English-only.
- Runtime identifiers stay `yopedia` (bindings, tenants, MCP server, `YOPEDIA_*`, wrangler names). User-visible copy is work-wiki.
- Page and Source writes go through the kernel lifecycle path in the architecture spine (AD-3). No second markdown writer.
- `SCHEMA.md` Page conventions load into Ingest, Chat, and Lint prompts at runtime.
- The kernel store is the only system of record. Sidecar disk is extract temp and `agent-workspace/`. Conversations, Settings, Review, and Todos persist in the kernel.
- v1 Agent host is a **local** sidecar. Chat streams from the browser to loopback `POST /api/v1/projects/:wikiId/chat`. Cloud Chat returns 503 `sidecar_required`.
- Ingest LLM work is serial per Wiki; Chat may overlap. Skip cache is SHA256 of Source bytes.
- Vector search is off by default.
- Todos never auto-approve. Deep Research never runs unconfirmed. External shell needs per-command approval. Meeting Todo extraction runs only for Plaud-origin or user-marked meeting Sources.
- `llm-wiki.md` is immutable. `.github/` and `.yoyo/yoyo.toml` change only when explicitly asked.
- Ship **P0 before P1** (private Wiki, Workbench, two-step Ingest, Plaud upload, cited Chat, Todo HITL, ZIP, view-first Preview — then Graph Insights, Deep Research, API/MCP/skill, office extract, Skills/shell, Plaud OAuth, email, Mermaid/KaTeX, Search images).
- Match nashsu Workbench density and layout. SF/system sans for chrome and Chat; Georgia for Preview page body and headings. Light theme only in v1.
- Phone and other Clerk browsers may use tree, Preview, and search. Chat, extract, loopback, shell, and Skills require the sidecar on the same machine as the browser.
- Commons publish/sync is a no-op; leftover public routes 404.
- MinerU default is off (Local API if enabled). Deep Research default is Tavily. Rejected Candidates and completed Todos persist until owner delete.

## Non-goals

- RAG as the product (retrieve-only Chat without a compiled Wiki).
- Multi-user commons, public lab, billing, waitlist, clone-to-private, observer dashboards.
- Tauri or desktop rewrite; OS folder-watch; Chrome extension as a must; clipper port 19827.
- Auto-approved Todos or treating Plaud action items as Todos.
- Dedicated remote Agent host in v1.
- General project manager (sprints, assignees, team boards).
- Page talk threads; visible confidence/expiry badges; ingest-diff review of every Generation.
- Extra sidebar modes `synthesis/` or `comparisons/`.
- i18n beyond English; colleagues as users.
- Spreadsheet editor, in-app Plaud recorder, or required PWA.

## Success signal

After a Plaud meeting Ingest, Christian finishes the Todo Candidate pass in that session, and later can retrieve a cited decision from Chat or Search without opening Plaud (SM-1, SM-2). No queued Source disappears: every job ends success, failed-after-retries, or cancel (SM-3). Full metric set: `success-metrics.md`.

## Assumptions

- Existing Clerk sign-in is enough identity; no new IdP.
- Nashsu's 58.2% → 71.4% vector recall is a reference lift, not a contractual SLA until re-measured here (SM-6).
- Bookmarklet + in-app URL Ingest is v1 clipper parity.
