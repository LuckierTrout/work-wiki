# work-wiki loopback API reference

Base URL: `http://127.0.0.1:19828`. Every route below is under `/api/v1`.

Authentication: `Authorization: Bearer <token>`, unless `/health` reports
`authRequired: false`. `X-LLM-Wiki-Token: <token>` and `?token=<token>` are also
accepted, in that order of preference.

`{id}` is a project id: `current`, or a UUID from `GET /api/v1/projects`.

---

## GET /api/v1/health

Public. Answers even when the API is switched off, and even before the listener
has finished binding.

```json
{
  "ok": true,
  "status": "running",
  "version": "0.1.0",
  "enabled": true,
  "authRequired": true,
  "authConfigured": true,
  "allowUnauthenticated": false,
  "tokenSource": "store"
}
```

- `ok` — the listener is up. It says nothing about whether you may call data
  routes; `enabled` says that.
- `status` — `starting` | `running` | `port_conflict` | `error`.
- `enabled` — the API switch in Settings → API + MCP.
- `authRequired` — `enabled` and unauthenticated access off.
- `authConfigured` — a token exists. Never the token itself.
- `tokenSource` — `env` | `store` | `none`.

A 200 whose body is not this shape means a different program owns the port.
Check the field names, not just the status code.

---

## GET /api/v1/projects

```json
{
  "currentId": "9f0c…",
  "projects": [
    {
      "id": "9f0c…",
      "name": "Acme",
      "scenario": "research",
      "createdAt": "2026-05-02T10:11:12.000Z",
      "updatedAt": "2026-08-20T08:00:00.000Z",
      "isCurrent": true
    }
  ]
}
```

`currentId` is `null` on a workspace that has not created a project yet. `current`
still works as an id — it addresses the flat page tree.

---

## GET /api/v1/projects/{id}/files

Query: `root=all` (default) | `wiki` | `raw` | `sources`. `sources` is an alias
for `raw`.

```json
{
  "wikiId": "current",
  "root": "all",
  "files": ["purpose.md", "schema.md", "wiki/acme.md", "raw/sources/notes/ab12.md"],
  "truncated": false
}
```

Paths are always tree-relative, whatever `root` you asked for — pass them back to
`files/content` unchanged.

**413 `tree_too_large`** when the tree exceeds 10 000 nodes. Narrow with `root`.

---

## GET /api/v1/projects/{id}/files/content

Query: `path=` — a path exactly as `files` returned it.

```json
{ "wikiId": "current", "path": "wiki/acme.md", "content": "# Acme\n…", "bytes": 4096 }
```

| Status | Body | Meaning |
| --- | --- | --- |
| 403 | `out_of_scope` | The path is outside `purpose.md`, `schema.md`, `wiki/`, `raw/`. |
| 415 | `unsupported_media_type` | Not a text extension. |
| 413 | `too_large` | Over 1 MB. |
| 404 | `not_found` | Allowed, but no such file. |

403 and 404 are different answers: one is a permission boundary, the other is an
absence. Do not retry a 403 with a different spelling.

---

## POST /api/v1/projects/{id}/search

```json
{ "query": "quarterly planning", "topK": 10, "includeContent": false }
```

```json
{
  "query": "quarterly planning",
  "topK": 10,
  "mode": "wiki",
  "tokenHits": 3,
  "vectorHits": 0,
  "results": [
    {
      "path": "wiki/quarterly-planning.md",
      "title": "Quarterly planning",
      "snippet": "…",
      "score": 8.5,
      "titleMatch": true
    }
  ],
  "hits": [{ "path": "…", "title": "…", "snippet": "…", "score": 8.5 }],
  "vectorPhase": { "status": "off" }
}
```

Read `results`. (`hits` and `vectorPhase` are the in-app surface's fields, carried
on the same response; they describe the same rows.)

- `topK` is clamped to 50.
- `includeContent: true` adds each hit's full page text. Large — prefer
  `files/content` for one page.
- An empty `results` array means the wiki has no coverage. Say that.
- 400 `query is required` for an empty query. It is never answered as zero
  results, because "nothing found" would be a false statement about the wiki.

---

## GET /api/v1/projects/{id}/reviews

Query: `status=open` (default) | `all`.

