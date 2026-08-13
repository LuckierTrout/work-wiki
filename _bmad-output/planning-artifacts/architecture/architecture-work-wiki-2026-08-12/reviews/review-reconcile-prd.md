---
name: review-reconcile-prd
type: document-review
status: complete
created: 2026-08-12
reviewed:
  - _bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md
against:
  - _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md
  - _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/addendum.md
focus:
  - PRD §8 Open Questions (post-patch)
  - PRD §9 Assumptions Index
  - PRD §11 Platform
  - FR-1, FR-9, FR-36, FR-60, FR-67, FR-71
  - Todos (FR-26–FR-29)
verdict: not-ready-to-finalize
completeness_pct: 74
---

# Document review — Architecture Spine vs PRD

**Spine:** `architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md` (`status: draft`, binds `prd-work-wiki-2026-08-12`)  
**PRD:** `prd-work-wiki-2026-08-12/prd.md` (`status: final`) + `addendum.md`  
**Scope:** Reconcile only. Neither source file was edited. PRD §8 was already patched to the architecture locks (Tavily, MinerU off, todo no-TTL, phone browse-only, local sidecar). This review flags **remaining** drift: quiet requirements the AD structure dropped, and contradictions.

---

## 1. Executive summary

The spine is a coherent two-runtime substrate (hexagonal kernel + local sidecar) and **matches the five §8 locks**. FR-1 / FR-9 / FR-60 / FR-67 / AD-17–21 are aligned with the patched PRD and addendum.

It is **not ready to finalize**. The AD set placed *runtime split* and *the closed open-questions*, then stopped. Several PRD contracts that only make sense *because* of that split were never given an AD, a capability-map row, or a convention:

1. The loopback `/api/v1` **route shape** in AD-5/AD-6 does not match FR-76/FR-77.
2. Kernel-as-SoR (AD-2) was not extended to **Conversations, Settings/API keys, dual Chat vs Ingest models, retrieval assembly, or project Skills** — all of which Chat now owns on the sidecar.
3. Extract (AD-16) dropped **EPUB/MOBI**; ingest dropped the **meeting-Todo rule**, **cascade delete**, and **Deep Research’s own 3-slot queue**.

**Readiness:** do not Finalize until HIGH items are ADs or explicitly deferred with a pointer to the FR. §8 itself does not need another patch for those five locks.

**Completeness: 74%** — spine structure and §8 locks are done; architecturally load-bearing FRs are only partly placed (see §6).

---

## 2. What already matches (do not re-open)

| Lock / FR | PRD | Spine | Status |
| --- | --- | --- | --- |
| Deep Research default | §8.1, FR-67, §9: Tavily; SerpApi/SearXNG selectable; one active | AD-18 | Match |
| MinerU default | §8.2, FR-71, §9: off; Local API if enabled | AD-19 | Match |
| Todo retention | §8.3, FR-28, §9: persist until owner delete; no TTL | AD-20 | Match |
| Multi-device | §8.4, §11, §9: tree/Preview/search any Clerk browser; Chat/extract/loopback/shell/Skills same-machine; phone browse-only | AD-17 | Match |
| Agent host | §8 intro, FR-60, FR-36, §11, addendum: local sidecar; no remote Agent host | AD-1, AD-5, AD-6 | Match |
| Cloud `POST /chat` | addendum: 503 `sidecar_required` | AD-6 | Match **addendum ↔ spine**. FR-76 table still omits the 503 (see H2). |
| Private wiki + commons cut | FR-1 | AD-8, AD-21 | Match |
| Two-step ingest in kernel | FR-9, FR-10, FR-39 | AD-4, AD-9 | Match |
| Vector off; Vectorize not LanceDB | FR-52, addendum, §9 | AD-12 | Match |
| dataVersion | FR-74 | AD-11 | Match |
| yopedia runtime IDs | addendum Mechanism | AD-7 | Match |
| Serial ingest; Chat may overlap; ≤3 retries | FR-39, §9 | AD-9 | Match |
| Graph viz stack | addendum Graph visualization | AD-14 (sigma + graphology + FA2 + Louvain) | Match **library**. API semantics still conflict (H3). |
| Web clips in kernel | FR-71, addendum | AD-16 (`@mozilla/readability` + Turndown) | Match |
| English-only | §5, §9, FR-8 | Consistency Conventions | Match |

