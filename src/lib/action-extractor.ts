import { generateText, Output } from "ai";
import { z } from "zod";
import { proposeActionItems, type ActionItem } from "./action-items";
import { humanOwnerOf } from "./agent-handle";
import { llmTimeoutOption } from "./config";
import { getConfiguredModel, hasLLMKey, retryWithBackoff } from "./llm";
import {
  canonicalizeNamesTerm,
  listNamesTerms,
  renderNamesTermsGuidance,
} from "./names-terms";
import { readWikiPageWithFrontmatter } from "./wiki";
import { buildWorkspaceGuidance } from "./workspace-guidance";

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
  if (!(await hasLLMKey())) return [];
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) throw new Error(`Page "${slug}" not found`);

  const model = await getConfiguredModel();
  // Guidance is addressed BY HUMAN, storage by handle (DW-543/DW-709). A
  // Workspace Purpose and a Names & Terms dictionary belong to a PERSON, not to
  // each of that person's agents — `alice--yoyo` keys its own empty tenant, so
  // resolving guidance from the raw handle would extract against no Purpose and
  // no dictionary. Reduce ONCE, here, and use it for the two guidance reads
  // below; `proposeActionItems` keeps the RAW handle, because that one names a
  // SILO and a reduced handle there would silently repoint the write.
  const guidanceOwner = humanOwnerOf(owner);
  const dictionary = await listNamesTerms(guidanceOwner);
  const dictionaryGuidance = renderNamesTermsGuidance(dictionary);
  const workspaceGuidance = await buildWorkspaceGuidance(guidanceOwner);
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
