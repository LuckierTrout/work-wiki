import {
  PAGE_CONVENTIONS_HEADING,
  extractSection,
  readSchemaFile,
  rootSchemaPath,
  sectionBody,
} from "./schema-source";
import { readActiveWikiSchema } from "./wikis";

/**
 * Load the "Page conventions" section from the active Schema.
 *
 * With no explicit path this prefers the ACTIVE WIKI's seeded `schema.md`
 * (Story 1.2 / AD-10: the Schema a Scenario Template seeds must be the Schema
 * that executes — one loader, no forked copy of the conventions in code). A
 * seeded `schema.md` embeds the engine's own conventions before the scenario's,
 * so nothing the ingest, chat, and lint prompts rely on is lost by activating a
 * Wiki — see `readEnginePageConventions` in `schema-source.ts`.
 *
 * Falls back to the repo-root `SCHEMA.md` when there is no owner, no Wiki, an
 * unreadable Wiki file, OR when the Wiki's file yields an EMPTY conventions
 * section — a hand-emptied `schema.md` must not silently strip the prompt.
 *
 * Note what this means for the repo-root file: it is the source of truth only
 * while no Wiki is active. A seeded `schema.md` embeds a SNAPSHOT of the root
 * conventions taken at seed time, so once a Wiki exists, editing `SCHEMA.md`
 * changes {@link loadPageTemplates} on the next call but NOT the conventions
 * this returns — re-applying the Wiki's Scenario Template re-seeds them. The
 * Wiki's own `schema.md` is the doc to edit (Story 1.8).
 *
 * Extracts from the `## Page conventions` heading up to (but not including)
 * the next `## ` heading. Returns empty string if SCHEMA.md is missing or
 * the section can't be found, so ingest degrades gracefully rather than
 * crashing on a fresh clone.
 *
 * TENANCY (DW-19): the no-argument form is DEPLOYMENT-GLOBAL, not per-caller. It
 * resolves the active Wiki via {@link readActiveWikiSchema}, which reads the
 * site owner from `NEXT_PUBLIC_OWNER_HANDLE` — so every caller gets the SITE
 * OWNER's conventions, whoever they are. That is correct only while work-wiki
 * is a single-owner deployment. Adding a second tenant means adding a tenant
 * parameter here and threading it into `readActiveWikiSchema()`, then passing
 * it at all four no-argument call sites (`query.ts`, `ingest.ts`, and both
 * `lint-checks.ts` detectors). See the invariant on `readActiveWikiSchema` in
 * `wikis.ts` and the pins in `src/lib/__tests__/wiki-schema-source.test.ts`.
 * The existing `schemaPath` argument is NOT that parameter and must not be
 * pressed into service as one: it names a file and bypasses tenant resolution
 * entirely, which is why it stays a test-only override.
 *
 * Accepts an optional `schemaPath` override for tests; defaults to
 * `<cwd>/SCHEMA.md`.
 */
export async function loadPageConventions(
  schemaPath?: string,
): Promise<string> {
  if (!schemaPath) {
    const active = await readActiveWikiSchema();
    if (active) {
      const section = extractSection(active, PAGE_CONVENTIONS_HEADING);
      // A heading with no body is worse than useless: it would hand the
      // prompt an empty contract. Check the BODY, not the section, because
      // the section always contains at least the heading line itself.
      if (sectionBody(section)) return section;
    }
  }
  const schema = await readSchemaFile(schemaPath ?? rootSchemaPath());
  if (!schema) return "";
  return extractSection(schema, PAGE_CONVENTIONS_HEADING);
}

/**
 * Load the "Page templates" section from `SCHEMA.md`.
 *
 * Returns the full `## Page templates` section including sub-headings
 * (source summary, entity page, concept page, comparison page).
 * This allows ingest and query prompts to load templates at runtime so
 * the LLM can generate pages that follow the documented structure.
 *
 * Returns empty string if SCHEMA.md is missing or the section can't be
 * found, so callers degrade gracefully.
 *
 * Unlike {@link loadPageConventions} this ALWAYS reads the repo-root
 * `SCHEMA.md`: page templates are the wiki engine's own output shapes, a
 * different concept from a Wiki's Scenario Template, and a seeded `schema.md`
 * carries no `## Page templates` section.
 *
 * Accepts an optional `schemaPath` override for tests; defaults to
 * `<cwd>/SCHEMA.md`.
 */
export async function loadPageTemplates(
  schemaPath?: string,
): Promise<string> {
  const schema = await readSchemaFile(schemaPath ?? rootSchemaPath());
  if (!schema) return "";
  return extractSection(schema, "## Page templates");
}
