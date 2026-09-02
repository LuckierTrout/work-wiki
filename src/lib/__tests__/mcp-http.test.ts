import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * Spy — NOT stub — on the lint-fix dispatcher: the factory spreads
 * `importOriginal`, so every tool below still runs the real implementation.
 * The wrapper exists for the `fix_lint_issue` gate rows (DW-348), which have to
 * tell "the door refused" from "the dispatcher refused". The two answer with
 * the SAME sentence — `autoFixRefusal` owns it and both read from it — so the
 * call record is the only thing that separates them.
 */
vi.mock("../lint-fix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lint-fix")>();
  return { ...actual, fixLintIssue: vi.fn(actual.fixLintIssue) };
});

import {
  dispatchMcp,
  MCP_TOOLS,
  MCP_MAX_BATCH,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  _internal,
} from "../mcp-http";
import {
  ensureDirectories,
  readWikiPageWithFrontmatter,
  writeWikiPage,
} from "../wiki";
import { listRevisions, readRevision, saveRevision } from "../revisions";
import { _resetStorage } from "../storage";
import { createVault, vaultSlugs } from "../vault";
import { registerAgent } from "../agents";
import type { Principal } from "../auth";
import type { Frontmatter } from "../frontmatter";
import { WRITE_DENIAL_REALM } from "../write-denial";
import { fixLintIssue } from "../lint-fix";
import { AUTO_FIXABLE_CHECK_TYPES } from "../lint-types";

const spiedFixLintIssue = vi.mocked(fixLintIssue);

const ALICE: Principal = { id: "agent:a--yoyo", handle: "alice" };
const BOB: Principal = { id: "user:bob", handle: "bob" };