---

## 3. Issue list

### CRITICAL

None that make the paradigm infeasible. The two-runtime split is the right reading of FR-60 / §11. Remaining issues are contract and SoR holes, not a wrong topology.

---

### HIGH

#### H1 — Chat route shape contradicts FR-76 / FR-77

**Spine:** AD-5 (`ARCHITECTURE-SPINE.md` ~L65) and AD-6 (~L71) use `POST /api/v1/chat` (SSE). Capability map: “Loopback `/api/v1`”.  
**PRD:** FR-76 table and FR-77 specify `POST /api/v1/projects/{id}/chat`. `{id}` is `current` | UUID | URL-encoded path (FR-76 consequences). Stock skill and `reconcile-skill.md` use the project-scoped path.  
**Why it matters:** Dual-surface “one contract” (AD-6) will ship a flattened path the skill and FR-76 tests will miss. Sidecar and cloud façade will diverge on day one.

**Fix:** Change AD-5/AD-6 (and the structural mermaid if it cites the path) to `POST /api/v1/projects/{id}/chat`. Bind FR-76 as the route table. State that `{id}` resolution is part of the contract, not Workbench-only.

---

#### H2 — Cloud 503 is locked in AD-6/addendum but not in FR-76

**Spine:** AD-6 — cloud `POST /api/v1/chat` returns **503** `sidecar_required`; not a second Agent; no remote proxy.  
**Addendum:** “Cloud `POST /chat` returns 503 `sidecar_required`.”  
**PRD FR-76:** “**work-wiki implements this.**” No cloud vs loopback split. FR-36 says the cloud façade has the **same route shapes**.

**Fix (spine):** Keep 503. Add one sentence: loopback implements FR-77 (JSON default, SSE on `stream` / `Accept: text/event-stream`, terminal `done` is the aggregate); cloud implements the **same path** and returns 503 `sidecar_required` with a body the Workbench can show.  
**Fix (PRD, if a follow-on patch is allowed):** One consequence under FR-76/FR-77: cloud façade 503; loopback implements. Do not weaken AD-6.

---

#### H3 — AD-14 conflates Workbench 4-signal graph with the HTTP wikilink graph

**Spine:** AD-14 — “Kernel owns the **graph API**, 4-signal Relevance, and Louvain partition.”  
**PRD FR-76:** `GET /api/v1/projects/{id}/graph` is the **wikilink** graph (deduped undirected, `weight` 1.0). “It is **not** the Workbench 4-signal Relevance engine (FR-45).”  
**PRD FR-45 / FR-19:** Workbench Graph uses 4-signal + Louvain.

**Fix:** Split in AD-14 (or a new AD): (a) Workbench Graph API — 4-signal, Louvain, cohesion, positions; (b) loopback/cloud `GET .../graph` — wikilink-only for the skill. Do not serve FR-45 edges on the skill route.

---

#### H4 — FR-36 / FR-76 contract dropped; token name clashes with AD-7

AD-6 binds FR-36, FR-76–78 as “same route shapes” and never imports the contract:

| PRD (FR-36 / FR-76) | Spine |
| --- | --- |
| `GET /api/v1/health` unauthenticated; fields `ok/status/version/enabled/authRequired/authConfigured/allowUnauthenticated/tokenSource` | Absent |
| Token: Bearer / `X-LLM-Wiki-Token` / `?token=`; env **`LLM_WIKI_API_TOKEN`** overrides UI | Auth convention: Clerk + bearer owner token + `YOPEDIA_SERVICE_TOKEN` only |
| Enable in Settings; off → 503 `"disabled"`; in-flight 64 → 503 `"busy"` | Absent |
| File whitelist, 2 MB / 415 binary, body 1 MiB, tree 10000, `topK` 50, graph limit 1000, 120 rps | Absent |
| `{id}` = `current` \| UUID \| path; names resolved client-side | Absent |
| Mutations on this API: Review patch/resolve + `sources/rescan` only (skill) | AD-8: stock skill read-only except rescan (partial) |

