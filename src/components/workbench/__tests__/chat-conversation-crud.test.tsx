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

import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
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
      if (url.endsWith("/api/v1/health")) return Response.json({ status: "running", pairingReady: true, pairing: { protocol: 1, instance: "test-app", localIdentity: "test-local" } });
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
  it("coalesces hidden attachment nudges until return without replaying Intake", async () => {
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [ALPHA] };
      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
      return {};
    });
    const releases: Array<(body: unknown) => void> = [];
    submitIntakeFiles.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const tree = (visible: boolean) => <SurfaceVisibilityProvider visible={visible}><ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} /></SurfaceVisibilityProvider>;
    const view = render(tree(true));
    await screen.findByText("Alpha answer.");
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["notes"], "notes.md")], configurable: true });
    fireEvent.change(input);
    fireEvent.change(input);
    view.rerender(tree(false));
    await act(async () => {
      for (const release of releases) release([{ name: "notes.md", error: null, unconfirmed: false, disposition: "queued" }]);
    });
    expect(submitIntakeFiles).toHaveBeenCalledTimes(2);
    expect(requestDataVersionCheck).not.toHaveBeenCalled();
    expect(screen.queryByText(intakeStoredCopy(1))).toBeNull();
    view.rerender(tree(true));
    await act(async () => {});
    expect(screen.getByText(intakeStoredCopy(1))).toBeTruthy();
    expect(requestDataVersionCheck).toHaveBeenCalledTimes(1);
    view.rerender(tree(false));
    view.rerender(tree(true));
    await act(async () => {});
    expect(requestDataVersionCheck).toHaveBeenCalledTimes(1);
    expect(submitIntakeFiles).toHaveBeenCalledTimes(2);
  });

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


describe("returning Chat snapshots cannot undo explicit list mutations (DW-422)", () => {
  it.each(["list-first", "create-first"])("reconciles New Chat during first load (%s)", async (order) => {
    let releaseList!: (body: unknown) => void;
    let releaseCreate!: (body: unknown) => void;
    const firstList = new Promise((resolve) => { releaseList = resolve; });
    const creation = new Promise((resolve) => { releaseCreate = resolve; });
    let listReads = 0;
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/loopback-settings") return { token: "door" };
      if (url === "/api/chat/conversations" && init?.method === "POST") return creation;
      if (url === "/api/chat/conversations") {
        listReads += 1;
        return listReads === 1 ? firstList : { conversations: [GAMMA, ALPHA, BETA] };
      }
      return {};
    });
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
    await act(async () => {});
    if (order === "list-first") {
      await act(async () => releaseList({ conversations: [ALPHA, BETA] }));
      expect(listReads).toBe(1);
    }
    await act(async () => releaseCreate({ conversation: GAMMA }));
    const composer = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep the new draft" } });
    if (order === "create-first") await act(async () => releaseList({ conversations: [ALPHA, BETA] }));
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Gamma" })).toHaveLength(1);
    expect(screen.getByLabelText("Message")).toBe(composer);
    expect(composer.value).toBe("Keep the new draft");
    expect(screen.queryByText("Alpha answer.")).toBeNull();
    expect(listReads).toBe(2);
    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations/c1")).toHaveLength(0);
  });

  it.each(["create", "rename", "delete"])("preserves %s while a return refresh is pending", async (operation) => {
    baseSend((url) => {
      if (url === "/api/chat/conversations") return { conversations: [ALPHA, BETA] };
      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
      return {};
    });
    const tree = (visible: boolean) => <SurfaceVisibilityProvider visible={visible}><HookProbe /></SurfaceVisibilityProvider>;
    const view = render(tree(true));
    await act(async () => {});
    expect(hook!.conversations.map((row) => row.id)).toEqual(["c1", "c2"]);
    expect(hook!.activeId).toBe("c1");
    view.rerender(tree(false));
    let release!: (body: unknown) => void;
    const staleList = new Promise((resolve) => { release = resolve; });
    let refreshes = 0;
    const currentRows = operation === "create" ? [GAMMA, ALPHA, BETA]
      : operation === "rename" ? [{ ...ALPHA, name: "Renamed Alpha" }, BETA]
      : [ALPHA];
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/chat/conversations" && init?.method === "GET") {
        return ++refreshes === 1 ? staleList : { conversations: currentRows };
      }
      if (url === "/api/chat/conversations" && init?.method === "POST") return { conversation: GAMMA };
      if (url === "/api/chat/conversations/c1" && init?.method === "PATCH") return { conversation: { ...ALPHA, name: "Renamed Alpha" } };
      return {};
    });
    view.rerender(tree(true));
    await act(async () => {});
    expect(send.mock.calls.filter(([url, init]) => url === "/api/chat/conversations" && init?.method === "GET")).toHaveLength(2);
    await act(async () => {
      if (operation === "create") await hook!.startConversation();
      else if (operation === "rename") await hook!.renameActive("c1", "Renamed Alpha");
      else await hook!.removeConversation("c2");
    });
    const expected = hook!.conversations.map((row) => ({ id: row.id, name: row.name }));
    await act(async () => release({ conversations: [ALPHA, BETA] }));
    expect(refreshes).toBe(2);
    expect(hook!.conversations.map((row) => ({ id: row.id, name: row.name }))).toEqual(expected);
    if (operation === "create") {
      expect(hook!.activeId).toBe("c3");
      expect(hook!.conversations.map((row) => row.id)).toEqual(["c3", "c1", "c2"]);
    } else if (operation === "rename") {
      expect(hook!.conversations.find((row) => row.id === "c1")?.name).toBe("Renamed Alpha");
    } else expect(hook!.conversations.map((row) => row.id)).toEqual(["c1"]);
  });
});

describe("initial Chat list reconciliation after New Chat (DW-422)", () => {
  it.each(["ok", "error", "hidden"])("recovers an invalidated initial list (%s) without replacing the new conversation or draft", async (settlement) => {
    let release!: (body: unknown) => void;
    let reject!: (cause: Error) => void;
    const initialList = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    let reads = 0;
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/loopback-settings") return { token: "tok-door" };
      if (url === "/api/chat/conversations" && init?.method === "POST") return { conversation: GAMMA };
      if (url === "/api/chat/conversations") {
        return ++reads === 1 ? initialList : { conversations: [GAMMA, ALPHA, BETA] };
      }
      return {};
    });
    const tree = (visible: boolean) => <SurfaceVisibilityProvider visible={visible}><ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} /></SurfaceVisibilityProvider>;
    const view = render(tree(true));
    expect(reads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
    await screen.findByRole("button", { name: "Gamma" });
    const composer = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep this new draft" } });
    if (settlement === "hidden") view.rerender(tree(false));
    await act(async () => {
      if (settlement === "error") reject(new Error("Obsolete initial-list failure"));
      else release({ conversations: [ALPHA, BETA] });
    });
    if (settlement === "hidden") {
      expect(reads).toBe(1);
      view.rerender(tree(true));
    }
    await screen.findByRole("button", { name: "Alpha" });
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gamma" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("Message")).toBe(composer);
    expect(composer.value).toBe("Keep this new draft");
    expect(screen.queryByText("Obsolete initial-list failure")).toBeNull();
    expect(reads).toBe(2);
    expect(send.mock.calls.filter(([url, init]) => /^\/api\/chat\/conversations\//.test(url) && init?.method === "GET")).toHaveLength(0);
  });
});
