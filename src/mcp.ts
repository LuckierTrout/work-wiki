#!/usr/bin/env node
/**
 * yopedia MCP server — exposes wiki tools over stdio transport.
 *
 * Tools:
 *   search_wiki    — Search wiki pages by query string
 *   read_page      — Read a single wiki page by slug
 *   list_pages     — List all wiki pages with optional sort/limit
 *   create_page    — Create a new wiki page
 *   update_page    — Update an existing wiki page
 *   delete_page    — Delete a wiki page by slug
 *   ingest_url     — Ingest a URL into the wiki (fetch → chunk → summarize → write)
 *   query_wiki     — Ask the wiki a question with LLM synthesis
 *   agent_context  — Get an agent's full context by agent ID
 *   seed_agent     — Register an agent and create its wiki pages
 *   lint_wiki      — Run quality checks on the wiki
 *   fix_lint_issue — Auto-fix a lint issue found by lint_wiki
 *   list_discussions   — List discussion threads for a wiki page
 *   create_discussion  — Start a new discussion thread
 *   add_comment        — Add a comment to a discussion thread
 *   resolve_discussion — Resolve a discussion thread
 *   reingest           — Re-ingest a wiki page from its original source URL
 *
 * Usage:
 *   pnpm mcp          # starts the stdio server
 *   echo '{}' | pnpm mcp   # smoke test (exits cleanly)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  searchWikiContent,
  readWikiPage,
  readWikiPageWithFrontmatter,
  listWikiPages,
  validateSlug,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
  deleteWikiPage,
  type Frontmatter,
} from "./lib/wiki";
import { extractSummary, ingestUrl, reingest } from "./lib/ingest";
import { query, type QueryFormat } from "./lib/query";
import { isUrl } from "./lib/fetch";
import { getAgent, seedAgent } from "./lib/agents";
import type { SeedAgentSection } from "./lib/agents";
import type { AgentProfile, IngestResult, QueryResult, LintResult, LintIssue } from "./lib/types";
import type { DeletePageResult } from "./lib/lifecycle";
import { resolveScope, type ContentSearchResult } from "./lib/search";
import { lint, ALL_CHECK_TYPES } from "./lib/lint";
import { fixLintIssue, type FixResult } from "./lib/lint-fix";
import { listThreads, createThread, resolveThread, addComment } from "./lib/talk";
import type { TalkThread, TalkComment } from "./lib/types";

// ---------------------------------------------------------------------------
// Tool handler logic — exported for direct testing without transport
// ---------------------------------------------------------------------------

export async function handleSearchWiki(args: {
  query: string;
  limit?: number | undefined;
  scope?: string | undefined;
}): Promise<{ slug: string; title: string; snippet: string; score: number }[]> {
  const limit = args.limit ?? 10;
  const scope = args.scope ? await resolveScope(args.scope) : undefined;
  const results: ContentSearchResult[] = await searchWikiContent(
    args.query,
    limit,
    scope ?? undefined,
  );
  return results.map((r) => ({
    slug: r.slug,
    title: r.title,
    snippet: r.snippet,
    score: r.score,
  }));
}

export async function handleReadPage(args: {
  slug: string;
}): Promise<{
  slug: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
}> {
  const page = await readWikiPageWithFrontmatter(args.slug);
  if (!page) {
    throw new Error(`Page not found: ${args.slug}`);
  }
  return {
    slug: page.slug,
    title: page.title,
    content: page.body,
    frontmatter: page.frontmatter as Record<string, unknown>,
  };
}

export async function handleListPages(args: {
  sort?: "title" | "updated" | "confidence" | undefined;
  limit?: number | undefined;
}): Promise<
  {
    slug: string;
    title: string;
    tags?: string[];
    confidence?: number;
    updated?: string;
  }[]
> {
  const entries = await listWikiPages();

  // Sort
  const sorted = [...entries];
  const sortBy = args.sort ?? "title";
  if (sortBy === "updated") {
    sorted.sort((a, b) => {
      const aDate = a.updated ?? "";
      const bDate = b.updated ?? "";
      return bDate.localeCompare(aDate); // newest first
    });
  } else if (sortBy === "confidence") {
    sorted.sort((a, b) => {
      const aC = a.confidence ?? 0;
      const bC = b.confidence ?? 0;
      return bC - aC; // highest first
    });
  } else {
    // "title" (default)
    sorted.sort((a, b) => a.title.localeCompare(b.title));
  }

  // Limit
  const limit = args.limit ?? sorted.length;
  const limited = sorted.slice(0, limit);

  return limited.map((e) => ({
    slug: e.slug,
    title: e.title,
    ...(e.tags && e.tags.length > 0 ? { tags: e.tags } : {}),
    ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
    ...(e.updated ? { updated: e.updated } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Write tool handlers
// ---------------------------------------------------------------------------

/**
 * Extract title from the first `# Heading` in markdown content.
 * Falls back to the provided fallback string.
 */
