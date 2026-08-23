---
title: 'Stories 3.1–3.11: Ask the wiki'
type: 'feature'
created: '2026-08-22'
status: 'done'
baseline_revision: '625a3348f93d80ef97a28df4f1639000beac2d67'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/.yoyo/learnings.md'
warnings:
  - multiple-goals
  - oversized
deferred:
  - summary: >-
      Sidecar Chat generation uses process env keys; retrieve does not send
      provider secrets to the browser.
    evidence: |-
      Settings GET omits secrets. Loopback tokens are later. Chat fails
      closed with a Settings sentence when the sidecar has no key.
    location: >-
      sidecar/server.mjs
    severity: medium
  - summary: >-
      Save to Wiki writes the query Page, then queues a second text ingest of
      the same answer body.
    evidence: |-
      save/route.ts calls saveAnswerToWiki then enqueueOrInline(ingest
      sourceType text). Two-step compile may create another primary page.
    location: >-
      src/app/api/chat/conversations/[id]/save/route.ts
    severity: medium
  - summary: >-
      Phase 1 lists raw/sources/ non-recursively, so hashed snapshot files
      under a slug subdirectory are not retrieve candidates.
    evidence: |-
      listRawSources skips subdirectories by contract. Epic 2 hashed
      snapshots stay on readRawSourceById.
    location: >-
      src/lib/raw.ts
    severity: medium
  - summary: >-
      POST conversations/:id/messages { message } still runs Worker
      addChatTurn for the legacy /chat page.
    evidence: |-
      Workbench uses persist / retractLastTurn only. The { message } branch
      remains for ChatWorkspace.
    location: >-
      src/app/api/chat/conversations/[id]/messages/route.ts
    severity: medium
  - summary: >-
      Sidecar never emits cancelled; there is no Stop control. Thinking
      arrives as one agent frame after a blocking provider call.
    evidence: |-
      generateChat is one HTTP call; cancelled is parsed by the client but
      not produced. AC names the event, not a Stop button.
    location: >-
      sidecar/server.mjs
    severity: low
---

<intent-contract>

## Intent

**Problem:** Workbench Chat is a sidecar-gated empty sentence, Search is the same stub, and the only live ask path is Worker `query.ts` / `/chat` — not cited loopback Chat. Christian cannot ask the compiled wiki from the rail and get `[n]` citations or an honest no-coverage.

**Approach:** Ship Epic 3 on the existing Workbench rail: a Chat-only loopback sidecar (health + SSE), kernel-durable Conversations, one retrieval pipeline (tokenized → optional vector → 2-hop graph → budgeted numbered bodies) shared by Chat and Search, cited answers, Sources-only, Thinking, Regenerate, Save to `wiki/queries/` with auto-Ingest.

## Boundaries & Constraints

