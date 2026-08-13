# Reconciliation extract — work-wiki-concept.md

**Input:** `work-wiki-concept.md`  
**Intent:** North-star concept for work-wiki as a collective second brain — commons-first, dual-surface (human wiki + agent API), agent-maintained, accumulating (not RAG).

## What the PRD / addendum captured

- **Not RAG / compile-once:** accumulate into concept Pages; contradictions stay `disputed`; Sources immutable; Chat cites compiled Pages (Vision, FR-2, FR-3).
- **Human wiki substrate:** markdown + YAML frontmatter, wikilinks, `sources[]`, Schema-steered Ingest (Glossary, FR-34).
- **Agents maintain Pages via Ingest;** Christian curates Sources, Chat, Review, Todos (FR-1 description, FR-9).
- **Private-by-default** single-operator Wiki; per-owner isolation kept from the fork (FR-1, §9).
- **Multiple named Wikis** from Scenario Templates (FR-38) — a private analogue of “named vaults,” not commons lenses.
- **Ingest merge** when a Source maps to an existing concept; SHA256 skip + provenance (FR-3, FR-10).
- **Lint / expiry-staleness / disputed** as health, not silent overwrite (FR-21, UJ-4).
- **CJK-aware tokenized search** (FR-51) with English-only UI/LLM (non-goal).
- **Bounded retrieval cost** (FR-54 budget; SM-C3) vs dumping the whole Wiki.
- **MCP / HTTP API** as the agent access path (FR-36, FR-76–79) — nashsu-shaped, not the concept’s open research question.
- **Mechanism** (Workers, R2/KV/Vectorize, Clerk, queues) parked in addendum, not FRs.
- **Explicitly deferred north star:** commons, public lab, billing, federation, token-funded agents, trust scores (Non-Goals; addendum Rejected table).

## Gaps

Ideas in the concept that the PRD dropped or diluted. Items the addendum already refused are labeled **rejected (in addendum)** and are not misses.

### Highest-signal (4)

1. **Humans discuss, agents write (talk as the human job).** Concept division of labor: humans ingest and steer via **talk threads** (dispute, staleness, merge/split); agents write; direction is to retire prose-editing of maintained pages. PRD replaces this with a Review queue (Create Page / Deep Research / Skip) and leaves Preview editing as Open Question 5 (“talk-style steer” is a PM note, not a feature). The emotional job — *I argue with the wiki; I don’t maintain the prose* — is not a journey.

2. **Wiki as identity + knowledge layer for agents (per-user yoyo).** Concept dogfood: every signed-in user gets a forked `<handle>/yoyo`, agent `owner`, agents **query** (they don’t get copies), agent-knowledge vs deliberate publish, agent profiles. Addendum rejects only **commons publish** and **token-funded maintenance**, not this layer. PRD’s “Agent” is nashsu’s Chat tool-runtime + MCP skill for Claude Code. Audience shift: concept co-builders are *humans and their agents*; PRD’s user is Christian with an Agent feature.

3. **Agent-surface form as a primary research question.** Concept: “What’s the right form of a wiki for agents?” (claim graphs / fact triples / embeddings vs the same markdown) is something the product answers over time — not an assumption. PRD treats markdown Pages + `/api/v1` + MCP as the answer. Roadmap “agent-surface research” is neither a Non-Goal nor an Open Question.

4. **Trust feel: confidence + visible decay on every page.** Concept human surface is trusted because every claim has a **citation and a confidence**, and stale knowledge **visibly expires**. PRD keeps citations and `disputed`, and Lint lists staleness, but `confidence: 0–1` and expiry-as-the-look-of-the-wiki are not in Vision, JTBD, or FRs. The *feel* of a decaying, scored commons page is gone.

### Rejected (in addendum) — not misses

- **Commons-first collective wiki**, public observer / reads-stay-public, vaults as live reference lenses over the commons, clone-to-private + Clerk Billing.
- **Token-crowdfunded agents**, federation, contributor trust scores, Twitter/X-community growth.
- **PRODUCT.md “public research lab” UI** (addendum aesthetic note).

### Noted dilutions (below the cut)

- Canonical-concept **resolver contract** (slug from concept not source title; exact slug → alias → embedding nearest-page; conservative, err toward a new page) is implied by FR-3 merge, not specified.
- `owner` vs `authors`/`contributors`/`triggered_by` attribution table is unused in a solo private Wiki.
- Concept MCP is stdio-only / no HTTP; PRD requires local HTTP `:19828` + MCP (nashsu parity — intentional, not a concept miss).
