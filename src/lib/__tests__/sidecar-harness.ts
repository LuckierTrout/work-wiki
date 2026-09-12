/**
 * One `listen()` for the three suites that stand up a REAL sidecar on an
 * ephemeral loopback port and keep a registry of what they opened (DW-606).
 *
 * NOT every binder in the repo, and the difference is deliberate:
 * `workbench-epic3.test.ts` holds a fourth copy of the bind, but a differently
 * shaped one — `openDoorServer()` (:51) is an UNBOUND factory whose callers
 * bind and close each server inside their own `try`/`finally` (:182, :485),
 * with no registry, no `wikiRegistry`, and no `afterEach` to drain. Folding it
 * in would mean changing how that suite manages lifetimes, which is a separate
 * piece of work; it is named here so the next reader does not mistake this
 * module for an exhaustive one.
 *
 * `sidecar.test.ts`, `workbench-epic8.test.ts` and `epic8-remediation.test.ts`
 * each grew their own copy of the same twelve lines — build a
 * `createSidecarServer`, bind it to `(0, "127.0.0.1")`, read the port back off
 * `address()`, remember the server so `afterEach` can close it — and the copies
 * had already drifted apart in their FAILURE paths:
 *
 * - only `sidecar.test.ts` attached `server.once("error", reject)`, so a taken
 *   port or a permissions refusal hung the other two out to the suite timeout
 *   instead of naming what went wrong;
 * - only `sidecar.test.ts` threw when `address()` was not an object, so the
 *   other two silently handed their tests `http://127.0.0.1:0`;
 * - only `sidecar.test.ts` called `closeAllConnections()` before `close()`, so
 *   an undici keep-alive socket could wedge the other two's teardown.
 *
 * THE STRICTEST OF THE THREE WINS, on all three counts. That is safe precisely
 * because every difference is failure-path only: a bind that succeeds and a
 * server that reports an `AddressInfo` behave identically under all three
 * variants, so no passing test changes meaning — the two loose suites merely
 * stop hanging or lying when something goes wrong.
 *
 * WHAT STAYS PER-SUITE. The fixtures do: each suite passes its own defaults
 * (`settingsSource`, and a `wikiRegistry` in two of the three) into
 * `sidecarHarness(...)`, and per-call `overrides` are spread AFTER them — the
 * same order the copies used, so a call site that passes `wikiRegistry` in its
 * `extra` still overrides the suite default. So does `afterEach`: this module
 * must not import `vitest` (it is not a suite and is loaded by both projects),
 * and `sidecar.test.ts`'s teardown additionally saves and restores
 * `SIDECAR_ALLOWED_ORIGINS_ENV`, which is that suite's business and not the
 * harness's.
 *
 * `allowedOrigins` IS NEVER DEFAULTED HERE. `createSidecarServer` reads
 * `SIDECAR_ALLOWED_ORIGINS_ENV` at construction as that option's own default,
 * and an `allowedOrigins: undefined` key in the options object would still
 * count as "passed" and defeat it. Callers therefore omit the key entirely
 * rather than passing `undefined`, exactly as `sidecar.test.ts` already did.
 *
 * Not named `*.test.ts`: `vitest.config.ts` collects
 * `src/**\/__tests__/**\/*.test.ts` into the `node` project, so a helper wearing
 * that suffix would be collected as a suite with no assertions in it. It sits
 * beside its four importers rather than under `src/test/` because all four
 * share this one directory, and is imported as `./sidecar-harness` — the same
 * rule `source-scan.ts` and `internal-link-fixture.ts` follow.
 */
import type { Server } from "node:http";

import { createSidecarServer } from "../../../sidecar/server.mjs";

/**
 * The loopback settings shape all three suites hand to `settingsSource`.
 *
 * `sidecar/server.mjs` is untyped `.mjs` with no `.d.ts`, so this is the
 * suites' own description of what they pass, not a type read off the server.
 */
