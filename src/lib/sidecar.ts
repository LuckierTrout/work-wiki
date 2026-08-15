/**
 * The local sidecar's loopback contract (AD-6 / AD-22).
 *
 * The Agent, extractors, shell and Skills run on the owner's machine, not on
 * the Worker — and the Worker cannot reach localhost. So the health probe is
 * made by the BROWSER against `127.0.0.1`, never by a server route; a server
 * route would always report the sidecar down and would be a lie dressed as a
 * check. Epic 1 needs only up/down, for the rail's status dot and Chat's
 * fail-closed state.
 *
 * Fail-closed is the whole point: anything that is not an affirmative 2xx —
 * a refused connection, a non-2xx, a hang — is `down`.
 */

export const SIDECAR_ORIGIN = "http://127.0.0.1:19828";
export const SIDECAR_HEALTH_URL = `${SIDECAR_ORIGIN}/health`;

/** A refused port answers instantly; a wedged one must not stall the rail. */
export const SIDECAR_PROBE_TIMEOUT_MS = 1500;

export type SidecarStatus = "unknown" | "up" | "down";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Wrapped rather than passed as a bare reference: a detached `window.fetch`
 * throws "Illegal invocation" in browsers that check the receiver.
 */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface SidecarProbeOptions {
  /** Aborts an in-flight probe (component unmount). Answers `"down"`. */
  signal?: AbortSignal;
  /** Overridable so the unit test does not have to wait out the real budget. */
  timeoutMs?: number;
}

/**
 * Resolves `"up"` only on a 2xx from the sidecar's health endpoint.
 *
 * `fetchImpl` is injected so the unit test needs no network and no port.
 *
 * The timeout is a RACE, not just an `AbortSignal`: a transport that ignores
 * abort (or a stubbed fetch that never settles) would otherwise leave the rail
 * stuck on `unknown` forever, which reads as "still checking" rather than the
 * fail-closed answer the owner is owed.
 */
export async function probeSidecar(
  fetchImpl: FetchLike = defaultFetch,
  options: SidecarProbeOptions = {},
): Promise<Exclude<SidecarStatus, "unknown">> {
  const { signal, timeoutMs = SIDECAR_PROBE_TIMEOUT_MS } = options;
  // An already-aborted signal fires no `abort` event, so wiring the listener
  // alone would issue a real loopback request and spend the whole timeout
  // budget on an answer nobody is waiting for.
  if (signal?.aborted) return "down";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  const expired = new Promise<"down">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("down");
    }, timeoutMs);
  });

  const probed = (async (): Promise<"up" | "down"> => {
    try {
      const response = await fetchImpl(SIDECAR_HEALTH_URL, {
        method: "GET",
        // The sidecar is a different origin; a cached or opaque answer would
        // let a stale "up" outlive the process it claims is running.
        cache: "no-store",
        signal: controller.signal,
      });
      return response.ok ? "up" : "down";
    } catch {
      // Connection refused, DNS, CORS, abort — all the same answer.
      return "down";
    }
  })();

  try {
    return await Promise.race([probed, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
