/**
 * Epic 8, the parts only a mounted Chat can show.
 *
 * The node suites cover the rules (`epic8-chat-agent.test.ts` drives the
 * sidecar's loop, `workbench-epic8.test.ts` pins the door). What is left is the
 * surface: a tool row and an output chip on a settled turn, and the two pauses —
 * the Skill form and the shell approval — which are only real if the modal
 * appears AND the answer goes back to the sidecar. Deny that never reaches the
 * sidecar would leave a turn nothing ever finished, so the assertions are on the
 * resume body, not just on the closed modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  FORM_CANCEL_LABEL,
  FORM_SUBMIT_LABEL,
  SHELL_APPROVAL_TITLE,
  SHELL_APPROVE_LABEL,
  SHELL_DENY_LABEL,
  outputChipLabel,
  toolRowLabel,
} from "@/lib/chat-agent";
import { workspaceSelection } from "@/lib/workbench-tree";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { ChatCanvas } from "@/components/workbench/ChatCanvas";
import { WorkspacePreview } from "@/components/workbench/WorkspacePreview";
import { workspaceFileUrl } from "@/lib/chat-agent";

const SKILLS = [
  {
    id: "recap",
    name: "recap",
    description: "Write a meeting recap",
    scope: "project",
    enabled: true,
  },
  {
    id: "offsite",
    name: "offsite",
    description: "Plan an offsite",
    scope: "user",
    enabled: false,
  },
];

const CONV = {
  id: "c1",
  title: "Agent turn",
  name: "Agent turn",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [
    { id: "u1", role: "user" as const, content: "Recap the Acme call." },
    {
      id: "a1",
      role: "assistant" as const,
      content: "Written.",
      citations: [],
      toolCalls: [
        { id: "t1", tool: "wiki_search", state: "ok" as const, detail: "3 matches" },
        { id: "t2", tool: "workspace_write", state: "ok" as const, detail: "recaps/acme.md" },
      ],
      outputs: [{ path: "recaps/acme.md", name: "acme.md", bytes: 13 }],
    },
  ],
};

/** One SSE response, from the frames a turn actually emits. */
function sse(frames: Array<[string, unknown]>): Response {
  const text = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

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

/** The sidecar leg, so a test can script one turn and read the resume back. */
let sidecar: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/chat/conversations") return { conversations: [CONV] };
    if (url === "/api/v1/loopback-settings") return { token: "tok-door" };
    if (url.endsWith("/retrieve")) return ASSEMBLED;
    if (url.includes("/conversations/c1")) {
      return { conversation: CONV };
    }
    return {};
  });
  sidecar = vi.fn(async () => sse([["done", { content: "ok", citations: [] }]]));
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/skills")) {
      return new Response(JSON.stringify({ skills: SKILLS }), { status: 200 });
    }
    if (url.includes("/chat")) return sidecar(url, init);
    if (url.includes("/api/v1/workspace/file")) {
      return new Response(JSON.stringify({ content: "# Acme recap\n" }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Type a message and press Send, which is how every pause below is reached. */
async function ask(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("a settled agent turn shows its work", () => {
  it("renders tool rows and docks the Preview from an output chip", async () => {
    const onDock = vi.fn();
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={onDock} />);
    await screen.findByText("Written.");

    expect(screen.getByText(toolRowLabel("wiki_search"))).toBeTruthy();
    expect(screen.getByText("3 matches")).toBeTruthy();
    expect(screen.getByText(toolRowLabel("workspace_write"))).toBeTruthy();

    const chip = screen.getByRole("button", {
      name: outputChipLabel({ name: "acme.md", bytes: 13 }),
    });
    fireEvent.click(chip);
    // A `workspace` pick, not a `file` one: these bytes are on local disk and
    // the kernel has never seen them.
    expect(onDock).toHaveBeenCalledWith(workspaceSelection("recaps/acme.md"));
  });
});

describe("shell approval is per command", () => {
  const PENDING = {
    kind: "shell_approval" as const,
    rowId: "s1",
    command: "rg",
    args: ["acme", "."],
    cwd: "/tmp/agent-workspace",
    reason: "external_cwd",
  };

  it("shows the command and resumes denied on Deny", async () => {
    sidecar
      .mockImplementationOnce(async () => sse([["done", { pending: PENDING }]]))
      .mockImplementationOnce(async () =>
        sse([["done", { content: "I did not run it.", citations: [] }]]),
      );
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    await ask("Search my notes with rg.");

    const modal = await screen.findByRole("alertdialog", { name: SHELL_APPROVAL_TITLE });
    expect(modal.textContent).toContain("rg acme .");
    expect(modal.textContent).toContain("/tmp/agent-workspace");

    fireEvent.click(screen.getByRole("button", { name: SHELL_DENY_LABEL }));
    await waitFor(() => expect(sidecar).toHaveBeenCalledTimes(2));
    const resumed = JSON.parse(String(sidecar.mock.calls[1]?.[1]?.body));
    expect(resumed.resume).toEqual({ pending: PENDING, approved: false });
    // Denied, so the executable is NOT remembered for the next call.
    expect(resumed.approvedExecutables).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
  });

  it("remembers the executable for this conversation on Approve", async () => {
    sidecar
      .mockImplementationOnce(async () => sse([["done", { pending: PENDING }]]))
      .mockImplementationOnce(async () => sse([["done", { content: "Found it.", citations: [] }]]));
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    await ask("Search my notes with rg.");
    await screen.findByRole("alertdialog", { name: SHELL_APPROVAL_TITLE });

    fireEvent.click(screen.getByRole("button", { name: SHELL_APPROVE_LABEL }));
    await waitFor(() => expect(sidecar).toHaveBeenCalledTimes(2));
    const resumed = JSON.parse(String(sidecar.mock.calls[1]?.[1]?.body));
    expect(resumed.resume.approved).toBe(true);
    expect(resumed.approvedExecutables).toEqual(["rg"]);
  });

  it("sends the door token like any other client", async () => {
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    await ask("Anything.");
    await waitFor(() => expect(sidecar).toHaveBeenCalled());
    const headers = sidecar.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-door");
  });

  it("opens a workspace chip with the same Bearer", async () => {
    render(
      <WorkspacePreview
        id="preview"
        selection={workspaceSelection("recaps/acme.md")}
      />,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/v1/workspace/file"),
        ),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/v1/workspace/file"),
    );
    expect(String(call?.[0])).toBe(workspaceFileUrl("recaps/acme.md"));
    expect(
      (call?.[1]?.headers as Record<string, string> | undefined)?.authorization,
    ).toBe("Bearer tok-door");
  });
});

describe("a Skill form pauses the turn", () => {
  const FORM = {
    kind: "skill_form" as const,
    rowId: "f1",
    title: "Which meeting?",
    fields: [
      {
        name: "meeting",
        label: "Meeting",
        kind: "single" as const,
        options: ["Acme", "Globex"],
        required: true,
      },
    ],
  };

  it("submits the answers and resumes", async () => {
    sidecar
      .mockImplementationOnce(async () => sse([["done", { pending: FORM }]]))
      .mockImplementationOnce(async () => sse([["done", { content: "Acme recap.", citations: [] }]]));
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    await ask("Recap a meeting.");

    await screen.findByRole("dialog", { name: "Which meeting?" });
    // Nothing is submittable before an answer — an empty required field would
    // resume the turn with a blank the Agent would have to guess at.
    expect(
      (screen.getByRole("button", { name: FORM_SUBMIT_LABEL }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText("Acme"));
    fireEvent.click(screen.getByRole("button", { name: FORM_SUBMIT_LABEL }));

    await waitFor(() => expect(sidecar).toHaveBeenCalledTimes(2));
    const resumed = JSON.parse(String(sidecar.mock.calls[1]?.[1]?.body));
    expect(resumed.resume).toEqual({
      pending: FORM,
      approved: true,
      answers: { meeting: "Acme" },
    });
  });

  it("Esc cancels through the sidecar, and closes the Skill picker first", async () => {
    sidecar
      .mockImplementationOnce(async () => sse([["done", { pending: FORM }]]))
      .mockImplementationOnce(async () =>
        sse([["done", { content: "Cancelled.", citations: [] }]]),
      );
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    await ask("Recap a meeting.");
    await screen.findByRole("dialog", { name: "Which meeting?" });

    // The picker is the shallower overlay: with both open, Esc closes it and
    // leaves the form standing rather than cancelling underneath it.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    await screen.findByRole("dialog", { name: "Pick a Skill" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pick a Skill" })).toBeNull());
    expect(sidecar).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Which meeting?" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(sidecar).toHaveBeenCalledTimes(2));
    const resumed = JSON.parse(String(sidecar.mock.calls[1]?.[1]?.body));
    expect(resumed.resume.approved).toBe(false);
  });

  it("Cancel is a button too", async () => {
    sidecar
      .mockImplementationOnce(async () => sse([["done", { pending: FORM }]]))
      .mockImplementationOnce(async () =>
        sse([["done", { content: "Cancelled.", citations: [] }]]),
      );
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    await ask("Recap a meeting.");
    await screen.findByRole("dialog", { name: "Which meeting?" });
    fireEvent.click(screen.getByRole("button", { name: FORM_CANCEL_LABEL }));
    await waitFor(() => expect(sidecar).toHaveBeenCalledTimes(2));
  });
});

describe("the Skill picker offers only enabled packs", () => {
  it("lists the scanned Skills and hides the disabled one", async () => {
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    await screen.findByText("Written.");
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    const picker = await screen.findByRole("dialog", { name: "Pick a Skill" });
    expect(picker.textContent).toContain("recap");
    expect(picker.textContent).not.toContain("offsite");

    fireEvent.click(screen.getByRole("button", { name: /Write a meeting recap/ }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "/api/chat/conversations/c1",
        expect.objectContaining({ body: JSON.stringify({ selectedSkill: "recap" }) }),
      ),
    );
  });
});
