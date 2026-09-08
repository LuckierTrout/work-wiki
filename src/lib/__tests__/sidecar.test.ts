/**
 * Story 1.3 — the sidecar probe fails CLOSED.
 *
 * Fail-closed is a behaviour, not a comment: only an affirmative 2xx from the
 * loopback health endpoint may report `up`. A refused port, a 500, and a
 * process that accepts the connection and then wedges must all answer `down`,
 * and the wedged case must answer at all rather than leaving the rail stuck on
 * "unknown" forever. The probe suite injects its fetch, so none of THOSE tests
 * touches a network.
 *
 * The DW-25 suite at the bottom is different on purpose: it binds a real
 * sidecar on an ephemeral port and drives it with the global `fetch`, because
 * the thing under test is response HEADERS on a cross-origin request and a
 * stub would only re-state the assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  SIDECAR_ALLOWED_ORIGINS_ENV,
  allowSidecarOrigin,
  parseSidecarAllowedOrigins,
} from "../../../sidecar/server.mjs";
import {
  SIDECAR_HEALTH_URL,
  SIDECAR_ORIGIN,
  SIDECAR_PROBE_TIMEOUT_MS,
  isSidecarDefaultAdmittedOrigin,
  probeSidecar,
} from "../sidecar";
import { settingsSource, sidecarHarness } from "./sidecar-harness";

function respond(ok: boolean, status: number): Response {
  return { ok, status } as Response;
}

describe("loopback contract", () => {
  it("probes 127.0.0.1:19828/api/v1/health", () => {
    // The Worker cannot reach localhost, so this URL must never become a
    // same-origin server route pretending to check the sidecar.
    expect(SIDECAR_ORIGIN).toBe("http://127.0.0.1:19828");
    expect(SIDECAR_HEALTH_URL).toBe("http://127.0.0.1:19828/api/v1/health");
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

/**
 * DW-25 — the cross-origin contract a deployed HTTPS page has to satisfy.
 *
 * The probe suite above fails closed on a rejected fetch, which is right; what
 * it cannot tell the owner is WHY a running sidecar is unreachable. These pin
 * the door's half of the answer: loopback unchanged with nothing configured, a
 * NAMED deployment origin admitted, everything else refused bare, and Chrome's
 * Private Network Access preflight answered only when it is asked for and only
 * for an origin already admitted.
 */
