/**
 * Research synthesis text: thinking tags and citation fences.
 *
 * Split out of the run loop so the orchestrator does not also own the two
 * string contracts the panel and the published Page depend on.
 */
import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * Split a model's `<thinking>` block(s) off its answer.
 *
 * Every matched pair is thinking. An unmatched opener takes the rest of the
 * text as thinking so a truncated stream cannot publish private reasoning.
 * Stray closers are dropped. No block means no thinking.
 */
export function extractThinking(text: string): { thinking: string; content: string } {
  const blocks: string[] = [];
  let content = text.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_, body: string) => {
    const trimmed = body.trim();
    if (trimmed) blocks.push(trimmed);
    return "";
  });
  content = content.replace(/<thinking>([\s\S]*)$/i, (_, body: string) => {
    const trimmed = String(body).trim();
    if (trimmed) blocks.push(trimmed);
    return "";
  });
  content = content.replace(/<\/thinking>/gi, "").trim();
  return { thinking: blocks.join("\n\n"), content };
}

function normalizeUrl(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function isAllowed(href: string, allowed: Set<string>): boolean {
  const normalized = normalizeUrl(href);
  return normalized !== null && allowed.has(normalized);
}

/**
 * Drop every URL-bearing citation whose href is not one of the fetched sources.
 *
 * The model is instructed to cite only those URLs; this is the fence when it
 * does not. Inline links, images, autolinks, reference-style links, HTML
 * anchors, and bare URLs are all checked. Labels stay so the sentence still
 * reads; the invented URL does not.
 */
export function restrictResearchCitations(
  markdown: string,
  allowedUrls: readonly string[],
): string {
  const allowed = new Set(
    allowedUrls.map(normalizeUrl).filter((url): url is string => url !== null),
  );
  type MdNode = {
    type: string;
    value?: string;
    url?: string;
    identifier?: string;
    alt?: string;
    children?: MdNode[];
    position?: { start?: { offset?: number }; end?: { offset?: number } };
  };
  type Edit = { start: number; end: number; replacement: string };
  const root = fromMarkdown(markdown) as unknown as MdNode;
  const edits: Edit[] = [];
  const droppedDefinitions = new Set<string>();

  const htmlAnchors = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = htmlAnchors.exec(markdown))) {
    if (isAllowed(htmlMatch[1], allowed)) continue;
    edits.push({
      start: htmlMatch.index,
      end: htmlMatch.index + htmlMatch[0].length,
      replacement: htmlMatch[2].replace(/<[^>]+>/g, ""),
    });
  }

  const offsets = (node: MdNode): { start: number; end: number } | null => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    return typeof start === "number" && typeof end === "number" ? { start, end } : null;
  };
  const label = (node: MdNode): string => {
    if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    return (node.children ?? []).map(label).join("");
  };
  const addEdit = (node: MdNode, replacement: string): void => {
    const span = offsets(node);
    if (span) edits.push({ ...span, replacement });
  };

  const collectDefinitions = (node: MdNode): void => {
    if (node.type === "definition" && node.url && !isAllowed(node.url, allowed)) {
      droppedDefinitions.add((node.identifier ?? "").toLowerCase());
      addEdit(node, "");
    }
    for (const child of node.children ?? []) collectDefinitions(child);
  };
  collectDefinitions(root);

  const splitTrailingPunctuation = (candidate: string): [string, string] => {
    let href = candidate;
    let suffix = "";
    while (/[.,;:!?]$/.test(href)) {
      suffix = href.slice(-1) + suffix;
      href = href.slice(0, -1);
    }
    while (href.endsWith(")") && (href.match(/\(/g)?.length ?? 0) < (href.match(/\)/g)?.length ?? 0)) {
      suffix = ")" + suffix;
      href = href.slice(0, -1);
    }
    return [href, suffix];
  };

  const visit = (node: MdNode, insideLink = false): void => {
    if ((node.type === "link" || node.type === "image") && node.url) {
      if (!isAllowed(node.url, allowed)) {
        const span = offsets(node);
        const autolink = node.type === "link" && span
          ? markdown.slice(span.start, span.end).startsWith("<")
          : false;
        addEdit(node, autolink ? "" : label(node));
      }
      return;
    }
    if (node.type === "linkReference" || node.type === "imageReference") {
      if (droppedDefinitions.has((node.identifier ?? "").toLowerCase())) addEdit(node, label(node));
      return;
    }
    if (node.type === "html") return;
    if (node.type === "text" && node.value && !insideLink) {
      const span = offsets(node);
      if (span) {
        const bare = /https?:\/\/[^\s<>"']+/gi;
        let match: RegExpExecArray | null;
        while ((match = bare.exec(node.value))) {
          const [href, suffix] = splitTrailingPunctuation(match[0]);
          if (isAllowed(href, allowed)) continue;
          const start = span.start + match.index;
          edits.push({ start, end: start + match[0].length, replacement: suffix });
        }
      }
    }
    for (const child of node.children ?? []) visit(child, insideLink || node.type === "link");
  };
  visit(root);

  const ordered = edits
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .filter((edit, index, all) => !all.slice(0, index).some(
      (applied) => edit.start >= applied.start && edit.end <= applied.end,
    ));
  let next = markdown;
  for (const edit of ordered) {
    next = `${next.slice(0, edit.start)}${edit.replacement}${next.slice(edit.end)}`;
  }
  // Replacement labels are data too. A model can put a second invented URL in
  // the visible label/alt text, which structural removal would otherwise
  // reintroduce after the mdast walk. A final whole-output pass also catches
  // permissive raw HTML such as `href = "…"` and image `src` attributes.
  next = next.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
    const [href, suffix] = splitTrailingPunctuation(candidate);
    return isAllowed(href, allowed) ? candidate : suffix;
  });
  return next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Newest `limit` thinking lines, in order, each trimmed and bounded. */
export function appendThinkingLines(
  existing: readonly string[] | undefined,
  next: string,
  limit = 200,
): string[] {
  const extra = next
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " ").slice(0, 500))
    .filter((line) => line.length > 0);
  return [...(existing ?? []), ...extra].slice(-limit);
}
