import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlugTenantMap } from "@/lib/links";

/**
 * Pins the load-bearing seams of `useSlugTenants` without a renderer (the hook
 * itself needs one; its two seams don't):
 *   - `loadSlugTenants`: the session-cached `/api/wiki/routes` fetch — one
 *     request per session, graceful `{}` on failure.
 *   - `hrefFromMap`: the map→href resolution the hook's `hrefForSlug`
 *     delegates to — map hit → canonical owner URL (the DW-2 behavior),
 *     unknown slug → the DEFAULT_TENANT form the owner route 308s onward.
 *
 * The module-level cache is a singleton, so each test resets the module
 * registry and dynamically imports a cold copy.
 */

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function importCold() {
  return import("../useSlugTenants");
}

describe("loadSlugTenants", () => {
  it("fetches /api/wiki/routes exactly once across calls and returns the parsed map", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ a: "alice" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants } = await importCold();

    expect(await loadSlugTenants()).toEqual({ a: "alice" });
    expect(await loadSlugTenants()).toEqual({ a: "alice" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/wiki/routes");
  });

  it("shares one in-flight request between concurrent callers", async () => {
    // The "exactly once" test above awaits the first call, so its second call
    // only exercises the warm cache — this pins the `inflight` sharing branch.
    let release!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants } = await importCold();

    const first = loadSlugTenants();
    const second = loadSlugTenants(); // issued while the first is still in flight
    release({ ok: true, json: async () => ({ a: "alice" }) });

    expect(await first).toEqual({ a: "alice" });
    expect(await second).toEqual({ a: "alice" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves to an empty map on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ never: "used" }) })),
    );
    const { loadSlugTenants } = await importCold();
    expect(await loadSlugTenants()).toEqual({});
  });

  it("does NOT cache the empty map from a non-OK response — the next call retries", async () => {
    // DW-87: the non-OK branch used to substitute `{}` INSIDE the chain, so it
    // reached the cache-assigning `.then` and pinned every link to the
    // DEFAULT_TENANT form for the rest of the session. One transient
    // 401/429/500 was enough, and only a full reload cleared it. The rejected
    // fetch never cached; the two failure modes are symmetric now.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ a: "alice" }) });
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants } = await importCold();

    expect(await loadSlugTenants()).toEqual({});
    expect(await loadSlugTenants()).toEqual({ a: "alice" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // And the recovered map IS cached, so the retry is not a per-call refetch.
    expect(await loadSlugTenants()).toEqual({ a: "alice" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves to an empty map when the fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { loadSlugTenants } = await importCold();
    expect(await loadSlugTenants()).toEqual({});
  });

  it.each([
    ["null", null],
    ["an array", [{ a: "alice" }]],
    ["a string", "alice"],
    ["a number", 7],
  ])(
    "treats an OK response whose body is %s as a failure: {} back, nothing cached",
    async (_label, body) => {
      // `r.json()` is `any`, so the body is not a typed map just because the
      // route declares one. `null` is the worst of these: it caches FALSY, so
      // `if (cache)` misses and every caller re-fetches forever. An array or a
      // scalar caches and reaches every renderer.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => body })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ a: "alice" }) });
      vi.stubGlobal("fetch", fetchMock);
      const { loadSlugTenants } = await importCold();

      expect(await loadSlugTenants()).toEqual({});
      // Not cached — the next caller retries and gets the real map.
      expect(await loadSlugTenants()).toEqual({ a: "alice" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("caches a legitimately empty map from an OK response", async () => {
    // A viewer with no readable pages gets `{}` — a real answer, not a
    // failure. Making the non-OK branch uncached must not turn every empty
    // map into a per-call refetch.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants } = await importCold();
    expect(await loadSlugTenants()).toEqual({});
    expect(await loadSlugTenants()).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("_resetSlugTenants() drops the warm cache — the next call re-fetches", async () => {
    // The reset is a CONTRACT, not a convenience: it is what lets a mounted
    // suite express "routes failed" (DW-262), which is unreachable once any
    // earlier case in that file has warmed this module-level singleton. This
    // project has no DOM, so it pins the cache/in-flight clearing only.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ a: "alice" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants, _resetSlugTenants } = await importCold();

    expect(await loadSlugTenants()).toEqual({ a: "alice" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    _resetSlugTenants();

    expect(await loadSlugTenants()).toEqual({ a: "alice" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("_resetSlugTenants() unwires an IN-FLIGHT request — the next call issues its own", async () => {
    // Clearing only `cache` would leave the stale promise in `inflight`, so the
    // next caller would silently join the request the reset was meant to
    // discard — and a suite that reset to stage an outage would still be
    // answered by the pre-reset fetch.
    let release!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, json: async () => ({ b: "bob" }) });
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants, _resetSlugTenants, _subscribeSlugTenants } =
      await importCold();

    const abandoned = loadSlugTenants(); // in flight when the reset lands
    _resetSlugTenants();

    expect(await loadSlugTenants()).toEqual({ b: "bob" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Subscribed AFTER the reset, so anything it hears came from the abandoned
    // request writing to state it no longer owns.
    const seen: SlugTenantMap[] = [];
    _subscribeSlugTenants((m) => {
      seen.push(m);
    });

    // The abandoned request settles LATE — nothing cancels a `fetch`. It still
    // answers its own caller, and that is all it may do: writing `{a:"alice"}`
    // into the cache here would hand every later caller the map the reset
    // discarded, and broadcasting it would push that stale map into every
    // component mounted since.
    release({ ok: true, json: async () => ({ a: "alice" }) });
    expect(await abandoned).toEqual({ a: "alice" });

    expect(await loadSlugTenants()).toEqual({ b: "bob" }); // cache not clobbered
    expect(fetchMock).toHaveBeenCalledTimes(2); // inflight slot not stolen either
    expect(seen).toEqual([]); // and nothing was broadcast
  });

  it("an abandoned request does not free the in-flight slot of the one that replaced it", async () => {
    // The other half of the reset's disowning. The abandoned chain's `.finally`
    // still runs, and clearing `inflight` unconditionally there would empty a
    // slot the POST-reset request is still using — so the next caller, instead
    // of joining it, would open a duplicate `/api/wiki/routes`.
    const releases: Array<(response: unknown) => void> = [];
    const fetchMock = vi.fn(
      () => new Promise((resolve) => releases.push(resolve as (r: unknown) => void)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants, _resetSlugTenants } = await importCold();

    const abandoned = loadSlugTenants(); // request 1, parked
    _resetSlugTenants();
    const replacement = loadSlugTenants(); // request 2, parked, now owns the slot

    // Request 1 settles LATE, while request 2 is still in flight.
    releases[0]({ ok: true, json: async () => ({ a: "alice" }) });
    expect(await abandoned).toEqual({ a: "alice" });

    // A third caller must join request 2, not open a request 3.
    const joined = loadSlugTenants();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releases[1]({ ok: true, json: async () => ({ b: "bob" }) });
    expect(await replacement).toEqual({ b: "bob" });
    expect(await joined).toEqual({ b: "bob" });
  });

  it("a DEGRADED load notifies nobody", async () => {
    // The broadcast lives inside the success `.then` precisely so this is true:
    // `{}` is not news, and a hook that adopted it would re-render for a map it
    // already has. Moved below the `.catch`, every href assertion in the mounted
    // suites would still pass — the degraded href and the not-yet-loaded href
    // are the same string — so this is the only place the distinction is
    // observable at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const { loadSlugTenants, _subscribeSlugTenants } = await importCold();

    const seen: SlugTenantMap[] = [];
    _subscribeSlugTenants((m) => {
      seen.push(m);
    });

    expect(await loadSlugTenants()).toEqual({});
    expect(seen).toEqual([]);
  });

  it("a throwing listener strands neither its neighbours nor the map", async () => {
    // The notify loop runs INSIDE the success `.then`, so an unguarded throw
    // would reject the shared promise straight into the degrading `.catch` —
    // and every caller of a load that actually succeeded would be handed `{}`.
    // That is the failure this guard exists for, and the reason the subscribe
    // door is exported at all: every real listener is a hook's `setMap`, which
    // does not throw.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ a: "alice" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadSlugTenants, _subscribeSlugTenants } = await importCold();

    const seen: SlugTenantMap[] = [];
    // Registered FIRST, so the recording listener below is genuinely downstream
    // of the throw rather than merely unaffected by it.
    _subscribeSlugTenants(() => {
      throw new Error("a listener blew up");
    });
    _subscribeSlugTenants((m) => {
      seen.push(m);
    });

    // The map, not the degraded `{}`: the throw never reached the `.catch`.
    expect(await loadSlugTenants()).toEqual({ a: "alice" });
    expect(seen).toEqual([{ a: "alice" }]);
  });
});

describe("hrefFromMap", () => {
  it("resolves a mapped slug to its owner's canonical URL", async () => {
    const { hrefFromMap } = await importCold();
    expect(hrefFromMap({ a: "alice" }, "a")).toBe("/u/alice/a");
  });

  it("falls back to the DEFAULT_TENANT form for an unknown slug (map loading / new page)", async () => {
    const { hrefFromMap } = await importCold();
    expect(hrefFromMap({}, "x")).toBe("/u/yopedia/x");
  });
});

describe("useSlugTenants in a React render", () => {
  // Effects don't run during server rendering, so these pin the hook's actual
  // render-time contract — state initialized from the warmed module cache,
  // `hrefForSlug` delegation, and the exposed `slugTenants` map — inside a real
  // React render, not just the extracted seams.
  it("renders map-driven canonical hrefs once the session cache is warm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ a: "alice" }) })),
    );
    const mod = await importCold();
    await mod.loadSlugTenants(); // warm the cache the hook's state initializes from
    const Probe = () => {
      const { hrefForSlug, slugTenants } = mod.useSlugTenants();
      return createElement("a", { href: hrefForSlug("a") }, slugTenants["a"]);
    };
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain('href="/u/alice/a"');
    expect(html).toContain(">alice<");
  });

  it("renders the DEFAULT_TENANT fallback href while the map has not loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ x: "alice" }) })),
    );
    const mod = await importCold(); // cold module: cache is still empty
    const Probe = () =>
      createElement("a", { href: mod.useSlugTenants().hrefForSlug("x") });
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain('href="/u/yopedia/x"');
  });
});
