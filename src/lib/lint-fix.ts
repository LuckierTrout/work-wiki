import { resolveAlias } from "./alias-index";
import { readWikiPage, readWikiPageWithFrontmatter, isArtifactType } from "./wiki";
import { pruneStaleIndexEntry, writeWikiPageWithSideEffects, deleteWikiPage } from "./lifecycle";
import { callLLM, hasLLMKey } from "./llm";
import { slugify } from "./slugify";
import {
  rewriteMarkdownLinksByTarget,
  rewriteWikilinksByTarget,
} from "./markdown-link-rewrite";
import { serializeFrontmatter } from "./frontmatter";
import { disputedClearGuidance, type AutoFixableCheckType } from "./lint-types";
import { withTriggeredBy } from "./wiki-log";
import type { LintIssue } from "./types";

/**
 * WHO IS THE AUTHOR OF A LINT FIX, AND WHO IS THE TRIGGER (DW-447).
 *
 * `author` is the machine: `"lint-fix"`, an `AUTOMATION_ACTORS` member
 * (`./agent-handle`) that `normalizeActor` folds into the agent, on EVERY door
 * — REST, HTTP MCP, stdio MCP, Workbench. A door that stamped its resolved
 * principal as `author` credited a human with a machine-generated edit in the
 * revision history, the page's contributor list and their trust score, which is
 * the exact thing `AUTOMATION_ACTORS` exists to prevent.
 *
 * `triggeredBy` is the human (or agent) who ASKED. It is optional, server-
 * derived from the resolved principal — never caller-supplied — and lands ONLY
 * on the wiki-log detail line, via `withTriggeredBy`. Nothing that feeds
 * attribution reads that line. Absent or blank leaves the line byte-identical,
 * which is what the principal-less callers (stdio MCP, `cli.ts --fix`,
 * `POST /api/tasks/run`'s `maintain:fix`) get.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a lint-fix operation. */
export interface FixResult {
  success: boolean;
  slug: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a required field is missing from the fix request. */
export class FixValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixValidationError";
  }
}

/** Thrown when a page required by the fix doesn't exist. */
export class FixNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Individual fix functions
// ---------------------------------------------------------------------------

/**
 * Fix an orphan-page lint issue by adding the page to the wiki index.
 *
 * Reads the page, extracts a summary, and writes it through the lifecycle
 * pipeline so that the index entry is created.
 */
export async function fixOrphanPage(
  slug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  const page = await readWikiPage(slug, { fresh: true, strict: true });
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  // Extract summary from the first paragraph
  const summaryMatch = page.content.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: page.content,
    summary,
    logOp: "edit",
    logDetails: () => withTriggeredBy("auto-fix: added orphan page to index", triggeredBy),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });

  return {
    success: true,
    slug,
    message: `Added ${slug} to index`,
  };
}

/**
 * Fix a stale-index lint issue by removing the stale entry from the index.
 *
 * If the slug is not found in the index, returns a no-op success result.
 */
export async function fixStaleIndex(
  slug: string,
  // INERT, and kept anyway. `pruneStaleIndexEntry` mints no revision, so there
  // is no author to record — but every one of this function's nine siblings
  // takes `(…, author, triggeredBy)` and `FIX_HANDLERS` forwards that pair
  // positionally to all ten. Dropping the slot here would make this the one
  // entry with a different tail, which is a worse trap than an unused
  // parameter: the next hand-written call would put the trigger in it.
  _author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  // Re-verify the page file is genuinely missing before dropping its index
  // entry — never remove a valid entry on a transient read miss or a retry
  // after the page was (re)created.
  if (await readWikiPage(slug, { fresh: true, strict: true })) {
    return {
      success: false,
      slug,
      message: `Page "${slug}" exists — index entry is not stale`,
    };
  }

  // `author` is deliberately NOT forwarded: `pruneStaleIndexEntry` mints no
  // revision and never had a use for one. The trigger is its only extra input.
  const result = await pruneStaleIndexEntry(slug, triggeredBy);
  if (!result.removed) {
    return {
      success: true,
      slug,
      message: `Entry for ${slug} not found in index — no changes needed`,
    };
  }

  return {
    success: true,
    slug,
    message: `Removed stale entry for ${slug} from index`,
  };
}

