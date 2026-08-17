# LLM Wiki functional parity roadmap

This document defines how work-wiki will reach user-visible functional parity
with [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) while remaining an
owner-only cloud application. The audit baseline is upstream version `0.6.7`,
commit `ad215b51252ffc1c6721d5b057f0449a2fb51530` (2026-08-02).

"Parity" means that a work-wiki user can achieve the same outcome. It does not
mean copying the desktop implementation or forcing local-computer concepts into
a Cloudflare Worker. The upstream repository is GPL-3.0 licensed, so work-wiki
will independently implement the behavior and will not copy its source code,
prompts, templates, or UI.

## Product constraints

- Every new page, source, search result, agent artifact, and project remains
  owner-only unless Christian later chooses a narrower sharing model.
- Raw sources and accepted wiki revisions remain durable; embeddings, graph
  scores, communities, summaries, and other indexes remain rebuildable.
- Automated changes use the existing Review proposal and revision lifecycle.
- Local filesystem access is provided through an optional authenticated sync
  companion. A browser session or Cloudflare Worker cannot silently watch a
  folder on a user's computer.
- Shell and code execution use an isolated remote sandbox with explicit grants,
  timeouts, budgets, output limits, and approval. They never run in the Worker
  or on the work-wiki host filesystem.
- Provider credentials stay server-side. Purpose, model choices, and retrieval
  preferences may be changed in the owner UI.

## Capability matrix