// Most cases exercise the JSON-RPC envelope + auth gating, which need no
// storage/LLM (a write tool is rejected BEFORE its handler runs when there's no
// principal). The reingest-ACL case touches storage, so set up a temp wiki.
let tmpDir: string;
let prevWiki: string | undefined;
let prevRaw: string | undefined;
let prevData: string | undefined;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-test-"));
  prevWiki = process.env.WIKI_DIR;
  prevRaw = process.env.RAW_DIR;
  prevData = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
});
afterEach(async () => {
  process.env.WIKI_DIR = prevWiki;
  process.env.RAW_DIR = prevRaw;
  process.env.DATA_DIR = prevData;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("dispatchMcp — protocol", () => {
  it("initialize returns protocol version + serverInfo + tools capability", async () => {
    const res = await dispatchMcp({ id: 1, method: "initialize" }, null);
    expect(res).not.toBeNull();
    expect(res!.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
    });
  });

  it("ping returns an empty result", async () => {
    const res = await dispatchMcp({ id: 2, method: "ping" }, null);
    expect(res!.result).toEqual({});
  });

  it("notifications get no response (null)", async () => {
    expect(await dispatchMcp({ method: "notifications/initialized" }, null)).toBeNull();
  });

  it("unknown method is a JSON-RPC method-not-found error", async () => {
    const res = await dispatchMcp({ id: 3, method: "frobnicate" }, null);
    expect(res!.error?.code).toBe(-32601);
  });

  it("echoes the request id (incl. null)", async () => {
    const res = await dispatchMcp({ id: "abc", method: "ping" }, null);
    expect(res!.id).toBe("abc");
  });
});

describe("dispatchMcp — tools/list", () => {
  it("lists the curated tools with name/description/inputSchema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_wiki");
    expect(names).toContain("query_wiki");
    expect(names).toContain("ingest_url");
    expect(names).toContain("ingest_text");
    expect(names).toContain("agent_context");
    expect(names).toContain("dataview_query");
    expect(names).toContain("wiki_graph");
    expect(names).toContain("activity_trail");
    expect(names).toContain("ingest_history");
    expect(names).toContain("delete_agent");
    expect(names).toContain("vault_delete");
    expect(names).toContain("vault_rename");
    expect(names).toContain("query_history");
    expect(names).toContain("ingest_image");
    expect(names).toContain("ingest_pdf");
    expect(names).toContain("ingest_x_mention");
    // Every descriptor carries a schema; the internal `write`/`run` fields are
    // NOT leaked to the wire.
    for (const t of tools) {
      expect(t.inputSchema).toBeTypeOf("object");
      expect(t).not.toHaveProperty("write");
      expect(t).not.toHaveProperty("run");
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP ↔ stdio parity
// ---------------------------------------------------------------------------
// `mcp-http.ts`'s header promises "full parity with the stdio MCP server", but
// the two tool sets are maintained by hand in separate files (`MCP_TOOLS` here,
// `server.registerTool` calls in `src/mcp.ts`). The existing guards only compare
// `mcp.json` against the stdio registrations and grep a prose count, so a tool
// added or retired on one side alone slipped through. Pin the two directly.
describe("MCP_TOOLS ↔ stdio registration parity", () => {
  it("exposes exactly the tools createMcpServer() registers", async () => {
    const { createMcpServer } = await import("../../mcp");
    const server = createMcpServer();
    // _registeredTools is private in TypeScript but accessible at runtime —
    // same idiom as mcp-annotations.test.ts / the mcp.json manifest-sync test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stdioNames = Object.keys((server as any)._registeredTools);
    const httpNames = MCP_TOOLS.map((t) => t.name);

    const stdioSet = new Set(stdioNames);
    const httpSet = new Set(httpNames);

    const missingFromHttp = stdioNames.filter((n) => !httpSet.has(n));
    const extraInHttp = httpNames.filter((n) => !stdioSet.has(n));

    expect(
      missingFromHttp,
      `stdio registers tools the HTTP endpoint does not expose: ${missingFromHttp.join(", ")}`,
    ).toEqual([]);
    expect(
      extraInHttp,
      `HTTP endpoint exposes tools the stdio server does not register: ${extraInHttp.join(", ")}`,
    ).toEqual([]);

    // No duplicate descriptors on the HTTP side (the first would win silently).
    expect(httpNames.length).toBe(httpSet.size);
    expect([...httpNames].sort()).toEqual([...stdioNames].sort());
  });

  // The door's argument gate (DW-563) reads `required` and `properties` off
  // these same schemas, so a `required` name with no matching property would
  // make a tool permanently uncallable — every request refused for a field the
  // caller cannot supply, because nothing advertises it. Cheap to typo, and
  // invisible until an agent hits it, so pin the shape rather than the tools.
  it("declares every `required` name as a property on every tool", () => {
    const broken: string[] = [];
    for (const tool of MCP_TOOLS) {
      const schema = tool.inputSchema as {
        required?: unknown;
        properties?: Record<string, unknown>;
      };
      const required = Array.isArray(schema.required) ? schema.required : [];
      const properties = schema.properties ?? {};
      for (const name of required) {
        if (!Object.prototype.hasOwnProperty.call(properties, name as string)) {
          broken.push(`${tool.name}.${String(name)}`);
        }
      }
    }

    expect(
      broken,
      `required names with no declared property: ${broken.join(", ")}`,
    ).toEqual([]);
  });

  // The gate can only decide a declared type `jsonType` can return, and it
  // SKIPS anything else rather than refusing — the safe direction, because
  // comparing against a type `jsonType` never returns (`"integer"`, or a union
  // like `["string","null"]`) would refuse every value for that field and make
  // the tool permanently uncallable. Skipping is silent, though, so a schema
  // edit could quietly drop a field out of the gate with nothing to show for
  // it. This is what makes that visible: today every declared type is one the
  // gate decides, and a future `"integer"` has to come here and say so.
  it("declares only types the argument gate can decide", () => {
    const decidable = new Set(["string", "number", "boolean", "object", "array"]);
    const primitives = new Set(["string", "number", "boolean"]);
    const undecidable: string[] = [];

    for (const tool of MCP_TOOLS) {
      const properties =
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const [name, declaration] of Object.entries(properties)) {
        const decl = declaration as { type?: unknown; items?: unknown };
        if (!decidable.has(decl.type as string)) {
          undecidable.push(`${tool.name}.${name}: ${JSON.stringify(decl.type)}`);
          continue;
        }
        if (decl.type !== "array") continue;
        const itemType = (decl.items as { type?: unknown } | undefined)?.type;
        // `"object"` is the deliberate pass-through case: element-level
        // `required` is out of this gate's scope, so object arrays go to the
        // handler unchecked. Anything OTHER than that or a primitive is an
        // element type nothing decides and nothing meant to skip.
        if (itemType !== "object" && !primitives.has(itemType as string)) {
          undecidable.push(`${tool.name}.${name}[]: ${JSON.stringify(itemType)}`);
        }
      }
    }

    expect(
      undecidable,
      `declared types the gate silently skips: ${undecidable.join(", ")}`,
    ).toEqual([]);
  });

  // Matching names is not parity on its own: `ToolDef.write` is what gates the
  // HTTP side (auth requirement in `dispatchMcp`, the vault-filing suffix on
  // write-tool descriptions), and its stdio counterpart is
  // `annotations.readOnlyHint`. A tool whose two flags disagree passes the
  // name check above while behaving differently on each transport.
  it("agrees with the stdio readOnlyHint annotation on every tool's write flag", async () => {
    const { createMcpServer } = await import("../../mcp");
    const server = createMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server as any)._registeredTools as Record<
      string,
      { annotations?: { readOnlyHint?: boolean } }
    >;

    const disagreements = MCP_TOOLS.filter((t) => {
      const readOnlyHint = registered[t.name]?.annotations?.readOnlyHint;
      // An absent hint is its own drift — every tool declares one today.
      return readOnlyHint === undefined || t.write === readOnlyHint;
    }).map(
      (t) =>
        `${t.name} (write: ${t.write}, readOnlyHint: ${registered[t.name]?.annotations?.readOnlyHint})`,
    );

    expect(
      disagreements,
      `write flag disagrees with the stdio readOnlyHint annotation: ${disagreements.join(", ")}`,
    ).toEqual([]);
  });
});

describe("dispatchMcp — tools/call auth gating", () => {
  it("rejects an unknown tool as an isError result (not a crash)", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/i);
  });

  it("blocks a WRITE tool when unauthenticated (principal=null) before running it", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "ingest_url", arguments: { url: "https://example.com" } } },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("reingest denies (cloaked) a missing/unauthorized page before any fetch", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "reingest", arguments: { slug: "does-not-exist" } } },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found or you don't have permission/i);
  });

  /**
   * DW-122 — the one place the merged cloak may be broken, and only there.
   *
   * This tool answers a single sentence for "missing" and "denied" alike, on
   * purpose: a distinguishable denial would make it a private-page existence
   * oracle. The commons realm is the exception, because a realm-denied page is
   * PUBLIC — naming it reveals nothing a `read_page` would not. So the realm
   * explanation replaces the cloak exactly when a page was read AND the realm
   * predicate holds for it, and the cloak stands everywhere else.
   */
  it("reingest explains the realm on a readable public knowledge page", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Realm Page", owner: "alice", created: "2025-01-01", visibility: "public" };
    await writeWikiPage("realm-reingest", serializeFrontmatter(fm as Frontmatter, "# Realm Page\n\nPublic knowledge."));

    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "reingest", arguments: { slug: "realm-reingest" } } },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    // `dispatchMcp` prefixes a thrown error with "Error: " on its way into the
    // tool result, so the sentence is asserted as a suffix rather than
    // re-spelled with the prefix baked in.
    expect(r.content[0].text).toContain(WRITE_DENIAL_REALM.reingest);
  });

  it("reingest keeps the cloak on another user's private page", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Alice Private", owner: "alice", created: "2025-01-01", visibility: "private" };
    await writeWikiPage("private-reingest", serializeFrontmatter(fm as Frontmatter, "# Alice Private\n\nSecret."));

    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "reingest", arguments: { slug: "private-reingest" } } },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    // Indistinguishable from the missing-slug case above — and, critically,
    // carrying no word about what kind of page it is.
    expect(r.content[0].text).toMatch(/not found or you don't have permission/i);
    expect(r.content[0].text).not.toMatch(/public knowledge/i);
  });

  it("every write tool is gated and every read tool is open", () => {
    const writes = MCP_TOOLS.filter((t) => t.write).map((t) => t.name);
    const reads = MCP_TOOLS.filter((t) => !t.write).map((t) => t.name);
    expect(writes).toEqual(
      expect.arrayContaining(["ingest_url", "batch_ingest_urls", "ingest_text", "ingest_image", "ingest_pdf", "ingest_x_mention", "create_page", "update_page", "delete_page", "save_query_answer", "reingest", "update_metadata", "fix_lint_issue", "merge_pages", "delete_agent", "vault_delete", "vault_rename"]),
    );
    expect(reads).toEqual(
      expect.arrayContaining(["search_wiki", "read_page", "list_pages", "query_wiki", "lint_wiki", "query_history"]),
    );
  });

  it("exposes a batch cap constant", () => {
    expect(MCP_MAX_BATCH).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The generic argument gate (DW-563)
// ---------------------------------------------------------------------------
/**
 * `dispatchMcp` reads the `inputSchema` each `ToolDef` already declares and
 * refuses arguments that contradict it, before `tool.run`.
 *
 * WHY THESE ROWS EXIST. `batch_ingest_urls` with `urls: "https://x"` used to
 * reach `handleBatchIngest`, where a string's `.length` and index access make it
 * array-like enough to be reported back as `Malformed URLs at indices 0, 1, 2…`
 * — one complaint per CHARACTER, about a field the caller passed once. The
 * stdio door answers the same body at `z.array(z.string())`. Every other
 * `ToolDef.run` spreads-and-casts the same way, so the rows below drive the GATE
 * through `dispatchMcp` rather than any one tool's `run`: they are about the
 * door, and a per-tool suite could not tell the two apart.
 *
 * Every row goes through `dispatchMcp` with a principal, because a refusal that
 * arrived from the auth check instead of the gate would prove nothing.
 */
describe("dispatchMcp — the argument gate", () => {
  type ToolCallResult = { isError?: boolean; content: { text: string }[] };

  // `arguments` is typed `Record<string, unknown>` on the wire type, and some
  // rows below deliberately send something else — that is the case under test.
  const call = async (
    name: string,
    args: unknown,
    principal: Principal | null = ALICE,
  ): Promise<ToolCallResult> => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name, arguments: args } as Record<string, unknown>,
      },
      principal,
    );
    return res!.result as ToolCallResult;
  };

  const text = async (res: Promise<ToolCallResult>) => (await res).content[0].text;

  const refusal = async (res: Promise<ToolCallResult>) => {
    const r = await res;
    expect(r.isError).toBe(true);
    return r.content[0].text;
  };

  it("lets a well-shaped call through to its handler", async () => {
    // The control, and it deliberately uses a URL the HANDLER rejects: the
    // array-of-strings shape is what the gate judges, and "Malformed URLs at
    // indices 0" can only have been written by `handleBatchIngest`, past the
    // gate, without this suite reaching the network.
    expect(await refusal(call("batch_ingest_urls", { urls: ["not-a-url"] }))).toContain(
      "Malformed URLs at indices 0",
    );
  });

  it("refuses a string where the schema declares an array, before the handler", async () => {
    // The ledger's case (DW-563). The old answer indexed the string's
    // characters; the new one names the field and the type it wanted.
    const message = await refusal(call("batch_ingest_urls", { urls: "https://x" }));

    expect(message).toBe("Error: Invalid request field `urls`: expected array");
    expect(message).not.toContain("indices 0, 1, 2");
  });

  it("refuses a missing `required` name in the doors' shared vocabulary", async () => {
    // Same sentence `@/lib/lint-fix` and `POST /api/lint/fix` answer with.
    expect(await refusal(call("batch_ingest_urls", {}))).toBe(
      "Error: Missing required field: urls",
    );
  });

  it("refuses an explicit null — absent is unset, null is a value", async () => {
    // `LINT_FIX_REQUEST`'s `z.string().optional()` accepts a missing key and
    // `undefined` but answers "received null" for an explicit null. Reading
    // null as "unset" here would make one body a 400 at the REST door and a
    // silent success at this one.
    expect(await refusal(call("read_page", { slug: null }))).toBe(
      "Error: Invalid request field `slug`: expected string",
    );
  });

  it("refuses a bad element inside a primitive array, naming its index", async () => {
    // `items.type` is the last thing the gate reads. The index is the point:
    // "expected string" about a ten-element `tags` is not actionable without it.
    expect(
      await refusal(call("create_page", { slug: "s", content: "c", tags: [1] })),
    ).toBe("Error: Invalid request field `tags[0]`: expected string");
  });

  it("refuses arguments that are not a JSON object at all", async () => {
    expect(await refusal(call("read_page", "slug"))).toBe(
      "Error: Invalid request arguments: expected a JSON object",
    );
  });

  it("refuses an explicit null envelope the same way it refuses a null field", async () => {
    // One rule, applied at both levels. `arguments: null` used to be coalesced
    // to `{}` by a `?? {}` in `dispatchMcp`, so `list_agents` SUCCEEDED on a
    // body whose `arguments` was null while the gate one line down refused
    // `{slug: null}` as "a value, not unset" — the gate contradicting itself
    // between the envelope and the fields inside it. `list_agents` is the sharp
    // case because it has no `required` list: nothing else would have objected.
    expect(await refusal(call("list_agents", null))).toBe(
      "Error: Invalid request arguments: expected a JSON object",
    );
  });

  it("refuses a string where the schema declares a number", async () => {
    // The parity this buys is the stdio door's `z.number()`. `limit`, `cap` and
    // `timestamp` are declared `type: "number"` across many tools, and a
    // string-shaped `limit` previously travelled into the handler — where
    // `"10"` is not `10` and the failure, if any, surfaces far from the field.
    // Refused before any storage read, so this row needs no fixtures.
    expect(await refusal(call("search_wiki", { query: "x", limit: "10" }))).toBe(
      "Error: Invalid request field `limit`: expected number",
    );
  });

  it("leaves array elements alone when `items` is an object schema", async () => {
    // A SCOPE boundary, not a delegation: element-level `required` was out of
    // scope for DW-563, so a malformed section reaches the handler — and
    // `handleSeedAgent` does not validate it either. It maps and delegates, and
    // `src/lib/agents.ts` throws "Cannot read properties of undefined" some
    // way in. That answer is bad, and it is deliberately NOT pinned here:
    // asserting it would freeze a crash as the contract. The only claim is the
    // negative one — the gate did not speak, so nothing about object array
    // elements changed with this door. Closing the gap is a separate change
    // that has to design a sentence first.
    const message = await refusal(
      call("seed_agent", {
        agent_id: "gatetest",
        name: "Gate Test",
        description: "d",
        sections: [{ slug: "s" }],
      }),
    );

    expect(message).not.toContain("Invalid request field `sections");
  });

  it("does not REFUSE an undeclared key", async () => {
    // `vault_curate` is called with an `owner` its schema never mentions, and a
    // gate that rejected unknown keys would refuse the call outright. This row
    // proves it does not: the curate succeeds.
    //
    // It does NOT prove the key survives. `vault_curate`'s `run` builds
    // `{slug, owner: p.handle, vault}` and never reads `a.owner`, so the
    // assertions below hold whether the gate passed the key through, ignored
    // it, or stripped it. Non-stripping is unobservable through this tool —
    // every tool that would notice needs the ingest pipeline to run — so the
    // claim is deliberately the weaker one the fixture can actually support.
    await writeWikiPage(
      "gate-curate-me",
      "---\ntitle: Gate Curate\nvisibility: public\n---\n# Gate Curate\nBody",
    );

    const parsed = JSON.parse(
      await text(
        call("vault_curate", {
          slug: "gate-curate-me",
          vault: "research",
          owner: "evil-hacker",
        }),
      ),
    );

    expect(parsed.curated).toBe(true);
    expect(parsed.owner).toBe("alice");
  });

  it.each([
    ["absent arguments", undefined],
    ["empty arguments", {}],
  ])("still admits %s for a tool with no `required` list", async (_label, args) => {
    // `list_agents` declares `schema({})` — no properties, no `required`. The
    // gate must be a no-op there rather than inventing a contract.
    const r = await call("list_agents", args);

    expect(r).not.toHaveProperty("isError");
    expect(JSON.parse(r.content[0].text)).toBeDefined();
  });

  it("admits an optional property that is simply absent", async () => {
    // `wiki_graph`'s `scope` is declared and optional; omitting it is not a
    // type violation, and the gate skips what is not there.
    const r = await call("wiki_graph", {});

    expect(r).not.toHaveProperty("isError");
    expect(JSON.parse(r.content[0].text).nodes).toBeDefined();
  });

  it("keeps the auth refusal ahead of the gate", async () => {
    // Order matters for what an unauthenticated caller learns: telling them
    // which field is malformed before telling them they may not call at all
    // would answer a question they had not earned an answer to.
    expect(await refusal(call("batch_ingest_urls", { urls: 7 }, null))).toMatch(
      /authentication required/i,
    );
  });

  it("keeps the unknown-tool refusal ahead of the gate", async () => {
    // There is no schema to read for a tool that does not exist, so the gate
    // could not speak here even if it ran first.
    expect(await refusal(call("no_such_tool", { urls: 7 }))).toContain(
      "Unknown tool: no_such_tool",
    );
  });
});

