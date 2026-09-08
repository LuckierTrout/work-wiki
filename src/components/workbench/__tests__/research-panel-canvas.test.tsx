/**
 * The Research Panel canvas.
 *
 * Its own file rather than more rows in `graph-lint-review-canvas.test.tsx`:
 * that file mocks Sigma for Graph, and this panel needs none of it. What is
 * pinned here is what the spec asks the panel to be — every task listed and
 * distinguishable, the fourth start visible as waiting, thinking reused from
 * Chat and collapsible, the start control refused when read-only or when there
 * is no query, and the two calls a mode-direct start makes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({
  send,
  writeFailure: (cause: unknown, action: string) => ({
    message: cause instanceof Error ? cause.message : `Couldn’t ${action}.`,
    unconfirmed: false,
  }),
}));

import { ResearchCanvas } from "../ResearchCanvas";
import {
  RESEARCH_CREATE_READ_ONLY_COPY,
  RESEARCH_MUTATE_READ_ONLY_COPY,
  RESEARCH_POLL_MS,
  RESEARCH_REPAIRED_COPY,
  RESEARCH_REPAIR_LABEL,
  RESEARCH_REPAIR_NOTE_COPY,
  RESEARCH_REPAIR_PATH,
} from "@/lib/research-panel";
import { REPAIR_HINT } from "@/lib/research-projects";
import { workbenchMode } from "@/lib/workbench-modes";

/** A stored project, with only the fields the panel reads. */
const project = (extra: Record<string, unknown>) => ({
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

/**
 * The sentences a control NAMES, read off its `aria-describedby` in order —
 * never guessed at from what happens to be on screen.
 */
function describedBy(control: HTMLElement): string[] {
  return (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => {
      const node = document.getElementById(id);
      expect(node, id).not.toBeNull();
      return node!.textContent ?? "";
    });
}

beforeEach(() => {
  send.mockReset();
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
});

describe("Research Panel — the task board", () => {
  it("lists every task, not just one, and each one carries its own state", async () => {
    // It used to show a single card that said "Draft — web search has not
    // started." whatever the project was actually doing.
    send.mockResolvedValue({
      projects: [
        project({
          id: "a",
          title: "First topic",
          status: "collecting",
          provider: "tavily",
          progress: { completedQueries: 1, totalQueries: 3, message: "Searching the web." },
        }),
        project({
          id: "b",
          title: "Second topic",
          status: "complete",
          progress: { completedQueries: 2, totalQueries: 2, message: "Wrote research-second." },
        }),
      ],
    });

    render(<ResearchCanvas wikiId="current" />);

    expect(await screen.findByRole("heading", { name: "First topic" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Second topic" })).toBeTruthy();
    // DISTINGUISHABLE by word, not by colour: the chip, the heading and the
    // progress line each differ.
    expect(screen.getByText("Searching")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.getByText("Searching the web. (1 of 3)")).toBeTruthy();
    // Which provider searched this is a fact the results cannot recover.
    expect(screen.getByText("tavily")).toBeTruthy();
  });

  it("shows a queued fourth start as waiting, and says what it waits behind", async () => {
    send.mockResolvedValue({
      projects: [project({
        id: "d",
        title: "Fourth topic",
        status: "queued",
        progress: {
          completedQueries: 0,
          totalQueries: 1,
          message: "Waiting for a free research slot (3 of 3 running).",
        },
      })],
    });

    render(<ResearchCanvas wikiId="current" />);

    expect(await screen.findByText("Waiting")).toBeTruthy();
    expect(screen.getByText(/3 of 3 running/)).toBeTruthy();
  });

  it("marks the row the rail asked for", async () => {
    send.mockResolvedValue({
      projects: [
        project({ id: "a", title: "First topic" }),
        project({ id: "b", title: "Second topic" }),
      ],
    });

    render(<ResearchCanvas wikiId="current" filledId="b" />);

    const marked = await waitFor(() => {
      const node = screen.getByRole("heading", { name: "Second topic" }).closest("article");
      if (!node || node.getAttribute("aria-current") !== "true") throw new Error("not yet");
      return node;
    });
    // `aria-current`, not only a border: a highlight a screen reader cannot
    // perceive does not answer "which one did I just open?".
    expect(marked.getAttribute("aria-current")).toBe("true");
  });

  it("shows the failure sentence on the row that failed", async () => {
    send.mockResolvedValue({
      projects: [project({
        status: "failed",
        error: "Deep Research is set to Tavily, which has no credential.",
      })],
    });

    render(<ResearchCanvas wikiId="current" />);

    expect(await screen.findByText(/no credential/)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("keeps the empty sentence when there is nothing to show", async () => {
    send.mockResolvedValue({ projects: [] });
    render(<ResearchCanvas wikiId="current" />);
    expect(await screen.findByText(workbenchMode("research").emptyState!)).toBeTruthy();
  });

  it("re-reads while a run is live, and stops once nothing is", async () => {
    // The run is a queue task on another isolate: there is no stream for the
    // browser to hold, so the poll IS how a transition becomes visible. It must
    // also stop — an interval against a finished board is a request every few
    // seconds for the life of the session.
    send.mockResolvedValue({ projects: [project({ status: "collecting" })] });
    vi.useFakeTimers();

    render(<ResearchCanvas wikiId="current" />);
    // `act` around the clock advance, so React commits the state the poll read
    // before the next tick is asserted. Without it the interval effect has not
    // been mounted yet and the second poll never fires.
    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    await tick(0);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(RESEARCH_POLL_MS + 10);
    expect(send).toHaveBeenCalledTimes(2);

    // The run finishes, so the board goes static and the interval is torn down.
    send.mockResolvedValue({ projects: [project({ status: "complete" })] });
    await tick(RESEARCH_POLL_MS + 10);
    expect(send).toHaveBeenCalledTimes(3);
    await tick(RESEARCH_POLL_MS * 4);
    expect(send).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("keeps rows and keeps polling after a transient load failure", async () => {
    send
      .mockResolvedValueOnce({ projects: [project({ status: "collecting" })] })
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue({
        projects: [project({
          status: "collecting",
          progress: { completedQueries: 1, totalQueries: 2, message: "Still going." },
        })],
      });
    vi.useFakeTimers();

    render(<ResearchCanvas wikiId="current" />);
    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    await tick(0);
    expect(screen.getByRole("heading", { name: "Launch evidence" })).toBeTruthy();
    await tick(RESEARCH_POLL_MS + 10);
    expect(screen.getByRole("heading", { name: "Launch evidence" })).toBeTruthy();
    expect(screen.getByText("network blip")).toBeTruthy();
    await tick(RESEARCH_POLL_MS + 10);
    expect(screen.getByText("Still going. (1 of 2)")).toBeTruthy();

    vi.useRealTimers();
  });

  it("retries when the initial list request fails", async () => {
    send
      .mockRejectedValueOnce(new Error("first load failed"))
      .mockResolvedValue({ projects: [] });
    vi.useFakeTimers();

    render(<ResearchCanvas wikiId="current" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("first load failed")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS + 10); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("first load failed")).toBeNull();

    vi.useRealTimers();
  });

  it("asks the list door for the rail's wiki", async () => {
    send.mockResolvedValue({ projects: [] });

    render(<ResearchCanvas wikiId="6f1b7e10-0000-4000-8000-000000000000" />);

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/api/research?wikiId=6f1b7e10-0000-4000-8000-000000000000",
      expect.objectContaining({ method: "GET" }),
    ));
  });
});

describe("Research Panel — thinking", () => {
  it("streams a live run's newest lines and renders no chrome without thinking", async () => {
    send.mockResolvedValue({
      projects: [
        project({
          id: "live",
          title: "Live topic",
          status: "collecting",
          thinking: ["one", "two", "three", "four", "five", "six"],
        }),
        project({ id: "quiet", title: "Quiet topic", status: "collecting" }),
      ],
    });

    render(<ResearchCanvas wikiId="current" />);

    await screen.findByRole("heading", { name: "Live topic" });
    // Five lines, newest last — Chat's own viewport rule, and Chat's own class.
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getByText("six")).toBeTruthy();
    const liveRow = screen.getByRole("heading", { name: "Live topic" }).closest("article")!;
    expect(liveRow.querySelector(".wb-chat-thinking--live")).toBeTruthy();
    expect(liveRow.querySelector('[aria-live="polite"]')).toBeTruthy();
    // NO CHROME WHEN THERE IS NO THINKING.
    const quietRow = screen.getByRole("heading", { name: "Quiet topic" }).closest("article")!;
    expect(quietRow.querySelector(".wb-chat-thinking")).toBeNull();
  });

  it("follows the newest line without animating on a platform with no scrollTo", async () => {
    // jsdom has neither `scrollTo` nor a layout engine. The row must still land
    // at the bottom rather than throwing out of a layout effect — the same
    // platform guard the shell's `scrollIntoView?.()` carries.
    send.mockResolvedValue({
      projects: [project({ status: "collecting", thinking: ["one", "two"] })],
    });

    render(<ResearchCanvas wikiId="current" />);

    const viewport = await waitFor(() => {
      const node = document.querySelector(".wb-chat-thinking--live");
      if (!node) throw new Error("not yet");
      return node as HTMLElement;
    });
    expect(viewport.scrollTop).toBe(viewport.scrollHeight);
  });

  it("jumps rather than animating when the platform asks for reduced motion", async () => {
    // A platform WITH `scrollTo`, so the jump can only be attributable to the
    // media query — the one thing `prefers-reduced-motion` means is "do not
    // animate", and `behavior: "smooth"` is an animation.
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", {
      value: scrollTo,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })));
    send.mockResolvedValue({
      projects: [project({ status: "collecting", thinking: ["one", "two"] })],
    });

    render(<ResearchCanvas wikiId="current" />);

    const viewport = await waitFor(() => {
      const node = document.querySelector(".wb-chat-thinking--live");
      if (!node) throw new Error("not yet");
      return node as HTMLElement;
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(viewport.scrollHeight);

    vi.unstubAllGlobals();
    delete (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  });

  it("collapses a finished run's thinking behind the same details Chat uses", async () => {
    send.mockResolvedValue({
      projects: [project({
        status: "complete",
        thinking: ["Searching with tavily.", "Wrote research-launch-evidence."],
      })],
    });

    render(<ResearchCanvas wikiId="current" />);

    const summary = await screen.findByText("Thinking");
    const details = summary.closest("details")!;
    expect(details.className).toContain("wb-chat-thinking");
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(screen.getByText(/Wrote research-launch-evidence/)).toBeTruthy();
  });

  it("lets the owner collapse live thinking while the run keeps polling", async () => {
    send.mockResolvedValue({
      projects: [project({ status: "collecting", thinking: ["Working through evidence"] })],
    });

    render(<ResearchCanvas wikiId="current" />);

    const summary = await screen.findByText("Thinking");
    const details = summary.closest("details")!;
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });
});

describe("Research Panel — starting a run", () => {
  it("creates then runs, and reports the queries it is about to send", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/research" && init?.method === "POST") {
        return { project: { id: "new-1" } };
      }
      return { projects: [] };
    });

    render(<ResearchCanvas wikiId="current" />);
    await screen.findByText(workbenchMode("research").emptyState!);

    const start = screen.getByRole("button", { name: "Start Deep Research" }) as HTMLButtonElement;
    // Refused with no topic and no query, and the reason is a sentence rather
    // than a disabled control with nothing beside it.
    expect(start.disabled).toBe(true);
    expect(screen.getByText("Add a topic and at least one query.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Launch evidence" } });
    fireEvent.change(screen.getByLabelText("Queries"), {
      target: { value: "launch evidence\n\nschedule risk\nlaunch evidence" },
    });
    // Blank and duplicate lines are not queries.
    expect(screen.getByText("2 queries ready.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start Deep Research" }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Start Deep Research" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/api/research/new-1/run",
      expect.objectContaining({ method: "POST" }),
    ));
    const [, createInit] = send.mock.calls.find(
      ([url, init]) => url === "/api/research" && (init as RequestInit | undefined)?.method === "POST",
    )!;
    const created = JSON.parse(String((createInit as RequestInit).body));
    expect(created).toMatchObject({
      title: "Launch evidence",
      queries: ["launch evidence", "schedule risk"],
    });
    // NEVER THE `"current"` PLACEHOLDER. `ModeCanvas` defaults `wikiId` to it,
    // and this canvas PERSISTS the value on a project — a stored `"current"` is a
    // wiki id that resolves to nothing, forever.
    expect(created).not.toHaveProperty("vaultId");
  });

  it("still starts a created project after a wiki switch, without painting the other wiki", async () => {
    let resolveCreate: ((value: { project: { id: string } }) => void) | undefined;
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/research" && init?.method === "POST") {
        return await new Promise<{ project: { id: string } }>((resolve) => {
          resolveCreate = resolve;
        });
      }
      if (String(url).includes("/run")) return { project: { id: "new-1" } };
      return { projects: [] };
    });

    const { rerender } = render(
      <ResearchCanvas wikiId="6f1b7e10-0000-4000-8000-000000000000" />,
    );
    await screen.findByText(workbenchMode("research").emptyState!);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Launch evidence" } });
    fireEvent.change(screen.getByLabelText("Queries"), { target: { value: "launch evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Deep Research" }));

    rerender(<ResearchCanvas wikiId="6f1b7e10-0000-4000-8000-000000000001" />);
    expect(screen.getByRole("button", { name: "Start Deep Research" })).toBeTruthy();
    resolveCreate?.({ project: { id: "new-1" } });

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      "/api/research/new-1/run",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(screen.queryByText(/no credential|Deep Research did not return/)).toBeNull();
  });

  it("does not paint a cancel failure onto the Wiki selected afterward", async () => {
    let rejectCancel: ((reason: unknown) => void) | undefined;
    send.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/run") && init?.body) {
        return new Promise((_resolve, reject) => { rejectCancel = reject; });
      }
      if (String(url).includes("000000000000")) {
        return Promise.resolve({ projects: [project({ status: "collecting" })] });
      }
      return Promise.resolve({ projects: [] });
    });

    const view = render(
      <ResearchCanvas wikiId="6f1b7e10-0000-4000-8000-000000000000" />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(rejectCancel).toBeTypeOf("function"));
    view.rerender(
      <ResearchCanvas wikiId="6f1b7e10-0000-4000-8000-000000000001" />,
    );
    await act(async () => { rejectCancel?.(new Error("Wiki A cancel failed")); });

    expect(screen.queryByText("Wiki A cancel failed")).toBeNull();
  });

  it("keeps polling a complete row whose ingest is still draining", async () => {
    send.mockResolvedValue({
      projects: [project({
        status: "complete",
        completion: { phase: "sources", pageSlug: "research-x", sources: [] },
        progress: { completedQueries: 1, totalQueries: 1, message: "1 source ingest still pending." },
      })],
    });
    vi.useFakeTimers();

    render(<ResearchCanvas wikiId="current" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS + 10);
    });
    expect(send.mock.calls.length).toBeGreaterThan(1);

    vi.useRealTimers();
  });

  it("stops automatic polling for an operator-blocked delivery", async () => {
    send.mockResolvedValue({
      projects: [project({
        status: "failed",
        deliveryBlocked: true,
        completion: { phase: "page", pageSlug: "research-x", sources: [] },
      })],
    });
    vi.useFakeTimers();

    render(<ResearchCanvas wikiId="current" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3); });
    expect(send).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("retries an operator-blocked delivery through the run route and reloads", async () => {
    const blocked = project({
      id: "blocked-1",
      status: "failed",
      deliveryBlocked: true,
      completion: { phase: "sources", pageSlug: "research-x", sources: [] },
    });
    send.mockImplementation(async (_url: string, init?: RequestInit) => (
      init?.method === "POST" ? { project: blocked } : { projects: [blocked] }
    ));

    render(<ResearchCanvas wikiId="current" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/research/blocked-1/run",
        { method: "POST" },
      );
    });
    expect(send.mock.calls.filter(([, init]) => init?.method === "GET").length)
      .toBeGreaterThanOrEqual(2);
  });

  it("sends the real wiki id when the rail has one", async () => {
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/research" && init?.method === "POST") return { project: { id: "new-1" } };
      return { projects: [] };
    });

    render(<ResearchCanvas wikiId="6f1b7e10-0000-4000-8000-000000000000" />);
    await screen.findByText(workbenchMode("research").emptyState!);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Launch evidence" } });
    fireEvent.change(screen.getByLabelText("Queries"), { target: { value: "launch evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Deep Research" }));

    await waitFor(() => {
      const [, createInit] = send.mock.calls.find(
        ([url, init]) =>
          url === "/api/research" && (init as RequestInit | undefined)?.method === "POST",
      )!;
      expect(JSON.parse(String((createInit as RequestInit).body))).toMatchObject({
        vaultId: "6f1b7e10-0000-4000-8000-000000000000",
      });
    });
  });

  it("refuses a start with a topic but no query", async () => {
    send.mockResolvedValue({ projects: [] });
    render(<ResearchCanvas wikiId="current" />);
    await screen.findByText(workbenchMode("research").emptyState!);

    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Launch evidence" } });

    expect((screen.getByRole("button", { name: "Start Deep Research" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("reports a refused start, and shows the failed row it created", async () => {
    let started = false;
    send.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/research" && init?.method === "POST") {
        started = true;
        return { project: { id: "new-1" } };
      }
      if (String(url).includes("/run")) {
        throw new Error("Deep Research is set to Tavily, which has no credential.");
      }
      // The refused start already stored a failed project. Before this, nothing
      // re-read the list, so the sentence appeared above a panel still reading
      // "no research tasks yet".
      return {
        projects: started
          ? [project({ id: "new-1", status: "failed", error: "Nothing was written." })]
          : [],
      };
    });

    render(<ResearchCanvas wikiId="current" />);
    await screen.findByText(workbenchMode("research").emptyState!);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Launch evidence" } });
    fireEvent.change(screen.getByLabelText("Queries"), { target: { value: "launch evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Deep Research" }));

    expect(await screen.findByText(/no credential/)).toBeTruthy();
    // The row and the sentence arrive together.
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getByText("Nothing was written.")).toBeTruthy();
    expect(screen.queryByText(workbenchMode("research").emptyState!)).toBeNull();
    // The topic survives, so the owner can fix Settings and start again without
    // retyping it.
    expect((screen.getByLabelText("Topic") as HTMLInputElement).value).toBe("Launch evidence");
  });

  it("cancels a live run through the run door", async () => {
    send.mockImplementation(async (url: string) => {
      if (String(url).includes("/run")) return { project: { id: "p1", status: "cancelled" } };
      return { projects: [project({ status: "collecting" })] };
    });

    render(<ResearchCanvas wikiId="current" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      const cancelCall = send.mock.calls.find(([url]) => String(url).includes("/run"));
      expect(JSON.parse(String((cancelCall?.[1] as RequestInit).body))).toEqual({ action: "cancel" });
    });
  });
});

