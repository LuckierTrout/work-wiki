import { tokenize } from "./bm25";
import { readRawSource, readRawSourceById } from "./raw";
import { parseSources } from "./sources";
import type { IndexEntry, SourceEntry } from "./types";
import { wrapUntrusted } from "./untrusted";
import { readWikiPageWithFrontmatter } from "./wiki";

const MAX_CANDIDATE_PAGES = 12;
const MAX_SOURCE_CHUNKS = 12;
const MAX_CHUNK_CHARS = 3_800;
const CHUNK_OVERLAP_SEGMENTS = 2;
const MAX_CONTEXT_CHARS = 52_000;

interface SourceSegment {
  text: string;
  line: number;
}

export interface RawSourceChunk {
  key: string;
  pageSlug: string;
  pageTitle: string;
  sourceType: SourceEntry["type"] | "legacy";
  sourceUrl: string;
  rawId?: string;
  label: string;
  startLine: number;
  endLine: number;
  content: string;
  citationHref: string;
  citation: string;
  score: number;
}

export interface RawSourceContext {
  context: string;
  chunks: RawSourceChunk[];
  pageSlugs: string[];
}

function sourceHref(slug: string, rawId?: string): string {
  const base = `/api/raw/${encodeURIComponent(slug)}`;
  return rawId ? `${base}?source=${encodeURIComponent(rawId)}` : base;
}

function splitLongLine(line: string, lineNumber: number): SourceSegment[] {
  if (line.length <= MAX_CHUNK_CHARS) return [{ text: line, line: lineNumber }];
  const segments: SourceSegment[] = [];
  for (let offset = 0; offset < line.length; offset += MAX_CHUNK_CHARS) {
    segments.push({
      text: line.slice(offset, offset + MAX_CHUNK_CHARS),
      line: lineNumber,
    });
  }
  return segments;
}

function chunkText(content: string): Array<{
  content: string;
  startLine: number;
  endLine: number;
}> {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return [];
  const segments = normalized
    .split("\n")
    .flatMap((line, index) => splitLongLine(line, index + 1));
  const chunks: Array<{ content: string; startLine: number; endLine: number }> = [];

  let start = 0;
  while (start < segments.length) {
    let end = start;
    let length = 0;
    while (end < segments.length) {
      const addition = segments[end].text.length + (end > start ? 1 : 0);
      if (end > start && length + addition > MAX_CHUNK_CHARS) break;
      length += addition;
      end += 1;
      if (length >= MAX_CHUNK_CHARS) break;
    }
    const selectedWithPadding = segments.slice(start, end);
    const firstContent = selectedWithPadding.findIndex(
      (segment) => segment.text.trim().length > 0,
    );
    let lastContent = selectedWithPadding.length - 1;
    while (
      lastContent >= firstContent &&
      selectedWithPadding[lastContent].text.trim().length === 0
    ) {
      lastContent -= 1;
    }
    const selected = firstContent >= 0
      ? selectedWithPadding.slice(firstContent, lastContent + 1)
      : [];
    const excerpt = selected.map((segment) => segment.text).join("\n");
    if (excerpt) {
      chunks.push({
        content: excerpt,
        startLine: selected[0].line,
        endLine: selected[selected.length - 1].line,
      });
    }
    if (end >= segments.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_SEGMENTS);
  }
  return chunks;
}

function scoreChunk(
  content: string,
  questionTokens: ReadonlySet<string>,
  pageTitle: string,
  sourceUrl: string,
): number {
  if (questionTokens.size === 0) return 0;
  const contentTokens = tokenize(content);
  const counts = new Map<string, number>();
  for (const token of contentTokens) {
    if (questionTokens.has(token)) {
      counts.set(token, Math.min(8, (counts.get(token) ?? 0) + 1));
    }
  }
  const bodyScore = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const metadataTokens = new Set(tokenize(`${pageTitle} ${sourceUrl}`));
  const metadataScore = [...questionTokens].filter((token) => metadataTokens.has(token)).length * 4;
  return bodyScore + metadataScore;
}