| Area | Reference behavior | work-wiki today | Status | Parity work |
| --- | --- | --- | --- | --- |
| Knowledge layers | Immutable sources, generated wiki, schema, purpose, overview, and log | Raw snapshots, wiki pages, conventions, revisions, evidence, and activity ledger | Partial | Add owner and vault purpose profiles plus a generated overview page |
| Project templates | Research, reading, personal growth, business, and general scenarios | Page templates and vaults, but no purpose/schema scenario setup | Missing | Add independently written scenario profiles that initialize purpose, page types, and starter questions |
| Ingest reasoning | Separate analysis and generation passes | Structured extraction and source contribution tracking feed a second compilation pass that creates owner-review proposals | Strong partial | Add semantic map/reduce checkpoints for very long sources and retain a richer claim-level analysis artifact |
| Multi-page ingest | Source summary plus entity, concept, index, overview, log, and review outputs | One source article plus reviewable entity/project/decision/etc. pages and related-page consolidation proposals | Strong partial | Add deterministic overview/index maintenance and more comparison/custom page planners |
| Long-source ingest | Context budgeting, semantic chunk analysis, checkpoints, and recovery | Bounded chunking and durable async jobs | Partial | Add semantic map/reduce analysis checkpoints and resumable stage state |
| Ingest cache and queue | Content-hash cache, serial durable queue, retry, cancel, and crash recovery | R2 staging, durable queue, job status, retry/failure handling, and dedup | Equivalent | Extend jobs with explicit analysis/generation/materialization stages and cancellation receipts |
| Folder import | Recursive import that preserves source hierarchy | Browser folder/ZIP import with retained relative paths | Equivalent | Add project destination and source-watch metadata |
| Local source watch | Watches local folders and automatically queues changes | Optional signed companion previews or watches an explicitly selected folder, journals hashes/job IDs, queues changed files, and reports per-client heartbeats to an in-app manager | Equivalent cloud adaptation | Add a dedicated scoped token so removal can revoke writes rather than only retire the status record |
| Scheduled import | Periodic local folder scans | Source monitors, Cloudflare schedules, and the companion's opt-in source-watch interval | Equivalent cloud adaptation | Add OS service templates for unattended companion startup |
| Core documents | PDF, Office, text, Markdown, web, images, and URL batches | PDF, DOCX, PPTX, XLSX, CSV, Markdown, text, HTML, ZIP, images, URLs, YouTube, and email | Equivalent | Preserve current cloud extraction and add the remaining formats below |
| Additional formats | EPUB, MOBI, Org, ODT/ODS/ODP, and selected legacy Office/media previews | EPUB, MOBI, Org, ODT/ODS/ODP, and RTF now join the existing cloud document formats | Equivalent for listed modern formats | Assess legacy binary Office and media transcription separately |
| Multimodal documents | Extracts PDF/Office images, captions them, and makes results image-aware | PDF images are extracted to PNG, captioned/transcribed with page context, cached by content hash, preserved, indexed with the document text, and shown in a lightbox that opens the original PDF page | Strong partial | Add bounding boxes and image-aware result cards outside the vault explorer |
| Hybrid retrieval | Keyword, vectors, graph expansion, full-page context, and citations | BM25, vectors, reciprocal-rank fusion, LLM reranking, weighted graph expansion, context controls, source-only retrieval, and citation validation | Stronger | Add token-level allocation controls and durable raw-chunk semantic indexes |
| Read Sources Only | Answers exclusively from original imported material | Chat has a persistent Original Sources Only mode and Knowledge Studio has owner-scoped original-source search with raw line citations | Partial | Add durable raw-chunk semantic indexes for larger collections |
| Context controls | Adjustable model context and explicit allocation | Each chat stores an enforced Compact (4 pages), Standard (8), or Expanded (12) retrieval budget | Partial | Add owner defaults and token-level allocation controls |
| Chat | Persistent multi-conversation chat, references, regeneration, and save-to-wiki | Persistent scoped conversations with native/Hermes backends, citations, Save to Wiki, and per-thread Wiki/Original Sources evidence mode | Partial | Add answer regeneration and context-budget controls |
| Graph construction | Four weighted signals: links, shared sources, Adamic-Adar, and type affinity | All four explainable signals produce deterministic weighted edges used by the graph and retrieval | Equivalent | Add owner controls for tuning signal weights only if real usage requires them |
| Graph communities | Louvain communities and cohesion | Deterministic weighted modularity/Louvain-style communities replace label propagation | Strong partial | Persist rebuild metadata and expose cohesion thresholds in the UI |
| Graph UX | Force layout, type/community color, filters, focus, cached positions | Canvas force graph, community colors, scope lenses, and page navigation | Partial | Add filters, type coloring, focus neighborhood, position persistence, and accessible list equivalents |
| Graph insights | Surprising links, isolated pages, sparse communities, and bridge nodes | Knowledge Studio derives isolated, bridge, missing-link, and sparse-topic signals with evidence and Research actions | Partial | Add dismiss/highlight state plus weighted surprising-link evidence |
| Deep research | Multi-query external search, editable plan, concurrent jobs, synthesis, and ingest | Tavily, SerpApi, or SearXNG projects run through the durable queue with progress, cancellation, deduped evidence, and a Review synthesis proposal | Strong partial | Add bounded concurrent query fan-out and optional capture of full approved source pages |
| Review | Asynchronous review queue with recommended actions | Owner-only Review Desk, evidence, semantic diffs, accept/edit/reject/split, revisions, and rollback | Stronger | Add graph and deep-research proposal types to the existing trust fabric |
| Agent retrieval | Wiki, raw sources, graph, web, and local desktop search | Wiki retrieval, structured knowledge, specialized agents, MCP, optional Hermes | Partial | Add source/graph/research tools and preserve owner scopes and audit receipts |
| Agent skills | Discovers local `SKILL.md` packages and activates selected skills | Owner skill registry supports create, assign, pause, and delete; enabled instructions are injected into assigned agents without expanding tools | Partial | Add versioned manifests, import/export, and per-run skill receipts |
| Agent workspace | Generates files, previews outputs, and can run approved shell commands | Private run workspaces retain response, receipts, logs, and generated text artifacts; every sandbox command now pauses in an owner approval docket before the separate bounded Cloudflare Sandbox worker can run it | Strong partial | Add richer artifact previews plus an enforced network-egress policy |
| Agent interaction | Structured questions/forms during a run | Typed owner forms pause a run, validate the response, and resume the agent with the submitted values | Equivalent | Add optional expiry and cancellation controls |
| Mermaid and math | Mermaid plus KaTeX | Mermaid, remark-math, rehype-katex, and KaTeX rendering are tested | Equivalent | Add authoring help/examples |
| Web clipper | Browser extension sends a cleaned page to a chosen project | A token-free Manifest V3 clipper remembers default tags and opens a compact owner-authenticated window for vault/tag confirmation and the accepted ingest receipt | Strong partial | Add optional selected-text/readable-content capture while retaining server-side URL safety checks |
| Delete lifecycle | Source-aware cascade that preserves entities shared by other sources | Comprehensive cleanup plus a source-to-page contribution ledger that replaces one page's stale contribution without touching others | Strong partial | Drive source deletion through the contribution ledger before removing shared compiled pages |
| Portability | Complete project ZIP export/import and deterministic index rebuild | Owner tenant ZIP export/import validates version, paths, size, tenant, and checksums; previews collisions and rebuilds derived indexes after skip/overwrite restore | Equivalent core | Add optional client-side archive encryption and a dedicated scoped sync token |
| HTTP API and MCP | Projects, files, read, reviews, search, chat, graph, and source rescan | Larger MCP surface covering read/write, ingest, query, review-adjacent lifecycle, vaults, agents, graph, and history | Stronger | Add project binding, source-only search, research, skill, and sync operations |
| Internationalization | English and Chinese UI, multilingual output behavior | English-only interface: the zh-CN catalog, the interface selector, and its locale cookie are retired, leaving a literal `lang="en"` document; the workspace output-language preference still steers generated content | Declined (recorded decision) | None — declined under parity clause 3: `AGENTS.md` → Learned User Preferences records English-only UI, so no interface translation or catalog tooling is planned |
| Desktop shell | Three-column resizable local application and activity panel | Responsive three-column Knowledge Studio with workflow navigation, working center desks, and a persistent source-to-decision evidence rail | Equivalent web adaptation | Add optional user-resizable widths after owner-session UX acceptance |

