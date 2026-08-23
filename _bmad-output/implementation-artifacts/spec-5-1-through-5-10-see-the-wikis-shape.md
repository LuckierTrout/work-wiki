---
title: 'See the wiki''s shape'
slug: spec-5-1-through-5-10-see-the-wikis-shape
created: 2026-08-23
status: done
stepsCompleted: [1, 2, 3, 4]
followup_review_recommended: true
review_loop_iteration: 0
baseline_revision: 83595933eda2434194ac827cbcc0ee06877ccde5
context:
  - AGENTS.md
  - _bmad-output/implementation-artifacts/epic-5-context.md
  - .yoyo/learnings.md
intent_resolution: auto
intent_resolution_reason: 'Freeform epic-story intent. 5.1–5.10 from epics.md + compiled epic-5-context. No conflicting human-in-loop answers.'
warnings:
  - multiple-goals
  - oversized
---

# See the wiki's shape

**Goal:** Christian opens Graph, Lint, and Review in the Workbench and sees structure, health, and human-judgment leftovers without starting unconfirmed web search.

**Actor & scope:** Christian (owner). Kernel Relevance + Workbench Graph (sigma/graphology/FA2/Louvain) + automatic Insights + Lint + mechanical auto-fix + Review queue. Sidecar not required. Deep Research confirm fills mode only.

**Non-negotiable constraints:** Frozen identifiers. English-only. Graph is not a public commons. Do not edit `SCHEMA.md` or `llm-wiki.md`. Mechanical auto-fix only on Workbench Lint. Workbench Review actions are Deep Research · Create Page · Skip only. Confirm Deep Research does not run the web search.

## Context

- Epic 4 (meeting Todos) is shipped. Chat/Search/Todos stay mounted-hidden. `dataVersion` already refreshes trees after lifecycle writes.
- Kernel 4-signal Relevance already lives in `graph-relevance.ts` / `graph-build.ts`. Chat `expandHits` still passes empty `sourceUrls`. MCP/`wiki_graph` stays wikilink-capable as today — it is not this viz (AD-14).
- Custom `/wiki/graph` (vis-network + label-prop) stays. Workbench Graph is a new canvas.
- Legacy `/lint` + `lint-fix` stay. Workbench Lint is a rail surface with semantic off by default and three mechanical auto-fix classes only.
- Memory-proposals (`Accept`/`Reject`/`Revise`) stay on `/review`. Workbench Review is a separate kernel JSON queue written from successful ingest when analysis needs human judgment.

## Intent Resolution

- **Locked:** Weights 3.0 / 4.0 / 1.5 / 1.0. Missing signal = 0. Shared-Source beats a single wikilink. Unrelated mixed-type with no link/overlap/neighbors = 0.
- **Locked:** Chat Phase 2 expansion uses full 4-signal (`sourceUrls` from cited pages). `[[wikilink]]` and markdown links both count as the wikilink signal.
- **Locked:** Workbench Graph uses `sigma` 3.0.3, `graphology` 0.26.0, `@graphology/layout-forceatlas2` 0.10.1, `graphology-communities-louvain` 2.0.2. Isolates included. Node size √degree. Edges green=strong / gray=weak. Click docks Preview. Narrow (`< ~900px`) shows `GRAPH_NARROW_COPY`. Empty: `No graph yet. Ingest sources to build one.`
- **Locked:** Louvain from the package, not custom label-prop. Topology only (not `type`). Type / Community toggle. 12-color palette, reuse after 12. Legend: top label, count, Cohesion; warn Cohesion < 0.15. Re-cluster on `dataVersion` refresh. No “run clustering” click.
- **Locked:** Hover dims non-neighbors; incident Relevance labels. Zoom in/out/Fit. Positions persist across `dataVersion` in **browser-local** `workbench-state` (not a kernel graph store). `prefers-reduced-motion` jumps to cached positions.
- **Locked:** Insights are automatic. Surprise rank: cross-Community, cross-type, peripheral-hub. Dismiss persists in **kernel** until structure changes enough. Isolated = degree ≤ 1. Sparse = Cohesion < 0.15 **and ≥ 3 Pages** (2-page low-cohesion is not sparse). Bridges = Page linking 3+ Communities. Isolated/sparse/bridge have Deep Research; Surprising Connections do not require that button. Lint may point at these Insights — no second gap product.
- **Locked:** Insight click highlights the graph (toggle). Deep Research confirm: editable topic + queries, prefilled from `overview.md`, `purpose.md`, Insight Pages; ≥1 query; Cancel starts nothing; Confirm **opens Deep Research mode filled** and does not fetch the web.
- **Locked:** Lint idle: `Run lint to check wiki health.` Semantic toggle **off by default**. Lists disputed, broken wikilinks (with source Page), stale/expired, duplicates, inbound-wikilink orphans (exclude purpose/Schema/Index/Log/Overview). Each issue links to the Page. `disputed: true` visible in Preview, not auto-cleared.
- **Locked:** Workbench auto-fix **mechanical only**: renamed-slug wikilinks, dangling `[[slug]]` after delete, `index.md` drift. Lifecycle write + Page history. `disputed` never cleared. Other classes: no auto-fix button on Workbench Lint (legacy `/lint` may keep extra buttons).
- **Locked:** Workbench Review actions: Deep Research · Create Page · Skip only. Warning vs lightbulb. Paths `wiki/…md`. Badge pending count, hidden at 0, a11y `Review, N pending reviews`. Ingest can succeed while Review still has items. Skip writes nothing. Create Page is constrained Ingest/create, not a free editor. Extra model actions drop or map to Skip. Persist across restart (`tenants/{t}/review-queue.json`).
- **Locked:** Ingest writes Review items after a **successful** compile when analysis has tensions or stored follow-up queries (extend `IngestAnalysis` optionally). Failed/skipped compile writes none. Do not route Workbench Review through `memory-proposals`.
- **Deferred:** Public graph, Dark Mode, Chat-driven graph, Deep Research web run (Epic 6), semantic lint on by default, Workbench auto-fix for non-mechanical classes.

