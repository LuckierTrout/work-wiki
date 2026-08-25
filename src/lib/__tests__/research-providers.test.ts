import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableResearchProviders,
  extractResearchSourceText,
  researchProviderMissingCopy,
  resolveResearchProvider,
  searchResearchProvider,
  selectResearchProvider,
  ResearchProviderUnconfiguredError,
} from "../research-providers";
import type { ResearchSettings } from "../config";
import { SETTINGS_FIRECRAWL_COPY } from "../workbench-settings";

const ENV_KEYS = [
  "TAVILY_API_KEY",
  "SERPAPI_API_KEY",
  "SERPAPI_ENGINE",
  "SEARXNG_BASE_URL",
  "SEARXNG_API_KEY",
  "SEARXNG_CATEGORIES",
  "RESEARCH_PROVIDER",
  "FIRECRAWL_API_KEY",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/**
 * A settings snapshot, injected rather than read.
 *
 * `getResearchSettings()` is the default argument of every function here, and
 * the env-precedence cases below exercise exactly that door. These explicit
 * snapshots are for the cases about the STORE — a provider chosen in Settings
 * with no environment variable in sight — which no amount of `process.env`
 * poking can express.
 */
function settings(overrides: Partial<ResearchSettings> = {}): ResearchSettings {
  return {
    provider: null,
    envProvider: null,
    invalidEnvProvider: null,
    tavilyApiKey: null,
    serpApiKey: null,
    serpApiEngine: "google",
    searxngBaseUrl: null,
    envSearxngBaseUrl: null,
    searxngCategories: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("choosing a research provider", () => {
  it("defaults to Tavily when nothing is stored and nothing is pinned", () => {
    expect(selectResearchProvider(undefined, settings())).toBe("tavily");
  });

  it("honors the stored selection over the default", () => {
    expect(selectResearchProvider(undefined, settings({ provider: "serpapi" }))).toBe("serpapi");
  });

  it("lets RESEARCH_PROVIDER win over the stored selection", () => {
    process.env.RESEARCH_PROVIDER = "searxng";
    process.env.SEARXNG_BASE_URL = "https://search.example/";
    // Env-wins is resolved inside `getResearchSettings`, so this case goes
    // through the real door rather than an injected snapshot.
    expect(selectResearchProvider()).toBe("searxng");
    expect(resolveResearchProvider()).toBe("searxng");
  });

  it("lets an env override beat a per-run preference too", () => {
    // A pinned deployment is pinned for every run: a project carrying a stored
    // `provider` from before the pin must not slip past it.
    expect(
      selectResearchProvider("tavily", settings({ envProvider: "serpapi", provider: "tavily" })),
    ).toBe("serpapi");
  });

  it("ignores a per-run preference that is not one of the three", () => {
    expect(selectResearchProvider("firecrawl", settings({ provider: "serpapi" }))).toBe("serpapi");
  });

  it("fails closed on an unsupported RESEARCH_PROVIDER", () => {
    process.env.RESEARCH_PROVIDER = "firecrawl";
    process.env.TAVILY_API_KEY = "tavily-test";
    expect(() => selectResearchProvider()).toThrow(/unsupported value/i);
    expect(() => resolveResearchProvider()).toThrow(/unsupported value/i);
  });
});

describe("refusing to fall back", () => {
  it("throws for the SELECTED provider even when another one is configured", () => {
    // THE ONE THAT MATTERS. A deployment holding a Tavily key with SerpApi
    // selected used to search Tavily and say nothing about it.
    const stored = settings({ provider: "serpapi", tavilyApiKey: "tavily-test" });
    expect(() => resolveResearchProvider(undefined, stored)).toThrow(
      ResearchProviderUnconfiguredError,
    );
    expect(() => resolveResearchProvider(undefined, stored)).toThrow(/SerpApi/);
    // …and it still REPORTS what is configured, which the surface needs.
    expect(availableResearchProviders(stored)).toEqual(["tavily"]);
  });

  it("names the selected provider and the credential to supply", () => {
    expect(researchProviderMissingCopy("serpapi")).toContain("SerpApi API key");
    expect(researchProviderMissingCopy("searxng")).toContain("SearXNG instance URL");
    for (const provider of ["tavily", "serpapi", "searxng"] as const) {
      expect(researchProviderMissingCopy(provider)).toContain(
        "no other provider is used in its place",
      );
    }
  });

  it("refuses when only a Firecrawl key is stored", () => {
    process.env.FIRECRAWL_API_KEY = "firecrawl-test";
    expect(availableResearchProviders()).toEqual([]);
    expect(() => resolveResearchProvider()).toThrow(ResearchProviderUnconfiguredError);
  });

  it("does not advertise a malformed SearXNG URL as configured", () => {
    const malformed = settings({ provider: "searxng", searxngBaseUrl: "not a url" });

    expect(availableResearchProviders(malformed)).toEqual([]);
    expect(() => resolveResearchProvider(undefined, malformed))
      .toThrow(ResearchProviderUnconfiguredError);
  });

  it("no longer claims the Firecrawl key is for Deep Research", () => {
    expect(SETTINGS_FIRECRAWL_COPY).not.toMatch(/for Deep Research/i);
    expect(SETTINGS_FIRECRAWL_COPY).toMatch(/not a Deep Research search provider/i);
  });
});

describe("searching", () => {
  it("asks Tavily for raw content and keeps it unsliced", async () => {
    const long = "x".repeat(12_000);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      results: [
        {
          title: "  Useful   source ",
          url: "https://example.com/page",
          content: "A   finding",
          raw_content: long,
          score: 0.8,
        },
        { title: "Unsafe", url: "javascript:alert(1)", content: "ignored" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const results = await searchResearchProvider(
      "tavily",
      "  launch evidence  ",
      50,
      settings({ tavilyApiKey: "tavily-test" }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Useful source",
      url: "https://example.com/page",
      snippet: "A finding",
      score: 0.8,
    });
    // The persisted snippet is bounded; the synthesis text is NOT — 12 000
    // characters through a 4 000-character cap is the exact regression the spec
    // names.
    expect(results[0].content).toHaveLength(long.length);

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "launch evidence",
      max_results: 10,
      search_depth: "advanced",
      include_raw_content: true,
    });
  });

  it("bounds the persisted snippet even when the provider sends an essay", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: "T", url: "https://example.com/", content: "y".repeat(9_000) }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const results = await searchResearchProvider(
      "tavily",
      "q",
      1,
      settings({ tavilyApiKey: "tavily-test" }),
    );
    expect(results[0].snippet).toHaveLength(4_000);
  });

  it("sends the configured SerpApi engine", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      organic_results: [{ title: "Hit", link: "https://example.com/", snippet: "S", date: "2026-08-01" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(
      searchResearchProvider("serpapi", "topic", 3, settings({
        serpApiKey: "serp-test",
        serpApiEngine: "bing",
      })),
    ).resolves.toEqual([
      { title: "Hit", url: "https://example.com/", snippet: "S", publishedAt: "2026-08-01" },
    ]);
    const [requestUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(requestUrl)).toContain("engine=bing");
  });

  it("normalizes SearXNG results, sends its categories and its optional token", async () => {
    process.env.SEARXNG_API_KEY = "private-search-token";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: "Result", url: "https://example.org/", content: "Summary", publishedDate: "2026-08-01" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(
      searchResearchProvider("searxng", "topic", 3, settings({
        searxngBaseUrl: "https://search.example/root/",
        searxngCategories: "news,science",
      })),
    ).resolves.toEqual([
      {
        title: "Result",
        url: "https://example.org/",
        snippet: "Summary",
        publishedAt: "2026-08-01",
      },
    ]);
    const [requestUrl, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(requestUrl)).toContain("/root/search?q=topic&format=json&safesearch=1");
    expect(String(requestUrl)).toContain("categories=news%2Cscience");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer private-search-token" });
  });

  it.each([
    ["tavily", /Tavily/],
    ["serpapi", /SerpApi/],
    ["searxng", /SearXNG/],
  ] as const)("refuses to search %s with an empty credential, before any fetch", async (
    provider,
    named,
  ) => {
    // `searchResearchProvider` takes the provider as an ARGUMENT — the runtime
    // passes the project's stored one — so it is reachable without going through
    // `resolveResearchProvider`. Tavily used to send `Authorization: Bearer `
    // and SerpApi `api_key=`, spending a round trip to be told 401 and then
    // reporting a provider failure instead of the missing key that caused it.
    await expect(searchResearchProvider(provider, "topic", 3, settings()))
      .rejects.toThrow(ResearchProviderUnconfiguredError);
    await expect(searchResearchProvider(provider, "topic", 3, settings()))
      .rejects.toThrow(named);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("reports an unparseable SEARXNG_BASE_URL as a misconfigured provider", async () => {
    // Not as `TypeError: Invalid URL`, which reached the panel as a sentence
    // about URL parsing and told the owner nothing about the Settings box.
    await expect(
      searchResearchProvider("searxng", "topic", 3, settings({ searxngBaseUrl: "not a url" })),
    ).rejects.toThrow(ResearchProviderUnconfiguredError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("omits categories when none are configured", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await searchResearchProvider("searxng", "topic", 3, settings({
      searxngBaseUrl: "https://search.example/",
    }));
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain("categories=");
  });
});

describe("extracting a source URL", () => {
  it("returns the kernel readability extract", async () => {
    vi.doMock("../fetch", () => ({
      fetchUrlContent: vi.fn(async () => ({ title: "Page", content: "  Body text  " })),
    }));
    await expect(extractResearchSourceText("https://example.com/a")).resolves.toEqual({
      title: "Page",
      content: "Body text",
    });
    vi.doUnmock("../fetch");
  });

  it("skips one dead URL rather than failing the run", async () => {
    vi.doMock("../fetch", () => ({
      fetchUrlContent: vi.fn(async () => {
        throw new Error("403");
      }),
    }));
    await expect(extractResearchSourceText("https://example.com/b")).resolves.toBeNull();
    vi.doUnmock("../fetch");
  });

  it("asks the kernel extract for the uncapped body", async () => {
    const fetchMod = await import("../fetch");
    const spy = vi.spyOn(fetchMod, "fetchUrlContent").mockResolvedValue({
      title: "Page",
      content: "Body",
    });

    await extractResearchSourceText("https://example.com/c");

    expect(spy).toHaveBeenCalledWith("https://example.com/c", { maxContentLength: null });
    spy.mockRestore();
  });
});
