---
title: 'DW-447: record the lint-fix trigger separately from the author'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'e065191ebf63238f1549e5497d60b617a7443220'
---

<intent-contract>

## Intent

**Problem:** Lint auto-fix doors disagree on who made the edit. `src/lib/mcp-http.ts:702` and `src/app/api/lint/fix/route.ts:163` (and `src/app/api/lint/workbench-fix/route.ts:33`) stamp the resolved principal as `author`, which credits a real human with machine-generated edits in revision history, the contributor list and trust scores — the exact thing `AUTOMATION_ACTORS` (`src/lib/agent-handle.ts:33`) exists to prevent — while the stdio door keeps the honest `"lint-fix"` default.

**Approach:** Human decision (DW-447, option 1 "Record the trigger separately"): keep `"lint-fix"` as `author` on every lint-fix door, and carry the principal's handle in a separate `triggeredBy` field — the same field name `attributed()` and `handleReingest` already use — recorded in the wiki log detail line for the fix, which is outside the contributor contract entirely.

## Boundaries & Constraints

**Always:**
- `author` for a lint fix stays `"lint-fix"` (the `fixLintIssue` default) on every door. No door passes a principal handle as `author`.
- `triggeredBy` is optional everywhere; absent/blank leaves every existing log detail line byte-identical.
- The trigger suffix has ONE owner (a helper in `src/lib/wiki-log.ts`) — never a second hand-copied format string.
- All ten `FIX_HANDLERS` entries plus `fixDanglingWikilink`/`fixRenamedSlug` (called directly by the workbench door) accept and record `triggeredBy`; no fix type silently drops it.

**Block If:** Recording `triggeredBy` cannot be done without changing what `normalizeActor`/`contributors.ts` observe (i.e. it would require writing the handle into revision `author`, page `contributors`, or the recent-events actor).

**Never:**
- Do not add `triggeredBy` to the revision sidecar, page frontmatter, `contributors`, `pushRecentEvent`, or any trust-score input.
- Do not change `AUTOMATION_ACTORS`, `normalizeActor`, or the contributor assertions in `contributors.test.ts` / `lifecycle.test.ts`.
- Do not change the wire contract of any door (no new request fields; `triggeredBy` is server-derived from the resolved principal, never caller-supplied).
- Do not touch the in-process callers that pass no principal (`src/cli.ts` `--fix`, `POST /api/tasks/run` `maintain:fix`) or the stdio `fix_lint_issue` registration behaviour.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HTTP MCP fix | `fix_lint_issue` with principal `alice` | `handleFixLintIssue` receives `triggeredBy: "alice"` and NO `author`; log detail ends `(triggered by alice)`; revision author is `"lint-fix"` | No error expected |
| REST fix | `POST /api/lint/fix` by owner `bob` | `fixLintIssue(type, slug, target, message, undefined, "bob")`; author defaults to `"lint-fix"` | No error expected |
| Workbench fix | `POST /api/lint/workbench-fix` by owner `bob` | `fixWorkbenchLintIssue(..., undefined, "bob")` → underlying fix gets `author "lint-fix"`, `triggeredBy "bob"` | No error expected |
| stdio fix | `fix_lint_issue` over stdio (null principal) | No `author`, no `triggeredBy`; log detail unchanged from today | No error expected |
| No-page fix types | `stale-index` / `empty-page` with `triggeredBy: "alice"` | `pruneStaleIndexEntry` / `deleteWikiPage` log detail ends `(triggered by alice)` | Existing errors unchanged |
| Blank handle | `triggeredBy: "   "` | Treated as absent — detail line unchanged, no empty parenthetical | No error expected |

</intent-contract>

## Code Map

