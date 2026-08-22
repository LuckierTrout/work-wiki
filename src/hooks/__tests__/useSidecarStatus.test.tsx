import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSidecarStatus } from "@/hooks/useSidecarStatus";
import { SIDECAR_HEALTH_URL, SIDECAR_PROBE_TIMEOUT_MS } from "@/lib/sidecar";
import { fireVisibilityChange, setVisibilityState } from "../../../vitest.setup.dom";

/**
 * The rail's sidecar signal, MOUNTED.
 *
 * DW-24 records this hook as having no test at all — `sidecar.test.ts` covers
 * `probeSidecar`'s fail-closed race, but nothing has ever run the hook's own
 * effect: the `"unknown"` first paint, the visibility gate, the re-probe cadence
 * and the abort on unmount. The harness below renders nothing but the status the
 * hook returns, so every assertion is on the rendered DOM.
 */

/**
 * `POLL_MS` is module-private in `useSidecarStatus.ts` on purpose, so the
 * cadence is driven by advancing wall-clock time rather than by importing the
 * number the implementation uses — a rewrite that changes it fails here.
 *
 * `SIDECAR_PROBE_TIMEOUT_MS` is imported instead, and the difference is not an
 * inconsistency: it is EXPORTED from `sidecar.ts`, which documents the budget
 * as part of the probe's contract ("a wedged port must not stall the rail"),
 * and `probeSidecar` takes a `timeoutMs` override so callers can pick their
 * own. Restating it as a literal here would pin a number that is explicitly
 * allowed to move, and would go stale silently the day it does. The cadence has
 * no such contract — nothing outside the hook may know it — so it is the one
 * that gets spelled out.
 */
const FIFTEEN_SECONDS = 15_000;

function Harness() {
  const status = useSidecarStatus();
  return <output data-testid="sidecar-status">{status}</output>;
}

function status(): string {
  return screen.getByTestId("sidecar-status").textContent ?? "";
}

/** Settle the probe's race: its timeout is a timer, its answer is a microtask. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => ({ ok: true }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // hook down while the fake clock and the `fetch` stub are still in place —
  // otherwise the probe's abort runs against an environment it never ran in.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSidecarStatus", () => {
  it("claims nothing until the first probe has answered", async () => {
    render(<Harness />);

    // The dot must not accuse a running sidecar, nor promise a Chat that
    // cannot answer, before anything has asked.
    expect(status()).toBe("unknown");

    await settle();
    expect(status()).toBe("up");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(SIDECAR_HEALTH_URL);
  });

  it("reports down when the probe rejects, rather than throwing", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    render(<Harness />);
    await settle();

    expect(status()).toBe("down");
  });

  it("reports down when the probe answers a non-2xx", async () => {
    // A sidecar that ACCEPTS the connection and answers 503 is up as a process
    // and unusable as a service. `probeSidecar` is `response.ok ? "up" : "down"`
    // — weaken it to a bare `"up"` and the rejection case above still passes,
    // because nothing else here ever gets a response object at all.
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    render(<Harness />);
    await settle();

    expect(status()).toBe("down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls closed once the timeout budget elapses on a probe that never answers", async () => {
    // The wedged port: the connection is accepted and nothing comes back. The
    // probe's timeout is a RACE against the fetch, not merely an abort signal,
    // because a transport that ignores abort would otherwise leave the rail on
    // `"unknown"` forever — which reads as "still checking", not the
    // fail-closed answer the owner is owed.
    //
    // The budget is spent in WALL-CLOCK TIME rather than shortened through
    // `timeoutMs`: the hook does not pass that option, so overriding it would
    // test a probe the rail never makes.
    fetchMock.mockImplementation(async () => new Promise<never>(() => {}));

    render(<Harness />);
    await settle(SIDECAR_PROBE_TIMEOUT_MS - 1);
    // Still inside the budget: claiming "down" here would accuse a sidecar
    // that is merely slow to answer.
    expect(status()).toBe("unknown");

    await settle(1);
    expect(status()).toBe("down");

    // …and the LOOP survived the timeout. A hook that treated a timed-out probe
    // as terminal would sit on `down` forever, so a sidecar started a minute
    // later would never be noticed — the dot would be permanently wrong in the
    // one direction nobody checks.
    fetchMock.mockResolvedValue({ ok: true } as unknown as Response);
    await settle(FIFTEEN_SECONDS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status()).toBe("up");
  });

  it("re-probes on the poll cadence and moves the status with the answer", async () => {
    render(<Harness />);
    await settle();
    expect(status()).toBe("up");

    fetchMock.mockRejectedValue(new Error("gone"));
    await settle(FIFTEEN_SECONDS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status()).toBe("down");
  });

  it("does not probe at all while the tab is hidden", async () => {
    setVisibilityState("hidden");

    render(<Harness />);
    await settle(FIFTEEN_SECONDS * 3);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status()).toBe("unknown");
  });

  it("re-probes immediately when the tab becomes visible", async () => {
    setVisibilityState("hidden");
    render(<Harness />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      fireVisibilityChange("visible");
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status()).toBe("up");

    // …and the interval is running again from that point.
    await settle(FIFTEEN_SECONDS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops probing when the tab is hidden again", async () => {
    render(<Harness />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireVisibilityChange("hidden");
    });
    await settle(FIFTEEN_SECONDS * 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight probe and stops polling on unmount", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<never>(() => {});
    });

    const { unmount } = render(<Harness />);
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    unmount();

    expect(signals[0].aborted).toBe(true);
    await settle(FIFTEEN_SECONDS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
