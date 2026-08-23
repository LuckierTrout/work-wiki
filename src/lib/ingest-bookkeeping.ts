/**
 * Post-Generation bookkeeping for Workbench compile (Stories 2.4–2.12).
 *
 * `index.md` and `log.md` already ride {@link writeWikiPageWithSideEffects}.
 * This module regenerates `overview.md` and guarantees a Source summary Page.
 * Bookkeeping pages do not carry YAML `sources`. Summary metadata comes from
 * {@link extractSummary}, not from parsing LLM headings.
 */

import { isEnoent } from "./errors";
import { serializeFrontmatter } from "./frontmatter";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { loadPageTemplates } from "./schema";
import { slugify } from "./slugify";
import { parseSources, serializeSources, buildSourceEntry } from "./sources";
import { getStorage } from "./storage";
import {
  listWikiPages,
  readWikiPageWithFrontmatter,
} from "./wiki";
import type { SourceEntry } from "./types";

const BOOKKEEPING = new Set(["index", "log", "overview"]);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function regenerateOverview(owner: string): Promise<void> {
  const pages = await listWikiPages();
  const entries = pages.filter((entry) => !BOOKKEEPING.has(entry.slug));
  const lines = [
    "# Overview",
    "",
    `This wiki has ${entries.length} ${entries.length === 1 ? "page" : "pages"}.`,
    "",
  ];
  for (const entry of entries.sort((a, b) => a.title.localeCompare(b.title))) {
    const summary = entry.summary?.trim() || "";
    lines.push(`- [[${entry.slug}]]${summary ? ` — ${summary}` : ""}`);
  }
  const now = today();
  const content = serializeFrontmatter(
    {
      created: now,
      updated: now,
      owner,
      visibility: "public",
      authors: [owner],
    },
    lines.join("\n") + "\n",
  );
  const existing = await readWikiPageWithFrontmatter("overview");
  const created =
    typeof existing?.frontmatter.created === "string"
      ? existing.frontmatter.created
      : now;
  const withCreated = serializeFrontmatter(
    {
      created,
      updated: now,
      owner,
      visibility: "public",
      authors: [owner],
    },
    lines.join("\n") + "\n",
  );
  await writeWikiPageWithSideEffects({
    slug: "overview",
    title: "Overview",
    content: existing ? withCreated : content,
    summary: `This wiki has ${entries.length} ${entries.length === 1 ? "page" : "pages"}.`,
    logOp: "edit",
    crossRefSource: null,
    author: owner,
    logDetails: () => "regenerated overview.md",
  });
}

function bookkeepingMarkerPath(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("invalid bookkeeping digest");
  }
  return `ingest-bookkeeping/${digest}.json`;
}

