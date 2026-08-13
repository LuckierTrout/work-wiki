# Adversarial review — Architecture Spine (work-wiki)

- **Artifact:** `ARCHITECTURE-SPINE.md` (status: draft, altitude: initiative, purpose: build-substrate)
- **Lens:** Two units one level down (epics/features) that obey every AD to the letter and still ship incompatibly
- **Focus:** sidecar vs kernel HTTP contracts; ingest Analysis artifact; dataVersion; Todo/Review persistence; `/api/v1` route ownership; Chat SSE event names; frontmatter schema
- **Spine edits:** none (read-only)

## Executive summary

**Verdict: not ready to finalize.** The spine locks *where code runs* (Workers vs local Rust sidecar) and *which libraries* (sigma, pdf-extract, Next 15.5.x). It does not lock the *bytes on the wire or in the store*. Two epics can satisfy AD-1 through AD-21 and still disagree on URL paths, JSON shapes, who implements which route, who owns Review/Todo/Conversation records, and what a Page’s YAML looks like.

That is the initiative-altitude failure mode: the layer below is features/epics, and those are exactly the seams left as “same route shapes,” “or equivalent,” and “typed frontmatter.”

**Readiness:** topology ADs are strong; interchange ADs are missing. Close the holes below with new or tightened ADs before treating this spine as a build substrate.

**Completeness (divergence-prevention bar): 52%.** Runtime split, SoR slogan, Page write funnel, serial ingest, yopedia IDs, extract crate set, device split, and defaults (Tavily / MinerU off / no Todo TTL / commons 404) are decided. Shared HTTP schema, Analysis document, dataVersion type/transport, Review/Todo/Conversation mutation ownership, Chat URL+SSE names, and v1 frontmatter field set are not.

---

## Method

For each hole: two units that do not violate any adopted AD, the clash, and the AD that would have forbidden the pair. Existing ADs are cited by id and heading. Line references are to `ARCHITECTURE-SPINE.md`.

---

## Incompatible pairs

### Pair 1 — Dual `/api/v1` surfaces with no owner per route

**Location:** AD-6 (L67–71); AD-2 (L47); AD-5 (L65); Capability map (L309–311); Structural seed (L258, L267)

**Unit S — Sidecar loopback API.** Implements the full nashsu/FR-76 table on `127.0.0.1:19828` (health, projects, files, reviews, search, chat, graph, rescan). Wiki I/O goes through “owner-auth kernel HTTP” (AD-2) by calling whatever kernel paths this epic invents (`POST /api/ingest`, `GET /api/wiki/...`) because the spine never lists kernel routes. Chat is served here (AD-5, AD-6). Bind is loopback only (AD-6).

**Unit K — Cloud façade.** Implements the *same* FR-76 table as Next.js routes under `src/app/api/v1/**` against `src/lib`. `POST /api/v1/chat` returns 503 `sidecar_required` (AD-6). Search/graph/reviews hit the kernel directly. Existing `/api/wiki/*` and `/api/query*` stay up because no AD retires them.

**How both obey every AD:** AD-6 requires “same route shapes,” not a single implementation. AD-2 requires sidecar not to treat disk as the wiki; it does not require sidecar to *proxy* kernel `/api/v1`. AD-1 forbids importing `src/lib` into the sidecar, so the sidecar *must* reimplement or proxy — and “reimplement against HTTP” is legal.

**Clash:**

- Two search/graph/files/reviews stacks. Field names drift (`snippet` vs `excerpt`, `path` vs `slug`, `id` vs `reviewId`).
- Sidecar Chat tools call loopback `/search` (Unit S). Workbench Search calls `/api/wiki/search` (Unit K, not even `/api/v1`). MCP curl calls loopback. Three contracts.
- If Unit S proxies to cloud `/api/v1` and Unit K’s cloud `/api/v1` is itself a façade that some stories think *is* the loopback contract, you get proxy-to-self, missing routes, or 503 on the wrong path.
- FR-76 `{id}` is `current` | UUID | filesystem path. Kernel today is tenant/`vault`/`yopedia` (AD-7). Unit S uses `path: "/Users/…/vault"`. Unit K uses vault UUID. Skill `{id}` works on one surface only.

**Hole:** AD-6 says dual surfaces, one contract, then specifies only Chat’s 503. It does not say which *process implements* which route.

