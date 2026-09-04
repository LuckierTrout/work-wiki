import { describe, expect, it } from "vitest";
import {
  CHAT_API_DISABLED_COPY,
  CHAT_API_UNAUTHORIZED_COPY,
  type ChatPendingForm,
  type ChatPendingShell,
} from "../chat-agent";
import { CHAT_COVERAGE_MISSING_COPY } from "../workbench-modes";
import {
  SIDECAR_TURN_INCOMPLETE_COPY,
  type SidecarDoneFrame,
} from "../chat-session-transport";
import {
  chatTurnRequest,
  resumeRequest,
  settleTurn,
  turnFailureCopy,
  type ChatTurnAssemble,
  type OpenTurn,
} from "../chat-pending-turn";

const ASSEMBLED: ChatTurnAssemble = {
  systemPrompt: "system",
  numberedBodies: "[1] alpha",
  indexSlice: "index",
  historySlice: [{ role: "user", content: "earlier" }],
  citations: [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }],
  chatModel: { model: "gpt-4o-mini" },
};

function openTurn(overrides: Partial<OpenTurn> = {}): OpenTurn {
  return {
    conversationId: "c1",
    userText: "why",
    replaceLastTurn: false,
    request: chatTurnRequest({
      query: "why",
      conversationId: "c1",
      assembled: ASSEMBLED,
      skill: null,
    }),
    fallbackCitations: ASSEMBLED.citations,
    coverageMessage: null,
    ...overrides,
  };
}

const FORM_PENDING: ChatPendingForm = {
  kind: "skill_form",
  title: "Which quarter?",
  rowId: "r1",
  capabilityId: "cap-1",
  fields: [
    { name: "quarter", label: "Quarter", kind: "single", options: ["Q1", "Q2"] },
    { name: "regions", label: "Regions", kind: "multiple", options: ["EU"] },
    { name: "note", label: "Note", kind: "text" },
  ],
};

const SHELL_PENDING: ChatPendingShell = {
  kind: "shell_approval",
  reason: "new_executable",
  command: "rg",
  args: ["acme"],
  cwd: "agent-workspace",
  rowId: "r2",
  capabilityId: "cap-2",
};

describe("the Agent turn's request", () => {
  it("always carries tools and coverage, whatever the assemble reported", () => {
    // The assemble said "no coverage"; with tools on that is the reason to
    // look, not the answer, so the request is identical either way.
    const request = chatTurnRequest({
      query: "why",
      conversationId: "c1",
      assembled: ASSEMBLED,
      skill: "recap",
    });
    expect(request.tools).toBe(true);
    expect(request.coverage).toBe(true);
    expect(request.stream).toBe(true);
    expect(request.query).toBe("why");
    expect(request.conversationId).toBe("c1");
    expect(request.skill).toBe("recap");
    expect(request.system).toBe("system");
    expect(request.context).toBe("[1] alpha");
    expect(request.indexSlice).toBe("index");
    expect(request.messages).toEqual(ASSEMBLED.historySlice);
    expect(request.citations).toEqual(ASSEMBLED.citations);
    // The key is NEVER on the wire from the browser — only the model name.
    expect(request.model).toEqual({ model: "gpt-4o-mini" });
  });

  it("sends a null Skill rather than omitting the field", () => {
    const request = chatTurnRequest({
      query: "why",
      conversationId: "c1",
      assembled: ASSEMBLED,
    });
    expect("skill" in request).toBe(true);
    expect(request.skill).toBeNull();
  });
});

describe("a done frame that holds the turn open", () => {
  it("returns the form and the blanks it opens with, and persists nothing", () => {
    const outcome = settleTurn(openTurn(), { pending: FORM_PENDING });
    expect(outcome).toEqual({
      kind: "pending",
      pending: FORM_PENDING,
      formValues: { quarter: "", regions: [], note: "" },
    });
  });

  it("returns a shell pause with no form values", () => {
    const outcome = settleTurn(openTurn(), { pending: SHELL_PENDING });
    expect(outcome).toEqual({ kind: "pending", pending: SHELL_PENDING });
    expect("formValues" in outcome).toBe(false);
  });

  it("settles normally when the pending shape is not one the surface understands", () => {
    const outcome = settleTurn(openTurn(), {
      content: "Answer [1].",
      pending: { kind: "mystery" },
    });
    expect(outcome.kind).toBe("settled");
  });
});