describe("dispatchMcp — per-agent target vault", () => {
  const VAULT = { id: "alice--inbox", name: "Inbox" };

  it("initialize surfaces the target vault in instructions (and omits it without one)", async () => {
    const withVault = await dispatchMcp({ id: 1, method: "initialize" }, ALICE, VAULT);
    expect((withVault!.result as { instructions?: string }).instructions).toMatch(/Inbox/);
    const without = await dispatchMcp({ id: 1, method: "initialize" }, ALICE, null);
    expect((without!.result as { instructions?: string }).instructions).toBeUndefined();
  });

  it("tools/list appends the vault destination to WRITE tool descriptions only", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, ALICE, VAULT);
    const tools = (res!.result as { tools: { name: string; description: string }[] }).tools;
    const ingest = tools.find((t) => t.name === "ingest_url")!;
    const search = tools.find((t) => t.name === "search_wiki")!;
    expect(ingest.description).toMatch(/Inbox/);
    expect(search.description).not.toMatch(/Inbox/);
  });

  it("files a created page into the target vault and notes it in the result", async () => {
    const vault = await createVault("alice", "Inbox", "public");
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "create_page", arguments: { slug: "from-agent", content: "# From Agent\n\nbody." } },
      },
      ALICE,
      { id: vault.id, name: vault.name },
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    // The new page is referenced into the vault, and the result records it.
    expect(await vaultSlugs(vault.id)).toContain("from-agent");
    expect(r.content[0].text).toContain("filedIntoVault");
  });

  it("resultSlug reads `slug` (most write tools) and `primarySlug` (reingest)", () => {
    // Guards the reingest filing path: reingest returns IngestResult with
    // primarySlug and no top-level slug.
    expect(_internal.resultSlug({ slug: "a" })).toBe("a");
    expect(_internal.resultSlug({ primarySlug: "b" })).toBe("b");
    expect(_internal.resultSlug({ slug: "a", primarySlug: "b" })).toBe("a");
    expect(_internal.resultSlug({})).toBeNull();
    expect(_internal.resultSlug("nope")).toBeNull();
  });

  it("a vault-filing failure does not fail the write (fail-soft)", async () => {
    // No such vault → addToVault's mutate is a no-op/throws internally; the page
    // is still created and the call succeeds.
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "create_page", arguments: { slug: "still-created", content: "# X\n\nbody." } },
      },
      ALICE,
      { id: "alice--ghost", name: "Ghost" },
    );
    const r = res!.result as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    const { readWikiPage } = await import("../wiki");
    expect(await readWikiPage("still-created")).not.toBeNull();
  });
});

