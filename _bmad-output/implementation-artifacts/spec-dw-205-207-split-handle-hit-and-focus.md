---
title: 'DW-205/207: Split handle hit-strip clearance and focus indicator'
type: 'bugfix'
created: '2026-09-02'
baseline_revision: '6d5d0e2001340065f9ea18b4ca24f2cd1633081a'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-dw-44-split-divider-target-and-responsiveness.md'
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      `WorkspacePreview` renders a second `.wb-preview` column whose
      `<header className="wb-preview-header">` matches no rule anywhere in
      globals.css, so that column's title and path have zero padding and no
      separator while its body indents to the clearance.
    evidence: |-
      `WorkspacePreview.tsx:77` renders its own `<aside className="wb-preview">`
      for Agent-workspace picks, and its header at `:84` carries the class
      `wb-preview-header` — one letter off `wb-preview-head`, and
      `grep -n "wb-preview-header" src/app/globals.css` returns nothing. The
      class is dead: no padding, no `border-bottom`, no flex row, so the `<h2>`
      and the path sit flush at the column's x=0 while `PreviewColumn`'s
      equivalent header is a padded, bordered strip. That is pre-existing and
      independent of this change, but DW-205 widens the mismatch inside that
      one column from 16px to 24px, because `.wb-preview-body` there IS matched
      by the clearance rule and the header still is not. The fix is a component
      change (render `wb-preview-head`, or declare the missing rule), which
      moves that column's header geometry — outside a stylesheet-only bundle.
    location: >-
      src/components/workbench/WorkspacePreview.tsx:84
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-44 widened each divider's grab strip to `--wb-split-hit: 24px` and offset both strips RIGHT of their boundary, but the panes those strips now cover still pad their leading edge with `--wb-space-4` (16px). The strip is `z-index: 2`, `touch-action: none` and full height, so ~8px of real content in the canvas and in the docked Preview cannot be clicked, selected or touch-panned (DW-205). Separately, the divider's `:hover` and `:focus-visible` share one rule painting an identical 1px `var(--wb-border)` hairline — a border tone chosen to be quiet against the very surfaces a focus indicator has to stand out from, nowhere near SC 1.4.11's 3:1, and identical to hover (DW-207).

**Approach:** Derive one clearance token from `--wb-split-hit` and pad every pane edge the strips cover with it, so the padding can never drift below the strip width; release it in the same media block that hides the handles. Split the shared hover/focus rule so `:focus-visible` gets its own indicator — a wider rule in `--wb-foreground` drawn on the divider line itself instead of the shell-wide box outline around an invisible 24px strip — with a forced-colours fallback, because forced-colours modes discard the author background the indicator is painted with.

## Boundaries & Constraints

**Always:**
- The clearance is DERIVED from `--wb-split-hit`, never a retyped `24px`. Use `max(var(--wb-space-4), var(--wb-split-hit))` so the padding tracks the strip upward and never falls below the shell's ordinary gutter.
- Every pane edge a strip covers gets the same clearance, so the Preview column's children keep one shared left margin. The strips cover the canvas's leading edge and the Preview column's leading edge only — the tree column and both scrollbars stay clear, as DW-44 arranged.
- The visible divider at REST stays invisible and the hover hairline stays 1px `var(--wb-border)`. Only `:focus-visible` changes appearance.
- Paint from `--wb-*` tokens only, in the shell-scoped rules; the existing bans on Folio tokens and the reading face in this slice still hold.
- Keep `.wb-shell {` unique at column 0 and keep the handle rules ahead of the docked-grid variants — both are pinned by `workbench-split.test.ts`.
- No new `@media (max-width: 1199px)` or `(max-width: 899px)` block; there are exactly two of each and suites slice the file by the last one.

**Block If:**
- The clearance cannot be expressed without a second literal copy of the strip width.