**Always:**
- Chat is browser → `127.0.0.1:19828` `POST /api/v1/projects/:wikiId/chat`. SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error`. JSON is the default; stream with `stream: true` or `Accept: text/event-stream`. The `done` frame is the complete aggregate — the client must not also commit deltas as a second message. `{id}` is `current` or the Wiki UUID. Cloud Chat and any `/chat` alias return 503 `sidecar_required`. `src/lib/query.ts` / `/api/query` is not v1 Chat.
- Sidecar binds `127.0.0.1:19828` only. It never imports `src/lib`, Next, or Clerk. Wiki reads/writes go through owner-auth kernel HTTP. Conversations and Settings stay in the kernel store. Sidecar may cache the in-flight turn only.
- `GET /api/v1/health` needs no auth and reports at least `ok`, `status`, `version`, `enabled`, `authRequired`, `authConfigured`, `allowUnauthenticated`, `tokenSource`. Browser probe fail-closed; status dot not live when down. No in-browser Agent stub.
- One retrieval pipeline for Chat and Search. Phase 1 tokenizes `wiki/` and `raw/sources/` (English word + stop words; CJK bigram; title match +10 vs body-only). Vector (off by default) merges cosine ANN; missing/invalid credentials fail that phase visibly and fall back — Chat is never blank. Phase 2 expands seeds two hops with 0.5 decay on the second hop, whether or not vector is on. Phase 3 is a 4K–1M token slider split 60% Pages / 20% history / 5% index / 15% system; history defaults to 10 messages and the tighter of N vs the 20% slot wins; changing N applies to the next send only. Phase 4 sends numbered full Page or Source bodies, not summaries. `purpose.md` and `index.md` stay in the system/index allocation. Schema conventions load via `loadPageConventions()` at runtime. Do not stuff the whole wiki into the prompt. Do not use `selectPagesForQuery`'s small-wiki-all-pages or empty-fallback-to-first-N for Chat/Search.
- Matching Pages: every non-empty answer includes at least one `[n]` that maps to that turn’s assembled context. No match: exactly `Wiki has no coverage for this. Ingest a source or run Deep Research.` — no invented citations, no empty fake panel.
- Conversations: create, rename, delete, switch; messages and per-message citations restore after reload; delete does not delete Wiki Pages. Export shape is nashsu (`id`, `name`, `messages`, per-message citations). Sources-only is per-Conversation and visibly distinct. Thinking is stored, never cited, never in Save to Wiki. Regenerate removes the last user+assistant pair and re-sends; no-op if empty.
- Save to Wiki writes the main response only under `wiki/queries/` with a Conversation link, through `writeWikiPageWithSideEffects`, then auto-queues two-step Ingest.
- Search UI empty copy is `Press Enter to search.` An empty UI query does not error. Search API empty `query` is 400. Hits carry `path`, `title`, `snippet`, `score`. Selecting a hit docks Preview.
- Owner-only kernel wiki/chat/search APIs 401. English-only UI and generation. Frozen `yopedia` / `WORKWIKI_*` identifiers. Chat answer type is system sans; Georgia is Preview body only. Chat may overlap serial Ingest. Workbench stays interactive while Chat streams.

**Block If:**
- Satisfying an AC requires Deep Research UI, Graph viz/sigma, 4-signal Relevance, office extract, MCP/skill/shell, `agent-workspace/` tool chips, Plaud OAuth, or renaming a frozen identifier.
- Chat generation would run on the Worker or in the browser.
- A write would invent a second markdown/page writer.

**Never:**
- In-browser TS Agent stub; Worker-hosted Chat Agent; binding the sidecar to `0.0.0.0`.
- Treating `/api/query` or `ChatWorkspace` `/chat` as v1 Chat.
- LanceDB. Sidecar SQLite/JSON as Conversation SoR.
- Fake citations. Filing Thinking. Image Search lightbox (Epic 7).
- Cloud accepting a filesystem path as `{wikiId}`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Health up | Sidecar on `:19828` | `GET /api/v1/health` 200, required fields; rail dot live; Chat column mounts | No error expected |
| Health down | Nothing on `:19828` | EXPERIENCE sidecar-down copy; dot not live; no composer, no Worker/browser Agent | Fail closed |
| Cloud Chat | `POST` OpenNext `/api/v1/projects/:id/chat` or `/api/v1/chat` | 503 `{ "error": "sidecar_required" }` | Not a Chat implementation |
| SSE turn | Loopback `stream: true` or `Accept: text/event-stream` | Events `meta`, `agent`, `done`, `cancelled`, `error` only; client commits `done` once | `error` / `cancelled` frames; no second message from deltas |
| JSON turn | Loopback POST without stream | Single JSON aggregate (same fields as `done`) | 4xx/5xx JSON |
| Conversations | New / rename / delete / switch / reload | Independent threads; citations restore; delete is conversation-only | Empty title refused; unsaved composer stays with its conversation |
| Tokenized retrieve | Vector off, matching Pages | Phase 1 over `wiki/` + `raw/sources/`; title +10; numbered full bodies under budget | Empty assemble → coverage sentence |
| Vector on | Endpoint + key + model | Cosine ANN merges; model-tag mismatch is a miss then tokenized | Visible phase failure; Chat not blank |
| Graph expand | Seeds from Phase 1 (± vector) | 2-hop, 0.5 second-hop decay; wikilinked neighbor may enter | Expansion failure keeps seeds |
| Cited answer | Matching Pages | ≥1 `[n]`; collapsible panel grouped by type; `[n]`/row docks Preview | No fake panel if empty |
| No coverage | No Phase 1–2 hits | Exact coverage sentence; no `[n]`; no panel | Not an LLM hallucination |
| Sources-only | Per-conversation Smart retrieval | Citations are Sources; chrome distinct from Wiki Chat | Switch back allows Page citations |
| Thinking | Model emits reasoning | 5-line fade (newer more opaque); collapsed after; stored; `prefers-reduced-motion` | No chrome if none emitted |
| Regenerate | Last user+assistant pair | Pair removed, user re-sent, new retrieval/citations | Empty conversation: no-op |
| Save to Wiki | Assistant answer | `wiki/queries/<slug>` main body only + Conversation link; lifecycle write; two-step Ingest queued | Thinking omitted; read-only refuses |
| Search empty UI | Search mode, blank field | `Press Enter to search.`; no error | Do not call API |
| Search API empty | `POST …/search` `{ query: "" }` | 400 | Owner missing → 401 |
| Search hit | Non-empty query | Ranked Pages + Sources (phases 1–2; vector only if on); pick docks Preview | No image lightbox |

</intent-contract>

## Code Map

- `src/lib/sidecar.ts:15-16,48-91` -- `SIDECAR_ORIGIN` / `SIDECAR_HEALTH_URL` / `probeSidecar`. Point the probe at `GET /api/v1/health` (today `/health`). Fail-closed 2xx only. Never add a Worker proxy to localhost.
- `src/hooks/useSidecarStatus.ts:22-76` -- 15s visible-tab poll. Keep.
- `src/lib/workbench-modes.ts:37-40,73-83` -- Chat empty + `CHAT_SIDECAR_DOWN_COPY`. Add coverage-missing and composer placeholder here (one definition). Search empty is already `Press Enter to search.`
- `src/components/workbench/ModeCanvas.tsx:122-143` -- Replace the Chat/Search sentence stubs with real surfaces when those modes are active; sidecar-down Chat stays the down copy only. Do not unmount Wiki (`hidden` pattern). Update `workbench-chrome.test.ts:312-315` which pins the ternary stub.
- `src/components/workbench/Workbench.tsx:287,362,1554-1622` -- `useSidecarStatus`, `shouldDockPreview`, `<ModeCanvas>`, `<PreviewColumn>`. Dock Preview from Chat `[n]` / Search hit as well as Wiki tree. Do not import `ChatWorkspace`.
- `src/lib/workbench-tree.ts:417-422` -- `shouldDockPreview` is Wiki-only today; extend for Chat citation + Search selection without docking empty Chat.
- `src/components/workbench/IconRail.tsx:78-133` -- Sidecar status dot. Keep labels.
- `src/lib/chat.ts:56-217,375-528` -- Kernel Conversation SoR (`tenants/{t}/chat-conversations.json`). Reuse list/create/update/delete. Extend message with `citations[]` + `thinking?`; export `name` (today `title`); add token budget (4K–1M) + `historyDepth` (default 10). Do not call `generateChatAnswer` / `addChatTurn` from Workbench Chat (Worker LLM).
- `src/app/api/chat/conversations/route.ts` / `[id]/route.ts` / `[id]/messages/route.ts` -- Keep CRUD + owner auth. Messages POST must not run Worker generation for v1 Chat; persist user/assistant frames the sidecar (or a kernel persist helper) writes after `done`.
- `src/lib/query-search.ts:155-258,274-338,411-481` -- BM25 + vector RRF + `expandGraphSeeds`. **Do not** reuse `selectPagesForQuery` for Epic 3: it returns all pages under `SMALL_WIKI_THRESHOLD` and falls back to first-N on empty (`:424-432`) — that stuffs the wiki and forbids honest no-coverage. New assemble/search entry in a dedicated module that calls `tokenize` / `bm25Score` / `searchByVector` / `expandGraphSeeds` / `buildRawSourceContext`.
- `src/lib/bm25.ts:11,90-97,190-247` -- Word + stop words + CJK bigram. Existing `TITLE_BOOST` is `2.0 * idf` (`constants.ts:108`). Epic 3 Phase 1 title match is **+10 vs body-only** — apply that additive on the new retrieve path, do not silently keep 2.0×idf as +10.
- `src/lib/graph-relevance.ts:127-174` -- `expandGraphSeeds` already 1-hop then 0.5 second hop. Reuse.
- `src/lib/embeddings.ts:848-898` -- `searchByVector`; model-tag mismatch is a miss. Gate with `getVectorSearchSettings().enabled` (`config.ts:1193-1236`). Vector failure must surface to Chat, not only `logger.warn` (`query-search.ts:197-200`).
- `src/lib/schema.ts:52-68` -- `loadPageConventions()` into Chat system prompt. No second SCHEMA copy.
- `src/lib/query.ts:219-233,390-508` -- `buildQuerySystemPrompt` / `saveAnswerToWiki`. Extend save: default slug under `wiki/queries/`, Conversation backlink, main body only, then `enqueueOrInline` two-step Ingest. Keep `writeWikiPageWithSideEffects`. Do not use `/api/query` as Chat.
- `src/app/api/query/route.ts` / `query/stream/route.ts` -- Leave unused for v1 Chat (legacy `/query` page may stay). Workbench must not call them.
- `src/app/api/wiki/search/route.ts:15-46` -- GET fuzzy `fuzzySearchWikiContent`. Workbench Search and `POST /api/v1/projects/:wikiId/search` use the new Phase 1–2 pipeline, not this GET.
- `src/lib/lifecycle.ts:741-767` -- Save-to-Wiki writes only through `writeWikiPageWithSideEffects` (bumps `dataVersion`).
- `src/lib/ingest-async.ts` / `src/app/api/workbench/intake/route.ts` -- Reuse `enqueueOrInline` for query-page auto-Ingest. Same owner-serial compile as Epic 2.
- `src/lib/config.ts:1159-1172` -- `getChatModelSettings()`. Sidecar fetches Settings via kernel HTTP; Chat model is independent of ingest.
- `src/lib/citations.ts:5-22` -- `](slug.md)` extractor. Epic 3 citations are `[n]` → assembled row (`path`, `title`, type). New mapper; keep this for legacy `/chat`.
- `src/components/ChatWorkspace.tsx` / `src/app/chat/page.tsx` -- Legacy. Read-only for this story; do not mount in Workbench.
- `src/lib/__tests__/sidecar.test.ts:23-28` -- Pins `/health`; update with the `/api/v1/health` probe.
- `integrations/browser-clipper/` -- Read-only.

New (expected):
- `sidecar/` -- Loopback process: `GET /api/v1/health`, `POST /api/v1/projects/:wikiId/chat` (JSON + SSE). Chat-only. No extract/MCP/shell. Bind `127.0.0.1` only. Generation + SSE live here. Kernel retrieve/persist/Settings stay owner-auth on the Workbench origin (browser-mediated is fine — loopback tokens are later).
- `src/app/api/v1/projects/[wikiId]/chat/route.ts` / `src/app/api/v1/chat/route.ts` -- Cloud 503 `sidecar_required` only.
- `src/app/api/v1/projects/[wikiId]/search/route.ts` -- Kernel search (`query`, `topK` → hits). 400 empty query; 401 unauthenticated.
- `src/lib/wiki-retrieve.ts` -- Shared Phase 1–4 assemble + Phase 1–2 search hits. Sources-only constraint. Token budget packer. Numbered bodies.
- `src/components/workbench/ChatCanvas.tsx` / `SearchCanvas.tsx` -- Rail surfaces. Conversation sidebar, composer, citations, thinking, regenerate, save. Search field + results.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-retrieve.ts` -- Phase 1–4 assemble + Phase 1–2 search hits; title +10; no whole-wiki / first-N fallback; vector gated + visible failure; `expandGraphSeeds`; numbered full bodies; `purpose.md`/`index.md` in system/index; `loadPageConventions()`; Sources-only uses `raw/sources/` via `buildRawSourceContext`.
- `src/lib/chat.ts` + `src/app/api/chat/conversations/**` -- Persist `name`, messages, `citations`, `thinking`, token budget, `historyDepth`, `retrievalMode`; delete is conversation-only; no Worker `addChatTurn` for Workbench.
- `src/app/api/v1/projects/[wikiId]/search/route.ts` -- Owner-auth POST; FR-76 fields; empty query 400.
- `src/app/api/v1/projects/[wikiId]/chat/route.ts` + `src/app/api/v1/chat/route.ts` -- 503 `sidecar_required`.
- `src/lib/sidecar.ts` + `src/lib/__tests__/sidecar.test.ts` -- Probe `http://127.0.0.1:19828/api/v1/health`.
- `sidecar/` -- Health + Chat HTTP/SSE; loopback only; `done` is the aggregate; Chat model from kernel Settings (Workbench may fetch Settings and pass what the sidecar needs to generate). Retrieve/persist stay on owner-auth kernel routes — do not invent a loopback token product.
- `src/lib/query.ts` / save door -- `wiki/queries/` + Conversation link + `writeWikiPageWithSideEffects` + `enqueueOrInline` two-step; body excludes Thinking.
- `src/lib/workbench-modes.ts` / `workbench-tree.ts` / `ModeCanvas.tsx` / `Workbench.tsx` / `ChatCanvas.tsx` / `SearchCanvas.tsx` -- Chat column (≥320px): sidebar + New Chat + composer (`Type a message…`, Enter sends, send disabled until text); coverage and sidecar-down copy from the shared module; `[n]` + panel dock Preview; Sources-only chrome; 5-line Thinking; Regenerate; Save; Search empty no-error; hit docks Preview; `aria-live` polite; system sans; `prefers-reduced-motion`.
- `src/lib/__tests__/wiki-retrieve.test.ts` / `chat-store.test.ts` / `workbench-epic3.test.ts` -- Pin the I/O matrix (retrieve/coverage/vector-fallback/graph; persist/export; cloud 503; SSE event names; copy; dock).

