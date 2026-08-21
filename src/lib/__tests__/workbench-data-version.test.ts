/**
 * Story 1.7 — the `dataVersion` refresh signal, executed rather than grepped
 * wherever a node suite can execute it.
 *
 * The whole story is invisible when it works: a correct refresh looks like
 * nothing happening, and a broken one looks like a tree that is merely a few
 * seconds behind. So everything that CAN be run is run — the counter against a
 * real temp `DATA_DIR` through the filesystem provider (the fixture shape
 * `lifecycle.test.ts` uses), the real write and delete pipelines, the route with
 * a mocked principal, the poll against a stubbed fetch, and every decision
 * function directly.
 *
 * What is left is the component wiring, which `environment: "node"` cannot
 * render at all. That is pinned by source scan, the `workbench-left-column.
 * test.ts` convention — chiefly that the shell and the column stayed router-free
 * and that the watcher spells no version comparison of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * The route's gate is `getPrincipal()`. Mocked here — hoisted, so it governs the
 * whole file — because there is no Clerk session in a node suite and what is
 * under test is what the route does WITH a principal. Every other module in this
 * file imports only the `Principal` TYPE from `@/lib/auth`, so nothing else is
 * affected.
 */
const principal = vi.hoisted(() => ({
  current: null as { id: string; handle: string } | null,
  throws: false,
}));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => {
    if (principal.throws) throw new Error("auth backend unreachable");
    return principal.current;
  }),
}));

import {
  DATA_VERSION_KEY,
  DATA_VERSION_LOCK,
  bumpDataVersion,
  readDataVersion,
} from "../data-version";
import {
  DATA_VERSION_POLL_MS,
  DATA_VERSION_REFRESH_SETTLE_MS,
  DATA_VERSION_REFRESH_WINDOW_MS,
  DATA_VERSION_ROUTE,
  NO_DATA_VERSION_REFRESH,
  _resetDataVersionListeners,
  dataVersionRefreshPlan,
  fetchDataVersion,
  previewFetchPlan,
  requestDataVersionCheck,
  subscribeDataVersionCheck,
  type DataVersionFetch,
  type DataVersionRefreshState,
  type DataVersionResponseLike,
} from "../workbench-data-version";
import type { TreeSelection } from "../workbench-tree";
import { deleteWikiPage, writeWikiPageWithSideEffects } from "../lifecycle";
import { ensureDirectories } from "../wiki";
import { _resetStorage, getStorage } from "../storage";

const SRC = path.resolve(__dirname, "../..");
const WORKBENCH = path.join(SRC, "components/workbench");

function readSource(relative: string): Promise<string> {
  return fs.readFile(path.join(SRC, relative), "utf8");
}

// ---------------------------------------------------------------------------
// The counter, against a real filesystem provider
// ---------------------------------------------------------------------------

describe("the counter in the config store", () => {
  let tmpDir: string;
  const original: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "data-version-"));
    for (const key of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) original[key] = process.env[key];
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    // Isolate DATA_DIR so `.indexes/` lands under tmp, not the repo cwd.
    process.env.DATA_DIR = tmpDir;
    _resetStorage();
    await ensureDirectories();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // The principal mock is hoisted and therefore file-global. Restoring it
    // here rather than at the end of each route case means a case that throws
    // part-way cannot leave a permanently-throwing `getPrincipal` behind for
    // every test after it — which would fail them for a reason that has nothing
    // to do with what they assert.
    principal.current = null;
    principal.throws = false;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Where the filesystem provider keeps it — `_idx:data-version` in KV. */
  function storedPath(): string {
    return path.join(tmpDir, ".indexes", `${DATA_VERSION_KEY}.json`);
  }

  it("names one key and one lock, and nothing else invents either", () => {
    expect(DATA_VERSION_KEY).toBe("data-version");
    expect(DATA_VERSION_LOCK).toBe("data-version");
  });

  it("reads 0 from a fresh store", async () => {
    await expect(readDataVersion()).resolves.toBe(0);
  });

  it("stores 1 on the first bump and keeps counting from there", async () => {
    await expect(bumpDataVersion()).resolves.toBe(1);
    await expect(readDataVersion()).resolves.toBe(1);
    // …and it lands under the provider's index API, not in `config.json`, not
    // in the wiki registry, and not per-tenant or per-wiki.
    await expect(fs.readFile(storedPath(), "utf8")).resolves.toBe("1");
    await expect(bumpDataVersion()).resolves.toBe(2);
    await expect(bumpDataVersion()).resolves.toBe(3);
  });

  it("counts forward from whatever was already stored", async () => {
    await getStorage().putIndex(DATA_VERSION_KEY, 7);
    await expect(bumpDataVersion()).resolves.toBe(8);
    await expect(bumpDataVersion()).resolves.toBe(9);
    await expect(readDataVersion()).resolves.toBe(9);
  });

  it("never lets concurrent bumps collapse into one", async () => {
    // The lock is the whole reason two ops that both read `n` cannot both store
    // `n + 1` — which would make the second write invisible to a client that
    // already refreshed for the first.
    //
    // This proves the property at the SINGLE-PROCESS filesystem provider, which
    // is what `withFileLock` covers (`lock.ts`: in-process only). It is not
    // proof for KV across Workers isolates, where a collapse is still possible;
    // `DATA_VERSION_LOCK`'s docblock says what that costs.
    await Promise.all(Array.from({ length: 8 }, () => bumpDataVersion()));
    await expect(readDataVersion()).resolves.toBe(8);
  });

  it("narrows a corrupt stored value to 0 rather than propagating it", async () => {
    for (const corrupt of ["x", -1, 1.5, true, null, {}, [], "4"]) {
      await getStorage().putIndex(DATA_VERSION_KEY, corrupt);
      await expect(readDataVersion()).resolves.toBe(0);
      // …and the next bump self-heals to a usable counter.
      await expect(bumpDataVersion()).resolves.toBe(1);
    }
  });

  it("treats an unparseable stored file as 0 as well", async () => {
    await fs.mkdir(path.dirname(storedPath()), { recursive: true });
    await fs.writeFile(storedPath(), "NaN", "utf8");
    await expect(readDataVersion()).resolves.toBe(0);
  });

  it("never throws when the store does — a stale tree beats a rejected write", async () => {
    const storage = getStorage();
    const read = vi
      .spyOn(storage, "getIndex")
      .mockRejectedValue(new Error("config store unreachable"));
    await expect(readDataVersion()).resolves.toBe(0);
    await expect(bumpDataVersion()).resolves.toBe(0);
    read.mockRestore();

    const write = vi.spyOn(storage, "putIndex").mockRejectedValue(new Error("kv down"));
    await expect(bumpDataVersion()).resolves.toBe(0);
    write.mockRestore();
    // Nothing was written, so the counter is still where it was.
    await expect(readDataVersion()).resolves.toBe(0);
  });

  // -------------------------------------------------------------------------
  // The pipeline — the reason no call site had to be edited
  // -------------------------------------------------------------------------

  const PAGE = {
    slug: "alpha",
    title: "Alpha",
    content: "# Alpha\n\nBody.\n",
    summary: "The alpha page",
    logOp: "ingest" as const,
    // Cross-ref discovery needs an LLM key it will not have here; `null` skips
    // it, and this story changes nothing about that branch.
    crossRefSource: null,
  };

  it("raises the signal by exactly one on a successful kernel write", async () => {
    const before = await readDataVersion();
    await writeWikiPageWithSideEffects(PAGE);
    await expect(readDataVersion()).resolves.toBe(before + 1);
    // A second write is a second bump — the signal counts ops, not pages.
    await writeWikiPageWithSideEffects({ ...PAGE, summary: "Edited" });
    await expect(readDataVersion()).resolves.toBe(before + 2);
  });

  it("raises it by exactly one on a successful kernel delete", async () => {
    await writeWikiPageWithSideEffects(PAGE);
    const before = await readDataVersion();
    await deleteWikiPage("alpha");
    await expect(readDataVersion()).resolves.toBe(before + 1);
  });

  it("does not raise it when the op throws before the pipeline's tail", async () => {
    const before = await readDataVersion();
    await expect(
      writeWikiPageWithSideEffects({ ...PAGE, slug: "../escape" }),
    ).rejects.toThrow();
    await expect(deleteWikiPage("no-such-page")).rejects.toThrow();
    await expect(readDataVersion()).resolves.toBe(before);
  });

  it("still returns the write's result when the bump itself fails", async () => {
    const storage = getStorage();
    const realPut = storage.putIndex.bind(storage);
    const spy = vi
      .spyOn(storage, "putIndex")
      .mockImplementation(async (key: string, value: unknown) => {
        if (key === DATA_VERSION_KEY) throw new Error("kv down");
        return realPut(key, value);
      });
    // A config-store hiccup must not turn a write that already landed into a
    // failed one: the owner's text is gone either way, and only one of those
    // two outcomes is recoverable.
    await expect(writeWikiPageWithSideEffects(PAGE)).resolves.toEqual({
      slug: "alpha",
      updatedSlugs: [],
    });
    spy.mockRestore();
    await expect(readDataVersion()).resolves.toBe(0);
  });

  // -------------------------------------------------------------------------
  // The route
  // -------------------------------------------------------------------------

  async function get(): Promise<Response> {
    const { GET } = await import("@/app/api/workbench/version/route");
    return GET();
  }

  it("serves the integer to a signed-in owner, uncacheably", async () => {
    principal.current = { id: "u1", handle: "yuanhao" };
    principal.throws = false;
    await bumpDataVersion();
    await bumpDataVersion();
    const response = await get();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ dataVersion: 2 });
    // Per-principal and gated: a shared cache holding one answer would hand it
    // to the next reader, and the bfcache would serve a version that has moved.
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers 401 without a principal, in the shape the column parses", async () => {
    principal.current = null;
    principal.throws = false;
    const response = await get();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Sign in required." });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers a throw with its own { error } shape, never a framework 500", async () => {
    principal.current = null;
    principal.throws = true;
    const response = await get();
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
    // …and never a page's content.
    expect(JSON.stringify(body)).not.toContain("dataVersion");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): DataVersionResponseLike {
  return { ok: status >= 200 && status < 300, json: async () => body };
}

