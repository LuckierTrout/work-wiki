import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// DW-64: when the owner's own LLM deadline cuts a streamed answer short, the
// body must SAY SO.
//
// The failure this pins is silence, not noise: `ai@6`'s `streamText` turns the
// abort into an `{ type: "abort" }` part and closes the stream, and the
// `textStream` the route used to serve keeps only `text-delta` parts — so the
// abort vanished and a truncated half-answer arrived looking finished.
//
// A SEPARATE file from `query-stream-route.test.ts` on purpose: this suite has
// to mock `@/lib/llm` (to drive `callLLMStream` with a fake `fullStream`) while
// importing the REAL sentence, which is why the sentence lives in its own
// module. Asserting against a restated literal would be the test grading its
// own copy of the copy.
// ---------------------------------------------------------------------------

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));

// Only the deadline READING is faked. `importOriginal` keeps the rest of
// `config` real, so nothing else this route reaches through that module is
// quietly replaced by a stub that agrees with the test.
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getLlmTimeoutMs: vi.fn(() => 30_000),
}));

vi.mock("@/lib/search", () => ({
  resolveScopeSlugs: vi.fn(async () => ({ scopeSlugs: undefined })),
}));

vi.mock("@/lib/wiki", () => ({
  listReadableWikiPages: vi.fn(),
  isAgentScopedType: (t: unknown) =>
    typeof t === "string" && t.startsWith("agent-"),
  isArtifactType: (t: unknown) => t === "html",
}));

vi.mock("@/lib/llm", () => ({
  hasLLMKey: vi.fn(() => true),
  callLLMStream: vi.fn(),
}));

vi.mock("@/lib/query", () => ({
  selectPagesForQuery: vi.fn(async () => ["concept-a"]),
  buildContext: vi.fn(async () => ({ context: "ctx", slugs: ["concept-a"] })),
  buildQuerySystemPrompt: vi.fn(() => "system"),
}));

vi.mock("@/lib/names-terms", () => ({
  expandQueryWithNamesTerms: vi.fn(
    async (_owner: string, question: string) => question,
  ),
}));

import { listReadableWikiPages } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import { getLlmTimeoutMs } from "@/lib/config";
import { callLLMStream } from "@/lib/llm";
import { logger } from "@/lib/logger";
import {
  LLM_DEADLINE_COPY,
  LLM_LENGTH_CAP_COPY,
  LLM_STOPPED_EARLY_COPY,
} from "@/lib/llm-deadline";
import { SETTINGS_LABEL, settingsPointer } from "@/lib/workbench-settings";
import { POST } from "@/app/api/query/stream/route";

const mockedList = vi.mocked(listReadableWikiPages);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedStream = vi.mocked(callLLMStream);
const mockedTimeout = vi.mocked(getLlmTimeoutMs);

const ENTRIES = [
  { slug: "concept-a", title: "A", summary: "", type: undefined },
] as unknown as Awaited<ReturnType<typeof listReadableWikiPages>>;

/** A `text-delta` part, minus the fields the route never reads. */
const delta = (text: string) => ({ type: "text-delta", id: "t0", text });

type FakePart = { type: string; [key: string]: unknown };

/**
 * Stand in for `StreamTextResult`, exposing only the `fullStream` the route
 * touches. `pending: true` parks the iterator after the scripted parts instead
 * of finishing, which is what the cancellation row needs.
 */
function fakeResult(
  parts: FakePart[],
  opts: { throws?: unknown; pending?: boolean } = {},
) {
  let index = 0;
  // Resolved BY the fake `return`, so the cancellation test awaits the event
  // itself rather than guessing how many ticks propagation takes.
  let announceReturn: () => void;
  const returnCalled = new Promise<void>((resolve) => {
    announceReturn = resolve;
  });
  const returned = vi.fn(async () => {
    announceReturn();
    return { done: true as const, value: undefined };
  });
  const iterator = {
    async next() {
      if (index < parts.length) {
        return { done: false as const, value: parts[index++] };
      }
      if ("throws" in opts) throw opts.throws;
      if (opts.pending) return new Promise<never>(() => {});
      return { done: true as const, value: undefined };
    },
    return: returned,
  };
  const result = {
    fullStream: { [Symbol.asyncIterator]: () => iterator },
  };
  // The route's `result` is a StreamTextResult; this fake carries only what it
  // reads, so the cast is the honest way to say "narrower on purpose".
  mockedStream.mockResolvedValue(
    result as unknown as Awaited<ReturnType<typeof callLLMStream>>,
  );
  return { returned, returnCalled };
}

