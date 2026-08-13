---
name: review-rubric
type: document-review
status: complete
created: 2026-08-12
reviewed:
  - _bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md
against:
  - good-spine checklist (bmad-architecture reviewer-gate)
  - _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md
  - package.json / wrangler.jsonc / src/lib/lifecycle.ts / workers/task-consumer
  - npm registry + crates.io + Context7 (2026-08-12)
verdict: pass-with-fixes
completeness_pct: 78
lint_spine: clean (0 findings)
---

# Rubric review — Architecture Spine (initiative)

**Spine:** `architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md` (`status: draft`, altitude: initiative, purpose: build-substrate)  
**Parent spine:** none — inherited-AD checks skipped.  
**Mechanical lint:** `lint_spine.py` clean (no placeholders, monotonic AD-1…AD-21, every AD has Binds/Prevents/Rule, Stack rows pinned).  
**Deferred section:** absent (emptied after AD-14…AD-21).  

**Verdict: pass-with-fixes.** Do not treat as final until HIGH items are tightened or restored as Deferred/open questions. Do not rewrite the spine.

---

## 1. Executive summary

This is a real build-substrate, not a design essay. The hexagonal two-runtime split, `lifecycle.ts` write path, yopedia identifier lock, serial ingest, Vectorize-not-LanceDB, thin task-consumer, and the AD-14…AD-21 lock of the former Deferred list are the right invariants for feature/epic work.

It is **not pass**. Emptying Deferred was correct for the *named* former items (graph lib, Next/OpenNext bump, MinerU, Tavily, todo TTL, multi-device, remote Agent host, extract crates, cloud chat proxy). It is **not safe as “nothing left”**: several initiative-altitude divergences were never on that list and are now silent. The worst are (1) Chat-adjacent durable state across the HTTP boundary, (2) AD-6’s “one contract” Rule naming a chat path that is not FR-76, and (3) an operational envelope that is a one-line deploy note rather than a decided/deferred dimension.

Named tech is **verified-current**, not invented. Brownfield is **ratified** on the load-bearing identifiers (`lifecycle.ts`, `getStorage()`, `yopedia` bindings, thin `workers/task-consumer`). Intentional deltas (two-step ingest, sidecar Chat, unpdf out of the Worker, commons 404) are named as must-change, which is the right brownfield posture.

**Readiness:** apply HIGH autofixes (route shape, AD-2/AD-3 Rule text, restore a thin Deferred for remaining envelope) before Finalize. Discuss the Settings/LLM-key split and MCP catalog; do not invent new AD numbers in this review.

**Completeness: 78%.** Structure, paradigm, and the 21 ADs that exist are strong. The score is held down by silent dimensions (ops envelope, cross-runtime SoR, `/api/v1` contract), a capability map that omits several driving-spec areas, and a handful of Rules that do not fully prevent their stated divergence.

---

## 2. Checklist scorecard

| Checklist item | Result | Notes |
| --- | --- | --- |
| Fixes real divergence points for the level below (features/epics); misses none | **Partial** | Hits the big ones (runtime split, SoR for Pages/Sources, write path, ingest compile, yopedia IDs, serial queue, graph renderer, extract crate set). Misses Chat-adjacent SoR, `/api/v1` path table, MCP catalog, DR vs ingest queues, sidecar→kernel URL. |
| Every AD Rule is enforceable and actually prevents its stated divergence | **Partial** | AD-1, AD-7, AD-9, AD-13, AD-15, AD-17–AD-21 are tight. AD-3, AD-5/AD-6, AD-11, AD-14 have holes (below). |
| Nothing under Deferred could let two units diverge; empty Deferred is safe, not silent | **Unsafe** | Former Deferred list was locked into ADs (good). Emptying the *section* hid leftover envelope and shared-state items that were never on that list. |
| Named tech is verified-current (flag invented versions) | **Pass** | npm + crates.io + Context7 2026-08-12 match the Stack table. Next floor is the OpenNext peer, not a fake patch. |
| Ratifies rather than contradicts brownfield (Next/OpenNext/R2/yopedia IDs/`lifecycle.ts`) | **Pass with notes** | Ratifies the identifiers and consumer. Names must-change leftovers (`ingest.ts` single-shot, `mcp-http.ts` public reads, unpdf). Does not contradict. Fork leftover `YOPEDIA_URL=https://yopedia.yolog.dev` is unmentioned. |
| Covers driving spec capabilities (PRD work-wiki v1) | **Partial** | Runtime/ingest/chat-host/graph/auth/commons map. Conversations, Settings/LLM, ZIP, retrieval ownership, email/Plaud adapters, EPUB/MOBI, FR-76 table are thin or absent. |
| Parent spine inherited ADs | **N/A** | No parent. |
| Every dimension this altitude owns is decided, deferred, or an open question | **Fail (ops envelope)** | Deploy is one sentence. Sidecar lifecycle, secrets, kernel base URL, local queue vs Queues, consumer origin, staging, leftover cron — silent, and Deferred is gone. |

