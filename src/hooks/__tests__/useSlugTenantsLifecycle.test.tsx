import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  _resetSlugTenants,
  _slugTenantListenerCount,
  loadSlugTenants,
  useSlugTenants,
} from "@/hooks/useSlugTenants";

/**
 * The hook's MOUNT lifecycle — what `useSlugTenants.test.ts` cannot reach.
 *
 * That file is the `node` project, so its renders go through
 * `renderToStaticMarkup`, which runs no effects: it can pin the module's seams
 * and the hook's render-time output, but never the subscription those seams
 * exist for. This file is the `dom` project, mounts the hook for real, and owns
 * the facts that only a mount has:
 *
 *   - the SHIPPED recovery trigger, which is not a bare `loadSlugTenants()`
 *     (no production module calls it — every consumer reaches the map through
 *     this hook) but a SECOND component mounting after the outage clears and
 *     paying for the re-fetch the first one then adopts (DW-234);
 *   - the loading→loaded transition DW-262 names alongside the failed one;
 *   - an unmounted hook leaves NO listener behind, which is invisible from
 *     anywhere else — React no longer warns on a `setState` against an
 *     unmounted component, so a leak would stay silent while it accumulated
 *     one listener per mount for the life of the tab.
 *
 * `owner-scoped-anchors.test.tsx` is the sibling that pins what a real
 * component RENDERS across the same recovery. This one pins the bookkeeping
 * underneath it.
 */

const MAP = { target: "alice" };
const CANONICAL = "/u/alice/target";
/** The DEFAULT_TENANT form, which the owner route 308s onward. */
const DEGRADED = "/u/yopedia/target";

let fetchMock: ReturnType<typeof vi.fn>;
/** Flipped per test: what the one `fetch` stub does with `/api/wiki/routes`. */
let routesUp: boolean;
/** Held open by `pending()`, so a test can observe the LOADING window. */
let release: (() => void) | null;

function Probe({ id }: { id: string }) {
  const { hrefForSlug } = useSlugTenants();
  return <a href={hrefForSlug("target")}>{id}</a>;
}

