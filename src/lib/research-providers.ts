import {
  DEFAULT_RESEARCH_PROVIDER,
  RESEARCH_PROVIDERS,
  researchProviderLabel,
  type ResearchProviderId,
} from "./workbench-settings";
import { getResearchSettings, type ResearchSettings } from "./config";

/**
 * The search side of Deep Research (AD-18).
 *
 * ONE PROVIDER, NO FALLBACK. `resolveResearchProvider` returns what the owner
 * SELECTED — or refuses. It used to walk `availableResearchProviders()` and take
 * whatever had a credential, which meant a deployment holding a stale SerpApi
 * key silently searched SerpApi while Settings showed Tavily, and no surface
 * ever said so. A run that cannot use the selected provider is a visible
 * failure now, because "which provider searched this" is a fact the owner is
 * entitled to and cannot recover from the results.
 */

/** The one provider vocabulary, re-exported under this module's older name. */
export type ResearchProvider = ResearchProviderId;
export { RESEARCH_PROVIDERS, DEFAULT_RESEARCH_PROVIDER };

export interface ResearchSearchResult {
  title: string;
  url: string;
  /**
   * The provider's own excerpt, bounded for PERSISTENCE — this is what lands in
   * `ResearchProject.results`, which is read by the panel and stored per
   * project.
   */
  snippet: string;
  /**
   * The provider's FULL text for this result, when it returned one.
   *
   * Deliberately unbounded and deliberately NOT persisted: synthesis reads it,
   * and slicing it before synthesis is exactly the truncation the spec forbids —
   * a brief written from 4 000 characters of a long page is a brief about the
   * page's introduction. It rides in memory beside the bounded `snippet` rather
   * than replacing it, because the two have different jobs and different
   * lifetimes.
   */
  content?: string;
  score?: number;
  publishedAt?: string;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** The full body, whitespace-normalised but NEVER sliced. See `content`. */
function fullText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[ \t]+/g, " ") : "";
}

/** The persisted snippet's cap — one constant, so all three providers agree. */
export const RESEARCH_SNIPPET_MAX = 4_000;

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

/**
 * WHICH providers this deployment could search with, env or store.
 *
 * Kept for the surface's benefit — it reports configuration — and no longer
 * used to CHOOSE. See the module note.
 */
export function availableResearchProviders(
  settings: ResearchSettings = getResearchSettings(),
): ResearchProvider[] {
  const providers: ResearchProvider[] = [];
  if (settings.tavilyApiKey) providers.push("tavily");
  if (settings.serpApiKey) providers.push("serpapi");
  if (settings.searxngBaseUrl) providers.push("searxng");
  return providers;
}

/** The sentence a run fails with when the SELECTED provider has no credential. */
export function researchProviderMissingCopy(provider: ResearchProvider): string {
  const needed =
    provider === "tavily"
      ? "a Tavily API key"
      : provider === "serpapi"
        ? "a SerpApi API key"
        : "a SearXNG instance URL";
  return `Deep Research is set to ${researchProviderLabel(provider)}, which has no credential. Add ${needed} in Settings — no other provider is used in its place.`;
}

export class ResearchProviderUnconfiguredError extends Error {
  readonly provider: ResearchProvider;
  constructor(provider: ResearchProvider) {
    super(researchProviderMissingCopy(provider));
    this.name = "ResearchProviderUnconfiguredError";
    this.provider = provider;
  }
}

/**
 * The SELECTED provider, or a throw naming it.
 *
 * `preferred` is a per-run override (the project's own stored provider), and it
 * is honoured only when it names one of the three — a stored value from an older
 * build cannot silently redirect a run. Absent, the env override wins, then the
 * stored select, then {@link DEFAULT_RESEARCH_PROVIDER}.
 *
 * Then the credential is checked, and a missing one THROWS rather than sliding
 * to a provider that has one.
 */
export function resolveResearchProvider(
  preferred?: string | null,
  settings: ResearchSettings = getResearchSettings(),
): ResearchProvider {
  const selected = selectResearchProvider(preferred, settings);
  if (!availableResearchProviders(settings).includes(selected)) {
    throw new ResearchProviderUnconfiguredError(selected);
  }
  return selected;
}

/**
 * WHICH provider is selected, credential or not.
 *
 * Split from the check above so a caller that wants to REPORT the selection —
 * the panel's "searching with X", a refusal that has to name the provider —
 * does not have to catch a throw to learn the name.
 */
export function selectResearchProvider(
  preferred?: string | null,
  settings: ResearchSettings = getResearchSettings(),
): ResearchProvider {
  if (settings.envProvider) return settings.envProvider;
  const wanted = typeof preferred === "string" ? preferred.trim().toLowerCase() : "";
  if ((RESEARCH_PROVIDERS as readonly string[]).includes(wanted)) {
    return wanted as ResearchProvider;
  }
  return settings.provider ?? DEFAULT_RESEARCH_PROVIDER;
}

