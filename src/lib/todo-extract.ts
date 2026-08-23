/**
 * Meeting-only LLM extract → kernel Todo Candidates.
 *
 * Runs after a successful Plaud or marked-meeting compile. Never copies a
 * Plaud action-item list. Never calls proposeActionItems.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { llmTimeoutOption } from "./config";
import { isEnoent } from "./errors";
import { getConfiguredModel, hasLLMKey, retryWithBackoff } from "./llm";
import { rawSourceRelPath, tenantRawSourceRelPath } from "./raw";
import { loadPageConventions } from "./schema";
import { parseSources } from "./sources";
import { sourceRestFromPath } from "./source-delete";
import { getStorage } from "./storage";
import {
  collapseTodoTitles,
  enqueueTodoCandidates,
  type TodoCandidateProposal,
  type TodoItem,
} from "./todos";
import { getCurrentWiki } from "./wikis";
import {
  readWikiPageWithFrontmatter,
  tenantForOwner,
} from "./wiki";

const todoExtractionSchema = z.object({
  candidates: z
    .array(
      z.object({
        title: z.string().min(1).max(240),
        rationale: z.string().min(1).max(2_000),
        due: z.string().max(40).optional(),
        speaker: z.string().max(160).optional(),
        context: z.string().max(800).optional(),
      }),
    )
    .max(25),
});

const EXTRACT_SYSTEM =
  "You extract Todo Candidates from a meeting compile. " +
  "Propose only concrete commitments implied by the transcript, summary, and compiled page. " +
  "Precision over recall: skip observations, aspirations, and generic advice. " +
  "Do not transcribe or copy a Plaud \"Action items\" list, a bullet list of follow-ups, or any vendor action section. " +
  "If both a transcript and a summary are present, read both and collapse duplicate titles into one Candidate. " +
  "Optional due dates only when the meeting states a date; leave speaker and context when they are explicit. " +
  "Write English only. Return an empty candidates array when none are approve-worthy.";

export function buildTodoExtractPrompt(input: {
  conventions: string;
  pageTitle: string;
  slug: string;
  pageBody: string;
  sourceBodies: string;
}): string {
  const conventions = input.conventions.trim()
    ? `\n\nPage conventions:\n${input.conventions.trim()}`
    : "";
  return (
    `Compiled page: ${input.pageTitle} (${input.slug}.md)\n\n` +
    `${input.pageBody.slice(0, 40_000)}\n\n` +
    `Cited sources:\n${input.sourceBodies.slice(0, 40_000) || "(none)"}${conventions}`
  );
}

async function readSourceText(owner: string, sourcePath: string): Promise<string | null> {
  const rest = sourceRestFromPath(sourcePath);
  const candidates = [
    sourcePath,
    rest ? rawSourceRelPath(rest) : null,
    rest ? tenantRawSourceRelPath(tenantForOwner(owner), rest) : null,
  ].filter((value): value is string => Boolean(value));
  for (const rel of candidates) {
    try {
      return await getStorage().readFile(rel);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  return null;
}

export async function readCitedMeetingSources(
  owner: string,
  slug: string,
  preferredPath?: string,
): Promise<{ sourceId: string; bodies: string }> {
  const page = await readWikiPageWithFrontmatter(slug);
  const sources = page
    ? parseSources(page.frontmatter.sources as string | string[] | undefined)
    : [];
  const paths: string[] = [];
  if (preferredPath?.trim()) paths.push(preferredPath.trim());
  for (const source of sources) {
    if (source.url.startsWith("raw/") || source.url.startsWith("raw/sources/")) {
      paths.push(source.url);
    }
  }
  const unique = [...new Set(paths)];
  const chunks: string[] = [];
  let sourceId = preferredPath?.trim() ?? unique[0] ?? "";
  for (const path of unique) {
    const text = await readSourceText(owner, path);
    if (!text) continue;
    if (!sourceId) sourceId = path;
    chunks.push(`--- ${path} ---\n${text}`);
  }
  return { sourceId, bodies: chunks.join("\n\n") };
}

/**
 * Extract Candidates after a successful meeting compile.
 * Always refreshes pending Candidates for the Source, including none found.
 */
export async function extractTodoCandidatesFromMeeting(
  owner: string,
  slug: string,
  sourcePath?: string,
): Promise<TodoItem[]> {
  if (!hasLLMKey()) {
    throw new Error("Configure an LLM to extract Todos.");
  }
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) throw new Error(`Page "${slug}" not found`);

  const { sourceId, bodies } = await readCitedMeetingSources(owner, slug, sourcePath);
  if (!sourceId) {
    throw new Error(`No Source path for meeting extract of "${slug}"`);
  }

  const conventions = await loadPageConventions();
  const model = await getConfiguredModel();
  const { output } = await retryWithBackoff(() =>
    generateText({
      model,
      output: Output.object({ schema: todoExtractionSchema }),
      system: EXTRACT_SYSTEM,
      prompt: buildTodoExtractPrompt({
        conventions,
        pageTitle: page.title,
        slug,
        pageBody: page.body,
        sourceBodies: bodies,
      }),
      maxOutputTokens: 2_500,
      ...llmTimeoutOption(),
    }),
  );

  const wiki = await getCurrentWiki(owner);
  const proposals: TodoCandidateProposal[] = collapseTodoTitles(output.candidates);
  return enqueueTodoCandidates(owner, {
    wikiId: wiki?.id ?? "current",
    sourceId,
    pageSlug: slug,
    candidates: proposals,
  });
}
