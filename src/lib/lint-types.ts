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
 * no runtime dependency beyond its own declarations — the two arrays below and
 * {@link disputedClearGuidance}, which is here for the same one-home reason.
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
 * The ONE sentence that tells a reader how a `disputed` flag actually gets
 * cleared — and who is allowed to clear it.
 *
 * TWO SITES SAY THIS, and they used to say it separately: the `disputed-page`
 * issue's own `suggestion` (`./lint-checks`, which the stdio MCP server's
 * `fix_lint_issue` description points agents at) and the refusal
 * `fixLintIssue` throws when someone tries to auto-fix it (`./lint-fix`). Both
 * were written before DW-121 made the realm gate cover METADATA writes, so both
 * told every reader to go and run a `PATCH /api/wiki/<slug>` that
 * `canWritePage`'s realm branch now refuses for every non-admin, non-service
 * principal on a public knowledge page (DW-389). Correcting one and not the
 * other leaves half the instruction wrong, which is why the clause lives here,
 * in the client-safe module both server halves already import, rather than
 * being hand-copied a third time.
 *
 * THE QUALIFICATION IS BY PAGE CLASS, not a flat "you cannot do this". The
 * realm gate only covers what `belongsInCommons` selects — public,
 * non-agent-scoped, non-artifact pages. On a private, agent-scoped or artifact
 * page the owner's toggle still works exactly as it always did, so the sentence
 * says where the refusal applies instead of claiming the loop is shut.
 *
 * `slug` is interpolated into the PATCH so the path can be copy-pasted; a
 * caller with no usable slug should pass `""` rather than invent one, matching
 * `autoFixRefusal`'s contract.
 *
 * AND THAT EMPTY CASE DROPS THE PATCH ENTIRELY (DW-458). THREE callers really
 * do pass `""`: the HTTP door, where a body `{"type":"disputed-page"}` with no
 * slug falls to `autoFixRefusal(record.type, "")`
 * (`src/app/api/lint/fix/route.ts`); the HTTP MCP door's
 * `autoFixRefusal(a.type, slug ?? "")` (`src/lib/mcp-http.ts`); and the stdio
 * server's `handleFixLintIssue`, which passes `args.slug ?? ""` into
 * `fixLintIssue` and so reaches the same helper through that function's throw
 * (`src/mcp.ts`). The stdio path is the narrowest of the three — the registered
 * `fix_lint_issue` tool's `z.enum` is the FIXABLE subset, so the SDK refuses
 * `disputed-page` before the handler runs — but `handleFixLintIssue` is
 * exported and a direct call bypasses that schema entirely. Interpolating `""`
 * rendered
 * `PATCH /api/wiki/ with metadata …`, a request that 404s the moment anyone
 * pastes it. The whole reason the slug is interpolated is copy-pasteability, so
 * an un-pasteable path is worse than no path: with no slug the sentence names
 * the editor toggle, says nothing about a URL, and re-points the qualifier at
 * "that metadata write" so nothing dangles. The qualifier itself is ONE local
 * shared by both variants — it is the half DW-121/DW-389 corrected, and two
 * copies of it is how the correction would rot.
 */
export function disputedClearGuidance(slug: string): string {
  const qualifier =
    `admin- or service-only, so an owner who is ` +
    `not an admin has to ask one to clear the flag`;
  if (!slug) {
    return (
      `clear the Disputed toggle in the page editor — on a public ` +
      `knowledge page that metadata write is ${qualifier}`
    );
  }
  return (
    `clear the Disputed toggle in the page editor ` +
    `(PATCH /api/wiki/${slug} with metadata { disputed: false }) — on a public ` +
    `knowledge page that PATCH is ${qualifier}`
  );
}
