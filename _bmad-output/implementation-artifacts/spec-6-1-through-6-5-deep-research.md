---
title: 'Deep Research'
slug: spec-6-1-through-6-5-deep-research
created: 2026-08-24
status: done
stepsCompleted: [1, 3, 4]
followup_review_recommended: true
review_loop_iteration: 0
baseline_revision: 6df2c30573d0a2dcbeabb3a0f65315d82a7698d9
context:
  - AGENTS.md
  - _bmad-output/implementation-artifacts/epic-6-context.md
  - .yoyo/learnings.md
intent_resolution: auto
intent_resolution_reason: >-
  Freeform epic-story intent. 6.1–6.5 from sprint-status.yaml + compiled
  epic-6-context. Planning epics.md is not the contract (6.1↔6.2 and 6.4↔6.5
  are swapped there). Fast-path assumptions tagged below. No conflicting
  human-in-loop answers. Do not edit the Epic 5 intent-contract.
warnings:
  - multiple-goals
  - oversized
deferred:
  - summary: >-
      The research lease file is last-write-wins, so two isolates can over-admit
      under a concurrent acquire.
    evidence: |-
      acquireResearchSlot reads then writes tenants/{t}/research-leases.json
      without compare-and-swap, the same kernel JSON pattern as other stores.
      The three-slot ceiling is therefore best-effort across isolates, not
      linearizable.
    location: >-
      src/lib/research-concurrency.ts
    severity: medium
  - summary: >-
      DELETE /api/research/:id does not release a held research slot, so a
      deleted in-flight run occupies a slot until TTL.
    evidence: |-
      The DELETE handler calls deleteResearchProject only. Slot release lives
      on cancel and on runResearchProject's finally, not on delete. The panel
      has no delete control; the API door still leaks a slot until TTL.
    location: >-
      src/app/api/research/[id]/route.ts
    severity: medium
---

# Deep Research

**Goal:** Christian confirms a topic and queries, then Deep Research actually searches the web, streams in the Research Panel, writes a research Page, and auto-Ingests on success — at most three runs at once, never unconfirmed.

**Actor & scope:** Christian (owner). Kernel research projects + Settings providers (Tavily default, SerpApi, SearXNG) + Workbench Research Panel + Graph/Review confirm (already shipped as fill-only). Sidecar not required. Firecrawl stays Capture, not a search provider.

**Non-negotiable constraints:** Frozen identifiers. English-only. Do not edit `SCHEMA.md` or `llm-wiki.md`. Do not edit the Epic 5 `<intent-contract>`. This spec supersedes Epic 5's fill-only confirm for Graph/Review/mode-direct start going forward. No silent provider fallback. No unconfirmed search. No auto-Ingest on failed synthesis. Do not complete a run through `memory-proposals` / `/review`.

## Context

- Epic 5 shipped Graph Insights, Lint, Review, and `DeepResearchConfirm`. Confirm from Graph or Review `POST /api/research` creates a **draft** project and opens Deep Research mode. The canvas says `Draft — web search has not started.` That was correct for Epic 5. It is the gap this epic closes.
- Kernel already has `research-projects.ts` (`tenants/{t}/research-projects.json`, cap 100), `research-providers.ts` (Tavily / SerpApi / SearXNG, env keys only), `research-runtime.ts` (`queue` / `run` / `cancel`), `POST /api/research/[id]/run` (enqueue `run-research` or inline), and a task-consumer branch that calls `runResearchProject`.
- The current run path searches with **snippet-only** Tavily (`include_raw_content: false`, 4_000-char slice), synthesizes, then files a **legacy memory-proposal** (`Draft is ready in Review.`). That is the wrong success door. Workbench Review is a different queue.
- Settings → External Sources stores **Firecrawl** only, with copy `Firecrawl credentials are stored for Deep Research; nothing here calls it yet.` Firecrawl is the optional Capture credential (Epic 2). Deep Research providers are Tavily / SerpApi / SearXNG (AD-18).
- Chat save-to-wiki already does the auto-Ingest door this epic reuses: lifecycle Page + `saveRawSourceFor` + `createIngestJob` + `enqueueOrInline`. Thinking chrome already exists on Chat (`wb-chat-thinking`). Do not invent a second Page writer or a second thinking widget family.
- `epics.md` 6.1 is confirm, 6.2 is providers, 6.4 is Page/ingest, 6.5 is the queue. `sprint-status.yaml` (and this spec) use the opposite pairing for 6.1/6.2 and 6.4/6.5. Implement against this spec and the sprint keys.

