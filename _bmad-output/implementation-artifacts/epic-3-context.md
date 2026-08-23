# Epic 3 Context: Ask the wiki

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Christian asks the compiled wiki from the Workbench and gets cited answers — or an honest “no coverage” — instead of a hallucinated blob. Chat runs on the local sidecar Agent (browser to loopback), never on the Worker or in the browser. Independent Conversations persist, Search shares the same retrieval pipeline, and a good answer can be filed under `wiki/queries/` and auto-Ingested. This is the P0 ask capability: evidence-backed query over compiled Pages, not retrieve-only RAG.

## Stories

- Story 3.1: Sidecar health and Chat HTTP/SSE
- Story 3.2: Conversations sidebar and persistence
- Story 3.3: Tokenized retrieval, budget, and numbered assembly
- Story 3.4: Optional vector merge
- Story 3.5: Graph expansion for retrieval
- Story 3.6: Cited Chat answers
- Story 3.7: Sources-only Chat
- Story 3.8: Thinking blocks
- Story 3.9: Regenerate last turn
- Story 3.10: Save to Wiki
- Story 3.11: Search mode

## Requirements & Constraints

**Cited or silent.** When matching Pages exist, every non-empty answer includes at least one `[n]` that maps to that turn’s assembled context. When none match, say the wiki has no coverage and offer Ingest or Deep Research — no invented citations, no empty fake references panel.

**Sidecar or closed.** Chat requires the sidecar on the same machine as the browser. Cloud Chat returns 503 `sidecar_required`. Sidecar down: fail closed, status dot not live, no in-browser Agent stub. Search, trees, and Preview stay usable without the sidecar.

**Conversations are independent and kernel-durable.** Create, rename, delete, and switch. Messages and per-message citations restore after reload. Deleting a Conversation does not delete Wiki Pages. Export uses the nashsu record shape (id, name, messages, per-message citations).

**One retrieval pipeline for Chat and Search.** Phase 1 tokenizes `wiki/` and `raw/sources/` (English word + stop words; CJK bigram; title match +10 vs body-only). Optional vector (off by default) merges cosine ANN into those hits; missing or invalid credentials fail that phase visibly and fall back — Chat is never blank. Phase 2 expands seeds two hops with decay on the second hop, whether or not vector is on. Phase 3 is a 4K–1M token slider split 60% Pages / 20% history / 5% index / 15% system; history defaults to 10 messages and the tighter of N vs the 20% slot wins; changing N applies to the next send only. Phase 4 sends numbered full Page or Source bodies, not summaries; `purpose.md` and `index.md` stay in the system/index allocation. Do not stuff the whole Wiki into the prompt.

**Sources-only** is per-Conversation and visibly distinct; citations point at Sources, not concept Pages.

**Save to Wiki** files the main response only (no Thinking) under `wiki/queries/` with a link back to the Conversation, then auto-queues two-step Ingest. After that Ingest, the new Pages are retrievable.

**Regenerate** removes the last user+assistant pair and re-sends; no-op if empty. New citations come from new retrieval.

**Thinking is inspectable, not wiki prose.** Five-line fade while streaming (newer lines more opaque), collapsed after, stored on the message so expand works after reload, never cited, never in Save to Wiki. If the model emits none, show no thinking chrome. Honor `prefers-reduced-motion`.

**Search mode.** Idle copy is “Press Enter to search.” An empty UI query does not error. Hits come from Pages and Sources via phases 1–2 (vector only if on). Selecting a hit docks Preview. Image section and lightbox are later.

**Runtime.** Chat may overlap serial Ingest. The Workbench stays interactive while Chat streams. English-only UI and generation. Owner-only: unauthenticated wiki/chat APIs 401. A recent meeting decision should be reachable from Chat or Search as a cited Page without opening Plaud.

## Technical Decisions

**Two runtimes.** Workbench and wiki data plane stay on the Worker; the Chat Agent runs on the local sidecar at `127.0.0.1:19828`. The Worker cannot reach localhost. The browser posts Chat to loopback. The sidecar is not a second wiki — wiki reads and writes go through owner-auth kernel HTTP.

