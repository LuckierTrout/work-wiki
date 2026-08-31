/**
 * The Graph, Review and Deep Research canvases on a read-only deployment,
 * MOUNTED (DW-531, DW-644).
 *
 * Graph and Review used to pass `readOnly` straight into `disabled`. A
 * `disabled` button is out of the tab order and carries no accessible
 * description, so the standing refusal could never be reached OR announced: the
 * owner met a dead control and no reason — the exact defect DW-191/DW-299
 * removed from the Wiki switcher and DW-386 from Names & Terms and Email
 * ingestion. The Deep Research canvas (DW-644) had a THIRD shape, the one that
 * explains least: its two row controls were not rendered at all under
 * `readOnly`, so the card carried no control, no reason, and no voice for the
 * sentence `POST /api/research/[id]/run` answers.
 *
 * What is pinned here is the shipped shape: `disabled` for TRANSIENT state
 * only, YIELDING to the standing refusal; `aria-disabled` for the standing one;
 * an `aria-describedby` that resolves to the sentence ITS OWN door answers; a
 * handler that returns before any request; and nothing at all rendered on a
 * writable deployment.
 *
 * Its own file rather than more rows in `graph-lint-review-canvas.test.tsx`:
 * that suite is about what the canvases DO, and every row here is about what
 * they refuse. The Sigma mock is duplicated because Graph will not paint its
 * chrome — and therefore its insight list — without a renderer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({
  send,
  writeFailure: (cause: unknown, action: string) => ({
    message: cause instanceof Error ? cause.message : `Couldn’t ${action}.`,
    unconfirmed: false,
  }),
}));
vi.mock("sigma", () => ({
  default: class MockSigma {
    kill() {}
    refresh() {}
    on() {}
    setSetting() {}
    getNodeDisplayData() {
      return { x: 0, y: 0 };
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
        animatedZoom: vi.fn(),
        animatedUnzoom: vi.fn(),
        animate: vi.fn(),
        on: vi.fn(),
      };
    }
  },
}));

import {
  GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY,
  GraphCanvas,
} from "@/components/workbench/GraphCanvas";
import {
  REVIEW_QUEUE_READ_ONLY_COPY,
  ReviewCanvas,
} from "@/components/workbench/ReviewCanvas";
import { ResearchCanvas } from "@/components/workbench/ResearchCanvas";
import {
  RESEARCH_CREATE_READ_ONLY_COPY,
  RESEARCH_MUTATE_READ_ONLY_COPY,
} from "@/lib/research-panel";

/** The sentence a control actually ANNOUNCES, resolved through its own id. */
function describedBy(control: HTMLElement): string {
  const id = control.getAttribute("aria-describedby");
  expect(id, "aria-describedby is set").toBeTruthy();
  const note = document.getElementById(id!);
  expect(note, `a node with id ${id}`).toBeTruthy();
  return note!.textContent ?? "";
}

/** Focusable AND announced-as-refusing, which is the whole point of the shape. */
function expectStandingRefusal(control: HTMLElement): void {
  expect((control as HTMLButtonElement).disabled, "not `disabled`").toBe(false);
  expect(control.getAttribute("aria-disabled")).toBe("true");
  control.focus();
  expect(document.activeElement).toBe(control);
}

const NODES = [{ id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] }];

const surpriseInsight = {
  id: "surprise:alone",
  kind: "surprise" as const,
  title: "Alone is surprising",
  summary: "Unexpected neighbours",
  slugs: ["alone"],
  edges: [],
  offersDeepResearch: false,
  fingerprint: "surprise:alone:0::0",
  topic: "Alone",
  queries: ["What surprised us about Alone?"],
};

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

/** A stored research project, with only the fields the canvas reads. */
const researchProject = (extra: Record<string, unknown>) => ({
  id: "p1",
  title: "Launch evidence",
  question: "What supports the launch date?",
  queries: ["launch evidence"],
  sourceUrls: [],
  pageSlugs: [],
  status: "draft",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  ...extra,
});

