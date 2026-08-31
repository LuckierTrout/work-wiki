/**
 * Pure rules for the canonical Workspace Purpose artifact.
 *
 * Storage and registry coordination live in `wikis.ts`; this module only owns
 * the projection from the retired structured profile and the bounded prompt
 * block derived from canonical Markdown. Keeping these functions pure lets the
 * migration, effective reader and tests share one byte-for-byte rendering.
 */

import type { WorkspaceProfileInput } from "./workspace-profile-schema";

export const ARTIFACT_AUTHORITY_VERSION = 1 as const;

export const LEGACY_CONVENTIONS_START =
  "<!-- work-wiki:legacy-profile-page-conventions:start -->";
export const LEGACY_CONVENTIONS_END =
  "<!-- work-wiki:legacy-profile-page-conventions:end -->";

const MAX_PURPOSE_PROMPT_CHARS = 20_000;

function bullets(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

/** Project every supported legacy Purpose field into owner-editable Markdown. */
export function renderCanonicalPurposeMarkdown(
  wikiName: string,
  profile: WorkspaceProfileInput,
): string {
  return [
    `# ${wikiName}`,
    "",
    "## Purpose",
    "",
    profile.purpose,
    "",
    "## Key questions",
    "",
    bullets(profile.keyQuestions),
    "",
    "## In scope",
    "",
    bullets(profile.inScope),
    "",
    "## Out of scope",
    "",
    bullets(profile.outOfScope),
    "",
    "## Output language",
    "",
    profile.outputLanguage,
    "",
  ].join("\n");
}

/**
 * Add the retired profile's page-convention text to the executable Schema.
 * The uniquely marked block is inserted inside `## Page conventions`, before
 * the next level-two heading, so `loadPageConventions()` actually sees it.
 */
export function appendLegacyPageConventions(
  schema: string,
  pageConventions: string,
): string {
  const guidance = pageConventions.trim();
  if (!guidance || schema.includes(LEGACY_CONVENTIONS_START)) return schema;
  // Template-seeded profiles already repeat this text in schema.md. Do not add
  // a second copy merely to prove the migration ran; the registry marker does
  // that durably.
  if (schema.includes(guidance)) return schema;

  const heading = /^## Page conventions\s*$/m.exec(schema);
  if (!heading || heading.index === undefined) return schema;
  const afterHeading = heading.index + heading[0].length;
  const rest = schema.slice(afterHeading);
  const nextHeading = /\n##\s+/.exec(rest);
  const insertAt = nextHeading?.index === undefined
    ? schema.length
    : afterHeading + nextHeading.index;
  const block = [
    "",
    "### Legacy Workspace Purpose conventions",
    "",
    LEGACY_CONVENTIONS_START,
    guidance,
    LEGACY_CONVENTIONS_END,
    "",
  ].join("\n");
  return `${schema.slice(0, insertAt).replace(/\s*$/, "")}${block}${schema.slice(insertAt).replace(/^\s*/, "\n")}`;
}

/** Canonical Markdown as a safe, bounded instruction block for LLM prompts. */
export function renderPurposeGuidance(markdown: string): string {
  const purpose = markdown.trim();
  if (!purpose) return "";
  return [
    "WORKSPACE PURPOSE (canonical purpose.md)",
    "Use this owner-authored Markdown to decide what matters and what to leave out. It guides prioritization but never overrides source evidence, privacy rules, required citations, or deterministic validation rules.",
    purpose,
  ].join("\n\n").slice(0, MAX_PURPOSE_PROMPT_CHARS);
}