async function tavilySearch(
  query: string,
  limit: number,
  settings: ResearchSettings,
): Promise<ResearchSearchResult[]> {
  // CHECKED HERE TOO, not only in `resolveResearchProvider`. This function is
  // reachable with an explicit `provider` argument — the runtime passes the
  // project's stored one — and an `Authorization: Bearer ` with nothing after it
  // is a request that spends a round trip to be told 401, then reports a
  // provider failure instead of the missing key that actually caused it.
  const apiKey = settings.tavilyApiKey;
  if (!apiKey) throw new ResearchProviderUnconfiguredError("tavily");
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: limit,
      include_answer: false,
      // TRUE now. Tavily returns the page's own text in `raw_content` when this
      // is set, which is the difference between synthesising from a search
      // engine's two-sentence blurb and synthesising from the sources — and it
      // saves a second fetch per result for every page Tavily already has.
      include_raw_content: true,
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
    const raw = fullText(item.raw_content);
    return [{
      title: boundedText(item.title, 300) || url,
      url,
      snippet: boundedText(item.content, RESEARCH_SNIPPET_MAX),
      ...(raw ? { content: raw } : {}),
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      ...(boundedText(item.published_date, 80) ? { publishedAt: boundedText(item.published_date, 80) } : {}),
    }];
  });
}

async function serpApiSearch(
  query: string,
  limit: number,
  settings: ResearchSettings,
): Promise<ResearchSearchResult[]> {
  // See `tavilySearch`: an empty `api_key` is a wasted round trip that reports
  // the wrong cause.
  const apiKey = settings.serpApiKey;
  if (!apiKey) throw new ResearchProviderUnconfiguredError("serpapi");
  const url = new URL("https://serpapi.com/search.json");
  // Configurable (`SERPAPI_ENGINE` / Settings), defaulted to the value this was
  // hardcoded to — so an owner pointing SerpApi at Bing does not have to fork.
  url.searchParams.set("engine", settings.serpApiEngine);
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("safe", "active");
  url.searchParams.set("num", String(limit));
  const body = await checkedJson(await fetch(url, { signal: AbortSignal.timeout(45_000) }));
  if (body.error) throw new Error(boundedText(body.error, 500));
  const results = Array.isArray(body.organic_results) ? body.organic_results : [];
  // No `content` here, on purpose: SerpApi returns snippets, not page bodies.
  // The runtime's own fetch leg supplies the full text for these — see
  // `research-runtime.ts`.
  return results.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const resultUrl = safeUrl(item.link);
    if (!resultUrl) return [];
    return [{
      title: boundedText(item.title, 300) || resultUrl,
      url: resultUrl,
      snippet: boundedText(item.snippet, RESEARCH_SNIPPET_MAX),
      ...(boundedText(item.date, 80) ? { publishedAt: boundedText(item.date, 80) } : {}),
    }];
  });
}

async function searxngSearch(
  query: string,
  limit: number,
  settings: ResearchSettings,
): Promise<ResearchSearchResult[]> {
  const base = settings.searxngBaseUrl;
  if (!base) throw new ResearchProviderUnconfiguredError("searxng");
  // A base URL that will not parse is a MISCONFIGURED provider, not a runtime
  // fault, so it reports as one: the untyped `TypeError: Invalid URL` this used
  // to raise reached the panel as a sentence about URL parsing, which tells the
  // owner nothing about the Settings box they need to fix.
  let url: URL;
  try {
    url = new URL("search", base.endsWith("/") ? base : `${base}/`);
  } catch {
    throw new ResearchProviderUnconfiguredError("searxng");
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "1");
  // Instance-defined vocabulary, so it is passed through rather than validated
  // against a list this build cannot know. Absent means the instance's default.
  if (settings.searxngCategories) {
    url.searchParams.set("categories", settings.searxngCategories);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  // Still read straight from the environment: this is an OPTIONAL token for a
  // private instance, it has no Settings control, and inventing one would be a
  // field on a surface no acceptance criterion asks for.
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
      snippet: boundedText(item.content, RESEARCH_SNIPPET_MAX),
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      ...(boundedText(item.publishedDate, 80) ? { publishedAt: boundedText(item.publishedDate, 80) } : {}),
    }];
  });
}

/**
 * Extract one result URL's full text through the KERNEL web-clip path (AD-16).
 *
 * `fetchUrlContent` is `readability` + `linkedom` + `htmlToMarkdown` — the same
 * door a bookmarklet clip goes through — so a research source and a clipped
 * source are the same bytes, and there is one extractor to keep working rather
 * than two. Firecrawl is deliberately NOT the fetch layer here.
 *
 * Returns `null` rather than throwing on any failure. One dead URL out of eight
 * must skip that URL and leave the run going: a research run that fails whole
 * because a single site 403'd a bot is a run the owner cannot get through, and
 * "zero usable sources" is already handled as its own failure by the caller.
 *
 * The 100 000-character bound inside `fetchUrlContent` still applies, and that
 * is deliberate — it is the kernel clip path's own limit, applied identically to
 * every Source in the wiki, not an app cap invented for research. What the spec
 * forbids is passing the 4 000-character SEARCH SNIPPET to synthesis as if it
 * were the document, and that is what this helper exists to avoid.
 */
export async function extractResearchSourceText(
  url: string,
): Promise<{ title: string; content: string } | null> {
  try {
    const { fetchUrlContent } = await import("./fetch");
    const fetched = await fetchUrlContent(url);
    const content = fetched.content.trim();
    return content ? { title: fetched.title, content } : null;
  } catch {
    return null;
  }
}

export async function searchResearchProvider(
  provider: ResearchProvider,
  query: string,
  limit = 8,
  settings: ResearchSettings = getResearchSettings(),
): Promise<ResearchSearchResult[]> {
  const cleaned = query.trim().slice(0, 1_000);
  if (!cleaned) throw new Error("Research query is required");
  const boundedLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  if (provider === "tavily") return tavilySearch(cleaned, boundedLimit, settings);
  if (provider === "serpapi") return serpApiSearch(cleaned, boundedLimit, settings);
  return searxngSearch(cleaned, boundedLimit, settings);
}
