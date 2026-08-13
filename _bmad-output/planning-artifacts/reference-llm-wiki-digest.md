# Reference digest: nashsu/llm_wiki → work-wiki rework

> Input for the PRD session. Prepared 2026-08-12 from a fresh clone of
> <https://github.com/nashsu/llm_wiki> (v0.6.8, 16.2K stars, GPL-3.0, updated same day).
> Decision already made by Christian: **web app, desktop-style UX** — keep the
> Next.js/Cloudflare stack and multi-tenant backend; adopt the reference app's
> workbench UI/UX and workflows as web features. Not a Tauri port.

## Licensing constraint

The reference is **GPL-3.0**. Reimplement its UX patterns and workflows from
observation; do **not** port its source code into work-wiki unless work-wiki is
willing to become GPL. Treat the reference repo as a spec, not a component library.

## Shared ancestry (why the mapping is tractable)

Both apps implement Karpathy's `llm-wiki.md` pattern and both repos carry that
file verbatim. Shared data model: raw sources (immutable) → wiki pages
(markdown + YAML frontmatter, `[[wikilinks]]`) → schema rules; core ops
ingest / query / lint; `index.md` catalog; `log.md` history; Obsidian-compatible.
The rework is a re-skin + workflow adoption over a compatible substrate, not a
data-model migration.

## UI/UX to adopt (reference → web)

1. **Three-column workbench** — knowledge/file tree (left) + chat (center) +
   preview/WYSIWYG editor (right); drag-resizable panels with min/max
   (reference uses react-resizable-panels + Milkdown editor).
2. **Icon sidebar** switching modes: Wiki, Sources, Search, Graph, Lint,
   Review, Deep Research, Settings.
3. **Activity panel** — live ingest-queue status: progress bar,
   pending/processing/failed, cancel + retry per task.
4. **Multi-conversation chat** — session sidebar, per-conversation persistence,
   configurable history depth, collapsible cited-references panel per response,
   regenerate, save-to-wiki.
5. **Graph view as instrument** — sigma.js-style rendering, node color by
   type/community toggle, hover neighbor highlighting, zoom/fit controls,
   position caching, legend.
6. Rich markdown everywhere: KaTeX math, Mermaid with compact error cards,
   thinking-block display (streaming, collapsed after completion).

## Workflows to adopt

| Workflow | Reference mechanics | work-wiki today |
|---|---|---|
| Two-step CoT ingest | Analyze (entities/connections/contradictions) → generate (pages + index + log + review items) | Single-pass synthesis w/ concept resolver + dedup |
| Ingest queue | Persistent, serial, crash-safe, 3 auto-retries, visualized | CF Queues (`yopedia-tasks`) — headless, no UI |
| `purpose.md` | Goals/questions/scope read by LLM on every ingest & query | No equivalent (SCHEMA.md is structural only) |
| Review queue | LLM flags items during ingest; constrained actions (Create Page / Deep Research / Skip); pre-generated search queries; async | No equivalent (talk pages are contradiction-driven) |
| Deep Research | Gap → LLM-optimized topics (reads overview + purpose) → web search (Tavily/SerpApi/SearXNG) → synthesize → auto-ingest; editable confirmation dialog | No equivalent |
| Graph relevance | 4-signal model: direct link ×3.0, source overlap ×4.0, Adamic-Adar ×1.5, type affinity ×1.0 | Wikilink edges only |
| Communities | Louvain clustering, cohesion scoring (<0.15 flagged), 12-color palette | No equivalent |
| Graph insights | Surprising connections, isolated pages, sparse communities, bridge nodes → one-click Deep Research | No equivalent |
| Retrieval budget | Configurable 4K–1M window; 60/20/5/15 split (wiki/history/index/system); tokenized search → vector merge → 2-hop graph expansion → assembly | Hybrid BM25+vector RRF, streaming, citations |
| Cascade deletion | 3-method matching; shared-entity preservation; index + wikilink cleanup | Delete exists; parity unverified |
| Multi-format parsing | PDF (+MinerU opt), DOCX, PPTX, XLSX, EPUB/MOBI, images w/ vision captions | URL/text/X/PDF/image via MCP tools; breadth unverified |
| Source auto-watch | Watches `raw/sources/` for external changes | n/a as-is (web); maps to R2-event or poll design question |
| Project mgmt | Multi-project, ZIP export/import, index rebuild | Vaults + Obsidian export; single commons |

"Unverified" rows = architecture phase should diff actual work-wiki capability
before scoping work.

## Reference stack (for pattern reference only — not adopting)

Tauri v2/Rust · React 19 + Vite · shadcn/ui + Tailwind v4 · Milkdown editor ·
sigma.js + graphology (+ Louvain, ForceAtlas2) · LanceDB (optional vectors) ·
Zustand · react-i18next · local HTTP API :19828 + bundled MCP server.

Notable for us: work-wiki already ships Tailwind and an MCP surface; shadcn/ui
and graphology are directly usable on our stack; Milkdown works in any React app.

## Tensions the PRD must resolve

1. **Single-user workbench UX vs multi-tenant commons** — the reference's whole
   UI assumes one owner and local files. How do Mine/All lens, tenants, and the
   commons map onto a three-column workbench? Is the workbench the owner's cockpit
   while public browse stays closer to current UI?
2. **`purpose.md` per what?** Per tenant? Per vault? The commons has many owners.
3. **Ingest queue visibility** — CF Queues is server-side and multi-tenant; the
   activity panel implies per-user queue scoping.
4. **Deep Research cost/abuse surface** — web-search keys + LLM synthesis on a
   public multi-tenant app needs quota/authorization design (reference is local,
   spends only the owner's keys).
5. **Editor** — reference is WYSIWYG-first (Milkdown). work-wiki is
   agent-writes-first. Who edits pages in the browser, and does the commons allow it?
6. **Which existing surfaces retire** — current pages (query, wiki index, graph,
   lint, save) vs the eight-mode sidebar; what maps, what merges, what dies.
7. **Scope of parity** — the reference has ~19 feature clusters; the PRD should
   rank them (e.g. workbench shell + graph instrument + review queue first;
   web clipper/i18n/desktop-isms later or never).

## Constraints from the current repo (carry into PRD)

- Rebrand is display-only: runtime identifiers remain `yopedia` (tenant default,
  agent owner, MCP identity, storage/queue/secret names). See AGENTS.md.
- SCHEMA.md "Page conventions" is loaded into prompts at runtime — schema changes
  are behavior changes.
- yoyo autonomous pipeline is dormant on this fork; deploys are manual wrangler.
- `.yoyo/learnings.md` holds 13 hard-won lessons (write-path consolidation,
  frontmatter typing, parallel-prompt drift) that directly constrain ingest/edit
  pipeline design.
