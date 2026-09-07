import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SIDECAR_HEALTH_URL, SIDECAR_SSE_EVENTS } from "../sidecar";
import { CHAT_COVERAGE_MISSING_COPY, CHAT_COMPOSER_PLACEHOLDER } from "../workbench-modes";
import { shouldDockPreview, selectionFromContentPath } from "../workbench-tree";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => null),
  // Epic 8: the `/api/v1` façade accepts the owner-automation token as well as a
  // session, because the sidecar reaches the kernel with exactly that and has no
  // cookie jar. Both branches must answer "nobody" here — this test is about the
  // 401, and a mock missing the second one would throw instead of refusing.
  getServicePrincipal: vi.fn(() => null),
}));

import { POST as POST_CLOUD_CHAT } from "@/app/api/v1/projects/[wikiId]/chat/route";
import { POST as POST_CHAT_ALIAS } from "@/app/api/v1/chat/route";
import { POST as POST_SEARCH } from "@/app/api/v1/projects/[wikiId]/search/route";
import { POST as POST_RETRIEVE } from "@/app/api/v1/projects/[wikiId]/retrieve/route";
import {
  applyDotEnv,
  allowSidecarOrigin,
  createChatTurnSession,
  createSidecarServer,
  formatSse,
  generateChat,
  healthPayload,
  isSidecarWikiId,
  parseDotEnv,
  resolveChatEndpoint,
  resolveChatSecret,
  sanitizeCitedAnswer,
  SSE_EVENTS,
} from "../../../sidecar/server.mjs";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * A sidecar whose door is OPEN, for the tests that are about Chat rather than
 * about the door.
 *
 * Epic 8 made the loopback API opt-in and fail-closed: `createSidecarServer()`
 * with no settings source answers 503 `disabled` on every data route, which is
 * the behaviour the matrix asks for. These SSE-shape tests predate that switch,
 * so they open the door explicitly rather than relying on a default — a default
 * that admitted them would be an unauthenticated API.
 */
