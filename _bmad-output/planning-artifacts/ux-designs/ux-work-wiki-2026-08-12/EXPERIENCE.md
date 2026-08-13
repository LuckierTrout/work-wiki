---
name: work-wiki
status: final
sources:
  - {planning_artifacts}/prds/prd-work-wiki-2026-08-12/prd.md
  - {planning_artifacts}/prds/prd-work-wiki-2026-08-12/addendum.md
  - {planning_artifacts}/ux-designs/ux-work-wiki-2026-08-12/imports/
updated: 2026-08-12
---

# work-wiki — Experience Spine

Behavioral contract for the Workbench. Visual tokens live in `DESIGN.md`. Spines win on conflict with any mock or import.

Visual references (illustrative): `imports/16-chat-empty.png` (Chat empty), `mockups/chat-cited.html` (Chat + citations + docked Preview), `imports/15-knowledge-tree.png` (Wiki), `imports/11-files-empty-preview.png` (Files), `imports/14-raw-sources.png` (Sources), `imports/12-search-empty.png` (Search), `imports/13-knowledge-graph.png` (Graph), `imports/10-wiki-lint.png` (Lint), `imports/09-review-queue.png` / `imports/08-review-deep-research.png` (Review + Deep Research), `imports/07-skills.png` (Skills), `imports/04-settings-api-mcp.png` (Settings), `mockups/todos.html` (Todos), `mockups/create-wiki.html` (Create Wiki), `mockups/intake.html` (Intake). Screenshot mapping: `reconcile-nashsu-screenshots.md`.

## Foundation

**Desktop-primary web** (~1440×900). Next.js App Router + Tailwind 4 on Cloudflare Workers. **Not shadcn.** Do not inherit shadcn component names or defaults; chrome is custom, matching `imports/` nashsu screenshots.

v1 is a **single-operator** private job tool (Christian). One or more named Wikis. No multi-user, no public commons, no observer lab. English-only chrome and LLM generation.

The Agent, local HTTP API (`127.0.0.1:19828`), MCP, shell, and document extractors run on a **local sidecar**. The Workbench is the web shell; Chat fails closed if the sidecar is down.

`DESIGN.md` is the visual identity. This spine is how the shell works.

`[ASSUMPTION: light theme only in v1.]`
`[ASSUMPTION: existing Clerk sign-in is enough; no new identity chrome.]`

## Information Architecture

Icon rail (`{components.icon-rail}`) is always present. It **switches modes**; it does not stack every mode as simultaneous columns.

`[ASSUMPTION: match nashsu screenshots for mode chrome, not a literal always-on three-column of Tree | Chat | Preview. Preview docks as a third column when a tree selection or Chat citation is active. This is the Fast-path resolution of PRD FR-5 and §10 (“Chat is not an icon”) vs screenshot 16 (Chat is a rail icon; empty Chat has no Preview). Chat is a rail icon. Last-used mode persists (FR-8). First-run after Create Wiki lands on Wiki (screenshot 15).]`

Rail order, top → bottom: **Wiki · Chat · Sources · Search · Graph · Lint · Todos · Review · Deep Research · Skills**. Bottom: sidecar status · Settings · collapse chevron (left column).

