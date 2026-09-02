import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// #413: the streaming query route must apply the SAME agent-scoped filter the
// non-streaming query() does — unscoped queries answer from the public commons
// only, never from agent-identity/knowledge/social pages.
//
// DW-546: the three filtering cases ALSO pin that the route streams a
// completing 200 with a body. The filter and `selectPagesForQuery` both run
// before `callLLMStream`, so the argument assertions held even while a broken
// `callLLMStream` double made every one of those calls 500 into the handler's
// catch — nothing here could see it. The status/body assertions are what make
// a non-completing route visible. They are not noise; do not strip them.
// ---------------------------------------------------------------------------

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));

vi.mock("@/lib/search", () => ({
  // Default to UNSCOPED; individual tests override per scope.
  resolveScopeSlugs: vi.fn(async () => ({ scopeSlugs: undefined })),
}));

// The realm predicates here are the REAL ones, not stubs. They come from
// `@/lib/page-types`, the client-safe module `wiki.ts` itself re-exports them
// from, so no logic is restated and nothing can drift.
//
// DW-667: this factory used to hand-copy them, and the copied `isArtifactType`
// matched `html` while production matched `html` and `slides` — so a route that
// stopped filtering decks still passed green. A comment telling the next reader
// to mirror production is not enforcement; importing the predicate is. A stub
// here can never again be narrower than the code it stands in for.
vi.mock("@/lib/wiki", async () => {
  const { isAgentScopedType, isArtifactType } = await import("@/lib/page-types");
  return {
    listReadableWikiPages: vi.fn(),
    isAgentScopedType,
    isArtifactType,
  };
});