## Intent Snapshot

<intent-contract>
- Kernel 4-signal Relevance (weights 3 / 4 / 1.5 / 1). Chat expansion uses it.
- Workbench Graph: all Pages including isolates; sigma + graphology + FA2 + Louvain; Type/Community; Insights; hover/zoom/fit; cached positions.
- Insights: surprising / isolated / sparse / bridge. Automatic. Kernel dismissals. Confirm-only Deep Research fill.
- Workbench Lint: idle copy; semantic off; inbound-orphan definition; disputed visible; three mechanical auto-fixes.
- Workbench Review: ingest-persisted queue; DR · Create Page · Skip; badge; persist restart.
- No sidecar. No unconfirmed web search. No SCHEMA/llm-wiki edits.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Relevance shared-Source | Two pages share a Source, no wikilink | Score ≥ single-wikilink pair | Missing signals = 0 |
| Relevance unrelated | Mixed type, no link/overlap/neighbors | Score 0 | No fabricated affinity |
| Chat expansion | Seed hits with cited Sources | `expandHits` / `expandGraphSeeds` use real `sourceUrls` | Retrieval fail stays existing |
| Graph empty | No wiki Pages | `No graph yet. Ingest sources to build one.` | No crash |
| Graph narrow | Viewport < ~900px | `GRAPH_NARROW_COPY`; not the job surface | Desktop unchanged |
| Graph isolate | Page with degree 0 | Node still drawn | Size uses √degree floor |
| Community refresh | `dataVersion` bump | Re-Louvain; positions from cache if node ids match | New nodes layout; reduced-motion jumps |
| Sparse 2-page | Cohesion < 0.15, 2 Pages | Not a sparse Insight | Isolated may still apply |
| Insight dismiss | Owner dismisses surprise | Kernel persist; gone until structure changes enough | 401/403 on write |
| DR confirm Cancel | Dialog open | No mode change; no research run | — |
| DR confirm OK | ≥1 query | Open Deep Research mode filled; no web fetch | Block confirm if 0 queries |
| Lint idle | Never run this session | `Run lint to check wiki health.` | — |
| Lint semantic | Toggle off (default) | No LLM lint classes | Toggle on runs existing semantic checks |
| Lint orphan | Page with no inbound wikilink, not bookkeeping | Listed; click docks Preview | purpose/Schema/Index/Log/Overview excluded |
| Mechanical fix | Renamed slug / dangling / index drift | Lifecycle write + history | Read-only disables; disputed never fixed |
| Review skip | Pending item | Removed from pending; no wiki write | Persist; restart still skipped |
| Review ingest fail | Compile skipped/failed | No new Review items from that job | Existing queue unchanged |
| Review extra action | Model proposes Accept/other | Drop or map to Skip | Never Accept/Reject/Revise on Workbench |
| Unauthenticated | Graph/Lint/Review write APIs | 401 `Sign in required.` | No leak |
</intent-contract>