AD-7 forbids renaming `YOPEDIA_*`. FR-36 requires `LLM_WIKI_API_TOKEN` for skill parity. Unresolved, implementers will pick one and break the other.

**Fix:** New AD (or extend AD-6 + AD-7): loopback auth **is** the FR-36 surface (`LLM_WIKI_API_TOKEN`, three send methods, health payload). Kernel/task-consumer keep `YOPEDIA_SERVICE_TOKEN`. Cloud façade uses Clerk session **or** owner bearer — document which token the façade accepts. Point at FR-36/FR-76 as the normative table; do not restated it in full.

---

#### H5 — Sidecar Chat vs kernel SoR: Settings, Conversations, retrieval, Skills have no home

AD-2: canonical bytes behind `getStorage()`; sidecar disk is extract temp + `agent-workspace/` only. Chat, Skills, and shell live on the sidecar (AD-1, AD-5). The PRD then requires state that must cross that HTTP boundary and is **not** placed:

| Requirement | PRD | Spine gap |
| --- | --- | --- |
| Durable Settings (provider, **API key**, model, context size, language) | FR-8, §9 | No AD. Chat needs keys on the sidecar; Ingest needs keys in the kernel. |
| **Dual Chat vs Ingest models**; providers OpenAI / Anthropic / Google / **Ollama / Custom**; provider-specific streaming | FR-35, FR-56, §9 | Stack table lists `@ai-sdk/{anthropic,openai,google}` only. No Ollama/Custom. No split of which runtime reads which model. |
| Conversation record shape; citations on the message; `.llm-wiki/chats/{id}.json` on export | FR-58, FR-13, addendum | ER: `Wiki ||--o{ Conversation`. No rule that chats persist in the kernel store (not sidecar disk) and that the Agent loads/saves them over owner-auth HTTP. |
| Retrieval pipeline: tokenized (+ CJK bigrams, title +10) → optional vector → 2-hop graph decay → **60/20/5/15** budget → numbered full-content assembly | FR-51–FR-55, FR-56 | Capability map: Search in `src/lib` (AD-12). Chat Agent is sidecar. Who runs Phases 3–4 (budget + assembly) is unspecified. |
| Project + user `SKILL.md` scan; `/skill` per Conversation | FR-62, addendum | Skills scan is sidecar (AD-1). Project Skills live in the Wiki (kernel store). No fetch/scan path. |
| Context slider 4K–1M; history depth N=10 inside 20% slice | FR-54, FR-59 | Absent |
| Chat SSE contract (`meta` / `agent` / `done` aggregate; `mode: deep` ≠ Research Panel) | FR-77 | AD-5 says SSE only |

Independently built Chat and Ingest epics will each grow a settings store and a retrieval stack.

**Fix:** New AD, “Chat-adjacent state stays in the kernel store”:

- Settings (including Chat and Ingest model/key/endpoint, vector, DR provider, MinerU, Firecrawl, timeout, history N) persist in kernel; sidecar **reads** Chat-relevant settings over owner-auth HTTP at turn start (or via a settings endpoint). Do not keep a second secrets file on sidecar disk as SoR.
- Conversations persist in the kernel (export layout `.llm-wiki/chats/{id}.json`). Sidecar is the Agent runtime, not the chat archive.
- Retrieval: kernel owns Phases 1–2 (and graph expansion data); sidecar Agent owns tool choice + FR-54/55 assembly **or** kernel owns assembly and sidecar only streams — pick one and bind FR-51–55.
- Project Skills: sidecar lists/reads `SKILL.md` via kernel file API (same whitelist as FR-36), not by assuming a local vault.
- Stack: add Ollama + Custom OpenAI-compatible as Chat/Ingest providers (FR-35). Kernel Ingest may keep Vercel AI SDK; sidecar Chat may use a Rust client — both must honor the same Settings records.

---

#### H6 — AD-16 dropped EPUB/MOBI (and over-binds FR-72)

**PRD FR-32 / FR-71 / §6.1:** EPUB/MOBI required (metadata, chapters, body). Images native preview; video/audio built-in player (FR-72).  
**Spine AD-16:** pdf-extract, docx-rs, calamine, PPTX ZIP+XML, web clips in kernel. **No EPUB/MOBI crate or “unsupported” rule.** Binds FR-72 but does not place preview/player (Workbench `src/app`, media under `wiki/media/` / `raw/assets/`).

