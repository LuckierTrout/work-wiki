# Addendum — work-wiki PRD (2026-08-12)

Depth that does not belong in the PRD: rejected alternatives, mechanism, and desktop→web mapping. Not an audit trail (see `.memlog.md`).

## Rejected for v1 (and why)

| Alternative | Why not now |
|-------------|-------------|
| **Commons-first multi-user wiki** (`work-wiki-concept.md`, `PRODUCT.md`) | Christian’s job tool is a private compiled Wiki. Public lab / observer audience would leak meeting Sources. Revisit as a later product, not this MVP. |
| **Tauri desktop rewrite to match nashsu packaging** | User chose web. Fork is already Next.js. Parity is behavior/UX, not OS integration. |
| **Keep route-per-function IA** (Browse / Ask / Ingest as separate pages) | Conflicts with nashsu chat-centric Workbench, which is an explicit goal. |
| **Auto-complete Todos from Plaud’s own action items** | User required approve/reject on LLM assessment. Plaud notes are Sources, not the Todo list. |
| **RAG-only Chat over files** | Founding pattern is compile-once wiki. |

## Desktop → web parity mapping (nashsu/llm_wiki)

| nashsu (desktop) | work-wiki v1 (web) |
|------------------|--------------------|
| Tauri app, local vault on disk | Browser Workbench; private owner Wiki in existing storage |
| `raw/sources/` folder watch | **Not required.** FR-41: any Intake arrival (upload, folder, email, direct connect, API/MCP) auto-queues two-step Ingest |
| Recursive folder import + path context | FR-40: preserved tree; path passed to LLM (e.g. `papers > energy`) |
| SHA256 skip cache | FR-10 |
| Serial persistent queue, retry ≤3 | FR-39 |
| Two-step CoT ingest | FR-9 Analysis then Generation |
| Chrome extension + local ports 19827/19828 | Bookmarklet / share / in-app URL → same Ingest queue |
| `.llm-wiki/chats/{id}.json` | Same record shape persisted per Conversation; export uses that layout |
| Local HTTP API `:19828` + MCP | **In-scope FR-36/76–78:** loopback, token, same `/api/v1` routes, MCP wraps them, copyable client config |
| Milkdown WYSIWYG | Preview; owner markdown escape hatch (view-first; no WYSIWYG) |
| Multi-project templates (Research, Reading, Personal Growth, Business, General) | Same five Scenario Templates seed `purpose.md` + Schema; multiple named Wikis, one operator |
| EN/ZH i18n | **English only** (persisted language setting) |
| Tauri Store | Durable Settings: provider, API key, model, context size, language (FR-8) — not Tauri-specific on web |
| ZIP export/import + index rebuild | FR-37; includes `.obsidian/` recommended config |
| GFM / wikilinks | FR-73 in Chat and Preview |
| dataVersion | FR-74 auto-refresh Graph and UI |
| Agent shell tools + skills on machine | **In-app Chat Agent (FR-60–65):** tools, Skills, `agent-workspace/`, forms, workspace vs external-shell approval. MCP remains for external agents (FR-36). |

## Mechanism (architecture — not requirements)

Current fork (do not rename production identifiers; they stay `yopedia` at runtime):

- Next.js App Router on Cloudflare Workers (OpenNext)
- R2 (Pages, Sources, assets), KV (indexes), Vectorize + Workers AI embeddings
- Generation via configured LLM (today DeepSeek-compatible chat)
- Hybrid BM25 + vector search
- Clerk session for humans; agent tokens for MCP
- Queues consumer for async Ingest

## Chat Agent runtime (mechanism)

Nashsu runs a **Rust** tool-using Agent inside the desktop app. This PRD requires the same: **Chat is not a browser-only TypeScript loop**. The Workbench is the web UI; turns are executed by a **Rust backend Agent** that streams to the client.

Hosting that process on Cloudflare Workers is an architecture problem (Workers are not a general shell host). **Locked:** Workbench on Workers; **local Rust Agent sidecar** owns `:19828`, MCP, shell, Skills scan, `agent-workspace/`, and document extractors. No dedicated remote Agent host in v1. Cloud `/api/v1` is an authenticated façade with the same route shapes, not the loopback bind. Cloud `POST /chat` returns 503 `sidecar_required`.

Skill folders: project Skills in the Wiki/repo; user Skills in a per-operator store. `/skill` binds one Skill to a Conversation.

