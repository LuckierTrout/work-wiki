import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  KnowledgeStudio,
  RESEARCH_COLLECT_READ_ONLY_COPY,
  RESEARCH_CREATE_READ_ONLY_COPY,
  RESEARCH_MUTATE_READ_ONLY_COPY,
} from "@/components/KnowledgeStudio";

/**
 * The Studio's Research desk on a read-only deployment, MOUNTED (DW-386).
 *
 * `POST /api/research`, `POST /api/research/[id]/run`,
 * `DELETE /api/research/[id]` and `POST /api/ingest/batch` have all refused
 * since DW-294/DW-187, while this desk carried no `readOnly` term at all:
 * Create, Run, Cancel, Collect and Delete looked live over four 403s, and
 * **Delete** opened a `window.confirm` onto one.
 *
 * The flag rides on the `GET /api/research` the desk already makes rather than
 * on a prop — `src/app/studio/page.tsx` is an async SERVER component and could
 * have passed one, but a prop is pinned at first render while this desk
 * RE-READS that door on every **Refresh**, so the flag and the projects it
 * gates have to arrive in one answer or they can disagree. That is why the
 * whole component is mounted here rather than a panel in isolation.
 *
 * THREE doors, three sentences: Collect is an INGEST, and saying "Research
 * projects cannot be changed…" beside it would name a refusal that is not the
 * one it meets.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const PROJECT = {
  id: "rp-1",
  title: "Vendor landscape",
  question: "Which vendors matter?",
  queries: ["vendors"],
  sourceUrls: ["https://example.com/report"],
  pageSlugs: [],
  // `queued` so **Cancel** renders at all — it is offered only for a project
  // that is actually in flight.
  status: "queued",
  updatedAt: "2026-08-20T12:00:00.000Z",
};

/** One graph signal, so the Insights panel renders a **Research this →**. */
const INSIGHT = {
  id: "gi-1",
  kind: "orphan-page",
  title: "Nothing links to Pricing",
  summary: "This page is disconnected from the rest of the graph.",
  priority: 2,
  slugs: ["pricing"],
  signals: ["pricing"],
};

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

/**
 * Every read the studio makes on mount, with `/api/research` carrying
 * `readOnly` as the route now serves it.
 *
 * `undefined` means the field is ABSENT — a route that stopped sending it,
 * which must leave the desk working rather than refusing on a missing value.
 */
function stubFetch(
  readOnly: boolean | undefined,
  overrides: { insights?: unknown[] } = {},
) {
  const routes: Record<string, unknown> = {
    "/api/wiki/routes": {},
    "/api/vaults": { vaults: [] },
    "/api/agents?mine=1": { agents: [] },
    "/api/ingest/jobs?limit=16": { jobs: [] },
    "/api/review/proposals?status=pending": { proposals: [] },
    "/api/knowledge/insights?scope=mine": {
      insights: overrides.insights ?? [INSIGHT],
    },
    "/api/research": {
      projects: [PROJECT],
      availableProviders: ["tavily"],
      ...(readOnly === undefined ? {} : { readOnly }),
    },
    "/api/agent-skills": { skills: [] },
    "/api/knowledge/compilation": { contributions: [] },
  };
  fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    // The routes table answers the mount GETs; anything with a METHOD is a
    // write, and every write on this desk answers with a single project. Keyed
    // on the method rather than the path because `/api/research` is BOTH — the
    // desk's read and its create — and a table keyed on path alone answered the
    // create with a project list, which the panel then rendered as `undefined`.
    const write = init?.method !== undefined && init.method !== "GET";
    const body = !write && href in routes
      ? routes[href]
      // A DIFFERENT id from the seeded brief, so a create that lands leaves the
      // list holding two distinct rows rather than two of one key.
      : { project: { ...PROJECT, id: "rp-2", title: "From a graph signal" } };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Requests the desk issued that were not one of the mount GETs. */
function writeCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const method = (call[1] as RequestInit | undefined)?.method;
    return method !== undefined && method !== "GET";
  });
}