- `src/lib/lint-fix.ts` -- owner of all fix functions. `fixLintIssue` (l.932-947, 5th param `author = "lint-fix"`), `FixRequest` (l.772-778), `FIX_HANDLERS` (l.791-806). Ten `writeWikiPageWithSideEffects` calls each with a `logDetails: () => "auto-fix: …"` closure (l.75, 239, 304, 387, 452, 501, 557, 604, 698, 755). `fixStaleIndex` (l.93) calls `pruneStaleIndexEntry(slug, author)`; `fixEmptyPage` (l.128) calls `deleteWikiPage(slug, author)`.
- `src/lib/wiki-log.ts` -- `appendToLog`/`appendToLogOnce`/`logBlock` (l.41-104). Home for the new shared `withTriggeredBy(details, triggeredBy)` formatter; imported by both `lifecycle.ts` (already, l.50) and `lint-fix.ts` (new import) with no cycle.
- `src/lib/lifecycle.ts` -- `pruneStaleIndexEntry(slug, _author?)` (l.1118; `_author` is already unused, its own `appendToLog` at l.1142) and `deleteWikiPage(slug, author?, expectedContent?)` (l.1163; builds its own log details closure at l.1191-1192). Both need one trailing optional `triggeredBy` param. No other caller passes it (`deleteWikiPage` callers: cli.ts:524, mcp.ts:464, ingest/history/route.ts:551, wiki/[slug]/route.ts:93, source-cascade.ts:216,235, tenant-admin.ts:63).
- `src/mcp.ts` -- `handleFixLintIssue` (l.1285-1293) currently forwards `args.author`; `handleReingest` (l.1299-1310) is the shape reference (`{ author, triggeredBy }`). stdio `fix_lint_issue` registration comment at l.2617-2626 states the DW-456 rationale and must be re-worded.
- `src/lib/mcp-http.ts` -- `attributed()` (l.288-294) already mints `triggeredBy`; `fix_lint_issue` `run` passes `author: p!.handle` at l.702 — the line the decision drops.
- `src/app/api/lint/fix/route.ts` -- passes `principal!.handle` as the 5th arg at l.163 with a DW-456 comment at l.153-156.
- `src/app/api/lint/workbench-fix/route.ts` -- l.33 passes `principal.handle` as `author` into `fixWorkbenchLintIssue`; `src/lib/workbench-lint-fix.ts` l.16-40 forwards it to `fixRenamedSlug`/`fixDanglingWikilink`/`fixLintIssue`. Fourth door of the same class; the triage context enumerated only three.
- READ-ONLY EVIDENCE (do not change): `src/lib/agent-handle.ts:33` `AUTOMATION_ACTORS`; `src/lib/__tests__/contributors.test.ts:121-149`, `src/lib/__tests__/lifecycle.test.ts:880` assert `"lint-fix"` never surfaces as a contributor.
- Tests to update: `src/lib/__tests__/lint-fix-route.test.ts:240-288` (two DW-456 assertions that the principal IS the author — now inverted), `src/lib/__tests__/lint-fix.test.ts:245` (`deleteWikiPage` called with exactly two args), `src/lib/__tests__/lint-fix.test.ts:681,734` (already assert `author === "lint-fix"` — must keep passing).

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-log.ts` -- export `withTriggeredBy(details: string, triggeredBy?: string): string` returning `` `${details} (triggered by ${handle})` `` for a non-blank trimmed handle and `details` unchanged otherwise -- one owner for the format so lifecycle and lint-fix cannot drift.
- `src/lib/lifecycle.ts` -- add a trailing optional `triggeredBy?: string` to `pruneStaleIndexEntry` and `deleteWikiPage`, wrapping their existing log details with `withTriggeredBy` -- these two fix types write no page, so their log lines are the only place a trigger can land.
- `src/lib/lint-fix.ts` -- add a trailing optional `triggeredBy?: string` to every exported `fix*` function and to `fixLintIssue` (6th param, after `author`); add `triggeredBy?: string` to `FixRequest` and thread it through all ten `FIX_HANDLERS` entries; wrap every `logDetails` closure with `withTriggeredBy` -- records the trigger without touching `author`.
- `src/mcp.ts` -- replace `handleFixLintIssue`'s `author` field with `triggeredBy` and forward it as `fixLintIssue`'s 6th arg; re-word the stdio `fix_lint_issue` comment so it states the new rule (author is `"lint-fix"` at every door; the stdio transport has no principal so it records no trigger either) -- the old comment asserts the now-reversed DW-456 behaviour.
- `src/lib/mcp-http.ts` -- in `fix_lint_issue.run`, replace `author: p!.handle` with `triggeredBy: p!.handle` -- the door the decision names.
- `src/app/api/lint/fix/route.ts` -- pass `undefined` for `author` and `principal!.handle` as `triggeredBy`; replace the DW-456 comment with the DW-447 rationale -- reverses the human-as-author attribution.
- `src/lib/workbench-lint-fix.ts` + `src/app/api/lint/workbench-fix/route.ts` -- add a trailing `triggeredBy?: string` to `fixWorkbenchLintIssue`, forward it to all three call sites, and have the route pass the principal as `triggeredBy` instead of `author` -- same door class, same contributor-contract violation.
- `src/lib/__tests__/lint-fix.test.ts` -- update the `deleteWikiPage` call-shape assertion; add unit tests for the I/O matrix rows (trigger suffix present, absent, and blank-handle) over at least one page-writing fix, `stale-index`, and `empty-page` -- pins the recording point.
- `src/lib/__tests__/lint-fix-route.test.ts` -- invert the two DW-456 tests to assert `author` is not the principal and the 6th arg is the principal handle -- these currently pin the behaviour being reversed.
- `src/lib/__tests__/mcp-http.test.ts` + `src/lib/__tests__/workbench-lint-fix.test.ts` -- pin that each door forwards the principal as `triggeredBy` and never as `author` -- three of the four doors otherwise have no regression guard.

**Acceptance Criteria:**
- Given any of the four lint-fix doors, when a fix succeeds, then the revision/lifecycle `author` observed by `normalizeActor` is `"lint-fix"` and never the principal's handle.
- Given a door with a resolved principal `alice`, when a lint fix writes its log entry, then the entry's detail line ends with `(triggered by alice)`.
- Given the stdio door (no principal), when a lint fix succeeds, then its log detail line is byte-identical to today's.
- Given `pnpm test` (or `npx vitest run`), when the full suite runs, then it passes with no change to `contributors.test.ts` or `lifecycle.test.ts`.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 4, low 6)
- defer: 0
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `withTriggeredBy` interpolated the handle raw into markdown that `wiki/log.md` stores and `/wiki/log` renders publicly with line-based redaction — control characters now collapse to a single space and the handle is capped at 64 chars inside the one owner of the format.
  - `[medium]` `[patch]` The Workbench door's `renamed-slug` and `fixLintIssue` fall-through branches had no trigger assertion (a mutation putting the handle back in the author slot stayed green) — one row per branch added, plus a no-trigger control.
  - `[medium]` `[patch]` Seven of ten `FIX_HANDLERS` entries could swap the `author`/`triggeredBy` slots with the suite green — table-driven `it.each` over every `AUTO_FIXABLE_CHECK_TYPES` member now pins `author === "lint-fix"` and the suffix, triggered and untriggered.
  - `[medium]` `[patch]` No end-to-end guard that a triggered fix keeps the human handle out of the contributor contract — real-storage test added asserting `log.md` carries the trigger, every revision sidecar's author is `"lint-fix"`, and the handle appears in no wiki file except `log.md`.
  - `[low]` `[patch]` `withTriggeredBy` had no direct unit test despite being the declared single owner of the format — direct tests added for absent/blank/whitespace/control-character/cap cases.
  - `[low]` `[patch]` The stdio `fix_lint_issue` registration forwarded `args` wholesale, resting the server-derived-only contract on the SDK's zod parse — it now passes explicit fields.
  - `[low]` `[patch]` `pruneStaleIndexEntry` had an ignored optional string (`_author`) ahead of the live `triggeredBy`, so a caller meaning the trigger would drop it silently — the dead slot is removed.
  - `[low]` `[patch]` The `withTriggeredBy` docstring claimed nothing parses the detail line, but `/wiki/log` line-filters it — corrected, and the name collision with `SourceEntry.triggered_by` is now documented.
  - `[low]` `[patch]` A 115-character line in `lifecycle.ts` inconsistent with the surrounding file — wrapped.
  - `[low]` `[patch]` The `pruneStaleIndexEntry` test double rebuilt the production string via the real formatter — comment added recording that the load-bearing guard lives in `stale-index-lifecycle.test.ts`.

## Design Notes

The wiki log detail line is the landing place because it is the only durable, per-operation record a lint fix already writes that is not an input to attribution: `logBlock` emits it as free prose under the entry heading, nothing parses it, and `contributors.ts`/`normalizeActor`/`pushRecentEvent` never read it. The revision sidecar was rejected — it is `{ author, reason }` and is exactly what the contributor contract reads.

Golden example (`src/lib/lint-fix.ts`, `fixOrphanPage`):

```ts
export async function fixOrphanPage(
  slug: string,
  author = "lint-fix",
  triggeredBy?: string,
): Promise<FixResult> {
  // …
  logDetails: () => withTriggeredBy("auto-fix: added orphan page to index", triggeredBy),
```

`author` keeps its parameter and default so in-process callers and the `"lint-fix"` assertions at `lint-fix.test.ts:681,734` are untouched; `triggeredBy` is purely additive and trailing, so no existing call site changes arity except the doors.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: no errors.
- `npx vitest run src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/workbench-lint-fix.test.ts src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/contributors.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/stale-index-lifecycle.test.ts` -- expected: all pass.
- `npx vitest run` -- expected: full suite passes (no new failures vs. the pre-change baseline).
- `npx eslint src/lib/lint-fix.ts src/lib/wiki-log.ts src/lib/lifecycle.ts src/lib/mcp-http.ts src/mcp.ts src/lib/workbench-lint-fix.ts src/app/api/lint` -- expected: clean.

## Auto Run Result

Status: done

### Summary

Human decision DW-447, option 1 ("Record the trigger separately"). `author` for a lint auto-fix is now `"lint-fix"` at every door; the resolved principal is carried in a separate `triggeredBy` and recorded only on the fix's `wiki/log.md` detail line, which no part of the contributor contract reads. `AUTOMATION_ACTORS`, `normalizeActor`, `contributors.ts`, the revision sidecar and every trust-score input are untouched.

Scope note: the triage context enumerated three doors, but a fourth of the same class — `POST /api/lint/workbench-fix` — also stamped `principal.handle` as `author`. It was included, since leaving it would have left the same contributor-contract violation alive and the doors still disagreeing.

### Files changed

- [`../../src/lib/wiki-log.ts`](../../src/lib/wiki-log.ts) — new `withTriggeredBy`, the single owner of the `(triggered by <handle>)` suffix and of its sanitization.
- [`../../src/lib/lifecycle.ts`](../../src/lib/lifecycle.ts) — `pruneStaleIndexEntry(slug, triggeredBy?)` (dead `_author` slot dropped) and `deleteWikiPage`'s new trailing `triggeredBy`; both wrap their own log detail.
- [`../../src/lib/lint-fix.ts`](../../src/lib/lint-fix.ts) — trailing `triggeredBy` on all twelve exported fixes and on `fixLintIssue`; `FixRequest` and all ten `FIX_HANDLERS` entries thread it; ten `logDetails` closures wrapped.
- [`../../src/mcp.ts`](../../src/mcp.ts) — `handleFixLintIssue` takes `triggeredBy` instead of `author`; stdio registration passes explicit fields and its comment states the new rule.
- [`../../src/lib/mcp-http.ts`](../../src/lib/mcp-http.ts) — `fix_lint_issue` passes `triggeredBy: p!.handle`, not `author`.
- [`../../src/app/api/lint/fix/route.ts`](../../src/app/api/lint/fix/route.ts) — owner recorded as trigger; DW-456's author attribution reversed.
- [`../../src/app/api/lint/workbench-fix/route.ts`](../../src/app/api/lint/workbench-fix/route.ts) + [`../../src/lib/workbench-lint-fix.ts`](../../src/lib/workbench-lint-fix.ts) — same reversal on the fourth door.
- Tests: `wiki-log.test.ts` (formatter units), `lint-fix.test.ts` (table-driven over every fixable type), `stale-index-lifecycle.test.ts` (real-storage end-to-end incl. the contributor-contract sweep), `workbench-lint-fix.test.ts` (one row per branch), `lint-fix-route.test.ts` (DW-456 assertions inverted), `mcp-http.test.ts`, `mcp.test.ts` (stdio records no trigger), `epic5-routes.test.ts`, `workbench-data-version.test.ts` (source-text pin relaxed for the reformatted call).

### Review findings

Patches applied: 10 (medium 4, low 6). Deferred: 0. Rejected: 10.

Follow-up review recommended: **true**. Patched counts — high 0, medium 4, low 6; score = 3x4 + 1x6 = 18, which is >= 5.

### Verification

- `npx tsc --noEmit` — clean, no output.
- `npx eslint` over all sixteen touched source and test files — clean, no errors or warnings.
- `npx vitest run` — 359 files, 8728 passed / 1 skipped, 0 failures.
- Every I/O matrix row is covered by a test that ran and passed in that run: HTTP MCP (`mcp-http.test.ts`), REST (`lint-fix-route.test.ts`), Workbench (`workbench-lint-fix.test.ts`), stdio (`mcp.test.ts`), the two page-less fix types (`stale-index-lifecycle.test.ts`, `lint-fix.test.ts`), and the blank-handle case (`wiki-log.test.ts`, `lint-fix.test.ts`).
- Mutation checks confirmed the new guards bite: putting the handle back in the author slot on the Workbench fall-through, swapping the slots in the `unmigrated-page` handler, and writing `author: triggeredBy` in `fixOrphanPage` each fail at least one test that was green before the patch.

### Residual risks

- The trigger is recorded as prose in `wiki/log.md` only: `FixResult` does not echo it, no API or UI can answer "who asked for this fix", and reading it back is a grep. That is the cost of keeping the record outside the contributor contract, which is what the decision asked for.
- `/wiki/log` renders those lines publicly, so a lint-fix line now carries a human handle it did not carry before. Handles are already public elsewhere (page contributors, `/u/<handle>` URLs, the trail, `sources[].triggered_by`), so this is not a new class of disclosure, but it is a new place one appears.
- A triggered `empty-page` delete stamps its own log entry but not the companion backlink-strip entries the delete pipeline writes under `"system"`, so that operation reads as half-attributed in the log.
- `author` remains an open, defaulted `string` on the lint-fix surface. Nothing but prose stops a future door from passing a principal there again; the intent explicitly kept `author` as the mechanism carrying `"lint-fix"`, so it was not narrowed.