function abortError(name: "TimeoutError" | "AbortError"): Error {
  // Exactly what `AbortSignal.timeout()` rejects with — transport vocabulary
  // and all. None of it may reach the owner.
  const error = new Error("The operation was aborted due to timeout");
  error.name = name;
  return error;
}

/**
 * The OPERATOR log lines the route emits beside each notice.
 *
 * Restated here rather than imported, because the route cannot export them:
 * Next 15 type-checks route exports and this repo's `route.ts` files export
 * only their HTTP handlers. Restating is safe in a way it would NOT be for the
 * owner-facing sentences — these are log strings for an operator, not copy in
 * an answer body, so there is no Settings pointer to drift and no second home
 * for the wording. What these pin is that the THREE endings are
 * DISTINGUISHABLE: a cap truncation logging "LLM deadline reached" would send
 * an operator to raise a timeout that never fired, and a content filter logged
 * as either would hide the one ending nothing in this repo caused.
 */
const DEADLINE_LOG =
  "LLM deadline reached; the answer was cut short and the owner told";
const LENGTH_CAP_LOG =
  "Output token cap reached; the answer was cut short and the owner told";
const STOPPED_EARLY_LOG =
  "Model stopped before finishing; the answer was cut short and the owner told";

/** The `(scope, message)` pair of the single `logger.warn` a run emitted. */
function warnedOnce(): [string, string] {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  const [scope, message] = vi.mocked(logger.warn).mock.calls[0];
  return [scope as string, message as string];
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/query/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ask = () => POST(makeRequest({ question: "what is A?" }));

beforeEach(() => {
  vi.clearAllMocks();
  // The owner HAS set a deadline unless a test says otherwise — every notice
  // below is licensed by that field being filled in.
  mockedTimeout.mockReturnValue(30_000);
  mockedList.mockResolvedValue(ENTRIES);
  mockedGetPrincipal.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: "u", handle: "u" } as any,
  );
});

describe("LLM_DEADLINE_COPY", () => {
  it("names the Settings destination the way every other pointer composes it", () => {
    // Composed, never typed (DW-369): renaming the `llm-models` category must
    // move this sentence with it rather than orphan it.
    expect(LLM_DEADLINE_COPY).toContain(
      settingsPointer("llm-models", SETTINGS_LABEL),
    );
  });

  it("carries no transport vocabulary", () => {
    for (const word of ["aborted", "signal", "TimeoutError", "AbortError"]) {
      expect(LLM_DEADLINE_COPY).not.toContain(word);
    }
  });
});

