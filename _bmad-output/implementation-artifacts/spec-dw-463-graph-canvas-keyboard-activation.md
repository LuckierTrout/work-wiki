---
title: 'DW-463: retire the graph canvas''s inert keyboard focus stop'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      The graph canvas's fallback `<a href={KNOWLEDGE_TREE_HREF}>` child is itself
      focusable, so a keyboard reader can still land on a focus stop inside the
      canvas that renders nothing on screen.
    evidence: |-
      Verified in this repo's jsdom: the fallback anchor reports `tabIndex === 0`
      and becomes `document.activeElement` after `.focus()`. Browsers likewise
      include focusable canvas fallback content in the sequential focus order —
      that is what `CanvasRenderingContext2D.drawFocusIfNeeded` exists for.
      `role="img"` prunes the subtree from the ACCESSIBILITY tree, which is a
      different thing from the focus order. Pre-existing (the fallback child
      predates DW-463) and out of DW-463's scope, which named the canvas element
      itself; the DW-463 pin is deliberately narrowed to the element and says so.
    location: >-
      src/app/wiki/graph/page.tsx:201
    severity: medium
  - summary: >-
      Graph nodes remain unreachable by keyboard: DW-463 was resolved by removing
      the inert focus stop, so the intent's other branch — a keyboard-owned node
      cursor plus onKeyDown reaching the same handler the click does — is
      consciously unbuilt and now has no tracked home.
    evidence: |-
      `handleClick` (src/hooks/useGraphSimulation.ts:272-291) hit-tests
      `e.clientX/clientY` against node positions, and `hoveredRef` is written only
      by `handleMouseMove`, so there is no keyboard-addressable node. Opening a
      wiki page from the graph is therefore pointer-only. The text alternative
      (the Workbench Knowledge tree) covers it for WCAG purposes but is not an
      exact substitute — the graph is `?scope=` lens-scoped and the tree is not,
      as the page's own block comment records. The only trace of the unbuilt
      branch today is a code comment and a test failure message.
    location: >-
      src/app/wiki/graph/page.tsx:186
    severity: medium
  - summary: >-
      Nothing pins that the graph canvas's click activation path stays wired, so
      dropping `onClick` would leave the canvas fully inert with every
      accessibility test still green.
    evidence: |-
      `graph-escape-hatch-mounted.test.tsx` stubs `useGraphSimulation`, and its
      `handleClick` is a fresh `vi.fn()` per render that no test dispatches a
      click at; no other suite mounts this page or exercises the hook. "Pointer
      is the remaining activation path" is the premise the DW-463 removal rests
      on, asserted in three comments and observed nowhere. A hoisted spy plus
      `fireEvent.click(theCanvas())` would make it a fact.
    location: >-
      src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx
    severity: low
baseline_revision: '84484654eb4e27c00afbe3f5c7c43fc0dfd5ca73'
---

<intent-contract>

## Intent

**Problem:** `src/app/wiki/graph/page.tsx` puts `tabIndex={0}` on a `<canvas>` that carries only `onClick`/`onMouseMove`/`onMouseLeave`, so a keyboard-only reader lands on a focus stop where Enter and Space do nothing (DW-463).

**Approach:** The canvas has no keyboard action to offer — `handleClick` hit-tests pointer coordinates against node positions, and nothing in the page or `useGraphSimulation` gives the keyboard a selected node to activate — so remove the focus stop rather than invent a node-selection model. The page's accessible alternative is unchanged and already keyboard-reachable: the visible `Workbench Knowledge tree` link above the canvas. Pin the choice with a mounted assertion so the canvas cannot drift back to focusable-but-inert.

## Boundaries & Constraints

**Always:**
- The canvas keeps `role="img"`, its `aria-label`, and its `<canvas>` fallback child exactly as they are — DW-131's escape hatch is a separate, already-passing contract.
- The visible `<Link href={KNOWLEDGE_TREE_HREF}>` stays outside the canvas and stays in the keyboard order.
- The new pin must fail if `tabIndex` returns to the canvas, and its message must say it is the thing to update if a real keyboard activation path is being added.

**Block If:**
- Removing the focus stop would break an existing test that asserts the canvas IS focusable. (None found during planning; if one appears, halt rather than weaken it.)

