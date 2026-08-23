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

import { TodosCanvas } from "@/components/workbench/TodosCanvas";
import { MarkMeetingControl } from "@/components/workbench/MarkMeetingControl";
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

  it("disables write controls when read-only", async () => {
    render(
      <TodosCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />,
    );
    await screen.findByText("Send recap");
    for (const name of ["Approve", "Reject"]) {
      for (const button of screen.getAllByRole("button", { name })) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
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
});
