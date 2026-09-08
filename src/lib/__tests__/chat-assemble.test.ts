/**
 * The retrieval door a Chat turn opens before it asks anything (DW-587).
 *
 * `send` is mocked, not `fetch`: the assemble goes through the workbench's one
 * parsed-body helper like every other kernel call, and stubbing the network
 * would let a second door pass unnoticed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../workbench-request", () => ({ send }));

import {
  RETRIEVE_FAILED_COPY,
  assembleTurn,
  chatHistorySlice,
  type AssembleResponse,
  type ChatHistorySource,
} from "../chat-assemble";

const ASSEMBLED: AssembleResponse = {
  coverage: true,
  coverageMessage: null,
  citations: [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }],
  numberedBodies: "[1] alpha",
  systemPrompt: "system",
  indexSlice: "",
  historySlice: [],
  vectorPhase: { status: "off" },
  chatModel: { provider: "openai", model: "gpt-4o-mini", configured: true },
};

const INPUT = {
  wikiId: "current",
  query: "What is alpha?",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  history: [],
};

beforeEach(() => {
  send.mockReset();
});

describe("assembling one turn", () => {
  it("posts the question and the settings at the project's retrieve door", async () => {
    send.mockResolvedValue(ASSEMBLED);
    await expect(assembleTurn(INPUT)).resolves.toEqual(ASSEMBLED);
    expect(send.mock.calls[0]?.[0]).toBe("/api/v1/projects/current/retrieve");
    expect(send.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({
      query: "What is alpha?",
      retrievalMode: "wiki",
      tokenBudget: 32_000,
      historyDepth: 10,
      history: [],
    });
  });

  it("encodes the wiki id into the path", async () => {
    send.mockResolvedValue(ASSEMBLED);
    await assembleTurn({ ...INPUT, wikiId: "wiki one" });
    expect(send.mock.calls[0]?.[0]).toBe("/api/v1/projects/wiki%20one/retrieve");
  });

  it("carries the transcript it was given", async () => {
    send.mockResolvedValue(ASSEMBLED);
    await assembleTurn({
      ...INPUT,
      history: [
        { id: "u1", role: "user", content: "earlier", citations: [], createdAt: "" },
      ],
    });
    expect(
      (JSON.parse(String(send.mock.calls[0]?.[1]?.body)) as { history: unknown[] }).history,
    ).toEqual([{ id: "u1", role: "user", content: "earlier", citations: [], createdAt: "" }]);
  });

  it("refuses a body whose coverage is not a boolean", async () => {
    // `send` hands back `{}` for a 2xx that would not parse, and every other
    // field the turn reads would then be undefined in a request the sidecar
    // accepts. One boolean decides that the door answered at all.
    send.mockResolvedValue({});
    await expect(assembleTurn(INPUT)).rejects.toThrow(RETRIEVE_FAILED_COPY);
    send.mockResolvedValue({ ...ASSEMBLED, coverage: "yes" });
    await expect(assembleTurn(INPUT)).rejects.toThrow(RETRIEVE_FAILED_COPY);
  });

  it("accepts an assemble that found nothing", async () => {
    // `coverage: false` is an ANSWER, not a refusal: with tools on it is the
    // reason to look rather than the end of the turn.
    send.mockResolvedValue({ ...ASSEMBLED, coverage: false });
    await expect(assembleTurn(INPUT)).resolves.toMatchObject({ coverage: false });
  });
});

describe("the history the assemble is given", () => {
  it("exports each canvas message in the kernel's read shape", () => {
    // Typed as `ChatHistorySource` on purpose: the slice is built FROM canvas
    // messages, and the name is what keeps this off `wiki-retrieve.ts`'s
    // same-directory `AssembleHistoryMessage`, which is the narrower shape on
    // the far side of this conversion.
    const source: ChatHistorySource[] = [
      {
        id: "u1",
        role: "user",
        content: "What is alpha?",
        citations: [],
      },
      {
        id: "a1",
        role: "assistant",
        content: "Alpha [1].",
        citations: [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }],
      },
    ];
    expect(chatHistorySlice(source)).toEqual([
      { id: "u1", role: "user", content: "What is alpha?", citations: [], createdAt: "" },
      {
        id: "a1",
        role: "assistant",
        content: "Alpha [1].",
        citations: [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }],
        createdAt: "",
      },
    ]);
  });

  it("sends an empty citation list for a message that carries none", () => {
    expect(chatHistorySlice([{ id: "u1", role: "user", content: "q" }])).toEqual([
      { id: "u1", role: "user", content: "q", citations: [], createdAt: "" },
    ]);
  });

  it("is empty for an empty transcript", () => {
    expect(chatHistorySlice([])).toEqual([]);
  });
});