describe("sidecar cross-origin contract (DW-25)", () => {
  const harness = sidecarHarness({
    settingsSource: settingsSource({
      enabled: true,
      allowUnauthenticated: true,
      token: null,
      tokenSource: "none",
      skillEnablement: {},
    }),
    wikiRegistry: { current: () => [], currentId: () => null } as never,
  });
  let savedEnv: string | undefined;

  beforeEach(() => {
    // A developer machine with this exported would otherwise make "refuses an
    // unconfigured origin" pass or fail for a reason that is not the code.
    savedEnv = process.env[SIDECAR_ALLOWED_ORIGINS_ENV];
    delete process.env[SIDECAR_ALLOWED_ORIGINS_ENV];
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[SIDECAR_ALLOWED_ORIGINS_ENV];
    else process.env[SIDECAR_ALLOWED_ORIGINS_ENV] = savedEnv;
    await harness.closeAll();
  });

  async function listen(allowedOrigins?: string[]): Promise<string> {
    return listenWith({}, allowedOrigins);
  }

  async function listenWith(
    extra: Record<string, unknown>,
    allowedOrigins?: string[],
  ): Promise<string> {
    return harness.listen({
      ...extra,
      // Absent entirely when the caller passes nothing, so the option's own
      // default — the env read — is what runs.
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    });
  }

  it("admits loopback with nothing configured, exactly as before", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(response.headers.get("vary")).toBe("Origin");
    await response.json();
  });

  it("admits IPv6 loopback with nothing configured (DW-605)", async () => {
    // The same machine, on the address `localhost` frequently resolves to on a
    // dual-stack host. A dev server bound to IPv6 loopback was refused by
    // default while the identical process reached through `localhost` was
    // admitted — the difference the widened regex removes.
    const base = await listen();
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "http://[::1]:3000" },
    });
    expect(response.status).toBe(200);
    // Echoed back with the brackets intact: `normalizeOrigin` already returns
    // an IPv6 literal unchanged, so no further change was needed for `cors`.
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://[::1]:3000",
    );
    expect(response.headers.get("vary")).toBe("Origin");
    await response.json();
  });

  it("still refuses an origin that only LOOKS like IPv6 loopback", async () => {
    // The widening is the bracketed literal and nothing else. Anchored at both
    // ends, so a hostname that merely opens with it is a different machine.
    const base = await listen();
    for (const origin of [
      "http://[::1].evil.test",
      "http://[::1]evil.test",
      "https://evil.example",
    ]) {
      const response = await fetch(`${base}/api/v1/health`, {
        headers: { origin },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "origin_not_allowed",
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toBe("Origin");
    }
  });

  it("admits a request with no Origin header, echoes nothing, still varies", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // `Vary` on a response that echoed NOTHING is the half of the change a
    // cache depends on, and the only assertion that observes it.
    expect(response.headers.get("vary")).toBe("Origin");
    await response.json();
  });

  it("admits a CONFIGURED deployment origin, so the probe can answer up", async () => {
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://app.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    // Never `*`: the door is an allowlist that echoes, not an open door.
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    await response.json();
  });

  it("echoes the CANONICAL origin, not the header as it arrived", async () => {
    // The match is on the normalized origin, so echoing the raw header would
    // answer a request the browser then rejects as a mismatch — a CORS failure
    // indistinguishable from a refusal.
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "HTTPS://APP.EXAMPLE" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    await response.json();
  });

  it("reads the allowlist from the env when no option is passed", async () => {
    // This default parameter is the ONLY path by which the env reaches the
    // production door: `isMain` passes no `allowedOrigins`.
    expect(SIDECAR_ALLOWED_ORIGINS_ENV).toBe("WORKWIKI_SIDECAR_ALLOWED_ORIGINS");
    process.env[SIDECAR_ALLOWED_ORIGINS_ENV] = "https://env.example";
    const base = await listen();
    const admitted = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://env.example" },
    });
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("access-control-allow-origin")).toBe(
      "https://env.example",
    );
    await admitted.json();
    const refused = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://other.example" },
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({ error: "origin_not_allowed" });
  });

  it("refuses the same origin when it is NOT configured", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://app.example" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-private-network")).toBeNull();
    // The refusal is origin-specific too: a shared cache must not replay it at
    // an origin that would have been admitted.
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("refuses a lookalike of a configured origin", async () => {
    // A `startsWith`/`includes` allowlist lets this through; equality does not.
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://app.example.evil.test" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses the literal Origin: null a sandboxed frame sends", async () => {
    // Sandboxed iframes, `file://` pages and some redirect chains send this.
    // 403 is the right answer, and it must not soften into an allow.
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "null" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("admits a configured origin to the door but NOT past the token gate", async () => {
    // The gate sits ahead of every route, so an allowed origin reaches Chat,
    // the workspace, Skills and the kernel proxy. The allowlist admits an
    // origin; it does not authorize it.
    const guarded = {
      current: () => ({
        enabled: true,
        allowUnauthenticated: false,
        token: "s3cret-loopback-token",
        tokenSource: "env",
        skillEnablement: {},
      }),
      refresh: async () => guarded.current(),
    };
    const base = await listenWith({ settingsSource: guarded }, ["https://app.example"]);
    const response = await fetch(`${base}/api/v1/skills`, {
      headers: { origin: "https://app.example" },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    // Health stays public even behind the token gate.
    const health = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://app.example" },
    });
    expect(health.status).toBe(200);
    await health.json();
  });

  it("answers Chrome's PNA preflight for an allowed origin", async () => {
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
    // Preflight-only, and the answer varies by the PNA ask as well as by origin
    // — otherwise a cached non-PNA 204 gets replayed for a PNA preflight.
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Private-Network",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reads the PNA ask leniently, since its spelling protects nothing", async () => {
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "TRUE",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("refuses the PNA preflight from an unconfigured origin, before CORS", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-private-network")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not volunteer the PNA header when the preflight did not ask", async () => {
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "GET",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-private-network")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
  });

  it("keeps Access-Control-Max-Age off a plain GET", async () => {
    const base = await listen(["https://app.example"]);
    const response = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://app.example" },
    });
    expect(response.headers.get("access-control-max-age")).toBeNull();
    await response.json();
  });

  /**
   * The two halves joined: the intent's pin is at the PROBE, not the door.
   *
   * `probeSidecar` is the thing the rail calls, and inferring its answer from a
   * status code leaves the one seam that matters — a real sidecar, a real
   * cross-origin request, the probe's own verdict — unobserved.
   */
  function probeFrom(base: string, origin: string) {
    return (input: string, init: RequestInit = {}) =>
      // `cache` is dropped rather than forwarded: it is a browser directive and
      // undici has no store to bypass. The `Origin` is what this test is about.
      fetch(input.replace(SIDECAR_ORIGIN, base), {
        method: init.method,
        signal: init.signal,
        headers: { origin },
      });
  }

  it("answers up through probeSidecar from a CONFIGURED origin", async () => {
    const base = await listen(["https://app.example"]);
    await expect(
      probeSidecar(probeFrom(base, "https://app.example")),
    ).resolves.toBe("up");
  });

  it("answers down through probeSidecar from an unconfigured origin", async () => {
    const base = await listen();
    await expect(
      probeSidecar(probeFrom(base, "https://app.example")),
    ).resolves.toBe("down");
  });
});

describe("parseSidecarAllowedOrigins", () => {
  it("defaults to loopback-only for absent or garbage input", () => {
    expect(parseSidecarAllowedOrigins(undefined)).toEqual([]);
    expect(parseSidecarAllowedOrigins("")).toEqual([]);
    expect(parseSidecarAllowedOrigins("   ")).toEqual([]);
    expect(parseSidecarAllowedOrigins(",,,")).toEqual([]);
    expect(parseSidecarAllowedOrigins(42 as never)).toEqual([]);
    expect(parseSidecarAllowedOrigins("not a url at all")).toEqual([]);
  });

  it("drops the malformed entries and keeps the one real origin", () => {
    // A bad env value must never stop the sidecar from binding, so every one of
    // these is dropped rather than thrown on.
    expect(
      parseSidecarAllowedOrigins(
        "*, https://a.example/path, ftp://x, HTTPS://B.Example:443/, , https://b.example",
      ),
    ).toEqual(["https://b.example"]);
  });

  it("refuses wildcards and suffix patterns outright", () => {
    expect(parseSidecarAllowedOrigins("https://*.example")).toEqual([]);
    expect(parseSidecarAllowedOrigins("*")).toEqual([]);
  });

  it("refuses credentials, queries and fragments", () => {
    expect(parseSidecarAllowedOrigins("https://user:pw@a.example")).toEqual([]);
    expect(parseSidecarAllowedOrigins("https://a.example?x=1")).toEqual([]);
    expect(parseSidecarAllowedOrigins("https://a.example#f")).toEqual([]);
  });

  it("keeps an explicit non-default port and normalizes case", () => {
    expect(parseSidecarAllowedOrigins("HTTP://App.Example:8443")).toEqual([
      "http://app.example:8443",
    ]);
  });

  it("dedupes entries that normalize to the same origin", () => {
    expect(
      parseSidecarAllowedOrigins("https://a.example, https://A.Example/, https://a.example:443"),
    ).toEqual(["https://a.example"]);
  });
});

describe("allowSidecarOrigin with a configured list", () => {
  it("keeps the one-argument loopback contract intact", () => {
    // The default arg is what keeps `workbench-epic3.test.ts` honest.
    expect(allowSidecarOrigin(undefined)).toBe(true);
    expect(allowSidecarOrigin("http://localhost:3000")).toBe(true);
    expect(allowSidecarOrigin("http://127.0.0.1:19828")).toBe(true);
    expect(allowSidecarOrigin("https://evil.example")).toBe(false);
  });

  it("admits a configured origin without widening the loopback regex", () => {
    const allowed = parseSidecarAllowedOrigins("https://app.example");
    expect(allowSidecarOrigin("https://app.example", allowed)).toBe(true);
    expect(allowSidecarOrigin("https://APP.example", allowed)).toBe(true);
    expect(allowSidecarOrigin("https://app.example.evil.test", allowed)).toBe(false);
    expect(allowSidecarOrigin("https://evil.example", allowed)).toBe(false);
    // Loopback still passes when a list is configured.
    expect(allowSidecarOrigin("http://localhost:3000", allowed)).toBe(true);
  });

  it("does not trust an unparsed injected list", () => {
    expect(allowSidecarOrigin("https://app.example", ["https://*.example"])).toBe(false);
    expect(allowSidecarOrigin("https://app.example", ["*"])).toBe(false);
    // The fast path is exact string equality; a raw entry still has to survive
    // normalization before it can match.
    expect(allowSidecarOrigin("https://app.example", ["HTTPS://APP.EXAMPLE/"])).toBe(true);
  });

  it("refuses the literal string null", () => {
    expect(allowSidecarOrigin("null", ["https://app.example"])).toBe(false);
  });
});

/**
 * DW-607 — the browser's mirror of the door's default, held to the door.
 *
 * `src/lib/sidecar.ts` restates `LOOPBACK_ORIGIN_RE` because it has to: AD-6
 * forbids `sidecar/*.mjs` importing `src/lib`, and nothing the browser ships may
 * import `sidecar/*.mjs`, so the two definitions cannot be one module. This
 * suite is the only thing that keeps them the same rule — it imports BOTH and
 * runs them over one table, so widening or narrowing either alone fails here
 * rather than in a browser nobody is watching.
 *
 * The two sides do NOT agree on every input, and the rows where they differ are
 * enumerated in `DIVERGENT` below with the reason. Enumerating them is the
 * point: an unlisted disagreement is a drift, and the table is what surfaces it.
 */
describe("isSidecarDefaultAdmittedOrigin mirrors the door (DW-607)", () => {
  /** Loopback, IPv6, deployed, malformed, padded, and the literal `null`. */
  const ORIGINS = [
    "http://localhost:3000",
    "http://LOCALHOST:3000",
    "https://localhost",
    "http://127.0.0.1:19828",
    "http://127.0.0.1",
    "http://[::1]:3000",
    "http://[::1]",
    "https://[::1]:8443",
    "http://[::ffff:127.0.0.1]:3000",
    "http://[fe80::1]:3000",
    "http://127.0.0.2:3000",
    "https://app.example",
    "https://app.example.evil.test",
    "http://[::1].evil.test",
    "https://localhost.evil.test",
    "ws://localhost:3000",
    "not a url",
    "null",
    "",
    "  http://localhost:3000  ",
  ] as const;

  /**
   * The rows where the two sides answer differently ON PURPOSE.
   *
   * Both come from the sides reading different KINDS of value, and both are
   * argued in `isSidecarDefaultAdmittedOrigin`'s docblock. They are listed here
   * rather than dropped from the table so the divergence is enumerated — an
   * unlisted third one is a drift, not an exemption.
   */
  const DIVERGENT: Record<string, { door: boolean; mirror: boolean }> = {
    // A falsy origin on the wire is NO `Origin` header — curl, a non-browser
    // client — which the sidecar has always admitted. A page with no origin to
    // reason about is not that.
    "": { door: true, mirror: false },
    // The mirror trims and the door does not. The door reads a header a browser
    // never pads; the mirror reads a JS value whose surrounding whitespace is an
    // artefact of how it was carried.
    "  http://localhost:3000  ": { door: false, mirror: true },
  };

  it("agrees with the one-argument allowSidecarOrigin on every origin", () => {
    for (const origin of ORIGINS) {
      // The one-argument call IS "nothing configured", which is exactly the
      // question the browser-side predicate answers — so on every row but the
      // enumerated exceptions the two must return the SAME boolean.
      const divergent = DIVERGENT[origin];
      if (divergent) {
        expect(allowSidecarOrigin(origin)).toBe(divergent.door);
        expect(isSidecarDefaultAdmittedOrigin(origin)).toBe(divergent.mirror);
        continue;
      }
      expect(isSidecarDefaultAdmittedOrigin(origin)).toBe(
        allowSidecarOrigin(origin),
      );
    }
  });

  it("admits the three loopback spellings and nothing else", () => {
    expect(isSidecarDefaultAdmittedOrigin("http://localhost:3000")).toBe(true);
    expect(isSidecarDefaultAdmittedOrigin("http://127.0.0.1:19828")).toBe(true);
    expect(isSidecarDefaultAdmittedOrigin("http://[::1]:3000")).toBe(true);
    // Not a bare `::1`, not another IPv6 address, not a lookalike hostname.
    expect(isSidecarDefaultAdmittedOrigin("http://::1:3000")).toBe(false);
    expect(isSidecarDefaultAdmittedOrigin("http://[::ffff:127.0.0.1]")).toBe(false);
    expect(isSidecarDefaultAdmittedOrigin("http://[::1].evil.test")).toBe(false);
    expect(isSidecarDefaultAdmittedOrigin("https://app.example")).toBe(false);
  });

  it("never throws on what a page can actually hand it", () => {
    // The caller holds `window.location.origin`, which is absent on the server
    // render and can be the literal `"null"` in a sandboxed frame.
    expect(isSidecarDefaultAdmittedOrigin(null)).toBe(false);
    expect(isSidecarDefaultAdmittedOrigin(undefined)).toBe(false);
    expect(isSidecarDefaultAdmittedOrigin("")).toBe(false);
    expect(isSidecarDefaultAdmittedOrigin("null")).toBe(false);
    // Trimmed — one of the two enumerated divergences from the door above.
    expect(isSidecarDefaultAdmittedOrigin("  http://localhost:3000  ")).toBe(true);
  });
});

/**
 * DW-604 — the knob has to be findable without reading the source.
 *
 * The env name lived in a JSDoc in `sidecar/server.mjs` and a module comment in
 * `src/lib/sidecar.ts`, which is nowhere an operator looks. Both pins read the
 * name FROM THE MODULE rather than retyping it, so a rename that leaves the
 * docs behind fails here instead of stranding the one person who needs them.
 */
describe("the origin allowlist is documented for operators (DW-604)", () => {
  const ROOT = path.resolve(__dirname, "../../..");

  it("names the env, its shape and a worked value in .env.example", async () => {
    const env = await readFile(path.join(ROOT, ".env.example"), "utf8");
    expect(env).toContain(SIDECAR_ALLOWED_ORIGINS_ENV);
    // A worked value, not just the name: the comma-separated bare-origin shape
    // is the part a reader gets wrong.
    expect(env).toContain(`${SIDECAR_ALLOWED_ORIGINS_ENV}=https://`);
    expect(env).toContain("Comma-separated bare origins");
    // Loopback needs no entry, and a bad entry is dropped rather than fatal.
    expect(env).toMatch(/\[::1\]/);
    expect(env).toContain("DROPPED");
    // Naming an origin opens more than health.
    expect(env).toContain("/api/v1");
  });

  it("answers the SYMPTOM in DEPLOY.md's troubleshooting", async () => {
    const deploy = await readFile(path.join(ROOT, "DEPLOY.md"), "utf8");
    const troubleshooting = deploy.slice(deploy.indexOf("## Troubleshooting"));
    expect(troubleshooting).toContain("### Chat says the sidecar is down");
    expect(troubleshooting).toContain(SIDECAR_ALLOWED_ORIGINS_ENV);
    // The three causes, in `src/lib/sidecar.ts`'s order.
    expect(troubleshooting).toContain("origin_not_allowed");
    expect(troubleshooting).toContain("mixed content");
    // The one failure no configuration can fix has to say so.
    expect(troubleshooting).toContain("No configuration fixes this");
    expect(troubleshooting).toContain("Safari");
  });
});
