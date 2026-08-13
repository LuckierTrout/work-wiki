---
title: work-wiki
status: final
created: 2026-08-12
updated: 2026-08-12
---

# PRD: work-wiki

*Personal compiled wiki — Karpathy LLM Wiki pattern, nashsu/llm_wiki functional parity on the web, plus meeting Todos.*

## 0. Document Purpose

This PRD is for Christian (builder and sole v1 user) and for downstream UX, architecture, and epic work. It specifies **what** the product must do, not how it is hosted. Vocabulary is locked in §3 Glossary; features are grouped with globally numbered FRs; inferences are tagged `[ASSUMPTION]` and indexed in §9.

Inputs: `work-wiki-concept.md`, `PRODUCT.md`, Karpathy LLM Wiki pattern, [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) as the UX/functionality parity target, and Discovery answers (web, solo, Plaud + office docs, HITL Todos). Concept-doc **commons / public lab** positioning is **not** v1 — see Non-Goals and `addendum.md`.

## 1. Vision

work-wiki is a **personal compiled knowledge base**. You drop in meeting recordings, documents, and URLs. An LLM **integrates** them into a persistent, interlinked wiki — concept Pages, citations, a catalog, a chronology — and **keeps that wiki current** as new Sources arrive. You then chat with the wiki, browse it, and act on work that fell out of meetings.

This is not RAG. RAG re-derives an answer from raw chunks every time you ask. work-wiki **compiles once and maintains**: knowledge compounds across Ingests; contradictions stay visible; a good Chat answer can be filed back as a Page.

The interaction model mirrors **nashsu/llm_wiki** on the web: icon sidebar, three columns (Knowledge Tree / File Tree | Chat | Preview), drag-to-resize with min/max, a file-by-file Activity panel, durable Conversations/Settings/Review/project config, and Scenario Templates that seed `purpose.md` + Schema. Search, Graph, Lint, Review, Deep Research, and Capture sit in that shell — not as separate apps. On top of that parity, meeting Ingests produce **Todo Candidates** you approve or reject, with due dates and links back to the meeting Source and Page.

v1 exists so Christian can trust it at work: after a Plaud meeting, the wiki and the Todo list are the system of record — not a pile of transcripts and a fading memory.

**Voice:** UI and generated wiki copy stay **precise, evidence-rich, and unsentimental** — short, direct, no overclaim. This is a working lab, not a magazine and not a generic AI landing page.

## 2. Target User

### 2.1 Jobs To Be Done

- **Functional:** After a meeting or a document dump, have a current wiki I can ask and browse — without re-reading the transcript or re-prompting from scratch.
- **Functional:** Never lose an action item the meeting implied; decide explicitly which proposed Todos are real.
- **Functional:** Point at a decision months later and see the cited Source, not a vibes-based recap.
- **Emotional:** Trust that job-critical knowledge is private, cited, and not silently overwritten.
- **Contextual:** Use this from a browser during and after the workday; one operator; Wikis created from Scenario Templates.

### 2.2 Non-Users (v1)

- Colleagues, teammates, or a public audience (no shared commons, no observer lab).
- People who want a chatbot over a folder with no persistent wiki.
- Multi-tenant SaaS customers, waitlist signups, or Twitter/X-identity communities.

### 2.3 Key User Journeys

- **UJ-1. Christian turns a Plaud meeting into wiki + Todos before the next call.**
  - **Persona + context:** Christian, using this as a job tool; just finished a meeting captured in Plaud (transcript + summary).
  - **Entry state:** Signed in; Workbench open on his private Wiki.
  - **Path:** He **uploads** transcript+summary (P0) or pulls via Plaud OAuth (P1), or uses email/folder. Arrival auto-queues Ingest; Activity shows Analysis then Generation. Pages compile (meeting Source summary, related concepts, index/log/overview). The Todo list shows Candidates with suggested due dates and links to the meeting.
  - **Climax:** He approves the real actions, rejects the rest; each approved Todo still links back to the transcript/Page.
  - **Resolution:** Wiki is updated; open Todos are his working list. **Edge case:** Ingest fails — Source is still stored; queue shows failed with retry; no Todos invented from a failed compile.

- **UJ-2. Christian asks the wiki, not the raw pile.**
  - **Persona + context:** He needs “what did we decide about X?” mid-week.
  - **Entry state:** Signed in; Chat is the center column.
  - **Path:** He asks in an existing or new Conversation (sidebar switch). The answer cites Pages as `[n]` and a collapsible references panel lists the Pages used. He opens a citation in Preview.
  - **Climax:** He can act from the cited Page without re-opening Plaud. Optionally **Save to Wiki** (`wiki/queries/`) so the answer is auto-Ingested into the network.
  - **Resolution:** Conversation is kept. **Edge case:** Wiki has no coverage — Chat says so and offers Ingest or Deep Research rather than hallucinating.

- **UJ-3. Christian dumps a deck or doc and it lands as knowledge, not a file graveyard.**
  - **Persona + context:** A PPT, Word, Excel, PDF, or URL just showed up in the job.
  - **Entry state:** Workbench; Ingest/Sources mode or drag onto the shell.
  - **Path:** File, folder, or URL enters the serial Ingest queue. Activity shows Analysis then Generation per file. Related concept Pages and a Source summary update; `overview.md` regenerates; Source remains immutable.
  - **Climax:** Preview shows the new/updated Page with YAML `sources: []` pointing at the file/URL.
  - **Resolution:** Search and Chat can use it. **Edge case:** Same SHA256 skips LLM; a failed file auto-retries up to 3 times then sits failed with retry.

- **UJ-4. Christian checks the wiki’s health when something feels off.**
  - **Persona + context:** A Page looks stale or two meetings disagree.
  - **Path:** Lint lists issues. Graph Insights show Surprising Connections and Knowledge Gaps; clicking a card highlights nodes/edges. He can dismiss a connection or confirm Deep Research (editable topic) for a gap or Bridge node.
  - **Climax:** He can see *why* a claim is disputed and which clusters are weakly linked or held together by one Page.
  - **Resolution:** He triggers a fix or Deep Research; he does not hand-rewrite the whole wiki.

- **UJ-5. Christian works the Todo list as the meeting aftermath.**
  - **Persona + context:** Morning; several approved Todos due this week.
  - **Path:** Todo surface: filter by due/status; open link to meeting Page/transcript; mark complete.
  - **Climax:** Nothing important from last week’s Plaud notes is only in his head.
  - **Resolution:** Completed Todos stay inspectable with original links. **Edge case:** Rejected Candidates never become Todos and do not clutter the working list.

- **UJ-6. Christian asks Claude Code / Codex against the same wiki.**
  - **Persona + context:** He is in a coding agent and wants the wiki, not a guess.
  - **Entry state:** Workbench (or local sidecar) running; API enabled; token set.
  - **Path:** Agent Skill pack installed; he names “my wiki.” The agent probes health, searches, reads cited paths.
  - **Climax:** The answer cites wiki page paths he can open in Preview.
  - **Resolution:** Read-only except rescan. **Edge case:** App/sidecar not running → connection refused, not a hallucinated wiki.

## 3. Glossary

- **Wiki** — Christian’s private compiled knowledge base: markdown Pages with wikilinks and frontmatter. One operator; each Wiki is a named project created from a Scenario Template. HTTP `{id}` may say **project**; Obsidian export may say **vault** — same Wiki.
- **Source** — An immutable raw input (Plaud transcript/summary, file, URL, pasted text, clip). Never overwritten by compile.
- **Page** — One wiki document (concept, entity, source-summary, query write-back, index, log, overview). Identified by slug; may accumulate many Sources.
- **Ingest** — The compile operation: two sequential LLM calls (Analysis, then Generation) that update Pages, Index, Log, Overview, Review items, and Todo Candidates when applicable.
- **Ingest Analysis** — Structured output of Ingest step 1: entities, concepts, arguments, connections to existing Pages, contradictions/tensions, and recommended wiki structure. Input to Generation; not a user-facing Page unless filed.
- **Source summary** — A Page that summarizes one Source, with frontmatter `type`, `title`, and `sources: []`. Always created for a successful Ingest (system fallback if the LLM omits it).
- **Overview** — Global summary Page (`overview.md`) regenerated on every successful Ingest.
- **Workbench** — The primary web shell: icon sidebar, three columns (Knowledge Tree or File Tree | Chat | Preview), plus an Activity panel.
- **Knowledge Tree** — Left-column browse of Pages by wiki structure (concepts/entities/types), not raw files.
- **File Tree** — Left-column browse of the Wiki’s files (Pages, Sources, purpose/Schema) as a tree.
- **Activity panel** — Queue visualization: progress bar plus per-file pending / processing / succeeded / failed with cancel and retry.
- **Scenario Template** — A named starter (Research, Reading, Personal Growth, Business, General) that pre-configures `purpose.md` and Schema for a new Wiki.
- **Chat** — Query against the Wiki via a backend Agent runtime (not a browser-only loop). Multi-Conversation. Center column — not an icon-sidebar mode.
- **Skill** — An in-app Agent instruction pack (`SKILL.md` in project or user Skill folders). Enable/disable globally; pick per Conversation with `/skill`.
- **Agent Skill pack** — The installable **llm-wiki** documentation skill (FR-79) that calls the local HTTP API from Claude Code / Codex. Not the same object as an in-app Skill.
- **Agent workspace** — Directory `agent-workspace/` for files the Agent generates; previewable from Chat.
- **Conversation** — An independent, named Chat session. Create, rename, delete, switch via sidebar. Persisted per id (nashsu layout: `.llm-wiki/chats/{id}.json`).
- **Thinking block** — Model-emitted reasoning (e.g. `<think>…</think>` from DeepSeek, QwQ). Shown separately from the answer; not cited as Wiki content.
- **Preview** — The right-hand **view-first** rendering of the selected Page. Owner markdown edit is an explicit escape hatch (confirm); Ingest may overwrite on the next compile. Not WYSIWYG in v1.
- **Lint** — Health check over the Wiki (contradictions, orphans, staleness, broken links, gaps).
- **Review item** — An async HITL card from Ingest. Allowed actions only: **Create Page**, **Deep Research**, **Skip**. Carries ingest-time search queries. Does not block Ingest. HTTP Review routes mutate these same items (`action` is one of those three; Skip = resolved).
- **Deep Research** — Confirmed multi-query web research (Tavily / SerpApi / SearXNG) that extracts full source content, synthesizes a research Page, and auto-Ingests. Shown in the Research Panel. Does not block Ingest.
- **Todo Candidate** — An LLM-proposed action item from a Source (typically a meeting), awaiting approve or reject. Not a Todo until approved.
- **Todo** — An approved Candidate: title, optional due date, status, and links to the originating Source and/or Page.
- **Schema** — Executable conventions that steer Ingest, Chat, Lint, and Todo extraction (`schema.md` / page conventions).
- **Index** — Catalog Page (`index.md`) of the Wiki.
- **Log** — Append-only chronology Page (`log.md`).
- **Intake** — A path that delivers a Source into the Wiki: Workbench upload, folder import, email, direct connect (e.g. Plaud), or API/MCP. Arrival always queues Ingest — no second “process this” click.
- **Capture** — Saving a web page or clip into Ingest (bookmarklet/share/clipper-equivalent); an Intake path.
- **Retrieval pipeline** — The multi-phase path that fills Chat/Search context: tokenized search → optional vector search → graph expansion → budget control → context assembly.
- **Relevance** — A numeric score between two Pages from the 4-signal model (direct wikilink, source overlap, Adamic-Adar, type affinity).
- **Community** — A knowledge cluster of Pages discovered automatically from link topology (Louvain), independent of page type. Used as a Graph coloring mode.
- **Cohesion** — Intra-edge density of a Community: actual edges among members / possible edges among members. Below **0.15** is low-cohesion and must be flagged.
- **Insight** — An auto-generated Graph card: a Surprising Connection or a Knowledge Gap (isolated Page, sparse Community, or Bridge node).
- **Surprising Connection** — An unexpected relationship ranked by a composite surprise score: cross-Community edges, cross-type links, or peripheral↔hub couplings.
- **Bridge node** — A Page whose links connect **3 or more** Communities.