## Intent Resolution

- **Locked:** Default active provider is Tavily. SerpApi and SearXNG remain selectable. One provider is active at a time. Unused keys may stay stored. Env (`TAVILY_API_KEY`, `SERPAPI_API_KEY`, `SEARXNG_BASE_URL`, optional `SEARXNG_API_KEY`, optional `RESEARCH_PROVIDER`) wins when set, same as other Settings secrets.
- **Locked:** Missing credentials for the *selected* provider fail the task visibly. `resolveResearchProvider` must not silently pick another available provider. `availableResearchProviders()` may still list what is configured.
- **Locked:** Firecrawl is not a Deep Research search provider. Keep the existing Firecrawl fields. Rewrite `SETTINGS_FIRECRAWL_COPY` so it no longer claims Firecrawl is “for Deep Research.”
- **Locked:** Confirm is required from Graph Insights, Review, and Deep Research mode. Editable topic + queries; ≥1 query; empty topic refused; Cancel starts nothing. Graph/Review keep `DeepResearchConfirm`. Mode-direct uses the same rules (topic above + queries; empty copy stays `workbenchMode("research").emptyState`).
- **Locked:** Confirm **creates then runs** (`POST /api/research` then `POST /api/research/:id/run`). Record the active `wikiId` on the project (`vaultId`). Opening the mode without Confirm does not search.
- **Locked:** Starting a Review Deep Research does **not** Skip or resolve that Review item. Graph Insight dismiss stays a separate action.
- **Locked:** Tavily search requests full content (`include_raw_content` enabled; Context7 `/websites/tavily` — `true` or `markdown`). SerpApi / SearXNG search, then extract each result URL with the kernel web-clip path (`readability` + `linkedom` + `htmlToMarkdown`, AD-16). Do not require a Tavily key to extract for a non-Tavily selection. Do not slice fetched source text to 4_000 (or any other app cap) before synthesis. Provider-side limits may still apply.
- **Locked:** SerpApi engine is selectable in Settings; persist the engine string. `[ASSUMPTION: default engine is \`google\` — today's hardcoded value.]` SearXNG uses the stored instance URL and search categories.
- **Locked:** Research Panel is the Deep Research canvas. Dynamic height. Streams query / fetch / synthesis progress. Concurrent tasks are distinguishable. Fourth start stays `queued` and is visible as waiting. Thinking is collapsible; viewport follows the newest thinking line; `prefers-reduced-motion` jumps. Reuse Chat thinking chrome, do not restyle.
- **Locked:** Successful synthesis writes a research Page through `writeWikiPageWithSideEffects` (slug `research-{slugify(title)}`, existing runtime), `[[wikilink]]`s related existing Pages, cites exact source URLs, loads `loadPageConventions()` into the synthesis prompt. Thinking is shown in the panel and is **not** filed on the Page and is **not** a Source.
- **Locked:** Auto-Ingest on success only: persist fetched URL bodies as Sources (`saveRawSource` first-write-only) and `enqueueOrInline` two-step Ingest so Activity shows the jobs (Chat save-to-wiki door). Failed or cancelled synthesis writes no Page and queues no Ingest. SHA skip still applies to unchanged Source bytes.
- **Locked:** Do **not** call `createMemoryChangeProposal` from the research run. Do not tell the owner the draft is “ready in Review.”
- **Locked:** Own concurrency: at most 3 projects in `collecting` (plus in-flight synthesis) per owner. A fourth confirm persists as `queued` and waits. This lease is independent of AD-9 (one Ingest compile per Wiki). `run-research` must not take the serial Ingest compile lock. `[ASSUMPTION: reuse \`yopedia-tasks\` plus a kernel lease; do not add a second wrangler Queue binding in v1.]`
- **Locked:** Tasks survive restart. Cancel: `queued` → `cancelled` immediately; `collecting` sets `cancelRequested` and stops between queries / before synthesis write. Read-only 403s create, run, cancel, PATCH, DELETE, and Settings writes. Unauthenticated 401 `Sign in required.`
- **Locked:** No sidecar. No Agent mid-turn web search (FR-61 / Epic 8). No KnowledgeStudio research-desk rewrite. No SCHEMA/llm-wiki edits.
- **Deferred:** Agent web-search tool, Firecrawl-as-search, office/email extract, public research, a second Cloudflare Queue binding.

