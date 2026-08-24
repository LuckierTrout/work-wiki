# Epic 6 Context: Deep Research

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Christian can confirm a topic and search queries, then run multi-query web research that streams in the Workbench Research Panel, synthesizes a wiki research Page with wikilinks, and auto-Ingests on success — without blocking serial Ingest and without starting any search before confirm. This is the P1 “fill the gap from the web” surface. Graph Insights and Review already open the confirm dialog; this epic is the run, the providers, the panel, the Page, and the three-slot queue.

## Stories

Tracking keys match `sprint-status.yaml` (implementable spec). Planning `epics.md` swaps 6.1↔6.2 and 6.4↔6.5; that file is not the contract.

- Story 6.1: Configure Deep Research providers
- Story 6.2: Confirm topic and queries before start
- Story 6.3: Research Panel streams progress
- Story 6.4: Own queue, max 3 concurrent
- Story 6.5: Research Page, thinking, auto-Ingest

## Requirements & Constraints

**Nothing runs before confirm.** Topic and the query list are editable. At least one query is required. Cancel or dismiss starts no search and no Ingest. Graph Insights prefill from Purpose, Overview, and the Insight Pages. Review prefills ingest-time queries. Deep Research mode can start a run directly with the same rules.

**One active provider; Tavily out of the box.** Selectable providers are Tavily, SerpApi, and SearXNG. Tavily and SerpApi each have their own key. SerpApi exposes selectable engines. SearXNG uses a configured instance URL and search categories. Unused keys may stay stored. Missing credentials for the *selected* provider fail the task visibly — they do not silently fall back to another configured provider.

**Full content, then synthesis.** Fetched source text is passed to synthesis without an app-imposed truncation cap (provider-side limits may still apply). The LLM writes a research Page that `[[wikilink]]`s existing Pages where relevant. Thinking is collapsible and the viewport follows the newest line. Successful synthesis auto-Ingests (same arrival → two-step compile as other Intake). Failed synthesis does not auto-Ingest a partial draft as a clean success.

**Own concurrency.** Up to three research tasks run at once. A fourth start waits until a slot frees; it is not dropped. This cap is independent of the serial Ingest compile slot. Tasks survive restart as queued / collecting / failed like other durable jobs.

**Safety and language.** Deep Research never starts unconfirmed. UI and generation stay English-only. Display copy is work-wiki; runtime identifiers stay `yopedia`. No sidecar is required for this epic. Agent mid-turn web search is not this epic.

## Technical Decisions

**Kernel owns the run.** Search, extract, synthesis, project records, and the concurrency lease live in the kernel store and Workbench APIs. The sidecar does not import `src/lib` and does not run Deep Research. Chat SSE event names stay Chat-only.

**Settings store the active provider.** Env vars win when set, same as other secrets. Keys never round-trip to the browser (`has*ApiKey` only). Firecrawl remains the optional Capture credential already stored under External Sources — it is not a fourth search provider.

**One write path after success.** The research Page goes through the kernel Page lifecycle. Fetched URLs become Sources under `raw/sources/` and queue two-step Ingest so Activity shows those jobs. Completing a run must not file a legacy memory-proposal or treat `/review` as the success door. Workbench Review stays Create Page · Deep Research · Skip.

**dataVersion after wiki writes.** A landed research Page and its auto-Ingest bump the same monotonic version Graph, trees, and Preview already watch.

## UX & Interaction Patterns

Deep Research is the globe rail icon (after Review). Empty copy is exactly: “No research tasks yet. Enter a topic above or click Deep Research in Review.” Confirm is one overlay: topic + query list; Confirm / Cancel. Starting a run opens the Research Panel without leaving the Workbench. The panel has dynamic height, streams query / fetch / synthesis progress, and distinguishes concurrent tasks. Thinking uses the existing collapsible chrome (system sans); Georgia stays Preview body. `prefers-reduced-motion` jumps rather than auto-scrolling. Read-only disables start, settings writes, and other research mutations.

## Cross-Story Dependencies

6.1 (Settings + resolve-without-fallback + full-content fetch) must land before a confirm can honestly start a run. 6.2 turns Graph / Review / mode-direct confirm into create-then-run. 6.3 is the streaming panel those runs feed. 6.4 is the three-slot lease that 6.2/6.3 must honor (fourth waits). 6.5 is the success path: Page + thinking + auto-Ingest; it must not run on failed synthesis.

Depends on Epic 1 Settings/rail, Epic 2 Intake + serial Ingest + Activity, Epic 3 thinking chrome + save-to-wiki auto-Ingest pattern (reuse the door, not the Chat sidecar), Epic 5 confirm dialog and draft project create. Does not wait on Epic 7 extract, Epic 8 API/MCP/skill, or Plaud OAuth. Does not edit the Epic 5 `<intent-contract>`.
