---
name: work-wiki
description: Private personal compiled wiki Workbench — nashsu/llm_wiki visual parity on the web.
status: final
created: 2026-08-12
updated: 2026-08-12
colors:
  surface: '#FFFFFF'
  surface-subtle: '#FAFAFA'
  surface-rail: '#FAFAFA'
  foreground: '#171717'
  muted: '#737373'
  border: '#E5E5E5'
  primary: '#171717'
  primary-foreground: '#FFFFFF'
  accent-live: '#16A34A'
  warning: '#D97706'
  warning-surface: '#FFF7ED'
  destructive: '#DC2626'
  badge: '#171717'
  badge-foreground: '#FFFFFF'
  overlay: '#17171766'
  graph-entity: '#3B82F6'
  graph-concept: '#A78BFA'
  graph-source: '#F97316'
  graph-meeting: '#E879F9'
  graph-stakeholder: '#B45309'
  graph-project: '#14B8A6'
  graph-decision: '#F472B6'
  graph-overview: '#EAB308'
  graph-other: '#9CA3AF'
  graph-edge-strong: '#16A34A'
  graph-edge-weak: '#D4D4D4'
  graph-community-01: '#4E79A7'
  graph-community-02: '#F28E2B'
  graph-community-03: '#E15759'
  graph-community-04: '#76B7B2'
  graph-community-05: '#59A14F'
  graph-community-06: '#EDC948'
  graph-community-07: '#B07AA1'
  graph-community-08: '#FF9DA7'
  graph-community-09: '#9C755F'
  graph-community-10: '#BAB0AC'
  graph-community-11: '#D37295'
  graph-community-12: '#A0CBE8'
typography:
  ui:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.45'
  ui-strong:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: 13px
    fontWeight: '600'
    lineHeight: '1.45'
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.3'
  preview:
    fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif'
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.65'
  preview-heading:
    fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif'
    fontSize: 22px
    fontWeight: '600'
    lineHeight: '1.3'
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.5'
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  rail: 48px
  tree: 280px
  settings-nav: 220px
  split-min-tree: 200px
  split-min-chat: 320px
  split-min-preview: 200px
components:
  button-primary:
    background: '{colors.primary}'
    foreground: '{colors.primary-foreground}'
    radius: '{rounded.md}'
  button-ghost:
    background: transparent
    foreground: '{colors.foreground}'
    radius: '{rounded.md}'
  button-destructive:
    background: transparent
    foreground: '{colors.destructive}'
    radius: '{rounded.md}'
  icon-rail:
    background: '{colors.surface-rail}'
    width: '{spacing.rail}'
    border: '{colors.border}'
  tree-panel:
    background: '{colors.surface}'
    width: '{spacing.tree}'
    border: '{colors.border}'
  conversation-sidebar:
    background: '{colors.surface}'
    width: '{spacing.tree}'
    border: '{colors.border}'
  composer:
    background: '{colors.surface}'
    border: '{colors.border}'
    radius: '{rounded.lg}'
  cited-references-panel:
    background: '{colors.surface-subtle}'
    border: '{colors.border}'
    radius: '{rounded.md}'
  thinking-block:
    foreground: '{colors.muted}'
    fontFamily: '{typography.mono.fontFamily}'
  tool-call-row:
    background: '{colors.surface-subtle}'
    border: '{colors.border}'
    radius: '{rounded.sm}'
  skill-form:
    background: '{colors.surface}'
    border: '{colors.border}'
    radius: '{rounded.md}'
  shell-approval:
    background: '{colors.surface}'
    border: '{colors.warning}'
    radius: '{rounded.md}'
  preview:
    background: '{colors.surface}'
    foreground: '{colors.foreground}'
    fontFamily: '{typography.preview.fontFamily}'
  activity-row:
    background: '{colors.surface}'
    border: '{colors.border}'
  review-card:
    background: '{colors.surface}'
    border: '{colors.border}'
    radius: '{rounded.md}'
  todo-card:
    background: '{colors.surface}'
    border: '{colors.border}'
    radius: '{rounded.md}'
  graph-canvas:
    background: '{colors.surface}'
  warning-callout:
    background: '{colors.warning-surface}'
    foreground: '{colors.foreground}'
    border: '{colors.warning}'
  save-bar:
    background: '{colors.surface}'
    border: '{colors.border}'
  badge-count:
    background: '{colors.badge}'
    foreground: '{colors.badge-foreground}'
    radius: '{rounded.full}'
  empty-state:
    foreground: '{colors.muted}'
  lightbox:
    overlay: '{colors.overlay}'
    background: '{colors.surface}'
  research-panel:
    background: '{colors.surface}'
    border: '{colors.border}'
  confirm-dialog:
    overlay: '{colors.overlay}'
    background: '{colors.surface}'
    radius: '{rounded.lg}'
  settings-nav:
    background: '{colors.surface}'
    width: '{spacing.settings-nav}'
    border: '{colors.border}'
---

# work-wiki — Design Spine

