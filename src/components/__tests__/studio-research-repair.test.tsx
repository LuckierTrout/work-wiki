import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KnowledgeStudio } from "@/components/KnowledgeStudio";
import {
  RESEARCH_REPAIRED_COPY,
  RESEARCH_REPAIR_LABEL,
  RESEARCH_REPAIR_NOTE_COPY,
  RESEARCH_REPAIR_PATH,
} from "@/lib/research-panel";
import { REPAIR_HINT } from "@/lib/research-projects";

/**
 * The Studio's way out of a wedged research registry, MOUNTED (DW-688).
 *
 * A tenant whose `research-projects.json` `parseRegistry` refuses meets a 500
 * on EVERY research door — the reads, the create, and the DELETEs that could
 * have shrunk the file — and every one of those refusals ends by naming
 * `POST /api/research/repair`. Until this story nothing in the product
 * performed that POST: the desk rendered the store's sentence verbatim and left
 * the owner holding an instruction addressed to somebody with a terminal.
 *
 * MOUNTED rather than asserted as copy, because what is under test is the
 * WIRING: the control is offered off the failure the desk is already holding,
 * it posts exactly once, the desk re-reads, and the banner only then claims a
 * success. The sentences themselves are pinned in `research-panel.test.ts`.
 *
 * WHY NO READ-ONLY MIRROR IS ASSERTED HERE. This desk adopts `readOnly` only
 * from a `GET /api/research` that SUCCEEDED — the failure branch leaves the
 * flag untouched, on purpose — and this control exists only when that GET
 * FAILED, so the flag is stale by construction at this call site. The 403's own
 * sentence lands in this same banner instead, which is the last case below.
 * `ResearchCanvas` takes `readOnly` as a trustworthy prop and does get the full
 * DW-644 treatment; `research-panel-canvas.test.tsx` pins that half.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/** What `GET /api/research` answers for a registry that will not parse. */
const WEDGED = `Research projects file is unreadable.${REPAIR_HINT}`;

/** The repair door's own 409 — a file that reads fine and needed nothing. */
const NOTHING_TO_REPAIR =
  "The research projects file reads fine; there is nothing to repair.";

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Every read the studio makes on mount, with `/api/research` refusing until the
 * repair lands.
 *
 * `researchError` is re-read on each call rather than captured, so the state
 * the repair changes is visible to the RE-READ the handler makes — which is the
 * thing being asserted.
 */
function stubFetch(options: {
  researchError: string | null;
  repair?: { ok: boolean; status?: number; error?: string; heals?: boolean };
  /** One of the desk's OTHER seven reads, failing. Nothing to do with research. */
  failRoute?: { href: string; error: string };
}) {
  let researchError = options.researchError;
  const routes: Record<string, unknown> = {
    "/api/wiki/routes": {},
    "/api/vaults": { vaults: [] },
    "/api/agents?mine=1": { agents: [] },
    "/api/ingest/jobs?limit=16": { jobs: [] },
    "/api/review/proposals?status=pending": { proposals: [] },
    "/api/knowledge/insights?scope=mine": { insights: [] },
    "/api/agent-skills": { skills: [] },
    "/api/knowledge/compilation": { contributions: [] },
  };
  fetchMock = vi.fn(async (url: unknown) => {
    const href = String(url);
    if (href === RESEARCH_REPAIR_PATH) {
      const repair = options.repair ?? { ok: true };
      if (repair.ok) {
        // The registry is no longer wedged for the re-read the handler makes
        // immediately after this resolves — unless the case under test is the
        // one where it is (`heals: false`).
        if (repair.heals !== false) researchError = null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ repaired: true, quarantinedPath: "…corrupt-1" }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: repair.status ?? 409,
        json: async () => ({ error: repair.error ?? NOTHING_TO_REPAIR }),
      } as unknown as Response;
    }
    if (href === "/api/research") {
      if (researchError !== null) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: researchError }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ projects: [], availableProviders: ["tavily"], readOnly: false }),
      } as unknown as Response;
    }
    if (options.failRoute && href === options.failRoute.href) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: options.failRoute!.error }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => (href in routes ? routes[href] : {}),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Every request the desk aimed at the repair door. */
function repairCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === RESEARCH_REPAIR_PATH);
}