**Acceptance Criteria:**
- Given the sidecar is running on `127.0.0.1:19828`, when I `GET /api/v1/health`, then it needs no auth and reports at least `ok`, `status`, `version`, `enabled`, `authRequired`, `authConfigured`, `allowUnauthenticated`, `tokenSource`.
- Given I `POST /api/v1/projects/:wikiId/chat` on the sidecar with `stream: true` or `Accept: text/event-stream`, when a turn runs, then SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error`, JSON is the non-stream default, the `done` frame is the complete aggregate, and `{id}` accepts `current` or the Wiki UUID.
- Given Chat is posted to the cloud OpenNext origin, when that route runs, then it returns 503 `sidecar_required`, and `/api/query` is not v1 Chat.
- Given the sidecar is down, when I open Chat, then I see the sidecar-down copy, the status dot is not live, and there is no in-browser Agent.
- Given Chat mode is open, when the sidebar shows, then I can New Chat, rename, delete, and switch, empty copy is `Start a new conversation. Click New Chat to begin.`, composer placeholder is `Type a message…`, and send is disabled until there is text.
- Given two Conversations exist, when I switch, then messages do not mix, the active row is distinct, and unsaved composer text is not applied to the other Conversation.
- Given I reload, when Chat opens, then Conversations, messages, and per-message citations restore from the kernel, export uses `id` / `name` / `messages` / per-message citations, and delete does not delete Wiki Pages.
- Given vector search is off, when Search or Chat retrieves, then Phase 1 tokenized search runs over `wiki/` and `raw/sources/`, English uses word split + stop words, CJK uses bigram, and a title match adds +10 vs body-only.
- Given I set the context slider between 4K and 1M tokens, when a Chat turn assembles context, then the prompt does not exceed that budget, the split is 60/20/5/15, history defaults to 10 and the tighter of N vs the 20% slot wins, and changing N applies to the next send only.
- Given Pages are selected for the wiki slice, when Phase 4 runs, then the model gets numbered full Page/Source bodies, `purpose.md` and `index.md` stay in the system/index allocation, and Schema conventions load at runtime.
- Given vector is on with endpoint, key, and model, when retrieval runs, then cosine ANN merges into tokenized hits, embeddings are model-tagged, mismatch is a miss then tokenized fallback, and ANN is Vectorize or the kernel store.
- Given vector credentials are missing or invalid, when that phase fails, then the failure is visible, Chat falls back to tokenized + graph, and Chat is not blank.
- Given Phase 1 (and 1.5 if on) returned seed hits, when Phase 2 runs, then expansion is 2-hop with decay on the second hop, it runs whether or not vector is on, and a wikilinked neighbor of a top hit can enter the candidate set without Graph-mode viz.
- Given matching Pages exist, when the sidecar finishes a turn, then the answer includes at least one `[n]` that maps to assembled context, a collapsible cited-references panel lists those Pages grouped by type, `[n]` or a panel row docks Preview, citations are stored on the message, and Chat type stays system sans.
- Given no Page matches, when the model would answer, then the UI states `Wiki has no coverage for this. Ingest a source or run Deep Research.` and there is no fake citation and no empty fake panel.
- Given I send from the composer, when the sidecar streams, then the Workbench stays interactive.
- Given Smart retrieval is Sources-only, when I send, then citations point at Sources, not concept Pages, and the chrome is distinct; switching back to Wiki allows Page citations and the setting is per Conversation.
- Given the model emits a Thinking block, when it streams, then a 5-line rolling viewport shows with newer lines more opaque, `prefers-reduced-motion` is honored, Thinking collapses after the turn, is stored, is not a citation, and is not in Save to Wiki; if none is emitted, there is no thinking chrome.
- Given a Conversation has a last user+assistant pair, when I Regenerate, then that pair is removed and the user message is re-sent with new retrieval; if empty, Regenerate is a no-op.
- Given an assistant answer exists, when I Save to Wiki, then a query Page is written under `wiki/queries/` with a Conversation link, the body is the main response only, writes go through `writeWikiPageWithSideEffects`, and arrival auto-queues two-step Ingest so later Chat/Search can retrieve the new Pages.
- Given Search mode is open with an empty query, when I look at the canvas, then copy is `Press Enter to search.` and an empty query does not error.
- Given I submit a Search query, when results return, then they are ranked hits from `wiki/` and `raw/sources/` using Phases 1–2 (vector only if on), selecting a hit docks Preview, `POST /api/v1/projects/:wikiId/search` matches `query` / `topK` / hits `{path,title,snippet,score}`, empty API `query` is 400, and image lightbox is not required.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 20: (high 3, medium 15, low 2)
- defer: 5: (high 0, medium 4, low 1)
- reject: 8
- addressed_findings:
  - `[high]` `[patch]` Chat/Search now use `send()` as a parsed-body helper (required `init`, no `.json()`)
  - `[high]` `[patch]` Sidecar no longer appends a fake `[1]`
  - `[high]` `[patch]` Read-only disables New Chat, delete, rename, send, regenerate, and settings writes
  - `[medium]` `[patch]` Token budget persists on change with the new value
  - `[medium]` `[patch]` Regenerate restores the user text if re-send fails
  - `[medium]` `[patch]` Save link includes `conversation=` and Chat restores that id
  - `[medium]` `[patch]` Persist throws when the conversation is missing; save reports errors
  - `[medium]` `[patch]` In-flight send guard; abort on switch/delete; optimistic user row
  - `[medium]` `[patch]` Citation n/path guards; skip blank frames; MAX_MESSAGES; first non-empty user title
  - `[medium]` `[patch]` Sidecar decodeURIComponent fail-soft; 1MB body cap
  - `[medium]` `[patch]` Numbered bodies trimmed back into the page budget
  - `[medium]` `[patch]` Search errors no longer look like zero hits
  - `[medium]` `[patch]` Chat/Search mount when sidecar is up without requiring `onDockPreview`
  - `[medium]` `[patch]` `wiki/queries/<slug>` docks Preview as a page
  - `[medium]` `[patch]` Persist/retract/retrieve/tokenBudget tests execute
  - `[low]` `[patch]` Flush leftover SSE buffer; leftover `done` is applied

## Design Notes

Sidecar in this epic is Chat-only (health + one Chat route). Extract, MCP, shell, and the rest of `/api/v1` stay later. Implementation language is whatever stays off the Worker and off `src/lib`. Other loopback `/api/v1` routes are not required.

Kernel I/O (retrieve, conversations, Settings, Save to Wiki) is owner-auth on the OpenNext origin. The Workbench already has that session. Loopback API tokens are later — do not invent them here. The browser may assemble via a kernel route, POST the numbered context + history + model to the sidecar, then persist `done` to the conversation API. The sidecar must not become Conversation or Page SoR.

`selectPagesForQuery` is the wrong entry for Epic 3: small wikis get every page, and a miss becomes first-N. New `wiki-retrieve` must return zero hits for no-coverage.

`done` is the commit. Streamed `agent` deltas are paint-only.

Golden path: New Chat → composer send → kernel assemble → sidecar SSE → `done` persisted on the conversation → `[n]` docks Preview. Skip path: no hits → coverage sentence, no LLM answer-as-fact. Save path: main body → `wiki/queries/` → lifecycle → `enqueueOrInline`.

Coverage-missing may *name* Deep Research; it must not open that panel.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/wiki-retrieve.test.ts src/lib/__tests__/chat-store.test.ts src/lib/__tests__/sidecar.test.ts src/lib/__tests__/workbench-modes.test.ts src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/query.test.ts` -- expected: pass; title +10; no-coverage empty assemble; vector fallback; 2-hop; cloud 503; SSE names; probe `/api/v1/health`; `wiki/queries/` save; copy pins; brand scan clean

