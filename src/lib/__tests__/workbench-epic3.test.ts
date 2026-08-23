import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SIDECAR_HEALTH_URL, SIDECAR_SSE_EVENTS } from "../sidecar";
import { CHAT_COVERAGE_MISSING_COPY, CHAT_COMPOSER_PLACEHOLDER } from "../workbench-modes";
import { shouldDockPreview, selectionFromContentPath } from "../workbench-tree";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => null),
}));

import { POST as POST_CLOUD_CHAT } from "@/app/api/v1/projects/[wikiId]/chat/route";
import { POST as POST_CHAT_ALIAS } from "@/app/api/v1/chat/route";
import { POST as POST_SEARCH } from "@/app/api/v1/projects/[wikiId]/search/route";
import { POST as POST_RETRIEVE } from "@/app/api/v1/projects/[wikiId]/retrieve/route";
import {
  applyDotEnv,
  createChatTurnSession,
  createSidecarServer,
  formatSse,
  generateChat,
  healthPayload,
  isSidecarWikiId,
  parseDotEnv,
  resolveChatSecret,
  SSE_EVENTS,
} from "../../../sidecar/server.mjs";

const ROOT = path.resolve(__dirname, "../../..");

async function readRel(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

describe("cloud Chat is sidecar_required", () => {
  it("returns 503 sidecar_required on project and alias routes", async () => {
    const project = await POST_CLOUD_CHAT(new Request("http://local/api/v1/projects/current/chat"), {
      params: Promise.resolve({ wikiId: "current" }),
    });
    expect(project.status).toBe(503);
    await expect(project.json()).resolves.toEqual({ error: "sidecar_required" });

    const alias = await POST_CHAT_ALIAS();
    expect(alias.status).toBe(503);
    await expect(alias.json()).resolves.toEqual({ error: "sidecar_required" });
  });

  it("refuses a filesystem path as wikiId", async () => {
    const res = await POST_CLOUD_CHAT(
      new Request("http://local/api/v1/projects/../etc/passwd/chat"),
      { params: Promise.resolve({ wikiId: "../etc/passwd" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("kernel Search auth and empty query", () => {
  it("401s without a session and 400s an empty query", async () => {
    const unauth = await POST_SEARCH(
      new Request("http://local/search", {
        method: "POST",
        body: JSON.stringify({ query: "alpha" }),
      }),
      { params: Promise.resolve({ wikiId: "current" }) },
    );
    expect(unauth.status).toBe(401);

    const { getPrincipal } = await import("@/lib/auth");
    vi.mocked(getPrincipal).mockResolvedValueOnce({ id: "alice", handle: "alice" } as never);
    const empty = await POST_SEARCH(
      new Request("http://local/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "" }),
      }),
      { params: Promise.resolve({ wikiId: "current" }) },
    );
    expect(empty.status).toBe(400);
  });

  it("retrieve 401s without a session and 400s an empty query", async () => {
    const unauth = await POST_RETRIEVE(
      new Request("http://local/retrieve", {
        method: "POST",
        body: JSON.stringify({ query: "alpha" }),
      }),
      { params: Promise.resolve({ wikiId: "current" }) },
    );
    expect(unauth.status).toBe(401);

    const { getPrincipal } = await import("@/lib/auth");
    vi.mocked(getPrincipal).mockResolvedValueOnce({ id: "alice", handle: "alice" } as never);
    const empty = await POST_RETRIEVE(
      new Request("http://local/retrieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "   " }),
      }),
      { params: Promise.resolve({ wikiId: "current" }) },
    );
    expect(empty.status).toBe(400);
  });
});

describe("sidecar contract", () => {
  it("health payload has the required fields and SSE names match", () => {
    const health = healthPayload();
    for (const key of [
      "ok",
      "status",
      "version",
      "enabled",
      "authRequired",
      "authConfigured",
      "allowUnauthenticated",
      "tokenSource",
    ]) {
      expect(health).toHaveProperty(key);
    }
    expect(SIDECAR_HEALTH_URL).toBe("http://127.0.0.1:19828/api/v1/health");
    expect([...SSE_EVENTS]).toEqual([...SIDECAR_SSE_EVENTS]);
    expect(isSidecarWikiId("current")).toBe(true);
    expect(isSidecarWikiId("2c1a0c2e-0f3a-4b1a-9c2e-0f3a4b1a9c2e")).toBe(true);
    expect(isSidecarWikiId("/tmp/wiki")).toBe(false);
  });

  it("JSON is the default and SSE uses only the locked events", async () => {
    const server = createSidecarServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/api/v1/projects/current/chat`;
    try {
      const jsonRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverage: false, query: "anything" }),
      });
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers.get("content-type")).toContain("application/json");
      const jsonBody = await jsonRes.json();
      expect(jsonBody).toEqual({
        content: CHAT_COVERAGE_MISSING_COPY,
        thinking: "",
        citations: [],
        coverage: false,
      });
      expect(jsonBody.content).not.toMatch(/\[\d+\]/);

      const sseRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ coverage: false, query: "anything" }),
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      const text = await sseRes.text();
      const events = [...text.matchAll(/^event: (\w+)/gm)].map((match) => match[1]);
      expect(events[0]).toBe("meta");
      expect(events.at(-1)).toBe("done");
    expect(events.every((name) => (SIDECAR_SSE_EVENTS as readonly string[]).includes(name))).toBe(true);
    expect(text).toContain(CHAT_COVERAGE_MISSING_COPY);
    expect(text).not.toMatch(/event: agent[\s\S]*\[1\]/);
    expect(SSE_EVENTS).toContain("cancelled");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("copy and dock", () => {
  it("pins coverage copy, composer placeholder, and citation dock", () => {
    expect(CHAT_COVERAGE_MISSING_COPY).toBe(
      "Wiki has no coverage for this. Ingest a source or run Deep Research.",
    );
    expect(CHAT_COMPOSER_PLACEHOLDER).toBe("Type a message…");
    expect(shouldDockPreview("chat", { kind: "page", slug: "alpha" })).toBe(true);
    expect(shouldDockPreview("chat", null)).toBe(false);
    expect(shouldDockPreview("search", { kind: "file", path: "raw/sources/a.md" })).toBe(true);
    expect(selectionFromContentPath("wiki/alpha.md")).toEqual({
      kind: "page",
      slug: "alpha",
    });
    expect(selectionFromContentPath("raw/sources/a.md")).toEqual({
      kind: "file",
      path: "raw/sources/a.md",
    });
    expect(selectionFromContentPath("wiki/queries/cited-answer.md")).toEqual({
      kind: "page",
      slug: "queries/cited-answer",
    });
  });
});

describe("Workbench Chat does not use Worker query or ChatWorkspace", () => {
  it("retires Worker generation on the leftover { message } door", async () => {
    const route = await readRel("src/app/api/chat/conversations/[id]/messages/route.ts");
    const legacy = await readRel("src/components/ChatWorkspace.tsx");
    expect(route).not.toContain("addChatTurn");
    expect(route).toContain('error: "sidecar_required"');
    expect(legacy).not.toContain("JSON.stringify({ message })");
    expect(legacy).toContain("/?mode=chat");
  });

  it("keeps /api/query and ChatWorkspace off the rail surfaces", async () => {
    const chat = await readRel("src/components/workbench/ChatCanvas.tsx");
    const search = await readRel("src/components/workbench/SearchCanvas.tsx");
    const mode = await readRel("src/components/workbench/ModeCanvas.tsx");
    const shell = await readRel("src/components/workbench/Workbench.tsx");
    expect(chat).not.toContain("/api/query");
    expect(chat).not.toContain("ChatWorkspace");
    expect(mode).not.toContain("ChatWorkspace");
    expect(shell).not.toContain("ChatWorkspace");
    expect(chat).toContain("sidecarChatUrl");
    expect(chat).toContain("CHAT_COMPOSER_PLACEHOLDER");
    expect(chat).toContain("send<{");
    expect(chat).not.toContain("await response.json()");
    expect(search).not.toContain("await response.json()");
    expect(mode).toContain("CHAT_SIDECAR_DOWN_COPY");
    expect(chat).toContain("Regenerate");
    expect(chat).toContain("Save to Wiki");
    expect(chat).toContain("Stop");
    expect(chat).not.toContain("body.model?.apiKey");
    expect(chat).toContain("wb-chat-thinking");
    expect(chat).toContain("Sources-only");
    const css = await readRel("src/app/globals.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".wb-chat-thinking--live p");
    expect(chat).toContain("body: JSON.stringify({ content: assistant.content })");
    expect(chat).not.toContain("assistant.thinking");
  });
});

describe("Save to Wiki door", () => {
  it("writes under queries and queues two-step Ingest", async () => {
    const route = await readRel("src/app/api/chat/conversations/[id]/save/route.ts");
    const save = await readRel("src/lib/query.ts");
    expect(route).toContain("underQueries: true");
    expect(route).toContain("enqueueOrInline");
    expect(route).toContain("createIngestJob");
    expect(route).toContain("saveRawSourceFor");
    expect(route).toContain("sourcePath");
    expect(route).toContain("contentSha256");
    expect(save).toContain("queries/${baseSlug");
    expect(save).toContain("writeWikiPageWithSideEffects");
  });
});

describe("sidecar local credentials and cancel", () => {
  it("parses dotenv without overriding a live env value", () => {
    expect(parseDotEnv("ANTHROPIC_API_KEY=from-file\n# skip\n")).toEqual({
      ANTHROPIC_API_KEY: "from-file",
    });
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "already" };
    applyDotEnv("ANTHROPIC_API_KEY=from-file\nOPENAI_API_KEY=new\n", env);
    expect(env.ANTHROPIC_API_KEY).toBe("already");
    expect(env.OPENAI_API_KEY).toBe("new");
  });

  it("resolves secrets from env/config and ignores a request apiKey", async () => {
    expect(resolveChatSecret("anthropic", { ANTHROPIC_API_KEY: "sk" })).toBe("sk");
    expect(resolveChatSecret("custom", {}, { customApiKey: "stored" })).toBe("stored");
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        generateChat({
          provider: "anthropic",
          apiKey: "sk-from-browser",
          system: "s",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow(/Configure a Chat model in Settings/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("emits cancelled once when the client aborts before settle", () => {
    const chunks: string[] = [];
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead() {
        this.headersSent = true;
      },
      write(chunk: string) {
        chunks.push(chunk);
      },
      end() {
        this.writableEnded = true;
      },
    };
    const req = { on() {} };
    const session = createChatTurnSession(req, res, true);
    session.emitCancelled();
    session.emitCancelled();
    expect(chunks.join("")).toBe(formatSse("cancelled", {}));
    expect(res.writableEnded).toBe(true);
    session.settle();
  });
});

describe("Search empty query stays quiet", () => {
  it("does not POST or set an error when the field is blank", async () => {
    const search = await readRel("src/components/workbench/SearchCanvas.tsx");
    expect(search).toContain('if (!trimmed) return');
    expect(search).toContain("workbenchMode(\"search\").emptyState");
    expect(search).not.toContain("setError(\"Query cannot be empty");
  });
});