| Surface | Reached from | Purpose |
|---|---|---|
| Create Wiki | First run / New Wiki in tree-header switcher | Pick one Scenario Template: **Research, Reading, Personal Growth, Business, General**. Writes `purpose.md` + Schema. No blank Wiki. → `mockups/create-wiki.html` |
| Wiki | Rail (grid) | Knowledge Tree or File Tree + Preview. Tabs **Knowledge \| Files**. Header title **work-wiki** is also the Wiki switcher. |
| Chat | Rail | Conversation list + composer/thread. Preview docks when a citation or output is opened. **Center of gravity** for asking, not a separate “Ask” page. → `mockups/chat-cited.html` |
| Sources | Rail (folder) | Progressive Raw Sources list (`raw/sources`). + Import, + Folder, URLs. |
| Search | Rail | Wiki + Source search; hit opens Preview. Image hits → lightbox + jump-to-source. |
| Graph | Rail | Force-directed graph; Type / Community / Insights. Node click → Preview. |
| Lint | Rail (clipboard) | Wiki health. Semantic (LLM) toggle. Run Lint. Mechanical auto-fix only. |
| Todos | Rail (checklist) — extra vs nashsu | **Candidates \| Open \| Done**. Approve/reject; due dates; links to meeting Source/Page. Badge = pending Candidates. → `mockups/todos.html` |
| Review | Rail (badge when pending) | Gap/warning cards. Closed actions: **Deep Research · Create Page · Skip**. |
| Deep Research | Rail (globe) or Review / Insights | Topic + queries confirm, then `{components.research-panel}`. |
| Skills | Rail (sparkles) | Scan/enable Skill folders; `/skill` in Chat uses this set. |
| Settings | Rail bottom (gear) | `{components.settings-nav}` + detail + sticky Save. |
| Sidecar status | Rail bottom (dot) | `{colors.accent-live}` when sidecar/API is running. Not a mode. |
| Capture | Bookmarklet / share / in-app URL (Sources or Intake) | Web page or selection → Source → auto-queue Ingest. Not a rail icon. |
| Clerk sign-in | Unauthenticated visit | Existing Clerk. No public write. |

**Not in the rail:** Home, marketing, billing, waitlist, observer dashboard, `synthesis/` or `comparisons/` as extra icons (those dirs may exist in the File Tree).

**Activity (Ingest queue)** docks **under the left column** on Wiki, Sources, and Files — not a fourth full-height column. Collapsible. Queue N/M, paused/running, Resume / Cancel all, per-file Analysis \| Generation \| pending \| succeeded \| skipped \| failed. Visible whenever Ingest is relevant; collapsible otherwise.

**Settings nav:** General · LLM Models · Embeddings · Image Captioning · External Information Sources · Network · **Intake** · Scheduled Import · MinerU PDF · API + MCP · Output · Interface · Maintenance · Changelog · About.

`[ASSUMPTION: Intake replaces nashsu “Source Folder Auto Watch.” No OS folder-watch. Arrival paths: upload, recursive folder import, inbound email address, Plaud/direct connect, API/MCP, Capture bookmarklet/share.]`

IA closes when UJ-1–UJ-6 plus Create Wiki and Capture land on a surface above.

## Voice and Tone

Microcopy. Brand posture lives in `DESIGN.md` Brand & Style.

| Do | Don't |
|---|---|
| “Select a file to preview.” | “Let’s get started! 🚀” |
| “No candidates. Meeting ingest will propose them.” | “You’re all caught up — great job!” |
| “Wiki has no coverage for this. Ingest a source or run Deep Research.” | Fake citations or a confident empty answer |
| “Ingest failed. Source is stored. Retry.” | “Something went wrong.” with no next step |
| “Changes apply after saving” | Toast spam on every keystroke |
| “No token — every endpoint will return 401.” | Soften privacy/auth warnings |
| “This Source is not a meeting. Mark as meeting to extract Todos.” | Auto-extract Todos from every PDF |
| English labels, short verbs | Chinese chrome, emoji empty states, confetti |

## Component Patterns

Behavioral. Visual specs: `DESIGN.md.Components`. Names match that table.