## Intent Snapshot

<intent-contract>

## Intent

**Problem:** Confirm already mints a draft research project, but the web search never starts from the Workbench, Settings cannot select Tavily/SerpApi/SearXNG, the existing run path truncates sources and files a memory-proposal, and nothing enforces the three-slot queue independent of Ingest.

**Approach:** Settings becomes the provider SoR (Tavily default, no silent fallback). Confirm from Graph, Review, or Deep Research mode creates then runs. The kernel fetches full source text, streams progress in the Research Panel, writes a research Page through lifecycle, and auto-Ingests only after successful synthesis — max 3 concurrent, fourth waits.

## Boundaries & Constraints

**Always:**
- Confirm before any provider call. Topic + ≥1 query, both editable. Cancel / dismiss / dialog close starts no search and no Ingest.
- Active provider from Settings (env wins). Default Tavily. One active. Missing selected credentials fail visibly — no silent fallback to another provider.
- Full fetched source text to synthesis; no app-imposed truncation cap on that text. Tavily `include_raw_content` on. SerpApi/SearXNG use kernel readability extract.
- Firecrawl stays Capture-only. Rewrite the External Sources Firecrawl sentence so it does not say “for Deep Research.”
- Research Panel streams progress; concurrent tasks distinguishable; empty copy unchanged; thinking collapsible + follow-newest; reduced-motion jumps.
- Success: lifecycle research Page + Sources + `enqueueOrInline` Ingest. Failure/cancel: no Page, no Ingest. Never `createMemoryChangeProposal`.
- Max 3 `collecting`. Fourth stays `queued`. Independent of serial Ingest. Durable across restart.
- Owner APIs: 401 `Sign in required.`; `assertWritable` / read-only 403 on mutations (`READ_ONLY_REFUSAL.researchCreate` already exists — add matching run/cancel sentences or reuse one research-mutation sentence). English-only. Frozen identifiers. `loadPageConventions()` at synthesis time.
- Record `vaultId` (active wiki) on confirm so auto-Ingest lands in that Wiki.

**Block If:**
- Satisfying an AC requires sidecar Chat, office/email extract, MCP/skill/shell, Plaud OAuth, Graph viz changes, Review action-set changes, or renaming a frozen identifier.
- Completing a run would write only a memory-proposal, or would auto-Ingest on failed synthesis.
- Firecrawl would be added as a fourth search provider, or Settings would keep Firecrawl as the only External Sources control for this epic.
- `resolveResearchProvider` would keep silent fallback as the selected-provider behavior.