vi.mock("@/lib/llm", () => ({
  // Async on purpose (DW-669): production `hasLLMKey` is `async` and the route
  // calls it as `await hasLLMKey()`. The "500s when no API key is configured"
  // case at the bottom of this file is what makes that shape load-bearing —
  // without a case that resolves FALSE, an async and a sync double behave
  // identically everywhere and reverting this line would break nothing.
  //
  // The implementation lives on the `vi.fn` itself, not in `beforeEach`:
  // `vi.clearAllMocks()` clears call history, not implementations, so this
  // survives every case and the one `mockResolvedValueOnce(false)` override.
  hasLLMKey: vi.fn(async () => true),
  // Bare mock; `scriptStream()` below resolves it to a fake `StreamTextResult`.
  // The SHAPE is load-bearing: `callLLMStream` is async and returns
  // `streamText()`'s result object, and the route reads
  // `result.fullStream[Symbol.asyncIterator]()`. An async generator (what this
  // used to be) has no `fullStream`, so the route threw a TypeError into its
  // catch and answered 500 on every one of these tests — which is why they now
  // assert a status and a body, not just the `selectPagesForQuery` arguments.
  callLLMStream: vi.fn(),
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
import { selectPagesForQuery, buildQuerySystemPrompt } from "@/lib/query";
import { getPrincipal } from "@/lib/auth";
import { callLLMStream, hasLLMKey } from "@/lib/llm";
import { POST } from "@/app/api/query/stream/route";

const mockedList = vi.mocked(listReadableWikiPages);
const mockedScope = vi.mocked(resolveScopeSlugs);
const mockedSelect = vi.mocked(selectPagesForQuery);
const mockedPrompt = vi.mocked(buildQuerySystemPrompt);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedStream = vi.mocked(callLLMStream);
const mockedHasKey = vi.mocked(hasLLMKey);

/** The whole answer these tests expect back out of the route's body. */
const ANSWER = "A is a concept.";

/**
 * Resolve `callLLMStream` to a stand-in for `StreamTextResult` carrying only
 * what the route touches: a `fullStream`.
 *
 * The script carries the bookkeeping parts a real `fullStream` has around its
 * text — a `start`, which the route's `pull` must LOOP past rather than return
 * on (see route.ts's comment on that loop), and a closing `finish`. The finish
 * reason is `"stop"` and must stay that way: `"length"` is the DW-547 output
 * cap, which would append a notice to the body and break the body assertions.
 *
 * `text` is here because a real result has it — the route never awaits it, so
 * nothing should assert on it.
 *
 * `[Symbol.asyncIterator]` builds a FRESH iterator on every call, so a second
 * `POST` within one test reads the script from the top instead of finding it
 * exhausted and answering an empty body.
 */
function scriptStream(text = ANSWER) {
  const parts = [
    { type: "start" },
    { type: "text-delta", id: "t0", text },
    { type: "finish", finishReason: "stop" },
  ];
  const makeIterator = () => {
    let index = 0;
    return {
      async next() {
        return index < parts.length
          ? { done: false as const, value: parts[index++] }
          : { done: true as const, value: undefined };
      },
    };
  };
  mockedStream.mockResolvedValue({
    fullStream: { [Symbol.asyncIterator]: () => makeIterator() },
    text: Promise.resolve(text),
    // Narrower than `StreamTextResult` on purpose — the cast says so rather
    // than widening the route's own types to accommodate a test double.
  } as unknown as Awaited<ReturnType<typeof callLLMStream>>);
}

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
  // Every case gets a stream that runs to completion by default.
  scriptStream();
});

describe("POST /api/query/stream — agent-scope filtering (#413)", () => {
  it("excludes agent-scoped pages from an UNSCOPED query", async () => {
    const res = await POST(makeRequest({ question: "what is A?" }));

    // The route filters and selects BEFORE it calls the LLM, so the argument
    // assertions below were reached even under the old broken double. What
    // they could not see is the 500 the route then fell into — these two lines
    // are what pin that it reaches a 200 with a body (DW-546).
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ANSWER);

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

    const res = await POST(
      makeRequest({ question: "what is yoyo?", scope: "agent:yoyo" }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ANSWER);

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    // Scoped query: no agent filter — the full readable set flows through.
    expect(passedEntries.map((e) => e.type)).toContain("agent-identity");
    expect(passedEntries.map((e) => e.type)).toContain("agent-knowledge");
  });

  it("excludes saved html and slides artifacts from an unscoped query (and accepts format:html)", async () => {
    mockedList.mockResolvedValue([
      { slug: "concept-a", title: "A", summary: "", type: undefined },
      { slug: "saved-chart", title: "Chart", summary: "", type: "html" },
      { slug: "saved-deck", title: "Deck", summary: "", type: "slides" },
    ] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>);

    const res = await POST(makeRequest({ question: "?", format: "html" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ANSWER);

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const passedEntries = mockedSelect.mock.calls[0][1] as Array<{ type?: string }>;
    // Neither artifact type's markup may enter the LLM context — `slides` is
    // here so a route that filtered `html` only would fail (DW-667).
    expect(passedEntries.map((e) => e.type)).not.toContain("html");
    expect(passedEntries.map((e) => e.type)).not.toContain("slides");
    expect(passedEntries.map((e) => (e as { slug: string }).slug)).toEqual([
      "concept-a",
    ]);

    // DW-671: the "accepts format:html" half of this title. A 200 alone does
    // not show the format survived the route — one that coerced every request
    // to "prose" would still stream a 200 with the same body. `queryFormat` is
    // argument index 3 of the real `buildQuerySystemPrompt`
    // (`context, entries, selectedSlugs, format, owner` — query.ts:180-186), so
    // the assertion pins THAT position rather than the whole call: the other
    // arguments are the mocked context/entries/slugs this case does not speak
    // to, and spelling them out here would break on any unrelated fixture edit.
    expect(mockedPrompt).toHaveBeenCalledTimes(1);
    expect(mockedPrompt.mock.calls[0][3]).toBe("html");
  });

  it("rejects an invalid format with 400", async () => {
    const res = await POST(makeRequest({ question: "?", format: "bogus" }));
    expect(res.status).toBe(400);
    // Stopped before any expensive work — no page selection, no LLM stream.
    // Both are pinned (DW-668): `callLLMStream` runs after
    // `selectPagesForQuery` in the route, so asserting only the latter left the
    // "no LLM stream" claim resting on statement order instead of on a check.
    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller and never selects pages / calls the LLM", async () => {
    mockedGetPrincipal.mockResolvedValueOnce(null); // anonymous
    const res = await POST(makeRequest({ question: "what is A?" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sign in/i);
    // Stopped before any expensive work — no page selection, no LLM stream.
    // Both are pinned (DW-668): `callLLMStream` runs after
    // `selectPagesForQuery` in the route, so asserting only the latter left the
    // "no LLM stream" claim resting on statement order instead of on a check.
    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  // DW-670: the `#413` filter's own user-visible failure mode. When every
  // readable page is agent-scoped, an UNSCOPED query filters `entries` down to
  // nothing and the route answers the "wiki is empty" 400 (route.ts:124-139) —
  // not an empty wiki, but a commons emptied BY the filter. The other filtering
  // cases all keep at least one public page, so nothing covered this outcome.
  it("400s an unscoped query whose readable pages are ALL agent-scoped", async () => {
    mockedList.mockResolvedValue([
      { slug: "yoyo-identity", title: "Y", summary: "", type: "agent-identity" },
      { slug: "yoyo-notes", title: "N", summary: "", type: "agent-knowledge" },
    ] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>);

    const res = await POST(makeRequest({ question: "what is yoyo?" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/wiki is empty/i);
    // The empty-entries 400 sits ABOVE the key gate (route.ts:141), so an
    // unreached `hasLLMKey` also pins that ordering — as does the untouched
    // selection/stream pair below it.
    expect(mockedHasKey).not.toHaveBeenCalled();
    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  // DW-669: this case is what makes the `hasLLMKey` double's ASYNC shape
  // load-bearing. The route gates on `if (!(await hasLLMKey()))`; drop that
  // `await` and the expression tests a Promise, which is always truthy, so the
  // gate is skipped and this case sees a streamed 200 instead of the 500. With
  // no false-resolving case, a sync double and an async one are indistinguish-
  // able and nothing in the suite can see that slip.
  //
  // The default `ENTRIES` fixture is non-empty on purpose here — the route must
  // reach the key gate rather than short-circuit on the empty-wiki 400 above it.
  it("500s when no API key is configured and never selects pages / calls the LLM", async () => {
    mockedHasKey.mockResolvedValueOnce(false);

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/API key/i);
    // Gated before any expensive work — no page selection, no LLM stream.
    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();
  });
});
