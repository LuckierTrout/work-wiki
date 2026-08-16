import { generateText, Output } from "ai";
import { z } from "zod";
import { proposeActionItems, type ActionItem } from "./action-items";
import { llmTimeoutOption } from "./config";
import { getConfiguredModel, hasLLMKey, retryWithBackoff } from "./llm";
import {
  canonicalizeNamesTerm,
  listNamesTerms,
  renderNamesTermsGuidance,
} from "./names-terms";
import { readWikiPageWithFrontmatter } from "./wiki";
import { buildWorkspaceGuidance } from "./workspace-profile";

const actionExtractionSchema = z.object({
  actions: z.array(
    z.object({
      title: z.string().min(1).max(240),
      details: z.string().max(2_000).optional(),
      assignee: z.string().max(160).optional(),
      dueDate: z.string().max(40).optional(),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
      sourceExcerpt: z.string().max(800),
      confidence: z.number().min(0).max(1),
    }),
  ).max(25),
});

/**
 * Extract explicit commitments and requests from one newly ingested page.
 * Results enter the owner's private inbox as proposals; this never activates or
 * completes work without the owner accepting it.
 */
export async function extractActionsFromPage(
  owner: string,
  slug: string,
): Promise<ActionItem[]> {
  if (!hasLLMKey()) return [];
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) throw new Error(`Page "${slug}" not found`);

  const model = await getConfiguredModel();
  const dictionary = await listNamesTerms(owner);
  const dictionaryGuidance = renderNamesTermsGuidance(dictionary);
  const workspaceGuidance = await buildWorkspaceGuidance(owner);
  const { output } = await retryWithBackoff(() =>
    generateText({
      model,
      output: Output.object({ schema: actionExtractionSchema }),
      system:
        "You extract actionable commitments from newly added knowledge. " +
        "Return only concrete tasks that someone is asked, expected, or committed to do. " +
        "Do not turn observations, aspirations, reference material, or generic advice into tasks. " +
        "Preserve named assignees and explicit dates. If a date is relative, leave it verbatim. " +
        "The source excerpt must be a short exact-or-close passage supporting the task." +
        (workspaceGuidance ? `\n\n${workspaceGuidance}` : "") +
        (dictionaryGuidance ? `\n\n${dictionaryGuidance}` : ""),
      prompt: `Source page: ${page.title} (${slug}.md)\n\n${page.content.slice(0, 80_000)}`,
      maxOutputTokens: 2_500,
      // Inside the thunk, so each retry gets its own fresh deadline.
      ...llmTimeoutOption(),
    }),
  );

  return proposeActionItems(
    owner,
    output.actions.map((action) => ({
      ...action,
      ...(action.assignee
        ? {
            assignee: canonicalizeNamesTerm(
              dictionary,
              action.assignee,
              ["person", "organization"],
            ),
          }
        : {}),
      sourceSlug: slug,
    })),
  );
}
