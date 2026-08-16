/**
 * Scenario Templates, projected for the Wiki entity.
 *
 * AD-10: the template prose has exactly ONE source —
 * {@link WORKSPACE_SCENARIO_TEMPLATES} in `workspace-profile-schema.ts`. This
 * module never re-authors it; it only renders that data into the two markdown
 * artifacts a Wiki is seeded with (`purpose.md`, `schema.md`) and owns the one
 * label map the picker and the Settings form share.
 *
 * Pure and client-safe (no storage, no `node:` imports) so the Create Wiki
 * dialog can import it directly.
 */

import {
  WORKSPACE_SCENARIO_TEMPLATES,
  type WorkspaceScenario,
  type WorkspaceScenarioTemplate,
} from "./workspace-profile-schema";

/**
 * A scenario a Wiki can actually be created from. `custom` is deliberately
 * excluded: FR-38 / UX-DR19 say there is no blank Wiki, so the picker offers
 * exactly five choices and the input parsers reject anything else.
 */
export type CreatableScenario = Exclude<WorkspaceScenario, "custom">;

/**
 * The five creatable Scenario Templates, in the order the AC lists them.
 * This array is the picker's source of truth — nothing else enumerates them.
 */
export const CREATABLE_SCENARIOS: readonly CreatableScenario[] = [
  "research",
  "reading",
  "personal-growth",
  "business",
  "general",
] as const;

/**
 * The single label map. The five AC labels plus `custom` for the pre-existing
 * Workspace Purpose settings form, which still lets an owner hand-author a
 * profile that matches no template.
 */
export const SCENARIO_LABELS: Record<WorkspaceScenario, string> = {
  research: "Research",
  reading: "Reading",
  "personal-growth": "Personal Growth",
  business: "Business",
  general: "General",
  custom: "Custom",
};

/**
 * The two markdown artifacts a Wiki is seeded with. Lives here, not in the
 * server module, so the workbench can list them without importing storage.
 */
export const WIKI_ARTIFACT_FILES = ["purpose.md", "schema.md"] as const;
export type WikiArtifactFile = (typeof WIKI_ARTIFACT_FILES)[number];

/**
 * The artifacts an owner may EDIT from the Preview (Story 1.8) — a strict
 * subset of {@link WIKI_ARTIFACT_FILES}, and today exactly one.
 *
 * `schema.md` is executable: `loadPageConventions()` reads the active Wiki's
 * copy and hands its `## Page conventions` body to every ingest, chat and lint
 * prompt, so editing it changes behaviour with no deploy. `purpose.md` has no
 * runtime reader at all and its content overlaps the tenant-global workspace
 * profile, whose reconciliation is an open design decision — so it stays
 * read-only until whichever story owns that decision. Adding it is one entry
 * here, which is the whole point of the list being named.
 *
 * Declared in THIS module rather than in `wikis.ts` because both the browser
 * (`workbench-preview.ts`, which the Preview column imports) and the write
 * route have to name it, and `wikis.ts` would drag the storage provider into
 * the client chunk.
 */
export const EDITABLE_ARTIFACT_FILES = ["schema.md"] as const;
export type EditableArtifactFile = (typeof EDITABLE_ARTIFACT_FILES)[number];

/**
 * Whether a value names the one artifact the Preview may write.
 *
 * Takes `unknown` on purpose: it is the write route's allowlist over a raw
 * query parameter as well as the payload check the column runs, so it must
 * refuse a number, an array and `undefined` without a caller narrowing first.
 */
export function isEditableArtifactFile(value: unknown): value is EditableArtifactFile {
  return (
    typeof value === "string" &&
    (EDITABLE_ARTIFACT_FILES as readonly string[]).includes(value)
  );
}

/** Longest accepted Wiki name — shared by the input parser and the dialog. */
export const MAX_WIKI_NAME_CHARS = 80;

/** Whether a value names one of the five creatable scenarios. */
export function isCreatableScenario(value: unknown): value is CreatableScenario {
  return (
    typeof value === "string" &&
    (CREATABLE_SCENARIOS as readonly string[]).includes(value)
  );
}

/** The template data behind a creatable scenario. */
export function scenarioTemplate(
  scenario: CreatableScenario,
): WorkspaceScenarioTemplate {
  return WORKSPACE_SCENARIO_TEMPLATES[scenario];
}

function bullets(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

/**
 * Render a Wiki's `purpose.md` from its name and Scenario Template.
 *
 * Every section is projected from the template record, so two Wikis seeded
 * from different templates get genuinely different purpose files.
 */
export function renderPurposeMarkdown(
  name: string,
  template: WorkspaceScenarioTemplate,
): string {
  return [
    `# ${name}`,
    "",
    `Scenario Template: ${SCENARIO_LABELS[template.scenario]} — ${template.description}`,
    "",
    "## Purpose",
    "",
    template.purpose,
    "",
    "## Key questions",
    "",
    bullets(template.keyQuestions),
    "",
    "## In scope",
    "",
    bullets(template.inScope),
    "",
    "## Out of scope",
    "",
    bullets(template.outOfScope),
    "",
    "## Output language",
    "",
    template.outputLanguage,
    "",
  ].join("\n");
}

/**
 * Render a Wiki's `schema.md` from its Scenario Template.
 *
 * The file is SELF-CONTAINED: `engineConventions` is the body of the repo-root
 * `SCHEMA.md`'s `## Page conventions` — the slug rule, the H1 and summary
 * rules, the `[Title](other-slug.md)` cross-reference form the graph builder
 * needs, the `index.md`/`log.md` rules, the frontmatter table — and it is
 * composed in FIRST, with the scenario's guidance layered after it. Activating
 * a Wiki must add scenario direction, never subtract the engine's structural
 * contract from the prompt.
 *
 * The `## Page conventions` heading is load-bearing: `extractSection` matches
 * on that exact literal, and this file is what `loadPageConventions()` executes
 * once the Wiki is active. Everything the prompt should see therefore lives
 * inside that section, before the next `## ` heading — the engine's own
 * sub-headings are `###`, which does not terminate the section.
 */
export function renderSchemaMarkdown(
  template: WorkspaceScenarioTemplate,
  engineConventions: string,
): string {
  const label = SCENARIO_LABELS[template.scenario];
  return [
    `# Schema — ${label}`,
    "",
    `Seeded from the ${label} Scenario Template. This file is executable: its Page conventions section is loaded into ingest, chat, and lint prompts at runtime.`,
    "",
    "## Page conventions",
    "",
    ...(engineConventions ? [engineConventions, ""] : []),
    `### Scenario conventions — ${label}`,
    "",
    template.pageConventions,
    "",
    `Write pages in ${template.outputLanguage}.`,
    "",
    "Keep in scope:",
    "",
    bullets(template.inScope),
    "",
    "Leave out:",
    "",
    bullets(template.outOfScope),
    "",
    "## Key questions",
    "",
    bullets(template.keyQuestions),
    "",
  ].join("\n");
}