function stubFetch(handler: (url: string) => unknown): {
  fetchImpl: DataVersionFetch;
  calls: string[];
  signals: (AbortSignal | undefined)[];
} {
  const calls: string[] = [];
  // What the transport was actually handed. Recorded because every abort case
  // below works by pre-aborting a controller that `fetchDataVersion` inspects
  // ITSELF — so a poll that never passed `{ signal }` on to `fetchImpl` would
  // answer `stale` in all four of them and stay green, while being
  // uncancellable in the browser. `abortRef` and the effect cleanup both depend
  // on the opposite, so it is asserted rather than assumed.
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl: DataVersionFetch = async (url, init) => {
    calls.push(url);
    signals.push(init?.signal);
    const result = handler(url);
    if (result instanceof Error) throw result;
    return result as DataVersionResponseLike;
  };
  return { fetchImpl, calls, signals };
}

describe("fetchDataVersion", () => {
  it("polls the one route and parses the integer", async () => {
    const { fetchImpl, calls, signals } = stubFetch(() => jsonResponse(200, { dataVersion: 4 }));
    const signal = new AbortController().signal;
    await expect(fetchDataVersion(signal, fetchImpl)).resolves.toEqual({
      status: "ok",
      version: 4,
    });
    expect(calls).toEqual([DATA_VERSION_ROUTE]);
    expect(DATA_VERSION_ROUTE).toBe("/api/workbench/version");
    // The caller's signal reaches the TRANSPORT, not only this module's own
    // `signal.aborted` checks: the watcher aborts the previous run at the top of
    // every tick and again in its cleanup, and neither ends a request that was
    // issued without it. A poll left hanging on a stalled connection would then
    // outlive the shell that started it.
    expect(signals).toEqual([signal]);
    // A cadence, not a hot loop, and not zero — and BOUNDED ABOVE as well. A
    // lower bound alone is satisfied by a ten-minute interval, which keeps the
    // suite green while making "a page written by the CLI or an agent reaches
    // the trees without a reload" untrue for the length of a working session.
    expect(DATA_VERSION_POLL_MS).toBeGreaterThanOrEqual(1000);
    expect(DATA_VERSION_POLL_MS).toBeLessThanOrEqual(30_000);
  });

  it("reports a body it does not recognise as unavailable, never as a version", async () => {
    for (const body of [
      {},
      { dataVersion: "4" },
      { dataVersion: null },
      { dataVersion: 1.5 },
      { dataVersion: -1 },
      { dataVersion: Number.NaN },
      { version: 4 },
      null,
      4,
      "4",
    ]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(200, body));
      await expect(
        fetchDataVersion(new AbortController().signal, fetchImpl),
      ).resolves.toEqual({ status: "unavailable" });
    }
  });

  it("reports a refusal, a failure and a non-JSON body as unavailable", async () => {
    for (const status of [401, 404, 500, 503]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(status, { error: "nope" }));
      await expect(
        fetchDataVersion(new AbortController().signal, fetchImpl),
      ).resolves.toEqual({ status: "unavailable" });
    }
    const unparseable = stubFetch(() => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    await expect(
      fetchDataVersion(new AbortController().signal, unparseable.fetchImpl),
    ).resolves.toEqual({ status: "unavailable" });
    const down = stubFetch(() => new TypeError("Failed to fetch"));
    await expect(
      fetchDataVersion(new AbortController().signal, down.fetchImpl),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("reports an abort as stale, both before and after the body is parsed", async () => {
    const early = new AbortController();
    const first = stubFetch(() => {
      early.abort();
      return jsonResponse(200, { dataVersion: 9 });
    });
    await expect(fetchDataVersion(early.signal, first.fetchImpl)).resolves.toEqual({
      status: "stale",
    });

    const late = new AbortController();
    const second = stubFetch(() => ({
      ok: true,
      json: async () => {
        late.abort();
        return { dataVersion: 9 };
      },
    }));
    await expect(fetchDataVersion(late.signal, second.fetchImpl)).resolves.toEqual({
      status: "stale",
    });

    // …and a fetch that throws BECAUSE it was aborted is stale too, not a
    // failure the watcher would otherwise treat as a signal it cannot read.
    const thrown = new AbortController();
    const third = stubFetch(() => {
      thrown.abort();
      return new DOMException("The operation was aborted.", "AbortError");
    });
    await expect(fetchDataVersion(thrown.signal, third.fetchImpl)).resolves.toEqual({
      status: "stale",
    });
  });
});

// ---------------------------------------------------------------------------
// The two decisions
// ---------------------------------------------------------------------------

describe("dataVersionRefreshPlan", () => {
  /**
   * The clock origin every case below is written against, deliberately AWAY
   * from zero: a rule that forgot to stamp `firstRefreshAt` would leave it at
   * `0`, and with `T0 = 0` a span computed from that zero is indistinguishable
   * from the right answer.
   */
  const T0 = 1_000;
  const WINDOW = DATA_VERSION_REFRESH_WINDOW_MS;
  const SETTLE = DATA_VERSION_REFRESH_SETTLE_MS;
  /**
   * The most refreshes one observed version can ever cost. Refreshes for a
   * version are at least SETTLE apart, and one is issued only while those
   * already out span LESS than `WINDOW - SETTLE` — the span read AT THE MOMENT
   * OF THE DECISION, not the span the version ends up with, which a gap can
   * push far past that bound (the idle-gap case below is exactly that). So
   * before the n-th refresh the span is at least `(n - 2) * SETTLE`, which is
   * under the bound only for `n <= ceil(WINDOW / SETTLE)`. Derived here rather
   * than hard-coded, so the drives below assert the BOUND and not a number that
   * happens to match.
   */
  const CEILING = Math.ceil(WINDOW / SETTLE);

  /**
   * A no-op branch must hand back the SAME object it was given, not a copy.
   * `toEqual({ refresh: false, state })` is satisfied by a branch returning
   * `{ ...state }`, which reads identically — so the identity is what turns
   * "the state does not move" from a comment into a fact. `previewFetchPlan`'s
   * own tests pin `shown` with `toBe(ALPHA)` for exactly this reason.
   */
  function expectUnchanged(input: {
    served: number;
    polled: number;
    now: number;
    state: DataVersionRefreshState;
  }): void {
    const plan = dataVersionRefreshPlan(input);
    expect(plan.refresh).toBe(false);
    expect(plan.state).toBe(input.state);
  }

  /** The same answer, poll after poll — a route that never catches up. */
  function repeated(version: number, count: number): number[] {
    return Array.from({ length: count }, () => version);
  }

  /**
   * Drive the rule the way the watcher does: feed each answer back in, one poll
   * every `cadenceMs`. The cadence is an ARGUMENT because the whole of DW-377
   * is that the budget must not move with it — the old rule counted qualifying
   * polls, so driving the same degraded route twice as fast bought twice the
   * renders.
   */
  function drive(
    served: number,
    polls: readonly number[],
    cadenceMs: number,
  ): { refreshes: number; refreshedAt: number[]; state: DataVersionRefreshState } {
    let state: DataVersionRefreshState = NO_DATA_VERSION_REFRESH;
    const refreshedAt: number[] = [];
    polls.forEach((polled, tick) => {
      const now = T0 + tick * cadenceMs;
      const plan = dataVersionRefreshPlan({ served, polled, now, state });
      state = plan.state;
      if (plan.refresh) refreshedAt.push(now);
    });
    return { refreshes: refreshedAt.length, refreshedAt, state };
  }

  it("starts from nothing refreshed for, bounded by two wall-clock constants", () => {
    expect(NO_DATA_VERSION_REFRESH).toEqual({
      version: 0,
      firstRefreshAt: 0,
      lastRefreshAt: 0,
    });
    // Frozen: this one object is the seed in every mounted watcher's ref AND
    // what several branches hand straight back, so a mutation anywhere would
    // reach every watcher in the tab. `readonly` is erased at build time.
    expect(Object.isFrozen(NO_DATA_VERSION_REFRESH)).toBe(true);

    // Asserted rather than merely imported, because "bounded" is the whole
    // safety argument and a window quietly raised to 30 minutes would keep
    // every other case below green.
    expect(WINDOW).toBe(30_000);
    expect(SETTLE).toBe(10_000);
    // …and the RELATIONSHIP, which neither value pins on its own: `SETTLE = 0`
    // makes the ceiling `Infinity` (every poll in the window refreshes),
    // `SETTLE >= WINDOW` deletes the retry entirely (the DW-48 regression), and
    // both files would happily assert against either.
    expect(SETTLE).toBeGreaterThan(0);
    expect(SETTLE).toBeLessThan(WINDOW);
    expect(CEILING).toBe(3);
  });

  it("spells both bounds as plain millisecond literals, not as multiples of the cadence", async () => {
    // The point of DW-377: changing the poll cadence must change NEITHER bound.
    // A `WINDOW = DATA_VERSION_POLL_MS * 3` would satisfy every behavioural
    // case in this file today and silently re-couple the budget to the cadence.
    const source = await readSource("lib/workbench-data-version.ts");
    expect(source).toContain("export const DATA_VERSION_REFRESH_WINDOW_MS = 30_000;");
    expect(source).toContain("export const DATA_VERSION_REFRESH_SETTLE_MS = 10_000;");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
    // The cadence is DECLARED here and referenced nowhere in this module's
    // code — the `{@link}`s in the prose above are comments and are stripped.
    expect(code).toContain("export const DATA_VERSION_POLL_MS = 10_000;");
    expect(code.match(/DATA_VERSION_POLL_MS/g) ?? []).toHaveLength(1);
    // The old count is gone, name and concept alike.
    expect(source).not.toContain("DATA_VERSION_REFRESH_ATTEMPTS");
    expect(code).not.toMatch(/attempts/i);
  });

  it("refreshes when the served number moved forward", () => {
    expect(
      dataVersionRefreshPlan({
        served: 3,
        polled: 4,
        now: T0,
        state: NO_DATA_VERSION_REFRESH,
      }),
    ).toEqual({
      refresh: true,
      state: { version: 4, firstRefreshAt: T0, lastRefreshAt: T0 },
    });
    expect(
      dataVersionRefreshPlan({
        served: 0,
        polled: 1,
        now: T0,
        state: NO_DATA_VERSION_REFRESH,
      }),
    ).toEqual({
      refresh: true,
      state: { version: 1, firstRefreshAt: T0, lastRefreshAt: T0 },
    });
  });

  it("stops as soon as the re-render caught up", () => {
    // The refresh landed and the new baseline IS the polled number, so there is
    // nothing outstanding — and the state does not move, whatever it holds.
    const state: DataVersionRefreshState = {
      version: 4,
      firstRefreshAt: T0,
      lastRefreshAt: T0,
    };
    expectUnchanged({ served: 4, polled: 4, now: T0 + WINDOW, state });
    // A baseline that overshot (other writes landed with it) is caught up too.
    expectUnchanged({ served: 6, polled: 4, now: T0 + WINDOW, state });
  });

  it("declines a repeat while the previous refresh is still in flight (DW-377)", () => {
    // `router.refresh()` returns `void` and its render lands asynchronously, so
    // an answer arriving 500ms later is not "the re-render did not catch up" —
    // it is "the re-render has not happened yet". Refreshing on it burns a
    // render for nothing, which is what a burst of saves or alt-tabs used to do.
    const state: DataVersionRefreshState = {
      version: 4,
      firstRefreshAt: T0,
      lastRefreshAt: T0,
    };
    expectUnchanged({ served: 3, polled: 4, now: T0 + 500, state });
    expectUnchanged({ served: 3, polled: 4, now: T0 + SETTLE - 1, state });

    // …and a whole BURST of triggers inside the settle interval spends nothing:
    // 50 polls 100ms apart issue exactly one refresh, and the budget for 4 is
    // untouched — a poll past the interval still gets the retry it is owed.
    const burst = drive(3, repeated(4, 50), 100);
    expect(burst.refreshes).toBe(1);
    expect(burst.refreshedAt).toEqual([T0]);
    expect(burst.state).toEqual({ version: 4, firstRefreshAt: T0, lastRefreshAt: T0 });
    expect(
      dataVersionRefreshPlan({ served: 3, polled: 4, now: T0 + SETTLE, state: burst.state }),
    ).toEqual({
      refresh: true,
      state: { version: 4, firstRefreshAt: T0, lastRefreshAt: T0 + SETTLE },
    });
  });

  it("retries once the refresh has settled and the baseline is still behind (DW-48)", () => {
    // The whole point of the retry. `router.refresh()` re-ran the server render,
    // but THAT render's own read answered the pre-bump integer, so the baseline
    // is still behind the version refreshed for. The old rule recorded 4 as
    // done and left the trees stale until the next write; this one tries again.
    expect(
      dataVersionRefreshPlan({
        served: 3,
        polled: 4,
        now: T0 + SETTLE,
        state: { version: 4, firstRefreshAt: T0, lastRefreshAt: T0 },
      }),
    ).toEqual({
      refresh: true,
      state: { version: 4, firstRefreshAt: T0, lastRefreshAt: T0 + SETTLE },
    });
  });

  it("retries, then stops the moment a later render catches up", () => {
    // The DW-48 SUCCESS story end to end, which neither the single-step cases
    // above nor the give-up drive below tells: the first re-render lagged, the
    // retry went out, THAT render landed with the bump — and the retries stop
    // because the baseline arrived, not because the budget ran out. Asserted as
    // a sequence because each step's input is the previous step's output, and a
    // rule that recorded the wrong version would still pass every case in
    // isolation.
    let state: DataVersionRefreshState = NO_DATA_VERSION_REFRESH;
    const first = dataVersionRefreshPlan({ served: 3, polled: 4, now: T0, state });
    expect(first.refresh).toBe(true);
    state = first.state;

    // The re-render's own read answered the pre-bump integer: still serving 3.
    const retry = dataVersionRefreshPlan({ served: 3, polled: 4, now: T0 + SETTLE, state });
    expect(retry.refresh).toBe(true);
    expect(retry.state).toEqual({
      version: 4,
      firstRefreshAt: T0,
      lastRefreshAt: T0 + SETTLE,
    });
    state = retry.state;

    // …and THIS one landed. Every poll from here on is a no-op, and the
    // refreshes issued span only SETTLE — well inside the budget, so it was the
    // catch-up that ended it and not the bound.
    expectUnchanged({ served: 4, polled: 4, now: T0 + 2 * SETTLE, state });
    expectUnchanged({ served: 4, polled: 4, now: T0 + WINDOW * 4, state });
    expect(state.lastRefreshAt - state.firstRefreshAt).toBeLessThan(WINDOW - SETTLE);
  });

  it("pins BOTH edges of the budget — the last legal refresh and the first refused one", () => {
    // `page.tsx` stuck at 0 while the route answers 7 is a baseline that NEVER
    // catches up. Without the bound this is `router.refresh()` every poll
    // forever. The bound is the SPAN of the refreshes already issued, so both
    // sides of it are exact numbers rather than a range: assert only the refusal
    // and the whole bound could be tightened by a third with the suite green.
    const spent = WINDOW - SETTLE;
    // One millisecond inside the span: still owed a retry.
    const almost: DataVersionRefreshState = {
      version: 7,
      firstRefreshAt: T0,
      lastRefreshAt: T0 + spent - 1,
    };
    expect(
      dataVersionRefreshPlan({ served: 0, polled: 7, now: T0 + spent - 1 + SETTLE, state: almost }),
    ).toEqual({
      refresh: true,
      state: { version: 7, firstRefreshAt: T0, lastRefreshAt: T0 + spent - 1 + SETTLE },
    });
    // Exactly ON the bound: spent, and the state does not move again.
    expectUnchanged({
      served: 0,
      polled: 7,
      now: T0 + spent + SETTLE,
      state: { version: 7, firstRefreshAt: T0, lastRefreshAt: T0 + spent },
    });
    // …and no later poll ever revives it, however long it waits.
    expectUnchanged({
      served: 0,
      polled: 7,
      now: T0 + WINDOW * 100,
      state: { version: 7, firstRefreshAt: T0, lastRefreshAt: T0 + spent },
    });
  });

  it("measures the budget from the FIRST refresh, so retries cannot slide it", () => {
    // Driven as the watcher drives it, at the real cadence: the same pair of
    // numbers repeated forever yields exactly CEILING refreshes, each SETTLE
    // after the last, and then nothing. Measure the span from the LAST refresh
    // instead — the obvious "reset the window on every retry" mistake — and
    // this drive never stops.
    const run = drive(0, repeated(7, 25), DATA_VERSION_POLL_MS);
    expect(run.refreshes).toBe(CEILING);
    expect(run.refreshedAt).toEqual([T0, T0 + SETTLE, T0 + 2 * SETTLE]);
    expect(run.state).toEqual({
      version: 7,
      firstRefreshAt: T0,
      lastRefreshAt: T0 + 2 * SETTLE,
    });
  });

  it("does not spend the budget on time in which it issued nothing", () => {
    // The watcher stops polling entirely while the tab is hidden, and a sleeping
    // machine issues nothing either. A give-up measured as raw elapsed wall
    // clock (`now - firstRefreshAt >= WINDOW`) would be BURNED by that silence
    // and decline the retry forever — reinstating the DW-48 symptom in the
    // single most likely way for 30s to pass without a poll: alt-tabbing away.
    const state: DataVersionRefreshState = {
      version: 4,
      firstRefreshAt: T0,
      lastRefreshAt: T0,
    };
    const back = dataVersionRefreshPlan({
      served: 3,
      polled: 4,
      now: T0 + WINDOW * 2,
      state,
    });
    expect(back).toEqual({
      refresh: true,
      state: { version: 4, firstRefreshAt: T0, lastRefreshAt: T0 + WINDOW * 2 },
    });
    // …and the gap spent the budget in one step, because the SPAN jumped with
    // it: the degenerate direction of every clock oddity is FEWER refreshes.
    expectUnchanged({ served: 3, polled: 4, now: T0 + WINDOW * 4, state: back.state });
  });

  it("keeps the same ceiling however fast or slow the polls arrive", () => {
    // The old rule counted qualifying POLLS, so a burst of saves or a faster
    // cadence bought more renders for the same degraded read. These three drives
    // are the same route and the same baseline at three cadences: 40× faster
    // than the interval, the interval itself, and 6× slower.
    const fast = drive(0, repeated(7, 400), 250);
    const cadence = drive(0, repeated(7, 25), DATA_VERSION_POLL_MS);
    const slow = drive(0, repeated(7, 10), 60_000);

    for (const run of [fast, cadence, slow]) {
      expect(run.refreshes).toBeLessThanOrEqual(CEILING);
      expect(run.state.version).toBe(7);
    }
    // The ceiling is REACHED at both cadences that can reach it, and the
    // timeline is deterministic, so it is asserted exactly.
    expect(fast.refreshes).toBe(cadence.refreshes);
    expect(fast.refreshedAt).toEqual([T0, T0 + SETTLE, T0 + 2 * SETTLE]);
    expect(cadence.refreshedAt).toEqual([T0, T0 + SETTLE, T0 + 2 * SETTLE]);
    // A cadence slower than the budget simply cannot spend it all — fewer
    // renders, never more, and never a loop.
    expect(slow.refreshedAt).toEqual([T0, T0 + 60_000]);
  });

  it("stays bounded when the route FLAPS between two versions", () => {
    // The bound is only a bound if the refreshed-for version cannot be rewritten
    // downward. Relax the retry branch's equality to `polled <= state.version`
    // and every single-step case in this file still passes — while a route
    // alternating 7 and 5 against a degraded baseline re-arms the budget on each
    // backwards read and refreshes forever, which is precisely the loop the
    // bound exists to prevent. Driven, because it only appears in sequence.
    const flapping = Array.from({ length: 25 }, (_, tick) => (tick % 2 === 0 ? 7 : 5));
    const run = drive(0, flapping, DATA_VERSION_POLL_MS);
    // Exact, not a range: the timeline is deterministic. The 5s land between
    // the 7s, so the retries fall on every OTHER tick.
    expect(run.refreshedAt).toEqual([T0, T0 + 2 * DATA_VERSION_POLL_MS]);
    // The high-water mark never moved down: 5 was never recorded as refreshed
    // for, and its stamps never touched the budget for 7.
    expect(run.state).toEqual({
      version: 7,
      firstRefreshAt: T0,
      lastRefreshAt: T0 + 2 * DATA_VERSION_POLL_MS,
    });
  });

  it("starts over for a new bump, even after giving up", () => {
    // Giving up is per VERSION, never a latch on the watcher: a real write
    // arriving after a degraded stretch still refreshes, and its budget starts
    // clean at the moment of that refresh.
    expect(
      dataVersionRefreshPlan({
        served: 0,
        polled: 8,
        now: T0 + WINDOW,
        state: { version: 7, firstRefreshAt: T0, lastRefreshAt: T0 + WINDOW - SETTLE },
      }),
    ).toEqual({
      refresh: true,
      state: { version: 8, firstRefreshAt: T0 + WINDOW, lastRefreshAt: T0 + WINDOW },
    });
  });

  it("ignores a backwards read — eventual consistency is not a change", () => {
    expectUnchanged({ served: 5, polled: 4, now: T0, state: NO_DATA_VERSION_REFRESH });
  });

  it("ignores a poll that lands behind an outstanding refresh", () => {
    // A refresh is already out for 4 and this poll answers the number already
    // on screen: nothing to do, and nothing to record — recording it would
    // otherwise re-arm the retry for a version the render is already handling.
    const outstanding: DataVersionRefreshState = {
      version: 4,
      firstRefreshAt: T0,
      lastRefreshAt: T0,
    };
    expectUnchanged({ served: 3, polled: 3, now: T0 + WINDOW, state: outstanding });
    // …and a read BELOW the refreshed-for version while the baseline lags is the
    // same backwards read, not a reason to restart the budget — whether that
    // version's budget is spent…
    expectUnchanged({
      served: 0,
      polled: 5,
      now: T0 + WINDOW,
      state: { version: 7, firstRefreshAt: T0, lastRefreshAt: T0 + WINDOW - SETTLE },
    });
    // …or still OPEN, which is the case that separates `polled ===
    // state.version` from `polled <= state.version`: the loose form refreshes
    // here and rewrites the version down to 5, losing the high-water mark that
    // bounds the whole thing.
    expectUnchanged({
      served: 0,
      polled: 5,
      now: T0 + SETTLE,
      state: { version: 7, firstRefreshAt: T0, lastRefreshAt: T0 },
    });
  });

  it("declines when the clock jumps BACKWARDS", () => {
    // `now - lastRefreshAt` goes negative, which the settle guard reads as "has
    // not landed yet". Fewer refreshes, never more — and the next forward
    // reading gets the retry, so nothing is stranded.
    expectUnchanged({
      served: 3,
      polled: 4,
      now: T0 - 500,
      state: { version: 4, firstRefreshAt: T0, lastRefreshAt: T0 },
    });
  });

  it("declines on a clock reading that is not a finite number", () => {
    // Every elapsed comparison against `NaN` is `false`, so WITHOUT the finite
    // guard the settle branch falls through, the spent branch is unreachable for
    // a state whose own stamps are `NaN`, and the rule refreshes on every poll
    // forever — the exact loop the bound exists to prevent, with the whole suite
    // otherwise green. A new bump still refreshes: that branch reads no clock
    // it must compare, and stranding real data on a broken clock would be worse.
    const state: DataVersionRefreshState = {
      version: 4,
      firstRefreshAt: T0,
      lastRefreshAt: T0,
    };
    const readings = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const now of readings) {
      expectUnchanged({ served: 3, polled: 4, now, state });
    }
    // …but a NEW BUMP still refreshes on the same unreadable clock, and THIS is
    // the assertion that holds the guard where it is. Hoisting the finiteness
    // check above the new-bump branch — the natural "never act on a clock we
    // cannot read" tidy-up — leaves every other case in both suites green while
    // silently deciding that a broken clock should strand real data. It should
    // not: that branch compares no clock, it only STAMPS one, so the worst a
    // bad reading does there is spend that version's whole budget at once,
    // which is the direction every other clock case degrades in too.
    for (const now of readings) {
      expect(
        dataVersionRefreshPlan({ served: 3, polled: 5, now, state }).refresh,
      ).toBe(true);
      expect(
        dataVersionRefreshPlan({
          served: 3,
          polled: 5,
          now,
          state: NO_DATA_VERSION_REFRESH,
        }).refresh,
      ).toBe(true);
    }
    // …and a state already poisoned by such a reading cannot loop either.
    expectUnchanged({
      served: 3,
      polled: 4,
      now: T0 + WINDOW,
      state: { version: 4, firstRefreshAt: Number.NaN, lastRefreshAt: Number.NaN },
    });
  });
});

describe("previewFetchPlan", () => {
  const ALPHA: TreeSelection = { kind: "page", slug: "alpha" };
  const BETA: TreeSelection = { kind: "page", slug: "beta" };
  const FILE: TreeSelection = { kind: "file", path: "wiki/alpha.md" };

  it("fetches and resets for a new row, whatever the editor is doing", () => {
    for (const editing of [false, true]) {
      expect(previewFetchPlan({ shown: ALPHA, next: BETA, editing })).toEqual({
        fetch: true,
        reset: true,
        shown: BETA,
      });
    }
    // The first run of all — nothing has been read yet — is a new row too.
    expect(previewFetchPlan({ shown: null, next: ALPHA, editing: false })).toEqual({
      fetch: true,
      reset: true,
      shown: ALPHA,
    });
    // The same page reached from the other tab is a different ROW, and its
    // bytes are fetched under a different query.
    expect(previewFetchPlan({ shown: ALPHA, next: FILE, editing: false })).toEqual({
      fetch: true,
      reset: true,
      shown: FILE,
    });
  });

  it("refreshes the same row silently when the owner is only reading", () => {
    // No reset, so `Loading…` does not flash over a page somebody is reading.
    // A fresh-but-equal object is the same row: the shell's one equality rule.
    expect(
      previewFetchPlan({ shown: ALPHA, next: { kind: "page", slug: "alpha" }, editing: false }),
    ).toEqual({ fetch: true, reset: false, shown: { kind: "page", slug: "alpha" } });
  });

  it("does nothing at all while the editor is open", () => {
    expect(previewFetchPlan({ shown: ALPHA, next: ALPHA, editing: true })).toEqual({
      fetch: false,
      reset: false,
      shown: ALPHA,
    });
  });

  it("records the row it read, and leaves it alone when it read nothing", () => {
    // The ordering the component can no longer get wrong, executed: a run that
    // fetches records what it fetched, and a run that does not fetch must leave
    // the previous row recorded — recording `next` there would make the NEXT
    // pick look like the same row, so the editor would survive a row change and
    // the column would show one row's draft over another row's header.
    expect(previewFetchPlan({ shown: ALPHA, next: BETA, editing: true }).shown).toEqual(BETA);
    expect(previewFetchPlan({ shown: ALPHA, next: ALPHA, editing: true }).shown).toBe(ALPHA);
    expect(previewFetchPlan({ shown: null, next: ALPHA, editing: true }).shown).toEqual(ALPHA);
    // …and the recorded row of a no-fetch run is the SHOWN one even though a
    // different object with the same identity was offered.
    const equal: TreeSelection = { kind: "page", slug: "alpha" };
    expect(previewFetchPlan({ shown: ALPHA, next: equal, editing: true }).shown).toBe(ALPHA);
  });
});

// ---------------------------------------------------------------------------
// The nudge
// ---------------------------------------------------------------------------

describe("the immediate-check nudge", () => {
  afterEach(() => _resetDataVersionListeners());

  it("runs every subscriber, and none after they unsubscribe", () => {
    const seen: string[] = [];
    const offA = subscribeDataVersionCheck(() => seen.push("a"));
    const offB = subscribeDataVersionCheck(() => seen.push("b"));
    requestDataVersionCheck();
    expect(seen).toEqual(["a", "b"]);
    offA();
    offB();
    requestDataVersionCheck();
    expect(seen).toEqual(["a", "b"]);
  });

  it("does not let one throwing listener strand the others", () => {
    const seen: string[] = [];
    subscribeDataVersionCheck(() => {
      throw new Error("watcher exploded");
    });
    subscribeDataVersionCheck(() => seen.push("b"));
    expect(() => requestDataVersionCheck()).not.toThrow();
    expect(seen).toEqual(["b"]);
  });

  it("survives a listener that unsubscribes itself mid-notify", () => {
    const seen: string[] = [];
    const off = subscribeDataVersionCheck(() => {
      seen.push("a");
      off();
    });
    subscribeDataVersionCheck(() => seen.push("b"));
    requestDataVersionCheck();
    expect(seen).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// The wiring a node suite cannot execute
// ---------------------------------------------------------------------------

describe("the bump lives at exactly one site", () => {
  it("sits between the log append and the pipeline's return, inside a try/catch", async () => {
    const source = await readSource("lib/lifecycle.ts");
    expect(source).toMatch(
      /await appendToLog\(logOp, op\.title, details\);[\s\S]{0,1200}try \{\s*\n\s*await bumpDataVersion\(\);\s*\n\s*\} catch \(err\) \{[\s\S]{0,160}logger\.warn\("data-version"/,
    );
    const bump = source.indexOf("await bumpDataVersion();");
    expect(bump).toBeGreaterThan(source.indexOf("await appendToLog(logOp"));
    expect(bump).toBeLessThan(
      source.indexOf("return { slug, crossRefedSlugs, strippedBacklinksFrom, removedFromIndex };"),
    );
    // Not in the two wrappers, and not in `writeWikiPage`, which the pipeline
    // itself calls 2–4× per op.
    expect(source.match(/bumpDataVersion\(\)/g) ?? []).toHaveLength(1);
  });

  it("is called from nowhere else in the app", async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if ((await fs.readFile(file, "utf8")).includes("bumpDataVersion(")) {
        offenders.push(path.relative(SRC, file).split(path.sep).join("/"));
      }
    }
    // The definition, the page pipeline's one call site, and `lib/wikis.ts`,
    // which owns a class of bytes the page pipeline cannot address at all
    // (`schema.md` has no slug and no page-index entry). WHICH functions in
    // that module bump is pinned by the next test, since this list is
    // file-granular; `seedWikiArtifacts` is not one of them, and every other
    // writer that bypasses both pipelines is still deliberately absent.
    expect(offenders.sort()).toEqual([
      "lib/data-version.ts",
      "lib/lifecycle.ts",
      "lib/wikis.ts",
    ]);
  });

  it("has exactly four sites inside wikis.ts, each outside the tenant lock", async () => {
    // The list above is FILE-granular, so allowlisting `lib/wikis.ts` would
    // otherwise buy a blanket exemption for a module with seven exported
    // writers in it. This pins WHICH of them bump, the way the `lifecycle.ts`
    // test above pins its own count.
    //
    // Four, since DW-209: `writeWikiArtifact` (a Schema edit) plus `createWiki`
    // and `applyScenarioTemplate` (DW-49), because seeding writes `purpose.md`
    // and `schema.md` through the tail-less `putWikiArtifact` and a re-template
    // moves nothing else a Preview is keyed on — without the bump a Preview
    // READING either artifact keeps the old template's bytes — plus `renameWiki`,
    // which retitles `purpose.md`'s heading and moves the name the Workbench
    // renders while changing no `currentWikiId`, so the counter is the only
    // thing that can un-stale an open Preview.
    //
    // The rest are deliberately absent for three DIFFERENT reasons, and lumping
    // them together would hide the one that matters. `putWikiArtifact`,
    // `seedWikiArtifacts` and `retitlePurpose` write exactly the bytes a Preview
    // renders — they are absent because they run INSIDE `wikis:<tenant>`, where
    // taking `DATA_VERSION_LOCK` would nest two keys, so their CALLERS carry the
    // tail instead; that is the whole reason the four above are callers.
    // `sweepOrphanWikiDirectories` and `deleteWiki` REMOVE such bytes, but only
    // for a Wiki that is by then unreachable — the sweep's directories are
    // unreferenced and the current Wiki is undeletable — so no Preview can be
    // open on what they take. `setCurrentWiki` is the only one that genuinely
    // writes nothing a Preview renders: it moves `currentId` in `wikis.json` and
    // nothing else, and the selection change is its own refresh trigger.

    /**
     * Comments removed, so a call QUOTED in a docblock is never counted as a
     * call site nor attributed to the function whose body it precedes. Block
     * comments go entirely; `//` counts as a comment only at the start of a
     * line, which leaves a `https://` inside a string literal alone.
     */
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    const source = stripComments(await readSource("lib/wikis.ts"));

    // BOTH forms, and both are load-bearing. The await form is what the
    // ordering checks below navigate by. The IDENTIFIER form is what sees a
    // bump that was moved inside the lock and fired unawaited — `void
    // bumpDataVersion()`, or a `.then()` chain — which the await form cannot
    // match at all and which would leave the count looking untouched.
    expect(source.match(/bumpDataVersion\s*\(/g) ?? []).toHaveLength(4);
    expect(source.match(/await bumpDataVersion\(\);/g) ?? []).toHaveLength(4);

    /**
     * One function's body, from its `export` line to the `}` that closes it.
     *
     * Bounded by the function's OWN close, not by the next `export`: the region
     * between two exports also holds the NEXT one's JSDoc and any private
     * helper declared in between, so slicing that far attributes their text to
     * this function. A top-level declaration is the only thing in this file
     * with a `}` in column 0.
     */
    const bodyOf = (name: string): string => {
      const at = source.indexOf(`export async function ${name}(`);
      expect(at).toBeGreaterThan(-1);
      const close = source.indexOf("\n}\n", at);
      expect(close).toBeGreaterThan(at);
      return source.slice(at, close);
    };

    for (const name of [
      "writeWikiArtifact",
      "createWiki",
      "applyScenarioTemplate",
      "renameWiki",
    ]) {
      const body = bodyOf(name);
      const bump = body.indexOf("await bumpDataVersion();");
      expect(bump).toBeGreaterThan(-1);
      // OUTSIDE `wikis:<tenant>`. `withFileLock` is not reentrant and
      // `bumpDataVersion` takes `DATA_VERSION_LOCK`, so a bump moved inside the
      // callback would nest two lock keys in an order nothing else in the repo
      // takes — a tenant-wide deadlock risk. The `withFileLock` call's own close
      // at the function's top indent has to come first. Two closing forms,
      // because one caller passes a one-line arrow and two pass a block.
      // Two accepted spellings: the bare `withFileLock(wikiLockKey(owner), …)`
      // and `withWikiLock(owner, …)`, the wrapper that took its place when the
      // lock started minting a `WikiLockHeld` (DW-139). Either one is the Wiki
      // lock opening; what is being pinned is where its CLOSE falls relative to
      // the bump, and that is unchanged by the rename.
      // `?? -1` so a body with NEITHER spelling fails as "no lock found" and
      // names the function, rather than passing `undefined` into the
      // `indexOf(close, lock)` below — which would search from 0 and find the
      // close of something else entirely.
      const lock =
        ["withFileLock(wikiLockKey(owner)", "withWikiLock(owner"]
          .map((form) => body.indexOf(form))
          .filter((at) => at > -1)
          .sort((a, b) => a - b)[0] ?? -1;
      expect(lock, `${name} opens the wiki lock`).toBeGreaterThan(-1);
      const closes = ["\n  });\n", "\n  );\n"]
        .map((close) => body.indexOf(close, lock))
        .filter((at) => at > -1)
        .sort((a, b) => a - b);
      expect(closes.length).toBeGreaterThan(0);
      expect(bump).toBeGreaterThan(closes[0]);
    }

    // The four counted above are now accounted for one apiece by four
    // DISJOINT bodies, so no other function in the module has one — including
    // `seedWikiArtifacts`, which is the whole reason the tails live at the
    // callers: it always runs while `wikis:<tenant>` is held. Asserted directly
    // as well, because that is the refactor this guard exists to catch and a
    // count mismatch names no function.
    const seederAt = source.indexOf("async function seedWikiArtifacts(");
    expect(seederAt).toBeGreaterThan(-1);
    const seederClose = source.indexOf("\n}\n", seederAt);
    expect(seederClose).toBeGreaterThan(seederAt);
    expect(source.slice(seederAt, seederClose)).not.toContain("bumpDataVersion");
  });

  it("introduces no second refresh paradigm anywhere in src", async () => {
    // `WebSocket` is banned alongside `EventSource`, and the SWR half is
    // case-insensitive because one dependency is spelled three ways (`useSWR`,
    // `from "swr"`, `SWRConfig`). Both are matched as USE rather than as a bare
    // substring: `html.ts` names WebSocket in a CSP comment, and
    // `vendor/yoyo-reference.generated.ts` is a base64 blob that contains
    // almost every three-letter sequence there is.
    const banned = [
      /revalidatePath/,
      /revalidateTag/,
      /unstable_cache/,
      /new\s+EventSource\s*\(/,
      /new\s+WebSocket\s*\(/,
      /\buseSWR\b/i,
      /\bSWRConfig\b/i,
      /from\s+["']swr["']/i,
      /react-query/i,
    ];
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const source = await fs.readFile(file, "utf8");
      if (banned.some((pattern) => pattern.test(source))) {
        offenders.push(path.relative(SRC, file).split(path.sep).join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reloads the window — a refresh the owner can see is a bug", async () => {
    // The acceptance criterion says the window does not reload: mode, tree tab,
    // selection, scroll offset and column widths all survive precisely because
    // nothing here unmounts. `location.reload()` or an assignment to
    // `window.location` would satisfy "the trees are current" and destroy every
    // one of them, so all three files that could reach for it are checked.
    for (const file of ["DataVersionWatcher.tsx", "PreviewColumn.tsx", "Workbench.tsx"]) {
      const source = await fs.readFile(path.join(WORKBENCH, file), "utf8");
      expect(source).not.toMatch(/location\s*\.\s*reload\s*\(/);
      expect(source).not.toMatch(/location\s*\.\s*(href|assign|replace)\s*[=(]/);
      expect(source).not.toMatch(/window\.location\s*=/);
    }
  });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the served baseline reaches the browser through the provider", () => {
  it("page.tsx reads it on the server, BEFORE the data it describes", async () => {
    const source = await readSource("app/page.tsx");
    expect(source).toContain("await Promise.all([");
    expect(source).toContain("readDataVersion()");
    // Degrades like the two reads below it rather than throwing the page away.
    expect(source).toMatch(
      /readDataVersion\(\)\.catch\(\(error\) => \{[\s\S]{0,200}logger\.error\("home"[\s\S]{0,120}return 0;/,
    );
    expect(source).toContain("const [wikiRegistry, pageIndex] = await Promise.all([");
    expect(source).toContain("dataVersion,");
    // The ORDER is the whole correctness argument, so it is asserted rather
    // than commented. The bump is the last step of a kernel op, after the page
    // index has been rewritten — so a version read racing that op CONCURRENTLY
    // with the index read can answer the post-bump integer over the pre-write
    // trees, and forward-only comparison then never refreshes them. Awaiting it
    // first makes the baseline at worst older than the data beside it.
    const version = source.indexOf("await readDataVersion()");
    const round = source.indexOf("await Promise.all([");
    expect(version).toBeGreaterThan(-1);
    expect(version).toBeLessThan(round);
    // …and it is genuinely awaited on its own, not a third element of the round.
    expect(source).not.toMatch(/Promise\.all\(\[[\s\S]*?readDataVersion\(\)[\s\S]*?\]\)/);
    // The trees stay a server read: no client fetch of tree data, and the
    // version is a lib call rather than a request to its own route.
    expect(source).not.toContain("fetch(");
    // The watcher is mounted INSIDE the provider — outside it, the baseline it
    // compares against would be `EMPTY_DATA`'s 0 on every render.
    const provider = source.indexOf("<WorkbenchDataProvider");
    const watcher = source.indexOf("<DataVersionWatcher />");
    const shell = source.indexOf("<Workbench>");
    expect(provider).toBeGreaterThan(-1);
    expect(watcher).toBeGreaterThan(provider);
    expect(watcher).toBeLessThan(shell);
  });

  it("WorkbenchData carries it as a field with an empty default", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "WorkbenchData.tsx"), "utf8");
    expect(source).toContain("dataVersion: number;");
    expect(source).toContain("dataVersion: 0,");
  });

  it("the shell hands it to the Preview and stays router-free", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "Workbench.tsx"), "utf8");
    expect(source).toContain("dataVersion,");
    expect(source).toContain("dataVersion={dataVersion}");
    // A mode switch is state, never a route change — and the trees are refreshed
    // by the watcher, which is the only component here that may hold a router.
    expect(source).not.toMatch(/\buseRouter\(/);
    expect(source).not.toContain("router.refresh()");
  });
});

describe("the Preview column re-reads its bytes without disturbing an editor", () => {
  it("gates its effect on the executed plan and takes the version as a dep", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "PreviewColumn.tsx"), "utf8");
    // Whitespace-insensitive: what matters is that BOTH selections reach the
    // plan and that the recorded row comes back OUT of it. The ordering the
    // component used to hold by hand — compare, then record — is now inside
    // `previewFetchPlan`, where the suite executes it.
    expect(source).toMatch(
      /previewFetchPlan\(\{\s*shown:\s*shownSelectionRef\.current,\s*next:\s*selection,\s*editing,\s*\}\)/,
    );
    expect(source).toContain("shownSelectionRef.current = plan.shown;");
    // …and the component records nothing of its own, so there is no assignment
    // left that a tidy-up could hoist above the comparison.
    expect(source).not.toContain("shownSelectionRef.current = selection");
    expect(source).toContain("if (!plan.fetch) return;");
    expect(source).toContain("if (plan.reset) {");
    // DW-54's `retryNonce` joins the array. It is a DEPENDENCY rather than an
    // imperative re-read for the reason the plan exists at all: a second
    // request path would carry its own reset semantics, and a retry pressed
    // while the editor is open would then take the owner's draft.
    expect(source).toMatch(/\}, \[selection, dataVersion, editing, retryNonce\]\)/);
    // The reset block — the one that abandons an open editor — is now BEHIND the
    // plan, and still inside the effect.
    const effect = source.slice(
      source.indexOf("if (plan.reset) {"),
      source.indexOf("}, [selection, dataVersion, editing, retryNonce])"),
    );
    expect(effect).toContain("setEditing(false)");
    expect(effect).toContain("editingTargetRef.current = null");
    expect(effect).toContain("setPayload(null)");
    // A silent refresh that succeeds must clear a previous failure; a 404 must
    // still say so, because a page another actor just deleted cannot keep
    // rendering as if it were there; and a read that could not be REACHED must
    // do neither — the last-good bytes stay and a transient strip appears over
    // them (DW-54). Three outcomes, three branches.
    //
    // Scoped to the RESPONSE HANDLER, not to the effect: the reset block above
    // carries its own clearing calls, so an effect-wide check is satisfied by a
    // handler that never clears the flags — and a row that failed once would
    // then keep showing `This file couldn’t be loaded.` over bytes it has since
    // re-read successfully.
    // …and scoped to each BRANCH of that handler, not to the handler as a
    // whole: one slice containing every call is satisfied by them swapped,
    // which renders `This file couldn’t be loaded.` over every page that read
    // fine and leaves every genuine failure rendering as if the bytes were
    // still there — the precise pair of states this pins against.
    const handler = source.slice(
      source.indexOf("void fetchPreview("),
      source.indexOf("setLoading(false);", source.indexOf("void fetchPreview(")),
    );
    const okStart = handler.indexOf('if (result.status === "ok") {');
    const goneStart = handler.indexOf('} else if (result.status === "gone") {', okStart);
    const elseStart = handler.indexOf("} else {", goneStart);
    expect(okStart).toBeGreaterThan(-1);
    expect(goneStart).toBeGreaterThan(okStart);
    expect(elseStart).toBeGreaterThan(goneStart);
    const ok = handler.slice(okStart, goneStart);
    const gone = handler.slice(goneStart, elseStart);
    const unreachable = handler.slice(elseStart);
    // A landed read clears BOTH failure flags. `setGone(false)` alone would
    // leave a strip standing over bytes that just arrived successfully.
    expect(ok).toContain("setPayload(result.payload);");
    expect(ok).toContain("setGone(false);");
    expect(ok).toContain("setUnreachable(false);");
    // …and it is the only branch that may announce, because it is the only one
    // in which the body actually changed. WHETHER it does is the executed
    // `previewRefreshAnnouncement`, not a comparison typed here.
    expect(ok).toContain("previewRefreshAnnouncement({");
    expect(gone).not.toContain("previewRefreshAnnouncement(");
    expect(unreachable).not.toContain("previewRefreshAnnouncement(");
    // A 404 replaces the body and cancels any strip: "showing the last version
    // that loaded" over `This file couldn’t be loaded.` is a false statement
    // about what is underneath it.
    expect(gone).toContain("setGone(true);");
    expect(gone).toContain("setUnreachable(false);");
    expect(gone).not.toContain("setGone(false);");
    // And a blip touches NEITHER the payload nor `gone`. The whole of DW-54 is
    // that these two lines are absent from this branch: with them, one dropped
    // packet replaces the page the owner is reading and never heals.
    expect(unreachable).toContain("setUnreachable(true);");
    expect(unreachable).not.toContain("setGone(true);");
    expect(unreachable).not.toContain("setPayload(");
  });

  it("nudges the watcher after a save instead of refreshing anything itself", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "PreviewColumn.tsx"), "utf8");
    expect(source).toContain("requestDataVersionCheck();");
    expect(source).not.toMatch(/\buseRouter\(/);
    expect(source).not.toContain("router.refresh()");
    expect(source).not.toContain('from "next/navigation"');
    // The column still issues no request of its own.
    expect(source).not.toMatch(/\bfetch\(/);
  });
});

describe("DataVersionWatcher", () => {
  it("renders nothing and owns the only refresh in the shell", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "DataVersionWatcher.tsx"), "utf8");
    expect(source).toContain('"use client"');
    expect(source).toContain("return null;");
    expect(source).toContain("useRouter()");
    expect(source).toContain("router.refresh();");
    // The baseline is the provider's field, read through a ref assigned during
    // render so a poll compares against the payload now on screen.
    expect(source).toContain("useWorkbenchData()");
    expect(source).toContain("servedRef.current = dataVersion;");
    // The refresh state is the rule's answer, assigned verbatim. The watcher
    // decides nothing about how much of a version's budget has been spent.
    expect(source).toContain("refreshStateRef.current = plan.state;");
    // Ref state, seeded from the module's own initial value: it resets on
    // remount and there is nowhere for it to be persisted.
    expect(source).toContain("useRef(NO_DATA_VERSION_REFRESH)");
  });

  it("spells no comparison or arithmetic of its own — the decision is the executed function", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "DataVersionWatcher.tsx"), "utf8");
    expect(source).toContain("dataVersionRefreshPlan({");
    expect(source).toContain("served: servedRef.current,");
    expect(source).toContain("polled: result.version,");
    expect(source).toContain("state: refreshStateRef.current,");
    // The clock READING is the watcher's to take — it is the one thing the pure
    // rule cannot get for itself — and it is handed over raw. Nothing is
    // computed from it here.
    expect(source).toContain("now: Date.now(),");
    // Strip the comments first: the docblock explains forward-only comparison
    // and the retry budget in prose, and prose is neither a comparison nor
    // arithmetic. TRAILING comments are stripped too — a whole-line filter
    // alone leaves `refreshStateRef.current = plan.state; // + 1` behind,
    // which trips both guards below on what is still only prose.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/(version|Version|polled|served)\s*[<>]=?\s*/);
    // …and the budget is kept in the rule, not here: no bound of the watcher's
    // own, in either the old count's spelling or the new one's. An inlined
    // `Date.now() - last < 10_000` here would pass every other assertion in
    // this file while owning half the policy. Case-insensitive, so a
    // `Settle`/`SETTLE` spelling cannot slip past.
    expect(code).not.toMatch(/attempts/i);
    expect(code).not.toMatch(/settle/i);
    expect(code).not.toContain("DATA_VERSION_REFRESH_ATTEMPTS");
    expect(code).not.toContain("DATA_VERSION_REFRESH_WINDOW_MS");
    expect(code).not.toContain("DATA_VERSION_REFRESH_SETTLE_MS");
    // The arithmetic ban is ANCHORED to the state handling rather than applied
    // to the whole file: some unrelated `+ 1` elsewhere in this component is
    // not this story's business, but one between the plan call and the refresh
    // is the watcher recomputing what the rule already answered.
    const stateHandling = code.slice(
      code.indexOf("const plan = dataVersionRefreshPlan("),
      code.indexOf("router.refresh();"),
    );
    expect(stateHandling).toContain("refreshStateRef.current = plan.state;");
    expect(stateHandling).not.toMatch(/[+\-]\s*\d/);
    // Nothing is COMPUTED from the reading, and no bound is spelled next to it:
    // no arithmetic hanging off `Date.now()`, no comparison at all, and no
    // millisecond literal for a `30_000`/`10_000` to hide in.
    expect(stateHandling).not.toMatch(/Date\.now\(\)\s*[+\-*/%]/);
    expect(stateHandling).not.toMatch(/[<>]=?/);
    expect(stateHandling).not.toMatch(/\d[\d_]{2,}/);
    // …and the reading is taken ONCE, here. The occurrence guard is anchored to
    // this slice for the same reason the arithmetic ban is: an unrelated clock
    // read elsewhere in this component is not this story's business.
    expect(stateHandling).toContain("now: Date.now(),");
    expect(stateHandling.match(/Date\.now\(\)/g) ?? []).toHaveLength(1);
  });

  it("uses the decision's answer the right way round", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "DataVersionWatcher.tsx"), "utf8");
    // Executing the decision is not the same as OBEYING it. `toContain(
    // "dataVersionRefreshPlan({")` above is satisfied by a watcher that dropped
    // the `!` — which refreshes on every poll where nothing changed and never
    // when a write lands, i.e. the exact inverse of the story, with the whole
    // suite green. The polarity is the thing, so it is pinned here.
    const run = source.slice(
      source.indexOf("async function run()"),
      source.indexOf("function startPolling()"),
    );
    expect(run).toMatch(
      /const plan = dataVersionRefreshPlan\(\{[\s\S]{0,240}?\}\);/,
    );
    expect(run).toMatch(/if \(!plan\.refresh\) return;/);
    // The state is recorded BEFORE the guard. Today's rule returns the state
    // UNCHANGED on every non-refresh branch, so moving the assignment below the
    // guard changes no behaviour — which is precisely why it is pinned here
    // rather than left to a mounted test: the ordering is invisible until the
    // day a branch declines to refresh AND still has something to record (a
    // give-up that should stop re-arming, say), and then it silently loops.
    // `previewFetchPlan.shown` carries the same guarantee for the same reason.
    const assigned = run.indexOf("refreshStateRef.current = plan.state;");
    expect(assigned).toBeGreaterThan(run.indexOf("dataVersionRefreshPlan("));
    expect(assigned).toBeLessThan(run.indexOf("if (!plan.refresh) return;"));
    // …and the refresh is reached only AFTER that guard, exactly once, so the
    // branch cannot be bypassed by a second call site above it.
    expect(run.match(/router\.refresh\(\)/g) ?? []).toHaveLength(1);
    expect(run.indexOf("router.refresh()")).toBeGreaterThan(
      run.indexOf("if (!plan.refresh) return;"),
    );
    // A poll that could not answer never reaches the decision at all.
    expect(run).toMatch(/if \(result\.status !== "ok"\) return;/);
  });

  it("polls only while the tab is visible, one controller per run", async () => {
    const source = await fs.readFile(path.join(WORKBENCH, "DataVersionWatcher.tsx"), "utf8");
    // The `useSidecarStatus` loop, verbatim in structure.
    expect(source).toContain('document.visibilityState === "visible"');
    expect(source).toContain("setInterval(() => void run(), DATA_VERSION_POLL_MS)");
    expect(source).toContain("clearInterval(timer)");
    expect(source).toContain("new AbortController()");
    // The handler is REGISTERED, asserted rather than merely used below as a
    // slice delimiter. Deleting this one line leaves every other assertion in
    // this test green — `mount`'s slice just runs to the end of the file, and
    // the cleanup still references `onVisibility` so eslint stays quiet — while
    // a Workbench mounted into a hidden tab (a restored session, a
    // background-opened tab) never reaches `startPolling()` for the whole life
    // of that mount, and a visible one never stops.
    expect(source).toContain('document.addEventListener("visibilitychange", onVisibility);');

    // BOTH call sites, each sliced. A whole-file `toContain("startPolling()")`
    // is satisfied by the function's own declaration, so deleting both calls
    // would leave the story's only non-owner refresh path silently dead with
    // the suite green: the tab would then refresh solely when the owner saves.
    //
    // The mount: an immediate check AND the interval, so the first answer does
    // not wait a full cadence.
    const mount = source.slice(
      source.lastIndexOf('if (document.visibilityState === "visible") {'),
      source.indexOf('document.addEventListener("visibilitychange"'),
    );
    expect(mount).toContain("void run();");
    expect(mount).toContain("startPolling();");
    // …and coming back to a backgrounded tab does exactly the same, so the
    // trees are fresh by the time they are visible again.
    const onVisibility = source.slice(
      source.indexOf("function onVisibility() {"),
      source.indexOf("} else {", source.indexOf("function onVisibility() {")),
    );
    expect(onVisibility).toContain("void run();");
    expect(onVisibility).toContain("startPolling();");
    // …and going away STOPS it, sliced to the hidden branch alone. A whole-file
    // `toContain("stopPolling();")` is satisfied by the cleanup's own copy, so
    // deleting this branch's call would leave the suite green while a
    // backgrounded tab kept polling forever — the one claim the visibility gate
    // makes, and the reason the loop exists in this shape at all.
    const hidden = source.slice(
      source.indexOf("} else {", source.indexOf("function onVisibility() {")),
      source.lastIndexOf('if (document.visibilityState === "visible") {'),
    );
    expect(hidden).toContain("stopPolling();");
    expect(hidden).not.toContain("startPolling();");
    expect(source).toContain("let cancelled = false;");
    expect(source).toContain("if (cancelled || controller.signal.aborted) return;");
    // Full teardown: the interval, the listener, the subscription and the
    // in-flight request all stop when the shell goes away.
    const cleanup = source.slice(source.lastIndexOf("return () => {"));
    expect(cleanup).toContain("cancelled = true;");
    expect(cleanup).toContain("stopPolling();");
    expect(cleanup).toContain('document.removeEventListener("visibilitychange", onVisibility);');
    expect(cleanup).toContain("unsubscribe();");
    expect(cleanup).toContain("abortRef.current?.abort();");
    // The save's immediate check is wired in the SAME effect as the poll, so it
    // can never outlive the teardown.
    expect(source).toContain("subscribeDataVersionCheck(() => void run())");
    // No browser-local copy of the signal (AD-7 adds no new key here).
    expect(source).not.toContain("localStorage");
  });
});

describe("the route", () => {
  it("follows the shape every other Workbench route answers with", async () => {
    const source = await readSource("app/api/workbench/version/route.ts");
    expect(source).toContain('const NO_STORE = { "Cache-Control": "private, no-store" } as const;');
    expect(source).toContain("getPrincipal()");
    expect(source).toContain('return json({ error: "Sign in required." }, 401);');
    expect(source).toContain("return await handle();");
    expect(source).toContain("return json({ error: getErrorMessage(error) }, 500);");
    expect(source).toContain("readDataVersion()");
    // The gate is the route's, and the counter is the module's — the route
    // invents neither a key nor an idea of what an invalid value means.
    expect(source).not.toContain("getIndex");
    expect(source).not.toContain("putIndex");
  });
});