## Cloud adaptations for desktop-only behavior

### Local sync companion

The companion watches only folders the owner explicitly selects. It computes
content hashes locally and sends a signed change manifest plus changed files to
work-wiki. work-wiki records every change before enqueueing ingest. Deletions are
proposals unless the owner enables a narrow automatic rule. The companion
reports its last operation to Knowledge Studio and its status record can be
retired there. Stopping the local process or rotating the shared owner
automation token remains a separate operator action until dedicated scoped
companion credentials are implemented.

### Isolated agent sandbox

Agent-generated files live in an R2 run workspace. Optional commands execute in
an ephemeral sandbox, not in Cloudflare Workers or the Hermes host. The agent
declares the command, purpose, input manifest, expected outputs, and timeout
before approval. Completed files receive hashes and durable receipts. An
enforceable per-command network-egress declaration remains a hardening item.

### Browser extension

The extension carries no token. It sends the current URL, title, and optional
remembered tags into a compact work-wiki-origin window, where the existing owner
session controls vault selection, final tag editing, and the verified ingest
job. Selected-text and readable-content capture remain optional future work.

## Implementation sequence

### Local implementation status — 2026-08-06

Two Phase 1 slices are implemented locally. Settings now includes an
owner-scoped Workspace Purpose editor with clean-room General, Research,
Reading, Personal Growth, and Business scenario drafts. It stores purpose, key
questions, scope boundaries, output language, and page conventions. The saved
profile is included in ingest and reconciliation, query and native chat,
source-monitor proposals, structured-knowledge extraction, action extraction,
and specialized-agent instructions. It does not alter raw evidence or bypass
citations and review. Chat also has a persistent evidence selector. Original
Sources Only mode uses the readable wiki index solely to find candidate source
documents, then builds answer context exclusively from captured raw snapshots.
It uses bounded lexical chunk ranking, treats source text and metadata as
untrusted data, requires exact raw API links with line ranges, and fails with a
useful error when the selected scope has no captured originals. Existing
conversations migrate safely to Wiki Pages mode.

Verification for these slices: 172 test files and 3,683 tests passed, full lint
passed, the Next production build passed, the OpenNext Cloudflare build
completed, and Wrangler deployment dry-run passed. This is local and build
proof only; the feature has not been deployed or accepted in a production owner
session.

### Knowledge Studio UX status — 2026-08-07

