/**
 * Epic 8, the Agent: the tool loop, Skills, forms, workspace outputs and the
 * shell gate (Stories 8.5–8.9).
 *
 * THE MODEL IS SCRIPTED, which is what makes "the Agent calls wiki search
 * without me picking the tool" a test rather than a manual check: `generate` is
 * injected, so the suite can hand back a tool call and then an answer and assert
 * what the loop did in between. The kernel is scripted the same way — the Agent's
 * tools are HTTP calls, and a suite that needed a running kernel would be an
 * integration test pretending to be a unit one.
 *
 * Skills, the workspace and the shell all touch real files, in a temp directory:
 * their whole contract is about paths, and a mocked filesystem would not have
 * caught the traversal cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_TOOL_ROW_STATES,
  AGENT_TOOLS,
  FORM_CANCELLED_COPY,
  MAX_TOOL_CALLS_PER_TURN,
  enabledSkillNames,
  formAnswerObservation,
  normalizeFormFields,
  parseToolCall,
  runAgentTurn,
  resumeAgentTurn,
  runTool,
  toolsForTurn,
  toolRow,
  toolSystemPrompt,
  withSelectedSkill,
} from "../../../sidecar/agent.mjs";
import { parseSkillFrontmatter, readSkill, scanSkills, skillId, skillRoots } from "../../../sidecar/skills.mjs";
import {
  createAgentWorkspace,
  canonicalizePathSnapshot,
  isWorkspaceTextPath,
  resolveWorkspacePath,
  WORKSPACE_BINARY_ERROR,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_NOT_FOUND_ERROR,
  WORKSPACE_OUT_OF_SCOPE_ERROR,
} from "../../../sidecar/workspace.mjs";
import {
  canPersistExecutableApproval,
  executableKey,
  executableSnapshot,
  runShellCommand,
  SHELL_DENIED_COPY,
  SHELL_PATH_CHANGED_COPY,
  shellApprovalReason,
  shellExternalSetGrew,
  shellExternalTargets,
} from "../../../sidecar/shell.mjs";
import {
  AGENT_TOOL_NAMES,
  isChatToolRow,
  outputChipLabel,
  TOOL_ROW_STATES,
  toolRowLabel,
  workspaceFileUrl,
} from "../chat-agent";
import { normalizeConversation } from "../chat";

let dir = "";
let workspace: ReturnType<typeof createAgentWorkspace>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "epic8-agent-"));
  workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
});

afterEach(() => {
  dir = "";
});

function approved(command: string) {
  return new Set<string>([
    executableKey(command, { cwd: workspace.root, workspace }),
  ]);
}

/** A `generate` that reads a script, one entry per model call. */
function scripted(...replies: string[]) {
  const calls: { system: string; messages: { role: string; content: string }[] }[] = [];
  let index = 0;
  const generate = async (input: {
    system: string;
    messages: { role: string; content: string }[];
  }) => {
    calls.push(input);
    return replies[Math.min(index++, replies.length - 1)];
  };
  return { generate, calls };
}

/**
 * The pause a turn suspended on, or a failure that says it did not suspend.
 *
 * A resume takes the pending object back, so every one of these tests reads it
 * off the previous turn. Asserting it is there first turns "the turn answered
 * instead of pausing" into that sentence, rather than into a resume that quietly
 * ran with `undefined`.
 */
function pauseOf(turn: Awaited<ReturnType<typeof runAgentTurn>>) {
  if (!turn.pending) throw new Error("the turn did not suspend");
  return turn.pending;
}

/** A kernel that answers from a table, and records what it was asked. */
function kernelStub(table: Record<string, unknown>) {
  const seen: string[] = [];
  const kernel = async (url: string) => {
    seen.push(url);
    const key = Object.keys(table).find((prefix) => url.startsWith(prefix));
    return key ? table[key] : null;
  };
  return { kernel, seen };
}

describe("the tool vocabulary is one list", () => {
  it("names the same nine tools in the sidecar and in the browser", () => {
    // `chat-agent.ts` is the browser's copy — `ChatCanvas` cannot import
    // `sidecar/agent.mjs`, and a row labelled for a tool the loop does not have
    // (or worse, an unlabelled row) is what a drift here looks like on screen.
    expect(AGENT_TOOLS.map((tool: { name: string }) => tool.name).sort()).toEqual(
      [...AGENT_TOOL_NAMES].sort(),
    );
    for (const name of AGENT_TOOL_NAMES) {
      // Every tool has an owner-facing label, so no row can render as a bare
      // snake_case identifier.
      expect(toolRowLabel(name)).not.toBe("");
      expect(toolRowLabel(name)).not.toContain("_");
    }
  });

  it("pins every sidecar tool-row state to a browser-readable state", () => {
    expect(TOOL_ROW_STATES).toEqual(AGENT_TOOL_ROW_STATES);
    expect(
      isChatToolRow({ id: "t1", tool: "shell", state: "error", detail: "failed" }),
    ).toBe(true);
  });

  it("describes every tool in the prompt the model is given", () => {
    const prompt = toolSystemPrompt();
    for (const tool of AGENT_TOOLS as { name: string }[]) {
      expect(prompt).toContain(tool.name);
    }
  });

  it("parses a tool call and ignores prose that merely mentions one", () => {
    expect(parseToolCall('{"tool":"wiki_search","input":{"query":"alpha"}}')).toEqual({
      tool: "wiki_search",
      input: { query: "alpha" },
    });
    // A model that ANSWERS about searching has not asked to search. Treating
    // prose as a call would make the loop search on the strength of the word.
    expect(parseToolCall("I could use wiki_search for this.")).toBeNull();
    expect(parseToolCall('{"tool":"rm_rf","input":{}}')).toBeNull();
  });
});

