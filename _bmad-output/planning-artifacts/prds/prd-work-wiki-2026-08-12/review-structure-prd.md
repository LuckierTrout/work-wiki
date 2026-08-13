# Structure review — PRD work-wiki (2026-08-12)

This document exists to help Christian and downstream UX, architecture, and epic authors extract a build-directing product contract without inventing requirements.

**Reader type:** humans (downstream UX / architecture / epics)
**Style:** Microsoft Writing Style Guide
**Structure model:** Strategic/Context (Pyramid)
**Current length:** 13,338 words (`word_metrics.py`)
**Constraint honored:** no CUT of FRs or testable consequences; content is sacrosanct.

Pyramid fit is close: Vision leads, FRs carry the contract, Non-Goals and MVP sequencing follow. The shape fights the reader where the same contract is restated after §4, where two FRs sit under the wrong heading, where §6 numbering is out of reading order, and where API/skill protocol is dumped into the product spine.

Cap: 8 highest-value CUT / MERGE / MOVE / CONDENSE. Nitpicks omitted.

| Pass      | Original Text                                         | Revised Text                                  | Changes                                                              |
| --------- | ----------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| structure | §14 Integration — duplicate bullet block (~90 words; second copy of Office/PDF, Web Capture, LLM providers, Web search, MCP/HTTP) | CUT the second copy (keep the first, including “sidecar” on MCP/HTTP) | Identical information with no reinforcement value; two slightly different MCP lines will fork epics (saves ~90 words) |
| structure | §4.17 Backup and portability — FR-73 Markdown rendering (~101 words) + FR-74 dataVersion signaling (~70 words) | MOVE FR-73 to §4.2 after FR-5 (Preview/Chat render); MOVE FR-74 to §4.2 after FR-8 (Workbench-wide refresh) | Backup heading hides Preview/Chat/Graph contracts; UX scanning 4.2/4.6 will miss them (0 words removed) |
| structure | §6 MVP Scope — 6.1 In Scope, then **6.3** Epic order, then **6.2** Out of Scope | MOVE §6.3 to after §6.2 (restore 6.1 → 6.2 → 6.3) | Numbering and reading order disagree; Out of Scope is skipped then hit after sequencing (0 words removed) |
| structure | §6.1 In Scope (~297 words) | CONDENSE to one line that v1 includes all of §4, plus a pointer to §6.3 P0/P1; do not re-list formats, Chat tools, or API surface | Verbatim restatement of §4 after the reader already has FRs; unique sequencing already lives in §6.3 (saves ~220 words) |
| structure | §9 Assumptions Index (~451 words) | CONDENSE to tagged `[ASSUMPTION]` inferences that are not already FR consequences; drop restated SHA256 / 3-retries / English / 60-20-5-15 / history-N / Plaud-P0 / view-first bullets | Dual source of truth vs §4; index should round-trip tags, not republish the contract (saves ~200 words) |
| structure | FR-79 llm-wiki Agent Skill (~417 words) — install variants, skill-file list, trigger discipline, lookup recipe, “do not dump/fabricate” | CONDENSE the FR to the product contract + **Consequences (testable)**; MOVE recipes, trigger lists, and extra install paths to `addendum.md` | Skill-pack documentation in the PRD spine; UX/epics need health-probe / read-only / cite-paths, not agent prose (saves ~220 words in `prd.md`) |
| structure | FR-36 (~301 words) status/CORS/rate-limit/size-cap matrix + FR-76 (~433 words) client recipes (`{id}` resolution, score-across-mode, pagination) | MOVE protocol matrix and client recipes to `addendum.md`; KEEP bind/auth/token, the FR-76 route table, wikilink-graph ≠ FR-45, and v1 mutation scope in §4.16 | Premature protocol detail in the product spine; architecture still has the contract in the addendum (saves ~180 words in `prd.md`) |
| structure | §13 Constraints and Guardrails (~55 words) vs §12 Cross-Cutting NFRs (~118 words) | MERGE §13 into §12 (Privacy, Cost, Safety/Integrity already live there); keep unique Safety bullets (no invented citations, no auto-approve Todos, no unconfirmed Deep Research, no unapproved external shell) | Same cross-cuts in two adjacent sections; one MECE NFR block (saves ~40 words) |

## Summary

- **8 recommendations** (2 CUT/MERGE, 3 MOVE, 3 CONDENSE).
- **Estimated reduction if all accepted:** ~750 words in `prd.md` (~6% of 13,338), plus ~400 words relocated to `addendum.md` (not deleted).
- **No length target** was provided.
- **Comprehension trade-offs:** none of the eight remove an FR or a testable consequence. Condensing §6.1 and §9 removes post-body restatement that currently competes with the FRs. Moving FR-73/FR-74 and restoring §6 order improves scan for UX. Protocol/skill recipes remain in the addendum for architecture.
- **Explicitly preserved:** §0 purpose, §1 Vision (pyramid headline), §2.3 journeys, §3 Glossary, all FR headings and consequence lists, §5 Non-Goals, §6.3 P0/P1, §7 metrics, §10 IA table (UX scan aid).
