# Reconciliation: llm-wiki.md (Karpathy LLM Wiki)

**Input:** `llm-wiki.md` (immutable founding prompt; do not edit)  
**Intent:** Compile a persistent, LLM-maintained markdown wiki between the human and immutable sources — knowledge compounds at ingest time, not re-derived via RAG on every question.

## What the PRD / addendum captured

- **Compile-once vs RAG:** Vision, §5 Non-Goals, and addendum reject “RAG-only Chat over files.” System of record is the compiled Wiki; Chat may retrieve over Pages, not raw chunks as the product.
- **Three layers:** Immutable Sources (FR-2); LLM-generated interlinked Pages; executable Schema / `purpose.md` (FR-34, FR-38).
- **Accumulate, don’t overwrite:** Merge on concept; disputed state instead of silent overwrite (FR-3).
- **Ingest ops:** Two-step Analysis → Generation; Source summary; entity/concept Pages; `index.md` / `log.md` / `overview.md` (FR-9, FR-11). Auto-queue on arrival (FR-41).
- **Query ops:** Cited answers from Wiki Pages; Save to Wiki so explorations compound (`wiki/queries/`, FR-14–15).
- **Lint / health:** Contradictions, orphans, staleness, broken links, gaps (FR-21); Graph Insights + confirmed Deep Research for coverage holes (FR-20, FR-24, FR-49).
- **Human curates, LLM maintains (partial):** Christian sources, Chats, Reviews, Todos; agents write Pages via Ingest. Scenario Templates cover Karpathy’s contexts (Research, Reading, Personal Growth, Business, General) as private named Wikis.
- **Index-then-search scaling:** Vector search off by default (FR-52); tokenized + graph path stands alone — aligned with “index is enough at moderate scale; search is optional.”
- **Portability / Obsidian:** Markdown vault, ZIP export with `.obsidian/` (FR-37); Graph as shape-of-wiki (FR-19). Clipper → Capture (FR-25).
- **Team/commons wiki and RAG-as-product:** Explicitly out of v1 (addendum).

## Gaps (highest-signal)

1. **Collaborative ingest (direct the analysis).** The idea file’s ingest *feel* is partnership: the LLM reads a source, **discusses takeaways with you**, you check summaries and **guide what to emphasize**, often one source at a time (batch is allowed but secondary). The PRD auto-queues Ingest on arrival (FR-41) and hides Ingest Analysis as “not a user-facing Page unless filed.” HITL is a closed Review set (Create Page / Deep Research / Skip) *after* compile — it cannot steer emphasis mid-ingest. Qualitative dilution: pipeline + later cards vs. “you direct the analysis.”

2. **You never (or rarely) write the wiki.** Founding voice: the LLM owns the wiki layer entirely; the human reads; Obsidian is the IDE, the LLM is the programmer. PRD Preview is “edit where allowed”; Open Question 5 leaves view-only vs. WYSIWYG unresolved; addendum maps Milkdown to “owner markdown escape hatch.” The ownership model is diluted toward nashsu editability rather than locked as LLM-maintained.

3. **Schema as co-evolved discipline, not a seeded settings file.** Karpathy: the schema is *the* config that makes the LLM a disciplined maintainer; **you and the LLM co-evolve it** as you learn the domain. PRD Schema is template-seeded and owner-editable (FR-34, FR-38). No product loop where Lint/Ingest *proposes* convention changes, or where page-type rules (comparison pages, a living synthesis/thesis, index as categorized catalog with one-liners, `log.md` grep-able `## [date] op | title` prefix) are treated as first-class wiki conventions. Conventions are thinner than the idea file.

4. **Query as index-first drill-down, not a retrieval pipeline.** Karpathy query: read `index.md` first, then drill into Pages; that *is* the map at ~100 sources and avoids embedding RAG. PRD Chat is nashsu’s multi-phase Retrieval pipeline (tokenized → optional vector → 2-hop graph → token budget). Compile-once is kept as the system of record, but the qualitative “the catalog is the map” is replaced by search-first context assembly (index is 5% of the budget, FR-54). Varied answer forms (Marp decks, charts, canvas) are optional in the idea file and omitted — acceptable; the index-first *feel* is the miss.

5. **Business/team shared wiki — rejected (in addendum).** Karpathy lists an internal team wiki (Slack, meetings, humans in the loop). v1 is a private single-operator job tool; commons / multi-user is explicitly rejected. Not a miss.

## Note

Do not edit `llm-wiki.md`. Gaps above are for PRD/addendum triage before polish — especially 1–4 (qualitative). Item 5 is already decided.
