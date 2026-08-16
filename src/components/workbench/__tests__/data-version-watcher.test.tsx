import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DataVersionWatcher } from "@/components/workbench/DataVersionWatcher";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  DATA_VERSION_POLL_MS,
  DATA_VERSION_ROUTE,
  _resetDataVersionListeners,
  requestDataVersionCheck,
} from "@/lib/workbench-data-version";
import { fireVisibilityChange, setVisibilityState } from "../../../../vitest.setup.dom";

/**
 * The watcher's EFFECT, mounted (DW-52).
 *
 * `workbench-data-version.test.ts` executes the pure decisions
 * (`shouldRefreshForDataVersion`, `fetchDataVersion`) and
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

  it("refreshes once when the served version moves forward, and not again", async () => {
    fetchMock = answering(4);
    vi.stubGlobal("fetch", fetchMock);

    mountWatcher(3);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The same answer on the next tick is not a new write.
    await settle(DATA_VERSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
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

    // 5 is BEHIND the payload the owner is looking at, so nothing is stale.
    // Read from the effect's mount-time closure instead, 5 would be ahead of
    // both the served 3 and the 4 already refreshed for — and the shell would
    // re-render for a version it is already past.
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