**Never:**
- Do not build keyboard node navigation (arrow-key node cursor, focus ring, roving selection). That is a feature, not this defect's fix, and the intent explicitly permits removing the focus stop instead.
- Do not touch `src/hooks/useGraphSimulation.ts` — no handler there changes.
- Do not edit `src/lib/__tests__/retired-surfaces.test.ts`; it asserts nothing about `tabIndex` and must stay green untouched.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Keyboard reader reaches the canvas | Graph page rendered with data (`loading:false`, `empty:false`, `fetchError:null`) | The `<canvas>` is not a tab stop: no `tabindex` attribute, `tabIndex` property negative — so there is no focus stop where Enter/Space is a no-op | No error expected |
| Screen-reader reader on the same page | Same | The canvas is still `role="img"` with an `aria-label` naming the Knowledge tree and still carries its fallback `<a>` child; the visible tree link is still the one reachable link outside the canvas and still has `tabIndex >= 0` | No error expected |

</intent-contract>

## Code Map

- `src/app/wiki/graph/page.tsx:171-190` -- the `<canvas>` element. Line 186 is the `tabIndex={0}` to remove; `role="img"`, `aria-label`, and the fallback `<a href={KNOWLEDGE_TREE_HREF}>` child on the same element are read-only for this change. The block comment at lines ~143-158 already explains the escape-hatch design and is the right place to note why this element is deliberately not a tab stop.
- `src/hooks/useGraphSimulation.ts:272-291` -- `handleClick`, read-only evidence that no keyboard activation is possible today: it derives `mx`/`my` from `e.clientX/clientY` and hit-tests `data.nodes`, and `hoveredRef` (line 38) is written only by `handleMouseMove` (line 226). No selected-node state exists for a key press to stand in for.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` -- the only mounted suite for this page and the reuse point for the pin: it already mocks `@clerk/nextjs` (signed-out), `next/navigation` and `@/hooks/useGraphSimulation` (stubbed at its return shape with `satisfies UseGraphSimulationReturn`, on the one branch that renders the canvas), and already reaches the element via `document.querySelector("canvas")`. Add the pin here, not in a new file — a second file would duplicate that scaffolding and the two stubs would drift.
- `src/lib/__tests__/retired-surfaces.test.ts` (from line 186) -- source-scan pins for the same canvas (`role="img"`, fallback child, `aria-label` wording, `KNOWLEDGE_TREE_HREF`). Read-only; verified it asserts nothing about `tabIndex`, so removing the attribute cannot break it.
- `vitest.config.ts:90-103` -- `*.test.ts` runs in the `node` project, `*.test.tsx` in `dom`; the pin must live in a `.test.tsx` file.

## Tasks & Acceptance

**Execution:**
- `src/app/wiki/graph/page.tsx` -- delete `tabIndex={0}` from the `<canvas>` and add a short comment (in the existing canvas block comment, or immediately above the element) recording that the canvas is deliberately not a tab stop: it is a `role="img"` picture whose keyboard-reachable alternative is the visible Knowledge tree link, and it offers no keyboard activation, so a focus stop would be inert (DW-463). -- removes the inert focus stop and stops the next reader from "fixing" it back.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` -- add a `describe` block (and extend the file's header docblock to say the file now pins two mounted facts about the same canvas: the escape hatch's reachability, and the canvas's absence from the keyboard order) asserting the rendered `<canvas>` is not a keyboard focus stop, with a failure message that names DW-463 and says the pin is what to update if a genuine keyboard activation path is being added. -- this is the pin the intent asks for, and it is what makes the first matrix row observable.

**Acceptance Criteria:**
- Given the graph page rendered with data present, when the document is inspected, then the `<canvas>` has no `tabindex` attribute and its `tabIndex` property is negative (not a tab stop).
- Given the same render, when the Knowledge tree link is inspected, then it is still the one link outside the canvas, still points at `KNOWLEDGE_TREE_HREF`, and still has `tabIndex >= 0` — every existing assertion in `graph-escape-hatch-mounted.test.tsx` still passes unmodified.
- Given the same render, when the canvas is inspected, then `role="img"`, the `aria-label` naming the Knowledge tree, and the fallback `<a>` child are all unchanged.
- Given the repository at the end of this change, when the full test suite runs, then it introduces no new failure, and no test file has been edited other than the additive change to `graph-escape-hatch-mounted.test.tsx`. (The suite is red on the baseline: 233 tests across 13 files under `src/components/workbench/__tests__/` fail in `beforeEach` with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`. Confirmed pre-existing and unrelated — identical failures with this change stashed.)

## Spec Change Log

_No bad_spec loopback occurred; nothing amended._

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 3: (high 0, medium 2, low 1)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` Both focusability reads were attribute-shaped: the `tabIndex`-property test's contentEditable/draggable rationale describes behaviour jsdom does not implement (a `contenteditable` canvas still reports `tabIndex === -1`), so it merely restated the attribute test; and `hasAttribute("tabindex") === false` failed a correct `tabIndex={-1}` while reporting it as a return to the keyboard order. Replaced with a behavioural read (`canvas.focus()`, then `document.activeElement` is not the canvas) plus a markup read accepting absent-or-negative, each documenting what it sees that the other cannot — including that the behavioural read is deliberately the stricter of the two.
  - `[low]` `[patch]` The `aria-label` assertion carried no failure message (breaking this file's convention) and `toMatch` on a removed label would have failed as a matcher type error. Now read once, null-checked with its own message, then matched.
  - `[low]` `[patch]` `theCanvas()` duplicated the inline canvas lookup in the escape-hatch describe. Hoisted to module scope beside `treeLinks()`/`theReachableLink()`, used by both describes, and it now asserts exactly one `<canvas>` rather than taking `querySelector`'s silent first.
  - `[low]` `[patch]` `WHY` renamed to `WHY_NO_TAB_STOP` and reworded so it stays accurate for both reads; the markup read appends the observed `tabindex` value.
  - `[low]` `[patch]` The header and describe claimed the canvas is "not a keyboard focus stop" while its fallback `<a>` child is focusable. Claim narrowed to the canvas ELEMENT, with a SCOPE paragraph recording the fallback child as separate pre-existing work and warning that the DW-461 `role="img"` pruning sentence is about AT exposure, not focus order.
  - `[low]` `[patch]` The new `page.tsx` paragraph called the Knowledge tree link the canvas's alternative three paragraphs below the pre-existing comment saying the tree does not cover this lens-scoped graph's contents. Softened to name it as the advertised text alternative, caveat included.

Rejected (dropped): the "a source scan would need the brace-depth tag scanner" rationale called overstated (both clauses are true as written); the rationale being duplicated across `page.tsx`, the test header and the failure string (this file's idiom, and the cross-references are load-bearing for a reader); the file name no longer naming its second subject (a rename churns history for a fact the header now states); the pin forbidding "focusable" rather than the narrower "focusable-and-inert" (strictly stronger, so it satisfies the intent, and the failure message tells the next implementer to update it); and the `role`/`aria-label` reads duplicating source-surface pins (a deliberate premise guard for the DW-463 argument, as its comment says).

## Design Notes

Why remove rather than add: the intent offers both, selected by "if there is no meaningful keyboard action". There is none — `handleClick` needs pointer coordinates and no keyboard-owned node cursor exists in the page or the hook, so "reach the same handler the click does" is not implementable without first inventing keyboard node selection, which the `Never` list keeps out. The equivalent text alternative is already there and already keyboard-reachable, and a `role="img"` element is not required to be operable.

The pin is a mounted DOM read, not a source scan: "is this a tab stop" is a property of the rendered element, and React props are invisible from the DOM, so a source scan for `onKeyDown` would have to duplicate `retired-surfaces.test.ts`'s brace-depth JSX tag scanner — the duplication hazard DW-460 already recorded.

Shape of the pin:

```tsx
it("keeps the canvas out of the keyboard order", () => {
  render(<GraphPage />);
  const canvas = document.querySelector("canvas")!;
  expect(canvas.hasAttribute("tabindex"), "<msg naming DW-463>").toBe(false);
});
```

## Verification

**Commands:**
- `npx vitest run src/app/wiki/graph src/lib/__tests__/retired-surfaces.test.ts` -- expected: green, the new pin included.
- `npx vitest run` -- expected: no failure beyond the pre-existing `window.localStorage` setup failures in `src/components/workbench/__tests__/` described in the acceptance criteria.
- `npx tsc --noEmit` -- expected: no type errors.
- `npx eslint src/app/wiki/graph` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** DW-463: the graph canvas advertised a keyboard focus stop (`tabIndex={0}`) beside pointer-only handlers, so Enter and Space were a no-op there. The intent allowed either adding a keyboard activation path or removing the focus stop "if there is no meaningful keyboard action"; the second branch is the one the code selects, because `handleClick` hit-tests `e.clientX/clientY` against node positions and no keyboard-owned node cursor exists anywhere in the page or `useGraphSimulation`, so nothing a key press could reach the click's handler with. The focus stop is removed, the decision and its reasoning are recorded in the page's own block comment, and the choice is pinned by a mounted suite so the element cannot drift back to focusable-but-inert. The canvas's `role="img"`, `aria-label` and fallback child — DW-131/DW-461's escape hatch — are untouched.

**Files changed.**
- `../../src/app/wiki/graph/page.tsx` -- dropped `tabIndex={0}` from the `<canvas>`; added a paragraph to the existing canvas block comment recording why the element is deliberately not a tab stop, naming the Knowledge tree link as the advertised text alternative with its lens-scoping caveat, and pointing at the pin.
- `../../src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` -- additive: a `describe("the graph canvas element is not a keyboard focus stop (DW-463)")` with three tests (takes no focus when focus is pushed onto it; spells no focus stop in its markup; keeps the `role="img"` + labelled-alternative semantics that make the missing focus stop correct), a hoisted `theCanvas()` helper now shared with the escape-hatch describe, and a header section explaining the second pinned fact and scoping it to the canvas element rather than its subtree.

**Review findings breakdown.** 6 patches applied (1 medium, 5 low) — see the Review Triage Log. 3 items deferred (2 medium, 1 low) — see frontmatter `deferred`. 5 rejected. 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation.** `true`. Patched findings this pass: high 0, medium 1, low 5. Score = 3x1 + 1x5 = 8, which is >= 5.

**Verification performed.**
- `npx vitest run src/app/wiki/graph src/lib/__tests__/retired-surfaces.test.ts` -- 83 passed (9 mounted + 74 source pins), re-run after the patches. Every pre-existing assertion still passes unmodified.
- `npx tsc --noEmit` -- clean. `npx eslint src/app/wiki/graph` -- clean.
- Mutation check (implementation agent, re-done after the patches): temporarily restoring `tabIndex={0}` fails both DW-463 focus tests with the DW-463 message; restored, 9/9 green. The pin is load-bearing, not vacuous.
- Matrix audit: row 1 (canvas is not a tab stop) is covered by "takes no focus when focus is pushed onto it" and "spells no focus stop in its markup either"; row 2 (picture semantics and the reachable alternative) by "renders the canvas whose alternative this link is", "keeps the picture semantics...", "exposes exactly one Knowledge tree link outside the canvas", "points that link at KNOWLEDGE_TREE_HREF" and "leaves that link in the keyboard order". All ran and passed in the run above.
- `npx vitest run` (full suite) -- 7731 passed, 233 failed across 13 files, all in `src/components/workbench/__tests__/` and all `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage` in `beforeEach`. Independently confirmed pre-existing and unrelated: with this change stashed, `workbench-split-wiring.test.tsx` fails identically (29/29). This change introduces no new failure.

**Residual risks.**
- The keyboard reader's capability is unchanged by this work: they still cannot open a graph node. What is fixed is the misleading affordance. The unbuilt branch of the intent is recorded as a deferred item rather than left implicit in a comment.
- The canvas's fallback `<a>` child is still focusable, so the canvas SUBTREE still contributes a stop a sighted keyboard reader cannot see. Pre-existing, out of DW-463's stated scope, deferred, and explicitly excluded from the new pin's claim.
- The two focusability reads disagree on one state neither the page nor this change produces: `.focus()` succeeds on a `tabIndex={-1}` element, which the behavioural test would reject and the markup test would accept. Both pass today (no attribute at all). The divergence is documented in both tests as a deliberate-decision trigger rather than silently resolved.
- The repository's test suite is red on the baseline for an unrelated `window.localStorage` setup problem in the workbench suites. Nothing here depends on it, but a future run of this spec's full-suite verification will keep reporting it.