/** Open one of the studio's sections — the landing section is Compile. */
async function openDesk(name: string) {
  render(<KnowledgeStudio />);
  await screen.findByRole("region", { name: "Compile" });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("region", { name });
}

async function openResearchDesk() {
  await openDesk("Research desk");
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** The sentence a control names, read OFF the control rather than guessed. */
function announcedFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const node = document.getElementById(id);
      expect(node, id).not.toBeNull();
      return node!.textContent ?? "";
    })
    .join(" ");
}

beforeEach(() => {
  // Defaults to ACCEPTING, so a missing gate shows up as a DELETE request
  // rather than as a dialog nobody answered.
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed — and this tree polls on an interval.
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Research desk refuses on a read-only deployment", () => {
  it("points each control at the sentence ITS OWN door answers", async () => {
    stubFetch(true);
    await openResearchDesk();

    expect(announcedFor(button("Create research brief"))).toBe(
      RESEARCH_CREATE_READ_ONLY_COPY,
    );
    for (const name of ["Run research", "Cancel", "Delete"]) {
      expect(announcedFor(button(name)), name).toBe(RESEARCH_MUTATE_READ_ONLY_COPY);
    }
    // Collect is an INGEST, and says so — the whole reason this desk states
    // three sentences rather than one.
    expect(announcedFor(button(/Collect 1 URLs/))).toBe(
      RESEARCH_COLLECT_READ_ONLY_COPY,
    );
  });

  it("keeps every refused control in the tab order", async () => {
    stubFetch(true);
    await openResearchDesk();

    for (const name of [
      "Create research brief",
      "Run research",
      "Cancel",
      "Delete",
    ] as const) {
      const control = button(name);
      // `aria-disabled`, never `disabled`: the transient guards these buttons
      // already carried (a run in flight, a status that cannot be cancelled)
      // YIELD to the standing refusal, or the sentence beside them could never
      // be announced.
      expect(control.getAttribute("aria-disabled"), name).toBe("true");
      expect(control.hasAttribute("disabled"), name).toBe(false);
    }
    expect(button(/Collect 1 URLs/).getAttribute("aria-disabled")).toBe("true");
    expect(button(/Collect 1 URLs/).hasAttribute("disabled")).toBe(false);
  });

  it("issues no request from any of the five controls", async () => {
    stubFetch(true);
    await openResearchDesk();

    fireEvent.click(button("Run research"));
    fireEvent.click(button("Cancel"));
    fireEvent.click(button(/Collect 1 URLs/));
    fireEvent.click(button("Delete"));
    fireEvent.submit(button("Create research brief").closest("form")!);

    expect(writeCalls()).toEqual([]);
  });

  it("opens no confirm before the refused Delete", async () => {
    stubFetch(true);
    await openResearchDesk();

    fireEvent.click(button("Delete"));

    // The refusal lands BEFORE the dialog: a confirm promising that source
    // documents are left untouched, answered onto a 403, asks the owner to
    // approve something they were never offered (the DW-265 shape).
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("still refuses when an UNRELATED endpoint fails", async () => {
    // The regression this guards. `refresh()` used to settle all eight mount
    // GETs in one `Promise.all`, which rejects on the first failure — so a bad
    // day at `/api/vaults` skipped every `set*` call including `setReadOnly`,
    // and the desk rendered with the flag still `false`: five live controls in
    // front of four 403s, and Delete's `window.confirm` open again. The
    // research read is settled on its own, so the flag is adopted whenever ITS
    // door answered.
    stubFetch(true);
    const answered = fetchMock;
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "/api/vaults") throw new Error("vaults are down");
      return answered(url, init) as Promise<Response>;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<KnowledgeStudio />);
    // The sibling really did fail — asserted BEFORE navigating, because
    // `openSection` clears the feedback banner on the way in. Without this the
    // case could pass against a stub that never fired, which is how a
    // regression test quietly stops testing anything.
    await screen.findByText("vaults are down");
    fireEvent.click(screen.getByRole("button", { name: /Research desk/ }));
    await screen.findByRole("region", { name: "Research desk" });

    expect(button("Delete").getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(button("Delete"))).toBe(RESEARCH_MUTATE_READ_ONLY_COPY);

    fireEvent.click(button("Delete"));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(writeCalls()).toEqual([]);
  });

  it("leaves the brief on screen and readable", async () => {
    stubFetch(true);
    await openResearchDesk();

    expect(screen.getByText("Vendor landscape")).toBeTruthy();
    const title = screen.getByPlaceholderText("Vendor landscape") as HTMLInputElement;
    expect(title.readOnly).toBe(true);
    expect(title.hasAttribute("disabled")).toBe(false);
  });
});

