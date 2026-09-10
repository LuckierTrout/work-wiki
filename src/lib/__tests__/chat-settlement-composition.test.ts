import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resumeAgentTurn } from "../../../sidecar/agent.mjs";
import { formatSse, sanitizeCitedAnswer as sidecarSanitize } from "../../../sidecar/chat-transport.mjs";
import { consumeSidecarStream, readSidecarSseBlock, SIDECAR_TURN_INCOMPLETE_COPY } from "../chat-session-transport";
import { settleTurn, type OpenTurn } from "../chat-pending-turn";
import { createChatConversation, persistChatTurn, getChatConversation } from "../chat";
import { _resetStorage } from "../storage";
import { _resetLocks } from "../lock";
import { CHAT_COVERAGE_MISSING_COPY } from "../workbench-modes";

const citations = [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }];
const sink = () => ({ onDelta: vi.fn(), onThinking: vi.fn(), onToolRow: vi.fn() });
function stream(text: string, width = 3) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width));
    controller.close();
  } });
}
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-settlement-"));
  vi.stubEnv("DATA_DIR", directory); _resetStorage(); _resetLocks();
});
afterEach(async () => {
  vi.unstubAllEnvs(); _resetStorage(); _resetLocks();
  await fs.rm(directory, { recursive: true, force: true });
});
function turn(id: string): OpenTurn {
  return { conversationId: id, userText: "Please help", replaceLastTurn: false, request: {}, fallbackCitations: citations, coverageMessage: null };
}

describe("complete sidecar → browser settlement → durable conversation", () => {
  it.each(["shell_approval", "skill_form"])("preserves a real %s refusal after persistence and reload", async (kind) => {
    const generate = vi.fn(() => { throw new Error("Refusal must not generate or execute"); });
    const kernel = vi.fn(() => { throw new Error("Refusal must not call the kernel"); });
    const result = await resumeAgentTurn({
      pending: { kind, rowId: "row-1", rowSeed: 1, transcript: [], toolCalls: [], outputs: [] },
      approved: false, generate, system: "Synthetic refusal fixture", context: { kernel },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(kernel).not.toHaveBeenCalled();
    const sanitized = sidecarSanitize(result.content, citations, CHAT_COVERAGE_MISSING_COPY, { allowUncited: result.toolCalls.length > 0 });
    const frame = await consumeSidecarStream(stream(formatSse("done", { ...result, ...sanitized })), sink());
    const conversation = await createChatConversation("alice");
    const outcome = settleTurn(turn(conversation.id), frame);
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") throw new Error("Unexpected pending turn");
    expect(outcome.frames[1].content).toBe(result.content);
    expect(outcome.frames[1].citations).toEqual(citations);
    await persistChatTurn("alice", conversation.id, outcome.frames);
    _resetStorage(); _resetLocks();
    const stored = await getChatConversation("alice", conversation.id);
    expect(stored?.messages.at(-1)).toMatchObject({ content: result.content, toolCalls: result.toolCalls });
    expect(stored?.messages.at(-1)?.content).not.toBe(CHAT_COVERAGE_MISSING_COPY);
  });

  it.each(['{"content":"Roll', '{"content":', '', 'null', '[]', '{"content":"valid"} garbage'])("rejects an unusable terminal payload: %s", async (payload) => {
    const block = `event: done\ndata: ${payload}`;
    expect(readSidecarSseBlock(block)).toBeNull();
    const handlers = sink();
    await expect(consumeSidecarStream(stream(formatSse("agent", { delta: "Rolling α" }) + block), handlers)).rejects.toThrow(SIDECAR_TURN_INCOMPLETE_COPY);
    expect(handlers.onDelta).toHaveBeenCalledWith("Rolling α");
  });

  it("keeps a complete final block without a delimiter and filters invented citations", async () => {
    const frame = await consumeSidecarStream(stream('event: done\ndata: {"content":"Supported [1], invented [9]."}'), sink());
    const outcome = settleTurn(turn("c"), frame);
    if (outcome.kind !== "settled") throw new Error("Unexpected pending turn");
    expect(outcome.frames[1].content).toBe("Supported [1], invented .");
    expect(outcome.frames[1].citations).toEqual(citations);
  });

  it("retains coverage enforcement for ordinary answers even with assembled citations", () => {
    const outcome = settleTurn(turn("c"), { content: "An unsupported factual answer", citations, toolCalls: [], outputs: [] });
    if (outcome.kind !== "settled") throw new Error("Unexpected pending turn");
    expect(outcome.frames[1]).toMatchObject({ content: CHAT_COVERAGE_MISSING_COPY, citations: [] });
  });

  it("still strips invented markers from a tool outcome", () => {
    const outcome = settleTurn(turn("c"), { content: "Denied. [99]", toolCalls: [{ id: "r", tool: "shell", detail: "denied" }] });
    if (outcome.kind !== "settled") throw new Error("Unexpected pending turn");
    expect(outcome.frames[1].content).toBe("Denied.");
  });
});
