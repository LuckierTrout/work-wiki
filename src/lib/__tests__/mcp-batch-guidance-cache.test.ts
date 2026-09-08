/**
 * `batch_ingest_urls` mints ONE guidance handle per call (DW-395).
 *
 * The MCP batch handler is the other door onto the same operation
 * `POST /api/ingest/batch` runs, and that route has supplied a request-scoped
 * `guidanceCache` to its inline `ingestUrl` calls since DW-324. This handler did
 * not: every URL in one agent action re-resolved the active Wiki's Workspace
 * Purpose and re-read the Names & Terms dictionary from scratch, N times over.
 *
 * The claim can only be observed in what the handler HANDS `ingestUrl` — the
 * memo has no output of its own, and two freshly-minted handles are shapewise
 * identical — so `../ingest` is module-mocked here and the assertions are
 * about object IDENTITY. That is also why these rows cannot join the
 * `batch_ingest_urls` suite in `mcp.test.ts`: that one drives the REAL pipeline
 * with only `fetchUrlContent` mocked, and so never sees the options object.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ingest")>();
  return { ...actual, ingestUrl: vi.fn() };
});

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { ingestUrl } from "../ingest";
import { handleBatchIngest } from "../../mcp";

const mockedIngestUrl = vi.mocked(ingestUrl);

const fakeResult = {
  primarySlug: "some-page",
  slugs: ["some-page"],
  chunks: 1,
} as unknown as Awaited<ReturnType<typeof ingestUrl>>;

const handlesFromCalls = () =>
  mockedIngestUrl.mock.calls.map((call) => call[1]?.guidanceCache);

/**
 * A real `GuidanceCache`, not merely something truthy.
 *
 * The identity assertions below compare whatever sits at `options.guidanceCache`
 * to itself, so they would pass just as happily on a hard-coded `true` — the
 * option has to be the composite handle `createGuidanceCache()` returns, whose
 * two memos are the things whose re-creation costs the reads this fix removes.
 */
const expectGuidanceHandle = (handle: unknown) => {
  expect(handle).toEqual(
    expect.objectContaining({
      workspace: expect.anything(),
      namesTerms: expect.anything(),
    }),
  );
};

describe("batch_ingest_urls — one guidance cache per CALL", () => {
  beforeEach(() => {
    mockedIngestUrl.mockReset();
    mockedIngestUrl.mockResolvedValue(fakeResult);
  });

  it("hands every URL in one batch the SAME handle", async () => {
    const result = await handleBatchIngest({
      urls: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ],
    });

    expect(result.succeeded).toBe(3);
    expect(mockedIngestUrl).toHaveBeenCalledTimes(3);

    const handles = handlesFromCalls();
    expectGuidanceHandle(handles[0]);
    // IDENTITY, not shape: three fresh handles would look alike under
    // `toEqual` while each still paid for its own Purpose resolution and
    // dictionary read — the exact cost this fix removes.
    expect(handles[1]).toBe(handles[0]);
    expect(handles[2]).toBe(handles[0]);
  });

  it("mints a fresh handle per call, never reusing one across calls", async () => {
    // The other half of the caller-owned, per-operation contract in
    // `guidance-cache.ts`: the handle's lifetime is exactly the variable
    // holding it. A module-level cache would pass the row above and quietly
    // serve a Workspace Purpose edited between two agent actions from a memo
    // minted before it.
    await handleBatchIngest({ urls: ["https://example.com/a"] });
    await handleBatchIngest({ urls: ["https://example.com/b"] });

    expect(mockedIngestUrl).toHaveBeenCalledTimes(2);
    const [first, second] = handlesFromCalls();
    expectGuidanceHandle(first);
    expectGuidanceHandle(second);
    expect(second).not.toBe(first);
  });

  it("still carries the batch's other options through", async () => {
    // The control: the handle was ADDED to the options literal, not swapped in
    // for what was already there.
    await handleBatchIngest({
      urls: ["https://example.com/a"],
      tags: ["research"],
      owner: "alice",
      triggeredBy: "alice",
    });

    expect(mockedIngestUrl).toHaveBeenCalledWith("https://example.com/a", {
      tags: ["research"],
      owner: "alice",
      author: "alice",
      triggeredBy: "alice",
      guidanceCache: handlesFromCalls()[0],
    });
  });

  it("keeps one handle across a batch in which some URLs fail", async () => {
    // A per-URL failure is caught and counted, not rethrown — the handle must
    // survive it, or the batch silently splits into two guidance scopes at the
    // first bad URL.
    mockedIngestUrl
      .mockResolvedValueOnce(fakeResult)
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(fakeResult);

    const result = await handleBatchIngest({
      urls: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ],
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    const handles = handlesFromCalls();
    expectGuidanceHandle(handles[0]);
    expect(handles[1]).toBe(handles[0]);
    expect(handles[2]).toBe(handles[0]);
  });
});