**External Agent Skill:** [nashsu/llm_wiki_skill](https://github.com/nashsu/llm_wiki_skill) — documentation-only (SKILL.md + api-reference.md + examples.md); `npx skills add https://github.com/nashsu/llm_wiki_skill.git --skill llm-wiki`. HTTP+JSON via curl; no SDK. Read-only except `sources/rescan`. Token: Settings generate or `LLM_WIKI_API_TOKEN` (Bearer / `X-LLM-Wiki-Token` / `?token=` last resort). `{id}` = `current` | UUID | URL-encoded path; names resolved client-side from `GET /projects`. Stock skill treats `POST /chat` as **501** (desktop WebView chat); work-wiki implements `/chat` as FR-77 — a branded skill may document that. Triggers: LLM Wiki / work-wiki / “my wiki” / “my knowledge base”; not generic notes/Obsidian/Notion/Logseq. File whitelist and rate limits are FR-36.

## Retrieval (mechanism — not a requirement)

Nashsu’s desktop vector path is **LanceDB (Rust)** + OpenAI-compatible `/v1/embeddings`. This web app already has **Cloudflare Vectorize** + Workers AI embeddings. **FR-52** requires optional cosine ANN, independent embeddings config, merge-into-tokenized-search, and fallback when off — not LanceDB specifically. Keep Vectorize. Tokenized search should cover `wiki/` and `raw/sources/` with English word+stopword and CJK bigrams; title bonus +10. Graph expansion reuses FR-45 with 2-hop decay.

## Document extraction (mechanism)

Intended extractors (nashsu / Rust-side; may run in the Agent sidecar, not in the Cloudflare isolate):

| Format | Method |
|--------|--------|
| PDF | Built-in **pdf-extract** (Rust) with file caching; optional **MinerU** (default off; if enabled, Local API first) |
| DOCX | **docx-rs** → headings, bold/italic, lists, tables as Markdown |
| PPTX | ZIP + XML, slide-by-slide |
| XLSX/XLS/ODS | **calamine** — cell types, multi-sheet, Markdown tables |
| EPUB/MOBI | Metadata, chapters, body |
| Images | Native preview (png, jpg, gif, webp, svg, …) |
| Video/Audio | Built-in player |
| Web clips | **Readability.js** + **Turndown.js** → clean Markdown |

The PRD contract is the **behavior** in FR-71/FR-72, not a mandatory crate inside Workers.

## Deep Research providers (mechanism)

FR-67 requires **Tavily**, **SerpApi**, and **SearXNG** as selectable backends with independent keys / engine / instance URL. **Default active provider is Tavily.** “No truncation” means the app does not slice fetched content before synthesis; provider payload limits still apply. Research concurrency (3) is a separate queue from serial Ingest.

## Graph visualization (mechanism)

v1 web stack for FR-19 / FR-45 / FR-46 / FR-47 is **sigma.js** + **graphology** + **ForceAtlas2**, with **graphology-communities-louvain** for Community discovery (locked in architecture AD-14). Node positions cached after layout so Ingest updates do not re-scatter the view. Interaction contract: Louvain-equivalent clustering, 12-color Community palette, cohesion = intra-edge density, warn below 0.15.

## Plaud

Plaud recordings expose transcript (speaker + timestamps) and AI notes (summary + action items). Product rule: store transcript and summary as Sources; run Todo Candidate extraction; **do not** trust Plaud action items as approved Todos.

**Locked:** P0 is export/upload of transcript + summary. P1 is in-app OAuth list/pull.

## Existing app vs this PRD

Already present: URL/PDF/text/image Ingest, wiki Pages, search, streaming query, lint, graph, MCP, bookmarklet Capture, vaults/commons.

Must change or add: private-by-default, three-column Workbench, multi-Conversation Chat as center driven by a Rust backend Agent (not in-browser TS), Review queue, Deep Research, office Ingest, Plaud meeting path, Todo Candidate HITL, dual Chat/Ingest models, export as backup.

## Sizing (informal)

Solo, job-critical, high functional surface. Treat as an **internal-tool-sized** PRD (~Workbench rewrite + several ingest/HITL features), not a hobby one-pager. No TAM/SAM.

## Aesthetic note

`PRODUCT.md` “public research lab” is **out** for the v1 app UI. Follow nashsu’s workbench density (tree / chat / preview / queue). Voice: precise, evidence-rich, unsentimental. Keep PRODUCT anti-refs that still help: no generic AI landing-page costume, no fake terminal skin, no metric dashboard as the home, **no editorial/magazine affectation**.
