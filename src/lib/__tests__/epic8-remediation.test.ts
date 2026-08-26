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
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createChatTurnSession,
  createSidecarServer,
  productionWikiRegistry,
} from "../../../sidecar/server.mjs";
import {
  createCapabilityStore,
  publicPending,
} from "../../../sidecar/capabilities.mjs";
import {
  canonicalizePathSnapshot,
  createAgentWorkspace,
  WORKSPACE_OUT_OF_SCOPE_ERROR,
} from "../../../sidecar/workspace.mjs";
import {
  executableKey,
  SHELL_MAX_ARG_CHARS,
  SHELL_MAX_TOTAL_ARG_CHARS,
  shellApprovalReason,
} from "../../../sidecar/shell.mjs";
import {
  canonicalLoopbackWikiId,
  createLoopbackSettingsSource,
  createWikiRegistrySource,
  parseWikiRoots,
  resolveLoopbackWikiId,
  rewriteProxiedWikiPath,
  V1_MAX_BODY_BYTES,
  WIKI_REGISTRY_MAX_RESPONSE_BYTES,
  WIKI_REGISTRY_MAX_LOCAL_BYTES,
  WIKI_REGISTRY_MAX_ROWS,
  WIKI_REGISTRY_MAX_TENANTS,
} from "../../../sidecar/loopback.mjs";
import fs from "node:fs/promises";
import { getStorage } from "../storage";
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
const TEST_CURRENT_WIKI_ID = "aaaa1111-0000-4000-8000-000000000000";