---

## 3. Issue list

### CRITICAL

None. The paradigm is feasible. Cloudflare isolate vs local sidecar is the correct reading of FR-60 / PRD §11. No AD contradicts another AD. No invented versions. No missing essential spine sections (paradigm, ADs, conventions, stack, seed, capability map). Inherited-AD checks skipped.

---

### HIGH

#### H1 — Empty Deferred is not safe: Chat-adjacent state has no SoR

**Checklist:** divergence for the level below; empty Deferred; dimension silent.  
**Where:** AD-2 (L43–47); ERD (L288–298) has `Wiki ||--o{ Conversation` but AD-2 Binds omit Conversations and Settings; capability map (L301–319) has no Conversations/Settings/retrieval-assembly row; no Deferred section.

AD-2 correctly forbids a second markdown vault and limits sidecar disk to extract temp + `agent-workspace/`. Chat, Skills, and shell then live on the sidecar (AD-1, AD-5). Independently built units can still choose incompatibly:

| State | Epic A | Epic B |
| --- | --- | --- |
| Conversations (FR-13/58; ZIP must include chats, FR-37) | Sidecar `~/.llm-wiki/chats/` (nashsu shape) | Kernel `getStorage()` + HTTP |
| Settings / API keys / dual Chat vs Ingest models (FR-8, FR-35) | Sidecar `.env` / local file | Kernel KV (`YOPEDIA_CONFIG`) |
| Retrieval Phases 3–4 (FR-54/55) | Rust Agent assembles context from a local index | Kernel search API; sidecar only streams |
| Project `SKILL.md` | Sidecar reads a local checkout | Sidecar GET via kernel file API (FR-36 whitelist) |

AD-2’s “sidecar wiki reads/writes go through owner-auth kernel HTTP” is close but **not enforceable** for this set: a builder can claim chats/settings are not “wiki.” The ERD implies kernel Conversations; the Rule never says so.

**Recommendation:** **discuss** then **autofix** AD-2 (do not add a new ID unless a second decision is truly distinct): Binds include Conversations, Settings (Chat+Ingest model/key/endpoint), Review, Todos; Rule: those records persist behind `getStorage()`; sidecar loads Chat-relevant settings and conversation history over owner-auth HTTP at turn start; sidecar disk remains extract temp + `agent-workspace/` only. Pick one owner for FR-54/55 assembly (kernel vs sidecar) in the same Rule or a convention row. Stack: note kernel Ingest may keep Vercel AI SDK while sidecar Chat uses a Rust client — both honor the same Settings records. Add Ollama + Custom to the Stack seed (`ollama-ai-provider-v2` is already in `package.json`).

#### H2 — AD-6 Rule does not prevent façade drift: it names the wrong chat path

**Checklist:** Rule does not prevent its stated divergence; spec coverage.  
**Where:** AD-5 Rule (L65) `POST /api/v1/chat`; AD-6 Rule (L71) same; AD-6 Prevents (L70) “cloud façade drifting from loopback route shapes”; Binds FR-36, FR-76–78 (L69).

PRD FR-76/FR-77 lock `POST /api/v1/projects/{id}/chat` with `{id}` = `current` | UUID | URL-encoded path. JSON default; SSE when `stream` or `Accept: text/event-stream`. Stock skill and health/projects/files/search/graph/rescan are the rest of that table.