function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

export async function handleCreatePage(args: {
  slug: string;
  content: string;
  author?: string;
}): Promise<{ slug: string; title: string; created: true }> {
  validateSlug(args.slug);

  // Check for conflicts
  const existing = await readWikiPage(args.slug);
  if (existing) {
    throw new Error(`Page already exists: ${args.slug}`);
  }

  const title = extractTitle(args.content, args.slug);
  const summary = extractSummary(args.content);
  const today = new Date().toISOString().slice(0, 10);
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 90);
  const expiryDate = expiry.toISOString().slice(0, 10);

  const frontmatter: Frontmatter = {
    title,
    created: today,
    updated: today,
    confidence: 0.5,
    expiry: expiryDate,
    authors: [args.author ?? "agent"],
    valid_from: today,
    disputed: false,
    contributors: [],
    aliases: [],
    tags: [],
  };

  const fullContent = serializeFrontmatter(frontmatter, args.content);

  await writeWikiPageWithSideEffects({
    slug: args.slug,
    title,
    content: fullContent,
    summary,
    logOp: "ingest",
    author: args.author,
    crossRefSource: null, // skip cross-ref for MCP writes
  });

  return { slug: args.slug, title, created: true };
}

export async function handleUpdatePage(args: {
  slug: string;
  content: string;
  author?: string;
}): Promise<{ slug: string; title: string; updated: true }> {
  const existingPage = await readWikiPageWithFrontmatter(args.slug);
  if (!existingPage) {
    throw new Error(`Page not found: ${args.slug}`);
  }

  const title = extractTitle(args.content, existingPage.title);
  const summary = extractSummary(args.content);
  const today = new Date().toISOString().slice(0, 10);

  // Merge frontmatter: preserve existing fields, bump updated, backfill created
  const merged: Frontmatter = {
    ...existingPage.frontmatter,
    title,
    updated: today,
  };
  if (!merged.created) {
    merged.created = today;
  }

  // Track contributors: append the editor if they're not already listed.
  if (args.author) {
    const existingContributors = Array.isArray(merged.contributors)
      ? (merged.contributors as string[])
      : [];
    if (!existingContributors.includes(args.author)) {
      merged.contributors = [...existingContributors, args.author];
    }
  }

  const fullContent = serializeFrontmatter(merged, args.content);

  await writeWikiPageWithSideEffects({
    slug: args.slug,
    title,
    content: fullContent,
    summary,
    logOp: "edit",
    author: args.author,
    crossRefSource: null, // skip cross-ref for MCP writes
  });

  return { slug: args.slug, title, updated: true };
}

// ---------------------------------------------------------------------------
// Delete page handler
// ---------------------------------------------------------------------------

export async function handleDeletePage(args: {
  slug: string;
}): Promise<DeletePageResult> {
  return deleteWikiPage(args.slug);
}

// ---------------------------------------------------------------------------
// Ingest URL handler
// ---------------------------------------------------------------------------

