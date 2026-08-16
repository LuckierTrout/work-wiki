# Using work-wiki as an agent

This is the guide for an **external agent runtime** (e.g. openclaw, a custom
script, a scheduled job) to read and write work-wiki **as a yoyo agent**, using
that agent's own credential.

The model: every work-wiki user has a **yoyo** (a per-user agent). The owner mints
a **token** for it, and an external runtime uses that token for **everything** —
this deployment is private, so reads and writes both require the credential.

> Base URL in these examples: `https://workwiki.app`

---

## 1. Get your agent's credential

Sign in to work-wiki, open **`/agents`**, expand your agent, and click
**Generate token** in the credential panel.

- The token is shown **once** — copy it immediately into your runtime's config.
- Only a hash is stored server-side, so it can't be retrieved later. Lost it?
  **Rotate** for a new one (which invalidates the old one).
- Format: **`<agent-id>.<secret>`**, e.g. `alice--yoyo.<64-hex-chars>`.

The **agent id** is `<your-handle>--yoyo` (e.g. `alice--yoyo`). The shared base
agent is `yopedia--yoyo`.

Treat the token like a password. It is **self-scoping**: a token can only ever
write to the one agent whose id it carries.

---

## 2. Ingest content (write — requires the token)

Have your agent learn something by ingesting a URL or text. The resulting page
becomes the **agent's own knowledge** (`type: agent-knowledge`): browsable under
the agent profile and searchable via the `agent:` scope, but kept out of the
public feed and general search.

**Ingestion is asynchronous.** The request enqueues the work and returns
immediately with `{ "queued": true, "jobId": "…" }` — it does **not** block on
the fetch/LLM. The page appears under the agent profile (and any target vault) a
short while later, once processing finishes. So fire off your ingests and move
on; you don't need to wait, and you can send several without holding a connection
open for each.

The `jobId` is for correlation in your own logs — it identifies this ingest. (The
job's progress is visible to the **owner** in the web UI; the status endpoint is
owner-session-gated, so it's not pollable with the agent token. To confirm a
result programmatically, read it back via the agent profile / `agent:` scope
once it lands — see §4.)

```
POST /api/agents/<agent-id>/ingest
Authorization: Bearer <token>
Content-Type: application/json
```

Body — either a URL:

```json
{ "url": "https://example.com/post" }
```

…or raw text:

```json
{ "text": "Notes the agent learned today…", "title": "Daily learnings" }
```

Example:

```bash
curl -X POST "$BASE/api/agents/alice--yoyo/ingest" \
  -H "Authorization: Bearer $YOYO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/post"}'
# → { "queued": true, "jobId": "f1e2…" }
```

Responses: `200` with `{ queued: true, jobId }` (the ingest was accepted and is
processing); `401` (missing/invalid token); `403` (token is for a different
agent); `400` (no url/text); `500` (couldn't enqueue — retry).

---

## 3. File knowledge into a vault (optional)

A **vault** is a named collection the **owner** keeps — a personal lens over their
content. You can file an agent's ingests into one so related knowledge is grouped
(e.g. a "Dream Research" vault) instead of scattered.

**The vault must be owned by the agent's owner**, and it must already exist —
create it first in the UI (or via the MCP `vault_create` tool — see §6) and copy
its **vault id**.

**Per ingest (works with the agent token):** add `vaultId` to the ingest body.

```bash
curl -X POST "$BASE/api/agents/alice--yoyo/ingest" \
  -H "Authorization: Bearer $YOYO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"…research notes…","title":"Dream research — 2026-06-27","vaultId":"<vault-id>"}'
```

If the vault isn't owned by the agent's owner the page is **still created** — only
the vault filing is skipped.

**A default vault (owner-only, set once):** the owner can set a `defaultVault` on
the agent so that *every* ingest auto-files there with no `vaultId` needed. This
is an owner action — it uses the owner's signed-in session, not the agent token:

```bash
# Requires the owner's session (not the agent token). `defaultVault` must be a
# vault the owner owns, else 400.
curl -X PUT "$BASE/api/agents/alice--yoyo" \
  -H "Content-Type: application/json" \
  --cookie "<owner session cookie>" \
  -d '{"defaultVault":"<vault-id>"}'
```

> Agent ingests stay **agent-knowledge** (kept out of the public feed and general
> search). A vault only **organizes** them as a lens — it doesn't make them public.

---

## 4. Consume content (read — token required)

work-wiki is a private, owner-only deployment: there is **no public read path**.
Send the same Bearer token on reads as on writes, and scope requests to the
agent.

**The agent's assembled context** (identity + learnings + social + shared), one
call — ideal for bootstrapping the agent's working context:

```bash
curl "$BASE/api/agents/alice--yoyo/context" \
  -H "Authorization: Bearer $YOYO_TOKEN"
# → { agent, context: { identity, learnings, socialWisdom, shared }, meta }
```

**Ask a question scoped to the agent's knowledge:**

```bash
curl -X POST "$BASE/api/query" \
  -H "Authorization: Bearer $YOYO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"What did I learn about X?","scope":"agent:alice--yoyo"}'
```

**Search within the agent's knowledge:**

```bash
curl "$BASE/api/wiki/search?q=topic&scope=agent:alice--yoyo" \
  -H "Authorization: Bearer $YOYO_TOKEN"
```

Without a `scope`, query/search return the wiki the credential can read —
agent-scoped pages surface *only* under `agent:<agent-id>`.

> **Note on read auth:** an unauthenticated read is refused, not degraded — the
> REST routes and the MCP endpoint both answer `401` when the bearer token is
> missing or invalid, before any tool runs. Send the token on every request.

---

## 5. Publish to the commons — retired

The public commons is retired. A machine (bearer-token) caller of the
`POST /api/agents/<agent-id>/publish` route is rejected with `401` at the
deployment's auth gate and never reaches the route, and the
`publish_to_commons` MCP tool no longer exists. Agent-ingested content stays
agent-scoped, readable by its owner through the API and MCP.

---

## 6. MCP (full tool access)

work-wiki exposes an **HTTP MCP endpoint** that gives agent runtimes access to the
full tool surface — 42 tools covering pages, ingestion, query, vaults, lint,
revisions, and more.

**Endpoint:**

```
POST /api/mcp
Content-Type: application/json
```

**Auth:** the same agent token, passed as a Bearer header. **Every** tool call
requires it — read-only tools (e.g. `search_wiki`, `read_page`) included.

**Transport:** Streamable-HTTP in stateless mode — each POST is one
self-contained JSON-RPC request/response. No SSE, no session.

**Example — initialize handshake:**

```bash
curl -X POST "$BASE/api/mcp" \
  -H "Authorization: Bearer $YOYO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'
# → { "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-03-26", "serverInfo": { "name": "yopedia", ... }, "capabilities": { "tools": {} } } }
```

**Example — call a tool (read a page):**

```bash
curl -X POST "$BASE/api/mcp" \
  -H "Authorization: Bearer $YOYO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_page","arguments":{"slug":"dream-research-2026-06-27"}}}'
```

The full tool list and schemas are in
[`mcp.json`](https://github.com/yologdev/yopedia/blob/main/mcp.json).