Two feature units that obey the spine letter-for-letter:

- **API epic:** implements FR-76 `.../projects/{id}/chat`.
- **Chat epic:** implements AD-5 `POST /api/v1/chat` SSE-only.

That *is* the divergence AD-6 claims to prevent. “Same route shapes” is not enforceable without pointing at the FR-76 table (or listing the paths). Cloud 503 `sidecar_required` is a good lock and should stay; it must apply to the **FR-76 path**, not a flattened alias.

Related enforceability gap (same AD): loopback auth in FR-36 is `LLM_WIKI_API_TOKEN` + Bearer / `X-LLM-Wiki-Token` / `?token=`, plus unauthenticated `GET /health`. Conventions (L203) only mention Clerk + bearer owner token + `YOPEDIA_SERVICE_TOKEN`. AD-7 correctly freezes Cloudflare/`YOPEDIA_*` names. Unresolved, one epic will rename the skill token to `YOPEDIA_API_TOKEN` (breaks nashsu skill) or the other will put `LLM_WIKI_API_TOKEN` on the Worker (conflicts with AD-7’s “don’t invent parallel env families” spirit).

**Recommendation:** **autofix** AD-5/AD-6 Rule: loopback and cloud façade share the **FR-76 path table**; Chat is `POST /api/v1/projects/{id}/chat`; cloud that path returns 503 `sidecar_required` (not a second Agent, no remote proxy). Point at FR-36/FR-76 as the normative contract; do not restated every field. **discuss** one sentence: loopback skill token remains `LLM_WIKI_API_TOKEN` (FR-36); kernel/consumer secrets remain `YOPEDIA_*` (AD-7). `{id}` resolution is part of the contract.

#### H3 — Operational/environmental envelope is silent (and Deferred cannot catch it)

**Checklist:** every dimension decided, deferred, or open; especially deployment / infra / operations.  
**Where:** Structural Seed (L286) one sentence: “Production deploy is manual `wrangler` … Local: `next dev` + filesystem storage + sidecar on 19828.” Stack names R2/KV/Vectorize/Queues (L247–250). No Deferred. No Open Questions.

Initiative altitude owns this envelope. What two units can still pick incompatibly:

| Gap | Evidence | Divergence |
| --- | --- | --- |
| Sidecar → kernel base URL | Diagram (L273–284) shows SC → CF only; local sentence does not say sidecar talks to `next dev` vs production Worker | Hardcoded origin vs Settings vs env |
| How the sidecar is built/run/updated | Seed lists `sidecar/` (L267); no launch contract | `cargo run` vs prebuilt binary vs `pnpm sidecar` vs launchd |
| Local ingest durability | AD-9 (L89) “Queue is durable (Cloudflare Queues).” Code: `enqueueTask` no-ops off-Workers; `enqueueOrInline` runs ingest in-process (`src/lib/ingest-async.ts`, `src/lib/tasks.ts`) | Epic A requires `wrangler dev` queues; epic B assumes inline `next dev` |
| Consumer origin | `workers/task-consumer/wrangler.jsonc` `YOPEDIA_URL`: `https://yopedia.yolog.dev` (upstream, not this fork) | Deploy consumer as-is vs retarget this Worker |
| Secrets | Conventions name bindings, not where Clerk/LLM/Tavily/owner-token live or how Settings mints the loopback token | |
| Staging | Unmentioned | One prod, or a second Worker/account |
| Leftover cron | Consumer `crons: ["0 6 * * *"]` + `AUTONOMOUS_MAINTENANCE` | Keep dry-run vs treat as v1 non-goal |

**Recommendation:** **autofix** restore a short **Deferred** (or Open Questions) section — emptying is only safe when the leftovers are listed with “why it can wait.” Minimum rows: sidecar packaging/launch; staging; autonomous-maintenance cron. **discuss** then lock: sidecar kernel URL (prod Worker when the browser is on Clerk HTTPS; local Next when `next dev`); local `next dev` uses `enqueueOrInline` (ratify code); consumer `YOPEDIA_URL` is this fork’s origin, not `yopedia.yolog.dev`.

