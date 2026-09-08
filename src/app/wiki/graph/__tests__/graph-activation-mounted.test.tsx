import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import GraphPage from "@/app/wiki/graph/page";
import { useGraphSimulation } from "@/hooks/useGraphSimulation";
import { renderGraph } from "@/lib/graph-render";

/**
 * The graph canvas's TWO activation paths, executed against the REAL
 * `useGraphSimulation` (DW-595/596).
 *
 * `graph-escape-hatch-mounted.test.tsx` mocks the hook, which is the right
 * choice for the questions it asks — it is about the markup the page puts in
 * the tab order — but it means nothing in the repo observed that the canvas's
 * `onClick` was wired to anything at all: deleting the prop left the surface
 * inert with every accessibility assertion still green (DW-596). And the
 * keyboard path DW-595 added has the same exposure twice over, because its
 * whole promise is a comparison — "Enter opens the page a click opens" — which
 * a stubbed hook cannot be asked about, since the stub is where the URL would
 * come from.
 *
 * So this file mocks only what the ENVIRONMENT does not provide: Clerk (the
 * page reads a signed-in state), `next/navigation` (the router is the thing
 * being observed), and `fetch` (the graph data). `useGraphSimulation` itself
 * runs.
 *
 * WHY THE COORDINATES WORK. Two environment facts hold this together, and both
 * are properties of jsdom rather than of the code under test:
 *
 *   - `canvas.getContext("2d")` returns `null` here, so the hook's `simulate()`
 *     returns before `stepPhysics` and node positions stay EXACTLY where the
 *     fetch handler initialised them. Nothing drifts between the fetch and the
 *     click.
 *   - `getBoundingClientRect()` is all-zeros, so a client coordinate is a
 *     canvas coordinate: `e.clientX - rect.left === e.clientX`.
 *
 * With `Math.random` pinned to 0, every node initialises at
 * `(0 * 400 + 100, 0 * 300 + 100)` — that is, all of them at (100, 100). A
 * click at client (100, 100) therefore hits the FIRST node in the array, which
 * is `handleClick`'s own loop order, and the same node the keyboard cursor
 * starts on. That coincidence is the point: it is what lets one test compare
 * the two paths' `router.push` arguments directly.
 *
 * FIDELITY LIMIT: with no 2D context there is no drawn scene to inspect, so
 * nothing here reads PIXELS. The ring is pinned in two halves instead: that it
 * is stroked around the cursor node, and only when one is passed, in
 * `src/lib/__tests__/graph-render.test.ts` against a mock context; and that the
 * hook hands `renderGraph` a cursor only while the canvas holds focus, in the
 * last describe below, which stubs `getContext` so the render pass runs at all.
 * The rest of this file pins what a keyboard reader depends on regardless of
 * the drawing: where the cursor is, what is announced, and what Enter opens.
 */

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

/**
 * Only `renderGraph` is replaced; everything else in the module — `nodeRadius`,
 * `connectionsLabel`, `stepPhysics`, the palettes — is the real thing, because
 * the hook's hit test, its announcement wording and its physics all run against
 * it.
 *
 * Inert for every describe but the cursor-drawing one: with jsdom's
 * `getContext` returning `null`, `simulate()` returns before it would ever call
 * this.
 */
vi.mock("@/lib/graph-render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph-render")>()),
  renderGraph: vi.fn(),
}));

/**
 * Three nodes, because every claim below needs a set the cursor can WRAP
 * around, and two nodes make "forward from the last" and "back from the first"
 * the same move. Distinct tenants and link counts, so a URL or an announcement
 * built from the wrong node reads as the wrong node rather than as a
 * coincidence — and `Beta`'s single link is what exercises the singular branch
 * of the connection-count wording.
 */
const NODES = [
  { id: "alpha", label: "Alpha", tenant: "yopedia", linkCount: 2, tags: [] },
  { id: "beta", label: "Beta", tenant: "yopedia", linkCount: 1, tags: [] },
  { id: "gamma", label: "Gamma", tenant: "otherhandle", linkCount: 0, tags: [] },
];

/** The URL each node's activation must produce, spelled once. */
const HREF_OF = NODES.map((n) => `/u/${n.tenant}/${n.id}`);