**Guard (new AD-22 — `/api/v1` ownership matrix):** Publish a table: route → implementer (`kernel` | `sidecar` | `sidecar proxy-to-kernel` | `cloud 503`). Kernel is the only implementation of wiki read, search, graph, reviews, rescan, projects list, and file content. Sidecar implements Chat, extract, shell/Skills, loopback health, and MCP wrap; every other loopback `/api/v1` route is a reverse-proxy to the kernel with *identical* request/response bodies. Cloud `POST` chat (both `/api/v1/chat` and `/api/v1/projects/{id}/chat`) returns 503 `sidecar_required`. Pin FR-76 field names as the schema (or an appendix OpenAPI). `{id}` is the kernel Wiki UUID; `current` resolves to the operator’s active Wiki; filesystem path is a loopback-only alias that maps to that UUID — cloud never accepts a path. Retire or 404 `/api/query` and `/api/query/stream` as a second Chat.

**Consequence if unaddressed:** Sidecar and Workbench integrate only after an unplanned contract negotiation; MCP skill and UI disagree on the same Wiki.

---

### Pair 2 — Chat URL and SSE event names

**Location:** AD-5 (L65) `POST /api/v1/chat`; AD-6 (L71) `POST /api/v1/chat` 503; Capability map Chat (L308); PRD FR-76/77 (not copied into the spine)

**Unit W — Workbench Chat column.** Browser streams to `http://127.0.0.1:19828/api/v1/chat` (literal AD-5). SSE events invented as Vercel AI SDK / `text-delta` / `event: message` because the spine only says “SSE.”

**Unit A — Agent Skill + MCP chat.** Implements PRD `POST /api/v1/projects/{id}/chat` with events `meta`, incremental `agent`, terminal `done` | `cancelled` | `error`, and `done` carrying the full aggregate. Cloud 503 is only documented for `/api/v1/chat` (AD-6), so Unit K may implement `/api/v1/projects/{id}/chat` on the Worker as a “façade shape” — a second Agent, which AD-6 meant to forbid but did not name this path.

**How both obey every AD:** AD-5 names one path; AD-6 names the same path for 503. Neither names `projects/{id}/chat` nor event names. JSON-default vs stream is unset.

**Clash:** Workbench never hits the skill URL. Skill 404s on the Workbench URL. UI that renders deltas *and* the `done` aggregate shows every answer twice (PRD warned; spine did not lock it). A kernel epic can ship Worker-side `/projects/{id}/chat` without tripping AD-6’s 503.

**Guard (tighten AD-5 + AD-6):** The only Chat implementation is loopback `POST /api/v1/projects/{id}/chat`. Alias `POST /api/v1/chat` on loopback is 308/404 — pick one and kill the other. Cloud both paths return 503 `{ "error": "sidecar_required" }`. SSE event names are exactly `meta`, `agent`, `done`, `cancelled`, `error`. `done.data` is the complete aggregate; clients must not also commit deltas as a second message. Non-stream JSON is the default for skill/MCP; Workbench sends `stream: true` or `Accept: text/event-stream`.

**Consequence:** Chat column and MCP skill cannot share a client; “sidecar_required” is bypassed on the PRD path.

---

### Pair 3 — Ingest Analysis artifact shape and home

**Location:** AD-4 (L55–59); Consistency “Ingest jobs” (L205); ER `IngestJob ||--o| Analysis` (L295); no schema, key, or store

**Unit I1 — Analysis step.** Writes freeform markdown to R2 `raw/analysis/{sha256}.md` with headings “Entities / Concepts / Tensions / Recommended structure.” Job row stores the path. Retained for retry (convention table).

**Unit I2 — Generation step.** Expects KV JSON `ingest:{jobId}:analysis` with Zod `{ people, orgs, claims, pagePlan, reviewDrafts, todoDrafts, schemaVersion }`. Retry reads KV, misses R2, re-runs Analysis (pays twice) or fails closed.

**How both obey every AD:** AD-4 only requires two sequential LLM calls in the TS kernel after extracted text is in the store, and forbids a Rust compile. It does not type the artifact. Analysis is not a Page, so AD-3 does not apply. AD-2 “canonical bytes behind getStorage()” is satisfied by either R2 or KV.

**Clash:** Generation cannot consume Analysis. Activity can show “Analysis succeeded, Generation failed” with no reusable object. Two prompt authors embed two different “structured outputs” while AD-10 only protects SCHEMA.md *page* conventions, not this artifact.

**Guard (new AD-23 — Analysis artifact):** Analysis is a versioned JSON document in the kernel store (not a wiki Page, not sidecar disk). Key `{wikiId, sourceId, contentSha256, schemaVersion}`. Required fields at v1: `entities[]`, `concepts[]`, `arguments[]`, `existingPageLinks[]`, `contradictions[]`, `recommendedStructure`, `reviewDrafts[]`, `todoCandidates[]` (empty unless meeting rule). Generation reads *only* this object plus Source bytes. Generation-only retry must reuse a successful Analysis; it must not re-call Analysis. Schema lives in code (Zod) *and* a short appendix — not as a second copy of SCHEMA.md prose.