**Never:**
- Unconfirmed web search.
- Silent fallback when the selected provider cannot run.
- App-truncated source text (the current 4_000-char snippet slice) passed to synthesis as if it were full content.
- `createMemoryChangeProposal` / `/review` as the Deep Research success door.
- Auto-Ingest of a failed or cancelled synthesis.
- Taking the AD-9 serial Ingest slot for a research run, or dropping a fourth start.
- Editing `SCHEMA.md`, `llm-wiki.md`, or the Epic 5 `<intent-contract>`.
- Reusing Chat SSE event names (`meta`, `agent`, `done`, `cancelled`, `error`) for research.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Settings default | No stored provider | Active provider is Tavily | Select still offers SerpApi / SearXNG |
| Settings env pin | `TAVILY_API_KEY` set | Env key wins; Settings shows `hasTavilyApiKey`; cannot silently clear via store | Same pattern as other env keys |
| Selected key missing | Active = SerpApi, no SerpApi key | Run fails visibly; does **not** use Tavily even if `TAVILY_API_KEY` is set | 409/400 with availableProviders; panel shows error |
| Firecrawl only | Firecrawl stored, no Tavily/SerpApi/SearXNG | Firecrawl cannot satisfy a Deep Research start | Visible “configure a research provider” |
| Confirm Cancel | Dialog open | No project run; no provider call; mode unchanged if already on Graph/Review | — |
| Confirm 0 queries | Topic filled, queries empty | Confirm disabled | No POST |
| Graph / Review Confirm | ≥1 query | Create project with `vaultId` + queries + pageSlugs; immediately `run`; open Deep Research mode; Review item stays pending | 401/403; create failure does not run |
| Mode-direct start | Topic + queries on Research canvas | Same confirm rules; create + run | Empty canvas copy until a task exists |
| Tavily fetch | Active Tavily, key present | Search with `include_raw_content`; full `raw_content` (or equivalent) to synthesis | Provider 4xx/5xx → project `failed` |
| SerpApi / SearXNG fetch | Active that provider | Search, then kernel extract each http(s) URL | One URL extract fail skips that URL; zero usable sources → `failed` |
| Panel stream | Project `queued` / `collecting` / `ready` | Progress (queries done/total, message, results) updates in panel; height grows; ≥2 collecting rows distinct | Load error sentence; no crash |
| Fourth start | 3 already `collecting` | New project `queued`; panel shows waiting; starts when a slot frees | Not dropped; not inline-stolen |
| Overlap Ingest | Ingest compile running | Research may collect/synthesize | Research must not hold the ingest compile lock |
| Synthesis success | ≥1 usable source, LLM returns markdown | Lifecycle Page `research-{slug}`; Sources saved; Ingest queued; Activity shows jobs; `dataVersion` bumps; status `complete` | — |
| Synthesis fail | LLM empty/throw | status `failed`; no Page; no Ingest | Retryable; prior drafts unchanged |
| Cancel queued | `queued` | `cancelled` immediately; never starts | — |
| Cancel collecting | `collecting` | Stops before next query or before Page write | Partial results may remain on the project; no Page |
| Restart | `queued` / `collecting` in store | Survives; worker/lease resumes or fails visibly | No silent drop (SM-3 family) |
| Read-only | `YOPEDIA_READONLY=1` | 403 on create/run/cancel/PATCH/DELETE/Settings write; canvas start disabled | 401 still wins if unsigned |
| Unauthenticated | No principal | 401 `Sign in required.` | No project leak |
| Wiki switch | Confirm from wiki A | Auto-Ingest writes wiki A even if the rail later shows wiki B | Stale-response fence like Review |
| Thinking none | Model emits no think | No thinking chrome | Progress still streams |
| Reduced motion | `prefers-reduced-motion` | Thinking/panel jump; no follow-scroll animation | — |

</intent-contract>

## Code Map

Brownfield — extend, do not replace the store:

