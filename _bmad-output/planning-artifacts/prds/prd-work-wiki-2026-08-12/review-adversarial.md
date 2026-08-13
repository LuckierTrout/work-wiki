# Adversarial review — PRD work-wiki (2026-08-12)

**Lens:** BMad Finalize Reviewer Gate (adversarial). Look for what is missing, not only what is wrong.
**Inputs:** `prd.md`, `addendum.md`, `.memlog.md`.
**Consumer:** UX, architecture, epics. Fast-path personal job tool; nashsu/llm_wiki web parity; Karpathy compile-once; HITL Todos; single operator; not commons.
**Verdict:** Do not treat this PRD as architecture- or UX-ready. Two open questions are phase-blockers, Chat Agent “done” is not testable, and several nashsu-desktop contracts are pasted onto a Cloudflare web app without a hosting decision.

---

## Findings

- **[critical]** Agent host is an architecture phase-blocker; local `:19828` assumes a desktop process that this product is not (§8 Q9, FR-36, FR-60–65, FR-78–79, addendum “Chat Agent runtime”) — The PRD requires a Rust backend Agent with workspace file tools, approved shell, Skill folder scans, `agent-workspace/`, and a **127.0.0.1:19828** token API whose skill docs say “if the app is not running → connection refused.” v1 is a Next.js app on Cloudflare Workers. Workers cannot host general shell; R2 is not a cwd; there is no local vault. Addendum admits this and then leaves Q9 open. Until “local sidecar vs remote service” is decided, architecture cannot place Chat, extraction (pdf-extract/docx-rs/calamine), MCP, or the Agent Skill, and UX cannot know whether Settings → API + MCP is a cloud panel or a “start the sidecar” product. Two servers (Clerk HTTPS app vs loopback sidecar) are implied and never specified: who owns the Wiki bytes, how they sync, and which one Claude Code talks to. *Fix:* Close Q9 before UX/architecture. Pick one: (A) local sidecar required for Chat/API/MCP (honest desktop dependency; update Non-Goals that rejected Tauri), or (B) remote Agent with **no shell**, no `127.0.0.1` bind, cloud `/api/v1` behind Clerk, and FR-65/FR-36 loopback/FR-79 “app not running” rewritten. Do not leave both in MVP.

- **[critical]** Preview editing is a UX phase-blocker and contradicts compile-once ownership (§8 Q5, Glossary “Preview”, FR-5, Non-Goals, Karpathy) — The right column is half the Workbench. Glossary: “rendered markdown; **edit where allowed**.” Q5 still asks view-only vs WYSIWYG. Karpathy/concept: LLM maintains Pages; humans steer. Non-Goals kill talk pages, ingest-diff review, and confidence badges — so the steer surfaces are Review, Schema, Chat, and maybe Preview edit. That “maybe” is the product. UX cannot wireframe Preview, File Tree context menus, or “who writes the wiki.” Architecture cannot choose Milkdown vs markdown-escape-hatch vs Ingest-only writes. The PM note in Q5 is a preference, not a requirement. *Fix:* Lock v1: Preview is **view-first**; owner markdown edit is an explicit escape hatch (confirm + “LLM may overwrite on next Ingest”); Ingest/Review/Schema are the normal write path. Delete “edit where allowed.” Move WYSIWYG to a later PRD.

