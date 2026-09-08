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

### Review Findings

- [x] [Review][Patch] Correct Sigma Fit camera math and verify the renderer-to-camera integration [src/lib/graph-camera-fit.ts:25]
- [x] [Review][Patch] Make uncached reduced-motion positions id-stable and collision-safe [src/lib/graph-camera-fit.ts:8]
- [x] [Review][Patch] Seed and order Louvain from the canonical effective graph [src/lib/graph-louvain.ts:85]
- [x] [Review][Patch] Include every incident endpoint edge in Surprise dismissal fingerprints [src/lib/graph-surprise.ts:149]
- [x] [Review][Patch] Reject malformed dismissal rows and validate timestamp-based retention [src/lib/graph-insight-dismissals.ts:47]
- [x] [Review][Patch] Quarantine corrupt dismissal bytes once without rereading a changed primary [src/lib/graph-insight-dismissals.ts:73]
- [x] [Review][Patch] Add atomic conditional first-create semantics for the dismissal store [src/lib/graph-insight-dismissals.ts:130]
- [x] [Review][Patch] Preserve an available Wiki Purpose source when its paired profile/artifact read fails [src/lib/research-prefill.ts:24]
- [x] [Review][Patch] Guarantee Overview and Insight Page context cannot be crowded out by profile questions [src/lib/research-prefill.ts:69]
- [x] [Review][Patch] Load shared Wiki prefill context once per Graph request instead of once per Insight [src/app/api/graph/workbench/route.ts:28]
- [x] [Review][Patch] Surface the prefill cap and remaining count in the Graph contract and UI [src/components/workbench/GraphCanvas.tsx:28]
- [x] [Review][Patch] Verify the Graph route forwards the authenticated owner into Research prefill [src/lib/__tests__/epic5-routes.test.ts:117]
- [x] [Review][Patch] Clear a prior Wiki's Review badge when the new scoped request fails [src/components/workbench/Workbench.tsx:399]
- [x] [Review][Patch] Stabilize the Review-count callback and execute its stale-response fencing [src/components/workbench/Workbench.tsx:1622]
- [x] [Review][Patch] Use fresh Page reads for stale-index destructive preconditions [src/lib/lifecycle.ts:687]
- [x] [Review][Patch] Distinguish fixable dangling wikilinks from markdown-only broken-link reports [src/lib/workbench-lint-types.ts:27]
- [x] [Review][Patch] Rewrite raw wikilink spellings by normalized target instead of exact normalized text [src/lib/lint-fix.ts:61]
- [x] [Review][Patch] Ignore alias-resolved self-links when computing inbound reachability [src/lib/workbench-lint.ts:59]
- [x] [Review][Patch] Make protected-region rewrites cover valid Markdown code forms without sentinel collisions [src/lib/lint-fix.ts:42]
- [x] [Review][Patch] Replace whole-wiki stale validation with an exact fresh targeted validator and production tests [src/lib/workbench-lint-fix.ts:27]
- [x] [Review][Patch] Exercise the real stale-index lifecycle and keep derived page-index cleanup fail-soft [src/lib/lifecycle.ts:691]
- [x] [Review][Patch] Mount Preview with a disputed Files selection instead of source-position assertions [src/lib/__tests__/workbench-preview.test.ts:1056]
- [x] [Review][Patch] Add a lease and state-checked transitions so live Create Page claims are never recovered or skipped as crashed work [src/lib/review-queue.ts:133]
- [x] [Review][Patch] Add operation identity and fresh Page reads so recovery, post-write failure, and idempotent retry converge on the right Page [src/lib/review-queue.ts:139]
- [x] [Review][Patch] Publish Review-created Pages with an atomic create-only lifecycle operation instead of check-then-overwrite [src/lib/review-queue.ts:393]
- [x] [Review][Patch] Count `creating` rows as active capacity, preserve them from terminal retention, and verify newest-terminal retention [src/lib/review-queue.ts:206]
- [x] [Review][Patch] Use authoritative conditional first-create semantics for the Review queue file [src/lib/review-queue.ts:260]
- [x] [Review][Patch] Serialize Review outbox append and drain with CAS and include `wikiId` in outbox identity [src/lib/review-queue.ts:558]
- [x] [Review][Patch] Preserve full-queue proposals as durable backpressure instead of treating an empty enqueue result as delivery [src/lib/review-queue.ts:498]
- [x] [Review][Patch] Treat any malformed Review row as store corruption instead of silently filtering it out [src/lib/review-queue.ts:94]
- [x] [Review][Patch] Keep Review GET strictly read-only when the deployment is read-only [src/lib/review-queue.ts:284]
- [x] [Review][Patch] Make successful and post-compile-skipped Review delivery fail-soft and durable when Analysis reads fail [src/lib/review-queue.ts:607]
- [x] [Review][Patch] Normalize and enforce the submitted Wiki scope on Review actions while preserving the legacy unscoped-card ruling [src/app/api/review-queue/[id]/route.ts:25]
- [x] [Review][Patch] Fence in-flight Review actions so an old Wiki response cannot replace the newly selected Wiki queue [src/components/workbench/ReviewCanvas.tsx:64]
- [x] [Review][Patch] Honor an explicit ingest `wikiId` and directly verify current-Wiki assignment through the real helper [src/lib/review-queue.ts:601]
- [x] [Review][Patch] Build Review list/count responses from one repair snapshot and keep a successful action successful if count refresh fails [src/app/api/review-queue/route.ts:13]
- [x] [Review][Patch] Quarantine the exact corrupt Review bytes already read and verify the recovery copy [src/lib/review-queue.ts:188]
- [x] [Review][Patch] Put the Graph browser-test timeout on the Playwright test body instead of unsupported `TestDetails` [e2e/workbench-owner.spec.ts:114]
- [x] [Review][Patch] Make the rail-mode browser journey create its own Wiki instead of depending on test order [e2e/workbench-owner.spec.ts:79]
- [x] [Review][Patch] Make Page seeding verify or replace conflicting fixture content instead of accepting any 409 [e2e/workbench-owner.spec.ts:20]
- [x] [Review][Patch] Verify the Graph canvas returns after leaving the narrow layout [e2e/workbench-owner.spec.ts:129]
- [x] [Review][Patch] Assert a positively identified Research draft after Graph handoff [e2e/workbench-owner.spec.ts:147]
- [x] [Review][Patch] Require Lint Auto-fix to run and verify the stored Page was repaired [e2e/workbench-owner.spec.ts:167]
- [x] [Review][Patch] Reload after Review Skip and prove the skipped card stays absent [e2e/workbench-owner.spec.ts:197]
- [x] [Review][Patch] Verify Review Create Page writes the expected Page content instead of only hiding the card [e2e/workbench-owner.spec.ts:222]
- [x] [Review][Patch] Invalidate badge requests when initial scope data changes and preserve the new Wiki's valid initial count [src/components/workbench/useReviewBadge.ts:16]
- [x] [Review][Patch] Short-circuit the Review badge to zero without an unscoped request when no Wiki is current [src/components/workbench/useReviewBadge.ts:20]
- [x] [Review][Patch] Normalize API and canvas badge counts to finite non-negative integers [src/components/workbench/useReviewBadge.ts:29]
- [x] [Review][Patch] Cover successful scoped badge refresh, data-version refresh, prop races, and no-Wiki behavior [src/components/workbench/__tests__/review-badge.test.tsx:19]
- [x] [Review][Patch] Preserve the first filesystem create failure when temporary-handle close also fails [src/lib/storage/filesystem.ts:285]
- [x] [Review][Patch] Verify conditional creation concurrently, bind stored bytes to the winner, and cover pre-existing paths and scratch cleanup [src/lib/__tests__/storage-fs.test.ts:205]
- [x] [Review][Patch] Pin exact data-version bump owners and fail-soft tails instead of broad file exemptions and a raw count [src/lib/__tests__/workbench-data-version.test.ts:995]
- [x] [Review][Patch] Relabel the retained closure logs as a superseded working-tree snapshot instead of exact-head evidence and explain the later test-count delta [_bmad-output/implementation-artifacts/epic-5-retro-closure/README.md:3]
- [x] [Review][Patch] Keep the delivery/review gate in progress while its own same-SHA review and flag-clear conditions remain open [_bmad-output/implementation-artifacts/sprint-status.yaml:390]
- [x] [Review][Patch] Point closure readers to the authoritative decision ledger recorded in the implementable spec [_bmad-output/implementation-artifacts/epic-5-retro-closure/README.md:32]

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm exec vitest run src/lib/__tests__/graph-relevance.test.ts src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/wiki.test.ts src/lib/__tests__/graph-louvain.test.ts src/lib/__tests__/graph-surprise.test.ts src/lib/__tests__/graph-insight-dismissals.test.ts src/lib/__tests__/workbench-state.test.ts src/lib/__tests__/workbench-lint.test.ts src/lib/__tests__/workbench-lint-fix.test.ts src/lib/__tests__/review-queue.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/epic5-routes.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/workbench-modes.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/links.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/workbench-chrome.test.ts src/components/workbench/__tests__/graph-lint-review-canvas.test.tsx src/components/workbench/__tests__/icon-rail.test.tsx` -- expected: pass, I/O matrix pinned
- Browser or closest substitute: Graph empty/narrow copy, Lint idle + semantic-off, Review skip, Deep Research confirm Cancel — no web fetch

## Spec Change Log

- 2026-08-23 — Implementation added Verification commands and review pins. No `<intent-contract>` edits.
- 2026-08-23 — Feature-area review chunk 1 applied all 14 Graph/Relevance/Insights/Research patches. No `<intent-contract>` edits.
- 2026-08-23 — Feature-area review chunk 2 applied all 8 Lint/Preview patches. No `<intent-contract>` edits.
- 2026-08-23 — Feature-area review chunk 3 applied all 15 Review/Ingest patches. No `<intent-contract>` edits.
- 2026-08-23 — Feature-area review chunk 4 applied all 15 Workbench delivery/browser/storage patches. No `<intent-contract>` edits.
- 2026-08-23 — Final full-diff chunk applied all 3 delivery-metadata/evidence patches. No `<intent-contract>` edits.
- 2026-08-24 — Retained exact-head gates at `250688ee769d356c8be6c8567b00c2dd7b34a620`. No `<intent-contract>` edits. This does not clear `followup_review_recommended`.

## Review Triage Log

### 2026-08-23 — Final full-diff metadata/evidence follow-up
- scope: hooks / agent instructions / sprint state / retrospective / retained closure evidence
- patch: 3 applied
- defer: 0
- decision_needed: 0
- dismissed: 9
- verification: hooks JSON and sprint YAML parse clean; retained-log counts match their historical files; current working-tree gates are TypeScript clean, production build clean, full lint exit 0, 6,590/6,590 Vitest green, and 17/17 Playwright green
- remaining_gate: reviewer step at `250688ee769d356c8be6c8567b00c2dd7b34a620` that can clear `followup_review_recommended`; exact-head gate output is retained in `epic-5-retro-closure/`

### 2026-08-23 — Feature-area chunk 4 follow-up
- scope: Workbench delivery / browser journeys / storage / refresh wiring
- patch: 15 applied
- defer: 0
- decision_needed: 0
- dismissed: 11
- failed_layer: acceptance-auditor stopped before returning findings; the other three configured layers completed
- verification: TypeScript clean; affected ESLint clean; focused 174 tests green; full 6,590-test suite green; all 17 Playwright tests green
- remaining_gate: none for Chunk 4

### 2026-08-23 — Feature-area chunk 3 follow-up
- scope: Review / Ingest
- patch: 15 applied
- defer: 0
- decision_needed: 0
- dismissed: 5
- verification: affected ESLint clean; full lint clean; focused Review/Ingest suite green; full 6,580-test suite green
- remaining_gate: repository TypeScript check is blocked by the separately modified `e2e/workbench-owner.spec.ts:115` (`timeout` is not a `TestDetails` field)

### 2026-08-23 — Feature-area chunk 2 follow-up
- scope: Lint / Preview
- patch: 8 applied
- defer: 0
- decision_needed: 0
- dismissed: 7
- verification: affected ESLint clean; focused 331 tests green; full 6,563-test suite green
- remaining_gate: repository TypeScript check is blocked by the separately modified `e2e/workbench-owner.spec.ts:115` (`timeout` is not a `TestDetails` field)

### 2026-08-23 — Feature-area chunk 1 follow-up
- scope: Graph / Relevance / Insights / Research
- patch: 14 applied
- defer: 0
- decision_needed: 0
- dismissed: 5
- verification: affected ESLint clean; focused 151 tests green; full 6,557-test suite green
- remaining_gate: repository TypeScript check is blocked by the separately modified `e2e/workbench-owner.spec.ts:115` (`timeout` is not a `TestDetails` field)

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

**2026-08-23 retrospective remediations:** Implementation work for the ten `epic-5-retro-*` actions is recorded below. Nine actions are marked implementation-complete; `epic-5-retro-delivery-review-gate` remains `in-progress` because its same-SHA reviewer step is still open. Story and action `done` means implementation complete, not retrospective acceptance. The Epic 5 retrospective remains `verdict: rejected` until a fresh exact-head review of retained gate output. This note does not clear `followup_review_recommended`.

## Recorded product rulings (Epic 5 retrospective)

These rulings sit outside `<intent-contract>` and are the authoritative answers to the decision-required actions in `epic-5-retro-2026-08-23.md`.

- **Semantic Lint gaps (`epic-5-retro-lint-product-reconcile`):** `missing-concept-page` and `incomplete-coverage` are not a second gap list. Workbench Lint drops those rows. When Semantic is on, Lint adds one `insight-pointer` row: “Knowledge gaps are listed under Graph Insights.”
- **Review `wikiId` (`epic-5-retro-review-scope-create`):** Review is a current-Wiki view. List, count, and badge filter by `wikiId`. Items with no `wikiId` still show. Pages are shared; `wikiId` is queue scope, not a write destination.
- **Dismissal fingerprints (`epic-5-retro-graph-correctness`):** A dismissed Insight stays hidden only while these fields match: kind, sorted slugs, community IDs of those slugs, incident undirected edges and weights, and the kind-specific extra (surprise classes / isolated degree / sparse cohesion / bridge neighbor communities). Invalidation happens only when those fields change. The executable list is `DISMISSAL_FINGERPRINT_FIELDS` in `src/lib/graph-surprise.ts`.
- **Stale `index.md` (`epic-5-retro-lint-write-contract`):** The authoritative lifecycle/history operation is `pruneStaleIndexEntry` in `src/lib/lifecycle.ts` (index lock, `updateIndexUnsafe`, page-index drop, log, fail-soft `bumpDataVersion`).
- **Corrupt Review and dismissal stores (`epic-5-retro-durable-store-atomicity`):** Fail closed. Quarantine the first unreadable dismissal bytes once to `{path}.corrupt`, without rereading a possibly changed primary or accumulating timestamped copies; Review retains its existing quarantine behavior. Do not treat corrupt JSON as empty and overwrite it.
- **Story `done` (`epic-5-retro-delivery-review-gate`):** In `sprint-status.yaml`, story `done` means implementation complete. It is not retrospective acceptance and does not imply Epic 5 passed. `epic-5-retrospective: done` means the retrospective ran. The machine-readable verdict stays in `epic-5-retro-2026-08-23.md`.
- **Epic 4 retrospective absence:** Waived. Epic 4 has no retrospective document; `epic-4-retrospective` stays `optional`. That absence is intentional, not an unfinished gate.
- **Semantic Lint with a live provider (`epic-5-retro-executed-workbench-contracts`):** Explicitly remains unaccepted. v1 CI and Playwright do not run Semantic Lint against a real configured LLM. Kernel and canvas coverage prove the insight-pointer mapping only.
- **Worker/R2 multi-isolate (`epic-5-retro-durable-store-atomicity`):** Local evidence is the same CAS / first-create / restart path (`writeFileIfMatch`, verify-after-create, `_resetStorage`). This repo cannot spawn Cloudflare Worker isolates or an R2 replica in Vitest. Those production runtimes share the storage helpers under test.

## Planning metadata

`followup_review_recommended` stays `true` until a fresh review at the same SHA as the retained release-gate output records no unresolved acceptance findings. Action 10's closure that would clear this flag is a reviewer step, not an implementer step.

Exact-head gate output at `250688ee769d356c8be6c8567b00c2dd7b34a620` lives at `_bmad-output/implementation-artifacts/epic-5-retro-closure/`.