## 4. Features

### 4.1 Personal Wiki substrate

**Description:** v1 is a **single-operator** private Wiki (one or more named projects). All Pages and Sources are owner-only. Agents maintain Pages via Ingest; Christian curates Sources, Chats, Reviews, and Todos. Realizes UJ-1–UJ-4. `[ASSUMPTION: existing Clerk sign-in is enough; no new identity provider.]`

**Functional Requirements:**

#### FR-1: Private-by-default Wiki

Christian’s Wiki, Sources, Chats, Todos, and Review items are readable and writable only by his authenticated session (and his own agent credentials). Realizes UJ-1.

**Consequences (testable):**
- Unauthenticated requests to Wiki/Chat/Ingest/Todo APIs receive 401.
- No public listing, public graph, or public query over his Pages. Existing commons/public browse, waitlist, billing, clone-to-private, and talk/discussion routes are **off or 404** for this product.
- Write-capable MCP tools in the fork are **owner-auth only** and are **not** part of the nashsu Agent Skill pack (FR-79 remains read-only except rescan).
- A missed UI check cannot leak another tenant’s objects `[ASSUMPTION: keep per-owner storage isolation already in the fork]`.

#### FR-2: Immutable Sources, compiled Pages

Ingest never mutates the stored Source bytes/text. Pages may be re-synthesized; lineage and `sources[]` remain. Realizes UJ-3.

**Consequences (testable):**
- Re-fetching a Source after Ingest returns the original payload.
- Every generated or updated Page includes YAML frontmatter `sources: []` listing the raw Source files/URLs that contributed to it.
- A Page with no contributing Source is a defect (except purpose/Schema/Index/Log/Overview bookkeeping Pages, which cite Ingest events in Log instead).

#### FR-3: Accumulate, don’t overwrite

When a new Source maps to an existing concept, Ingest merges into that Page. Contradictions set a visible disputed state rather than silently picking a side. Realizes UJ-4.

**Consequences (testable):**
- Two Sources about the same concept yield one Page with both in `sources[]`.
- A contradictory claim sets frontmatter **`disputed: true`**, remains visible in Preview and Lint, and is **not** cleared by mechanical auto-fix (FR-22). A later Ingest or Review that reconciles the claim may clear it.

### 4.2 Workbench shell (nashsu parity)

**Description:** The product *feels* like nashsu/llm_wiki: icon sidebar, three columns (Knowledge Tree / File Tree | Chat | Preview), drag-to-resize with min/max, Activity panel with file-by-file progress, and durable Workbench state. Chat is the default center of gravity — not a separate “Ask” page. Realizes UJ-2, UJ-3.

**Functional Requirements:**

#### FR-4: Icon-mode navigation

A vertical icon sidebar switches modes without leaving the Workbench frame. Required modes: **Wiki, Sources, Search, Graph, Lint, Review, Deep Research, Settings**. **Todos** is an additional icon (job feature, not in nashsu). Realizes UJ-2, UJ-4, UJ-5.

**Consequences (testable):**
- Each listed mode is reachable in one click from the icon sidebar.
- Mode switch does not destroy the active Conversation or unsaved Chat input.
- The eight nashsu modes above are always present; Todos does not replace Settings or Review.

#### FR-5: Three-column Workbench

Left: **Knowledge Tree** and **File Tree** (user can switch which tree is shown). Center: **Chat**. Right: **Preview**. Realizes UJ-2.

**Consequences (testable):**
- Selecting a Knowledge Tree or File Tree item updates Preview (**view-first**). Owner markdown edit is a confirm-gated escape hatch; next Ingest may overwrite. v1 is not Milkdown WYSIWYG.
- Opening a Chat citation selects that Page in Preview.
- Knowledge Tree and File Tree are distinct views, not a single unlabeled list.
- The left Knowledge/Files navigation can **collapse** to give Chat more width; collapsed/expanded state and scroll/selection **persist** across collapse and reload (FR-8).

#### FR-6: Drag-to-resize panels

Christian can drag to resize the left and right columns. Widths have minimum and maximum constraints so Chat cannot be crushed to unusable and trees/Preview cannot consume the whole frame. Realizes UJ-2.

**Consequences (testable):**
- Dragging a splitter changes that column’s width continuously until min or max.
- **Min widths:** Chat ≥ **320px**; Knowledge/File Tree and Preview ≥ **200px** each. At min the splitter stops; Chat input stays visible.
- Panel widths persist across reload.

#### FR-7: Activity panel (file-by-file)

An Activity panel visualizes the Ingest queue: progress bar, and per-file rows for pending / processing (Analysis vs Generation) / succeeded / failed, each with cancel and retry. Realizes UJ-1, UJ-3.

**Consequences (testable):**
- A batch of N files shows N rows; each row updates without a full-page refresh.
- A progress bar reflects queue depth and the active file’s step (Analysis vs Generation).
- Failed rows expose an error and a retry control; retry does not duplicate the Source record.
- Cancel stops work that has not committed Page writes `[ASSUMPTION: in-flight LLM calls may still complete server-side but must not commit if cancelled]`.

#### FR-8: Durable Workbench state

Conversations, Settings, Review items, and project config survive browser reload, re-login, and app/server restart. Persisted Settings include **LLM provider, API key, model, context size, and language** (English). Realizes UJ-2, UJ-4.

**Consequences (testable):**
- After reload or a new session, the same Conversations, Review items, and Settings are present — including provider, model, context slider, and language.
- Project config is not stored only in the tab; a second browser session for the same account sees it.
- Ingest queue durability is included (no silent loss on restart) — validates SM-3.
- `[ASSUMPTION: nashsu uses Tauri Store; this web app persists the same fields server-side (or equivalent durable store). See addendum.]`

#### FR-73: Markdown rendering

Chat and Preview render **GFM tables with borders**, **proper code blocks**, **wikilink processing** (`[[Page]]` navigates), **Mermaid diagrams**, and **KaTeX math**. Realizes UJ-2.