```json
{
  "wikiId": "current",
  "status": "open",
  "pendingCount": 2,
  "reviews": [
    {
      "id": "rv_1",
      "kind": "lightbulb",
      "title": "No page covers onboarding",
      "summary": "Three sources mention onboarding; no page compiles them.",
      "path": "raw/sources/kickoff/ab12.md",
      "queries": ["onboarding checklist"],
      "status": "pending",
      "resolved": false,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

## PATCH /api/v1/projects/{id}/reviews/{reviewId}

```json
{ "action": "create_page" }
```

| Body | Effect |
| --- | --- |
| `{ "action": "skip" }` or `{ "resolved": true }` | Dismiss. |
| `{ "resolved": false }` | Reopen a dismissed review. |
| `{ "action": "create_page" }` | Compile the suggested page. Returns its `slug`. |
| `{ "action": "deep_research" }` | Create a **draft** research project. Returns `research` and `confirmRequired: true`. Does not run. |

An unknown action is 400 `unknown_action`. Reopening something already created is
409 `not_reopenable`.

`deep_research` has **two different 400s**, and they ask for opposite things:

- 400 `invalid_input` — the store refused one of the values it was given, with
  the explanation in `detail`. Note that this call sends the store the **stored
  review row**, not fields from your body: the research title and question come
  from the review's own title and summary. So when `detail` names one of those,
  resending the same call unchanged will not clear it either — the review itself
  has to change first.
- 400 `limit_reached` — the workspace already holds the maximum research
  projects, with the store's sentence in `detail`. The request was fine.
  **Do not retry it unchanged** — no edit to the body can clear this. The cap is
  per workspace owner, so another `{id}` answers the same refusal. Clearing it
  means deleting a research project, which no `/api/v1` route can do: this one
  has to be resolved outside the API.

When the research store is simply contended, `deep_research` is 503 and nothing
was written: retry it. That 503 carries **no token** — `error` is the store's own
sentence, not a string to branch on — so do not confuse it with the 503 `busy`
below, which is the concurrency shed and is a different refusal.

## POST /api/v1/projects/{id}/reviews/resolve

Bulk skip. Body `{ "ids": ["rv_1"], "action": "skip" }`. `create_page` and
`deep_research` are per-review only.

```json
{ "resolved": ["rv_1"], "notFound": [], "count": 1 }
```

Reopen is `PATCH /api/v1/projects/{id}/reviews` with `{ "ids": [...], "resolved": false }`.

---

## GET /api/v1/projects/{id}/graph

Query: `limit=` (default 500, clamped to 1000).

```json
{
  "wikiId": "current",
  "truncated": false,
  "nodeCount": 42,
  "nodes": [{ "id": "acme", "label": "Acme", "nodeType": "concept", "path": "wiki/acme.md", "linkCount": 3 }],
  "edges": [{ "source": "acme", "target": "onboarding", "weight": 1.0 }]
}
```

Wikilink edges only. `weight` is always `1.0`. This is not the Workbench 4-signal graph.

When the node cap cuts the graph, the most-linked nodes survive and every edge
still points at two nodes that are present.

---

## POST /api/v1/projects/{id}/sources/rescan

```json
{ "paths": ["raw/sources/kickoff/ab12.md"] }
```

Omit `paths` to rescan every source, up to 25 per call.

```json
{
  "wikiId": "current",
  "requested": 1,
  "queued": 1,
  "remaining": 0,
  "results": [{ "path": "raw/sources/kickoff/ab12.md", "queued": true, "jobId": "…" }]
}
```

- `remaining` is what the cap left for a follow-up call.
- A path outside `raw/` is 403 `out_of_scope`, and one bad path fails the whole
  call rather than being skipped silently.
- More than 25 named paths is 400 `too_many_paths`, carrying `limit`. This is
  the **request-shaped** cap: name fewer paths and the retry succeeds. Its
  workspace-state sibling is `limit_reached` on `deep_research` above, which
  says the workspace itself is full — **never retry a `limit_reached` request
  unchanged**, because nothing in the request can clear it.
- A `paths` that is not an array of strings is 400 `invalid_input`, with the
  explanation in `detail`.
- `queued: false` with `reason: "queue_unavailable"` means the compile was not
  scheduled. It is not a success.

---

## POST /api/v1/projects/{id}/chat

```json
{ "query": "What did we decide about pricing?", "tools": true }
```

Streams Server-Sent Events when `Accept: text/event-stream`, else answers one
JSON object. Five event names, and no others: `meta`, `agent`, `done`,
`cancelled`, `error`. Tool-call rows and approval prompts ride inside those
payloads.

```json
{
  "content": "…",
  "citations": [{ "n": 1, "path": "wiki/pricing.md", "title": "Pricing", "type": "page" }],
  "coverage": true,
  "toolCalls": [{ "id": "t1", "tool": "wiki_search", "detail": "4 hits" }],
  "outputs": []
}
```

`coverage: false` means the wiki had nothing to answer from. On the cloud
deployment this route answers 503 `sidecar_required`.

---

## Refusals, everywhere

| Status | Body | Meaning |
| --- | --- | --- |
| 503 | `disabled` | API switched off in Settings. `/health` still answers. |
| 401 | `unauthorized` | Missing or wrong token. |
| 503 | `busy` | 64 requests already in flight. Retry. |
| 429 | `rate_limited` | Over 120 requests in a second. Back off. |
| 400 | `body_too_large` | Request body over 1 MB. |
| 400 | `invalid_wiki_id` | `{id}` is not `current` or a UUID. |
| 404 | `wiki_not_found` | No project with that id. |
| 503 | `kernel_unreachable` | The sidecar cannot reach the wiki store. |