| Component | Use | Behavioral rules |
|---|---|---|
| button-primary | Global | One primary per cluster (Save, New Chat, Run Lint, Generate token). Never a second filled color. |
| button-ghost | Global | Secondary: Refresh, Skip, Rescan, Clear resolved. |
| button-destructive | Global | Cancel all, delete Source, Reject. Confirm before delete. |
| icon-rail | Global | One active mode. Click does not destroy Conversations or unsaved composer text. Count badges on Review and Todos when non-zero. Status dot is not a mode. Collapse chevron hides/shows the left column; state persists (FR-8). |
| tree-panel | Wiki, and as left column on Sources/Search/Graph/Lint/Review | Knowledge \| Files tabs are distinct views. Selection + scroll persist across collapse, mode switch, and reload. Wiki title is a switcher (multiple named Wikis) plus **New Wiki**. No “Open project folder” — **Import / Upload** instead. |
| conversation-sidebar | Chat | + New Chat. Rename/delete. Active session distinct. Composer is **per-Conversation**; switching does not silently apply unsaved text to another session. |
| composer | Chat | Placeholder “Type a message…”. Tools: Attach · Web search · **AnyTXT** · Skills · **Smart retrieval** · model · send (disabled until text). Send streams from the sidecar Agent. **Smart retrieval** includes Wiki (default) and **Sources-only** (FR-16) — Sources-only must be visibly distinct. |
| cited-references-panel | Assistant message | Collapsible; grouped by page type with icons. `[n]` and panel rows open Preview. Stored on the message. No fake panel when coverage is missing. |
| thinking-block | Assistant message | During stream: 5-line rolling viewport, newer lines more opaque. After: collapsed by default. Hidden if the model emits none. Not included in Save to Wiki. |
| tool-call-row | Assistant message | Name + outcome visible. Workspace outputs as chips under `agent-workspace/`; open in Preview. |
| skill-form | Chat | Single/multi choice or free text from any Skill. Chat waits until submit or cancel. Cancel does not run the pending tool. |
| shell-approval | Chat | Project-workspace commands run without a prompt. External commands: explicit Approve / Deny per command. No blanket “allow all” default. |
| preview | Wiki, Chat citation, Graph, Search, Todos, outputs | **View-first** GFM (bordered tables, code, `[[wikilinks]]`, Mermaid, KaTeX). Frontmatter compact header in `{typography.ui}` (`title`, `sources: []`, `disputed` if true). Page body `{typography.preview}` (Georgia); headings `{typography.preview-heading}`. Markdown edit is a **confirm-gated** escape hatch; next Ingest may overwrite. Not WYSIWYG. Images native; click → lightbox. Video/audio play in-pane (FR-72). Chat answers stay `{typography.ui}`. |
| activity-row | Left-column dock | One row per queue file. Cancel / retry. Failed shows error + retry; retry does not duplicate the Source. Cancel must not commit Page writes. SHA256 skip shows **skipped**. |
| review-card | Review | Warning or lightbulb icon only. Paths as `wiki/…md`. Closed set: Deep Research · Create Page · Skip. `[ASSUMPTION: Deep Research is shown when the item has stored search queries; otherwise Create Page + Skip only. No model-invented extra buttons.]` Skip writes nothing. Create Page is a constrained Ingest/Generation, not a free editor. Toolbar: Refresh, Clear resolved, Select pending, Mark selected resolved, Dismiss selected. |
| todo-card | Todos → Candidates | Title, one-line rationale, optional due, speaker/context if present, links to Source + Page. **Approve · Reject** only. Nothing auto-approves. Bulk in toolbar. Rejected stay for audit, never in Open. |
| todo-card (Open / Done) | Todos | Filter/sort by due and status. Edit title/due after approval without breaking links. Complete keeps links. Source-missing if the Source was deleted. |
| graph-canvas | Graph | √ node size by degree. Type or Community coloring. Edge strong/weak. Hover: neighbors stay, others dim, Relevance label on incident edges. Zoom in / out / Fit. Position cache survives dataVersion refresh. Insights open without a separate analyze click. Click Insight → highlight; click again → deselect. Dismissed Insights stay dismissed until structure changes. Cohesion < 0.15 warned in Community legend. |
| warning-callout | Settings | Unauthenticated API, MinerU cloud upload. Sticky Save required before apply. |
| save-bar | Settings | Unsaved changes do not apply until Save. |
| empty-state | Any canvas | One instructional sentence + optional single primary action. No illustration, no emoji. |
| lightbox | Search images, Preview images | Overlay; jump-to-source opens the containing Page or Source. Esc closes. |
| research-panel | Deep Research | Dynamic height; streams queries/fetches/synthesis. Up to **3 concurrent** tasks, distinguishable. Fourth waits. Thinking collapsible; viewport follows newest line. Success writes a research Page and **auto-Ingests**. Failed synthesis does not auto-Ingest. Independent of the serial Ingest queue. |
| confirm-dialog | Deep Research, Preview edit, Source delete, template switch | One level. Deep Research: editable **topic + query list**; ≥1 query required; Cancel starts nothing. Source delete is confirm-gated (FR-12). Applying a different Scenario Template later is confirm-gated and overwrites purpose/Schema only. |
| settings-nav | Settings | Second list. Active category gray wash. |
| badge-count | Rail, Review title | Accessible name includes the count and noun (“62 pending reviews”). Hidden at 0. |

