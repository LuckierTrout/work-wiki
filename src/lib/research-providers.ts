export type ResearchProvider = "tavily" | "serpapi" | "searxng";

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = boundedText(body?.error ?? body?.message, 500);
    throw new Error(`Research provider failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!body) throw new Error("Research provider returned invalid JSON");
  return body;
}

export function availableResearchProviders(): ResearchProvider[] {
  const providers: ResearchProvider[] = [];
  if (process.env.TAVILY_API_KEY?.trim()) providers.push("tavily");
  if (process.env.SERPAPI_API_KEY?.trim()) providers.push("serpapi");
  if (process.env.SEARXNG_BASE_URL?.trim()) providers.push("searxng");
  return providers;
}

export function resolveResearchProvider(preferred?: string): ResearchProvider {
  const available = availableResearchProviders();
  if (preferred && available.includes(preferred as ResearchProvider)) {
    return preferred as ResearchProvider;
  }
  const configuredDefault = process.env.RESEARCH_PROVIDER?.trim().toLowerCase();
  if (configuredDefault && available.includes(configuredDefault as ResearchProvider)) {
    return configuredDefault as ResearchProvider;
  }
  if (available[0]) return available[0];
  throw new Error("No research provider is configured. Add TAVILY_API_KEY, SERPAPI_API_KEY, or SEARXNG_BASE_URL.");
}

async function tavilySearch(query: string, limit: number): Promise<ResearchSearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: limit,
      include_answer: false,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await checkedJson(response);
  const results = Array.isArray(body.results) ? body.results : [];
  return results.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const url = safeUrl(item.url);
    if (!url) return [];
    return [{
      title: boundedText(item.title, 300) || url,
      url,
      snippet: boundedText(item.content, 4_000),
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      ...(boundedText(item.published_date, 80) ? { publishedAt: boundedText(item.published_date, 80) } : {}),
    }];
  });
}

async function serpApiSearch(query: string, limit: number): Promise<ResearchSearchResult[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY ?? "");
  url.searchParams.set("safe", "active");
  url.searchParams.set("num", String(limit));
  const body = await checkedJson(await fetch(url, { signal: AbortSignal.timeout(45_000) }));
  if (body.error) throw new Error(boundedText(body.error, 500));
  const results = Array.isArray(body.organic_results) ? body.organic_results : [];
  return results.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const resultUrl = safeUrl(item.link);
    if (!resultUrl) return [];
    return [{
      title: boundedText(item.title, 300) || resultUrl,
      url: resultUrl,
      snippet: boundedText(item.snippet, 4_000),
      ...(boundedText(item.date, 80) ? { publishedAt: boundedText(item.date, 80) } : {}),
    }];
  });
}

async function searxngSearch(query: string, limit: number): Promise<ResearchSearchResult[]> {
  const base = process.env.SEARXNG_BASE_URL?.trim();
  if (!base) throw new Error("SEARXNG_BASE_URL is not configured");
  const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "1");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.SEARXNG_API_KEY?.trim()) {
    headers.Authorization = `Bearer ${process.env.SEARXNG_API_KEY.trim()}`;
  }
  const body = await checkedJson(await fetch(url, { headers, signal: AbortSignal.timeout(45_000) }));
  const results = Array.isArray(body.results) ? body.results.slice(0, limit) : [];
  return results.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const resultUrl = safeUrl(item.url);
    if (!resultUrl) return [];
    return [{
      title: boundedText(item.title, 300) || resultUrl,
      url: resultUrl,
      snippet: boundedText(item.content, 4_000),
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      ...(boundedText(item.publishedDate, 80) ? { publishedAt: boundedText(item.publishedDate, 80) } : {}),
    }];
  });
}

export async function searchResearchProvider(
  provider: ResearchProvider,
  query: string,
  limit = 8,
): Promise<ResearchSearchResult[]> {
  const cleaned = query.trim().slice(0, 1_000);
  if (!cleaned) throw new Error("Research query is required");
  const boundedLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  if (provider === "tavily") return tavilySearch(cleaned, boundedLimit);
  if (provider === "serpapi") return serpApiSearch(cleaned, boundedLimit);
  return searxngSearch(cleaned, boundedLimit);
}