describe("dispatchMcp — update_metadata", () => {
  it("tools/list returns update_metadata", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("update_metadata");
  });

  it("rejects update_metadata without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "update_metadata", arguments: { slug: "test", metadata: { disputed: true } } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("forwards the principal to patchMetadata (updates metadata on an owned page)", async () => {
    // Create a page owned by alice first. PRIVATE, so `alice` is inside the set
    // the per-page ACL admits: since DW-121 the commons realm refuses a human's
    // metadata patch on a PUBLIC knowledge page exactly as it refuses a body
    // write, and this case is about the PRINCIPAL reaching `patchMetadata` at
    // all — not about the realm, which has its own coverage.
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = {
      title: "Meta Test",
      owner: "alice",
      visibility: "private",
      created: "2025-01-01",
    };
    await writeWikiPage("meta-test", serializeFrontmatter(fm, "# Meta Test\n\nBody."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_metadata",
          arguments: { slug: "meta-test", metadata: { disputed: true, confidence: 0.5 } },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.updated).toBe(true);

    // Verify the metadata was actually applied.
    const { readWikiPageWithFrontmatter: readFm } = await import("../wiki");
    const page = await readFm("meta-test");
    expect(page!.frontmatter.disputed).toBe(true);
    expect(page!.frontmatter.confidence).toBe(0.5);
  });

  /**
   * THE TWO DENY CASES, and why the happy path above cannot stand in for them.
   *
   * `handleUpdateMetadata` substitutes a write-anything `service:mcp` principal
   * when `principal` is `undefined`, so a success case passes whether or not
   * the tool's `run: (a, p) => handleUpdateMetadata({ …, principal: p })`
   * actually forwards `p` — deleting `principal: p` from `mcp-http.ts` leaves
   * every other case in this file green. That forwarding is not a detail: this
   * is the one door where a non-service, non-admin principal (`agent:<id>`,
   * which is what ALICE is) really arrives, and since DW-121 it is the whole
   * metadata ACL for it. Both cases below fail if the forwarding is dropped,
   * because the substituted service principal would be admitted.
   */
  it("refuses an agent principal patching a public knowledge page (DW-121)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    // Public and untyped → `belongsInCommons` → the realm reserves it for
    // service principals and admins. ALICE owns it and is still refused, which
    // is the DW-121 rule: the realm is not an ownership term.
    const fm = { title: "Shared Knowledge", owner: "alice", created: "2025-01-01" };
    await writeWikiPage(
      "shared-knowledge",
      serializeFrontmatter(fm as Frontmatter, "# Shared Knowledge\n\nBody."),
    );

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_metadata",
          arguments: { slug: "shared-knowledge", metadata: { disputed: true } },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    // The realm sentence, from the shared table — readable + denied implies the
    // realm at this door like every other.
    expect(r.content[0].text).toContain(WRITE_DENIAL_REALM.edit);

    // …and nothing was written.
    const { readWikiPageWithFrontmatter: readFm } = await import("../wiki");
    expect((await readFm("shared-knowledge"))!.frontmatter.disputed).toBeUndefined();
  });

  it("cloaks another user's PRIVATE page rather than naming it", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = {
      title: "Alice Secret",
      owner: "alice",
      visibility: "private",
      created: "2025-01-01",
    };
    await writeWikiPage(
      "alice-secret",
      serializeFrontmatter(fm as Frontmatter, "# Alice Secret\n\nPrivate."),
    );

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_metadata",
          arguments: { slug: "alice-secret", metadata: { disputed: true } },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    // No realm wording, and nothing that says what kind of page it is.
    expect(r.content[0].text).not.toMatch(/public knowledge/i);
    expect(r.content[0].text).not.toMatch(/agent-maintained/i);
    expect(r.content[0].text).not.toBe(WRITE_DENIAL_REALM.edit);

    // THE ACTUAL CLOAK TEST is indistinguishability, not slug-absence. This
    // sentence does echo the slug — but it is the slug BOB just sent, so
    // repeating it tells him nothing he did not already know, and every
    // not-found cloak in the app has the same shape. What would be an oracle is
    // a REAL page answering differently from a missing one, so the assertion is
    // that the two are byte-identical apart from the name he supplied.
    const missing = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "update_metadata",
          arguments: { slug: "no-such-page", metadata: { disputed: true } },
        },
      },
      BOB,
    );
    const m = missing!.result as { isError?: boolean; content: { text: string }[] };
    expect(m.isError).toBe(true);
    expect(r.content[0].text.replace("alice-secret", "SLUG")).toBe(
      m.content[0].text.replace("no-such-page", "SLUG"),
    );
  });
});

// ---------------------------------------------------------------------------
// update_page
// ---------------------------------------------------------------------------
describe("dispatchMcp — update_page", () => {
  it("tools/list returns update_page with correct schema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools;
    const tool = tools.find((t) => t.name === "update_page");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["slug", "content"]));
  });

  it("rejects update_page without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "update_page", arguments: { slug: "test", content: "# New\n\nBody." } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("updates a page owned by the caller (ACL + success)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    // Use agent-scoped type so the page is NOT commons (commons body writes are
    // agent-only via service principals — the realm gate is intentional).
    const fm = { title: "Update Test", owner: "alice", created: "2025-01-01", type: "agent-knowledge" };
    await writeWikiPage("update-test", serializeFrontmatter(fm, "# Update Test\n\nOld body."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_page",
          arguments: { slug: "update-test", content: "# Update Test\n\nNew body." },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.updated).toBe(true);
    expect(parsed.slug).toBe("update-test");

    // Verify the content was actually updated.
    const { readWikiPageWithFrontmatter: readFm } = await import("../wiki");
    const page = await readFm("update-test");
    expect(page).not.toBeNull();
    expect(page!.body).toContain("New body.");
  });

  it("rejects update_page when caller cannot write the page (ACL)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Alice Only", owner: "alice", created: "2025-01-01", visibility: "private" };
    await writeWikiPage("alice-only", serializeFrontmatter(fm as Frontmatter, "# Alice Only\n\nPrivate."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_page",
          arguments: { slug: "alice-only", content: "# Hacked\n\nEvil." },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete_page
// ---------------------------------------------------------------------------
describe("dispatchMcp — delete_page", () => {
  it("tools/list returns delete_page with correct schema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools;
    const tool = tools.find((t) => t.name === "delete_page");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["slug"]));
  });

  it("rejects delete_page without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_page", arguments: { slug: "test" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("deletes a page owned by the caller (ACL + success)", async () => {
    const { writeWikiPage, serializeFrontmatter, readWikiPage } = await import("../wiki");
    // Use agent-scoped type so the page is NOT commons (commons delete writes
    // require a service principal — the realm gate is intentional).
    const fm = { title: "Delete Test", owner: "alice", created: "2025-01-01", type: "agent-knowledge" };
    await writeWikiPage("delete-test", serializeFrontmatter(fm, "# Delete Test\n\nWill be deleted."));

    // Confirm the page exists.
    expect(await readWikiPage("delete-test")).toBeTruthy();

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "delete_page",
          arguments: { slug: "delete-test" },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("delete-test");

    // Verify the page was actually deleted.
    expect(await readWikiPage("delete-test")).toBeNull();
  });

  it("rejects delete_page when caller cannot write the page (ACL)", async () => {
    const { writeWikiPage, serializeFrontmatter } = await import("../wiki");
    const fm = { title: "Alice Private", owner: "alice", created: "2025-01-01", visibility: "private" };
    await writeWikiPage("alice-private", serializeFrontmatter(fm as Frontmatter, "# Alice Private\n\nPrivate."));

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "delete_page",
          arguments: { slug: "alice-private" },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
  });
});

describe("dispatchMcp — publish_to_commons is retired", () => {
  it("is absent from tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, ALICE);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain("publish_to_commons");
  });

  it("is an unknown tool when called", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "publish_to_commons",
          arguments: { slug: "agent-topic", agentId: "alice--yoyo" },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/i);
  });
});

describe("dispatchMcp — lint_wiki", () => {
  it("tools/list returns lint_wiki", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("lint_wiki");
  });

  it("lint_wiki works for an authenticated reader", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "lint_wiki", arguments: {} },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toHaveProperty("issues");
    expect(Array.isArray(parsed.issues)).toBe(true);
  });
});

