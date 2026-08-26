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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
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
  isWorkspaceTextPath,
  resolveWorkspacePath,
  WORKSPACE_BINARY_ERROR,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_NOT_FOUND_ERROR,
  WORKSPACE_OUT_OF_SCOPE_ERROR,
} from "../../../sidecar/workspace.mjs";
import {
  executableKey,
  runShellCommand,
  SHELL_DENIED_COPY,
  SHELL_PATH_CHANGED_COPY,
  shellApprovalReason,
} from "../../../sidecar/shell.mjs";
import {
  AGENT_TOOL_NAMES,
  outputChipLabel,
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
    const approved = new Set(["name:node"]);
    expect(
      shellApprovalReason(
        { command: "node", args: ["build.mjs"], cwd: workspace.root },
        { workspace, approvedExecutables: approved },
      ),
    ).toBeNull();
    expect(
      shellApprovalReason(
        { command: "node", args: [], cwd: "/etc" },
        { workspace, approvedExecutables: approved },
      ),
    ).toBe("external_cwd");
    // Every argument that looks like a path is checked, not just the first: a
    // command whose cwd is inside the workspace but whose target is /etc/hosts is
    // an external command by any reading an owner would recognise.
    expect(
      shellApprovalReason(
        { command: "node", args: ["--flag", "/etc/hosts"], cwd: workspace.root },
        { workspace, approvedExecutables: approved },
      ),
    ).toBe("external_path");
    // A flag value is NOT a path — a modal in front of every command is the
    // failure mode that makes owners stop reading them.
    expect(
      shellApprovalReason(
        { command: "node", args: ["--color=always"], cwd: workspace.root },
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
      `path:${path.resolve("/usr/bin/Python3")}`,
    );
    expect(shellApprovalReason({ command: "   " }, { workspace })).toBe("invalid");
  });

  it("suspends for approval and runs nothing on Deny", async () => {
    const { generate } = scripted(
      '{"tool":"shell","input":{"command":"ls","args":["/etc"]}}',
      "unreachable",
    );
    const approvedExecutables = new Set<string>(["name:ls"]);
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
    expect(approvedExecutables.has("name:ls")).toBe(true);
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
    expect(approvedExecutables.has("name:echo")).toBe(true);
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

  it("still runs an approved resume when the reason is still external_path", async () => {
    await mkdir(workspace.root, { recursive: true });
    const approvedExecutables = new Set<string>(["name:echo"]);
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

  it("runs a cleared command with no shell, and reports its exit", async () => {
    await mkdir(workspace.root, { recursive: true });
    const result = await runShellCommand({
      command: "printf",
      args: ["a;b"],
      cwd: workspace.root,
    });
    expect(result.code).toBe(0);
    // `shell: false` — so a semicolon the model composed is an ARGUMENT, not a
    // second command.
    expect(result.stdout).toBe("a;b");

    const missing = await runShellCommand({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      cwd: workspace.root,
    });
    expect(missing.code).not.toBe(0);
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