**Consequence:** The two-step pipeline exists in name only; retry cost and Page quality diverge by epic.

---

### Pair 4 — dataVersion type, transport, and watcher

**Location:** AD-11 (L97–101) — “bumps a store `dataVersion` (or equivalent)”

**Unit K — Kernel bump.** After `lifecycle.ts`, increments a global KV integer `yopedia:dataVersion`. Exposes it as `ETag` / `X-Data-Version` on `GET /api/wiki/[slug]`.

**Unit U — Workbench refresh.** Polls `GET /api/v1/projects/{id}` for `{ dataVersion: "<ISO-8601 timestamp>" }` (per-Wiki string). Compares with `===`. Alternatively polls sidecar `GET /api/v1/health` (Chat machine) which never sees the kernel bump.

**How both obey every AD:** AD-11’s “or equivalent” is an explicit escape hatch. It does not specify integer vs time vs hash, per-Wiki vs global, header vs JSON vs SSE, poll vs push, or whether Review/Todo/Conversation mutations bump it. Sidecar-originated Page writes still go through lifecycle (AD-3/AD-11).

**Clash:** Types never compare equal → UI stays stale (the thing AD-11 exists to prevent) *or* timestamp inequality → constant refetch and Graph re-layout fights AD-14’s position cache. Save-to-Wiki from Chat bumps kernel; Workbench watching sidecar health never refreshes Preview.

**Guard (tighten AD-11):** `dataVersion` is a per-Wiki monotonic `uint64` JSON number (not ISO time, not content hash, not “equivalent”). Stored in kernel KV. Exposed as `{ "dataVersion": <n> }` on `GET /api/v1/projects/{id}` (and optionally a tiny `GET /api/v1/projects/{id}/version`). Workbench polls the **kernel/cloud** endpoint under Clerk, not sidecar health. Bump on every successful `lifecycle.ts` Page/Source write or delete. Separate `auxVersion` (or the same counter — pick one in the AD) for Review/Todo/Conversation so those lists do not stay stale; do not leave that implicit. Graph position cache keys by node id and survives a version bump (already AD-14).

**Consequence:** FR-74 auto-refresh is unimplementable without a side meeting; two UIs will pick two signals.

---

### Pair 5 — Two owners of Review and Todo

**Location:** AD-3 (L49–53) Page/Source only; AD-20 (L151–155) retention only; Capability map (L315) “kernel persist + Workbench”; ER (L296–297); FR-76 review routes not assigned to a process

**Unit G — Ingest Generation.** Writes Review cards into Source-summary frontmatter (`reviews:`) and Todos into `wiki/todos.md` via `writeWikiPageWithSideEffects` (AD-3). Meeting rule honored. No TTL (AD-20).

**Unit R — Review API + Todo UI.** Stores `reviews.json` / `todos.json` in KV. Workbench and `PATCH /api/v1/projects/{id}/reviews/{id}` mutate KV. Not Pages, so AD-3 does not apply. No TTL (AD-20). Sidecar implements the FR-76 review routes on loopback (Pair 1) and, for `action: "create_page"`, POSTs markdown to kernel ingest or writes a stub via a new HTTP path.

**How both obey every AD:** AD-3’s Rule is Page create/update/delete only. AD-20 only forbids TTL. Capability map says “kernel persist” without a function name or schema. Sidecar disk is not used (AD-2).

**Clash:**

- Ingest fills YAML; UI reads KV → empty Review/Todo after a successful meeting Ingest (UJ-1 broken).
- Two mutation paths for `create_page`: sidecar-originated ingest vs kernel `lifecycle.ts` stub. One skips Analysis→Generation (AD-4 is about compile, not HITL create); the other skips the Review action log.
- Rejected Candidates in a Page body vs KV: delete-Source (FR-29 source-missing) updates one store.
- Chat Agent (sidecar) may also write `agent-workspace/todos.json` (AD-1 allows that directory) as a “working list” the Workbench never sees.

**Guard (new AD-24 — Review and Todo SoR):** `ReviewItem`, `TodoCandidate`, and `Todo` are kernel-store records (KV/R2 JSON), not frontmatter, not `wiki/todos.md`, not `agent-workspace/`. Ingest Generation may *enqueue* only through kernel functions (e.g. `enqueueReviewItems`, `enqueueTodoCandidates`) called from the ingest pipeline — never by writing YAML. Workbench and `/api/v1` review routes are façades over those functions. `create_page` and `deep_research` execute in the kernel (lifecycle / Deep Research queue), never in the sidecar. Pin v1 shapes:

- Review: `{ id, wikiId, sourceId, pageSlug?, status: unresolved|resolved, action?: create_page|deep_research|skip, queries: string[], createdAt }`
- TodoCandidate: `{ id, wikiId, sourceId, pageSlug?, title, rationale, due?: ISO-8601, decision?: approve|reject, decidedAt?, actor? }`
- Todo: `{ id, candidateId, status: open|done, title, due?, sourceId, pageSlug?, sourceMissing: boolean }`

Owner delete only (AD-20). Source delete sets `sourceMissing: true` on linked Todos; it does not delete them.

**Consequence:** Meeting Ingest “succeeds” with no Todos; Review tab and HTTP export disagree; HITL create_page forks the write path AD-3 was meant to close.

---

### Pair 6 — Frontmatter schema vs executable SCHEMA.md

**Location:** Consistency “Page files” (L200) “typed frontmatter (not all-strings)”; AD-10 (L91–95); AD-8/AD-21 private/commons; brownfield `SCHEMA.md` + `src/lib/frontmatter.ts`

**Unit P — PRD/UX ingest.** Writes YAML arrays and `[[wikilinks]]`:

```yaml
type: entity
title: Acme
sources:
  - raw/sources/meet-1.md
disputed: false
```

Treats “typed” as Zod objects. Cascade-delete matches `sources[]` paths (PRD FR-12).

**Unit B — AD-10 brownfield.** Loads current `SCHEMA.md` Page conventions into prompts (mandatory). That file requires `[Title](other-slug.md)` links, `sources` as a **JSON-encoded string** of `SourceEntry` objects, `visibility: public`, 90-day `expiry`, confidence badges. Parser (`Frontmatter`) is `string | string[] | number | boolean` and **throws on nested YAML / block arrays**. Graph detection uses `.md` suffix links (`SCHEMA.md` says so).

**How both obey every AD:** AD-10 forbids forking conventions *into code*; it does not freeze v1 field types. Spine “typed, not all-strings” contradicts the live parser and SCHEMA `sources` string without picking a winner. AD-21 404s commons *routes* but does not forbid `visibility: public` on every new Page.

**Clash:** Generation emits block-array `sources:` → parser throws → ingest fails or strips provenance. Or Generation emits JSON-string `sources` → cascade-delete looking for path strings misses. Wikilink graph (AD-14 / FR-76) sees no `[[wikilink]]` edges. Public `visibility` fights AD-8. `expiry` 90-day on Pages is not Todo TTL (AD-20) but two epics will “helpfully” apply a 90-day wipe to Reviews/Todos by analogy.

**Guard (new AD-25 — v1 frontmatter + wikilink syntax):** Lock the v1 field set and types in the spine (or a dated appendix the parser implements). Minimum:

| Field | Type | Notes |
| --- | --- | --- |
| `type` | string | closed set: entity / concept / source-summary / query / index / log / overview / … |
| `title` | string | |
| `sources` | `string[]` of raw Source paths/ids | not a JSON string; parser must accept inline YAML arrays |
| `disputed` | boolean | mechanical lint must not clear (PRD) |
| `created` / `updated` | ISO-8601 | |

Wikilinks in body: `[[Title]]` / `[[slug]]` (PRD/UX). SCHEMA.md Page conventions **must be edited to match this AD** before they are loaded into ingest prompts — AD-10 otherwise compiles the old commons wiki. Default `visibility` is private / omitted (not `public`). Commons-oriented fields (`authors` as public profiles, `visibility: public`) are not v1 write defaults. Page `expiry` is not Todo retention.

**Consequence:** Ingest, Preview, Graph, and cascade-delete each speak a different YAML dialect; SCHEMA.md remains a loaded footgun.

---

### Pair 7 — Sidecar extract → kernel ingest HTTP body

**Location:** AD-4 (L59) “POSTs into kernel ingest”; AD-5 (L65); AD-2 (L47) “`/api/v1` or ingest/lifecycle routes”; AD-9 SHA256 skip; today’s `POST /api/ingest` body (`url|content|sourceType` with enum `url,text,x-mention,image,pdf,youtube`)

**Unit E — Extract sidecar.** `POST /api/ingest` `{ content, title, sourceType: "pdf" }` matching the live route. SHA256 of **extracted text**. No `meeting`, no Plaud origin, no original-bytes hash. `docx`/`xlsx`/`pptx` coerced to `pdf` or `text` because they are not in the live enum.