beforeEach(() => {
  routesUp = true;
  release = null;
  fetchMock = vi.fn(async (url: string) => {
    if (url !== "/api/wiki/routes") throw new Error(`unexpected fetch: ${url}`);
    if (release) await new Promise<void>((resolve) => (release = resolve));
    if (!routesUp) throw new Error(`staged outage: ${url}`);
    return { ok: true, status: 200, json: async () => ({ ...MAP }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  // The module singleton outlives any one test in this file, so each case
  // starts cold — otherwise the first case's warm cache would decide the rest.
  _resetSlugTenants();
});

afterEach(() => {
  // FIRST, so mounts unmount while `fetch` is still stubbed: the setup file's
  // own `cleanup()` runs after this hook (reverse registration order). It is
  // also what drops every subscription — `_resetSlugTenants()` deliberately
  // leaves listeners to their mounts.
  cleanup();
  vi.unstubAllGlobals();
  _resetSlugTenants();
});

/**
 * Let a load's WHOLE chain run out: `fetch` → the two `.then`s → `.catch` →
 * `.finally`. A bare `await act(async () => {})` drains an unknown number of
 * microtask turns, so a test that re-loaded straight after one could join the
 * request it meant to replace. One macrotask turn is the deterministic drain.
 */
async function settleLoad() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The href of the probe named `id`. */
function href(id = "a") {
  return screen.getByRole("link", { name: id }).getAttribute("href");
}

/** How many times `/api/wiki/routes` was actually requested. */
function routeFetches() {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/wiki/routes").length;
}

/**
 * The two attention events, dispatched the way a browser dispatches them:
 * native, on `window`/`document`, not through React's synthetic system — the
 * hook registers real listeners, so anything else would prove nothing.
 *
 * Deliberately NOT wrapped in `act()`: the handler starts a load and returns,
 * so no React state changes synchronously here. The `setMap` the recovery
 * eventually produces is flushed inside `settleLoad()`'s `act()`.
 */
function fireFocus() {
  window.dispatchEvent(new Event("focus"));
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Make the tab report itself hidden for one case. jsdom serves
 * `visibilityState` from `Document.prototype` and always answers "visible", so
 * an own property shadows it and `delete` restores the prototype's — no
 * `vi.stubGlobal` reach, and nothing left behind for the next case.
 */
function hideTab(): () => void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  return () => {
    Reflect.deleteProperty(document, "visibilityState");
  };
}

describe("useSlugTenants mount lifecycle", () => {
  it("shows the DEFAULT_TENANT fallback while the map is still loading, then adopts it", async () => {
    // The other half of what DW-262's reset is for: "still loading" is a state
    // no mounted suite could reach while the singleton stayed warm. The stub
    // parks here until `release()` runs, so the loading window is a place the
    // test can stand rather than a race it has to win.
    release = () => {};
    render(<Probe id="a" />);
    // A full macrotask turn: if the stub were NOT parked the load would have
    // finished by now, so the fallback below is the loading window and not an
    // un-drained chain.
    await settleLoad();

    expect(href()).toBe(DEGRADED); // in flight: no map yet
    expect(routeFetches()).toBe(1);

    release?.();
    await settleLoad();
    expect(href()).toBe(CANONICAL);
  });

  it("adopts the map a LATER mount fetched, which is how recovery reaches production", async () => {
    // The shipped trigger. Nothing outside this hook calls `loadSlugTenants()`,
    // so the "next cold caller" DW-234 relies on is always another component
    // mounting — a panel opening, a route change, a rail expanding. Driving
    // recovery by calling the module function directly (as the sibling suite
    // does) proves the seam; this proves the path the app actually walks.
    routesUp = false;
    render(<Probe id="a" />);
    await settleLoad();
    expect(href("a")).toBe(DEGRADED);
    expect(routeFetches()).toBe(1);

    routesUp = true;
    render(<Probe id="b" />); // the second mount pays for the re-fetch
    await settleLoad();

    expect(_slugTenantListenerCount()).toBe(2);
    expect(routeFetches()).toBe(2); // one per cold load, not one per render
    expect(href("b")).toBe(CANONICAL);
    // The one that matters: the FIRST mount, which asked for nothing, adopted
    // the map anyway. Before DW-234 this stayed on the fallback until it
    // remounted.
    expect(href("a")).toBe(CANONICAL);
  });

  it("subscribes even when the session cache was already warm at mount", async () => {
    await act(async () => {
      await loadSlugTenants(); // warm, the way every sibling suite's setup does
    });
    render(<Probe id="a" />);

    // Warm cache ⇒ the map is the hook's INITIAL state, no waiting.
    expect(href()).toBe(CANONICAL);
    expect(routeFetches()).toBe(1); // the mount did not re-fetch
    // ...and it subscribes anyway. The subscription is uniform by construction
    // rather than a branch: a hook that only subscribed when its own load came
    // back degraded would pass every assertion above, and the rule "who gets a
    // recovered map" would then depend on what each mount happened to see.
    expect(_slugTenantListenerCount()).toBe(1);
  });

  it("registers exactly one listener per mount and drops it on unmount", async () => {
    routesUp = false;
    const first = render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);
    expect(_slugTenantListenerCount()).toBe(1);

    first.unmount();
    expect(_slugTenantListenerCount()).toBe(0);

    // A second mount does not inherit the first one's listener.
    render(<Probe id="a" />);
    await settleLoad();
    expect(_slugTenantListenerCount()).toBe(1);
  });

  it("notifies nobody after unmount — a recovered map reaches no dead hook", async () => {
    // React 19 no longer warns on a post-unmount `setState`, so the spy is not
    // the whole assertion; the listener count is. The spy is here because a
    // stray update, an act() complaint or a listener throwing would all arrive
    // through it, and this is the case that would produce one.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    routesUp = false;
    const { unmount } = render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);

    unmount();
    routesUp = true;

    // The recovery signal fires against an empty listener set. Nothing throws,
    // and the load still answers the real map rather than degrading.
    let recovered: unknown;
    await act(async () => {
      recovered = await loadSlugTenants();
    });
    expect(recovered).toEqual(MAP);
    expect(_slugTenantListenerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps a mounted hook subscribed across _resetSlugTenants()", async () => {
    // The reset clears the CACHE, not the mounts. Clearing listeners too would
    // silently detach whatever is on screen, and the next suite to reset
    // mid-life would watch a live component fail to recover and read that as
    // product behavior rather than as its own harness.
    routesUp = false;
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);

    _resetSlugTenants();
    expect(_slugTenantListenerCount()).toBe(1);

    routesUp = true;
    await act(async () => {
      await loadSlugTenants();
    });
    expect(href()).toBe(CANONICAL);
  });
});

describe("useSlugTenants attention-driven recovery while degraded", () => {
  /**
   * DW-723. The describe above pins PROPAGATION: a map somebody else's mount
   * paid for reaching the components already on screen. That is the whole of
   * DW-234's recovery, and it needs a later mount to exist — so a surface that
   * goes idle after an outage (no navigation, no panel opening, no rail
   * expanding) never gets one and keeps its DEFAULT_TENANT hrefs, and their
   * extra 308 hop, until the tab is reloaded.
   *
   * These cases pin the ORIGINATING half: while and only while the map is
   * degraded, the hook itself asks again when the user's attention returns.
   * The bound is the module cache rather than a counter, so every case below
   * that stages a healthy map is also a case that the retry has switched off
   * for good.
   */

  it("re-fetches on window focus and adopts the map without a remount", async () => {
    routesUp = false;
    render(<Probe id="a" />);
    // The failed request must be out of `inflight` before the retry, or the
    // retry would JOIN it and be answered the degraded `{}`.
    await settleLoad();
    expect(href()).toBe(DEGRADED);
    expect(routeFetches()).toBe(1);

    // The SAME node, held across the recovery: if the probe were remounted the
    // assertion below would read a detached element. Nothing here mounts
    // anything — that is the point of the case.
    const link = screen.getByRole("link", { name: "a" });

    routesUp = true;
    fetchMock.mockClear(); // the count below is this event's, not the mount's
    fireFocus();
    await settleLoad();

    expect(routeFetches()).toBe(1); // one event, one request
    expect(link.isConnected, "the probe was remounted").toBe(true);
    expect(link.getAttribute("href")).toBe(CANONICAL);
  });

  it("re-fetches on visibilitychange while the tab is visible", async () => {
    // The other attention event, and the one that covers tab switching and
    // un-minimising. jsdom reports "visible" by default, which is the state
    // this case is about.
    routesUp = false;
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);

    routesUp = true;
    fetchMock.mockClear();
    fireVisibilityChange();
    await settleLoad();

    expect(routeFetches()).toBe(1);
    expect(href()).toBe(CANONICAL);
  });

  it("issues no request when visibilitychange fires for a tab going HIDDEN", async () => {
    // Same event, opposite direction. Without the `visibilityState` guard this
    // case passes identically to the one above — a backgrounded tab would pay
    // for a fetch nobody is looking at, twice per switch.
    routesUp = false;
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);

    routesUp = true;
    fetchMock.mockClear();
    const restore = hideTab();
    try {
      // BOTH events while hidden. `focus` is not a "the tab came back" signal
      // on its own — a hidden tab can still be handed focus — so a guard
      // applied only on the `visibilitychange` path would satisfy every other
      // assertion in this case and re-fetch here.
      fireVisibilityChange();
      fireFocus();
      await settleLoad();
      expect(routeFetches()).toBe(0);
      expect(href()).toBe(DEGRADED); // still degraded, still eligible
    } finally {
      restore();
    }

    // ...and coming back to it is what recovers, so the guard defers the work
    // rather than dropping it.
    fireVisibilityChange();
    await settleLoad();
    expect(routeFetches()).toBe(1);
    expect(href()).toBe(CANONICAL);
  });

  it("issues no request on either event once the map has loaded successfully", async () => {
    // The healthy path, unchanged and unpolled. `cache !== null` is the whole
    // bound: production never clears it, so the first success turns the
    // handler into a no-op for the rest of the tab's life.
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(CANONICAL);

    fetchMock.mockClear();
    fireFocus();
    fireVisibilityChange();
    fireFocus();
    await settleLoad();

    expect(routeFetches()).toBe(0);
    expect(href()).toBe(CANONICAL);
  });

  it("issues no request on either event for a legitimately EMPTY successful map", async () => {
    // A viewer with no readable pages gets `{}` from an OK response, which
    // caches normally — and whose rendered hrefs are indistinguishable from
    // the degraded fallback. This case pins the BEHAVIOR that viewer gets:
    // zero requests on attention events, forever, exactly like any other warm
    // session.
    //
    // It does NOT pin the hook's `cache !== null` guard, and no test in this
    // file can. A warm `cache = {}` is truthy, so `loadSlugTenants`' own
    // `if (cache)` short-circuit absorbs the call whatever the guard says:
    // deleting the guard, or keying it on emptiness instead, leaves this case
    // and every other one green. What this case would catch is the failure
    // that matters to this viewer — an OK-but-empty response ceasing to CACHE
    // (falling into the degrading `.catch` path, or being treated as a
    // failure), which would leave them permanently degraded and re-fetching on
    // every switch back to the tab.
    fetchMock.mockImplementation(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED); // no tenant known for `target`

    fetchMock.mockClear();
    fireFocus();
    fireVisibilityChange();
    await settleLoad();

    expect(routeFetches()).toBe(0);
  });

  it("stays degraded when the retry fails too, and retries again on the next event", async () => {
    // The symmetric-failure contract is what makes this safe to repeat: a
    // failed load resolves `{}` and caches NOTHING, so the hook is still
    // degraded and still eligible. No counter, no backoff — the user coming
    // back is the only budget.
    routesUp = false;
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);

    fetchMock.mockClear();
    fireFocus();
    await settleLoad();
    expect(routeFetches()).toBe(1);
    expect(href()).toBe(DEGRADED); // routes are still down

    routesUp = true;
    fetchMock.mockClear();
    fireFocus();
    await settleLoad();
    expect(routeFetches()).toBe(1);
    expect(href()).toBe(CANONICAL);
  });

  it("JOINS a still-in-flight failing request, so the retry it buys is the NEXT event's", async () => {
    // The stated cost of reusing `inflight`. An attention event that lands
    // while a failing request is still running gets that request's promise
    // back — no second fetch, and the `{}` it eventually resolves broadcasts
    // nothing — so this event buys no retry of its own. A slow failure (a
    // timeout, not a fast 500) is exactly when someone switches away and back
    // mid-request, so this is the reachable shape of it.
    //
    // Pinned rather than fixed: bypassing `inflight` would stampede
    // `/api/wiki/routes` with one request per mounted hook per attention event
    // precisely while it is already struggling. What the user is owed is that
    // the NEXT event still works, which is the second half of this case.
    routesUp = false;
    release = () => {}; // park the load in flight
    render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);
    expect(routeFetches()).toBe(1);

    fetchMock.mockClear();
    fireFocus(); // lands mid-flight
    await settleLoad();
    expect(routeFetches()).toBe(0); // joined the running request, started none

    // Let the parked request finish — and FAIL, since routes are still down.
    // It degrades to `{}`, caches nothing, and notifies nobody.
    release?.();
    await settleLoad();
    expect(href()).toBe(DEGRADED);
    expect(routeFetches()).toBe(0); // still nothing new: that event is spent

    // The next one is the one that recovers. Nothing had to be retried on a
    // timer for this to work — the user simply came back again.
    routesUp = true;
    release = null;
    fireFocus();
    await settleLoad();
    expect(routeFetches()).toBe(1);
    expect(href()).toBe(CANONICAL);
  });

  it("collapses three mounted hooks × two attention events into ONE request", async () => {
    // The retry adds no dedupe of its own — it just reuses
    // `loadSlugTenants`' `inflight` slot. A handler that fetched directly, or
    // one that skipped the shared loader, would show up here as six requests,
    // and as six more on every switch back to the tab for as long as the
    // outage lasted.
    routesUp = false;
    render(<Probe id="a" />);
    render(<Probe id="b" />);
    render(<Probe id="c" />);
    await settleLoad();
    expect(href("a")).toBe(DEGRADED);
    expect(_slugTenantListenerCount()).toBe(3);

    routesUp = true;
    fetchMock.mockClear();
    // Both events, so the six handler calls this produces collapse too.
    fireFocus();
    fireVisibilityChange();
    await settleLoad();

    expect(routeFetches()).toBe(1);
    // ...and all three end on the canonical href. Which PATH carried the map
    // to each of them is not something this case can see — every probe called
    // `loadSlugTenants()` itself and shares the one promise, so each is served
    // by its own `.then` as well as by the broadcast. The claim here is the
    // one that matters to a user with several surfaces open: one request, and
    // nothing left behind on the fallback.
    expect(href("a")).toBe(CANONICAL);
    expect(href("b")).toBe(CANONICAL);
    expect(href("c")).toBe(CANONICAL);
  });

  it("leaves no listener behind: neither event fetches after the hook unmounts", async () => {
    // The listeners live and die with the mount effect, like the subscription
    // beside them. A leaked one would keep re-fetching for the life of the tab
    // — once per attention event per dead mount — and React 19 no longer warns
    // on a `setState` against an unmounted component, so nothing else would
    // say so.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    routesUp = false;
    const { unmount } = render(<Probe id="a" />);
    await settleLoad();
    expect(href()).toBe(DEGRADED);

    unmount();
    expect(_slugTenantListenerCount()).toBe(0);

    routesUp = true;
    fetchMock.mockClear();
    fireFocus();
    fireVisibilityChange();
    await settleLoad();

    expect(routeFetches()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