/**
 * Fix an empty-page lint issue by deleting the page entirely.
 */
export async function fixEmptyPage(
  slug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  // `expectedContent` stays `undefined` — this fix has never read the page
  // first — so the trigger has to be named positionally as the fourth argument.
  await deleteWikiPage(slug, author, undefined, triggeredBy);

  return {
    success: true,
    slug,
    message: `Deleted empty page ${slug}`,
  };
}

/**
 * Fix a missing-crossref lint issue by inserting a cross-reference link
 * from `slug` to `targetSlug`.
 *
 * If the link already exists, returns a no-op success result.
 * If no `## Related` section exists, creates one at the end of the page.
 */
export async function fixMissingCrossRef(
  slug: string,
  targetSlug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug || !targetSlug) {
    throw new FixValidationError(
      "Missing required fields: slug and targetSlug",
    );
  }

  // Read the source page
  const sourcePage = await readWikiPage(slug, { fresh: true, strict: true });
  if (!sourcePage) {
    throw new FixNotFoundError(`Source page not found: ${slug}`);
  }

  // Never append a markdown "## Related" section to an HTML artifact — its body
  // is a self-contained document and the markdown would render as literal text.
  const sourceFm = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
  if (
    sourceFm &&
    isArtifactType(
      typeof sourceFm.frontmatter.type === "string"
        ? sourceFm.frontmatter.type
        : undefined,
    )
  ) {
    return {
      success: true,
      slug,
      message: `Skipped ${slug}: HTML artifacts don't take markdown cross-references`,
    };
  }

  // Read the target page to get its title
  const targetPage = await readWikiPage(targetSlug, { fresh: true, strict: true });
  if (!targetPage) {
    throw new FixNotFoundError(`Target page not found: ${targetSlug}`);
  }

  // Build the cross-reference link
  const link = `[${targetPage.title}](${targetSlug}.md)`;

  // Check if the link already exists (avoid duplicates)
  if (sourcePage.content.includes(`(${targetSlug}.md)`)) {
    return {
      success: true,
      slug,
      message: `Page already links to ${targetSlug}.md — no changes needed`,
    };
  }

  // Append the link to a ## Related section
  let updatedContent: string;
  const relatedHeadingRe = /^## Related\b.*$/m;
  const relatedMatch = relatedHeadingRe.exec(sourcePage.content);

  if (relatedMatch) {
    // Insert the link on the line after the heading.
    // Find the end of the Related section: either the next heading or EOF.
    const afterHeading = relatedMatch.index! + relatedMatch[0].length;
    const restAfterHeading = sourcePage.content.slice(afterHeading);

    // Find next heading (## or #) after the Related section
    const nextHeadingMatch = restAfterHeading.match(/\n(?=## )/);
    const insertPos = nextHeadingMatch
      ? afterHeading + nextHeadingMatch.index!
      : sourcePage.content.length;

    // Insert just before the next heading (or at EOF), with a blank line guard
    const before = sourcePage.content.slice(0, insertPos).trimEnd();
    const after = sourcePage.content.slice(insertPos);
    updatedContent = `${before}\n- ${link}${after ? `\n${after}` : "\n"}`;
  } else {
    // No Related section yet — append one at the end
    updatedContent = `${sourcePage.content.trimEnd()}\n\n## Related\n\n- ${link}\n`;
  }

  // Extract summary from the source page for the index entry
  const summaryMatch = sourcePage.content.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  // Write via the lifecycle pipeline (handles index, log, embeddings)
  await writeWikiPageWithSideEffects({
    slug,
    title: sourcePage.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(`auto-fix: added cross-reference to ${targetSlug}.md`, triggeredBy),
    crossRefSource: null, // skip cross-ref discovery — we're adding a specific link
    author,
    expectedContent: sourcePage.content,
  });

  return {
    success: true,
    slug,
    message: `Added cross-reference from ${slug}.md to ${targetSlug}.md`,
  };
}

/**
 * Fix a contradiction lint issue by calling the LLM to rewrite the first page
 * so it no longer conflicts with the second page.
 *
 * @param slug - The slug of the page to rewrite
 * @param targetSlug - The slug of the other page involved in the contradiction
 * @param message - The contradiction description from the linter
 */
export async function fixContradiction(
  slug: string,
  targetSlug: string,
  message: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug || !targetSlug) {
    throw new FixValidationError(
      "Missing required fields: slug and targetSlug",
    );
  }

  if (!(await hasLLMKey())) {
    throw new FixValidationError(
      "Cannot fix contradictions without an LLM provider configured",
    );
  }

  const sourcePage = await readWikiPage(slug, { fresh: true, strict: true });
  if (!sourcePage) {
    throw new FixNotFoundError(`Source page not found: ${slug}`);
  }

  const otherPage = await readWikiPage(targetSlug, { fresh: true, strict: true });
  if (!otherPage) {
    throw new FixNotFoundError(`Target page not found: ${targetSlug}`);
  }

  const systemPrompt = `You are a wiki editor resolving contradictions between pages. You will be given two wiki pages and a description of the contradiction. Rewrite ONLY the first page to resolve the contradiction while preserving as much of its original content and structure as possible. Output only the full rewritten markdown for the first page — no explanation, no wrapping.`;

  const userMessage = `## Contradiction\n${message}\n\n## Page to rewrite: ${slug}.md\n\n${sourcePage.content}\n\n## Other page (do not rewrite): ${targetSlug}.md\n\n${otherPage.content}`;

  const rewritten = await callLLM(systemPrompt, userMessage);

  // Extract summary from the rewritten page for the index entry
  const summaryMatch = rewritten.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: sourcePage.title,
    content: rewritten,
    summary,
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(`auto-fix: resolved contradiction with ${targetSlug}.md`, triggeredBy),
    crossRefSource: null,
    author,
    expectedContent: sourcePage.content,
  });

  return {
    success: true,
    slug,
    message: `Rewrote ${slug}.md to resolve contradiction with ${targetSlug}.md`,
  };
}

