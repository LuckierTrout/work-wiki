---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md
  - _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/EXPERIENCE.md
  - _bmad-output/specs/spec-work-wiki/SPEC.md
  - _bmad-output/specs/spec-work-wiki/glossary.md
  - _bmad-output/specs/spec-work-wiki/success-metrics.md
---

# work-wiki - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for work-wiki, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR-1: Wiki, Sources, Chats, Todos, and Review are owner-only (Clerk + agent token); unauthenticated APIs 401; commons/public/waitlist/billing/clone-to-private/talk 404.
FR-2: Sources are immutable; Pages may re-synthesize; every generated Page has YAML `sources: []` (except bookkeeping Pages).
FR-3: New Sources merge into existing concept Pages; contradictions set `disputed: true` (not cleared by mechanical auto-fix).
FR-4: Icon rail switches Wiki, Sources, Search, Graph, Lint, Review, Deep Research, Settings, plus Todos; mode switch does not destroy Chat input.
FR-5: Workbench: Knowledge Tree / File Tree, Chat, Preview (view-first; markdown edit confirm-gated; no WYSIWYG). UX lock: Chat is a rail icon; Preview docks when a tree pick or citation is active.
FR-6: Drag-resize panels; Chat min 320px; tree and Preview min 200px; widths persist.
FR-7: Activity panel: per-file pending / Analysis / Generation / succeeded / failed / skipped; cancel must not commit Page writes; retry does not duplicate Source.
FR-8: Conversations, Settings, Review, project config, panel widths, last mode, tree selection/scroll persist across reload.
FR-9: Ingest is two sequential LLM calls (Analysis then Generation); Activity shows that order; Generation retry may reuse Analysis.
FR-10: SHA256 skip cache; unchanged bytes skip LLM; byte change re-queues full two-step Ingest.
FR-11: Successful Ingest updates Index, Log, Overview; always writes a Source summary.
FR-12: Source delete is confirm-gated; cascade trims shared entities; dead wikilinks and index cleaned; Todos with deleted Source show source-missing.
FR-13: Independent named Conversations (create, rename, delete, switch).
FR-14: Chat answers use `[n]` citations that resolve to Wiki paths; no invented citations; coverage-missing offers Ingest or Deep Research.
FR-15: Save to Wiki files the answer under `wiki/queries/` then auto-Ingests (main response only).
FR-16: Sources-only Chat mode is visibly distinct; citations point at Sources not concept Pages.
FR-17: Regenerate removes last assistant+user pair and re-sends; no-op if empty.
FR-18: Search Wiki + Sources; hit opens Preview.
FR-19: Knowledge graph visualization of Pages.
FR-20: Graph Insights (Surprising Connections and Knowledge Gaps).
FR-21: Lint report (contradictions, orphans, staleness, broken links, gaps); semantic toggle off by default.
FR-22: Mechanical auto-fix only for renamed-slug wikilinks, dangling `[[slug]]` after delete, and `index.md` drift — not `disputed`.
FR-23: Review items: Create Page, Deep Research, Skip only; ingest-time search queries stored; does not block Ingest.
FR-24: Deep Research starts only after confirm of editable topic and queries.
FR-25: Capture URL/clip (bookmarklet/share/in-app URL) into Ingest queue.
FR-26: Todo Candidates only for Plaud-origin or user-marked meeting Sources; non-meeting default off.
FR-27: Approve or reject Candidates (bulk allowed); nothing auto-approves; decision/timestamp/actor stored.
FR-28: Todos have optional due date, open/done; edit title/due without breaking links; rejected and completed persist until owner delete.
FR-29: Every Candidate/Todo links to originating Source and meeting Page when one exists.
FR-30: Ingest Plaud transcript and summary as Sources (do not trust Plaud action items as Todos).
FR-31: Plaud bring-in: upload P0; in-app OAuth list/pull P1.
FR-32: Multi-format Ingest; unsupported type fails visibly, never silent drop.
FR-33: Batch and drag-drop queue multiple files/URLs in one action; auto-queue Ingest.
FR-34: Schema is editable and steers Ingest/Chat/Lint/Todos; SCHEMA.md Page conventions load at runtime.
FR-35: Chat and Ingest models independent; providers OpenAI, Anthropic, Google, Ollama, Custom; provider-specific streaming.
FR-36: Settings enable local API, generate token, optional local unauth; bind 127.0.0.1:19828 only (not 0.0.0.0).
FR-37: ZIP export/import; deterministic `index.md` rebuild; export includes `.obsidian/`.
FR-38: Five Scenario Templates (Research, Reading, Personal Growth, Business, General) seed `purpose.md` + Schema; no blank Wiki; later template switch confirm-gated.
FR-39: Serial durable Ingest queue per Wiki; Chat may overlap; auto-retry ≤3 then stay failed.
FR-40: Recursive folder import preserves tree; path passed to LLM as context.
FR-41: Automatic Ingest on any Intake arrival (upload, folder, email inbound address, Plaud/direct connect, API/MCP).
FR-42: Auto-embed after Ingest only when vector search is on.
FR-44: Progressive Sources view for large `raw/sources/` trees.
FR-45: 4-signal Relevance (wikilink, source overlap, Adamic-Adar, type affinity).
FR-46: Graph interaction: hover dim, zoom/fit, position cache survives dataVersion (no re-scatter).
FR-47: Louvain Communities independent of page type; 12-color palette; cohesion < 0.15 warned.
FR-48: Surprising Connections ranked by composite surprise; dismissable.
FR-49: Knowledge Gaps: isolated (degree ≤1), sparse community, bridge nodes (3+ communities).
FR-50: Insight click highlights; Deep Research from gap/bridge with editable topic/queries.
FR-51: Phase 1 tokenized search (EN word+stop, CJK bigram, title bonus); wiki + raw/sources.
FR-52: Optional vector search off by default; cosine ANN; model-tagged embeddings; mismatch = miss; fallback to tokenized.
FR-53: Phase 2 graph expansion 2-hop with decay.
FR-54: Phase 3 budget 4K–1M slider; split 60/20/5/15 Pages/history/index/system.
FR-55: Phase 4 numbered full pages + purpose/index; cite [n].
FR-56: Retrieval Settings: context slider, vector config, DR provider keys, MinerU, LLM timeout, optional Firecrawl, language English.
FR-57: Conversation sidebar: New Chat, list, active session distinct.
FR-58: Per-conversation persistence (nashsu chat record shape).
FR-59: History depth default 10; tighter of N vs 20% token budget wins.
FR-60: Chat Agent is backend sidecar runtime, not in-browser TS and not Workers isolate; `query.ts` is not v1 Chat.
FR-61: Agent tools: wiki/source/graph/web/AnyTXT/workspace files/approved shell/skill reads.
FR-62: Skills scan project+user folders; enable/disable; `/skill` per Conversation.
FR-63: Agent outputs under `agent-workspace/` previewable.
FR-64: Skill forms: single/multi/free text; Chat waits; cancel does not run the tool.
FR-65: Workspace cmds may auto-run; external shell needs explicit Approve/Deny per command; no blanket allow-all.
FR-66: Thinking blocks: 5-line fade while streaming; collapsed after; not cited as Wiki; not in Save to Wiki.
FR-67: Deep Research providers Tavily (default), SerpApi, SearXNG; one active; full-content fetch; no silent provider fallback.
FR-68: Research Panel streams progress; dynamic height.
FR-69: Research synthesizes a Page, shows thinking, auto-Ingests on success; failed synthesis does not auto-Ingest.
FR-70: Deep Research own queue; max 3 concurrent; independent of serial Ingest.
FR-71: Structured extract: PDF cached (+ optional MinerU, default off / Local API if on); DOCX; PPTX slide-by-slide; XLSX/XLS/ODS tables; EPUB/MOBI; web clips clean Markdown.
FR-72: Native image preview + lightbox; video/audio in-pane player.
FR-73: Preview renders GFM, bordered tables, `[[wikilinks]]`, Mermaid, KaTeX; missing wikilink is a missing-link state.
FR-74: After kernel commits, bump dataVersion; Workbench trees/Preview/Graph refresh without full reload.
FR-76: Loopback `/api/v1` surface (health, projects, files, reviews, search, chat, graph, rescan) per PRD table; `:wikiId` is kernel UUID; `current` = active Wiki.
FR-77: `POST /api/v1/projects/:wikiId/chat` JSON default; SSE `meta`, `agent`, `done`, `cancelled`, `error`; cloud returns 503 `sidecar_required`.
FR-78: MCP wraps loopback `/api/v1`; copyable client config; stock skill read-only except rescan.
FR-79: work-wiki-branded llm-wiki Agent Skill documents `/chat`; probes health first; connection refused if sidecar down.

### NonFunctional Requirements

NFR-1: Reliability — Ingest and Todo extraction failures are visible and retryable; Sources persist independently of compile success; no silent queue drops (SM-3).
NFR-2: Privacy — private-by-default; no public reads; agent tokens scoped to Christian's Wiki; meeting transcripts private; export owner-initiated.
NFR-3: Integrity — citations required when coverage exists; disputed visible; no silent overwrite; Chat must not invent citations.
NFR-4: Observability — queue states, Ingest errors, and Todo decisions are inspectable.
NFR-5: Performance — Chat streams; Ingest is async (Workbench stays interactive); multi-minute Ingests OK if Activity tells the truth.
NFR-6: Accessibility — WCAG 2.2 AA target on chrome (not a certification gate); keyboard: rail → left → canvas → Preview → Activity; Approve/Reject/Skip in tab order; visible focus ring; `prefers-reduced-motion` for thinking fade and graph layout.
NFR-7: Cost — SHA256 skip; Chat uses retrieval budget (FR-54), not the whole Wiki.
NFR-8: Safety — no auto-approve Todos; no unconfirmed Deep Research; no unapproved external shell.
NFR-9: Language — English-only UI and LLM Generation.
NFR-10: Device — desktop-primary; phone/other Clerk browsers: tree, Preview, search only; Chat/extract/MCP/shell require sidecar on the same machine (AD-17 supersedes UX phone Chat+Todos assumption).