#### H4 — AD-3 title/Binds include Sources; Rule only names Page functions

**Checklist:** Rule does not prevent stated divergence.  
**Where:** AD-3 (L49–53) title “Single Page/Source write path”; Binds “Ingest, Save to Wiki, lint fix, import, delete, MCP writes, sidecar-originated commits”; Rule: `writeWikiPageWithSideEffects` / `deleteWikiPage` only.

Brownfield Source writes are `saveRawSource` / `saveRawSourceFor` in `src/lib/raw.ts` (re-exported from `wiki.ts`), called from `ingest.ts`. Two ingest epics can add a second raw writer and skip SHA256 / immutability. FR-12 cascade delete is also more than `deleteWikiPage`; a Sources epic can implement cascade in the route while a Wiki epic puts it inside lifecycle.

**Recommendation:** **autofix** the Rule (keep AD-3): Pages go through `writeWikiPageWithSideEffects` / `deleteWikiPage`; Source bytes go through `saveRawSource` / `saveRawSourceFor` only (immutable; no parallel raw writer). Source delete runs FR-12 cascade inside that lifecycle, not in the route. Cancelled ingest must not call the Page writer (PRD §9). Do not invent a new AD id.

#### H5 — MCP / fork tool catalog vs nashsu `/api/v1` wrap is undecided

**Checklist:** divergence; spec coverage; brownfield leftover.  
**Where:** Capability map (L311) “sidecar wraps loopback; cloud `/api/mcp` owner-auth”; Structural Seed (L264–265) still lists `src/mcp.ts` stdio and `src/lib/mcp-http.ts`; AD-8 (L83) stock skill read-only except rescan; AD-21 (L161) publish-to-commons not in the v1 tool list.

Three surfaces exist in the fork today: Next stdio (`src/mcp.ts`, ~49 tools including commons/talk/vaults), HTTP `/api/mcp` (same handlers; comment still says unauthenticated commons reads), and the PRD sidecar wrapping loopback `/api/v1`. AD-8/AD-21 cut public reads and publish-to-commons. They do not say whether v1 MCP **is** the FR-76/FR-78 nashsu-shaped wrap or a trimmed fork catalog. Two units: keep `handlePublishToCommons` / talk tools behind owner-auth vs expose only health/projects/files/search/graph/rescan/chat.

**Recommendation:** **discuss** then **autofix** AD-8 (or AD-6): v1 MCP tools are the FR-78 wrap of the FR-76 surface; commons/talk/vault/discussion tools are absent (same posture as AD-21). `src/mcp.ts` may remain as the handler module if it is trimmed to that set — not a third product surface.

---

### MEDIUM

#### M1 — AD-11 “or equivalent” weakens FR-74

**Where:** AD-11 Rule (L101).  
Two units can ship ETag polling, a custom event, or websocket and still claim compliance. FR-74 names `dataVersion`.  
**Recommendation:** **autofix** — drop “or equivalent”; bump a store `dataVersion` after every successful `lifecycle.ts` write/delete. Workbench refetches on change.

#### M2 — AD-14 “kernel owns the graph API” collides with FR-76 wikilink graph

**Where:** AD-14 Rule (L119); capability map Graph row (L313).  
AD-14 successfully prevents vis-network/cytoscape (sigma 3.0.3 + graphology 0.26.0 + FA2 0.10.1 + louvain 2.0.2 — **verified npm latest 2026-08-12**). It also says the kernel owns “the graph API” and 4-signal Relevance. PRD FR-76: `GET /api/v1/projects/{id}/graph` is **wikilink-only**, explicitly not the Workbench 4-signal engine. Workbench Graph epic vs API/MCP epic will disagree on edge payload.  
**Recommendation:** **autofix** AD-14: Workbench Graph = sigma/graphology + 4-signal + Louvain + position cache (FR-19/45–47). Loopback/cloud `GET .../graph` = wikilink graph (FR-76). Do not serve FR-45 edges on the skill route.

#### M3 — AD-16 extract set omits EPUB/MOBI; URL-PDF vs “kernel-direct URL” is ambiguous