describe("a done frame that writes the turn down", () => {
  it("writes the user leg and the sanitized assistant leg", () => {
    const frame: SidecarDoneFrame = {
      content: "Alpha says so [1]. Also [7].",
      thinking: "looked twice",
      toolCalls: [{ id: "t1", tool: "wiki_search", detail: "3 matches" }],
      outputs: [{ path: "recaps/a.md", name: "a.md", bytes: 4 }],
    };
    const outcome = settleTurn(openTurn({ replaceLastTurn: true }), frame);
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.replaceLastTurn).toBe(true);
    expect(outcome.frames[0]).toEqual({ id: "u", role: "user", content: "why" });
    const assistant = outcome.frames[1];
    // The invented `[7]` is stripped; the assemble's citations stand in for a
    // frame that carried none of its own.
    expect(assistant.content).toBe("Alpha says so [1]. Also .");
    expect(assistant.citations).toEqual(ASSEMBLED.citations);
    expect(assistant.thinking).toBe("looked twice");
    expect(assistant.toolCalls).toEqual(frame.toolCalls);
    expect(assistant.outputs).toEqual(frame.outputs);
  });

  it("prefers the frame's own citations over the assemble's", () => {
    const cited = { n: 1, path: "raw/sources/x.pdf", title: "X", type: "source" };
    const outcome = settleTurn(openTurn(), {
      content: "From the PDF [1].",
      citations: [cited],
    });
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].citations).toEqual([cited]);
  });

  it("falls back to the assemble when the frame's citations are an EMPTY array", () => {
    // A HAND-BUILT FRAME, not one observed on the wire (DW-585). The sidecar
    // re-sanitizes before it emits and falls back to these same assemble rows
    // while doing so (`chat-transport.mjs:375`), so it does not currently pair
    // `citations: []` with a surviving marker — every real frame settles the
    // same way under `??` and under the length test today. What this pins is
    // the FIELD'S CONTRACT: an empty array says "none of my own" exactly as an
    // absent key does, so `fallbackCitations` — populated on every turn by
    // `ChatCanvas.tsx:488` — is reachable rather than dead. A row of its own
    // because that difference is invisible to every other assertion here.
    const outcome = settleTurn(openTurn(), {
      content: "Alpha says so [1].",
      citations: [],
    });
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].content).toBe("Alpha says so [1].");
    expect(outcome.frames[1].citations).toEqual(ASSEMBLED.citations);
  });

  it("has nothing to rescue when the assemble carried no citations either", () => {
    // THE OTHER HALF OF THE BRANCH: the length test picks a fallback, it does
    // not invent evidence. With both sides empty the marker is still invented,
    // so the answer is still reduced to the coverage sentence — which is what
    // stops the rescue from becoming an unconditional override.
    const outcome = settleTurn(openTurn({ fallbackCitations: [] }), {
      content: "Certainly [9].",
      citations: [],
    });
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].content).toBe(CHAT_COVERAGE_MISSING_COPY);
    expect(outcome.frames[1].citations).toEqual([]);
  });

  it("settles an empty answer to the coverage sentence, with nothing cited", () => {
    const outcome = settleTurn(openTurn(), { content: "", toolCalls: [] });
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].content).toBe(CHAT_COVERAGE_MISSING_COPY);
    expect(outcome.frames[1].citations).toEqual([]);
  });

  it("says the same thing when the assemble carried a coverage sentence", () => {
    // `/retrieve` only ever sends `null` or exactly `CHAT_COVERAGE_MISSING_COPY`
    // (`wiki-retrieve.ts:583,666`), and `sanitizeCitedAnswer` has already
    // substituted that copy by the time the `turn.coverageMessage` term could
    // be reached — so the branch is a preserved shape, not a live one, and both
    // assembles settle to the same sentence.
    const outcome = settleTurn(
      openTurn({ coverageMessage: CHAT_COVERAGE_MISSING_COPY }),
      { content: "" },
    );
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].content).toBe(CHAT_COVERAGE_MISSING_COPY);
  });

  it("settles an answer whose every marker was invented to the coverage sentence", () => {
    const outcome = settleTurn(openTurn(), { content: "Certainly [9]." });
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].content).toBe(CHAT_COVERAGE_MISSING_COPY);
    expect(outcome.frames[1].citations).toEqual([]);
  });

  it("normalizes missing tool calls and outputs to empty arrays", () => {
    const outcome = settleTurn(openTurn(), { content: "Alpha [1]." });
    if (outcome.kind !== "settled") throw new Error("expected a settled turn");
    expect(outcome.frames[1].toolCalls).toEqual([]);
    expect(outcome.frames[1].outputs).toEqual([]);
  });
});

describe("answering a pause", () => {
  it("denies a shell pause with the original request plus resume, and no answers", () => {
    const turn = openTurn();
    const body = resumeRequest(turn, SHELL_PENDING, false, { ignored: "x" });
    expect(body.resume).toEqual({ capabilityId: "cap-2", approved: false });
    // The rest of the body is the turn's ORIGINAL request, byte for byte: a
    // resume rebuilt from a later render would re-ask the previous question.
    const { resume, ...rest } = body;
    expect(rest).toEqual(turn.request);
    expect(resume).toBeDefined();
  });

  it("submits a form with the collected answers alongside the approval", () => {
    const values = { quarter: "Q2", regions: ["EU"], note: "" };
    const body = resumeRequest(openTurn(), FORM_PENDING, true, values);
    expect(body.resume).toEqual({
      capabilityId: "cap-1",
      approved: true,
      answers: values,
    });
  });

  it("cancels a form the same way it submits one — back to the sidecar", () => {
    const body = resumeRequest(openTurn(), FORM_PENDING, false, {});
    expect(body.resume).toEqual({
      capabilityId: "cap-1",
      approved: false,
      answers: {},
    });
  });
});

describe("what the owner is told when a turn fails", () => {
  it("turns the door's one-word refusals into the Settings sentence", () => {
    expect(turnFailureCopy(new Error("disabled"))).toBe(CHAT_API_DISABLED_COPY);
    expect(turnFailureCopy(new Error("unauthorized"))).toBe(CHAT_API_UNAUTHORIZED_COPY);
  });

  it("passes every other message through verbatim", () => {
    expect(turnFailureCopy(new Error("provider down"))).toBe("provider down");
    // Read from the transport rather than retyped, so a reworded transport
    // sentence fails here instead of leaving a green test pinning a dead string.
    expect(turnFailureCopy(new Error(SIDECAR_TURN_INCOMPLETE_COPY))).toBe(
      SIDECAR_TURN_INCOMPLETE_COPY,
    );
  });

  it("has a sentence for a thrown non-Error", () => {
    expect(turnFailureCopy("boom")).toBe("Chat failed.");
  });
});