describe("dispatchMcp — fix_lint_issue", () => {
  it("tools/list returns fix_lint_issue", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("fix_lint_issue");
  });

  it("rejects fix_lint_issue without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "fix_lint_issue", arguments: { type: "orphan-page", slug: "test" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  // Every gate row below drives the tool the same way: one `tools/call` as an
  // authenticated principal, read back as the error text it answered with. The
  // shared `mockClear` keeps "was the dispatcher reached?" answerable per row —
  // that question is the point of most of them.
  const call = (args: Record<string, unknown>) =>
    dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "fix_lint_issue", arguments: args },
      },
      ALICE,
    );

  const errorText = (res: Awaited<ReturnType<typeof dispatchMcp>>) => {
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    return r.content[0].text;
  };

  beforeEach(() => {
    spiedFixLintIssue.mockClear();
  });

  /**
   * The `type` gate this transport has to carry itself (DW-348).
   *
   * `tools/call` now runs `validateToolArguments` over the tool's own
   * `inputSchema` before `run` (DW-563), so `type`'s DECLARED SHAPE — present,
   * and a string — is answered at the door. What that generic gate deliberately
   * does NOT read is `enum`: the stdio server gets member checking from the SDK
   * (`z.enum(AUTO_FIXABLE_CHECK_TYPES)`, pinned in `mcp.test.ts`), and here it
   * stays in the tool's own `run` so a recognized-but-not-fixable type keeps the
   * explanation written for a human instead of an "expected one of" list. These
   * rows are that gate's only observer; the door's half is pinned by
   * `dispatchMcp — the argument gate` below.
   */
  describe("the type gate", () => {
    it("refuses a recognized-but-not-fixable type, with its own explanation", async () => {
      // Refused at the door, but NOT with a bare "unsupported": the type is a
      // real check type whose refusal was written for a human, and dropping
      // that sentence is how a gate makes an answer worse than the one it
      // replaced.
      const text = errorText(await call({ type: "low-confidence", slug: "some-page" }));

      expect(text).toContain("Low-confidence pages cannot be auto-fixed");
      expect(spiedFixLintIssue).not.toHaveBeenCalled();
    });

    it("keeps the disputed-page clear path, with the slug interpolated", async () => {
      // The sentence `lint-types.ts` insists must arrive copy-pasteable. The
      // door has the sibling `slug`, which is exactly what a schema-level
      // refusal (the stdio side) could not have reached.
      const text = errorText(await call({ type: "disputed-page", slug: "contested-page" }));

      expect(text).toContain(
        "PATCH /api/wiki/contested-page with metadata { disputed: false }",
      );
      expect(spiedFixLintIssue).not.toHaveBeenCalled();
    });

    it.each([
      ["an unknown type", { type: "made-up-type", slug: "p" }],
      // Inherited `Object.prototype` members — `ownEntry`'s `typeof`/own-key
      // guard is what stops `constructor` resolving to a real function.
      ["a prototype-chain type", { type: "constructor", slug: "p" }],
    ])("refuses %s without dispatching", async (_label, args) => {
      const text = errorText(await call(args));

      expect(text).toContain("Auto-fix not supported for this issue type");
      expect(spiedFixLintIssue).not.toHaveBeenCalled();
    });

    it.each([
      // `hasOwnProperty.call` runs its key through `ToPropertyKey`, so
      // `["orphan-page"]` stringifies to a REAL handler key. That coercion is
      // what `ownEntry`'s `typeof` guard exists to stop; the door's generic gate
      // now stops it a layer earlier still, before any lookup — and answers with
      // the field name, which is the thing an agent can act on.
      [
        "a non-string type",
        { type: ["orphan-page"], slug: "p" },
        "Invalid request field `type`: expected string",
      ],
      // `type` is this tool's one `required` name, so an absent one is the
      // door's sentence rather than `autoFixRefusal`'s. Still a refusal, still
      // undispatched — only the wording moved, and it moved toward naming the
      // field that is wrong.
      ["no type at all", { slug: "p" }, "Missing required field: type"],
    ])(
      "refuses %s at the door, before `run` is reached",
      async (_label, args, expected) => {
        const text = errorText(await call(args));

        expect(text).toContain(expected);
        expect(spiedFixLintIssue).not.toHaveBeenCalled();
      },
    );

    it("still dispatches a fixable type — the control", async () => {
      // The gate refuses what it should and nothing else. The page is absent, so
      // "Page not found" can only have come from `fixOrphanPage`, past the gate.
      const text = errorText(await call({ type: "orphan-page", slug: "absent-page" }));

      expect(text).toContain("Page not found: absent-page");
      expect(spiedFixLintIssue).toHaveBeenCalledWith(
        "orphan-page",
        "absent-page",
        undefined,
        undefined,
        undefined,
        ALICE.handle,
      );
    });

    /**
     * The principal is the TRIGGER, never the AUTHOR (DW-447).
     *
     * This door used to pass `author: p!.handle` into `handleFixLintIssue`, so
     * an owner who asked for a lint fix was written into the page's revision
     * sidecar, its `contributors` and their trust score as the author of a
     * machine-generated edit — the exact thing `AUTOMATION_ACTORS` exists to
     * prevent, and the honest `"lint-fix"` the stdio transport kept all along.
     * Position matters as much as presence here: fifth is `author`, sixth is
     * `triggeredBy`, and the defect was the handle sitting in the wrong one.
     */
    it("forwards the principal as the trigger and leaves the author alone", async () => {
      // BOB, not the suite's ALICE, so neither assertion can pass on a
      // coincidence with a handle some other row already put in the spy.
      await dispatchMcp(
        {
          id: 1,
          method: "tools/call",
          params: {
            name: "fix_lint_issue",
            arguments: { type: "orphan-page", slug: "absent-page" },
          },
        },
        BOB,
      );

      expect(spiedFixLintIssue.mock.lastCall?.[4]).toBeUndefined();
      expect(spiedFixLintIssue.mock.lastCall?.[5]).toBe(BOB.handle);
    });

    it("advertises the same set it enforces", async () => {
      // An `accept` that offers more than the gate admits is the DW-347 failure
      // in another door; here the two are read from one const.
      const res = await dispatchMcp({ id: 1, method: "tools/list" }, ALICE);
      const tools = (res!.result as {
        tools: { name: string; description: string; inputSchema: unknown }[];
      }).tools;
      const tool = tools.find((t) => t.name === "fix_lint_issue")!;
      const schema = tool.inputSchema as {
        properties: { type: { enum?: string[] } };
      };

      expect(schema.properties.type.enum).toEqual([...AUTO_FIXABLE_CHECK_TYPES]);
      // And the prose must not still promise what the schema now refuses.
      expect(tool.description).not.toContain("Not all issue types are auto-fixable");
      expect(tool.description).toContain("suggestion");
    });
  });

  /**
   * The three STRING fields, gated the same way `type` is (DW-455).
   *
   * `dispatchMcp` used to validate nothing — `params.arguments` reached
   * `tool.run` as whatever JSON arrived — and this tool spread that object
   * straight into `handleFixLintIssue` behind a cast. A non-string `slug`
   * therefore travelled all the way to `fixOrphanPage` and came back a 404
   * naming `[object Object]`: an error about a page the caller never asked for,
   * useless for correcting the call. The gate must name the FIELD instead, and
   * the dispatcher must never be reached — the spy is what proves the second
   * half, since a refusal alone cannot tell "stopped at the door" from
   * "dispatched and failed".
   *
   * The gate now lives at the door for every tool (`validateToolArguments`,
   * DW-563) rather than in this tool's `run`, and answers these rows in the same
   * words. They stay HERE, driven through `fix_lint_issue`, because the claim
   * they pin is behavioural — this tool's three optional strings match
   * `LINT_FIX_REQUEST`'s field for field — not a claim about where the check
   * happens to be implemented.
   */
  describe("the string-field gate", () => {
    it.each([
      ["an object slug", { type: "orphan-page", slug: { x: 1 } }, "slug"],
      ["a numeric slug", { type: "orphan-page", slug: 7 }, "slug"],
      ["an array slug", { type: "orphan-page", slug: ["p"] }, "slug"],
      [
        "a numeric target",
        { type: "missing-crossref", slug: "p", target: 7 },
        "target",
      ],
      [
        "an object message",
        { type: "contradiction", slug: "p", target: "q", message: { a: 1 } },
        "message",
      ],
    ])("refuses %s, naming the field", async (_label, args, field) => {
      const text = errorText(await call(args));

      expect(text).toContain(`\`${field}\``);
      expect(text).not.toContain("[object Object]");
      expect(spiedFixLintIssue).not.toHaveBeenCalled();
    });

    it("checks the fields BEFORE the type gate speaks for them", async () => {
      // Order matters for the message the agent reads: with a bad `slug` the
      // `type` gate would interpolate garbage into the copy-pasteable clear
      // path it exists to hand over ("PATCH /api/wiki/[object Object] …").
      // Naming the malformed field first is the only answer that can be acted
      // on.
      const text = errorText(await call({ type: "disputed-page", slug: { x: 1 } }));

      expect(text).toContain("`slug`");
      expect(text).not.toContain("[object Object]");
    });

    it("lets an ABSENT field through — optional means optional", async () => {
      // The control for the gate's shape: it refuses PRESENT-but-wrong, not
      // MISSING. `orphan-page` takes no target or message, so omitting them
      // must reach the dispatcher as `undefined` rather than trip the gate.
      const text = errorText(
        await call({ type: "orphan-page", slug: "absent-page" }),
      );

      expect(text).toContain("Page not found: absent-page");
      expect(spiedFixLintIssue).toHaveBeenCalledWith(
        "orphan-page",
        "absent-page",
        undefined,
        undefined,
        undefined,
        ALICE.handle,
      );
    });

    it("refuses an explicit null — absent is not the same as null", async () => {
      // The parity that makes this gate worth having. `LINT_FIX_REQUEST`'s
      // `z.string().optional()` accepts a MISSING key and `undefined`, but
      // answers "expected string, received null" for an explicit `null` —
      // verified against the installed zod. Reading `null` as "unset" here
      // would make the same body a 400 at `POST /api/lint/fix` and a silent
      // success over MCP, which is the door divergence this bundle closes.
      const text = errorText(await call({ type: "orphan-page", slug: null }));

      expect(text).toContain("`slug`");
      expect(spiedFixLintIssue).not.toHaveBeenCalled();
    });
  });

  /**
   * `missing-concept-page` without a slug (DW-457).
   *
   * It is the one auto-fixable type whose handler reads `message` ALONE —
   * `FIX_HANDLERS["missing-concept-page"]` never destructures `slug`. While
   * `slug` sat in this tool's `required` list the type was unreachable over
   * this transport unless the agent invented a dummy slug for a fix that would
   * ignore it. The REST door already accepts the slug-less body; these rows are
   * the parity.
   */
  describe("a slug-less missing-concept-page", () => {
    it("reaches the dispatcher with an empty slug", async () => {
      // The message is deliberately UNPARSEABLE, so `fixMissingConceptPage`
      // refuses at its own regex rather than writing a stub into this suite's
      // wiki. The claim under test is that the request GOT there, which the
      // spy's recorded arguments establish on their own — including the `""`
      // an absent slug converts to, the same conversion `POST /api/lint/fix`
      // does.
      const text = errorText(
        await call({
          type: "missing-concept-page",
          message: "no concept sentence here",
        }),
      );

      expect(text).toContain("Could not parse concept name");
      expect(spiedFixLintIssue).toHaveBeenCalledWith(
        "missing-concept-page",
        "",
        undefined,
        "no concept sentence here",
        undefined,
        ALICE.handle,
      );
    });

    it("still lets a slug-requiring type answer for its own missing slug", async () => {
      // The other half of the trade. An optional `slug` means `orphan-page`
      // with none reaches the handler as `""`, and "Missing required field:
      // slug" names both the field and the fact that this type needs it —
      // strictly more than a schema error over an absent property could say.
      const text = errorText(await call({ type: "orphan-page" }));

      expect(text).toContain("Missing required field: slug");
      expect(spiedFixLintIssue).toHaveBeenCalledWith(
        "orphan-page",
        "",
        undefined,
        undefined,
        undefined,
        ALICE.handle,
      );
    });

    it("advertises slug as optional", async () => {
      // What the agent reads before composing the call. A `required` list still
      // naming `slug` would keep the type unreachable in practice even though
      // the door now accepts it.
      const res = await dispatchMcp({ id: 1, method: "tools/list" }, ALICE);
      const tools = (res!.result as { tools: { name: string; inputSchema: unknown }[] })
        .tools;
      const schema = tools.find((t) => t.name === "fix_lint_issue")!
        .inputSchema as { required?: string[]; properties: Record<string, unknown> };

      expect(schema.required).toEqual(["type"]);
      // Still ADVERTISED — optional is not absent; every other type needs it.
      expect(schema.properties).toHaveProperty("slug");
    });
  });
});