**Where:** AD-16 (L127–131); AD-5 (L65) “Plain text/markdown/URL Intake may go kernel-direct.”  
FR-71/§6.1 require EPUB/MOBI. Two extract epics can put epub.js in the Worker vs an unspecified sidecar crate. AD-5 kernel-direct URL plus AD-16 “no unpdf in the Worker” leave URL-to-PDF ingest unspecified; brownfield `src/lib/fetch.ts` still uses `unpdf`.  
**Recommendation:** **discuss** EPUB/MOBI crate (or Deferred: “sidecar, crate named before the extract epic”). **autofix** AD-5: HTML/text URL → kernel readability; PDF/office URL or upload → sidecar extract then kernel ingest. FR-72 preview/player lives in Workbench + kernel blob store, not in the crate set (AD-16 currently Binds FR-72).

#### M4 — Capability map misses driving-spec areas that are architectural

**Where:** L301–319.  
Present: Workbench, Intake (lumped), two-step Ingest, Chat, dual `/api/v1`, MCP, Search, Graph, Lint, Review+Todos, Deep Research, Skills/shell, task queue, Commons.  
Absent (and able to fork placement): Conversations; Settings / dual LLM; retrieval pipeline ownership; ZIP export/import + `.obsidian/` (FR-37); Scenario Templates / per-Wiki `schema.md` (FR-34/38); Capture + optional Firecrawl; inbound email; Plaud upload P0 / OAuth P1.  
**Recommendation:** **autofix** add rows (Lives in / Governed by). Not every FR needs an AD; the map is the auditor’s checklist. Email/Plaud/Firecrawl/ZIP can be rows that all “POST into the same kernel ingest queue / `getStorage()`” without new ADs.

#### M5 — AD-10 repo `SCHEMA.md` vs per-Wiki `schema.md`

**Where:** AD-10 (L91–95); conventions (L200).  
`src/lib/schema.ts` loads repo `SCHEMA.md` via `getStorage()` (ratifies brownfield). PRD FR-34/38/36: per-Wiki `schema.md` + `purpose.md` seeded by Scenario Templates; file API whitelist uses those names. Two units: prompts keep reading repo `SCHEMA.md` while templates write dead `schema.md` files.  
**Recommendation:** **discuss** then tighten AD-10: engine/repo `SCHEMA.md` (if still required) vs per-Wiki `schema.md`/`purpose.md` as ingest/chat/lint prompt inputs. Templates write the Wiki files.

#### M6 — Deep Research concurrency and Agent web-search unplaced

**Where:** AD-9 (L85–89) serializes Ingest only; AD-18 (L139–143) default provider only; capability map DR row (L316).  
FR-70: DR is a **separate** durable queue, max 3 concurrent, not the serial Ingest slot. FR-61: Agent mid-turn web search ≠ confirmed Deep Research. Two units can enqueue DR onto `yopedia-tasks` (stalls ingest) or give the sidecar a second Tavily key store.  
**Recommendation:** **autofix** AD-9 or a convention: DR queue is independent, max 3; Agent web-search tool uses the **same** active provider Settings as AD-18; confirmed DR stays kernel + Research Panel.

#### M7 — Meeting-Todo gate and talk leftover

**Where:** ERD `TodoCandidate : meeting-only` (L296); AD-4/AD-20 do not mention FR-26; AD-21 cuts commons not talk.  
PRD already locked “Plaud-origin or marked meeting” — inherit-silently is allowed — but two ingest units can still extract todos from every office file, and `lifecycle.ts` still calls talk/discussion helpers.  
**Recommendation:** **autofix** one sentence on AD-4 or AD-20: Todo Candidates only when Plaud-origin or Source marked meeting. **autofix** AD-21 (or a convention): talk/discussion routes and MCP tools are 404/absent like commons (PRD §5).

#### M8 — Brownfield leftovers the spine should name so epics do not extend them