- `src/lib/research-projects.ts` -- Keep `tenants/{t}/research-projects.json`, `MAX_PROJECTS` 100, lock, statuses. Add/keep `vaultId`, `provider`, `progress`, `results`, `error`, `cancelRequested`. `[ASSUMPTION: add optional \`thinking\` on the project (panel-only, never Page/Source).]` Do not change the insert-order cap semantics.
- `src/lib/research-providers.ts` -- **Fix:** `resolveResearchProvider` must honor the selected/active provider and throw when that provider cannot run (no `available[0]` fallback for a missing selection). Tavily: set `include_raw_content` (Context7 `/websites/tavily`). Drop the 4_000-char slice on fetched full text (titles/URLs may still be bounded). SerpApi: pass Settings engine (default `google`). SearXNG: pass categories. Add a full-content extract helper for non-Tavily URLs.
- `src/lib/research-runtime.ts` -- **Fix:** stop `createMemoryChangeProposal`. Success = lifecycle Page + Sources + `enqueueOrInline`. Fail/cancel = no those writes. Honor cancel between queries and before the Page write. Drive progress messages the panel can show. Do not take the ingest compile lock.
- `src/lib/research-prefill.ts` -- Already correct for Graph. Do not regress Purpose/Overview/Insight reservation. Review continues to prefill stored `queries`.
- `src/app/api/research/route.ts` -- Create stays 401 / read-only 403 / 201. Accept `vaultId` / `wikiId` from Graph/Review/mode-direct.
- `src/app/api/research/[id]/run/route.ts` -- Create-then-run door. Add read-only 403. After `queueResearchProject`, enqueue `run-research` **or** wait behind the 3-slot lease. Inline fallback (no Cloudflare Queue) must still honor max 3 and must not block the HTTP request for the whole run `[ASSUMPTION: 202 + poll/SSE; do not keep today's "run the whole job inside the POST" as the Workbench path.]`
- `src/app/api/research/[id]/route.ts` -- PATCH/DELETE need read-only 403.
- `src/app/api/tasks/run/route.ts:252-255` -- Keep dispatching `run-research` to `runResearchProject`. Ensure ingest serialization (AD-9) does not include this kind.
- `src/lib/tasks.ts` -- Keep `kind: "run-research"`. Add a kernel concurrency lease (new small module) that admits at most 3 collecting runs; queued projects stay queued until a slot frees. `[ASSUMPTION: lease file \`tenants/{t}/research-leases.json\` or equivalent counted on the project registry; no new wrangler queue name.]`
- `src/lib/config.ts` / `src/lib/workbench-settings.ts` / `SettingsCanvas.tsx` -- External Sources: active research provider, Tavily key, SerpApi key + engine, SearXNG URL + categories, plus existing Firecrawl. Keys never in GET body (`hasTavilyApiKey`, `hasSerpApiKey`, …). Env-wins + `SECRET_UNTOUCHED` same as Firecrawl/custom. Rewrite `SETTINGS_FIRECRAWL_COPY`.
- `.env.example` -- Document `TAVILY_API_KEY`, `SERPAPI_API_KEY`, `SEARXNG_BASE_URL`, `RESEARCH_PROVIDER`. Keep Firecrawl as Capture, not “so Epic 6 can.”
- `src/components/workbench/DeepResearchConfirm.tsx` -- Keep. Confirm still requires topic + ≥1 query.
- `src/components/workbench/GraphCanvas.tsx` `confirmResearch` / `ReviewCanvas.tsx` `confirmResearch` -- After create, `POST /api/research/:id/run`, then `onOpenResearch(id)`. Pass `vaultId: wikiId`.
- `src/components/workbench/ResearchCanvas.tsx` -- Replace draft-only cards. Topic + queries (empty copy already assumes “a topic above”). List running / queued / failed / complete tasks. Stream progress. Thinking chrome reused from Chat. Start control disabled when read-only or <1 query.
- `src/lib/workbench-state.ts` -- `writeStoredResearchFill` / `readStoredResearchFill` stay as “which project to highlight,” not as the SoR.
- `src/lib/workbench-modes.ts` -- Keep empty copy. Do not invent a research badge (Todos/Review only).
- `src/lib/lifecycle.ts` / `src/lib/raw.ts` / `src/lib/ingest-async.ts` / `src/app/api/chat/conversations/[id]/save/route.ts` -- Reuse the save-to-wiki ingest door. Page writes bump `dataVersion`.
- `src/lib/html-parse.ts` -- Reuse for SerpApi/SearXNG URL extract. Do not add unpdf/Turndown.
- `src/lib/memory-proposals.ts` / `/review` -- **Read-only for this epic.** Do not route success here.
- `src/lib/owner-route.ts` / `src/lib/read-only.ts` -- 401 + writable gates on run/cancel/settings.
- `src/lib/schema.ts` -- `loadPageConventions()` into synthesis only. Do not edit SCHEMA.md.
- `src/lib/portable-archive.ts` -- Tenant walk already ships `research-projects.json`. Pin a test that it rides along. Do not put research JSON in Obsidian stubs.
- `src/components/KnowledgeStudio.tsx` -- Legacy research desk. **Out of scope.** Do not mount it as the Workbench panel.
- Tests: `research-providers.test.ts`, `research-projects.test.ts`, `research-route.test.ts`, `research-prefill.test.ts`, `workbench-settings.test.ts`, Graph/Review canvas confirm tests, `tasks-route.test.ts`. Add: no silent fallback; Tavily raw content; run read-only; create-then-run; max-3 wait; success lifecycle+ingest; fail writes nothing; no memory-proposal; Firecrawl copy; Settings provider fields.

New (expected):

- Kernel research concurrency lease + tests.
- Settings research-provider fields + External Sources UI.
- Research Panel streaming (poll `GET /api/research` on an interval **or** a kernel SSE such as `GET /api/research/[id]/stream`). `[ASSUMPTION: either is fine if progress is real-time enough to show query/fetch/synthesis transitions without a full reload; prefer SSE if poll would miss thinking lines.]`
- `READ_ONLY_REFUSAL` entries for research run/cancel if create's sentence is too narrow.