- **[high]** Chat Agent, Skills, and shell have no testable “done” (FR-60–65, FR-79, SM-2) — Consequences are tautologies or LLM-flaky. FR-61: “a question that needs Wiki lookup can trigger wiki search” — no golden questions, no required tool-call traces, no fixture Skills. FR-62: “project and user Skill folders” — no paths, no file format (SKILL.md? YAML?), no shipped vs empty-folder success. FR-64: Skills “request structured input” — no form schema the renderer must honor. FR-65: “project workspace commands” vs “external” — undefined on a web Wiki with no local disk; approval UI cannot be specified until Q9. FR-63: `agent-workspace/` has no storage contract. FR-79 is a **documentation-only external skill** that **must not** call `/chat`, while FR-60 is **in-app** Chat that must. Success metrics never mention Agent/Skills/shell (SM-2 is citations). An epic can ship a streaming stub and claim FR-60–65. *Fix:* Add an acceptance slice: (1) Skill file format + scan paths; (2) one fixture Skill that must present a form and write a file under `agent-workspace/`; (3) three golden Chat turns with expected tool names (wiki search / source search / none); (4) shell: either **out of v1** or a table of allow/deny commands once the host is chosen; (5) a metric or gate that Chat fails closed without the Agent (already in FR-60) **and** that the fixture Skill path passes. Split FR-79 (external curl skill) from FR-60–65 (in-app Agent) so “done” cannot be satisfied by shipping markdown into `~/.claude/skills`.

- **[high]** `/chat` 501 vs FR-77 vs stock skill is an unresolved product fork (FR-76, FR-77, FR-79, addendum) — The table says work-wiki **implements** `POST .../chat`. Nashsu desktop returns **501**; stock `llm-wiki` skill **must not** call it. FR-78 says MCP **can** call Agent chat. Assumption: v1 “may” ship the stock skill (chat stays 501 in that skill) **or** a branded fork. That is not a decision. Epics will either build FR-77 as dead API or fork the skill in the same sprint with no owner. External agents that follow the advertised install command never exercise the Workbench’s differentiator. *Fix:* Decide one v1 contract: (A) ship a work-wiki-branded skill that **does** call FR-77 (document SSE `done` aggregate, `mode: deep` ≠ Research Panel); or (B) drop FR-77 from MVP and keep `/chat` 501 until a later skill. Do not list both as in-scope. Align FR-78 MCP with the same choice.

- **[high]** Meeting-detection open question makes Todo extraction untestable (§8 Q2, FR-26, UJ-1, SM-1) — FR-26 is the job feature beyond nashsu. Consequences: meeting Ingest “always” updates the Todo list; non-meetings “do not spam.” The rule is an assumption: “Plaud origin, or user-marked meeting, or transcript-like schema; PPT/PDF default off.” Q2 still asks Plaud-only vs flag vs classifier. Without a closed rule, SM-1 and the Todos epic have no given/when. A PPT of a meeting deck, an emailed transcript, a pasted Zoom doc, and a Plaud pull can each go either way. *Fix:* Close Q2. Recommended v1: extract iff Plaud origin **or** Christian marks “meeting” on the Source; never classify PPT/PDF/URL by default. Put that in FR-26 consequences; delete the open question.

- **[high]** Email Intake is in MVP while the integration is unchosen (§8 Q8, FR-41, §6.1, §14) — Arrival paths in MVP include **email**. Q8 still asks inbound address vs connected mailbox — different auth, different failure modes, different UX (none vs a mailbox picker). Architecture cannot start FR-41 email. Fast-path v1 does not need email if upload/folder/Plaud/API exist. *Fix:* Move email **out of MVP** until Q8 is answered, or pick inbound address now (simpler, matches “not an email client”) and write the address + provenance fields into FR-41. Same treatment as Plaud: one must-work path, one deferred path.

- **[high]** Commons/MCP decommission is missing; FR-1 is a privacy slogan, not a cut list (FR-1, Risks, addendum “Existing app vs this PRD”, extract-current-app) — The fork is a public commons with waitlist, vault lenses, talk threads, 40+ MCP write tools, public wiki browse. v1 Non-Goals forbid commons, talk, billing, observers. Risks say “FR-1 is a release blocker.” FR-1 only tests 401 and “no public listing.” There is no FR to **remove or hide** existing public routes, discuss/talk, clone-to-private, waitlist, or the write-capable MCP surface that contradicts FR-76’s read-only-except-rescan skill. Architecture will bolt a Workbench onto a still-public app. *Fix:* Add a decommission FR (or Non-Goal with a testable cut list): public listing/graph/query off; talk routes gone or 404; waitlist/billing UI gone; existing `src/mcp.ts` write/merge/ingest tools either wrapped in owner auth and documented as **out of the nashsu skill** or retired. FR-1 consequences must include “existing commons URLs do not serve Christian’s Pages.”