## Auto Run Result

Status: done

**Summary:** Epic 3 Ask the wiki on the Workbench rail. Chat-only loopback sidecar (health + SSE), kernel Conversations with citations/thinking, one retrieve pipeline for Chat and Search, cited answers or the exact no-coverage sentence, Sources-only, Regenerate, Save to `wiki/queries/` with auto-Ingest, Search hits that dock Preview. Cloud Chat is 503 `sidecar_required`.

**Files:**
- Retrieve: `src/lib/wiki-retrieve.ts`, `src/lib/chat-contract.ts`, retrieve/search v1 routes
- Conversations: `src/lib/chat.ts`, persist/retract/save routes
- Sidecar: `sidecar/server.mjs`, probe `/api/v1/health`
- Cloud 503: `src/app/api/v1/chat/route.ts`, `src/app/api/v1/projects/[wikiId]/chat/route.ts`
- Save: `src/lib/query.ts` `wiki/queries/<slug>` + conversation link + enqueue
- Workbench: `ChatCanvas.tsx`, `SearchCanvas.tsx`, `ModeCanvas.tsx`, `workbench-tree.ts`, `workbench-modes.ts`
- Tests: wiki-retrieve, chat-store, chat-routes, workbench-epic3, query save, sidecar, chrome/modes

**Review:** 20 patches applied (3 high, 15 medium, 2 low). 5 deferred. 8 rejected (Stop button, browser API keys, export UI, R2 sidecar-owns-retrieve, image lightbox, inventing citations to satisfy [n], treating leftover addChatTurn as this story's SoR, CORS lockdown on loopback).

**Follow-up review recommended:** true — patched high 3, medium 15, low 2; score `3×15 + 1×2 = 47` (≥ 5). High alone forces true.

**Verification:**
- Spec command plus chat-routes and workbench-tree: 273 passed (10 files)

**Residual risks:** Sidecar keys from machine env; Save queues a second text ingest; hashed `raw/sources/<slug>/<hash>` not in Phase 1 listing; leftover Worker `addChatTurn` on `{ message }`; cancelled/Stop not shipped; Thinking is one post-generation frame.

**Browser:** Chat/Search rail flows were not exercised in a running Next.js Workbench this run.
