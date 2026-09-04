/**
 * The seams DW-587 opened, mounted (DW-587 review pass).
 *
 * The decomposition put the conversation state behind `useChatConversations`
 * and the doors behind `@/lib/chat-conversation-store`, so four things that
 * used to be one function are now a hand-off: the in-flight guards, the
 * `/skill` decision, the attach, and what New Chat writes on each side of the
 * hook boundary. The node suites prove each half in isolation; nothing proved
 * the halves are joined, and every one of these is a wrong answer the owner can
 * actually reach.
 *
 * A NEW FILE on purpose. `epic8-chat-ui.test.tsx`, `chat-search-contracts.test.tsx`
 * and `chat-live-stream.test.tsx` have to pass BYTE-IDENTICAL for DW-587's
 * acceptance criterion to mean anything, so the new coverage cannot live there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const { send, submitIntakeFiles, requestDataVersionCheck } = vi.hoisted(() => ({
  send: vi.fn(),
  submitIntakeFiles: vi.fn(),
  requestDataVersionCheck: vi.fn(),
}));
vi.mock("@/lib/workbench-request", () => ({ send }));
// Only the DOOR and the nudge are replaced. `intakeReport` stays real, because
// the sentence this suite asserts on screen has to be Intake's own — a copy of
// it here would drift from what the owner reads.
vi.mock("@/lib/workbench-intake-client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/workbench-intake-client")>(
      "@/lib/workbench-intake-client",
    );
  return { ...actual, submitIntakeFiles };
});
vi.mock("@/lib/workbench-data-version", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/workbench-data-version")>(
      "@/lib/workbench-data-version",
    );
  return { ...actual, requestDataVersionCheck };
});

import { ChatCanvas } from "@/components/workbench/ChatCanvas";
import {
  useChatConversations,
  type ChatConversations,
} from "@/components/workbench/useChatConversations";
import { SKILL_SCAN_URL, skillSelectedCopy } from "@/lib/chat-agent";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";
import { intakeStoredCopy } from "@/lib/workbench-intake";

const SKILLS = [
  {
    id: "recap",
    name: "recap",
    description: "Write a meeting recap",
    scope: "project",
    enabled: true,
  },
];

const ALPHA = {
  id: "c1",
  title: "Alpha",
  name: "Alpha",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [
    { id: "u1", role: "user" as const, content: "What is alpha?" },
    { id: "a1", role: "assistant" as const, content: "Alpha answer.", citations: [] },
  ],
};

const BETA = {
  id: "c2",
  title: "Beta",
  name: "Beta",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [
    { id: "u2", role: "user" as const, content: "What is beta?" },
    { id: "a2", role: "assistant" as const, content: "Beta answer.", citations: [] },
  ],
};

const GAMMA = {
  id: "c3",
  title: "Gamma",
  name: "Gamma",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [],
};

/** Every sidecar-bound call this surface makes, so none of them reaches a network. */
let fetchMock: ReturnType<typeof vi.fn>;
/** Just the sidecar chat leg, so "no turn ran" is assertable on its own. */
let sidecar: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearLoopbackDoorToken();
  sidecar = vi.fn(async () => new Response("{}", { status: 200 }));
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === SKILL_SCAN_URL) {
      return new Response(JSON.stringify({ skills: SKILLS }), { status: 200 });
    }
    if (url.includes("/chat")) return sidecar(url, init);
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A `send` that answers the list and the loopback door, and nothing else. */
function baseSend(handler: (url: string) => unknown) {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/v1/loopback-settings") return { token: "tok-door" };
    return handler(url);
  });
}

/** Whether the assemble door was opened at all. */
function retrieveCalls(): unknown[] {
  return send.mock.calls.filter(([url]) => String(url).endsWith("/retrieve"));
}

describe("the load guard keeps the conversation the owner switched to", () => {
  it("drops a superseded read rather than rendering its transcript", async () => {
    // The mount read of Alpha is GATED, so it lands after the Beta read the
    // owner's click issued. Without `loadSeq`, the slower answer wins and the
    // owner is left looking at a conversation they navigated away from.
    let releaseAlpha!: () => void;
    const alphaRead = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [ALPHA, BETA] };
      if (url === "/api/chat/conversations/c1") {
        return alphaRead.then(() => ({ conversation: ALPHA }));
      }
      if (url === "/api/chat/conversations/c2") return { conversation: BETA };
      return {};
    });

    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    // The list rendered, but Alpha's transcript is still in flight.
    await screen.findByRole("button", { name: "Beta" });
    expect(screen.queryByText("Alpha answer.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await screen.findByText("Beta answer.");

    await act(async () => {
      releaseAlpha();
      await alphaRead;
    });

    // The read the owner did NOT ask for is discarded, and the one they did
    // stays on screen.
    expect(screen.queryByText("Alpha answer.")).toBeNull();
    expect(screen.getByText("Beta answer.")).toBeTruthy();
  });
});

/**
 * The hook, driven directly — the only way to reach the persist guard.
 *
 * `persistSeq` cannot be exercised through `ChatCanvas`: `sendTurn` holds
 * `sendInFlight` true for the whole of `driveTurn`, and `driveTurn` awaits
 * `persistFrames` inside it, so the surface serializes turns and only ever has
 * one persist open at a time. The guard is nonetheless part of the hook's stated
 * contract ("LAST WRITER WINS on both legs"), and a hook contract can only be
 * asserted by mounting one — so this probe mounts the hook alone and issues the
 * two overlapping writes the surface cannot.
 */