The owner-only `/studio` route now provides one responsive three-column
workspace for Purpose & Vaults, Compile, Original Sources, Graph Insights,
Research, Files & Vaults, Agent Skills, Portability, and Connections. These are
not decorative parity mockups: the desks call the existing authenticated APIs
and new owner-scoped APIs for original-source search, graph insight derivation,
research briefs, and agent skills. Research briefs persist their question,
queries, approved URLs, optional vault, status, and cited synthesis; URL
collection enters the normal ingest queue. Assigned skills are injected into
the real agent runtime but never expand the agent's granted tools. Chat now
stores and enforces Compact (4-page), Standard (8-page), or Expanded (12-page)
context per conversation. The global signed-in workspace menu links to Studio.

Local proof for this tranche: all 175 test files and 3,691 tests pass, TypeScript
passes, full lint exits successfully, and the Next production build passes. A
local signed-out browser probe confirmed that `/studio` is protected and
redirects to the owner sign-in page without an error overlay or console error.
The OpenNext Cloudflare build and Wrangler deployment dry-run also pass. The
generated dependency bundle emits only its pre-existing negative-zero warning.
Signed-in visual acceptance, deployment, and production owner-session
acceptance remain separate gates until recorded.

### Functional parity priorities 1-7 — local implementation status, 2026-08-07

The seven requested parity priorities are now implemented locally as one
coherent tranche:

1. Two-pass knowledge compilation persists exact source contributions, creates
   separate reviewable structured pages, and optionally proposes related-page
   consolidation without bypassing Review.
2. The graph combines direct links, shared sources, Adamic-Adar, and type
   affinity; deterministic weighted communities and graph-expanded retrieval
   use the same evidence-bearing edges.
3. Research projects can use Tavily, SerpApi, or SearXNG, run asynchronously,
   report progress, accept cancellation, deduplicate results, and create a
   private evidence-backed Review proposal.
4. Agent runs retain private artifacts and structured owner-input forms. Agents
   with the explicit `run-sandbox` grant can execute bounded commands through a
   separately deployable Cloudflare Sandbox worker with no work-wiki or provider
   credentials mounted.
5. PDF figures are extracted with page context, converted to PNG, captioned and
   transcribed through vision, cached by content hash, and preserved. EPUB,
   MOBI, Org, ODT, ODS, ODP, and RTF ingestion are supported.
6. Complete owner archives support checksummed preview/import and deterministic
   rebuild. A token-free browser clipper uses the normal owner session. The
   optional local companion supports archive replication plus journaled source
   folder preview, push, and explicit continuous watch.
7. Markdown renders KaTeX math. The persistent English/Chinese interface
   selector has been retired along with its translation catalog and locale
   cookie: the interface is English-only.

The dedicated UX polish is also implemented locally: sandbox requests pause in
an exact-command approval docket and retain execution receipts; preserved PDF
figures have a lightbox and original-page jump; the clipper carries remembered
tags into a compact vault-selection window; and Knowledge Studio now generates
local-companion commands and displays/removes client heartbeat records.

Current local exact-head verification: all 185 test files and 3,714 tests pass;
TypeScript and ESLint pass; the Next production build generates all 96 pages;
the OpenNext Cloudflare build completes; and the main Worker passes a Wrangler
deployment dry-run. The sandbox Worker passes TypeScript, but its current
Wrangler container dry-run could not launch because Docker is unavailable on
this Mac. The source companion and clipper scripts pass syntax validation. A
desktop/mobile signed-out visual check passed; authenticated local cross-page
acceptance still requires an owner session. The generated OpenNext bundle emits
only its known dependency-level negative-zero warning. No deployment or
production owner-session acceptance is claimed by this section.

### Phase 1 — Purpose and retrieval controls

1. Add an owner workspace profile and optional per-vault overrides for purpose,
   key questions, scope, output language, and page conventions.
2. Add clean-room scenario templates and a non-destructive template preview.
3. Inject purpose into ingest, query, chat, research, graph-insight, and agent
   prompts through one tested context builder.
4. Add separate primary, ingest-analysis, ingest-generation, chat, research,
   vision, and embedding model routes, all using server-side credentials.