Visual identity: nashsu Workbench density and layout from `imports/`. Type: SF chrome + Georgia Preview (user pick). Color: theme A — nashsu-sampled light gray, black primary (user confirmed). `[ASSUMPTION: light theme only in v1; no dark tokens until asked.]`

Spines win on conflict with any mock or import.

Visual references (illustrative; this spine wins): `imports/16-chat-empty.png`, `imports/15-knowledge-tree.png`, `imports/11-files-empty-preview.png`, `imports/08-review-deep-research.png`, `imports/13-knowledge-graph.png`, `imports/04-settings-api-mcp.png`. Key-screen mocks: `mockups/todos.html`, `mockups/create-wiki.html`, `mockups/intake.html`, `mockups/chat-cited.html`. Full mapping: `reconcile-nashsu-screenshots.md`.

## Brand & Style

work-wiki is a **working lab**, not a product landing page. Chrome is quiet: near-white surfaces, hairline borders, black primary actions, **system sans (SF / Segoe)**. Density is high — trees, queues, and cards carry the job, not hero type. **Preview body is Georgia** so compiled Pages read as documents; that serif does not leak into the rail, trees, Chat, or Settings.

Voice in the chrome is the same as the PRD: precise, evidence-rich, unsentimental. No display serif in chrome, no gradient mesh, no fake terminal, no metric dashboard as home.

The graph is the only place color is categorical (page type or Community). Everywhere else, color means **state**: green = live/sidecar up, amber = warning, red = destructive, black pill = count.

Wiki title in the tree header is **work-wiki**, not “CHRISTIAN’S LLM WIKI”.

## Colors

- **`{colors.surface}` / `{colors.surface-subtle}` / `{colors.surface-rail}`** — canvas, panels, icon rail. Sampled from screenshots (~`#FAFAFA` rail, `#FFFFFF` canvas).
- **`{colors.foreground}` / `{colors.muted}`** — primary copy vs helper/empty-state.
- **`{colors.border}`** — 1px splitters and cards.
- **`{colors.primary}`** — Save, New Chat, Run Lint, Generate token. Black fill, white label. Not a brand navy.
- **`{colors.accent-live}`** — status dot only (sidecar/API running). Not used as a marketing accent. Graph edge green is `{colors.graph-edge-strong}` in Graph only — do not treat the status dot as a graph color.
- **`{colors.warning}` + `{colors.warning-surface}`** — Settings callouts (unauthenticated API, MinerU cloud upload).
- **`{colors.destructive}`** — Cancel all, delete Source, reject Candidate. Text or ghost control, not a filled red bar.
- **`{colors.overlay}`** — one-level dim behind confirm dialogs and the lightbox.
- **Graph type tokens** — Entity, Concept, Source, Meeting, Stakeholder, Project, Decision, Overview, Other. Legend in Graph Type mode only. `[ASSUMPTION: hex values approximate the screenshot legend; tune to pixel-match if a later mock disagrees.]`
- **Graph Community tokens** `{colors.graph-community-01}`–`{colors.graph-community-12}` — Louvain coloring; reuse after 12. Not used in chrome.
- **Graph edges** — `{colors.graph-edge-strong}` / `{colors.graph-edge-weak}` for Relevance thickness/color.

Do not add a second brand hue. Do not use graph colors in Settings or Chat chrome. Nashsu Settings checkboxes render platform-blue when checked — **do not promote that blue to a brand token**; native form controls may keep platform accent.

**Contrast (WCAG 2.2 AA targets):** `{colors.foreground}` on `{colors.surface}` ≥ 12:1. `{colors.muted}` on `{colors.surface}` ≥ 4.5:1 for helper text. `{colors.primary-foreground}` on `{colors.primary}` ≥ 12:1. `{colors.destructive}` on `{colors.surface}` ≥ 4.5:1. `{colors.warning}` is not body text — pair with `{colors.foreground}` on `{colors.warning-surface}`. `{colors.accent-live}` is a ≥8px status dot, not small text.

## Typography

**Locked (user pick, type pairing 4):** system UI sans for chrome; Georgia for Preview reading text.

- `{typography.ui}` / `{typography.ui-strong}` — rail, trees, cards, Settings, Chat, composer, Preview chrome (header, frontmatter, Edit).
- `{typography.title}` — surface titles (Review, Wiki Lint, Skills, Todos). Still sans.
- `{typography.preview}` — rendered Page **body** in the Preview column (16px / 1.65).
- `{typography.preview-heading}` — rendered Page headings in Preview only.
- `{typography.mono}` — paths (`wiki/concepts/….md`), token fields, code fences.
- Chat answers stay `{typography.ui}`, not Georgia. Empty Preview copy (“Select a file to preview.”) is chrome, not Georgia.
- No display serif. No marketing scale. Georgia is a document face, not a brand display.

## Layout & Spacing

Desktop Workbench (~1440×900 primary). Icon rail `{spacing.rail}` always. Next column is the mode panel (tree, conversation list, or Settings nav), default `{spacing.tree}`, drag-resize, min `{spacing.split-min-tree}`. Chat canvas min `{spacing.split-min-chat}`; Preview min `{spacing.split-min-preview}` (PRD FR-6).