export async function hasBookkeepingComplete(digest: string): Promise<boolean> {
  try {
    await getStorage().readFile(bookkeepingMarkerPath(digest));
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function markBookkeepingComplete(digest: string): Promise<void> {
  await getStorage().writeFile(
    bookkeepingMarkerPath(digest),
    JSON.stringify({ complete: true, at: new Date().toISOString() }),
  );
}

function renderSourceSummaryBody(input: {
  templates: string;
  title: string;
  summary: string;
  details: string;
  sourceTitle: string;
  sourcePath: string;
}): string {
  const keyPoints = input.templates.includes("## Key Points")
    ? "## Key Points"
    : "## Key Points";
  const details = input.templates.includes("## Details") ? "## Details" : "## Details";
  const sources = input.templates.includes("## Sources") ? "## Sources" : "## Sources";
  return [
    `# ${input.title}`,
    "",
    input.summary || "Source stored.",
    "",
    keyPoints,
    "",
    `- ${input.summary || "See the stored Source."}`,
    "",
    details,
    "",
    input.details || input.summary || "Source stored.",
    "",
    sources,
    "",
    `- [${input.sourceTitle}](../${input.sourcePath})`,
    "",
  ].join("\n");
}

export async function ensureSourceSummary(input: {
  owner: string;
  actor: string;
  sourceTitle: string;
  sourceText: string;
  sourcePath: string;
  sourceUrl?: string;
  sourceType: "url" | "text" | "x-mention" | "image" | "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "md" | "txt" | "html" | "zip" | "youtube" | "email" | "odt" | "ods" | "odp" | "epub" | "org" | "rtf" | "mobi";
  rawId?: string;
  origin?: SourceEntry["origin"];
}): Promise<string> {
  const templates = await loadPageTemplates();

  // Loaded after this module so ingest → bookkeeping is not a cycle.
  const { extractSummary } = await import("./ingest");
  const summary = extractSummary(input.sourceText, 400);
  const title = `${input.sourceTitle} — source summary`;
  const existing = await findExistingSourceSummary(input.sourcePath, input.rawId);
  const slug =
    existing?.slug ??
    (await freeSummarySlug(slugify(`src-summary ${input.sourceTitle}`) || "src-summary"));

  const now = today();
  const created =
    typeof existing?.frontmatter.created === "string"
      ? existing.frontmatter.created
      : now;
  const entry = buildSourceEntry(
    input.sourcePath,
    input.sourceType,
    input.actor,
    input.rawId,
    input.origin,
  );
  const body = renderSourceSummaryBody({
    templates,
    title,
    summary: summary || "Source stored.",
    details: input.sourceText.trim().slice(0, 1_200) || summary || "Source stored.",
    sourceTitle: input.sourceTitle,
    sourcePath: input.sourcePath,
  });

  const content = serializeFrontmatter(
    {
      type: "summary",
      created,
      updated: now,
      owner: input.owner,
      visibility: "public",
      authors: [input.actor],
      contributors: [],
      disputed: existing?.frontmatter.disputed === true,
      source_url: input.sourceUrl ?? input.sourcePath,
      source_path: input.sourcePath,
      sources: serializeSources([entry]),
      ...(input.origin ? { source_origin: input.origin } : {}),
    },
    body,
  );

  await writeWikiPageWithSideEffects({
    slug,
    title,
    content,
    summary: summary || "Source stored.",
    logOp: "ingest",
    crossRefSource: null,
    author: input.actor,
    logDetails: () => `source summary for ${input.sourcePath}`,
  });
  return slug;
}

async function findExistingSourceSummary(
  sourcePath: string,
  rawId?: string,
): Promise<{ slug: string; frontmatter: Record<string, unknown> } | null> {
  const pages = await listWikiPages();
  for (const entry of pages) {
    if (BOOKKEEPING.has(entry.slug)) continue;
    const page = await readWikiPageWithFrontmatter(entry.slug);
    if (!page || page.frontmatter.type !== "summary") continue;
    const sources = parseSources(
      typeof page.frontmatter.sources === "string" ||
        Array.isArray(page.frontmatter.sources)
        ? (page.frontmatter.sources as string | string[])
        : undefined,
    );
    const cites = sources.some(
      (item) =>
        item.url === sourcePath || (rawId ? item.raw_id === rawId : false),
    );
    if (cites) {
      return { slug: entry.slug, frontmatter: page.frontmatter };
    }
  }
  return null;
}

async function freeSummarySlug(base: string): Promise<string> {
  let candidate = base.slice(0, 80).replace(/^-+|-+$/g, "") || "src-summary";
  let n = 2;
  while (await readWikiPageWithFrontmatter(candidate)) {
    candidate = `${base.slice(0, 70)}-${n++}`;
  }
  return candidate;
}

export async function runIngestBookkeeping(input: {
  owner: string;
  actor: string;
  sourceTitle: string;
  sourceText: string;
  sourcePath: string;
  sourceUrl?: string;
  sourceType: Parameters<typeof ensureSourceSummary>[0]["sourceType"];
  rawId?: string;
  origin?: SourceEntry["origin"];
}): Promise<void> {
  const summarySlug = await ensureSourceSummary(input);
  if (!summarySlug) {
    throw new Error("Source summary was not written.");
  }
  await regenerateOverview(input.owner);
}