function graphResponse(nodes: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ nodes, edges: [] }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pushMock.mockClear();
  vi.mocked(renderGraph).mockClear();
  // Every node at (100, 100) — see the header.
  vi.spyOn(Math, "random").mockReturnValue(0);
  fetchMock = vi.fn(async () => graphResponse(NODES));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Mount the page and wait for the fetch to land, returning the canvas.
 *
 * The canvas renders on ONE branch of the hook (`loading: false`,
 * `empty: false`, `fetchError: null`), so waiting for it is also the assertion
 * that the real hook reached that branch — a fetch shape it rejected would fail
 * here rather than in whatever read came next.
 */
async function mountGraph(): Promise<HTMLCanvasElement> {
  render(<GraphPage />);
  const canvas = await screen.findByRole("img");
  return canvas as HTMLCanvasElement;
}

/** The page's live region, whatever it currently says. */
function announcement(): string {
  return screen.getByRole("status").textContent ?? "";
}

/**
 * Focus the canvas the way a keyboard reader does, rather than by dispatching a
 * synthetic `focus`.
 *
 * `HTMLElement.focus()` is what moves `document.activeElement`, and it is also
 * what makes the subsequent `blur()` meaningful — a synthetic focus event
 * leaves the document's real focus untouched, so a "blur clears it" case would
 * be blurring an element that was never focused.
 */
function focusCanvas(canvas: HTMLCanvasElement): void {
  act(() => {
    canvas.focus();
  });
}

function blurCanvas(canvas: HTMLCanvasElement): void {
  act(() => {
    canvas.blur();
  });
}

/**
 * Press a key on the canvas and hand back the event, so a case can read
 * `defaultPrevented` off the very event the handler saw.
 *
 * Constructed rather than driven through `fireEvent.keyDown(el, { key })`
 * because the return value of that helper is a bare boolean: it says the event
 * was cancelled without saying which event, and a case asserting BOTH a
 * navigation and a cancellation wants the two facts to come from one press.
 */
function pressKey(
  canvas: HTMLCanvasElement,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  fireEvent(canvas, event);
  return event;
}

/**
 * Give the nodes DISTINCT positions, by feeding `Math.random` the values the
 * fetch handler is about to consume.
 *
 * `useGraphSimulation` initialises each node as
 * `x = random() * 400 + 100, y = random() * 300 + 100`, in array order, so the
 * draws are two per node and their order is the node order. `mockReturnValueOnce`
 * queues ahead of the `mockReturnValue(0)` the fixture installed, which stays
 * behind as the fallback for anything else that asks (community detection runs
 * after this and must not be able to steal a queued value).
 *
 * Call it BEFORE `render`. Returns the canvas coordinate each node will end up
 * at, so a case clicks a computed point rather than a restated one.
 */
function positionNodes(fractions: [number, number][]): { x: number; y: number }[] {
  const random = Math.random as unknown as ReturnType<typeof vi.fn>;
  for (const [fx, fy] of fractions) {
    random.mockReturnValueOnce(fx).mockReturnValueOnce(fy);
  }
  return fractions.map(([fx, fy]) => ({ x: fx * 400 + 100, y: fy * 300 + 100 }));
}

/**
 * Three well-separated points. The largest node here has `linkCount: 2`, so a
 * radius under 12px plus the hit test's 4px slop — these are hundreds of pixels
 * apart, and no click below is ambiguous about which node it means.
 */
const SPREAD: [number, number][] = [
  [0, 0],
  [0.5, 0.5],
  [1, 1],
];

/**
 * A router stub for the cases that drive the hook directly with `renderHook`
 * rather than through the mounted page, which has `next/navigation` mocked for
 * it. Module scope because two describes below need one.
 */
function router() {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  };
}