**Never:**
- Do not narrow `--wb-split-hit` or move either strip off its boundary — DW-44 took that decision and SC 2.5.8 depends on it.
- Do not change `SPLIT_HIT_WIDTH` or any other geometry constant in `workbench-split.ts`.
- Do not touch the tree column's padding, the `@media (max-width: 899px)` stacking rules, or the Preview's `border-left`.
- Do not remove the divider's focus indicator outright — replace it, and keep a forced-colours channel.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Canvas beside the tree divider | Viewport ≥1200px | `.wb-canvas-pad` pads left by the clearance token, so the 24px strip covers gutter only and the first characters of a line are clickable | No error expected |
| Docked Preview beside its divider | Viewport ≥1200px, Preview docked | `.wb-preview-head/-fm/-stale/-body/-editor/-note` all pad left by the same clearance, keeping one column margin | No error expected |
| Handles hidden | Viewport ≤1199px | The clearance is released to `--wb-space-4` in the same block that sets `.wb-split-handle { display: none }`; the 900–1199px `--wb-space-2` overrides for the Preview panes still win by source order | No error expected |
| Divider hovered | Pointer over the strip | 1px `var(--wb-border)` hairline at the boundary — unchanged | No error expected |
| Divider focused from the keyboard | `:focus-visible` on the handle | A wider rule in `var(--wb-foreground)` on the divider line, and no 24px box outline around the invisible strip | No error expected |
| Preview divider focused | `:focus-visible`, Preview docked | Indicator still steps 1px inside the boundary so it does not repaint `.wb-preview`'s own border | No error expected |
| Forced colours | `@media (forced-colors: active)` + focus | An `outline` in `CanvasText` restores the indicator, because author backgrounds are discarded there | No error expected |

</intent-contract>

## Code Map

- `src/app/globals.css:2388` -- `--wb-split-hit: 24px` in the single `.wb-shell` token block. The new clearance token belongs immediately after it, with the rest of the spacing scale.
- `src/app/globals.css:2686` -- `.wb-canvas-pad { padding: var(--wb-space-4) }`. Used by `WikiWorkbench.tsx:348`, `SettingsCanvas.tsx:1600` and nine `ModeCanvas.tsx` panes, so one rule covers every mode.
- `src/app/globals.css:4205`–`4253` -- the Preview column's left-edge children: `.wb-preview-head` (`10px var(--wb-space-4)`), `.wb-preview-fm`, `.wb-preview-body` (`var(--wb-space-3) var(--wb-space-4)`).
- `src/app/globals.css:4517`, `4571`, `4584` -- `.wb-preview-editor`, `.wb-preview-note`, `.wb-preview-stale`; the editor's textarea is an interactive target currently overlaid by the strip.
- `src/app/globals.css:5086`–`5150` -- the handle rules: `.wb-split-handle` (`z-index: 2`, `width: var(--wb-split-hit)`, `touch-action: none`), the shared `:hover, :focus-visible` `::before` rule at `:5117`, and `.wb-split-handle--preview::before { left: 1px }` at `:5148`.
- `src/app/globals.css:2540` -- `.wb-shell :where(a, button, input, select, textarea, [tabindex]):focus-visible { outline: 2px solid var(--wb-foreground); outline-offset: 1px }`. READ-ONLY EVIDENCE: `SplitHandle.tsx:95` renders `tabIndex={0}`, so this already reaches the handle and boxes the whole 24px strip — its right edge lands 25px inside the pane. Overriding it per-control by source order is the file's established idiom (`.wb-preview-history-panel:focus-visible` at `:4774`).
- `src/app/globals.css:3731` -- the existing `@media (forced-colors: active)` block, whose comment states the rule this fix has to respect: forced-colours modes discard author backgrounds.
- `src/app/globals.css:5188` -- the LAST `@media (max-width: 1199px)` block, holding `.wb-split-handle { display: none }` at `:5190` and the Preview panes' `--wb-space-2` overrides at `:5210`.
- `src/lib/workbench-split.ts:90` -- `SPLIT_HIT_WIDTH = 24`, the JS copy of the strip width. READ-ONLY: no JS reads the padding, so no third copy is needed.
- `src/lib/__tests__/workbench-split.test.ts:1679`–`1790` -- the `globals.css positions the divider…` describe block, and at `:1682` the `.wb-shell {`-uniqueness pin, at `:1758` the two-blocks-per-query pin. New assertions go here.

