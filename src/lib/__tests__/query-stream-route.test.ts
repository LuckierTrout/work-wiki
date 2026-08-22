import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// #413: the streaming query route must apply the SAME agent-scoped filter the
// non-streaming query() does — unscoped queries answer from the public commons
// only, never from agent-identity/knowledge/social pages.
// ---------------------------------------------------------------------------

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));

vi.mock("@/lib/search", () => ({
  // Default to UNSCOPED; individual tests override per scope.
  resolveScopeSlugs: vi.fn(async () => ({ scopeSlugs: undefined })),
}));

vi.mock("@/lib/wiki", () => ({
  listReadableWikiPages: vi.fn(),
  // Real-ish predicates: agent-scoped types are the `agent-*` family; saved
  // artifacts are `html`.
  isAgentScopedType: (t: unknown) =>
    typeof t === "string" && t.startsWith("agent-"),
  isArtifactType: (t: unknown) => t === "html",
}));

vi.mock("@/lib/llm", () => ({
  hasLLMKey: vi.fn(() => true),
  // The real `callLLMStream` resolves to the AI SDK's `StreamTextResult`, whose
  // `fullStream` yields `TextStreamPart`s — NOT a bare async generator. The
  // route reads `result.fullStream`, so the mock has to carry that shape.
  // Default: an empty stream, so the route completes without a real LLM.
  callLLMStream: vi.fn(async () => ({
    fullStream: (async function* () {})(),
  })),
}));

vi.mock("@/lib/query", () => ({
  selectPagesForQuery: vi.fn(async () => ["concept-a"]),
  buildContext: vi.fn(async () => ({ context: "ctx", slugs: ["concept-a"] })),
  buildQuerySystemPrompt: vi.fn(() => "system"),
}));

vi.mock("@/lib/names-terms", () => ({
  expandQueryWithNamesTerms: vi.fn(async (_owner: string, question: string) => question),
}));

import { listReadableWikiPages } from "@/lib/wiki";
import { resolveScopeSlugs } from "@/lib/search";
import { selectPagesForQuery } from "@/lib/query";
import { getPrincipal } from "@/lib/auth";
import { callLLMStream } from "@/lib/llm";
import { POST } from "@/app/api/query/stream/route";

const mockedList = vi.mocked(listReadableWikiPages);
const mockedScope = vi.mocked(resolveScopeSlugs);
const mockedSelect = vi.mocked(selectPagesForQuery);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedStream = vi.mocked(callLLMStream);

const ENTRIES = [
  { slug: "concept-a", title: "A", summary: "", type: undefined },
  { slug: "yoyo-identity", title: "Y", summary: "", type: "agent-identity" },
  { slug: "yoyo-notes", title: "N", summary: "", type: "agent-knowledge" },
] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/query/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue(ENTRIES);
  mockedScope.mockResolvedValue({ scopeSlugs: undefined });
  // Default: a signed-in user (the middleware guarantees a session for POST).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetPrincipal.mockResolvedValue({ id: "u", handle: "u" } as any);
  // A generator is consumed once, so the stream is built PER CALL (not handed
  // over pre-constructed) — a second POST inside one test would otherwise see
  // an exhausted stream. `clearAllMocks` clears calls, not implementations, so
  // each test still needs this default restored here.
  mockedStream.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => ({ fullStream: (async function* () {})() }) as any,
  );
});

