---
title: 'Lint check parity and a read model for the disputed flag'
type: 'bugfix'
created: '2026-08-19'
baseline_revision: '0bc55c1312fb0d0896cb693134f66a6ad88e2192'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      LintIssueCard's hand-copied `fixableTypes` set omits `supersedes-dangling`,
      so one of the ten auto-fixable lint checks renders with no Fix button.
    evidence: |-
      `src/components/LintIssueCard.tsx:25-35` lists nine types. `fixLintIssue`
      auto-fixes `supersedes-dangling` via `fixSupersededDangling`
      (`src/lib/lint-fix.ts:710-712`), and `SCHEMA.md` advertises it as one of
      the ten fixable checks. This is the same hand-copied-list drift class as
      DW-75, in the sibling list this story did not touch; nothing observes it.
    location: >-
      src/components/LintIssueCard.tsx:25
    severity: medium
  - summary: >-
      Disputed transitions still write talk reconciliation threads that no
      surface can read, since talk's HTTP routes are retired.
    evidence: |-
      `ensureReconciliationThread` (`src/lib/talk.ts:203-229`) is still called on
      every disputed false->true transition from `src/lib/ingest.ts`,
      `src/lib/merge.ts` and `src/lib/patch-metadata.ts:173-181`, while the talk
      HTTP surfaces 404 via `src/lib/retired.ts`. Threads accumulate on disk
      unreadable. Pre-existing and outside DW-75/DW-76, but it is the other half
      of the loop the DW-76 decision describes.
    location: >-
      src/lib/patch-metadata.ts:173
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `src/components/LintFilterControls.tsx:5-17` hand-copies `ALL_CHECK_TYPES` with only 11 entries while `src/lib/lint-checks.ts:15-30` defines 14, so `uncited-claims`, `supersedes-dangling` and `incomplete-coverage` can never be toggled in the lint UI (DW-75). Separately, the `disputed` frontmatter flag is one-way: ingest still sets it and `ArticleView` still renders the banner, but `checkDisputedPages` was deleted with the talk surface, so nothing lists disputed pages for an owner to act on (DW-76).

**Approach:** Extract the check-type list into one client-safe module both the lib and the UI import, so the UI list cannot drift again, and pin that with a mounted test. Then restore a talk-free `disputed-page` lint check that surfaces disputed pages and points at the per-page clear path that already exists (`WikiEditor` Disputed toggle → `PATCH /api/wiki/<slug>` metadata).

## Boundaries & Constraints

**Always:** Exactly one runtime declaration of the check-type list; every other module imports it. The new module stays pure (type-only imports) so a client component can import it without pulling `src/lib/storage` into the browser bundle. `disputed-page` is human-resolved: it gets an explicit non-auto-fix branch, never a silent fall-through. Keep runtime identifiers as-is per AGENTS.md.

**Block If:** Making the UI import a check-type list would require pulling a server-only module (storage, llm, wiki) into a client component — that means the seam is wrong, not that the constraint should be relaxed.

**Never:** Do not revive talk, `getDiscussionStats`, `unresolved-discussions`, or reconcile-from-talk. Do not add an auto-fix that clears `disputed` — clearing stays an owner decision. Do not touch the `## Page conventions` templates or prose in `SCHEMA.md` beyond the one `disputed` "Surfaced in" cell; that section is loaded into live LLM prompts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full toggle set | Lint page mounted with defaults | One toggle button per entry of `ALL_CHECK_TYPES`, including `uncited-claims`, `supersedes-dangling`, `incomplete-coverage`, `disputed-page` | No error expected |
| Disputed page present | Page frontmatter `disputed: true` | One `disputed-page` issue, severity `warning`, suggestion naming the clear path | No error expected |
| Not disputed | `disputed: false` or key absent | No `disputed-page` issue | No error expected |
| Unreadable page | Index entry with no readable page file | Skipped, other pages still checked | Skip, no throw |
| Check deselected | `lint({ checks: [] })` | `checkDisputedPages` not run, no `disputed-page` issues | No error expected |
| Auto-fix attempted | `POST /api/lint/fix` with `type: "disputed-page"` | `FixValidationError` naming the manual owner action | 400 with that message |

</intent-contract>

## Code Map