/**
 * Fix a missing-concept-page lint issue by generating a stub wiki page for the
 * concept.
 *
 * - Parses the concept name from the lint message (pattern: `Concept "X" is mentioned in ...`)
 * - If the slug already exists on disk, returns a no-op success (race guard)
 * - With an LLM key: asks the LLM to produce a concise wiki page for the concept
 * - Without an LLM key: creates a minimal stub page
 * - Writes via `writeWikiPageWithSideEffects` so index + cross-refs are updated
 */
export async function fixMissingConceptPage(
  message: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  // Extract concept name from the lint message format:
  //   Concept "X" is mentioned in slug-a, slug-b but has no dedicated page. <reason>
  const conceptMatch = message.match(/^Concept "([^"]+)" is mentioned in/);
  if (!conceptMatch) {
    throw new FixValidationError(
      "Could not parse concept name from lint message",
    );
  }

  const concept = conceptMatch[1];
  const slug = slugify(concept);

  if (!slug) {
    throw new FixValidationError(
      `Could not generate a valid slug for concept "${concept}"`,
    );
  }

  // Guard: if the page already exists, there's nothing to do
  const existing = await readWikiPage(slug, { fresh: true, strict: true });
  if (existing) {
    return {
      success: true,
      slug,
      message: `Page ${slug}.md already exists — no changes needed`,
    };
  }

  let content: string;

  if (await hasLLMKey()) {
    const systemPrompt =
      "You are a wiki editor. Create a concise wiki page for the given concept. " +
      "Start with a level-1 heading using the concept name, then provide a brief " +
      "definition and overview. Note at the end that this page was auto-generated " +
      "from a lint suggestion and may need expansion. Output only the markdown — " +
      "no wrapping, no explanation.";
    const userMessage = `Create a wiki page for the concept: "${concept}"`;
    content = await callLLM(systemPrompt, userMessage);
  } else {
    content =
      `# ${concept}\n\n` +
      `*This page was auto-generated by lint. Expand it with real content by ingesting sources about this topic.*\n`;
  }

  // Extract summary from generated content
  const summaryMatch = content.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : concept;

  await writeWikiPageWithSideEffects({
    slug,
    title: concept,
    content,
    summary,
    logOp: "ingest",
    logDetails: () =>
      withTriggeredBy(
        `auto-fix: created stub page for missing concept "${concept}"`,
        triggeredBy,
      ),
    crossRefSource: content,
    author,
    createOnly: true,
  });

  return {
    success: true,
    slug,
    message: `Created stub page ${slug}.md for concept "${concept}"`,
  };
}

