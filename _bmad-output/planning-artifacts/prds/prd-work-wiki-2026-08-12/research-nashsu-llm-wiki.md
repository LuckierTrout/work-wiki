# Research digest: nashsu/llm_wiki (parity target)

Sources: [GitHub README](https://github.com/nashsu/llm_wiki/blob/main/README.md) (primary), bundled [llm-wiki.md](https://github.com/nashsu/llm_wiki/blob/main/llm-wiki.md) (Karpathy pattern), `plans/multimodal-images.md` (stale “not started” vs README/changelog/code), local upload mirror of GitHub page, `src/lib/changelog.ts` via search. No inventing; uncertainty marked.

---

## Product one-liner

Cross-platform **desktop** app (Tauri v2) that turns documents into an organized, interlinked markdown wiki the LLM **incrementally builds and maintains**—compile knowledge once, keep it current—rather than re-deriving answers via classic RAG on every query.

## Karpathy LLM Wiki pattern (brief)

Three layers: **immutable raw sources** → **LLM-owned wiki** (markdown, wikilinks, frontmatter) → **schema** (conventions/workflows). Three ops: **Ingest** (integrate a source into many pages), **Query** (answer from wiki; optionally file answers back), **Lint** (health-check). Special files: `index.md` (catalog), `log.md` (chronology). Role split: human curates/asks; LLM maintains. Obsidian as browse IDE. Abstract pattern; nashsu ships a concrete desktop product with large extensions.

## Primary surfaces / screens (UX map)

| Surface | Role (per README) |
|--------|-------------------|
| **Icon sidebar** | Switch: Wiki, Sources, Search, Graph, Lint, Review, Deep Research, Settings |
| **Three-column shell** | Left: Knowledge Tree / File Tree · Center: **Chat** · Right: **Preview** (Milkdown WYSIWYG); resizable panels |
| **Activity panel** | Ingest queue progress (pending/processing/failed; cancel/retry) |
| **Conversation sidebar** | Multi-chat create/rename/delete |
| **Graph** | Force graph + Type/Community coloring + Insights cards |
| **Research panel** | Deep Research streaming progress |
| **Project create** | Scenario templates (Research, Reading, Personal Growth, Business, General) |
| **Chrome extension** | Web clipper (separate UI; talks to local app) |
| **External** | Local HTTP API `:19828`, MCP client config, optional agent skill repo |

## Feature inventory (shipped vs unclear/aspirational)

Legend: **Shipped** = README presents as product capability (often backed by Quick Start / API / changelog). **Unclear** = docs conflict or thin UX detail. **Not in public docs** = absent from README feature set.

| Area | Status | Notes |
|------|--------|-------|
| Two-step CoT ingest + SHA256 skip cache | **Shipped** | Analysis → generation; queue persisted, retry ≤3 |
| Multi-format ingest (PDF/Office/EPUB-MOBI/images/media/clips/URL batches; MinerU optional) | **Shipped** | Org mode listed in features bullet |
| Folder import + `raw/sources/` auto-watch | **Shipped** | External add/edit/delete → same lifecycle |
| Cascade delete / wikilink & index cleanup | **Shipped** | Shared entities keep pages, trim `sources[]` |
| Multimodal image ingest + image search/lightbox/jump-to-source | **Shipped (README + code/changelog)** | `plans/multimodal-images.md` still says “Spec, not started”—treat plan as **stale** |
| Wiki pages, `[[wikilinks]]`, YAML frontmatter, Obsidian vault | **Shipped** | |
| `purpose.md` + `schema.md` + templates | **Shipped** | purpose = intent; schema = rules |
| Chat / Q&A (multi-conversation, citations, regenerate, Save to Wiki) | **Shipped** | Center column; persist under `.llm-wiki/chats/` |
| Read Sources Only mode | **Shipped** | Feature bullet; UX depth not detailed |
| Rust tool-using Agent + Skills (`/skill`) + workspace outputs | **Shipped** | Shell approval for external cmds |
| Tokenized + optional vector (LanceDB) + graph expansion retrieval | **Shipped** | Vector off by default |
| Search surface (incl. image section) | **Shipped** | |
| Knowledge graph + Louvain + Insights → Deep Research | **Shipped** | |
| Lint | **Shipped** | Sidebar; exact lint checks not enumerated in README |
| Async Review (Create Page / Deep Research / Skip) | **Shipped** | Non-blocking HITL queue |
| Deep Research (Tavily / SerpApi / SearXNG) | **Shipped** | Confirm dialog; auto-ingest |
| Chrome web clipper | **Shipped** | Ports: clip API **19827**, app API **19828** |
| Project ZIP export/import + rebuild `index.md` | **Shipped** | Migration, not cloud sync |
| Settings: providers, Chat vs Ingest models, context 4K–1M, i18n EN/ZH (+ Czech AI output in changelog), API+MCP, Firecrawl, timeouts | **Shipped** | |
| Local HTTP API + MCP + external agent skill | **Shipped** | Skill read-only by default |
| Mermaid + KaTeX in chat/preview; thinking blocks | **Shipped** | |
| **Todos** | **Not in public docs** | No todo product surface described |
| **Multi-user / cloud collab** | **Not in public docs** | Personal/local; multi-**project** yes |
| **Cloud sync** | **Not in public docs** | “Sync” = local source-folder watch + ZIP migrate |

## Interaction patterns that define the UX

1. **Nav**: icon sidebar selects major mode; left tree browses wiki/files; chat stays central; preview shows selected/edited markdown.
2. **Source → page**: Import/watch/clip → Activity queue → two-step LLM → entity/concept/source pages + `index`/`log`/`overview` updates; optional Review/Deep Research follow-ups.
3. **Chat placement**: primary workspace center; conversations switchable; answers cite wiki pages; **Save to Wiki** → `wiki/queries/` then re-ingest.
4. **Browse**: Knowledge tree + Preview editor; Obsidian-compatible on disk.
5. **Graph loop**: explore connections → Insights (gaps/bridges) → editable Deep Research → auto-ingest.
6. **Agent loop**: tools (wiki/source/graph/web/…) + skills + generated files under `agent-workspace/` with preview.

## Data model concepts users see

- **Project** (multi-project; templates seed purpose/schema)
- **purpose.md / schema.md**
- **raw/sources/** (immutable inputs), **raw/assets/**, **wiki/media/** (extracted images)
- **Wiki pages** by type/dir: entities, concepts, sources (summaries), queries, synthesis, comparisons; plus **index.md**, **log.md**, **overview.md**
- Frontmatter: e.g. `type`, `title`, **`sources[]`**
- **`[[wikilinks]]`**, graph nodes/edges/communities
- **Conversations**, **Review items**, **ingest queue tasks**, **Deep Research tasks**
- **`.llm-wiki/`** app state (chats, reviews, caches); **`.obsidian/`**
- **agent-workspace/** generated outputs
- Not documented as first-class UX: todos, users/roles, shared tenants

## Gaps / unclear from public docs

- Exact Lint rule set and Review UI density
- How “Read Sources Only” is toggled and constrained
- Whether multimodal is always-on or Settings-gated (plan said default off; README silent)
- Standalone image → full wiki-page ingest completeness
- Multi-device story beyond ZIP; no team/auth model
- Desktop-only vs any web client (docs: Tauri desktop + local APIs)
- `plans/prd.md` not fetchable at expected paths; only multimodal plan found under `plans/`
- Upload file is GitHub page scrape—same content as README, not extra product spec

## Parity checklist candidates (PRD: “mirror nashsu/llm_wiki”)

Prioritize **behavior/UX**, not Tauri packaging:

1. Three-layer vault mental model + Ingest / Query / Lint
2. Icon-mode nav + wiki/file tree + **chat-centric** layout + preview
3. Two-step ingest, queue UX, incremental skip, source→`sources[]` traceability
4. Multi-format import + folder import + source watch + cascade delete
5. Chat: multi-thread, citations, regenerate, save-answer→wiki, optional sources-only
6. Search (keyword ± vector) + image-aware results if multimodal in scope
7. Graph viz + communities + insights→research
8. Async Review queue with constrained actions
9. Deep Research with provider config + confirm + auto-ingest
10. Web clipper (or equivalent capture→ingest)
11. purpose + schema + project templates; `index` / `log` / `overview`
12. Wikilinks + frontmatter + Obsidian-friendly markdown layout
13. Settings: dual Chat/Ingest models, context budget, embeddings optional
14. Local API/MCP (or work-wiki equivalents) for agent access
15. Project export/import / index rebuild
16. Explicitly **out of nashsu docs** (do not invent for parity): todos, multi-user cloud sync—only if work-wiki vision adds them beyond mirror scope