- **[high]** Vector-off default vs auto-embed vs existing hybrid search leaves enablement and backfill unspecified (FR-42, FR-52, SM-6, addendum Mechanism) — Not a logic bug: auto-embed is gated on vector-on. The gaps: (1) turning vector **on** for an already-compiled Wiki has no backfill/rebuild FR — only “new and updated Pages after Ingest”; SM-6’s recall lift is then false for old Pages; (2) the running app already does hybrid BM25 + Vectorize — v1 **disables** that by default without saying the existing embed path is switched off; (3) SM-2 (primary Chat success) is measured on the weaker tokenizer-only path. *Fix:* Add FR: enabling vector enqueues embed of all current Pages (progress in Activity); disabling does not delete Sources/Pages; first-run default remains off. State that the fork’s always-on Vectorize is **not** v1 default. Do not use SM-6 as a v1 gate unless backfill exists.

- **[medium]** English-only non-goal vs CJK bigram tokenization will spawn a tokenizer epic nobody asked for (Non-Goals, FR-51, §9, .memlog) — Non-goal: i18n English only. FR-51 still requires CJK bigrams (`每个` → …) “so mixed-language Sources still match,” with a parenthetical that UI/generation stay English. Memlog still records “EN/ZH generation” on one line and “Dropped FR-43” on the next. For a single-operator English job wiki this is nashsu residue unless mixed-language **Sources** are in-scope. As written, architecture will build a CJK tokenizer while generation is forbidden to emit Chinese. *Fix:* Either promote a one-line requirement: “Sources may contain CJK; retrieval must match; UI and Generation stay English — this is not i18n,” or **cut CJK from v1** and say English word+stopword only. Strike EN/ZH from memlog. Do not leave a nashsu example as the only spec.

- **[medium]** FR ID gaps FR-43 and FR-75 are unexplained; numbering is not a stable epic index (§4, .memlog) — Globally numbered FRs skip **43** (dropped Chinese generation — only in memlog, not in the PRD) and **75** (no record). Document order is not numeric (FR-39 after FR-12, FR-13 after FR-44). No duplicates, but downstream epics that allocate “FR-43” or assume contiguous IDs will invent work or collide. *Fix:* In §4 or an appendix, list reserved/dropped IDs: `FR-43 dropped (Chinese generation); FR-75 unused.` Freeze IDs; do not renumber. Optionally add a one-line index table FR → section.

- **[medium]** Two HITL queues after one meeting Ingest have no IA (FR-23 Review vs FR-26 Todos, UJ-1, §10) — A Plaud Ingest can emit Review items (Create Page / Deep Research / Skip) **and** Todo Candidates (approve/reject). UJ-1 climax is Todos; UJ-4 is Lint/Graph/Review. Nothing says which panel opens, whether Activity “succeeded” hides both, or how Skip vs Reject differ. UX will either merge them into one junk drawer or make Christian visit two icons to finish one meeting. *Fix:* Specify post-Ingest UX: Activity success + badge counts on Review and Todos; meeting Ingest focuses **Todos** (UJ-1); Review stays async and never blocks. One sentence: Review ≠ Todos (pages/research vs action items).

- **[medium]** Todos are job-critical and missing from the API, MCP, File Tree, and a storage path (FR-26–29, FR-76, FR-37, §10) — No `/api/v1/.../todos`. MCP cannot list or complete them. ZIP “includes Todos” with no filename/schema. File Tree/Knowledge Tree do not mention them. External Agent Skill is read-only wiki files — the working list that SM-1 cares about is Workbench-only. *Fix:* Define Todo persistence (e.g. `.llm-wiki/todos.json` or equivalent) in export/import. Either add read/complete routes to FR-76 **or** explicitly Non-Goal “Todos are Workbench-only in v1.” Do not imply portability in FR-37 without a record shape.