describe("Research Panel — read-only", () => {
  it("refuses the start control and REFUSES Cancel rather than hiding it", async () => {
    send.mockResolvedValue({ projects: [project({ status: "collecting" })] });

    render(<ResearchCanvas wikiId="current" readOnly />);

    await screen.findByRole("heading", { name: "Launch evidence" });
    const start = screen.getByRole("button", { name: "Start Deep Research" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    // The reason names the DEPLOYMENT, not the form: an owner who typed a topic
    // and a query would otherwise read "add a topic".
    //
    // ASSERTED THROUGH THE CONSTANT, not a retyped literal (DW-529). This hint
    // used to spell a fourth wording of the create door's sentence inline, and
    // a test that retyped it would keep passing against copy that no longer
    // matched what `POST /api/research` answers.
    expect(screen.getByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeTruthy();
    // DW-644. Cancel used to be absent entirely — `{live && !readOnly ? … }` —
    // and this row pinned that absence. A hidden control is the refusal that
    // explains least: the owner met a card with no controls and no reason, and
    // the sentence `POST /api/research/[id]/run` answers had no voice here at
    // all. It is now RENDERED, focusable, `aria-disabled`, and describes the
    // run door's own sentence. The shape itself is pinned in
    // `canvas-read-only-refusal.test.tsx` beside Graph's and Review's.
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    const noteId = cancel.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent)
      .toBe(RESEARCH_MUTATE_READ_ONLY_COPY);
    expect((screen.getByLabelText("Topic") as HTMLInputElement).readOnly).toBe(true);
  });
});

/**
 * The way out of a wedged registry, from the canvas (DW-688).
 *
 * A `research-projects.json` `parseRegistry` refuses 500s every research door
 * for its tenant, and the sentence this panel renders verbatim ends by naming
 * `POST /api/research/repair` — a route no control in the product performed.
 * The owner read an instruction addressed to somebody with a terminal.
 */
describe("Research Panel — a wedged registry", () => {
  /** What `GET /api/research` answers for a registry that will not parse. */
  const WEDGED = `Research projects file is unreadable.${REPAIR_HINT}`;

  it("offers Repair beside the store's sentence, posts once, and re-reads", async () => {
    // Keyed on the URL rather than queued with `mockResolvedValueOnce`: the
    // panel POLLS while `error` is set, so a positional queue would be consumed
    // by a tick rather than by the interaction under test.
    let repaired = false;
    send.mockImplementation(async (url: string) => {
      if (url === RESEARCH_REPAIR_PATH) {
        repaired = true;
        return { repaired: true, quarantinedPath: "x.corrupt-1" };
      }
      if (!repaired) throw new Error(WEDGED);
      return { projects: [] };
    });

    render(<ResearchCanvas wikiId="current" />);

    const repair = await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });
    // The store's own sentence stays on screen — the control is an ADDITION to
    // the diagnosis, not a replacement for it.
    expect(screen.getByText(WEDGED)).toBeTruthy();
    // And the note is honest about what pressing it costs — PROGRAMMATICALLY,
    // not merely on screen. A warning that only sighted users receive is not a
    // warning on the one control here that cannot be undone.
    expect(describedBy(repair)).toEqual([RESEARCH_REPAIR_NOTE_COPY]);

    fireEvent.click(repair);

    await waitFor(() => {
      const posts = send.mock.calls.filter(([url]) => url === RESEARCH_REPAIR_PATH);
      expect(posts).toHaveLength(1);
      expect((posts[0][1] as RequestInit).method).toBe("POST");
    });
    // The repair's whole visible effect is on the list: the refusal clears and
    // the empty board the quarantine produced is what is left.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: RESEARCH_REPAIR_LABEL })).toBeNull();
    });
    expect(screen.queryByText(WEDGED)).toBeNull();
    expect(screen.getByText(workbenchMode("research").emptyState ?? "")).toBeTruthy();
  });

  it("relays the door's own refusal and claims no repair", async () => {
    // 409 "nothing to repair" is the one that matters: a mis-aimed repair must
    // not read as a success, and the client cannot tell 409 from 503 or 403.
    const NOTHING_TO_REPAIR =
      "The research projects file reads fine; there is nothing to repair.";
    send.mockImplementation(async (url: string) => {
      if (url === RESEARCH_REPAIR_PATH) throw new Error(NOTHING_TO_REPAIR);
      throw new Error(WEDGED);
    });

    render(<ResearchCanvas wikiId="current" />);

    fireEvent.click(await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    expect(await screen.findByText(NOTHING_TO_REPAIR)).toBeTruthy();
  });

  it("offers nothing for a research failure the repair would not fix", async () => {
    // Repairing throws the tenant's projects away. Offering it in front of a
    // timeout or a provider misconfiguration would be an invitation to do that
    // for no reason.
    send.mockRejectedValue(new Error("Request failed (504)"));

    render(<ResearchCanvas wikiId="current" />);

    expect(await screen.findByText("Request failed (504)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: RESEARCH_REPAIR_LABEL })).toBeNull();
    expect(screen.queryByText(RESEARCH_REPAIR_NOTE_COPY)).toBeNull();
  });

  it("sends ONE repair for a double press, and confirms the one that landed", async () => {
    // The repair is DESTRUCTIVE and not idempotent: the second POST meets a
    // registry the first already made parseable, and the door answers 409 "the
    // research projects file reads fine; there is nothing to repair." That
    // sentence carries no `REPAIR_HINT`, so a repair that SUCCEEDED would end
    // with a refusal on screen and the control gone.
    let repaired = false;
    let release: (() => void) | null = null;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    send.mockImplementation(async (url: string) => {
      if (url === RESEARCH_REPAIR_PATH) {
        if (repaired) throw new Error("nothing to repair");
        await inFlight;
        repaired = true;
        return { repaired: true, quarantinedPath: "x.corrupt-1" };
      }
      if (!repaired) throw new Error(WEDGED);
      return { projects: [] };
    });

    render(<ResearchCanvas wikiId="current" />);
    const repair = await screen.findByRole(
      "button",
      { name: RESEARCH_REPAIR_LABEL },
    ) as HTMLButtonElement;

    fireEvent.click(repair);
    // A REAL `disabled` while in flight, with the label saying why — the same
    // shape the Studio's copy of this control has.
    await waitFor(() => expect(repair.disabled).toBe(true));
    expect(repair.textContent).toBe("Repairing…");
    fireEvent.click(repair);
    release!();

    await waitFor(() => expect(screen.getByText(RESEARCH_REPAIRED_COPY)).toBeTruthy());
    expect(send.mock.calls.filter(([url]) => url === RESEARCH_REPAIR_PATH)).toHaveLength(1);
  });

  it("says a landed repair happened, and takes the notice down on the next read", async () => {
    // The canvas has no feedback banner, so without a statement of its own a
    // successful repair showed as NOTHING: the refusal vanished and an empty
    // board appeared, with no account of the fact that the owner's whole
    // registry had just been quarantined.
    let repaired = false;
    send.mockImplementation(async (url: string) => {
      if (url === RESEARCH_REPAIR_PATH) {
        repaired = true;
        return { repaired: true, quarantinedPath: "x.corrupt-1" };
      }
      if (!repaired) throw new Error(WEDGED);
      return { projects: [] };
    });

    const view = render(<ResearchCanvas wikiId="current" active />);
    fireEvent.click(await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    expect(await screen.findByText(RESEARCH_REPAIRED_COPY)).toBeTruthy();
    // The notice sits over the board the quarantine PRODUCED, not the one it
    // replaced.
    expect(screen.getByText(workbenchMode("research").emptyState ?? "")).toBeTruthy();

    // A later read for any other reason has moved on from it — the notice is
    // about that one transition, not a standing state.
    view.rerender(<ResearchCanvas wikiId="current" active filledId="p1" />);
    await waitFor(() => expect(screen.queryByText(RESEARCH_REPAIRED_COPY)).toBeNull());
  });

  it("renders Repair on a read-only deployment, describes the refusal, and sends nothing", async () => {
    // The DW-644 shape. `readOnly` arrives here as a PROP from `ModeCanvas`,
    // independent of the GET that just failed, so unlike the Studio's copy of
    // this control it is trustworthy enough to disable on.
    send.mockRejectedValue(new Error(WEDGED));

    render(<ResearchCanvas wikiId="current" readOnly />);

    const repair = await screen.findByRole(
      "button",
      { name: RESEARCH_REPAIR_LABEL },
    ) as HTMLButtonElement;
    // RENDERED, NOT HIDDEN, and focusable.
    expect(repair.disabled).toBe(false);
    expect(repair.getAttribute("aria-disabled")).toBe("true");
    // BOTH descriptions, in order. The read-only sentence is an ADDITION to the
    // repair warning, never a replacement: the projects still do not come back,
    // and withdrawing that warning exactly where the control is least
    // explicable would be the worse of the two omissions. The list-level note
    // also has to RENDER here even though a wedged registry means there are no
    // rows at all — an `aria-describedby` that resolves to nothing describes
    // nothing.
    expect(describedBy(repair)).toEqual([
      RESEARCH_REPAIR_NOTE_COPY,
      RESEARCH_MUTATE_READ_ONLY_COPY,
    ]);

    const before = send.mock.calls.length;
    fireEvent.click(repair);
    await act(async () => { await Promise.resolve(); });

    // THE HANDLER is what refuses: no request left the browser.
    expect(send.mock.calls.filter(([url]) => url === RESEARCH_REPAIR_PATH)).toHaveLength(0);
    expect(send.mock.calls.length).toBe(before);
  });
});
