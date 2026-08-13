# Reconciliation: nashsu/llm_wiki

**Input:** `research-nashsu-llm-wiki.md`  
**Intent:** UX/functionality parity target — desktop llm_wiki’s shipped Workbench, ingest/query/lint loop, and vault feel, remapped to web (not Tauri packaging).

## What the PRD/addendum captured

- Karpathy three-layer vault (immutable Sources → LLM wiki → Schema) plus Ingest / Query / Lint; Chat files answers back (`wiki/queries/` → auto-Ingest).
- Icon sidebar (Wiki, Sources, Search, Graph, Lint, Review, Deep Research, Settings) + Todos extra; three-column Workbench (Knowledge Tree / File Tree | Chat | Preview); drag-resize; collapsible left nav; file-by-file Activity queue.
- Two-step CoT Ingest, SHA256 skip, serial durable queue (retry ≤3), cascade delete, `sources[]`, guaranteed Source summary, `index` / `log` / `overview`, Scenario Templates + `purpose.md` / Schema.
- Chat: multi-Conversation sidebar, citations + type-grouped references, regenerate, Save to Wiki, Sources-only, Thinking blocks, backend Agent + Skills `/skill` + `agent-workspace/` + forms + split shell approval.
- Search/retrieval (tokenized ± optional vector, graph expansion, 4K–1M budget); Graph (force layout, Type/Community, Louvain, Insights → Deep Research); async Review (Create Page / Deep Research / Skip); Deep Research (Tavily/SerpApi/SearXNG, confirm, Research Panel, auto-Ingest).
- Multi-format structured extract (PDF/MinerU, Office, EPUB/MOBI, AV player, web clips); dual Chat/Ingest models; local API `:19828` + MCP + llm-wiki skill; ZIP + `.obsidian/` + index rebuild; GFM/wikilinks; dataVersion refresh.
- **Rejected/mapped (in addendum), not misses:** OS `raw/sources/` watch → Intake arrival (FR-41); Chrome clipper / port 19827 → bookmarklet/share; Tauri vault-on-disk → web private Wiki; Milkdown WYSIWYG → Preview + open Q5; EN/ZH i18n → English only; LanceDB → Vectorize; AnyTXT → Source full-text; 19828 API kept in-scope.

## Gaps (highest-signal)

1. **Multimodal image loop (search / lightbox / jump-to-source).** Nashsu ships image ingest plus a Search **image section**, lightbox, and jump-to-source; vault layout includes `raw/assets/` and `wiki/media/` for extracted images. PRD only has images as an Ingest format (FR-32) and native Preview (FR-72). Search UI is title/body retrieval; the HTTP search payload’s optional `images` field has no Workbench contract. Diluted, not mapped.

2. **Mermaid + KaTeX in Chat/Preview.** Nashsu renders diagrams and math in both surfaces (shipped with thinking blocks). FR-66 kept Thinking; FR-73 kept GFM tables, code, wikilinks — **not** Mermaid or KaTeX. Silent drop of wiki/chat “feel” for meeting diagrams and formulas.

3. **Typed vault directories: `synthesis/` and `comparisons/`.** Nashsu’s user-visible page taxonomy includes those dirs alongside entities/concepts/sources/queries. PRD glossary and Ingest Generation name entity, concept, source-summary, query, index/log/overview (plus Deep Research “research Page”) — synthesis/comparisons never appear as first-class Knowledge Tree types. Schema could still emit them; the IA does not require them.