Activity/queue docks **under the left column**, not as a fourth full-height column. Settings uses `{components.settings-nav}` plus a sticky Save bar.

Mobile: Chat + Todos usable; Graph is not the job surface. `[ASSUMPTION: no dedicated phone IA in v1; stack rail into a sheet if the viewport is below ~900px.]`

## Elevation & Depth

Almost none. Cards are bordered, not shadowed. Hover is a light `{colors.surface-subtle}` fill. Active icon / Settings row is a slightly darker gray wash. Modals (confirm Preview edit, Deep Research confirm, shell approval, Source delete) are one level of `{colors.overlay}` + `{components.confirm-dialog}` — no stacked dialogs.

## Shapes

Tight tool radii: `{rounded.sm}` inputs, `{rounded.md}` buttons/cards, `{rounded.full}` count badges and the status dot. No large “consumer app” rounding.

## Components

| Component | Anatomy / color / size |
|---|---|
| **icon-rail** `{components.icon-rail}` | 48px. Active icon = filled rounded square in `{colors.foreground}` wash, not a hue change. `{components.badge-count}` on Review and Todos when non-zero. Bottom: `{colors.accent-live}` dot, Settings, collapse chevron. |
| **button-primary** `{components.button-primary}` | Black fill, white label, `{rounded.md}`. Save, New Chat, Run Lint, Generate token, Enable all. |
| **button-ghost** `{components.button-ghost}` | Transparent; Refresh, Skip, Rescan, Clear resolved. |
| **button-destructive** `{components.button-destructive}` | `{colors.destructive}` label, no red fill. Cancel all, delete, Reject. |
| **tree-panel** `{components.tree-panel}` | Knowledge \| Files tabs; title **work-wiki**; `{typography.ui}`. |
| **conversation-sidebar** `{components.conversation-sidebar}` | + New Chat (primary) then session list. Active row `{colors.surface-subtle}`. |
| **composer** `{components.composer}` | Bordered rounded field. Tool row: Attach · Web search · AnyTXT · Skills · Smart retrieval · model · send. Send muted until text. |
| **cited-references-panel** `{components.cited-references-panel}` | Collapsed by default after the answer. Type icons; mono paths. |
| **thinking-block** `{components.thinking-block}` | Muted mono. Streaming: 5-line fade. Rest: collapsed chevron. |
| **tool-call-row** `{components.tool-call-row}` | Name + outcome; output chips. |
| **skill-form** `{components.skill-form}` | Choice / multi / free text + Submit / Cancel. |
| **shell-approval** `{components.shell-approval}` | Warning border; command in mono; Approve / Deny. |
| **preview** `{components.preview}` | View-first GFM. Compact frontmatter header in `{typography.ui}` + `{typography.mono}`. Page body `{typography.preview}`; headings `{typography.preview-heading}`. No WYSIWYG toolbar. |
| **activity-row** `{components.activity-row}` | Filename + Analysis\|Generation\|pending\|succeeded\|failed. Destructive only on retry/cancel, not the row fill. |
| **review-card** `{components.review-card}` | White, 1px border. Warning vs lightbulb is **icon-only**. Path chips in `{typography.mono}`. |
| **todo-card** `{components.todo-card}` | Same card chrome as Review. Approve primary; Reject destructive ghost. |
| **graph-canvas** `{components.graph-canvas}` | Type fills from graph-* ; Community from graph-community-*; edges strong/weak. Labels `{typography.ui}`. |
| **warning-callout** `{components.warning-callout}` | Amber surface + `{colors.foreground}` body. |
| **save-bar** `{components.save-bar}` | Sticky; muted “Changes apply after saving” + primary Save. |
| **badge-count** `{components.badge-count}` | Black pill, white numerals. |
| **empty-state** `{components.empty-state}` | Muted sentence + optional one primary. No illustration. |
| **lightbox** `{components.lightbox}` | Overlay + image; jump-to-source control. |
| **research-panel** `{components.research-panel}` | Right column; topic field; grows with streamed progress. |
| **confirm-dialog** `{components.confirm-dialog}` | One overlay. Topic + query list for Deep Research; short confirm for delete / Preview edit. |
| **settings-nav** `{components.settings-nav}` | SETTINGS heading; active row gray wash. |

## Do's and Don'ts

| Do | Don't |
|---|---|
| Match `imports/` density and layout; SF chrome; Georgia Preview | Invent a new shell, dark theme, or “AI” costume |
| Black primary actions | Colored primary buttons or gradients |
| Type / Community color only on the Graph | Rainbow chrome, magazine Preview |
| Short unsentimental labels | Emoji, “Let’s get started!”, success confetti |
| English chrome | Chinese / i18n strings |
| View-first Preview; Georgia for Page body only | WYSIWYG toolbar; Georgia in Chat, rail, or Settings |
| Title the wiki **work-wiki** | Keep “CHRISTIAN’S LLM WIKI” |
| Bind API to loopback in the UI | Offer nashsu’s `0.0.0.0` / LAN / Clip-server toggle |
