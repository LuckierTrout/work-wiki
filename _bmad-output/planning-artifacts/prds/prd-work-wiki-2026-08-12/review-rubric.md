# PRD Quality Review — work-wiki (2026-08-12)

## Overall verdict
The thesis holds: a private compiled wiki (not RAG), nashsu Workbench parity on the web, plus HITL meeting Todos, with commons/public lab honestly killed for v1. Most FRs carry testable consequences, metrics include counter-metrics that match the bet, and the addendum parks mechanism and rejected alternatives instead of laundering them into requirements. What is at risk for a high-rigor chain-top is not vision — it is extraction: an unsequenced full-nashsu MVP, an unresolved Agent/loopback/Cloudflare topology, a Review HITL vs Review API fork, and a disputed/Lint contract too thin for the trust claim. Close those and this is build-directing; leave them and UX/architecture/epics will invent three different products.

## Decision-readiness — adequate
Trade-offs are named as decisions, not “balances”: “This is not RAG,” “Not a Tauri/desktop rewrite,” “Not a multi-user commons or public research lab in v1,” English-only, no auto-approved Todos. The addendum’s rejected-alternatives table gives a pusher-back something to cite. Open Questions 3, 4, 6, 7, 8 are real defaults (provider, MinerU, retention, phone, mailbox), not rhetorical.

The document still will not let architecture pick one operator topology. FR-36 requires “The local server binds **127.0.0.1 only** (default port **19828**)”; FR-60/65 require a Rust backend Agent and “**External** shell commands require **explicit approval**”; §9 assumes “Stay on the existing Next.js / Cloudflare web stack.” Those three cannot be one process. Open Question 9 leaves “Where the Rust Agent process runs (local sidecar vs remote service)” open, while the FR-36 assumption already smuggles both: “cloud/remote access uses the same `/api/v1` shape behind the operator’s auth; the nashsu-compatible bind is the local Agent sidecar.” The addendum has the answer (“Plan for a **Rust Agent service/sidecar**”) but the PRD never promotes it, so a decision-maker can green-light a product that architecture cannot host as written.

Plaud, the load-bearing job loop, is similarly half-decided: FR-31 says “if that slips, export/upload of transcript+summary is the hard fallback.” That is honest, but UJ-1’s “before the next call” depends on which path is v1. Preview editing (Q5) is the same pattern: a `[NOTE FOR PM]` recommendation sits next to an open question, so UX cannot lock Preview.

### Findings
- **high** Three topologies asserted as one product (§4.16 FR-36, FR-60/65, §8 Q9, §9, addendum “Chat Agent runtime”) — “binds **127.0.0.1 only**” + Cloudflare web stack + external shell. *Fix:* Promote the sidecar to a PRD decision: Workbench on Workers; Agent/MCP/shell on a local (or dedicated) sidecar; cloud `/api/v1` is a separate authenticated façade, not the 19828 bind.
- **high** Plaud connect is a slip-allowed assumption on UJ-1 (FR-31, §8 Q1) — “if that slips, export/upload … is the hard fallback.” *Fix:* MVP In: export/upload must; OAuth list/pull is stretch. Do not hang UJ-1 on an assumption.
- **medium** Preview editing is still an open question with a recommendation that is not a requirement (§8 Q5, Glossary “edit where allowed”). *Fix:* Convert the NOTE into an FR: view-first Preview; owner markdown escape hatch; no Milkdown WYSIWYG in v1.

## Substance over theater — strong
One named operator, five UJs that actually drive FRs, Non-Users that exclude the concept-doc audience. Vision cannot be swapped into a generic AI-wiki PRD: “RAG re-derives an answer from raw chunks every time you ask. work-wiki **compiles once and maintains**.” NFRs in §12 point at FRs (skip-hash, budget, disputed, retryable queue) rather than “must be scalable.” Graph weights, cohesion 0.15, and the five Scenario Template names are nashsu-parity contracts, not innovation theater — they follow from the stated UX target.