describe("the graph canvas opens a page on click (DW-596)", () => {
  it("navigates to the node under the pointer", async () => {
    const canvas = await mountGraph();

    fireEvent.click(canvas, { clientX: 100, clientY: 100 });

    // Not just "push was called": the ARGUMENT is the whole claim, and a
    // handler wired to the wrong node would still call the router.
    expect(
      pushMock.mock.calls,
      "clicking the node at (100, 100) did not push its page — the canvas's onClick is not " +
        "reaching useGraphSimulation's handleClick (DW-596)",
    ).toEqual([[HREF_OF[0]]]);
  });

  it("navigates nowhere when the click hits no node", async () => {
    const canvas = await mountGraph();

    // Far from (100, 100) — outside every node's radius plus the 4px slop the
    // hit test allows.
    fireEvent.click(canvas, { clientX: 400, clientY: 400 });

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("picks the node the pointer is actually on, not the first one", async () => {
    // The degenerate geometry every other case here relies on — all three
    // nodes stacked at (100, 100) — cannot tell "hit-tests the pointer" from
    // "always returns nodes[0]", because under it the two answers are the same
    // node. This is the case that separates them, and the only one that spreads
    // the nodes out.
    const at = positionNodes(SPREAD);
    const canvas = await mountGraph();

    fireEvent.click(canvas, { clientX: at[1].x, clientY: at[1].y });

    expect(
      pushMock.mock.calls,
      "a click on the SECOND node did not open the second node's page — the hit test is not " +
        "distinguishing nodes by position",
    ).toEqual([[HREF_OF[1]]]);
  });
});

describe("the graph canvas has a keyboard node cursor (DW-595)", () => {
  it("announces the first node when the canvas takes focus", async () => {
    const canvas = await mountGraph();

    expect(
      announcement(),
      "the live region is not empty before the canvas is focused, so a reader is told about a " +
        "cursor that does not exist yet",
    ).toBe("");

    focusCanvas(canvas);

    // Label, connection count, position and the key that opens it — the four
    // things a reader who cannot see the picture has no other source for.
    const said = announcement();
    expect(said).toContain("Alpha");
    expect(said).toContain("2 connections");
    expect(said).toContain("1 of 3");
    expect(said).toMatch(/Enter/);
  });

  it("moves the cursor forward on ArrowRight and ArrowDown", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const right = pressKey(canvas, "ArrowRight");
    expect(announcement()).toContain("Beta");
    expect(announcement()).toContain("2 of 3");
    // Beta has ONE link, and the singular is a branch the plural cases can
    // never reach. The trailing comma is what makes the read exact: without it
    // "1 connections" contains "1 connection" and would pass.
    expect(
      announcement(),
      "the announcement says \"1 connections\" — the connection-count wording is not going " +
        "through connectionsLabel",
    ).toContain("1 connection,");
    expect(
      right.defaultPrevented,
      "ArrowRight was not prevented, so the page scrolls out from under a reader moving the cursor",
    ).toBe(true);

    const down = pressKey(canvas, "ArrowDown");
    expect(announcement()).toContain("Gamma");
    expect(announcement()).toContain("3 of 3");
    expect(down.defaultPrevented).toBe(true);
  });

  it("moves the cursor back on ArrowLeft and ArrowUp", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    pressKey(canvas, "ArrowRight");
    pressKey(canvas, "ArrowRight");
    expect(announcement()).toContain("3 of 3");

    const left = pressKey(canvas, "ArrowLeft");
    expect(announcement()).toContain("2 of 3");
    expect(left.defaultPrevented).toBe(true);

    const up = pressKey(canvas, "ArrowUp");
    expect(announcement()).toContain("1 of 3");
    expect(up.defaultPrevented).toBe(true);
  });

  it("wraps at both ends rather than going dead", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    // Backwards off the front.
    pressKey(canvas, "ArrowLeft");
    expect(
      announcement(),
      "ArrowLeft on the first node did not wrap to the last — a clamped arrow reads as a broken " +
        "control, since the node order carries no meaning that would tell a reader they are at " +
        "the end",
    ).toContain("3 of 3");

    // Forwards off the back.
    pressKey(canvas, "ArrowRight");
    expect(announcement()).toContain("1 of 3");
  });

  it("leaves keys it does not handle alone", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const tab = pressKey(canvas, "Tab");
    expect(
      tab.defaultPrevented,
      "the canvas cancelled Tab, which is the key a reader leaves it with",
    ).toBe(false);
    // And the cursor did not move.
    expect(announcement()).toContain("1 of 3");
  });

  it("leaves a MODIFIED arrow to the browser", async () => {
    // Alt+Arrow is Back/Forward, Ctrl+Arrow is a word jump, Cmd+Arrow is
    // line-start/end. A canvas that claimed those would both move its cursor
    // and cancel the shortcut — the same key doing two things at once, one of
    // them invisibly. Alt stands in for all three; the guard reads them
    // together.
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const alt = pressKey(canvas, "ArrowRight", { altKey: true });

    expect(
      alt.defaultPrevented,
      "Alt+ArrowRight was cancelled, so the browser's Forward shortcut no longer works while " +
        "the graph has focus",
    ).toBe(false);
    expect(
      announcement(),
      "Alt+ArrowRight moved the keyboard cursor — a modified press belongs to the browser",
    ).toContain("1 of 3");
  });

  it("clears the announcement on blur and announces again on refocus", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);
    pressKey(canvas, "ArrowRight");
    expect(announcement()).toContain("Beta");

    blurCanvas(canvas);
    expect(
      announcement(),
      "the live region still names a node after the canvas lost focus — it is describing a " +
        "cursor that is no longer drawn",
    ).toBe("");

    focusCanvas(canvas);
    expect(
      announcement(),
      "refocusing did not announce again, so a reader returning to the graph is told nothing",
    ).toContain("Beta");
  });
});