**Locked Chat contract.** `POST /api/v1/projects/:wikiId/chat` — JSON is the default; stream with `stream: true` or `Accept: text/event-stream`. SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error`. The `done` frame is the complete aggregate — the client must not also commit deltas as a second message. `{id}` is `current` or the Wiki UUID (a filesystem path is loopback-only; cloud never accepts a path). Cloud Chat and any `/chat` alias return 503 `sidecar_required`. The existing query module and `/api/query` are not this Chat (404 or unused). `mode: deep` may broaden evidence; it is not the Deep Research panel.

**Health and ownership.** `GET /api/v1/health` needs no auth and reports at least `ok`, `status`, `version`, `enabled`, `authRequired`, `authConfigured`, `allowUnauthenticated`, `tokenSource`. Sidecar owns health and Chat; kernel owns search and other wiki reads. Other loopback `/api/v1` routes reverse-proxy the kernel with identical bodies. Full loopback enablement, tokens, MCP, and the branded skill are later.

**Search HTTP.** `POST .../search` takes `query` and `topK`; hits carry `path`, `title`, `snippet`, `score`. Empty `query` on the API is 400. Kernel is the only search implementation.

**Persistence and prompts.** Conversations and Settings (including the independent Chat model) persist in the kernel store, not sidecar SQLite. Sidecar may cache a turn in memory. SCHEMA page conventions load into Chat prompts at runtime — do not fork a second copy.

**Vector.** Off by default. When on: independent endpoint, key, and model; embeddings are model-tagged; a mismatch is a miss, then tokenized fallback. ANN is Vectorize (or the kernel store), not LanceDB. All three credentials are required to enable.

**Writes.** Save to Wiki goes through the single Page write path so `dataVersion` bumps and Ingest side effects fire. The Chat Agent does not compile Pages.

**Out of this epic.** Graph expansion is kernel-only (2-hop neighborhood). Four-signal Relevance and Graph viz stay later. Skills, shell approval, `agent-workspace/` outputs, and a tool-picking Agent stay later.

## UX & Interaction Patterns

Chat is a rail icon, not a permanent center column. Preview docks when a citation (or tree pick) is active; empty Chat has no Preview.

Left of Chat: conversation sidebar with + New Chat (the one primary), a session list, and a distinct active row. Empty copy: “Start a new conversation. Click New Chat to begin.” Composer is per-Conversation; placeholder “Type a message…”; send disabled until text; Enter sends. Switching modes or Conversations must not apply unsaved composer text to another session.

Composer tool row includes Smart retrieval (Wiki default vs Sources-only). Attach, Web search, AnyTXT, and Skills may appear but are not required to function.

Cited-references panel is collapsible and grouped by page type. `[n]` or a panel row docks Preview. Chat answers stay system sans — Georgia is Preview body only.

Coverage missing: “Wiki has no coverage for this. Ingest a source or run Deep Research.” Sidecar down: fail-closed copy naming the sidecar / `:19828`; status dot not live. Vector misconfigured: that phase fails visibly and falls back. Missing LLM credentials: actionable Settings error, not a blank Chat.

Streaming answers use `aria-live` polite. Inputs are labeled beyond placeholder. Chat column ≥ 320px. Mode change announces the surface name. Empty canvases: one muted sentence plus optional one primary — no illustration, emoji, or encouragement.

## Cross-Story Dependencies

Health and SSE (3.1) is the contract every Chat story uses. Conversations (3.2) must persist before citations, regenerate, thinking-after-reload, and Save to Wiki can be durable.

Retrieval (3.3–3.5) is shared by Chat assembly and Search hits. Vector (3.4) must not gate tokenized + graph. Graph expansion ships without Graph-mode viz.

Cited answers (3.6) consume assembly plus SSE. Sources-only (3.7) is a retrieval constraint on the same Conversation. Thinking (3.8) and Save to Wiki (3.10) must agree: Thinking never files. Search (3.11) uses the kernel search route, not the sidecar Agent.

Depends on Epic 1 (rail Chat icon, dual models, vector-off, Schema, `dataVersion`) and Epic 2 (compiled Pages plus the auto-queue Ingest contract for Save to Wiki). Chat may overlap serial Ingest.

Do not implement Deep Research, Graph Insights, office extract, MCP/skill/shell, or the rest of `/api/v1`. Coverage-missing may offer those later surfaces.