**Fix:** Extend AD-16 with an EPUB/MOBI extractor (name the crate or “sidecar, crate TBD before extract epic”). Place FR-72 on Workbench + kernel blob store, not on the extract crate set.

---

#### H7 — Ingest/Todo/DR rules that must live in the kernel were not ADs

These are product rules whose **wrong runtime** would fork the wiki:

| Requirement | PRD | Spine |
| --- | --- | --- |
| Todo extract **iff** Plaud-origin **or** user-marked `"meeting"`; no classifier; office default off | FR-26, §8 intro, §9, memlog constraint | ER only: `Source \|\|--o{ TodoCandidate : meeting-only`. No AD. AD-4 binds FR-9/10/39, not FR-26. |
| Cascade delete: three-method match; trim shared entities; purge index; strip dead wikilinks; Todos **source-missing** not silent delete | FR-12, FR-29, §9 | AD-3: `deleteWikiPage` only. No cascade / Todo rule. |
| Cancel must not commit Page writes | FR-7, §9 | Absent |
| Deep Research **own** queue, **3 concurrent**, independent of serial Ingest; durable | FR-70, FR-24 | AD-9 serializes Ingest only. Capability map: “Deep Research \| kernel + Settings”. No 3-slot queue. A DR epic could reuse `yopedia-tasks` and stall Ingest or violate FR-70. |
| Analysis artifact retained for Generation retry | FR-9, conventions table | Conventions mention it; not an AD-4 rule with storage location. |
| Auto-ingest on every Intake arrival (upload, folder, email inbound address, Plaud, API/MCP) | FR-41, §9 | Capability map “Intake” only. No email/Plaud adapter row. |

**Fix:**

- Extend **AD-4** (or AD-20): meeting-Todo extraction is kernel Generation; gate is Plaud-origin or marked meeting (FR-26).
- Extend **AD-3**: Source delete runs FR-12 cascade inside `lifecycle.ts`; Todos follow FR-29 (source-missing). Cancelled jobs do not call write.
- New AD or extend **AD-9**: Deep Research is a **separate** durable queue, max 3 concurrent, not the serial Ingest slot (FR-70). Confirm-before-run stays AD-18/FR-24.
- Capability map: inbound email Worker/route; Plaud upload P0 vs OAuth P1 as Intake adapters into the same queue.

---

### MEDIUM

#### M1 — Repo `SCHEMA.md` (AD-10) vs per-Wiki `schema.md` (FR-34 / FR-38)

**Spine AD-10:** Page conventions from repo `SCHEMA.md` via `src/lib/schema.ts`; editing it changes production without deploy.  
**PRD:** Schema is per-Wiki `schema.md` seeded by Scenario Templates (Research / Reading / Personal Growth / Business / General); Christian edits it; next Ingest/Chat/Lint honor it (FR-34, FR-38). File API whitelist is `purpose.md`, `schema.md` (FR-36).

Fork today loads **repo** `SCHEMA.md`. Product v1 needs **per-Wiki** `schema.md` + `purpose.md`. Unresolved, templates become dead files while prompts still read the repo spec.

**Fix:** AD-10 distinguishes (1) product/repo `SCHEMA.md` as engine conventions if still required, vs (2) per-Wiki `schema.md` + `purpose.md` as the FR-34/38/55 prompt inputs. Ingest/Chat/Lint load the Wiki’s files. Templates write those files at Wiki create.

---

#### M2 — Vector-on backfill (FR-42) not in AD-12

Turning vector **on** enqueues embed of current Pages (Activity). Off does not delete content. AD-12: optional, model-tagged, ingest succeeds with embeddings off. Missing the backfill job and that it must not block the serial Ingest LLM slot (or must be specified if it does).

**Fix:** One sentence on AD-12: enable → enqueue backfill; model tag mismatch = miss; backfill is not Generation.

---

#### M3 — Two web-search paths unplaced