describe("a golden turn calls wiki search without being told to", () => {
  it("records the call, its row, and the citations it produced", async () => {
    const { kernel, seen } = kernelStub({
      "/api/v1/projects/current/search": {
        results: [
          { path: "wiki/pricing.md", title: "Pricing", snippet: "Tiers are…" },
        ],
      },
    });
    const { generate, calls } = scripted(
      '{"tool":"wiki_search","input":{"query":"pricing"}}',
      "Pricing has three tiers [1].",
    );
    const rows: unknown[] = [];

    const result = await runAgentTurn({
      generate,
      emit: (event: string, payload: { toolRow?: unknown }) => {
        if (payload.toolRow) rows.push({ event, ...(payload.toolRow as object) });
      },
      messages: [{ role: "user", content: "What are our pricing tiers?" }],
      system: "You are the wiki Agent.",
      context: { kernel, wikiId: "current", workspace },
    });

    // THE OWNER PICKED NO TOOL. The question was prose; the search happened
    // because the loop decided to.
    expect(seen[0]).toContain("/api/v1/projects/current/search");
    expect(result.toolCalls).toEqual([
      { id: "t1", tool: "wiki_search", detail: "1 hit" },
    ]);
    expect(result.content).toBe("Pricing has three tiers [1].");
    expect(result.citations).toEqual([
      { n: 1, path: "wiki/pricing.md", title: "Pricing", type: "page" },
    ]);
    // A row while it runs and a row when it finishes, both rideing inside
    // `agent` — never a sixth SSE event name.
    expect(rows).toEqual([
      { event: "agent", id: "t1", tool: "wiki_search", state: "running", detail: "" },
      { event: "agent", id: "t1", tool: "wiki_search", state: "done", detail: "1 hit" },
    ]);
    // The model saw the hits, not the owner's summary — feeding it "1 hit" would
    // make the loop search twice.
    expect(calls[1].messages.at(-1)?.content).toContain("wiki/pricing.md");
  });

  it("tells the model the wiki has no coverage rather than inventing one", async () => {
    const { kernel } = kernelStub({
      "/api/v1/projects/current/search": { results: [] },
    });
    const { generate, calls } = scripted(
      '{"tool":"wiki_search","input":{"query":"unicorns"}}',
      "The wiki has nothing on that.",
    );
    const result = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "unicorns?" }],
      system: "s",
      context: { kernel, wikiId: "current", workspace },
    });
    expect(calls[1].messages.at(-1)?.content).toContain("No hits");
    // No citations minted out of nothing: an empty search cites nothing at all.
    expect(result.citations).toEqual([]);
  });

  it("stops at the tool bound and asks for an answer from what it has", async () => {
    const { kernel } = kernelStub({
      "/api/v1/projects/current/search": { results: [] },
    });
    // A model that only ever asks for another search.
    const { generate, calls } = scripted('{"tool":"wiki_search","input":{"query":"x"}}');
    const result = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "loop forever" }],
      system: "s",
      context: { kernel, wikiId: "current", workspace },
      maxToolCalls: 2,
    });
    expect(result.toolCalls).toHaveLength(2);
    // A model that searched twice has still gathered two searches' worth of
    // evidence — throwing it away to show a failure is the worse outcome.
    expect(calls.at(-1)?.messages.at(-1)?.content).toContain("Answer now");
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(6);
  });

  it("uses the four-signal graph in-app, not the wikilink export", async () => {
    const { kernel, seen } = kernelStub({
      "/api/graph/workbench": { nodes: [{ id: "a" }], edges: [] },
    });
    const result = await runTool(
      { tool: "graph", input: {} },
      { kernel, wikiId: "current", workspace },
    );
    // The loopback `/graph` export is the wikilink graph; the IN-APP tool may use
    // Epic 5's engine, which is the point of it being in-app.
    expect(seen).toEqual(["/api/graph/workbench"]);
    expect(result.detail).toBe("1 nodes, 0 edges");
  });

  it("says why the web returned nothing when no provider is configured", async () => {
    const { kernel } = kernelStub({
      "/api/v1/web-search": { results: [], error: "provider_unconfigured" },
    });
    const result = await runTool(
      { tool: "web_search", input: { query: "anything" } },
      { kernel, wikiId: "current", workspace },
    );
    // An unconfigured provider and an empty web are different facts, and the
    // Agent's next move differs.
    expect(result.detail).toBe("provider_unconfigured");
    expect(result.observation).toContain("No web search provider is configured");
  });

  it("reads AnyTXT over raw sources, with line spans", async () => {
    const { kernel, seen } = kernelStub({
      "/api/sources/search": {
        results: [
          {
            citation: "raw/sources/kickoff.md",
            startLine: 4,
            endLine: 9,
            excerpt: "we agreed to ship in March",
          },
        ],
      },
    });
    const result = await runTool(
      { tool: "source_search", input: { query: "ship" } },
      { kernel, wikiId: "current", workspace },
    );
    expect(seen[0]).toContain("/api/sources/search?q=ship");
    expect(result.detail).toBe("1 source match");
    expect(result.observation).toContain("lines 4-9");
  });
});