**Unit Q — Ingest queue epic.** Expects `POST /api/v1/projects/{id}/sources` `{ path, sha256OriginalBytes, extractedText, origin, meeting }` then enqueues. SHA256 skip is on **original bytes** (FR-10). Meeting Todos only if `origin=plaud` or `meeting=true`.

**How both obey every AD:** “POSTs into kernel ingest” is untyped. Dual `/api/v1` does not include an Intake route. SHA256 is a “kernel concern” (AD-4) without saying *which bytes*.

**Clash:** Extract returns 200; nothing is queued. Skip cache never hits (text hash ≠ file hash) → duplicate compiles, or always hits → new PDFs skipped. Office files mis-typed. Meeting Ingest never sets the meeting flag → no Todo Candidates (UJ-1).

**Guard (new AD-26 — Intake HTTP contract):** One kernel Intake endpoint (name it: e.g. `POST /api/v1/projects/{id}/sources` *or* keep `POST /api/ingest` and freeze its body — not both). Owner-token auth. Body:

`{ wikiId, originalFilename, mime, sha256OriginalBytes, extractedText, origin: upload|folder|email|plaud|capture|api|mcp, meeting: boolean }`

SHA256 skip hashes **original bytes**. Sidecar extract must call this and only this. Plain text/markdown/URL may use the same body with `extractedText` = bytes. `meeting` is true iff Plaud-origin or owner-marked meeting (PRD). Do not add a second ingest URL in the sidecar.

**Consequence:** Binary Intake “works” in the sidecar and never becomes wiki Pages/Todos.

---

### Pair 8 — Two MCP servers, two write vocabularies

**Location:** Capability map (L311); Structural seed `src/mcp.ts` + `src/lib/mcp-http.ts` (L264–265); AD-1 sidecar never imports `src/lib`; AD-8 owner-auth MCP; AD-3 writes through lifecycle

**Unit M1 — Sidecar MCP.** Wraps loopback `/api/v1` (capability map). Tools: list projects, read files, search, graph, reviews, rescan, chat (FR-78).

**Unit M2 — Kernel MCP.** Ships existing stdio `src/mcp.ts` + `POST /api/mcp` with `create_page`, `update_page`, `ingest`, `dataview_query`, `update_metadata`. Writes already call `writeWikiPageWithSideEffects` (AD-3). Owner-auth (AD-8).

**How both obey every AD:** Both are described. AD-8 says write MCP is owner-auth and not in the stock skill — it does not say there is one tool list.

**Clash:** Cursor/Codex using stdio MCP creates Pages via `create_page`; Workbench/skill using loopback MCP cannot; ingest provenance and Review enqueue happen on one path only. Cloud `/api/mcp` vs sidecar MCP are different products with the same word “MCP.”

**Guard (tighten AD-8 + capability map):** One v1 tool list. Sidecar MCP wraps loopback `/api/v1` only. Cloud `/api/mcp` exposes the *same* tools, owner-auth, no commons publish. Kernel stdio either dispatches those same handlers or is documented out of v1. Page-mutating tools must call kernel lifecycle HTTP, not a parallel markdown writer (already AD-3) — including `create_page`.

**Consequence:** “MCP writes go through lifecycle” is true for one server and vacuously true for the other that cannot write.

---

### Pair 9 — Conversation system of record

**Location:** ER `Wiki ||--o{ Conversation` (L292); AD-1 Chat Agent on sidecar; AD-2 sidecar disk = extract temp + `agent-workspace/`; AD-17 Chat requires same-machine sidecar; FR-8 durable conversations (PRD, not an AD)

**Unit C1 — Sidecar Chat.** Persists nashsu-shaped `.llm-wiki/chats/{id}.json` under `agent-workspace/` (legal sidecar disk). Workbench Chat column reads loopback.

**Unit C2 — Workbench durability.** Persists Conversation JSON in kernel KV/R2 so Clerk reload restores the list (FR-8). Chat POST body includes `conversationId` the sidecar has never seen.

**How both obey every AD:** Conversations are not Pages (AD-3). AD-2 forbids a parallel *wiki* tree, not a parallel chat store. No AD names Conversation persistence.

**Clash:** Reload of the OpenNext Workbench shows empty Chat; sidecar has the history. Phone browse-only (AD-17) is fine; desktop HTTPS Workbench + loopback Chat is two databases. Save-to-Wiki (FR-15) needs a Conversation id the kernel does not have.

**Guard (new AD-27 — Conversation SoR):** Conversation and message records (including citations on the message) live in the kernel store. Sidecar may cache the in-flight turn only. Workbench lists/loads conversations via kernel HTTP (Clerk). Chat POST is `…/projects/{id}/chat` with `conversationId`; sidecar reads/writes messages through kernel HTTP, not `agent-workspace/`. `agent-workspace/` remains generated tool files only (AD-1).