/**
 * Fix a broken-link lint issue by removing the broken link from the page.
 *
 * Replaces all occurrences of `[text](targetSlug.md)` with just `text`.
 */
export async function fixBrokenLink(
  slug: string,
  targetSlug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }
  if (!targetSlug) {
    throw new FixValidationError("Missing required field: targetSlug");
  }

  const page = await readWikiPage(slug, { fresh: true, strict: true });
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  let updatedContent = rewriteMarkdownLinksByTarget(
    page.content,
    targetSlug,
    ({ label }) => label,
  );
  updatedContent = rewriteWikilinksByTarget(
    updatedContent,
    targetSlug,
    ({ rawTarget, fragment, label }) => label || `${rawTarget.trim()}${fragment}`,
  );

  if (updatedContent === page.content) {
    return {
      success: true,
      slug,
      message: `No broken links to ${targetSlug}.md found in ${slug}.md — no changes needed`,
    };
  }

  // Extract summary from the first paragraph
  const summaryMatch = updatedContent.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(`auto-fix: removed broken link(s) to "${targetSlug}.md"`, triggeredBy),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });

  return {
    success: true,
    slug,
    message: `Removed broken link(s) to ${targetSlug}.md from ${slug}.md`,
  };
}

/**
 * Workbench dangling-link fix: drop authorized `[[slug]]` / `[[slug|text]]`
 * wikilinks only. Markdown links and fenced examples stay put.
 */
export async function fixDanglingWikilink(
  slug: string,
  targetSlug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) throw new FixValidationError("Missing required field: slug");
  if (!targetSlug) throw new FixValidationError("Missing required field: targetSlug");
  const [page, target] = await Promise.all([
    readWikiPage(slug, { fresh: true, strict: true }),
    readWikiPage(targetSlug, { fresh: true, strict: true }),
  ]);
  if (!page) throw new FixNotFoundError(`Page not found: ${slug}`);
  if (target) {
    throw new FixValidationError(`Target page now exists: ${targetSlug}`);
  }
  const updatedContent = rewriteWikilinksByTarget(
    page.content,
    targetSlug,
    ({ rawTarget, fragment, label }) => label || `${rawTarget.trim()}${fragment}`,
  );
  if (updatedContent === page.content) {
    throw new FixValidationError(`No dangling wikilink to ${targetSlug} remains in ${slug}.md`);
  }
  const summaryMatch = updatedContent.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;
  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(`auto-fix: removed dangling wikilink(s) to "${targetSlug}"`, triggeredBy),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });
  return {
    success: true,
    slug,
    message: `Removed dangling wikilink(s) to ${targetSlug} from ${slug}.md`,
  };
}

/**
 * Rewrite a wikilink or markdown link whose target slug was renamed (alias).
 */