- `src/lib/types.ts:70` -- `LintIssue["type"]` union; add `"disputed-page"`. File is type-only and client-safe — keep it that way.
- `src/lib/lint-checks.ts:15-30` -- current `ALL_CHECK_TYPES` declaration to relocate. Module imports `./storage`, `./llm`, `./wiki` — NOT client-safe, which is why the const must move out.
- `src/lib/lint-checks.ts:678-696` -- `checkLowConfidence` is the shape to copy for `checkDisputedPages`: `listWikiPages()` → `readWikiPageWithFrontmatter(slug)` → `continue` on null → push issue.
- `src/lib/lint.ts:4-29,39-59,91-125,141` -- import list, re-export block, the lightweight `Promise.all` batch, and the concat. Wire `disputed-page` into all four. JSDoc at `:65` says "all 14".
- `src/lib/lint-fix.ts:677-721` -- `fixLintIssue` switch; `low-confidence`/`duplicate-entity`/`incomplete-coverage` are the precedent for a typed non-fixable branch.
- `src/components/LintFilterControls.tsx:5-17,19-34` -- the hand-copied const to delete; `checkTypeLabels` already carries all 14 labels and is `Record<LintIssue["type"], string>`, so the union addition compile-forces the new label. Export it so a test can assert label coverage.
- `src/hooks/useLint.ts:5-8,66,101,120` -- currently imports `ALL_CHECK_TYPES` from the component; repoint at the new module.
- `src/components/LintIssueCard.tsx:25-46` -- `fixableTypes` / `fixLabel`; leave both alone so `disputed-page` renders with a slug link and no Fix button.
- `src/lib/__tests__/lint-checks.test.ts:909-918` -- "retired discussion checks" pins `disputed-page` absent and length 14. Must be rewritten, not deleted: `unresolved-discussions` stays retired.
- `src/lib/__tests__/lint.test.ts:1-60` -- tmpdir + `_resetStorage()` harness and LLM mock to reuse for the dispatch test. Its `vi.mock("../talk")` is vestigial; leave it.
- `src/components/__tests__/*.test.tsx` -- mounted-suite home; `vitest.config.ts` `DOM_INCLUDE` only collects `src/**/__tests__/**/*.test.tsx`.
- `SCHEMA.md:71` (frontmatter table, inside `## Page conventions`), `SCHEMA.md:551-608` (`## Lint checks`), `SCHEMA.md:639-656` ("ten of fourteen", "four exceptions").
- `src/mcp.ts:3130`, `src/lib/mcp-http.ts:416` -- `scan_maintenance` descriptions claim it returns "disputed pages needing reconciliation"; `src/lib/maintenance.ts` has no such op (verified: only `unmigrated-page`, `supersedes-dangling`, `stale-page`, staleness, expiry). No test asserts these strings.
- Read-only evidence: `src/mcp.ts:1166,2411,2456` and `src/app/api/lint/route.ts:2-9,34` derive their validation and Zod enums from the lib const, so they pick up `disputed-page` with no edit.

## Tasks & Acceptance

**Execution:**
- `src/lib/types.ts` -- add `"disputed-page"` to the `LintIssue["type"]` union -- the union is the contract every other change type-checks against.
- `src/lib/lint-types.ts` (new) -- pure module exporting `ALL_CHECK_TYPES` as a const tuple `as const satisfies readonly LintIssue["type"][]`, with `disputed-page` added -- single declaration importable from both server and client.
- `src/lib/lint-checks.ts` -- delete the local declaration, re-export from `./lint-types`, add `checkDisputedPages()` -- keeps every existing `@/lib/lint-checks` importer working while removing the second copy.
- `src/lib/lint.ts` -- import, re-export, and dispatch `checkDisputedPages` in the lightweight batch; correct the "all 14" JSDoc -- an unwired check is invisible.
- `src/lib/lint-fix.ts` -- add a `disputed-page` case throwing `FixValidationError` that names the owner clear path -- the flag needs a stated way out, not a generic "not supported".
- `src/components/LintFilterControls.tsx` -- import `ALL_CHECK_TYPES` from `@/lib/lint-types`, add the `disputed-page` label, export the label map -- removes the drift source and makes label coverage testable.
- `src/hooks/useLint.ts` -- import `ALL_CHECK_TYPES` from `@/lib/lint-types` -- the component is no longer the const's home.
- `src/components/__tests__/lint-check-parity.test.tsx` (new) -- mount `LintFilterControls` and assert one labelled toggle per `ALL_CHECK_TYPES` entry, naming the four previously-unreachable types -- pins the parity DW-75 asks for.
- `src/lib/__tests__/lint-checks.test.ts` -- rewrite the retired-checks block (talk checks still gone, `disputed-page` back, length 15) and cover `checkDisputedPages` for the matrix rows -- the existing block would otherwise fail closed against the recorded decision.
- `src/lib/__tests__/lint.test.ts` -- assert a `disputed: true` page surfaces as a `disputed-page` issue through `lint()` -- covers wiring, which the unit test cannot.
- `SCHEMA.md` -- add the `disputed-page` bullet under `## Lint checks`, correct the auto-fix counts, and name lint in the `disputed` row's "Surfaced in" cell -- SCHEMA is the documented check list.
- `src/mcp.ts`, `src/lib/mcp-http.ts` -- correct the `scan_maintenance` descriptions to stop claiming disputed pages and point at `lint_wiki` -- the claim is false today and the new check is where that promise is actually kept.