FR-61: Agent **web search** mid-turn (not Deep Research). FR-24/FR-67/FR-70: confirmed Deep Research in kernel, Tavily default, full-content no app truncation, Research Panel. AD-18 covers DR provider only. Agent web search could silently call Tavily from the sidecar with a different key store (see H5).

**Fix:** Capability map: Agent web-search tool = sidecar, uses the **same** active DR provider settings (read from kernel). Confirmed DR = kernel job + Research Panel. Do not implement two provider configs.

---

#### M4 — Firecrawl, ZIP export, inbound email, Plaud P0/P1 have no adapter row

| Item | PRD | Spine |
| --- | --- | --- |
| Optional Firecrawl key + custom Base URL | FR-56, §14 | Absent (Capture/web clips are kernel readability) |
| ZIP export/import, deterministic `index.md`, `.obsidian/` | FR-37, SM-5 | Absent |
| Email = inbound address, not a mailbox | FR-41, §8, §14 | Intake named, no adapter |
| Plaud upload P0, OAuth P1 | FR-31, §8 | Absent |

Not all need ADs. They need **capability-map rows** so epics do not invent a second Intake pipeline.

**Fix:** Add rows: Capture (bookmarklet/URL + optional Firecrawl) → kernel; Export → kernel `lifecycle`/storage; Email inbound → Worker/route → same ingest queue; Plaud → upload now, OAuth later, same queue.

---

#### M5 — MCP dual hosting under-specified

**Spine:** Sidecar wraps loopback MCP; cloud `/api/mcp` owner-auth (AD-8, capability map).  
**PRD FR-78:** MCP calls the **same** API surface; Settings copies **local** client config.

Risk: cloud MCP exposes tools that need the sidecar (chat, shell) or a second tool list.

**Fix:** v1 copyable config points at **loopback** MCP (sidecar). Cloud `/api/mcp` is owner-auth, same **read/rescan/review** tools as FR-76; chat/shell tools are loopback-only (or 503 `sidecar_required`). Stock skill remains HTTP+JSON, not MCP.

---

#### M6 — Branded `/chat` skill vs stock 501

AD-8: stock llm-wiki skill read-only except rescan. FR-79 / addendum: stock must not `POST /chat` (desktop 501); work-wiki implements FR-77; **branded** skill may document `/chat`. Spine never mentions the branded pack.

**Fix:** One line under AD-6 or AD-8: stock skill must not call `/chat`; branded pack documents loopback FR-77 (and cloud 503).

---

#### M7 — `GET /graph` vs Workbench already in H3; FR-45 weights missing from spine

4-signal weights (direct ×3, source overlap ×4, Adamic-Adar ×1.5, type ×1.0) are the v1 contract (FR-45, §9). AD-14 says “4-signal Relevance” without weights. Changing weights would be an undocumented epic tweak.

**Fix:** Point AD-14 at FR-45 table as normative; do not copy the table unless the spine wants a freeze.

---

### LOW

#### L1 — Structural mermaid uses flattened Chat path

Second mermaid (`ARCHITECTURE-SPINE.md` ~L275): `B -->|127.0.0.1:19828 Chat extract MCP| SC`. Fine at this altitude. If H1 is fixed, do not add a wrong `/api/v1/chat` label here.

#### L2 — AD-5 “plain text/markdown/URL Intake may go kernel-direct”

Compatible with FR-41 if kernel-direct still **queues** two-step ingest. Spell “still FR-41 / AD-4” so an Intake epic does not bypass the queue for URLs.

#### L3 — Stack `compatibility_date` 2025-01-01 vs “today” 2026-08-12

Brownfield pin, not a PRD conflict. Note it is a Worker compat date, not a doc typo.

#### L4 — PRD has no §13

PRD jumps 12 → 14. Not spine drift. Ignore here.

#### L5 — Architecture `.memlog.md` still has pre-lock sentences

e.g. “Multi-device Chat is deferred (PRD open)”; “dedicated remote Agent host … Deferred.” Spine AD-1/AD-17 supersede. Out of review scope (memlog was not a source file to edit). Do not let those lines override the spine.

#### L6 — UX-only FRs correctly omitted

FR-4–FR-6, FR-44, FR-66, FR-73, Preview view-first, min widths, 12-color palette pointer to DESIGN.md. Correct for a build-substrate spine. Cohesion 0.15 is in AD-14; good.