- **[medium]** Workbench “Wiki mode” vs Chat-always-center is an IA hole (FR-4, FR-5, §10) — FR-5: Chat is the center column always. FR-4 / §10: **Wiki** is a sidebar mode (“Knowledge Tree of Pages; Preview; default Workbench”). If Chat never leaves the frame, what does the Wiki icon change? Sources vs File Tree also overlap (`raw/sources/` in Sources mode and in File Tree). UX cannot draw the icon map. *Fix:* Define modes as **left-column + right-column bindings** (Wiki → Knowledge Tree + Page Preview; Sources → source tree + source Preview; Graph/Lint/Review/Research/Todos/Settings replace or overlay a pane). State that Chat stays mounted unless a mode needs the center (e.g. Graph). Collapse rules already in FR-5 should apply.

- **[medium]** Lint “done” is thinner than the Lint description (FR-21–22, UJ-4, SM-4) — Description: contradictions, expiry/staleness, duplicates, broken wikilinks, orphans, suggested gaps. Testable consequences: disputed Pages + broken wikilinks. Auto-fix: mechanical only, recorded in “Page history” — and there is **no FR for Page history** in the Workbench. SM-4 asks weekly Lint plus Graph Insights, not a complete Lint taxonomy. Epics will ship two issue types and skip staleness/orphans/duplicates. *Fix:* Table of v1 Lint kinds with detect vs auto-fix. If Page history is required for FR-22, add it (or record auto-fix in `log.md` only).

- **[medium]** Disputed state has no UI or data contract (FR-3, FR-21, Integrity NFR) — “Marks the Page disputed and remains inspectable” is the compile-once promise. No frontmatter field, no Preview banner, no Chat behavior (must Chat disclose dispute?), no how two claims are shown vs a flag. Lint lists them; that is not inspectable-at-the-claim. *Fix:* Specify `disputed: true` (or equivalent) + Preview callout + both claims remain in the Page body with `sources[]`. Chat must not pick a side without citing the dispute.

- **[medium]** Plaud connect vs upload is a UX-scope blocker even with a fallback (§8 Q1, FR-31, UJ-1) — FR-31 already says upload is the hard fallback. That prevents a ship blocker, not a UX blocker: UJ-1 still lists “Plaud connect, email, upload, or folder” as equivalent entry paths. First-run and Settings cannot be designed as four first-class Intakes. *Fix:* v1 UX: **upload/export of transcript+summary is the default path**; in-app OAuth is a stretch labeled as such. Keep FR-30 as the non-negotiable. Close Q1.

- **[low]** Context slider 4K–1M is a desktop number with no web ceiling (FR-54, FR-56, addendum) — 1M-token assembly plus “full content, no truncation” Deep Research (FR-67) on Workers/OpenNext will fail closed in ways the PRD treats as product success. Not a hosting spec, but it will be copied into epics as a must. *Fix:* Keep the slider as a UX control; add a constraint: v1 max is whatever the Agent host can honor; Settings must fail visibly when the selected window exceeds the runtime, not silently clamp to 4K.

- **[low]** Firecrawl appears in Settings with no behavior FR (FR-56, FR-25, FR-67, §14) — Optional Firecrawl key + base URL sits beside Tavily/SerpApi/SearXNG and bookmarklet Capture. Nothing says when Firecrawl runs vs Readability/Turndown. *Fix:* One sentence: Firecrawl is an optional **Capture/URL fetch** backend, not a Deep Research provider; off unless keyed. Or drop it from v1 Settings.

---

## Open questions — phase-blocker map