export type SidecarSettings = {
  enabled: boolean;
  allowUnauthenticated: boolean;
  token: string | null;
  tokenSource: string;
  skillEnablement: Record<string, boolean>;
};

/**
 * A `settingsSource` that answers with `value` forever.
 *
 * The SAME object comes back from every `current()` call rather than a freshly
 * built literal: `sidecar/server.mjs` calls `current()` once per request and
 * only reads fields off the result, so identity is unobservable — and this is
 * what `workbench-epic8.test.ts` already did.
 *
 * The parameter is `SidecarSettings` rather than a free type variable ON
 * PURPOSE. `sidecarHarness`'s options are `Record<string, unknown>` — they have
 * to be, since `sidecar/server.mjs` is untyped — so this function is the ONLY
 * place a compiler ever sees the settings literal a suite writes. Inferring the
 * shape from the argument would check nothing, and a typo like
 * `allowUnauthorized` would compile into a sidecar that quietly runs
 * authenticated. That is the whole reason the type was hoisted here.
 */
export function settingsSource(value: SidecarSettings): {
  current: () => SidecarSettings;
  refresh: () => Promise<SidecarSettings>;
} {
  return { current: () => value, refresh: async () => value };
}

/**
 * Bind `server` to an ephemeral port on the loopback interface and return its
 * base URL.
 *
 * Exported, and separate from `sidecarHarness` below, ONLY so
 * `sidecar-harness.test.ts` can reach the two failure paths no suite can
 * otherwise provoke: a bind that emits `error`, and a server that reports an
 * `address()` which is not an `AddressInfo`. Both were silently absent from two
 * of the three copies this module replaces, which is exactly the kind of drift
 * a rule nobody executes invites — so the rules are pinned rather than trusted.
 */
export async function bindLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    // Without this a taken port or a permissions refusal hangs the test out
    // to the suite timeout instead of naming what went wrong.
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      // DETACHED ON SUCCESS, deliberately. A listener left attached would swallow
      // the FIRST error the server emits after it is bound — landing it on an
      // already-settled promise, where it disappears entirely. Two of the three
      // copies this replaces attached nothing at all, so a post-bind `error`
      // surfaced as an unhandled `'error'` event and failed the run; keeping the
      // handler would have quietly changed that SUCCESS-path behaviour, which is
      // more than the header above claims this consolidation does.
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error(
      `sidecar test server did not bind a port: ${String(address)}`,
    );
  }
  return `http://127.0.0.1:${address.port}`;
}

export interface SidecarHarness {
  /** Bind a sidecar built from the harness defaults plus `overrides`. */
  listen(overrides?: Record<string, unknown>): Promise<string>;
  /** Register a server this suite started itself, so `closeAll()` closes it. */
  track(server: Server): void;
  /** Close everything opened or tracked since the last drain. */
  closeAll(): Promise<void>;
}

/**
 * A registry of listening servers plus the `listen()` the three suites share.
 *
 * `defaults` are the suite's fixtures; a call's `overrides` win over them.
 */
export function sidecarHarness(
  defaults: Record<string, unknown> = {},
): SidecarHarness {
  const open: Server[] = [];

  return {
    async listen(overrides: Record<string, unknown> = {}): Promise<string> {
      const server = createSidecarServer({
        kernel: { base: "http://localhost:3000", token: "" },
        pairingSource: { read: async () => ({ protocol: 1, instance: "test-app", localIdentity: "test-local" }) },
        ...defaults,
        ...overrides,
      }) as Server;
      // Tracked BEFORE the bind, so a server that fails to listen is still
      // closed by `closeAll()` rather than left behind by the rejection.
      open.push(server);
      return bindLoopback(server);
    },

    track(server: Server): void {
      open.push(server);
    },

    async closeAll(): Promise<void> {
      await Promise.all(
        open.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              // undici keeps sockets alive, and `close()` alone waits for every
              // one of them — which is a hung afterEach, not a failing test.
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
