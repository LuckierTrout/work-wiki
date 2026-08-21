import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DataVersionWatcher } from "@/components/workbench/DataVersionWatcher";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  DATA_VERSION_POLL_MS,
  DATA_VERSION_REFRESH_ATTEMPTS,
  DATA_VERSION_ROUTE,
  _resetDataVersionListeners,
  requestDataVersionCheck,
} from "@/lib/workbench-data-version";
import { fireVisibilityChange, setVisibilityState } from "../../../../vitest.setup.dom";

/**
 * The watcher's EFFECT, mounted (DW-52).
 *
 * `workbench-data-version.test.ts` executes the pure decisions
 * (`dataVersionRefreshPlan`, `fetchDataVersion`) and
 * `workbench-data-version.test.ts`'s source scan can see that `startPolling` is
 * spelled inside the visible branch. Neither can see the LIFECYCLE: that a
 * hidden tab issues nothing, that becoming visible re-checks at once, that the
 * interval keeps running, that a repeat answer refreshes nothing, and that
 * unmount aborts the flight. Every assertion below is on the requests issued
 * and on `router.refresh`.
 */

// ONE stable router object, not a fresh literal per call: the watcher's effect
// is keyed on `[router]`, so a new identity per render would tear the whole
// poll down and rebuild it on every re-render — which is exactly the thing the
// "compares against the version now on screen" case has to rule out.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

function data(dataVersion: number): WorkbenchData {
  return {
    wikis: [],
    currentWikiId: null,
    registryUnavailable: false,
    knowledge: [],
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion,
    readOnly: false,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Answer every poll with this version until told otherwise. */
function answering(version: number, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => ({ dataVersion: version }) }));
}

function tree(served: number) {
  return (
    <WorkbenchDataProvider value={data(served)}>
      <DataVersionWatcher />
    </WorkbenchDataProvider>
  );
}

function mountWatcher(served: number) {
  const view = render(tree(served));
  return {
    ...view,
    /** A fresh server render arrives: same mounted watcher, new baseline. */
    serve: (next: number) => view.rerender(tree(next)),
  };
}

/** Let the in-flight poll settle (and optionally run the interval forward). */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
  fetchMock = answering(0);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST, and it matters most here: vitest runs afterEach hooks in reverse
  // registration order, so the setup file's own `cleanup()` lands last —
  // after the clock is real again and after the listener registry has been
  // cleared. Unmounting there would let a watcher that never unsubscribed slip
  // through, because the reset below would already have hidden its listener.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Belt and braces for a file that throws mid-test: the registry is module
  // state, so a stranded listener would otherwise reach the next file.
  _resetDataVersionListeners();
});