The one slab that reads like furniture is FR-79: install command, trigger phrases, “Do not dump full pages unless asked,” “When in doubt, **ask** which tool.” That is skill-pack documentation pasted into a product PRD. It does not change the Workbench and will not help UX.

### Findings
- **medium** FR-79 is agent-facing skill prose, not a Workbench requirement (§4.16) — “Trigger discipline,” “Do not fabricate,” stock skill “must not `POST /chat`.” *Fix:* Keep compatibility (health probe, token, read-only except rescan, cite paths) as FRs; move recipes and trigger lists to addendum or the skill repo.

## Strategic coherence — adequate
The bet is unified in §1: compile-once personal wiki, nashsu shell, meeting Todos as the job increment. SM-1–SM-3 validate that bet (same-session Todo HITL, cited Page without opening Plaud, zero silent Source loss). Counter-metrics SM-C1–C3 are the real tell — they punish page-spam, Todo-spam, and “stuff the whole Wiki into the prompt,” which is exactly the thesis.

What does not follow from the thesis is sequencing. §6.1 is the entire nashsu surface plus Todos, listed as equal in-scope. The Risks row “Parity scope explodes” mitigates with “MVP = Workbench + Ingest/Chat/Lint/Review/Graph/Research/Capture + Todos,” which is not a cut — it is the backlog restated. UJ-1 (Plaud → wiki + Todos) and FR-47 Louvain / FR-79 skill triggers therefore have the same priority. Epics cannot source-extract a first ship.

§4.16 (local HTTP API, MCP, Agent Skill) is tagged “Realizes UJ-2,” but UJ-2 is Workbench Chat: “He asks in an existing or new Conversation (sidebar switch).” There is no journey in which Christian’s Claude Code / Codex session is the protagonist. For a personal job tool that may still be load-bearing — it is not traced.

### Findings
- **high** MVP is unsequenced full-parity (§6.1, §15) — meeting loop and Louvain/API/Skill are the same “in scope.” *Fix:* P0 = private Wiki, Workbench, two-step Ingest, Plaud/upload, cited Chat, Todo HITL, export. P1 = Graph Insights, Deep Research, API/MCP/Skill, office/EPUB, in-app Skills/shell.
- **medium** API/MCP/Skill has no journey (§4.16 vs UJ-2). *Fix:* Add UJ-6 (external agent grounds in the wiki without opening the Workbench) or mark 4.16 as P1 parity, not a UJ-2 realization.

## Done-ness clarity — adequate
This is the PRD’s strongest craft at the FR level: SHA256 skip, 3 auto-retries, 60/20/5/15 budget, N=10 history, cohesion < 0.15, 3 concurrent Deep Research tasks, closed Review actions, no fake citations, cancel-must-not-commit. Adjective NFRs are rare; “gracefully” / “user-friendly” do not appear.

The holes sit on the trust and health claims that the Vision sells. FR-3: “A contradictory claim marks the Page disputed and remains inspectable” — no frontmatter key, no Preview treatment, no who-sets-it. FR-22 then refers to `` `disputed` `` as if the field existed. UJ-4’s climax (“see *why* a claim is disputed”) cannot be story-tested. FR-21’s testable consequences are only “Disputed Pages appear in the report” and “Broken wikilinks are listed,” while §4.7’s description also promises “expiry/staleness, duplicates, … orphans, suggested gaps.” SM-4 then asks Lint to be “runnable” without those checks. FR-12’s third matching method — “**Frontmatter section references**” — is not in the Glossary. FR-6’s min/max are “Chat remains usable (input visible).” FR-22’s mechanical auto-fix is “e.g. broken link to a renamed slug,” not a closed class list.

