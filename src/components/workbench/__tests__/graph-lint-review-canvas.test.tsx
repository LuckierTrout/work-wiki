import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GRAPH_NARROW_COPY, workbenchMode } from "@/lib/workbench-modes";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
const sigmaState = vi.hoisted(() => ({
  animate: vi.fn(),
  animatedZoom: vi.fn(),
  animatedUnzoom: vi.fn(),
  refresh: vi.fn(),
  instances: 0,
  handlers: {} as Record<string, (payload?: { node: string }) => void>,
  settings: {} as Record<
    string,
    (id: string, data: Record<string, unknown>) => Record<string, unknown>
  >,
  graph: null as null | {
    edges: () => string[];
  },
  missingDisplayNodes: new Set<string>(),
}));
vi.mock("@/lib/workbench-request", () => ({
  send,
  writeFailure: (cause: unknown, action: string) => ({
    message: cause instanceof Error ? cause.message : `Couldn’t ${action}.`,
    unconfirmed: false,
  }),
}));
vi.mock("sigma", () => ({
  default: class MockSigma {
    constructor(graph: { edges: () => string[] }) {
      sigmaState.instances += 1;
      sigmaState.graph = graph;
    }
    kill() {}
    refresh() { sigmaState.refresh(); }
    on(event: string, handler: (payload?: { node: string }) => void) {
      sigmaState.handlers[event] = handler;
    }
    setSetting(
      setting: string,
      reducer: (id: string, data: Record<string, unknown>) => Record<string, unknown>,
    ) {
      sigmaState.settings[setting] = reducer;
    }
    getNodeDisplayData(node: string) {
      if (sigmaState.missingDisplayNodes.has(node)) return undefined;
      return node === "a" ? { x: 0, y: 0 } : { x: 1, y: 0.5 };
    }
    getDimensions() {
      return { width: 800, height: 400 };
    }
    getBBox() {
      return { x: [0, 1] as [number, number], y: [0, 0.5] as [number, number] };
    }
    getCustomBBox() {
      return null;
    }
    getCamera() {
      return {
        getState: () => ({ x: 0.5, y: 0.5, ratio: 1 }),
        setState: vi.fn(),
        animatedZoom: sigmaState.animatedZoom,
        animatedUnzoom: sigmaState.animatedUnzoom,
        animate: sigmaState.animate,
        on: vi.fn(),
      };
    }
  },
}));

import { DeepResearchConfirm } from "@/components/workbench/DeepResearchConfirm";
import { GraphCanvas } from "@/components/workbench/GraphCanvas";
import { LintCanvas } from "@/components/workbench/LintCanvas";
import { ResearchCanvas } from "@/components/workbench/ResearchCanvas";
import { ReviewCanvas } from "@/components/workbench/ReviewCanvas";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sigmaState.instances = 0;
  sigmaState.handlers = {};
  sigmaState.settings = {};
  sigmaState.graph = null;
  sigmaState.missingDisplayNodes.clear();
});

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/graph/workbench") return { nodes: [], edges: [], insights: [] };
    if (url === "/api/review-queue") return { items: [], pendingCount: 0 };
    if (url === "/api/lint/workbench") return { issues: [] };
    return {};
  });
});

const isolatedInsight = {
  id: "isolated:alone",
  kind: "isolated" as const,
  title: "Alone is isolated",
  summary: "Degree 0",
  slugs: ["alone"],
  edges: [],
  offersDeepResearch: true,
  fingerprint: "isolated:alone:0::0",
  topic: "Alone",
  queries: ["What belongs with Alone?"],
};