| # | Question | Blocks UX? | Blocks architecture? | Notes |
|---|----------|------------|----------------------|--------|
| 1 | Plaud OAuth vs upload | **Yes (scope)** | No (fallback exists) | Design one primary Intake; OAuth is stretch. |
| 2 | Meeting detection | No (UI can exist) | **Yes (Todos epic)** | FR-26 untestable until closed. |
| 3 | Deep Research default provider | No | No | Settings pick; default can be “none until keyed.” |
| 4 | MinerU default | No | No | Default **off**. |
| 5 | Preview editing | **Yes** | **Yes (editor stack)** | Close before Workbench wireframes. |
| 6 | Retention of rejected/completed Todos | No | Soft (schema) | Pick 90 days or “keep until delete.” |
| 7 | Multi-device | Soft | Soft | §11 already says desktop primary, mobile Chat+Todos. **Close Q7 as “§11 stands”** or stop contradicting it. |
| 8 | Email inbound vs mailbox | Yes if email in MVP | **Yes if email in MVP** | Cut from MVP or pick inbound. |
| 9 | Agent host | **Yes (API/MCP Settings)** | **Yes** | Hard gate for Chat, shell, extraction, skill. |

Q3, Q4, Q6 are not phase-blockers. Q7 is already answered in §11 and should not remain open.

---

## FR ID audit

| ID | Status |
|----|--------|
| FR-1–FR-42 | Present (not contiguous in document order) |
| **FR-43** | **Gap.** Dropped Chinese generation (memlog only). |
| FR-44–FR-74 | Present |
| **FR-75** | **Gap.** Unused; no memlog reason. |
| FR-76–FR-79 | Present |
| Duplicates | **None** |

Related overlap (not ID duplicates): FR-8 vs FR-58 (durable Conversations); FR-18 vs FR-51 (Search vs Phase 1); FR-36 vs FR-76 (enablement vs route table); FR-76 graph vs FR-45 (wikilink graph ≠ 4-signal — already footnoted, still easy for epics to merge).

---

## Contradiction audit (requested)

| Pair | Real contradiction? | What to do |
|------|---------------------|------------|
| English-only vs CJK tokenization | **Soft.** Retrieval of mixed Sources vs i18n non-goal, under-specified. | Lock mixed-Source retrieval or cut CJK from v1. |
| `/chat` 501 vs FR-77 | **Yes.** Implement vs stock skill must not call vs MCP may call. | One client contract for v1. |
| Vector off vs auto-embed | **No**, if gated. **Missing backfill** when toggling on; fork already hybrid. | Add enablement backfill; state default off overrides current Vectorize. |
| LLM-maintains vs Preview edit | **Yes**, while Q5 is open. | View-first + escape hatch. |

---

## Chat Agent / Skills — is “done” testable?

**No.** In-app Agent (FR-60–65) and external llm-wiki skill (FR-79) are collapsed under Chat. Shell and workspace paths depend on Q9. There are no fixture Skills, no golden tool traces, no Skill schema, no SM for Agent behavior. FR-79 “done” can be three markdown files and an install command that **never chats**. Treat Chat Agent as **not specified enough for epics** until the acceptance slice in finding 3 exists.

---

## What would make this PRD usable downstream

1. Close **Q9** and **Q5** (and Q2, Q8 or cut email).
2. Write testable Agent/Skill/shell acceptance; split FR-79 from in-app Chat.
3. Pick one `/chat` client story.
4. Add commons/MCP cut list and Todo record shape.
5. Document dropped FR-43 / unused FR-75.

Until then: UX can sketch the three-column chrome and Todo approve/reject; it cannot lock Preview, Settings → API, or post-Ingest HITL. Architecture cannot choose Agent hosting, extraction process, or MCP surface. Epics will either overbuild nashsu-desktop ghosts (shell, 1M context, CJK, Firecrawl, `:19828`) or underbuild the job loop (Plaud → wiki + Todos).
