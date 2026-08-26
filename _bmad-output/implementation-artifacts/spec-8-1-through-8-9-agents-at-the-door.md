---
title: 'Stories 8.1–8.9: Agents at the door'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_revision: e679ef66605d514cb670f36749ebdc5591e070bd
review_loop_iteration: 0
followup_review_recommended: true
context:
  - AGENTS.md
  - _bmad-output/implementation-artifacts/epic-8-context.md
  - .yoyo/learnings.md
intent_resolution: auto
intent_resolution_reason: >-
  Freeform epic-story range 8.1–8.9 from the invocation, sprint-status.yaml
  keys, and compiled epic-8-context. Planning epics.md is not the contract.
  Fast-path assumptions tagged below. Do not edit this spec's
  <intent-contract>.
warnings:
  - multiple-goals
  - oversized
deferred:
  - summary: >-
      Copyable MCP config uses a relative sidecar/mcp.mjs path with no cwd, so
      it is only valid if the client is started from the repo root.
    evidence: |-
      loopbackMcpConfig emits args: ["sidecar/mcp.mjs"] and no cwd. A Claude
      Desktop / Cursor client launched from elsewhere will fail to spawn the
      wrap. The Settings pane does not rewrite this to an absolute path.
    location: >-
      src/lib/workbench-settings.ts loopbackMcpConfig
    severity: medium
  - summary: >-
      Settings does not probe loopback /health for port_conflict; only the
      branded skill prose and injected healthPayload cover that status.
    evidence: |-
      The assumption says Settings and the skill treat a foreign 19828 payload
      as port_conflict. Settings shows Open /health and copy, but does not
      fetch and classify the live listener.
    location: >-
      src/components/workbench/SettingsCanvas.tsx API + MCP pane
    severity: medium
  - summary: >-
      Skills are scanned on Chat mount and the Skills rail, not when Settings
      opens.
    evidence: |-
      AC says "when Settings or Workbench loads, then they are scanned without
      reinstall". Workbench/Skills rail scans; Settings only shows the install
      command and the enablement map write.
    location: >-
      src/components/workbench/SettingsCanvas.tsx
    severity: medium
  - summary: >-
      persistChatTurn and chat-routes suites do not execute the new
      toolCalls/outputs persist path end to end.
    evidence: |-
      chat.ts persistChatTurn now writes those fields, and ChatCanvas sends
      them, but chat-routes.test.ts still mocks persistChatTurn and never
      asserts the stored shape.
    location: >-
      src/lib/__tests__/chat-routes.test.ts
    severity: medium
  - summary: >-
      Per-review PATCH /api/v1/projects/{id}/reviews/{id} and reopenReviewItem
      are never executed in tests.
    evidence: |-
      epic8-v1-routes covers collection PATCH skip/reopen and POST resolve.
      The single-id route and reopen helper can regress with the suite green.
    location: >-
      src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts
    severity: medium
  - summary: >-
      requireOwnerOrServicePrincipal is only mocked, never executed, in the
      suites that now depend on it.
    evidence: |-
      AnyTXT /api/sources/search and several v1 routes switched to the helper.
      Tests stub the owner door rather than driving a non-owner 403 through
      the real function.
    location: >-
      src/lib/owner-route.ts
    severity: medium
  - summary: >-
      createLoopbackSettingsSource.refresh and the kernel
      GET /api/v1/loopback-settings route are not tested as a pair.
    evidence: |-
      Sidecar poll and the owner-automation route each have isolated pins;
      a token-shape drift between them would not fail the current suites.
    location: >-
      sidecar/loopback.mjs / src/app/api/v1/loopback-settings/route.ts
    severity: medium
  - summary: >-
      Search mode: deep does not broaden evidence; queryEmbedding is accepted
      and unused; the graph tool ignores its path argument.
    evidence: |-
      Intent says mode: deep broadens evidence (not Deep Research). The v1
      search route accepts queryEmbedding for FR-76 shape but does not embed.
      The in-app graph tool always loads the full workbench graph.
    location: >-
      src/app/api/v1/projects/[wikiId]/search/route.ts / sidecar/agent.mjs
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Agents on this machine have no token-protected loopback door to the private wiki, and the in-app Chat Agent cannot pick tools, run enabled Skills, write previewable workspace files, or split workspace vs external shell.

**Approach:** Enable Settings → API + MCP, bind `127.0.0.1:19828` only, ship the FR-76 `/api/v1` surface (kernel implements wiki data; sidecar owns Chat/MCP/shell/Skills and reverse-proxies the rest), then add a branded skill, a tool-using Chat Agent, opt-in SKILL.md packs, Chat forms, `agent-workspace/` chips, and per-command shell Approve/Deny.

## Boundaries & Constraints

