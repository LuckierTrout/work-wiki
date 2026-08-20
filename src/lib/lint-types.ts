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

/**
 * The check types `fixLintIssue` (`./lint-fix`) actually dispatches to a handler.
 *
 * Same reason this module exists at all: `./lint-fix` imports `./wiki`,
 * `./lifecycle` and `./llm`, so `@/components/LintIssueCard` — which has to know
 * whether to render a Fix button — could never import the dispatcher and kept a
 * hand-copied nine-entry set instead. It fell one entry behind
 * (`supersedes-dangling` is auto-fixed by `fixSupersededDangling`, yet its card
 * showed no button, DW-229), and nothing observed it: a missing button looks the
 * same as a check nobody can fix.
 *
 * This const is not a fourth copy of the dispatch table, it IS its shape:
 * `lint-fix.ts` builds `Record<AutoFixableCheckType, FixHandler>` and
 * `Record<Exclude<LintIssue["type"], AutoFixableCheckType>, …>` from it, so an
 * entry here without a handler — or a handler without an entry — fails to
 * compile, and a new `ALL_CHECK_TYPES` member cannot land without an explicit
 * fixable-or-not decision.
 *
 * The five types deliberately absent (`low-confidence`, `uncited-claims`,
 * `duplicate-entity`, `incomplete-coverage`, `disputed-page`) need human
 * judgement; `lint-fix.ts` rejects each with its own explanatory message.
 */
export const AUTO_FIXABLE_CHECK_TYPES = [
  "orphan-page",
  "stale-index",
  "empty-page",
  "missing-crossref",
  "broken-link",
  "contradiction",
  "missing-concept-page",
  "stale-page",
  "unmigrated-page",
  "supersedes-dangling",
] as const satisfies readonly LintIssue["type"][];

/** A check type that `fixLintIssue` can resolve without a human. */
export type AutoFixableCheckType = (typeof AUTO_FIXABLE_CHECK_TYPES)[number];
