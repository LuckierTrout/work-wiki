/**
 * Epic 8 retrospective remediations (2026-08-25).
 *
 * These are the release blockers the retro reproduced against 07332c8:
 * forged HTTP shell resume, workspace write-through-symlink that deletes the
 * outside file, approved commands that run from the repo root, tool-only
 * persist refused for missing wiki citations, and MCP config that only works
 * from the repository cwd.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createSidecarServer,
  productionWikiRegistry,
} from "../../../sidecar/server.mjs";
import {
  createCapabilityStore,
  publicPending,
} from "../../../sidecar/capabilities.mjs";
import { createAgentWorkspace, WORKSPACE_OUT_OF_SCOPE_ERROR } from "../../../sidecar/workspace.mjs";
import {
  executableKey,
  shellApprovalReason,
} from "../../../sidecar/shell.mjs";
import {
  createLoopbackSettingsSource,
  createWikiRegistrySource,
  resolveLoopbackWikiId,
  rewriteProxiedWikiPath,
  V1_MAX_BODY_BYTES,
} from "../../../sidecar/loopback.mjs";
import {
  clampTopK,
  isV1FileInScope,
  V1_DEFAULT_TOP_K,
  V1_MAX_BODY_BYTES as CONTRACT_BODY,
  V1_MAX_TOP_K,
} from "../v1-contract";
import { registerLoopbackTools } from "../../../sidecar/mcp.mjs";
import { persistChatTurn, createChatConversation, getChatConversation } from "../chat";
import { loopbackMcpConfig } from "../workbench-settings";
import { classifyLoopbackHealth } from "../workbench-loopback-health";
import { rescanSources } from "../source-rescan";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import { listIngestJobs } from "../ingest-jobs";
import { saveRawSource, saveRawSourceTree } from "../raw";
import { listRawSourceFilePaths } from "../workbench-files";
import * as tasks from "../tasks";

const open: Server[] = [];

async function listen(extra: Record<string, unknown> = {}): Promise<string> {
  const source = {
    current: () => ({
      enabled: true,
      allowUnauthenticated: true,
      token: null,
      tokenSource: "none",
      skillEnablement: {},
    }),
    refresh: async () => source.current(),
  };
  const server = createSidecarServer({
    settingsSource: source,
    kernel: { base: "", token: "" },
    ...extra,
  }) as Server;
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("F8-01 server-owned shell capabilities", () => {
  it("issues a capability once and refuses replay", () => {
    let n = 0;
    const store = createCapabilityStore({
      id: () => `cap-${++n}`,
      now: () => 1_000,
      ttlMs: 60_000,
    });
    const id = store.issue("shell_approval", { command: "ls" });
    expect(id).toBe("cap-1");
    expect(store.consume(id, "shell_approval")).toEqual({ command: "ls" });
    expect(store.consume(id, "shell_approval")).toBeNull();
  });

  it("refuses a fabricated, expired, or cross-kind resume", () => {
    let clock = 1_000;
    const store = createCapabilityStore({
      id: () => "cap-x",
      now: () => clock,
      ttlMs: 10,
    });
    expect(store.consume("invented", "shell_approval")).toBeNull();
    store.issue("shell_approval", { command: "ls" });
    expect(store.consume("cap-x", "skill_form")).toBeNull();
    store.issue("shell_approval", { command: "ls" });
    clock = 2_000;
    expect(store.consume("cap-x", "shell_approval")).toBeNull();
  });

  it("refuses a ticket issued for another conversation or Wiki", () => {
    const store = createCapabilityStore({ id: () => "cap-scope" });
    store.issue(
      "shell_approval",
      { command: "ls" },
      { conversationId: "conv-a", wikiId: "wiki-a" },
    );
    expect(
      store.consume("cap-scope", "shell_approval", {
        conversationId: "conv-b",
        wikiId: "wiki-a",
      }),
    ).toBeNull();
    expect(
      store.consume("cap-scope", "shell_approval", {
        conversationId: "conv-a",
        wikiId: "wiki-b",
      }),
    ).toBeNull();
    expect(
      store.consume("cap-scope", "shell_approval", {
        conversationId: "conv-a",
        wikiId: "wiki-a",
      }),
    ).toEqual({ command: "ls" });
  });

  it("does not resume a capability on a different Wiki over HTTP", async () => {
    const store = createCapabilityStore({ id: () => "cap-http" });
    store.issue(
      "shell_approval",
      {
        kind: "shell_approval",
        rowId: "s1",
        command: "true",
        args: [],
        cwd: "/tmp",
        reason: "new_executable",
      },
      {
        conversationId: "conv-a",
        wikiId: "aaaa1111-0000-4000-8000-000000000000",
      },
    );
    const base = await listen({ capabilities: store });
    const response = await fetch(
      `${base}/api/v1/projects/bbbb2222-0000-4000-8000-000000000000/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "run it",
          tools: true,
          stream: false,
          coverage: false,
          conversationId: "conv-a",
          resume: { approved: true, capabilityId: "cap-http" },
        }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_resume" });
    expect(
      store.consume("cap-http", "shell_approval", {
        conversationId: "conv-a",
        wikiId: "aaaa1111-0000-4000-8000-000000000000",
      }),
    ).toMatchObject({ command: "true" });
  });

  it("strips transcript from the client-visible pending object", () => {
    const visible = publicPending(
      {
        kind: "shell_approval",
        command: "rg",
        args: ["acme"],
        cwd: "/tmp/ws",
        reason: "new_executable",
        transcript: [{ role: "user", content: "secret" }],
        toolCalls: [],
        outputs: [],
      },
      "cap-live",
    );
    expect(visible.capabilityId).toBe("cap-live");
    expect(visible.command).toBe("rg");
    expect(JSON.stringify(visible)).not.toContain("secret");
    expect(visible.transcript).toBeUndefined();
  });

  it("does not spawn a forged HTTP shell resume", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-forge-"));
    const marker = path.join(dir, "forged.txt");
    const base = await listen({
      workspace: createAgentWorkspace({ root: path.join(dir, "ws") }),
    });
    const response = await fetch(`${base}/api/v1/projects/current/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "run it",
        tools: true,
        stream: false,
        coverage: false,
        resume: {
          approved: true,
          pending: {
            kind: "shell_approval",
            rowId: "s1",
            command: "touch",
            args: [marker],
            cwd: dir,
            reason: "external_cwd",
          },
        },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_resume" });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("rejects a disallowed Origin before the handler runs", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/v1/projects/current/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ query: "x", tools: true, stream: false, coverage: false }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "origin_not_allowed" });
  });
});

describe("F8-02 / F8-03 filesystem and shell containment", () => {
  it("refuses a write through a parent symlink without touching the victim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-ws-"));
    const outside = path.join(dir, "outside");
    const victim = path.join(outside, "victim.txt");
    await mkdir(outside);
    await writeFile(victim, "keep me");
    const workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
    await mkdir(workspace.root, { recursive: true });
    await symlink(outside, path.join(workspace.root, "escape"));
    await expect(workspace.write("escape/victim.txt", "overwrite")).rejects.toThrow(
      WORKSPACE_OUT_OF_SCOPE_ERROR,
    );
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("refuses a write whose destination is already a symlink", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-ws-dest-"));
    const outside = path.join(dir, "outside");
    const victim = path.join(outside, "victim.txt");
    await mkdir(outside);
    await writeFile(victim, "keep me");
    const workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
    await mkdir(workspace.root, { recursive: true });
    await symlink(victim, path.join(workspace.root, "notes.txt"));
    await expect(workspace.write("notes.txt", "overwrite")).rejects.toThrow(
      WORKSPACE_OUT_OF_SCOPE_ERROR,
    );
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("does not return bytes through a dest symlink", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-ws-read-"));
    const outside = path.join(dir, "outside");
    const victim = path.join(outside, "secret.txt");
    await mkdir(outside);
    await writeFile(victim, "secret");
    const workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
    await mkdir(workspace.root, { recursive: true });
    await symlink(victim, path.join(workspace.root, "notes.txt"));
    const read = await workspace.read("notes.txt");
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain("secret");
  });

  it("answers a status instead of throwing when the dest is a directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-ws-dir-"));
    const workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
    await mkdir(path.join(workspace.root, "notes.md"), { recursive: true });
    const read = await workspace.read("notes.md");
    expect(read.status).toBeGreaterThanOrEqual(400);
    expect(read.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it("refuses a later write after a parent is swapped for a symlink", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-ws-race-"));
    const outside = path.join(dir, "outside");
    const victim = path.join(outside, "later.txt");
    await mkdir(outside);
    await writeFile(victim, "keep me");
    const workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
    await mkdir(path.join(workspace.root, "notes"), { recursive: true });
    await workspace.write("notes/first.md", "ok");
    await symlink(outside, path.join(workspace.root, "notes-link"));
    // Replace the real parent with a symlink after the first honest write.
    await rm(path.join(workspace.root, "notes"), { recursive: true });
    await symlink(outside, path.join(workspace.root, "notes"));
    await expect(workspace.write("notes/later.txt", "overwrite")).rejects.toThrow(
      WORKSPACE_OUT_OF_SCOPE_ERROR,
    );
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("treats a missing cwd as the workspace, not the process cwd", () => {
    const workspace = createAgentWorkspace({ root: "/tmp/agent-workspace" });
    expect(
      shellApprovalReason(
        { command: "rm", args: ["package.json"] },
        { workspace, approvedExecutables: new Set(["name:rm"]) },
      ),
    ).toBeNull();
    expect(
      shellApprovalReason(
        { command: "rm", args: ["package.json"], cwd: process.cwd() },
        { workspace, approvedExecutables: new Set(["name:rm"]) },
      ),
    ).toBe("external_cwd");
  });

  it("treats an option-embedded path as a path", () => {
    const workspace = createAgentWorkspace({ root: "/tmp/agent-workspace" });
    expect(
      shellApprovalReason(
        { command: "cp", args: ["--target=/etc/passwd", "notes.md"], cwd: workspace.root },
        { workspace, approvedExecutables: new Set(["name:cp"]) },
      ),
    ).toBe("external_path");
  });

  it("does not treat a basename approval as a path approval", () => {
    expect(executableKey("python3")).toBe("name:python3");
    expect(executableKey("/tmp/evil/python3")).toBe("path:/tmp/evil/python3");
    expect(executableKey("python3")).not.toBe(executableKey("/tmp/evil/python3"));
  });
});

describe("F8-04 tool-turn persistence", () => {
  const originalDataDir = process.env.DATA_DIR;

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    _resetStorage();
    _resetLocks();
  });

  it("persists a workspace-only turn and reloads the chip from the store", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-chat-"));
    process.env.DATA_DIR = tmp;
    _resetLocks();
    _resetStorage();
    const conversation = await createChatConversation("alice");
    const saved = await persistChatTurn("alice", conversation.id, [
      { role: "user", content: "Write the recap." },
      {
        role: "assistant",
        content: "Wrote recaps/acme.md.",
        toolCalls: [{ id: "t1", tool: "workspace_write", detail: "acme.md" }],
        outputs: [{ path: "recaps/acme.md", name: "acme.md", bytes: 13 }],
      },
    ]);
    expect(saved?.messages[1]?.outputs).toEqual([
      { path: "recaps/acme.md", name: "acme.md", bytes: 13 },
    ]);
    const reloaded = await getChatConversation("alice", conversation.id);
    expect(reloaded?.messages[1]?.outputs).toEqual([
      { path: "recaps/acme.md", name: "acme.md", bytes: 13 },
    ]);
    expect(reloaded?.messages[1]?.content).toBe("Wrote recaps/acme.md.");
  });

  it("keeps typed Source and web citations without a wiki [n]", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-cite-"));
    process.env.DATA_DIR = tmp;
    _resetLocks();
    _resetStorage();
    const conversation = await createChatConversation("alice");
    const saved = await persistChatTurn("alice", conversation.id, [
      { role: "user", content: "What did the notes say?" },
      {
        role: "assistant",
        content: "The notes mention pricing.",
        citations: [
          { n: 1, path: "raw/sources/meet/a.md", title: "Meet", type: "source" },
          { n: 2, path: "https://example.com", title: "Example", type: "web" },
        ],
      },
    ]);
    expect(saved?.messages[1]?.citations).toEqual([
      { n: 1, path: "raw/sources/meet/a.md", title: "Meet", type: "source" },
      { n: 2, path: "https://example.com", title: "Example", type: "web" },
    ]);
  });
});

describe("F8-05 / F8-06 v1 contract", () => {
  it("emits an absolute MCP entry that can spawn from /tmp", async () => {
    const parsed = JSON.parse(loopbackMcpConfig("tok")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const entry = Object.values(parsed.mcpServers)[0];
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args[0].endsWith(`${path.sep}sidecar${path.sep}mcp.mjs`)).toBe(true);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    Object.assign(env, entry.env);

    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: "/tmp",
      env,
    });
    const client = new Client({ name: "epic8-tmp-cwd", version: "0.0.1" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "chat",
        "files",
        "graph",
        "health",
        "projects",
        "read_file",
        "rescan_sources",
        "reviews",
        "search",
      ]);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("keeps file reads inside raw/sources, not the rest of raw/", () => {
    expect(isV1FileInScope("raw/sources/note.txt")).toBe(true);
    expect(isV1FileInScope("raw/other.md")).toBe(false);
    expect(isV1FileInScope("wiki/alpha.md")).toBe(true);
  });

  it("refuses an unregistered filesystem {id} instead of silently mapping to current", () => {
    expect(resolveLoopbackWikiId("/Users/me/wiki")).toBeNull();
    expect(
      resolveLoopbackWikiId("/Users/me/wiki", [
        { id: "aaaa1111-0000-4000-8000-000000000000", path: "/Users/me/wiki" },
      ]),
    ).toBe("aaaa1111-0000-4000-8000-000000000000");
    expect(
      rewriteProxiedWikiPath("/api/v1/projects/%2FUsers%2Fme%2Fwiki/files"),
    ).toBeNull();
  });

  it("keeps the last good wiki registry when a later poll fails", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    let calls = 0;
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: "/data",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              projects: [{ id: wikiId, path: `tenants/alice/wikis/${wikiId}` }],
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 500 });
      },
    });
    await source.refresh();
    expect(
      resolveLoopbackWikiId(`/data/tenants/alice/wikis/${wikiId}`, source),
    ).toBe(wikiId);
    await source.refresh();
    expect(source.current()).toHaveLength(1);
    expect(
      resolveLoopbackWikiId(`/data/tenants/alice/wikis/${wikiId}`, source),
    ).toBe(wikiId);
  });

  it("resolves a live registry source on Chat instead of an empty listen-time array", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const hostPath = `/Users/me/data/tenants/alice/wikis/${wikiId}`;
    const source = {
      current: () => [{ id: wikiId, path: hostPath }],
    };
    const base = await listen({ wikiRegistry: source });
    const rejected = await fetch(
      `${base}/api/v1/projects/${encodeURIComponent("/Users/me/other")}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x", tools: true, stream: false, coverage: false }),
      },
    );
    expect(rejected.status).toBe(400);
    const accepted = await fetch(
      `${base}/api/v1/projects/${encodeURIComponent(hostPath)}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x", stream: false, coverage: false }),
      },
    );
    expect(accepted.status).not.toBe(400);
  });

  it("wires the production registry poller into createSidecarServer", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const { kernel, wikiRegistry } = productionWikiRegistry({
      env: {
        WORKWIKI_URL: "http://kernel.test",
        WORKWIKI_API_TOKEN: "automation",
        DATA_DIR: "/data",
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            projects: [{ id: wikiId, path: `tenants/alice/wikis/${wikiId}` }],
          }),
          { status: 200 },
        ),
    });
    expect(kernel.base).toBe("http://kernel.test");
    await wikiRegistry.refresh();
    const hostPath = `/data/tenants/alice/wikis/${wikiId}`;
    expect(resolveLoopbackWikiId(hostPath, wikiRegistry)).toBe(wikiId);
    const main = await readFile(
      path.join(process.cwd(), "sidecar/server.mjs"),
      "utf8",
    );
    expect(main).toContain("const { kernel, wikiRegistry } = productionWikiRegistry()");
    expect(main).toMatch(/createSidecarServer\(\{[\s\S]*wikiRegistry,/);
  });

  it("keeps the last good remote settings when a later poll fails", async () => {
    let calls = 0;
    const source = createLoopbackSettingsSource({
      base: "http://kernel.test",
      token: "automation",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              enabled: true,
              allowUnauthenticated: false,
              token: "live-token",
              skillEnablement: {},
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 500 });
      },
    });
    const first = await source.refresh();
    expect(first.token).toBe("live-token");
    const second = await source.refresh();
    expect(second.token).toBe("live-token");
    expect(second.enabled).toBe(true);
  });

  it("treats paths: [] as no Sources, not every Source", async () => {
    const result = await rescanSources({
      owner: "alice",
      wikiId: null,
      readableSlugs: new Set(),
      paths: [],
    });
    expect(result.requested).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("pages rescan with a cursor instead of re-slicing the first 25", async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `raw/sources/n${i}.txt`);
    const page = await rescanSources({
      owner: "alice",
      wikiId: null,
      readableSlugs: new Set(),
      paths,
      cursor: 0,
    });
    expect(page.requested).toBe(25);
    expect(page.remaining).toBe(5);
    expect(page.nextCursor).toBe(25);
  });

  it("abandons a job when enqueue throws after create", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-rescan-"));
    const originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    _resetLocks();
    _resetStorage();
    const enqueue = vi.spyOn(tasks, "enqueueTask").mockRejectedValue(new Error("queue exploded"));
    try {
      await saveRawSource("note", "compile me again", { owner: "alice" });
      const result = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
        paths: ["raw/sources/note.md"],
      });
      expect(result.results[0]?.queued).toBe(false);
      expect(await listIngestJobs({ owner: "alice" })).toEqual([]);
    } finally {
      enqueue.mockRestore();
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      _resetStorage();
      _resetLocks();
    }
  });

  it("pages an implicit rescan past the Files-tab node cap", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-rescan-page-"));
    const originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    _resetLocks();
    _resetStorage();
    try {
      for (let i = 0; i < 5; i += 1) {
        await saveRawSource(`note-${i}`, `body ${i}`, { owner: "alice" });
      }
      await saveRawSourceTree("a/b/c/deep.md", "too deep", { owner: "alice" });
      const listed = await listRawSourceFilePaths("alice", {
        offset: 0,
        limit: 2,
        allow: (p) => p.endsWith(".md"),
      });
      expect(listed.paths).toHaveLength(2);
      expect(listed.more).toBe(true);
      expect(listed.remaining).toBe(3);
      const page = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
        limit: 2,
      });
      expect(page.requested).toBe(2);
      expect(page.remaining).toBe(3);
      expect(page.nextCursor).toBe(2);
      const next = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
        limit: 2,
        cursor: page.nextCursor ?? 0,
      });
      expect(next.requested).toBe(2);
      expect(next.remaining).toBe(1);
      expect(next.nextCursor).toBe(4);
      const last = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
        limit: 2,
        cursor: next.nextCursor ?? 0,
      });
      expect(last.requested).toBe(1);
      expect(last.remaining).toBe(0);
      expect(last.nextCursor).toBeNull();
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      _resetStorage();
      _resetLocks();
    }
  });

  it("treats mode: deep as a broader topK default, not Deep Research", () => {
    expect(clampTopK(undefined)).toBe(V1_DEFAULT_TOP_K);
    expect(clampTopK(undefined, "deep")).toBe(V1_MAX_TOP_K);
    expect(clampTopK(3, "deep")).toBe(3);
  });

  it("forwards every stock MCP callback to the door", async () => {
    const seen: string[] = [];
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fake = {
      registerTool(
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
        return fake;
      },
    };
    registerLoopbackTools(fake, {
      call: async (pathname: string) => {
        seen.push(pathname);
        return { ok: true, text: "{}" };
      },
    });
    expect([...handlers.keys()]).toEqual([
      "health",
      "projects",
      "files",
      "read_file",
      "search",
      "reviews",
      "graph",
      "rescan_sources",
      "chat",
    ]);
    await handlers.get("health")?.({});
    await handlers.get("search")?.({ query: "pricing" });
    await handlers.get("chat")?.({ query: "hi" });
    expect(seen).toContain("/api/v1/health");
    expect(seen.some((row) => row.includes("/search"))).toBe(true);
    expect(seen.some((row) => row.includes("/chat"))).toBe(true);
  });

  it("classifies a foreign health payload as port_conflict", () => {
    expect(classifyLoopbackHealth({ ok: true, status: "running" })).toBe("running");
    expect(classifyLoopbackHealth({ status: "port_conflict" })).toBe("port_conflict");
    expect(classifyLoopbackHealth({ server: "nginx" })).toBe("port_conflict");
    expect(classifyLoopbackHealth(null)).toBe("error");
  });

  it("shares the 1 MiB body cap on both sides of AD-6", () => {
    expect(V1_MAX_BODY_BYTES).toBe(CONTRACT_BODY);
    expect(V1_MAX_BODY_BYTES).toBe(1_048_576);
  });
});
