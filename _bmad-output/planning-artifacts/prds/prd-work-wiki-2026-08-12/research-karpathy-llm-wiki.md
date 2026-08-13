# Research: Karpathy LLM Wiki Pattern

Digest of Andrej Karpathy’s “LLM Wiki” methodology for personal knowledge bases (compile with LLMs vs. pure RAG). Cap: ~600 words. Researched 2026-08-12.

## Source links

- **Canonical gist (idea file):** https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f (`llm-wiki.md`)
- **Raw gist:** https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/llm-wiki.md
- **Origin tweet (Apr 2026, “LLM Knowledge Bases”):** https://x.com/karpathy/status/2039805659525644595
- **Secondary explainers:** [Tekai](https://tekai.dev/references/2026-04-06-llm-wiki-karpathy-personal-knowledge-base), [Gamgee](https://gamgee.ai/blogs/karpathy-llm-wiki-memory-pattern/), [Agentpedia idea-file guide](https://agentpedia.codes/blog/karpathy-llm-wiki-idea-file)

## Core principles

- **Compile, don’t re-discover:** Persist a structured wiki between humans and raw sources; knowledge is integrated once and kept current.
- **Three layers:** Immutable raw sources → LLM-owned interlinked markdown wiki → schema (`CLAUDE.md` / `AGENTS.md`) that defines conventions and workflows.
- **Human curates; LLM maintains:** Users source, explore, and ask; the LLM summarizes, cross-links, updates, and bookkeeps.
- **Compounding artifact:** Cross-refs, contradiction flags, and synthesis accumulate with every ingest and good query.
- **Schema is the product config:** Co-evolved rules make the LLM a disciplined maintainer, not a chatbot.
- **Navigation without RAG (at moderate scale):** `index.md` (catalog) + `log.md` (append-only timeline); index-first then drill-down (~100 sources / hundreds of pages).
- **Obsidian as IDE:** Browse graph/pages while the agent edits; wiki is a git repo of markdown.
- **Optional search later:** Hybrid search (e.g. qmd) when index alone stops scaling.

## How it differs from RAG

| RAG | LLM Wiki |
|-----|----------|
| Retrieve chunks at query time | Integrate sources into a living wiki at ingest time |
| No accumulation across questions | Synthesis, links, and contradictions persist |
| Re-pieces fragments every ask | Answers cite pre-compiled pages; good answers can be filed back |
| Infra-heavy embeddings/vector DBs | Markdown + schema; search optional until scale demands it |

## What “done” looks like (ops)

- **Ingest:** Drop source → LLM reads, summarizes, updates index + entity/concept pages (often 10–15 touches) → appends log; human may review emphasis.
- **Query:** Search/read wiki → answer with citations → optionally file the answer as a new wiki page so exploration compounds.
- **Lint:** Periodic health check — contradictions, stale claims, orphans, missing concept pages, weak cross-refs, data gaps / suggested next sources.

## Product-requirement implications (capabilities)

- Accept curated sources as immutable truth; never overwrite raw.
- Agent-maintained wiki write path: create/update pages, cross-refs, index, and log on ingest.
- Executable schema/conventions that steer ingest, query, and lint behavior.
- Query UX that answers from the wiki with citations and can persist high-value answers.
- Lint/health workflows surfacing contradictions, orphans, staleness, and coverage gaps.
- Human-in-the-loop review of updates (especially early / high-stakes domains).
- Browseable knowledge graph (links/graph), not chat-only memory.
- Multi-context applicability: personal, research, team/internal wiki from meetings/docs — shared second brain for humans and agents.