## Tasks & Acceptance

**Execution:**
- `src/app/globals.css` -- declare `--wb-split-clear: max(var(--wb-space-4), var(--wb-split-hit));` in the `.wb-shell` token block beside `--wb-split-hit`, with a comment naming DW-205 and why the padding is derived rather than retyped -- one definition is what stops the padding and the strip drifting apart.
- `src/app/globals.css` -- set `padding-left: var(--wb-split-clear)` on `.wb-canvas-pad` and on `.wb-preview-head`, `.wb-preview-fm`, `.wb-preview-stale`, `.wb-preview-body`, `.wb-preview-editor`, `.wb-preview-note`, keeping each rule's existing shorthand ahead of it -- the strip covers both panes' leading edges, and padding only some Preview children would break the column's shared left margin.
- `src/app/globals.css` -- inside the LAST `@media (max-width: 1199px)` block, beside `.wb-split-handle { display: none }`, reset `--wb-split-clear` to `var(--wb-space-4)` on an indented `.wb-shell` selector -- nothing overlays a pane edge once the handles are gone, and declaring the release beside the hide is what keeps them in step.
- `src/app/globals.css` -- split `:5117` into a hover-only rule (unchanged) and a `:focus-visible` rule that widens the `::before` and paints it `var(--wb-foreground)`, plus `.wb-split-handle:focus-visible { outline: none }` after the shell-wide ring, and a `@media (forced-colors: active)` block immediately after those rules restoring an `outline: … CanvasText` -- distinct from hover, above 3:1 against both pane surfaces, and still present where backgrounds are discarded.
- `src/lib/__tests__/workbench-split.test.ts` -- extend the `globals.css positions the divider…` describe with cases for the derived clearance, its readers, its narrow-viewport release, and the focus/hover split (including the forced-colours fallback), parsing values rather than retyping `24px` -- these are the two claims a future edit would otherwise silently undo.

**Acceptance Criteria:**
- Given the stylesheet, when the clearance token is read, then it is declared exactly once, inside the `.wb-shell` token block, as a `max()` over `var(--wb-space-4)` and `var(--wb-split-hit)`, and the file contains no second `24px` literal for it.
- Given a viewport of 1200px or more, when the tree divider is drawn, then the canvas content beside it begins at or after the strip's trailing edge, so no rendered text sits under a `z-index: 2` handle.
- Given a viewport of 1200px or more with the Preview docked, when the Preview column is drawn, then its header, frontmatter strip, stale strip, body, editor and note all resolve the same left padding.
- Given a viewport of 1199px or less, when the handles are hidden, then the clearance resolves to `var(--wb-space-4)` and the existing 900–1199px `var(--wb-space-2)` overrides for the Preview panes still apply.
- Given a divider, when it is hovered, then its hairline is 1px `var(--wb-border)`; and when it is focused via `:focus-visible`, then it paints a wider rule in `var(--wb-foreground)` — a different width AND a different colour, so the two states are not interchangeable.
- Given a focused divider, when the shell's generic focus ring would apply, then it is suppressed for this control only, and a `@media (forced-colors: active)` rule declared after that suppression restores an outline in `CanvasText`.
- Given the repository, when `pnpm test` and `pnpm lint` run, then both pass with no pre-existing assertion changed.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The Preview column has EIGHT leading-edge direct children, not the six the spec enumerated: `.wb-preview-media` (`globals.css:4448`, a sibling of `.wb-preview-body` returned from `PreviewColumn.tsx:1153`, holding the lightbox zoom button and native player bars) and `.wb-preview-history` (`:4673`, `PreviewColumn.tsx:1421`, holding the History toggle, the focusable panel and the `Revert` buttons) were still 8px under the strip. Both added.
  - `[low]` `[patch]` `.wb-preview-note` is also rendered NESTED inside `.wb-preview-media` as the player's failure caption (`PreviewColumn.tsx:1199`), so a class-only match indented it to 16+24=40px, right of the element it captions. The six scattered `padding-left` declarations were replaced by one `.wb-preview > :where(…eight…)` rule; the child combinator leaves the nested caption at 16px and `:where()` keeps the rule at one class so the narrow-viewport `--wb-space-2` tightening still wins.
  - `[low]` `[patch]` The Preview comment claimed "All six" — corrected to name all eight and both halves of the selector as load-bearing.
  - `[low]` `[patch]` The forced-colours fallback is a box around the strip, the very shape the normal-mode rule rejects, with no stated reason. Comment now says why: the `::before` background is exactly what the mode discards, so the outline is the only channel left.
  - `[low]` `[patch]` The test restated the covered list instead of deriving it — the reason two children escaped. It now derives the set from every top-level `.wb-preview*` rule whose `padding` shorthand puts `var(--wb-space-4)` on the horizontal axis, and asserts it equals the rule's `:where()` list in both directions, so a ninth child fails the suite.
  - `[low]` `[patch]` `rule.indexOf("padding:") < rule.indexOf("padding-left:")` passes vacuously at `-1` when a rule has no shorthand; the shorthand's presence is now asserted first.
  - `[low]` `[patch]` `expect(Math.max(gutter, hit)).toBe(SPLIT_HIT_WIDTH)` would fail the day `--wb-space-4` rose above the strip width — the legitimate case `max()` exists for. Now resolves the operands and asserts `>=` against `SPLIT_HIT_WIDTH`.
  - `[low]` `[patch]` Nothing pinned focus AFTER hover; the two `::before` rules tie at (0,2,1), so reordering them would silently restore the DW-207 ambiguity with the suite green. Source order is now asserted.
  - `[low]` `[patch]` The 3:1 claim lived only in a comment. A new case parses the `--wb-foreground` / `--wb-surface` / `--wb-border` hexes from the token block, computes the WCAG relative-luminance ratio, and asserts the indicator clears 3:1 against both adjacent colours and that `--wb-border` against `--wb-surface` does NOT — the reason focus cannot reuse the hover token.
  - `[low]` `[patch]` `css.slice(forced, forced + 400)` was a magic window that stops covering the forced-colours block once a comment is added inside it; it now slices to the block's own closing brace.