---

## 4. Named-section checklist

### §8 Open Questions (post-patch)

All five closed items match AD-17–AD-20 + AD-1/5/6. **No remaining §8 drift.** Remaining drift is outside §8 (FR-76 table vs 503; route path; SoR; extract; ingest rules).

### §9 Assumptions Index

| Assumption | Spine |
| --- | --- |
| Next/Cloudflare web, not Tauri | AD-1 |
| Clerk | AD-8 |
| Per-owner isolation | AD-8 (light) |
| Server-durable Conversations/Settings/Review | **Dropped** (H5) |
| Multiple named Wikis + templates | **Dropped** (M1) |
| SHA256; serial ingest; 3 retries; Chat overlap | AD-4, AD-9 |
| English only | Conventions |
| Arrival auto-queue; no OS folder-watch | Partial (capability map) |
| Rust local sidecar | AD-1 |
| Meeting todos Plaud-or-marked | **Dropped** (H7) |
| Plaud upload P0 / OAuth P1 | **Dropped** (M4) |
| View-first Preview | UX; OK omit |
| Branded skill documents `/chat` | **Dropped** (M6) |
| Relevance weighted sum; FR-45 weights | Partial (H3, M7) |
| Cancelled ingest no commit | **Dropped** (H7) |
| Cascade delete + source-missing Todos | **Dropped** (H7) |
| Tavily / MinerU / no TTL / phone browse-only | Match |
| Dual Chat/Ingest models; Ollama/Custom | **Dropped** (H5) |
| Vectorize; vector off | AD-12 |
| 60/20/5/15; history N=10 | **Dropped** (H5) |
| AnyTXT = Source full-text | Unplaced; follows Search-in-kernel |
| No blanket shell allow | AD-1 “approved shell” only; FR-65 workspace vs external not spelled |
| Skill scan on Settings/load | Unplaced (H5) |
| Export markdown/Obsidian | **Dropped** (M4) |

### §11 Platform

Aligned with AD-1, AD-5, AD-17. PWA-not-required correctly omitted.

### FR-1

AD-8 + AD-21 cover private-by-default, commons 404, `syncCommonsForPage` no-op, stock skill read-only except rescan, write MCP owner-auth. Good.

### FR-9

AD-4 places two-step compile in the kernel, sidecar extract-then-POST, SHA256 + serial as kernel concerns, today’s single-shot `ingest.ts` must change. Review items, ingest-time search queries, and Todo Candidates as Generation outputs are not in AD-4 (H7).

### FR-36

Bound by AD-1, AD-6, AD-17 (loopback `127.0.0.1:19828`, not `0.0.0.0`, cloud façade, same-machine). **Contract body dropped** (H4). Path flattened (H1).

### FR-60

AD-1, AD-5, AD-6, AD-17 match: backend Agent, not browser TS loop, not Worker isolate, local sidecar, cloud façade ≠ loopback. Fixture Skill golden turn is a test concern; OK omit.

### FR-67

AD-18 matches default Tavily, selectable SerpApi/SearXNG, one active, unused keys stored. Missing: independent keys, SerpApi engines, SearXNG URL+categories, no app truncation, no silent provider fallback (FR-67 consequences). Point at FR-67 rather than duplicating.

### FR-71

Crates match addendum for PDF/DOCX/XLSX/PPTX/web. **EPUB/MOBI missing** (H6). MinerU off / Local API first matches (AD-19). Structured-Markdown behavior (headings/lists/tables/slides/sheets) is implied by crate choice, not stated — one sentence would lock the FR-71 table.

### Todos (FR-26–FR-29)

| FR | Spine |
| --- | --- |
| FR-26 meeting gate | **Dropped** (H7) |
| FR-27 approve/reject, no auto-promote | Unplaced (product; kernel persist implied by AD-20) |
| FR-28 due/status; **no TTL** | AD-20 match |
| FR-29 links; source-missing on Source delete | **Dropped** (H7) |

ER `TodoCandidate : meeting-only` is not a substitute for FR-26’s Plaud-or-marked rule.

---

## 5. Recommendations (priority order)

