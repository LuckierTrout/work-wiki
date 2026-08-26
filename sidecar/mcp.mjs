#!/usr/bin/env node
/**
 * The stock loopback MCP wrap (Story 8.3).
 *
 * WHAT IT IS: a thin stdio MCP server that forwards each tool call to the
 * loopback `/api/v1` door on `127.0.0.1:19828`. It holds no wiki logic, no
 * storage and no model. Every answer is the door's JSON, verbatim.
 *
 * WHY IT IS NOT `src/mcp.ts`: that server is the CLOUD catalog — forty-odd
 * write-capable tools that import `src/lib` and run inside the kernel's own
 * process. This one is what an off-the-shelf MCP client on the owner's laptop
 * spawns, and it deliberately exposes the FR-76 READ surface plus the two verbs
 * FR-76 names (`rescan`, `chat`). Replacing the cloud catalog with this, or
 * growing this into that, would give one of them the wrong reach: the cloud
 * catalog writes pages, and a stock client pointed at the loopback door should
 * not be able to.
 *
 * THE SERVER NAME STAYS `yopedia` — a frozen identifier. Already-installed
 * clients key their config on it.
 *
 * IT NEVER PARSES THE WIKI ITSELF. When the door answers 503 `disabled` or 401
 * `unauthorized`, that sentence is what the client sees, because "switched off in
 * Settings" is an instruction the owner can act on and an empty result set is
 * not.
 *
 * Imports nothing from `src/lib` (AD-6). The two constants it shares with the
 * door come from `loopback.mjs`, which is the sidecar's own copy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  LOOPBACK_HOST,
  LOOPBACK_PORT,
  LOOPBACK_TOKEN_ENV,
} from "./loopback.mjs";

export const MCP_SERVER_NAME = "yopedia";
export const MCP_BASE_URL = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`;

/**
 * What the client is told before it calls anything.
 *
 * HEALTH FIRST is the whole instruction, and it is here rather than in a README
 * because a stock client reads this and nothing else. `authConfigured: false`
 * means the owner has not generated a token — retrying the call is useless, and
 * saying so is the difference between one clear sentence and a loop of 401s.
 */
export const MCP_INSTRUCTIONS = [
  "This server reads one work-wiki workspace over its local loopback API.",
  "",
  "Call `health` first. If `enabled` is false the owner has switched the API off",
  "in Settings → API + MCP. If `authRequired` is true and `authConfigured` is",
  "false, no token has been generated yet — say so and stop rather than retrying.",
  "",
  "Use `current` as the project id unless the owner named another project.",
  "Cite pages by the exact `path` a tool returned. Never invent a path, a page or",
  "a citation: if a search returns nothing, the wiki has no coverage for it.",
].join("\n");

/**
 * One call to the door.
 *
 * THE TOKEN COMES FROM THE ENVIRONMENT ONLY. The copyable config in Settings
 * puts it in `env`, so it never enters a URL, a shell history or a screenshot —
 * and this file never logs it, on any path.
 *
 * A refused TCP connection is reported as "the sidecar is not running", which is
 * the one diagnosis the client cannot reach on its own: every other failure
 * arrives as an HTTP status with a body.
 *
 * @param {string} pathname
 * @param {{
 *   method?: string,
 *   body?: unknown,
 *   token?: string,
 *   fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
 * }} [options]
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function callDoor(
  pathname,
  { method = "GET", body, token = process.env[LOOPBACK_TOKEN_ENV], fetchImpl = fetch } = {},
) {
  let response;
  try {
    response = await fetchImpl(`${MCP_BASE_URL}${pathname}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return {
      ok: false,
      text: `Could not reach the work-wiki sidecar at ${MCP_BASE_URL}. Start it with \`pnpm sidecar\`.`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    // The door's own words. `disabled`, `unauthorized`, `busy`, `rate_limited`
    // are all actionable, and paraphrasing them here would lose that.
    return { ok: false, text: `HTTP ${response.status}: ${text}` };
  }
  return { ok: true, text };
}

/** MCP's content envelope, so every tool below is one line. */
function reply(result) {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  };
}

const projectId = z
  .string()
  .optional()
  .describe("Project id, or `current` for the active project. Default: current");

function idOf(args) {
  const value = typeof args.project === "string" ? args.project.trim() : "";
  return encodeURIComponent(value || "current");
}

/**
 * The FR-76 tool set, and nothing else.
 *
 * SEVEN TOOLS, matching the door's seven capabilities one-for-one. There is no
 * page-write tool and no settings tool: the door does not expose them, so a wrap
 * that offered them would be advertising a call that can only fail.
 */