describe("Graph insights' Research this refuses on a read-only deployment", () => {
  it("marks the button, names the CREATE sentence, and posts nothing", async () => {
    // The panel's **Research this →** turns a graph signal into a brief through
    // `POST /api/research` — the same door the desk's Create form meets, so the
    // same sentence. It lives on a different section, which is exactly how it
    // stayed un-pinned while the Research desk's own controls were covered.
    stubFetch(true);
    await openDesk("Graph insights");

    const research = button(/Research this/);
    expect(research.getAttribute("aria-disabled")).toBe("true");
    expect(research.hasAttribute("disabled")).toBe(false);
    expect(announcedFor(research)).toBe(RESEARCH_CREATE_READ_ONLY_COPY);

    fireEvent.click(research);
    expect(writeCalls()).toEqual([]);
  });

  it("says nothing and still posts on a writable deployment", async () => {
    stubFetch(false);
    await openDesk("Graph insights");

    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
    const research = button(/Research this/);
    expect(research.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(research);
    await waitFor(() => expect(writeCalls().length).toBeGreaterThan(0));
    expect(String(writeCalls()[0][0])).toBe("/api/research");
    expect((writeCalls()[0][1] as RequestInit).method).toBe("POST");
  });

  it("says nothing when there is no insight for the sentence to describe", async () => {
    // A read-only deployment with an empty signal list renders no
    // **Research this** at all, so a sentence here would announce the refusal
    // of an operation the owner was never offered, pointing at nothing.
    stubFetch(true, { insights: [] });
    await openDesk("Graph insights");

    expect(screen.queryByRole("button", { name: /Research this/ })).toBeNull();
    expect(screen.queryByText(RESEARCH_CREATE_READ_ONLY_COPY)).toBeNull();
  });
});

describe("the Research desk is unchanged on a writable deployment", () => {
  it("says nothing, refuses nothing, and still deletes", async () => {
    // The control case. Without it every assertion above would also pass
    // against a desk that had simply stopped working.
    stubFetch(false);
    await openResearchDesk();

    for (const copy of [
      RESEARCH_CREATE_READ_ONLY_COPY,
      RESEARCH_MUTATE_READ_ONLY_COPY,
      RESEARCH_COLLECT_READ_ONLY_COPY,
    ]) {
      expect(screen.queryByText(copy), copy).toBeNull();
    }
    expect(button("Delete").hasAttribute("aria-disabled")).toBe(false);
    expect(button("Delete").getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(button("Delete"));
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() => expect(writeCalls().length).toBeGreaterThan(0));
    expect((writeCalls()[0][1] as RequestInit).method).toBe("DELETE");
  });

  it("stays live when the route serves no readOnly field at all", async () => {
    // A route that stopped sending the field must leave the desk working rather
    // than refusing everything on an `undefined` — the server refuses either
    // way, and a refusal invented on the client would be the worse failure.
    stubFetch(undefined);
    await openResearchDesk();

    expect(screen.queryByText(RESEARCH_MUTATE_READ_ONLY_COPY)).toBeNull();
    expect(button("Delete").hasAttribute("aria-disabled")).toBe(false);
  });
});
