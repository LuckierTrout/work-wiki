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
import { RESEARCH_POLL_MS } from "@/lib/research-panel";
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
  it("refuses the start control and offers no Cancel", async () => {
    send.mockResolvedValue({ projects: [project({ status: "collecting" })] });

    render(<ResearchCanvas wikiId="current" readOnly />);

    await screen.findByRole("heading", { name: "Launch evidence" });
    const start = screen.getByRole("button", { name: "Start Deep Research" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    // The reason names the DEPLOYMENT, not the form: an owner who typed a topic
    // and a query would otherwise read "add a topic".
    expect(screen.getByText("Deep Research cannot start while this deployment is read-only."))
      .toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect((screen.getByLabelText("Topic") as HTMLInputElement).readOnly).toBe(true);
  });
});