export async function fixRenamedSlug(
  slug: string,
  targetSlug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) throw new FixValidationError("Missing required field: slug");
  if (!targetSlug) throw new FixValidationError("Missing required field: targetSlug");
  const canonical = await resolveAlias(targetSlug);
  if (!canonical || canonical === targetSlug) {
    throw new FixValidationError(`No renamed-slug target for ${targetSlug}`);
  }
  const page = await readWikiPage(slug, { fresh: true, strict: true });
  if (!page) throw new FixNotFoundError(`Page not found: ${slug}`);
  let updatedContent = rewriteMarkdownLinksByTarget(
    page.content,
    targetSlug,
    ({ label, fragment }) => `[${label}](${canonical}.md${fragment})`,
  );
  updatedContent = rewriteWikilinksByTarget(
    updatedContent,
    targetSlug,
    ({ fragment, label }) => {
      const dest = `${canonical}${fragment}`;
      return label ? `[[${dest}|${label}]]` : `[[${dest}]]`;
    },
  );
  if (updatedContent === page.content) {
    return {
      success: true,
      slug,
      message: `No renamed-slug links to ${targetSlug} found in ${slug}.md — no changes needed`,
    };
  }
  const summaryMatch = updatedContent.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;
  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(
        `auto-fix: rewrote renamed slug "${targetSlug}" → "${canonical}"`,
        triggeredBy,
      ),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });
  return {
    success: true,
    slug,
    message: `Rewrote links from ${targetSlug} to ${canonical} in ${slug}.md`,
  };
}

/**
 * Fix a stale-page lint issue by bumping the expiry date forward by 90 days
 * and refreshing the `valid_from` timestamp to today.
 *
 * Reads the page, updates the `expiry` and `valid_from` frontmatter fields,
 * and writes back.
 */
export async function fixStalePage(
  slug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  const page = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  const now = new Date();
  const newExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const expiryStr = newExpiry.toISOString().split("T")[0];
  const validFromStr = now.toISOString().split("T")[0];

  page.frontmatter.expiry = expiryStr;
  page.frontmatter.valid_from = validFromStr;

  const updatedContent = serializeFrontmatter(page.frontmatter, page.body);
  const summaryMatch = page.body.match(/^#\s+.+\n+(.+)/m);
  const summary = summaryMatch ? summaryMatch[1].slice(0, 120) : slug;

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: updatedContent,
    summary,
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(
        `auto-fix: extended expiry to ${expiryStr}, verified as of ${validFromStr}`,
        triggeredBy,
      ),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });

  return {
    success: true,
    slug,
    message: `Expiry extended to ${expiryStr}, verified as of ${validFromStr}`,
  };
}

// ---------------------------------------------------------------------------
// Unmigrated-page fix — adds sensible work-wiki defaults to pre-Phase-1 pages.
// ---------------------------------------------------------------------------

/**
 * Fix an unmigrated-page lint issue by adding sensible work-wiki defaults.
 *
 * Adds only missing fields — never overwrites existing ones:
 * - `confidence: 0.5` (moderate default)
 * - `expiry: <90 days from now>` (reasonable review interval)
 * - `authors: ["system"]` (migrated by automation)
 * - `contributors: []` (empty)
 * - `disputed: false`
 *
 * Does NOT add `supersedes` or `aliases` — those are page-specific with no
 * sensible default.
 */
export async function fixUnmigratedPage(
  slug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }

  const page = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  const fm = page.frontmatter;
  const added: string[] = [];

  // 90 days from now as ISO date
  const now = new Date();
  const defaultExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  if (!("confidence" in fm)) {
    fm.confidence = 0.5;
    added.push("confidence");
  }
  if (!("expiry" in fm)) {
    fm.expiry = defaultExpiry;
    added.push("expiry");
  }
  if (!("authors" in fm)) {
    fm.authors = ["system"];
    added.push("authors");
  }
  if (!("contributors" in fm)) {
    fm.contributors = [];
    added.push("contributors");
  }
  if (!("disputed" in fm)) {
    fm.disputed = false;
    added.push("disputed");
  }
  if (!("valid_from" in fm)) {
    // For unmigrated pages, use the page's created/updated date as a best guess
    // for when the content was last verified. Falls back to today.
    const createdRaw = fm.created;
    const updatedRaw = fm.updated;
    const bestGuess =
      typeof updatedRaw === "string" && updatedRaw.length >= 10
        ? updatedRaw.slice(0, 10)
        : typeof createdRaw === "string" && createdRaw.length >= 10
          ? createdRaw.slice(0, 10)
          : now.toISOString().split("T")[0];
    fm.valid_from = bestGuess;
    added.push("valid_from");
  }

  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: serializeFrontmatter(fm, page.body),
    summary: (() => {
      const m = page.body.match(/^#\s+.+\n+(.+)/m);
      return m ? m[1].slice(0, 120) : slug;
    })(),
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(
        added.length > 0
          ? `auto-fix: added work-wiki defaults: ${added.join(", ")}`
          : `auto-fix: unmigrated page already has all work-wiki fields`,
        triggeredBy,
      ),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });

  return {
    success: true,
    slug,
    message: added.length > 0
      ? `Added work-wiki defaults: ${added.join(", ")}`
      : `Page already has all work-wiki fields — no changes needed`,
  };
}