### Additional Requirements

Brownfield: no greenfield starter. Stay on existing Next.js App Router + OpenNext Cloudflare. Epic 1 must not scaffold a new app.

- AD-1: Workbench/data plane on OpenNext Workers; Agent, extract, shell, Skills, `:19828` on local sidecar. No shell in the isolate. No dedicated remote Agent host in v1.
- AD-2: Kernel `getStorage()` is sole SoR (R2+KV prod; fs local-dev). Sidecar disk is extract temp + `agent-workspace/` only.
- AD-3: Page writes via `writeWikiPageWithSideEffects` / `deleteWikiPage`; Source bytes via `saveRawSource` / `saveRawSourceFor`.
- AD-4: Two-step compile stays in TS kernel; skip hash is SHA256 (replace FNV-1a); Analysis JSON stored with the ingest job.
- AD-5: Chat is a rail icon; browser → loopback chat URL; SSE event names locked; `src/lib/query.ts` / `/api/query` is not v1 Chat (404 or unused).
- AD-6 / AD-22: Sidecar binds 127.0.0.1:19828. Kernel implements wiki read/search/graph/reviews/rescan/files. Sidecar implements Chat, extract, shell/Skills, loopback health, MCP wrap; other loopback `/api/v1` routes reverse-proxy to kernel. Cloud Chat 503 `sidecar_required`.
- AD-7: Runtime identifiers stay `yopedia` (bindings, tenants, MCP name, `YOPEDIA_*`, wrangler). Display copy is work-wiki.
- AD-8: Clerk for humans; bearer owner/service token for agents; MCP/HTTP reads require auth.
- AD-9: Serial ingest per Wiki; Chat may overlap.
- AD-10: SCHEMA.md Page conventions load into ingest/chat/lint prompts at runtime.
- AD-11: `dataVersion` is a monotonic integer in `YOPEDIA_CONFIG`.
- AD-12: Vector off by default; fork always-on Vectorize/Workers AI path must change; embeddings model-tagged; ANN is Vectorize not LanceDB.
- AD-13: `workers/task-consumer` stays thin; POSTs `/api/tasks/run` with `YOPEDIA_SERVICE_TOKEN`; `YOPEDIA_URL` must be this fork, not `yopedia.yolog.dev`.
- AD-14: Workbench Graph uses sigma 3.0.3 + graphology 0.26.0 + ForceAtlas2 0.10.1 + louvain 2.0.2 (replace custom canvas).
- AD-15: Before next prod deploy, bump next to 15.5.23, `@opennextjs/cloudflare` to 1.20.2, react 19.1.4. Stay off Next 16.
- AD-16: Sidecar extract: pdf-extract 0.12.0, docx-rs 0.4.22, calamine 0.36.1, PPTX ZIP+XML, EPUB/MOBI. Web clips: Readability + linkedom + `htmlToMarkdown` (not Turndown package).
- AD-17: Device split as NFR-10.
- AD-18: Deep Research default Tavily; own queue max 3.
- AD-19: MinerU default off; if enabled, Local API first.
- AD-20: Todo retention until owner delete.
- AD-21: Commons surface 404 / `syncCommonsForPage` no-op; unauthenticated MCP reads must go away.
- AD-23: Conversations, Settings (keys, dual models), Review, Todos persist in kernel — not sidecar SQLite.
- AD-24: Raw bytes stored in kernel first; sidecar claims pending extract jobs (covers email/Plaud/API, not only browser drop).
- Loopback/skill token may accept `LLM_WIKI_API_TOKEN`; consumer uses `YOPEDIA_SERVICE_TOKEN`.
- Manual `wrangler` deploy (fork GitHub deploy workflows are inert).
- `llm-wiki.md` immutable; `.github/` and `.yoyo/yoyo.toml` protected unless explicitly asked.
- Ship P0 before P1 (PRD §6.3 / SPEC constraint).

### UX Design Requirements