1. **H1 + H2 + H4 — Dual `/api/v1` is FR-76.** Project-scoped paths; loopback implements chat; cloud 503; FR-36 token/health/limits; `LLM_WIKI_API_TOKEN` vs `YOPEDIA_*` coexistence.
2. **H3 — Two graphs.** Skill `GET .../graph` ≠ Workbench 4-signal.
3. **H5 — Chat-adjacent SoR.** Settings, Conversations, retrieval assembly, Skills, dual models/Ollama — kernel store, sidecar reads.
4. **H6 — EPUB/MOBI** on the extract crate set; move FR-72 off AD-16.
5. **H7 — Kernel ingest rules:** FR-26 meeting gate, FR-12/FR-29 delete, FR-7 cancel, FR-70 DR queue, FR-41 Intake adapters.
6. **M1 — Per-Wiki `schema.md` vs repo `SCHEMA.md`.**
7. **M2–M6** as capability-map / one-line AD extensions.

Do not re-open §8 locks. Do not expand the spine into a restated PRD; bind FRs by number.

---

## 6. Completeness score

| Bucket | Weight | Score | Notes |
| --- | --- | --- | --- |
| Spine structure (paradigm, ADs, stack, seed, map) | 20% | 95% | Draft spine is well-formed; map incomplete |
| §8 / §11 / FR-1 / FR-9 / FR-60 / FR-67 locks | 25% | 96% | Patched PRD and ADs agree |
| FR-36 / FR-76–79 API contract | 20% | 45% | Bind listed; path wrong; table not imported |
| Chat-adjacent SoR (FR-8, 35, 51–58, 62) | 15% | 35% | AD-2 not applied across the HTTP boundary |
| Ingest/extract/Todos (FR-12, 26–29, 32, 41, 70, 71) | 15% | 60% | Two-step + crates + no-TTL yes; EPUB, meeting gate, cascade, DR queue no |
| Traceability (FR binds, no contradiction) | 5% | 50% | H1/H3 are direct contradictions |

**Weighted total: 74%.**

Threshold for Finalize at this altitude: HIGH contradictions closed (H1–H3 at minimum) and H4–H7 either ADs or explicit “deferred to epic, FR-n is normative.”

---

## 7. Risk if shipped as-is

| Risk | From | Impact |
| --- | --- | --- |
| Skill/API tests fail; two chat routes | H1 | P1 API epic vs Workbench Chat epic |
| Cloud implements a Worker Agent “to match FR-76” | H2 | Violates AD-1/AD-6; isolate cannot shell |
| Skill graph returns 4-signal edges | H3 | Breaks llm-wiki skill; Workbench vs HTTP drift |
| Sidecar file of API keys; Chat model ≠ Settings | H5 | Dual SoR; FR-8 fails; keys on disk |
| Ingest and Chat retrieval stacks diverge | H5 | SM-2 (cited Chat) untestable |
| EPUB/MOBI silent-fail or a second TS parser in the Worker | H6 | FR-32/71; AD-16 intent |
| Todos from every PDF; cascade misses shared entities | H7 | SM-C2; data loss vs FR-12/29 |
| DR jobs block serial Ingest or run unbounded | H7 | FR-70 vs AD-9 |
| Templates never reach prompts | M1 | FR-38 dead; AD-10 only repo SCHEMA.md |

**Implementation concern:** the spine is strong on *where processes run* and weak on *which HTTP contract and which store* the sidecar uses. That is the gap Finalize must close.

---

## 8. Goal alignment

Requirements still support the PRD vision (compiled wiki, nashsu Workbench, meeting Todos, private v1). No AD fights UJ-1–UJ-6 except where a missing AD lets an epic recreate a local vault (Conversations/Settings/Skills on sidecar disk) — which **would** fight AD-2 and UJ-2/UJ-6.

Success metrics SM-1 (Todo HITL) and SM-3 (no silent queue loss) need H7. SM-2 (cited Chat) needs H5. SM-5 (ZIP) needs M4. SM-4 (Graph Insights) is covered by AD-14 once H3 splits the HTTP graph.

---

*Reviewer: bmm-document-reviewer. Sources read in full: ARCHITECTURE-SPINE.md, prd.md, addendum.md. No edits to those files.*
