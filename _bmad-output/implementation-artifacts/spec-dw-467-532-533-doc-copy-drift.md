---
title: 'Doc copy drift: lint-count pin, SCHEMA disputed qualification, superseded golden example'
type: 'bugfix'
created: '2026-09-05'
baseline_revision: 'b52d1a620819bd1282be6220070b7c483836b0b6'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The lint check-type count is hand-written in three more reader-facing
      places outside DESIGN-triggers.md, none of them pinned or reachable by
      the new pin's regex.
    evidence: |-
      `SCHEMA.md:897` says "work-wiki's 15 lint check types already detect …" —
      the exact phrasing `documentedCheckCounts` matches, in a file this story
      already edits, but the pin reads only `DESIGN-triggers.md`.
      `SCHEMA.md:698` says "Lint auto-fix handles ten of fifteen checks" and
      `.yoyo/status.md:22` says "15 lint checks (10 with auto-fix)"; both are
      spelled-out or differently-worded forms the regex would not match even if
      pointed at those files. All three are correct against `ALL_CHECK_TYPES`
      (15) and `AUTO_FIXABLE_CHECK_TYPES` (10) today, so nothing is wrong for a
      reader right now — but they are the same unpinned hand-written count that
      produced DW-467, and the next roster change leaves them stale. Out of
      scope here: the bundle intent scoped the pin to "that file", i.e.
      DESIGN-triggers.md, and DW-467's location names only it.
    location: >-
      SCHEMA.md:897, SCHEMA.md:698, .yoyo/status.md:22
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three reader-facing documents describe code that has moved on. `DESIGN-triggers.md:454` says lint "already detect 14 condition types" while `:141` and `:404` say 15 and `ALL_CHECK_TYPES` (`src/lib/lint-types.ts:24-40`) really has 15 — all three numbers are hand-written and nothing reads a lint count out of that file. `SCHEMA.md:661-663` still tells a reader to clear `disputed` "via the Disputed toggle" with no admin-or-service qualification, the sentence DW-121 falsified and that `disputedClearGuidance` (`src/lib/lint-types.ts:106-113`) now carries at both lint copy sites. `spec-dw-75-76-lint-check-parity-and-disputed-surface.md:144` quotes the pre-DW-389 `disputed-page` suggestion verbatim, so a reader consulting that done spec for the current copy gets the falsified version.

**Approach:** Correct the wrong count in `DESIGN-triggers.md` and add a regex pin in the existing `ALL_CHECK_TYPES roster` suite that reads the doc and asserts every lint-count phrasing in it equals `ALL_CHECK_TYPES.length`. Extend the `SCHEMA.md` `disputed-page` bullet with the same by-page-class qualification `disputedClearGuidance` states. Annotate the done spec's golden example as superseded, naming what replaced it.

## Boundaries & Constraints

**Always:** Keep the pin reading `ALL_CHECK_TYPES.length` (never a second hand-written number). Keep the `SCHEMA.md` qualification faithful to `disputedClearGuidance`'s by-page-class shape — the refusal applies to public knowledge pages, not to every page. Edit only the Design Notes of `spec-dw-75-76-…`, never its `<intent-contract>`. Keep `SCHEMA.md` edits inside `## Lint checks`.

**Block If:** `ALL_CHECK_TYPES` no longer has 15 entries, or `disputedClearGuidance` no longer states a by-page-class qualification — either means the intent's premise has moved and the correct copy is no longer determinable from the spec.

**Never:** Do not touch `SCHEMA.md`'s `## Page conventions` section (loaded into live ingest prompts). Do not rewrite `disputedClearGuidance` or any lint runtime copy. Do not add a second doc pin for `SCHEMA.md`'s disputed sentence or for any other document — this bundle pins the lint counts in `DESIGN-triggers.md` only. Do not edit the deferred-work ledger. Do not restructure `DESIGN-triggers.md` beyond the one wrong number.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| All counts current | `DESIGN-triggers.md` says 15 at `:141`, `:404`, `:454`; `ALL_CHECK_TYPES.length === 15` | Pin passes | No error expected |
| A doc count goes stale | One phrasing edited to a different number | Pin fails naming the offending count | Assertion failure |
| Roster grows/shrinks | A check type added to or removed from `ALL_CHECK_TYPES` | Pin fails on every doc phrasing until the doc is updated | Assertion failure |
| Doc loses its counts | No `N lint check types` / `N condition types` phrasing matches | Pin fails on the non-empty guard rather than passing vacuously | Assertion failure |
| Count wraps a line | Phrasing split across two lines by markdown wrapping | Whitespace flattened before matching, so it is still seen | No error expected |

</intent-contract>

## Code Map