**Acceptance Criteria:**
- Given the repo, when `ALL_CHECK_TYPES` is searched for, then exactly one runtime declaration exists (in `src/lib/lint-types.ts`) and every other occurrence is an import or re-export.
- Given `src/lib/lint-types.ts`, when its imports are inspected, then it imports only types, so no client component importing it pulls in storage, llm, or wiki.
- Given a wiki with one `disputed: true` page and one `disputed: false` page, when `lint()` runs with default options, then exactly one `disputed-page` warning is returned, for the disputed slug.
- Given the lint results list, when a `disputed-page` issue renders, then it shows a slug link and no Fix button.
- Given `pnpm test` and `pnpm exec tsc --noEmit`, when run, then both pass.

## Spec Change Log

_No bad_spec loopback occurred; this section is empty._

## Review Triage Log

### 2026-08-19 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 4, low 7)
- defer: 2: (high 0, medium 2, low 0)
- reject: 18: (high 0, medium 3, low 15)
- addressed_findings:
  - `[medium]` `[patch]` `useLint` — the module that actually owns the enabled set and the `checks.length < ALL_CHECK_TYPES.length` gate — had no test tying it to the single list, so a re-seeded 11-entry literal there would reproduce DW-75 with every suite green. Added `src/hooks/__tests__/useLint.test.tsx` (6 tests) pinning the initial set, select-all, and the exact `checks` body for all-enabled / one-deselected / cleared / single. Mutation-checked: the DW-75 mutant now turns it red while the parity suite stays green.
  - `[medium]` `[patch]` `src/lib/__tests__/mcp-http.test.ts` still asserted `disputed-page` was rejected as a retired check type, passing only incidentally. Split: `unresolved-discussions` alone must be rejected, and `disputed-page` must be accepted.
  - `[medium]` `[patch]` The I/O matrix's deselection row is literally `lint({ checks: [] })`, but only `checks: ["orphan-page"]` was covered. Added the empty-array case so a later `?.length` refactor cannot silently re-enable every check.
  - `[medium]` `[patch]` The matrix's auto-fix row names `POST /api/lint/fix` -> 400, but coverage stopped at the `fixLintIssue` unit. Added `src/lib/__tests__/lint-fix-route.test.ts` asserting the route maps the `disputed-page` `FixValidationError` to a 400 carrying the owner action (and not the generic fall-through text).
  - `[low]` `[patch]` Parity test's custom failure message was dead code — `getByRole` throws before `expect` runs. Now collects misses via `queryByRole` and names them.
  - `[low]` `[patch]` Parity test counted `button[aria-pressed]` while its comment claimed the aria-label shape; now queries the `Toggle … check` names and compares sorted lists, so an extra toggle is named.
  - `[low]` `[patch]` `PREVIOUSLY_UNREACHABLE` conflated the three types the hand-copy dropped with `disputed-page`, which never existed. Split into `HISTORICALLY_DROPPED` and `NEWLY_ADDED`.
  - `[low]` `[patch]` `describe("retired discussion checks")` asserted the opposite of its own name after gaining the roster pin. Split into a talk-retirement test and an `ALL_CHECK_TYPES roster` describe.
  - `[low]` `[patch]` `lint-fix.ts`'s `disputed-page` message emitted a literal `PATCH /api/wiki/<slug>` with `slug` in scope; now interpolated so a copy-paste works.
  - `[low]` `[patch]` The JSDoc and SCHEMA bullet claimed this check is the ONLY surface listing contested pages; `queryByFrontmatter` (`src/lib/dataview.ts:206`) can already list them on request. Softened both and named the alternative.
  - `[low]` `[patch]` `DESIGN-triggers.md:141,399` still said "14 lint check types"; both updated to 15.

## Design Notes

`checkDisputedPages` is deliberately not the deleted version: the old one called `getDiscussionStats` to describe open threads. Talk is retired, so the message states the flag and the suggestion names the surviving action.

```ts
issues.push({
  type: "disputed-page",
  slug: entry.slug,
  message: `Page is flagged disputed — its sources disagree and no review has cleared it`,
  severity: "warning",
  suggestion: `Review "${entry.slug}", reconcile the conflicting claims in the page body, then clear the Disputed toggle in the page editor (PATCH /api/wiki/${entry.slug} with metadata { disputed: false })`,
});
```

