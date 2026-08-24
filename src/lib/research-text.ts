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

/**
 * Drop markdown links whose href is not one of the fetched source URLs.
 *
 * The model is instructed to cite only those URLs; this is the fence when it
 * does not. The label stays so the sentence still reads; the invented URL
 * does not.
 */
export function restrictResearchCitations(
  markdown: string,
  allowedUrls: readonly string[],
): string {
  const allowed = new Set(
    allowedUrls.map(normalizeUrl).filter((url): url is string => url !== null),
  );
  return markdown.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/gi,
    (full, label: string, href: string) => {
      const normalized = normalizeUrl(href);
      return normalized && allowed.has(normalized) ? full : label;
    },
  );
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
