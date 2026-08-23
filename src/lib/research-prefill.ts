/**
 * Deep Research confirm prefills: overview.md, purpose.md, and Insight pages.
 */

import { readWikiPage } from "./wiki";

export interface ResearchPrefill {
  topic: string;
  queries: string[];
}

function firstSentence(body: string): string | null {
  const stripped = body.replace(/^#\s+.+$/m, "").replace(/^---[\s\S]*?---/, "").trim();
  const line = stripped.split(/\n+/).map((row) => row.trim()).find((row) => row.length > 20);
  if (!line) return null;
  return line.replace(/^[-*]\s+/, "").slice(0, 200);
}

export async function buildResearchPrefill(
  slugs: readonly string[],
  fallbackTopic: string,
): Promise<ResearchPrefill> {
  const queries: string[] = [];
  const seen = new Set<string>();
  let topic = fallbackTopic.trim();

  const extras = ["overview", "purpose", ...slugs];
  for (const slug of extras) {
    const page = await readWikiPage(slug).catch(() => null);
    if (!page) continue;
    if (!topic && page.title) topic = page.title;
    const sentence = firstSentence(page.content);
    if (!sentence) continue;
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(sentence);
    if (queries.length >= 8) break;
  }

  if (queries.length === 0 && topic) {
    queries.push(`What should I know about ${topic}?`);
  }

  return {
    topic: topic || "Deep Research",
    queries,
  };
}