## Code Map

- `src/lib/graph-relevance.ts` -- Weights + `buildWeightedGraphEdges` + `expandGraphSeeds`. Keep weights. Chat must call this with real `sourceUrls`.
- `src/lib/graph-build.ts` -- `buildWikiGraph` lists pages + markdown `[text](slug.md)`. Also parse `[[wikilink]]` for the wikilink signal (parity with retrieval).
- `src/lib/wiki-retrieve.ts:397` -- `expandHits` hardcodes `sourceUrls: []`. **Fix:** pass `parseSources` like `query-search.ts:435-480`.
- `src/app/api/wiki/graph/route.ts` + MCP `wiki_graph` -- Already 4-signal-capable. **Do not** turn into the Workbench viz; do not collapse contracts.
- `src/lib/graph.ts` `detectCommunities` / `graph-render.ts` / `useGraphSimulation.ts` / `src/app/wiki/graph/page.tsx` -- Custom viz. **Read-only.** Do not extend as Workbench Graph.
- `src/lib/graph-insights.ts` -- Precursor isolated/bridge/tag-sparse. Replace/extend for FR surprise + cohesion-sparse (≥3) + kernel dismissals.
- `src/lib/workbench-modes.ts` -- Empty Graph/Lint/Review copy already correct. Keep `GRAPH_NARROW_COPY`. Rail order already Search · Graph · Lint · Todos · Review · Deep Research.
- `src/lib/workbench-tree.ts:417-423` -- Extend `shouldDockPreview` for graph / lint / review picks (`wiki/…md`).
- `src/lib/workbench-state.ts` -- Persist Graph camera + node positions keyed by node id (browser-local). Not kernel.
- `src/lib/workbench-preview.ts` / `PreviewColumn.tsx` -- Add compact `disputed: true` header (legacy banner is `ArticleView` only).
- `src/components/workbench/ModeCanvas.tsx:182-197` -- Replace Graph/Lint/Review stubs with stay-mounted canvases. Deep Research mode already exists — confirm only navigates/fills it.
- `src/components/workbench/Workbench.tsx` / `page.tsx` -- Drive `reviewCount` from pending Review-queue (like Todos). Graph Insights chrome: Type / Community / Insights.
- `src/lib/lint.ts` / `lint-checks.ts` / `lint-types.ts` / `POST /api/lint` -- Reuse report. Add inbound-wikilink orphan class for Workbench (do not redefine existing `orphan-page` index-drift). Semantic checks stay behind Workbench toggle default off.
- `src/lib/lint-fix.ts` -- Keep legacy extra fixes. Workbench UI exposes only renamed-slug, dangling `[[slug]]`, `index.md` drift. Add renamed-slug rewrite via `page-redirect.ts` / alias index. Dangling drops the link. Index drift uses existing index rebuild. All through lifecycle + history.
- `src/lib/page-redirect.ts` -- Reuse for renamed-slug repair.
- `src/lib/ingest-analysis.ts` -- Optional `reviewItems` / `searchQueries` / tensions → Workbench Review enqueue after successful compile (`tasks/run` post-hooks, not on skip/fail).
- `src/lib/memory-proposals.ts` / `/review` -- **Read-only for Workbench.** Do not replace Accept/Reject.
- `src/lib/research-projects.ts` / Deep Research mode -- Confirm opens filled project/draft. **No** `run` of web search.
- `src/lib/owner-route.ts` / `read-only.ts` -- 401 + `assertWritable` on dismiss, lint-fix, review skip/create, review enqueue writes.
- `src/lib/lifecycle.ts` -- `bumpDataVersion` after graph-insight dismissals, lint-fix, review-queue writes (badge + Graph refresh).
- `src/lib/portable-archive.ts` -- Tenant walk already ships new `tenants/{t}/*.json`. Pin review-queue + insight-dismissals ride along.
- Tests: `graph-relevance.test.ts`, `wiki-retrieve.test.ts`, `wiki.test.ts`, `lint*.test.ts`, `icon-rail.test.tsx`, `workbench-tree.test.ts`, `workbench-modes.test.ts`. Add Graph/Lint/Review canvas, Louvain cohesion, sourceUrls expansion, inbound orphan, renamed-slug fix, Preview disputed, review badge.