describe("DataVersionWatcher lifecycle", () => {
  it("issues nothing at all while the tab is hidden", async () => {
    setVisibilityState("hidden");

    mountWatcher(3);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await settle(DATA_VERSION_POLL_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks immediately when the tab becomes visible, then polls", async () => {
    setVisibilityState("hidden");
    mountWatcher(3);
    await settle();

    await act(async () => {
      fireVisibilityChange("visible");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(DATA_VERSION_ROUTE);

    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling again when the tab is hidden", async () => {
    mountWatcher(3);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireVisibilityChange("hidden");
    });
    await settle(DATA_VERSION_POLL_MS * 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls once per interval while visible", async () => {
    mountWatcher(3);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes when the served version moves forward, and stops once the re-render lands", async () => {
    fetchMock = answering(4);
    vi.stubGlobal("fetch", fetchMock);

    const { serve } = mountWatcher(3);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    // `router.refresh()` is a `vi.fn()` here, so the new server render is
    // simulated: it arrives with the version the poll asked for.
    act(() => {
      serve(4);
    });

    // The same answer on the next tick is not a new write, and the baseline has
    // caught up — so there is nothing left outstanding to retry either.
    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);

    await settle(DATA_VERSION_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once a LATER re-render catches up (DW-48)", async () => {
    // The success story the case above cannot tell, because there the baseline
    // arrives on the first attempt. Here the first re-render lags — `serve` is
    // not called on the first tick — the retry goes out, and only THEN does the
    // new baseline land. What is asserted is that the catch-up ends the retries
    // mid-budget: the count stops at 2, below the cap, so it stopped because
    // the render arrived and not because the attempts ran out.
    fetchMock = answering(4);
    vi.stubGlobal("fetch", fetchMock);

    const { serve } = mountWatcher(3);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The re-render answered the pre-bump integer: still serving 3.
    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    // …and THIS one landed.
    act(() => {
      serve(4);
    });

    await settle(DATA_VERSION_POLL_MS * 5);
    const stoppedAt = refresh.mock.calls.length;
    expect(stoppedAt).toBe(2);
    expect(stoppedAt).toBeLessThan(DATA_VERSION_REFRESH_ATTEMPTS);
  });

  it("retries a refresh whose re-render never catches up, then gives up (DW-48)", async () => {
    // The DW-48 failure, mounted: the re-render's own read keeps answering the
    // pre-bump integer, so the baseline never reaches 4. `serve` is never
    // called, which is exactly that. The old single-shot stamp refreshed once
    // and then sat stale until the next write; this retries — and stops.
    fetchMock = answering(4);
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(DATA_VERSION_REFRESH_ATTEMPTS);

    // Bounded, not a loop: the polls keep going, the renders do not.
    await settle(DATA_VERSION_POLL_MS * 6);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(DATA_VERSION_REFRESH_ATTEMPTS);
    expect(refresh).toHaveBeenCalledTimes(DATA_VERSION_REFRESH_ATTEMPTS);

    // …and giving up is per VERSION, not a latch: a real write still lands.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ dataVersion: 5 }),
    }));
    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(DATA_VERSION_REFRESH_ATTEMPTS + 1);
  });

  it("compares against the version now on screen, not the one it mounted with", async () => {
    fetchMock = answering(4);
    vi.stubGlobal("fetch", fetchMock);

    const { serve } = mountWatcher(3);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The refresh landed: the server re-rendered and handed down a baseline
    // AHEAD of the poll that triggered it (other writes had accumulated).
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ dataVersion: 5 }),
    }));
    act(() => {
      serve(7);
    });

    await settle(DATA_VERSION_POLL_MS);

    // 5 is BEHIND the payload the owner is looking at, so nothing is stale —
    // and the baseline is past 4, so the attempt outstanding for it is settled
    // rather than retried. Read from the effect's mount-time closure instead,
    // the served number would still be 3, 5 would be a version beyond anything
    // attempted, and the shell would re-render for a version it is already past.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the polled version has not moved forward", async () => {
    fetchMock = answering(3);
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle(DATA_VERSION_POLL_MS);

    expect(fetchMock).toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh on a non-ok answer", async () => {
    fetchMock = answering(9, false);
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("swallows a transport failure and keeps polling on the next tick", async () => {
    // `fetchDataVersion` maps a throw to `unavailable`, and the effect returns
    // on `result.status !== "ok"`. Nothing here is observable from the source:
    // a rewrite that let the rejection escape `run()` would leave an unhandled
    // rejection AND stop the loop, and both are only visible mounted.
    fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    // The interval survived the failure: the next tick issues a fresh poll…
    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // …and a recovered route still refreshes, so the failure cost one tick and
    // not the whole loop.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ dataVersion: 4 }),
    }));
    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on a 200 whose dataVersion is not an integer", async () => {
    // A 200 is not a promise about SHAPE. `"4" > 3` is `true` in JS, so a
    // watcher that trusted the body would refresh here — and `"10" > 9` is
    // `false`, so the same bug would also stop refreshing at the ten-boundary.
    // `servedVersion` rejects the string, and the effect's `status !== "ok"`
    // guard is what turns that into no refresh.
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ dataVersion: "4" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    // And it is not merely deferred to the next tick either.
    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("supersedes a wedged poll every tick and still refreshes once it answers", async () => {
    // A route that accepts the connection and never answers. `run()` aborts the
    // PREVIOUS controller before issuing its own, so the stalled request is
    // SUPERSEDED rather than left waiting on an answer that can no longer
    // matter — and a late reply from it can never reach `router.refresh()`,
    // because the effect returns on `controller.signal.aborted`.
    //
    // What is asserted below is exactly that: which signals are aborted, and
    // that a fresh request goes out each tick. NOT that fewer requests are in
    // flight — this stub ignores its signal (as a transport that has stopped
    // honouring abort would), so every one of them stays pending either way.
    const signals: AbortSignal[] = [];
    fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<never>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    // Each tick issues a FRESH request and aborts the stalled one before it.
    await settle(DATA_VERSION_POLL_MS);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    await settle(DATA_VERSION_POLL_MS);
    expect(signals).toHaveLength(3);
    expect(signals[1].aborted).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    // The route recovers. A forward answer still lands — the wedge cost ticks,
    // not the watcher.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ dataVersion: 4 }),
    }));
    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The attempt state survived the wedge: `serve` was never called, so the
    // baseline is still 3 and the following tick is the bounded RETRY, not an
    // unbounded reaction to the same answer. It stops at the cap.
    await settle(DATA_VERSION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    await settle(DATA_VERSION_POLL_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(DATA_VERSION_REFRESH_ATTEMPTS);
  });

  it("checks now when something asks for an immediate check", async () => {
    fetchMock = answering(4);
    vi.stubGlobal("fetch", fetchMock);
    setVisibilityState("hidden");

    mountWatcher(3);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      requestDataVersionCheck();
    });
    // Settled explicitly, like every other case here: the request is issued
    // synchronously, but the refresh is two awaits (`fetch`, then `.json()`)
    // further on, and how many turns `act` happens to yield is not a contract.
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight poll and issues nothing more after unmount", async () => {
    const signals: AbortSignal[] = [];
    fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      // Never settles: the request is still in flight when the tree unmounts.
      return new Promise<never>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = mountWatcher(3);
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    unmount();

    expect(signals[0].aborted).toBe(true);
    await settle(DATA_VERSION_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops listening for the immediate-check nudge after unmount", async () => {
    const { unmount } = mountWatcher(3);
    await settle();
    fetchMock.mockClear();

    unmount();
    await act(async () => {
      requestDataVersionCheck();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
