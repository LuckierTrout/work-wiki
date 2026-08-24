/**
 * Research synthesis text: thinking tags and citation fences.
 *
 * Split out of the run loop so the orchestrator does not also own the two
 * string contracts the panel and the published Page depend on.
 */

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
  const droppedRefs = new Set<string>();
  let next = markdown.replace(
    /^[ \t]*\[([^\]]+)\]:[ \t]*<?(https?:[^\s>]+)>?[ \t]*.*$/gim,
    (full, id: string, href: string) => {
      if (isAllowed(href, allowed)) return full;
      droppedRefs.add(id.toLowerCase());
      return "";
    },
  );
  next = next.replace(
    /!\[([^\]]*)\]\((https?:[^)\s]+)\)/gi,
    (full, alt: string, href: string) => (isAllowed(href, allowed) ? full : alt),
  );
  next = next.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/gi,
    (full, label: string, href: string) => (isAllowed(href, allowed) ? full : label),
  );
  next = next.replace(
    /<(https?:[^>\s]+)>/gi,
    (full, href: string) => (isAllowed(href, allowed) ? full : ""),
  );
  next = next.replace(
    /<a\s+[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (full, href: string, label: string) => (isAllowed(href, allowed) ? full : label),
  );
  next = next.replace(
    /\[([^\]]+)\]\[([^\]]+)\]/g,
    (full, text: string, id: string) => (droppedRefs.has(id.toLowerCase()) ? text : full),
  );
  next = next.replace(
    /(?<!\]\()(?<!<)(https?:\/\/[^\s<>)"']+)/gi,
    (href: string) => (isAllowed(href, allowed) ? href : ""),
  );
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