**Consequence:** Chat history vanishes on Workbench refresh; Save-to-Wiki cannot link `wiki/queries/` back to a Conversation.

---

### Pair 10 — Auth headers and health on “the same shapes”

**Location:** AD-6 (L67–71); AD-7 (L73–77) `YOPEDIA_*`; AD-8 (L79–83); Consistency Auth (L203); PRD FR-36 `LLM_WIKI_API_TOKEN`, `X-LLM-Wiki-Token`, unauthenticated local, `GET /health` no auth

**Unit L — Loopback nashsu.** `X-LLM-Wiki-Token` / `?token=` / env `LLM_WIKI_API_TOKEN`. Health unauthenticated. `allowUnauthenticated` for local data routes.

**Unit C — Cloud AD-7/8.** `Authorization: Bearer` owner token; env `YOPEDIA_OWNER_TOKEN` / `YOPEDIA_SERVICE_TOKEN`. All HTTP reads require auth. Health behind Clerk.

**How both obey every AD:** “Same route shapes” is not “same headers.” AD-7 locks resource names, not the nashsu header alias. AD-8 vs FR-36 health-no-auth is unresolved; each unit picks the AD that names its surface.

**Clash:** Skill curl that works on :19828 gets 401 on cloud façade (or the reverse). Unauthenticated cloud `/api/v1/health` leaks `authConfigured` / version (AD-8). Service token vs owner token vs Clerk session for the same route is unspecified beyond task-consumer.

**Guard (tighten AD-6 + AD-8):** Auth matrix: (1) Browser → cloud: Clerk. (2) Sidecar → kernel: `Authorization: Bearer` owner token (`YOPEDIA_OWNER_TOKEN`). (3) Loopback clients: same bearer, plus `X-LLM-Wiki-Token` as an alias for that secret (not a second secret). (4) Task-consumer: `YOPEDIA_SERVICE_TOKEN` only on `/api/tasks/run`. (5) Loopback `GET /api/v1/health` may be unauthenticated; cloud `GET /api/v1/health` requires Clerk or owner token. Do not use `LLM_WIKI_API_TOKEN` as the canonical env name (AD-7); if kept, it is an alias for `YOPEDIA_OWNER_TOKEN`.

**Consequence:** Dual surfaces are not actually one contract; skill and Workbench cannot share auth docs.

---

### Pair 11 — Graph: 4-signal engine vs v1 wikilink graph

**Location:** AD-14 (L115–119) kernel owns graph API + 4-signal Relevance + Louvain; FR-76 `GET …/graph` is wikilink-only, not FR-45 (PRD, not in spine)

**Unit G1 — Workbench Graph.** Calls a kernel “graph API” returning communities, cohesion, 4-signal edge labels (AD-14).

**Unit G2 — MCP/skill graph.** `GET /api/v1/projects/{id}/graph` → `{ nodes: [{id,label,nodeType,path,linkCount}], edges: [{source,target,weight}] }` with `weight: 1.0`. Sidecar proxies to Unit G1’s endpoint and forwards 4-signal payloads the skill cannot parse — or re-walks markdown and disagrees with Louvain.

**How both obey every AD:** AD-14 names the renderer and that “kernel owns the graph API” without distinguishing the two PRD graphs.

**Guard (tighten AD-14):** Two kernel endpoints (or one with `engine=wikilink|relevance`). `/api/v1/projects/{id}/graph` is the wikilink graph (FR-76 shape). Workbench Graph uses a separate kernel route for 4-signal + Louvain + cached positions. Sidecar must not recompute Louvain.

**Consequence:** Skill graph and Workbench Graph tell different stories; proxying one as the other corrupts both clients.

---

### Pair 12 — Settings/keys: kernel store vs sidecar env

**Location:** AD-1 sidecar never imports `src/lib`; AD-5 Worker cannot reach localhost; AD-18 provider in Settings; Chat runs on sidecar

**Unit S — Settings epic.** LLM keys, models, Tavily key live in kernel KV (Workbench Settings, Clerk). Ingest (kernel) reads them.

**Unit H — Chat sidecar.** Reads `ANTHROPIC_API_KEY` from sidecar env / a local config file (cannot import kernel; Worker cannot push to 127.0.0.1).

**How both obey every AD:** No AD says Settings is the SoR for *Chat* credentials.

**Clash:** Ingest works; Chat 401s. Or Christian pastes keys twice. Deep Research (kernel, AD-18) and Chat web-tool disagree on the active provider.

