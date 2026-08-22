import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
