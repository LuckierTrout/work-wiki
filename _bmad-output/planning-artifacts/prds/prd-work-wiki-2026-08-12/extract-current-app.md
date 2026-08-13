# work-wiki — Current App Extract (2026-08-12)

Survey of shipped user-facing surfaces vs nashsu/llm_wiki-style personal workbench. Sources: `README.md`, `PRODUCT.md`, `work-wiki-concept.md`, `src/app/**`, `src/lib/**`, `src/mcp.ts`.

## What already exists

**Ingest** — `/ingest` UI: URL, PDF (upload/URL), X post, YouTube, paste text, image. Async job polling, batch API, re-ingest, recent-ingests list. `/save` capture via bookmarklet, PWA share sheet, iOS Shortcut (confirm + vault picker). Agent-token ingest routes. Full ingest pipeline in `src/lib/ingest.ts` (LLM synthesis → canonical concept pages, merge, provenance).

**Wiki browse & read** — `/wiki` paginated browse with scope lens (Public commons / `vault:<id>`), tags, sort. Article pages at `/wiki/[slug]` and tenant silos `/u/[handle]/[slug]`. Wiki log, contributors, export API, raw markdown routes, revisions, discuss/talk threads + agent reconcile loop. Human prose-edits blocked on commons pages (talk is steering surface).

**Search** — `GlobalSearch` in nav (BM25/hybrid via `src/lib/search.ts`); browse inline search; `/api/wiki/search`.

**Query (“Ask”)** — `/query` streaming Q&A with citations, format toggle (prose/HTML), vault/scope lens, query history sidebar (last 20), save-answer-to-wiki. Not a persistent multi-chat workspace — single Q&A page with history list.

**Lint** — Owner-only `/lint` + `/api/lint` + auto-fix; MCP `lint_wiki` / `fix_lint_issue`. Checks expiry, duplicates, disputes, broken links, etc.

**Graph** — `/wiki/graph` force-directed canvas; vault-scoped; MCP `wiki_graph`. No “Insights → Deep Research” loop observed.

**Auth** — Clerk sign-in (writes require session); public reads. Per-agent tokens + service token for MCP/API/task consumer. Owner handle gates lint/settings/admin.

**MCP** — Rich stdio server (`src/mcp.ts`, 40+ tools) + HTTP `/api/mcp`: search/read/write/merge pages, all ingest modes, query/save_query_answer, discussions, reconcile, reingest, vaults, lint, graph, maintenance_scan, activity_trail.

**Backend tasks (not user todos)** — Cloudflare Queues consumer runs `reconcile` + async `ingest` tasks (`src/lib/tasks.ts`). No UI task/todo list for humans.

**Also shipped** — Vaults (`/vault`), agents (`/agents`), settings (LLM provider/model, embeddings rebuild), waitlist, CLI (`src/cli.ts`).

## Clearly missing vs nashsu-like personal UX

**3-column chat-centric shell** — Current nav is separate routes (Browse | Ask | Ingest | Save). No icon-mode sidebar, no resizable tree + chat-center + live preview/editor panel. Query is a dedicated page, not the primary workspace.

**Review queue** — No async HITL “Create Page / Deep Research / Skip” queue. Ingest commits directly (no two-step preview/review UI; tests note preview/commit removed).

**Deep research** — No web-research agent (Tavily/SerpApi/SearXNG), no confirm-and-auto-ingest flow, no graph-insights bridge.

**Chrome clipper** — `/save` bookmarklet/share-target only; no browser extension or local clip API.

**Office / folder ingest** — No desktop folder watch or “office hour” ingest UI. Upstream yoyo workflows exist in repo but **this fork’s `.github/workflows` are inert** (per `AGENTS.md`) — office ingest not operational here.

**Todos** — No auto-extracted or manual todo list from transcripts/chat. Agent task queue ≠ personal todos.

## Uncertain / partial

- **Multi-conversation chat**: history exists; named threads create/rename/delete not verified in UI.
- **Dual Chat vs Ingest models**: settings expose one provider/model pair (+ embeddings), not separate chat/ingest model pickers.
- **WYSIWYG editing**: markdown render + owner/vault edit paths; no Milkdown-style split preview editor in main shell.
- **Private vault billing**: concept doc marks clone-to-private UI as future; read-enforcement exists.

## Positioning delta

work-wiki today is a **public commons + vault lens** web wiki (multi-tenant, agent-maintained, observer-friendly). nashsu/llm_wiki targets a **local, single-user workbench** where chat is central and ingest/review/research orbit it. Core Karpathy ops (Ingest, Query, Lint) are present; the **personal desktop shell and HITL loops** are the main gap.
