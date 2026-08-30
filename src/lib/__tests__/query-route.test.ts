import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/query", () => ({
  query: vi.fn(async () => ({ answer: "ok", sources: [] })),
}));
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
// Only the deadline READING is faked (DW-545). `importOriginal` keeps the rest
// of `config` real, so nothing else reached through that module is quietly
// replaced by a stub that agrees with the test.
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getLlmTimeoutMs: vi.fn(() => null),
}));

import { query } from "@/lib/query";
import { getPrincipal } from "@/lib/auth";
import { getLlmTimeoutMs } from "@/lib/config";
import { LLM_DEADLINE_COPY } from "@/lib/llm-deadline";
import { POST } from "@/app/api/query/route";

const mockedQuery = vi.mocked(query);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedTimeout = vi.mocked(getLlmTimeoutMs);

function abortError(name: "TimeoutError" | "AbortError"): Error {
  // Exactly what `AbortSignal.timeout()` rejects with — transport vocabulary
  // and all. None of it may reach the owner.
  const error = new Error("The operation was aborted due to timeout");
  error.name = name;
  return error;
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: NO deadline configured, which is this repo's default and the state
  // of every owner who never filled the field in — so every pre-DW-545 row runs
  // against exactly the behaviour it always had.
  mockedTimeout.mockReturnValue(null);
  // Default: a signed-in user — the middleware already guarantees this for any
  // POST /api/query, so the route's own guard passes and we exercise the body.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetPrincipal.mockResolvedValue({ handle: "tester" } as any);
});

describe("POST /api/query — format validation", () => {
  it("accepts format:'html' and threads it to query()", async () => {
    const res = await POST(makeRequest({ question: "what is A?", format: "html" }));
    expect(res.status).toBe(200);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    expect(mockedQuery.mock.calls[0][1]).toBe("html"); // 2nd arg = format
  });

  it("accepts the existing formats", async () => {
    for (const f of ["prose", "table", "slides"]) {
      await POST(makeRequest({ question: "q", format: f }));
    }
    expect(mockedQuery).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid format with 400 and does not run the query", async () => {
    const res = await POST(makeRequest({ question: "q", format: "bogus" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/format must be/);
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});

describe("POST /api/query — auth (LLM cost gate)", () => {
  it("401s an unauthenticated caller and never runs the LLM query", async () => {
    mockedGetPrincipal.mockResolvedValueOnce(null); // anonymous
    const res = await POST(makeRequest({ question: "what is A?", format: "prose" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sign in/i);
    expect(mockedQuery).not.toHaveBeenCalled(); // no LLM call for anonymous
  });
});

// ---------------------------------------------------------------------------
// DW-545. This route is where the owner actually READS a deadline sentence:
// `useStreamingQuery` re-queries it whenever `/api/query/stream` answers
// non-2xx and PREFERS the message it gets back, so transport words here
// overwrite the sentence the stream route already emitted.
// ---------------------------------------------------------------------------
describe("POST /api/query — the deadline sentence (DW-545)", () => {
  it.each(["TimeoutError", "AbortError"] as const)(
    "answers 500 with the notice when the owner's deadline rejects the query (%s)",
    async (name) => {
      mockedTimeout.mockReturnValue(30_000);
      mockedQuery.mockRejectedValueOnce(abortError(name));

      const res = await POST(makeRequest({ question: "what is A?" }));

      // 500 and not 504: a verdict about a limit the OWNER set.
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: LLM_DEADLINE_COPY });
    },
  );

  it("lets no transport vocabulary through on that path", async () => {
    mockedTimeout.mockReturnValue(30_000);
    mockedQuery.mockRejectedValueOnce(abortError("TimeoutError"));

    const { error } = await (
      await POST(makeRequest({ question: "what is A?" }))
    ).json();

    for (const word of ["aborted", "signal", "TimeoutError", "AbortError"]) {
      expect(error).not.toContain(word);
    }
  });

  it("still reports a NON-deadline failure in the error's own words", async () => {
    mockedTimeout.mockReturnValue(30_000);
    mockedQuery.mockRejectedValueOnce(new Error("no model configured"));

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("no model configured");
  });

  it("says nothing about a limit when NO deadline is configured", async () => {
    // `llmTimeoutOption()` installs no signal at all with the field blank, so
    // an abort arriving anyway is not one this repo set up — naming a limit to
    // raise and a field to clear would send the owner to controls that do not
    // exist.
    mockedQuery.mockRejectedValueOnce(abortError("TimeoutError"));

    const res = await POST(makeRequest({ question: "what is A?" }));

    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error).not.toBe(LLM_DEADLINE_COPY);
    expect(error).toBe("The operation was aborted due to timeout");
  });
});