**Guard (new AD-28 — Settings SoR):** Provider keys, models, timeouts, Deep Research provider, MinerU mode live only in the kernel Settings store. Sidecar fetches them over owner-auth HTTP at turn start (or Workbench supplies a short-lived session to loopback). Sidecar must not be the SoR for keys.

**Consequence:** The split runtime silently splits credentials.

---

## Findings (canonical fields)

No ranking implied by list order; pairs above are the same holes.

1. **Location:** AD-6 Dual `/api/v1` surfaces  
   **Trigger:** “Same route shapes” with no implementer-per-route table and no frozen request/response fields.  
   **Guard:** AD-22 ownership matrix + FR-76 schema + `{id}` mapping (Pair 1).  
   **Consequence:** Sidecar reimplements search/graph/reviews; Workbench keeps `/api/wiki/*`; MCP talks a third dialect.

2. **Location:** AD-5 vs AD-6 Chat path  
   **Trigger:** Spine Chat URL is `/api/v1/chat`; PRD/skill URL is `/api/v1/projects/{id}/chat`; 503 is only on the former.  
   **Guard:** One path; 503 both on cloud (Pair 2).  
   **Consequence:** Workbench and skill never hit the same endpoint; Worker can still host a second Agent.

3. **Location:** AD-5 “SSE”  
   **Trigger:** No event names, no `done`-aggregate rule, no stream vs JSON default.  
   **Guard:** Lock `meta` / `agent` / `done` / `cancelled` / `error` (Pair 2).  
   **Consequence:** Double-rendered answers or a Chat UI that cannot parse sidecar events.

4. **Location:** AD-4 + convention “Analysis artifact retained”  
   **Trigger:** Artifact has no schema, key, or store.  
   **Guard:** AD-23 versioned JSON in kernel store (Pair 3).  
   **Consequence:** Generation cannot retry from Analysis; two-step ingest forks.

5. **Location:** AD-11 dataVersion “or equivalent”  
   **Trigger:** Type, granularity, transport, and watcher host unspecified.  
   **Guard:** Per-Wiki uint64 JSON on kernel `GET …/projects/{id}`; Workbench polls kernel (Pair 4).  
   **Consequence:** Stale trees/Preview/Graph, or refetch storms vs position cache.

6. **Location:** AD-3 + AD-20 + capability “Review + Todos”  
   **Trigger:** Page funnel does not cover Review/Todo; retention is not a schema or writer.  
   **Guard:** AD-24 kernel records + enqueue functions + review action execution in kernel (Pair 5).  
   **Consequence:** Two owners of one entity; meeting Todos never appear in the UI.

7. **Location:** Consistency frontmatter + AD-10  
   **Trigger:** “Typed not all-strings” vs live SCHEMA.md JSON-string `sources` and `(slug.md)` links vs PRD `[[wikilink]]` / `sources: []`.  
   **Guard:** AD-25 field table; SCHEMA.md must match before prompt load (Pair 6).  
   **Consequence:** Parser throws, Graph empty, cascade-delete misses, public visibility defaults.

8. **Location:** AD-4/AD-5 “POST into kernel ingest”  
   **Trigger:** No path, body, hash basis, or meeting/origin fields.  
   **Guard:** AD-26 single Intake contract; SHA256 of original bytes (Pair 7).  
   **Consequence:** Extract succeeds, ingest never runs or skip-cache lies; no meeting Todos.

9. **Location:** Capability MCP + `src/mcp.ts`  
   **Trigger:** Two MCP servers with different tools both look AD-compliant.  
   **Guard:** One tool list; stdio = same handlers or out of v1 (Pair 8).  
   **Consequence:** Parallel Page writers labeled “MCP.”

10. **Location:** ER Conversation; AD-1/AD-2  
    **Trigger:** Chat history has two legal homes (`agent-workspace/` vs kernel).  
    **Guard:** AD-27 Conversation SoR in kernel (Pair 9).  
    **Consequence:** Empty Chat after Workbench reload; Save-to-Wiki cannot cite a conversation.

11. **Location:** AD-6 + AD-7 + AD-8  
    **Trigger:** Same shapes ≠ same auth headers/env names/health rules.  
    **Guard:** Auth matrix; `X-LLM-Wiki-Token` alias only; cloud health authenticated (Pair 10).  
    **Consequence:** Skill works on one surface only; possible unauthenticated cloud health.

12. **Location:** AD-14 graph API  
    **Trigger:** One “graph API” for both 4-signal Workbench Graph and FR-76 wikilink graph.  
    **Guard:** Two endpoints or `engine=` (Pair 11).  
    **Consequence:** Skill and Graph mode consume incompatible payloads.