let hook: ChatConversations | null = null;

function HookProbe() {
  // Captured during render on purpose: this is a probe, and the test needs the
  // callbacks the current render is holding.
  hook = useChatConversations({ readOnly: false, onError: () => {} });
  return (
    <div data-testid="messages">
      {hook.messages.map((message) => message.content).join("|")}
    </div>
  );
}

describe("the persist guard keeps the newer turn", () => {
  it("drops a superseded persist rather than overwriting the later one", async () => {
    const gates: Array<(body: unknown) => void> = [];
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [] };
      if (url.includes("/messages")) {
        return new Promise((resolve) => gates.push(resolve));
      }
      return {};
    });

    hook = null;
    render(<HookProbe />);
    await waitFor(() => expect(hook).not.toBeNull());

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = hook!.persistFrames("c1", [
        { id: "u", role: "user", content: "older" },
      ]);
      second = hook!.persistFrames("c1", [
        { id: "u", role: "user", content: "newer" },
      ]);
      await waitFor(() => expect(gates).toHaveLength(2));
    });

    // The NEWER write lands first…
    await act(async () => {
      gates[1]({
        conversation: {
          id: "c1",
          title: "One",
          messages: [{ id: "a2", role: "assistant", content: "Newer answer." }],
        },
      });
      await second;
    });
    expect(screen.getByTestId("messages").textContent).toBe("Newer answer.");

    // …and the older one, answering afterwards, is discarded rather than
    // putting the superseded turn back on screen.
    await act(async () => {
      gates[0]({
        conversation: {
          id: "c1",
          title: "One",
          messages: [{ id: "a1", role: "assistant", content: "Older answer." }],
        },
      });
      await first;
    });
    expect(screen.getByTestId("messages").textContent).toBe("Newer answer.");
  });
});

describe("/skill is a command, not a question", () => {
  it("selects the Skill and sends nothing to the assemble or the sidecar", async () => {
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [ALPHA] };
      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
      return {};
    });

    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Alpha answer.");
    // The scan has to have landed, or `/skill recap` would match nothing and
    // this would pass for the wrong reason.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === SKILL_SCAN_URL)).toBe(
        true,
      ),
    );

    send.mockClear();
    sidecar.mockClear();
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "/skill recap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The Skill is selected and persisted on the conversation. BOTH surfaces
    // say so: the standing banner that names what the next turns run under, and
    // the one-off note acknowledging the command.
    await waitFor(() =>
      expect(document.querySelector(".wb-chat-skill")?.textContent).toContain(
        skillSelectedCopy("recap"),
      ),
    );
    expect(document.querySelector(".wb-chat-skill-note")?.textContent).toBe(
      skillSelectedCopy("recap"),
    );
    expect(screen.queryByRole("dialog", { name: "Pick a Skill" })).toBeNull();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "/api/chat/conversations/c1",
        expect.objectContaining({ body: JSON.stringify({ selectedSkill: "recap" }) }),
      ),
    );
    // …the composer is cleared, because the command was consumed…
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    // …and NOTHING was asked. A `/skill …` line that reached `/retrieve` would
    // go on to the provider as an ordinary question.
    expect(retrieveCalls()).toEqual([]);
    expect(sidecar).not.toHaveBeenCalled();
    expect(screen.queryByText("/skill recap")).toBeNull();
  });
});

describe("Attach reports what Intake did", () => {
  it("shows the report and asks the trees to re-poll", async () => {
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [ALPHA] };
      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
      return {};
    });
    submitIntakeFiles.mockResolvedValue([
      { name: "notes.md", error: null, unconfirmed: false, disposition: "queued" },
    ]);

    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Alpha answer.");

    const input = document.querySelector(
      "input[type='file']",
    ) as HTMLInputElement;
    const file = new File(["# notes\n"], "notes.md", { type: "text/markdown" });
    // `files` has no setter in jsdom, and `attachFiles` reads the list off the
    // event target exactly as a real pick would.
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    // The bytes went through Intake — the one arrival path (FR-2).
    await waitFor(() => expect(submitIntakeFiles).toHaveBeenCalledTimes(1));
    expect(
      (submitIntakeFiles.mock.calls[0]?.[0] as File[]).map((item) => item.name),
    ).toEqual(["notes.md"]);
    // Both surface effects: the sentence the owner reads…
    expect(await screen.findByText(intakeStoredCopy(1))).toBeTruthy();
    // …and the nudge that sends the trees to look for what just landed.
    await waitFor(() => expect(requestDataVersionCheck).toHaveBeenCalledTimes(1));
  });
});

describe("New Chat writes on both sides of the hook boundary", () => {
  it("opens the new row, empties the transcript, and clears the draft", async () => {
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [ALPHA] };
      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
      return {};
    });

    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Alpha answer.");
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "half-typed question" },
    });

    // The create door answers with the new row; everything else is unchanged.
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/loopback-settings") return { token: "tok-door" };
      if (url === "/api/chat/conversations" && init?.method === "POST") {
        return { conversation: GAMMA };
      }
      if (url === "/api/chat/conversations") return { conversations: [ALPHA] };
      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
      return {};
    });
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));

    // The hook's half: the row is in the list and it is the open one.
    const row = await screen.findByRole("button", { name: "Gamma" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
    expect(
      screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-current"),
    ).toBeNull();
    // The component's half: the previous transcript is gone and the composer is
    // empty — a new conversation that opened holding the last one's answer, or
    // the last one's draft, is the seam failing.
    expect(screen.queryByText("Alpha answer.")).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });
});