export async function handleIngestUrl(args: {
  url: string;
  tags?: string[] | undefined;
}): Promise<{
  slug: string;
  title: string;
  summary: string;
  sourceUrl: string;
}> {
  if (!isUrl(args.url)) {
    throw new Error(
      `Invalid URL: "${args.url}" — must start with http:// or https://`,
    );
  }

  const result: IngestResult = await ingestUrl(args.url, {
    ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
  });

  // Read the written page to extract title and summary for the response
  const page = await readWikiPageWithFrontmatter(result.primarySlug);
  const title = page?.title ?? result.primarySlug;
  const summary = page
    ? extractSummary(page.body)
    : `Ingested from ${args.url}`;

  return {
    slug: result.primarySlug,
    title,
    summary,
    sourceUrl: args.url,
  };
}

// ---------------------------------------------------------------------------
// Query wiki handler
// ---------------------------------------------------------------------------

export async function handleQueryWiki(args: {
  question: string;
  format?: "prose" | "table" | "slides" | undefined;
  scope?: string | undefined;
}): Promise<QueryResult> {
  const format: QueryFormat = args.format ?? "prose";
  return query(args.question, format, args.scope);
}

// ---------------------------------------------------------------------------
// Agent context handler
// ---------------------------------------------------------------------------

/** Separator used between concatenated page contents (matches API route). */
const PAGE_SEPARATOR = "\n\n---\n\n";

/**
 * Load wiki pages by slug, concatenate their content.
 * Missing pages are silently skipped (returns empty string for that section).
 */
async function loadPages(slugs: string[]): Promise<{ content: string; count: number }> {
  const contents: string[] = [];
  for (const slug of slugs) {
    const page = await readWikiPageWithFrontmatter(slug);
    if (page) {
      contents.push(page.body);
    }
  }
  return {
    content: contents.join(PAGE_SEPARATOR),
    count: contents.length,
  };
}