**Chat message actions (not separate components):** **Save to Wiki** writes `wiki/queries/` then auto-Ingests (main response only). **Regenerate** removes the last assistant+user pair and re-sends; no-op if empty.

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| Signed out | Any | Clerk sign-in. Capture without a session fails closed. |
| Cold load | Workbench | Skeleton matching tree + canvas. Restore last mode, widths, selection, Conversation (FR-8). |
| First run / no Wiki | Create Wiki | Five named templates only. After create, land on Wiki empty Preview. |
| Chat empty | Chat | “Start a new conversation. Click New Chat to begin.” Composer visible. No Preview until citation or tree pick. → `imports/16-chat-empty.png` |
| Wiki empty Preview | Wiki / Files | “Select a file to preview.” → `imports/15-knowledge-tree.png`, `imports/11-files-empty-preview.png` |
| Search empty | Search | “Press Enter to search.” Empty query does not error. → `imports/12-search-empty.png` |
| Search results | Search | Ranked hits; image section when hits include images. |
| Lint idle | Lint | Checkmark + “Run lint to check wiki health.” Semantic toggle off by default. → `imports/10-wiki-lint.png` |
| Lint results | Lint | Issues with links to Pages. Auto-fix **only** for renamed-slug wikilinks, dangling `[[slug]]` after delete, `index.md` drift. No auto-fix for `disputed`. |
| Review empty | Review | No pending cards. Badge hidden. |
| Review pending | Review | Cards + badge. Ingest may show **succeeded** while Review still has items. → `imports/09-review-queue.png` |
| Deep Research empty | Deep Research | “No research tasks yet. Enter a topic above or click Deep Research in Review.” → `imports/08-review-deep-research.png` |
| Deep Research running | research-panel | Stream progress; 3-slot cap; fourth waits. |
| Todos empty Candidates | Todos | “No candidates. Meeting ingest will propose them.” Meeting Ingest that finds none still updates this list (“none found”). |
| Todos Open empty | Todos | Open list empty; Candidates/Done may still have items. |
| Ingest running | Activity | Per-file Analysis then Generation. Progress = queue depth + active step. Workbench stays interactive. |
| Ingest skipped (same SHA256) | Activity | Row shows skipped; no LLM spend. |
| Ingest failed | Activity | Source still stored. Auto-retry up to 3, then failed + Retry. **No Todo Candidates from a failed compile.** Unsupported type: visible fail, never silent drop. |
| Coverage missing | Chat | State that the wiki has no coverage; offer Ingest or Deep Research. No hallucinated citations. |
| Sources-only Chat | Chat | Mode visible on Smart retrieval. Citations point at Sources, not concept Pages. |
| Sidecar down | Chat / status | Fail closed (start sidecar / check `:19828`). Status dot not live. Not a client-side stub. |
| API unauthenticated | Settings → API + MCP | Orange callout. Generate token. Missing token → 401; UI says so. API off → 503 `"disabled"` on data routes; `/health` still works. |
| `disputed: true` | Preview, Lint | Visible. Mechanical auto-fix does not clear it. |
| Source deleted | Todos, trees | Confirm first. Cascade per FR-12. Linked Todos show source-missing. |
| Mark as meeting | Sources / Preview | Non-Plaud Sources default off for Todo extraction. Explicit **Mark as meeting** enables FR-26. |
| Deep Research confirm | confirm-dialog | Editable topic + queries. Unconfirmed bulk research does not start. |
| Offline / queue durable | Activity | Queue survives reload. No silent loss. |
| dataVersion | Graph, trees, Preview | After Ingest commits, UI refreshes without a full reload; Graph does not re-scatter (position cache). |
| Progressive Sources | Sources | Large `raw/sources/` trees render while scrolling (FR-44). |
| Missing wikilink | Preview / Chat | Missing-link state; does not navigate to a blank Page silently. |
| Vector search misconfigured | Search / Chat | Phase fails visibly; fall back to tokenized + graph. Do not blank Chat. |
| LLM credentials missing | Chat / Settings | Actionable Settings error, not a blank Chat. |

