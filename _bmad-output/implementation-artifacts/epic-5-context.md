# Epic 5 Context: See the wiki's shape

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Christian can see the wiki’s structure and health without leaving the Workbench: a scored Graph with discovered Communities, automatic Insights (odd links and thin spots), Lint for contradictions and mechanical drift, and an async Review queue that never blocks Ingest. This is the P1 health surface. He inspects shape, dismisses or highlights Insights, auto-fixes only mechanical link/index drift, and confirms Deep Research or Create Page — he does not hand-rewrite the vault or start an unconfirmed web search.

## Stories

- Story 5.1: 4-signal Relevance in the kernel
- Story 5.2: Graph canvas with sigma
- Story 5.3: Louvain Communities and Type/Community toggle
- Story 5.4: Graph hover, zoom, and position cache
- Story 5.5: Surprising Connections
- Story 5.6: Knowledge Gaps
- Story 5.7: Insight highlight and Deep Research entry
- Story 5.8: Lint report
- Story 5.9: Mechanical auto-fix
- Story 5.10: Review queue

## Requirements & Constraints

**One Relevance score.** Pairwise Page Relevance is a weighted sum: wikilink ×3.0, source overlap (`sources: []`) ×4.0, Adamic-Adar ×1.5, type affinity ×1.0. A missing signal is 0. Shared-Source beats a single wikilink, all else equal. Unrelated mixed-type Pages with no link, overlap, or neighbors score 0. Weights are the v1 contract — changing them is a product change. Chat expansion uses this score once it ships; it must not stay wikilink-only.

**Graph shows every Page.** Isolates stay on the canvas. Node size is √ degree. Edges follow Relevance: green = strong, gray = weak. Clicking a node docks Preview. Communities come from topology (Louvain), not frontmatter `type`. Type / Community coloring toggles in place. Community legend: top node label, member count, Cohesion (actual intra-edges / possible intra-edges); warn when Cohesion < 0.15. Type mode shows type counts. Re-cluster when Graph data refreshes — no separate “run clustering” click. Palette is 12 Community colors, reuse only after 12.

**Insights are automatic.** Opening Graph shows cards — no analyze click. Surprising Connections rank by composite surprise (cross-Community, cross-type, peripheral-hub); each card names the Pages/edge and class. Dismiss stays dismissed until structure changes enough to be a new Insight. Knowledge Gaps: isolated (degree ≤ 1), sparse (Cohesion < 0.15 and ≥ 3 Pages; a 2-page low-cohesion group does not), bridges (Page linking 3+ Communities). Isolated, sparse, and bridge cards have Deep Research; Surprising Connections do not require that button. Lint may point at these Insights and must not invent a second gap list. Clicking a card highlights matching nodes/edges; click again deselects.

**Deep Research is confirm-only here.** From a gap or bridge: editable topic + queries, prefilled from `overview.md`, `purpose.md`, and the Insight Pages; ≥1 query required; Cancel starts nothing; Confirm opens Deep Research mode filled — this epic does not run the web search. From Review: same dialog, prefilled with ingest-time stored queries. No unconfirmed research.

**Lint is a health report, not a second product.** Idle copy: “Run lint to check wiki health.” Semantic (LLM) toggle starts off. The report lists disputed Pages, broken wikilinks (with source Page), stale/expired (Schema age or `expires`), duplicates (same concept slug/title cluster), and orphans (no inbound wikilinks, excluding purpose/Schema/Index/Log/Overview). Each issue links to the Page. `disputed: true` stays visible and is not auto-cleared; a later Ingest or Review that reconciles the claim may clear it.

**Auto-fix is mechanical only.** Allowed classes: renamed-slug wikilinks, dangling `[[slug]]` after delete, `index.md` drift vs existing Pages. Fixes go through the single Page write path and are recorded in Page history. `disputed` is never cleared by auto-fix. Every other class has no auto-fix button.

