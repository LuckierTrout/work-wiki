# Google Stitch prompt — work-wiki Workbench

Paste into [Google Stitch](https://stitch.withgoogle.com). Upload the 16 screenshots in `imports/` as visual references. Match those screens — do not invent a new brand, landing page, or “AI product” costume.

After generation, save `DESIGN.md` and each screen HTML into:

`_bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/`

(HTML can go in `mockups/` or the folder root. Keep filenames obvious: `chat.html`, `review.html`, etc.)

---

## Product

**work-wiki** is a private personal compiled wiki for one operator (Christian). Desktop web app, ~1440×900. English only.

You drop in meeting transcripts, PDFs, decks, and URLs. An LLM compiles them into an interlinked markdown wiki. You chat with the wiki, review gaps, run deep research, and approve meeting todos. This is not a chatbot over files and not a public research lab.

**Match the attached screenshots** of the existing LLM Wiki desktop app (light workbench, dense, grayscale chrome, black primary buttons, green status, orange warning callouts, type-colored graph nodes). Recreate that density and information architecture on the web. Do not restyle it as a SaaS marketing site, a magazine, a fake terminal, or a metric dashboard.

Voice: precise, short, unsentimental. No emoji. No “Let’s get productive.” Empty states are instructional, not cute.

## Shell (every screen)

Far-left **icon rail** (~48px), light gray, 1px right border:

Top: Wiki (grid) · Chat · Sources (folder) · Search · Graph · Lint (clipboard) · **Todos** (checklist — extra vs screenshots; badge when candidates exist) · Review (badge “62”) · Deep Research (globe) · Skills (sparkles)

Bottom: green status dot · Settings (gear)

Do **not** omit Todos. Do **not** add Home/marketing.

Next column (~260–300px, drag-resize, min 200px): depends on mode (see screens). Bottom of this column: **Ingest Activity** — “Queue: 0/600”, paused, per-file rows (pending / processing Analysis|Generation / succeeded / failed), Resume / Cancel all. Visible whenever ingest is relevant (Wiki, Sources, Files). Collapsible.

Main canvas fills the rest. No top app bar except in-canvas titles.

Wiki title in the tree header: **work-wiki** (not “CHRISTIAN’S LLM WIKI”).

## Screens to generate

### 1. Chat (empty)

Icon: Chat active.

Left: **+ New Chat** button, then “No conversations yet.”

Center: empty state “Start a new conversation” / “Click New Chat to begin.”

Bottom composer (full width of canvas): placeholder “Type a message…”  
Tools in one row: Attach · Web search (can show on) · Skills · Smart retrieval dropdown · model dropdown (“Standard”) · send (disabled until text).

No Preview column on this screen (matches screenshot).

### 2. Wiki — Knowledge tree + Preview

Icon: Wiki/document active.

Left tabs: **Knowledge** | Files. Knowledge selected.

Tree grouped by type with counts: Overview (1), Entities (50), Concepts, Meetings, … realistic work names (entities like vendors/projects; not lorem).

Right: Preview of a selected Page — rendered markdown, view-first (no WYSIWYG toolbar). Frontmatter visible as a compact header (`title`, `sources: []`, `disputed` if true). Wikilinks look like links.

### 3. Files + empty Preview

Left: **Files** tab. Tree:

- `raw/` → `assets`, `sources`
- `wiki/` → `comparisons`, `concepts`, `decisions`, `entities`, `meetings`, `projects`, `queries`, `sources`, `stakeholders`, `synthesis`
- `index.md`, `log.md`

Button: not “Open project folder” (web app). Use **Import** / **Upload**.

Right: “Select a file to preview.”

Queue at bottom of left column, paused, 0/600, dated `combined` items.

### 4. Review + Deep Research (three columns)

Left: Files tree + queue (as screen 3).

Center: **Review** title + badge **62**. Toolbar: Refresh, Clear resolved, Select pending, Mark selected resolved, Dismiss selected.

Cards (warning or lightbulb): title, 2–3 sentence gap, wiki paths as `wiki/concepts/….md`, actions **Deep Research** · **Create Page** · **Skip** only. No other action buttons.

Right: **Deep Research** — topic field “Enter a research topic…” Empty: “No research tasks yet. Enter a topic above or click Deep Research in Review.”

### 5. Graph

Left: Files tree.

Main: force-directed graph, node sizes vary, labels on. Top stats: “231/234 pages · 55/55 links · 3 hidden”. Toolbar: Search, Filter, Reset, Type, Community, Insights (badge 9), refresh.

Legend bottom-left by type with counts and colors matching the screenshot (Concept purple, Entity blue, Source orange, Meeting magenta, Stakeholder brown, Project teal, etc.).

### 6. Search (empty)

Left: Files tree.

Main: search field “Search wiki pages… (Enter to search)”. Empty: “Press Enter to search.”

### 7. Lint (empty)

Left: Files tree.

Main: **Wiki Lint**. Centered checkmark, “Run lint to check wiki health”, “Checks for orphan pages, broken links, and more.” Toggle **Semantic (LLM)** off. Button **Run Lint**.

### 8. Sources list

Left: Files tree, Sources icon active.

Main: **Raw Sources** / `raw/sources`. Actions: Refresh, + Import, + Folder, URLs. Rows: timestamped `.md` names, grey **Ingested** tag, open + delete. Footer: “620 sources”.

### 9. Todos (new — not in screenshots)

Match Review card density. Title **Todos**. Two segments: **Candidates** | **Open**.

Candidate card: title, rationale one line, optional due date, links to meeting Source + Page. Actions: **Approve** · **Reject** only. Bulk approve/reject in toolbar.

Nothing auto-approved. Empty candidates: “No candidates. Meeting ingest will propose them.”

### 10. Settings — LLM Models

Settings uses a **second list sidebar** labeled SETTINGS (not the icon rail replacing it — icon rail stays; Settings list is the next column).

Categories (web mapping of the screenshots; English labels):

General · LLM Models · Embeddings · Image Captioning · External Information Sources · Network · **Intake** (replaces Source Folder Auto Watch — no OS folder-watch; upload/folder/email/API arrival) · Scheduled Import · MinerU PDF · API + MCP · Output · Interface · Maintenance · Changelog · About

**LLM Models** selected. Copy: “Configure built-in providers or add custom endpoints. Activating one deactivates the others; every provider keeps its own credentials.”

Checkbox: Use a project-specific model (unchecked).

Dropdowns: **Chat model** · **Ingest model** (can differ).

+ Add custom provider.

Provider cards with description, **configured** / **active** badge, toggle. Include OpenAI, Anthropic, Google, Ollama, Custom. Sticky footer: “Changes apply after saving” + black **Save**.

### 11. Settings — API + MCP

Same Settings chrome. Title **API + MCP**. Copy: “Expose this wiki to local tools through the HTTP API, and optionally MCP for agent clients.”

Card: Enable local HTTP API (checked). Warning callout (orange): Allow access without a token (unchecked). Status: Running. Base URL `http://127.0.0.1:19828`. Open /health.

Token field, show/hide, copy, **Generate new token**. Orange: “No token — every endpoint will return 401.”

Sticky Save bar.

### 12. Skills

Icon: sparkles. Title **Skills**. “Scan project and user skill folders, then choose which skills can be used from Chat.”

Scanned folders field: `.llm-wiki/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`.

Search. “12 enabled / 12 discovered”. Enable all · Disable all · Rescan.

Skill cards: name, source tag (CLAUDE / AGENTS), id, description, Enabled checkbox.

## Also emit

A **DESIGN.md** (Google Labs spec): YAML frontmatter tokens for colors, typography, rounded, spacing, components — **extracted from the screenshots**, not a new palette — plus Brand & Style, Colors, Typography, Layout, Components, Do’s and Don’ts.

## Hard don’ts

- No dark theme unless a second variant is requested
- No Chinese / i18n chrome
- No OS “watch this folder” as the primary intake story
- No WYSIWYG editor chrome on Preview
- No extra Review actions beyond Create Page / Deep Research / Skip
- No auto-approved Todos
- No public commons, billing, waitlist, or observer dashboard
- No lorem ipsum; use plausible work-wiki content (meetings, concepts, entities)