/**
 * Fix a supersedes-dangling issue by CLEARING the dead reference — the page's
 * `supersedes` points at a slug that no longer exists, so the pointer is stale.
 * Re-verifies the target is still missing before clearing (idempotent / safe
 * under queue retry), so a now-valid reference is never dropped.
 */
export async function fixSupersededDangling(
  slug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  if (!slug) {
    throw new FixValidationError("Missing required field: slug");
  }
  const page = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
  if (!page) {
    throw new FixNotFoundError(`Page not found: ${slug}`);
  }

  const supersedes = page.frontmatter.supersedes;
  if (typeof supersedes !== "string" || supersedes === "") {
    return { success: false, slug, message: `No supersedes field to fix on "${slug}"` };
  }
  // Don't clear a reference that has since become valid.
  if (await readWikiPageWithFrontmatter(supersedes, { fresh: true, strict: true })) {
    return {
      success: false,
      slug,
      message: `supersedes target "${supersedes}" now exists — nothing to fix`,
    };
  }

  const fm = { ...page.frontmatter };
  delete fm.supersedes;
  await writeWikiPageWithSideEffects({
    slug,
    title: page.title,
    content: serializeFrontmatter(fm, page.body),
    summary: (() => {
      const m = page.body.match(/^#\s+.+\n+(.+)/m);
      return m ? m[1].slice(0, 120) : slug;
    })(),
    logOp: "edit",
    logDetails: () =>
      withTriggeredBy(`auto-fix: cleared dangling supersedes "${supersedes}"`, triggeredBy),
    crossRefSource: null,
    author,
    expectedContent: page.content,
  });

  return {
    success: true,
    slug,
    message: `Cleared dangling supersedes "${supersedes}" from "${slug}"`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Everything a handler may need; each one takes only the parts it uses. */
interface FixRequest {
  slug: string;
  targetSlug?: string;
  message?: string;
  author: string;
  /** Handle of whoever asked; log-line only. See the DW-447 note at the top. */
  triggeredBy?: string;
}

type FixHandler = (request: FixRequest) => Promise<FixResult>;

/**
 * The dispatch table, keyed by `AUTO_FIXABLE_CHECK_TYPES`.
 *
 * `Record<AutoFixableCheckType, …>` is exhaustive AND closed: a type listed in
 * `./lint-types` with no entry here fails to compile, and an entry here that the
 * const does not name fails too. That is what stops `@/components/LintIssueCard`
 * — which reads the same const to decide whether to draw a Fix button — from
 * drifting behind this table again (DW-229).
 */
const FIX_HANDLERS: Record<AutoFixableCheckType, FixHandler> = {
  "orphan-page": ({ slug, author, triggeredBy }) => fixOrphanPage(slug, author, triggeredBy),
  "stale-index": ({ slug, author, triggeredBy }) => fixStaleIndex(slug, author, triggeredBy),
  "empty-page": ({ slug, author, triggeredBy }) => fixEmptyPage(slug, author, triggeredBy),
  "missing-crossref": ({ slug, targetSlug, author, triggeredBy }) =>
    fixMissingCrossRef(slug, targetSlug ?? "", author, triggeredBy),
  "contradiction": ({ slug, targetSlug, message, author, triggeredBy }) =>
    fixContradiction(slug, targetSlug ?? "", message ?? "", author, triggeredBy),
  "missing-concept-page": ({ message, author, triggeredBy }) =>
    fixMissingConceptPage(message ?? "", author, triggeredBy),
  "broken-link": ({ slug, targetSlug, author, triggeredBy }) =>
    fixBrokenLink(slug, targetSlug ?? "", author, triggeredBy),
  "stale-page": ({ slug, author, triggeredBy }) => fixStalePage(slug, author, triggeredBy),
  "unmigrated-page": ({ slug, author, triggeredBy }) =>
    fixUnmigratedPage(slug, author, triggeredBy),
  // Auto-fixable: clear the dead reference (re-verified missing first).
  "supersedes-dangling": ({ slug, author, triggeredBy }) =>
    fixSupersededDangling(slug, author, triggeredBy),
};

/**
 * Why each remaining check type has no auto-fix, in the words the caller sees.
 *
 * `Exclude<LintIssue["type"], AutoFixableCheckType>` is the exact complement of
 * the table above, so a new check type added to `ALL_CHECK_TYPES` must land in
 * one map or the other — there is no way to add one and have it quietly fall
 * through to the generic "not supported" text below.
 */
const NOT_AUTO_FIXABLE: Record<
  Exclude<LintIssue["type"], AutoFixableCheckType>,
  (slug: string) => string
> = {
  "low-confidence": () =>
    "Low-confidence pages cannot be auto-fixed. Ingest additional sources about this topic to improve confidence.",
  // Full auto-fix would require LLM-driven citation generation — out of scope.
  // Users should ingest a source URL or add inline citations manually.
  "uncited-claims": () =>
    "Uncited-claims pages cannot be auto-fixed. Ingest a source URL for this topic or add inline citations manually.",
  "duplicate-entity": () =>
    "Duplicate entities require human judgment to merge. Review the alias lists and decide which page to keep.",
  "incomplete-coverage": () =>
    "Incomplete coverage cannot be auto-fixed. Re-ingest the source URL to refresh the page content.",
  // Explicit, not a fall-through to the generic default: clearing `disputed`
  // asserts that a human read the conflicting claims and decided the page is
  // now correct. An auto-fix would clear the flag without that review, which
  // is exactly the state the flag exists to prevent.
  //
  // The manual path it hands back is `disputedClearGuidance` — the SAME clause
  // the `disputed-page` issue's own `suggestion` carries (`./lint-checks`), so
  // a caller that refuses here and a caller reading the issue are told one
  // thing. Both used to spell the PATCH out separately, and both spelled it out
  // as if any owner could run it; DW-121 made that metadata write admin- or
  // service-only on a public knowledge page, and correcting one copy would have
  // left the other still wrong (DW-389).
  "disputed-page": (slug) =>
    `Disputed pages cannot be auto-fixed. Reconcile the conflicting claims in "${slug}", then ${disputedClearGuidance(slug)}.`,
};

/**
 * Look `type` up: own properties only, and only if it is really a string.
 *
 * The declared `string` is a claim, not a fact. The three doors each gate `type`
 * themselves now (DW-348) — this used to be the ONLY gate, back when
 * `src/app/api/lint/fix/route.ts` destructured `type` straight off an
 * unvalidated `await req.json()` — but the doors are not the only callers, and
 * no two callers gate alike. `runLint`'s `--fix` loop in `src/cli.ts` hands the
 * dispatcher `issue.type` for EVERY issue the scan emitted, the five
 * non-fixable types included, and leans on the throw below to count them
 * `failed`. `POST /api/tasks/run`'s `maintain:fix` branch IS gated — `parseTask`
 * rejects the task outright before the call — but against `MAINTAIN_FIX_TYPES`,
 * a different and narrower list than the `AUTO_FIXABLE_CHECK_TYPES` the doors
 * enforce. So no one list is checked on every path in, and the declared
 * `string` stays a compile-time claim about a value that can still be any
 * shape.
 * Two ways that bites a table lookup, and the `switch (type)` this replaced was
 * immune to both because `case` compares with `===`:
 *
 *  1. The PROTOTYPE CHAIN. A bare `FIX_HANDLERS[type]` answers `"constructor"`,
 *     `"toString"` and every other `Object.prototype` member with an inherited
 *     function — truthy, and then called.
 *  2. COERCION. `hasOwnProperty.call(table, key)` runs `key` through
 *     `ToPropertyKey`, so the array `["orphan-page"]` stringifies to
 *     `"orphan-page"` and a POST of `{"type":["orphan-page"]}` would dispatch a
 *     real page mutation. The `typeof` guard is what restores strict equality's
 *     behaviour here: a non-string answers `null` and falls through to the
 *     generic rejection, exactly as it did before.
 *
 * `hasOwnProperty.call` rather than `Object.hasOwn` because the build targets
 * ES2018.
 */
function ownEntry<T>(table: Record<string, T>, key: string): T | null {
  if (typeof key !== "string") return null;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/** The answer for a type no check ever emits — unrecognized, so unexplainable. */
const AUTO_FIX_UNSUPPORTED = "Auto-fix not supported for this issue type";

/**
 * Why this `type` cannot be auto-fixed, or `null` when it can be.
 *
 * ONE OWNER FOR THE REFUSAL SENTENCES, two callers: `POST /api/lint/fix` and
 * `mcp-http.ts`'s `fix_lint_issue`. Both need to refuse a bad `type` BEFORE
 * {@link fixLintIssue} runs — the route parsed an unvalidated body straight into
 * the dispatcher, and the HTTP MCP transport validates `tools/call` arguments
 * not at all, so `ownEntry` below was the only thing standing between a
 * caller's JSON and the handler table (DW-348). A gate at each door that
 * re-typed "Disputed pages cannot be auto-fixed…" would be two more hand-copied
 * restatements of prose `lint-types.ts` went to some trouble to give a single
 * home; the doors call this instead.
 *
 * THE STDIO SERVER IS THE EXCEPTION, and does not call this. `src/mcp.ts`
 * registers `fix_lint_issue` with `z.enum(AUTO_FIXABLE_CHECK_TYPES)`, so the
 * SDK refuses a bad type before the handler is even entered — there is no point
 * in the request at which a gate of ours could run. Its tool description points
 * the agent at the issue `suggestion` instead, which carries the same guidance
 * with the slug already interpolated.
 *
 * `type` is `unknown` on purpose: every caller receives it from the wire, where
 * the declared `string` is a claim rather than a fact. A non-string is
 * unrecognized, exactly as `ownEntry`'s `typeof` guard already made it.
 *
 * `slug` is interpolated by the `disputed-page` explanation into a
 * copy-pasteable PATCH, so a door with no usable slug should pass `""` rather
 * than invent one.
 */
export function autoFixRefusal(type: unknown, slug: string): string | null {
  if (typeof type !== "string") return AUTO_FIX_UNSUPPORTED;
  if (ownEntry<FixHandler>(FIX_HANDLERS, type)) return null;

  const explain = ownEntry<(slug: string) => string>(NOT_AUTO_FIXABLE, type);
  return explain ? explain(slug) : AUTO_FIX_UNSUPPORTED;
}

/**
 * Dispatch a lint-fix request to the appropriate handler based on issue type.
 *
 * Keeps `type: string` — the gate belongs at the doors, and this stays the
 * defense that runs whichever door (or in-process caller) got here.
 *
 * `author` keeps its `"lint-fix"` default and every door leaves it there;
 * `triggeredBy` is the trailing, optional handle of whoever asked. See the
 * DW-447 note at the top of this file for why they are two parameters.
 *
 * @throws {FixValidationError} for missing fields or unsupported types
 * @throws {FixNotFoundError} when a required page doesn't exist
 */
export async function fixLintIssue(
  type: string,
  slug: string,
  targetSlug?: string,
  message?: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  const handler = ownEntry<FixHandler>(FIX_HANDLERS, type);
  if (handler) {
    return handler({ slug, targetSlug, message, author, triggeredBy });
  }

  // `autoFixRefusal` answers `null` only when a handler exists, which the branch
  // above has already ruled out; the `??` is a type narrowing, not a fallback.
  throw new FixValidationError(autoFixRefusal(type, slug) ?? AUTO_FIX_UNSUPPORTED);
}