describe("both activation paths open the same page (DW-595)", () => {
  it("Enter opens exactly what a click on the same node opens", async () => {
    const canvas = await mountGraph();

    // The pointer path first, so the expected URL is the one the CLICK
    // produced rather than one restated here.
    fireEvent.click(canvas, { clientX: 100, clientY: 100 });
    const clicked = pushMock.mock.calls.at(-1);
    expect(clicked, "the click path produced no navigation to compare against").toBeDefined();

    focusCanvas(canvas);
    const enter = pressKey(canvas, "Enter");

    expect(
      pushMock.mock.calls.at(-1),
      "Enter on the cursor's node did not push the same page a click on it does — the two paths " +
        "have diverged, which is what routing both through one openNode is meant to prevent",
    ).toEqual(clicked);
    expect(enter.defaultPrevented).toBe(true);
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it("Space activates the cursor too", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);
    pressKey(canvas, "ArrowRight");

    const space = pressKey(canvas, " ");

    expect(pushMock.mock.calls).toEqual([[HREF_OF[1]]]);
    expect(
      space.defaultPrevented,
      "Space was not prevented, so activating a node also scrolls the page",
    ).toBe(true);
  });

  it("leaves a MODIFIED Enter to the browser", async () => {
    // Cmd/Ctrl+Enter is "open in a new tab". Handling it would replace the
    // current page instead — a same-tab navigation the reader did not ask for.
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const modified = pressKey(canvas, "Enter", { metaKey: true });

    expect(pushMock).not.toHaveBeenCalled();
    expect(modified.defaultPrevented).toBe(false);
  });

  it("navigates once while the activation key is held down", async () => {
    // A held key auto-repeats, and `repeat: true` is how the browser says so.
    // Without the guard every repeat is another `router.push` of the same
    // route, which is a history stack full of one page.
    const canvas = await mountGraph();
    focusCanvas(canvas);

    pressKey(canvas, "Enter");
    const repeated = pressKey(canvas, "Enter", { repeat: true });

    expect(
      pushMock,
      "a held Enter navigated more than once — the auto-repeat guard is gone",
    ).toHaveBeenCalledTimes(1);
    // The press is still the canvas's — it just does not navigate twice.
    expect(repeated.defaultPrevented).toBe(true);
  });

  it("still repeats the ARROW keys, which is how a big graph is crossed", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    pressKey(canvas, "ArrowRight", { repeat: true });
    pressKey(canvas, "ArrowRight", { repeat: true });

    expect(
      announcement(),
      "a held arrow stopped moving the cursor — the repeat guard is meant to cover the " +
        "activation keys only",
    ).toContain("3 of 3");
  });

  it("navigates nowhere when Enter arrives with no cursor", async () => {
    const canvas = await mountGraph();

    // No focus, so nothing is selected. `handleKeyDown` must not invent a
    // cursor for an activation key the way it does for an arrow.
    const enter = pressKey(canvas, "Enter");

    expect(pushMock).not.toHaveBeenCalled();
    expect(
      enter.defaultPrevented,
      "Enter was cancelled even though there was no node to open — an unhandled key keeps its " +
        "default",
    ).toBe(false);
  });
});

