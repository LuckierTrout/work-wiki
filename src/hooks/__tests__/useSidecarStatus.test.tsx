import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSidecarStatus } from "@/hooks/useSidecarStatus";
import { SIDECAR_HEALTH_URL } from "@/lib/sidecar";
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