### Findings
- **high** Disputed state has no representation contract (FR-3, FR-22, UJ-4, §12 Integrity) — “marks the Page disputed” vs later `` `disputed` ``. *Fix:* Frontmatter `disputed: true` (or equivalent), visible in Preview and Lint, cleared only by a new Ingest/Review — not by mechanical auto-fix.
- **high** Lint consequences do not cover the Lint product (§4.7 FR-21 vs description, SM-4). *Fix:* One testable consequence per class (staleness, duplicates, orphans, gaps), or explicitly move orphans/gaps to FR-49 only.
- **medium** FR-12 “Frontmatter section references” is undefined. *Fix:* Name the keys/sections that count as a match.
- **medium** FR-6 min/max are adjectives. *Fix:* Numeric floors (e.g. Chat ≥ 320px; tree/Preview ≥ 200px) so UX/architecture do not invent them.
- **medium** FR-22 mechanical auto-fix is an example, not a set. *Fix:* Enumerate v1 classes (renamed-slug links, dangling `[[slug]]` after FR-12, index drift); everything else is Lint-only.

## Scope honesty — adequate
§5 Non-Goals does real work: not RAG-as-product, not commons, not Tauri, not auto-Todos, not PM boards, not talk pages, not confidence badges, not `synthesis/`/`comparisons/` icons. MVP out-of-scope gives reasons. Inline `[ASSUMPTION]` tags are frequent and usually at real inferences (cancel-commit, AnyTXT substitute, bookmarklet parity).

Open-item density is the problem at these stakes. Nine Open Questions plus ~35 inline assumptions on a chain-top, job-critical PRD: Q1 (Plaud), Q2 (meeting detection), Q5 (Preview edit), and Q9 (Agent host) sit on UJ-1, Todo extraction, UX, and architecture. The rubric treats that density as a green-light blocker. Only two `[NOTE FOR PM]` callouts exist, and neither is the Agent topology.

§9 mixes true inferences with restated requirements (“SHA256 is the incremental Ingest cache,” “Failed Ingest auto-retries at most 3 times,” “English only,” the 60/20/5/15 split). Several inline tags never appear in the index (composer-on-switch, Save-to-Wiki uses main response only, Generation-only retry, WCAG-not-a-gate, mobile Chat+Todos, SM-6 not an SLA). Nashsu extras (EPUB/MOBI, Mermaid/KaTeX, Firecrawl, three Deep Research providers, 1M-token slider) are in-scope with no stretch label, so omissions the reader might assume (job tool = Plaud + office docs) are not the omissions the PRD made.

### Findings
- **high** Critical-path questions still open on a high-rigor chain-top (§8 Q1, Q2, Q5, Q9). *Fix:* Close or default those four before UX/architecture; leave Q3/Q4/Q6/Q7/Q8 as Settings defaults.
- **medium** Assumptions Index is not a roundtrip (§9 vs inline tags) — requirements restated; composer/Save-body/WCAG/mobile/SM-6 missing. *Fix:* Index only tagged inferences; drop restated FRs.
- **medium** Job-unnecessary nashsu extras are silent in-scope (§6.1: EPUB/MOBI, Mermaid/KaTeX, Firecrawl, three research providers, 1M slider). *Fix:* Mark P1 or `[NON-GOAL for MVP]` unless they are required for Plaud + office.

## Downstream usability — adequate
Chain-top needs clean extraction. Glossary is rich and mostly stable (Source vs Page vs Ingest Analysis, Todo Candidate vs Todo, Intake vs Capture, Community vs Cohesion). UJs name Christian. FR IDs are unique. GET `/graph` is explicitly *not* the 4-signal Workbench graph — a rare, useful distinction.

Two collisions will fork implementations. Workbench Review (FR-23 / Glossary) is a closed set: “**Create Page**, **Deep Research**, **Skip**.” FR-76 Review API is a different object: `PATCH … { "resolved": true, "action": "label" }` and bulk-resolve by ids. Epic writers will build two Review models. Domain nouns drift: Glossary **Wiki**, FR-76 `/projects`, FR-8 “project config,” FR-37 “Obsidian can open the vault,” addendum “vaults/commons.” **Skill** (FR-62 in-app packs, `/skill`) and **llm-wiki Agent Skill** (FR-79 docs pack) share one Glossary entry. IA §10 lists Chat as a Mode; FR-4’s icon modes omit Chat because Chat is the center column (FR-5). UX will draw nine or ten icons depending on which section they pull.

