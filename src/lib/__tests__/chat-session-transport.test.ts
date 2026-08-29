import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The door is mocked, not the network: `loopbackFetch` is the ONE authenticated
 * way to 127.0.0.1:19828, and a suite that stubbed global `fetch` instead would
 * pass even if the transport reached the sidecar around it.
 */
const loopbackFetch = vi.fn();
vi.mock("../loopback-client", () => ({
  loopbackFetch: (input: string, init?: RequestInit) => loopbackFetch(input, init),
}));

import {
  SIDECAR_TURN_ERROR_COPY,
  SIDECAR_TURN_FAILED_COPY,
  SIDECAR_TURN_INCOMPLETE_COPY,
  applySidecarSseBlock,
  consumeSidecarStream,
  readSidecarSseBlock,
  runSidecarTurn,
  type SidecarTurnHandlers,
} from "../chat-session-transport";
import { sidecarChatUrl } from "../sidecar";

const ROOT = path.resolve(__dirname, "../../..");

async function readRel(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

interface Sink extends SidecarTurnHandlers {
  deltas: string[];
  thinking: string[];
  rows: unknown[];
}

function sink(): Sink {
  const deltas: string[] = [];
  const thinking: string[] = [];
  const rows: unknown[] = [];
  return {
    deltas,
    thinking,
    rows,
    onDelta: (delta) => deltas.push(delta),
    onThinking: (value) => thinking.push(value),
    onToolRow: (row) => rows.push(row),
  };
}

/** A body delivered as the caller wrote it — one `read()` per chunk. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  loopbackFetch.mockReset();
});

describe("SSE blocks are filtered to the locked five", () => {
  it("reads a known event and its JSON payload", () => {
    expect(readSidecarSseBlock('event: agent\ndata: {"delta":"hi"}')).toEqual({
      event: "agent",
      data: { delta: "hi" },
    });
  });

  it("ignores an unknown event name rather than failing the turn", () => {
    expect(readSidecarSseBlock('event: heartbeat\ndata: {"t":1}')).toBeNull();
    expect(readSidecarSseBlock(": comment only")).toBeNull();
  });

  it("treats a payload-less known event as an empty payload", () => {
    expect(readSidecarSseBlock("event: done")).toEqual({ event: "done", data: {} });
  });

  it("lets `meta` through the filter and then does nothing with it", () => {
    // `meta` is one of the locked five, so it must NOT be rejected as unknown —
    // but it carries no answer, so it feeds no handler and ends no turn. The
    // two halves are asserted separately: a filter that dropped it and a sink
    // that ignored it look identical from the outside.
    const block = 'event: meta\ndata: {"model":"gpt-4o-mini"}';
    expect(readSidecarSseBlock(block)).toEqual({
      event: "meta",
      data: { model: "gpt-4o-mini" },
    });
    const handlers = sink();
    expect(applySidecarSseBlock(block, handlers)).toBeNull();
    expect(handlers.deltas).toEqual([]);
    expect(handlers.thinking).toEqual([]);
    expect(handlers.rows).toEqual([]);
  });
});

describe("consuming one streamed turn", () => {
  it("delivers deltas, thinking and tool rows in order and returns done", async () => {
    const handlers = sink();
    // Split MID-BLOCK on purpose: the reader must buffer across reads.
    const done = await consumeSidecarStream(
      streamOf([
        'event: agent\ndata: {"delta":"Hel',
        'lo "}\n\nevent: agent\ndata: {"thinking":"looking"}\n\n',
        frame("agent", {
          toolRow: { id: "t1", tool: "wiki_search", state: "done", detail: "3 matches" },
        }),
        frame("agent", { delta: "world" }),
        frame("done", { content: "Hello world", citations: [] }),
      ]),
      handlers,
    );
    expect(handlers.deltas).toEqual(["Hello ", "world"]);
    expect(handlers.thinking).toEqual(["looking"]);
    expect(handlers.rows).toEqual([
      { id: "t1", tool: "wiki_search", state: "done", detail: "3 matches" },
    ]);
    expect(done).toEqual({ content: "Hello world", citations: [] });
  });

  it("applies the trailing block even when the stream never sends the blank line", async () => {
    const handlers = sink();
    const done = await consumeSidecarStream(
      streamOf([
        frame("agent", { delta: "partial" }),
        'event: done\ndata: {"content":"final"}',
      ]),
      handlers,
    );
    expect(handlers.deltas).toEqual(["partial"]);
    expect(done).toEqual({ content: "final" });
  });

  it("carries an unknown event between two agent blocks without stopping", async () => {
    const handlers = sink();
    const done = await consumeSidecarStream(
      streamOf([
        frame("agent", { delta: "a" }),
        frame("heartbeat", { t: 1 }),
        frame("agent", { delta: "b" }),
        frame("done", { content: "ab" }),
      ]),
      handlers,
    );
    expect(handlers.deltas).toEqual(["a", "b"]);
    expect(done).toEqual({ content: "ab" });
  });

  it("ignores a malformed tool row rather than rendering half of one", async () => {
    const handlers = sink();
    await consumeSidecarStream(
      streamOf([frame("agent", { toolRow: { tool: "wiki_search" } }), frame("done", {})]),
      handlers,
    );
    expect(handlers.rows).toEqual([]);
  });

  it("throws the error frame's message, and a default when it has none", async () => {
    await expect(
      consumeSidecarStream(streamOf([frame("error", { message: "provider down" })]), sink()),
    ).rejects.toThrow("provider down");
    await expect(
      consumeSidecarStream(streamOf([frame("error", {})]), sink()),
    ).rejects.toThrow(SIDECAR_TURN_ERROR_COPY);
  });

  it("throws an AbortError on cancelled so the caller stays silent", async () => {
    const cause = await consumeSidecarStream(
      streamOf([frame("agent", { delta: "a" }), frame("cancelled", {})]),
      sink(),
    ).catch((error: unknown) => error);
    expect((cause as Error).name).toBe("AbortError");
  });

  it("throws when the stream closes without a done frame", async () => {
    await expect(
      consumeSidecarStream(
        streamOf([frame("agent", { delta: "a" }), frame("agent", { delta: "b" })]),
        sink(),
      ),
    ).rejects.toThrow(SIDECAR_TURN_INCOMPLETE_COPY);
  });
});

describe("posting a turn through the loopback door", () => {
  it("sends the request to the project's chat URL as an event stream", async () => {
    loopbackFetch.mockResolvedValue(
      new Response(streamOf([frame("done", { content: "ok" })]), { status: 200 }),
    );
    const controller = new AbortController();
    const done = await runSidecarTurn({
      wikiId: "acme wiki",
      request: { stream: true, query: "why" },
      handlers: sink(),
      signal: controller.signal,
    });
    expect(done).toEqual({ content: "ok" });
    const [url, init] = loopbackFetch.mock.calls[0];
    expect(url).toBe(sidecarChatUrl("acme wiki"));
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("text/event-stream");
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body))).toEqual({ stream: true, query: "why" });
  });

  it("reports the door's own reason and never reads the body as a stream", async () => {
    loopbackFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "disabled" }), { status: 503 }),
    );
    const handlers = sink();
    await expect(
      runSidecarTurn({ wikiId: "w", request: {}, handlers }),
    ).rejects.toThrow("disabled");
    // The refusal body is the door's reason, not a turn: nothing was streamed.
    expect(handlers.deltas).toEqual([]);
    expect(handlers.thinking).toEqual([]);
    expect(handlers.rows).toEqual([]);
  });

  it("falls back to one sentence when the refusal body says nothing usable", async () => {
    loopbackFetch.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    await expect(
      runSidecarTurn({ wikiId: "w", request: {}, handlers: sink() }),
    ).rejects.toThrow(SIDECAR_TURN_FAILED_COPY);
    loopbackFetch.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      runSidecarTurn({ wikiId: "w", request: {}, handlers: sink() }),
    ).rejects.toThrow(SIDECAR_TURN_FAILED_COPY);
  });

  it("treats a 200 with no body as a refusal rather than an empty answer", async () => {
    loopbackFetch.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(
      runSidecarTurn({ wikiId: "w", request: {}, handlers: sink() }),
    ).rejects.toThrow(SIDECAR_TURN_FAILED_COPY);
  });
});

describe("the seam actually moved", () => {
  it("leaves no SSE reader or event parsing in ChatCanvas", async () => {
    const chat = await readRel("src/components/workbench/ChatCanvas.tsx");
    expect(chat).not.toContain("getReader()");
    expect(chat).not.toContain("/event:");
    expect(chat).not.toContain("TextDecoder");
    expect(chat).not.toContain("SIDECAR_SSE_EVENTS");
    expect(chat).toContain("@/lib/chat-session-transport");
    expect(chat).toContain("@/lib/chat-pending-turn");
  });

  it("keeps both extracted modules framework-free", async () => {
    // Spelled as regexes because the obvious string pins are too weak to hold:
    // `from "react"` misses single quotes, `react/jsx-runtime` and
    // `require("react")`, and `</` misses every self-closing tag as well as
    // `React.createElement`. A re-regression would slip past either one.
    const reactImport = /(?:from|require\s*\()\s*['"]react(?:[/-][^'"]*)?['"]/;
    const jsx = /<\/[A-Za-z]|<[A-Za-z][^>]*\/>|React\.createElement|jsx\s*\(|_jsxs?\b/;
    const hooks = /\buse(?:State|Effect|Ref|Callback|Memo|Context|Reducer)\s*\(/;
    for (const rel of ["src/lib/chat-session-transport.ts", "src/lib/chat-pending-turn.ts"]) {
      const source = await readRel(rel);
      expect(source).not.toMatch(reactImport);
      expect(source).not.toMatch(jsx);
      expect(source).not.toMatch(hooks);
    }
  });
});
