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
 * entries behind (DW-75). Every import here is type-only, so this module's only
 * runtime output is its own value exports — the two check-type arrays and
 * {@link disputedClearInstruction} — and no dependency travels with them.
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

/**
 * How a reader clears a page's `disputed` flag — ONE sentence, two surfaces.
 *
 * `checkDisputedPages` (`./lint-checks`) puts it in the issue's `suggestion`
 * and `NOT_AUTO_FIXABLE["disputed-page"]` (`./lint-fix`) puts it in the
 * `FixValidationError` the auto-fix refusal throws. Both used to spell it out
 * themselves, and both spelled it out WRONG in the same way (DW-389): they
 * named the Disputed toggle — a `PATCH /api/wiki/<slug>` metadata write — as
 * the clear path, full stop. Since DW-121 `canWritePage`'s realm branch refuses
 * EVERY write kind, `"metadata"` included, on a public knowledge page, so on
 * exactly the pages ingest flags most often the loop the copy described is one
 * the reader cannot complete. Naming who *can* complete it is the difference
 * between a suggestion and a dead end.
 *
 * ONE OWNER, NOT TWO CORRECTED COPIES. The two sites drifted together into the
 * same error because each was a hand-typed restatement of the same fact; fixing
 * both in place would leave the same two copies to drift again. They now read
 * this function, and `lint-checks.test.ts`/`lint-fix.test.ts` assert each
 * surface contains its output verbatim, so a future edit either moves both or
 * fails.
 *
 * WHY IT ECHOES `WRITE_DENIAL_REALM` RATHER THAN IMPORTING IT. That table
 * (`./write-denial`) is the canonical phrasing — "Only an agent or a site admin
 * can …" — but it reaches `./authz` → `./commons` → storage, locks and
 * `./wiki`, and THIS module is the one `@/components/LintIssueCard` imports
 * from the browser. Duplicating the clause is the same trade `read-only.ts`'s
 * client mirrors make next to their components: a copied sentence beats a
 * server-only import in a `"use client"` graph.
 *
 * WHY THE REFERRAL IS CONDITIONAL, NOT ADVICE. `checkDisputedPages` fires for
 * EVERY page carrying `disputed: true`, and the realm covers only public
 * knowledge pages — `belongsInCommons` excludes private pages, artifacts and
 * agent-scoped pages, on which the owner's own PATCH is admitted exactly as it
 * always was. So the sentence scopes both halves to that class ("on a public
 * knowledge page…", "so on such a page, ask one of them"); an unconditional
 * "ask an agent or a site admin" would send a private-vault owner off to
 * request a write they can already make themselves.
 *
 * It stays a SINGLE sentence for every page rather than branching on the actual
 * frontmatter: `NOT_AUTO_FIXABLE` handlers receive only a slug, and a clause
 * that took a page would stop being the one string both sites can share — which
 * is the property that keeps them from drifting.
 *
 * The slug is interpolated, not left as a `<slug>` placeholder, so the PATCH is
 * copy-pasteable as written.
 */
export function disputedClearInstruction(slug: string): string {
  return `clear the Disputed toggle in the page editor (PATCH /api/wiki/${slug} with metadata { disputed: false }). On a public knowledge page that metadata write is refused — only an agent or a site admin can clear the flag there — so on such a page, ask one of them once the claims are reconciled.`;
}