**Consequences (testable):**
- A GFM table in a Page shows as a bordered table in Preview and in Chat markdown.
- Fenced code blocks keep language styling / monospace, not inline mashed text.
- Clicking a `[[wikilink]]` in Chat or Preview opens that Page (or shows missing-link state).
- A ` ```mermaid ` fence renders as a diagram, not a raw code dump.
- Inline and block math (`$…$` / `$$…$$`) render via KaTeX, not as leftover TeX source.

#### FR-74: dataVersion signaling

When Wiki content changes, a **dataVersion** signal causes **Graph and UI to refresh automatically**. Realizes UJ-2, UJ-4.

**Consequences (testable):**
- After Ingest commits Pages, Graph, trees, and Preview do not stay stale until a full reload.
- Graph position cache (FR-46) still applies; refresh updates data without a random re-scatter.
- Multiple surfaces (Search, Index, Insights) pick up the new version without a manual refresh button as the only path.

### 4.3 Ingest and accumulation

**Description:** Dual Ingest: two sequential LLM calls (Analysis, then Generation) — not a single read-and-write. SHA256 skip cache, serial durable queue with retries, folder import, automatic processing on Intake arrival (upload, folder, email, direct connect), guaranteed Source summary, Overview on every Ingest, `sources: []` on Pages, optional auto-embed. Realizes UJ-1, UJ-3.

**Functional Requirements:**

#### FR-9: Two-step Chain-of-Thought Ingest

Ingest is **two sequential LLM calls**. The model must not read a Source and write Pages in one step. Realizes UJ-3, UJ-4.

**Step 1 — Analysis:** LLM reads the Source and produces a structured Ingest Analysis:
- Key entities, concepts, and arguments
- Connections to existing Wiki content
- Contradictions and tensions with existing knowledge
- Recommendations for wiki structure

**Step 2 — Generation:** LLM takes that Ingest Analysis (not a fresh unguided read) and generates Wiki files:
- Source summary with frontmatter (`type`, `title`, `sources: []`)
- Entity Pages and concept Pages with cross-references (`[[wikilinks]]`)
- Updated `index.md`, `log.md`, `overview.md`
- Review items for human judgment
- Search queries proposed for Deep Research
- Todo Candidates when the Source is a meeting (FR-26)

**Consequences (testable):**
- Activity shows Analysis completing before Generation starts for that Source.
- Generation is given the Analysis artifact; a Generation-only retry may reuse a successful Analysis `[ASSUMPTION: failed Generation does not re-pay for Analysis]`.
- A failure in Generation does not delete the stored Source or a completed Analysis.
- Successful Ingest **enqueues Review items** when human judgment is needed, each with **pre-generated search queries**, and **does not wait** for Christian to act (FR-23).

#### FR-10: SHA256 incremental cache

Source content is hashed with SHA256 before Ingest. Unchanged bytes are skipped automatically (no Analysis/Generation LLM calls). Realizes UJ-3.

**Consequences (testable):**
- Re-importing a file with the same SHA256 does not create a duplicate concept Page and does not call the Ingest LLM.
- Provenance records that the Source was seen again.
- A byte change (new hash) re-queues full two-step Ingest.

#### FR-11: Index, Log, Overview, guaranteed Source summary

Successful Ingest updates `index.md`, appends `log.md`, and **regenerates `overview.md`** to reflect the latest Wiki. A Source summary Page is **always** created, even if the LLM omits it (system fallback). Realizes UJ-2, UJ-3.

**Consequences (testable):**
- After Ingest, Index lists the new/updated Pages.
- Log has a new chronological entry pointing at the Source.
- `overview.md` content changes on every successful Ingest (not only the first).
- If Generation output lacks a Source summary, the system still writes one that cites the Source; Ingest is not “success” without it.

#### FR-12: Intelligent cascade deletion

Deleting a Source **always** removes its **Source summary** Page, then finds related Pages by **three matching methods** and either deletes or trims them. The same lifecycle runs whether delete started in-app or from an Intake path (FR-41). `[ASSUMPTION: in-app delete is confirm-gated.]` Realizes UJ-3.

**Matching (all three):**
1. Frontmatter `sources: []` contains the deleted Source
2. **Source summary page name** tied to that Source
3. Other YAML fields whose values are the deleted Source path or its Source-summary slug (e.g. `meeting`, `related`) — not body prose

**Consequences (testable):**
- After delete, the Source summary Page is gone.
- A Page found only via any of the three methods, and linked to **no other** Source, is deleted.
- A shared entity/concept Page linked to **multiple** Sources is **not** deleted; the deleted Source is **removed from `sources: []` only**.
- Deleted Pages are **purged from `index.md`**.
- Remaining Pages have **dead `[[wikilinks]]` to deleted Pages removed** (link text may remain as plain text or be dropped with the wikilink — no dangling `[[slug]]` to a missing Page).
- A Page that did not match any of the three methods is untouched.
- Todos linked to the deleted Source follow FR-29 (source-missing, not silent Todo delete).

#### FR-39: Persistent serial Ingest queue

Ingest runs **serially** (one Source’s LLM work at a time per Wiki) so Analysis/Generation calls do not overlap. The queue is durable and survives app/server restart. Failed tasks auto-retry up to **3** times, then stay failed in the Activity panel for manual retry. Realizes UJ-3, SM-3.

**Consequences (testable):**
- Two queued files do not run Generation concurrently on the same Wiki.
- After restart, pending/failed items are still in the queue (not lost).
- A failing Ingest is attempted at most 3 times automatically; a fourth attempt is only via explicit retry.
- Chat may still run while Ingest is queued `[ASSUMPTION: serial constraint applies to Ingest LLM calls, not Chat]`.

#### FR-40: Recursive folder import

Christian can import a folder tree. Directory structure is preserved under `raw/sources/`. The folder path is passed to the LLM as classification context (e.g. `papers > energy`). Realizes UJ-3.

**Consequences (testable):**
- Importing a nested folder creates Sources whose stored paths mirror the relative tree.
- Analysis/Generation receive the relative folder path as context.
- Each file is a separate queue item (FR-7, FR-39); SHA256 skip still applies.

#### FR-41: Automatic Ingest on arrival

When a Source **arrives** via any Intake path, it is stored under `raw/sources/` and **queued for two-step Ingest automatically** — Workbench upload, folder import, email, direct connect (Plaud and similar), or API/MCP. The same SHA256 skip, serial queue, Activity panel, and cascade-delete rules apply. Realizes UJ-1, UJ-3.

**Consequences (testable):**
- An upload, folder import, email attachment/body, or direct-connect pull appears in the Activity panel without a separate “Ingest” click.
- Unchanged SHA256 is skipped (FR-10); new/changed content runs Analysis then Generation.
- Removing a Source (in-app or via the Intake that owns it) runs FR-12 cleanup.
- Email Intake turns the message and/or attachments into Sources with provenance (from, received time, subject). **v1 is an inbound address** Christian controls, not a connected mailbox and not a general email client.
- Direct connect is at least Plaud (FR-31); other connectors follow the same arrival → queue contract.

#### FR-42: Auto-embedding after Ingest

When vector search is enabled (FR-52), new and updated Pages are embedded automatically after Ingest — no separate “rebuild” step required for those Pages. Realizes UJ-2.

**Consequences (testable):**
- With vector search on, a Page created by Ingest is retrievable via vector Search without a manual embed action.
- With vector search off (the default), Ingest still succeeds and does not fail for lack of embeddings. The fork’s always-on Vectorize path is **not** the v1 default.
- Turning vector **on** for an existing Wiki **enqueues embed of current Pages** (progress in Activity). Turning **off** does not delete Sources or Pages.

#### FR-44: Progressive Sources view

Large `raw/sources/` trees render progressively while scrolling so big collections stay responsive. Realizes UJ-3.

**Consequences (testable):**
- Opening a Sources tree with hundreds of files does not require rendering every row before first paint of the visible window.
- Scrolling reveals additional files without a full-tree remount that loses scroll position.

### 4.4 Chat (Query)

**Description:** Full multi-Conversation Chat driven by a **backend Agent runtime** (not a browser-only TypeScript loop): tools, Skills, workspace outputs, structured input forms, and a split shell-approval model. Independent sessions, sidebar, persistence, history depth, cited-references panel, regenerate, Save to Wiki → `wiki/queries/` then auto-Ingest. Realizes UJ-2.

**Functional Requirements:**

#### FR-13: Independent Conversations

Christian can **create, rename, and delete** Conversations as independent Chat sessions. Realizes UJ-2.

**Consequences (testable):**
- A new Conversation starts empty and does not share messages with others.
- Rename changes the display name only; message history is unchanged.
- Delete removes that Conversation’s messages and does not delete Wiki Pages.

#### FR-57: Conversation sidebar

A Conversation sidebar lists sessions for **quick switching** between topics without leaving the Chat column. Realizes UJ-2.

**Consequences (testable):**
- Switching Conversations shows that session’s messages immediately.
- The active Conversation is visually distinct.
- Unsaved input in the composer is not silently applied to a different Conversation `[ASSUMPTION: composer is per-Conversation or cleared/warned on switch].`

#### FR-58: Per-conversation persistence

Each Conversation is saved independently and survives restart. Cited Pages are stored **on the message**, not recomputed later. Realizes UJ-2.

**Consequences (testable):**
- After reload, every Conversation, its messages, and each assistant message’s cited Pages are identical.
- Nashsu on-disk layout is `.llm-wiki/chats/{id}.json`; the web app must persist the same record shape (id, name, messages, per-message citations). `[ASSUMPTION: storage backend may differ; the file path is the export/Obsidian-compatible layout when the Wiki is exported.]`

#### FR-59: Configurable history depth

Only the last **N** messages are sent as Chat history context. Default **N = 10**. Configurable in Settings. Realizes UJ-2.

**Consequences (testable):**
- With N=10, the 11th-oldest message is not in the model’s chat-history allocation (FR-54 20% slot).
- Changing N applies to the next send, not retroactively rewriting stored messages.
- History depth is a message-count cap **inside** the 20% chat-history token budget (FR-54); whichever is tighter wins.

#### FR-14: Cited answers and references panel

Chat answers use the Retrieval pipeline and cite assembled context by number (`[1]`, `[2]`, …). Each assistant response has a **collapsible cited-references panel** listing the Wiki Pages used, **grouped by page type with icons**. Realizes UJ-2.

**Consequences (testable):**
- Each non-empty answer includes at least one `[n]` citation when matching Pages exist.
- `[n]` maps to the numbered Page (or Source) in the assembled context (FR-55).
- The panel can collapse/expand per response; grouping is by type (entity, concept, source, query, …).
- Clicking a reference opens that Page in Preview.
- Cited Pages are stored on the message (FR-58) so the panel is stable across restarts (not a live re-query).
- When no Page matches, the UI states coverage is missing (no fake citations or empty fake panel).

#### FR-15: Save to Wiki

Christian can archive a valuable answer to **`wiki/queries/`**, which then **auto-Ingests** (FR-41) so entities/concepts fold into the knowledge network. Realizes UJ-2.

**Consequences (testable):**
- Save writes a query Page under `wiki/queries/` with a link back to the Conversation.
- Arrival queues two-step Ingest; related entity/concept Pages update.
- The new Pages are Chat-retrievable after that Ingest finishes.

#### FR-16: Sources-only mode

Christian can constrain a Conversation to raw Sources (no compiled Pages) for “what did they actually say.” Realizes UJ-2.

**Consequences (testable):**
- In this mode, citations point at Sources, not concept Pages.
- Mode is visible so it cannot be confused with Wiki Chat.

#### FR-17: Regenerate

One click regenerates the last response: the last **assistant + user message pair is removed**, then that user message is **re-sent**. Realizes UJ-2.

**Consequences (testable):**
- After regenerate, the previous last pair is gone; a new assistant message is stored.
- Cited references on the new message reflect the new retrieval, not the deleted pair.
- Regenerating an empty Conversation or with no last pair is a no-op (no error crash).

#### FR-66: Thinking / reasoning display

When the model emits a Thinking block (`<think>` or equivalent), Chat shows it **separately from the main response**. Realizes UJ-2.

**Consequences (testable):**
- **During generation:** thinking streams in a rolling **5-line** viewport with **opacity fade** (newer lines more opaque than older).
- **After completion:** the Thinking block is **collapsed by default**; one click expands it, another collapses it.
- Thinking uses a **distinct visual style** from the assistant answer (not mixed into the same prose block).
- Models that emit no Thinking block show no thinking chrome (no empty collapsed stub).
- Thinking is stored with the message so expand still works after restart (FR-58).
- Thinking is not treated as a Wiki citation or Save-to-Wiki body unless Christian explicitly includes it `[ASSUMPTION: Save to Wiki uses the main response only].`

#### FR-60: Backend Agent runtime

Chat turns are executed by a **backend Agent runtime**, not a browser-only TypeScript tool loop. The Workbench streams results; the Agent chooses tools. Realizes UJ-2.

**Consequences (testable):**
- Disabling or killing the Agent backend makes Chat fail closed with an actionable error (not a silent client-side stub).
- Tool calls are visible in the Conversation (name + outcome), not hidden in the browser console only.
- **v1 topology:** Workbench stays on the web app (Cloudflare). The Agent, local HTTP API `:19828`, MCP, shell, and document extractors run on a **local sidecar** (or dedicated Agent service). Cloud `/api/v1` behind operator auth is a separate façade, not the loopback bind.
- A fixture Skill (`SKILL.md`) in the project Skill folder can be enabled and selected with `/skill`; at least one golden Chat turn records a wiki-search tool call.

#### FR-61: Tool-using Agent

The Agent can choose tools: **wiki search, source search, graph search, web search, AnyTXT, workspace file tools, approved shell commands, and Skill file reads**. Realizes UJ-2.

**Consequences (testable):**
- A question that needs Wiki lookup can trigger wiki search without Christian picking the tool.
- Graph search can use the 4-signal / Community graph (FR-45, FR-47).
- Web search is distinct from Deep Research confirm (FR-24) when used as an Agent tool mid-turn; unconfirmed bulk Deep Research still requires FR-24.
- AnyTXT (or its web equivalent: full-text over `raw/sources/`) is available as a tool. `[ASSUMPTION: desktop AnyTXT is nashsu-specific; web v1 may implement the same job as Source full-text search.]`
- Skill file reads only see Skills that are enabled (FR-62).

#### FR-62: Skill management

The system scans **project and user Skill folders** for `SKILL.md` files, lets Christian **enable or disable** Skills, and pick a Skill **per Conversation** via **`/skill` completion**. Realizes UJ-2.

**Consequences (testable):**
- Disabled Skills do not appear in `/skill` completion and are not injected into that Conversation.
- `/skill` offers matching Skill names as Christian types.
- The selected Skill is stored on the Conversation and persists across restart (FR-58).
- Scanning picks up new Skill files without a full app reinstall `[ASSUMPTION: scan on Settings open and on Workbench load].`

#### FR-63: Agent workspace outputs

Files produced by Agent tools are kept under **`agent-workspace/`**, shown as **generated outputs**, and can be **previewed or opened from Chat**. Realizes UJ-2.

**Consequences (testable):**
- A tool-created file appears in `agent-workspace/` and as an output chip/list on the message.
- Preview opens in the Preview column (or a file preview) without leaving the Workbench.
- Outputs survive restart with the Conversation.

#### FR-64: User interaction forms

Skills can request structured input — **single choice, multiple choice, or free text** — without hardcoded skill-specific UI. Realizes UJ-2.

**Consequences (testable):**
- Two different Skills can each present a choice form using the same form renderer.
- Chat does not proceed with that Skill’s next tool step until the form is submitted or cancelled.
- Cancel leaves the Conversation intact and does not run the pending tool.

#### FR-65: Safer shell execution

**Project workspace** commands may continue without a prompt. **External** shell commands require **explicit approval** before they run. Realizes UJ-2.

**Consequences (testable):**
- A command whose cwd/target is inside the Wiki/project workspace can run without an approval modal.
- A command targeting outside that workspace (or a new executable path) shows an approval UI; Deny means it does not run.
- Approval is per command (or a clearly scoped allow); it is not a blanket “allow all shells forever” unless Christian sets that in Settings `[ASSUMPTION: no blanket allow in v1 default].`

### 4.5 Search and Retrieval pipeline

**Description:** Search mode and Chat share one Retrieval pipeline: tokenized search over Pages and Sources, optional vector search (off by default), 4-signal graph expansion, token budget, then numbered full-content assembly. Realizes UJ-2, UJ-3.

#### FR-18: Search the Wiki

Christian can search titles and bodies (Pages and Sources) and jump to Preview. Results use Phases 1–2 of the Retrieval pipeline (vector only if enabled). Realizes UJ-2.

**Consequences (testable):**
- Queries return ranked hits; empty query does not error.
- Selecting a hit opens that Page or Source in Preview.
- Hits can come from `wiki/` and from `raw/sources/`.
- Search shows an **image section** when hits include extracted/embedded images (`wiki/media/`, `raw/assets/`, or markdown `![]()`). Opening an image uses a **lightbox**; **jump-to-source** opens the Page or Source that contains it (FR-72).

#### FR-51: Phase 1 — Tokenized search

Tokenized search runs first over **both** `wiki/` and `raw/sources/`. Realizes UJ-2.

**Consequences (testable):**
- English: word splitting + stop-word removal.
- CJK text: bigram tokenization (e.g. `每个` → `[每个, 个…]`) so mixed-language Sources still match. UI and LLM Generation remain English (non-goal).
- A title match adds **+10** to that hit’s tokenized score vs body-only match.
- With vector search **off**, Search and Chat still return tokenized hits (then Phase 2).

#### FR-52: Phase 1.5 — Optional vector search

Vector semantic search is **fully optional, disabled by default**. When enabled, embeddings come from any OpenAI-compatible `/v1/embeddings` endpoint; retrieval is cosine-similarity ANN. Results **merge** into tokenized search: boost existing matches and add new discoveries (semantic neighbors with no keyword overlap). Realizes UJ-2.

**Consequences (testable):**
- Default Settings: vector search **off**. Chat/Search work via FR-51 + FR-53.
- Enabling requires independent **endpoint**, **API key**, and **model** (not necessarily the Chat/Ingest model).
- Missing/invalid vector credentials fail that phase visibly and **fall back** to tokenized + graph — they do not blank Chat.
- Cosine-similar Pages without shared keywords can appear in results when vector is on.
- `[ASSUMPTION: ANN store is an architecture choice. Nashsu uses LanceDB; this web app may use Cloudflare Vectorize or equivalent. See addendum.]`

#### FR-53: Phase 2 — Graph expansion

Top search results are **seed nodes**. The 4-signal Relevance model (FR-45) finds related Pages. Expansion is **2-hop** with **decay** on the second hop. Realizes UJ-2.

**Consequences (testable):**
- A Page linked only via Relevance to a top hit can enter the candidate set even if it missed Phase 1 keywords.
- 2-hop candidates score lower than 1-hop (decay applied).
- Graph expansion runs whether or not vector search is on.

#### FR-54: Phase 3 — Budget control

Christian sets how much context the LLM receives with a **slider from 4K to 1M tokens**, so the budget can match the model. Allocation is **proportional** to that window: a larger setting sends **proportionally more wiki content**, not a fixed page count. The split is **60% wiki Pages / 20% chat history / 5% index / 15% system prompt**. Pages are prioritized by **combined search + graph Relevance** score. Realizes UJ-2.

**Consequences (testable):**
- Settings exposes a **slider** whose range is 4K–1M tokens (FR-56).
- Assembled Chat context does not exceed the selected budget.
- Wiki Pages receive **60%** of the selected window; chat history **20%**; index **5%**; system prompt **15%**.
- Doubling the slider (e.g. 32K → 64K) approximately doubles the wiki-token budget (still 60%), filling additional ranked Pages — not the same N Pages padded.
- Lower-scoring Pages are dropped before higher-scoring ones when over the wiki slice.
- Raising the window does not dump the whole Wiki unranked (SM-C3).
- `[ASSUMPTION: the same slider caps Ingest LLM context unless Settings later splits Chat vs Ingest windows; dual Chat/Ingest *models* (FR-35) can still share this one budget.]`

#### FR-55: Phase 4 — Context assembly

The model receives **numbered Pages with full content** (not summaries only). The system prompt includes `purpose.md`, language rules, citation format, and `index.md`. The LLM is instructed to cite by number: `[1]`, `[2]`, etc. Realizes UJ-2.

**Consequences (testable):**
- Assembled items include full Page (or Source) body, not title+summary only.
- Each assembled item has a stable number for that turn.
- Chat answers use `[n]` citations that resolve to those numbers (FR-14).
- `purpose.md` and `index.md` are in the system/index allocation, not omitted when Pages are many.

### 4.6 Graph and Relevance engine

**Description:** A full knowledge-graph visualization of Pages, with edges scored by a 4-signal Relevance model. Louvain Communities (independent of page type), type/Community coloring, cohesion warnings, hover, zoom, and stable layout. Insights can spawn Deep Research. Realizes UJ-4.

#### FR-19: Knowledge graph visualization

Christian can view all Wiki Pages as a force-directed graph in Graph mode. Realizes UJ-4.

**Consequences (testable):**
- Every Page is a node; isolated Pages remain visible (orphans / unlinked).
- Node color is by **page type** or by **Community** via an explicit Type / Community toggle (FR-47).
- Node size scales with link count using **square-root (√) scaling**.
- Edge thickness and color follow Relevance: **green = strong**, **gray = weak**.
- Clicking a node opens that Page in Preview.
- A legend shows **type counts** when coloring by type, and the Community legend (FR-47) when coloring by Community.

#### FR-47: Louvain Communities

The Graph **automatically discovers** Communities from link topology using Louvain clustering, independent of predefined page types (entity, concept, source, …). Realizes UJ-4.

**Consequences (testable):**
- Running/opening Graph assigns each Page a Community from topology, not from `type` frontmatter.
- A **Type / Community toggle** switches node coloring between page type and discovered Community without leaving Graph mode.
- Each Community has a **Cohesion** score (actual intra-edges / possible intra-edges). Communities with Cohesion **< 0.15** are flagged with a visible warning.
- Community coloring uses a **12-color palette** so clusters are visually distinct (reuse colors only after 12 Communities).
- In Community coloring mode, the legend lists each cluster’s **top node label**, **member count**, and **Cohesion** (and the low-cohesion warning when Cohesion < 0.15).
- Re-clustering after Ingest does not require a manual “run clustering” step `[ASSUMPTION: Communities refresh when Graph data refreshes; position cache (FR-46) still holds].`

#### FR-45: 4-signal Relevance model

Pairwise Relevance between Pages is the weighted combination of four signals. Weights are:

| Signal | Weight | Description |
|--------|--------|-------------|
| Direct link | ×3.0 | Pages linked via `[[wikilinks]]` |
| Source overlap | ×4.0 | Pages sharing the same raw Source (via frontmatter `sources: []`) |
| Adamic-Adar | ×1.5 | Pages sharing common neighbors, weighted by neighbor degree |
| Type affinity | ×1.0 | Bonus for same page type (entity↔entity, concept↔concept) |

Realizes UJ-4.

**Consequences (testable):**
- Two Pages that share a Source score higher from source overlap than from a single wikilink alone (4.0 vs 3.0), all else equal.
- Two Pages with no wikilink, no shared Source, no common neighbors, and different types score 0.
- Same-type Pages receive the type-affinity bonus; mixed types do not.
- Graph edges display this Relevance (thickness, color, hover label).
- Weights are the v1 contract; changing them is a product change, not an undocumented tweak. `[ASSUMPTION: combination is a weighted sum of the four signals; a missing signal contributes 0.]`

#### FR-46: Graph interaction and layout stability

Graph interaction: hover, zoom, and cached positions. Realizes UJ-4.

**Consequences (testable):**
- **Hover:** neighbors of the hovered node stay visible; non-neighbors dim; incident edges highlight and show a Relevance score label.
- **Zoom:** Zoom in, Zoom out, and Fit-to-screen controls exist and affect the view.
- **Position caching:** after layout, node positions persist across data updates so the graph does not jump/re-scatter on every Ingest.
- Fit-to-screen brings all current nodes into view.

#### FR-20: Graph Insights

The Graph automatically analyzes structure and surfaces **Insight** cards: Surprising Connections and Knowledge Gaps. Realizes UJ-4.

**Consequences (testable):**
- Opening Graph mode shows Insights without a separate “analyze” click.
- Insights refresh when graph data/Communities refresh.
- Dismissed Insights do not reappear until the underlying structure changes enough to create a new Insight `[ASSUMPTION: dismissals persist with Workbench state (FR-8); identical edge/node Insights stay dismissed across reload].`

#### FR-48: Surprising Connections

The system detects unexpected relationships and ranks them with a **composite surprise score**. Classes: cross-Community edges, cross-type links, peripheral↔hub couplings. Realizes UJ-4.

**Consequences (testable):**
- Cards are ordered by surprise score (highest first).
- Each card identifies the Pages/edge and the class (cross-community, cross-type, or peripheral-hub).
- Christian can **dismiss** a connection as reviewed; it does not reappear on the next Graph open.
- `[ASSUMPTION: v1 surprise formula is a documented weighted mix of those three classes; exact coefficients may live in Schema/settings but ranking must be stable for the same graph.]`

#### FR-49: Knowledge Gaps

The system surfaces:

- **Isolated pages** — degree ≤ 1 (few or no connections to the rest of the Wiki)
- **Sparse communities** — Cohesion < 0.15 and ≥ 3 Pages
- **Bridge nodes** — Pages connecting 3+ Communities

Realizes UJ-4.

**Consequences (testable):**
- An isolated Page with degree 0 or 1 appears as a Knowledge Gap card.
- A Community with Cohesion 0.14 and 3+ members appears; a 2-page low-cohesion group does not (size gate).
- A Page linking three distinct Communities appears as a Bridge node card.
- Isolated and sparse-community cards, and Bridge node cards, include a **Deep Research** button (FR-50). Surprising Connection cards do not require that button.

#### FR-50: Insight highlight and Deep Research

Insights are interactive. Realizes UJ-4.

**Consequences (testable):**
- Clicking an Insight card **highlights** the corresponding nodes and edges on the Graph; clicking the same card again **deselects**.
- Deep Research from a Knowledge Gap or Bridge node opens an **editable confirmation dialog** showing a proposed **research topic** and **search queries** before anything runs.
- Proposed topic/queries are LLM-optimized and **domain-aware**: they are built using `overview.md` and `purpose.md` (plus the Insight’s Pages).
- Christian can edit topic and queries, then confirm (FR-24) or cancel. Cancel starts no research.
- Confirm starts streaming Deep Research that can auto-Ingest (FR-24).

### 4.7 Lint

**Description:** Owner Lint: contradictions/disputed, expiry/staleness, duplicates, broken wikilinks, orphans, suggested gaps. Optional auto-fix for mechanical issues. Realizes UJ-4.

#### FR-21: Lint report

Christian can run Lint and see a list of issues with links to affected Pages. Realizes UJ-4.

**Consequences (testable):**
- Disputed Pages (`disputed: true`) appear in the report.
- Broken wikilinks are listed with source Page.
- Stale/expired Pages (Schema-defined age or `expires`) appear.
- Duplicate Pages (same concept slug/title cluster) appear.
- Orphan Pages (no inbound wikilinks, excluding bookkeeping Pages) appear.
- Suggested gaps may point at Graph Insights (FR-49); Lint does not invent a second gap product.

#### FR-22: Mechanical auto-fix

Christian can apply auto-fix for **mechanical** classes only: renamed-slug wikilinks, dangling `[[slug]]` after FR-12, and `index.md` drift vs existing Pages. Not for disputed claims.

**Consequences (testable):**
- Auto-fix does not clear `disputed` without a new Ingest/Review.
- A fix is recorded in Page history.
- Issues outside those three classes stay Lint-only (no auto-fix button).

### 4.8 Asynchronous Review queue

**Description:** During Ingest, the LLM flags items that need human judgment. Those land in a Review queue Christian handles later. Ingest is never blocked. Actions are a closed set so the model cannot invent arbitrary buttons. Realizes UJ-4.

#### FR-23: Review items

Ingest can flag Review items. Each item offers **only** three actions: **Create Page**, **Deep Research**, **Skip**. At ingest time the LLM **pre-generates optimized web search queries** stored on the item. Realizes UJ-4.

**Consequences (testable):**
- A Review item appearing does **not** pause or fail the Ingest job; Activity can show Ingest **succeeded** while Review still has pending items.
- The Review UI exposes **only** Create Page, Deep Research, and Skip — no free-form action string from the model is executable.
- An LLM-proposed action outside that set is dropped or mapped to Skip; it must not appear as a custom button.
- Each Review item stores the ingest-time search queries; Deep Research from that item **pre-fills** those queries in the confirm dialog (FR-24 / FR-50), still editable.
- **Skip** dismisses the item with no Wiki writes.
- **Create Page** starts a constrained Page-create path (traceable Ingest or Generation), not an arbitrary tool.
- **Deep Research** starts FR-24 using the stored queries after confirm.
- Pending Review items persist across restart (FR-8). Christian can empty the queue hours later.

### 4.9 Deep Research

**Description:** When the LLM (or Graph Insights / Review) identifies knowledge gaps, Deep Research runs **after confirm**: multiple search queries, full-content fetch via Tavily, SerpApi, or SearXNG, synthesis into a wiki research Page with cross-references, thinking display, auto-Ingest, up to **3 concurrent** tasks, streamed in a dedicated Research Panel. Realizes UJ-2, UJ-4.

#### FR-24: Confirmed Deep Research

No Deep Research starts until Christian confirms an **editable** topic and **multiple search queries**. Realizes UJ-4.

**Consequences (testable):**
- Cancel or dismiss starts no search and no Ingest.
- Confirm dialog shows topic + the query list; both are editable; at least one query is required to start.
- From a **Review item**: queries are the ingest-time set (FR-23).
- From **Graph Insights**: topic and queries are LLM-generated from `overview.md` + `purpose.md` plus the Insight Pages — not generic keywords (FR-50).
- From Deep Research mode directly: Christian can enter/edit topic and queries before start.

#### FR-67: Search providers and full-content fetch

Deep Research searches the web via **Tavily**, **SerpApi**, or **SearXNG**, with **full content extraction (no truncation)** of fetched sources before synthesis. Realizes UJ-4.

**Consequences (testable):**
- Settings configures the active provider.
- Out of the box the active provider is **Tavily**. SerpApi and SearXNG remain selectable; one is active at a time.
- **Tavily** and **SerpApi** each have an **independent API key**.
- **SerpApi** exposes **selectable engines**.
- **SearXNG** uses a **configured instance URL** and **search categories**.
- Missing credentials for the selected provider fail the task visibly; they do not silently fall back to another provider `[ASSUMPTION: Christian picks one active provider per Wiki; keys for unused providers may still be stored].`
- Fetched page/source text is passed to synthesis **without an app-imposed truncation cap**. Provider-side limits may still apply.

#### FR-68: Research Panel

A dedicated **Research Panel** (sidebar) shows Deep Research with **dynamic height** and **real-time streaming progress**. Realizes UJ-4.

**Consequences (testable):**
- Starting research opens/reveals the panel without leaving the Workbench.
- Progress updates (queries, fetches, synthesis) stream; the panel height grows with content rather than a fixed stub.
- Multiple concurrent tasks (FR-70) are distinguishable in the panel.

#### FR-69: Research Page, thinking, auto-Ingest

The LLM **synthesizes findings into a wiki research Page** with **cross-references** to existing Pages. During synthesis, `<think>` blocks are **collapsible** and the view **auto-scrolls to the latest** thinking content. When synthesis completes, results **auto-Ingest** (FR-41) to extract entities/concepts. Realizes UJ-4.

**Consequences (testable):**
- A successful run writes a research Page that `[[wikilinks]]` existing Wiki Pages where relevant.
- Thinking during synthesis is visually separate (FR-66 family): collapsible sections; viewport follows the newest thinking line.
- Auto-Ingest queues two-step compile of the research Sources/Page; Activity shows those jobs.
- Failed synthesis does not auto-Ingest a partial hallucination as a clean success.

#### FR-70: Deep Research task concurrency

Deep Research uses its **own task queue** with **up to 3 concurrent** research tasks. Realizes UJ-4.

**Consequences (testable):**
- A fourth start waits until a slot frees (does not silently drop).
- This concurrency is **independent** of the serial Ingest LLM queue (FR-39).
- Tasks survive restart as pending/running/failed like other durable jobs (FR-8).

### 4.10 Capture from the web

**Description:** Parity with nashsu’s clipper using web-native Capture (existing bookmarklet/share is acceptable if it lands in the same Ingest queue). Realizes UJ-3.

#### FR-25: Capture a URL or clip into Ingest

Christian can send a web page or selection into the Ingest queue while signed in. Realizes UJ-3.

**Consequences (testable):**
- Captured items appear as Sources with original URL, stored as **clean Markdown** (main content, FR-71 web clips).
- Capture without a session fails closed (no public write).

**Out of Scope:** A Chrome Web Store extension is not required if bookmarklet/share meets FR-25. `[ASSUMPTION: bookmarklet + in-app URL Ingest is v1 parity.]`

### 4.11 Meeting Todos (beyond nashsu)

**Description:** After meeting-like Ingests, the LLM proposes Todo Candidates. Christian **approves or rejects** each. Approved Todos have due dates and links back to the meeting Source and Page. Rejected Candidates are retained for audit but excluded from the working list. Realizes UJ-1, UJ-5.

**Functional Requirements:**

#### FR-26: Extract Todo Candidates on meeting Ingest

When a Source is a meeting transcript and/or summary, Ingest produces zero or more Todo Candidates (title, rationale, optional due date, speaker/context if present). Realizes UJ-1.

**Consequences (testable):**
- A meeting Ingest that completes always opens/updates the Todo review list (including “none found”).
- Candidates cite the Source (and Page if created).
- Non-meeting Sources do not spam Candidates. **v1 meeting rule:** extract iff the Source is **Plaud-origin** or Christian **marks it “meeting”**. PPT/PDF/URL/office default **off**. No classifier.

#### FR-27: Approve or reject Candidates

Christian can approve (becomes Todo) or reject (does not). Bulk approve/reject allowed. Realizes UJ-1, UJ-5.

**Consequences (testable):**
- Rejected Candidates never appear as open Todos.
- Approval is explicit; nothing auto-promotes to Todo.
- Decision (approve/reject), timestamp, and actor are stored.

#### FR-28: Due dates and completion

A Todo has an optional due date, status (open/done), and can be edited after approval (title, due date) without breaking Source links. Realizes UJ-5.

**Consequences (testable):**
- The Todo list can sort/filter by due date and status.
- Completing a Todo keeps links to Source/Page.
- Rejected Candidates and completed Todos persist until the owner deletes them. No automatic expiry.

#### FR-29: Links back to the meeting

Every Candidate and Todo links to the originating Source and to the meeting Page when one exists. Realizes UJ-1, UJ-5.

**Consequences (testable):**
- From a Todo, one action opens Preview on the meeting Page or the Source transcript view.
- Deleting a Source marks linked Todos as source-missing rather than deleting them silently `[ASSUMPTION: keep Todos; show broken-source state]`.

### 4.12 Plaud and meeting Sources

**Description:** First-class meeting Sources: transcript + summary from Plaud, plus other transcripts Christian pastes/uploads. Realizes UJ-1.

#### FR-30: Ingest Plaud transcript and summary

Christian can Ingest a Plaud recording’s transcript and AI summary as Sources (same meeting). Realizes UJ-1.

**Consequences (testable):**
- Both artifacts are stored immutably and cited from the meeting Page.
- Todo extraction may use summary action items **and** transcript; duplicates are collapsed into one Candidate `[ASSUMPTION: prefer transcript+summary together over summary-only]`.

#### FR-31: Plaud bring-in path

Christian can bring recordings in without leaving the job loop. Arrival **auto-queues** Ingest (FR-41). **MVP must:** export/upload of transcript+summary (FR-30). **Stretch:** in-app Plaud OAuth list/pull.

**Consequences (testable):**
- Uploading transcript+summary queues Ingest and satisfies UJ-1.
- If OAuth pull ships, a recording can be selected and queued the same way.
- Auth failure fails closed; no partial Wiki writes from an incomplete pull.

### 4.13 Multi-format documents and media

**Description:** Structured extraction that **preserves document semantics** (headings, emphasis, lists, tables, slides, sheets, chapters), plus native preview for images and a built-in player for video/audio. Web clips become clean Markdown. Realizes UJ-3.

#### FR-32: Multi-format Ingest

Christian can Ingest PDF, DOCX, PPTX, XLSX/XLS/ODS, EPUB/MOBI, images, video/audio, URLs/web clips, and pasted text. Realizes UJ-3.

**Consequences (testable):**
- Each listed type reaches successful Ingest or a clear unsupported/fail state — never a silent drop.
- Spreadsheets become Markdown tables in Pages, not an in-app spreadsheet editor.

#### FR-71: Structured extraction by format

Extraction preserves structure for the LLM, not a flattened text dump. Realizes UJ-3.

**Consequences (testable):**

| Format | Required extraction behavior |
|--------|------------------------------|
| **PDF** | Text/layout extracted with **file caching** so the same bytes are not re-parsed. Optional **MinerU** (Cloud, Local API, or Pipeline) for complex layouts, selectable in Settings. Default **off**; if enabled, first mode is **Local API**. |
| **DOCX** | Headings, bold/italic, lists, and tables become **structured Markdown**. |
| **PPTX** | **Slide-by-slide** extraction with heading/list structure. |
| **XLSX / XLS / ODS** | Proper **cell types**, **multi-sheet** support, output as **Markdown tables**. |
| **EPUB / MOBI** | Metadata, chapters, and body text → ingest-ready content. |
| **Web clips** | Clean Markdown (main content, not chrome/nav). |

- A DOCX with Heading 1 / a bullet list / a table produces Markdown that still has a heading, a list, and a table — not one undifferentiated paragraph.
- A multi-sheet workbook yields more than the first sheet.
- A PPTX Source summary can be navigated by slide, not a single undifferentiated blob.
- PDF re-Ingest of identical SHA256 uses the parse cache (FR-10) and does not re-run MinerU/pdf-extract.
- MinerU off: built-in PDF extract still works; complex-layout failure is visible, not silent.

#### FR-72: Image preview and AV player

Images have **native preview**. Video and audio have a **built-in player**. Realizes UJ-3.

**Consequences (testable):**
- Preview of png, jpg, gif, webp, svg (and other common raster/vector types the browser can render) shows the image, not only a filename.
- Clicking an image in Preview or Search opens a **lightbox**; a control jumps to the containing Page or Source.
- Extracted images may live under `wiki/media/` or `raw/assets/`; they remain reachable from Search (FR-18).
- Selecting a video or audio Source plays it in the Workbench (no mandatory external app).
- Media files still Ingest (transcript/description path as the pipeline allows); player failure does not delete the Source.

#### FR-33: Batch and drag-drop

Multiple files/URLs can be queued in one action. Realizes UJ-3.

**Consequences (testable):**
- A batch of N files creates N Source jobs (or a documented split); failures are per-item.

**Out of Scope:** In-app spreadsheet editing or slide editing. Folder import is FR-40; automatic processing on arrival is FR-41.

### 4.14 Schema, purpose, and Scenario Templates

**Description:** `purpose.md` + Schema steer Ingest/Chat/Lint/Todos. A new Wiki starts from a Scenario Template that writes those files. Christian can still edit them afterward. Realizes UJ-1–UJ-4.

#### FR-34: Editable Schema

Christian can view/edit purpose and Schema from Settings or Wiki tree. Changes apply to subsequent Ingest/Chat/Lint.

**Consequences (testable):**
- A Schema change is visible on the next Ingest prompt/context.
- Invalid Schema does not crash Ingest; it errors visibly `[ASSUMPTION: keep markdown Schema, not a form builder]`.

#### FR-38: Scenario Templates

Creating a Wiki requires choosing one Scenario Template: **Research**, **Reading**, **Personal Growth**, **Business**, or **General**. Each pre-configures `purpose.md` and Schema (`schema.md`). Realizes UJ-2.

**Consequences (testable):**
- The create/first-run UI lists exactly those five names (no blank Wiki without a template).
- After create, `purpose.md` and Schema exist and differ by template (Business ≠ Reading).
- Christian can edit purpose/Schema after create without being stuck on the template forever.
- Applying a different template later is confirm-gated and overwrites purpose/Schema only — not Pages or Sources. `[ASSUMPTION: v1 allows more than one named Wiki so templates are not a one-shot onboarding screen; still one operator.]`

### 4.15 Settings

**Description:** Provider/model configuration. nashsu splits Chat vs Ingest models. Realizes reliability for job use.

#### FR-35: Multi-provider LLM support

Christian can set Chat and Ingest models independently. Supported providers: **OpenAI, Anthropic, Google, Ollama, Custom**. Each uses **provider-specific streaming and headers**. Realizes UJ-2.

**Consequences (testable):**
- Switching provider shows that provider’s model list / custom base URL as appropriate.
- Streaming works for each listed provider (tokens appear incrementally in Chat).
- Custom provider accepts a base URL + key and still streams.
- Changing Ingest model does not change Chat mid-Conversation until new turns.
- Missing credentials fail with an actionable Settings error, not a blank Chat.

#### FR-56: Retrieval Settings

Settings control the Retrieval pipeline: a **context-window slider 4K–1M**, and optional vector search (off by default) with **independent** embeddings endpoint, API key, and model. Realizes UJ-2.

**Consequences (testable):**
- Vector search cannot turn on without endpoint + key + model; leaving it off is valid.
- The slider is the control for FR-54; a change applies to the next Chat turn (and Ingest if sharing the budget).
- History depth N (default 10) is set here (FR-59) and still sits inside the 20% chat slice.
- Deep Research provider: default **Tavily**; Tavily and SerpApi keys; SerpApi engine; SearXNG URL + categories (FR-67).
- Optional MinerU mode for complex PDFs (FR-71): default **off**; if enabled, **Local API**.
- **LLM timeout** is configurable (slow local models / long Ingest or research).
- **Firecrawl** is optional: API key and **custom Base URL** (hosted or self-hosted).
- Language is **English** (persisted; no other UI locale).

### 4.16 Local HTTP API, MCP, and Agent Skill

**Description:** External tools (Claude Code, Codex, HTTP scripts) talk to the Wiki through a **token-protected local HTTP API**, an **MCP server** on the same surface, and a **one-command Agent Skill**. Realizes UJ-2.

#### FR-36: API enablement and bind

Christian enables the API in **Settings → API + MCP**, **generates a token**, and chooses whether **local unauthenticated access** is allowed. The local server binds **127.0.0.1 only** (default port **19828**). Realizes UJ-2.

**Consequences (testable):**
- With the API off, data routes return **503** with `"disabled"`; `/health` still reports `enabled: false`. In-flight cap (64) → **503** `"busy"` (back off ≥2s).
- With the API on and unauthenticated local access **off**, mutating and data routes require a token. Three equivalent send methods: `Authorization: Bearer <token>` (preferred), `X-LLM-Wiki-Token: <token>`, `?token=` last resort (never echo/log the token or put it in a URL the user can see). Env **`LLM_WIKI_API_TOKEN`** overrides the UI token (`tokenSource: "env"`). Missing/wrong token → **401**.
- If `authConfigured: false` and `allowUnauthenticated: false`, callers must not proceed — tell Christian to **Settings → API + MCP → Generate new token**.
- `GET /api/v1/health` needs no auth and reports at least `ok`, `status` (`starting` / `running` / `port_conflict` / `error`), `version`, `enabled`, `authRequired`, `authConfigured`, `allowUnauthenticated`, `tokenSource` (`env` / `store` / `none`).
- The listener is **127.0.0.1 only** (not other hosts). This bind is the **local Agent sidecar**. Cloud `/api/v1` behind operator auth is a separate façade with the same route shapes, not this loopback port.
- Path traversal / out-of-scope → **403**. File reads limited to **`purpose.md`, `schema.md`, `wiki/**`, `raw/sources/**`**, **text extensions only** (md/mdx/txt/json/yaml/yml/csv/html/htm/xml/rtf/log), **2 MB** cap (**413** oversize). Binary/PDF via `files/content` → **415**. Hidden files and symlinks are skipped.
- Body limit **1 MiB** (exceed → **400**); file-tree hard cap **10000** nodes (**413**); search `topK` clamped to 50; graph `limit` clamped to 1000; rate limit **120 req/sec** (**429**, back off ≥1s).
- CORS `Access-Control-Allow-Origin: *`; preflight cached 10 min; allowed headers include `Authorization`, `X-LLM-Wiki-Token`, `Content-Type`. Relies on token secrecy.
- Token compare is not timing-leaky. Treat the token as a local secret.

#### FR-76: HTTP API v1 surface

The API exposes at least:

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/v1/health` | Server status; **no auth** |
| GET | `/api/v1/projects` | List Wikis: `{ id, name, path, current }` |
| GET | `/api/v1/projects/{id}/files` | Tree: `?root=wiki\|sources\|all&recursive=true&maxFiles=2000` → `{ name, path, isDir, size, children, truncated? }`. `sources` aliases **`raw`** and **`raw/sources`**. `all` includes `purpose.md`, `schema.md`, `wiki/`, `raw/sources/`. No offset/cursor — raise `maxFiles` or filter `root`; do not paginate with `maxFiles=1,2,…` |
| GET | `/api/v1/projects/{id}/files/content` | `?path=` project-relative; text only |
| GET | `/api/v1/projects/{id}/reviews?status=` | Export Review items: `unresolved`, `resolved`, or `all`; optional `type` and `limit` |
| PATCH | `/api/v1/projects/{id}/reviews/{reviewId}` | Body `{ "resolved": true, "action": "create_page" \| "deep_research" \| "skip" }`. `skip` (or omitted action with `resolved: true`) dismisses. `resolved: false` reopens |
| POST | `/api/v1/projects/{id}/reviews/resolve` | Bulk-resolve `{ "ids": [...], "action": "skip" }` → `{ resolved, notFound, count }`. `action` is the same closed set as FR-23 |
| POST | `/api/v1/projects/{id}/search` | Body `{ query, topK: 10, includeContent: false, queryEmbedding? }`. Hybrid when embeddings are on. Response: `mode`, `tokenHits`, `vectorHits`, per-result `path`, `title`, `snippet`, `score`, `titleMatch`, optional `vectorScore` / `images` / `content` |
| POST | `/api/v1/projects/{id}/chat` | Backend Agent chat (FR-77). **work-wiki implements this.** Nashsu desktop v1 returns **501**; the stock skill must not call it. |
| GET | `/api/v1/projects/{id}/graph` | Wikilinks graph: `?q=&nodeType=&limit=200` → `{ nodes: [{id, label, nodeType, path, linkCount}], edges: [{source, target, weight}] }` |
| POST | `/api/v1/projects/{id}/sources/rescan` | Queue a source diff. Returns `{ queue, changedTasks }` immediately; Ingest is async (Activity panel). |

**Consequences (testable):**
- Each route above exists and matches the stated auth, query, and body/response fields.
- `{id}` accepts **`current`**, a Wiki **UUID**, or a **URL-encoded absolute filesystem path**. Spoken names are **not** accepted as `{id}`: list projects, case-insensitive substring-match on `name`, then use that `id`. 0 matches → list names and ask (no silent fallback to `current`). 2+ matches → disambiguate with name + path. Cache the resolved `id` until the user switches Wiki.
- Empty search `query` → **400**. `includeContent: true` puts full markdown on each hit (avoids N+1 reads). Do not compare `score` across `mode`s (keyword scores are ~100× RRF).
- **`GET .../graph` is the wikilink graph** (edges from `[[wikilink]]`, deduped undirected, `weight` 1.0 in v1). It is **not** the Workbench 4-signal Relevance engine (FR-45).
- Review mutations are visible in the Review tab after Refresh.
- **v1 mutations on this API:** Review resolve/patch plus **`/sources/rescan`**. The Agent Skill treats everything else as read-only. Direct filesystem writes to `wiki/**` or `raw/sources/**` are not an API substitute.

#### FR-77: Agent chat HTTP + SSE

`POST /api/v1/projects/{id}/chat` is the **backend Agent** chat endpoint (wiki/source/web/AnyTXT retrieval). JSON is **non-streaming by default**. `"stream": true` or `Accept: text/event-stream` yields SSE events: `meta`, incremental `agent`, then `done`, `cancelled`, or `error`. Realizes UJ-2.

**Consequences (testable):**
- The terminal **`done` frame contains the complete aggregate response**. Clients must not render both message deltas **and** the final message as two answers.
- `mode: "deep"` **broadens evidence collection**. Full Deep Research workspace remains the Workbench Research Panel (FR-68), not this flag alone.
- Cancelled/error frames do not leave a partial answer marked success.

#### FR-78: MCP server and copyable config

An MCP server (nashsu: `mcp-server/`, build via `mcp:build`) calls the **same API surface**. Settings → API + MCP shows a **copyable MCP client configuration** with the correct local path. Realizes UJ-2.

**Consequences (testable):**
- MCP tools can list projects, read files, export unresolved Reviews, hybrid search, inspect the graph, trigger source rescan, and call Agent chat **without custom HTTP glue**.
- The copied config is valid for a local MCP client on this machine (path/command filled in).
- MCP is subject to the same token / loopback rules as FR-36.

#### FR-79: llm-wiki Agent Skill

A ready-made **documentation-only** Agent Skill ([nashsu/llm_wiki_skill](https://github.com/nashsu/llm_wiki_skill)) installs into Claude Code / Codex / any skills-compatible runtime, then calls the local HTTP+JSON API with ordinary `curl`/`fetch` — **no client library, SDK, or compile step**. Realizes UJ-2.

Install:

`npx skills add https://github.com/nashsu/llm_wiki_skill.git --skill llm-wiki`

(Also valid: clone + symlink into `~/.claude/skills/llm-wiki`, or drop the three markdown files into any skill dir.)

Skill files: `SKILL.md` (agent instructions), `api-reference.md` (endpoint contract), `examples.md` (recipes), `README.md` (human setup).

**Consequences (testable):**
- After install, the agent **probes `GET /api/v1/health` first**. If `authConfigured: false` and `allowUnauthenticated: false`, it asks Christian to generate a token and does not proceed.
- The agent can: hybrid search + read (“what does my wiki say about X”); graph neighborhood; read a Page by path; structural overview (file tree + `index.md` / `overview.md` / `purpose.md`); **rescan** sources after new docs (report `changedTasks` counts + first ~5 paths; ingest is async).
- Standard lookup: resolve project → `POST .../search` (`topK` 5–10, often `includeContent: true`) → cite each used `path` → synthesize. **Do not dump full pages unless asked. Do not fabricate** if results are empty or scores are flat.
- Default project is **`current`**. The agent **names the active Wiki once** (“Looking in your active project …”). Switching Wikis mid-conversation is **confirmed in the reply**, not silent. API calls to a non-current `{id}` do not change the Workbench’s open Wiki.
- **Read-only except `sources/rescan`**. Stock nashsu skill **must not** `POST /chat` (desktop returns 501). work-wiki implements `/chat` (FR-77); a branded skill may call it.
- Answers **cite wiki page paths** (and Wiki name when comparing Wikis) so Christian can verify in the Workbench.
- **Trigger discipline:** runs when the user names **LLM Wiki**, **work-wiki**, **“my wiki”**, **“my knowledge base”**, a Wiki by id/path/`current`, or asks to ground/rescan **the wiki**. Does **not** run on generic “search my notes”, “my notebook”, Obsidian / Notion / Logseq / Roam / Anki / Readwise, or “search my files”. When in doubt, **ask** which tool — do not silently hit the API.
- If the app is not running, the agent sees connection refused and says so (API binds only while the local server is up). `port_conflict` in `/health` → tell Christian another process owns 19828.
- Settings → API + MCP shows this install command. Re-running `npx skills add` updates the skill.
- `[ASSUMPTION: v1 ships a work-wiki-branded Agent Skill pack that documents FR-77 /chat (SSE done-aggregate; mode:deep ≠ Research Panel). The stock nashsu skill remains a valid read/rescan install and must not call /chat.]`

### 4.17 Backup and portability

**Description:** nashsu ZIP export/import. Christian needs a way to get the Wiki out. Realizes job-critical recoverability.

#### FR-37: ZIP export/import and index rebuild

Christian can **ZIP export/import** the Wiki for migration and trigger a **deterministic rebuild of `wiki/index.md`**. Export includes an auto-generated **`.obsidian/`** directory with recommended settings. Realizes job-critical recoverability.

**Consequences (testable):**
- Export is a ZIP of Pages, Sources, Todos, chats record-shape, and `.obsidian/` recommended config.
- Import restores a Wiki Chat can cite.
- Rebuilding `index.md` from current Pages is **deterministic** (same Pages → same index content).
- `.obsidian/` is present after export/create so Obsidian can open the vault without hand-config.

## 5. Non-Goals (Explicit)

- **Not RAG-as-the-product.** Chat may retrieve, but the system of record is the compiled Wiki.
- **Not a multi-user commons or public research lab** in v1 (concept-doc north star deferred).
- **Not a Tauri/desktop rewrite.** Web Workbench UI; Chat Agent runtime is backend (Rust), not an in-browser TS loop.
- **Not unapproved external shell.** Project-workspace commands may auto-run; external shell needs explicit approval (FR-65).
- **Not OS-local clipper port 19827, or Chrome extension-as-must.** Local API **19828** is in-scope (FR-36).
- **Not auto-approved Todos.** LLM proposes; Christian decides.
- **Not a general project manager** (no sprints, assignees, or team boards).
- **Not billing, waitlist, Twitter-community growth, or observer dashboards.**
- **Not federation, token-funded agents, or trust scores.**
- **i18n is English only.** Language setting is persisted as English (FR-8).
- **Not colleagues-as-users** until a later PRD.
- **Not Page-level discussion threads or talk pages.** Humans steer via Chat, Review (Create Page / Deep Research / Skip), Schema, and Todo approve/reject.
- **Not a visible confidence score or expiry badge as a Page attribute.** Disputed state + Lint staleness cover trust; PRODUCT “confidence / expiry / discussion” is deferred.
- **Not an ingest-diff review of every Generation.** Ingest commits; Review is the closed HITL set, not a per-merge change list.
- **Not required `synthesis/` or `comparisons/` Workbench modes.** Schema/templates may create those dirs; they are not extra sidebar icons.

## 6. MVP Scope

### 6.1 In Scope

- Private single-operator Wiki(s) on the existing web app.
- Workbench: icon sidebar, Knowledge Tree / File Tree + Chat + Preview, **collapsible left nav** (state preserved), drag-to-resize with min/max, file-by-file Activity panel.
- Durable state: Conversations, Settings, Review items, project config survive restart/re-login.
- Scenario Templates: Research, Reading, Personal Growth, Business, General (seed `purpose.md` + Schema).
- Ingest: two-step CoT (Analysis then Generation); SHA256 skip; serial durable queue with 3 auto-retries; recursive folder import with path context; **automatic Ingest on arrival** (upload, folder, email, direct connect, API/MCP); guaranteed Source summary; `overview.md` every Ingest; `sources: []` on Pages; auto-embed when vector on; progressive Sources view.
- Ingest formats: Plaud transcript+summary; PDF (cached extract + optional MinerU); DOCX/PPTX/XLSX/XLS/ODS; EPUB/MOBI; images with native preview; video/audio with built-in player; web clips as clean Markdown; URL/text.
- Chat: backend Agent runtime (tools: wiki/source/graph/web/AnyTXT/workspace files/approved shell/skill reads); Skill scan + enable/disable + `/skill` per Conversation; `agent-workspace/` outputs with preview; generic forms (single/multi/free text); workspace commands vs explicit external-shell approval; plus Conversations/sidebar/persistence/history/references/regenerate/Save to queries; Thinking blocks (5-line fade stream, collapsed after, distinct style).
- Search, Graph with 4-signal Relevance, Louvain Communities, Graph Insights, Lint + mechanical auto-fix, **async Review queue**, **Deep Research** (Tavily/SerpApi/SearXNG, full-content fetch, confirm dialog, research Page + auto-Ingest, thinking in Research Panel, 3 concurrent tasks).
- Capture via bookmarklet/share/in-app URL.
- Todo Candidates with approve/reject, due dates, links back to meeting Source/Page.
- Dual Chat/Ingest models; providers OpenAI / Anthropic / Google / Ollama / Custom with provider-specific streaming; configurable timeout; optional Firecrawl key + base URL; **local HTTP API `:19828` + MCP** (token, loopback, copyable config, chat SSE); **llm-wiki Agent Skill** (docs-only, curl, read-only except rescan, cite paths, explicit wiki trigger); ZIP export/import + deterministic `index.md` rebuild + `.obsidian/`; GFM/wikilink/**Mermaid/KaTeX** rendering; Search image section + lightbox; dataVersion UI refresh.

### 6.2 Out of Scope for MVP

- Shared vaults, public commons, Clerk Billing, clone-to-private marketplace flows — **reason:** solo job tool.
- Desktop app, nashsu i18n of the chrome, local clipper ports — **reason:** web personal Wiki. Finder-style OS folder-watch is not required; arrival via Intake is (FR-41).
- Chrome Web Store clipper — **reason:** FR-25 can be met without it `[NOTE FOR PM: revisit if bookmarklet friction shows up in daily URL capture]`.
- Spreadsheet editing, audio playback studio, or Plaud as a recording device inside work-wiki.
- Auto-join of every file type into Todo extraction.

### 6.3 Epic order (v1 includes both)

All of §6.1 is v1. Ship **P0 before P1** so UJ-1 is not blocked by Graph Insights or the Agent Skill pack.

- **P0:** Private Wiki (FR-1 cut list); Workbench; two-step Ingest; Plaud **upload**; cited Chat; Todo HITL (Plaud or marked meeting); ZIP export; view-first Preview.
- **P1:** Graph Insights + Louvain polish; Deep Research; local API/MCP/Agent Skill pack; office/EPUB extract; in-app Skills/shell; Plaud OAuth; inbound email; Mermaid/KaTeX; Search images.

## 7. Success Metrics

Job-critical personal tool: qualitative gates with a few operational counters. No vanity page-count.

**Primary**
- **SM-1**: After a meeting Ingest, Christian processes Todo Candidates in the same session (approve/reject complete) before starting the next meeting. Validates FR-26, FR-27, UJ-1.
- **SM-2**: For a decision he remembers from a meeting in the last 30 days, Chat or Search reaches a cited Page without opening Plaud first, in the majority of tries. Validates FR-14, FR-18, FR-51–FR-55, UJ-2.
- **SM-3**: Zero silent Source loss: every queued Ingest ends in success, explicit failure after ≤3 auto-retries, or cancel — never disappeared. Validates FR-7, FR-8, FR-9, FR-39, FR-32.

**Secondary**
- **SM-4**: Weekly Lint is runnable; Graph Insights surface at least isolated Pages and sparse Communities when they exist. Validates FR-21, FR-19, FR-20, FR-49, UJ-4.
- **SM-5**: ZIP export/import and deterministic `index.md` rebuild succeed on demand. Validates FR-37.
- **SM-6**: With vector search on vs off, Chat/Search recall on a fixed question set is higher when on. Nashsu published **58.2% → 71.4%** overall recall with vector enabled — treat as a reference lift, re-measure on this Wiki. Validates FR-52. `[ASSUMPTION: do not treat 71.4% as a contractual SLA until re-benchmarked here.]`

**Counter-metrics (do not optimize)**
- **SM-C1**: Number of Pages created per Ingest — more Pages ≠ better; prefer merge quality (FR-3).
- **SM-C2**: Todo Candidate count — extracting everything is failure; precision of approve-worthy Candidates matters (FR-26, FR-27).
- **SM-C3**: Chat token spend per question — do not “fix” quality by stuffing the whole Wiki into the prompt. Counterbalances FR-54 (budget, not dump).

## 8. Open Questions

Closed at PRD Finalize (Fast-path locks): Plaud **upload is P0**, OAuth is P1 (FR-31). Meeting extraction = Plaud-origin **or** user-marked meeting (FR-26). Preview is **view-first** + markdown escape hatch. Email v1 = **inbound address**. Agent host = **local sidecar** (FR-60, FR-36).

Closed at architecture (2026-08-12; `architecture-work-wiki-2026-08-12`):

1. **Deep Research default provider:** **Tavily**. SerpApi and SearXNG remain selectable in Settings (FR-67).
2. **MinerU default:** **Off**. Built-in PDF extract still runs. If enabled, first mode is **Local API**, not Cloud (FR-71).
3. **Retention:** Rejected Candidates and completed Todos persist until the owner deletes them. No TTL (FR-28).
4. **Multi-device:** Any Clerk-authenticated browser may use tree, Preview, and search. Chat, binary extract, loopback API, shell, and Skills require the sidecar on the **same machine** as the browser. Phone is browse-only.

No remaining open questions at this altitude.

## 9. Assumptions Index

- Stay on the existing Next.js / Cloudflare web stack; reshape UX rather than rewrite as Tauri.
- Clerk sign-in is sufficient identity for a single operator.
- Per-owner storage isolation from the fork is kept and tightened to private-by-default.
- Conversations, Settings, Review items, dismissed Insights, and project config are server-durable (not tab-only). Panel widths may persist locally.
- v1 allows multiple named Wikis for one operator, each created from a Scenario Template.
- Todos is an extra sidebar icon beyond the nashsu eight.
- SHA256 is the incremental Ingest cache.
- Ingest LLM calls are serial per Wiki; Chat may overlap.
- Failed Ingest auto-retries at most 3 times.
- English only (UI and LLM output). No Chinese generation or UI locale.
- Arrival via any Intake (upload, folder, email inbound address, direct connect, API/MCP) auto-queues Ingest. No OS folder-watch.
- Chat Agent runtime is backend Rust on a **local sidecar**; Workbench remains the web UI.
- Meeting Todo extraction runs for Plaud-origin or user-marked “meeting” only.
- Plaud **upload** is P0; in-app OAuth is P1.
- Preview is view-first; owner markdown edit is a confirm-gated escape hatch; no WYSIWYG in v1.
- v1 ships a work-wiki-branded Agent Skill pack that documents `/chat`; stock nashsu skill is read/rescan only.
- Relevance is a weighted sum of the four signals (missing signal = 0); weights are the v1 contract.
- Cancelled Ingest must not commit Page writes.
- Source delete is confirm-gated; cascade uses three-method matching (sources[], summary name, frontmatter section refs); shared entities are trimmed not deleted; index.md and dead wikilinks are cleaned; Todos with a deleted Source show source-missing.
- Bookmarklet/share + in-app URL Ingest counts as clipper parity.
- Tavily, SerpApi, and SearXNG are all in-scope; default active provider is Tavily; one is active at a time; unused keys may be stored.
- MinerU is off by default; if enabled, first mode is Local API.
- Rejected Candidates and completed Todos persist until owner delete (no TTL).
- Phone/other browsers are browse-only (tree, Preview, search). Chat, extract, loopback, shell, and Skills require the sidecar on the same machine as the browser.
- Dual Chat/Ingest models may use different providers (OpenAI, Anthropic, Google, Ollama, Custom).
- Settings persistence is durable for provider, API key, model, context size, language=English (Tauri Store on nashsu; server-side here).
- Vector search is off by default; embeddings endpoint/key/model are independent of Chat/Ingest.
- ANN backend is Cloudflare Vectorize (not LanceDB); cosine merge + fallback when off is the contract.
- Context budget split is 60% Pages / 20% chat history / 5% index / 15% system.
- History depth default is 10 messages; Settings-configurable; tighter of N vs 20% token budget wins.
- AnyTXT tool job on web may be Source full-text search.
- No blanket “allow all shells” in v1 default; external commands need per-command approval.
- Skill scan on Settings open and Workbench load.
- Prefer ingesting Plaud transcript and summary together.
- Schema remains markdown, not a form builder.
- Export is markdown/Obsidian-friendly archive.

## 10. Information Architecture

| Mode | Role |
|------|------|
| Wiki | Knowledge Tree of Pages; Preview; default Workbench |
| Sources | `raw/sources/` tree; folder import; progressive list; Intake arrivals auto-queue Ingest |
| Chat | **Center column** (not an icon). Agent runtime; Skills `/skill`; forms; workspace outputs; Thinking display; sidebar |
| Search | Retrieval pipeline over wiki/ + raw/sources/; optional vector; open in Preview |
| Graph | Force layout; Type/Community toggle; Louvain; Insights (surprise, gaps, bridges); click-highlight; Deep Research |
| Lint | Health report + auto-fix |
| Review | Async queue: Create Page / Deep Research / Skip only; ingest-time queries; does not block Ingest |
| Deep Research | Research Panel; confirm topic/queries; Tavily (default) / SerpApi / SearXNG; 3 concurrent; auto-Ingest |
| Todos | Extra icon: Candidates to approve/reject; open/done list |
| Settings | Models; context slider; vector; Schema; templates; Plaud; MinerU; Deep Research; **API + MCP** (token, loopback, copyable config) |

Left column toggles **Knowledge Tree** vs **File Tree**. Activity panel is global (visible during Ingest). Create-Wiki flow is the five Scenario Templates. Existing route-per-function nav (Browse / Ask / Ingest as separate pages) is replaced by this shell.

## 11. Platform

- **v1:** Web app (desktop browser primary) on the existing Cloudflare stack. Phone and other Clerk browsers may use tree, Preview, and search. Chat, binary extract, loopback API, shell, and Skills require the local sidecar on the same machine as the browser.
- **Agent sidecar:** Rust Agent, `:19828` API, MCP, shell, and document extractors run on a **local** sidecar. No dedicated remote Agent host in v1. Workbench does not execute shell in the Cloudflare isolate.
- **Not v1:** Native desktop, PWA-as-a-requirement (PWA share may remain as a Capture path).

## 12. Cross-Cutting NFRs

- **Reliability:** Ingest and Todo extraction are job-critical; failures are visible and retryable; Sources persist independently of compile success.
- **Privacy:** Private-by-default; no public reads of Christian’s Wiki; agent tokens scoped to his Wiki.
- **Integrity:** Citations required when coverage exists; disputed state is visible; no silent overwrite.
- **Observability:** Queue states, Ingest errors, and Todo decisions are inspectable.
- **Performance:** Chat streams; Ingest is async (Workbench stays interactive). `[ASSUMPTION: multi-minute Ingests are acceptable if the queue tells the truth.]`
- **Accessibility:** Keyboard can move between tree, Chat input, and Todo approve/reject. `[ASSUMPTION: WCAG AA is a target, not a certification gate.]`
- **Cost:** Skip-identical Ingest; Chat uses the Retrieval pipeline and budget (FR-54), not the whole Wiki.
- **Safety:** Chat must not invent citations. Todos must not auto-approve. Deep Research must not run unconfirmed. External shell must not run without approval (FR-65). Meeting transcripts stay private; export is owner-initiated.

## 14. Integration and Dependencies

- **Plaud:** Transcript + notes/summary as meeting Sources. **P0:** export/upload. **P1:** OAuth list/pull. Arrival auto-queues Ingest.
- **Email:** Inbound address; message/attachments become Sources (FR-41).
- **Office/PDF/ebooks/media:** Structured extract per FR-71; image preview + AV player (FR-72). Web clips via readability-style main-content Markdown (FR-25, FR-71).
- **Web Capture:** Bookmarklet / share / URL fetch; optional **Firecrawl** (key + custom Base URL).
- **LLM providers:** Configurable; Chat vs Ingest roles.
- **Web search:** Tavily (default), SerpApi (engine-selectable), or SearXNG (instance URL + categories) for Deep Research.
- **MCP/HTTP:** Local sidecar `127.0.0.1:19828` `/api/v1` (FR-76–78) plus MCP wrapping that surface; token and loopback rules in Settings → API + MCP.

Mechanism/transport (Cloudflare, R2, Vectorize, Clerk) lives in `addendum.md`.

## 15. Risks

| Risk | Mitigation |
|------|------------|
| Parity scope explodes (every nashsu extra) | Epic order §6.3: P0 job loop first; P1 Graph Insights / API / office |
| Todo extraction is noisy | Approve/reject gate; counter-metric SM-C2; Plaud-or-marked-meeting only |
| Public-by-default leftover from commons fork | FR-1 cut list is a release blocker |
| Office parse quality | Queue must fail clearly; FR-71 requires structured Markdown (not dump-to-text) |
| Job data loss | Immutable Sources + export (FR-37) + no silent queue drops (SM-3) |
| Agent/shell cannot run on Workers | Sidecar topology (FR-60, §11) |