| Leftover | Code | Spine |
| --- | --- | --- |
| Kernel Chat | `src/lib/query.ts` | AD-1/AD-5 replace it; seed does not name the file to stop extending |
| PDF in Worker | `unpdf` in `src/lib/fetch.ts` | AD-16 forbids as v1 path (good) |
| Public GET | `src/middleware.ts` “reads stay public” | AD-8 requires auth on HTTP reads (good; this is the cut) |
| PostHog | `src/components/Analytics.tsx` | Silent vs FR-1 / NFR Privacy |
| Consumer URL | `YOPEDIA_URL=https://yopedia.yolog.dev` | See H3 |

**Recommendation:** **autofix** seed: `src/lib/query.ts` is the kernel Chat path to retire, not extend. **discuss** PostHog (strip vs off-by-default). Consumer URL under H3.

#### M9 — Vector-on backfill (FR-42) not in AD-12

**Where:** AD-12 (L103–107).  
Enable vector → enqueue embed of current Pages; must not be Generation; off does not delete content.  
**Recommendation:** **autofix** one sentence on AD-12.

---

### LOW

#### L1 — Next 15.5 patch floor vs latest

AD-15 (L125) `>=15.5.21 <16` matches OpenNext 1.20.2 peers (Context7 + `npm view @opennextjs/cloudflare@1.20.2 peerDependencies`). npm `next@15.5` latest patch is **15.5.23**. The floor is correct, not invented.  
**Recommendation:** **ignore** (or optional Stack note “peer floor; 15.5.23 current patch”). Do not bump the Rule to 15.5.23 unless you want a moving target.

#### L2 — Stack omits packages already in the repo

`package.json` has `ollama-ai-provider-v2`, `mermaid`, `unpdf`, `posthog-js`. Seed says code owns versions once they move. Ollama belongs with FR-35 (see H1). `unpdf` is the path AD-16 retires. Mermaid is UX/FR-73, not an initiative fork if they keep the existing dep.  
**Recommendation:** **ignore** mermaid; handle Ollama under H1; unpdf stays out of the v1 extract path.

#### L3 — PPTX “ZIP+XML” names no crate

AD-16 (L131). Low: one sidecar crate (`zip` vs `async_zip`) is unlikely to fork two epics if extract is one unit.  
**Recommendation:** **ignore** until the extract epic, or name the crate in Stack seed.

#### L4 — Memlog still says some items are Deferred

`.memlog.md` L19, L28, L30 predate the lock. Spine is the contract; memlog is append-only.  
**Recommendation:** **ignore** for spine text. Optional memlog `event` that those lines are superseded (parent Finalize, not this review).

#### L5 — `silo.test.ts` comment claims `DEFAULT_TENANT` is `work-wiki`

Code is `yopedia` (`src/lib/links.ts`). Spine AD-7 is correct. Not a spine defect.  
**Recommendation:** **ignore** here.

#### L6 — AD-6 cloud 503 vs FR-76 “work-wiki implements this”

Addendum already matches AD-6. PRD FR-76 table does not mention cloud 503. Spine should keep 503 (H2). PRD patch is outside this review.  
**Recommendation:** **ignore** on the spine if H2 cites FR-76 **path** and keeps 503 **behavior** for the cloud façade.

---

## 4. AD Rule enforceability (all 21)