- `DESIGN-triggers.md` -- `:141` and `:404` say "15 lint check types" (correct); `:454` says "lint checks already detect 14 condition types" (the wrong one). `:130` mentions "lint check types" with no number and must stay unmatched by the pin.
- `src/lib/lint-types.ts:24-40` -- `ALL_CHECK_TYPES`, 15 entries, the single runtime home of the roster. `:106-113` -- `disputedClearGuidance(slug)`, whose tail reads "on a public knowledge page that PATCH is admin- or service-only, so an owner who is not an admin has to ask one to clear the flag"; its JSDoc (`:95-105`) states the qualification is BY PAGE CLASS — on private, agent-scoped or artifact pages the owner's toggle still works.
- `src/lib/__tests__/lint-checks.test.ts:1094-1120` -- the `ALL_CHECK_TYPES roster` describe (`toHaveLength(15)`, `includes disputed-page`, uniqueness). Add the doc pin here. `disputedClearGuidance` is already imported at `:27`.
- `src/lib/__tests__/mcp-annotations.test.ts:41-66` -- the reuse pattern for a doc pin: `readFile` via `path.resolve(__dirname, "../../..", relative)`, flatten with `.replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ")`, `matchAll`, guard `documented.length` non-zero, then compare each to the runtime count. It already pins the MCP *tool* count in `DESIGN-triggers.md` — the lint count is a separate, unpinned number in the same file.
- `SCHEMA.md:598-664` -- `## Lint checks`; the `disputed-page` bullet ends at `:661-663` with the unqualified sentence. `## Page conventions` (`:29-125`) is read into live prompts by `src/lib/schema.ts` and is out of scope.
- `_bmad-output/implementation-artifacts/spec-dw-75-76-lint-check-parity-and-disputed-surface.md:134-150` -- `## Design Notes`, outside the `<intent-contract>` (`:39-66`); `:140-146` is the stale golden example.
- `src/lib/lint-checks.ts:748,766` and `src/lib/lint-fix.ts:915,923` -- the two live copy sites, already rendering `disputedClearGuidance`. Read-only here; they are the evidence that `SCHEMA.md` is the third, unaligned site.

## Tasks & Acceptance

**Execution:**
- `DESIGN-triggers.md` -- change `:454`'s "14 condition types" to "15 condition types" -- 15 is what `ALL_CHECK_TYPES` has and what the file's two other phrasings already say.
- `src/lib/__tests__/lint-checks.test.ts` -- in the `ALL_CHECK_TYPES roster` describe, add a test that reads `DESIGN-triggers.md`, flattens whitespace, collects every `(\d+) lint check types` / `(\d+) condition types` phrasing, asserts at least one match, and asserts each equals `ALL_CHECK_TYPES.length` -- makes all three hand-written numbers fail loudly instead of drifting apart again.
- `SCHEMA.md` -- extend the `disputed-page` bullet's closing sentence with the by-page-class qualification, wording it from `disputedClearGuidance` -- a reader of the lint-check reference gets the same truth the lint output gives.
- `_bmad-output/implementation-artifacts/spec-dw-75-76-lint-check-parity-and-disputed-surface.md` -- annotate the golden example in Design Notes as superseded by DW-389, naming `disputedClearGuidance` as the current source of the clause -- preserves the record of what DW-76 built while stopping the block from reading as live expected copy.