### Findings
- **high** Review HITL and Review API are different products (FR-23 vs FR-76) — “only three actions” vs `"action": "label"`. *Fix:* Map API mutations onto Create Page / Deep Research / Skip (and Skip = resolved), or Glossary-split **Review item** from **exported review record**.
- **medium** Wiki / project / vault used interchangeably (Glossary, FR-8, FR-76, FR-37, addendum). *Fix:* Wiki = product; project = API `{id}`; vault = Obsidian export only.
- **medium** Chat is a column in FR-5 and a Mode in §10; FR-4 icons omit it. *Fix:* IA: Chat is the center column, not an icon; modes = FR-4’s eight + Todos.
- **medium** One Glossary **Skill** covers FR-62 and FR-79. *Fix:* **Skill** (in-app pack) vs **Agent Skill pack** (installable docs + curl).

## Shape fit — strong
This is a single-operator internal tool with a brownfield fork and chain-top downstream. The PRD chose the right shape: capability spec with operational SMs, one protagonist, UJs that earn their keep rather than persona theater, commons explicitly out. Addendum “Existing app vs this PRD” distinguishes already-present (ingest, lint, graph, MCP, bookmarklet, vaults/commons) from must-change (private-by-default, three-column Workbench, Rust Agent, Review, Todos). Sizing note (“internal-tool-sized … not a hobby one-pager”) matches the stakes.

Over-formality is concentrated in FR-36/76: 413/429/CORS/timing-safe compare/120 req/sec is a compatibility protocol inside a product PRD. That is the right contract for nashsu API parity and the wrong altitude for UX. It does not make the overall shape wrong.

### Findings
- **medium** FR-36/76 is a status-code matrix in the PRD body. *Fix:* Keep bind, auth, and route list as product; move the error/CORS/rate-limit matrix to addendum as the compatibility appendix.

## Mechanical notes
- **FR IDs:** Unique; not contiguous. Gaps at **FR-43** and **FR-75**. Document order is thematic (FR-39 follows FR-12, FR-57 follows FR-13), which is fine if epics key by ID not by sequence — say so, or renumber 1..N before story creation.
- **Assumptions Index roundtrip:** Incomplete. Inline but not indexed: composer-on-switch (FR-57), Save-to-Wiki = main response (FR-66), Generation-only retry (FR-9), Ingest shares Chat slider (FR-54), Communities refresh with Graph (FR-47), surprise coefficients (FR-48), Insight dismissals (FR-20), skill vs branded fork (FR-79), SM-6 not SLA, mobile Chat+Todos (§11), multi-minute Ingest (§12), WCAG not a gate (§12). Indexed but not tagged / actually FRs: Next.js stack, Todos extra icon, SHA256, 3 retries, English only, dual models, vector-off default, 60/20/5/15, history N=10, Obsidian export. Index-only: “Panel widths may persist locally.”
- **UJ protagonists:** All five name Christian. UJ-4 has no Entry state (UJ-1–3 do).
- **Glossary drift:** Wiki/project/vault; Skill vs Agent Skill pack; `disputed` as adjective then as field; “frontmatter section references” undefined; Chat as mode vs column.
- **Cross-refs:** FR-45 vs `GET .../graph` correctly disambiguated. FR-8 ingest-queue durability “validates SM-3” resolves. No duplicate FR/UJ/SM IDs.
- **Required sections:** Present for high-stakes internal/brownfield/chain-top (Vision, Non-Goals, MVP in/out, SMs + counters, Open Questions, Assumptions Index, IA, NFRs, Risks, addendum mechanism).