5. Add context-budget controls and a Read Sources Only conversation mode.
   **Implemented locally:** the conversation mode, enforced per-conversation
   context budgets, and source-only Search workspace are implemented. Owner
   default budgets and a durable raw semantic chunk index remain.

Acceptance: changing purpose affects the next ingest and chat answer, raw-only
answers cite original source locations, and all settings remain owner-scoped.

### Phase 2 — Two-pass incremental wiki compilation

1. Extend ingest jobs with `analysis`, `generation`, `materialization`,
   `postprocess`, and terminal stages.
2. Persist a schema-validated analysis artifact containing entities, concepts,
   claims, evidence anchors, connections, contradictions, and proposed pages.
3. Generate a guaranteed source summary plus proposals for new or updated
   entity, concept, comparison, synthesis, and custom-type pages.
4. Apply accepted proposals through the existing revision lifecycle; never let
   model output write arbitrary paths or bypass owner review.
5. Maintain owner-specific overview and activity pages deterministically.
6. Track each source's contribution to every derived page so reingest and
   deletion can remove one contribution without destroying shared knowledge.
7. Add semantic long-source checkpoints, cancellation, retry, and stage-level
   usage receipts.

Acceptance: one representative source creates a source summary and useful
cross-linked page proposals, retry is idempotent, and deleting that source
preserves claims supported by another source.

### Phase 3 — Graph intelligence and deep research

1. Build explainable edge signals for direct links, shared sources,
   Adamic-Adar, and type affinity.
2. Compute Louvain communities, cohesion, bridges, isolated nodes, sparse
   communities, and candidate surprising connections.
3. Add an owner-only Graph Insights inbox with dismiss, highlight, Review, and
   Deep Research actions.
4. Add editable research plans, multi-query web search adapters, concurrent
   source capture, progress, cancellation, synthesis proposals, and citations.

Acceptance: every graph insight exposes its input signals, and deep research
cannot publish or ingest a synthesis without an auditable owner rule or review.

### Phase 4 — Multimodal and document parity

1. Extract PDF images with page and bounding-location metadata.
2. Caption unique images through the selected vision route and cache by hash.
3. Index captions together with source anchors and add image-aware results,
   lightbox preview, and jump-to-source.
4. Add EPUB, MOBI, Org, ODT, ODS, and ODP extraction.
5. Add KaTeX rendering and multilingual output controls.

Acceptance: a figure-heavy PDF can be found by a visual concept that appears in
an image but not the document text, with the result opening the correct page.

### Phase 5 — Agent workspace and skills

1. Add a versioned owner skill registry and per-agent skill grants.
2. Add source, graph, research, and workspace tools to the existing safe agent
   runtime.
3. Add R2-backed generated outputs with preview, download, retention, and
   deletion controls.
4. Add resumable interaction forms.
5. Connect approved command execution to an ephemeral sandbox with explicit
   approval, network policy, and receipts.

Acceptance: an agent can use an approved skill to generate an artifact, pause
for owner input, and complete in a sandbox without gaining wiki write authority.

### Phase 6 — Portability and companion surfaces

1. Add full project export/import, collision preview, and deterministic rebuild.
2. Ship the scoped browser clipper.
3. Ship the authenticated local sync companion and scheduled local import.
4. ~~Internationalize the interface.~~ Declined — the interface is English-only
   (see the Internationalization row above); the shipped zh-CN catalog and its
   selector were retired rather than extended.
5. Add the optional resizable research workspace and complete cross-page
   consistency review.

Acceptance: a project can round-trip through an archive, a clipped page and a
watched local file produce visible ingest receipts, and revoking either client
immediately prevents further writes.

## Definition of exact functional parity

Parity is complete only when every row above is either:

1. implemented and verified in a production owner session;
2. deliberately replaced by a documented cloud equivalent that passes the
   same outcome-level acceptance test; or
3. explicitly declined by Christian and recorded as a product decision.

Local tests, a successful build, and a deployment are separate gates. Each
phase requires focused tests, the full test suite, lint, TypeScript/build,
Cloudflare build/dry-run, deployment approval, and owner-session acceptance.