function makeChunks(
  entry: IndexEntry,
  source: SourceEntry | null,
  content: string,
  questionTokens: ReadonlySet<string>,
): RawSourceChunk[] {
  const rawId = source?.raw_id;
  // Slugs are path-validated and therefore safe to place in the trusted
  // citation instruction. Titles and URLs stay inside the untrusted block.
  const label = `original source for ${entry.slug}`;
  const href = sourceHref(entry.slug, rawId);
  return chunkText(content).map((chunk, index) => {
    const lineLabel = chunk.startLine === chunk.endLine
      ? `line ${chunk.startLine}`
      : `lines ${chunk.startLine}-${chunk.endLine}`;
    const citation = `[${label}, ${lineLabel}](${href})`;
    return {
      key: `${entry.slug}:${rawId ?? "legacy"}:${index}`,
      pageSlug: entry.slug,
      pageTitle: entry.title,
      sourceType: source?.type ?? "legacy",
      sourceUrl: source?.url ?? "legacy-raw-snapshot",
      ...(rawId ? { rawId } : {}),
      label,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      citationHref: href,
      citation,
      score: scoreChunk(chunk.content, questionTokens, entry.title, source?.url ?? ""),
    };
  });
}

async function loadEntryChunks(
  entry: IndexEntry,
  questionTokens: ReadonlySet<string>,
): Promise<RawSourceChunk[]> {
  const page = await readWikiPageWithFrontmatter(entry.slug);
  if (!page) return [];
  const sources = parseSources(
    page.frontmatter.sources as string | string[] | undefined,
  );
  const chunks: RawSourceChunk[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source.raw_id || seen.has(source.raw_id)) continue;
    seen.add(source.raw_id);
    try {
      const raw = await readRawSourceById(entry.slug, source.raw_id);
      chunks.push(...makeChunks(entry, source, raw.content, questionTokens));
    } catch {
      // One unavailable snapshot must not hide other captured sources.
    }
  }

  if (chunks.length > 0) return chunks;
  try {
    const legacy = await readRawSource(entry.slug);
    return makeChunks(entry, sources.at(-1) ?? null, legacy.content, questionTokens);
  } catch {
    return [];
  }
}

function rankWithSourceDiversity(chunks: RawSourceChunk[]): RawSourceChunk[] {
  const ranked = chunks.slice().sort((a, b) =>
    b.score - a.score || a.key.localeCompare(b.key),
  );
  const selected: RawSourceChunk[] = [];
  const seenSources = new Set<string>();

  for (const chunk of ranked) {
    const sourceKey = `${chunk.pageSlug}:${chunk.rawId ?? "legacy"}`;
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    selected.push(chunk);
    if (selected.length >= MAX_SOURCE_CHUNKS) return selected;
  }
  for (const chunk of ranked) {
    if (selected.some((item) => item.key === chunk.key)) continue;
    selected.push(chunk);
    if (selected.length >= MAX_SOURCE_CHUNKS) break;
  }
  return selected;
}

/**
 * Build bounded chat context from original snapshots attached to already
 * authorized wiki entries. The generated page text is never added to context.
 */
export async function buildRawSourceContext(
  selectedSlugs: readonly string[],
  entries: readonly IndexEntry[],
  question: string,
): Promise<RawSourceContext> {
  const entryBySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const candidates = selectedSlugs
    .slice(0, MAX_CANDIDATE_PAGES)
    .map((slug) => entryBySlug.get(slug))
    .filter((entry): entry is IndexEntry => Boolean(entry));
  const questionTokens = new Set(tokenize(question));
  const loaded = (await Promise.all(
    candidates.map((entry) => loadEntryChunks(entry, questionTokens)),
  )).flat();
  const chunks = rankWithSourceDiversity(loaded);
  const contextParts: string[] = [];
  const included: RawSourceChunk[] = [];
  let contextLength = 0;

  for (const chunk of chunks) {
    const header = [
      "ORIGINAL SOURCE EXCERPT",
      `Page used to locate this source: ${chunk.pageSlug}`,
      `Source type: ${chunk.sourceType}`,
      `Required citation: ${chunk.citation}`,
    ].join("\n");
    const untrustedSource = [
      `Source title metadata: ${chunk.pageTitle}`,
      `Source location metadata: ${chunk.sourceUrl}`,
      "",
      chunk.content,
    ].join("\n");
    const part = `${header}\n${wrapUntrusted(untrustedSource, {
      slug: chunk.pageSlug,
      source: `${chunk.sourceType}:${chunk.sourceUrl}`,
    })}`;
    if (included.length > 0 && contextLength + part.length > MAX_CONTEXT_CHARS) break;
    contextParts.push(part);
    included.push(chunk);
    contextLength += part.length;
  }

  return {
    context: contextParts.join("\n\n"),
    chunks: included,
    pageSlugs: [...new Set(included.map((chunk) => chunk.pageSlug))],
  };
}

export function extractRawCitedPageSlugs(
  answer: string,
  chunks: readonly RawSourceChunk[],
): string[] {
  return [...new Set(
    chunks
      .filter((chunk) => answer.includes(chunk.citationHref))
      .map((chunk) => chunk.pageSlug),
  )];
}