**Review never blocks Ingest.** Cards persist from compile when human judgment is needed. Activity may show Ingest succeeded while Review still has items. Actions are only Deep Research · Create Page · Skip. Skip writes nothing. Create Page is a constrained Page-create/Ingest path, not a free editor. A model-proposed action outside that set is dropped or mapped to Skip — no custom button. Pending items and Insight dismissals survive restart. Rail badge shows pending count when non-zero and hides at empty.

**Success and language.** Weekly Lint is runnable; Insights must surface isolated Pages and sparse Communities when they exist. UI and generation stay English-only. Display copy is work-wiki; runtime identifiers stay `yopedia`. No public graph.

## Technical Decisions

**Kernel scores; Workbench draws.** The kernel computes 4-signal Relevance and Louvain and serves them to Graph mode. Workbench renders with sigma 3.0.3, graphology 0.26.0, ForceAtlas2 0.10.1, and Louvain 2.0.2 — not vis-network, cytoscape, or a custom canvas. Agent-skill `GET .../graph` may stay the undirected wikilink graph (v1 weight 1.0); it is not this viz and must not become a second renderer.

**One write path, one version signal.** Lint auto-fix and Review Create Page go through the kernel Page lifecycle (side effects on index/log/embeddings/backlinks). Successful writes bump monotonic `dataVersion`; Graph, trees, Preview, and Insights refetch without a full reload. Positions persist across that refresh so Ingest does not re-scatter the layout.

**Durable records live in the kernel.** Review items and dismissed Insights persist in the kernel store, not sidecar disk or browser-only state. Schema page conventions load into Lint (and Ingest/Chat) at runtime — do not fork a second copy. Graph, Lint, and Review do not require the sidecar; Chat still fails closed without it.

## UX & Interaction Patterns

Graph, Lint, and Review are rail modes (order: … Search · Graph · Lint · Todos · Review · Deep Research …). Graph chrome is Type / Community / Insights. Graph is the only place color is categorical (type tokens or the 12 Community colors); chrome stays light gray + black. Edge green is Graph-only — do not reuse the sidecar live-dot as an edge color. Canvas labels stay system sans; Georgia is Preview body only.

Hover: neighbors stay, others dim, incident edges show a Relevance label. Zoom in / out / Fit (Fit shows all current nodes). `prefers-reduced-motion` jumps to cached positions. Node or tree pick docks view-first Preview (`disputed` visible in the compact header). Below ~900px Graph is not the job surface; Lint and Review stay usable. Graph a11y is legend + Insights + Preview-on-node — the job must not be color-only.

Empty canvases: one muted sentence, optional one primary, no illustration or emoji. Lint idle is the checkmark + “Run lint to check wiki health.” Review empty: no pending cards, badge hidden. Run Lint is the one filled primary in that cluster.

Review cards: warning vs lightbulb icon-only; paths as `wiki/…md`. Deep Research appears when the item has stored queries; otherwise Create Page + Skip only. Badge accessible name includes count and noun. Confirm dialog is one level (topic + query list). Mode change announces the surface.

## Cross-Story Dependencies

5.1 is the score Graph edges, Insights, and Chat Phase 2 (3.5) consume — ship the kernel score before treating expansion as 4-signal. 5.2–5.4 are the canvas (sigma, Louvain coloring, hover/zoom/cache). 5.5–5.6 compute Insights on that graph; 5.7 highlights them and opens the confirm dialog only. 5.8 lists health; suggested gaps point at 5.6, not a parallel list. 5.9 writes through the same lifecycle as Ingest.

5.10 consumes Review items persisted by Ingest (2.6) with ingest-time queries. `dataVersion` after compile (Epic 2) refreshes Graph without re-scatter. Confirm from 5.7 or 5.10 opens Deep Research mode (Epic 6) filled; this epic does not fetch the web, stream the Research Panel, or auto-Ingest research Pages.

Depends on Epic 1 rail, Preview, durable shell, and owner-only Workbench. Does not wait on Epic 3 Chat UI, Epic 4 Todos, Epic 7 extract, or Epic 8 API/MCP/skill — except the wikilink `GET .../graph` contract must stay distinct from this viz.