export async function handleAgentContext(args: {
  agent_id: string;
}): Promise<{
  agent: { id: string; name: string; description: string };
  context: {
    identity: string;
    learnings: string;
    socialWisdom: string;
  };
  meta: {
    totalChars: number;
    pageCount: number;
  };
}> {
  const agent = await getAgent(args.agent_id);
  if (!agent) {
    throw new Error("Agent not found");
  }

  const [identity, learnings, social] = await Promise.all([
    loadPages(agent.identityPages),
    loadPages(agent.learningPages),
    loadPages(agent.socialPages),
  ]);

  const totalChars =
    identity.content.length + learnings.content.length + social.content.length;
  const pageCount = identity.count + learnings.count + social.count;

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
    },
    context: {
      identity: identity.content,
      learnings: learnings.content,
      socialWisdom: social.content,
    },
    meta: {
      totalChars,
      pageCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Seed agent handler
// ---------------------------------------------------------------------------

export async function handleSeedAgent(args: {
  agent_id: string;
  name: string;
  description: string;
  sections: {
    slug: string;
    title: string;
    type: "identity" | "learnings" | "social";
    content: string;
  }[];
}): Promise<AgentProfile> {
  const sections: SeedAgentSection[] = args.sections.map((s) => ({
    slug: s.slug,
    title: s.title,
    type: s.type,
    content: s.content,
  }));

  return seedAgent({
    id: args.agent_id,
    name: args.name,
    description: args.description,
    sections,
  });
}

// ---------------------------------------------------------------------------
// Lint handlers
// ---------------------------------------------------------------------------

const VALID_CHECK_TYPES = new Set<string>(ALL_CHECK_TYPES);

export async function handleLintWiki(args: {
  checks?: string[] | undefined;
  minSeverity?: string | undefined;
}): Promise<LintResult> {
  // Validate check types if provided
  if (args.checks) {
    const invalid = args.checks.filter((c) => !VALID_CHECK_TYPES.has(c));
    if (invalid.length > 0) {
      throw new Error(
        `Invalid check type(s): ${invalid.join(", ")}. Valid types: ${ALL_CHECK_TYPES.join(", ")}`,
      );
    }
  }

  // Validate minSeverity if provided
  const validSeverities = new Set(["error", "warning", "info"]);
  if (args.minSeverity !== undefined && !validSeverities.has(args.minSeverity)) {
    throw new Error(
      `Invalid minSeverity: "${args.minSeverity}". Valid values: error, warning, info`,
    );
  }

  return lint({
    ...(args.checks ? { checks: args.checks as LintIssue["type"][] } : {}),
    ...(args.minSeverity ? { minSeverity: args.minSeverity as LintIssue["severity"] } : {}),
  });
}

export async function handleFixLintIssue(args: {
  type: string;
  slug: string;
  target?: string | undefined;
  message?: string | undefined;
}): Promise<FixResult> {
  return fixLintIssue(args.type, args.slug, args.target, args.message);
}

// ---------------------------------------------------------------------------
// Discussion (talk page) handlers
// ---------------------------------------------------------------------------

export async function handleListDiscussions(args: {
  pageSlug: string;
}): Promise<{
  pageSlug: string;
  threads: {
    index: number;
    title: string;
    status: string;
    author: string;
    commentCount: number;
    created: string;
    updated: string;
  }[];
}> {
  const threads = await listThreads(args.pageSlug);
  return {
    pageSlug: args.pageSlug,
    threads: threads.map((t, i) => ({
      index: i,
      title: t.title,
      status: t.status,
      author: t.comments[0]?.author ?? "unknown",
      commentCount: t.comments.length,
      created: t.created,
      updated: t.updated,
    })),
  };
}

export async function handleCreateDiscussion(args: {
  pageSlug: string;
  title: string;
  body: string;
  author: string;
}): Promise<TalkThread> {
  if (!args.pageSlug) {
    throw new Error("pageSlug is required");
  }
  if (!args.title) {
    throw new Error("title is required");
  }
  if (!args.body) {
    throw new Error("body is required");
  }
  if (!args.author) {
    throw new Error("author is required");
  }
  return createThread(args.pageSlug, args.title, args.author, args.body);
}

export async function handleResolveDiscussion(args: {
  pageSlug: string;
  threadIndex: number;
  resolution: "resolved" | "wontfix";
}): Promise<TalkThread> {
  if (!args.pageSlug) {
    throw new Error("pageSlug is required");
  }
  if (args.threadIndex === undefined || args.threadIndex === null) {
    throw new Error("threadIndex is required");
  }
  if (!args.resolution) {
    throw new Error("resolution is required");
  }
  if (args.resolution !== "resolved" && args.resolution !== "wontfix") {
    throw new Error(
      `Invalid resolution: "${args.resolution}". Must be "resolved" or "wontfix"`,
    );
  }
  return resolveThread(args.pageSlug, args.threadIndex, args.resolution);
}

export async function handleAddComment(args: {
  pageSlug: string;
  threadIndex: number;
  content: string;
  author?: string | undefined;
  parentId?: string | undefined;
}): Promise<TalkComment> {
  if (!args.pageSlug) {
    throw new Error("pageSlug is required");
  }
  if (args.threadIndex === undefined || args.threadIndex === null) {
    throw new Error("threadIndex is required");
  }
  if (!args.content) {
    throw new Error("content is required");
  }
  const author = args.author ?? "anonymous";
  return addComment(args.pageSlug, args.threadIndex, author, args.content, args.parentId);
}

// ---------------------------------------------------------------------------
// Re-ingest handler
// ---------------------------------------------------------------------------

export async function handleReingest(args: {
  slug: string;
}): Promise<IngestResult> {
  if (!args.slug) {
    throw new Error("slug is required");
  }
  return reingest(args.slug);
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "yopedia",
    version: "1.0.0",
  });

  // search_wiki — Search wiki pages
  server.registerTool("search_wiki", {
    description: "Search yopedia wiki pages by query string",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of results (default 10)"),
      scope: z
        .string()
        .optional()
        .describe("Scope search to an agent's pages, e.g. 'agent:yoyo'"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const results = await handleSearchWiki(args);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  });

  // read_page — Read a single wiki page
  server.registerTool("read_page", {
    description: "Read a single yopedia wiki page by slug",
    inputSchema: {
      slug: z.string().describe("Page slug (e.g. 'neural-networks')"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const page = await handleReadPage(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // list_pages — List all wiki pages
  server.registerTool("list_pages", {
    description:
      "List all yopedia wiki pages with optional sort and limit",
    inputSchema: {
      sort: z
        .enum(["title", "updated", "confidence"])
        .optional()
        .describe("Sort order (default: title)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of pages to return"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const pages = await handleListPages(args);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(pages, null, 2),
        },
      ],
    };
  });

  // create_page — Create a new wiki page
  server.registerTool("create_page", {
    description: "Create a new yopedia wiki page with the given slug and markdown content",
    inputSchema: {
      slug: z.string().describe("URL-safe page slug (e.g. 'neural-networks')"),
      content: z.string().describe("Markdown body for the new page (include a # Heading for the title)"),
      author: z.string().optional().describe("Author handle for attribution (defaults to 'agent')"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleCreatePage(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // update_page — Update an existing wiki page
  server.registerTool("update_page", {
    description: "Update an existing yopedia wiki page with new markdown content",
    inputSchema: {
      slug: z.string().describe("Slug of the page to update"),
      content: z.string().describe("New markdown body for the page"),
      author: z.string().optional().describe("Author handle for attribution"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleUpdatePage(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // delete_page — Delete a wiki page
  server.registerTool("delete_page", {
    description: "Delete a yopedia wiki page by slug",
    inputSchema: {
      slug: z.string().describe("Slug of the page to delete (e.g. 'neural-networks')"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleDeletePage(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // ingest_url — Ingest a URL into the wiki
  server.registerTool("ingest_url", {
    description:
      "Ingest a URL into the wiki — fetches the page, chunks the content, summarizes with an LLM, and creates/updates a wiki page with cross-references",
    inputSchema: {
      url: z.string().describe("URL to ingest (must start with http:// or https://)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags to apply to the created page"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
  }, async (args) => {
    try {
      const result = await handleIngestUrl(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // query_wiki — Ask the wiki a question with LLM synthesis
  server.registerTool("query_wiki", {
    description:
      "Ask the wiki a question — searches relevant pages, synthesizes an answer with citations using an LLM",
    inputSchema: {
      question: z.string().describe("The question to ask the wiki"),
      format: z
        .enum(["prose", "table", "slides"])
        .optional()
        .describe("Answer format: prose (default), table, or slides"),
      scope: z
        .string()
        .optional()
        .describe("Scope query to an agent's pages, e.g. 'agent:yoyo'"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleQueryWiki(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // agent_context — Get an agent's full context
  server.registerTool("agent_context", {
    description:
      "Get an agent's full context (identity, learnings, social wisdom) by agent ID",
    inputSchema: {
      agent_id: z.string().describe("Agent ID (e.g. 'yoyo')"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleAgentContext(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // seed_agent — Register an agent and create its wiki pages
  server.registerTool("seed_agent", {
    description:
      "Register an agent and create its wiki pages (identity, learnings, social wisdom). Idempotent — re-seeding updates existing pages.",
    inputSchema: {
      agent_id: z.string().describe("Agent ID (lowercase alphanumeric + hyphens)"),
      name: z.string().describe("Agent display name"),
      description: z.string().describe("Short description of the agent"),
      sections: z.array(z.object({
        slug: z.string().describe("Wiki page slug for this section"),
        title: z.string().describe("Page title"),
        type: z.enum(["identity", "learnings", "social"]).describe("Section type"),
        content: z.string().describe("Markdown content for this section"),
      })).describe("Content sections to create as wiki pages"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleSeedAgent(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // lint_wiki — Run quality checks on the wiki
  server.registerTool("lint_wiki", {
    description:
      "Run quality checks on the yopedia wiki. Returns an array of issues with type, severity, slug, and message. Optionally scope to specific check types or minimum severity.",
    inputSchema: {
      checks: z
        .array(z.string())
        .optional()
        .describe(
          `Check types to run (default: all). Valid: ${ALL_CHECK_TYPES.join(", ")}`,
        ),
      minSeverity: z
        .enum(["error", "warning", "info"])
        .optional()
        .describe("Minimum severity to include (default: info)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleLintWiki(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // fix_lint_issue — Auto-fix a lint issue
  server.registerTool("fix_lint_issue", {
    description:
      "Auto-fix a lint issue found by lint_wiki. Takes the issue type, slug, and optional target/message. Not all issue types are auto-fixable.",
    inputSchema: {
      type: z.string().describe("Lint issue type (e.g. 'orphan-page', 'stale-index', 'empty-page')"),
      slug: z.string().describe("Slug of the affected page"),
      target: z
        .string()
        .optional()
        .describe("Target slug for cross-ref, contradiction, broken-link, and duplicate-entity fixes"),
      message: z
        .string()
        .optional()
        .describe("Message context for contradiction or missing-concept-page fixes"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleFixLintIssue(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // list_discussions — List discussion threads for a wiki page
  server.registerTool("list_discussions", {
    description:
      "List all discussion threads for a wiki page, including status, author, and comment count",
    inputSchema: {
      pageSlug: z
        .string()
        .describe("Slug of the wiki page to list discussions for"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleListDiscussions(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // create_discussion — Start a new discussion thread on a wiki page
  server.registerTool("create_discussion", {
    description:
      "Create a new discussion thread on a wiki page for editorial discussion",
    inputSchema: {
      pageSlug: z
        .string()
        .describe("Slug of the wiki page to discuss"),
      title: z.string().describe("Title of the discussion thread"),
      body: z
        .string()
        .describe("Body of the first comment (markdown supported)"),
      author: z
        .string()
        .describe("Author handle (agent ID or user handle)"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleCreateDiscussion(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // resolve_discussion — Resolve a discussion thread
  server.registerTool("resolve_discussion", {
    description:
      "Resolve a discussion thread on a wiki page (mark as resolved or wontfix)",
    inputSchema: {
      pageSlug: z
        .string()
        .describe("Slug of the wiki page the discussion belongs to"),
      threadIndex: z
        .number()
        .describe("Zero-based index of the thread to resolve"),
      resolution: z
        .enum(["resolved", "wontfix"])
        .describe('Resolution status: "resolved" or "wontfix"'),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleResolveDiscussion(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // add_comment — Add a comment to a discussion thread
  server.registerTool("add_comment", {
    description:
      "Add a comment to an existing discussion thread on a wiki page",
    inputSchema: {
      pageSlug: z
        .string()
        .describe("Slug of the wiki page the discussion belongs to"),
      threadIndex: z
        .number()
        .describe("Zero-based index of the thread to comment on"),
      content: z
        .string()
        .describe("Comment body (markdown supported)"),
      author: z
        .string()
        .optional()
        .describe('Author handle (agent ID or user handle, defaults to "anonymous")'),
      parentId: z
        .string()
        .optional()
        .describe("ID of parent comment for threaded replies (omit for top-level)"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleAddComment(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  // reingest — Re-ingest a wiki page from its original source URL
  server.registerTool("reingest", {
    description:
      "Re-ingest a wiki page from its original source URL to refresh stale content",
    inputSchema: {
      slug: z
        .string()
        .describe("Slug of the wiki page to re-ingest"),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const result = await handleReingest(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: (err as Error).message,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main — run as stdio server when executed directly
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("yopedia MCP server running on stdio");
}

// Only run main when executed directly (not imported for testing)
const isDirectExecution =
  process.argv[1]?.endsWith("mcp.ts") ||
  process.argv[1]?.endsWith("mcp.js");

if (isDirectExecution) {
  main().catch((error) => {
    console.error("MCP server error:", error);
    process.exit(1);
  });
}
