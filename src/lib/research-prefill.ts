/**
 * Deep Research confirm prefills: current Wiki Purpose/profile, overview.md,
 * and Insight pages.
 */

import { readWikiPage } from "./wiki";
import { getWikiRegistry, readEffectiveWikiArtifact } from "./wikis";
import { mapWithConcurrency } from "./concurrency";

export interface ResearchPrefill {
  topic: string;
  queries: string[];
}

export interface ResearchPrefillContext {
  purposeQueries: string[];
  overviewQuery: string | null;
  pages?: ReadonlyMap<string, { title: string; query: string | null }>;
}

export const RESEARCH_PREFILL_LIMIT = 12;
export const RESEARCH_PREFILL_PAGE_LIMIT = 48;
const RESEARCH_PREFILL_READ_CONCURRENCY = 8;
const RESEARCH_QUERY_LIMIT = 8;

/**
 * Allocate the request Page-read budget across Insights one slug at a time.
 * Global deduplication prevents overlaps from spending the budget twice, and
 * round-robin selection prevents a large sparse community from starving later
 * isolated or bridge Insights.
 */
export function allocateResearchPrefillSlugs(
  insightSlugs: readonly (readonly string[])[],
  limit = RESEARCH_PREFILL_PAGE_LIMIT,
): string[] {
  const groups = insightSlugs.map((slugs) =>
    [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))],
  );
  const cursors = groups.map(() => 0);
  const selected: string[] = [];
  const seen = new Set<string>();
  while (selected.length < limit) {
    let progressed = false;
    for (let index = 0; index < groups.length && selected.length < limit; index += 1) {
      const group = groups[index]!;
      while (cursors[index]! < group.length && seen.has(group[cursors[index]!]!)) {
        cursors[index]! += 1;
      }
      const slug = group[cursors[index]!];
      if (!slug) continue;
      cursors[index]! += 1;
      seen.add(slug);
      selected.push(slug);
      progressed = true;
    }
    if (!progressed) break;
  }
  return selected;
}

function firstSentence(body: string): string | null {
  const stripped = body.replace(/^#\s+.+$/m, "").replace(/^---[\s\S]*?---/, "").trim();
  const line = stripped.split(/\n+/).map((row) => row.trim()).find((row) => row.length > 20);
  if (!line) return null;
  return line.replace(/^[-*]\s+/, "").slice(0, 200);
}

export async function loadResearchPrefillContext(
  owner: string | undefined,
): Promise<ResearchPrefillContext> {
  const overviewPromise = readWikiPage("overview").catch(() => null);
  const purposeQueries: string[] = [];
  if (owner?.trim()) {
    const registry = await getWikiRegistry(owner).catch(() => null);
    const wikiId = registry?.currentId;
    if (wikiId) {
      const artifactResult = await Promise.resolve(
        readEffectiveWikiArtifact(owner, wikiId, "purpose.md"),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (artifactResult.status === "fulfilled" && artifactResult.value) {
        const sentence = firstSentence(artifactResult.value);
        if (sentence) purposeQueries.push(sentence);
      }
    }
  }
  const overview = await overviewPromise;
  return {
    purposeQueries,
    overviewQuery: overview ? firstSentence(overview.content) : null,
  };
}

/** One request-local, deduplicated and bounded Page-read budget for prefills. */
export async function loadResearchPrefillPages(
  slugs: readonly string[],
): Promise<ReadonlyMap<string, { title: string; query: string | null }>> {
  const selected = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))]
    .slice(0, RESEARCH_PREFILL_PAGE_LIMIT);
  const rows = await mapWithConcurrency(
    selected,
    RESEARCH_PREFILL_READ_CONCURRENCY,
    async (slug) => {
      const page = await readWikiPage(slug).catch(() => null);
      return page
        ? [slug, { title: page.title, query: firstSentence(page.content) }] as const
        : [slug, null] as const;
    },
  );
  return new Map(
    rows.filter((row): row is readonly [string, { title: string; query: string | null }] =>
      row[1] !== null),
  );
}

export async function buildResearchPrefill(
  slugs: readonly string[],
  fallbackTopic: string,
  owner?: string,
  context?: ResearchPrefillContext,
): Promise<ResearchPrefill> {
  const queries: string[] = [];
  const seen = new Set<string>();
  let topic = fallbackTopic.trim();

  const push = (text: string | null | undefined) => {
    const sentence = text?.trim();
    if (!sentence) return;
    const key = sentence.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(sentence);
  };

  const shared = context ?? await loadResearchPrefillContext(owner);
  const pages = shared.pages ?? await loadResearchPrefillPages(slugs);

  // Reserve one slot for every available source category before filling the
  // remainder. Purpose cannot crowd out Overview or the Insight page itself.
  push(shared.purposeQueries[0]);
  push(shared.overviewQuery);
  for (const slug of slugs) {
    if (queries.length >= RESEARCH_QUERY_LIMIT) break;
    const page = pages.get(slug);
    if (!page) continue;
    if (!topic && page.title) topic = page.title;
    push(page.query);
  }
  for (const line of shared.purposeQueries.slice(1)) {
    if (queries.length >= RESEARCH_QUERY_LIMIT) break;
    push(line);
  }

  if (queries.length === 0 && topic) {
    queries.push(`What should I know about ${topic}?`);
  }

  return {
    topic: topic || "Deep Research",
    queries,
  };
}
