# Epic 8 Context: Agents at the door

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

External agents and scripts on this machine reach the same private wiki as the Workbench through a token-protected loopback API, MCP, and a branded skill — while the in-app Agent can pick tools, run enabled Skills, write previewable workspace files, and run shell only with a workspace-vs-external split. This is the P1 door: clients talk to `127.0.0.1:19828` without a LAN bind or a second wiki.

## Stories

- Story 8.1: Enable loopback API and token
- Story 8.2: Full `/api/v1` surface
- Story 8.3: MCP and copyable config
- Story 8.4: work-wiki Agent Skill
- Story 8.5: Tool-using Agent
- Story 8.6: Skill scan, enable, `/skill`
- Story 8.7: Skill forms
- Story 8.8: Agent workspace outputs
- Story 8.9: Safer shell Approve/Deny

## Requirements & Constraints

**Loopback only, token by default.** Settings → API + MCP enables the API, generates a token, and allows or denies local unauthenticated access. Unauth is not the default. Bind `127.0.0.1:19828` only — never `0.0.0.0`, LAN, or Clip-server 19827. Env `LLM_WIKI_API_TOKEN` overrides the UI token (`tokenSource: env`). API off: data routes 503 `"disabled"`; `/health` still reports `enabled: false`. API on and unauth off: missing or wrong token is 401. Send via `Authorization: Bearer` (preferred), `X-LLM-Wiki-Token`, or `?token=` last resort — never echo or log the token.

**Health is public; status is honest.** `GET /api/v1/health` needs no auth and reports `ok`, `status` (`starting` / `running` / `port_conflict` / `error`), `version`, `enabled`, `authRequired`, `authConfigured`, `allowUnauthenticated`, `tokenSource` (`env` / `store` / `none`). Another process on 19828 → `port_conflict`. Sidecar down → connection refused, not a hallucinated wiki. If auth is not configured and unauth is off, callers stop and tell the operator to generate a token. In-flight cap 64 → 503 `"busy"`. Rate 120 req/sec → 429.

**One HTTP contract, tight limits.** Same route shapes on loopback and the cloud façade: health, projects, files, files/content, reviews (list / patch / bulk-resolve), search, chat, graph, sources/rescan. Field names are the contract. `{id}` is `current` or a Wiki UUID; a filesystem path is loopback-only; cloud never accepts a path; spoken names are not `{id}`. File reads stay in `purpose.md`, `schema.md`, `wiki/**`, `raw/sources/**` — text only; out of scope 403, binary/PDF 415, oversize 413. Body over 1 MiB → 400. Search `topK` clamped to 50; empty query → 400; graph `limit` clamped to 1000. v1 mutations: Review resolve/patch and sources/rescan. Loopback graph export is the wikilink graph, not the Workbench 4-signal engine.

**Chat stays on the sidecar.** `POST .../chat` is JSON by default; stream with `stream: true` or `Accept: text/event-stream`. SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error`. The `done` frame is the complete aggregate. Cloud Chat returns 503 `sidecar_required`. `mode: deep` may broaden evidence; it is not the Deep Research panel and does not skip confirm.

**MCP and the installable skill wrap the same surface.** Copyable MCP config is valid on this machine. Tools: list projects, read files, export unresolved Reviews, hybrid search, inspect the graph, rescan, Agent chat. Same token and loopback rules. Stock skill/MCP is read-only except rescan; write MCP is owner-auth only and is not in the stock skill. The branded skill probes health first, defaults to `current`, names the active Wiki once, searches then cites paths, and does not fabricate on empty results. Stock nashsu skill must not `POST /chat`; the branded pack may. Settings shows the install command.

**In-app Agent picks tools; Skills are opt-in.** Tools: wiki search, source search, graph search, web search, AnyTXT (full-text over `raw/sources/`), workspace files, approved shell, Skill file reads. Graph search may use 4-signal / Community data. Mid-turn web search is not unconfirmed Deep Research. Skill file reads see enabled Skills only. Scan project and user folders for `SKILL.md` on Settings open and Workbench load. Enable/disable globally; `/skill` completes enabled names only; the selected Skill is stored on the Conversation. Forms: single, multi, or free text on one renderer; Chat waits until submit or cancel. Outputs live under `agent-workspace/`, show as a chip, open in Preview, and survive restart with the Conversation.

**Safer shell.** Workspace cwd/target may run without a modal. Outside the workspace, or a new executable path, requires Approve / Deny per command. Deny does not run. No blanket allow-all default. Esc closes without running.

**Device.** Chat, extract, loopback, MCP, shell, and Skills require the sidecar on the same machine as the browser. Other Clerk sessions: tree, Preview, and search only — no alternate IA. English-only UI and generation.

## Technical Decisions

**Two runtimes, one wiki.** Workbench and the wiki data plane stay on the Worker. The sidecar owns Chat Agent, extract, approved shell, Skills scan, `agent-workspace/`, loopback bind, and MCP wrap. It drives the kernel only over owner-auth HTTP and never imports kernel internals. Canonical bytes stay in the kernel store. Sidecar disk is extract temp and `agent-workspace/` only. Wiki reads/writes go through kernel HTTP / the single write path so `dataVersion` still bumps.

**Ownership of `/api/v1`.** Kernel implements wiki read, search, graph, reviews, rescan, projects list, and file content. Sidecar implements Chat, extract, shell/Skills, loopback `/health`, and MCP wrap. Every other loopback `/api/v1` route reverse-proxies the kernel with identical bodies. Stock skill talks to loopback only.

**Durable state.** Conversations (including selected Skill), Settings (API enablement and Skill enablement), and Review live in the kernel store. Sidecar may cache a turn. Skills scan reads folders; enablement is kernel Settings. Display copy is work-wiki; runtime identifiers including the MCP server name stay `yopedia`.

## UX & Interaction Patterns

Settings → API + MCP: enable; status; Base URL `http://127.0.0.1:19828`; Open `/health`; token show/hide/copy/Generate; copyable MCP config; skill install command. Env override wins. Do not offer unauth as the default or LAN/`0.0.0.0`. When unauth is on, show the orange warning callout. Changes apply only after sticky Save.

Skills is a rail icon and lists scanned Skills. Composer tools: Attach · Web search · AnyTXT · Skills · Smart retrieval · model · send. Tool-call rows show name + outcome. Workspace outputs are chips that open Preview. Skill form: Submit / Cancel. Shell approval: warning border, command in mono, Approve / Deny. Esc closes the form or approval (one modal). Chat stays system sans; Preview body stays Georgia.

## Cross-Story Dependencies

8.1 (bind, token, health) gates 8.2–8.4. 8.2 is the HTTP contract that 8.3 and 8.4 consume — do not fork field names. 8.5–8.9 sit on Epic 3 Chat. 8.5 graph tool uses Epic 5 4-signal / Community data; loopback graph export remains the wikilink graph. 8.6 enablement gates Skill file reads and `/skill`. 8.8 writes sidecar `agent-workspace/` only; wiki bytes still go through the kernel. 8.9 gates any Agent-issued shell.

Depends on Epic 1 Settings chrome, Skills rail, and sidecar fail-closed; Epic 3 Chat/SSE/Conversations; Epic 5 for the in-app graph tool. Cloud `/api/v1` keeps the same shapes; Chat stays loopback-only. API/MCP Intake already auto-queues from earlier epics.
