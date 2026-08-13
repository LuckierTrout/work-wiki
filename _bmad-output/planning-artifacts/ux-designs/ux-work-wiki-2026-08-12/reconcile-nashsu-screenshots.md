# Reconcile — nashsu/llm_wiki screenshots

User-supplied visual input: `imports/` (16 PNGs). Spines win on conflict.

## Lifted (in DESIGN.md / EXPERIENCE.md)

| File | Illustrates | Kept |
|---|---|---|
| `01-settings-source-watch.png` | Settings second list + Save bar; allowed file-type grid; concurrent parsers; keep parsed Markdown | Mapped to **Intake**. Dropped OS folder-watch (see Dropped). |
| `02-settings-mineru-pdf.png` | MinerU as a Settings category; warning posture for cloud upload | Settings → MinerU PDF. Default on/off left **OPEN**. |
| `03-settings-external-sources.png` | External Information Sources category | Deep Research / Firecrawl keys live here. |
| `04-settings-api-mcp.png` | Enable API, token field, `/health`, Save bar, warning callouts | Loopback `:19828`, token generate, copyable MCP. Dropped LAN bind and Clip server. |
| `05-settings-llm-models.png` | Dual Chat/Ingest models, provider cards, Save bar | FR-35. |
| `06-settings-embeddings.png` | Independent embeddings config | Vector **off by default**. |
| `07-skills.png` | Scan folders, search, Enable all / Disable all / Rescan, skill cards | Skills rail mode. |
| `08-review-deep-research.png` | Files tree + Review cards + Deep Research empty column | Three-column Review; Research Panel empty copy. |
| `09-review-queue.png` | Review toolbar + cards; Create Page / Deep Research / Skip | Closed action set. Some cards omit Deep Research when no queries. |
| `10-wiki-lint.png` | Wiki Lint empty; Semantic (LLM) toggle; Run Lint | Lint idle state. “Open project folder” dropped. |
| `11-files-empty-preview.png` | Files tree + “Select a file to preview.” + Activity dock | Files tab; empty Preview. |
| `12-search-empty.png` | Search field empty copy | Search idle. |
| `13-knowledge-graph.png` | Force graph, Type legend, Insights badge, stats, Activity | Graph canvas + Type/Community/Insights. |
| `14-raw-sources.png` | Raw Sources list, + Import / + Folder / URLs, Ingested tags | Sources mode. Progressive list. |
| `15-knowledge-tree.png` | Knowledge tab grouped by type with counts; empty Preview | Wiki default after create. Title restyled to **work-wiki**. |
| `16-chat-empty.png` | Chat as rail icon; conversation list; composer tools including AnyTXT, Smart retrieval, Standard model | Chat empty + composer. No Preview column when empty. |

## Dropped (screenshot chrome that must not ship)

| Screenshot idea | Why dropped |
|---|---|
| Source Folder Auto Watch / monitor `raw/sources` on disk | PRD FR-41: Intake arrival, not OS folder-watch. |
| “Open project folder” | Desktop Finder. Web: Import / Upload. |
| Title “CHRISTIAN’S LLM WIKI” | Display name **work-wiki**. |
| Allow API from local network (`0.0.0.0`) | FR-36: `127.0.0.1` only. |
| Clip server / port 19827 | PRD non-goal. Capture = bookmarklet / share / in-app URL. |
| Blue checkbox as brand color | Primary actions stay black. Native form accent may remain. |
| Extra Review buttons beyond Create Page / Deep Research / Skip | FR-23 closed set. |
| `synthesis/` / `comparisons/` as rail icons | PRD non-goal; dirs may exist in the File Tree. |

## Added vs screenshots (PRD, not nashsu)

Todos rail icon; Create Wiki Scenario Templates; Capture bookmarklet; inbound email on Intake; Plaud upload; ZIP export on Maintenance; mark Source as meeting.

## Orphans

None of the 16 `imports/` files are unnamed. Key-screen mocks (no nashsu screenshot): `mockups/todos.html`, `mockups/create-wiki.html`, `mockups/intake.html`, `mockups/chat-cited.html`. Remaining IA surfaces (Search, Graph, Lint, Review, Skills, Sources, Wiki empty) stay screenshot-referenced. Spines win on conflict.