## Design Notes

The focus indicator's colour is settled, not chosen freely: `--wb-foreground` is `#171717` and both adjacent surfaces are `--wb-surface` `#ffffff` and `--wb-border` `#e5e5e5`, giving roughly 17.9:1 and 14.2:1 — SC 1.4.11 wants 3:1. `--wb-border` cannot be the focus colour at any width: it is specified as the quiet separator tone against exactly those surfaces.

Shape:

```css
.wb-split-handle:hover::before {
  background: var(--wb-border);
}
.wb-split-handle:focus-visible::before {
  width: 3px;
  background: var(--wb-foreground);
}
```

`.wb-split-handle--preview::before { left: 1px }` still applies to both states, so the Preview indicator keeps stepping inside `.wb-preview`'s own border rather than repainting it.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-split.test.ts` -- expected: all pass, including the new cases.
- `pnpm test` -- expected: the full two-project run passes; in particular `workbench-chrome.test.ts` and `workbench-left-column.test.ts`, which slice this stylesheet.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

DW-205: a single clearance token, `--wb-split-clear: max(var(--wb-space-4), var(--wb-split-hit))`, declared beside `--wb-split-hit` in the one `.wb-shell` token block and read by every pane edge a grab strip covers — `.wb-canvas-pad` on the canvas side, and all eight direct children of `.wb-preview` through one `.wb-preview > :where(…)` rule. `max()` is the pin the ledger asked for: the padding tracks the strip upward and never narrows a pane edge below the shell's ordinary gutter, and there is no second `24px` literal. The token is released back to `var(--wb-space-4)` inside the LAST `@media (max-width: 1199px)` block, beside the rule that hides the handles, so the clearance and the thing it clears for cannot drift apart.

DW-207: `:hover` and `:focus-visible` no longer share a rule. Hover keeps the 1px `var(--wb-border)` hairline; focus paints a 3px `var(--wb-foreground)` rule on the divider line itself (~17.9:1 against `--wb-surface`, ~14.2:1 against `--wb-border`, both now computed in the suite rather than asserted in prose). The shell-wide `:where(…, [tabindex]):focus-visible` ring — which already reached this handle and boxed the whole invisible 24px strip — is suppressed for this control alone by source-order tie, and a `@media (forced-colors: active)` block declared after it restores an outline in `CanvasText`, because forced-colours modes discard the author background the new indicator is painted with.