describe("POST /api/query/stream — agent-scope filtering (#413)", () => {
  it("excludes agent-scoped pages from an UNSCOPED query", async () => {
    await POST(makeRequest({ question: "what is A?" }));

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    expect(passedEntries.map((e) => e.type)).not.toContain("agent-identity");
    expect(passedEntries.map((e) => e.type)).not.toContain("agent-knowledge");
    expect(passedEntries.map((e) => (e as { slug: string }).slug)).toEqual([
      "concept-a",
    ]);
  });

  it("keeps agent-scoped pages when an agent: scope is provided", async () => {
    mockedScope.mockResolvedValue({ scopeSlugs: ["yoyo-identity", "yoyo-notes"] });

    await POST(makeRequest({ question: "what is yoyo?", scope: "agent:yoyo" }));

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    // Scoped query: no agent filter — the full readable set flows through.
    expect(passedEntries.map((e) => e.type)).toContain("agent-identity");
    expect(passedEntries.map((e) => e.type)).toContain("agent-knowledge");
  });

  it("excludes saved html artifacts from an unscoped query (and accepts format:html)", async () => {
    mockedList.mockResolvedValue([
      { slug: "concept-a", title: "A", summary: "", type: undefined },
      { slug: "saved-chart", title: "Chart", summary: "", type: "html" },
    ] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>);

    await POST(makeRequest({ question: "?", format: "html" }));

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    // The artifact's markup must never enter the LLM context.
    expect(passedEntries.map((e) => e.type)).not.toContain("html");
    expect(passedEntries.map((e) => (e as { slug: string }).slug)).toEqual([
      "concept-a",
    ]);
  });

  it("rejects an invalid format with 400", async () => {
    const res = await POST(makeRequest({ question: "?", format: "bogus" }));
    expect(res.status).toBe(400);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller and never selects pages / calls the LLM", async () => {
    mockedGetPrincipal.mockResolvedValueOnce(null); // anonymous
    const res = await POST(makeRequest({ question: "what is A?" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sign in/i);
    // Stopped before any expensive work — no page selection, no LLM stream.
    expect(mockedSelect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DW-64: a fired LLM deadline must speak to the OWNER, not in transport
// vocabulary and not by falling silent mid-sentence.
// ---------------------------------------------------------------------------

/** The route's module-private copy, pinned here literally on purpose. */
const DEADLINE_COPY =
  "This answer ran past the LLM timeout set in Settings and stopped " +
  "before it was finished. Ask again, or raise that limit in Settings.";

/** What `AbortSignal.timeout` rejects with, message and all. */
const RAW_TIMEOUT_MESSAGE = "The operation was aborted due to timeout";

/**
 * The REAL shape a fired `AbortSignal.timeout` rejects with — a `DOMException`,
 * not an `Error` with a reassigned `name`. Pins the classifier against the
 * thing it will actually meet in production.
 */
function timeoutDomException(): DOMException {
  return new DOMException(RAW_TIMEOUT_MESSAGE, "TimeoutError");
}

/** A cheaper stand-in for the cases where the exact class doesn't matter. */
function deadlineError(name: "TimeoutError" | "AbortError"): Error {
  const error = new Error(RAW_TIMEOUT_MESSAGE);
  error.name = name;
  return error;
}

/**
 * Whatever body this is, it must read as the owner's sentence and nothing
 * else — asserted against the ACTUAL response text, never against the local
 * copy constant (which could not fail).
 */
function expectOwnerFacing(text: string) {
  expect(text).toContain("LLM timeout");
  expect(text).toContain("Settings");
  expect(text.toLowerCase()).not.toContain("abort");
  expect(text.toLowerCase()).not.toContain("signal");
  expect(text).not.toContain(RAW_TIMEOUT_MESSAGE);
}

function delta(text: string) {
  return { type: "text-delta", id: "1", text };
}

/** A `StreamTextResult`-shaped stub whose `fullStream` yields these parts. */
function streamOf(...parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
  };
}

/** Built per call, so a second POST in one test gets a fresh stream. */
function setStream(...parts: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedStream.mockImplementation(async () => streamOf(...parts) as any);
}

/** A stream that yields `parts`, then REJECTS — the in-`pull` catch path. */
function setThrowingStream(parts: unknown[], error: unknown) {
  mockedStream.mockImplementation(
    async () =>
      ({
        fullStream: (async function* () {
          for (const part of parts) yield part;
          throw error;
        })(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
  );
}

const decoder = new TextDecoder();

describe("POST /api/query/stream — the LLM deadline sentence (DW-64)", () => {
  it("streams a normal answer unchanged: 200, text/plain, deltas concatenated, sources header", async () => {
    setStream(
      { type: "start" },
      delta("Hello"),
      delta(", world"),
      { type: "finish", finishReason: "stop" },
    );

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Wiki-Sources")).toBe(
      encodeURIComponent(JSON.stringify(["concept-a"])),
    );
    expect(await res.text()).toBe("Hello, world");
  });

  it("504s with the one owner-facing sentence when a real TimeoutError fires before the stream", async () => {
    mockedSelect.mockRejectedValueOnce(timeoutDomException());

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(504);
    // Read the RAW body: the assertions below have to see everything that
    // reached the owner, not just the field we expected to find.
    const raw = await res.text();
    expect(JSON.parse(raw).error).toBe(DEADLINE_COPY);
    expectOwnerFacing(raw);
  });

  it("504s with the same sentence for an explicit abort before the stream", async () => {
    mockedSelect.mockRejectedValueOnce(deadlineError("AbortError"));

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe(DEADLINE_COPY);
  });

  it("504s when the abort arrives wrapped as the `cause` of another error", async () => {
    mockedSelect.mockRejectedValueOnce(
      new Error("provider call failed", { cause: timeoutDomException() }),
    );

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe(DEADLINE_COPY);
  });

  it("appends the sentence to the partial answer when the deadline fires mid-stream", async () => {
    setStream(delta("Half an ans"), { type: "abort", reason: RAW_TIMEOUT_MESSAGE });

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    // The headers have to survive on THIS path too, not just the happy one.
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Wiki-Sources")).toBe(
      encodeURIComponent(JSON.stringify(["concept-a"])),
    );
    const text = await res.text();
    expect(text).toBe(`Half an ans\n\n${DEADLINE_COPY}`);
    expectOwnerFacing(text);
  });

  it("sends the BARE sentence when the deadline fires before any text — no leading blank line", async () => {
    setStream({ type: "start" }, { type: "abort", reason: RAW_TIMEOUT_MESSAGE });

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(DEADLINE_COPY);
    expect(text.startsWith("\n")).toBe(false);
  });

  it("treats a deadline that arrives as an error part the same way", async () => {
    setStream(delta("Half an ans"), {
      type: "error",
      error: deadlineError("TimeoutError"),
    });

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`Half an ans\n\n${DEADLINE_COPY}`);
  });

  it("appends the sentence and closes cleanly when the iterator REJECTS with a deadline", async () => {
    setThrowingStream([delta("Half an ans")], timeoutDomException());

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    // `res.text()` resolving at all is the assertion that matters: the body was
    // closed, not errored.
    const text = await res.text();
    expect(text).toBe(`Half an ans\n\n${DEADLINE_COPY}`);
  });

  it("errors the body when the iterator REJECTS with a non-deadline failure", async () => {
    setThrowingStream([delta("Some text")], new Error("boom"));

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    // Today's behaviour exactly: the failure errors the stream. No sentence is
    // appended — the reader sees the text that arrived, then the rejection.
    await expect(res.text()).rejects.toThrow();
  });

  it("finalizes the LLM stream when the client cancels the response body", async () => {
    let finalized = false;
    mockedStream.mockImplementation(
      async () =>
        ({
          fullStream: (async function* () {
            try {
              yield delta("first");
              yield delta("second");
              yield delta("third");
            } finally {
              finalized = true;
            }
          })(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    const res = await POST(makeRequest({ question: "what is A?" }));
    const reader = res.body!.getReader();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("first");
    expect(finalized).toBe(false);

    // The owner navigated away mid-answer: the model call must stop, not run on.
    await reader.cancel("client went away");
    expect(finalized).toBe(true);
  });

  it("leaves a non-deadline throw on today's 500 + raw message path", async () => {
    mockedSelect.mockRejectedValueOnce(new Error("boom"));

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });

  it("still ignores a non-deadline error part, appending no sentence", async () => {
    setStream(delta("Some text"), { type: "error", error: new Error("boom") });

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("Some text");
    expect(text).not.toContain(DEADLINE_COPY);
  });
});