describe("dispatchMcp — reconcile_page (retired)", () => {
  it("tools/list omits reconcile_page", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain("reconcile_page");
  });

  it("is an unknown tool when called", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "reconcile_page",
          arguments: { pageSlug: "test", threadIndex: 0 },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/i);
  });

  it("lint_wiki rejects the retired discussion check type", async () => {
    // `unresolved-discussions` retired with reconcile-from-talk and must not be
    // accepted by the shared handler either (the schema here is free-form
    // strings, so only the handler's own validation stands between a retired
    // type and a silently empty result).
    //
    // Passed ALONE on purpose: paired with a second invalid type, the assertion
    // passes whichever of the two the validator caught, so it would keep
    // passing even after `unresolved-discussions` was quietly re-admitted.
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "lint_wiki",
          arguments: { checks: ["unresolved-discussions"] },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/invalid check type/i);
    expect(r.content[0].text).toMatch(/unresolved-discussions/);
  });

  it("lint_wiki accepts disputed-page as a valid check type", async () => {
    // The other half of the retirement: `disputed` outlived talk, so
    // `disputed-page` is a live check (DW-76) and this handler must let it
    // through. Without this, the rejection test above is the only thing
    // describing the handler's view of the roster, and it would read as though
    // both types were retired.
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "lint_wiki",
          arguments: { checks: ["disputed-page"] },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).not.toMatch(/invalid check type/i);
  });
});

// ---------------------------------------------------------------------------
// merge_pages tool
// ---------------------------------------------------------------------------