| AD | Prevents stated divergence? | Enforceable? | Action |
| --- | --- | --- | --- |
| AD-1 Two-runtime | Yes | Yes — no shell/extract/agent in isolate or browser | Keep |
| AD-2 Kernel SoR | Pages/Sources yes; chats/settings no | Partial | H1 |
| AD-3 Write path | Pages yes; Sources/cascade/cancel no | Partial | H4 |
| AD-4 Ingest in kernel | Yes (no second compile LLM) | Yes; add meeting-Todo sentence (M7) | M7 |
| AD-5 Chat/extract attach | Topology yes; path wrong | Partial | H2, M3 |
| AD-6 Dual `/api/v1` | Bind yes; “same shapes” no | Partial | H2 |
| AD-7 yopedia IDs | Yes | Yes — matches `links.ts` / wrangler / AGENTS.md | Keep |
| AD-8 Private auth | Yes (cuts mcp-http leftover) | Yes; MCP catalog still open (H5) | H5 |
| AD-9 Serial ingest | Yes | Yes; local inline + DR queue unspecified | H3, M6 |
| AD-10 SCHEMA.md | Yes vs forked prompt copy | Yes; which file (repo vs per-Wiki) open | M5 |
| AD-11 dataVersion | Weakened by “or equivalent” | Partial | M1 |
| AD-12 Embeddings | Yes (off default; Vectorize not LanceDB) | Yes; backfill missing | M9 |
| AD-13 Thin consumer | Yes | Yes — matches `workers/task-consumer/index.ts` 2xx/4xx/5xx | Keep |
| AD-14 Graph viz | Renderer yes; “graph API” overloaded | Partial | M2 |
| AD-15 Next+OpenNext | Yes | Yes — versions verified | Keep |
| AD-16 Extract crates | Office/PDF yes; EPUB/MOBI no | Partial | M3 |
| AD-17 Device split | Yes | Yes | Keep |
| AD-18 Tavily default | Yes | Yes | Keep |
| AD-19 MinerU off | Yes | Yes | Keep |
| AD-20 Todo no TTL | Yes | Yes | Keep |
| AD-21 Commons 404 | Yes for listed routes | Yes; talk leftover (M7) | M7 |

---

## 5. Named tech verification (2026-08-12)

| Spine pin | Check | Result |
| --- | --- | --- |
| next repo 15.5.18 | `package.json` | Match |
| next ≥15.5.21 <16 | OpenNext 1.20.2 peer; npm `next@15.5` includes 15.5.21…15.5.23 | Real peer floor; not invented |
| @opennextjs/cloudflare 1.20.2 | npm latest + Context7 `/opennextjs/opennextjs-cloudflare` | Current |
| react 19.1.0, clerk ^7.4.2, ai ^6.0.146, wrangler ^4.92.0, zod ^4.4.2, vitest ^3, tailwindcss ^4, typescript ^5 | `package.json` | Ratified seed |
| sigma 3.0.3, graphology 0.26.0, graphology-layout-forceatlas2 0.10.1, graphology-communities-louvain 2.0.2 | `npm view` | Current |
| pdf-extract 0.12.0, docx-rs 0.4.22, calamine 0.36.1 | crates.io `max_version` | Current |
| @mozilla/readability ^0.6.0 | npm + `package.json` | Match |
| Node ≥20.9.0 | Next 15 engines | Plausible |
| compatibility_date 2025-01-01 | `wrangler.jsonc` | Ratified brownfield |
| R2 `yopedia-raw` / KV `YOPEDIA_CONFIG` / Vectorize `yopedia-embeddings` / queues `yopedia-tasks` | `wrangler.jsonc` (dual `YOPEDIA_VECTORIZE` + `VECTORIZE` bindings) | Ratified; conventions already say do not rename |

No invented versions. **ignore** L1.

---

## 6. Brownfield ratification

**Ratified (do not reopen):**

- `DEFAULT_TENANT` / `BASE_AGENT_OWNER` = `yopedia` (AD-7).
- Sole Page mutation `writeWikiPageWithSideEffects` / `deleteWikiPage` in `src/lib/lifecycle.ts` (AD-3).
- `getStorage()` R2 vs filesystem (AD-2).
- Task consumer: no `src/lib` import; POST `/api/tasks/run`; 2xx ack / 4xx poison / 5xx retry (AD-13).
- Wrangler resource names and `compatibility_date`.
- `SCHEMA.md` loaded at runtime via `src/lib/schema.ts` (AD-10).
- Manual `wrangler` deploy; fork GitHub deploy workflows inert (seed L286).

**Named must-change (correct, not contradiction):**

- `ingest.ts` single-shot → two-step (AD-4).
- Chat not `src/lib/query.ts` in the Worker (AD-1/AD-5).
- `unpdf` not the v1 extract path (AD-16).
- `mcp-http.ts` unauthenticated commons reads (AD-8).
- `syncCommonsForPage` no-op; commons routes 404 (AD-21).

**Unnamed leftovers** (M8, H3): `query.ts` as the file to stop extending; `YOPEDIA_URL` upstream; PostHog; talk helpers; middleware public GET is already in AD-8’s Prevents.

---

## 7. Completeness (78%)

