import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SourceMonitorDesk } from "@/components/SourceMonitorDesk";
import { unconfirmedWriteMessage } from "@/lib/workbench-request";

/**
 * The OTHER ordering class, mounted (DW-717).
 *
 * The adopting sites fall into two shapes, and the difference is not cosmetic —
 * it decides whether the owner ever reads the sentence at all:
 *
 *   - SENTENCE THEN REFETCH, where the loader leaves the message slot alone on
 *     the way in. `NamesTermsSettings`, `MonitorDigestPanel`,
 *     `AgentWorkspaceDesk`, `LocalSyncPanel`.
 *     `names-terms-unconfirmed-write.test.tsx` executes that class.
 *   - REFETCH THEN SENTENCE, where the loader OPENS with `setError(null)` — so
 *     a sentence set first is wiped by the very reconciliation it asks for, and
 *     the owner is left in front of a screen that says nothing happened at all.
 *     `SystemHealthDesk`, `IntegrationDesk`, `KnowledgeAtlas`, `ReviewDesk`,
 *     this desk, `ActionInbox`, `ChatWorkspace`, `KnowledgeStudio`.
 *
 * Nothing executed the second class, so swapping those two lines at any of
 * those eight left the owner with no message and every suite green. This is
 * that case: `SourceMonitorDesk.load` begins `setError(null)`, so the first
 * assertion below fails the moment the order is reversed.
 *
 * Everything is asserted on the outermost surface: what is on screen, and what
 * requests went out.
 */

const MONITOR = {
  id: "mon-1",
  owner: "owner",
  name: "Quarterly brief",
  url: "https://example.com/brief",
  targetSlug: "product-roadmap",
  cadence: "daily" as const,
  state: "active" as const,
  meaningfulChangeThreshold: 0.2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  nextCheckAt: null,
};

/** The action phrase `addMonitor` hands `writeFailure`. */
const ADD_ACTION = "add this source";

let fetchMock: ReturnType<typeof vi.fn>;

function listAnswer() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ monitors: [MONITOR] }),
  } as unknown as Response;
}

function calls(method: string | undefined): unknown[][] {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === method,
  );
}

const reads = () => calls(undefined);
const posts = () => calls("POST");

/** Fill the three required fields and submit. The button is dead without them. */
function addSource() {
  fireEvent.change(screen.getByPlaceholderText("Quarterly product brief"), {
    target: { value: "Pricing page" },
  });
  fireEvent.change(screen.getByPlaceholderText("product-roadmap"), {
    target: { value: "pricing" },
  });
  fireEvent.change(screen.getByPlaceholderText("https://example.com/brief"), {
    target: { value: "https://example.com/pricing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add source" }));
}

beforeEach(() => {
  fetchMock = vi.fn(async () => listAnswer());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("a refetch-then-sentence site keeps its unknown-outcome sentence (DW-717)", () => {
  it("survives the reconciliation it asks for when the 2xx body read dies", async () => {
    render(<SourceMonitorDesk />);
    await screen.findByText("Quarterly brief");
    const readsBefore = reads().length;

    // The 200 arrived and the body read then died. The monitor may be stored in
    // full, so the list on screen is the stale one.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error("signal timed out"), {
          name: "TimeoutError",
        });
      },
    } as unknown as Response);

    addSource();

    // The reconciliation goes out…
    await waitFor(() => expect(reads().length).toBe(readsBefore + 1));
    // …and the sentence is still there afterwards. `load` opens with
    // `setError(null)`, so this is the assertion that fails if the two lines
    // are ever swapped back.
    expect(await screen.findByText(unconfirmedWriteMessage(ADD_ACTION))).toBeTruthy();
    // Never a failure claim, and exactly one POST.
    expect(screen.queryByText(/Couldn’t add this source\./)).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("reports a gateway status as the same unknown outcome", async () => {
    // 502: a proxy answering where the route did not. The monitor may exist.
    // This is what carrying the STATUS on the thrown error buys — with a bare
    // `Error` only `Request failed (502)` survives, and `unconfirmedCause`
    // cannot read a status out of a sentence.
    render(<SourceMonitorDesk />);
    await screen.findByText("Quarterly brief");
    const readsBefore = reads().length;

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as unknown as Response);

    addSource();

    await waitFor(() => expect(reads().length).toBe(readsBefore + 1));
    expect(await screen.findByText(unconfirmedWriteMessage(ADD_ACTION))).toBeTruthy();
    expect(screen.queryByText(/502/)).toBeNull();
  });

  it("relays a STATED refusal unchanged, and reconciles nothing", async () => {
    // A 400 the route composed: it ran, it decided, it said so. Reconciling
    // would be a request made for no reason, over a screen already correct.
    render(<SourceMonitorDesk />);
    await screen.findByText("Quarterly brief");
    const readsBefore = reads().length;

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "That page slug does not exist." }),
    } as unknown as Response);

    addSource();

    expect(
      await screen.findByText("That page slug does not exist."),
    ).toBeTruthy();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(reads().length).toBe(readsBefore);
  });
});