Context7 before changing Tavily/SerpApi/SearXNG request shapes (`/websites/tavily`; resolve SerpApi and SearXNG the same way). Do not guess new query params.

## Tasks & Acceptance

**Execution (sprint keys):**

- **6.1** Settings + provider resolve + full-content fetch. External Sources gains Tavily / SerpApi / SearXNG. Firecrawl copy corrected. `resolveResearchProvider` loses silent fallback. Tavily raw content on. SerpApi engine + SearXNG categories persist. Tests for env-wins, missing-selected-key, Firecrawl-is-not-enough.
- **6.2** Confirm starts the run. Graph/Review/mode-direct: create + `vaultId` + run. Cancel stays inert. Review item not auto-skipped. Read-only disables start. Canvas no longer claims “web search has not started” for a project that is queued/collecting.
- **6.3** Research Panel streams. Empty copy unchanged. Concurrent rows distinguishable. Thinking chrome + follow-newest + reduced-motion. Dynamic height (not a fixed stub).
- **6.4** Kernel lease max 3. Fourth waits (`queued`). Independent of AD-9 ingest. Restart-safe. Cancel queued vs collecting. Inline/dev path honors the same cap.
- **6.5** Success Page + conventions + wikilinks + Sources + `enqueueOrInline`. Failure/cancel write nothing to the wiki. Remove memory-proposal completion. `dataVersion` after the Page write.

**Acceptance Criteria:**

- Given Settings has no stored research provider, when External Sources renders, then the active provider is Tavily and SerpApi / SearXNG are selectable.
- Given the selected provider’s key is missing, when I confirm Deep Research, then the task fails visibly and no other configured provider is used.
- Given only a Firecrawl key is stored, when I start Deep Research, then start is refused; Firecrawl is not treated as the search provider; the Firecrawl sentence does not say the key is “for Deep Research.”
- Given I open the confirm dialog and press Cancel, when the dialog closes, then no provider HTTP occurs and no Ingest job is created.
- Given I confirm with a topic and ≥1 query from Graph, Review, or Deep Research mode, when the confirm lands, then a project is created with those queries and the active `wikiId`, a run is queued, and Deep Research mode shows the panel — not a draft-only “web search has not started” card.
- Given a Review item’s Deep Research confirm succeeds, when I return to Review, then that item is still pending (not Skip’d).
- Given Tavily is active and configured, when a query runs, then fetched source text includes Tavily raw content and is not sliced to 4_000 characters before synthesis.
- Given SerpApi or SearXNG is the selected provider, when results return, then each http(s) URL is extracted via the kernel readability path before synthesis.
- Given a run is collecting, when I have Deep Research open, then the panel shows query/fetch/synthesis progress and grows with content. Two collecting tasks are visually distinct.
- Given three runs are collecting, when I confirm a fourth, then the fourth is `queued` (visible, not dropped) and starts only after a slot frees.
- Given Ingest is compiling a Source, when a Deep Research run is collecting, then both may proceed; research does not occupy the serial Ingest compile slot.
- Given synthesis succeeds, when the run completes, then a `research-{slug}` Page exists (lifecycle, conventions, `[[wikilink]]`s + URL citations), Sources for the fetched URLs exist, Activity shows the auto-Ingest job(s), and no memory-proposal is created.
- Given synthesis throws or returns empty, when the run finishes, then status is `failed`, no new Page exists, and no Ingest job was queued.
- Given a `queued` run is cancelled, when cancel lands, then it never starts. Given a `collecting` run is cancelled, then it stops before the Page write.
- Given a queued or collecting project exists, when the process restarts, then the project is still listed (not silently gone).
- Given the deployment is read-only, when I POST create or run, then 403 and the store is untouched.
- Given no principal, when I GET/POST research APIs, then 401 `Sign in required.`

## Assumptions (Fast path)

Tagged in Intent Resolution. Repeat for the implementer:

1. Reuse `yopedia-tasks` + a kernel max-3 lease. Do not add a wrangler Queue.
2. Tavily `include_raw_content` on; SerpApi/SearXNG extract with kernel readability; Firecrawl is not the fetch layer.
3. Auto-Ingest copies the Chat save-to-wiki door (lifecycle + raw Source + `enqueueOrInline`), not memory-proposals.
4. Research Page slug stays `research-{slugify(title)}` (not `wiki/queries/`).
5. Panel may poll or SSE; Chat SSE event names stay unused.
6. SerpApi default engine remains `google`.
7. Workbench run POST returns before the job finishes (202 + stream/poll). Today’s inline-complete-in-POST is test/dev fallback only and still honors the lease.
8. Optional `thinking` field on the project record; never cited, never saved as a Source or Page body.

## Open questions

None that block implementation. If an assumption is wrong, record the override in this spec (not in `epics.md`, not in the Epic 5 contract) before coding the opposite.

## Verification

- Vitest: I/O matrix rows above (providers, confirm, lease, success/fail writes, read-only, 401).
- Existing suites that pin Firecrawl-only External Sources, research-provider fallback, and memory-proposal completion must be updated to the new contract — do not leave them as silent regressions.
- Browser: Settings External Sources (Tavily default + Firecrawl still present); Graph/Review confirm Cancel vs Confirm; Deep Research empty copy; a mocked/dev run that shows panel progress; read-only start disabled. If a live provider key is absent, use mocked provider tests for fetch/synthesis and still click the Workbench empty/confirm/disabled paths.
- Do not claim done on a fill-only draft card.

## Review Triage Log

### 2026-08-24 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 20: (high 2, medium 11, low 7)
- defer: 2: (high 0, medium 2, low 0)
- reject: 14
- addressed_findings:
  - `[high]` `[patch]` `runResearchProject` / `queueResearchProject` refuse a second start on `collecting` / `ready` (and run refuses `complete`) so redelivery cannot search or write twice
  - `[high]` `[patch]` `drainResearchQueue` claims the slot before enqueue and skips waiters that already hold one, so panel poll cannot dispatch the same queued id twice
  - `[medium]` `[patch]` Graph/Review Confirm closes and opens the panel on the created id even when run is refused, so a second Confirm cannot mint another project
  - `[medium]` `[patch]` Mode-direct `start()` reloads the list after a refused run so the failed row appears
  - `[medium]` `[patch]` `wikilinkCandidates` is scoped to the project owner; agent/artifact pages are dropped
  - `[medium]` `[patch]` Research slot renews on a heartbeat through synthesis, not only search/fetch
  - `[medium]` `[patch]` Reconcile treats abandoned `ready` like `collecting`
  - `[medium]` `[patch]` SearXNG instance URL is read-only when `SEARXNG_BASE_URL` is env-pinned
  - `[medium]` `[patch]` `researchSourceSlug` distinguishes URLs that differ only by query string
  - `[medium]` `[patch]` Tavily/SerpApi throw `ResearchProviderUnconfiguredError` before fetch when the key is empty
  - `[medium]` `[patch]` Confirm never persists `vaultId: "current"`; omit when the rail has no real wiki id
  - `[medium]` `[patch]` `thinking` is model think-tokens only; kernel narration stays in `progress.message`
  - `[medium]` `[patch]` Success no longer calls `addToVault` with a Workbench wiki UUID
  - `[low]` `[patch]` Fetch progress sentence and counter use the same 1-based N
  - `[low]` `[patch]` Deep Research Confirm splits queries with `parseResearchQueries`
  - `[low]` `[patch]` Invalid `SEARXNG_BASE_URL` throws the typed unconfigured error
  - `[low]` `[patch]` Reconcile skips a row whose `updatedAt` will not parse
  - `[low]` `[patch]` Regression tests for re-entry, drain, refuse-then-open, poll, conventions, and reduced-motion
  - `[low]` `[patch]` Playwright Settings journey opens External Sources and pins Tavily default plus Capture Firecrawl copy
  - `[low]` `[patch]` Portable archive pin that `research-projects.json` rides along

## Auto Run Result

Status: done

**Summary:** Stories 6.1–6.5 close the Epic 5 draft-only confirm. Settings is the Deep Research provider SoR (Tavily default, SerpApi and SearXNG selectable, Firecrawl Capture-only, no silent fallback). Confirm from Graph, Review, or Deep Research mode creates then runs. The kernel fetches full source text, streams progress in the Research Panel, writes a lifecycle `research-{slug}` Page, and auto-Ingests only after successful synthesis. At most three runs collect at once; a fourth stays queued. Failed or cancelled synthesis writes no Page and queues no Ingest. Success never files a memory-proposal.