### Files changed

- `src/app/globals.css` -- the clearance token and its release, the eight-child Preview clearance rule, the canvas pad, and the split hover/focus/forced-colours rules.
- `src/lib/__tests__/workbench-split.test.ts` -- six new cases in the `globals.css positions the divider…` describe: the derived clearance, the derived covered set (both directions), the narrow-viewport release and its ordering, the hover/focus divergence and its source order, the computed contrast ratios, and the ring suppression plus forced-colours fallback.
- `_bmad-output/implementation-artifacts/spec-dw-205-207-split-handle-hit-and-focus.md` -- this spec.

### Review findings

- Patches applied: 9 (1 medium, 8 low) — see the triage log above.
- Items deferred: 1 (low) — `WorkspacePreview`'s `wb-preview-header` matches no rule in `globals.css`.
- Items rejected: 11. The substantive ones and why: the clearance is not released when the tree is COLLAPSED or before the shell is measured, leaving the canvas 24px left against 16px right — real, but purely cosmetic (extra gutter, never a dead target), and one token cannot express it because the Preview handle survives collapse while the tree's does not, so a partial fix would look complete while the unmeasured first paint kept the same asymmetry. `var(--wb-split-clear)` has no fallback outside `.wb-shell` — not a regression, because `padding: … var(--wb-space-4)` is equally undefined there and already computes to 0. The hairline vanishes mid-drag once the pointer outruns the strip while pointer capture holds — real and pre-existing since Story 1.6, not caused or worsened here. `padding-inline-start` over `padding-left` — the handle's own `left`/`right` positioning is physical, so switching only the padding would create the mismatch it is meant to avoid. Closing the DW ledger entries — orchestrator-owned, explicitly out of bounds for this session.
- Follow-up review recommendation: true. Patched severities: high 0, medium 1, low 8; score = 3x1 + 1x8 = 11, which is >= 5.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/workbench-split.test.ts` -- 126 passed.
- `pnpm test` -- 8927 passed, 1 skipped, 2 failed. Both failures are in `src/lib/__tests__/storage-fs.test.ts` (`reapStrandedScratchFiles`, a 5s mtime-window timeout whose dirty tmpdir cascades into the next test in that file). Confirmed PRE-EXISTING: with the change stashed, the clean baseline fails identically (8921 passed, 2 failed, same two tests); the suite passes in isolation (95/95) and a full run with the change in place passed once (8928/8928). The change is CSS plus a CSS-scanning node suite and cannot reach that code.
- `pnpm lint` -- exit 0 (three pre-existing `jsx-ast-utils` `TSNonNullExpression` stderr notices).
- `npx tsc --noEmit` -- exit 0.
- Every I/O matrix row is covered by a case that ran and passed in `workbench-split.test.ts`; the Preview-divider-indicator row is covered by the pre-existing `.wb-split-handle--preview::before { left: 1px }` assertion, which still holds against the new 3px focus width.
- Mutation-checked 13 ways across both passes, each failing exactly the intended case with the file restored byte-identical.

### Residual risks

- Rendered layout is unverified. jsdom computes none and the node project reads `globals.css` as text, so a real-browser check at >=1200px with the Preview docked — and in the 900-1199px band, where the release and the `--wb-space-2` overrides interact — is the only thing that can confirm the strip now covers gutter only. Same residual DW-44 recorded.
- The assertions are string scans of the stylesheet, which is this file's established convention: source formatting and comment prose are load-bearing (the token comment deliberately avoids spelling the breakpoint string, because the suites count its occurrences). A CSS formatter or minifier would break these cases; a genuine layout regression would not.
- Below 1200px, `.wb-preview-head`, `.wb-preview-fm`, `.wb-preview-media` and `.wb-preview-history` stay at 16px while the other four drop to 8px. Unchanged from before this fix and pre-existing.