| Required element | Weight | Score | Why |
| --- | --- | --- | --- |
| Named paradigm mapped to trees | 10 | 10 | Hexagonal two-runtime; HTTP anti-corruption; mermaid dependency rule |
| ADs cover feature-level forks | 20 | 14 | Strong on runtime/write/ingest/ids/graph/extract; weak on Chat SoR, API table, MCP catalog |
| Each AD Binds/Prevents/Rule actually closes the Prevents | 15 | 11 | 5 ADs need Rule text (H2, H4, M1, M2, M3) |
| Deferred/open vs silent dimensions | 15 | 8 | Former list locked; envelope + shared state now silent |
| Stack verified-current | 10 | 10 | npm/crates/Context7 match |
| Brownfield ratification | 10 | 8 | Identifiers + consumer yes; fork URL / query.ts unnamed |
| PRD capability map | 10 | 7 | Core areas yes; Conversations/Settings/ZIP/Intake adapters/FR-76 no |
| Operational envelope | 10 | 5 | One deploy sentence; sidecar/secrets/URL/local queue missing |
| **Total** | **100** | **78** | |

78% = structure and locked ADs are shippable as a draft substrate; HIGH holes would let two feature teams diverge. Not 90%+ until H1–H5 land or are explicitly Deferred.

---

## 8. Risk if Finalize as-is

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Chat epic persists conversations/keys on sidecar disk; Ingest epic reads kernel Settings; ZIP export misses chats | High | High — split brain, FR-37 fail | H1 |
| Loopback skill vs Workbench Chat disagree on `/api/v1/.../chat` | High | High — FR-79 / FR-77 tests fail | H2 |
| Sidecar cannot find the kernel; consumer still posts to `yopedia.yolog.dev` | Medium | High — ingest/Chat writes go nowhere or to upstream | H3 |
| Second raw/markdown writer reintroduces `.yoyo/learnings.md` drift | Medium | High | H4 (AD-3 is the right AD; Rule is incomplete) |
| MCP epic ships 49 fork tools; skill epic ships FR-78 wrap | Medium | Medium | H5 |
| DR jobs block serial ingest | Medium | Medium | M6 |
| EPUB/MOBI slips into the Worker | Low | Medium | M3 |

**Implementation concern:** the spine is safe to *start* Workbench-shell and yopedia-identifier work. It is not safe to split Chat, API/MCP, and Ingest across parallel units until H1–H3 are closed.

---

## 9. Suggested disposition (no new AD ids invented here)

| ID | Action | Disposition |
| --- | --- | --- |
| H1 | Tighten AD-2 Binds/Rule (Conversations, Settings, retrieval owner) | discuss → autofix |
| H2 | AD-5/AD-6 cite FR-76 path table; keep cloud 503; split `LLM_WIKI_API_TOKEN` vs `YOPEDIA_*` | autofix + discuss token names |
| H3 | Restore Deferred for packaging/staging/cron; lock kernel URL + local `enqueueOrInline` + consumer origin | autofix + discuss |
| H4 | AD-3 Rule: Source writers + cascade + cancel | autofix |
| H5 | AD-8: MCP = FR-78 wrap, not fork catalog | discuss → autofix |
| M1 | Drop “or equivalent” on AD-11 | autofix |
| M2 | Split Workbench graph vs FR-76 wikilink graph in AD-14 | autofix |
| M3 | EPUB/MOBI + URL-PDF vs kernel-direct | discuss / Deferred + autofix AD-5 |
| M4 | Capability-map rows | autofix |
| M5 | AD-10 repo vs per-Wiki schema | discuss |
| M6 | DR queue + shared provider for Agent web search | autofix |
| M7 | Meeting-Todo sentence; talk 404 | autofix |
| M8 | Name `query.ts` to retire; PostHog | autofix / discuss |
| M9 | Vector backfill sentence on AD-12 | autofix |
| L1–L6 | Versions, memlog, mermaid, PPTX crate | ignore |

Do not rewrite the spine. Do not renumber ADs. Do not re-open AD-7, AD-13, AD-15, AD-17–AD-20, or the two-runtime paradigm.