describe("Graph canvas", () => {
  it("shows the empty sentence and the narrow copy", async () => {
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(await screen.findByText(workbenchMode("graph").emptyState!)).toBeTruthy();
    expect(screen.getByText(GRAPH_NARROW_COPY)).toBeTruthy();
  });

  it("renders chrome, Fit, and Insight highlight for a non-empty graph", async () => {
    send.mockResolvedValue({
      nodes: [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }],
      edges: [],
      insights: [isolatedInsight],
      communities: [],
      types: [{ id: "page", label: "page", count: 1 }],
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Fit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Alone is isolated/ }));
    expect(screen.getByRole("button", { name: /Alone is isolated/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    expect(screen.getByRole("dialog", { name: "Deep Research" })).toBeTruthy();
  });

  it("passes a full-graph ratio of 1 from renderer coordinates to the camera", async () => {
    send.mockResolvedValue({
      nodes: [
        { id: "a", label: "A", tenant: "yopedia", linkCount: 0, tags: [] },
        { id: "b", label: "B", tenant: "yopedia", linkCount: 0, tags: [] },
      ],
      edges: [],
      insights: [],
      communities: [],
      types: [],
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    await waitFor(() => expect(sigmaState.instances).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(sigmaState.animate).toHaveBeenCalledWith(
      { x: 0.5, y: 0.25, ratio: 1 },
      { duration: 200 },
    );
  });

  it("wires Zoom in and Zoom out to Sigma camera animations", async () => {
    send.mockResolvedValue({
      nodes: [{ id: "a", label: "A", tenant: "yopedia", linkCount: 0, tags: [] }],
      edges: [],
      insights: [],
      communities: [],
      types: [],
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    await waitFor(() => expect(sigmaState.instances).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(sigmaState.animatedZoom).toHaveBeenCalledWith({ duration: 200 });
    expect(sigmaState.animatedUnzoom).toHaveBeenCalledWith({ duration: 200 });
  });

  it("fits the remaining display records when one node is temporarily missing", async () => {
    sigmaState.missingDisplayNodes.add("b");
    send.mockResolvedValue({
      nodes: [
        { id: "a", label: "A", tenant: "yopedia", linkCount: 0, tags: [] },
        { id: "b", label: "B", tenant: "yopedia", linkCount: 0, tags: [] },
      ],
      edges: [],
      insights: [],
      communities: [],
      types: [],
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    await waitFor(() => expect(sigmaState.instances).toBeGreaterThan(0));
    const before = sigmaState.animate.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(sigmaState.animate.mock.calls.length).toBe(before + 1);
  });

  it("refreshes and applies hover node/edge reducers on enter and leave", async () => {
    send.mockResolvedValue({
      nodes: ["a", "b", "c"].map((id) => ({
        id, label: id.toUpperCase(), tenant: "yopedia", linkCount: 0, tags: [],
      })),
      edges: [{ source: "a", target: "b", weight: 1, signals: [] }],
      insights: [], communities: [], types: [],
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    await waitFor(() => expect(sigmaState.handlers.enterNode).toBeTypeOf("function"));
    sigmaState.handlers.enterNode({ node: "a" });
    const dimmed = sigmaState.settings.nodeReducer("c", { color: "#111", label: "C" });
    const highlightedEdge = sigmaState.settings.edgeReducer(
      sigmaState.graph!.edges()[0]!,
      { color: "#111", label: "" },
    );
    expect(dimmed).toEqual(expect.objectContaining({ color: "#e5e7eb", label: "" }));
    expect(highlightedEdge).toEqual(expect.objectContaining({ forceLabel: true }));
    sigmaState.handlers.leaveNode();
    const restored = sigmaState.settings.nodeReducer("c", { color: "#111", label: "C" });
    expect(restored).toEqual({ color: "#111", label: "C" });
    expect(sigmaState.refresh).toHaveBeenCalledTimes(2);
  });

  it("uses selected Insight node and edge reducers to retain members and hide nonmembers", async () => {
    const insight = {
      ...isolatedInsight,
      id: "bridge:a",
      kind: "bridge" as const,
      title: "A bridges",
      slugs: ["a", "b"],
      edges: [{ source: "a", target: "b" }],
    };
    send.mockResolvedValue({
      nodes: ["a", "b", "c"].map((id) => ({
        id, label: id.toUpperCase(), tenant: "yopedia", linkCount: 0, tags: [],
      })),
      edges: [
        { source: "a", target: "b", weight: 1, signals: [] },
        { source: "b", target: "c", weight: 1, signals: [] },
      ],
      insights: [insight], communities: [], types: [],
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    await waitFor(() => expect(sigmaState.settings.edgeReducer).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: /A bridges/ }));
    const member = sigmaState.settings.nodeReducer("a", { color: "#111", label: "A" });
    const nonmember = sigmaState.settings.nodeReducer("c", { color: "#111", label: "C" });
    const reducedEdges = sigmaState.graph!.edges().map((edgeId) =>
      sigmaState.settings.edgeReducer(edgeId, { color: "#111", label: "" }));
    expect(member).toEqual({ color: "#111", label: "A" });
    expect(nonmember).toEqual(expect.objectContaining({ color: "#e5e7eb", label: "" }));
    expect(reducedEdges.some((edge) => edge.forceLabel === true)).toBe(true);
    expect(reducedEdges.some((edge) => edge.hidden === true)).toBe(true);
  });

  it("docks Preview when Sigma emits a node click", async () => {
    send.mockResolvedValue({
      nodes: [{ id: "a", label: "A", tenant: "yopedia", linkCount: 0, tags: [] }],
      edges: [],
      insights: [],
      communities: [],
      types: [],
    });
    const onDockPreview = vi.fn();
    render(<GraphCanvas wikiId="current" onDockPreview={onDockPreview} />);
    await waitFor(() => expect(sigmaState.handlers.clickNode).toBeTypeOf("function"));

    sigmaState.handlers.clickNode({ node: "a" });

    expect(onDockPreview).toHaveBeenCalledWith({ kind: "page", slug: "a" });
  });

  it("surfaces prefill cap and failure metadata beside Insights", async () => {
    send.mockResolvedValue({
      nodes: [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }],
      edges: [],
      insights: [isolatedInsight],
      communities: [],
      types: [],
      prefill: { limit: 12, attempted: 12, applied: 11, failed: 1, remaining: 2 },
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(
      (await screen.findByText(/Research context prepared for 11 insights/)).textContent,
    ).toContain("1 could not be prepared; 2 use default queries");
  });

  it("keeps the newer Graph payload when a stale response lands late", async () => {
    let finishFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    let calls = 0;
    send.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        await first;
        return { nodes: [], edges: [], insights: [] };
      }
      return {
        nodes: [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }],
        edges: [],
        insights: [isolatedInsight],
      };
    });
    const { rerender } = render(
      <GraphCanvas wikiId="current" dataVersion={1} onDockPreview={vi.fn()} />,
    );
    rerender(<GraphCanvas wikiId="current" dataVersion={2} onDockPreview={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Fit" })).toBeTruthy();
    finishFirst?.({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
    expect(screen.queryByText(workbenchMode("graph").emptyState!)).toBeNull();
  });

  it("surfaces a malformed Graph response", async () => {
    send.mockRejectedValue(new Error("bad graph json"));
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(await screen.findByText("bad graph json")).toBeTruthy();
  });
});

describe("Lint canvas", () => {
  it("idles with the health sentence and Semantic off", () => {
    render(<LintCanvas wikiId="current" onDockPreview={vi.fn()} />);
    expect(screen.getByText(workbenchMode("lint").emptyState!)).toBeTruthy();
    const semantic = screen.getByRole("checkbox", { name: "Semantic" }) as HTMLInputElement;
    expect(semantic.checked).toBe(false);
  });

  it("points semantic gaps at Graph Insights and can auto-fix a mechanical row", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/lint/workbench" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { semantic?: boolean };
        return {
          issues: [
            ...(body.semantic
              ? [
                  {
                    type: "insight-pointer",
                    slug: "",
                    message: "Knowledge gaps are listed under Graph Insights.",
                    severity: "info",
                  },
                ]
              : []),
            {
              type: "broken-link",
              slug: "src",
              target: "gone",
              message: "Dangling wikilink",
              severity: "warning",
              fix: "dangling-wikilink",
            },
          ],
        };
      }
      if (url === "/api/lint/workbench-fix") {
        return { success: true, slug: "src", message: "fixed" };
      }
      return {};
    });
    render(<LintCanvas wikiId="current" onDockPreview={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Semantic" }));
    fireEvent.click(screen.getByRole("button", { name: "Run lint" }));
    expect(await screen.findByText("Graph Insights")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Auto-fix" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/lint/workbench-fix",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "broken-link", slug: "src", target: "gone" }),
        }),
      );
    });
  });
});

describe("Review canvas", () => {
  it("does not issue an unscoped request when no Wiki is current", async () => {
    const onCount = vi.fn();
    render(
      <ReviewCanvas wikiId={null} onDockPreview={vi.fn()} onPendingCountChange={onCount} />,
    );
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(0));
    expect(send).not.toHaveBeenCalledWith("/api/review-queue", expect.anything());
  });

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

  it("does not forward a malformed pendingCount to the badge", async () => {
    send.mockResolvedValue({ items: [item], pendingCount: -3 });
    const onCount = vi.fn();
    render(
      <ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} onPendingCountChange={onCount} />,
    );
    await screen.findByText("Need a judgment");
    expect(onCount).not.toHaveBeenCalled();
  });

  it("keeps a creating card visible and disables Skip and Create Page", async () => {
    send.mockResolvedValue({
      items: [{ ...item, status: "creating" }],
      pendingCount: 1,
    });
    render(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);
    await screen.findByText("Need a judgment");
    expect((screen.getByRole("button", { name: "Create Page" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Deep Research" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("skips a pending item without a wiki write and never Accepts", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/review-queue") && (!init || init.method === "GET")) {
        return { items: [item], pendingCount: 1 };
      }
      if (typeof url === "string" && url.startsWith("/api/review-queue/r1")) {
        return { item: { ...item, status: "skipped" }, pendingCount: 0 };
      }
      if (String(url).startsWith("/api/review-queue")) return { items: [], pendingCount: 0 };
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
          body: JSON.stringify({ action: "skip", wikiId: "current" }),
        }),
      );
    });
    const bodies = send.mock.calls
      .map((call) => (typeof call[1]?.body === "string" ? call[1].body : ""))
      .join("\n");
    expect(bodies).not.toContain("/run");
    expect(bodies).not.toContain("accept");
  });

  it("loads the current Wiki queue and Create Page does not Accept", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/review-queue") && (!init || init.method === "GET")) {
        return { items: [item], pendingCount: 1 };
      }
      if (typeof url === "string" && url.startsWith("/api/review-queue/r1")) {
        return { item: { ...item, status: "created" }, slug: "need-a-judgment", pendingCount: 0 };
      }
      return {};
    });
    render(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);
    await screen.findByText("Need a judgment");
    fireEvent.click(screen.getByRole("button", { name: "Create Page" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/review-queue/r1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "create-page", wikiId: "wiki-a" }),
        }),
      );
    });
    expect(send.mock.calls.some((call) => String(call[0]).startsWith("/api/review-queue?wikiId=wiki-a"))).toBe(
      true,
    );
  });

  it("ignores an in-flight Review action after the active Wiki changes", async () => {
    let resolveAction: ((value: unknown) => void) | undefined;
    const action = new Promise((resolve) => {
      resolveAction = resolve;
    });
    const wikiBItem = { ...item, id: "r2", title: "Wiki B judgment", wikiId: "wiki-b" };
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/review-queue/r1" && init?.method === "POST") return action;
      if (String(url).includes("wikiId=wiki-b")) return { items: [wikiBItem], pendingCount: 1 };
      if (String(url).includes("wikiId=wiki-a")) return { items: [item], pendingCount: 1 };
      return { items: [], pendingCount: 0 };
    });
    const onCount = vi.fn();
    const { rerender } = render(
      <ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} onPendingCountChange={onCount} />,
    );
    await screen.findByText("Need a judgment");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    rerender(
      <ReviewCanvas wikiId="wiki-b" onDockPreview={vi.fn()} onPendingCountChange={onCount} />,
    );
    await screen.findByText("Wiki B judgment");
    resolveAction?.({ item: { ...item, status: "skipped" }, pendingCount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("Wiki B judgment")).toBeTruthy();
    expect(onCount).not.toHaveBeenCalledWith(0);
  });

  it("closes the Deep Research modal immediately when the Wiki changes", async () => {
    const wikiBItem = { ...item, id: "r2", title: "Wiki B judgment", wikiId: "wiki-b" };
    send.mockImplementation(async (url: string) =>
      String(url).includes("wikiId=wiki-b")
        ? { items: [wikiBItem], pendingCount: 1 }
        : { items: [item], pendingCount: 1 });
    const { rerender } = render(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);
    await screen.findByText("Need a judgment");
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    expect(screen.getByRole("dialog", { name: "Deep Research" })).toBeTruthy();
    rerender(<ReviewCanvas wikiId="wiki-b" onDockPreview={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Deep Research" })).toBeNull());
    expect(await screen.findByText("Wiki B judgment")).toBeTruthy();
  });

  it("ignores a late Deep Research result from the prior Wiki", async () => {
    let resolveResearch!: (value: unknown) => void;
    const pendingResearch = new Promise((resolve) => { resolveResearch = resolve; });
    const wikiBItem = { ...item, id: "r2", title: "Wiki B judgment", wikiId: "wiki-b" };
    send.mockImplementation(async (url: string) => {
      if (url === "/api/research") return pendingResearch;
      if (String(url).includes("wikiId=wiki-b")) return { items: [wikiBItem], pendingCount: 1 };
      return { items: [item], pendingCount: 1 };
    });
    const onOpenResearch = vi.fn();
    const { rerender } = render(
      <ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} onOpenResearch={onOpenResearch} />,
    );
    await screen.findByText("Need a judgment");
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/api/research",
      expect.objectContaining({ method: "POST" }),
    ));
    rerender(
      <ReviewCanvas wikiId="wiki-b" onDockPreview={vi.fn()} onOpenResearch={onOpenResearch} />,
    );
    resolveResearch({ project: { id: "stale-project" } });
    await screen.findByText("Wiki B judgment");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onOpenResearch).not.toHaveBeenCalled();
  });

  it("does not restore an old action busy state after switching away and back", async () => {
    let resolveAction!: (value: unknown) => void;
    const pendingAction = new Promise((resolve) => { resolveAction = resolve; });
    const wikiBItem = { ...item, id: "r2", title: "Wiki B judgment", wikiId: "wiki-b" };
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/review-queue/r1" && init?.method === "POST") return pendingAction;
      if (String(url).includes("wikiId=wiki-b")) return { items: [wikiBItem], pendingCount: 1 };
      return { items: [item], pendingCount: 1 };
    });
    const { rerender } = render(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);
    await screen.findByText("Need a judgment");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ReviewCanvas wikiId="wiki-b" onDockPreview={vi.fn()} />);
    await screen.findByText("Wiki B judgment");
    rerender(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);
    await screen.findByText("Need a judgment");
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(false);
    resolveAction({ item: { ...item, status: "skipped" }, pendingCount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(false);
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

  it("Confirm from Review creates the project and then runs it", async () => {
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
      if (String(url).startsWith("/api/review-queue")) return { items: [item], pendingCount: 1 };
      if (url === "/api/research") return { project: { id: "proj-1", status: "draft" } };
      return {};
    });
    const onOpen = vi.fn();
    render(
      <ReviewCanvas wikiId="wiki-r" onDockPreview={vi.fn()} onOpenResearch={onOpen} />,
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
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/research/proj-1/run",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(onOpen).toHaveBeenCalledWith("proj-1");
    const [, createInit] = send.mock.calls.find(([url]) => url === "/api/research")!;
    expect(JSON.parse(String((createInit as RequestInit).body))).toMatchObject({
      // The wiki the confirm came FROM, and the originating page, so the run's
      // auto-Ingest lands where the card lives.
      vaultId: "wiki-r",
      pageSlugs: ["topic"],
    });
    // Starting a research run is not a JUDGMENT on the Review item. The item
    // stays pending: the whole point of researching it is that the owner does
    // not know the answer yet, and resolving it here would take it off the queue
    // before the brief exists.
    const resolved = send.mock.calls.filter(
      ([url, init]) =>
        String(url).startsWith("/api/review-queue/") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(resolved).toEqual([]);
  });

  it("Confirm from Graph creates then runs, and records the wiki it came from", async () => {
    // The Epic 5 confirm stopped at the create, which left a draft project
    // nothing would ever search — the owner had confirmed a topic and got a card
    // saying web search had not started.
    send.mockImplementation(async (url: string) => {
      if (url === "/api/research") return { project: { id: "proj-g" } };
      if (String(url).includes("/run")) return { project: { id: "proj-g", status: "queued" } };
      return {
        nodes: [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }],
        edges: [],
        insights: [isolatedInsight],
        communities: [],
        types: [],
      };
    });
    const onOpenResearch = vi.fn();
    render(
      <GraphCanvas wikiId="wiki-a" onDockPreview={vi.fn()} onOpenResearch={onOpenResearch} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Alone is isolated/ }));
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/api/research/proj-g/run",
      expect.objectContaining({ method: "POST" }),
    ));
    const [, createInit] = send.mock.calls.find(([url]) => url === "/api/research")!;
    // The wiki the confirm came FROM, so the run's auto-Ingest lands there even
    // if the rail has moved on by the time it finishes.
    expect(JSON.parse(String((createInit as RequestInit).body)))
      .toMatchObject({ vaultId: "wiki-a" });
    expect(onOpenResearch).toHaveBeenCalledWith("proj-g");
  });

  it("opens the panel on the created project even when the run is refused", async () => {
    // ONE CONFIRM, ONE PROJECT. This used to keep the dialog open holding the
    // refusal, so a second Confirm minted a SECOND project for the same card —
    // one per press, all of them stored. The create already landed, so the
    // confirm is spent: the dialog closes and the panel opens on the project,
    // where `queueResearchProject` has recorded why the start failed.
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
      if (String(url).startsWith("/api/review-queue")) return { items: [item], pendingCount: 1 };
      if (url === "/api/research") return { project: { id: "proj-1", status: "draft" } };
      if (String(url).includes("/run")) throw new Error("Deep Research is set to Tavily, which has no credential.");
      return {};
    });
    const onOpen = vi.fn();
    render(
      <ReviewCanvas wikiId="current" onDockPreview={vi.fn()} onOpenResearch={onOpen} />,
    );
    await screen.findByText("Follow up");
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("proj-1"));
    // The dialog is gone, so there is nothing left to press twice.
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    const creates = send.mock.calls.filter(([url]) => url === "/api/research");
    expect(creates).toHaveLength(1);
  });

  it("keeps the Graph dialog open when the CREATE itself fails", async () => {
    // The other half of the rule: with no project there is nothing to open, so
    // the sentence has to live where the owner is — in the dialog.
    send.mockImplementation(async (url: string) => {
      if (url === "/api/research") throw new Error("This workspace already has the maximum");
      return {
        nodes: [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }],
        edges: [],
        insights: [isolatedInsight],
        communities: [],
        types: [],
      };
    });
    const onOpenResearch = vi.fn();
    render(
      <GraphCanvas wikiId="wiki-a" onDockPreview={vi.fn()} onOpenResearch={onOpenResearch} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Alone is isolated/ }));
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText(/maximum/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(onOpenResearch).not.toHaveBeenCalled();
  });

  it("never sends the rail's `current` placeholder as a wiki id", async () => {
    // `ModeCanvas` defaults `wikiId` to `"current"`, and this value is PERSISTED
    // on the project — a stored `"current"` resolves to no wiki, forever.
    send.mockImplementation(async (url: string) => {
      if (url === "/api/research") return { project: { id: "proj-c" } };
      if (String(url).includes("/run")) return { project: { id: "proj-c", status: "queued" } };
      return {
        nodes: [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }],
        edges: [],
        insights: [isolatedInsight],
        communities: [],
        types: [],
      };
    });
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} onOpenResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Alone is isolated/ }));
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/api/research/proj-c/run",
      expect.objectContaining({ method: "POST" }),
    ));
    const [, createInit] = send.mock.calls.find(([url]) => url === "/api/research")!;
    expect(JSON.parse(String((createInit as RequestInit).body))).not.toHaveProperty("vaultId");
  });

  it("counts the queries the store would keep, not the lines that were typed", async () => {
    // The dialog used to split with its own local helper, which dropped blanks
    // but kept DUPLICATES — so two identical lines enabled Confirm with a count
    // of two and started a run with one.
    const onConfirm = vi.fn();
    render(
      <DeepResearchConfirm
        open
        initialTopic="Topic"
        initialQueries={["one"]}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Queries/), {
      target: { value: "one\n\n one \ntwo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledWith({ topic: "Topic", queries: ["one", "two"] });
  });
});

