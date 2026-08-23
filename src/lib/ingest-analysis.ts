/**
 * Persisted Analysis JSON for two-step Ingest (Stories 2.4–2.12).
 *
 * Written through {@link getStorage} — not a wiki page and not a second
 * markdown writer. Generation reads this artifact; a Generation-only retry
 * reuses it instead of calling Analysis again.
 */

import { isEnoent } from "./errors";
import { getStorage } from "./storage";

export interface IngestReviewItemDraft {
  kind?: "warning" | "lightbulb";
  title: string;
  summary?: string;
  path?: string;
  queries?: string[];
  /** Extra model actions drop or map to Skip — never Accept/Reject/Revise. */
  action?: string;
}

export interface IngestAnalysis {
  entities: string[];
  concepts: string[];
  arguments: string[];
  existingLinks: string[];
  tensions: string[];
  recommendedStructure: string;
  /** Folder location such as `papers > energy` — classification context only. */
  classificationContext?: string;
  searchQueries?: string[];
  reviewItems?: IngestReviewItemDraft[];
}

function relPathFor(jobId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) {
    throw new Error(`invalid ingest job id: ${jobId}`);
  }
  return `ingest-analysis/${jobId}.json`;
}

export function emptyIngestAnalysis(
  classificationContext?: string,
): IngestAnalysis {
  return {
    entities: [],
    concepts: [],
    arguments: [],
    existingLinks: [],
    tensions: [],
    recommendedStructure: "",
    ...(classificationContext ? { classificationContext } : {}),
  };
}

export function parseIngestAnalysis(raw: unknown): IngestAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const reviewItems = Array.isArray(record.reviewItems)
    ? record.reviewItems.flatMap((item): IngestReviewItemDraft[] => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (typeof row.title !== "string" || !row.title.trim()) return [];
        return [
          {
            title: row.title,
            ...(row.kind === "warning" || row.kind === "lightbulb" ? { kind: row.kind } : {}),
            ...(typeof row.summary === "string" ? { summary: row.summary } : {}),
            ...(typeof row.path === "string" ? { path: row.path } : {}),
            ...(Array.isArray(row.queries)
              ? { queries: row.queries.filter((query): query is string => typeof query === "string") }
              : {}),
            ...(typeof row.action === "string" ? { action: row.action } : {}),
          },
        ];
      })
    : [];
  const searchQueries = strings(record.searchQueries);
  return {
    entities: strings(record.entities),
    concepts: strings(record.concepts),
    arguments: strings(record.arguments),
    existingLinks: strings(record.existingLinks),
    tensions: strings(record.tensions),
    recommendedStructure:
      typeof record.recommendedStructure === "string"
        ? record.recommendedStructure
        : "",
    ...(typeof record.classificationContext === "string" &&
    record.classificationContext.trim()
      ? { classificationContext: record.classificationContext }
      : {}),
    ...(searchQueries.length > 0 ? { searchQueries } : {}),
    ...(reviewItems.length > 0 ? { reviewItems } : {}),
  };
}

export async function saveIngestAnalysis(
  jobId: string,
  analysis: IngestAnalysis,
): Promise<void> {
  await getStorage().writeFile(relPathFor(jobId), JSON.stringify(analysis));
}

export async function loadIngestAnalysis(
  jobId: string,
): Promise<IngestAnalysis | null> {
  try {
    const raw = await getStorage().readFile(relPathFor(jobId));
    try {
      return parseIngestAnalysis(JSON.parse(raw));
    } catch {
      return null;
    }
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function hasIngestAnalysis(jobId: string): Promise<boolean> {
  return (await loadIngestAnalysis(jobId)) !== null;
}
