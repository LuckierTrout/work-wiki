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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
 *
 * `failBody(cause)` is the ABORT half (DW-586). `runSidecarTurn` hands the
 * signal to `loopbackFetch` and then reads `response.body`, so an abort is only
 * observable downstream if the BYTES stop — which is exactly what a real fetch
 * body does: the browser errors the stream with an `AbortError` rather than
 * leaving the reader parked forever. A stub that ignored the signal would let a
 * Stop press assert nothing at all about the hop.
 */
function gatedTurn(): {
  response: Response;
  releaseDone: () => void;
  failBody: (cause: unknown) => void;
} {
  const encoder = new TextEncoder();
  let releaseDone = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Once the body has been errored the controller refuses `enqueue`/`close`, and
  // `afterEach` releases the gate on EVERY test — including the two that killed
  // the stream on purpose. So the release is made inert rather than left to
  // throw out of a stream `start` nobody is awaiting.
  let failed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      streamController = controller;
      for (const chunk of LIVE_FRAMES) controller.enqueue(encoder.encode(chunk));
      await gate;
      if (failed) return;
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
    failBody: (cause) => {
      failed = true;
      streamController?.error(cause);
    },
  };
}

let releaseDone: () => void;

/**
 * The signal `ChatCanvas` handed the sidecar POST, captured at the door.
 *
 * `driveTurn` builds the `AbortController`, parks it in `abortRef` and forwards
 * `controller.signal` through `runSidecarTurn` → `loopbackFetch` → `fetch`. This
 * is the far end of that chain, and the only place a mounted test can observe
 * which signal the component actually committed to the turn.
 */
let chatSignal: AbortSignal | null = null;

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
  chatSignal = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/skills")) {
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      if (url.includes("/chat")) {
        chatSignal = init?.signal ?? null;
        // A real fetch does not merely record the signal, it OBEYS it: an abort
        // tears the response body down mid-read. Modelling that here is what
        // makes the abort observable as an `AbortError` out of `runSidecarTurn`
        // instead of a turn that quietly keeps streaming into a dead component.
        chatSignal?.addEventListener("abort", () => {
          gated.failBody(new DOMException("The operation was aborted.", "AbortError"));
        });
        return gated.response;
      }
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

/**
 * The turn ENDS when the owner says so, or when the surface goes away (DW-586).
 *
 * `abortRef.current?.abort()` has FOUR call sites in `ChatCanvas` — the unmount
 * cleanup, `stopTurn()`, `switchConversation` and `deleteConversation`. The two
 * covered here are the two this entry names: the ones an owner reaches by
 * pressing Stop or by leaving the surface. The other two abort the same ref on
 * the way into — or out of — a different conversation; they are outside this
 * entry's scope and remain uncovered mounted, so nothing below says anything
 * about them either way.
 *
 * Until now nothing mounted pressed Stop or unmounted mid-turn, so the abort hop
 * was unpinned on exactly the side that moved when the SSE reader was extracted
 * into `chat-session-transport.ts`. The transport's own suite checks only that
 * WHATEVER signal it is handed is forwarded to the fetch; which signal the
 * component committed to the turn, and whether either caller ever fires it, is
 * a question only a mounted surface can answer.
 *
 * Both cases read the signal captured at the fetch door — the far end of
 * `driveTurn` → `runSidecarTurn` → `loopbackFetch` — and both assert it was
 * UN-aborted while the turn was live. Without that, a stub handing back an
 * already-aborted signal would pass while proving nothing.
 */
describe("the owner can end a turn that is still in flight", () => {
  /**
   * The transcript, scoped away from the composer.
   *
   * The optimistic bubble and the textarea hold the SAME sentence — `onSend`
   * puts the draft back when a turn does not settle — so a document-wide text
   * query cannot tell "the bubble is gone" from "the draft is back". Both of
   * those are asserted below, separately, which is the only way either means
   * anything.
   */
  function log(): HTMLElement {
    return document.querySelector(".wb-chat-log") as HTMLElement;
  }

  /** What the composer is holding right now. */
  function composerValue(): string {
    return (screen.getByLabelText("Message") as HTMLTextAreaElement).value;
  }

  /** Start a turn and leave it mid-flight, behind the gate. */
  async function startLiveTurn() {
    const view = render(
      <ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />,
    );
    await screen.findByLabelText("Message");
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "How is revenue?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The `done` frame is still behind the gate, so the turn is genuinely open:
    // the deltas have landed and Stop is on screen.
    await screen.findByText("Rolling revenue is up.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    // The optimistic bubble is on screen — the positive control for the
    // withdrawal the Stop case asserts.
    expect(within(log()).getByText("How is revenue?")).toBeTruthy();
    const signal = chatSignal;
    expect(signal).not.toBeNull();
    // The signal is LIVE. A stub that handed back an already-aborted controller
    // would make every assertion below true for the wrong reason.
    expect(signal?.aborted).toBe(false);
    return { view, signal: signal as AbortSignal };
  }

  it("aborts the turn's own signal when Stop is pressed, with no error shown", async () => {
    const { signal } = await startLiveTurn();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    // The press reaches the controller `driveTurn` built for THIS turn —
    // synchronously, so this is `stopTurn()`'s doing and not a later teardown's.
    expect(signal.aborted).toBe(true);

    await waitFor(() => {
      // Streaming is over: the composer's Stop gives way to Send again.
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
    // The optimistic user bubble is withdrawn with the turn — `sendTurn`'s catch
    // calls `clearOptimistic()` before it looks at the cause, so a stopped turn
    // leaves no half-sent question behind.
    expect(within(log()).queryByText("How is revenue?")).toBeNull();
    // …and NOTHING is reported. A deliberate stop is not a failure: `sendTurn`
    // swallows `AbortError` and returns without `setError`, so the error
    // paragraph must never appear. Read from the DOM by class because the copy
    // renders as a plain `<p>`, not an alert — there is no role to query.
    expect(document.querySelector(".wb-chat-error")).toBeNull();
    // The persisted answer never arrives either: an aborted turn is not saved.
    expect(screen.queryByText("Settled answer.")).toBeNull();
    // …and the question is BACK IN THE COMPOSER. `onSend` clears the draft
    // optimistically and puts it back when `sendTurn` answers false, which a
    // stop does — so the sentence the owner typed is where they can edit or
    // re-send it rather than lost with the turn. This is the other half of the
    // pair {@link log} exists to separate: the bubble is gone AND the draft is
    // back, and a document-wide query could not have told those apart.
    expect(composerValue()).toBe("How is revenue?");
  });

  it("aborts the same signal when the surface unmounts mid-turn", async () => {
    const { view, signal } = await startLiveTurn();

    view.unmount();

    // The cleanup effect's `abortRef.current?.abort()` — the only thing left
    // that can end a turn whose component is gone. Without it the reader would
    // hold the sidecar's stream open with nowhere for its frames to land.
    expect(signal.aborted).toBe(true);
  });
});