**Acceptance Criteria:**
- Given the corrected `DESIGN-triggers.md`, when `pnpm exec vitest run --project node src/lib/__tests__/lint-checks.test.ts` runs, then the new pin passes and every count phrasing in the file reads 15.
- Given a reader at `SCHEMA.md`'s `disputed-page` bullet, when they read the clearing instruction, then it names the admin-or-service restriction on public knowledge pages and says the owner's toggle still works on private, agent-scoped and artifact pages.
- Given a reader at `spec-dw-75-76-…`'s Design Notes, when they reach the quoted `suggestion`, then an adjacent annotation tells them it is the pre-DW-389 text and points at `disputedClearGuidance`.
- Given `SCHEMA.md`, when the change is complete, then `## Page conventions` is byte-identical to before.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[low]` `[patch]` `documentedCheckCounts`'s "reports the documented number, not the roster length" case asserted `.not.toContain(16)` against a literal the test itself wrote — unfalsifiable, and it would stop contrasting once the roster reached 16. Rewritten to read a deliberately-stale count back verbatim and assert it differs from `ALL_CHECK_TYPES.length`, which is the comparison the pin actually performs.
  - `[low]` `[patch]` The doc pin's `expect(documented.length).toBeGreaterThan(0)` guard only fired if EVERY phrasing vanished, so deleting or rewording two of the three would silently shrink its reach while still passing. Changed to `toHaveLength(3)`, matching the bare-count convention of `toHaveLength(15)` in the same describe. Verified negatively: removing one phrasing now fails with "expected [ 15, 15 ] to have a length of 3 but got 2".

## Design Notes

The pin lives with the roster, not in `mcp-annotations.test.ts`: that suite's subject is the MCP tool registry, and it already pins a *different* number in the same file. Anchoring the lint count to `ALL_CHECK_TYPES.length` in the roster suite keeps each pin next to the thing it protects.

Match on both phrasings, since the doc uses two:

```ts
const flat = text.replace(/\s+/g, " ");
const counts = [...flat.matchAll(/\b(\d+) (?:lint check|condition) types\b/g)].map((m) => m[1]);
expect(counts.length).toBeGreaterThan(0);
for (const count of counts) expect(Number(count)).toBe(ALL_CHECK_TYPES.length);
```

`:130`'s "existing lint check types" carries no digit, so it does not match — the pin only ever sees a number someone wrote down.

The `SCHEMA.md` qualification must not flatten into "you cannot clear disputed": `disputedClearGuidance`'s JSDoc is explicit that the realm gate only covers what `belongsInCommons` selects, so the sentence says WHERE the refusal applies.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/lint-checks.test.ts` -- expected: all tests pass, including the new doc pin.
- `grep -n "condition types\|lint check types" DESIGN-triggers.md` -- expected: every numbered phrasing reads 15.
- `git diff -- SCHEMA.md` -- expected: the only hunk is inside `## Lint checks`.

## Auto Run Result

Status: done

**Summary.** Three reader-facing documents were realigned with the code they describe, and the lint check-type count in `DESIGN-triggers.md` is now pinned to `ALL_CHECK_TYPES.length` instead of being hand-written in three unconnected places.

**Files changed**

- `../../DESIGN-triggers.md` — `:454`'s "14 condition types" corrected to 15; all three numbered phrasings now agree with the roster (DW-467).
- `../../SCHEMA.md` — the `disputed-page` bullet's clearing instruction gained the by-page-class qualification `disputedClearGuidance` carries: admin- or service-only on a public knowledge page, owner's toggle still works on private, agent-scoped and artifact pages (DW-533). The only hunk is inside `## Lint checks`; `## Page conventions`, which `src/lib/schema.ts` loads into live ingest prompts, is byte-identical.
- `../../src/lib/__tests__/lint-checks.test.ts` — new `documentedCheckCounts` helper plus a doc pin in the `ALL_CHECK_TYPES roster` describe reading `DESIGN-triggers.md` and comparing every count phrasing to `ALL_CHECK_TYPES.length`, and five cases covering the pin's own failure modes.
- `spec-dw-75-76-lint-check-parity-and-disputed-surface.md` — a superseded note under the stale golden `suggestion` in Design Notes, pointing readers at `disputedClearGuidance()` (DW-532). The `<intent-contract>` was not touched.

**Review findings** — 2 patches applied (both low), 1 item deferred (low), 8 rejected (all low). Rejected as out of scope on the intent's own authority: adding a second pin tying `SCHEMA.md`'s disputed sentence to `disputedClearGuidance` (the intent scoped the pin to lint counts, and the spec's Never clause forbade it). Rejected as speculative: regex hardening for blockquote gutters, emphasis markers, hyphenated wordings, fenced code blocks, and a friendlier missing-file error — the sibling pin in `mcp-annotations.test.ts` carries the same looseness. Rejected as historical record: the two further unqualified statements of the clear path at `spec-dw-75-76-…:45` (inside its frozen `<intent-contract>`) and `:179` (an Auto Run Result), both already covered for a reader by the new superseded note in the same document.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 0, low 2; no high-severity patch, so no further pass is warranted.

**Verification**

- `pnpm exec vitest run --project node src/lib/__tests__/lint-checks.test.ts` — 86 passed.
- `pnpm test` (full suite, pre-patch) — 386 files, 9672 passed, 1 skipped.
- `pnpm exec tsc --noEmit` and `pnpm exec eslint src/lib/__tests__/lint-checks.test.ts` — both clean.
- Negative checks: reverting `:454` to 14 fails the pin on the value; deleting one phrasing fails it on `toHaveLength(3)`. Both restored.
- `grep -n "condition types\|lint check types" DESIGN-triggers.md` — every numbered phrasing reads 15.
- `git diff -U0 -- SCHEMA.md` — one hunk, at `@@ -663 +663,4 @@`, inside `## Lint checks`.

**Residual risks.** `SCHEMA.md`'s new qualification is prose with no executable tie to `disputedClearGuidance`, so the two can drift again — out of scope by the intent, recorded here rather than guarded. The doc pin covers `DESIGN-triggers.md` only; the sibling count sites are in `deferred`.