describe("a click seats the keyboard cursor on the node it hit (DW-751)", () => {
  /**
   * Why any of this is observable at all: a `tabIndex={0}` canvas takes focus
   * on mousedown, so a click ALREADY seats a cursor — `handleFocus` puts it on
   * the FIRST node regardless of which node was clicked. So the choice was
   * never "cursor or no cursor after a click", it was "the clicked node or the
   * first one", and the live region is the standing description of where the
   * cursor is.
   *
   * EVERY case here spreads the nodes with `positionNodes(SPREAD)`. Under this
   * file's default geometry all three stack at (100, 100), which makes "the
   * clicked node" and "the first node" the same node — the one arrangement in
   * which a `handleClick` that seats nothing looks identical to one that seats
   * correctly, since `handleFocus` seated the first node anyway.
   */

  it("announces the clicked node, not the one focus landed on", async () => {
    const at = positionNodes(SPREAD);
    const canvas = await mountGraph();
    focusCanvas(canvas);
    expect(announcement()).toContain("1 of 3");

    fireEvent.click(canvas, { clientX: at[1].x, clientY: at[1].y });

    // The navigation is unchanged — the same openNode, the same URL.
    expect(pushMock.mock.calls).toEqual([[HREF_OF[1]]]);
    const said = announcement();
    expect(
      said,
      "the live region still names the node FOCUS landed on after a click on a different node " +
        "— it is describing a cursor position the reader never chose (DW-751)",
    ).toContain("Beta");
    expect(said).toContain("2 of 3");
    // The same wording an arrow press produces, because both go through
    // describeCursor: a second copy in the click path is the same defect said
    // twice.
    expect(said).toContain("1 connection,");
    expect(said).toMatch(/Enter/);
  });

  it("resumes an arrow press from the clicked node", async () => {
    // The acceptance criterion: click the second node, press ArrowRight, land
    // on the third. Without the seat the cursor is still at 0 and this
    // announces "2 of 3".
    const at = positionNodes(SPREAD);
    const canvas = await mountGraph();
    focusCanvas(canvas);

    fireEvent.click(canvas, { clientX: at[1].x, clientY: at[1].y });
    pressKey(canvas, "ArrowRight");

    const said = announcement();
    expect(
      said,
      "ArrowRight after a click on the SECOND node did not land on the third — the keyboard " +
        "resumed from where focus seeded the cursor rather than from the node the reader just " +
        "acted on (DW-751)",
    ).toContain("Gamma");
    expect(said).toContain("3 of 3");
  });

  it("leaves the cursor alone when the click hits nothing", async () => {
    positionNodes(SPREAD);
    const canvas = await mountGraph();
    focusCanvas(canvas);
    pressKey(canvas, "ArrowRight");
    expect(announcement()).toContain("Beta");

    // SPREAD puts the nodes at (100, 100), (300, 250) and (500, 400). The
    // NEAREST of those to (400, 100) is the middle one, ~180px away; the
    // others are 300px and ~316px. The biggest hit radius in this fixture is
    // `nodeRadius(2)` ≈ 11.7px plus the test's 4px slop, so ~16px — every
    // node is more than ten times that away.
    fireEvent.click(canvas, { clientX: 400, clientY: 100 });

    expect(pushMock).not.toHaveBeenCalled();
    expect(
      announcement(),
      "a click on empty canvas moved the keyboard cursor — the seat is not gated on the hit " +
        "test, so an aimless click throws away the reader's position",
    ).toContain("Beta");
    expect(announcement()).toContain("2 of 3");
  });

  it("returns to the clicked node when the canvas is refocused", async () => {
    const at = positionNodes(SPREAD);
    const canvas = await mountGraph();
    focusCanvas(canvas);

    fireEvent.click(canvas, { clientX: at[1].x, clientY: at[1].y });
    blurCanvas(canvas);
    expect(announcement()).toBe("");

    focusCanvas(canvas);

    expect(
      announcement(),
      "refocusing after a click announced the FIRST node — the click wrote no index for blur " +
        "to preserve, so the pointer's position did not survive leaving the canvas",
    ).toContain("Beta");
  });

  it("seats the cursor BEFORE it navigates", async () => {
    /**
     * The ordering is claimed in three places — `handleClick`'s comment, this
     * bundle's spec, and its Code Map — and every other case here is blind to
     * it, because `router.push` is an inert mock: with the seat moved after
     * `openNode` both lines still run and the suite stays green.
     *
     * A router whose `push` THROWS is what separates them. Navigation is the
     * last thing this handler does, so nothing that must happen first may be
     * behind it; a `push` that does not return is the cheapest way to say so.
     * (In a browser the equivalent is a real navigation committing — the
     * handler does not get a second chance to write the cursor.) Driven
     * through `renderHook` rather than the page, since the page's router is
     * the module mock every other case reads.
     */
    const at = positionNodes(SPREAD);
    const canvasRef = { current: document.createElement("canvas") };
    const nav = router();
    nav.push.mockImplementation(() => {
      throw new Error("navigated");
    });

    const { result } = renderHook(() =>
      useGraphSimulation(
        canvasRef,
        nav as unknown as Parameters<typeof useGraphSimulation>[1],
      ),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Caught INSIDE `act`, not around it: a throw that escapes `act` leaves
    // the render it queued uncommitted, so `result.current` would still hold
    // the pre-click announcement and this case would fail either way.
    let thrown: unknown;
    act(() => {
      try {
        result.current.handleClick({
          clientX: at[1].x,
          clientY: at[1].y,
        } as unknown as React.MouseEvent<HTMLCanvasElement>);
      } catch (err) {
        thrown = err;
      }
    });
    expect(
      (thrown as Error | undefined)?.message,
      "the click did not reach openNode at all, so this case is not observing the ordering",
    ).toBe("navigated");

    expect(
      result.current.cursorAnnouncement,
      "the cursor was not seated before openNode ran — a navigation that does not return takes " +
        "the seat with it, and the ordering handleClick's comment claims is not the code's",
    ).toContain("Beta");
    expect(result.current.cursorAnnouncement).toContain("2 of 3");
  });

  it("seats the cursor on a click after a lens change, with no focus first", async () => {
    // Two facts in one case. The lens change is the state the fetch effect
    // resets the cursor from — index and announcement both cleared — so the
    // click here seats from NOTHING rather than from a stale index. And no
    // `handleFocus` runs before it: the seat must not be gated on `focusedRef`,
    // which a real browser sets on mousedown but jsdom's `fireEvent.click`
    // never does, so a gate would be untestable dead code.
    const canvasRef = { current: document.createElement("canvas") };
    const nav = router();

    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) =>
        useGraphSimulation(
          canvasRef,
          nav as unknown as Parameters<typeof useGraphSimulation>[1],
          scope,
        ),
      { initialProps: { scope: "mine" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The next lens's nodes get the spread positions; the first lens's were
    // stacked, which is why the click below could not be aimed before now.
    const at = positionNodes(SPREAD);
    fetchMock.mockResolvedValue(graphResponse(NODES));
    rerender({ scope: "vault:v1" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cursorAnnouncement).toBe("");

    act(() =>
      result.current.handleClick({
        clientX: at[2].x,
        clientY: at[2].y,
      } as unknown as React.MouseEvent<HTMLCanvasElement>),
    );

    expect(nav.push).toHaveBeenCalledWith(HREF_OF[2]);
    expect(
      result.current.cursorAnnouncement,
      "a click after a lens change announced nothing or the wrong node — the pointer seats the " +
        "cursor whether or not the canvas has been focused yet (DW-751)",
    ).toContain("Gamma");
    expect(result.current.cursorAnnouncement).toContain("3 of 3");
  });
});

describe("a cursor change asks for a new frame (DW-595)", () => {
  /**
   * The simulation STOPS when it settles: `simulate` only re-arms
   * `requestAnimationFrame` while `totalVelocity > VELOCITY_THRESHOLD`, so on a
   * settled graph nothing redraws unless something asks. That is what
   * `redraw()` is for, and it is invisible in every other case here — the
   * announcement is React state and updates whether or not a frame was ever
   * requested.
   *
   * So the SCHEDULING is what gets pinned, not the drawn frame. In this
   * describe's default setup `getContext` answers `null`, so `simulate` returns
   * immediately and requests no follow-up frame of its own: the loop is
   * quiescent between presses, and any new request in the window around a key
   * press came from `redraw`. (A case that stubbed the context would instead be
   * counting frames a still-running physics loop produces on its own, which is
   * exactly how this fact hid in the first place.)
   */
  function countFrames(): () => number {
    const spy = vi.spyOn(window, "requestAnimationFrame");
    const base = spy.mock.calls.length;
    return () => spy.mock.calls.length - base;
  }

  it("requests one on a cursor move and none on a key it ignores", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const since = countFrames();

    pressKey(canvas, "ArrowRight");
    expect(
      since(),
      "moving the cursor requested no animation frame, so on a settled graph the ring stays " +
        "drawn around the node the cursor has LEFT",
    ).toBeGreaterThan(0);

    const afterMove = since();
    pressKey(canvas, "Tab");
    expect(
      since(),
      "a key the canvas does not handle still scheduled a redraw",
    ).toBe(afterMove);
  });

  it("requests one on a click that hits, and none on a click that misses", async () => {
    // `seatCursor` has THREE effects and the click path's other cases read only
    // two of them: the index and the announcement are React-visible, the frame
    // is not. Without this the pointer could seat a cursor the ring never
    // follows — on a settled graph the ring would stay drawn around whatever
    // node the keyboard last left it on. Same quiescent setup as above: no 2D
    // context, so any frame in this window came from `redraw`.
    positionNodes(SPREAD);
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const since = countFrames();
    fireEvent.click(canvas, { clientX: 300, clientY: 250 });
    expect(
      since(),
      "a click that seated the cursor requested no animation frame, so the focus ring stays " +
        "around the node the cursor has LEFT (DW-751)",
    ).toBeGreaterThan(0);

    const afterHit = since();
    fireEvent.click(canvas, { clientX: 400, clientY: 100 });
    expect(
      since(),
      "a click that hit no node still scheduled a redraw — nothing about the scene changed",
    ).toBe(afterHit);
  });

  it("requests one on blur, so the ring is taken down", async () => {
    const canvas = await mountGraph();
    focusCanvas(canvas);

    const since = countFrames();
    blurCanvas(canvas);

    expect(
      since(),
      "blurring requested no animation frame, so the focus ring is left painted on a canvas " +
        "that no longer has focus",
    ).toBeGreaterThan(0);
  });
});

describe("the cursor the canvas is asked to draw follows focus", () => {
  /**
   * The one describe that gets a 2D context, because it is the one asking a
   * question about the RENDER pass: everywhere else `getContext` answers `null`
   * and `simulate()` returns before `renderGraph` — which is exactly what keeps
   * node positions still for the coordinate arithmetic above.
   *
   * The stub is the smallest thing the hook actually calls on a context: the
   * resize effect's `setTransform`/`scale`. `renderGraph` itself is mocked at
   * the module boundary, so nothing else is drawn with it.
   */
  function stubContext(): void {
    const ctx = { setTransform: vi.fn(), scale: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
  }

  /** The `cursor` the most recent render pass was handed. */
  function lastCursor() {
    const calls = vi.mocked(renderGraph).mock.calls;
    expect(calls.length, "renderGraph was never called, so no frame was drawn").toBeGreaterThan(0);
    return calls.at(-1)![0].cursor;
  }

  it("passes the cursor node while focused and nothing once blurred", async () => {
    stubContext();
    const canvas = await mountGraph();

    await waitFor(() =>
      expect(
        lastCursor(),
        "a cursor was drawn before the canvas was ever focused — the ring would be a focus " +
          "indication on an element that does not have focus",
      ).toBeNull(),
    );

    focusCanvas(canvas);
    pressKey(canvas, "ArrowRight");
    await waitFor(() =>
      expect(
        lastCursor()?.id,
        "the focused canvas's cursor node never reached renderGraph, so the keyboard reader's " +
          "position is announced but never shown",
      ).toBe(NODES[1].id),
    );

    blurCanvas(canvas);
    await waitFor(() =>
      expect(
        lastCursor(),
        "the cursor ring survives blur, so the canvas keeps drawing a focus indication after " +
          "focus has moved elsewhere",
      ).toBeNull(),
    );
  });
});

/**
 * Two facts the RENDERED page cannot be asked about, driven through the hook.
 *
 * Both concern states in which `GraphPage` renders a `<p>` instead of the
 * canvas — an empty graph, and the loading gap a lens change opens — so there
 * is no element to press a key on. The hook is where the guards live, so the
 * hook is what is asked.
 */
describe("the keyboard cursor outside the canvas's rendered branch", () => {
  /** Drive `handleKeyDown` without a DOM event, reporting `preventDefault`. */
  function pressOn(
    result: { current: ReturnType<typeof useGraphSimulation> },
    key: string,
  ) {
    const preventDefault = vi.fn();
    act(() => {
      result.current.handleKeyDown({
        key,
        preventDefault,
      } as unknown as React.KeyboardEvent<HTMLCanvasElement>);
    });
    return preventDefault;
  }

  it("drops the cursor when the scope lens changes", async () => {
    // The reset lives at the TOP of the fetch effect, before the request goes
    // out, and that ordering is the point: the canvas the previous lens
    // rendered is still mounted for the moment between the two, and a cursor
    // surviving into it indexes an array that is about to be replaced.
    const canvasRef = { current: document.createElement("canvas") };
    const nav = router();
    const OTHER_NODES = [
      { id: "delta", label: "Delta", tenant: "yopedia", linkCount: 4, tags: [] },
      { id: "epsilon", label: "Epsilon", tenant: "yopedia", linkCount: 0, tags: [] },
    ];

    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) =>
        useGraphSimulation(
          canvasRef,
          nav as unknown as Parameters<typeof useGraphSimulation>[1],
          scope,
        ),
      { initialProps: { scope: "mine" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.handleFocus());
    pressOn(result, "ArrowRight");
    expect(result.current.cursorAnnouncement).toContain("Beta");

    fetchMock.mockResolvedValue(graphResponse(OTHER_NODES));
    rerender({ scope: "vault:v1" });

    // Synchronously, before the new data can land.
    expect(
      result.current.cursorAnnouncement,
      "the live region still names a node from the PREVIOUS lens while the next one is loading",
    ).toBe("");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      result.current.cursorAnnouncement,
      "a lens change re-announced by itself — the cursor should be absent until a reader focuses",
    ).toBe("");

    // The INDEX was dropped too, not just the string: had it survived at 1,
    // this would announce the second of the new nodes instead of the first.
    act(() => result.current.handleFocus());
    expect(
      result.current.cursorAnnouncement,
      "focusing after a lens change landed on the node the cursor held in the PREVIOUS lens",
    ).toContain("Delta");
    expect(result.current.cursorAnnouncement).toContain("1 of 2");
  });

  it("focuses and keys without a cursor, an announcement, or a throw", async () => {
    fetchMock.mockResolvedValue(graphResponse([]));
    const canvasRef = { current: document.createElement("canvas") };
    const nav = router();

    const { result } = renderHook(() =>
      useGraphSimulation(
        canvasRef,
        nav as unknown as Parameters<typeof useGraphSimulation>[1],
      ),
    );
    await waitFor(() => expect(result.current.empty).toBe(true));

    act(() => result.current.handleFocus());
    expect(result.current.cursorAnnouncement).toBe("");

    // Both an arrow and an activation key: the arrow is the one that would
    // index into an empty array, the activation the one that would navigate.
    expect(pressOn(result, "ArrowRight")).not.toHaveBeenCalled();
    expect(pressOn(result, "Enter")).not.toHaveBeenCalled();
    expect(result.current.cursorAnnouncement).toBe("");
    expect(nav.push).not.toHaveBeenCalled();

    act(() => result.current.handleBlur());
    expect(result.current.cursorAnnouncement).toBe("");
  });
});
