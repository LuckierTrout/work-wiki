---
title: 'DOM test environment fidelity (DW-108, DW-111, DW-113)'
type: 'chore'
created: '2026-08-27'
status: 'done'
baseline_revision: '802783734cf28a54d5daa43e97268df643fd413d'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `showSplitHandle`'s collapsed-column branch is still unmounted — nothing observes that a
      collapsed left column withdraws its divider.
    evidence: |-
      The width harness makes the branch reachable for the first time, but the new cases only
      exercise `previewOpen` (the Preview divider's condition) and the measured guard. A shell that
      rendered a tree divider over a zero-width track would keep the whole suite green:
      `showSplitHandle("tree", …)` returns `!layout.collapsed`, and no mounted case sets
      `writeStoredCollapsed(true)` at a declared width.
    location: >-
      src/components/workbench/__tests__/workbench-split-wiring.test.tsx
    severity: low
  - summary: >-
      DW-24's roving `tabindex` / arrow-key surface is now mountable, and the comment that used to
      excuse it no longer does.
    evidence: |-
      `TreePanel.tsx`'s docblock rested the deliberate not-an-ARIA-tree decision on there being no
      way to verify focus machinery. That premise was corrected in this pass (the `dom` project
      executes focus order — `workbench-sheet.test.tsx` asserts `document.activeElement` after
      synthetic Tab), which leaves the decision itself defended only by the assistive-technology
      half. Whether the tablist and the tree rows keep their full keyboard surface is now testable
      and untested.
    location: >-
      src/components/workbench/TreePanel.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Twelve files still tell the reader this repository has no DOM test environment — and several name that as the reason their design exists — but a `jsdom` vitest project and a Playwright project both ship today, so a future agent will reproduce the workaround on a dead reason. The convention that replaced it (`*.test.tsx` ⇒ jsdom, `*.test.ts` ⇒ node) is written down only in a `vitest.config.ts` comment, and `vitest.setup.dom.ts` still leaves `getBoundingClientRect` at jsdom's all-zeros, so a mounted `Workbench` measures `shellWidth === 0` and no mounted test can reach a single width-derived shell decision.

**Approach:** Correct the false prose in place (keeping each comment's real argument, restated against the project split that is actually true), state the convention in `AGENTS.md` below the closing `<!-- /bmad:context -->` marker so a context refresh cannot overwrite it, add a source-scan guard so the claim cannot come back, and give `vitest.setup.dom.ts` a declared-rect harness (`setElementRect`) that lets a test state a shell width — then mount the width-derived shell decisions, including the window `resize` listener.

## Boundaries & Constraints

**Always:**
- A corrected comment keeps its ARGUMENT and changes only the premise: "the module holds the rule so a suite can execute it rather than grep it" is still true and still the reason the code is shaped that way. What changes is the justification — from "this repo has no DOM test environment" to "this file's suite is the `node` project (`environment: "node"`, `*.test.ts`), which mounts nothing".
- The declared-rect harness lives in `vitest.setup.dom.ts` and never in `src/`. No component is reshaped to make itself measurable.
- Undeclared elements keep exactly today's behaviour: `getBoundingClientRect` stays jsdom's all-zeros and `getClientRects` stays the fixed 1x1 placeholder, so every existing `.test.tsx` suite is unaffected.
- Each new or replaced comment in `vitest.setup.dom.ts` says what is actually true, including what the harness still cannot do (a declared box is a stated fact, not a measurement — it cannot catch a CSS mistake).
- The `AGENTS.md` note sits below `<!-- /bmad:context -->` and says, in its own text, why it is outside the managed block — the convention `## Frozen identifiers` already follows.

**Block If:**
- Overriding `Element.prototype.getBoundingClientRect` destabilises Testing Library or an existing `.test.tsx` suite in a way a passthrough default cannot fix.

**Never:**
- Change any runtime behaviour in `src/`. This pass edits comments in `src/` and adds test assertions; no expression, JSX node, prop or export changes.
- Touch `.github/`, the deferred-work ledger, or `vitest.setup.ts` (the node setup).
- Delete or weaken an existing assertion in `workbench-split-wiring.test.tsx`, or move the split RULES out of the node suite — `workbench-split.test.ts` stays the home of the geometry.
- Rewrite comments that are already accurate because they scope the claim to their own project ("the `node` project has no DOM"). Only the repo-wide claim is false.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No rect declared | Any `.test.tsx` mounts and reads a box | `getBoundingClientRect()` is jsdom's all-zeros; `getClientRects()` is the 1x1 placeholder; `offsetWidth` is 0 | No error expected |
| Width declared before mount | `setElementRect(".wb-shell", { width: 1400 })`, then render `Workbench` | The mount effect measures 1400; `--wb-tree` / `--wb-preview` are written; both `<SplitHandle>`s can render | No error expected |
| Resize after a re-declaration | Shell mounted at 1400; width re-declared to 700; `resize` dispatched on `window` | The shell re-measures to 700 and re-derives; without the listener the layout stays at 1400 | No error expected |
| Narrow shell, preferred widths too large | Stored tree 600 / preview 600 at shell width 1000 | `clampSplitWidths` shrinks the TREE first; the announced `aria-valuemax` matches the clamp | No error expected |
| Preview closed | Width declared; no selection | The tree separator renders; the Preview separator does not | No error expected |
| Rect declared for an unmatched selector | `setElementRect(".nope", …)` then read any box | Nothing changes; no element reports the declared box | No throw — an unused declaration is inert |
| Between tests | A file declared a rect and ended | The registry is empty again; the next file's boxes are jsdom's | No error expected |

</intent-contract>

## Code Map

**The false claim — the twelve files (verified by grep at `802783734cf2`):**

- `src/lib/workbench-data-version.ts:9-11` -- "vitest runs `environment: "node"` and this repo has no DOM test environment".
- `src/lib/workbench-split.ts:8-10` -- "There is no DOM test environment here (`vitest.config.ts` is `environment: "node"`)".
- `src/lib/workbench-settings.ts:9-11` -- "`vitest.config.ts` is `environment: "node"` — there is no DOM and no testing-library".
- `src/components/workbench/SplitHandle.tsx:15-18` -- "`vitest.config.ts` is `environment: "node"` and a condition typed into a handler here could only ever be grepped for".
- `src/components/workbench/TreePanel.tsx:36` -- "this repo has no DOM test environment to verify either (DW-24)". Note: the ARIA-tree design decision it defends STANDS; only the stated reason changes.
- `src/components/workbench/PreviewColumn.tsx:106-107` -- "because this repo has no DOM test environment and a rule typed into JSX here could only ever be grepped for".
- `src/components/workbench/SettingsCanvas.tsx:153-154` -- "`vitest.config.ts` is `environment: "node"`, so a rule typed into the JSX below could only ever be grepped for".
- `src/lib/__tests__/workbench-chrome.test.ts:4-6` -- "there is no jsdom and no testing-library, and adding them is out of scope here".
- `src/lib/__tests__/workbench-left-column.test.ts:4-6` -- same sentence, plus "(DW-24)".
- `src/lib/__tests__/workbench-settings.test.ts:11` -- "`vitest.config.ts` is `environment: "node"` with no DOM (DW-15)".
- `src/lib/__tests__/wiki-schema-edit.test.ts:15` -- same sentence.
- `src/lib/__tests__/workbench-preview.test.ts:12-14` -- "vitest runs `environment: "node"` and this story is forbidden from adding jsdom".

Already accurate, leave alone (they scope the claim to their own project): `src/app/wiki/new/__tests__/new-wiki-page-seam.test.ts:13`, `src/lib/__tests__/read-only-door-coverage.test.ts:23`, `src/lib/workbench-url.ts:64`, `src/lib/__tests__/workbench-intake.test.ts:16`.

**The convention and its home:**

- `vitest.config.ts:5,85-127` -- the only written record: `DOM_INCLUDE`, the two inline `projects` (`node`: `environment: "node"`, `include: ["src/**/__tests__/**/*.test.ts"]`; `dom`: `environment: "jsdom"`, `*.test.tsx`, `setupFiles: ["./vitest.setup.ts", "./vitest.setup.dom.ts"]`), plus the collection guard at 50-69 that refuses to run when the dom include matches nothing.
- `AGENTS.md:30` -- the closing `<!-- /bmad:context -->` marker. `AGENTS.md:32-35` is the precedent: `## Frozen identifiers` sits below it and says so in its own first paragraph. `AGENTS.md:20-23` is "Running and verifying" INSIDE the managed block — do not add the note there.
- `playwright.config.ts` / `package.json:12` (`test:e2e`) -- the third environment the note must name so "jsdom or node" is not itself a new half-truth.

**The width harness:**

- `vitest.setup.dom.ts:194-219` -- the `getClientRects` shim and the FIDELITY LIMIT note to replace. `displayHidden` (178) is the visibility predicate both shims share. `afterEach` (25-29) is where `resetElementRects()` must join `resetMediaQueries()` / `setVisibilityState("visible")`.
- `src/components/workbench/Workbench.tsx:591-603` -- the measure effect: `setShellWidth(shell.getBoundingClientRect().width)` on `.wb-shell` (`shellRef`, applied at 1409), `measure()` at mount, `window.addEventListener("resize", measure)`, removed on cleanup.
- `src/components/workbench/Workbench.tsx:1401-1404, 1593-1605, 1644-1656` -- everything derived from the width: `layout = { shellWidth, previewOpen, collapsed }`, `clampSplitWidths`, the two `splitBounds`, `splitStyleVars` (inline `--wb-tree` / `--wb-preview` at 1409-1412), and the two `showSplitHandle` gates.
- `src/lib/workbench-split.ts:227,264,296,417,440` -- `isSplitMeasured` (`shellWidth > 0`), `splitBounds` (`room = shellWidth - 48 - 320 - other`, floored at `min`), `clampSplitWidths` (tree clamped FIRST, then preview against the already-clamped tree), `splitStyleVars` (undefined until mounted AND measured), `showSplitHandle` (false until mounted AND measured). Constants: `SPLIT_RAIL_WIDTH` 48, `SPLIT_MIN_TREE`/`SPLIT_MIN_PREVIEW` 200, `SPLIT_MIN_CANVAS` 320.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx:38-49` -- the COVERAGE LIMIT docblock that states the shell cannot be measured; `renderShell()` (128-140), `DATA` (72), the hoisted `next/navigation` mock (53-54) and the `cleanup()`-first `afterEach` (119-125) are the reusable harness.
- `src/lib/workbench-state.ts:181,190` -- `readStoredSplitWidths` / `writeStoredSplitWidths`; `Workbench.tsx:425` reads the stored widths in the mount effect, so a test seeds preferred widths with `writeStoredSplitWidths`.
- `src/lib/__tests__/workbench-split.test.ts` -- read-only evidence: the geometry RULES already have full node coverage. The new mounted cases pin the shell's REACTION, not the numbers.

## Tasks & Acceptance

**Execution:**

1. `vitest.setup.dom.ts` -- add a declared-rect registry keyed by CSS selector: `setElementRect(selector, { width, height?, left?, top? })` and `resetElementRects()` (called from the existing `afterEach`). Override `Element.prototype.getBoundingClientRect` and `HTMLElement.prototype.offsetWidth` to answer a declared box for a matching element and otherwise delegate to jsdom's original; make `getClientRects` return the declared box when one exists and keep the 1x1 placeholder otherwise. Last matching declaration wins, documented. -- a mounted shell cannot state its own width, and this is the only place a shim may live.
2. `vitest.setup.dom.ts:204-209` -- replace the FIDELITY LIMIT note with what is now true: rects are all-zeros until a test declares one; a declared box is a stated fact, not a measurement, so it pins the shell's REACTION to a width and can never catch a CSS or layout mistake; the numbers themselves stay `workbench-split.test.ts`'s. -- the note is the contract readers act on.
3. `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` -- rewrite the COVERAGE LIMIT docblock (38-49) to describe the harness instead of the limit, and add a `describe` for the width-derived shell decisions covering every I/O row that names a width: measured-at-mount style vars and both separators, the `resize` re-measure, the tree-first clamp with the announced range agreeing, and the closed-Preview case. -- these are the decisions DW-113 names, and this file is already the shell's split home.
4. `src/lib/__tests__/workbench-chrome.test.ts` -- add a source-scan case asserting no file under `src/` claims the repository has no DOM test environment (match the family of phrasings the twelve files used), naming `vitest.config.ts`'s projects in the failure message. -- prose alone does not stop the claim coming back; this file already owns repo-wide source scans.
5. The twelve files in the Code Map -- correct each comment in place, keeping its argument and replacing only the premise. Comment text only; no code change. -- DW-108.
6. `AGENTS.md` -- add a section below `<!-- /bmad:context -->` stating the convention (`*.test.tsx` ⇒ jsdom project + `vitest.setup.dom.ts`; `*.test.ts` ⇒ node project; browser-level checks are Playwright via `pnpm test:e2e`), the symptom of getting it wrong (`document is not defined`), that `vitest.config.ts` refuses to run when the dom include matches nothing, and why the section is outside the managed block. -- DW-111.

**Acceptance Criteria:**

- Given the repo after this change, when `pnpm test` runs, then both projects execute and every suite passes, with no new act warnings or unhandled rejections.
- Given a grep over `src/` for the repo-wide claim ("no DOM test environment", "there is no jsdom", "no DOM (DW-15)", "forbidden from adding jsdom"), when it runs, then it returns nothing — and the new scan case in `workbench-chrome.test.ts` fails if any of them is reintroduced.
- Given `AGENTS.md`, when the `bmad:context` managed block is regenerated, then the test-environment section survives because it sits below the closing marker.
- Given the width-derived mounted cases, when `Workbench.tsx`'s `window.addEventListener("resize", measure)` is deleted, or `showSplitHandle`'s `isSplitMeasured` guard is inverted, then at least one of them fails.
- Given every pre-existing `.test.tsx` suite, when it runs with the harness installed but no rect declared, then it reports the same result as before this change.
- Given `pnpm lint` and `npx tsc --noEmit`, when they run, then neither reports a new error.

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 1, medium 5, low 7)
- defer: 2: (high 0, medium 0, low 2)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[high]` `[patch]` The guard was line-based and scoped to `src/`, so it could not see a claim wrapped across two comment lines — and five files still carried the retired repo-wide claim, one of them verbatim (`workbench-preview.ts:1165`), while `AGENTS.md` asserted the guard rejected it. Rewrote the scan to unwrap comment continuations before matching, replaced the five literal phrases with seven regexes that match the claim rather than one wording, widened the walk to `e2e/`, `AGENTS.md` and the three vitest config/setup files, and corrected all eight surviving sites (`workbench-preview.ts` ×2, `workbench-intake-client.ts`, `workbench-preview.test.ts` ×2, `workbench-split.test.ts`, `write-precondition.test.ts`, `workbench-intake.test.ts`). Proved load-bearing: a wrapped claim reintroduced into `workbench-split.ts` is invisible to the line-based grep and fails the scan by file and pattern.
  - `[medium]` `[patch]` `TreePanel.tsx`'s replacement premise was also false — jsdom executes focus machinery (`workbench-sheet.test.tsx` asserts `document.activeElement` after synthetic Tab). Scoped the unverifiable half to what a screen reader announces per platform, and cited the sheet suite as the counter-example.
  - `[medium]` `[patch]` The `getClientRects` visibility gate was unverified: letting a declared box beat `displayHidden` kept the whole dom project green. Added a case declaring a box on a `hidden` element and on one with inline `display: none`.
  - `[medium]` `[patch]` "Last matching declaration wins" and the `delete`-then-`set` that upholds it were unverified — first-match-wins passed. Added three cases: two overlapping selectors in both orders, plus a re-declared key.
  - `[medium]` `[patch]` `declaredRect()` returned the stored `DOMRect` instance, so every matching element shared one mutable object. Returns `DOMRect.fromRect` copy, pinned by a case that mutates the returned box.
  - `[medium]` `[patch]` The patch round left two `describe("the declared-rect harness itself")` blocks with a duplicate helper and a duplicate `it` name. Merged into one, keeping each unique case.
  - `[low]` `[patch]` `expect(separator(...)).not.toBeNull()` was dead — `getByRole` throws rather than returning null. Positive half is now `queryByRole`.
  - `[low]` `[patch]` `setElementRect` accepted an unparseable selector silently; the `SyntaxError` surfaced from an unrelated element's box read mid-render. Validated at declaration time.
  - `[low]` `[patch]` The `height`/`top` asymmetry (no `offsetHeight` sibling) and the `beforeAll` hazard (`resetElementRects()` runs in `afterEach`) were undocumented. Both stated in the setup file, the first also pinned by an assertion.
  - `[low]` `[patch]` `top` was a declared field with no coverage, and the 700px resize case could read as a claim that a handle is usable at 700px. Added the assertion and the note that CSS hides both handles below 1200px.
  - `[low]` `[patch]` `expect(files.length).toBeGreaterThan(100)` was a weak walk guard against a tree of hundreds of files. Replaced with `toContain` on two files that must be in the list.
  - `[low]` `[patch]` `AGENTS.md` folded `getBoundingClientRect` and `offsetWidth` under `setElementRect`'s name, hiding that both are unconditional prototype overrides, and gave no pointer to running one project or importing the helpers. All three added.
  - `[low]` `[patch]` Comments were edited in place without reflowing, leaving orphan fragments and over-width lines in five files. Re-wrapped.

## Design Notes

Selector-keyed rather than element-keyed, because the decision under test happens AT MOUNT: `Workbench`'s measure effect runs before a test can reach the element, so a `WeakMap<Element, DOMRect>` could only ever drive the resize path. Declaring `.wb-shell` before `render()` is what makes "mounted at 1400px" expressible at all.

```ts
// vitest.setup.dom.ts
const declaredRects = new Map<string, DOMRect>();
const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;

function declaredRect(element: Element): DOMRect | null {
  let found: DOMRect | null = null;          // last declaration wins
  for (const [selector, rect] of declaredRects) {
    if (element.matches(selector)) found = rect;
  }
  return found;
}
```

Failure-mode note for the new cases: `showSplitHandle` gates on `mounted && isSplitMeasured`, so asserting a separator EXISTS is what proves the width arrived. Assert the announced `aria-valuemax` against the clamp too — a handle that renders with the floors as its range is the exact bug `splitStyleVars`/`showSplitHandle`'s measured guard exists to prevent.

## Verification

**Commands:**
- `pnpm test` -- expected: both `node` and `dom` projects run; all suites pass.
- `pnpm lint` -- expected: no errors.
- `npx tsc --noEmit` -- expected: no errors.
- `grep -rniE "no DOM test environment|there is no jsdom|no jsdom and no testing-library|with no DOM \(DW-15\)|forbidden from adding jsdom" src/` -- expected: no matches.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** The repository now tells the truth about its own test environment, and a mounted `Workbench` can be given a width. Every comment that justified a design by a repo-wide absence of a DOM test environment was corrected to name the project its own suite runs in; the `*.test.tsx` ⇒ jsdom / `*.test.ts` ⇒ node convention is stated in `AGENTS.md` below the closing `<!-- /bmad:context -->` marker so a context refresh cannot overwrite it; a repo-wide source scan makes the retired claim fail CI if it returns; and `vitest.setup.dom.ts` gained a declared-rect harness (`setElementRect` / `resetElementRects`) that opens the shell's width-derived decisions — the clamp, both divider ranges, whether a `SplitHandle` renders at all, and the window `resize` listener — to mounted tests for the first time.

**Files changed (20 tracked + this spec):**

- `vitest.setup.dom.ts` — declared-rect registry keyed by CSS selector; `getBoundingClientRect`, `offsetWidth` and `getClientRects` answer a declared box and otherwise delegate to jsdom's own; the FIDELITY LIMIT note replaced with the real contract.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — COVERAGE LIMIT docblock rewritten as the harness's contract; 5 mounted width cases and 10 harness-contract cases added; no existing assertion removed (10 → 25 tests).
- `src/lib/__tests__/workbench-chrome.test.ts` — the retired-claim scan: comment-unwrapping, seven claim regexes, a walk over `src/`, `e2e/`, `AGENTS.md` and the three vitest config/setup files.
- `AGENTS.md` — new `## Test environments` section below the closing managed-block marker.
- `src/lib/workbench-data-version.ts`, `workbench-split.ts`, `workbench-settings.ts`, `workbench-preview.ts`, `workbench-intake-client.ts` — premise corrected, argument kept, comments only.
- `src/components/workbench/SplitHandle.tsx`, `TreePanel.tsx`, `PreviewColumn.tsx`, `SettingsCanvas.tsx` — same, comments only.
- `src/lib/__tests__/workbench-left-column.test.ts`, `workbench-settings.test.ts`, `wiki-schema-edit.test.ts`, `workbench-preview.test.ts`, `workbench-split.test.ts`, `write-precondition.test.ts`, `workbench-intake.test.ts` — same, docblocks only.

**Review findings:** 13 patches applied (1 high, 5 medium, 7 low), 2 items deferred, 5 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommended:** `true`. Patched severities: high 1, medium 5, low 7. A high-severity patched finding forces `true` on its own; the score `3 × 5 + 1 × 7 = 22` also clears the threshold of 5.

**Verification:**

- `pnpm test` — 325 files, 7477 passed / 1 skipped, both `node` and `dom` projects. No act warnings, no unhandled rejections.
- `pnpm lint` — exit 0 (the three `jsx-ast-utils` notices are pre-existing).
- `npx tsc --noEmit` — exit 0.
- `grep -rniE "no DOM test environment|there is no jsdom|…" src/` — no matches.
- Mutation checks, each reverted: deleting `window.addEventListener("resize", measure)` from `Workbench.tsx` fails the resize case; inverting `showSplitHandle`'s `isSplitMeasured` guard fails 5 cases; removing `resetElementRects()` from the setup `afterEach` fails 4; letting a declared box beat `displayHidden` fails 1; first-match-wins in `declaredRect` fails 3; returning the stored instance fails 1. Reintroducing the claim into `workbench-split.ts` WRAPPED across two comment lines is invisible to the line-based grep and fails the new scan by file and pattern.
- `git diff` over the non-test `src/` files is comment-only: no expression, JSX node, prop or export changed. `.github/`, the deferred-work ledger and `vitest.setup.ts` are untouched.

**Residual risks:**

- `Element.prototype.getBoundingClientRect` and `HTMLElement.prototype.offsetWidth` are now overridden for the whole `dom` project. Both delegate whenever nothing is declared and all 53 pre-existing dom suites pass unchanged, but this is the one broad prototype change in the pass.
- A declared box is a stated fact, not a measurement. The new cases pin the shell's reaction to a width and can never catch a CSS or layout mistake; the geometry itself stays executed as rules in `workbench-split.test.ts` against the real stylesheet. The setup file, the suite docblock and `AGENTS.md` all say so, but a future reader could still mistake a declaration for coverage of the layout.
- The claim scan matches patterns, not sentences. It is deliberately narrow enough to leave accurate project-scoped prose alone, which means a sufficiently novel phrasing of the same dead reason could still get through.
