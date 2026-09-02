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