The new module is `lint-types.ts` rather than a const added to `src/lib/types.ts`: `types.ts` is declaration-only today (no imports, no value exports) and adding an emitted value would change that character for every one of its importers.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: no errors; the `Record<LintIssue["type"], string>` label map proves label coverage at compile time.
- `pnpm exec vitest run src/lib/__tests__/lint-checks.test.ts src/lib/__tests__/lint.test.ts src/components/__tests__/lint-check-parity.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: full suite green, both `node` and `dom` projects collected.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

### Summary

Two ledger entries, one change. DW-75: the lint UI's hand-copied `ALL_CHECK_TYPES`
(11 entries against the library's 14) is gone — the list now has exactly one runtime
declaration, in the new pure `src/lib/lint-types.ts`, which `lint-checks.ts` re-exports
and both `LintFilterControls` and `useLint` import. A pure module rather than the old
home because `lint-checks.ts` pulls in `./storage`, `./llm` and `./wiki`, which is the
reason the hand-copy existed at all. DW-76: `disputed-page` is a lint check again, in a
talk-free form — it lists pages whose `disputed` flag is set and points at the clear
path that already exists (the editor's Disputed toggle, i.e. a `PATCH /api/wiki/<slug>`
metadata write). It is deliberately not auto-fixable: clearing the flag asserts a human
reconciled the claims, so `fixLintIssue` rejects it with that message rather than
falling through to the generic default.

### Files changed

- `src/lib/lint-types.ts` (new) — the sole runtime declaration of `ALL_CHECK_TYPES`, now 15 entries; type-only imports so a client component can import it.
- `src/lib/types.ts` — `"disputed-page"` added to the `LintIssue["type"]` union.
- `src/lib/lint-checks.ts` — local const deleted and re-exported from `./lint-types`; new `checkDisputedPages()`.
- `src/lib/lint.ts` — `checkDisputedPages` imported, re-exported, gated and dispatched in the lightweight batch, concatenated into the result.
- `src/lib/lint-fix.ts` — explicit `disputed-page` branch throwing `FixValidationError` with the interpolated owner action.
- `src/components/LintFilterControls.tsx` — imports the const, exports `checkTypeLabels`, adds the `disputed-page` label.
- `src/hooks/useLint.ts` — repointed at `@/lib/lint-types`.
- `src/mcp.ts`, `src/lib/mcp-http.ts` — `maintenance_scan` descriptions no longer claim disputed pages are scanned; they point at `lint_wiki`.
- `SCHEMA.md` — `disputed-page` bullet, corrected auto-fix counts (ten of fifteen, five exceptions), lint named in the `disputed` row's "Surfaced in" cell.
- `DESIGN-triggers.md` — check-type count 14 → 15 in two places.
- `src/components/__tests__/lint-check-parity.test.tsx` (new) — mounted parity: one toggle per entry, no extras, the historically-dropped and newly-added types reachable, and a `disputed-page` card with a slug link and no Fix button.
- `src/hooks/__tests__/useLint.test.tsx` (new) — pins the enabled set and the request body to the single list.
- `src/lib/__tests__/lint-fix-route.test.ts` (new) — route-level 400 for a `disputed-page` fix attempt.
- `src/lib/__tests__/lint-checks.test.ts`, `lint.test.ts`, `lint-fix.test.ts`, `mcp-http.test.ts` — new `checkDisputedPages` and dispatch coverage; roster and talk-retirement pins split.

### Review findings

- Patches applied: 11 (high 0, medium 4, low 7).
- Items deferred: 2 (see frontmatter `deferred`) — `LintIssueCard.fixableTypes` drift on `supersedes-dangling`, and reconciliation threads still written for disputed transitions that nothing can read.
- Items rejected: 18, including one claim that the parity test fails `tsc` (it does not — the `Set` literal is contextually typed) and one that the unreadable-page test is vacuous (it is not — both `listWikiPages` paths enumerate from `index.md`, so the ghost row reaches the `continue`).

### Follow-up review recommendation

`true`. Patched this pass: high 0, medium 4, low 7 → score `3 × 4 + 1 × 7 = 19`, at or above the threshold of 5.

### Verification performed

- `npx tsc --noEmit` — exit 0.
- `npx vitest run` — 231 files / 4839 tests pass, both `node` and `dom` projects collected.
- `npx eslint` — exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are present on the clean baseline too).
- Every I/O matrix row is covered by a named test that ran and passed in the run above.
- The parity and `useLint` suites were mutation-checked: reverting the component to an 11-entry slice turns the parity suite red, and re-seeding `useLint` with an 11-entry literal (which type-checks) turns the hook suite red while the parity suite stays green.

### Residual risks

- `LintIssueCard.fixableTypes` is still a hand-copied check-type list, so a future check type lands there as non-fixable by omission. That default is the intended one for `disputed-page` and is pinned, but the list itself is unguarded — deferred above.
- `lint()`'s lightweight batch is now a 12-element positional destructure; a transposed entry would mislabel a check's issues with no compile error. Judged not worth a refactor inside this change.
- `checkDisputedPages` reads frontmatter per page like its `checkLowConfidence` / `checkUnmigratedPages` peers, so it inherits their cost profile on large wikis rather than improving on it; `disputed` is not carried on `IndexEntry`.
