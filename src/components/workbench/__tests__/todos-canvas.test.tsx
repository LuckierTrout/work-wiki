import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TODOS_NON_MEETING_COPY, workbenchMode } from "@/lib/workbench-modes";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({
  send,
  writeFailure: (cause: unknown, action: string) => ({
    message: cause instanceof Error ? cause.message : `Couldn’t ${action}.`,
    unconfirmed: false,
  }),
}));

import { TODOS_READ_ONLY_COPY, TodosCanvas } from "@/components/workbench/TodosCanvas";
import {
  MarkMeetingControl,
  SOURCE_MEETING_READ_ONLY_COPY,
} from "@/components/workbench/MarkMeetingControl";
import type { TodoItem } from "@/lib/todo-types";

const CANDIDATE: TodoItem = {
  id: "c1",
  wikiId: "wiki-1",
  sourceId: "raw/sources/meet/abc.md",
  pageSlug: "standup",
  title: "Send recap",
  rationale: "Alice committed at close.",
  due: "2026-09-01",
  speaker: "Alice",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.startsWith("/api/todos")) {
      return { items: [CANDIDATE], pendingCount: 1 };
    }
    if (typeof url === "string" && url.startsWith("/api/sources/meeting")) {
      return { path: "raw/sources/notes/a.md", meeting: false };
    }
    return {};
  });
});

