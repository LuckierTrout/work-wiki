---
name: work-wiki
description: Read and query a local work-wiki workspace over its loopback API at 127.0.0.1:19828. Use when the user asks about their wiki, their notes, their sources, or their meetings; when they ask what the wiki says about something; or when they want a source re-compiled. Health-first — check that the API is on before anything else.
---

# work-wiki

A work-wiki workspace is one person's second brain: pages compiled from sources
they collected. This skill reads that workspace through a local HTTP API on
`127.0.0.1:19828`. Nothing here reaches the network.

## Check health first — every session

```
GET http://127.0.0.1:19828/api/v1/health
```

`/health` is the only route that answers while the API is switched off, and its
body tells you which of four situations you are in:

| What you see | What it means | What to do |
| --- | --- | --- |
| Connection refused | The sidecar is not running. | Ask the user to run `pnpm sidecar`. Stop. |
| 200, but not this JSON shape | Something else owns port 19828. | Say so. Do not describe a wiki. Stop. |
| `enabled: false` | The API is off in Settings → API + MCP. | Ask the user to switch it on. Stop. |
| `authRequired: true`, `authConfigured: false` | No token has been generated. | Ask the user to press Generate in Settings. Stop. |
| `enabled: true`, and a token if required | Ready. | Continue. |

Each of those is a sentence the user can act on. Retrying a call in any of the
first four states will keep failing for a reason the API has already told you.

## Authentication

Send the token as a bearer header:

```
Authorization: Bearer <token>
```

The token comes from Settings → API + MCP (or from the `LLM_WIKI_API_TOKEN`
environment variable, which overrides the stored one). Never put it in a URL:
`?token=` is supported for clients that cannot set headers, and it ends up in
logs and screenshots.

If the user has switched on "allow unauthenticated", calls work without a token.
Do not assume that — `authRequired` in `/health` tells you.

## Projects: use `current`

Every data route takes a project id. Use `current` unless the user named a
different project.

```
GET /api/v1/projects
```

Returns each project with `id`, `name` and `isCurrent`, plus a top-level
`currentId`. Only look this up when the user says something like "in my Acme
wiki" — guessing a UUID, or picking a project the user did not name, writes into
or reads from the wrong workspace.

## The routes

Full request and response shapes: [api-reference.md](api-reference.md).
Worked examples: [examples.md](examples.md).

| Route | Use it for |
| --- | --- |
| `GET /api/v1/health` | Readiness. First call, always. |
| `GET /api/v1/projects` | Which projects exist. |
| `GET /api/v1/projects/{id}/files` | What pages and sources exist. |
| `GET /api/v1/projects/{id}/files/content?path=` | One file's text. |
| `POST /api/v1/projects/{id}/search` | Find pages by topic. |
| `GET /api/v1/projects/{id}/reviews` | Gaps the wiki raised about itself. |
| `PATCH /api/v1/projects/{id}/reviews/{reviewId}` | Resolve or reopen one review. |
| `GET /api/v1/projects/{id}/graph` | How pages link to each other. |
| `POST /api/v1/projects/{id}/sources/rescan` | Re-compile stored sources. |
| `POST /api/v1/projects/{id}/chat` | Ask the local Agent (see below). |

## Citing

Cite the exact `path` a tool returned — `wiki/quarterly-planning.md`, not a
title you rephrased. `search` returns paths; `files` returns paths; use those
strings.

## Never fabricate

If `search` returns no results, the wiki has no coverage for that topic. Say so.
Do not answer from your own knowledge and present it as what the wiki says: the
whole value of this workspace is that its pages came from the user's own sources,
and an answer they cannot trace back to a path is worse than no answer.

The same applies to paths. If `files/content` answers 404, that file does not
exist — do not try neighbouring spellings and describe whatever you find.

## Writing

There is no page-write route here, on purpose. Wiki pages are written by the
compile pipeline so that provenance and versioning hold; an API that let you
write one directly would produce a page with no source.

Two things do change state, and both are safe:

- `sources/rescan` queues a re-compile of bytes that are already stored. It
  cannot remove or overwrite a source. Unchanged sources are skipped by the
  pipeline itself.
- `reviews/{id}` PATCH resolves, reopens, creates a page from, or opens research
  for one review — the same four actions the user has in the app.

`deep_research` on a review creates a **draft** research project and does not run
it. Running research spends the user's search-provider budget, and starting one
without them pressing confirm would be spending it on their behalf.

## The Chat route

`POST /api/v1/projects/{id}/chat` reaches the workspace's own Agent, which has
tools of its own (wiki search, source search, graph, workspace files, shell with
approval). Use it when the user wants the wiki's own reasoning rather than raw
data — "what does my wiki think about X" rather than "find pages about X".

It requires the sidecar. On the cloud deployment it answers 503
`sidecar_required`: the Agent runs on the user's machine or nowhere.

## Limits, and what they mean

- `topK` above 50 is clamped, not refused — you get 50 results.
- `graph?limit=` above 1000 is clamped the same way.
- A file over 1 MB answers 413 `too_large`. Search its page instead.
- A non-text file answers 415 `unsupported_media_type`. PDFs and images are
  stored as bytes; their extracted text is a separate file under `raw/`.
- 503 `busy` or 429 `rate_limited` means back off and retry, not that anything is
  wrong.