describe("Skills are scanned, and disabling one hides it everywhere", () => {
  async function pack(root: string, dirName: string, name: string) {
    const packDir = path.join(root, dirName);
    await mkdir(packDir, { recursive: true });
    await writeFile(
      path.join(packDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: does ${name} things\n---\n\nBody of ${name}.\n`,
      "utf8",
    );
    return packDir;
  }

  it("finds project and user packs and sorts them by name", async () => {
    const project = path.join(dir, "project-skills");
    const user = path.join(dir, "user-skills");
    await pack(project, "zebra", "Zebra");
    await pack(user, "apple", "Apple");
    const roots = [
      { scope: "project", dir: project },
      { scope: "user", dir: user },
    ];
    const skills = await scanSkills({ roots });
    expect(skills.map((skill: { name: string }) => skill.name)).toEqual([
      "Apple",
      "Zebra",
    ]);
    // No reinstall step: the packs are files, and the scan is the install.
    expect(skills[0]).toMatchObject({ scope: "user", enabled: true });
    expect(skills[1]).toMatchObject({ scope: "project", enabled: true });
  });

  it("keys enablement on where the pack is, not on what it calls itself", async () => {
    const project = path.join(dir, "skills");
    await pack(project, "notes", "Notes");
    const roots = [{ scope: "project", dir: project }];
    const id = skillId("project", "notes");
    expect(id).toBe("project:notes");

    // Absent from the map MEANS ENABLED — a fresh scan does not require the
    // owner to switch anything on.
    const [defaultOn] = await scanSkills({ roots });
    expect(defaultOn.enabled).toBe(true);

    const [off] = await scanSkills({ roots, enablement: { [id]: false } });
    expect(off.enabled).toBe(false);
    // …and a Skill the owner switched off is not READABLE either. "Disabled but
    // still readable" would be a switch that does nothing.
    expect(await readSkill(id, { roots, enablement: { [id]: false } })).toBeNull();
    const injected = await withSelectedSkill("You are the Agent.", id, {}, roots);
    expect(injected).toContain("Body of Notes.");
    const skipped = await withSelectedSkill(
      "You are the Agent.",
      id,
      { [id]: false },
      roots,
    );
    expect(skipped).toBe("You are the Agent.");
    expect(toolsForTurn(false).map((tool: { name: string }) => tool.name)).not.toContain(
      "shell",
    );
    expect(toolsForTurn(false).map((tool: { name: string }) => tool.name)).not.toContain(
      "workspace_write",
    );
    expect(
      (await readSkill(id, { roots }))?.text,
    ).toContain("Body of Notes.");
  });

  it("hides a disabled Skill from /skill completion", async () => {
    const project = path.join(dir, "skills");
    await pack(project, "notes", "Notes");
    await pack(project, "recap", "Recap");
    const roots = [{ scope: "project", dir: project }];
    const all = await scanSkills({ roots });
    expect(all.map((s: { name: string }) => s.name)).toEqual(["Notes", "Recap"]);
    const enabled = await scanSkills({
      roots,
      enablement: { "project:notes": false },
    });
    expect(
      enabled.filter((s: { enabled: boolean }) => s.enabled).map((s: { name: string }) => s.name),
    ).toEqual(["Recap"]);
    // The Agent's own tool refuses it by the same rule.
    const refused = await runTool(
      { tool: "skill_read", input: { id: "project:notes" } },
      {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        enablement: { "project:notes": false },
      },
    );
    expect(refused.observation).toBe("That Skill is not enabled.");
  });

  it("keeps a pack with a malformed header rather than hiding it", async () => {
    const project = path.join(dir, "skills");
    const packDir = path.join(project, "broken");
    await mkdir(packDir, { recursive: true });
    await writeFile(path.join(packDir, "SKILL.md"), "no frontmatter here", "utf8");
    const [found] = await scanSkills({
      roots: [{ scope: "project", dir: project }],
    });
    // Falling back to the directory name: a Skill with a bad header is still a
    // Skill, and hiding it would be a silent failure the owner cannot see.
    expect(found.name).toBe("broken");
    expect(parseSkillFrontmatter("no frontmatter", "fallback").name).toBe("fallback");
    expect(parseSkillFrontmatter('---\nname: "Quoted"\n---\n', "x").name).toBe("Quoted");
  });

  it("looks in the project cwd and the user home, project first", () => {
    const roots = skillRoots({ cwd: "/repo", home: "/home/me" });
    expect(roots).toEqual([
      { scope: "project", dir: path.join("/repo", "skills") },
      { scope: "user", dir: path.join("/home/me", ".workwiki", "skills") },
    ]);
  });

  it("returns no names at all when nothing is installed", async () => {
    // `enabledSkillNames` walks the real roots; on a machine with no packs the
    // answer is an empty list rather than a throw.
    expect(Array.isArray(await enabledSkillNames({}))).toBe(true);
  });
});

describe("a Skill form pauses the turn", () => {
  const formCall = {
    tool: "skill_form",
    input: {
      title: "Which client?",
      fields: [
        { name: "client", label: "Client", kind: "single", options: ["Acme", "Globex"] },
        { name: "areas", label: "Areas", kind: "multiple", options: ["Pricing", "Legal"] },
        { name: "note", label: "Anything else", kind: "text" },
      ],
    },
  };

  it("normalizes the three field kinds and degrades an optionless picker to text", () => {
    const fields = normalizeFormFields([
      { name: "a", kind: "single", options: ["x"] },
      { name: "b", kind: "multiple", options: [] },
      { name: "c", kind: "text" },
      { name: "d", kind: "nonsense" },
      { name: "", kind: "text" },
      "not an object",
    ]);
    expect(fields.map((field: { name: string; kind: string }) => [field.name, field.kind])).toEqual([
      ["a", "single"],
      // A picker with nothing to pick is a text box, not a dead control.
      ["b", "text"],
      ["c", "text"],
      ["d", "text"],
    ]);
  });

  it("suspends with the fields and resumes with the answers", async () => {
    const { generate } = scripted(
      JSON.stringify(formCall),
      "Acme it is, focusing on Pricing.",
    );
    const rows: { state: string }[] = [];
    const paused = await runAgentTurn({
      generate,
      emit: (_event: string, payload: { toolRow?: { state: string } }) => {
        if (payload.toolRow) rows.push(payload.toolRow);
      },
      messages: [{ role: "user", content: "start the client recap" }],
      system: "s",
      context: { kernel: async () => null, wikiId: "current", workspace },
    });

    expect(paused.pending).toMatchObject({
      kind: "skill_form",
      title: "Which client?",
      rowId: "t1",
    });
    expect(paused.content).toBe("");
    expect(rows.at(-1)?.state).toBe("pending");

    const answered = await resumeAgentTurn({
      pending: pauseOf(paused),
      approved: true,
      answers: { client: "Acme", areas: ["Pricing"], note: "" },
      generate,
      system: "s",
      context: { kernel: async () => null, wikiId: "current", workspace },
    });
    expect(answered.content).toBe("Acme it is, focusing on Pricing.");
    expect(answered.toolCalls).toEqual([
      { id: "t1", tool: "skill_form", detail: "submitted" },
    ]);
  });

  it("leaves the conversation intact on Cancel and does not run the pending tool", async () => {
    const { generate } = scripted(JSON.stringify(formCall), "unreachable");
    const paused = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "start" }],
      system: "s",
      context: { kernel: async () => null, wikiId: "current", workspace },
    });
    const cancelled = await resumeAgentTurn({
      // Esc arrives here as exactly this.
      pending: pauseOf(paused),
      approved: false,
      generate,
      system: "s",
      context: { kernel: async () => null, wikiId: "current", workspace },
    });
    expect(cancelled.content).toBe(FORM_CANCELLED_COPY);
    expect(cancelled.toolCalls).toEqual([
      { id: "t1", tool: "skill_form", detail: "cancelled" },
    ]);
    // Nothing the Agent had already gathered is lost, and nothing new ran.
    expect(cancelled.outputs).toEqual([]);
  });

  it("tells the model to ask in prose when a form has no usable field", async () => {
    const result = await runTool(
      { tool: "skill_form", input: { title: "Empty", fields: [] } },
      { kernel: async () => null, wikiId: "current", workspace },
    );
    // A form with no answerable field would block the turn on a modal the owner
    // cannot fill in.
    expect(result.pending).toBeUndefined();
    expect(result.observation).toContain("Ask in plain language");
  });

  it("labels the answers so the model can read them back", () => {
    const fields = normalizeFormFields(formCall.input.fields);
    const observation = formAnswerObservation(fields, {
      client: "Acme",
      areas: ["Pricing", "Legal"],
      note: "",
    });
    expect(observation).toContain("Client");
    expect(observation).toContain("Acme");
    expect(observation).toContain("Pricing, Legal");
  });
});

describe("workspace outputs", () => {
  it("writes under agent-workspace/, chips the file, and reads it back", async () => {
    const written = await runTool(
      {
        tool: "workspace_write",
        input: { path: "recaps/acme.md", contents: "# Acme recap\n" },
      },
      { kernel: async () => null, wikiId: "current", workspace },
    );
    expect(written.output).toEqual({
      path: "recaps/acme.md",
      name: "acme.md",
      bytes: 13,
    });
    // The chip is labelled from those bytes without a second stat.
    expect(outputChipLabel(written.output)).toContain("acme.md");
    // The bytes are on THIS disk, under the sidecar's workspace — the wiki's own
    // bytes still go through the kernel.
    expect(
      await readFile(path.join(workspace.root, "recaps/acme.md"), "utf8"),
    ).toBe("# Acme recap\n");

    // …and Preview reads it back through the same object, which is what makes a
    // chip clickable after a restart: the file outlives the process.
    const read = await workspace.read("recaps/acme.md");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ name: "acme.md", content: "# Acme recap\n" });
  });

  it("refuses to escape the workspace, whatever the path spells", async () => {
    for (const escape of [
      "../outside.md",
      "recaps/../../outside.md",
      "/etc/passwd",
      "",
    ]) {
      expect(resolveWorkspacePath(workspace.root, escape)).toBeNull();
      const refused = await runTool(
        { tool: "workspace_write", input: { path: escape, contents: "x" } },
        { kernel: async () => null, wikiId: "current", workspace },
      );
      // A REFUSAL THE MODEL CAN SEE. A write that silently did not happen is the
      // one failure a tool loop cannot recover from: the next turn cites a file
      // that is not there.
      expect(refused.detail).toBe("refused");
      expect(refused.output).toBeUndefined();
    }
    expect((await workspace.read("../outside.md")).status).toBe(403);
    expect((await workspace.read("../outside.md")).body).toEqual({
      error: WORKSPACE_OUT_OF_SCOPE_ERROR,
    });
    const outside = path.join(dir, "outside");
    await mkdir(workspace.root, { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(workspace.root, "escape"));
    await expect(workspace.write("escape/secret.md", "no")).rejects.toThrow(
      WORKSPACE_OUT_OF_SCOPE_ERROR,
    );
    await expect(readFile(path.join(outside, "secret.md"), "utf8")).rejects.toThrow();
  });

  it("gives each read refusal its own status", async () => {
    expect(await workspace.read("missing.md")).toEqual({
      status: 404,
      body: { error: WORKSPACE_NOT_FOUND_ERROR },
    });
    await workspace.write("deck.pdf", "%PDF-1.7");
    // Decided by EXTENSION, so Preview never renders a decoded PDF's mojibake.
    expect(await workspace.read("deck.pdf")).toEqual({
      status: 415,
      body: { error: WORKSPACE_BINARY_ERROR },
    });
    expect(isWorkspaceTextPath("notes.md")).toBe(true);
    expect(isWorkspaceTextPath("notes")).toBe(false);
    expect(WORKSPACE_MAX_FILE_BYTES).toBe(1_048_576);
  });

  it("survives a restart with the conversation, as persisted output rows", () => {
    // The kernel Chat store is what carries the chip across a restart; the
    // sidecar carries the bytes. `normalizeConversation` is the half that has to
    // keep the row, and the path stays WORKSPACE-RELATIVE — a stored
    // `agent-workspace/` prefix would double up when Preview asks for it.
    const conversation = normalizeConversation({
      id: "c1",
      title: "Acme",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      selectedSkill: "project:notes",
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "Wrote the recap.",
          sources: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          toolCalls: [{ id: "t1", tool: "workspace_write", detail: "acme.md" }],
          outputs: [{ path: "recaps/acme.md", name: "acme.md", bytes: 13 }],
        },
      ],
    });
    expect(conversation?.selectedSkill).toBe("project:notes");
    expect(conversation?.messages[0].outputs).toEqual([
      { path: "recaps/acme.md", name: "acme.md", bytes: 13 },
    ]);
    expect(conversation?.messages[0].toolCalls).toEqual([
      { id: "t1", tool: "workspace_write", detail: "acme.md" },
    ]);
    // …and the URL Preview asks the sidecar for carries the path exactly once.
    const url = workspaceFileUrl("recaps/acme.md");
    expect(url).toContain(encodeURIComponent("recaps/acme.md"));
    expect(url).not.toContain("agent-workspace");

    // A conversation written before Epic 8 has neither field, and opens with
    // neither rather than with empty arrays.
    const legacy = normalizeConversation({
      id: "c0",
      title: "Old",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        {
          role: "assistant",
          content: "Answer.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(legacy.selectedSkill).toBeUndefined();
    expect(legacy.messages[0].toolCalls).toBeUndefined();
    expect(legacy.messages[0].outputs).toBeUndefined();
  });
});

describe("the shell asks before it leaves the workspace", () => {
  it("classifies a workspace command, an external cwd, and an external target", () => {
    const approved = new Set([
      executableKey("git", { cwd: workspace.root, workspace }),
    ]);
    expect(
      shellApprovalReason(
        { command: "git", args: ["status"], cwd: workspace.root },
        { workspace, approvedExecutables: approved },
      ),
    ).toBeNull();
    expect(
      shellApprovalReason(
        { command: "git", args: [], cwd: "/etc" },
        { workspace, approvedExecutables: approved },
      ),
    ).toBe("external_cwd");
    // Every argument that looks like a path is checked, not just the first: a
    // command whose cwd is inside the workspace but whose target is /etc/hosts is
    // an external command by any reading an owner would recognise.
    expect(
      shellApprovalReason(
        { command: "git", args: ["--flag", "/etc/hosts"], cwd: workspace.root },
        { workspace, approvedExecutables: approved },
      ),
    ).toBe("external_path");
    // A flag value is NOT a path — a modal in front of every command is the
    // failure mode that makes owners stop reading them.
    expect(
      shellApprovalReason(
        { command: "git", args: ["--color=always"], cwd: workspace.root },
        { workspace, approvedExecutables: approved },
      ),
    ).toBeNull();
    // A program the Agent has not used before asks once, by basename.
    expect(
      shellApprovalReason(
        { command: "/usr/bin/python3", args: [], cwd: workspace.root },
        { workspace, approvedExecutables: approved },
      ),
    ).toBe("new_executable");
    expect(executableKey("/usr/bin/Python3")).toBe(
      `path:${canonicalizePathSnapshot("/usr/bin/Python3")}`,
    );
    expect(shellApprovalReason({ command: "   " }, { workspace })).toBe("invalid");
  });

  it("treats a missing leaf below an outside symlink as external", async () => {
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await mkdir(workspace.root, { recursive: true });
    await symlink(outside, path.join(workspace.root, "escape"));
    expect(
      shellApprovalReason(
        {
          command: "echo",
          args: ["escape/not-created-yet.txt"],
          cwd: workspace.root,
        },
        { workspace, approvedExecutables: approved("echo") },
      ),
    ).toBe("external_path");
  });

  it("follows a dangling symlink target for a missing leaf and fails closed on cycles", async () => {
    const danglingTarget = path.join(dir, "outside-not-created", "nested");
    await mkdir(workspace.root, { recursive: true });
    await symlink(danglingTarget, path.join(workspace.root, "dangling"));
    const leaf = path.join(workspace.root, "dangling", "future.txt");
    expect(canonicalizePathSnapshot(leaf)).toBe(
      canonicalizePathSnapshot(path.join(danglingTarget, "future.txt")),
    );
    expect(workspace.contains(leaf)).toBe(false);
    expect(
      shellApprovalReason(
        {
          command: "echo",
          args: ["dangling/future.txt"],
          cwd: workspace.root,
        },
        { workspace, approvedExecutables: approved("echo") },
      ),
    ).toBe("external_path");

    await symlink("cycle-b", path.join(workspace.root, "cycle-a"));
    await symlink("cycle-a", path.join(workspace.root, "cycle-b"));
    expect(
      canonicalizePathSnapshot(path.join(workspace.root, "cycle-a", "x")),
    ).toBeNull();
    expect(
      canonicalizePathSnapshot(`/${"component/".repeat(1_025)}leaf`),
    ).toBeNull();
  });

  it("uses the filesystem's canonical case for an existing path", async () => {
    const actual = path.join(dir, "CaseSensitiveApprovalTarget");
    const alias = path.join(dir, "casesensitiveapprovaltarget");
    await writeFile(actual, "ok");
    try {
      await access(alias);
    } catch {
      return;
    }
    expect(canonicalizePathSnapshot(alias)).toBe(canonicalizePathSnapshot(actual));
  });

  it("suspends for approval and runs nothing on Deny", async () => {
    const { generate } = scripted(
      '{"tool":"shell","input":{"command":"ls","args":["/etc"]}}',
      "unreachable",
    );
    const approvedExecutables = approved("ls");
    const paused = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "list /etc" }],
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(paused.pending).toMatchObject({
      kind: "shell_approval",
      reason: "external_path",
      command: "ls",
      args: ["/etc"],
    });

    const denied = await resumeAgentTurn({
      pending: pauseOf(paused),
      approved: false,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(denied.content).toBe(SHELL_DENIED_COPY);
    // NO ALLOW-ALL: a Deny does not teach the approval memory anything, so the
    // same command asks again next time.
    expect(
      approvedExecutables.has(
        executableKey("ls", { cwd: workspace.root, workspace }),
      ),
    ).toBe(true);
    expect(denied.toolCalls).toEqual([
      { id: "t1", tool: "shell", detail: SHELL_DENIED_COPY },
    ]);
  });

  it("remembers the approved executable for the conversation, and only that one", async () => {
    const approvedExecutables = new Set<string>();
    const { generate } = scripted(
      JSON.stringify({
        tool: "shell",
        input: { command: "echo", args: ["hello"], cwd: workspace.root },
      }),
      "Done.",
    );
    await workspace.write(".keep", "");
    const paused = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "say hello" }],
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(pauseOf(paused).reason).toBe("new_executable");

    const ran = await resumeAgentTurn({
      pending: pauseOf(paused),
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(ran.content).toBe("Done.");
    expect(ran.toolCalls).toEqual([{ id: "t1", tool: "shell", detail: "exit 0" }]);
    // The same program stops asking; a DIFFERENT program asks again.
    expect(
      approvedExecutables.has(
        executableKey("echo", { cwd: workspace.root, workspace }),
      ),
    ).toBe(true);
    expect(
      shellApprovalReason(
        { command: "echo", args: [], cwd: workspace.root },
        { workspace, approvedExecutables },
      ),
    ).toBeNull();
    expect(
      shellApprovalReason(
        { command: "curl", args: [], cwd: workspace.root },
        { workspace, approvedExecutables },
      ),
    ).toBe("new_executable");
  });

  it("remembers a canonical system executable and asks again after its alias is re-pointed", async () => {
    await mkdir(workspace.root, { recursive: true });
    const command = path.join(dir, "tool");
    await symlink("/bin/echo", command);
    const firstPath = canonicalizePathSnapshot(command);
    expect(firstPath).not.toBeNull();
    const approvedExecutables = new Set<string>();
    const { generate } = scripted("Done.");
    const ran = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command,
        args: [],
        cwd: workspace.root,
        reason: "new_executable",
        externalCwd: false,
        externalPaths: [firstPath!],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(ran.content).toBe("Done.");
    const firstKey = executableKey(command, { cwd: workspace.root, workspace });
    expect(approvedExecutables).toEqual(new Set([firstKey]));
    expect(
      shellApprovalReason(
        { command, args: [], cwd: workspace.root },
        { workspace, approvedExecutables },
      ),
    ).toBeNull();

    await rm(command);
    await symlink("/bin/ls", command);
    expect(executableKey(command, { cwd: workspace.root, workspace })).not.toBe(
      firstKey,
    );
    expect(
      shellApprovalReason(
        { command, args: [], cwd: workspace.root },
        { workspace, approvedExecutables },
      ),
    ).toBe("new_executable");
  });

  it("denies a relative path executable that is re-pointed while approval is pending", async () => {
    await mkdir(workspace.root, { recursive: true });
    const first = path.join(workspace.root, "tool-first");
    const second = path.join(workspace.root, "tool-second");
    const link = path.join(workspace.root, "tool");
    await writeFile(first, "#!/bin/sh\necho first\n");
    await writeFile(second, "#!/bin/sh\necho second\n");
    await chmod(first, 0o755);
    await chmod(second, 0o755);
    await symlink(first, link);
    const { generate } = scripted(
      JSON.stringify({
        tool: "shell",
        input: { command: "./tool", args: [], cwd: workspace.root },
      }),
      "unreachable",
    );
    const paused = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "run it" }],
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables: new Set(),
      },
    });
    expect(pauseOf(paused).executableKey).toBe(
      executableKey("./tool", { cwd: workspace.root, workspace }),
    );
    await rm(link);
    await symlink(second, link);
    const spawnImpl = vi.fn(() => {
      throw new Error("must not spawn");
    });
    const result = await resumeAgentTurn({
      pending: pauseOf(paused),
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables: new Set(),
        spawnImpl,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("denies a bare executable when PATH points its name at a new binary", async () => {
    await mkdir(workspace.root, { recursive: true });
    const firstBin = path.join(dir, "bin-first");
    const secondBin = path.join(dir, "bin-second");
    await mkdir(firstBin);
    await mkdir(secondBin);
    for (const root of [firstBin, secondBin]) {
      const executable = path.join(root, "epic8-runner");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
    }
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = firstBin;
      const { generate } = scripted(
        JSON.stringify({ tool: "shell", input: { command: "epic8-runner" } }),
        "unreachable",
      );
      const paused = await runAgentTurn({
        generate,
        messages: [{ role: "user", content: "run it" }],
        system: "s",
        context: {
          kernel: async () => null,
          wikiId: "current",
          workspace,
          approvedExecutables: new Set(),
        },
      });
      process.env.PATH = secondBin;
      const spawnImpl = vi.fn(() => {
        throw new Error("must not spawn");
      });
      const result = await resumeAgentTurn({
        pending: pauseOf(paused),
        approved: true,
        generate,
        system: "s",
        context: {
          kernel: async () => null,
          wikiId: "current",
          workspace,
          approvedExecutables: new Set(),
          spawnImpl,
        },
      });
      expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it("requires per-command approval for inline interpreter code", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = approved("sh");
    expect(
      shellApprovalReason(
        { command: "sh", args: ["-c", "exit 0"], cwd: workspace.root },
        { workspace, approvedExecutables },
      ),
    ).toBe("new_executable");
    const { generate } = scripted(
      JSON.stringify({
        tool: "shell",
        input: { command: "sh", args: ["-c", "exit 0"], cwd: workspace.root },
      }),
      "Done.",
    );
    const paused = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "run inline code" }],
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    approvedExecutables.clear();
    const result = await resumeAgentTurn({
      pending: pauseOf(paused),
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(result.content).toBe("Done.");
    expect(approvedExecutables.size).toBe(0);
  });

  it("keeps every interpreter and dynamic launcher per-command", () => {
    const launchers = [
      "sh", "bash", "dash", "zsh", "ksh", "fish", "csh", "tcsh",
      "pwsh", "powershell", "cmd", "node", "ruby", "perl", "php",
      "lua", "luajit", "osascript", "java", "dotnet", "mono", "env",
      "xargs", "npm", "npx", "pnpm", "yarn", "bun", "deno", "corepack",
    ];
    for (const command of launchers) {
      for (const spelling of [
        command,
        `${command}.EXE`,
        `${command}.cmd`,
        `${command}.BAT`,
        `${command}.com`,
      ]) {
        expect(canPersistExecutableApproval(spelling), spelling).toBe(false);
      }
      expect(
        shellApprovalReason(
          { command, args: ["--version"], cwd: workspace.root },
          {
            workspace,
            executable: { key: `name:${command}`, command },
            approvedExecutables: new Set([`name:${command}`]),
          },
        ),
        command,
      ).toBe("new_executable");
    }
    for (const command of ["python", "python2", "python3", "python3.12"]) {
      expect(canPersistExecutableApproval(command), command).toBe(false);
      expect(canPersistExecutableApproval(`${command}.EXE`), `${command}.EXE`).toBe(false);
    }
  });

  it("classifies a launcher alias by its canonical executable target", async () => {
    await mkdir(workspace.root, { recursive: true });
    const alias = path.join(workspace.root, "safe-runner");
    await symlink("/bin/sh", alias);
    const executable = executableSnapshot(alias, {
      cwd: workspace.root,
      workspace,
    });
    expect(executable.command).toBe(canonicalizePathSnapshot("/bin/sh"));
    expect(canPersistExecutableApproval(executable.command)).toBe(false);
    expect(
      shellApprovalReason(
        { command: alias, args: ["-c", "exit 0"], cwd: workspace.root },
        {
          workspace,
          executable,
          approvedExecutables: new Set([executable.key]),
        },
      ),
    ).toBe("new_executable");
  });

  it("does not remember an approved canonical launcher alias", async () => {
    await mkdir(workspace.root, { recursive: true });
    const alias = path.join(dir, "outside-safe-runner");
    await symlink("/bin/sh", alias);
    const executable = executableSnapshot(alias, {
      cwd: workspace.root,
      workspace,
    });
    const aliasPath = canonicalizePathSnapshot(alias);
    expect(aliasPath).not.toBeNull();
    expect(canPersistExecutableApproval(alias, [], { workspace, cwd: workspace.root })).toBe(true);
    expect(canPersistExecutableApproval(executable.command)).toBe(false);
    const approvedExecutables = new Set<string>();
    const { generate } = scripted("Done.");
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t-alias",
        command: alias,
        args: ["-c", "exit 0"],
        cwd: workspace.root,
        reason: "new_executable",
        executableKey: executable.key,
        externalCwd: false,
        externalPaths: [aliasPath!],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(result.content).toBe("Done.");
    expect(approvedExecutables).toEqual(new Set());
    expect(
      shellApprovalReason(
        { command: alias, args: ["-c", "exit 0"], cwd: workspace.root },
        { workspace, executable, approvedExecutables },
      ),
    ).toBe("new_executable");
  });

  it("does not remember a copied interpreter under a safe-looking name", async () => {
    await mkdir(workspace.root, { recursive: true });
    const command = path.join(dir, "copied-safe-runner");
    await writeFile(command, await readFile("/bin/sh"));
    // The file itself is read-only, but its owner-writable parent can replace
    // it at the same path. That path must still never become a capability.
    await chmod(command, 0o555);
    const executable = executableSnapshot(command, {
      cwd: workspace.root,
      workspace,
    });
    const commandPath = canonicalizePathSnapshot(command);
    expect(commandPath).not.toBeNull();
    expect(
      canPersistExecutableApproval(executable.command, [], {
        workspace,
        cwd: workspace.root,
      }),
    ).toBe(false);
    const approvedExecutables = new Set<string>();
    const { generate } = scripted("Done.");
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t-copy",
        command,
        args: ["-c", "exit 0"],
        cwd: workspace.root,
        reason: "new_executable",
        executableKey: executable.key,
        externalCwd: false,
        externalPaths: [commandPath!],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(result.content).toBe("Done.");
    expect(approvedExecutables).toEqual(new Set());
  });

  it("denies a path that appears or becomes executable after its modal", async () => {
    await mkdir(workspace.root, { recursive: true });
    for (const variant of ["missing", "non-executable"] as const) {
      const command = path.join(workspace.root, `future-${variant}`);
      if (variant === "non-executable") {
        await writeFile(command, "#!/bin/sh\nexit 0\n");
      }
      const { generate } = scripted(
        JSON.stringify({ tool: "shell", input: { command, args: [] } }),
        "unreachable",
      );
      const paused = await runAgentTurn({
        generate,
        messages: [{ role: "user", content: "run it" }],
        system: "s",
        context: {
          kernel: async () => null,
          wikiId: "current",
          workspace,
          approvedExecutables: new Set(),
        },
      });
      expect(pauseOf(paused).executableKey, variant).toBe("");
      if (variant === "missing") {
        await writeFile(command, "#!/bin/sh\nexit 0\n");
      }
      await chmod(command, 0o755);
      const spawnImpl = vi.fn(() => {
        throw new Error("must not spawn");
      });
      const result = await resumeAgentTurn({
        pending: pauseOf(paused),
        approved: true,
        generate,
        system: "s",
        context: {
          kernel: async () => null,
          wikiId: "current",
          workspace,
          approvedExecutables: new Set(),
          spawnImpl,
        },
      });
      expect(result.content, variant).toBe(SHELL_PATH_CHANGED_COPY);
      expect(spawnImpl, variant).not.toHaveBeenCalled();
    }
  });

  it("does not run a new_executable resume after the path becomes external", async () => {
    const approvedExecutables = new Set<string>();
    const { generate } = scripted("unreachable");
    const escaped = {
      ...workspace,
      contains: () => false,
    };
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: "echo",
        args: ["hello"],
        cwd: workspace.root,
        reason: "new_executable",
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace: escaped,
        approvedExecutables,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(approvedExecutables.size).toBe(0);
    expect(result.toolCalls).toEqual([
      { id: "t1", tool: "shell", detail: SHELL_PATH_CHANGED_COPY },
    ]);
  });

  it("does not run a new_executable resume after an argument path becomes external", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = new Set<string>();
    const { generate } = scripted("unreachable");
    const escaped = {
      ...workspace,
      contains: (candidate: string) =>
        path.resolve(candidate) === path.resolve(workspace.root),
    };
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: "echo",
        args: ["notes/x.txt"],
        cwd: workspace.root,
        reason: "new_executable",
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace: escaped,
        approvedExecutables,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(approvedExecutables.size).toBe(0);
    expect(result.toolCalls).toEqual([
      { id: "t1", tool: "shell", detail: SHELL_PATH_CHANGED_COPY },
    ]);
  });

  it("does not run an external_path resume after a second argument becomes external", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = approved("echo");
    const { generate } = scripted("unreachable");
    const escaped = {
      ...workspace,
      contains: (candidate: string) =>
        path.resolve(candidate) === path.resolve(workspace.root),
    };
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: "echo",
        args: ["/etc/hosts", "notes/x.txt"],
        cwd: workspace.root,
        reason: "external_path",
        externalCwd: false,
        externalPaths: [path.resolve("/etc/hosts")],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace: escaped,
        approvedExecutables,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(result.toolCalls).toEqual([
      { id: "t1", tool: "shell", detail: SHELL_PATH_CHANGED_COPY },
    ]);
  });

  it("still runs an approved resume when the reason is still external_path", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = approved("echo");
    const { generate } = scripted("Done.");
    const ran = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: "echo",
        args: ["/etc"],
        cwd: workspace.root,
        reason: "external_path",
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(ran.content).toBe("Done.");
    expect(ran.toolCalls).toEqual([{ id: "t1", tool: "shell", detail: "exit 0" }]);
  });

  it("does not run a captured new_executable resume after cwd becomes external", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = approved("echo");
    const { generate } = scripted("unreachable");
    const escaped = {
      ...workspace,
      contains: () => false,
    };
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: "echo",
        args: ["hello"],
        cwd: workspace.root,
        reason: "new_executable",
        externalCwd: false,
        externalPaths: [],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace: escaped,
        approvedExecutables,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(approvedExecutables.size).toBe(1);
  });

  it("does not run an external_cwd resume after the cwd realpath leaves the approved set", async () => {
    await mkdir(workspace.root, { recursive: true });
    const safe = path.join(dir, "safe");
    const other = path.join(dir, "other");
    await mkdir(safe);
    await mkdir(other);
    const approvedExecutables = approved("echo");
    const { generate } = scripted("unreachable");
    await rm(safe, { recursive: true });
    await symlink(other, safe);
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: "echo",
        args: ["hello"],
        cwd: safe,
        reason: "external_cwd",
        externalCwd: true,
        // Pause approved a different external cwd. The live cwd is `safe`,
        // now a symlink to `other` — same reason label, different dest.
        externalPaths: [path.join(dir, "safe-at-pause")],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(approvedExecutables.size).toBe(1);
  });

  it("does not run a new_executable resume after the command path is swapped outside", async () => {
    await mkdir(workspace.root, { recursive: true });
    const bin = path.join(workspace.root, "tool");
    const outside = path.join(dir, "outside-tool");
    await writeFile(bin, "#!/bin/sh\necho inside\n");
    await writeFile(outside, "#!/bin/sh\necho outside\n");
    await rm(bin);
    await symlink(outside, bin);
    const approvedExecutables = new Set<string>();
    const { generate } = scripted("unreachable");
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command: bin,
        args: [],
        cwd: workspace.root,
        reason: "new_executable",
        externalCwd: false,
        externalPaths: [],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(approvedExecutables.size).toBe(0);
  });

  it("denies a missing-leaf target whose canonical parent changes after the modal", async () => {
    const outsideA = path.join(dir, "outside-a");
    const outsideB = path.join(dir, "outside-b");
    await mkdir(outsideA);
    await mkdir(outsideB);
    await mkdir(workspace.root, { recursive: true });
    await symlink(outsideA, path.join(workspace.root, "escape"));
    const approvedExecutables = new Set<string>();
    const { generate } = scripted(
      JSON.stringify({
        tool: "shell",
        input: {
          command: "echo",
          args: ["escape/not-created-yet.txt"],
          cwd: workspace.root,
        },
      }),
      "unreachable",
    );
    const paused = await runAgentTurn({
      generate,
      messages: [{ role: "user", content: "name the future file" }],
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(pauseOf(paused)).toMatchObject({
      reason: "external_path",
      externalPaths: [
        canonicalizePathSnapshot(path.join(outsideA, "not-created-yet.txt")),
      ],
    });

    // The approval-time canonical snapshot names outside-a. Replacing that
    // ancestor with a symlink must not make the stored snapshot follow it.
    await rm(outsideA, { recursive: true });
    await symlink(outsideB, outsideA);
    const spawnImpl = vi.fn(() => {
      throw new Error("must not spawn");
    });
    const result = await resumeAgentTurn({
      pending: pauseOf(paused),
      approved: true,
      generate,
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
        spawnImpl,
      },
    });
    expect(result.content).toBe(SHELL_PATH_CHANGED_COPY);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(
      approvedExecutables.has(
        executableKey("echo", { cwd: workspace.root, workspace }),
      ),
    ).toBe(false);
  });

  it("does not remember approval when the executable never starts", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = new Set<string>();
    const command = "definitely-not-a-real-binary-xyz";
    const { generate } = scripted("Done.");
    const emitted: unknown[] = [];
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t1",
        command,
        args: [],
        cwd: workspace.root,
        reason: "new_executable",
        externalCwd: false,
        externalPaths: [],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      emit: (_event, payload) => emitted.push(payload),
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables,
      },
    });
    expect(result.content).toBe("Done.");
    expect(emitted).toContainEqual({
      toolRow: expect.objectContaining({ state: "error" }),
    });
    expect(result.toolCalls[0].detail).toMatch(/^failed to start/);
    expect(
      approvedExecutables.has(
        executableKey(command, { cwd: workspace.root, workspace }),
      ),
    ).toBe(false);
    expect(
      shellApprovalReason(
        { command, args: [], cwd: workspace.root },
        { workspace, approvedExecutables },
      ),
    ).toBe("new_executable");
  });

  it("renders a signal-terminated resumed command as an error", async () => {
    await mkdir(workspace.root, { recursive: true });
    const executable = executableSnapshot("sh", {
      cwd: workspace.root,
      workspace,
    });
    const emitted: unknown[] = [];
    const { generate } = scripted("Done.");
    const result = await resumeAgentTurn({
      pending: {
        kind: "shell_approval",
        rowId: "t-signal",
        command: "sh",
        args: ["-c", "kill -TERM $$"],
        cwd: workspace.root,
        reason: "new_executable",
        executableKey: executable.key,
        externalCwd: false,
        externalPaths: [],
        transcript: [],
        toolCalls: [],
        outputs: [],
        rowSeed: 0,
      },
      approved: true,
      generate,
      emit: (_event, payload) => emitted.push(payload),
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables: new Set(),
      },
    });
    expect(result.content).toBe("Done.");
    expect(emitted).toContainEqual({
      toolRow: expect.objectContaining({
        state: "error",
        detail: expect.stringContaining("SIGTERM"),
      }),
    });
  });

  it("marks an already-approved command that cannot start as an error row", async () => {
    const command = "definitely-not-a-real-approved-binary-xyz";
    const emitted: unknown[] = [];
    const { generate } = scripted(
      JSON.stringify({ tool: "shell", input: { command, args: [] } }),
      "Done.",
    );
    const result = await runAgentTurn({
      generate,
      emit: (_event, payload) => emitted.push(payload),
      messages: [{ role: "user", content: "run it" }],
      system: "s",
      context: {
        kernel: async () => null,
        wikiId: "current",
        workspace,
        approvedExecutables: new Set([`name:${command}`]),
      },
    });
    expect(result.content).toBe("Done.");
    expect(emitted).toContainEqual({
      toolRow: expect.objectContaining({ state: "error" }),
    });
    expect(result.toolCalls[0].detail).toMatch(/^failed to start/);
  });

  it("keys the external set on realpath, including cwd and a path-shaped command", () => {
    const stored = {
      externalCwd: true,
      externalPaths: [path.resolve("/tmp/safe")],
    };
    const liveCwd = shellExternalTargets(
      { command: "echo", args: [], cwd: "/etc" },
      { workspace },
    );
    expect(liveCwd.externalCwd).toBe(true);
    expect(liveCwd.externalPaths.length).toBeGreaterThan(0);
    expect(shellExternalSetGrew(stored, liveCwd)).toBe(true);

    const insideCmd = shellExternalTargets(
      { command: "echo", args: [], cwd: workspace.root },
      { workspace },
    );
    const outsideCmd = shellExternalTargets(
      { command: "/tmp/evil/bin", args: [], cwd: workspace.root },
      { workspace },
    );
    expect(
      shellExternalSetGrew(
        { externalCwd: false, externalPaths: insideCmd.externalPaths },
        outsideCmd,
      ),
    ).toBe(true);
  });

  it("runs a cleared command with no shell, and reports its exit", async () => {
    await mkdir(workspace.root, { recursive: true });
    const result = await runShellCommand({
      command: "printf",
      args: ["a;b"],
      cwd: workspace.root,
    });
    expect(result.code).toBe(0);
    expect(result.started).toBe(true);
    // `shell: false` — so a semicolon the model composed is an ARGUMENT, not a
    // second command.
    expect(result.stdout).toBe("a;b");

    const missing = await runShellCommand({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      cwd: workspace.root,
    });
    expect(missing.code).not.toBe(0);
    expect(missing.started).toBe(false);
  });

  it("retains the timeout signal instead of reporting exit null", async () => {
    await mkdir(workspace.root, { recursive: true });
    const result = await runShellCommand(
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: workspace.root,
      },
      { timeoutMs: 20, workspace },
    );
    expect(result).toMatchObject({
      code: null,
      signal: "SIGKILL",
      timedOut: true,
      started: true,
    });
  });

  it("labels a row for every state the surface draws", () => {
    expect(toolRow("t1", "shell", "running")).toEqual({
      id: "t1",
      tool: "shell",
      state: "running",
      detail: "",
    });
    expect(toolRow("t1", "shell", "denied", SHELL_DENIED_COPY).detail).toBe(
      SHELL_DENIED_COPY,
    );
  });
});
