# work-wiki Agent Skill

The branded Agent Skill pack for a local work-wiki workspace. It teaches an agent
to read one person's wiki over the loopback API on `127.0.0.1:19828` — health
first, `current` as the project id, cite the exact paths, never invent a page.

## Files

| File | What it is |
| --- | --- |
| `SKILL.md` | The skill itself: when to use it, the readiness checks, the rules. |
| `api-reference.md` | Every route, request shape, response shape and refusal. |
| `examples.md` | Worked `curl` sessions, including the failure cases. |

## Install

Copy the directory to wherever your agent looks for skills:

```bash
cp -R skills/work-wiki ~/.claude/skills/work-wiki
```

Settings → API + MCP shows this command with the right destination for your
setup. The pack is files — there is nothing to build and nothing to download.

A copy under `~/.workwiki/skills/` is also picked up by the in-app Chat Agent as
a user Skill, and the copy in this repo is picked up as a project Skill.

## Prerequisites

1. The sidecar is running: `pnpm sidecar`.
2. The API is on: Settings → API + MCP → Enable local API → Save.
3. A token exists: press Generate on the same pane, then copy it. Or set
   `LLM_WIKI_API_TOKEN` in the environment, which overrides the stored one.

Skipping any of these is not a silent failure — `/api/v1/health` reports which
one is missing, and `SKILL.md` opens by telling the agent to read it.

## This is not the MCP server

Two ways in, for different clients:

- **This pack** — for an agent that makes HTTP calls itself.
- **`sidecar/mcp.mjs`** — a stdio MCP server wrapping the same routes as tools,
  for an MCP client. Settings → API + MCP has the copyable config.

Both talk to the same door and are bound by the same switch and the same token.
Neither can write a wiki page: pages are written by the compile pipeline so their
provenance holds.

## Relationship to the stock nashsu skill

A stock `llm_wiki` skill also works against this door for reads and rescans — the
route shapes are compatible on purpose. What it does not know about is
`POST /chat`, which is this fork's local Agent. That is documented here instead.
