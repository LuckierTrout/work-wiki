import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../mcp";

// ---------------------------------------------------------------------------
// Helper — access the private _registeredTools map via runtime property access
// ---------------------------------------------------------------------------

interface ToolEntry {
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

function getRegisteredTools(
  server: ReturnType<typeof createMcpServer>,
): Record<string, ToolEntry> {
  // _registeredTools is private in TypeScript but accessible at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools as Record<string, ToolEntry>;
}

describe("MCP tool annotations", () => {
  const server = createMcpServer();
  const tools = getRegisteredTools(server);

  // 42 after publish_to_commons, the five discussion tools (retired with the
  // commons and with talk, AD-21), and reconcile_page (reconcile-from-talk
  // retired) were removed.
  it("registers exactly 42 tools", () => {
    expect(Object.keys(tools)).toHaveLength(42);
  });

  // The tool retirements left the count hand-written in two places, where it
  // silently went stale. Both are read by agent integrators —
  // `public/agent-api.md` is served at `/agent-api` — so pin them to the real
  // registration count rather than to another hand-written number.
  it.each([
    ["public/agent-api.md", "public/agent-api.md"],
    ["src/lib/mcp-http.ts", "src/lib/mcp-http.ts"],
  ])("%s documents the real tool count", async (_label, relative) => {
    const { readFile } = await import("fs/promises");
    const path = await import("path");
    const text = await readFile(
      path.resolve(__dirname, "../../..", relative),
      "utf8",
    );
    // Strip JSDoc gutters and collapse wrapping so a count that wraps onto the
    // next comment line ("All 43\n * tools are exposed") is still seen.
    const flat = text.replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ");
    const documented = [...flat.matchAll(/\b(\d+) tools\b/g)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    for (const count of documented) {
      expect(Number(count)).toBe(Object.keys(tools).length);
    }
  });

  it.each([
    "publish_to_commons",
    "list_discussions",
    "read_discussion",
    "create_discussion",
    "add_comment",
    "resolve_discussion",
    "reconcile_page",
  ])("no longer exposes %s", (retired) => {
    expect(Object.keys(tools)).not.toContain(retired);
  });

  it("every tool has explicit destructiveHint and idempotentHint", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.annotations, `${name} missing annotations`).toBeDefined();
      expect(
        typeof tool.annotations!.destructiveHint,
        `${name} missing destructiveHint`,
      ).toBe("boolean");
      expect(
        typeof tool.annotations!.idempotentHint,
        `${name} missing idempotentHint`,
      ).toBe("boolean");
    }
  });

  it("every tool has explicit readOnlyHint and openWorldHint", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(
        typeof tool.annotations!.readOnlyHint,
        `${name} missing readOnlyHint`,
      ).toBe("boolean");
      expect(
        typeof tool.annotations!.openWorldHint,
        `${name} missing openWorldHint`,
      ).toBe("boolean");
    }
  });

  // Requirement 1: destructiveHint: true on delete tools only
  it("delete_page has destructiveHint: true", () => {
    expect(tools["delete_page"].annotations!.destructiveHint).toBe(true);
  });

  it("delete_agent has destructiveHint: true", () => {
    expect(tools["delete_agent"].annotations!.destructiveHint).toBe(true);
  });

  // Requirement 2: destructiveHint: false on all non-delete write tools
  const nonDestructiveWriteTools = [
    "create_page",
    "update_page",
    "ingest_url",
    "batch_ingest_urls",
    "ingest_text",
    "ingest_pdf",
    "save_query_answer",
    "seed_agent",
    "update_agent",
    "fix_lint_issue",
    "reingest",
    "revert_revision",
  ];

  it.each(nonDestructiveWriteTools)(
    "%s has destructiveHint: false",
    (toolName) => {
      expect(tools[toolName].annotations!.destructiveHint).toBe(false);
    },
  );

  // Requirement 3: idempotentHint: true on all read-only tools
  const readOnlyTools = [
    "search_wiki",
    "read_page",
    "list_pages",
    "query_wiki",
    "agent_context",
    "list_agents",
    "lint_wiki",
    "dataview_query",
    "list_revisions",
    "read_revision",
    "list_contributors",
    "get_contributor",
  ];

  it.each(readOnlyTools)(
    "%s has readOnlyHint: true and idempotentHint: true",
    (toolName) => {
      expect(tools[toolName].annotations!.readOnlyHint).toBe(true);
      expect(tools[toolName].annotations!.idempotentHint).toBe(true);
    },
  );

  // Requirement 4: seed_agent is idempotent
  it("seed_agent has idempotentHint: true (creates or updates)", () => {
    expect(tools["seed_agent"].annotations!.idempotentHint).toBe(true);
    expect(tools["seed_agent"].annotations!.readOnlyHint).toBe(false);
  });

  // Verify openWorldHint preserved for ingest_url
  it("ingest_url retains openWorldHint: true", () => {
    expect(tools["ingest_url"].annotations!.openWorldHint).toBe(true);
  });
});
