import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GRAPH_NARROW_COPY, workbenchMode } from "@/lib/workbench-modes";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({
  send,
  writeFailure: (cause: unknown, action: string) => ({
    message: cause instanceof Error ? cause.message : `Couldn’t ${action}.`,
    unconfirmed: false,
  }),
}));

import { DeepResearchConfirm } from "@/components/workbench/DeepResearchConfirm";
import { GraphCanvas } from "@/components/workbench/GraphCanvas";
import { LintCanvas } from "@/components/workbench/LintCanvas";
import { ReviewCanvas } from "@/components/workbench/ReviewCanvas";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/graph/workbench") return { nodes: [], edges: [], insights: [] };
    if (url === "/api/review-queue") return { items: [], pendingCount: 0 };
    if (url === "/api/lint/workbench") return { issues: [] };
    return {};
  });
});

describe("Graph canvas", () => {
  it("shows the empty sentence and the narrow copy", async () => {
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(await screen.findByText(workbenchMode("graph").emptyState!)).toBeTruthy();
    expect(screen.getByText(GRAPH_NARROW_COPY)).toBeTruthy();
  });
});

describe("Lint canvas", () => {
  it("idles with the health sentence and Semantic off", () => {
    render(<LintCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(screen.getByText(workbenchMode("lint").emptyState!)).toBeTruthy();
    const semantic = screen.getByRole("checkbox", { name: "Semantic" }) as HTMLInputElement;
    expect(semantic.checked).toBe(false);
  });
});

describe("Review canvas", () => {
  const item = {
    id: "r1",
    kind: "warning" as const,
    title: "Need a judgment",
    summary: "Sources disagree.",
    path: "wiki/topic.md",
    queries: ["What is the deadline?"],
    status: "pending" as const,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    pageSlug: "topic",
  };

  it("skips a pending item without a wiki write and never Accepts", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/review-queue" && (!init || init.method === "GET")) {
        return { items: [item], pendingCount: 1 };
      }
      if (typeof url === "string" && url.startsWith("/api/review-queue/r1")) {
        return { item: { ...item, status: "skipped" }, pendingCount: 0 };
      }
      if (url === "/api/review-queue") return { items: [], pendingCount: 0 };
      return {};
    });
    const onCount = vi.fn();
    render(
      <ReviewCanvas wikiId="current" onDockPreview={vi.fn()} onPendingCountChange={onCount} />,
    );
    await screen.findByText("Need a judgment");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/review-queue/r1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "skip" }),
        }),
      );
    });
    const bodies = send.mock.calls
      .map((call) => (typeof call[1]?.body === "string" ? call[1].body : ""))
      .join("\n");
    expect(bodies).not.toContain("/run");
    expect(bodies).not.toContain("accept");
  });
});

describe("Deep Research confirm", () => {
  it("Cancel starts nothing", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DeepResearchConfirm
        open
        initialTopic="Topic"
        initialQueries={["one"]}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("Confirm from Review creates a draft and never runs web search", async () => {
    const item = {
      id: "r1",
      kind: "lightbulb" as const,
      title: "Follow up",
      summary: "Stored queries.",
      path: "wiki/topic.md",
      queries: ["What else belongs here?"],
      status: "pending" as const,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      pageSlug: "topic",
    };
    send.mockImplementation(async (url: string) => {
      if (url === "/api/review-queue") return { items: [item], pendingCount: 1 };
      if (url === "/api/research") return { project: { id: "proj-1", status: "draft" } };
      return {};
    });
    const onOpen = vi.fn();
    render(
      <ReviewCanvas wikiId="current" onDockPreview={vi.fn()} onOpenResearch={onOpen} />,
    );
    await screen.findByText("Follow up");
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/research",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const urls = send.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/run"))).toBe(false);
    expect(onOpen).toHaveBeenCalledWith("proj-1");
  });
});
