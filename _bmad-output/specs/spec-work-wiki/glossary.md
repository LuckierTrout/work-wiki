# Glossary — work-wiki

Vocabulary for this spec. FR-level detail lives in the adopted PRD. Chat-as-rail-icon follows UX + architecture (supersedes the PRD glossary line that called Chat a center column, not a rail mode).

- **Wiki** — Christian's private compiled knowledge base: markdown Pages with wikilinks and frontmatter. One operator; each Wiki is a named project from a Scenario Template.
- **Source** — Immutable raw input. Never overwritten by compile.
- **Page** — One wiki document, identified by slug. May accumulate many Sources.
- **Ingest** — Compile: Analysis then Generation. Updates Pages, Index, Log, Overview, Review items, and Todo Candidates when applicable.
- **Ingest Analysis** — Step-1 structured output. Input to Generation; not a user-facing Page unless filed.
- **Source summary** — Page summarizing one Source. Required for successful Ingest (system fallback if the LLM omits it).
- **Overview** — `overview.md`, regenerated on every successful Ingest.
- **Workbench** — Web shell: icon **rail** switches modes; mode panel (tree, conversation list, or Settings nav); Preview docks when a tree pick or Chat citation is active; Activity panel for Ingest.
- **Knowledge Tree / File Tree** — Left-column browse of Pages by structure vs files.
- **Activity panel** — Queue visualization: pending / Analysis / Generation / succeeded / failed, with cancel and retry.
- **Scenario Template** — Research, Reading, Personal Growth, Business, General — seeds `purpose.md` + Schema.
- **Chat** — Query against the compiled Wiki via the **local sidecar Agent**. A **rail icon**. Multi-Conversation. Not an in-browser tool loop and not `query.ts`.
- **Conversation** — Independent named Chat session, kernel-durable.
- **Preview** — View-first rendering of the selected Page. Markdown edit is confirm-gated. Not WYSIWYG.
- **Skill** — In-app Agent instruction pack (`SKILL.md`). Distinct from the installable **llm-wiki Agent Skill pack** (HTTP docs for Claude Code / Codex).
- **Agent workspace** — `agent-workspace/` files the Agent generates; previewable from Chat.
- **Lint** — Health check (contradictions, orphans, staleness, broken links, gaps).
- **Review item** — Async HITL card from Ingest. Actions: Create Page, Deep Research, Skip only.
- **Deep Research** — Confirmed multi-query web research that synthesizes a Page and auto-Ingests.
- **Todo Candidate / Todo** — Proposed action from a meeting Source; becomes a Todo only after approve.
- **Schema** — Executable conventions (`SCHEMA.md` / page conventions) that steer Ingest, Chat, Lint, and Todo extraction.
- **Intake** — Any path that delivers a Source. Arrival always queues Ingest.
- **Retrieval pipeline** — Tokenized search → optional vector → graph expansion → budget → context assembly.
- **Relevance / Community / Cohesion / Insight** — 4-signal edge score; Louvain cluster; intra-edge density (warn below 0.15); Graph cards (Surprising Connection or Knowledge Gap).
- **Sidecar** — Local process: Chat Agent, extractors, shell, Skills scan, loopback `:19828`, MCP wrap. Not a second wiki.
- **Kernel** — OpenNext Workbench + `src/lib` + R2/KV. System of record.
