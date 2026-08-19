import type { LintIssue } from "./types";

/**
 * The single runtime declaration of the lint check-type list.
 *
 * This module exists so that the list has exactly ONE home that both server
 * code (`./lint-checks`, `./lint`, the API route, the MCP servers) and client
 * code (`@/components/LintFilterControls`, `@/hooks/useLint`) can import.
 * `src/lib/lint-checks.ts` — the list's previous home — pulls in `./storage`,
 * `./llm` and `./wiki`, none of which can cross into a browser bundle, which
 * is why the lint UI used to keep a hand-copied second copy that drifted three
 * entries behind (DW-75). Every import here is type-only, so this module emits
 * no runtime dependency beyond the array itself.
 *
 * It is deliberately NOT a const added to `src/lib/types.ts`: that file is
 * declaration-only today (no imports, no value exports), and adding an emitted
 * value would change its character for every one of its importers.
 *
 * Declared as a const tuple so `z.enum(ALL_CHECK_TYPES)` keeps its literal
 * types, and `satisfies` so an entry that is not a real `LintIssue["type"]`
 * fails to compile.
 */
export const ALL_CHECK_TYPES = [
  "orphan-page",
  "stale-index",
  "empty-page",
  "missing-crossref",
  "broken-link",
  "contradiction",
  "missing-concept-page",
  "stale-page",
  "low-confidence",
  "unmigrated-page",
  "duplicate-entity",
  "uncited-claims",
  "supersedes-dangling",
  "incomplete-coverage",
  "disputed-page",
] as const satisfies readonly LintIssue["type"][];