**Files:**
- `src/lib/research-providers.ts` — selected-provider resolve, Tavily `include_raw_content`, kernel extract, typed unconfigured errors
- `src/lib/research-runtime.ts` — create-then-run worker, full-text synthesis, lifecycle Page + Sources + Ingest, no memory-proposal, re-entry/drain guards
- `src/lib/research-concurrency.ts` — max-3 kernel lease (`tenants/{t}/research-leases.json`)
- `src/lib/research-panel.ts` — panel copy, poll interval, `researchWikiId`, `parseResearchQueries`
- `src/lib/workbench-settings.ts` / `src/lib/config.ts` / `SettingsCanvas.tsx` — External Sources Deep Research fields; rewritten Firecrawl sentence
- `src/components/workbench/ResearchCanvas.tsx` — live panel (queue / progress / thinking chrome)
- `GraphCanvas.tsx` / `ReviewCanvas.tsx` / `DeepResearchConfirm.tsx` — confirm creates then runs and opens the panel
- `src/app/api/research/**` — run 202, read-only 403, GET reconcile
- `.env.example` / `playwright.config.ts` — provider env docs; e2e pins empty research env
- Tests: runtime, concurrency, providers, routes, panel, Graph/Review confirm, Settings, portable archive, Playwright Settings + Research handoff

**Review:** 20 patches applied (2 high, 11 medium, 7 low). 2 deferred. 14 findings rejected (mode-direct must use the overlay dialog; poll vs SSE; literal `enqueueOrInline` helper name; `hasTavilyApiKey` true whenever env is set; sprint-status `done` vs spec `in-review`; Retry / Page-link on complete rows; pre-flight disable Start; same-title slug overwrite; collecting-resume; Knowledge Studio desk; Firecrawl-as-search; a second wrangler queue; Chat SSE event names for research; legacy `/settings` as a second SoR).

**Follow-up review:** true — 2 high patches; score `3 × 11 medium + 7 low = 40`.

**Verification:** Research Vitest set (providers, runtime, concurrency, routes, panel, Graph/Review, Settings, portable archive) 12 files / 172 tests green. Playwright `workbench-owner` Settings External Sources + Deep Research empty copy + Graph confirm handoff 3/3 green. Live provider keys were absent; fetch/synthesis is covered by mocked kernel tests; the browser path exercised unconfigured refusal (Failed row, no-credential copy) and Settings Tavily default + Firecrawl Capture copy.

**Residual risks:** `POST …/run` still enqueues without claiming a slot; a poll drain can enqueue a second `run-research` for the same queued id. The re-entry guard makes the second task a no-op. Lease last-write-wins and DELETE-without-release are recorded under `deferred`. Same-title `research-{slug}` overwrite is the locked slug assumption. Heartbeat failure plus a stale `updatedAt` can still let reconcile fail a live `ready` run after `2 × TTL`.

## Epic 6 retrospective remediations (2026-08-24)

Closed outside `<intent-contract>`. `followup_review_recommended` stays true until a fresh same-SHA review. The retrospective verdict stays `rejected` until that review.

- Max-three admission is compare-and-set and fail-closed; `queued`→`collecting` is an atomic predicate claim.
- Page / Source / Ingest completion is an idempotent outbox. Frontmatter `sources` come from fetched evidence. Partial ingest is `complete` with a pending sentence, never “Nothing was written” after a Page exists.
- DELETE retires the lease. Cancel of `ready` does not release the slot. PATCH is title/question/queries on draft/failed/cancelled only. `/run` refuses unknown actions and provider overrides.
- `vaultId` is the Workbench Wiki UUID. List, Page `wiki:`, Ingest `wikiId`, and Activity tags honour it. Graph/Review always start a created run, then fence only the UI.
- Synthesis thinking persists from `callLLMStream`. A failed poll keeps rows and keeps polling. Research extract uses `maxContentLength: null`.
- Race, fault, delivery, and browser-path gates live beside the existing research suites. The live Tavily row skips when no key is present.