describe("POST /api/query/stream — the deadline sentence (DW-64)", () => {
  it("streams a normal answer exactly as before", async () => {
    fakeResult([
      { type: "start" },
      delta("Hello"),
      delta(", world"),
      { type: "finish", finishReason: "stop" },
    ]);

    const res = await ask();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Wiki-Sources")).toBe(
      encodeURIComponent(JSON.stringify(["concept-a"])),
    );
    expect(await res.text()).toBe("Hello, world");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("appends the notice after a blank line when the deadline fires mid-answer", async () => {
    fakeResult([delta("Half an ans"), { type: "abort", reason: "timeout" }]);

    const res = await ask();

    // The notice path is still an ordinary 200 text stream — same status, same
    // content type, same sources header as an answer that ran to completion.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Wiki-Sources")).toBe(
      encodeURIComponent(JSON.stringify(["concept-a"])),
    );
    const body = await res.text();
    expect(body).toBe(`Half an ans\n\n${LLM_DEADLINE_COPY}`);
    // The answer half must not have acquired transport words either.
    const answer = body.slice(0, body.length - LLM_DEADLINE_COPY.length);
    for (const word of ["aborted", "signal", "TimeoutError", "AbortError"]) {
      expect(answer).not.toContain(word);
    }
    // The DEADLINE log line, not the cap's — the two endings have to be
    // distinguishable in an operator's log, or a cap truncation reads as a
    // timeout to raise.
    expect(warnedOnce()).toEqual(["query", DEADLINE_LOG]);
  });

  it("emits the notice alone when the deadline fires before any token", async () => {
    fakeResult([{ type: "abort" }]);

    const res = await ask();

    // No leading blank line: there is no answer for it to separate.
    expect(await res.text()).toBe(LLM_DEADLINE_COPY);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not count an EMPTY delta as an answer to separate the notice from", async () => {
    fakeResult([delta(""), { type: "abort" }]);

    const res = await ask();

    // A zero-length delta is nothing on the wire, so the body must not open
    // with the blank line that exists to separate the notice from real text.
    expect(await res.text()).toBe(LLM_DEADLINE_COPY);
  });

  it("returns an empty body for a stream that yields no parts at all", async () => {
    fakeResult([]);

    const res = await ask();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["TimeoutError", "AbortError"] as const)(
    "maps a THROWN %s mid-read to the same notice",
    async (name) => {
      // The SDK's abort guard is `isAbortError(error) && signal.aborted`, which
      // has a race: an abort can reach `controller.error` instead of the part.
      fakeResult([delta("Half an ans")], { throws: abortError(name) });

      const res = await ask();

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`Half an ans\n\n${LLM_DEADLINE_COPY}`);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it("maps a deadline carried by an `error` part to the same notice", async () => {
    fakeResult([delta("Half"), { type: "error", error: abortError("TimeoutError") }]);

    const res = await ask();

    expect(await res.text()).toBe(`Half\n\n${LLM_DEADLINE_COPY}`);
  });

  it("leaves a NON-deadline mid-stream throw propagating unchanged", async () => {
    fakeResult([delta("Half")], { throws: new Error("provider exploded") });

    const res = await ask();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    let failed: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      failed = error;
    }

    // The stream errors — it does not quietly close with our sentence on the
    // end. DW-64 owns the deadline and nothing else.
    expect(failed).toBeDefined();
    expect(seen).toBe("Half");
    expect(seen).not.toContain(LLM_DEADLINE_COPY);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores a non-deadline `error` part, as it always has", async () => {
    fakeResult([
      delta("Half"),
      { type: "error", error: new Error("a warning-shaped part") },
      delta(" an answer"),
    ]);

    const res = await ask();

    expect(await res.text()).toBe("Half an answer");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("answers 500 with the notice when the deadline beats the stream into existence", async () => {
    // `callLLMStream` awaits config before it ever reaches `streamText`, so a
    // deadline can fire with no stream to carry the sentence.
    mockedStream.mockRejectedValue(abortError("TimeoutError"));

    const res = await ask();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: LLM_DEADLINE_COPY });
  });

  it("still reports a non-deadline setup failure in its own words", async () => {
    mockedStream.mockRejectedValue(new Error("no model configured"));

    const res = await ask();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("no model configured");
  });

  it("releases the provider connection when the owner cancels, writing no notice", async () => {
    const { returned, returnCalled } = fakeResult([delta("Half")], {
      pending: true,
    });

    const res = await ask();
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("Half");

    await reader.cancel("owner navigated away");
    // Cancellation crosses the `TextEncoderStream` and the `Response` body
    // wrapper before it reaches our source. Await the ARRIVAL rather than a
    // fixed number of ticks — a timer would pass or fail on how many hops that
    // crossing happens to take today.
    await returnCalled;

    expect(returned).toHaveBeenCalledTimes(1);
    // No cancellation reason is forwarded: `return(value)` takes a return
    // value, not a reason, and the SDK ignores the argument either way.
    expect(returned.mock.calls[0]).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("LLM_LENGTH_CAP_COPY", () => {
  it("points at no Settings destination, because there is no control behind it", () => {
    // `QUERY_MAX_OUTPUT_TOKENS` is a source constant — nothing on the Settings
    // surface writes it — so a pointer here would send the owner looking for a
    // field that does not exist. Composed rather than typed even to ASSERT its
    // absence, so this stays true through a category rename.
    expect(LLM_LENGTH_CAP_COPY).not.toContain(
      settingsPointer("llm-models", SETTINGS_LABEL),
    );
    expect(LLM_LENGTH_CAP_COPY).not.toContain(SETTINGS_LABEL);
  });

  it("carries no transport or SDK vocabulary", () => {
    // The owner never sees `finishReason`, and "tokens" is the model's unit,
    // not a length they can reason about.
    for (const word of [
      "finishReason",
      "token",
      "maxOutputTokens",
      "aborted",
      "signal",
    ]) {
      expect(LLM_LENGTH_CAP_COPY).not.toContain(word);
    }
  });

  it("is not the deadline sentence wearing a different name", () => {
    expect(LLM_LENGTH_CAP_COPY).not.toBe(LLM_DEADLINE_COPY);
  });

  it("is never the operator's log line, which the owner must not read", () => {
    // The route pairs each sentence with its log inside one descriptor rather
    // than taking two bare `string`s, so a transposition cannot put either of
    // these into the answer body. These assertions are the behavioural half.
    for (const copy of [LLM_LENGTH_CAP_COPY, LLM_DEADLINE_COPY]) {
      expect(copy).not.toBe(DEADLINE_LOG);
      expect(copy).not.toBe(LENGTH_CAP_LOG);
    }
  });
});

describe("POST /api/query/stream — the output cap sentence (DW-547)", () => {
  it("appends the cap notice after a blank line when the answer hits the cap", async () => {
    fakeResult([
      { type: "start" },
      delta("As far as this w"),
      { type: "finish", finishReason: "length" },
    ]);

    const res = await ask();

    // Still an ordinary 200 text stream — the cap is a truthful ending, not a
    // failure the client has to handle differently.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Wiki-Sources")).toBe(
      encodeURIComponent(JSON.stringify(["concept-a"])),
    );
    expect(await res.text()).toBe(
      `As far as this w\n\n${LLM_LENGTH_CAP_COPY}`,
    );
    // The CAP log line, and specifically not the deadline's: nothing about a
    // limit the owner set, because no deadline fired here.
    expect(warnedOnce()).toEqual(["query", LENGTH_CAP_LOG]);
    expect(warnedOnce()[1]).not.toBe(DEADLINE_LOG);
  });

  it("emits the cap notice alone when the cap is hit before any token", async () => {
    fakeResult([{ type: "finish", finishReason: "length" }]);

    const res = await ask();

    // Same blank-line rule as the deadline notice: nothing to separate it from.
    expect(await res.text()).toBe(LLM_LENGTH_CAP_COPY);
  });

  it("still emits the cap notice with NO deadline configured", async () => {
    // The gate on the deadline sentences does not apply here. The cap is passed
    // on every call this route makes, so a `length` finish is always ours —
    // there is no state in which it belongs to someone else.
    mockedTimeout.mockReturnValue(null);
    fakeResult([delta("Half"), { type: "finish", finishReason: "length" }]);

    const res = await ask();

    expect(await res.text()).toBe(`Half\n\n${LLM_LENGTH_CAP_COPY}`);
    expect(warnedOnce()).toEqual(["query", LENGTH_CAP_LOG]);
  });

  it("says nothing when the model stopped on its own", async () => {
    fakeResult([delta("A whole answer"), { type: "finish", finishReason: "stop" }]);

    const res = await ask();

    expect(await res.text()).toBe("A whole answer");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["tool-calls", "content-filter", "other", "error"] as const)(
    "never claims the CAP for finishReason %s",
    async (reason) => {
      // Only `length` is the cap. The rest are other endings entirely, and
      // claiming a maximum length for them would be a false sentence — the cap
      // sentence promises the REST of the answer is reachable by narrowing,
      // which nothing about a content filter or a provider failure makes true.
      fakeResult([delta("Answer"), { type: "finish", finishReason: reason }]);

      const res = await ask();

      const body = await res.text();
      expect(body).not.toContain(LLM_LENGTH_CAP_COPY);
      expect(warnedOnce()[1]).not.toBe(LENGTH_CAP_LOG);
    },
  );

  it("prefers the deadline sentence when an abort arrives before the finish part", async () => {
    // Both can be true of one run. The deadline is what actually stopped it;
    // the cap notice would name a limit that never bound.
    fakeResult([
      delta("Half"),
      { type: "abort" },
      { type: "finish", finishReason: "length" },
    ]);

    const res = await ask();

    expect(await res.text()).toBe(`Half\n\n${LLM_DEADLINE_COPY}`);
    expect(warnedOnce()).toEqual(["query", DEADLINE_LOG]);
  });
});

describe("LLM_STOPPED_EARLY_COPY", () => {
  it("points at no Settings destination, because no field causes this ending", () => {
    // Nothing on the Settings surface causes, prevents or relaxes a
    // `content-filter` or an `error` ending, so a pointer would send the owner
    // to a control that cannot act on what happened. Composed rather than
    // typed even to ASSERT its absence, so this stays true through a category
    // rename.
    expect(LLM_STOPPED_EARLY_COPY).not.toContain(
      settingsPointer("llm-models", SETTINGS_LABEL),
    );
    expect(LLM_STOPPED_EARLY_COPY).not.toContain(SETTINGS_LABEL);
  });

  it("carries no transport or SDK vocabulary", () => {
    // `finishReason` names the field this branch read, not anything that
    // happened to the owner.
    for (const word of [
      "finishReason",
      "token",
      "maxOutputTokens",
      "aborted",
      "signal",
      "content-filter",
    ]) {
      expect(LLM_STOPPED_EARLY_COPY).not.toContain(word);
    }
  });

  it("is neither of the other two sentences wearing a different name", () => {
    expect(LLM_STOPPED_EARLY_COPY).not.toBe(LLM_DEADLINE_COPY);
    expect(LLM_STOPPED_EARLY_COPY).not.toBe(LLM_LENGTH_CAP_COPY);
  });

  it("promises no retrievable remainder, which is what the cap sentence does", () => {
    // The PROPERTY the two sentences actually differ on, not merely that their
    // bytes differ — `not.toBe` above would pass for two sentences a single
    // word apart. Both end by suggesting a narrower question, and that advice
    // is fine after a content filter. What the cap sentence adds is "to see the
    // rest": an assertion that a remainder exists and narrowing retrieves it.
    // A content filter may have refused the remainder outright, and a provider
    // that died may never have produced one, so this sentence must not make
    // that claim.
    expect(LLM_LENGTH_CAP_COPY).toContain("the rest");
    expect(LLM_STOPPED_EARLY_COPY).not.toContain("the rest");
  });

  it("is never an operator's log line, which the owner must not read", () => {
    for (const log of [DEADLINE_LOG, LENGTH_CAP_LOG, STOPPED_EARLY_LOG]) {
      expect(LLM_STOPPED_EARLY_COPY).not.toBe(log);
    }
    // And the reverse pairing, so the third descriptor cannot be assembled
    // out of another notice's half.
    for (const copy of [LLM_DEADLINE_COPY, LLM_LENGTH_CAP_COPY]) {
      expect(copy).not.toBe(STOPPED_EARLY_LOG);
    }
  });
});

describe("POST /api/query/stream — the model stopped early (DW-666)", () => {
  it.each(["content-filter", "error", "tool-calls", "other"] as const)(
    "appends the third notice after a blank line for finishReason %s",
    async (reason) => {
      // The silence this closes: every one of these fell into the route's
      // bookkeeping tail and the body simply ended. `content-filter` is the
      // concrete case — the model was stopped and the owner was told nothing.
      fakeResult([
        { type: "start" },
        delta("As far as this w"),
        { type: "finish", finishReason: reason },
      ]);

      const res = await ask();

      // Still an ordinary 200 text stream with the same headers: an early
      // ending is a truthful ending, not a failure the client handles apart.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("X-Wiki-Sources")).toBe(
        encodeURIComponent(JSON.stringify(["concept-a"])),
      );
      expect(await res.text()).toBe(
        `As far as this w\n\n${LLM_STOPPED_EARLY_COPY}`,
      );
      // Its OWN log line, once — distinguishable from both others, or an
      // operator reads a content filter as a timeout to raise.
      expect(warnedOnce()).toEqual(["query", STOPPED_EARLY_LOG]);
    },
  );

  it("emits the third notice alone when nothing was streamed first", async () => {
    // Same blank-line rule as the other two notices: nothing to separate it
    // from, so no leading empty lines.
    fakeResult([{ type: "finish", finishReason: "content-filter" }]);

    const res = await ask();

    expect(await res.text()).toBe(LLM_STOPPED_EARLY_COPY);
    expect(warnedOnce()).toEqual(["query", STOPPED_EARLY_LOG]);
  });

  it("stays silent for finishReason stop, the one clean ending", async () => {
    fakeResult([delta("A whole answer"), { type: "finish", finishReason: "stop" }]);

    const res = await ask();

    expect(await res.text()).toBe("A whole answer");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the CAP sentence for finishReason length", async () => {
    // The widened branch must not swallow DW-547's distinction: `length` is
    // the one non-`stop` reason with a sentence of its own.
    fakeResult([delta("Half"), { type: "finish", finishReason: "length" }]);

    const res = await ask();

    expect(await res.text()).toBe(`Half\n\n${LLM_LENGTH_CAP_COPY}`);
    expect(warnedOnce()).toEqual(["query", LENGTH_CAP_LOG]);
  });

  it("emits the third notice with NO deadline configured", async () => {
    // Ungated, like both cap sentences. The model reporting that it did not
    // finish is its own statement about its own output — true whether or not
    // the owner ever filled a timeout in.
    mockedTimeout.mockReturnValue(null);
    fakeResult([delta("Half"), { type: "finish", finishReason: "content-filter" }]);

    const res = await ask();

    expect(await res.text()).toBe(`Half\n\n${LLM_STOPPED_EARLY_COPY}`);
    expect(warnedOnce()).toEqual(["query", STOPPED_EARLY_LOG]);
  });

  it("prefers the deadline sentence when an abort arrives before the finish part", async () => {
    // Deadline wins over finish, unchanged (DW-64). The deadline is what
    // actually stopped the run; the third sentence would describe an ending
    // the owner's own limit caused.
    fakeResult([
      delta("Half"),
      { type: "abort" },
      { type: "finish", finishReason: "error" },
    ]);

    const res = await ask();

    expect(await res.text()).toBe(`Half\n\n${LLM_DEADLINE_COPY}`);
    expect(warnedOnce()).toEqual(["query", DEADLINE_LOG]);
  });

  it("still lets a warning-shaped error part through when the brief carries on", async () => {
    // A non-deadline `error` part the stream continues past is dropped exactly
    // as it always has been — DW-666 keys on the FINISH part, not on errors.
    fakeResult([
      delta("Half"),
      { type: "error", error: new Error("a warning-shaped part") },
      delta(" an answer"),
      { type: "finish", finishReason: "stop" },
    ]);

    const res = await ask();

    expect(await res.text()).toBe("Half an answer");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("POST /api/query/stream — with NO deadline configured", () => {
  beforeEach(() => {
    // The default: the field is blank, `llmTimeoutOption()` installs no signal
    // at all, so nothing this repo set up can have aborted.
    mockedTimeout.mockReturnValue(null);
  });

  it("lets a thrown TimeoutError error the stream, saying nothing about a limit", async () => {
    fakeResult([delta("Half")], { throws: abortError("TimeoutError") });

    const res = await ask();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    let failed: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      failed = error;
    }

    expect(failed).toBeDefined();
    expect(seen).toBe("Half");
    expect(seen).not.toContain(LLM_DEADLINE_COPY);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports a pre-stream TimeoutError in the error's own words, not the notice", async () => {
    mockedStream.mockRejectedValue(abortError("TimeoutError"));

    const res = await ask();

    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error).not.toBe(LLM_DEADLINE_COPY);
    expect(error).toBe("The operation was aborted due to timeout");
  });
});