## Interaction Primitives

**Pointer-first Workbench** with keyboard where it is already a nashsu habit.

- Click rail icon → switch mode; persist Chat input.
- Drag splitters → resize; stop at `{spacing.split-min-chat}` / `{spacing.split-min-tree}` / `{spacing.split-min-preview}`. Widths persist.
- Click tree item / Search hit / Graph node / citation `[n]` / Todo link → Preview that Page or Source.
- `[[wikilink]]` in Chat or Preview → open that Page, or missing-link state.
- Drag-drop files onto the shell → store under `raw/sources/` and **auto-queue** two-step Ingest (no second “process this”).
- Enter in Search → run search. Enter in composer → send.
- Esc → close lightbox, confirm dialog, Skill form, shell-approval, or Preview edit without stacking a second modal.
- `/skill` in composer → complete enabled Skill names only.
- Tab order: rail → left column → canvas → Preview → Activity. Primary card actions (Approve / Reject / Skip) are in the tab order — not hover-only.

**Banned in v1:** WYSIWYG as default Preview; OS folder-watch as Intake; auto-approve Todos; modal stacks deeper than one; hover-only Approve/Reject; dark theme; i18n chrome; LAN/`0.0.0.0` API bind; Clip-server port 19827; extra Review actions.

## Accessibility Floor

Behavioral. Contrast lives in `DESIGN.md`.

- WCAG 2.2 AA on chrome (rail, trees, cards, Settings). `[ASSUMPTION: AA is a target, not a certification gate.]` Graph is a visualization: legend + Insights cards so the job is not color-only.
- Focus order: rail → left column → canvas → Preview → Activity. Visible focus ring on `{colors.foreground}` against `{colors.surface}`.
- Mode change announces the surface name (“Chat”, “Todos”, “Settings, LLM Models”).
- Count badges have accessible names (“62 pending reviews”, “3 todo candidates”), not color alone.
- Composer, Search, and Settings inputs are labeled; placeholder is not the only label.
- Streaming Chat: `aria-live` polite for the answer; Thinking viewport is optional to announce (collapsed after).
- Keyboard: Tab through cards’ Approve/Reject/Skip; tree, Chat input, and Todo actions are reachable without a pointer (PRD §12).
- Motion: Thinking fade and graph layout are the only continuous motion; respect `prefers-reduced-motion` (static last thinking lines; Graph jumps to cached positions).

`[ASSUMPTION: v1 does not ship a dedicated screen-reader Graph explorer beyond legend + Insights + Preview-on-node.]`

## Responsive & Platform

| Breakpoint | Behavior |
|---|---|
| ≥ ~1200px (primary) | Full Workbench: rail + mode column + canvas (+ Preview when docked). |
| ~900–1199px | Trees/Preview at min widths; Chat keeps ≥ 320px; Activity collapsed by default. |
| < ~900px | Chat + Todos usable. Rail becomes a sheet. Graph is not the job surface. Preview stacks under Chat. |

`[ASSUMPTION: no dedicated phone IA in v1. Tablet is a stacked Workbench, not a separate product. Multi-device same Wiki is an open PRD question — desktop browser is the contract.]`

Platform: **browser**. Local sidecar required for Agent/API/MCP/shell. Cloud façade may mirror `/api/v1` behind operator auth; the loopback bind stays `127.0.0.1:19828`.

