import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// DW-662 / DW-666 / DW-683: `callLLM` used to destructure `{ text }` from
// `generateText` and throw the finish reason away, so every non-streamed door
// committed a cut answer as a whole one. `callLLMWithFinish` surfaces it.
//
// This suite pins the SPLIT itself — that the sibling reports the reason and
// that `callLLM` is unchanged for the ~19 callers that do not act on it. The
// two doors that DO act on it are pinned where they live (`query.test.ts`,
// `research-runtime.test.ts`).
//
// `ai` is mocked so no network call happens and the finish reason is ours to
// choose; the provider SDKs are mocked so `getModel()` builds a client from a
// bare env key. Same shape as `llm-deepseek.test.ts`.
// ---------------------------------------------------------------------------

const { generateTextMock } = vi.hoisted(() => ({
  // Typed with its argument so the "forwards the output cap" row can read
  // `mock.calls[0][0]`; a zero-parameter double gives that an empty tuple.
  generateTextMock: vi.fn(
    async (_options: Record<string, unknown>) => ({
      text: "ok",
      finishReason: "stop",
    }),
  ),
}));
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: vi.fn(() => ({ toTextStreamResponse: vi.fn() })),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn(() => vi.fn()) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn(() => vi.fn()) }));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn()),
}));
vi.mock("ollama-ai-provider-v2", () => ({ createOllama: vi.fn(() => vi.fn()) }));

import { callLLM, callLLMWithFinish } from "../llm";
import { _resetConfigCache } from "../config";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_MODEL",
  "DATA_DIR",
];
const saved: Record<string, string | undefined> = {};

/** What the provider returned this time. */
function answers(text: string, finishReason: string) {
  generateTextMock.mockResolvedValue({ text, finishReason });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // No config file at this path, so the env key below is the whole ladder.
  process.env.DATA_DIR = "/tmp/llm-wiki-finish-test-nonexistent";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  vi.clearAllMocks();
  answers("ok", "stop");
  _resetConfigCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetConfigCache();
});

describe("callLLMWithFinish (DW-662, DW-666, DW-683)", () => {
  it("reports the text and why the model stopped", async () => {
    answers("A whole answer", "stop");

    expect(await callLLMWithFinish("system", "hello")).toEqual({
      text: "A whole answer",
      finishReason: "stop",
    });
  });

  it.each(["length", "content-filter", "error", "tool-calls", "other"])(
    "hands back finishReason %s rather than discarding it",
    async (reason) => {
      // The whole point: a fragment and a finished answer are the same string,
      // and this field is the only thing that tells the two apart.
      answers("As far as this w", reason);

      expect(await callLLMWithFinish("system", "hello")).toEqual({
        text: "As far as this w",
        finishReason: reason,
      });
    },
  );

  it("refuses an empty response in the same words the wrapper always used", async () => {
    // The throw lives on the sibling, not on the delegate, so a caller reading
    // the reason is never handed `{ text: "", finishReason: "stop" }` and left
    // to invent its own rule for it.
    answers("", "stop");

    await expect(callLLMWithFinish("system", "hello")).rejects.toThrow(
      "LLM response contained no text",
    );
  });

  it("forwards the output cap it was given", async () => {
    await callLLMWithFinish("system", "hello", { maxOutputTokens: 7_000 });

    expect(generateTextMock.mock.calls[0][0]).toMatchObject({
      system: "system",
      maxOutputTokens: 7_000,
    });
  });
});

describe("callLLM is unchanged by the split", () => {
  it("still returns the text alone", async () => {
    answers("A whole answer", "stop");

    const result = await callLLM("system", "hello");

    expect(result).toBe("A whole answer");
  });

  it("still returns the text alone when the model was CUT", async () => {
    // The ~19 callers that reach this name do not act on the distinction — an
    // ingest summary, a title, a classification — so a `length` finish must not
    // change what they receive. The doors that DO act on it call the sibling.
    answers("As far as this w", "length");

    expect(await callLLM("system", "hello")).toBe("As far as this w");
  });

  it("still refuses an empty response", async () => {
    answers("", "stop");

    await expect(callLLM("system", "hello")).rejects.toThrow(
      "LLM response contained no text",
    );
  });
});