describe("dispatchMcp — merge_pages", () => {
  it("tools/list includes merge_pages", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("merge_pages");
  });

  it("merge_pages is write-gated (rejects without auth)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "merge_pages", arguments: { from: "page-a", into: "page-b" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("merge_pages dispatches with actor from principal", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "merge_pages");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Revision tools
// ---------------------------------------------------------------------------

describe("dispatchMcp — list_revisions", () => {
  it("tools/list returns list_revisions", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("list_revisions");
  });

  it("returns revisions for a valid slug for an authenticated reader", async () => {
    // Create a page then update it so a revision exists
    await writeWikiPage("rev-list-test", "# Rev\nOriginal content");
    await saveRevision("rev-list-test", "# Rev\nOriginal content");
    await writeWikiPage("rev-list-test", "# Rev\nUpdated content");
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_revisions", arguments: { slug: "rev-list-test" } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("rev-list-test");
    expect(parsed.revisions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("dispatchMcp — read_revision", () => {
  it("tools/list returns read_revision", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("read_revision");
  });

  it("returns revision content for a valid slug + timestamp", async () => {
    // Set up a page with a revision
    await writeWikiPage("rev-read-test", "# Rev\nFirst version");
    await saveRevision("rev-read-test", "# Rev\nFirst version");
    await writeWikiPage("rev-read-test", "# Rev\nSecond version");

    // Get the timestamp from list_revisions
    const listRes = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_revisions", arguments: { slug: "rev-read-test" } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );
    const listParsed = JSON.parse(
      (listRes!.result as { content: { text: string }[] }).content[0].text,
    );
    const ts = listParsed.revisions[0].timestamp;

    // Read that revision
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: { name: "read_revision", arguments: { slug: "rev-read-test", timestamp: ts } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("rev-read-test");
    expect(parsed.content).toContain("First version");
  });
});

describe("dispatchMcp — revert_revision", () => {
  it("tools/list returns revert_revision", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("revert_revision");
  });

  it("keeps principal out of the caller-controlled HTTP input schema", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as {
      tools: {
        name: string;
        inputSchema: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }[];
    }).tools;
    const revert = tools.find((tool) => tool.name === "revert_revision")!;

    expect(revert.inputSchema.properties).not.toHaveProperty("principal");
    expect(revert.inputSchema.required ?? []).not.toContain("principal");
  });

  it("rejects revert_revision without auth (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "revert_revision",
          arguments: { slug: "test", timestamp: 1234567890 },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("forwards the principal to an owner-authorized private-page revert", async () => {
    const original =
      "---\ntitle: Revert\nowner: alice\nvisibility: private\n---\n# Revert\n\nOriginal";
    const changed =
      "---\ntitle: Revert\nowner: alice\nvisibility: private\n---\n# Revert\n\nChanged";
    await writeWikiPage("rev-revert-test", changed);
    await saveRevision("rev-revert-test", original, "snapshotter", "snapshot");
    const timestamp = (await listRevisions("rev-revert-test"))[0].timestamp;

    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "revert_revision",
          arguments: { slug: "rev-revert-test", timestamp },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.slug).toBe("rev-revert-test");
    expect((await readWikiPageWithFrontmatter("rev-revert-test"))!.content)
      .toContain("Original");

    const [revertCreatedRevision] = await listRevisions("rev-revert-test");
    expect(revertCreatedRevision.author).toBe("alice");
    expect(
      await readRevision("rev-revert-test", revertCreatedRevision.timestamp),
    ).toContain("Changed");
  });

  it("forwards a regular principal and denies a public-page revert without mutation", async () => {
    const current =
      "---\ntitle: Public HTTP revert\nvisibility: public\n---\n# Public HTTP revert\n\nCurrent";
    const revision =
      "---\ntitle: Public HTTP revert\nvisibility: public\n---\n# Public HTTP revert\n\nRevision";
    await writeWikiPage("public-http-revert", current);
    await saveRevision("public-http-revert", revision, "service:test", "snapshot");
    const timestamp = (await listRevisions("public-http-revert"))[0].timestamp;
    const pageBefore = (await readWikiPageWithFrontmatter("public-http-revert"))!.content;
    const revisionBefore = await readRevision("public-http-revert", timestamp);
    const revisionHistoryBefore = await listRevisions("public-http-revert");

    const res = await dispatchMcp(
      {
        id: 3,
        method: "tools/call",
        params: {
          name: "revert_revision",
          arguments: { slug: "public-http-revert", timestamp },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(WRITE_DENIAL_REALM.revert);
    expect((await readWikiPageWithFrontmatter("public-http-revert"))!.content)
      .toBe(pageBefore);
    expect(await readRevision("public-http-revert", timestamp))
      .toBe(revisionBefore);
    expect(await listRevisions("public-http-revert")).toEqual(
      revisionHistoryBefore,
    );
  });

  it("forwards a non-owner principal and cloaks a private-page revert without mutation", async () => {
    const current =
      "---\ntitle: Private HTTP revert\nowner: alice\nvisibility: private\n---\n# Private HTTP revert\n\nCurrent";
    const revision =
      "---\ntitle: Private HTTP revert\nowner: alice\nvisibility: private\n---\n# Private HTTP revert\n\nRevision";
    await writeWikiPage("private-http-revert", current);
    await saveRevision("private-http-revert", revision, "alice", "snapshot");
    const timestamp = (await listRevisions("private-http-revert"))[0].timestamp;
    const pageBefore = (await readWikiPageWithFrontmatter("private-http-revert"))!.content;
    const revisionBefore = await readRevision("private-http-revert", timestamp);
    const revisionHistoryBefore = await listRevisions("private-http-revert");

    const res = await dispatchMcp(
      {
        id: 4,
        method: "tools/call",
        params: {
          name: "revert_revision",
          arguments: { slug: "private-http-revert", timestamp },
        },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Error: page not found: private-http-revert");
    expect(r.content[0].text).not.toMatch(/realm|public knowledge/i);
    expect((await readWikiPageWithFrontmatter("private-http-revert"))!.content)
      .toBe(pageBefore);
    expect(await readRevision("private-http-revert", timestamp))
      .toBe(revisionBefore);
    expect(await listRevisions("private-http-revert")).toEqual(
      revisionHistoryBefore,
    );
  });
});

describe("dispatchMcp — vault tools", () => {
  it("list_vaults and vault_pages appear in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_vaults");
    expect(names).toContain("vault_pages");
  });

  it("list_vaults defaults to caller's handle when no owner arg", async () => {
    // Create a vault for alice
    await createVault("alice", "my-research", "public");

    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "list_vaults", arguments: {} } },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.vaults).toBeInstanceOf(Array);
    expect(parsed.vaults.length).toBeGreaterThanOrEqual(1);
    expect(parsed.vaults.some((v: { name: string }) => v.name === "my-research")).toBe(true);
  });

  it("list_vaults with explicit owner returns that user's vaults", async () => {
    await createVault("bob", "bob-notes", "public");

    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "list_vaults", arguments: { owner: "bob" } } },
      ALICE, // reads require a principal too (private deployment)
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.vaults).toBeInstanceOf(Array);
    expect(parsed.vaults.some((v: { name: string }) => v.name === "bob-notes")).toBe(true);
  });

  it("list_vaults is refused entirely without a principal", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/call", params: { name: "list_vaults", arguments: {} } },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_pages returns enriched metadata for vault contents", async () => {
    // Create a page, then a vault, then add the page to the vault
    await writeWikiPage("vault-test-page", "---\ntitle: Vault Test\ntags: [testing]\nconfidence: 0.9\n---\n# Vault Test\nHello");
    const vault = await createVault("alice", "test-vault", "public");
    const { addToVault: addToV } = await import("../vault");
    await addToV(vault.id, "vault-test-page");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_pages", arguments: { vault: "test-vault" } },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.owner).toBe("alice");
    expect(parsed.vault).toBe("test-vault");
    expect(parsed.slugs).toContain("vault-test-page");
    expect(parsed.pages).toBeInstanceOf(Array);
    expect(parsed.pages.length).toBe(1);
    expect(parsed.pages[0].slug).toBe("vault-test-page");
    expect(parsed.pages[0].title).toBe("Vault Test");
  });

  it("vault_pages is refused entirely without a principal", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_pages", arguments: { vault: "test-vault" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_curate, vault_create, vault_uncurate appear in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("vault_curate");
    expect(names).toContain("vault_create");
    expect(names).toContain("vault_uncurate");
  });

  it("vault_curate requires authentication", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_curate", arguments: { slug: "test", vault: "inbox" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_create requires authentication", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_create", arguments: { name: "inbox" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_uncurate requires authentication", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_uncurate", arguments: { slug: "test", vault: "inbox" } },
      },
      null,
    );
    const r2 = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/authentication required/i);
  });

  it("vault_curate forces owner from principal (ignores caller-supplied owner)", async () => {
    // Create a page for curation
    await writeWikiPage("curate-me", "---\ntitle: Curate Me\nvisibility: public\n---\n# Curate Me\nContent");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_curate",
          arguments: { slug: "curate-me", vault: "research", owner: "evil-hacker" },
        },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.curated).toBe(true);
    expect(parsed.owner).toBe("alice"); // forced from principal, not "evil-hacker"
    expect(parsed.vault).toBe("research");
  });

  it("vault_create forces owner from principal", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_create",
          arguments: { name: "my-new-vault", owner: "evil-hacker" },
        },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.vault).toBeDefined();
    expect(parsed.vault.owner).toBe("alice"); // forced from principal
  });

  it("vault_uncurate forces owner from principal", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_uncurate",
          arguments: { slug: "some-slug", vault: "inbox", owner: "evil-hacker" },
        },
      },
      ALICE,
    );
    const r2 = res!.result as { content: { text: string }[] };
    const parsed = JSON.parse(r2.content[0].text);
    expect(parsed.curated).toBe(false);
    expect(parsed.owner).toBe("alice"); // forced from principal
  });
});

describe("dispatchMcp — agent_context", () => {
  it("agent_context tool appears in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    const tool = tools.find((t) => t.name === "agent_context");
    expect(tool).toBeDefined();
  });

  it("agent_context is read-only (write: false) — no auth required", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "agent_context");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("agent_context returns identity, learnings, socialWisdom, and meta for a registered agent", async () => {
    // Register a test agent with some pages
    await registerAgent({
      id: "a--test-bot",
      name: "test-bot",
      description: "A test agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "agent_context", arguments: { agent_id: "a--test-bot" } },
      },
      ALICE, // reads require a principal too (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.agent).toBeDefined();
    expect(parsed.agent.name).toBe("test-bot");
    expect(parsed.context).toBeDefined();
    expect(parsed.context).toHaveProperty("identity");
    expect(parsed.context).toHaveProperty("learnings");
    expect(parsed.context).toHaveProperty("socialWisdom");
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta).toHaveProperty("totalChars");
    expect(parsed.meta).toHaveProperty("pageCount");
  });

  it("agent_context returns error for unknown agent", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "agent_context", arguments: { agent_id: "nonexistent" } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/agent not found/i);
  });
});