function completeDiskWiki(id: string, name = "Test Wiki") {
  return {
    id,
    name,
    scenario: "general",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

async function mkdirMany(paths: string[]) {
  for (let index = 0; index < paths.length; index += 100) {
    await Promise.all(paths.slice(index, index + 100).map((entry) => mkdir(entry, { recursive: true })));
  }
}

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
    wikiRegistry: {
      current: () => [],
      currentId: () => TEST_CURRENT_WIKI_ID,
    } as never,
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

  it("refuses a ticket issued with no conversationId when resumed under another", () => {
    const store = createCapabilityStore({ id: () => "cap-empty" });
    store.issue("shell_approval", { command: "ls" });
    expect(
      store.consume("cap-empty", "shell_approval", {
        conversationId: "conv-other",
      }),
    ).toBeNull();
    expect(store.consume("cap-empty", "shell_approval")).toEqual({
      command: "ls",
    });
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

  it("canonicalizes current to the poller's currentId, not a flattened row list", () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    expect(
      canonicalLoopbackWikiId("current", { currentId: () => wikiId }),
    ).toBe(wikiId);
    expect(
      canonicalLoopbackWikiId("current", [{ id: wikiId, path: "/tmp/wiki" }]),
    ).toBeNull();
    expect(canonicalLoopbackWikiId(wikiId, { currentId: () => wikiId })).toBe(
      wikiId,
    );
    expect(
      canonicalLoopbackWikiId("current", { currentId: () => null }),
    ).toBeNull();
  });

  it("503s a current-door tool turn while registry identity is unresolved", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const wikiRegistry = {
      current: () => [{ id: wikiId, path: `/data/wikis/${wikiId}` }],
      currentId: () => null,
    };
    const base = await listen({ wikiRegistry });
    const response = await fetch(`${base}/api/v1/projects/current/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "search",
        tools: true,
        stream: false,
        coverage: false,
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "current_wiki_unavailable",
    });
  });

  it("creates no Chat session before unresolved-current and invalid-resume refusals", async () => {
    const sessionFactory = vi.fn();
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const base = await listen({
      chatSessionFactory: sessionFactory,
      wikiRegistry: {
        current: () => [{ id: wikiId, path: "/data/wiki" }],
        currentId: () => null,
      },
    });
    const unresolved = await fetch(`${base}/api/v1/projects/current/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "search", tools: true, coverage: false }),
    });
    expect(unresolved.status).toBe(503);
    const invalidResume = await fetch(`${base}/api/v1/projects/${wikiId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "resume",
        tools: true,
        coverage: false,
        conversationId: "conv-refusal",
        resume: { capabilityId: "not-issued", approved: true },
      }),
    });
    expect(invalidResume.status).toBe(400);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("removes Chat abort and socket listeners when a turn settles", () => {
    const req = new EventEmitter() as EventEmitter & { socket: EventEmitter };
    req.socket = new EventEmitter();
    const res = {
      writableEnded: false,
      headersSent: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const session = createChatTurnSession(req, res, false);
    expect(req.listenerCount("aborted")).toBe(1);
    expect(req.socket.listenerCount("close")).toBe(1);
    session.settle();
    expect(req.listenerCount("aborted")).toBe(0);
    expect(req.socket.listenerCount("close")).toBe(0);

    const cancelledReq = new EventEmitter() as EventEmitter & { socket: EventEmitter };
    cancelledReq.socket = new EventEmitter();
    const cancelled = createChatTurnSession(cancelledReq, res, false);
    cancelled.emitCancelled();
    expect(cancelledReq.listenerCount("aborted")).toBe(0);
    expect(cancelledReq.socket.listenerCount("close")).toBe(0);
  });

  it("resumes a current-door pause on the poller's UUID", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const store = createCapabilityStore({ id: () => "cap-current" });
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
      { conversationId: "conv-a", wikiId },
    );
    const wikiRegistry = {
      current: () => [{ id: wikiId, path: `/data/tenants/alice/wikis/${wikiId}` }],
      currentId: () => wikiId,
    };
    const base = await listen({ capabilities: store, wikiRegistry });
    const response = await fetch(`${base}/api/v1/projects/current/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "run it",
        tools: true,
        stream: false,
        coverage: false,
        conversationId: "conv-a",
        resume: { approved: true, capabilityId: "cap-current" },
      }),
    });
    expect(response.status).not.toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).not.toBe("invalid_resume");
    expect(
      store.consume("cap-current", "shell_approval", {
        conversationId: "conv-a",
        wikiId,
      }),
    ).toBeNull();
  });

  it("resumes a real server-issued current-door pause on its UUID", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-current-http-"));
    const workspace = createAgentWorkspace({ root: path.join(tmp, "workspace") });
    const wikiRegistry = {
      current: () => [{ id: wikiId, path: path.join(tmp, "wiki") }],
      currentId: () => wikiId,
    };
    const originalDataDir = process.env.DATA_DIR;
    const originalOpenAi = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalGoogle = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const originalDeepseek = process.env.DEEPSEEK_API_KEY;
    const originalOllama = process.env.OLLAMA_API_KEY;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    process.env.DATA_DIR = tmp;
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    await writeFile(
      path.join(tmp, ".llm-wiki-config.json"),
      JSON.stringify({ chatProvider: "openai", chatModel: "test-model" }),
      "utf8",
    );
    let providerCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith("https://api.openai.com/")) {
          providerCalls += 1;
          const content =
            providerCalls === 1
              ? JSON.stringify({ tool: "shell", input: { command: "true", args: [] } })
              : "Done.";
          return new Response(
            JSON.stringify({ choices: [{ message: { content } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return nativeFetch(input, init);
      },
    );
    try {
      const base = await listen({ wikiRegistry, workspace });
      const paused = await fetch(`${base}/api/v1/projects/current/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "run true",
          tools: true,
          stream: false,
          coverage: false,
          conversationId: "conv-live",
        }),
      });
      expect(paused.status).toBe(200);
      const first = (await paused.json()) as {
        pending?: { capabilityId?: string };
      };
      expect(first.pending?.capabilityId).toEqual(expect.any(String));

      const resumed = await fetch(`${base}/api/v1/projects/${wikiId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "run true",
          tools: true,
          stream: false,
          coverage: false,
          conversationId: "conv-live",
          resume: {
            approved: true,
            capabilityId: first.pending?.capabilityId,
          },
        }),
      });
      expect(resumed.status).toBe(200);
      const second = (await resumed.json()) as {
        error?: string;
        toolCalls?: Array<{ tool?: string }>;
      };
      expect(second.error).toBeUndefined();
      expect(second.toolCalls).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "shell" })]),
      );
      expect(providerCalls).toBe(2);
    } finally {
      fetchSpy.mockRestore();
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalGoogle === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalGoogle;
      if (originalDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalDeepseek;
      if (originalOllama === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = originalOllama;
    }
  });

  it("does not resume an unbound ticket under a supplied conversationId", async () => {
    const store = createCapabilityStore({ id: () => "cap-anon" });
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
      { wikiId: "aaaa1111-0000-4000-8000-000000000000" },
    );
    const base = await listen({ capabilities: store });
    const response = await fetch(
      `${base}/api/v1/projects/aaaa1111-0000-4000-8000-000000000000/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "run it",
          tools: true,
          stream: false,
          coverage: false,
          conversationId: "conv-other",
          resume: { approved: true, capabilityId: "cap-anon" },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(
      store.consume("cap-anon", "shell_approval", {
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
        executableKey: "path:/server-only/tool",
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
    expect(visible.executableKey).toBeUndefined();
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

  it("answers 500 read_failed when a dest read throws after open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-ws-eio-"));
    const workspace = createAgentWorkspace({ root: path.join(dir, "agent-workspace") });
    await mkdir(workspace.root, { recursive: true });
    await writeFile(path.join(workspace.root, "notes.md"), "hello");
    const err = Object.assign(new Error("EIO"), { code: "EIO" });
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (target, flags) => {
      const handle = await realOpen(target, flags);
      return {
        stat: async () => handle.stat(),
        readFile: async () => {
          throw err;
        },
        close: () => handle.close(),
      } as unknown as Awaited<ReturnType<typeof fs.open>>;
    });
    try {
      const read = await workspace.read("notes.md");
      expect(read.status).toBe(500);
      expect(read.body).toEqual({ error: "read_failed" });
    } finally {
      open.mockRestore();
    }
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
        {
          workspace,
          approvedExecutables: new Set([
            executableKey("rm", { cwd: workspace.root, workspace }),
          ]),
        },
      ),
    ).toBeNull();
    expect(
      shellApprovalReason(
        { command: "rm", args: ["package.json"], cwd: process.cwd() },
        {
          workspace,
          approvedExecutables: new Set([
            executableKey("rm", { cwd: process.cwd(), workspace }),
          ]),
        },
      ),
    ).toBe("external_cwd");
  });

  it("treats an option-embedded path as a path", () => {
    const workspace = createAgentWorkspace({ root: "/tmp/agent-workspace" });
    expect(
      shellApprovalReason(
        { command: "cp", args: ["--target=/etc/passwd", "notes.md"], cwd: workspace.root },
        {
          workspace,
          approvedExecutables: new Set([
            executableKey("cp", { cwd: workspace.root, workspace }),
          ]),
        },
      ),
    ).toBe("external_path");
    expect(
      shellApprovalReason(
        { command: "cp", args: ["-I/etc", "notes.md"], cwd: workspace.root },
        {
          workspace,
          approvedExecutables: new Set([
            executableKey("cp", { cwd: workspace.root, workspace }),
          ]),
        },
      ),
    ).toBe("external_path");
  });

  it("rejects an unbounded shell argv before canonicalizing every argument", () => {
    const workspace = createAgentWorkspace({ root: "/tmp/agent-workspace" });
    expect(
      shellApprovalReason(
        { command: "echo", args: Array.from({ length: 129 }, () => "./deep") },
        { workspace },
      ),
    ).toBe("invalid");
    expect(
      shellApprovalReason(
        { command: "x".repeat(SHELL_MAX_ARG_CHARS + 1), args: [] },
        { workspace },
      ),
    ).toBe("invalid");
    expect(
      shellApprovalReason(
        { command: "echo", args: ["x".repeat(SHELL_MAX_ARG_CHARS + 1)] },
        { workspace },
      ),
    ).toBe("invalid");
    const aggregate = Array.from({ length: 5 }, () =>
      "x".repeat(Math.floor(SHELL_MAX_TOTAL_ARG_CHARS / 5) + 1),
    );
    expect(
      shellApprovalReason({ command: "echo", args: aggregate }, { workspace }),
    ).toBe("invalid");
  });

  it("resolves a basename approval to the PATH binary, not any same-named path", async () => {
    const fakeDir = await mkdtemp(path.join(os.tmpdir(), "epic8-fake-node-"));
    const fakeNode = path.join(fakeDir, "node");
    await writeFile(fakeNode, "#!/bin/sh\nexit 0\n");
    await fs.chmod(fakeNode, 0o755);
    expect(executableKey("node")).toMatch(/^path:/);
    expect(executableKey(fakeNode)).toBe(
      `path:${canonicalizePathSnapshot(fakeNode)}`,
    );
    expect(executableKey("node")).not.toBe(executableKey(fakeNode));
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

  it("refuses an unregistered filesystem {id} instead of silently mapping to current", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "epic8-registered-id-"));
    const registered = path.join(root, "wiki");
    await mkdir(registered);
    expect(resolveLoopbackWikiId(registered)).toBeNull();
    expect(
      resolveLoopbackWikiId(registered, [
        {
          id: "aaaa1111-0000-4000-8000-000000000000",
          path: canonicalizePathSnapshot(registered) as string,
        },
      ]),
    ).toBe("aaaa1111-0000-4000-8000-000000000000");
    expect(
      rewriteProxiedWikiPath("/api/v1/projects/%2FUsers%2Fme%2Fwiki/files"),
    ).toBeNull();
  });

  it("keeps the last good wiki registry when a later poll fails", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-last-good-"));
    const hostPath = path.join(dataDir, "tenants", "alice", "wikis", wikiId);
    await mkdir(hostPath, { recursive: true });
    let calls = 0;
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              currentId: wikiId,
              projects: [
                {
                  id: wikiId,
                  path: `tenants/alice/wikis/${wikiId}`,
                  hostPath,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 500 });
      },
    });
    await source.refresh();
    expect(source.currentId()).toBe(wikiId);
    expect(resolveLoopbackWikiId(hostPath, source)).toBe(wikiId);
    await source.refresh();
    expect(source.current()).toHaveLength(1);
    expect(resolveLoopbackWikiId(hostPath, source)).toBe(wikiId);
    expect(source.currentId()).toBeNull();
  });

  it("clears remote current identity and rows after a successful empty poll", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    let calls = 0;
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: "/data",
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify(
            calls === 1
              ? {
                  currentId: wikiId,
                  projects: [
                    {
                      id: wikiId,
                      hostPath: `/data/tenants/alice/wikis/${wikiId}`,
                    },
                  ],
                }
              : { currentId: null, projects: [] },
          ),
          { status: 200 },
        );
      },
    });
    await source.refresh();
    expect(source.currentId()).toBe(wikiId);
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(source.currentId()).toBeNull();
  });

  it("does not let an older concurrent registry refresh overwrite a newer snapshot", async () => {
    const olderId = "aaaa1111-0000-4000-8000-000000000000";
    const newerId = "bbbb2222-0000-4000-8000-000000000000";
    let releaseOlder: ((response: Response) => void) | undefined;
    let calls = 0;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-generation-"));
    const olderPath = path.join(dataDir, "wikis", olderId);
    const newerPath = path.join(dataDir, "wikis", newerId);
    await mkdir(olderPath, { recursive: true });
    await mkdir(newerPath, { recursive: true });
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            releaseOlder = resolve;
          });
        }
        return new Response(
          JSON.stringify({
            currentId: newerId,
            projects: [
              { id: newerId, hostPath: newerPath },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const older = source.refresh();
    const newer = source.refresh();
    await newer;
    releaseOlder?.(
      new Response(
        JSON.stringify({
          currentId: olderId,
          projects: [{ id: olderId, hostPath: olderPath }],
        }),
        { status: 200 },
      ),
    );
    await older;
    expect(source.currentId()).toBe(newerId);
    expect(source.current()).toEqual([
      { id: newerId, path: canonicalizePathSnapshot(newerPath) },
    ]);
  });

  it("does not let an older failed refresh clear a newer good snapshot", async () => {
    const wikiId = "bbbb2222-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-stale-fail-"));
    const hostPath = path.join(dataDir, "wikis", wikiId);
    await mkdir(hostPath, { recursive: true });
    for (const failure of ["http", "reject"] as const) {
      let releaseOlder: ((response: Response) => void) | undefined;
      let rejectOlder: ((error: Error) => void) | undefined;
      let calls = 0;
      const source = createWikiRegistrySource({
        base: "http://kernel.test",
        token: "automation",
        dataDir,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            return new Promise<Response>((resolve, reject) => {
              releaseOlder = resolve;
              rejectOlder = reject;
            });
          }
          return new Response(
            JSON.stringify({
              currentId: wikiId,
              projects: [{ id: wikiId, hostPath }],
            }),
            { status: 200 },
          );
        },
      });
      const older = source.refresh();
      await source.refresh();
      if (failure === "http") releaseOlder?.(new Response("nope", { status: 500 }));
      else rejectOlder?.(new Error("older request failed"));
      await older;
      expect(source.currentId()).toBe(wikiId);
      expect(resolveLoopbackWikiId(hostPath, source)).toBe(wikiId);
    }
  });

  it("does not treat kernel-relative project.path as a host root", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: "/data",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            projects: [{ id: wikiId, path: `tenants/alice/wikis/${wikiId}` }],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(
      resolveLoopbackWikiId(`/data/tenants/alice/wikis/${wikiId}`, source),
    ).toBeNull();
  });

  it("maps owner WORKWIKI_WIKI_ROOTS after the id is in the project list", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const ownerRoot = await mkdtemp(path.join(os.tmpdir(), "epic8-owner-root-"));
    expect(parseWikiRoots(`${wikiId}=/Users/me/project`)).toEqual([
      { id: wikiId, path: path.resolve("/Users/me/project") },
    ]);
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: "/data",
      wikiRoots: `${wikiId}=${ownerRoot}`,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            projects: [{ id: wikiId, path: `tenants/alice/wikis/${wikiId}` }],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(resolveLoopbackWikiId(ownerRoot, source)).toBe(wikiId);
  });

  it("refuses a kernel hostPath that is not under DATA_DIR", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: "/data",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            projects: [{ id: wikiId, path: "tenants/alice/wikis/x", hostPath: "/" }],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(resolveLoopbackWikiId("/etc/passwd", source)).toBeNull();
  });

  it("refuses invalid, symlink-escaped, and conflicting remote host mappings", async () => {
    const first = "aaaa1111-0000-4000-8000-000000000000";
    const second = "bbbb2222-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-hosts-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-outside-"));
    await mkdir(path.join(tmp, "one"));
    await mkdir(path.join(tmp, "two"));
    await mkdir(path.join(outside, "wiki"));
    await symlink(outside, path.join(tmp, "escape"));
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: tmp,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: first,
            projects: [
              { id: "not-a-uuid", hostPath: path.join(tmp, "invalid") },
              { id: first, hostPath: path.join(tmp, "escape", "wiki") },
              { id: first, hostPath: path.join(tmp, "one") },
              { id: first, hostPath: path.join(tmp, "two") },
              { id: second, hostPath: path.join(tmp, "one") },
            ],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(source.currentId()).toBeNull();
    expect(resolveLoopbackWikiId(path.join(outside, "wiki"), source)).toBeNull();
  });

  it("isolates a symlink-escaped remote host mapping", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-escape-only-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-escape-target-"));
    await mkdir(path.join(outside, "wiki"));
    await symlink(outside, path.join(dataDir, "escape"));
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [{ id: wikiId, hostPath: path.join(dataDir, "escape", "wiki") }],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(resolveLoopbackWikiId(path.join(outside, "wiki"), source)).toBeNull();
  });

  it("isolates one remote UUID claiming two roots", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-id-conflict-"));
    const one = path.join(dataDir, "one");
    const two = path.join(dataDir, "two");
    await mkdir(one);
    await mkdir(two);
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [
              { id: wikiId, hostPath: one },
              { id: wikiId, hostPath: two },
            ],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(source.currentId()).toBeNull();
  });

  it("canonicalizes an in-tree symlink host and resolves its original spelling", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-inside-link-"));
    const target = path.join(dataDir, "target");
    const alias = path.join(dataDir, "alias");
    await mkdir(target);
    await symlink(target, alias);
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ projects: [{ id: wikiId, hostPath: alias }] }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([
      { id: wikiId, path: canonicalizePathSnapshot(target) },
    ]);
    expect(resolveLoopbackWikiId(alias, source)).toBe(wikiId);
  });

  it("does not re-follow a registered host after it is replaced by a symlink", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-repoint-"));
    const hostPath = path.join(dataDir, "wiki");
    const outside = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-repoint-out-"));
    await mkdir(hostPath);
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ projects: [{ id: wikiId, hostPath }] }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(resolveLoopbackWikiId(hostPath, source)).toBe(wikiId);
    await rm(hostPath, { recursive: true });
    expect(resolveLoopbackWikiId(hostPath, source)).toBeNull();
    await symlink(outside, hostPath);
    expect(resolveLoopbackWikiId(hostPath, source)).toBeNull();
    expect(resolveLoopbackWikiId(outside, source)).toBeNull();
  });

  it("rejects relative hostPath values and remote-owner root conflicts", async () => {
    const first = "aaaa1111-0000-4000-8000-000000000000";
    const second = "bbbb2222-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-owner-conflict-"));
    const shared = path.join(dataDir, "shared");
    await mkdir(shared);
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      wikiRoots: `${second}=${shared}`,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: first,
            projects: [
              { id: first, hostPath: shared },
              { id: second, hostPath: "." },
            ],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(source.currentId()).toBeNull();
  });

  it("rejects one otherwise-valid relative hostPath in isolation", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir: process.cwd(),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [{ id: wikiId, hostPath: "." }],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
  });

  it("does not pre-authorize missing, file, or future host roots", async () => {
    const remoteId = "aaaa1111-0000-4000-8000-000000000000";
    const ownerId = "bbbb2222-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-future-root-"));
    const remoteRoot = path.join(dataDir, "remote-future");
    const ownerRoot = path.join(dataDir, "owner-future");
    const fileRoot = path.join(dataDir, "not-a-directory");
    await writeFile(fileRoot, "not a wiki root");
    const source = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      wikiRoots: `${ownerId}=${ownerRoot}`,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            projects: [
              { id: remoteId, hostPath: remoteRoot },
              { id: ownerId, hostPath: fileRoot },
            ],
          }),
          { status: 200 },
        ),
    });
    await source.refresh();
    expect(source.current()).toEqual([]);
    await mkdir(remoteRoot);
    await mkdir(ownerRoot);
    expect(resolveLoopbackWikiId(remoteRoot, source)).toBeNull();
    expect(resolveLoopbackWikiId(ownerRoot, source)).toBeNull();
    await source.refresh();
    expect(resolveLoopbackWikiId(remoteRoot, source)).toBe(remoteId);
    expect(resolveLoopbackWikiId(ownerRoot, source)).toBe(ownerId);
  });

  it("rejects oversized registry bodies and project lists before publishing", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-bounds-"));
    const hostPath = path.join(dataDir, "wiki");
    await mkdir(hostPath);
    const oversized = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [{ id: wikiId, hostPath }],
            padding: "x".repeat(WIKI_REGISTRY_MAX_RESPONSE_BYTES),
          }),
          { status: 200 },
        ),
    });
    await oversized.refresh();
    expect(oversized.current()).toEqual([]);
    expect(oversized.currentId()).toBeNull();

    const belowLimit = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [{ id: wikiId, hostPath }],
          }),
          { status: 200 },
        ),
    });
    await belowLimit.refresh();
    expect(resolveLoopbackWikiId(hostPath, belowLimit)).toBe(wikiId);

    const tooMany = createWikiRegistrySource({
      base: "http://kernel.test",
      token: "automation",
      dataDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [
              { id: wikiId, hostPath },
              ...Array.from({ length: WIKI_REGISTRY_MAX_ROWS }, () => ({
                id: "bbbb2222-0000-4000-8000-000000000000",
              })),
            ],
          }),
          { status: 200 },
        ),
    });
    await tooMany.refresh();
    expect(tooMany.current()).toEqual([]);
    expect(tooMany.currentId()).toBeNull();
  });

  it("loads local wiki dirs from disk when there is no kernel token", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-reg-"));
    await mkdir(path.join(tmp, "tenants", "alice", "wikis", wikiId), {
      recursive: true,
    });
    const source = createWikiRegistrySource({
      base: "",
      token: "",
      dataDir: tmp,
    });
    await source.refresh();
    expect(
      resolveLoopbackWikiId(
        path.join(tmp, "tenants", "alice", "wikis", wikiId),
        source,
      ),
    ).toBe(wikiId);
    expect(resolveLoopbackWikiId(path.join(tmp, "agent-workspace"), source)).toBeNull();
  });

  it("rotates local current identity from the disk registry and fails closed on ambiguity", async () => {
    const first = "aaaa1111-0000-4000-8000-000000000000";
    const second = "bbbb2222-0000-4000-8000-000000000000";
    const third = "cccc3333-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-local-current-"));
    const alice = path.join(tmp, "tenants", "alice");
    await mkdir(path.join(alice, "wikis", first), { recursive: true });
    await writeFile(
      path.join(alice, "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(first, "First")],
        currentId: first,
      }),
      "utf8",
    );
    const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
    await source.refresh();
    expect(source.currentId()).toBe(first);

    await rm(path.join(alice, "wikis", first), { recursive: true });
    await mkdir(path.join(alice, "wikis", second), { recursive: true });
    await writeFile(
      path.join(alice, "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(second, "Second")],
        currentId: second,
      }),
      "utf8",
    );
    await source.refresh();
    expect(source.currentId()).toBe(second);

    const bob = path.join(tmp, "tenants", "bob");
    await mkdir(path.join(bob, "wikis", third), { recursive: true });
    await writeFile(
      path.join(bob, "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(third, "Third")],
        currentId: third,
      }),
      "utf8",
    );
    await source.refresh();
    expect(source.currentId()).toBeNull();
  });

  it("does not authorize an incomplete local registry record as current", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-local-incomplete-"));
    const alice = path.join(tmp, "tenants", "alice");
    await mkdir(path.join(alice, "wikis", wikiId), { recursive: true });
    await writeFile(
      path.join(alice, "wikis.json"),
      JSON.stringify({ version: 1, wikis: [{ id: wikiId }], currentId: wikiId }),
      "utf8",
    );
    const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
    await source.refresh();
    expect(source.current()).toEqual([
      {
        id: wikiId,
        path: canonicalizePathSnapshot(path.join(alice, "wikis", wikiId)),
      },
    ]);
    expect(source.currentId()).toBeNull();
  });

  it("fails local current authority for each incomplete record field independently", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    for (const field of ["name", "scenario", "createdAt", "updatedAt"] as const) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), `epic8-local-${field}-`));
      const alice = path.join(tmp, "tenants", "alice");
      await mkdir(path.join(alice, "wikis", wikiId), { recursive: true });
      const record = completeDiskWiki(wikiId) as Record<string, unknown>;
      record[field] = "";
      await writeFile(
        path.join(alice, "wikis.json"),
        JSON.stringify({ version: 1, wikis: [record], currentId: wikiId }),
        "utf8",
      );
      const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
      await source.refresh();
      expect(source.currentId(), field).toBeNull();
    }
  });

  it("fails local current authority for unsupported and oversized registries", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    for (const variant of ["version", "size"] as const) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), `epic8-local-${variant}-`));
      const alice = path.join(tmp, "tenants", "alice");
      await mkdir(path.join(alice, "wikis", wikiId), { recursive: true });
      const body =
        variant === "version"
          ? JSON.stringify({
              version: 2,
              wikis: [completeDiskWiki(wikiId)],
              currentId: wikiId,
            })
          : JSON.stringify({
              version: 1,
              wikis: [completeDiskWiki(wikiId)],
              currentId: wikiId,
              padding: "x".repeat(WIKI_REGISTRY_MAX_LOCAL_BYTES),
            });
      await writeFile(path.join(alice, "wikis.json"), body, "utf8");
      const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
      await source.refresh();
      expect(source.currentId(), variant).toBeNull();
    }
  });

  it("bounds the aggregate bytes across individually valid local registries", async () => {
    const currentId = "eeeeeeee-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-local-aggregate-bytes-"));
    const alice = path.join(tmp, "tenants", "alice");
    const bob = path.join(tmp, "tenants", "bob");
    await mkdir(path.join(alice, "wikis", currentId), { recursive: true });
    await mkdir(path.join(bob, "wikis"), { recursive: true });
    const padding = "x".repeat(Math.floor(WIKI_REGISTRY_MAX_LOCAL_BYTES * 0.55));
    const aliceBody = JSON.stringify({
      version: 1,
      wikis: [completeDiskWiki(currentId)],
      currentId,
      padding,
    });
    const bobBody = JSON.stringify({
      version: 1,
      wikis: [],
      currentId: null,
      padding,
    });
    expect(Buffer.byteLength(aliceBody)).toBeLessThan(WIKI_REGISTRY_MAX_LOCAL_BYTES);
    expect(Buffer.byteLength(bobBody)).toBeLessThan(WIKI_REGISTRY_MAX_LOCAL_BYTES);
    expect(Buffer.byteLength(aliceBody) + Buffer.byteLength(bobBody)).toBeGreaterThan(
      WIKI_REGISTRY_MAX_LOCAL_BYTES,
    );
    await writeFile(path.join(alice, "wikis.json"), aliceBody, "utf8");
    await writeFile(path.join(bob, "wikis.json"), bobBody, "utf8");
    const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
    await source.refresh();
    expect(source.current()).toHaveLength(1);
    expect(source.currentId()).toBeNull();
  });

  it("publishes no local authority after a tenant Wiki listing fails", async () => {
    const currentId = "edededed-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-local-read-failure-"));
    const aliceWikis = path.join(tmp, "tenants", "alice", "wikis");
    const bobWikis = path.join(tmp, "tenants", "bob", "wikis");
    await mkdir(path.join(aliceWikis, currentId), { recursive: true });
    await mkdir(path.join(bobWikis, currentId), { recursive: true });
    await writeFile(
      path.join(tmp, "tenants", "alice", "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(currentId)],
        currentId,
      }),
      "utf8",
    );
    const original = fsSync.readdirSync.bind(fsSync);
    const listing = vi.spyOn(fsSync, "readdirSync").mockImplementation(
      ((target, options) => {
        if (path.resolve(String(target)) === path.resolve(bobWikis)) {
          throw Object.assign(new Error("listing denied"), { code: "EACCES" });
        }
        return original(target, options as { withFileTypes: true });
      }) as typeof fsSync.readdirSync,
    );
    try {
      const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
      await source.refresh();
      expect(source.current()).toEqual([]);
      expect(source.currentId()).toBeNull();
    } finally {
      listing.mockRestore();
    }
  });

  it("fails closed at every local discovery and declared-record bound", async () => {
    const currentId = "ffffffff-0000-4000-8000-000000000000";

    const tooManyTenants = await mkdtemp(
      path.join(os.tmpdir(), "epic8-local-tenant-bound-"),
    );
    const tenantRoot = path.join(tooManyTenants, "tenants");
    const alice = path.join(tenantRoot, "alice");
    await mkdir(path.join(alice, "wikis", currentId), { recursive: true });
    await writeFile(
      path.join(alice, "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(currentId)],
        currentId,
      }),
      "utf8",
    );
    await mkdirMany(
      Array.from({ length: WIKI_REGISTRY_MAX_TENANTS }, (_, index) =>
        path.join(tenantRoot, `extra-${String(index).padStart(3, "0")}`),
      ),
    );
    const tenantSource = createWikiRegistrySource({
      base: "",
      token: "",
      dataDir: tooManyTenants,
    });
    await tenantSource.refresh();
    expect(tenantSource.current()).toEqual([]);
    expect(tenantSource.currentId()).toBeNull();

    const tooManyEntries = await mkdtemp(
      path.join(os.tmpdir(), "epic8-local-entry-bound-"),
    );
    const entryAlice = path.join(tooManyEntries, "tenants", "alice");
    const entryWikis = path.join(entryAlice, "wikis");
    await mkdirMany([
      path.join(entryWikis, currentId),
      ...Array.from({ length: WIKI_REGISTRY_MAX_ROWS }, (_, index) =>
        path.join(entryWikis, `not-a-wiki-${String(index).padStart(4, "0")}`),
      ),
    ]);
    await writeFile(
      path.join(entryAlice, "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(currentId)],
        currentId,
      }),
      "utf8",
    );
    const entrySource = createWikiRegistrySource({
      base: "",
      token: "",
      dataDir: tooManyEntries,
    });
    await entrySource.refresh();
    expect(entrySource.current()).toEqual([]);
    expect(entrySource.currentId()).toBeNull();

    const tooManyDeclared = await mkdtemp(
      path.join(os.tmpdir(), "epic8-local-declared-bound-"),
    );
    const declaredAlice = path.join(tooManyDeclared, "tenants", "alice");
    await mkdir(path.join(declaredAlice, "wikis", currentId), { recursive: true });
    const declared = Array.from({ length: WIKI_REGISTRY_MAX_ROWS + 1 }, (_, index) =>
      completeDiskWiki(
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Wiki ${index}`,
      ),
    );
    declared[0] = completeDiskWiki(currentId);
    await writeFile(
      path.join(declaredAlice, "wikis.json"),
      JSON.stringify({ version: 1, wikis: declared, currentId }),
      "utf8",
    );
    const declaredSource = createWikiRegistrySource({
      base: "",
      token: "",
      dataDir: tooManyDeclared,
    });
    await declaredSource.refresh();
    expect(declaredSource.current()).toHaveLength(1);
    expect(declaredSource.currentId()).toBeNull();
  }, 20_000);

  it("publishes no partial local snapshot when the row budget is exhausted", async () => {
    const currentId = "ffffffff-0000-4000-8000-000000000000";
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-local-row-bound-"));
    const first = path.join(tmp, "tenants", "a", "wikis");
    const second = path.join(tmp, "tenants", "b", "wikis");
    const uuid = (index: number) =>
      `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    await mkdirMany([
      path.join(first, currentId),
      ...Array.from({ length: 500 }, (_, index) => path.join(first, uuid(index))),
      ...Array.from({ length: 499 }, (_, index) => path.join(second, uuid(index + 500))),
      path.join(second, currentId),
    ]);
    await writeFile(
      path.join(tmp, "tenants", "a", "wikis.json"),
      JSON.stringify({
        version: 1,
        wikis: [completeDiskWiki(currentId)],
        currentId,
      }),
      "utf8",
    );
    const source = createWikiRegistrySource({ base: "", token: "", dataDir: tmp });
    await source.refresh();
    expect(source.current()).toEqual([]);
    expect(source.currentId()).toBeNull();
  }, 20_000);

  it("resolves a live registry source on Chat instead of an empty listen-time array", async () => {
    const wikiId = "aaaa1111-0000-4000-8000-000000000000";
    const root = await mkdtemp(path.join(os.tmpdir(), "epic8-live-registry-"));
    const hostPath = path.join(root, wikiId);
    await mkdir(hostPath);
    const source = {
      current: () => [
        { id: wikiId, path: canonicalizePathSnapshot(hostPath) as string },
      ],
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
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "epic8-prod-registry-"));
    const hostPath = path.join(dataDir, "tenants", "alice", "wikis", wikiId);
    await mkdir(hostPath, { recursive: true });
    const { kernel, wikiRegistry } = productionWikiRegistry({
      env: {
        WORKWIKI_URL: "http://kernel.test",
        WORKWIKI_API_TOKEN: "automation",
        DATA_DIR: dataDir,
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            currentId: wikiId,
            projects: [
              {
                id: wikiId,
                path: `tenants/alice/wikis/${wikiId}`,
                hostPath,
              },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(kernel.base).toBe("http://kernel.test");
    await wikiRegistry.refresh();
    expect(resolveLoopbackWikiId(hostPath, wikiRegistry)).toBe(wikiId);
    const main = await readFile(
      path.join(process.cwd(), "sidecar/server.mjs"),
      "utf8",
    );
    expect(main).toContain("const { kernel, wikiRegistry } = productionWikiRegistry()");
    expect(main).toMatch(/createSidecarServer\(\{[\s\S]*wikiRegistry,/);
    expect(main).not.toMatch(/handleChat\([\s\S]*wikiRegistry:\s*registry/);
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

  it("does not treat a failed Source listing as an empty finished tree", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-list-"));
    const originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    _resetStorage();
    _resetLocks();
    try {
      await saveRawSource("note", "body", { owner: "alice" });
      vi.spyOn(getStorage(), "listFiles").mockRejectedValue(new Error("list exploded"));
      const page = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
      });
      expect(page.reason).toBe("listing_unavailable");
      expect(page.requested).toBe(0);
      expect(page.nextCursor).toBeNull();
    } finally {
      vi.restoreAllMocks();
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      _resetStorage();
      _resetLocks();
    }
  });

  it("fails a partial nested listing atomically and retries from the original cursor", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-list-nested-"));
    const originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    _resetStorage();
    _resetLocks();
    try {
      await saveRawSourceTree("good/readable.md", "readable", { owner: "alice" });
      await saveRawSourceTree("bad/unreadable.md", "unreadable", { owner: "alice" });
      const storage = getStorage();
      const realList = storage.listFiles.bind(storage);
      let failBadBranch = true;
      const list = vi.spyOn(storage, "listFiles").mockImplementation(async (prefix) => {
        if (failBadBranch && String(prefix).endsWith("/bad")) {
          throw new Error("nested list exploded");
        }
        return realList(prefix);
      });
      const enqueue = vi.spyOn(tasks, "enqueueTask").mockResolvedValue(true);

      const failed = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
        limit: 10,
        cursor: 0,
      });
      expect(failed).toMatchObject({
        requested: 0,
        results: [],
        remaining: 0,
        nextCursor: null,
        reason: "listing_unavailable",
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(await listIngestJobs({ owner: "alice" })).toEqual([]);

      failBadBranch = false;
      const retried = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
        limit: 10,
        cursor: 0,
      });
      expect(retried.requested).toBe(2);
      expect(retried.results.map((row) => row.path).sort()).toEqual([
        "raw/sources/bad/unreadable.md",
        "raw/sources/good/readable.md",
      ]);
      expect(retried.nextCursor).toBeNull();
      expect(enqueue).toHaveBeenCalledTimes(2);
      list.mockRestore();
      enqueue.mockRestore();
    } finally {
      vi.restoreAllMocks();
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      _resetStorage();
      _resetLocks();
    }
  });

  it("fails atomically when the depth cap hides a raw/sources subtree", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "epic8-list-depth-"));
    const originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    _resetStorage();
    _resetLocks();
    try {
      await saveRawSource("visible", "visible", { owner: "alice" });
      const deep = `${Array.from({ length: 20 }, (_, i) => `d${i}`).join("/")}/hidden.md`;
      await saveRawSourceTree(deep, "hidden", { owner: "alice" });
      const enqueue = vi.spyOn(tasks, "enqueueTask").mockResolvedValue(true);
      const failed = await rescanSources({
        owner: "alice",
        wikiId: null,
        readableSlugs: new Set(),
      });
      expect(failed).toMatchObject({
        requested: 0,
        results: [],
        remaining: 0,
        nextCursor: null,
        reason: "listing_unavailable",
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(await listIngestJobs({ owner: "alice" })).toEqual([]);
    } finally {
      vi.restoreAllMocks();
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