## Inspiration & Anti-patterns

- **Lifted from nashsu/llm_wiki (`imports/`):** icon-mode rail, dense light chrome, black primary, Settings second list + Save bar, Review cards, Graph Type/Community/Insights, Chat conversation list + composer tools (including AnyTXT), Skills scan list, Activity under the tree, Knowledge \| Files tabs.
- **Lifted from Karpathy LLM Wiki pattern:** compile-once Pages, immutable Sources, Chat cites compiled wiki not raw RAG chunks.
- **Added vs nashsu:** Todos rail icon; Intake instead of OS watch; web upload/email/Plaud; sidecar topology in Settings → API + MCP; Create Wiki templates; Capture bookmarklet (no Clip server).
- **Rejected — restyle:** SaaS marketing, magazine Preview, fake terminal, metric dashboard as home, dark “AI” costume, colored primary buttons.
- **Rejected — OS folder-watch** and **Open project folder** (desktop Finder). Web: Import / Upload.
- **Rejected — `0.0.0.0` / LAN bind and Clip server** (screenshot 04). Loopback only; Capture is bookmarklet/share/in-app URL.
- **Rejected — WYSIWYG** (Milkdown) as default Preview.
- **Rejected — auto-approved Todos** and extra Review actions beyond Create Page / Deep Research / Skip.
- **Rejected — public commons / observer lab / billing / waitlist.**
- **Rejected — shadcn inheritance.** Existing app is Tailwind 4 custom chrome.
- **Rejected — Chat as a hidden non-icon column** (PRD §10). Screenshots win: Chat is a rail icon.

## Intake & Settings

Invented section — Settings catalog is load-bearing and is not a Key Flow by itself.

**Intake** (replaces Source Watch): inbound email address (copy); Plaud **upload** (P0) and OAuth list/pull (P1); Capture bookmarklet snippet; allowed file-type grid (keep from screenshot 01); concurrent **parsers** (screenshot 01) vs **serial Ingest LLM** (FR-39) — parsers may run ahead, Generation stays serial; optional keep parsed Markdown under `raw/parsed`; auto-queue on arrival is **always on** (no “watch folder” toggle). → `mockups/intake.html`

**LLM Models:** Chat model and Ingest model independent. Providers: OpenAI, Anthropic, Google, Ollama, Custom. Activating one provider deactivates others; credentials kept per provider. Context-window slider 4K–1M. History depth N default 10. LLM timeout configurable.

**Embeddings:** Vector search **off by default**. Independent endpoint, key, model. Cannot enable without all three.

**External Information Sources / Deep Research keys:** Tavily, SerpApi (engine), SearXNG (URL + categories). One active provider. `[OPEN: which provider is the out-of-the-box default — do not invent.]` Optional Firecrawl key + custom Base URL.

**MinerU PDF:** Cloud / Local API / Pipeline. Warning if Cloud uploads documents. `[OPEN: off vs on default — do not invent. Built-in PDF extract still works when MinerU is off.]`

**API + MCP:** Enable local HTTP API; **do not** offer unauthenticated access as the default; **do not** offer LAN/`0.0.0.0`. Status + Base URL `http://127.0.0.1:19828` + Open `/health`. Token show/hide/copy/Generate. Copyable MCP client config. Install command for the llm-wiki Agent Skill. Env `LLM_WIKI_API_TOKEN` overrides the field.

**Interface:** Language persisted **English** only. No locale picker.

**Maintenance:** ZIP export / import; deterministic rebuild of `wiki/index.md`. Export includes Pages, Sources, Todos, chat record-shape, `.obsidian/`.

**Schema / purpose:** Editable from Settings (General or a Schema row) **or** the File Tree (`purpose.md`, `schema.md`). Markdown, not a form builder. Invalid Schema errors visibly on next Ingest. Changing Scenario Template later is confirm-gated.

## Key Flows

Protagonist: **Christian**, sole operator, using this as a private job tool. Names match PRD UJ-1–UJ-6.

### Flow 1 — Plaud meeting to wiki + Todos (UJ-1)

