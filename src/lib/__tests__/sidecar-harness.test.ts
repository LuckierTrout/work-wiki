/**
 * The rules `sidecar-harness.ts` owns, executed (DW-606).
 *
 * Three suites used to hold three copies of this bind-and-teardown code, and
 * the copies had drifted apart in exactly the places no passing test looks:
 * two of them never rejected on a bind `error`, never refused a
 * non-`AddressInfo` `address()`, and never called `closeAllConnections()`. A
 * rule that only ever runs on a path no test reaches is a rule that decays back
 * into three copies, so the ones that CAN be executed are pinned here — the
 * same reason `source-scan.test.ts` exists beside `source-scan.ts`.
 *
 * WHICH OF THE THREE ARE ACTUALLY PINNED, stated plainly so this file is not
 * read as covering more than it does:
 *
 * - the bind `error` reject, and
 * - the non-`AddressInfo` `address()` throw
 *
 * are executed below. `closeAllConnections()` is NOT. Deleting that line leaves
 * this file and all three suites green: it matters only when an undici
 * keep-alive socket outlives the response, and whether one does is a function
 * of the agent's pooling and the machine's timing rather than of anything a
 * test can force here. A pin that passes either way would assert nothing while
 * looking like protection, so the case for that line rests on the argument in
 * `sidecar-harness.ts`'s header — a hung `afterEach` is not a failing test —
 * and not on an assertion.
 *
 * `sidecarHarness().listen()` itself is exercised by the three suites that call
 * it for real; what those suites cannot provoke is a bind that fails, which is
 * why `bindLoopback` is reachable on its own.
 */
import { afterEach, describe, expect, it } from "vitest";
import http, { type Server } from "node:http";

import {
  bindLoopback,
  settingsSource,
  sidecarHarness,
  type SidecarHarness,
  type SidecarSettings,
} from "./sidecar-harness";

const open: Server[] = [];
const harnesses: SidecarHarness[] = [];

function stubServer(): Server {
  const server = http.createServer();
  open.push(server);
  return server;
}

/**
 * A harness registered for unconditional teardown.
 *
 * Every harness in this file is built through here rather than closed inline on
 * a case's last line: an assertion that fails before that line would skip the
 * close and leak a bound port — the exact property the harness exists to give
 * its own callers, so this file should not be the one place that forgoes it.
 */
function newHarness(defaults: Record<string, unknown> = {}): SidecarHarness {
  const harness = sidecarHarness(defaults);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all([
    ...harnesses.splice(0).map((harness) => harness.closeAll()),
    ...open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // NO `server.listening` GUARD. `listening` flips true a tick AFTER
          // `listen()` returns, so a case that settles in a microtask — the
          // `error` one below does — can reach teardown while the bind is
          // still in flight and skip the close on a false reading, leaving a
          // real port held for the rest of this worker's life. Closing
          // unconditionally is safe in both directions: `close()` cancels an
          // in-flight bind, and on a server that never bound it simply calls
          // back with `ERR_SERVER_NOT_RUNNING`, which is the state we wanted.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  ]);
});

describe("bindLoopback", () => {
  it("binds an ephemeral loopback port and returns its base URL", async () => {
    const server = stubServer();
    const base = await bindLoopback(server);
    // A real port, not the `http://127.0.0.1:0` the loose copies handed back.
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    expect((server.address() as { port: number }).port).toBe(
      Number(new URL(base).port),
    );
  });

  it("rejects when the bind emits an error instead of hanging to the timeout", async () => {
    const server = stubServer();
    // The handler is attached synchronously by `bindLoopback` before it awaits,
    // so the emit below lands on it — standing in for the EADDRINUSE or EACCES
    // a real machine would raise.
    const bound = bindLoopback(server);
    server.emit("error", new Error("EACCES: permission denied"));
    await expect(bound).rejects.toThrow("EACCES: permission denied");
  });

  it("stops listening for errors once the bind has succeeded", async () => {
    // The reject handler must be DETACHED on success. Left attached it would
    // absorb the first post-bind `error` onto an already-settled promise, where
    // it vanishes — a change to the SUCCESS path, since two of the three copies
    // this replaces attached no handler at all and let such an error surface.
    const server = stubServer();
    await bindLoopback(server);
    expect(server.listenerCount("error")).toBe(0);
  });

  it("throws when the server reports an address that is not an AddressInfo", async () => {
    // A pipe/UNIX-socket server answers `address()` with a string, and a server
    // that never bound answers `null`. Either one used to become the port `0`
    // in a base URL every subsequent fetch in the suite would fail against.
    for (const reported of ["/tmp/sidecar.sock", null]) {
      const fake = {
        once: () => fake,
        removeListener: () => fake,
        listen: (_port: number, _host: string, done: () => void) => {
          done();
          return fake;
        },
        address: () => reported,
      } as unknown as Server;
      await expect(bindLoopback(fake)).rejects.toThrow(
        `sidecar test server did not bind a port: ${String(reported)}`,
      );
    }
  });
});

describe("sidecarHarness", () => {
  it("closes a server the suite started itself and handed to track()", async () => {
    // `workbench-epic8.test.ts` stands up its own stub kernel alongside the
    // sidecar and used to push it onto the same array; `track()` is what
    // replaced that, so a kernel left listening would leak the port.
    const harness = newHarness();
    const kernel = http.createServer();
    harness.track(kernel);
    await bindLoopback(kernel);
    expect(kernel.listening).toBe(true);

    await harness.closeAll();
    expect(kernel.listening).toBe(false);
  });

  it("lets a per-call override win over the suite default", async () => {
    // The three suites rely on this order: two pass a `wikiRegistry` default and
    // then override it per call through their `extra`.
    //
    // Asserted by watching WHICH source the server consults, not by reading a
    // status code off a door: `sidecar/server.mjs` is read-only to this change,
    // and a test keyed on what `enabled: false` produces would pin its door
    // semantics here as a side effect of pinning a spread order.
    const consulted: string[] = [];
    const tagged = (tag: string) => {
      const value: SidecarSettings = {
        enabled: true,
        allowUnauthenticated: true,
        token: null,
        tokenSource: "none",
        skillEnablement: {},
      };
      const source = settingsSource(value);
      return {
        ...source,
        current: () => {
          consulted.push(tag);
          return source.current();
        },
      };
    };

    const harness = newHarness({ settingsSource: tagged("default") });
    const base = await harness.listen({ settingsSource: tagged("override") });
    // `/api/v1/health` is answered before any authorization branch, so one
    // request is enough and none of it depends on what the door admits.
    await (await fetch(`${base}/api/v1/health`)).json();

    expect(consulted.length).toBeGreaterThan(0);
    expect([...new Set(consulted)]).toEqual(["override"]);
  });
});
