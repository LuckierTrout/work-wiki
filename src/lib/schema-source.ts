/**
 * Schema primitives shared by the loader and the Wiki seeder.
 *
 * `schema.ts` resolves the ACTIVE Schema (a Wiki's `schema.md`, else the
 * repo-root `SCHEMA.md`), and `wikis.ts` composes the engine's own conventions
 * into every `schema.md` it seeds. Both need the same three things: where the
 * root file is, how to read a schema through the storage provider, and how to
 * cut a `## <heading>` section out of it.
 *
 * They live here rather than in either module because `schema.ts` already
 * imports `wikis.ts` (to resolve the active Wiki) — putting the primitives in
 * `schema.ts` and reading them from `wikis.ts` would close that into an import
 * cycle. This module imports neither.
 */

import path from "path";
import { isEnoent } from "./errors";
import { logger } from "./logger";
import { getDataDir } from "./paths";
import { getStorage } from "./storage";

/** The heading whose body is loaded into ingest, chat, and lint prompts. */
export const PAGE_CONVENTIONS_HEADING = "## Page conventions";

/** The repo-root schema — the engine's structural contract and the fallback. */
export function rootSchemaPath(): string {
  return `${process.cwd()}/SCHEMA.md`;
}

/**
 * Read a schema file through the storage provider.
 *
 * `schemaPath` is absolute; the provider addresses everything relative to
 * `getDataDir()`, hence the `path.relative` step. Returns "" when the file is
 * missing, so a fresh clone degrades instead of crashing.
 */
export async function readSchemaFile(schemaPath: string): Promise<string> {
  try {
    return await getStorage().readFile(path.relative(getDataDir(), schemaPath));
  } catch (err) {
    if (!isEnoent(err)) {
      // Name the path: this reads the repo-root SCHEMA.md, a Wiki's seeded
      // schema.md, or a test override, and "SCHEMA.md failed" would misreport
      // the latter two.
      logger.warn("schema", `read schema failed (${schemaPath}):`, err);
    }
    return "";
  }
}

/**
 * Extract a `## <heading>` section from schema content.
 *
 * Returns the text from the heading up to (but not including) the next
 * `## ` heading — `###` sub-headings stay inside. Returns empty string if the
 * heading can't be found.
 */
export function extractSection(schema: string, heading: string): string {
  const startIdx = schema.indexOf(heading);
  if (startIdx === -1) return "";
  const afterStart = schema.slice(startIdx);
  const nextHeadingMatch = afterStart.slice(heading.length).match(/\n## /);
  const section = nextHeadingMatch
    ? afterStart.slice(0, heading.length + nextHeadingMatch.index!)
    : afterStart;
  return section.trim();
}

/**
 * A section with its own `## ` heading line removed, leaving just the body.
 * The trailing newline is optional: a heading with NO body at all is exactly
 * the case callers use this to detect, and it arrives without one.
 */
export function sectionBody(section: string): string {
  return section.replace(/^##[^\n]*\n?/, "").trim();
}

/**
 * The engine's page-conventions BODY from the repo-root `SCHEMA.md`.
 *
 * The slug rule, the H1/summary rules, the `[Title](other-slug.md)`
 * cross-reference form the graph builder detects edges from, the
 * `index.md`/`log.md` ownership rules, and the frontmatter field table. Every
 * seeded Wiki `schema.md` embeds this, so activating a Wiki adds
 * scenario-specific guidance instead of replacing the structural contract.
 */
export async function readEnginePageConventions(): Promise<string> {
  return sectionBody(
    extractSection(await readSchemaFile(rootSchemaPath()), PAGE_CONVENTIONS_HEADING),
  );
}