1. Christian finishes a meeting. Workbench is open on his private wiki.
2. He uploads transcript + summary (P0) — or later pulls via Plaud OAuth (P1) — or drops them via email/folder. Arrival stores Sources and **auto-queues** Ingest.
3. Activity shows Analysis, then Generation. Meeting Source summary and related concept Pages compile. `overview.md` regenerates.
4. Todos badge appears. Candidates list titles, rationales, optional dues, links to the transcript and meeting Page. (If none: list shows “none found.”)
5. **Climax:** He approves the real actions and rejects the rest. Nothing was auto-approved. Each approved Todo still links back.
6. Resolution: wiki is current; Open Todos are the working list.
7. **Edge:** Ingest fails — Source remains; queue shows failed + Retry; **no Candidates invented**. Non-Plaud file: no Candidates unless he **marks it meeting**.

### Flow 2 — Ask the wiki, not the pile (UJ-2)

1. Mid-week, Christian needs “what did we decide about X?”
2. Chat mode: existing or New Chat. He types; sidecar Agent retrieves and answers with `[n]` citations.
3. He expands the references panel, clicks a citation; Preview docks on that Page.
4. **Climax:** He acts from the cited Page without reopening Plaud. Optionally **Save to Wiki** → `wiki/queries/` → auto-Ingest.
5. **Edge:** No coverage — Chat says so and offers Ingest or Deep Research, not a hallucinated answer. Sidecar down — fail closed. Sources-only mode cites raw Sources when he needs “what did they actually say.”

### Flow 3 — Dump a deck, get knowledge (UJ-3)

1. A PPT/PDF/URL arrives. He drags it onto the shell, uses + Import / + Folder / URLs, or Capture (bookmarklet/share).
2. Serial queue: one row per file. Same SHA256 skips LLM. Folder path is classification context.
3. **Climax:** Preview shows the new/updated Page with `sources: []` pointing at the file/URL.
4. Search and Chat can use it. Failed file retries up to 3, then sits failed. Unsupported type fails visibly.

### Flow 4 — Wiki health when something feels off (UJ-4)

1. A Page looks stale or two meetings disagree. He opens Lint and/or Graph Insights.
2. Insights: Surprising Connections and Knowledge Gaps (isolated, sparse Community, Bridge). Clicking a card highlights nodes/edges. `disputed: true` stays visible. He can dismiss a connection.
3. **Climax:** He sees *why* a claim is disputed and which clusters are weakly linked.
4. He confirms Deep Research (editable topic + queries) or Create Page from Review. He does not hand-rewrite the wiki.
5. **Edge:** Cancel confirm starts no research. Mechanical Lint auto-fix does not clear disputed.

### Flow 5 — Morning Todos (UJ-5)

1. Several approved Todos are due this week. He opens Todos → Open, filters by due.
2. He opens a link; Preview shows the meeting Page or transcript.
3. **Climax:** Nothing important from last week’s Plaud notes lives only in his head.
4. He marks complete; links remain. Rejected Candidates never appear here. Source-missing Todos stay inspectable.

### Flow 6 — Agent Skill from the editor (UJ-6)

1. Sidecar is running (green status). Settings → API + MCP: API on, token set, bind `127.0.0.1:19828`.
2. From Claude Code / Codex he uses the llm-wiki skill against that API (names “my wiki”). Agent probes `/health`, searches, reads cited paths.
3. **Climax:** The answer cites wiki page paths he can open in Preview. Read-only except rescan.
4. **Edge:** App/sidecar not running → connection refused, not a hallucinated wiki. `port_conflict` → another process owns 19828.

### Flow 7 — Create Wiki from a Scenario Template (FR-38)

1. Christian has no Wiki, or chooses New Wiki from the tree-header switcher.
2. He must pick exactly one of: Research, Reading, Personal Growth, Business, General.
3. **Climax:** `purpose.md` and Schema exist and differ by template. Workbench opens on Wiki.
4. **Edge:** Applying a different template later confirms and overwrites purpose/Schema only — not Pages or Sources.