// ---------------------------------------------------------------------------
// dataview_query dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — dataview_query", () => {
  it("returns results for a valid query (no auth required)", async () => {
    // Seed a page so the query has something to find
    await writeWikiPage(
      "dv-test-page",
      "---\ntitle: DV Test\ntags:\n  - testing\nconfidence: 0.9\n---\nDataview test content.",
    );

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "dataview_query",
          arguments: {
            filters: [{ field: "tags", op: "contains", value: "testing" }],
            limit: 5,
          },
        },
      },
      ALICE, // reads require a principal too (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.total).toBeTypeOf("number");
  });

  it("returns empty results when no pages match filters", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "dataview_query",
          arguments: {
            filters: [{ field: "tags", op: "contains", value: "nonexistent-tag-xyz" }],
          },
        },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wiki_graph dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — wiki_graph", () => {
  it("returns graph data (nodes + edges) without auth", async () => {
    // Seed a couple of pages so the graph is non-trivial
    await writeWikiPage(
      "graph-node-a",
      "---\ntitle: Node A\n---\nSee [[graph-node-b]].",
    );
    await writeWikiPage(
      "graph-node-b",
      "---\ntitle: Node B\n---\nStandalone page.",
    );

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "wiki_graph", arguments: {} },
      },
      ALICE, // reads require a principal too (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nodes).toBeDefined();
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.edges).toBeDefined();
    expect(Array.isArray(parsed.edges)).toBe(true);
  });

  it("returns graph with optional scope param", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "wiki_graph", arguments: { scope: "all" } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nodes).toBeDefined();
    expect(parsed.edges).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// batch_ingest_urls dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — batch_ingest_urls", () => {
  it("is listed in tools/list", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("batch_ingest_urls");
  });

  it("blocks unauthenticated calls (write-gated)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "batch_ingest_urls",
          arguments: { urls: ["https://example.com"] },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("rejects batch with malformed URLs (upfront validation)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "batch_ingest_urls",
          arguments: { urls: ["not-a-url", "also bad"] },
        },
      },
      ALICE,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/malformed/i);
  });
});

// ---------------------------------------------------------------------------
// activity_trail dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — activity_trail", () => {
  it("returns events array without auth (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "activity_trail", arguments: {} },
      },
      ALICE, // reads require a principal too (private deployment)
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  it("respects optional limit parameter", async () => {
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: { name: "activity_trail", arguments: { limit: 5 } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ingest_history dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_history", () => {
  it("returns entries array without auth (read-only)", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ingest_history", arguments: {} },
      },
      ALICE, // reads require a principal too (private deployment)
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("respects optional limit parameter", async () => {
    const res = await dispatchMcp(
      {
        id: 2,
        method: "tools/call",
        params: { name: "ingest_history", arguments: { limit: 10 } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contributor tools (retired) — every contributor page and REST route 404s, so
// the two MCP tools went with them.
// ---------------------------------------------------------------------------
describe.each(["list_contributors", "get_contributor"])(
  "dispatchMcp — %s is retired",
  (retired) => {
    it("is absent from tools/list", async () => {
      const res = await dispatchMcp({ id: 1, method: "tools/list" }, ALICE);
      const tools = (res!.result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).not.toContain(retired);
    });

    it("is an unknown tool when called", async () => {
      const res = await dispatchMcp(
        {
          id: 1,
          method: "tools/call",
          params: { name: retired, arguments: { handle: "alice" } },
        },
        ALICE,
      );
      const r = res!.result as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/unknown tool/i);
    });
  },
);

// ---------------------------------------------------------------------------
// list_agents dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — list_agents", () => {
  it("is registered as a read-only tool", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "list_agents");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("returns agents array without auth (read-only)", async () => {
    // Register a test agent so there's something to list.
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "list_agents", arguments: {} },
      },
      ALICE, // reads require a principal too (private deployment)
    );

    expect(res).not.toBeNull();
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.agents).toBeDefined();
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents.length).toBeGreaterThanOrEqual(1);
    expect(parsed.agents[0]).toHaveProperty("id");
    expect(parsed.agents[0]).toHaveProperty("name");
  });
});

// ---------------------------------------------------------------------------
// update_agent dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — update_agent", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "update_agent", arguments: { name: "new-name" } },
      },
      null,
    );

    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Authentication required");
  });

  it("updates an agent profile when called by the owner", async () => {
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "update_agent",
          arguments: { description: "Updated description" },
        },
      },
      ALICE,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.description).toBe("Updated description");
  });
});

// ---------------------------------------------------------------------------
// seed_agent dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — seed_agent", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "seed_agent",
          arguments: {
            agent_id: "test-bot",
            name: "test-bot",
            description: "A test bot",
            sections: [],
          },
        },
      },
      null,
    );

    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Authentication required");
  });

  it("seeds a new agent when authenticated", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "seed_agent",
          arguments: {
            agent_id: "test-bot",
            name: "test-bot",
            description: "A test bot",
            sections: [],
          },
        },
      },
      ALICE,
    );

    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.name).toBe("test-bot");
    expect(parsed.owner).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// delete_agent dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — delete_agent", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_agent", arguments: { agent_id: "alice--yoyo" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("deletes an agent when called by the owner", async () => {
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_agent", arguments: { agent_id: "alice--yoyo" } },
      },
      ALICE,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.deleted).toBe(true);
  });

  it("rejects delete_agent when caller does not own the agent (cross-user)", async () => {
    await registerAgent({
      id: "alice--yoyo",
      name: "yoyo",
      description: "Alice's agent",
      owner: "alice",
      identityPages: [],
      learningPages: [],
      socialPages: [],
      registered: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    // Bob tries to delete Alice's agent
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "delete_agent", arguments: { agent_id: "alice--yoyo" } },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/cannot modify/i);
  });
});

// ---------------------------------------------------------------------------
// vault_delete dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — vault_delete", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_delete", arguments: { vault_id: "alice--inbox" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("deletes a vault when called by the owner", async () => {
    const vault = await createVault("alice", "to-delete", "public");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_delete", arguments: { vault_id: vault.id } },
      },
      ALICE,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.deleted).toBe(true);
  });

  it("rejects vault_delete when caller does not own the vault (cross-user)", async () => {
    const vault = await createVault("alice", "private-vault", "public");

    // Bob tries to delete Alice's vault
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_delete", arguments: { vault_id: vault.id } },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// vault_rename dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — vault_rename", () => {
  it("rejects unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_rename", arguments: { vault_id: "alice--inbox", name: "new-name" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("renames a vault when called by the owner", async () => {
    const vault = await createVault("alice", "old-name", "public");

    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_rename", arguments: { vault_id: vault.id, name: "new-name" } },
      },
      ALICE,
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.renamed).toBe(true);
    expect(parsed.name).toBe("new-name");
  });

  it("rejects vault_rename when caller does not own the vault (cross-user)", async () => {
    const vault = await createVault("alice", "alice-vault", "public");

    // Bob tries to rename Alice's vault
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "vault_rename", arguments: { vault_id: vault.id, name: "stolen-vault" } },
      },
      BOB,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// query_history dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — query_history", () => {
  it("query_history is read-only (no auth required)", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "query_history");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(false);
  });

  it("returns entries for a valid owner", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "query_history", arguments: { owner: "alice" } },
      },
      ALICE, // reads require a principal too (private deployment)
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("returns entries with optional limit param", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "query_history", arguments: { owner: "alice", limit: 5 } },
      },
      ALICE, // every tools/call needs a principal (private deployment)
    );
    const r = res!.result as { content: { text: string }[] };
    expect(r).not.toHaveProperty("isError");
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.entries).toBeDefined();
  });

  it("tools/list includes query_history", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("query_history");
  });
});

// ---------------------------------------------------------------------------
// ingest_image dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_image", () => {
  it("ingest_image is write-gated", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "ingest_image");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  it("blocks unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ingest_image", arguments: { url: "https://example.com/img.png" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("tools/list includes ingest_image", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("ingest_image");
  });
});

// ---------------------------------------------------------------------------
// ingest_pdf dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_pdf", () => {
  it("ingest_pdf is write-gated", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "ingest_pdf");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  it("blocks unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ingest_pdf", arguments: { pdf_url: "https://example.com/doc.pdf" } },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("tools/list includes ingest_pdf", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("ingest_pdf");
  });
});

// ---------------------------------------------------------------------------
// ingest_x_mention dispatch
// ---------------------------------------------------------------------------
describe("dispatchMcp — ingest_x_mention", () => {
  it("ingest_x_mention is write-gated", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "ingest_x_mention");
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
  });

  it("blocks unauthenticated calls", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "ingest_x_mention",
          arguments: { url: "https://x.com/user/status/123", triggered_by: "@alice" },
        },
      },
      null,
    );
    const r = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/authentication required/i);
  });

  it("tools/list includes ingest_x_mention", async () => {
    const res = await dispatchMcp({ id: 1, method: "tools/list" }, null);
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("ingest_x_mention");
  });
});