UX-DR1: Implement DESIGN.md tokens: surfaces `#FFFFFF` / `#FAFAFA`, foreground `#171717`, border `#E5E5E5`, primary black, live `#16A34A`, warning `#D97706`, destructive `#DC2626`; graph type and community palettes as specified. Light theme only. Not shadcn.
UX-DR2: Type: SF/system sans 13px/1.45 for chrome, rail, trees, Chat, Settings, Preview header/frontmatter. Georgia 16px/1.65 Preview body; 22px Preview headings. Chat answers stay sans. Title the product **work-wiki** (not CHRISTIAN'S LLM WIKI).
UX-DR3: Icon rail 48px; active icon filled rounded square in foreground wash (not a hue change); badge-count on Review and Todos when non-zero; bottom live-dot, Settings, collapse chevron. Rail order: Wiki · Chat · Sources · Search · Graph · Lint · Todos · Review · Deep Research · Skills.
UX-DR4: button-primary (black fill), button-ghost, button-destructive (red label, no red fill) — one primary per cluster.
UX-DR5: tree-panel with Knowledge | Files tabs; header **work-wiki** is Wiki switcher + New Wiki; no Open project folder (Import/Upload instead).
UX-DR6: conversation-sidebar with + New Chat; composer per-Conversation; placeholder "Type a message…"; tools Attach · Web search · AnyTXT · Skills · Smart retrieval · model · send disabled until text.
UX-DR7: cited-references-panel collapsible, grouped by page type; `[n]` opens Preview; no fake panel when coverage missing.
UX-DR8: thinking-block 5-line fade while streaming, collapsed after; tool-call-row name+outcome; skill-form waits; shell-approval Approve/Deny for external commands.
UX-DR9: preview view-first GFM; compact frontmatter in UI sans; Georgia body; confirm-gated markdown edit; images lightbox; AV in-pane.
UX-DR10: activity-row per queued file (Analysis|Generation|pending|succeeded|skipped|failed); Activity docks under left column on Wiki/Sources/Files, collapsible.
UX-DR11: review-card warning vs lightbulb icon-only; paths `wiki/…md`; actions Deep Research · Create Page · Skip only.
UX-DR12: todo-card Candidates | Open | Done; Approve primary / Reject destructive ghost; empty Candidates copy: "No candidates. Meeting ingest will propose them."
UX-DR13: graph-canvas √ size by degree; Type/Community color; strong/weak edges; hover dim + Relevance; zoom/fit; position cache; Insights without a separate analyze click.
UX-DR14: warning-callout (unauthenticated API, MinerU cloud); sticky save-bar "Changes apply after saving".
UX-DR15: empty-state one muted sentence + optional one primary; no illustration/emoji. Exact copy from EXPERIENCE.md for Chat empty, Wiki empty Preview, Search empty, Lint idle, Deep Research empty, sidecar down, coverage missing.
UX-DR16: lightbox overlay; Esc closes; jump-to-source.
UX-DR17: research-panel dynamic height; up to 3 concurrent tasks; confirm-dialog one overlay (Deep Research topic+queries, Preview edit, Source delete, template switch).
UX-DR18: settings-nav categories: General · LLM Models · Embeddings · Image Captioning · External Information Sources · Network · Intake · Scheduled Import · MinerU PDF · API + MCP · Output · Interface · Maintenance · Changelog · About. Intake replaces Source Folder Auto Watch. API UI loopback only (no 0.0.0.0 / LAN / Clip-server 19827).
UX-DR19: Create Wiki: five named templates only; after create land on Wiki. First-run after Create Wiki lands on Wiki mode.
UX-DR20: Keyboard: Tab rail → left → canvas → Preview → Activity; Esc closes one modal; Enter sends/search; `/skill` completes enabled names only.
UX-DR21: A11y: mode change announces surface name; badge accessible names include count+noun; inputs labeled (placeholder not only label); Chat `aria-live` polite; visible focus ring foreground on surface.
UX-DR22: Responsive: ≥1200px full Workbench; 900–1199 min widths, Activity collapsed by default; <900 rail becomes a sheet, Graph not the job surface. Architecture AD-17: without sidecar, Chat/extract unavailable even if layout stacks.
UX-DR23: Voice: unsentimental English microcopy per EXPERIENCE.md Do/Don't table. No "Let's get started", confetti, or Chinese chrome.
UX-DR24: Match `imports/` nashsu density/layout; do not invent a restyle. Mock references: `mockups/todos.html`, `create-wiki.html`, `intake.html`, `chat-cited.html`.

### FR Coverage Map

FR-1: Epic 1 — private-by-default Wiki; commons 404
FR-2: Epic 2 — immutable Sources; compiled Pages with `sources: []`
FR-3: Epic 2 — accumulate; `disputed: true`
FR-4: Epic 1 — icon rail modes
FR-5: Epic 1 — Workbench; Chat rail icon; Preview docks view-first
FR-6: Epic 1 — drag-resize mins
FR-7: Epic 2 — Activity panel
FR-8: Epic 1 — durable Workbench state
FR-9: Epic 2 — two-step Ingest
FR-10: Epic 2 — SHA256 skip
FR-11: Epic 2 — Index, Log, Overview, Source summary
FR-12: Epic 2 — cascade delete
FR-13: Epic 3 — independent Conversations
FR-14: Epic 3 — cited answers
FR-15: Epic 3 — Save to Wiki
FR-16: Epic 3 — Sources-only Chat
FR-17: Epic 3 — Regenerate
FR-18: Epic 3 — Search
FR-19: Epic 5 — knowledge graph viz
FR-20: Epic 5 — Graph Insights
FR-21: Epic 5 — Lint report
FR-22: Epic 5 — mechanical auto-fix
FR-23: Epic 5 — Review items
FR-24: Epic 6 — confirmed Deep Research
FR-25: Epic 2 — Capture URL/clip
FR-26: Epic 4 — meeting Todo Candidates
FR-27: Epic 4 — approve/reject
FR-28: Epic 4 — due dates, open/done, no TTL
FR-29: Epic 4 — links back to meeting
FR-30: Epic 2 — Plaud transcript+summary as Sources
FR-31: Epic 2 (upload P0) + Epic 7 (OAuth P1)
FR-32: Epic 2 (text/URL/Plaud) + Epic 7 (office/ebook extend)
FR-33: Epic 2 — batch and drag-drop
FR-34: Epic 1 — editable Schema
FR-35: Epic 1 — dual Chat/Ingest models
FR-36: Epic 8 — API enablement and loopback bind
FR-37: Epic 2 — ZIP export/import
FR-38: Epic 1 — Scenario Templates
FR-39: Epic 2 — serial durable queue
FR-40: Epic 2 — recursive folder import
FR-41: Epic 2 (upload/folder/capture) + Epic 7 (email inbound)
FR-42: Epic 2 — auto-embed only when vector on
FR-44: Epic 2 — progressive Sources view
FR-45: Epic 5 — 4-signal Relevance
FR-46: Epic 5 — graph interaction and position cache
FR-47: Epic 5 — Louvain Communities
FR-48: Epic 5 — Surprising Connections
FR-49: Epic 5 — Knowledge Gaps
FR-50: Epic 5 — Insight highlight and Deep Research entry
FR-51: Epic 3 — tokenized search
FR-52: Epic 3 — optional vector search
FR-53: Epic 3 — graph expansion
FR-54: Epic 3 — context budget
FR-55: Epic 3 — context assembly and `[n]`
FR-56: Epic 1 — Settings shell + models/embeddings/vector-off (DR keys Epic 6; MinerU Epic 7; API+MCP Epic 8)
FR-57: Epic 3 — Conversation sidebar
FR-58: Epic 3 — per-conversation persistence
FR-59: Epic 3 — history depth
FR-60: Epic 3 — sidecar Agent runtime
FR-61: Epic 8 — tool-using Agent (skills/shell/workspace)
FR-62: Epic 8 — Skill management
FR-63: Epic 8 — agent-workspace outputs
FR-64: Epic 8 — Skill forms
FR-65: Epic 8 — safer shell
FR-66: Epic 3 — thinking display
FR-67: Epic 6 — DR providers (Tavily default)
FR-68: Epic 6 — Research Panel
FR-69: Epic 6 — research Page + auto-Ingest
FR-70: Epic 6 — DR concurrency cap 3
FR-71: Epic 7 — structured office/PDF/ebook extract
FR-72: Epic 7 — image preview and AV player
FR-73: Epic 1 (GFM + wikilinks) + Epic 7 (Mermaid/KaTeX)
FR-74: Epic 1 (dataVersion signal) + Epic 2 (bump on Ingest)
FR-76: Epic 3 (health + chat) + Epic 8 (full `/api/v1` surface)
FR-77: Epic 3 — Agent chat HTTP + SSE
FR-78: Epic 8 — MCP + copyable config
FR-79: Epic 8 — llm-wiki Agent Skill

## Epic List

### Epic 1: Private Workbench
Christian signs in, creates a Wiki from a Scenario Template, and works in the nashsu shell (icon rail, trees, view-first Preview, durable layout). Commons/public leftover is gone. LLM settings exist so later Ingest/Chat can run.
**FRs covered:** FR-1, FR-4, FR-5, FR-6, FR-8, FR-34, FR-35, FR-38, FR-56 (Settings shell + models/embeddings/vector-off), FR-73 (GFM + wikilinks), FR-74 (signal)

### Epic 2: Sources compile
Christian drops text, URLs, folders, Capture, or Plaud upload; they auto-queue two-step Ingest. Activity, SHA256 skip, serial queue, Source summary, cascade delete, ZIP export.
**FRs covered:** FR-2, FR-3, FR-7, FR-9, FR-10, FR-11, FR-12, FR-25, FR-30, FR-31 (upload), FR-32 (text/URL/Plaud), FR-33, FR-37, FR-39, FR-40, FR-41 (upload/folder/capture), FR-42, FR-44, FR-74 (bump on commit)

### Epic 3: Ask the wiki
Cited Chat via the local sidecar, Conversations, Save to Wiki, Search, retrieval pipeline. Empty wiki states missing coverage — no fake citations.
**FRs covered:** FR-13, FR-14, FR-15, FR-16, FR-17, FR-18, FR-51, FR-52, FR-53, FR-54, FR-55, FR-57, FR-58, FR-59, FR-60, FR-66, FR-76 (health + chat), FR-77

### Epic 4: Meeting Todos
Plaud-origin or marked-meeting Ingest proposes Candidates; Christian approves or rejects with due dates and links back. Does not require Chat.
**FRs covered:** FR-26, FR-27, FR-28, FR-29

### Epic 5: See the wiki's shape
Graph (sigma + Louvain + Insights), Lint, and the Review queue.
**FRs covered:** FR-19, FR-20, FR-21, FR-22, FR-23, FR-45, FR-46, FR-47, FR-48, FR-49, FR-50

### Epic 6: Deep Research
Confirmed multi-query web research (Tavily default), Research Panel, auto-Ingest, max 3 concurrent.
**FRs covered:** FR-24, FR-67, FR-68, FR-69, FR-70

### Epic 7: Any document in
Sidecar extract for office/PDF/EPUB, inbound email, Plaud OAuth, media preview, Mermaid/KaTeX.
**FRs covered:** FR-31 (OAuth), FR-32 (office/ebook extend), FR-41 (email), FR-71, FR-72, FR-73 (Mermaid/KaTeX)

### Epic 8: Agents at the door
Loopback API/MCP, llm-wiki skill, in-app Skills, approved shell, Settings → API + MCP.
**FRs covered:** FR-36, FR-61, FR-62, FR-63, FR-64, FR-65, FR-76 (full surface), FR-78, FR-79

## Epic 1: Private Workbench

Christian signs in, creates a Wiki from a Scenario Template, and works in the nashsu shell (icon rail, trees, view-first Preview, durable layout). Commons/public leftover is gone. LLM settings exist so later Ingest/Chat can run.

### Story 1.1: Sign in privately and retire commons

As Christian,
I want the app to require my Clerk session and hide every public leftover,
so that my wiki is owner-only from the first load.

**Acceptance Criteria:**

**Given** I am not signed in
**When** I open any Workbench or owner API route
**Then** I am sent to Clerk sign-in (pages) or get 401 (APIs)
**And** unauthenticated MCP/HTTP wiki reads do not succeed (AD-8, AD-21)

**Given** I am signed in
**When** I request `/commons`, public browse, waitlist, billing, clone-to-private, or talk
**Then** each route 404s
**And** `syncCommonsForPage` is a no-op
**And** user-visible copy says **work-wiki**
**And** runtime identifiers stay `yopedia` (AD-7)

**Given** I open the app on a phone or another Clerk browser without the sidecar
**When** the shell loads
**Then** Chat, extract, MCP, and shell are unavailable — no alternate IA (NFR-10, AD-17)
**And** surfaces that do not need the sidecar remain reachable with Clerk

### Story 1.2: Create a Wiki from a Scenario Template

As Christian,
I want to create a named Wiki by picking one of five templates,
so that I never start from a blank vault.

**Acceptance Criteria:**

**Given** I have no Wiki (or I choose New Wiki)
**When** I open Create Wiki
**Then** I must pick exactly one of Research, Reading, Personal Growth, Business, General
**And** there is no blank-Wiki option (UX-DR19, `mockups/create-wiki.html`)

**Given** I confirm a template
**When** create finishes
**Then** `purpose.md` and Schema exist and differ by template (Business ≠ Reading)
**And** I land on Wiki mode
**And** Preview empty copy is “Select a file to preview.”

**Given** I already have a Wiki
**When** I apply a different Scenario Template
**Then** a confirm dialog warns that purpose/Schema will be overwritten
**And** Cancel writes nothing
**And** Confirm overwrites purpose/Schema only — not Pages or Sources

### Story 1.3: Nashsu icon rail and Workbench chrome

As Christian,
I want the nashsu icon rail and chrome,
so that every later mode lives in one shell instead of separate apps.

**Acceptance Criteria:**

**Given** I am signed in with a Wiki
**When** the Workbench renders at ≥1200px
**Then** the icon rail is 48px with order Wiki · Chat · Sources · Search · Graph · Lint · Todos · Review · Deep Research · Skills
**And** bottom controls are sidecar status · Settings · collapse chevron
**And** the active icon is a filled rounded square in foreground wash
**And** tokens, type, and density match DESIGN.md / `imports/` (UX-DR1, 2, 24)
**And** the product title is **work-wiki**, light theme only

**Given** Chat mode is selected and the sidecar is down
**When** the canvas shows
**Then** Chat is a rail icon, not a permanent center column
**And** the empty copy is the sidecar-down / fail-closed sentence from EXPERIENCE.md
**And** the status dot is not live
**And** switching modes does not destroy typed Chat input if a composer is visible

**Given** I select Sources, Search, Graph, Lint, Todos, Review, Deep Research, or Skills before those epics land
**When** that mode opens
**Then** I get that mode’s one-sentence empty state (UX-DR15)
**And** the surface name is announced (UX-DR21)

**Given** viewport is 900–1199px or <900px
**When** the shell lays out
**Then** 900–1199 honors min widths; <900 the rail becomes a sheet
**And** Graph is not the job surface on small screens (UX-DR22)

### Story 1.4: Knowledge Tree and File Tree

As Christian,
I want Knowledge and Files trees in the left column,
so that I can browse compiled Pages and vault files without opening a local folder.

**Acceptance Criteria:**

**Given** Wiki mode is active
**When** the left column shows
**Then** it has Knowledge | Files tabs (UX-DR5)
**And** the header **work-wiki** is the Wiki switcher plus New Wiki
**And** there is no “Open project folder”

**Given** the template Wiki from 1.2 exists
**When** I expand Knowledge and Files
**Then** I see `purpose.md`, Schema, and the seeded wiki tree
**And** selecting a file docks the Preview column

**Given** I switch Wikis from the header
**When** I pick another of my Wikis
**Then** the trees show that Wiki’s files
**And** I cannot see another owner’s Wiki

### Story 1.5: View-first Preview with GFM and wikilinks

As Christian,
I want Preview to render the page and only edit markdown after confirm,
so that I read compiled Pages instead of living in an editor.

**Acceptance Criteria:**

**Given** no file is selected
**When** Preview would show
**Then** copy is “Select a file to preview.”
**And** Preview is not a third column until a tree pick (or later a citation)

**Given** I select a markdown Page
**When** Preview docks
**Then** it renders GFM, bordered tables, and `[[wikilinks]]`
**And** chrome/frontmatter use SF/system sans; body and headings use Georgia
**And** a missing wikilink is a missing-link state, not a silent skip
**And** Mermaid and KaTeX are not required (Epic 7)

**Given** I choose Edit
**When** the confirm dialog appears
**Then** Cancel leaves view-first
**And** Confirm opens markdown only — no WYSIWYG
**And** Save writes through the kernel page-write path
**And** Esc closes the dialog without saving

### Story 1.6: Drag-resize and durable layout

As Christian,
I want to resize columns and keep layout across reload,
so that the Workbench feels like a desk I already arranged.

**Acceptance Criteria:**

**Given** the Workbench is at ≥1200px with Preview docked
**When** I drag column dividers
**Then** Chat (when visible) cannot go below 320px
**And** tree and Preview cannot go below 200px
**And** widths persist across reload (browser-local is allowed)

**Given** I set last mode, tree selection, and tree scroll
**When** I reload
**Then** those restore (FR-8)
**And** project/Wiki selection restores
**And** Conversations and Review persistence are not required until those epics

### Story 1.7: dataVersion Workbench refresh

As Christian,
I want the shell to notice kernel writes without a full reload,
so that later Ingest can refresh trees and Preview in place.

**Acceptance Criteria:**

**Given** the kernel commits a page or Schema write
**When** `writeWikiPageWithSideEffects` / delete succeeds
**Then** `dataVersion` in `YOPEDIA_CONFIG` bumps as a monotonic integer (AD-11)

**Given** the Workbench is open
**When** `dataVersion` changes
**Then** trees and Preview refetch
**And** the window does not fully reload
**And** identifiers stay `yopedia`

### Story 1.8: Edit Schema

As Christian,
I want to edit Schema in the Wiki,
so that later Ingest, Chat, Lint, and Todos follow my conventions.

**Acceptance Criteria:**

**Given** a Wiki exists
**When** I open Schema
**Then** I can edit it and save through the kernel write path
**And** Page conventions from SCHEMA.md still load at runtime (AD-10)
**And** I do not fork a second copy of conventions into code

**Given** Schema is saved
**When** `dataVersion` bumps
**Then** Preview shows the saved Schema
**And** English-only copy is unchanged (NFR-9)

### Story 1.9: Settings for models and embeddings

As Christian,
I want Chat and Ingest models plus embeddings configured in Settings,
so that later compile and Chat have keys and vector-off is the default.

**Acceptance Criteria:**

**Given** I open Settings
**When** the nav renders
**Then** categories include at least General, LLM Models, Embeddings, Interface, About
**And** Intake, MinerU, API + MCP, and DR keys may be listed but are not required to function
**And** LLM timeout is configurable
**And** optional Firecrawl API key and base URL may be stored
**And** a sticky save-bar says “Changes apply after saving” (UX-DR14)

**Given** I set Chat model and Ingest model independently
**When** I save
**Then** both persist in the kernel store (AD-23)
**And** providers include OpenAI, Anthropic, Google, Ollama, Custom
**And** vector search defaults off (AD-12)
**And** UI language is English only

**Given** I change settings and leave without saving
**When** I return
**Then** unsaved edits are not applied

## Epic 2: Sources compile

Christian drops text, URLs, folders, Capture, or Plaud upload; they auto-queue two-step Ingest. Activity, SHA256 skip, serial queue, Source summary, cascade delete, ZIP export.

### Story 2.1: Upload, drag-drop, and URL Intake

As Christian,
I want to drop files or paste a URL and have them stored as Sources,
so that Intake starts without a separate Ingest click.

**Acceptance Criteria:**

**Given** I am in the Workbench
**When** I upload, drag-drop, or submit an in-app URL
**Then** bytes (or fetched clip markdown) land under `raw/sources/` via `saveRawSource` / `saveRawSourceFor`
**And** each item is queued for Ingest automatically (FR-41)
**And** tree header uses Import/Upload, not “Open project folder” (UX-DR5)

**Given** I drop a PDF, DOCX, or other office/ebook type
**When** Intake runs
**Then** it fails visibly — never a silent drop (FR-32)
**And** no sidecar extract job is required in this story (Epic 7)

**Given** the URL is HTML
**When** the kernel fetches it
**Then** it becomes clean Markdown via Readability + `htmlToMarkdown` (AD-16)
**And** Sources are immutable after save (FR-2)

### Story 2.2: Recursive folder import

As Christian,
I want to import a folder tree,
so that relative paths survive and classify the files.

**Acceptance Criteria:**

**Given** I import a nested folder
**When** Intake finishes storing
**Then** stored paths under `raw/sources/` mirror the relative tree (FR-40)
**And** each file is its own queue item
**And** Analysis/Generation later receive that relative path as context

**Given** the folder contains unsupported office binaries
**When** those files are considered
**Then** each fails visibly as in 2.1
**And** supported text/markdown/URL-equivalent files still queue

### Story 2.3: Capture URL or clip

As Christian,
I want Capture (bookmarklet, share, or in-app URL) to enqueue a Source,
so that a page I am reading becomes Intake without downloading a file.

**Acceptance Criteria:**

**Given** Capture sends a URL or clip
**When** the kernel receives it
**Then** it is stored under `raw/sources/` and queued like any other arrival (FR-25, FR-41)
**And** provenance includes the captured URL

**Given** Capture payload is empty or blocked
**When** Intake attempts store
**Then** the failure is visible on the Capture action
**And** no Source record is invented

### Story 2.4: Plaud transcript and summary upload

As Christian,
I want to upload a Plaud transcript and summary as Sources,
so that meetings enter the wiki without trusting Plaud’s action items as Todos.

**Acceptance Criteria:**

**Given** I upload Plaud transcript and/or summary files
**When** they are stored
**Then** each is an immutable Source with Plaud-origin provenance (FR-30, FR-31 upload)
**And** they auto-queue for two-step Ingest
**And** Plaud action-item lists are not written as Todos (FR-26 is Epic 4)

**Given** OAuth list/pull is not built
**When** I look for Plaud connect
**Then** upload is the only Plaud path in this epic

### Story 2.5: Serial durable queue and Activity

As Christian,
I want a per-file Activity panel on a serial durable queue,
so that I can see Analysis vs Generation, cancel, and retry without losing Sources.

**Acceptance Criteria:**

**Given** N files are queued
**When** Activity is open
**Then** I see N rows: pending / Analysis / Generation / succeeded / failed / skipped (FR-7, UX-DR10)
**And** Activity docks under the left column on Wiki/Sources/Files and is collapsible
**And** a progress bar reflects queue depth and the active step

**Given** two Sources are queued on one Wiki
**When** Ingest runs
**Then** their LLM work does not overlap (FR-39, AD-9)
**And** the Workbench stays interactive (NFR-5)
**And** Chat is allowed to overlap when it exists later

**Given** a job fails
**When** auto-retry runs
**Then** it attempts at most 3 times, then stays failed for manual retry
**And** retry does not duplicate the Source
**And** Cancel must not commit Page writes (in-flight LLM may finish server-side)

**Given** the app or Worker restarts
**When** I reopen the Wiki
**Then** pending/failed jobs are still in the queue (NFR-1)
**And** the consumer stays thin: POST `/api/tasks/run` with `YOPEDIA_SERVICE_TOKEN` (AD-13)

### Story 2.6: Two-step Analysis then Generation

As Christian,
I want Ingest to analyze then generate,
so that Pages accumulate from Sources instead of a single read-and-write.

**Acceptance Criteria:**

**Given** a queued Source with extracted/plain text in the kernel
**When** Ingest runs
**Then** Analysis LLM runs first and stores JSON with the job via `getStorage()` (AD-4)
**And** Generation starts only after Analysis succeeds
**And** Activity shows that order (FR-9)
**And** Generation is given the Analysis artifact, not a fresh unguided read

**Given** Generation succeeds
**When** Pages are written
**Then** writes go through `writeWikiPageWithSideEffects` only (AD-3)
**And** every generated Page has YAML `sources: []` except bookkeeping Pages (FR-2)
**And** new material merges into existing concept Pages
**And** contradictions set `disputed: true` (FR-3)
**And** `dataVersion` bumps (FR-74)
**And** LLM Generation is English-only (NFR-9)

**Given** Generation fails after Analysis succeeded
**When** I retry Generation
**Then** Analysis is reused (no second Analysis payment)
**And** the Source bytes still exist
**And** Ingest does not wait on Review UI (FR-23) and does not create Todos

**Given** human judgment is needed
**When** Ingest succeeds
**Then** Review items may be persisted in the kernel with proposed search queries
**And** Ingest is not blocked on Skip/Create/Deep Research

### Story 2.7: SHA256 skip cache

As Christian,
I want unchanged files skipped by SHA256,
so that re-import does not re-pay the Ingest LLMs.

**Acceptance Criteria:**

**Given** a Source whose bytes hash to a SHA256 already ingested
**When** it arrives again
**Then** Analysis and Generation are not called (FR-10)
**And** Activity marks the row skipped
**And** provenance records that the Source was seen again
**And** the fork FNV-1a skip path is not used (AD-4)

**Given** any byte change
**When** the new hash is computed
**Then** full two-step Ingest is queued

### Story 2.8: Index, Log, Overview, Source summary

As Christian,
I want bookkeeping Pages updated on every successful Ingest,
so that the wiki always has an Index, Log, Overview, and Source summary.

**Acceptance Criteria:**

**Given** Ingest Generation succeeds
**When** side effects run
**Then** `index.md` lists new/updated Pages
**And** `log.md` appends a chronological entry pointing at the Source
**And** `overview.md` is regenerated (content changes, not only on first Ingest) (FR-11)

**Given** Generation omits a Source summary
**When** the kernel finalizes the job
**Then** the system still writes a Source summary that cites the Source
**And** the job is not success without that summary
**And** summary metadata is not parsed out of free-form LLM headings (`.yoyo/learnings.md`)

### Story 2.9: Embed after Ingest only when vector is on

As Christian,
I want new Pages embedded only if vector search is on,
so that default Ingest does not depend on Vectorize.

**Acceptance Criteria:**

**Given** vector search is off (default from 1.9)
**When** Ingest succeeds
**Then** the job succeeds with no embed requirement (FR-42, AD-12)

**Given** vector search is on
**When** Ingest creates or updates Pages
**Then** those Pages are embedded automatically, model-tagged
**And** turning vector on for an existing Wiki enqueues embed of current Pages (progress in Activity)
**And** turning it off does not delete Sources or Pages

### Story 2.10: Confirm-gated cascade Source delete

As Christian,
I want deleting a Source to confirm and cascade cleanly,
so that shared entities stay and dead links do not.

**Acceptance Criteria:**

**Given** I choose delete on a Source
**When** the confirm dialog is open
**Then** Cancel writes nothing
**And** Confirm always removes the Source summary Page first (FR-12, UX-DR17)

**Given** related Pages are found by (1) `sources: []`, (2) Source summary name, or (3) YAML fields whose values are that Source path/slug
**When** cascade runs
**Then** a Page linked only to this Source is deleted
**And** a shared Page is kept; the Source is removed from `sources: []` only
**And** `disputed` is not cleared
**And** dead `[[wikilinks]]` to deleted Pages are removed
**And** `index.md` is purged of deleted Pages
**And** a Page matching none of the three methods is untouched
**And** Todos linked to the Source show source-missing when Todos exist (Epic 4) — they are not silently deleted
**And** delete goes through `deleteWikiPage` / the lifecycle path, not a second writer

### Story 2.11: Progressive Sources view

As Christian,
I want large `raw/sources/` trees to render while scrolling,
so that a big Intake folder stays usable.

**Acceptance Criteria:**

**Given** a Sources tree with hundreds of files
**When** I open Sources
**Then** first paint does not wait on every row (FR-44)
**And** scrolling reveals more files without a full-tree remount that loses scroll position

**Given** Sources is empty
**When** the mode opens
**Then** I get the one-sentence empty state from EXPERIENCE.md (UX-DR15)

### Story 2.12: ZIP export and import

As Christian,
I want to ZIP export and import the Wiki,
so that I can back it up and open it in Obsidian.

**Acceptance Criteria:**

**Given** a Wiki with Pages and Sources
**When** I export
**Then** the ZIP includes Pages, Sources, and an auto-generated `.obsidian/` directory (FR-37)
**And** Todos and chats record-shape are included when those records exist

**Given** I import that ZIP
**When** restore finishes
**Then** Pages and Sources are back in the kernel store
**And** rebuilding `index.md` from current Pages is deterministic
**And** identifiers stay `yopedia`

## Epic 3: Ask the wiki

Cited Chat via the local sidecar, Conversations, Save to Wiki, Search, retrieval pipeline. Empty wiki states missing coverage — no fake citations.

### Story 3.1: Sidecar health and Chat HTTP/SSE

As Christian,
I want Chat to talk to the local sidecar over the locked HTTP/SSE contract,
so that the cloud Worker never pretends to be the Agent.

**Acceptance Criteria:**

**Given** the sidecar is running on `127.0.0.1:19828`
**When** I `GET /api/v1/health`
**Then** it needs no auth and reports at least `ok`, `status`, `version`, `enabled`, `authRequired`, `authConfigured`, `allowUnauthenticated`, `tokenSource` (FR-76 health)

**Given** I send `POST /api/v1/projects/:wikiId/chat` on the sidecar with `stream: true` or `Accept: text/event-stream`
**When** a turn runs
**Then** SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error` (FR-77, AD-5)
**And** JSON is the non-stream default
**And** the `done` frame is the complete aggregate — the client must not also commit deltas as a second message
**And** `{id}` accepts `current` or the Wiki UUID

**Given** Chat is posted to the cloud OpenNext origin
**When** that route runs
**Then** it returns 503 `sidecar_required`
**And** `src/lib/query.ts` / `/api/query` is not v1 Chat (404 or unused)

**Given** the sidecar is down
**When** I open Chat
**Then** it fails closed with the EXPERIENCE.md sidecar-down copy
**And** the status dot is not live
**And** there is no in-browser TS Agent stub (FR-60)

### Story 3.2: Conversations sidebar and persistence

As Christian,
I want named Conversations I can create, rename, delete, and switch,
so that topics stay independent across reload.

**Acceptance Criteria:**

**Given** Chat mode is open
**When** the sidebar shows
**Then** I can New Chat, rename, delete, and switch (FR-13, FR-57, UX-DR6)
**And** empty copy is “Start a new conversation. Click New Chat to begin.”
**And** composer placeholder is “Type a message…”
**And** send is disabled until there is text

**Given** two Conversations exist
**When** I switch
**Then** messages do not mix
**And** the active session is visually distinct
**And** unsaved composer text is not applied to the other Conversation

**Given** I reload
**When** Chat opens
**Then** Conversations, messages, and per-message citations restore from the kernel (FR-58, AD-23)
**And** the nashsu record shape (id, name, messages, per-message citations) is what export uses
**And** delete removes that Conversation’s messages and does not delete Wiki Pages

### Story 3.3: Tokenized retrieval, budget, and numbered assembly

As Christian,
I want Chat context assembled from ranked Pages under a token budget,
so that answers use the wiki instead of the whole vault.

**Acceptance Criteria:**

**Given** vector search is off
**When** Search or Chat retrieves
**Then** Phase 1 tokenized search runs over `wiki/` and `raw/sources/` (FR-51)
**And** English uses word split + stop words; CJK uses bigram
**And** a title match adds +10 vs body-only

**Given** I set the context slider between 4K and 1M tokens
**When** a Chat turn assembles context
**Then** the assembled prompt does not exceed that budget (FR-54)
**And** the split is 60% Pages / 20% history / 5% index / 15% system
**And** history depth defaults to 10 messages; the tighter of N vs the 20% slot wins (FR-59)
**And** changing N applies to the next send only

**Given** Pages are selected for the wiki slice
**When** Phase 4 runs
**Then** the model gets numbered full Page/Source bodies, not summaries only (FR-55)
**And** `purpose.md` and `index.md` stay in the system/index allocation
**And** Schema Page conventions load at runtime (AD-10)

### Story 3.4: Optional vector merge

As Christian,
I want vector search only when I turn it on,
so that Chat still works on tokenized hits by default.

**Acceptance Criteria:**

**Given** vector search is off
**When** I Chat or Search
**Then** results still come from tokenized search (FR-51, FR-52)

**Given** vector is on with endpoint, key, and model
**When** retrieval runs
**Then** cosine ANN merges into tokenized hits (boost + new semantic neighbors)
**And** embeddings are model-tagged; mismatch is a miss, then fallback to tokenized
**And** ANN is Vectorize (or the kernel store), not LanceDB (AD-12)

**Given** vector credentials are missing or invalid
**When** that phase fails
**Then** the failure is visible and Chat falls back to tokenized + graph
**And** Chat is not blank

### Story 3.5: Graph expansion for retrieval

As Christian,
I want top hits expanded two hops,
so that related Pages can enter Chat context even without the keyword.

**Acceptance Criteria:**

**Given** Phase 1 (and 1.5 if on) returned seed hits
**When** Phase 2 runs
**Then** expansion is 2-hop with decay on the second hop (FR-53)
**And** it runs whether or not vector search is on
**And** a wikilinked neighbor of a top hit can enter the candidate set

**Given** Graph mode is still an empty rail from Epic 1
**When** this story ships
**Then** expansion is kernel-only
**And** 4-signal Relevance scoring and sigma viz remain Epic 5 (FR-45)

### Story 3.6: Cited Chat answers

As Christian,
I want answers with `[n]` citations that open Preview,
so that I can check the wiki instead of trusting a blob.

**Acceptance Criteria:**

**Given** matching Pages exist
**When** the sidecar finishes a turn
**Then** the answer includes at least one `[n]` that maps to assembled context (FR-14, FR-55)
**And** a collapsible cited-references panel lists those Pages grouped by type
**And** `[n]` or a panel row docks Preview
**And** citations are stored on the message (FR-58)
**And** Chat answer type stays SF/system sans (UX-DR2)

**Given** no Page matches
**When** the model would answer
**Then** the UI states coverage is missing: “Wiki has no coverage for this. Ingest a source or run Deep Research.”
**And** there is no fake citation and no empty fake panel (NFR-3)

**Given** I send from the composer
**When** the sidecar streams
**Then** the Workbench stays interactive (NFR-5)
**And** retrieval/tool name+outcome can show on the message
**And** Skills, shell approval, and `agent-workspace/` chips are not required (Epic 8)

### Story 3.7: Sources-only Chat

As Christian,
I want a visibly distinct Sources-only mode,
so that I can ask what the raw file said.

**Acceptance Criteria:**

**Given** Smart retrieval is set to Sources-only
**When** I send a message
**Then** citations point at Sources, not concept Pages (FR-16)
**And** the mode cannot be confused with Wiki Chat (composer/chrome is distinct)

**Given** I switch back to Wiki retrieval
**When** I send again
**Then** citations may point at compiled Pages again
**And** the setting is per Conversation

### Story 3.8: Thinking blocks

As Christian,
I want Thinking shown separately from the answer,
so that reasoning is inspectable and not filed as wiki prose.

**Acceptance Criteria:**

**Given** the model emits a Thinking block
**When** it streams
**Then** a 5-line rolling viewport shows with newer lines more opaque (FR-66, UX-DR8)
**And** `prefers-reduced-motion` is honored (NFR-6)

**Given** the turn completes
**When** I look at the message
**Then** Thinking is collapsed by default and distinct from the answer
**And** it is stored on the message so expand works after reload
**And** it is not a Wiki citation and is not in Save to Wiki

**Given** the model emits no Thinking
**When** the answer renders
**Then** there is no empty thinking chrome

### Story 3.9: Regenerate last turn

As Christian,
I want one click to regenerate the last response,
so that a bad turn can be replaced without a new Conversation.

**Acceptance Criteria:**

**Given** a Conversation has a last user+assistant pair
**When** I Regenerate
**Then** that pair is removed and the user message is re-sent (FR-17)
**And** new citations reflect the new retrieval

**Given** the Conversation is empty or has no last pair
**When** I Regenerate
**Then** it is a no-op (no crash)

### Story 3.10: Save to Wiki

As Christian,
I want to file a good answer under `wiki/queries/` and auto-Ingest it,
so that the answer joins the compiled wiki.

**Acceptance Criteria:**

**Given** an assistant answer exists
**When** I Save to Wiki
**Then** a query Page is written under `wiki/queries/` with a link back to the Conversation (FR-15)
**And** the body is the main response only (no Thinking)
**And** arrival auto-queues two-step Ingest (FR-41)
**And** writes go through `writeWikiPageWithSideEffects`

**Given** Ingest of that query Page finishes
**When** I Chat again
**Then** the new Pages are retrievable

### Story 3.11: Search mode

As Christian,
I want Search over Pages and Sources that opens Preview,
so that I can find a file without asking Chat.

**Acceptance Criteria:**

**Given** Search mode is open with an empty query
**When** I look at the canvas
**Then** copy is “Press Enter to search.”
**And** an empty query does not error (FR-18, UX-DR15)

**Given** I submit a query
**When** results return
**Then** they are ranked hits from `wiki/` and `raw/sources/` using Phases 1–2 (vector only if on)
**And** selecting a hit docks Preview
**And** Search API `POST /api/v1/projects/:wikiId/search` matches FR-76 fields (`query`, `topK`, hits with `path`, `title`, `snippet`, `score`)
**And** empty search `query` on the API is 400

**Given** hits include images
**When** this story ships
**Then** an image section + lightbox is not required (Epic 7, FR-72)

## Epic 4: Meeting Todos

Plaud-origin or marked-meeting Ingest proposes Candidates; Christian approves or rejects with due dates and links back. Does not require Chat.

### Story 4.1: Extract Todo Candidates from meeting Ingest

As Christian,
I want meeting Ingest to propose Todo Candidates,
so that I leave a meeting with actions without trusting Plaud’s list.

**Acceptance Criteria:**

**Given** a Source is Plaud-origin or I have marked it “meeting”
**When** two-step Ingest succeeds
**Then** zero or more Candidates are stored (title, rationale, optional due, speaker/context if present) (FR-26)
**And** the Todos Candidates list always updates, including “none found”
**And** Candidates persist in the kernel (AD-23)

**Given** a Source is not Plaud-origin and is not marked meeting
**When** Ingest succeeds
**Then** no Candidates are created
**And** PPT/PDF/URL/office default off — no classifier

**Given** Ingest fails or is skipped
**When** the job ends
**Then** no Candidates are created from that compile
**And** Plaud action-item lists are not copied into Todos (FR-30)

**Given** a non-Plaud Source
**When** I choose Mark as meeting on Sources or Preview
**Then** the next (or queued) Ingest for that Source uses the FR-26 path

### Story 4.2: Approve or reject Candidates

As Christian,
I want to approve or reject Candidates explicitly,
so that nothing becomes a Todo behind my back.

**Acceptance Criteria:**

**Given** Candidates exist
**When** I open Todos
**Then** I see Candidates | Open | Done (UX-DR12, `mockups/todos.html`)
**And** each Candidate card has Approve (primary) and Reject (destructive ghost)
**And** those actions are in the tab order, not hover-only
**And** the rail badge shows candidate count when non-zero (“N todo candidates”)

**Given** I Approve or Reject (single or bulk)
**When** the decision saves
**Then** nothing auto-promotes (FR-27, NFR-8)
**And** decision, timestamp, and actor are stored
**And** rejected Candidates never appear in Open

**Given** Candidates is empty
**When** the list shows
**Then** copy is “No candidates. Meeting ingest will propose them.”

### Story 4.3: Due dates, Open/Done, and owner delete

As Christian,
I want optional due dates, Open/Done, and edits that keep links,
so that the list stays a working list until I delete items.

**Acceptance Criteria:**

**Given** an approved Todo
**When** I view Open
**Then** I can set or clear a due date, mark done, and edit title/due without breaking Source/Page links (FR-28)
**And** I can sort/filter by due date and status

**Given** I complete a Todo
**When** it moves to Done
**Then** links to Source/Page remain
**And** rejected Candidates and completed Todos persist until I delete them — no TTL (AD-20)

**Given** Open is empty
**When** Candidates or Done still have items
**Then** Open can be empty without hiding the other tabs

### Story 4.4: Links back to the meeting

As Christian,
I want every Candidate and Todo to open the meeting Source or Page,
so that I can check what was actually said.

**Acceptance Criteria:**

**Given** a Candidate or Todo from a meeting Ingest
**When** I follow its meeting link
**Then** Preview opens the meeting Page if one exists, otherwise the Source transcript (FR-29)

**Given** I delete that Source (Epic 2 cascade)
**When** I look at linked Todos
**Then** they show source-missing
**And** they are not silently deleted (FR-12)

## Epic 5: See the wiki's shape

Graph (sigma + Louvain + Insights), Lint, and the Review queue.

### Story 5.1: 4-signal Relevance in the kernel

As Christian,
I want pairwise Page Relevance computed in the kernel,
so that Graph and Chat expansion share one score.

**Acceptance Criteria:**

**Given** two Pages
**When** Relevance is computed
**Then** it is a weighted sum: wikilink ×3.0, source overlap ×4.0, Adamic-Adar ×1.5, type affinity ×1.0 (FR-45)
**And** a missing signal contributes 0
**And** shared-Source beats a single wikilink, all else equal
**And** unrelated mixed-type Pages with no link, overlap, or neighbors score 0

**Given** Chat Phase 2 from 3.5
**When** this story ships
**Then** expansion can use this Relevance, not wikilink-only
**And** `GET .../graph` for the Agent Skill may stay the wikilink graph — it is not this viz (AD-14)

### Story 5.2: Graph canvas with sigma

As Christian,
I want Graph mode to show every Page as a force-directed graph,
so that I can see the wiki’s shape.

**Acceptance Criteria:**

**Given** the Wiki has Pages
**When** I open Graph
**Then** every Page is a node, including isolates (FR-19)
**And** the canvas uses sigma 3.0.3 + graphology 0.26.0 + ForceAtlas2 0.10.1 (AD-14)
**And** node size uses √ degree
**And** edge thickness/color follow Relevance: green = strong, gray = weak
**And** clicking a node docks Preview
**And** Graph is not the job surface below ~900px (UX-DR22)

**Given** Graph has no Pages
**When** the mode opens
**Then** I get the one-sentence empty state from EXPERIENCE.md

### Story 5.3: Louvain Communities and Type/Community toggle

As Christian,
I want Communities from topology, not from `type`,
so that clusters are discovered rather than labeled by me.

**Acceptance Criteria:**

**Given** Graph data is loaded
**When** Louvain runs (`graphology-communities-louvain` 2.0.2)
**Then** each Page gets a Community from topology, not frontmatter `type` (FR-47)
**And** I can toggle Type / Community coloring without leaving Graph
**And** Community colors use the 12-color palette (reuse only after 12)

**Given** Community coloring is on
**When** I read the legend
**Then** each cluster shows top node label, member count, and Cohesion
**And** Cohesion < 0.15 is warned
**And** type coloring shows type counts instead
**And** re-cluster happens when Graph data refreshes — no separate “run clustering” click

### Story 5.4: Graph hover, zoom, and position cache

As Christian,
I want hover, zoom, and stable layout after Ingest,
so that the graph does not re-scatter every compile.

**Acceptance Criteria:**

**Given** Graph is showing
**When** I hover a node
**Then** neighbors stay visible, others dim, and incident edges show a Relevance label (FR-46)

**Given** I use Zoom in, Zoom out, or Fit
**When** the view changes
**Then** Fit brings all current nodes into view

**Given** layout has run
**When** Ingest bumps `dataVersion`
**Then** positions persist (no random re-scatter)
**And** `prefers-reduced-motion` jumps to cached positions (NFR-6)

### Story 5.5: Surprising Connections

As Christian,
I want Insight cards for unexpected edges,
so that I can review odd links without a separate analyze click.

**Acceptance Criteria:**

**Given** I open Graph
**When** Insights render
**Then** Surprising Connections appear without an analyze click (FR-20, FR-48)
**And** cards are ranked by composite surprise (cross-Community, cross-type, peripheral-hub)
**And** each card names the Pages/edge and class

**Given** I dismiss a connection
**When** I reopen Graph
**Then** it stays dismissed until structure changes enough to be a new Insight
**And** dismissals persist in the kernel (FR-8)

### Story 5.6: Knowledge Gaps

As Christian,
I want isolated, sparse, and bridge Insights,
so that I can see where the wiki is thin.

**Acceptance Criteria:**

**Given** Graph Insights are showing
**When** gaps are computed
**Then** degree ≤ 1 Pages appear as isolated (FR-49)
**And** Communities with Cohesion < 0.15 and ≥ 3 Pages appear as sparse
**And** a 2-page low-cohesion group does not
**And** Pages linking 3+ Communities appear as bridges
**And** isolated, sparse, and bridge cards include a Deep Research button
**And** Surprising Connection cards do not require that button
**And** Lint may point at these Insights and must not invent a second gap product (FR-21)

### Story 5.7: Insight highlight and Deep Research entry

As Christian,
I want an Insight click to highlight the graph and offer confirmed Deep Research,
so that I can inspect a gap before anything searches the web.

**Acceptance Criteria:**

**Given** an Insight card
**When** I click it
**Then** corresponding nodes/edges highlight; click again deselects (FR-50)

**Given** I click Deep Research on a gap or bridge
**When** the confirm dialog opens
**Then** topic and queries are editable and prefilled from `overview.md`, `purpose.md`, and the Insight Pages
**And** ≥1 query is required to confirm
**And** Cancel starts no research
**And** Confirm opens Deep Research mode with topic and queries filled (FR-24); this story does not run the web search

### Story 5.8: Lint report

As Christian,
I want a Lint report with links to Pages,
so that I can see contradictions, orphans, and broken links.

**Acceptance Criteria:**

**Given** Lint is idle
**When** the mode opens
**Then** copy is the EXPERIENCE.md idle state and semantic toggle is off by default (FR-21, UX-DR15)

**Given** I run Lint
**When** the report renders
**Then** it lists disputed Pages, broken wikilinks (with source Page), stale/expired, duplicates, and orphans (excluding bookkeeping)
**And** each issue links to the Page
**And** suggested gaps point at Graph Insights, not a second gap list
**And** `disputed: true` is visible and not auto-cleared

### Story 5.9: Mechanical auto-fix

As Christian,
I want auto-fix only for mechanical link/index drift,
so that disputed claims stay human.

**Acceptance Criteria:**

**Given** Lint finds renamed-slug wikilinks, dangling `[[slug]]` after delete, or `index.md` drift
**When** I apply auto-fix
**Then** those classes are fixed through the lifecycle write path (FR-22)
**And** the fix is recorded in Page history
**And** `disputed` is not cleared

**Given** any other issue class
**When** I view the row
**Then** there is no auto-fix button

### Story 5.10: Review queue

As Christian,
I want a Review queue with only Create Page, Deep Research, and Skip,
so that Ingest never waits on me and the model cannot invent buttons.

**Acceptance Criteria:**

**Given** Ingest persisted Review items (2.6)
**When** I open Review
**Then** cards show warning vs lightbulb, paths as `wiki/…md`, and only Deep Research · Create Page · Skip (FR-23, UX-DR11)
**And** the rail badge shows pending count when non-zero
**And** empty Review hides the badge and shows no pending cards
**And** Ingest can show succeeded while Review still has items

**Given** Skip
**When** I take the action
**Then** the item dismisses with no Wiki writes

**Given** Create Page
**When** I take the action
**Then** a constrained Page-create/Ingest path runs, not a free editor

**Given** Deep Research
**When** the confirm dialog opens
**Then** it prefills ingest-time stored queries (editable)
**And** Cancel starts nothing
**And** Confirm opens Deep Research mode with those queries filled; this story does not run the web search

**Given** the model proposed some other action
**When** the card renders
**Then** that action is dropped or mapped to Skip — no custom button
**And** pending items persist across restart (FR-8)

## Epic 6: Deep Research

Confirmed multi-query web research (Tavily default), Research Panel, auto-Ingest, max 3 concurrent.

### Story 6.1: Configure Deep Research providers

As Christian,
I want Tavily as the default Deep Research provider, with SerpApi and SearXNG selectable,
so that web fetch uses one configured provider and never silently switches.

**Acceptance Criteria:**

**Given** I open Settings → External Information Sources (or equivalent DR keys pane)
**When** the form loads
**Then** the active provider is Tavily out of the box (FR-67, AD-18)
**And** SerpApi and SearXNG are selectable; only one is active
**And** Tavily and SerpApi each have independent API keys
**And** SerpApi exposes selectable engines
**And** SearXNG uses a configured instance URL and search categories
**And** unused keys may still be stored
**And** changes apply only after Save (UX-DR14)

**Given** the selected provider is missing credentials
**When** a research task would fetch
**Then** it fails visibly
**And** it does not fall back to another provider

### Story 6.2: Confirm topic and queries before start

As Christian,
I want to edit topic and queries before any search runs,
so that unconfirmed bulk research never starts.

**Acceptance Criteria:**

**Given** I start Deep Research from the rail, a Review item, or a Graph Insight
**When** the confirm dialog opens
**Then** topic and the query list are editable (FR-24, NFR-8)
**And** at least one query is required
**And** Cancel or dismiss starts no search and no Ingest

**Given** start is from Review
**When** the dialog opens
**Then** queries are the ingest-time set (still editable)

**Given** start is from a Knowledge Gap or Bridge Insight
**When** the dialog opens
**Then** topic/queries come from `overview.md` + `purpose.md` plus the Insight Pages (FR-50)

**Given** start is from Deep Research mode directly
**When** the dialog opens
**Then** I can enter topic and queries from scratch
**And** empty copy beforehand is “No research tasks yet. Enter a topic above or click Deep Research in Review.”

### Story 6.3: Research Panel streams progress

As Christian,
I want a Research Panel that streams queries, fetches, and synthesis,
so that I can watch Deep Research without leaving the Workbench.

**Acceptance Criteria:**

**Given** I confirm a task
**When** it starts
**Then** the Research Panel opens/reveals without leaving the Workbench (FR-68, UX-DR17)
**And** height grows with content
**And** progress for queries, fetches, and synthesis streams
**And** fetched text is passed to synthesis without an app-imposed truncation cap (FR-67)

**Given** more than one task is running
**When** I look at the panel
**Then** tasks are distinguishable

### Story 6.4: Own queue, max 3 concurrent

As Christian,
I want Deep Research on its own queue, capped at three,
so that it does not block serial Ingest and a fourth start waits instead of dropping.

**Acceptance Criteria:**

**Given** three Deep Research tasks are running
**When** I confirm a fourth
**Then** it waits until a slot frees — it is not silently dropped (FR-70)
**And** this queue is independent of the serial Ingest LLM queue (FR-39)

**Given** the app restarts
**When** I reopen Deep Research
**Then** tasks are still pending, running, or failed (FR-8)

### Story 6.5: Research Page, thinking, auto-Ingest

As Christian,
I want a successful run to write a research Page and auto-Ingest it,
so that findings join the compiled wiki.

**Acceptance Criteria:**

**Given** synthesis succeeds
**When** the run completes
**Then** a research Page is written with `[[wikilinks]]` to existing Pages where relevant (FR-69)
**And** two-step Ingest is queued (Activity shows those jobs)
**And** writes go through `writeWikiPageWithSideEffects`

**Given** synthesis emits Thinking
**When** it streams
**Then** thinking is collapsible and distinct from the Page body
**And** the viewport follows the newest thinking line
**And** `prefers-reduced-motion` is honored

**Given** synthesis fails
**When** the task ends
**Then** it does not auto-Ingest a partial result as success
**And** Chat `mode: deep` still does not drive this panel

## Epic 7: Any document in

Sidecar extract for office/PDF/EPUB, inbound email, Plaud OAuth, media preview, Mermaid/KaTeX.

### Story 7.1: Sidecar claims kernel extract jobs

As Christian,
I want binaries stored in the kernel and extracted by the sidecar,
so that email, Plaud, API, and drag-drop share one vault.

**Acceptance Criteria:**

**Given** a Source needs extract (PDF/office/ebook)
**When** bytes are saved via `saveRawSource`
**Then** the kernel enqueues an extract job (AD-24)
**And** the sidecar claims it, writes extracted text back through kernel HTTP
**And** two-step Ingest runs only after text is in the kernel (AD-4)
**And** there is no second vault on sidecar disk except extract temp

**Given** the sidecar is down
**When** I drop a PDF
**Then** extract is unavailable (fail closed, same as Chat)
**And** Source bytes remain in the kernel
**And** Activity shows the extract/pending failure, not a silent drop (FR-32)

### Story 7.2: PDF extract, cache, and MinerU

As Christian,
I want PDFs extracted with a parse cache, and MinerU off unless I enable Local API,
so that complex layouts are optional and PDFs do not leave the machine by default.

**Acceptance Criteria:**

**Given** I upload a PDF and the sidecar is up
**When** extract runs
**Then** pdf-extract 0.12.0 produces text/layout (AD-16, FR-71)
**And** identical SHA256 uses the parse cache and does not re-parse (FR-10)
**And** Ingest proceeds on the extracted text

**Given** MinerU is off (default)
**When** a complex layout fails
**Then** the failure is visible
**And** built-in extract still ran (AD-19)

**Given** I enable MinerU in Settings
**When** I save
**Then** the first mode is Local API, not Cloud
**And** a Cloud choice shows the warning callout (UX-DR14)
**And** Settings → MinerU PDF is the pane (UX-DR18)

### Story 7.3: DOCX, PPTX, and spreadsheet extract

As Christian,
I want Word, slides, and sheets as structured Markdown,
so that Ingest sees headings, slides, and tables instead of a blob.

**Acceptance Criteria:**

**Given** a DOCX with Heading 1, a list, and a table
**When** extract runs (docx-rs 0.4.22)
**Then** Markdown still has a heading, a list, and a table (FR-71)

**Given** a PPTX
**When** extract runs (ZIP+XML)
**Then** output is slide-by-slide with heading/list structure
**And** the Source summary can be navigated by slide

**Given** an XLSX/XLS/ODS workbook (calamine 0.36.1)
**When** extract runs
**Then** cell types are preserved, all sheets are included, and output is Markdown tables
**And** there is no in-app spreadsheet editor

### Story 7.4: EPUB/MOBI extract

As Christian,
I want ebook files ingested as chapters,
so that reading notes compile from the book, not a dump.

**Acceptance Criteria:**

**Given** an EPUB or MOBI
**When** extract runs
**Then** metadata, chapters, and body become ingest-ready text (FR-71, FR-32)
**And** arrival auto-queues two-step Ingest
**And** unsupported/corrupt files fail visibly

### Story 7.5: Inbound email Intake

As Christian,
I want an inbound address I control,
so that a forwarded transcript becomes Sources without a mail client.

**Acceptance Criteria:**

**Given** email arrives at the inbound address
**When** Intake runs
**Then** message and/or attachments become Sources with provenance: from, received time, subject (FR-41)
**And** they auto-queue Ingest (extract jobs if binary)
**And** this is not a connected mailbox and not a general email client

**Given** Settings → Intake
**When** I view the pane
**Then** Intake replaces Source Folder Auto Watch
**And** there is no OS folder-watch

### Story 7.6: Plaud OAuth list and pull

As Christian,
I want to pick a Plaud recording in-app and pull it,
so that I am not limited to file upload.

**Acceptance Criteria:**

**Given** Plaud OAuth is connected
**When** I select a recording and pull
**Then** transcript and/or summary land as Sources and auto-queue Ingest (FR-31)
**And** they carry Plaud-origin provenance (FR-26 still applies)

**Given** auth fails or the pull is incomplete
**When** the attempt ends
**Then** it fails closed
**And** there are no partial Wiki Page writes from that pull

### Story 7.7: Image lightbox and AV player

As Christian,
I want images in Preview/Search and audio/video in-pane,
so that media is usable without leaving the Workbench.

**Acceptance Criteria:**

**Given** I open a png/jpg/gif/webp/svg (or other browser-renderable image)
**When** Preview shows
**Then** I see the image, not only a filename (FR-72)
**And** click opens a lightbox; jump-to-source opens the containing Page or Source
**And** Esc closes the lightbox (UX-DR16)

**Given** Search hits include images (`wiki/media/`, `raw/assets/`, or `![]()`)
**When** results render
**Then** an image section appears (FR-18 remainder)

**Given** I select a video or audio Source
**When** Preview shows
**Then** it plays in-pane
**And** player failure does not delete the Source
**And** media still Ingests (transcript/description as the pipeline allows)

### Story 7.8: Mermaid and KaTeX in Preview

As Christian,
I want diagrams and math to render in Preview and Chat,
so that those fences are not raw dumps.

**Acceptance Criteria:**

**Given** a Page or Chat message with a ` ```mermaid ` fence
**When** it renders
**Then** it shows as a diagram, not a code dump (FR-73)

**Given** inline `$…$` or block `$$…$$` math
**When** it renders
**Then** KaTeX renders it, not leftover TeX
**And** GFM tables and wikilinks from 1.5 still work
**And** Chat answers stay SF/system sans; Preview body stays Georgia

## Epic 8: Agents at the door

Loopback API/MCP, llm-wiki skill, in-app Skills, approved shell, Settings → API + MCP.

### Story 8.1: Enable loopback API and token

As Christian,
I want to turn on the local API in Settings, generate a token, and bind loopback only,
so that agents on this machine can talk to the wiki and nothing on the LAN can.

**Acceptance Criteria:**

**Given** I open Settings → API + MCP
**When** I enable the API and generate a token
**Then** the sidecar binds `127.0.0.1:19828` only — not `0.0.0.0`, LAN, or Clip-server 19827 (FR-36)
**And** I can allow or deny local unauthenticated access
**And** `LLM_WIKI_API_TOKEN` overrides the UI token (`tokenSource: env`)
**And** an unauthenticated-API warning callout shows when unauth is on (UX-DR14)

**Given** the API is off
**When** a caller hits a data route
**Then** it returns 503 `"disabled"`
**And** `/health` still works with `enabled: false`

**Given** the API is on and unauth is off
**When** a data route has a missing/wrong token
**Then** it returns 401
**And** accepted send methods are `Authorization: Bearer`, `X-LLM-Wiki-Token`, or `?token=` last resort (never echoed)

**Given** another process owns 19828
**When** `/health` runs
**Then** `status` is `port_conflict`

### Story 8.2: Full `/api/v1` surface

As Christian,
I want the nashsu `/api/v1` routes on loopback, proxied to the kernel except Chat/extract/shell,
so that scripts and skills use one contract.

**Acceptance Criteria:**

**Given** the sidecar is up
**When** a client calls the FR-76 table
**Then** `GET` health, projects, files, files/content, reviews, graph
**And** `PATCH`/`POST` reviews, `POST` search, chat, sources/rescan
**And** field names match the PRD table
**And** kernel implements wiki read/search/graph/reviews/rescan/files; sidecar reverse-proxies those; sidecar owns Chat, extract, shell/Skills, health, MCP wrap (AD-22)

**Given** `{id}`
**When** it is `current` or a Wiki UUID
**Then** it resolves
**And** a filesystem path is loopback-only; cloud never accepts a path
**And** spoken names are not `{id}`

**Given** file reads
**When** the path is out of scope, binary, or oversize
**Then** 403 / 415 / 413 as specified
**And** body > 1 MiB → 400; tree > 10000 → 413; search `topK` clamped to 50; graph `limit` to 1000; 120 req/sec → 429

### Story 8.3: MCP and copyable config

As Christian,
I want MCP on the same loopback surface with a copyable client config,
so that I can paste it into Claude Code without writing glue.

**Acceptance Criteria:**

**Given** Settings → API + MCP
**When** I copy the MCP config
**Then** it is valid for a local client on this machine (FR-78)
**And** MCP tools list projects, read files, export unresolved Reviews, hybrid search, inspect the wikilink graph, rescan, and call Agent chat
**And** MCP uses the same token / loopback rules as FR-36
**And** stock skill/MCP is read-only except rescan; write MCP is owner-auth only and not part of the stock skill (AD-8)

### Story 8.4: work-wiki Agent Skill

As Christian,
I want a branded llm-wiki skill that probes health then talks HTTP,
so that an external agent can use the wiki without an SDK.

**Acceptance Criteria:**

**Given** the work-wiki-branded skill is installed
**When** an agent starts
**Then** it probes `GET /api/v1/health` first (FR-79)
**And** if `authConfigured: false` and `allowUnauthenticated: false`, it tells me to generate a token and does not proceed
**And** if the sidecar is down, it reports connection refused
**And** `port_conflict` tells me another process owns 19828

**Given** a lookup turn
**When** the skill runs
**Then** it resolves project → `POST .../search` → cites paths → synthesizes
**And** it does not fabricate if results are empty
**And** default project is `current`; it names the active Wiki once
**And** stock nashsu skill must not `POST /chat`; the branded skill may document FR-77
**And** Settings shows the install command

### Story 8.5: Tool-using Agent

As Christian,
I want the sidecar Agent to pick wiki, source, graph, web, and AnyTXT tools,
so that Chat can look things up without me choosing the tool.

**Acceptance Criteria:**

**Given** a question that needs the wiki
**When** the Agent runs a turn
**Then** it can call wiki search without me picking the tool (FR-61)
**And** tool-call-row shows name + outcome (UX-DR8)
**And** at least one golden Chat turn records a wiki-search tool call (FR-60)

**Given** graph search
**When** the Agent uses it
**Then** it can use 4-signal / Community data from Epic 5
**And** web search mid-turn is not unconfirmed Deep Research (FR-24 still required for bulk DR)

**Given** AnyTXT
**When** the Agent searches Sources
**Then** it is full-text over `raw/sources/`
**And** Skill file reads only see enabled Skills

**Given** composer tools
**When** Chat is open
**Then** Attach · Web search · AnyTXT · Smart retrieval are available (UX-DR6)

### Story 8.6: Skill scan, enable, `/skill`

As Christian,
I want project and user Skill folders scanned, with enable/disable and `/skill` per Conversation,
so that I pick which Skills the Agent may use.

**Acceptance Criteria:**

**Given** `SKILL.md` files in project and user folders
**When** Settings or Workbench loads
**Then** they are scanned without a reinstall (FR-62)
**And** Skills mode lists them (rail icon from Epic 1)

**Given** I disable a Skill
**When** I type `/skill`
**Then** it does not appear in completion and is not injected
**And** `/skill` completes enabled names only (UX-DR20)
**And** the selected Skill is stored on the Conversation (FR-58)
**And** a fixture `SKILL.md` can be enabled and selected with `/skill`
**And** composer Skills sits with the other Chat tools (UX-DR6)

### Story 8.7: Skill forms

As Christian,
I want Skills to ask single/multi/free-text questions in one form renderer,
so that Chat waits for me instead of guessing.

**Acceptance Criteria:**

**Given** a Skill requests structured input
**When** the form shows
**Then** it supports single choice, multiple choice, or free text (FR-64)
**And** two different Skills use the same renderer
**And** Chat does not run the next tool step until submit or cancel

**Given** I Cancel
**When** the form closes
**Then** the Conversation stays intact
**And** the pending tool does not run
**And** Esc closes the form (UX-DR20)

### Story 8.8: Agent workspace outputs

As Christian,
I want Agent-created files under `agent-workspace/` previewable from Chat,
so that tool output is a file I can open, not a paste.

**Acceptance Criteria:**

**Given** a tool creates a file
**When** the turn finishes
**Then** it lives under `agent-workspace/` and shows as an output chip on the message (FR-63)
**And** Preview can open it without leaving the Workbench
**And** outputs survive restart with the Conversation
**And** sidecar disk for these files is allowed; wiki bytes still go through the kernel (AD-2)

### Story 8.9: Safer shell Approve/Deny

As Christian,
I want workspace commands to run and external commands to wait for Approve,
so that the Agent cannot shell the rest of the machine by default.

**Acceptance Criteria:**

**Given** a command whose cwd/target is inside the Wiki/project workspace
**When** the Agent requests it
**Then** it may run without a modal (FR-65)

**Given** a command targeting outside that workspace or a new executable path
**When** it is requested
**Then** Approve / Deny is shown per command (UX-DR8)
**And** Deny means it does not run
**And** there is no blanket allow-all default (NFR-8)
**And** Esc closes the approval UI without running the command
