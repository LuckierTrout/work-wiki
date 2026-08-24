/** Markdown-aware link rewrites used by mechanical Lint fixes. */

import { isExternalLinkTarget, normalizeWikilinkTarget } from "./links";

type WikiReplacement = (parts: {
  rawTarget: string;
  fragment: string;
  label: string | undefined;
}) => string;

type MarkdownReplacement = (parts: {
  label: string;
  destination: string;
  fragment: string;
}) => string;

function mapInlineProse(text: string, rewrite: (prose: string) => string): string {
  const runs = [...text.matchAll(/`+/g)];
  let cursor = 0;
  let output = "";
  for (let index = 0; index < runs.length; index += 1) {
    const opener = runs[index];
    const openerAt = opener.index ?? 0;
    const width = opener[0].length;
    let closeIndex = -1;
    for (let candidate = index + 1; candidate < runs.length; candidate += 1) {
      if (runs[candidate][0].length === width) {
        closeIndex = candidate;
        break;
      }
    }
    if (closeIndex < 0) continue;
    const closer = runs[closeIndex];
    const closerAt = closer.index ?? openerAt;
    output += rewrite(text.slice(cursor, openerAt));
    output += text.slice(openerAt, closerAt + width);
    cursor = closerAt + width;
    index = closeIndex;
  }
  return output + rewrite(text.slice(cursor));
}

function nextLine(text: string, start: number): { body: string; end: number } {
  const newline = text.indexOf("\n", start);
  const end = newline < 0 ? text.length : newline + 1;
  const raw = text.slice(start, newline < 0 ? text.length : newline);
  return { body: raw.endsWith("\r") ? raw.slice(0, -1) : raw, end };
}

/**
 * Rewrite prose while preserving YAML frontmatter, fenced/indented code blocks,
 * and arbitrary-width inline code spans. No sentinels are inserted into input.
 */
export function mapMarkdownProse(
  content: string,
  rewrite: (prose: string) => string,
): string {
  const frontmatter = content.match(
    /^\uFEFF?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m,
  );
  const head = frontmatter?.[0] ?? "";
  const text = head ? content.slice(head.length) : content;
  let output = head;
  let cursor = 0;
  let proseStart = 0;

  const flushProse = (end: number) => {
    if (end > proseStart) output += mapInlineProse(text.slice(proseStart, end), rewrite);
  };

  while (cursor < text.length) {
    const line = nextLine(text, cursor);
    const fence = line.body.match(/^ {0,3}(`{3,}|~{3,})(?:[^\r\n]*)$/);
    const indented = /^(?: {4}|\t)/.test(line.body);
    if (!fence && !indented) {
      cursor = line.end;
      continue;
    }

    flushProse(cursor);
    const protectedStart = cursor;
    if (fence) {
      const marker = fence[1][0];
      const width = fence[1].length;
      cursor = line.end;
      while (cursor < text.length) {
        const candidate = nextLine(text, cursor);
        cursor = candidate.end;
        const close = candidate.body.match(/^ {0,3}(`+|~+)[ \t]*$/);
        if (close && close[1][0] === marker && close[1].length >= width) break;
      }
    } else {
      cursor = line.end;
      while (cursor < text.length) {
        const candidate = nextLine(text, cursor);
        if (candidate.body.trim() && !/^(?: {4}|\t)/.test(candidate.body)) break;
        cursor = candidate.end;
      }
    }
    output += text.slice(protectedStart, cursor);
    proseStart = cursor;
  }

  flushProse(text.length);
  return output;
}

const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

export function rewriteWikilinksByTarget(
  content: string,
  targetSlug: string,
  replacement: WikiReplacement,
): string {
  return mapMarkdownProse(content, (prose) =>
    prose.replace(WIKILINK, (whole, rawTarget: string, fragment = "", label?: string) => {
      if (normalizeWikilinkTarget(rawTarget) !== targetSlug) return whole;
      return replacement({ rawTarget, fragment, label });
    }),
  );
}

export function hasWikilinkTarget(content: string, targetSlug: string): boolean {
  let found = false;
  rewriteWikilinksByTarget(content, targetSlug, (parts) => {
    found = true;
    return `[[${parts.rawTarget}${parts.fragment}${parts.label ? `|${parts.label}` : ""}]]`;
  });
  return found;
}

export function rewriteMarkdownLinksByTarget(
  content: string,
  targetSlug: string,
  replacement: MarkdownReplacement,
): string {
  return mapMarkdownProse(content, (prose) =>
    prose.replace(MARKDOWN_LINK, (whole, label: string, destination: string) => {
      const hash = destination.indexOf("#");
      const path = hash < 0 ? destination : destination.slice(0, hash);
      const fragment = hash < 0 ? "" : destination.slice(hash);
      if (isExternalLinkTarget(path)) return whole;
      if (!/\.md$/i.test(path)) return whole;
      if (normalizeWikilinkTarget(path) !== targetSlug) return whole;
      return replacement({ label, destination, fragment });
    }),
  );
}

export function hasMarkdownLinkTarget(content: string, targetSlug: string): boolean {
  let found = false;
  rewriteMarkdownLinksByTarget(content, targetSlug, ({ label, destination }) => {
    found = true;
    return `[${label}](${destination})`;
  });
  return found;
}
