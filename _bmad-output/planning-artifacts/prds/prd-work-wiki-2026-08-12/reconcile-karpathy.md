# Reconciliation extract — Karpathy LLM Wiki pattern

**Input:** `research-karpathy-llm-wiki.md`  
**Intent:** Lock the Karpathy compile-once wiki (immutable sources → LLM-maintained markdown → executable schema) as the product pattern, not RAG-at-query-time.

## What the PRD / addendum captured

- **Compile-once, not RAG-as-product:** Vision, §5 Non-Goals, FR-2/FR-3/FR-9; addendum rejects RAG-only Chat over files.
- **Three layers:** Immutable Sources (FR-2), compiled interlinked Pages with `sources: []`, executable Schema (FR-34) + Scenario Templates (FR-38).
- **Accumulate + contradictions:** Merge on concept; disputed state instead of picking a side (FR-3); Lint + Graph Insights for orphans/staleness/gaps (FR-21, FR-20/49).
- **Citations + file-back:** Chat cites compiled Pages `[n]` with a references panel (FR-14); Save to Wiki → `wiki/queries/` auto-Ingest (FR-15); Chat must not invent citations (§13).
- **Index / log / overview bookkeeping** on every successful Ingest (FR-11); vector search optional and off by default (FR-52).
- **Human curates Sources / Reviews / Todos; agents write via Ingest** (UJ-4: no hand-rewrite of the whole wiki).
- **Team / public commons wiki:** **rejected (in addendum)** — private single-operator v1.
- **Obsidian-as-primary-IDE / Tauri git vault:** **rejected (in addendum)** as desktop rewrite; markdown + `.obsidian/` ZIP export remains (FR-37).

## Gaps (highest-signal)

1. **LLM-maintains is diluted / unlocked.** Karpathy: humans source and ask; the LLM owns wiki writes. PRD Open Q5 + addendum Milkdown mapping leave owner/WYSIWYG Page edit open; no FR that Ingest (or Schema/talk) is the normal write path and hand-edit is an escape hatch only.

2. **No review of Ingest emphasis / diffs.** Karpathy ingest: LLM touches many Pages, then “human may review emphasis.” PRD Review is Create Page / Deep Research / Skip and never blocks Ingest (FR-23). Generation commits Page merges with no required diff, emphasis check, or inspectable change list — the main silent-overwrite risk on *compiled prose* (Sources and disputed *claims* are already protected).

3. **Schema co-evolution dropped.** Karpathy: schema is co-evolved product config that disciplines the maintainer. PRD Schema is human-edited after a template seed (FR-34/38); Ingest does not propose convention updates.

4. **Index-first navigation inverted (compile-once kept).** Karpathy: at moderate scale, `index.md` + `log.md` then drill-down; hybrid search only when the catalog stops scaling. PRD Chat + Retrieval is the default query UX from day 1 (nashsu). Answers still cite compiled Pages, not raw chunks — pattern intact, ops model not.

Compile-once and citation *requirements* are not gaps. Team/shared-human wiki and Obsidian-as-IDE are **rejected (in addendum)**, not misses.
