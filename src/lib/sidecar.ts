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
 *
 * THE CROSS-ORIGIN CONTRACT (DW-25). The probe is a cross-origin request from
 * whatever page the Workbench is served on to `http://127.0.0.1:19828`, so
 * several things must go right before a running sidecar can report `up`. When a
 * deployed HTTPS page reports `down` while the sidecar is demonstrably running,
 * it is almost always one of the three below. (Not always: the 1500 ms budget,
 * the sidecar's load gate, a port conflict that made the process exit, a
 * browser extension or corporate proxy, and a sandboxed embedding that sends
 * `Origin: null` all produce the same `down`.)
 *
 * 1. ORIGIN NOT ALLOWED. `sidecar/server.mjs` admits the three spellings of
 *    THIS MACHINE — `localhost`, `127.0.0.1`, and the bracketed IPv6 loopback
 *    literal `[::1]` (DW-605) — on either scheme and any port with no
 *    configuration. Only those three hostnames, and the match is anchored, so
 *    `http://[::1].evil.test` is not loopback. Every other origin
 *    must be listed in `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` (comma-separated,
 *    e.g. `https://app.example`). An origin that is neither gets
 *    `403 {"error":"origin_not_allowed"}` with no `Access-Control-Allow-Origin`
 *    at all — the allowlist is exact-match on the normalized origin, never a
 *    wildcard, a suffix, or `*`, so `https://app.example.evil.test` is refused
 *    however much it resembles a configured entry, and so is the literal
 *    `Origin: null` a sandboxed iframe or a `file://` page sends. A request
 *    with NO `Origin` header at all — curl, other non-browser clients, and
 *    cross-site `<img>`/`<script>` style GETs — is admitted and has nothing
 *    echoed, which is unchanged from Epic 3. For an admitted origin the sidecar
 *    echoes that origin back, NORMALIZED, in `Access-Control-Allow-Origin`
 *    (never `*`), sends `Vary: Origin` on every answer including the 403, and
 *    allows `GET, POST, PATCH, OPTIONS` with `Content-Type, Accept,
 *    Authorization, x-llm-wiki-token`. There is no
 *    `Access-Control-Allow-Credentials` and there are no cookies: the loopback
 *    token travels in a header.
 *
 *    THE GATE SITS AHEAD OF EVERY ROUTE, not just health. A configured origin
 *    can therefore reach Chat — which drives the local Agent and shell —
 *    `/api/v1/workspace/file`, `/api/v1/skills` and the kernel proxy, with the
 *    loopback token gate as the only remaining barrier. Two consequences worth
 *    naming when choosing what to configure: a plaintext `http://` entry can be
 *    forged by anyone on the path, who then inherits that whole surface; and
 *    the preflight is cacheable for ten minutes, so an origin REMOVED from the
 *    list stays usable in an already-primed browser for up to that long.
 *
 * 2. UNANSWERED PNA PREFLIGHT. Chrome treats `127.0.0.1` as a private network,
 *    so a request from a public page is preceded by a Private Network Access
 *    preflight — an `OPTIONS` carrying `Access-Control-Request-Private-Network:
 *    true`. The sidecar answers `204` with `Access-Control-Allow-Private-Network:
 *    true` for an admitted origin. Without that header Chrome fails the request
 *    before the health route is ever reached, so the probe sees only a rejected
 *    fetch. That header pair is the header-based design; Chrome has been moving
 *    public-to-local requests behind a Local Network Access PERMISSION PROMPT
 *    that no response header satisfies, so a correct answer here may still not
 *    be sufficient on its own in a given Chrome version.
 *
 * 3. MIXED-CONTENT BLOCK. Safari blocks an `http://127.0.0.1` subresource from
 *    an HTTPS page, and no response the sidecar sends can change that — the
 *    request never leaves the browser. `down` is the HONEST answer there, not a
 *    bug to work around: the sidecar binds `127.0.0.1:19828` over plain HTTP
 *    and does not serve TLS or mint a certificate. (Chrome and Firefox both
 *    exempt loopback from mixed-content blocking, because `127.0.0.1` is
 *    "potentially trustworthy" per Secure Contexts — the carve-out is what
 *    makes any of this possible.) Chrome, with the origin configured and the
 *    PNA preflight answered, is the supported path for a deployed page.
 */

export const SIDECAR_ORIGIN = "http://127.0.0.1:19828";
export const SIDECAR_HEALTH_URL = `${SIDECAR_ORIGIN}/api/v1/health`;

/**
 * The browser-side MIRROR of `sidecar/server.mjs`'s `LOOPBACK_ORIGIN_RE`.
 *
 * A DUPLICATE ON PURPOSE. AD-6 forbids `sidecar/*.mjs` importing `src/lib`, and
 * nothing the browser ships may import `sidecar/*.mjs`, so there is no module
 * the two sides could share. What holds them together is a parity test that
 * imports both and runs them over one table of origins — not this comment.
 *
 * Anchored at both ends, for the same reason the door compares NORMALIZED
 * origins rather than substrings: `http://[::1].evil.test` and
 * `https://localhost.evil.test` are not loopback.
 */
const DEFAULT_ADMITTED_ORIGIN_RE =
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Would the door admit this origin with NOTHING configured?
 *
 * This is the ONE thing the browser can know about which of the three failures
 * above it is looking at. `fetch` cannot report why it was rejected — a refused
 * connection and a CORS refusal are the same rejected promise — so no probe can
 * tell them apart. But on an origin admitted by default, a `down` can only mean
 * nothing answered; on any other origin it is genuinely ambiguous, and the copy
 * has to say so ({@link chatSidecarDownCopy} in `workbench-modes`).
 *
 * NEVER THROWS, and answers `false` for anything that is not a string: the
 * caller holds `window.location.origin`, which is absent on the server render
 * and before the first effect runs.
 *
 * TWO DELIBERATE DIVERGENCES from the door, both from the two sides reading
 * different KINDS of value, and both pinned as exceptions in the parity suite
 * rather than left to be discovered:
 *
 * - `""`. `allowSidecarOrigin("")` admits it, because a falsy origin on the
 *   wire means NO `Origin` header — curl, a non-browser client — which the
 *   sidecar has always allowed. A page with no origin to reason about is not
 *   that, and must not claim the door would admit it.
 * - PADDING. This trims; `LOOPBACK_ORIGIN_RE.test(origin)` does not, so
 *   `"  http://localhost:3000  "` is refused at the door and admitted here.
 *   The door reads a header a browser never pads, and a padded one is
 *   malformed. This reads a JS value — a prop, a stored string, a test's
 *   literal — where surrounding whitespace is an artefact of how it was
 *   carried, not a claim about the origin. Trimming is the right answer on
 *   THIS side and would be a loosened door on the other.
 */
export function isSidecarDefaultAdmittedOrigin(
  origin: string | null | undefined,
): boolean {
  return typeof origin === "string" && DEFAULT_ADMITTED_ORIGIN_RE.test(origin.trim());
}

/** Locked SSE event names for loopback Chat. The sidecar must emit only these. */
export const SIDECAR_SSE_EVENTS = [
  "meta",
  "agent",
  "done",
  "cancelled",
  "error",
] as const;

export type SidecarSseEvent = (typeof SIDECAR_SSE_EVENTS)[number];

export function sidecarChatUrl(wikiId: string): string {
  return `${SIDECAR_ORIGIN}/api/v1/projects/${encodeURIComponent(wikiId)}/chat`;
}

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