function graphBody(insights: unknown[]) {
  return { nodes: NODES, edges: [], insights, communities: [], types: [] };
}

const reviewItem = {
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

beforeEach(() => {
  send.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Graph canvas — read-only", () => {
  it("keeps both insight controls focusable and names each one's OWN door", async () => {
    send.mockResolvedValue(graphBody([surpriseInsight, isolatedInsight]));
    render(<GraphCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />);

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    const research = screen.getByRole("button", { name: "Deep Research" });
    expectStandingRefusal(dismiss);
    expectStandingRefusal(research);
    // TWO doors, two sentences. Dismiss meets `POST /api/graph/insights`;
    // Deep Research meets `POST /api/research` and dismisses nothing.
    expect(describedBy(dismiss)).toBe(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY);
    expect(describedBy(research)).toBe(RESEARCH_CREATE_READ_ONLY_COPY);
    expect(dismiss.getAttribute("aria-describedby")).not.toBe(
      research.getAttribute("aria-describedby"),
    );
  });

  it("issues no request and opens no dialog when either control is activated", async () => {
    send.mockResolvedValue(graphBody([surpriseInsight, isolatedInsight]));
    render(<GraphCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />);

    await screen.findByRole("button", { name: "Dismiss" });
    const reads = send.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    // A focusable control is a REACHABLE one, so the handler is what refuses.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send.mock.calls.length).toBe(reads);
    // …and the confirm never opens onto a 403 the owner would meet afterwards.
    expect(screen.queryByRole("dialog", { name: "Deep Research" })).toBeNull();
    // The card stays listed: a refused dismiss removes nothing optimistically.
    expect(screen.getByText("Alone is surprising")).toBeTruthy();
  });

  it("renders only the note whose control is on screen", async () => {
    // The DW-386 rule: a sentence for an operation the owner was never offered
    // announces the refusal of something that is not there. Only `surprise`
    // insights carry Dismiss, so a list of nothing else carries no create note.
    send.mockResolvedValue(graphBody([surpriseInsight]));
    render(<GraphCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />);

    await screen.findByRole("button", { name: "Dismiss" });
    expect(screen.getByText(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY)).toBeTruthy();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Deep Research" })).toBeNull();
  });

  it("renders only the create note when nothing is dismissible", async () => {
    // The mirror of the case above, in the other direction. Only `surprise`
    // insights carry Dismiss, so a list without one must carry neither the
    // control nor the sentence that describes it — a guard tested in one
    // direction only would pass with the condition inverted.
    send.mockResolvedValue(graphBody([isolatedInsight]));
    render(<GraphCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />);

    await screen.findByRole("button", { name: "Deep Research" });
    expect(screen.getByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeTruthy();
    expect(screen.queryByText(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("states each sentence ONCE for the whole list, however many cards there are", async () => {
    // ONE NOTE PER LIST, NOT PER CARD. A note moved inside the `.map()` would
    // mint a duplicate id per insight — `aria-describedby` then resolves to
    // whichever node the browser found first, and a screen reader repeats the
    // deployment's standing state once per row. Every other case here renders a
    // single card and would stay green through exactly that regression.
    send.mockResolvedValue(
      graphBody([
        surpriseInsight,
        { ...surpriseInsight, id: "surprise:beta", title: "Beta is surprising" },
      ]),
    );
    render(<GraphCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />);

    await screen.findByText("Beta is surprising");
    const dismissals = screen.getAllByRole("button", { name: "Dismiss" });
    expect(dismissals).toHaveLength(2);
    expect(screen.getAllByText(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY)).toHaveLength(1);
    // …and BOTH controls resolve to that one node, rather than to two nodes
    // that happen to read the same.
    const [first, second] = dismissals;
    expect(first.getAttribute("aria-describedby")).toBe(
      second.getAttribute("aria-describedby"),
    );
    expect(describedBy(first)).toBe(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY);
  });

  it("renders nothing at all on a writable deployment", async () => {
    send.mockResolvedValue(graphBody([surpriseInsight, isolatedInsight]));
    render(<GraphCanvas wikiId="current" onDockPreview={vi.fn()} />);

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    expect(dismiss.getAttribute("aria-disabled")).toBeNull();
    expect(dismiss.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
    // And the door is still reachable — the refusal is the flag's, not the
    // control's.
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "/api/graph/insights",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("Review canvas — read-only", () => {
  it("keeps all three controls focusable and names each one's OWN door", async () => {
    send.mockResolvedValue({ items: [reviewItem], pendingCount: 1 });
    render(<ReviewCanvas wikiId="wiki-a" readOnly onDockPreview={vi.fn()} />);

    await screen.findByText("Need a judgment");
    const research = screen.getByRole("button", { name: "Deep Research" });
    const create = screen.getByRole("button", { name: "Create Page" });
    const skip = screen.getByRole("button", { name: "Skip" });
    for (const control of [research, create, skip]) expectStandingRefusal(control);
    // Create Page and Skip resolve the card through
    // `POST /api/review-queue/[id]`; Deep Research resolves nothing and meets
    // `POST /api/research`. Two doors, two sentences, three controls.
    expect(describedBy(research)).toBe(RESEARCH_CREATE_READ_ONLY_COPY);
    expect(describedBy(create)).toBe(REVIEW_QUEUE_READ_ONLY_COPY);
    expect(describedBy(skip)).toBe(REVIEW_QUEUE_READ_ONLY_COPY);
  });

  it("issues no request and opens no dialog when any of them is activated", async () => {
    send.mockResolvedValue({ items: [reviewItem], pendingCount: 1 });
    render(<ReviewCanvas wikiId="wiki-a" readOnly onDockPreview={vi.fn()} />);

    await screen.findByText("Need a judgment");
    const reads = send.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Page" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send.mock.calls.length).toBe(reads);
    expect(screen.queryByRole("dialog", { name: "Deep Research" })).toBeNull();
    expect(screen.getByText("Need a judgment")).toBeTruthy();
  });

  it("lets the standing refusal win over a card already creating", async () => {
    // The matrix's stalled row. `busy` cannot be reached under `readOnly` — the
    // only thing that sets it is `act`, which early-returns — but a card that
    // arrived from the server marked `creating` reaches the SAME expression,
    // and it is the one that must not take the control carrying the sentence
    // out of the tab order.
    send.mockResolvedValue({
      items: [{ ...reviewItem, status: "creating" }],
      pendingCount: 1,
    });
    render(<ReviewCanvas wikiId="wiki-a" readOnly onDockPreview={vi.fn()} />);

    await screen.findByText("Need a judgment");
    for (const name of ["Deep Research", "Create Page", "Skip"]) {
      expectStandingRefusal(screen.getByRole("button", { name }));
    }
  });

  it("states each sentence ONCE for the whole list, however many cards there are", async () => {
    // The Review half of the same rule. Both notes are rendered after the list
    // rather than inside it, and this is what holds them there: moved into the
    // `.map()` they would mint one id per card, and `aria-describedby` on the
    // second card's controls would resolve to the first card's node.
    send.mockResolvedValue({
      items: [reviewItem, { ...reviewItem, id: "r2", title: "Second judgment" }],
      pendingCount: 2,
    });
    render(<ReviewCanvas wikiId="wiki-a" readOnly onDockPreview={vi.fn()} />);

    await screen.findByText("Second judgment");
    const skips = screen.getAllByRole("button", { name: "Skip" });
    const researches = screen.getAllByRole("button", { name: "Deep Research" });
    expect(skips).toHaveLength(2);
    expect(researches).toHaveLength(2);
    expect(screen.getAllByText(REVIEW_QUEUE_READ_ONLY_COPY)).toHaveLength(1);
    expect(screen.getAllByText(RESEARCH_CREATE_READ_ONLY_COPY)).toHaveLength(1);
    // Both cards' controls point at the SAME node, per door.
    expect(skips[0].getAttribute("aria-describedby")).toBe(
      skips[1].getAttribute("aria-describedby"),
    );
    expect(researches[0].getAttribute("aria-describedby")).toBe(
      researches[1].getAttribute("aria-describedby"),
    );
    expect(describedBy(skips[1])).toBe(REVIEW_QUEUE_READ_ONLY_COPY);
    expect(describedBy(researches[1])).toBe(RESEARCH_CREATE_READ_ONLY_COPY);
  });

  it("renders the queue note but no create note for a card with no queries", async () => {
    send.mockResolvedValue({
      items: [{ ...reviewItem, queries: [] }],
      pendingCount: 1,
    });
    render(<ReviewCanvas wikiId="wiki-a" readOnly onDockPreview={vi.fn()} />);

    await screen.findByText("Need a judgment");
    expect(screen.queryByRole("button", { name: "Deep Research" })).toBeNull();
    expect(screen.getByText(REVIEW_QUEUE_READ_ONLY_COPY)).toBeTruthy();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
  });

  it("renders no note at all with an empty queue", async () => {
    send.mockResolvedValue({ items: [], pendingCount: 0 });
    render(<ReviewCanvas wikiId="wiki-a" readOnly onDockPreview={vi.fn()} />);

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(screen.queryByText(REVIEW_QUEUE_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
  });

  it("keeps the plain TRANSIENT disabled on a writable deployment", async () => {
    send.mockResolvedValue({
      items: [{ ...reviewItem, status: "creating" }],
      pendingCount: 1,
    });
    render(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);

    await screen.findByText("Need a judgment");
    for (const name of ["Deep Research", "Create Page", "Skip"]) {
      const control = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(control.disabled, name).toBe(true);
      expect(control.getAttribute("aria-disabled"), name).toBeNull();
      expect(control.getAttribute("aria-describedby"), name).toBeNull();
    }
    expect(screen.queryByText(REVIEW_QUEUE_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
  });

  it("renders nothing and still reaches the door when writable", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/review-queue/")) {
        return { item: { ...reviewItem, status: "skipped" }, pendingCount: 0 };
      }
      if (init?.method === "POST") return {};
      return { items: [reviewItem], pendingCount: 1 };
    });
    render(<ReviewCanvas wikiId="wiki-a" onDockPreview={vi.fn()} />);

    await screen.findByText("Need a judgment");
    const skip = screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement;
    expect(skip.disabled).toBe(false);
    expect(skip.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(skip);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "/api/review-queue/r1",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("Research canvas — read-only", () => {
  it("renders Cancel refused and announced instead of hiding it", async () => {
    // DW-644's defect, stated as its fix. `{live && !readOnly ? … : null}` is
    // why the read-only owner met a card with no controls at all.
    send.mockResolvedValue({ projects: [researchProject({ status: "collecting" })] });
    render(<ResearchCanvas wikiId="current" readOnly />);

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expectStandingRefusal(cancel);
    expect(describedBy(cancel)).toBe(RESEARCH_MUTATE_READ_ONLY_COPY);
  });

  it("renders Start on a draft row with the same shape", async () => {
    send.mockResolvedValue({ projects: [researchProject({ status: "draft" })] });
    render(<ResearchCanvas wikiId="current" readOnly />);

    const start = await screen.findByRole("button", { name: "Start" });
    expectStandingRefusal(start);
    expect(describedBy(start)).toBe(RESEARCH_MUTATE_READ_ONLY_COPY);
    // …and NOT the create door's sentence, which the form's hint above owns.
    // Two doors stand behind this one canvas: `POST /api/research` for the
    // form, `POST /api/research/[id]/run` for the row.
    expect(describedBy(start)).not.toBe(RESEARCH_CREATE_READ_ONLY_COPY);
    expect(screen.getByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeTruthy();
  });

  it("renders Retry on a failed row with the same shape", async () => {
    send.mockResolvedValue({ projects: [researchProject({ status: "failed" })] });
    render(<ResearchCanvas wikiId="current" readOnly />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expectStandingRefusal(retry);
    expect(describedBy(retry)).toBe(RESEARCH_MUTATE_READ_ONLY_COPY);
  });

  it("states the sentence ONCE for the whole list, however many rows there are", async () => {
    // The Research half of the rule. The note is minted with a single `useId()`
    // in the parent and rendered after the list: moved inside the `.map()` it
    // would mint one id per card, and the second row's control would resolve to
    // the first row's node.
    send.mockResolvedValue({
      projects: [
        researchProject({ id: "a", title: "Alpha", status: "collecting" }),
        researchProject({ id: "b", title: "Beta", status: "collecting" }),
      ],
    });
    render(<ResearchCanvas wikiId="current" readOnly />);

    await screen.findByRole("heading", { name: "Beta" });
    const cancels = screen.getAllByRole("button", { name: "Cancel" });
    expect(cancels).toHaveLength(2);
    expect(screen.getAllByText(RESEARCH_MUTATE_READ_ONLY_COPY)).toHaveLength(1);
    expect(cancels[0].getAttribute("aria-describedby")).toBe(
      cancels[1].getAttribute("aria-describedby"),
    );
    expect(describedBy(cancels[1])).toBe(RESEARCH_MUTATE_READ_ONLY_COPY);
  });

  it("renders no mutate note for a row that offers neither control", async () => {
    // A `complete` row with a DELIVERED completion is offered nothing: the
    // research is done and the Page is written. A sentence here would announce
    // the refusal of an operation the owner was never offered.
    send.mockResolvedValue({
      projects: [researchProject({
        status: "complete",
        completion: { phase: "done", pageSlug: "research-x", sources: [] },
      })],
    });
    render(<ResearchCanvas wikiId="current" readOnly />);

    await screen.findByRole("heading", { name: "Launch evidence" });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(RESEARCH_MUTATE_READ_ONLY_COPY)).toBeNull();
    // The CREATE hint is not the mutate note and stays: that door is still
    // standing in front of the form above.
    expect(screen.getByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeTruthy();
  });

  it("renders no mutate note for an empty list", async () => {
    send.mockResolvedValue({ projects: [] });
    render(<ResearchCanvas wikiId="current" readOnly />);

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(screen.queryByText(RESEARCH_MUTATE_READ_ONLY_COPY)).toBeNull();
    expect(screen.getByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeTruthy();
  });

  it("issues no request when either row control is activated", async () => {
    send.mockResolvedValue({
      projects: [
        researchProject({ id: "a", title: "Alpha", status: "collecting" }),
        researchProject({ id: "b", title: "Beta", status: "draft" }),
      ],
    });
    render(<ResearchCanvas wikiId="current" readOnly />);

    await screen.findByRole("heading", { name: "Beta" });
    const reads = send.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    // A focusable control is a REACHABLE one, so the handler is what refuses.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send.mock.calls.length).toBe(reads);
  });

  it("renders nothing and still reaches the run door when writable", async () => {
    send.mockResolvedValue({ projects: [researchProject({ status: "draft" })] });
    render(<ResearchCanvas wikiId="current" />);

    const start = (await screen.findByRole("button", { name: "Start" })) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect(start.getAttribute("aria-disabled")).toBeNull();
    expect(start.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(RESEARCH_MUTATE_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
    fireEvent.click(start);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "/api/research/p1/run",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("keeps Cancel reaching its own door when writable", async () => {
    send.mockResolvedValue({ projects: [researchProject({ status: "collecting" })] });
    render(<ResearchCanvas wikiId="current" />);

    const cancel = (await screen.findByRole("button", { name: "Cancel" })) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBeNull();
    expect(cancel.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(RESEARCH_MUTATE_READ_ONLY_COPY)).toBeNull();
    fireEvent.click(cancel);
    await waitFor(() => {
      const call = send.mock.calls.find(([url]) => String(url).includes("/run"));
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ action: "cancel" });
    });
  });
});