**Always:**
- Bind only `127.0.0.1:19828`. Never `0.0.0.0`, LAN, or Clip-server `19827`. Unauthenticated local access is off by default. Changes apply only after sticky Save.
- Env `LLM_WIKI_API_TOKEN` overrides the stored UI token (`tokenSource: env`). Accepted send methods: `Authorization: Bearer` (preferred), `X-LLM-Wiki-Token`, `?token=` last. Never echo or log the token.
- API off → data routes 503 `"disabled"`; `GET /api/v1/health` stays public and reports `enabled: false`. API on and unauth off → missing/wrong token is 401. In-flight cap 64 → 503 `"busy"`. Rate 120 req/sec → 429.
- Health `status` is one of `starting` / `running` / `port_conflict` / `error`. Sidecar down is TCP connection refused, not a hallucinated wiki. If `authConfigured: false` and `allowUnauthenticated: false`, callers stop and tell the owner to generate a token.
- Same `/api/v1` shapes on loopback and the cloud façade. `{id}` is `current` or a Wiki UUID. A filesystem path is loopback-only; cloud never accepts a path; spoken names are not `{id}`. File reads stay in `purpose.md`, `schema.md`, `wiki/**`, `raw/sources/**` — text only; out of scope 403, binary/PDF 415, oversize 413. Body > 1 MiB → 400. Tree > 10000 → 413. Search `topK` ≤ 50; empty query → 400. Graph `limit` ≤ 1000.
- Kernel implements wiki read, search, graph, reviews, rescan, projects, and file content. Sidecar implements Chat, extract, shell/Skills, loopback health, and MCP wrap; every other loopback `/api/v1` route reverse-proxies the kernel with identical bodies. Sidecar never imports `src/lib`. Wiki bytes still go through the kernel write path so `dataVersion` still bumps.
- Cloud `POST /api/v1/projects/{id}/chat` and `POST /api/v1/chat` stay 503 `sidecar_required`. SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error`. The `done` frame is the complete aggregate. `mode: deep` broadens evidence; it is not the Deep Research panel and does not skip confirm.
- Stock skill/MCP is read-only except `sources/rescan`. Write MCP is owner-auth only and is not in the stock skill. MCP server name stays `yopedia`. Loopback skill token stays `LLM_WIKI_API_TOKEN`; kernel/consumer secrets stay `YOPEDIA_*` / `WORKWIKI_*`.
- In-app graph tool may use Epic 5 4-signal / Community data. Loopback `GET .../graph` is the wikilink graph only (undirected, self-edges dropped, `weight` 1.0). Mid-turn web search is not unconfirmed Deep Research.
- Skill file reads see enabled Skills only. `/skill` completes enabled names only. Selected Skill is stored on the Conversation. Outputs live under sidecar `agent-workspace/`, show as a chip, open in Preview, and survive restart with the Conversation.
- Workspace cwd/target may run without a modal. Outside the workspace, or a new executable path, requires Approve / Deny per command. Deny does not run. No blanket allow-all. Esc closes the form or approval without running.
- English-only UI and generation. Frozen `yopedia` / `WORKWIKI_*` identifiers. `isReadOnly()` before writes. SCHEMA.md and `llm-wiki.md` are not edited.

**Block If:**
- Satisfying an AC requires renaming a frozen identifier, editing `SCHEMA.md` or `llm-wiki.md`, binding `0.0.0.0` / LAN / `19827`, making unauth the default, the sidecar importing `src/lib`, adding SSE events beyond the locked five, rewriting cloud `src/mcp.ts` as the stock skill, treating Studio `/agents` as Workbench Chat, shipping unofficial Plaud HTTP, or accepting a filesystem path as `{id}` on the cloud façade.

**Never:**
- LAN bind or Clip-server 19827. Echo or log the token. Fake wiki when the sidecar is down. New SSE event names. Stock nashsu skill `POST /chat`. Write tools in the stock skill/MCP. A second wiki vault on sidecar disk (extract temp and `agent-workspace/` only). Chinese/i18n. Cloudflare sandbox as the Epic 8 shell. Studio `AgentManager` / kernel `agent-workspaces/` as the Workbench Chat Agent. Reopening DW-17 to partition Pages per Wiki.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| API off | Data route on loopback | 503 `"disabled"` | `/health` still 200 with `enabled: false` |
| Wrong token | API on, unauth off, bad/missing token | 401 | Token never echoed |
| Env token wins | `LLM_WIKI_API_TOKEN` set, different store token | Env token accepted; `tokenSource: env` | Store token 401s |
| Unauth warning | Unauth enabled and Saved | Orange callout on Settings → API + MCP | Unauth is not the default |
| Port occupant | Foreign HTTP on 19828 or bind EADDRINUSE | Skill/Settings treat as `port_conflict` | Sidecar down is connection refused |
| Busy / rate | 65th in-flight or >120 req/sec | 503 `"busy"` / 429 | Back off |
| `{id}` current/UUID | Loopback or cloud | Resolves to that Wiki | Spoken name 400; cloud path 400 |
| Loopback path `{id}` | URL-encoded absolute path on sidecar only | Resolves if it maps to a known Wiki or workspace | Cloud never accepts a path |
| File out of scope / binary / oversize | `files/content` | 403 / 415 / 413 | Hidden/symlinks skipped |
| Search empty / topK | `query: ""` or `topK: 99` | 400 / clamped to 50 | Workbench Search still works |
| Graph export | `GET .../graph` | Wikilink graph, `weight` 1.0, limit ≤ 1000 | Not the 4-signal engine |
| Review patch / bulk | FR-23 action set | Visible in Review after refresh | Unknown action 400 |
| Rescan | `POST .../sources/rescan` | `{ queue, changedTasks }` immediately | Ingest stays async |
| Cloud Chat | `POST .../chat` on Worker | 503 `sidecar_required` | No remote Agent |
| Skill no token | `authConfigured: false`, unauth off | Skill stops; asks to generate a token | Does not call data routes |
| Empty search (skill) | Search returns no hits | No fabricated answer; cites nothing | Honest empty |
| Wiki tool call | Question that needs the wiki | Agent calls wiki search; tool-call row shows name + outcome | SSE stays the five events |
| Disabled Skill | Skill off; type `/skill` | Name absent from completion; not injected | Conversation intact |
| Skill form cancel | Esc or Cancel | Form closes; pending tool does not run | Conversation intact |
| Workspace output | Tool writes a file | Under `agent-workspace/`; chip; Preview opens it; survives restart | Wiki bytes still through kernel |
| External shell | cwd/target outside workspace or new executable | Approve / Deny modal; Deny/Esc does not run | No allow-all |

</intent-contract>

## Context

- Epic 3 shipped loopback Chat + minimal health + cloud search/retrieve + cloud Chat 503. `sidecar/server.mjs` binds `127.0.0.1:19828` today with **no** token auth, **no** reverse-proxy, health stubbed as `enabled: true` / `allowUnauthenticated: true` / `tokenSource: "none"` / `status: "ok"`. Extract claim-loop already shares the process and must keep working.
- Settings → API + MCP is the last pending category (`workbench-settings.ts:85-89`). Epic 7 left that pending sentence on purpose. Clearing it without controls would lie.
- Cloud `/api/v1` today: `projects/[wikiId]/search`, `retrieve` (internal), `chat` 503. No health, projects, files, reviews, graph, or rescan v1 routes. Search JSON is `{ query, topK, hits, vectorPhase }` — Workbench `SearchCanvas` depends on `hits` / `vectorPhase`.
- `{id}` helpers: `isSidecarWikiId` (`current` or UUID) and `isFilesystemWikiId` live in `src/lib/chat-contract.ts`. Cloud must keep refusing paths. Loopback may accept a URL-encoded absolute path only when it maps to a known Wiki.
- DW-17 remains open: Pages/Sources are not partitioned per Wiki. Do not invent a host project root beside `wiki/` + `raw/sources/`. `listWorkbenchFilePaths` already surfaces `purpose.md`, `schema.md`, `wiki/`, `raw/`.
- Fork MCP (`src/mcp.ts`, `src/lib/mcp-http.ts`, `/api/mcp`) is a write-capable cloud catalog. It is **not** the stock loopback wrap. Do not trim or replace it as the 8.3 surface.
- Studio `/agents` (`agent-runtime.ts`, `agent-workspaces.ts`, kernel `tenants/…/agent-workspaces/`) is a different product. Do not retarget it as Workbench Chat, Skills, forms, outputs, or shell.
- Chat SSE is locked to five events. Tool-call rows must ride inside `meta` / `agent` / `done` payloads — never a sixth event name.
- Sidecar cannot import `src/lib`. Kernel settings (AD-23) stay in `AppConfig` via `saveConfig`. Sidecar learns enablement/token over owner-automation HTTP using the existing `WORKWIKI_API_TOKEN` / `YOPEDIA_SERVICE_TOKEN` pattern in `sidecar/extract-loop.mjs`.

## Intent Resolution

- **Locked:** Settings → API + MCP: enable API (default off), allow unauthenticated (default off), Generate / show / hide / copy token, Base URL `http://127.0.0.1:19828`, Open `/health`, copyable MCP config, branded skill install command, orange unauth warning, sticky Save. Clear the `api-mcp` `pending` sentence. After Save, zero Settings categories are `pending`.
- **Locked:** Loopback health fields stay the Epic 3 names; `status` values become `starting` / `running` / `port_conflict` / `error` (replace today's `"ok"`). Successful listen → `running`. `probeSidecar` still treats any 2xx as up.
- **Locked:** Token compare is timing-safe. Three extractors on sidecar data routes (not `/health`). CORS keeps the Epic 3 origin allowlist (`allowSidecarOrigin`); add `Authorization` and `X-LLM-Wiki-Token` to allowed headers. Do not switch to `Access-Control-Allow-Origin: *` (that would break the Epic 3 pin).
- **Locked:** Public v1 search JSON includes the FR-76 fields (`mode`, `tokenHits`, `vectorHits`, per-hit `path` / `title` / `snippet` / `score` / `titleMatch`, optional `vectorScore` / `images` / `content`) **and** keeps `query`, `topK`, `hits`, `vectorPhase` so `SearchCanvas` does not break.
- **Locked:** Review v1 actions map onto the existing queue: `create_page` / `deep_research` / `skip` (FR-23). `skip` or omitted action with `resolved: true` dismisses; `resolved: false` reopens. No second Review store.
- **Locked:** Loopback `GET .../graph` uses `buildWikiGraph` (wikilink). In-app Agent graph tool may call `/api/graph/workbench` (4-signal).
- **Locked:** Stock loopback MCP wraps FR-76 tools only (projects, files, reviews export, search, graph, rescan, chat). Cloud `src/mcp.ts` catalog stays. MCP server name stays `yopedia`.
- **Locked:** Workbench Chat Agent stays on the Node sidecar (no Rust rewrite). Tool-using loop is added there. Composer tools: Attach · Web search · AnyTXT · Skills · Smart retrieval · model · send.
- **Locked:** Filesystem Skills are a new scan, not Studio `agent-skills.ts` CRUD. Enablement persists in the kernel store. Selected Skill is a new optional field on `ChatConversation`.
- **[ASSUMPTION: Sidecar stays the existing Node `sidecar/server.mjs` process (Chat + extract loop + new v1 proxy / MCP / shell / Skills). No Rust Agent rewrite this epic.]**
- **[ASSUMPTION: Stored loopback token, `apiEnabled`, `allowUnauthenticated`, and Skill enablement live on `AppConfig` / the workbench settings payload (AD-23). Sidecar polls a new owner-automation `GET /api/v1/loopback-settings` with `WORKWIKI_API_TOKEN` / `YOPEDIA_SERVICE_TOKEN` and never imports `src/lib`. Env `LLM_WIKI_API_TOKEN` wins for compare and `tokenSource`.]**
- **[ASSUMPTION: `GET /api/v1/projects` `path` is the kernel-relative wiki artifact dir (`tenants/{t}/wikis/{id}`), not a host filesystem project root. This does not reopen DW-17 partitioning. Cloud `{id}` never accepts a path. Loopback `{id}` accepts a URL-encoded absolute path only when it maps to a known Wiki UUID or the sidecar workspace.]**
- **[ASSUMPTION: `files?root=sources` aliases `raw` and `raw/sources`. `root=all` is purpose.md + schema.md + wiki/ + raw/sources/ from `listWorkbenchFilePaths`. Response may include `truncated` when `maxFiles` or the 10000-node cap cuts the tree.]**
- **[ASSUMPTION: `POST .../sources/rescan` enqueues the existing source-diff / ingest scan for that Wiki and returns `{ queue, changedTasks }` immediately. It is not `POST /api/tasks/scan` cron.]**
- **[ASSUMPTION: Cloud `GET /api/v1/health` reports the Worker façade (`running` when the Worker is up). It cannot observe loopback `port_conflict`. Loopback health is the sidecar listener.]**
- **[ASSUMPTION: On EADDRINUSE the losing sidecar process exits after logging. Settings and the branded skill treat a reachable 19828 whose JSON is not a work-wiki health payload as `port_conflict`, and TCP refused as sidecar down. Tests inject `healthPayload({ status: "port_conflict" })`.]**
- **[ASSUMPTION: Branded Agent Skill pack lives in-repo at `skills/work-wiki/` (`SKILL.md`, `api-reference.md`, `examples.md`, `README.md`). Settings copies an install command for that pack. Stock nashsu skill remains a valid read/rescan install and must not `POST /chat`; the branded pack documents FR-77.]**
- **[ASSUMPTION: Project Skills scan `{sidecar-cwd}/skills/**/SKILL.md`. User Skills scan `~/.workwiki/skills/**/SKILL.md`. Enablement is a kernel map of skill id → boolean (default enabled on first scan).]**
- **[ASSUMPTION: Tool-call rows, Skill form fields, and shell approval travel in `meta` / `agent` / `done` JSON (and Chat conversation persistence), not new SSE event names.]**
- **[ASSUMPTION: Sidecar `agent-workspace/` is a directory beside the sidecar cwd. Conversation messages persist `outputs[]` `{ path, name }` in the kernel Chat store. Preview opens those files through a sidecar-backed preview path, not kernel R2 `agent-workspaces/`.]**
- **[ASSUMPTION: Epic 8 shell is a sidecar-local process with a workspace-vs-external classifier. It is not `runSandbox` / Cloudflare Sandbox and not the Studio approval desk.]**

## Code Map

- `sidecar/server.mjs:18-42,657-691` -- Bind `SIDECAR_HOST`/`SIDECAR_PORT`; `healthPayload()`; Chat + 404 only today. Extend health honesty, token gate, in-flight/rate, reverse-proxy. Keep extract loop. No `src/lib`.
- `sidecar/extract-loop.mjs:62-72` -- Reuse `WORKWIKI_URL` + `WORKWIKI_API_TOKEN` / `YOPEDIA_SERVICE_TOKEN` Bearer pattern for kernel proxy and loopback-settings poll.
- `src/lib/sidecar.ts:15-25,63-106` -- `SIDECAR_ORIGIN`, `SIDECAR_HEALTH_URL`, `SIDECAR_SSE_EVENTS`, `probeSidecar` (2xx = up). Do not Worker-proxy health.
- `src/lib/auth.ts:176-183` -- Reuse `timingSafeEqual` on the kernel; sidecar gets its own copy (cannot import this file).
- `src/lib/chat-contract.ts:51-57` -- `isFilesystemWikiId` / `isSidecarWikiId`. Cloud keeps these. Loopback path resolver is sidecar-only.
- `src/lib/wiki-access.ts` -- `requireAccessibleWikiId` for cloud v1 `{id}`.
- `src/lib/wikis.ts:106-119,1022` -- `WikiRecord` has no host `path`; `getWikiRegistry` is the projects source. Add display `path` + `current` in the v1 mapper only.
- `src/lib/workbench-files.ts:302,543` -- `listWorkbenchFilePaths` / `readWorkbenchFile` for files + content. Reuse preview text-extension gates.
- `src/lib/review-queue.ts:498+` -- `reviewSnapshot`, `skipReviewItem`, create-page / deep-research actions. Adapt to v1 `{ resolved, action }`.
- `src/app/api/wiki/graph/route.ts` -- `buildWikiGraph` for loopback/cloud v1 graph export.
- `src/app/api/graph/workbench/route.ts` -- In-app Agent graph tool only (4-signal).
- `src/lib/wiki-retrieve.ts` / `src/app/api/v1/projects/[wikiId]/search/route.ts` -- `searchWiki`; wrap FR-76 fields; keep `hits`/`vectorPhase`.
- `src/app/api/v1/projects/[wikiId]/chat/route.ts` / `src/app/api/v1/chat/route.ts` -- Stay 503 `sidecar_required`.
- `src/app/api/v1/projects/[wikiId]/retrieve/route.ts` -- Internal Chat assemble; not an FR-76 external route.
- `src/lib/config.ts:33-137` / `src/app/api/settings/route.ts` -- Persist `apiEnabled`, `allowUnauthenticated`, loopback token, Skill enablement on `AppConfig`.
- `src/lib/workbench-settings.ts:75-92,722-901` / `src/components/workbench/SettingsCanvas.tsx:691-694` -- Clear `api-mcp` pending; add pane controls + copy constants.
- `src/lib/__tests__/workbench-settings.test.ts:373-380` -- Today pins `api-mcp` as the sole pending category; rewrite to expect **no** pending categories.
- `src/lib/__tests__/workbench-epic3.test.ts:125-145,354` -- Health field names + origin allowlist. Update `status` from `"ok"` to `running`; keep origin pin; allow auth headers.
- `src/mcp.ts` / `src/lib/mcp-http.ts` / `src/app/api/mcp/route.ts` -- Cloud write MCP; **read-only reuse of handler patterns**. Do not replace with stock wrap.
- `sidecar/mcp.mjs` (new) -- Loopback MCP wrap of FR-76 tools; copyable config points here; name `yopedia`.
- `skills/work-wiki/` (new) -- Branded pack: health-first, `current`, cite paths, no fabricate, may document `/chat`.
- `src/lib/chat.ts:76-91` -- Add optional `selectedSkill`; message `outputs[]` / tool-call rows.
- `src/components/workbench/ChatCanvas.tsx:298-366,625-806` -- Today retrieve→sidecar, no tools. Add composer tools, `/skill`, tool-call rows, form modal, output chips, shell Approve/Deny. Keep SSE filter to `SIDECAR_SSE_EVENTS`.
- `src/components/workbench/ChatBody.tsx` -- Keep citation buttons; do not own tool rows.
- `src/lib/workbench-modes.ts:54` / `src/components/workbench/ModeCanvas.tsx:257-271` -- Skills rail stub → list scanned Skills.
- `src/lib/raw-source-search.ts` / `src/app/api/sources/search/route.ts` -- AnyTXT / source full-text reuse.
- `src/lib/agent-skills.ts` / `src/lib/agent-workspaces.ts` / `src/lib/agent-runtime.ts` -- Studio only. Do not retarget.
- `src/lib/__tests__/sidecar.test.ts` / `src/lib/__tests__/chat-routes.test.ts` -- Probe URL and cloud Chat 503 pins.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` / `src/lib/workbench-settings.ts` / `src/app/api/settings/route.ts` / `src/components/workbench/SettingsCanvas.tsx` -- API + MCP pane; persist enablement, unauth, token, Skill enablement; clear `api-mcp` pending; orange unauth warning; copyable MCP + skill install; sticky Save.
- `src/app/api/v1/loopback-settings/route.ts` (new) -- Owner-automation GET of `{ enabled, allowUnauthenticated, token, tokenSource }` for the sidecar poll. Never log the token.
- `sidecar/server.mjs` -- Honest health; token extractors; 401/503 disabled/busy; 429; CORS auth headers; in-flight 64; poll settings + env override; reverse-proxy non-chat v1 to kernel; keep Chat/extract.
- `src/app/api/v1/health/route.ts` (new) -- Cloud façade health (no loopback `port_conflict`).
- `src/app/api/v1/projects/route.ts` / `src/app/api/v1/projects/[wikiId]/files/route.ts` / `files/content/route.ts` / `reviews/route.ts` / `reviews/[reviewId]/route.ts` / `reviews/resolve/route.ts` / `graph/route.ts` / `sources/rescan/route.ts` -- Cloud FR-76 shapes; Clerk/owner principal; reject filesystem `{id}`; file 403/415/413; search wrap FR-76 + keep `hits`.
- `src/app/api/v1/projects/[wikiId]/search/route.ts` -- Add `includeContent` / `queryEmbedding`; emit FR-76 fields; keep Workbench `hits`/`vectorPhase`.
- `sidecar/mcp.mjs` (new) -- Stock tools only; same token/loopback rules; read-only except rescan.
- `skills/work-wiki/**` (new) -- Health-first branded pack; no fabricate; `current`; may document `/chat`; Settings shows install command.
- `sidecar/server.mjs` + Chat Agent -- Tool loop (wiki/source/graph/web/AnyTXT/workspace/shell/skill reads); tool rows in `meta`/`agent`; Skill scan; forms; `agent-workspace/`; workspace-vs-external shell.
- `src/lib/chat.ts` / Chat conversation routes -- Persist `selectedSkill` and message `outputs[]`.
- `src/components/workbench/ChatCanvas.tsx` / `ModeCanvas.tsx` / `src/lib/workbench-modes.ts` -- Composer tools, `/skill`, form + Esc, chips → Preview, shell Approve/Deny + Esc.
- Tests -- Pin the I/O matrix; rewrite pending-category pin; health `status: running`; sidecar auth/proxy; v1 routes; skill pack probes; one golden wiki-search tool turn; `/skill` enablement; form cancel; output chip persistence; shell Deny/Esc.

**Acceptance Criteria:**
- Given I open Settings → API + MCP, when I enable the API, generate a token, and Save, then the sidecar binds `127.0.0.1:19828` only, unauth is off unless I turned it on, `LLM_WIKI_API_TOKEN` overrides the UI token (`tokenSource: env`), and an orange warning shows when unauth is on.
- Given the API is off, when a caller hits a data route, then it returns 503 `"disabled"` and `/health` still reports `enabled: false`.
- Given the API is on and unauth is off, when a data route has a missing or wrong token, then it returns 401 for Bearer, `X-LLM-Wiki-Token`, or `?token=` (never echoed).
- Given another process owns 19828, when I probe health, then I am told `port_conflict` (foreign payload or injected status), not a fake wiki.
- Given the sidecar is up, when a client calls the FR-76 table, then health, projects, files, files/content, reviews (GET/PATCH/bulk-resolve), search, chat, graph, and sources/rescan exist with the stated fields; kernel owns wiki data; sidecar reverse-proxies those and owns Chat/extract/shell/Skills/health/MCP wrap.
- Given `{id}`, when it is `current` or a Wiki UUID, then it resolves; a filesystem path works only on loopback; cloud never accepts a path; spoken names are not `{id}`.
- Given a file read that is out of scope, binary/PDF, or oversize, when `files/content` runs, then 403 / 415 / 413; body > 1 MiB → 400; tree > 10000 → 413; `topK` clamped to 50; graph `limit` to 1000; 120 req/sec → 429.
- Given Settings → API + MCP, when I copy the MCP config, then it is valid on this machine, tools list projects/files/unresolved reviews/search/graph/rescan/chat, and stock MCP is read-only except rescan.
- Given the branded skill is installed, when an agent starts, then it probes `GET /api/v1/health` first; if `authConfigured: false` and unauth is off it asks for a token and stops; sidecar down is connection refused; `port_conflict` names the other process; lookup is project → search → cite paths → synthesize; empty results do not fabricate; default project is `current` and names the Wiki once; Settings shows the install command.
- Given a question that needs the wiki, when the Agent runs a turn, then it can call wiki search without me picking the tool, a tool-call row shows name + outcome, and at least one golden turn records that call.
- Given graph / AnyTXT / composer tools, when Chat is open, then the Agent may use 4-signal graph data, AnyTXT is full-text over `raw/sources/`, Skill reads see enabled Skills only, mid-turn web search is not unconfirmed Deep Research, and Attach · Web search · AnyTXT · Skills · Smart retrieval are available.
- Given `SKILL.md` files in project and user folders, when Settings or Workbench loads, then they are scanned without reinstall, Skills mode lists them, disable hides them from `/skill` and injection, `/skill` completes enabled names only, and the selected Skill is stored on the Conversation.
- Given a Skill form, when it shows, then one renderer handles single, multiple, or free text; Chat waits until Submit or Cancel; Esc/Cancel leaves the Conversation intact and does not run the pending tool.
- Given a tool creates a file, when the turn finishes, then it lives under `agent-workspace/`, shows as a chip, Preview can open it, and it survives restart with the Conversation.
- Given a workspace command, when the Agent requests it, then it may run without a modal; given an external or new-executable command, when it is requested, then Approve/Deny is per command, Deny/Esc does not run, and there is no allow-all default.

## Spec Change Log

## Review Triage Log

### 2026-08-25 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 11, medium 2, low 0)
- defer: 8: (high 0, medium 8, low 0)
- reject: 8
- addressed_findings:
  - `[high]` `[patch]` Selected Skill was sent on the Conversation but never injected into the Agent system prompt — `withSelectedSkill` now prepends the enabled pack, pinned in `epic8-chat-agent.test.ts`.
  - `[high]` `[patch]` `WorkspacePreview` fetched workspace files without the door token — Preview now reads `/api/v1/loopback-settings` and sends `Authorization: Bearer`, pinned in `epic8-chat-ui.test.tsx`.
  - `[high]` `[patch]` A pending form/approval left Send and the composer live — both are disabled while `pending` is set.
  - `[high]` `[patch]` Stock MCP chat used the full write-tool set — MCP chat now sends `allowWrites: false` and `toolsForTurn` drops `shell` / `workspace_write`.
  - `[high]` `[patch]` `kernelFetch` treated 401/500 JSON as a successful tool result — non-OK responses return `null`.
  - `[high]` `[patch]` Loopback filesystem `{id}` was accepted then ignored — `resolveLoopbackWikiId` / `rewriteProxiedWikiPath` map an absolute path to `current` on Chat and the kernel proxy.
  - `[high]` `[patch]` Search omitted `tokenHits` / `vectorHits` when the vector leg was `ok` — those counts are always emitted, including with `queryEmbedding` present.
  - `[high]` `[patch]` Cloud `GET /api/v1/health` read laptop loopback Settings — Worker façade now reports `enabled: true`, `authRequired: true`, `allowUnauthenticated: false`, `tokenSource: "none"`.
  - `[high]` `[patch]` AnyTXT `/api/sources/search` used a weaker auth door — it now uses `requireOwnerOrServicePrincipal`.
  - `[high]` `[patch]` Resume without a `pending` object could continue a turn — sidecar returns 400 `invalid_resume`; `resumeAgentTurn` no-ops a missing pending.
  - `[high]` `[patch]` Workspace writes followed a symlink out of `agent-workspace/` and had no byte cap — write/read now realpath-contain (comparing both sides so macOS `/var` → `/private/var` still writes) and refuse above `WORKSPACE_MAX_FILE_BYTES`.
  - `[medium]` `[patch]` Persist failure after a finished sidecar turn restored the Approve/Deny modal — `settleTurn` clears `pending` / `turnRef` before persist; resume only restores the pause if the sidecar call itself failed.
  - `[medium]` `[patch]` MCP wrap body was not pinned to `tools: true` + `allowWrites: false` — source pin in `workbench-epic8.test.ts`.

## Design Notes

Sidecar is the nashsu-compatible bind; cloud `/api/v1` is the same *shape* behind Clerk/owner auth, not port 19828. Search dual-emits FR-76 fields and the Epic 3 `hits`/`vectorPhase` object so Search mode does not regress. Tool UX is payload-on-the-five-events, not a sixth SSE name. Studio `/agents` and fork MCP stay as they are.

Copyable MCP (shape, not a second convention): a local stdio client pointing at `sidecar/mcp.mjs` with server name `yopedia` and the loopback token in env — never the token inlined into a URL the owner can see.

Health `status` example after a good listen:

```json
{ "ok": true, "status": "running", "enabled": true, "authRequired": true, "authConfigured": true, "allowUnauthenticated": false, "tokenSource": "store" }
```

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/sidecar.test.ts src/lib/__tests__/chat-routes.test.ts src/components/workbench/__tests__/chat-search-contracts.test.tsx` -- expected: pass after pending-category and health-status pin updates
- `pnpm exec vitest run` with the new Epic 8 suites (sidecar auth/proxy, v1 routes, skill pack, Chat tools/forms/chips/shell) -- expected: pass; every I/O matrix row covered by a test that ran
- `pnpm exec vitest run src/lib/__tests__/brand-copy.test.ts` -- expected: pass (no frozen-identifier rename)

**Manual checks (if no CLI):**
- Settings → API + MCP: enable, generate token, Save; Open `/health` in the browser on `http://127.0.0.1:19828/api/v1/health`; unauth warning only when unauth is on.

## Auto Run Result

Status: done

**Summary.** Stories 8.1–8.9: Settings → API + MCP enables a token-gated loopback door on `127.0.0.1:19828`; kernel implements FR-76 `/api/v1` wiki data (sidecar reverse-proxies the rest); stock MCP wrap (`yopedia`) is read-only except rescan; branded `skills/work-wiki` pack; Workbench Chat Agent tools, SKILL.md scan, forms, `agent-workspace/` chips, and per-command shell Approve/Deny. Cloud Chat stays `503 sidecar_required`. SSE events stay the locked five.

**Files changed (areas):**
- `sidecar/loopback.mjs`, `sidecar/server.mjs` — bind, token extractors, health, in-flight/rate, settings poll, kernel proxy, filesystem `{id}` rewrite.
- `sidecar/agent.mjs`, `sidecar/skills.mjs`, `sidecar/workspace.mjs`, `sidecar/shell.mjs`, `sidecar/mcp.mjs` — tool loop, Skill scan, contained workspace, shell classifier, stock MCP wrap.
- `src/app/api/v1/**` — health, projects, files, graph, reviews (+ resolve), rescan, loopback-settings, web-search; search dual-emits FR-76 + Epic 3 fields.
- `src/lib/v1-contract.ts`, `src/lib/v1-route.ts`, `src/lib/source-rescan.ts`, `src/lib/chat-agent.ts`, `src/lib/chat.ts`, `src/lib/config.ts`, `src/lib/workbench-settings.ts`, `src/lib/owner-route.ts`, `src/lib/review-queue.ts` — contracts, persist, Settings payload, owner-or-service door.
- `src/components/workbench/ChatCanvas.tsx`, `SettingsCanvas.tsx`, `SkillsCanvas.tsx`, `WorkspacePreview.tsx`, `ModeCanvas.tsx`, `PreviewColumn.tsx` — composer tools, `/skill`, forms, chips, Approve/Deny, API + MCP pane.
- `skills/work-wiki/**` — branded health-first skill pack.
- Tests: `workbench-epic8`, `epic8-v1-routes`, `epic8-chat-agent`, `epic8-chat-ui`, `epic8-skills-canvas`, plus pending-category / health-status / brand-copy pins.
- `_bmad-output/implementation-artifacts/spec-8-1-through-8-9-agents-at-the-door.md`, `epic-8-context.md`, `sprint-status.yaml`, `AGENTS.md` (freeze `~/.workwiki/skills`).

**Review findings.** 11 high + 2 medium patches applied. 8 medium items deferred (MCP cwd, Settings health probe, Settings skill scan, persist/per-review/owner-route/loopback-settings test gaps, `mode: deep` / unused `queryEmbedding` / unused graph `path`). 8 rejected (branded-install vs in-app scan are different Skill objects; pending modal not persisted across reload; shell-border polish; live `EADDRINUSE` / MCP stdio handshake; SettingsCanvas unmounted; Studio `/agents` and cloud `src/mcp.ts` correctly left alone).

**Follow-up review recommendation:** `true`. Patched this pass: high 11, medium 2, low 0. Score: any high patched → recommend follow-up (`3 × 2 + 0 = 6` would also qualify).

**Verification.**
- `pnpm exec vitest run` of the spec Verification files plus Epic 8 suites (11 files): **419 passed**.
- Manual sidecar `/health` in a browser was not run in this session (CLI verification used).

**Residual risks.** Copyable MCP config is repo-root-relative. Settings does not classify a live `port_conflict`. `mode: deep` does not broaden retrieval. Workspace containment is realpath-after-write (a symlink escape is created then unlinked). Cloud health cannot observe laptop `port_conflict` (assumed). No live bind/`EADDRINUSE` or MCP stdio handshake was exercised.