export function registerLoopbackTools(server, { call = callDoor } = {}) {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    "health",
    {
      description:
        "Is the local work-wiki API reachable, switched on, and does it need a token? Call this first.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => reply(await call("/api/v1/health")),
  );

  server.registerTool(
    "projects",
    {
      description: "List the wiki projects in this workspace and which one is current.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => reply(await call("/api/v1/projects")),
  );

  server.registerTool(
    "files",
    {
      description:
        "List readable file paths in a project. Use `root` to narrow to wiki pages or sources.",
      inputSchema: {
        project: projectId,
        root: z
          .enum(["all", "wiki", "raw", "sources"])
          .optional()
          .describe("Default: all"),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await call(
          `/api/v1/projects/${idOf(args)}/files${args.root ? `?root=${encodeURIComponent(args.root)}` : ""}`,
        ),
      ),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read one text file by the exact path `files` returned, e.g. wiki/alpha.md.",
      inputSchema: {
        project: projectId,
        path: z.string().describe("Tree-relative path, exactly as `files` returned it"),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await call(
          `/api/v1/projects/${idOf(args)}/files/content?path=${encodeURIComponent(args.path)}`,
        ),
      ),
  );

  server.registerTool(
    "search",
    {
      description:
        "Search the wiki. Returns paths, titles and snippets. An empty result means the wiki has no coverage.",
      inputSchema: {
        project: projectId,
        query: z.string().describe("What to search for"),
        topK: z.number().optional().describe("Maximum hits (clamped to 50). Default: 10"),
        includeContent: z
          .boolean()
          .optional()
          .describe("Include each hit's full page text. Large; default false"),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await call(`/api/v1/projects/${idOf(args)}/search`, {
          method: "POST",
          body: {
            query: args.query,
            ...(args.topK === undefined ? {} : { topK: args.topK }),
            ...(args.includeContent === undefined
              ? {}
              : { includeContent: args.includeContent }),
          },
        }),
      ),
  );

  server.registerTool(
    "reviews",
    {
      description:
        "Export the Review queue: suggestions the wiki raised about its own gaps.",
      inputSchema: {
        project: projectId,
        status: z
          .enum(["open", "all"])
          .optional()
          .describe("`all` includes already-resolved reviews. Default: open"),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await call(
          `/api/v1/projects/${idOf(args)}/reviews${args.status ? `?status=${args.status}` : ""}`,
        ),
      ),
  );

  server.registerTool(
    "graph",
    {
      description: "The wiki's link graph: nodes and edges between pages.",
      inputSchema: {
        project: projectId,
        limit: z.number().optional().describe("Maximum nodes (clamped to 1000). Default: 500"),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await call(
          `/api/v1/projects/${idOf(args)}/graph${args.limit === undefined ? "" : `?limit=${args.limit}`}`,
        ),
      ),
  );

  server.registerTool(
    "rescan_sources",
    {
      description:
        "Queue a re-compile of stored sources. Writes no sources; unchanged ones are skipped by the pipeline.",
      inputSchema: {
        project: projectId,
        paths: z
          .array(z.string())
          .optional()
          .describe("Specific source paths under raw/. Absent means every source, up to the cap"),
      },
      annotations: {
        readOnlyHint: false,
        // NOT destructive: it schedules compiles over bytes that already landed
        // and cannot remove or overwrite a Source. Marking it destructive would
        // train clients to ask before a safe call.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      reply(
        await call(`/api/v1/projects/${idOf(args)}/sources/rescan`, {
          method: "POST",
          body: args.paths ? { paths: args.paths } : {},
        }),
      ),
  );

  server.registerTool(
    "chat",
    {
      description:
        "Ask the wiki's local Chat Agent a question. Requires the sidecar; answers cite wiki paths.",
      inputSchema: {
        project: projectId,
        query: z.string().describe("The question"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        // OPEN WORLD: the Agent may search the web mid-turn. Saying so is what
        // lets a client decide whether this call is appropriate.
        openWorldHint: true,
      },
    },
    async (args) =>
      reply(
        await call(`/api/v1/projects/${idOf(args)}/chat`, {
          method: "POST",
          // `tools: true` — this is the Agent, not a bare completion. A wrap that
          // sent the Epic 3 retrieve-then-chat shape would hand over an empty
          // context and get the honest "no coverage" answer every time.
          body: { query: args.query, tools: true, allowWrites: false },
        }),
      ),
  );

  return server;
}

export function createLoopbackMcpServer({ version = "1.0.0" } = {}) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    { instructions: MCP_INSTRUCTIONS },
  );
  return registerLoopbackTools(server);
}

// Started by a client as `node sidecar/mcp.mjs` over stdio. Nothing is written to
// stdout except the protocol — a stray `console.log` here corrupts the stream.
if (process.argv[1] && process.argv[1].endsWith("mcp.mjs")) {
  const server = createLoopbackMcpServer();
  await server.connect(new StdioServerTransport());
}