describe("Research canvas", () => {
  it("shows the empty Deep Research sentence", async () => {
    send.mockResolvedValue({ projects: [] });
    render(<ResearchCanvas wikiId="current" />);
    expect(await screen.findByText(workbenchMode("research").emptyState!)).toBeTruthy();
  });

  it("keeps the filled draft when a stale empty list lands late", async () => {
    let finishFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    let calls = 0;
    send.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        await first;
        return { projects: [] };
      }
      return {
        projects: [
          {
            id: "proj-1",
            title: "Filled topic",
            question: "Filled topic",
            queries: ["What belongs here?"],
            status: "draft",
          },
        ],
      };
    });
    const { rerender } = render(<ResearchCanvas wikiId="current" filledId={null} />);
    rerender(<ResearchCanvas wikiId="current" filledId="proj-1" />);
    expect(await screen.findByRole("heading", { name: "Filled topic" })).toBeTruthy();
    finishFirst?.({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("heading", { name: "Filled topic" })).toBeTruthy();
    expect(screen.queryByText(workbenchMode("research").emptyState!)).toBeNull();
  });

  it("surfaces a malformed Research response", async () => {
    send.mockRejectedValue(new Error("bad research json"));
    render(<ResearchCanvas wikiId="current" />);
    expect(await screen.findByText("bad research json")).toBeTruthy();
  });
});