13. **Location:** AD-1 + Settings + Chat on sidecar  
    **Trigger:** No Settings SoR for Chat/Deep Research keys across the HTTP boundary.  
    **Guard:** AD-28 kernel Settings; sidecar fetches (Pair 12).  
    **Consequence:** Ingest keyed, Chat not (or two key stores).

14. **Location:** AD-3 Rule vs Binds  
    **Trigger:** Binds list ingest/import/sidecar commits; Rule names only Page write/delete. Source create, Review `create_page`, Save-to-Wiki → auto-ingest are extra writers.  
    **Guard:** Extend AD-3 (or AD-26) to a single Source lifecycle function; HITL `create_page` must call Page lifecycle in-kernel.  
    **Consequence:** SHA256 index and embeddings skip on the unbound path (the `.yoyo/learnings.md` failure AD-3 claims to prevent).

15. **Location:** Structural seed vs AD-21  
    **Trigger:** Seed still lists `src/mcp.ts` public-read-era tools and commons modules “may remain if unreachable” while ingest still calls `syncCommonsForPage` (no-op per AD-21) — epics may keep calling real commons helpers from new code because “module files may remain.”  
    **Guard:** AD-21: new callers forbidden; lint/test that `syncCommonsForPage` is no-op *and* has no new non-no-op callees.  
    **Consequence:** A cleanup epic 404s routes while an ingest epic revives commons sync.

---

## What the spine already prevents (not holes)

These ADs actually stop a pair of epics from diverging on their stated axis: AD-1 isolate vs sidecar, AD-7 yopedia identifiers, AD-9 serial ingest vs overlapping Chat, AD-12 embeddings optional + model tag, AD-13 thin consumer, AD-15 Next/OpenNext couple, AD-16 crate set, AD-17 phone browse-only, AD-18 Tavily default, AD-19 MinerU off, AD-20 no Todo TTL, AD-21 commons 404. Do not spend Finalize cycles re-arguing those.

The failure is the *untyped seams between* those locked runtimes.

---

## Completeness

| Initiative dimension | Closed? | Notes |
| --- | --- | --- |
| Runtime topology | Yes | AD-1, 5, 13, 16, 17 |
| Page write funnel | Partial | AD-3 Pages only; Sources/Review/Todo/Conversation open |
| Wiki SoR | Partial | AD-2 slogan; chat/todos/reviews/settings not named |
| HTTP contract | No | AD-6 shapes without schema or ownership |
| Ingest pipeline | Partial | AD-4 two-step; Analysis bytes unspecified |
| UI refresh | No | AD-11 “or equivalent” |
| Frontmatter / SCHEMA.md | No | Typed vs executable brownfield clash |
| Auth across surfaces | Partial | Clerk vs bearer vs nashsu headers |
| Stack pins | Yes | Table + AD-14/15/16 |
| Defaults (DR, MinerU, TTL, commons) | Yes | AD-18–21 |

**Score: 52%** on “two epics cannot diverge.” Higher (~80%) if scored as “are the big hosting questions answered?” — that is the wrong bar for a build-substrate spine.

---

## Risk if finalized as-is

Parallel sidecar and kernel epics will each be “done” against the spine and fail integration on Chat URL/SSE, Intake POST, Review/Todo empty after ingest, stale Workbench, and YAML the parser rejects. That is not residual story-level detail; it is missing architecture. The cost is a contract rewrite mid-build, not a tidy follow-up story.

**Do not rewrite the spine in this review.** Apply new/tightened ADs (22–28 and the AD-3/5/6/8/11/14 patches) in a later distill pass.

---

## Suggested AD backlog (for the author, not applied here)

| Id | Action | Closes pairs |
| --- | --- | --- |
| AD-5, AD-6 | Chat path + cloud 503 both URLs + SSE names | 2, 3 |
| AD-6 + new AD-22 | Route ownership matrix + `{id}` + retire `/api/query*` | 1, 10 |
| AD-8 | Auth matrix; health; MCP one tool list | 8, 10 |
| AD-11 | uint64 per Wiki, kernel JSON, who polls | 4 |
| AD-14 | Wikilink vs relevance endpoints | 11 |
| AD-3 | Source lifecycle; HITL create_page in kernel | 5, 14 |
| AD-10 + new AD-25 | v1 frontmatter + wikilink; SCHEMA.md must match | 6 |
| new AD-23 | Analysis JSON schema + store key | 3 |
| new AD-24 | Review/Todo kernel records | 5 |
| new AD-26 | Intake POST body + sha256OriginalBytes | 7 |
| new AD-27 | Conversation SoR | 9 |
| new AD-28 | Settings SoR for sidecar | 12 |
| AD-21 | No new commons callers | 15 |