function banner(): HTMLElement {
  return screen.getByRole("status");
}

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Studio offers a way out of a wedged research registry", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("shows the store's sentence AND a control the owner can press", async () => {
    stubFetch({ researchError: WEDGED });

    render(<KnowledgeStudio />);

    // The diagnosis is unchanged — the element index and the parser's offset are
    // still the first thing read. The control is an addition to it.
    await waitFor(() => expect(banner().textContent).toContain(WEDGED));
    expect(banner().className).toContain("error");
    const repair = screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL });
    // …and the note that says what pressing it costs is what the button names.
    const noteId = repair.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent).toBe(RESEARCH_REPAIR_NOTE_COPY);
  });

  it("posts once, re-reads the desk, and only then claims the file was set aside", async () => {
    stubFetch({ researchError: WEDGED });
    render(<KnowledgeStudio />);
    await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });
    const readsBefore = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === "/api/research",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    await waitFor(() => expect(banner().textContent).toContain(RESEARCH_REPAIRED_COPY));
    expect(banner().className).toContain("success");
    // EXACTLY ONE. A repair is destructive — it quarantines the tenant's bytes
    // and restarts empty — so a double-fire would strand a second copy.
    expect(repairCalls()).toHaveLength(1);
    expect((repairCalls()[0][1] as RequestInit).method).toBe("POST");
    // The desk RE-READ: the banner sits above a list, and claiming the file was
    // replaced over the list from before the replacement would be a lie about
    // what is on screen.
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/research").length,
    ).toBeGreaterThan(readsBefore);
    // The failure — and with it the control — is gone.
    expect(banner().textContent).not.toContain(WEDGED);
    expect(screen.queryByRole("button", { name: RESEARCH_REPAIR_LABEL })).toBeNull();
  });

  it("lets the re-read's own failure stand rather than painting a success over it", async () => {
    // The repair landed — the door said 200 — but the desk re-reads before it
    // says anything, and that read found the registry wedged again. Claiming
    // the success unconditionally would paint over the sentence AND take the
    // **Repair** control off the screen, leaving the owner inside a working
    // failure with the way out hidden behind a Refresh they have no reason to
    // press.
    stubFetch({ researchError: WEDGED, repair: { ok: true, heals: false } });
    render(<KnowledgeStudio />);
    await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });

    fireEvent.click(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    await waitFor(() => expect(repairCalls()).toHaveLength(1));
    await waitFor(() => expect(banner().className).toContain("error"));
    expect(banner().textContent).toContain(WEDGED);
    expect(banner().textContent).not.toContain(RESEARCH_REPAIRED_COPY);
    // …and the way out is still on screen.
    expect(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL })).toBeTruthy();
  });

  it("still states the repair when an UNRELATED read failed", async () => {
    // `refresh` writes any of its eight reads' failures into the one shared
    // banner, so suppressing the success claim on "the banner holds a failure"
    // meant an `/api/vaults` hiccup could hide the fact that an irreversible
    // quarantine had just happened. Only the registry still refusing to parse
    // contradicts this claim; a failure about some other door does not.
    stubFetch({
      researchError: WEDGED,
      failRoute: { href: "/api/vaults", error: "Vaults are having a bad day." },
    });
    render(<KnowledgeStudio />);
    await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });

    fireEvent.click(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    await waitFor(() => expect(banner().textContent).toContain(RESEARCH_REPAIRED_COPY));
    expect(banner().className).toContain("success");
  });

  it("keeps the way out on screen when the repair door says RETRY", async () => {
    // 503 "Research projects were busy; retry the request." carries no
    // `REPAIR_HINT`, so a control offered off the CURRENT sentence alone
    // vanished the moment the owner was told to retry — and this desk does not
    // poll, so only a manual Refresh brought it back. That is DW-688's own
    // defect one layer down: an instruction to retry with nothing behind it.
    // The control is offered off the registry's remembered state instead.
    const BUSY = "Research projects were busy; retry the request.";
    stubFetch({ researchError: WEDGED, repair: { ok: false, status: 503, error: BUSY } });
    render(<KnowledgeStudio />);
    await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });

    fireEvent.click(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    await waitFor(() => expect(banner().textContent).toContain(BUSY));
    // The retry it asks for has something to press.
    const again = screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL });
    expect(again).toBeTruthy();
    expect((again as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(repairCalls()).toHaveLength(2));
  });

  it("relays the door's own refusal rather than claiming a repair", async () => {
    // 409 is the one that matters: a mis-aimed repair must not read as a
    // success, and the client cannot tell 409 from 503, 403 or 500.
    stubFetch({ researchError: WEDGED, repair: { ok: false, status: 409 } });
    render(<KnowledgeStudio />);
    await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });

    fireEvent.click(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    await waitFor(() => expect(banner().textContent).toContain(NOTHING_TO_REPAIR));
    expect(banner().className).toContain("error");
    expect(banner().textContent).not.toContain(RESEARCH_REPAIRED_COPY);
  });

  it("relays a read-only deployment's 403 instead of guessing at a stale flag", async () => {
    // The reason this desk derives no `aria-disabled`: its `readOnly` is adopted
    // only from a research GET that SUCCEEDED, and this control exists only
    // because one failed. The door answers, and its sentence lands in the same
    // banner the control sits in.
    const REFUSAL = "Research projects cannot be changed while this deployment is read-only.";
    stubFetch({
      researchError: WEDGED,
      repair: { ok: false, status: 403, error: REFUSAL },
    });
    render(<KnowledgeStudio />);
    await screen.findByRole("button", { name: RESEARCH_REPAIR_LABEL });

    fireEvent.click(screen.getByRole("button", { name: RESEARCH_REPAIR_LABEL }));

    await waitFor(() => expect(banner().textContent).toContain(REFUSAL));
    expect(repairCalls()).toHaveLength(1);
  });

  it("offers nothing for a research failure the repair would not fix", async () => {
    // Repairing throws the tenant's projects away. Offering it in front of an
    // unrelated failure would be an invitation to do that for no reason.
    stubFetch({ researchError: "Research projects were busy; retry the request." });

    render(<KnowledgeStudio />);

    await waitFor(() =>
      expect(banner().textContent).toContain("Research projects were busy"),
    );
    expect(screen.queryByRole("button", { name: RESEARCH_REPAIR_LABEL })).toBeNull();
    expect(screen.queryByText(RESEARCH_REPAIR_NOTE_COPY)).toBeNull();
    expect(repairCalls()).toHaveLength(0);
  });
});
