import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableResearchProviders,
  resolveResearchProvider,
  searchResearchProvider,
} from "../research-providers";

const ENV_KEYS = [
  "TAVILY_API_KEY",
  "SERPAPI_API_KEY",
  "SEARXNG_BASE_URL",
  "SEARXNG_API_KEY",
  "RESEARCH_PROVIDER",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("research providers", () => {
  it("reports configured providers and honors a configured default", () => {
    process.env.TAVILY_API_KEY = "tavily-test";
    process.env.SEARXNG_BASE_URL = "https://search.example/";
    process.env.RESEARCH_PROVIDER = "searxng";

    expect(availableResearchProviders()).toEqual(["tavily", "searxng"]);
    expect(resolveResearchProvider()).toBe("searxng");
    expect(resolveResearchProvider("tavily")).toBe("tavily");
  });

  it("normalizes Tavily results and drops unsafe URLs", async () => {
    process.env.TAVILY_API_KEY = "tavily-test";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      results: [
        { title: "  Useful   source ", url: "https://example.com/page", content: "A   finding", score: 0.8 },
        { title: "Unsafe", url: "javascript:alert(1)", content: "ignored" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(searchResearchProvider("tavily", "  launch evidence  ", 50)).resolves.toEqual([
      {
        title: "Useful source",
        url: "https://example.com/page",
        snippet: "A finding",
        score: 0.8,
      },
    ]);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "launch evidence",
      max_results: 10,
      search_depth: "advanced",
    });
  });

  it("normalizes SearXNG results and sends its optional bearer token", async () => {
    process.env.SEARXNG_BASE_URL = "https://search.example/root/";
    process.env.SEARXNG_API_KEY = "private-search-token";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: "Result", url: "https://example.org/", content: "Summary", publishedDate: "2026-08-01" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(searchResearchProvider("searxng", "topic", 3)).resolves.toEqual([
      {
        title: "Result",
        url: "https://example.org/",
        snippet: "Summary",
        publishedAt: "2026-08-01",
      },
    ]);
    const [requestUrl, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(requestUrl)).toContain("/root/search?q=topic&format=json&safesearch=1");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer private-search-token" });
  });

  it("fails closed when no provider is configured", () => {
    expect(() => resolveResearchProvider()).toThrow("No research provider is configured");
  });
});
