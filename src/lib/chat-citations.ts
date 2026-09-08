import type { ChatCitation } from "./chat-contract";
import { CHAT_COVERAGE_MISSING_COPY } from "./workbench-modes";

const MARKER_RE = /\[([1-9]\d*)\]/g;

function citationKey(row: ChatCitation): number | null {
  if (!row || typeof row !== "object") return null;
  if (!Number.isInteger(row.n) || row.n < 1) return null;
  if (typeof row.path !== "string" || !row.path.trim()) return null;
  if (typeof row.title !== "string" || typeof row.type !== "string") return null;
  return row.n;
}

/**
 * Persist and render only citations the answer actually cited.
 * Invented `[n]` markers are stripped. Unused assembled rows are dropped.
 * A positive answer with no valid mapped marker becomes the coverage sentence.
 */
export function sanitizeCitedAnswer(
  content: string,
  citations: readonly ChatCitation[] | undefined,
  coverageCopy: string = CHAT_COVERAGE_MISSING_COPY,
): { content: string; citations: ChatCitation[]; coverage: boolean } {
  const byN = new Map<number, ChatCitation>();
  for (const row of citations ?? []) {
    const n = citationKey(row);
    if (n === null || byN.has(n)) continue;
    byN.set(n, {
      n,
      path: row.path.trim(),
      title: row.title,
      type: row.type,
    });
  }

  const used = new Set<number>();
  const invented = new Set<number>();
  const text = typeof content === "string" ? content : "";
  for (const match of text.matchAll(MARKER_RE)) {
    const n = Number(match[1]);
    if (byN.has(n)) used.add(n);
    else invented.add(n);
  }

  let next = text;
  for (const n of invented) {
    next = next.replaceAll(`[${n}]`, "");
  }
  next = next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (used.size === 0) {
    return {
      content: coverageCopy,
      citations: [],
      coverage: false,
    };
  }

  const kept = [...used]
    .sort((a, b) => a - b)
    .map((n) => byN.get(n))
    .filter((row): row is ChatCitation => Boolean(row));

  return { content: next, citations: kept, coverage: true };
}

export function isCoverageSentence(
  content: string,
  coverageCopy: string = CHAT_COVERAGE_MISSING_COPY,
): boolean {
  return content.trim() === coverageCopy;
}

export function citationPathAllowed(path: string): boolean {
  return (
    path.startsWith("wiki/") ||
    path.startsWith("raw/sources/")
  );
}