describe("Todos canvas contract", () => {
  it("shows Candidates | Open | Done and the empty Candidates sentence", async () => {
    send.mockImplementation(async () => ({ items: [], pendingCount: 0 }));
    render(
      <TodosCanvas wikiId="current" onDockPreview={vi.fn()} />,
    );
    expect(await screen.findByRole("tab", { name: "Candidates" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Done" })).toBeTruthy();
    expect(screen.getByText(workbenchMode("todos").emptyState!)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Open" }));
    expect(screen.getByRole("tab", { name: "Candidates" })).toBeTruthy();
    expect(screen.queryByText(workbenchMode("todos").emptyState!)).toBeNull();
  });

  it("Approve posts the candidate id and decision", async () => {
    render(
      <TodosCanvas wikiId="current" onDockPreview={vi.fn()} />,
    );
    await screen.findByText("Send recap");
    const card = screen.getByText("Send recap").closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/todos",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ids: ["c1"], decision: "approve" }),
        }),
      );
    });
  });

  it("toolbar Approve does nothing until a candidate is selected", async () => {
    render(
      <TodosCanvas wikiId="current" onDockPreview={vi.fn()} />,
    );
    await screen.findByText("Send recap");
    send.mockClear();
    const toolbar = screen.getByRole("tablist", { name: "Todo lists" }).parentElement!;
    const bulk = within(toolbar).getAllByRole("button", { name: "Approve" })[0]!;
    expect((bulk as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(bulk);
    expect(send).not.toHaveBeenCalled();
  });

  it("puts Approve (primary) and Reject (ghost) in the tab order", async () => {
    render(
      <TodosCanvas wikiId="current" onDockPreview={vi.fn()} />,
    );
    await screen.findByText("Send recap");
    const approve = screen.getAllByRole("button", { name: "Approve" });
    const reject = screen.getAllByRole("button", { name: "Reject" });
    expect(approve.length).toBeGreaterThan(0);
    expect(reject.length).toBeGreaterThan(0);
    expect(approve[1]!.className).toContain("wb-todos-btn--primary");
    expect(reject[1]!.className).toContain("wb-todos-btn--reject");
    const card = screen.getByText("Send recap").closest("li")!;
    const buttons = [...card.querySelectorAll("button")];
    expect(buttons.map((btn) => btn.textContent)).toEqual(
      expect.arrayContaining(["Approve", "Reject"]),
    );
    expect(buttons.findIndex((btn) => btn.textContent === "Approve")).toBeLessThan(
      buttons.findIndex((btn) => btn.textContent === "Reject"),
    );
  });

  it("docks Preview on the meeting Page when present", async () => {
    const onDock = vi.fn();
    render(
      <TodosCanvas wikiId="current" onDockPreview={onDock} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "wiki/standup.md" }));
    expect(onDock).toHaveBeenCalledWith({ kind: "page", slug: "standup" });
  });

  it("docks the Source transcript when no Page exists and shows source-missing", async () => {
    send.mockImplementation(async () => ({
      items: [{
        ...CANDIDATE,
        pageSlug: undefined,
        sourceMissing: true,
      }],
      pendingCount: 1,
    }));
    const onDock = vi.fn();
    render(
      <TodosCanvas wikiId="current" onDockPreview={onDock} />,
    );
    expect(await screen.findByText("Source missing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "raw/sources/meet/abc.md" }));
    expect(onDock).toHaveBeenCalledWith({
      kind: "file",
      path: "raw/sources/meet/abc.md",
    });
  });

  it("refuses write controls out loud when read-only, rather than disabling them", async () => {
    // DW-643. This case used to pin `disabled === true`, which is the defect:
    // a `disabled` button is out of the tab order and carries no accessible
    // description, so the standing refusal could be neither reached NOR
    // announced. The shipped shape keeps it focusable, marks it
    // `aria-disabled`, points it at the sentence its door answers, and refuses
    // in the HANDLER. The full matrix lives in
    // `canvas-read-only-refusal.test.tsx`; this row is the repin.
    render(
      <TodosCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />,
    );
    await screen.findByText("Send recap");
    for (const name of ["Approve", "Reject"]) {
      for (const button of screen.getAllByRole("button", { name })) {
        expect((button as HTMLButtonElement).disabled, name).toBe(false);
        expect(button.getAttribute("aria-disabled"), name).toBe("true");
        const noteId = button.getAttribute("aria-describedby");
        expect(noteId, name).toBeTruthy();
        expect(document.getElementById(noteId!)?.textContent).toBe(
          TODOS_READ_ONLY_COPY,
        );
      }
    }
    send.mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);
    expect(send).not.toHaveBeenCalled();
  });

  it("loads through send() and not response.json()", async () => {
    render(
      <TodosCanvas wikiId="current" onDockPreview={vi.fn()} />,
    );
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/todos?tab=candidates",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});

describe("Mark as meeting copy", () => {
  it("uses the shared non-meeting sentence", async () => {
    render(<MarkMeetingControl path="raw/sources/notes/a.md" />);
    expect(await screen.findByText(TODOS_NON_MEETING_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark as meeting" })).toBeTruthy();
  });

  it("refuses in the open on a read-only deployment (DW-733)", async () => {
    // The control folded `readOnly` into bare `disabled`, so the standing
    // refusal left the tab order with nothing to announce — in front of
    // `POST /api/sources/meeting`, which DOES answer a 403 sentence. Same shape
    // DW-531/DW-643 gave the Graph, Review and Todos canvases: focusable,
    // `aria-disabled`, pointing at the door's own sentence, refusing in the
    // handler.
    render(<MarkMeetingControl path="raw/sources/notes/a.md" readOnly />);

    const button = (await screen.findByRole("button", {
      name: "Mark as meeting",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const noteId = button.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent).toBe(
      SOURCE_MEETING_READ_ONLY_COPY,
    );

    // `aria-disabled` is an announcement, not a gate — the handler is what
    // refuses, so the click has to reach it and issue nothing.
    send.mockClear();
    fireEvent.click(button);
    expect(send).not.toHaveBeenCalled();
  });

  it("renders no note and behaves as before on a writable deployment", async () => {
    render(<MarkMeetingControl path="raw/sources/notes/a.md" />);

    const button = (await screen.findByRole("button", {
      name: "Mark as meeting",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(SOURCE_MEETING_READ_ONLY_COPY)).toBeNull();

    send.mockClear();
    fireEvent.click(button);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "/api/sources/meeting",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("keeps `disabled` for the TRANSIENT in-flight state", async () => {
    // The other half of `disabled={!readOnly && busy}`. The rows above pin what
    // `readOnly` must NOT do to the attribute; without this one, deleting
    // `busy` from that expression leaves them both green while the owner can
    // fire a second `POST` on top of the first. `busy` describes nothing and
    // lasts one request, so unlike the standing refusal it is right for
    // `disabled` — the same split `canvas-read-only-refusal.test.tsx` pins for
    // the Review cards.
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/api/sources/meeting")) {
        // The GET still answers; the POST never settles, so the control stays
        // in flight for the length of the assertion.
        if (init?.method === "POST") return new Promise(() => {});
        return { path: "raw/sources/notes/a.md", meeting: false };
      }
      return {};
    });

    render(<MarkMeetingControl path="raw/sources/notes/a.md" />);

    const button = (await screen.findByRole("button", {
      name: "Mark as meeting",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    // Still the transient state and not a refusal: nothing to announce, so
    // nothing is announced.
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(SOURCE_MEETING_READ_ONLY_COPY)).toBeNull();
  });

  it("renders no note when there is no button for it to describe", async () => {
    // The note is guarded on the same `meeting === false` as the button, and
    // this is what holds it there. A Source ALREADY marked as a meeting offers
    // no write control at all, so a standing sentence explaining why one is
    // refused would describe something the owner was never shown — and
    // `aria-describedby` on a read-only deployment would be the only thing
    // pointing at it.
    send.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/sources/meeting")) {
        return { path: "raw/sources/notes/a.md", meeting: true };
      }
      return {};
    });

    render(<MarkMeetingControl path="raw/sources/notes/a.md" readOnly />);

    await waitFor(() =>
      expect(screen.queryByText(TODOS_NON_MEETING_COPY)).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Mark as meeting" }),
    ).toBeNull();
    expect(screen.queryByText(SOURCE_MEETING_READ_ONLY_COPY)).toBeNull();
  });
});
