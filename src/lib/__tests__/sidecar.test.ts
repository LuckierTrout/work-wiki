/**
 * Story 1.3 — the sidecar probe fails CLOSED.
 *
 * Fail-closed is a behaviour, not a comment: only an affirmative 2xx from the
 * loopback health endpoint may report `up`. A refused port, a 500, and a
 * process that accepts the connection and then wedges must all answer `down`,
 * and the wedged case must answer at all rather than leaving the rail stuck on
 * "unknown" forever. The fetch is injected so none of this touches a network.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SIDECAR_HEALTH_URL,
  SIDECAR_ORIGIN,
  SIDECAR_PROBE_TIMEOUT_MS,
  probeSidecar,
} from "../sidecar";

function respond(ok: boolean, status: number): Response {
  return { ok, status } as Response;
}

describe("loopback contract", () => {
  it("probes 127.0.0.1:19828/health", () => {
    // The Worker cannot reach localhost, so this URL must never become a
    // same-origin server route pretending to check the sidecar.
    expect(SIDECAR_ORIGIN).toBe("http://127.0.0.1:19828");
    expect(SIDECAR_HEALTH_URL).toBe("http://127.0.0.1:19828/health");
  });

  it("requests exactly that URL, uncached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(true, 200));
    await probeSidecar(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SIDECAR_HEALTH_URL);
    // A cached "up" would outlive the process it claims is running.
    expect(init.cache).toBe("no-store");
  });
});

describe("probeSidecar", () => {
  it("is up only on a 2xx", async () => {
    await expect(probeSidecar(async () => respond(true, 200))).resolves.toBe("up");
    await expect(probeSidecar(async () => respond(true, 204))).resolves.toBe("up");
  });

  it("is down on a non-2xx", async () => {
    await expect(probeSidecar(async () => respond(false, 500))).resolves.toBe("down");
    await expect(probeSidecar(async () => respond(false, 404))).resolves.toBe("down");
  });

  it("is down when the connection is refused", async () => {
    await expect(
      probeSidecar(async () => {
        throw new TypeError("fetch failed");
      }),
    ).resolves.toBe("down");
  });

  it("is down when the probe hangs, without hanging the caller", async () => {
    // A transport that never settles and ignores abort is the case an
    // AbortSignal alone does not cover.
    const never = () => new Promise<Response>(() => {});
    await expect(probeSidecar(never, { timeoutMs: 10 })).resolves.toBe("down");
  });

  it("is down immediately when the signal is already aborted", async () => {
    // An aborted signal fires no `abort` event, so a listener-only
    // implementation still opens a real loopback connection and burns the
    // whole timeout on it.
    const fetchImpl = vi.fn().mockResolvedValue(respond(true, 200));
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeSidecar(fetchImpl, { signal: controller.signal }),
    ).resolves.toBe("down");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is down when the caller aborts (component unmount)", async () => {
    const controller = new AbortController();
    const aborting: () => Promise<Response> = () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    const result = probeSidecar(aborting, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBe("down");
  });

  it("budgets the wait rather than trusting the far side", () => {
    expect(SIDECAR_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SIDECAR_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
