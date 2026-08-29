/**
 * The live turn, while it is still live (DW-444).
 *
 * The extract moved the SSE reader into `chat-session-transport.ts` and left
 * ChatCanvas holding a three-function sink — `onDelta`, `onThinking`,
 * `onToolRow`. The node suites prove the transport CALLS that sink; nothing
 * proved the component's sink is wired to anything, and replacing all three
 * with no-ops left every other suite green. That is the gap this file closes,
 * and it can only be closed mounted: "the owner sees the answer arrive" is a
 * statement about the screen, not about a callback.
 *
 * A NEW FILE on purpose. `epic8-chat-ui.test.tsx` has to pass UNEDITED for the
 * extract's acceptance criterion to mean anything, so the new coverage cannot
 * live there.
 *
 * The `done` frame is held back behind a gate until the live assertions have
 * run, because a turn that has already settled renders from the persisted
 * message instead — and that would pass with a dead sink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toolRowLabel } from "@/lib/chat-agent";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { ChatCanvas } from "@/components/workbench/ChatCanvas";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";

const CONV = {
  id: "c1",
  title: "Live turn",
  name: "Live turn",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [],
};

const ASSEMBLED = {
  coverage: true,
  coverageMessage: "",
  systemPrompt: "system",
  numberedBodies: "[1] alpha",
  indexSlice: "",
  historySlice: [],
  citations: [],
  chatModel: { configured: true, model: "gpt-4o-mini" },
  vectorPhase: { status: "off" },
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The `agent` legs of one turn: two deltas, a thinking line, and a tool row. */
const LIVE_FRAMES = [
  frame("agent", { delta: "Rolling " }),
  frame("agent", { thinking: "checking the ledger" }),
  frame("agent", {
    toolRow: { id: "t1", tool: "wiki_search", state: "running", detail: "3 matches" },
  }),
  frame("agent", { delta: "revenue is up." }),
];

/**
 * An SSE body that stops after the `agent` frames and waits.
 *
 * `releaseDone()` sends the `done` frame and closes, which is what lets the
 * test assert on a turn that is genuinely mid-flight rather than on one whose
 * answer has already been persisted and re-rendered from the store.
 */
function gatedTurn(): { response: Response; releaseDone: () => void } {
  const encoder = new TextEncoder();
  let releaseDone = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of LIVE_FRAMES) controller.enqueue(encoder.encode(chunk));
      await gate;
      controller.enqueue(
        encoder.encode(frame("done", { content: "Rolling revenue is up.", citations: [] })),
      );
      controller.close();
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    releaseDone,
  };
}

let releaseDone: () => void;

beforeEach(() => {
  clearLoopbackDoorToken();
  send.mockImplementation(async (url: string) => {
    if (url === "/api/chat/conversations") return { conversations: [CONV] };
    if (url === "/api/v1/loopback-settings") return { token: "tok-door" };
    if (url.endsWith("/retrieve")) return ASSEMBLED;
    // The persist leg answers with a DIFFERENT sentence from the streamed one,
    // and the initial load answers with no messages at all. Both on purpose: if
    // the settled turn said what the stream said, an assertion that actually
    // matched the persisted message would look identical to one that matched
    // the live region, and this suite would pass with a dead sink.
    if (url.includes("/conversations/c1/messages")) {
      return {
        conversation: {
          ...CONV,
          messages: [
            { id: "u1", role: "user", content: "How is revenue?", citations: [] },
            { id: "a1", role: "assistant", content: "Settled answer.", citations: [] },
          ],
        },
      };
    }
    if (url.includes("/conversations/c1")) return { conversation: CONV };
    return {};
  });
  const gated = gatedTurn();
  releaseDone = gated.releaseDone;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/api/v1/skills")) {
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      if (url.includes("/chat")) return gated.response;
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  releaseDone();
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the live region shows the turn as it arrives", () => {
  it("accumulates deltas and shows thinking and tool rows before done", async () => {
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByLabelText("Message");
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "How is revenue?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // STILL STREAMING: the `done` frame is behind the gate, so everything
    // asserted here reached the screen through the sink and nothing else.
    // Both deltas, ACCUMULATED — `onDelta` appends, it does not replace.
    await screen.findByText("Rolling revenue is up.");
    expect(screen.getByText("checking the ledger")).toBeTruthy();
    expect(screen.getByText(toolRowLabel("wiki_search"))).toBeTruthy();
    expect(screen.getByText("3 matches")).toBeTruthy();
    // The pause is still open, which is what "live" means here.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    releaseDone();
    // And the turn does settle: the live region gives way to the persisted
    // message, which says something the stream never did.
    await screen.findByText("Settled answer.");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
  });
});