New (expected):
- `sigma` / `graphology` / `@graphology/layout-forceatlas2` / `graphology-communities-louvain` at pinned versions.
- `src/lib/graph-louvain.ts` -- Package Louvain + Cohesion + 12-color assign.
- `src/lib/graph-surprise.ts` + kernel `tenants/{t}/graph-insight-dismissals.json`.
- `src/lib/review-queue.ts` + `src/app/api/review-queue/**` -- Kernel SoR; list/skip/create-page; ingest enqueue.
- `src/components/workbench/GraphCanvas.tsx` (+ hover/zoom/legend/insights).
- `src/components/workbench/LintCanvas.tsx` -- Idle, semantic toggle, issue list, mechanical fix only.
- `src/components/workbench/ReviewCanvas.tsx` -- Warning/lightbulb cards; DR · Create Page · Skip.
- `src/components/workbench/DeepResearchConfirm.tsx` -- Topic + queries; Cancel / Confirm.
- `src/app/api/graph/insights/route.ts` (or fold into wiki graph + dismiss route).
- Workbench lint-fix wrapper that refuses non-mechanical classes.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-retrieve.ts` + `graph-build.ts` -- Wire Chat/source overlap + `[[wikilink]]` into 4-signal. Pin weights. Do not change MCP viz contract.
- `package.json` -- Add pinned sigma/graphology/FA2/louvain. Context7 before first use.
- `GraphCanvas` + `graph-louvain` + workbench-state positions + `shouldDockPreview`.
- Insights compute + kernel dismiss + highlight toggle + `DeepResearchConfirm` (fill mode only).
- `LintCanvas` + inbound-orphan check + Preview disputed + mechanical-only fix (renamed-slug, dangling, index).
- `review-queue.ts` + ingest enqueue + Review canvas + badge + Skip/Create Page/DR confirm.
- Tests for the I/O matrix. Browser-verify Graph/Lint/Review on desktop; assert narrow copy exists.

**Acceptance Criteria:**
- Given two Pages that share a Source and have no wikilink, when Relevance is scored, then that pair outranks a pair with only one wikilink and no other signals.
- Given two unrelated mixed-type Pages with no wikilink, no Source overlap, and no shared neighbors, when Relevance is scored, then the score is 0.
- Given Chat retrieval expands seeds, when Phase 2 runs, then expansion uses the 4-signal score (real `sourceUrls`), not wikilink-only.
- Given wiki Pages exist, when I open Graph, then every Page including isolates is drawn, node size follows √degree, and edges are green (strong) or gray (weak).
- Given I click a Graph node, when the click lands, then Preview docks on that Page.
- Given the viewport is below ~900px, when Graph would be the job surface, then I see `GRAPH_NARROW_COPY` instead.
- Given there are no Pages, when I open Graph, then copy is `No graph yet. Ingest sources to build one.`
- Given Pages and edges exist, when Graph loads or `dataVersion` refreshes, then Louvain communities are computed from topology (not `type`) via `graphology-communities-louvain`, Type/Community toggles, the legend shows top label / count / Cohesion, and Cohesion < 0.15 is warned. There is no “run clustering” control.
- Given I hover a node, when neighbors exist, then others dim and incident Relevance labels show. Zoom in/out/Fit work. Positions survive `dataVersion` from the browser cache. `prefers-reduced-motion` jumps to cached positions.
- Given surprising cross-Community / cross-type / peripheral-hub edges exist, when Graph is open, then Surprising Connections appear automatically (no analyze click) and I can dismiss one until the structure changes enough.
- Given a Page with degree ≤ 1, when Insights compute, then it is Isolated. Given Cohesion < 0.15 and ≥ 3 Pages, then Sparse. Given a Page linking 3+ Communities, then Bridge. A 2-page low-cohesion cluster is not Sparse. Isolated/sparse/bridge offer Deep Research; Surprising Connections do not require that button.
- Given I click an Insight, when it is selected, then the graph highlights those nodes/edges (click again clears). Given I Confirm Deep Research with ≥1 query, then Deep Research mode opens filled and no web search starts. Cancel leaves Graph/Review as they were.
- Given I open Lint and have not run it, when the canvas shows, then copy is `Run lint to check wiki health.` Semantic is off. After run, disputed / broken wikilinks (with source Page) / stale / duplicates / inbound orphans list; each docks Preview. Bookkeeping pages are not orphans. `disputed: true` is visible on Preview and is not auto-cleared.
- Given a renamed-slug, dangling `[[slug]]`, or `index.md` drift issue, when I auto-fix from Workbench Lint, then the wiki writes through lifecycle with history. Other issue classes have no Workbench auto-fix button.
- Given ingest analysis needs human judgment and compile succeeds, when I open Review, then items persist (warning or lightbulb, `wiki/…` paths), actions are only Deep Research · Create Page · Skip, Skip writes nothing, Create Page is constrained create, extra model actions are not Accept/Reject/Revise, the badge shows pending count (`Review, N pending reviews`) and hides at 0, and items survive restart. Failed/skipped compile adds none. Ingest success may leave Review items pending.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm exec vitest run src/lib/__tests__/graph-relevance.test.ts src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/wiki.test.ts src/lib/__tests__/graph-louvain.test.ts src/lib/__tests__/graph-surprise.test.ts src/lib/__tests__/graph-insight-dismissals.test.ts src/lib/__tests__/workbench-state.test.ts src/lib/__tests__/workbench-lint.test.ts src/lib/__tests__/workbench-lint-fix.test.ts src/lib/__tests__/review-queue.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/epic5-routes.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-modes.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/links.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/workbench-chrome.test.ts src/components/workbench/__tests__/graph-lint-review-canvas.test.tsx src/components/workbench/__tests__/icon-rail.test.tsx` -- expected: pass, I/O matrix pinned
- Browser or closest substitute: Graph empty/narrow copy, Lint idle + semantic-off, Review skip, Deep Research confirm Cancel — no web fetch