function openDoorServer() {
  const settings = {
    enabled: true,
    allowUnauthenticated: true,
    token: null,
    tokenSource: "none" as const,
    skillEnablement: {},
  };
  return createSidecarServer({
    settingsSource: { current: () => settings, refresh: async () => settings },
  });
}

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
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "alice");
    vi.stubEnv("YOPEDIA_OWNER_USER_ID", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("rejects a ceremonial wiki id that is not current or a UUID", async () => {
    const { getPrincipal } = await import("@/lib/auth");
    vi.mocked(getPrincipal).mockResolvedValueOnce({ id: "alice", handle: "alice" } as never);
    const res = await POST_SEARCH(
      new Request("http://local/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "alpha" }),
      }),
      { params: Promise.resolve({ wikiId: "not-a-wiki" }) },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_wiki_id" });
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
    // The FIELD NAMES are Epic 3's and stay. The `status` VALUE is not: Epic 8
    // replaced the flat `"ok"` with a listener state, because `"ok"` said
    // nothing about whether the process answering on 19828 was this one.
    expect(health.status).toBe("running");
    expect(SIDECAR_HEALTH_URL).toBe("http://127.0.0.1:19828/api/v1/health");
    expect([...SSE_EVENTS]).toEqual([...SIDECAR_SSE_EVENTS]);
    expect(isSidecarWikiId("current")).toBe(true);
    expect(isSidecarWikiId("2c1a0c2e-0f3a-4b1a-9c2e-0f3a4b1a9c2e")).toBe(true);
    expect(isSidecarWikiId("/tmp/wiki")).toBe(false);
  });

  it("JSON is the default and SSE uses only the locked events", async () => {
    const server = openDoorServer();
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

      const forbidden = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(forbidden.headers.get("access-control-allow-origin")).toBeNull();
      const trusted = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { Origin: "http://localhost:3000" },
      });
      expect(trusted.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:3000",
      );
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
    expect(shouldDockPreview("todos", { kind: "page", slug: "standup" })).toBe(true);
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
    // The door moved to `chat-session-transport.ts` (DW-444). The pin follows
    // it, and stays doubled so neither half can drift alone: the transport
    // still owns the URL, and Chat still reaches the sidecar through it rather
    // than growing a second door.
    const transport = await readRel("src/lib/chat-session-transport.ts");
    expect(transport).toContain("sidecarChatUrl");
    expect(chat).toContain("@/lib/chat-session-transport");
    expect(chat).not.toContain("sidecarChatUrl");
    expect(chat).toContain("CHAT_COMPOSER_PLACEHOLDER");
    // The conversation doors moved to `chat-conversation-store.ts` (DW-587).
    // The same doubling as above: the store owns the parsed-body helper, and
    // Chat reaches the conversations through it rather than re-opening a door
    // of its own beside the JSX.
    const store = await readRel("src/lib/chat-conversation-store.ts");
    expect(store).toContain("send<{");
    expect(chat).toContain("@/lib/chat-conversation-store");
    expect(chat).not.toContain("send<");
    expect(chat).not.toContain("await response.json()");
    expect(search).not.toContain("await response.json()");
    // DW-607: the constant became a selector over the page's own origin. The
    // subject is unchanged — the sentence has one definition, in the shared
    // module, and none is typed in the component.
    expect(mode).toContain("chatSidecarDownCopy");
    // Neither sentence is typed here — banning only the old one would leave the
    // new one free to be inlined with this pin still passing.
    expect(mode).not.toContain("Start the local sidecar");
    expect(mode).not.toContain("WORKWIKI_SIDECAR_ALLOWED_ORIGINS");
    expect(chat).toContain("Regenerate");
    expect(chat).toContain("Save to Wiki");
    expect(chat).toContain("Stop");
    expect(chat).not.toContain("body.model?.apiKey");
    expect(chat).toContain("wb-chat-thinking");
    expect(chat).toContain("Sources-only");
    const css = await readRel("src/app/globals.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".wb-chat-thinking--live p");
    // The Save-to-Wiki body followed its door into the store (DW-587), so this
    // half is aimed there; Chat's half is that it still names the ANSWER it is
    // saving, which is what stops the button drifting onto the conversation or
    // onto whatever message happens to be last.
    expect(store).toContain("body: JSON.stringify({ messageId })");
    expect(chat).toContain("saveAnswerToWiki(activeId, assistant.id)");
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
      writeHead(_code?: number, _headers?: unknown) {
        res.headersSent = true;
      },
      write(chunk: string) {
        chunks.push(chunk);
      },
      end() {
        res.writableEnded = true;
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

describe("sidecar Chat extract boundaries", () => {
  it("keeps generateChat in chat-provider and sidecar modules off src/lib", async () => {
    const provider = await readRel("sidecar/chat-provider.mjs");
    const transport = await readRel("sidecar/chat-transport.mjs");
    const server = await readRel("sidecar/server.mjs");
    expect(provider).toMatch(/export async function generateChat\(/);
    expect(server).not.toMatch(/export async function generateChat\(/);
    expect(server).toMatch(/from ["']\.\/chat-provider\.mjs["']/);
    for (const src of [provider, transport, server]) {
      expect(src).not.toMatch(/from\s+["'][^"']*src\/lib/);
      expect(src).not.toMatch(/import\s*\(\s*["'][^"']*src\/lib/);
    }
  });
});

describe("sidecar origin, endpoint, and citation integrity", () => {
  it("allows only loopback browser origins", () => {
    expect(allowSidecarOrigin(undefined)).toBe(true);
    expect(allowSidecarOrigin("http://localhost:3000")).toBe(true);
    expect(allowSidecarOrigin("http://127.0.0.1:19828")).toBe(true);
    expect(allowSidecarOrigin("https://evil.example")).toBe(false);
  });

  it("resolves provider endpoints from local config only", () => {
    expect(
      resolveChatEndpoint("custom", {}, { customBaseUrl: "http://127.0.0.1:9/v1" }),
    ).toBe("http://127.0.0.1:9/v1");
    expect(resolveChatEndpoint("openai", {}, { customBaseUrl: "http://evil" })).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("drops invented and unused citations", () => {
    const result = sanitizeCitedAnswer("Hello [1] and [9].", [
      { n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" },
      { n: 2, path: "wiki/beta.md", title: "Beta", type: "page" },
    ]);
    expect(result.coverage).toBe(true);
    expect(result.citations).toEqual([
      { n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" },
    ]);
    expect(result.content).toContain("[1]");
    expect(result.content).not.toContain("[9]");
  });
});

describe("successful sidecar provider SSE", () => {
  afterEach(() => {
    delete process.env.LLM_CUSTOM_API_KEY;
  });

  it("aggregates thinking and cited content from the local provider only", async () => {
    const captured: { urls: string[]; attacker: boolean } = { urls: [], attacker: false };
    const provider = http.createServer((req, res) => {
      captured.urls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "<thinking>look at alpha</thinking>Alpha is defined [1].",
              },
            },
          ],
        }),
      );
    });
    const attacker = http.createServer((_req, res) => {
      captured.attacker = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "stolen" } }] }));
    });
    await Promise.all([
      new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve)),
    ]);
    const providerPort = (provider.address() as { port: number }).port;
    const attackerPort = (attacker.address() as { port: number }).port;
    const tmp = await mkdtemp(path.join(os.tmpdir(), "sidecar-sse-"));
    const previousDataDir = process.env.DATA_DIR;
    const previousKey = process.env.LLM_CUSTOM_API_KEY;
    process.env.DATA_DIR = tmp;
    process.env.LLM_CUSTOM_API_KEY = "sidecar-secret";
    await writeFile(
      path.join(tmp, ".llm-wiki-config.json"),
      JSON.stringify({
        chatProvider: "custom",
        chatModel: "local-test",
        customBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
      }),
    );
    const sidecar = openDoorServer();
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    const sidecarPort = (sidecar.address() as { port: number }).port;
    try {
      const response = await fetch(
        `http://127.0.0.1:${sidecarPort}/api/v1/projects/current/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            stream: true,
            query: "What is alpha?",
            coverage: true,
            context: "[1] Alpha\npath: wiki/alpha.md\ntype: page\n\nalpha body",
            citations: [
              { n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" },
              { n: 2, path: "wiki/beta.md", title: "Beta", type: "page" },
            ],
            model: {
              provider: "custom",
              baseUrl: `http://127.0.0.1:${attackerPort}/v1`,
              apiKey: "browser-key",
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: meta");
      expect(text).toContain("event: agent");
      expect(text).toContain("event: done");
      expect(text).toContain("look at alpha");
      expect(text).toContain("Alpha is defined [1].");
      expect(text).not.toContain("wiki/beta.md");
      expect(captured.attacker).toBe(false);
      expect(captured.urls.some((row) => row.includes("/chat/completions"))).toBe(true);
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      if (previousKey === undefined) delete process.env.LLM_CUSTOM_API_KEY;
      else process.env.LLM_CUSTOM_API_KEY = previousKey;
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          sidecar.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          attacker.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    }
  });
});