## Spec Change Log

- 2026-08-23 — Implementation added Verification commands and review pins. No `<intent-contract>` edits.

## Review Triage Log

### 2026-08-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 25: (high 4, medium 15, low 6)
- defer: 0
- reject: 20
- addressed_findings:
  - `[high]` `[patch]` Pin cached Graph nodes during ForceAtlas2 so Ingest does not re-scatter
  - `[high]` `[patch]` Slugify and normalize `[[wikilink]]` targets (`Foo Bar`, `wiki/foo.md`)
  - `[high]` `[patch]` Keep Review card paths inside `wiki/{slug}.md` (drop `..`)
  - `[high]` `[patch]` Pin renamed-slug promotion so Auto-fix rewrites instead of deleting
  - `[medium]` `[patch]` Show incident Relevance labels on hover; clear stale Insights on Graph load fail
  - `[medium]` `[patch]` Fall through to tensions/queries when every model Review draft maps to Skip
  - `[medium]` `[patch]` Claim Create Page before the wiki write; revert if the write fails
  - `[medium]` `[patch]` Guard `parseFrontmatter` on retrieve and Preview
  - `[medium]` `[patch]` Disable Graph Deep Research in read-only; catch Sigma setup failures
  - `[medium]` `[patch]` Add Create Page, searchQueries, Graph Insights GET, 403, and door-coverage tests
  - `[low]` `[patch]` Distinguish Type colors; keep Confirm open when research POST has no id; cap prefills

## Auto Run Result

Status: done

**Summary:** Stories 5.1–5.10 ship the Workbench health surface. Kernel 4-signal Relevance now feeds Chat expansion. Graph, Lint, and Review are real rail modes. Confirm Deep Research opens a draft only — it does not run the web search.

**Files:** New kernel/API/canvas (`graph-louvain.ts`, `graph-surprise.ts`, `graph-insight-dismissals.ts`, `review-queue.ts`, `workbench-lint.ts`, `workbench-lint-fix.ts`, `research-prefill.ts`, Graph/Lint/Review/Research canvases, `/api/graph/workbench`, `/api/graph/insights`, `/api/lint/workbench`, `/api/lint/workbench-fix`, `/api/review-queue`). Chat `sourceUrls`, `[[wikilink]]` extract, Preview `disputed: true`, ingest Review enqueue, pinned sigma/graphology/FA2/Louvain.

**Review:** 25 patches applied (4 high, 15 medium, 6 low). 0 deferred. 20 findings rejected (Lint as a second gap product, gap-card Dismiss, full-ingest Create Page, Insight-must-dock-Preview, jsdom Sigma tests, unused wikiId, Epic 6 web run).

**Follow-up review:** true — 4 high patches; score `3 × 15 medium + 6 low = 51`.

**Verification:** `pnpm exec tsc --noEmit` clean. Spec suite plus review pins: 662 tests green. No signed-in browser E2E; closest substitute is canvas/RTL + authenticated route/kernel tests. Confirm Deep Research never POSTs `/api/research/[id]/run`.

**Residual risks:** Graph WebGL (hover/zoom/FA2) is not exercised in jsdom. Extract/Lint semantic still need an LLM key. Deep Research web search remains Epic 6.
