---
title: 'DW-44/45/47: Split divider target size, semantics and responsiveness'
type: 'bugfix'
created: '2026-08-18'
baseline_revision: '57f90ac726e51cd980d9aa2518b9cc3aeea67a86'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md'
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The widened 24px grab strip now overlays the leftmost 24px of the canvas
      and of the docked Preview, so a click, text selection or touch-pan that
      starts there hits the divider instead of the content.
    evidence: |-
      `.wb-split-handle` is `z-index: 2`, `cursor: col-resize`, `touch-action:
      none` and full height, and both modifiers now start AT their boundary and
      extend 24px right. `.wb-canvas-pad` and `.wb-preview-body` are both
      `padding: ... var(--wb-space-4)` = 16px, so the strip covers the whole
      gutter plus ~8px of real content in each pane: the first characters of a
      line, and a wikilink sitting at the left margin, are unclickable and
      unselectable, and on a touchscreen at 1200px+ that band cannot be panned.
      DW-44's ledger named "eat 12px of the canvas edge" as the known cost of
      widening and its decision took the trade anyway, so this is authorised
      rather than accidental - but the decision reasoned about scrollbars, never
      about what the strip would cover, and 24px offset to one side eats twice
      what the entry quantified. Choosing between a narrower strip that misses
      SC 2.5.8, matching left padding on both panes, and a documented exception
      is the same chrome decision DW-44 was, one boundary further in.
    location: >-
      src/app/globals.css (.wb-split-handle--tree, .wb-split-handle--preview)
    severity: low
  - summary: >-
      One stored tree scroll offset per tab is shared across the 900px
      breakpoint, where `.wb-tree-body` is capped at 40vh - so crossing into the
      narrow layout restores a desktop offset the browser clamps, and the
      persist writes the clamped value back over it.
    evidence: |-
      `globals.css` caps `.wb-tree-body` at `max-height: 40vh` below 900px, a far
      shorter scroll range than the desktop column. The restore effect assigns
      `panel.scrollTop = readStoredTreeScroll()[tab]`; a value past the narrow
      maximum is clamped by the browser, the clamp fires a `scroll` event, and
      the persist effect writes the clamped number back - so widening again
      lands the tree somewhere it never was. This is pre-existing in kind: a
      narrow LOAD already does exactly this, because `WORKBENCH_TREE_SCROLL_KEY`
      stores one offset per tab and not one per width. DW-47's listener does not
      create it, but it adds a second route into it (resizing) that used to be
      inert. Closing it means keying the stored offset by width band, or
      skipping the persist for a write the restore itself provoked - either is a
      storage-shape decision, not a patch.
    location: >-
      src/components/workbench/TreePanel.tsx (the two scroll effects),
      src/lib/workbench-state.ts (WORKBENCH_TREE_SCROLL_KEY)
    severity: low
  - summary: >-
      A divider's hover and focus-visible states paint an identical 1px
      `var(--wb-border)` line, so keyboard focus is visually indistinguishable
      from hover, and a border-token hairline is unlikely to clear SC 1.4.11's
      3:1 against the surfaces beside it.
    evidence: |-
      `globals.css` declares one rule for both states:
      `.wb-split-handle:hover::before, .wb-split-handle:focus-visible::before {
      background: var(--wb-border); }`. Two separate problems sit on it. First,
      SC 1.4.11 wants a focus indicator at 3:1 against adjacent colours, and
      `--wb-border` is chosen to be a quiet separator colour against exactly the
      panel surfaces it now has to stand out from - the last pass's
      `--wb-split-hit--preview::before { left: 1px }` patch made the indicator
      VISIBLE (WCAG 2.4.7) without touching whether it is visible ENOUGH.
      Second, the two states are pixel-identical, so a keyboard user cannot tell
      focus from a stray pointer, and DW-44's widening enlarges the hover region
      that produces the focus appearance from 9px to 24px. This is pre-existing
      from Story 1.6 in kind - neither the colour nor the shared rule changed
      here - but the widened strip is what makes the ambiguity routine. Fixing
      it means choosing an indicator token (an outline, a second colour, a wider
      rule) against DESIGN.md's palette, which is a chrome decision rather than a
      patch, and the node suites pin this slice to `--wb-*` tokens plus
      `var(--wb-border)` by name.
    location: >-
      src/app/globals.css (.wb-split-handle:hover::before,
      .wb-split-handle:focus-visible::before)
    severity: low
  - summary: >-
      TreePanel's persist effect cancels a pending requestAnimationFrame write in
      its cleanup without flushing it, so a scroll in the last frame before a tab
      switch, a collapse, or now a breakpoint crossing is dropped and the restore
      puts the tree back at the stale offset.
    evidence: |-
      The persist effect coalesces through one frame (`if (frame !== 0) return;
      frame = requestAnimationFrame(...)`) and its cleanup ends
      `if (frame !== 0) cancelAnimationFrame(frame);` - the queued
      `writeStoredTreeScroll(tab, panel.scrollTop)` never runs. The restore
      effect then re-runs on the same dep change and assigns the stored value,
      which is now one frame stale. Pre-existing for `tab` and `collapsed`;
      DW-47's `narrow` dep adds resizing as a third route into it. The fix is
      not a safe one-liner: at cleanup time React has already committed the DOM,
      so on a collapse the panel can be `display: none`, where `scrollTop` reads
      0 - and the obvious guard does not help, because
      `treeBodyShowing(panel, collapsed)` closes over the STALE `collapsed`
      (still `false`) and `treeScrollActive` returns `!collapsed || rendered`,
      i.e. `true` regardless of the element. A correct flush has to ask the
      element directly (`panel.getClientRects().length > 0`), and jsdom answers
      for every attached element, so the guard it depends on cannot be tested
      here. Same storage-shape family as the entry above.
    location: >-
      src/components/workbench/TreePanel.tsx (the persist effect's cleanup)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Story 1.6's dividers carry three recorded debts. The 9px grab strip is centred on each boundary, so it sits on top of `.wb-tree-body`'s scrollbar and is well under WCAG 2.2 AA SC 2.5.8's 24×24 CSS px minimum (DW-44). `role="separator"` names no `aria-controls`, and with only a 16px arrow step crossing the tree's range takes ~30 presses (DW-45). `TreePanel`'s two scroll effects are keyed `[tab, collapsed]`, so an owner who is collapsed and narrows the window past 900px gets a force-shown, scrollable tree whose offset is neither restored nor recorded until they next switch tabs (DW-47).

**Approach:** Widen the hit strip to 24px and offset it fully off whichever scrollbar sits on that boundary, keeping the visible hairline on the boundary and compensating the grab so the divider does not jump to the pointer. Give each separator an `aria-controls` and a PageUp/PageDown coarse step. Promote the 900px breakpoint to one exported constant in `workbench-split.ts` that `Workbench.tsx` and a new `TreePanel` `matchMedia` listener both consume, and retarget `workbench-split.test.ts`'s ban so it forbids ad-hoc literals rather than the shared constant.

## Boundaries & Constraints

**Always:**
- Every number, bound, key mapping and media-query string stays in `src/lib/workbench-split.ts` and is EXECUTED by `workbench-split.test.ts`. Components hold state and read rects; they spell no comparison, no step and no breakpoint. This is the whole reason the module exists (`vitest.config.ts`'s `node` project cannot mount them).
- The strip is offset AWAY from the scrollbar at its own boundary: the tree's scrollbar sits at the tree/canvas boundary, and `.wb-canvas` (`overflow: auto`) puts its own scrollbar at the canvas/Preview boundary. Both strips therefore start AT the boundary and extend to its RIGHT, which is off both scrollbars and gives one uniform rule. Recording this reading explicitly: DW-44's decision says "the canvas side", but its stated purpose is "so the scrollbar stays reachable", and applying the letter to the Preview divider would bury `.wb-canvas`'s scrollbar under 24px of handle — a new regression. Purpose wins; see Design Notes.
- The visible 1px hairline stays exactly on the boundary at both dividers (DW-44: "keep the visual divider at its current width").
- The handle position is still `calc()`-ed from the same `--wb-*` custom properties the grid tracks read. No `left` computed in JavaScript.
- `aria-valuemin`/`aria-valuemax` keep coming from the same `splitBounds` call the clamp obeys, PageUp/PageDown included.
- Handles stay `display: none` below 1200px, inside the media blocks that already exist. Add no new `@media` block to `globals.css`.

**Block If:**
- Closing DW-45's `aria-controls` would require an id on an element `PreviewColumn` does not render (it renders `<aside className="wb-preview">` whenever `previewOpen`, which `shouldDockPreview` makes equivalent to `selection !== null`).

**Never:**
- No `window.innerWidth`, no `ResizeObserver`, no second copy of the 1199px breakpoint anywhere in JS.
- Do not change `--wb-rail`, `--wb-tree`, `--wb-preview`, the three floors, `SPLIT_KEY_STEP`, or any stored key/shape. No storage migration.
- Do not restyle the Preview, the tree or the canvas beyond the handle rules.
- Do not add a DOM (`.test.tsx`) suite for this work; the node scans plus the executed functions are the contract.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Grab offset, tree | `splitGrabOffset("tree", 1000, 0, 1400, 280)` — press 672px right of the shell's left edge with the tree rendered at 280 | `672` clamped to `+24`: the press landed at the strip's right end | No error expected |
| Grab offset, preview | `splitGrabOffset("preview", 1050, 0, 1400, 360)` — raw preview width 350 against a rendered 360 | `-10` | No error expected |
| Grab offset, unmeasured/degenerate | `splitGrabOffset("tree", 60, 0, 1400, 280)` — a press nowhere near the strip | Clamped to `-24`, never an unbounded delta | No error expected |
| Compensated drag | `splitWidthFromPointer("tree", 1000, 0, 1400, 16)` | `1000 - 0 - 48 - 16 = 936` | No error expected |
| Uncompensated drag (default) | `splitWidthFromPointer("tree", 700, 0, 1400)` | `652` — unchanged from Story 1.6, the parameter defaults to `0` | No error expected |
| Coarse grow, tree | `nextSplitWidthFromKey("tree", "PageDown", 280, {min:200,max:900})` | `344` (`SPLIT_KEY_PAGE_STEP` = `SPLIT_KEY_STEP * 4`) | No error expected |
| Coarse shrink, tree | `nextSplitWidthFromKey("tree", "PageUp", 280, {min:200,max:900})` | `216` | No error expected |
| Coarse keys are mirrored on the Preview | `nextSplitWidthFromKey("preview", "PageDown", 360, bounds)` | `296` — PageDown moves the BOUNDARY right, which narrows the Preview, exactly as `ArrowRight` does | No error expected |
| Coarse step clamps | `nextSplitWidthFromKey("tree", "PageUp", 210, {min:200,max:900})` | `200`, not `146` | No error expected |
| Unclaimed key | `nextSplitWidthFromKey("tree", "PageDown", …)` vs `"Enter"` | `number` vs `null`; only a non-null return makes the control call `preventDefault()` | No error expected |
| Breakpoint constants | `SPLIT_WIDE_QUERY` / `SPLIT_NARROW_QUERY` | `"(min-width: 900px)"` / `"(max-width: 899px)"`, both derived from `SPLIT_STACK_BREAKPOINT` and both asserted present in `globals.css` | No error expected |
| No `matchMedia` | `TreePanel` in SSR or an environment without `window.matchMedia` | The listener effect returns early; the two scroll effects still run on `[tab, collapsed]` | No throw |

</intent-contract>

## Code Map

**Extend (edit these existing files and no other source):**
- `src/lib/workbench-split.ts` — `SPLIT_KEY_STEP` (`:66`), `splitWidthFromPointer` (`:246`), `nextSplitWidthFromKey` (`:272`), `treeScrollActive` (`:349`). Adds `SPLIT_HIT_WIDTH`, `SPLIT_KEY_PAGE_STEP`, `SPLIT_STACK_BREAKPOINT`, `SPLIT_WIDE_QUERY`, `SPLIT_NARROW_QUERY`, `splitGrabOffset`; `splitWidthFromPointer` gains a trailing `grabOffset = 0`.
- `src/components/workbench/SplitHandle.tsx` — `role="separator"` block at `:72`. Adds a `controls` prop → `aria-controls={controls}`, and `onStart` becomes `(clientX: number) => void` so the shell can measure the grab. `expect(code).not.toMatch(/\d/)` still holds — neither addition carries a numeral.
- `src/components/workbench/Workbench.tsx` — `WIDE_QUERY` (`:135`, deleted in favour of the import), `LEFT_ID` (`:141`), `startResize`/`dragTo` (`:793-810`), the two `<SplitHandle>` mounts (`~:1000` and the tree one above `<ModeCanvas>`), the `<PreviewColumn>` mount (`:1021`). Adds `PREVIEW_ID`, `grabRef`, and `beginResize`.
- `src/components/workbench/PreviewColumn.tsx` — `PreviewColumnProps` (`:81-121`), the `<aside className="wb-preview">` (`:534`). Adds a required `id: string` prop forwarded onto the `<aside>`. `PreviewPane` is where the `<aside>` actually renders; thread the prop through the `PreviewColumn` → `PreviewPane` boundary the `ref` already crosses.
- `src/components/workbench/TreePanel.tsx` — the two scroll effects (`:127-131`, `:138-154`), both keyed `[tab, collapsed]`. Adds a `narrow` state fed by a `matchMedia(SPLIT_NARROW_QUERY)` listener and a third dep on both effects.
- `src/app/globals.css` — `--wb-split-hit: 9px` (`:2383`), `.wb-split-handle` (`:3642`), `::before` (`:3660`), `--tree`/`--preview` modifiers (`:3673-3678`).
- `src/lib/__tests__/workbench-split.test.ts` — pointer tests (`:328-350`), the Workbench literal ban (`:1136-1144`), the TreePanel ban (`:1235-1255`, the `matchMedia`/`899` lines and the `[tab, collapsed]` count at `:1225`), the CSS position assertions (`:1290-1300`).
- `src/lib/__tests__/workbench-chrome.test.ts:286` — `expect(source).toContain('"(min-width: 900px)"')` on `Workbench.tsx`; retarget to the shared constant.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx:26-27` and `src/components/workbench/__tests__/preview-announcements.test.tsx:50` — local `WIDE_QUERY` mirrors; import `SPLIT_WIDE_QUERY` instead.

**Reuse as-is (do not fork):**
- `src/lib/workbench-split.ts` — `clampSplitWidth` is the ONLY comparison; the grab clamp uses it with a symmetric `{min: -SPLIT_HIT_WIDTH, max: SPLIT_HIT_WIDTH}` range rather than a second `Math.min/max`.
- `src/lib/workbench-tree.ts:372` — `shouldDockPreview(mode, selection)` is `mode === "wiki" && selection !== null`, which is what makes `aria-controls={PREVIEW_ID}` always resolve while the Preview handle is mounted.
- `vitest.setup.dom.ts:64-80` — the `matchMedia` shim mints an unobserved entry per query and defaults `matches: false`, so `TreePanel`'s new call is safe in every existing `.test.tsx` without touching the shim.

**Read-only constraints (do not regress):**
- `workbench-split.test.ts:1335-1338` — exactly two `@media (max-width: 1199px)` and two `@media (max-width: 899px)` blocks, and the LAST 1199px block holds `.wb-split-handle { display: none; }`.
- `workbench-split.test.ts:1345-1355` — the handle slice names only `--wb-*` tokens and contains `var(--wb-border)`.
- `workbench-left-column.test.ts:641,662`, `workbench-chrome.test.ts:210,252,369,457-477`, `workbench-settings.test.ts:1607,1626` — all read `globals.css` media blocks by string; the breakpoints must stay character-identical in CSS.
- `workbench-split.test.ts:1170-1176` — `onLostPointerCapture={onEnd}` alone, exactly one `={onEnd}`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-split.ts` -- add `SPLIT_HIT_WIDTH = 24` (restating `--wb-split-hit`, asserted against the stylesheet like the other six), `SPLIT_KEY_PAGE_STEP = SPLIT_KEY_STEP * 4` (derived, so the coarse step cannot drift off the fine step's pixel grid), `SPLIT_STACK_BREAKPOINT = 900` with `SPLIT_WIDE_QUERY` / `SPLIT_NARROW_QUERY` built from it, `splitGrabOffset(id, clientX, shellLeft, shellWidth, current)`, and a trailing `grabOffset = 0` on `splitWidthFromPointer`; extend `nextSplitWidthFromKey` with `PageUp`/`PageDown` -- one module owns every number, and the coarse step must clamp to the same bounds the fine step does.
- `src/components/workbench/SplitHandle.tsx` -- add a required `controls: string` prop rendered as `aria-controls`, and change `onStart` to take `event.clientX` -- the ARIA window-splitter pattern names the pane a separator resizes, and the shell cannot compensate a grab it was never told the x of.
- `src/components/workbench/PreviewColumn.tsx` -- add a required `id: string` prop threaded through to the `<aside className="wb-preview">` -- an `aria-controls` pointing at nothing is worse than none, and required (not optional) makes a shell that forgot it a compile error.
- `src/components/workbench/Workbench.tsx` -- import `SPLIT_WIDE_QUERY` and delete the local `WIDE_QUERY`; add `PREVIEW_ID` beside `LEFT_ID` and pass it to `<PreviewColumn>` and to the Preview handle's `controls`; pass `LEFT_ID` to the tree handle's `controls`; replace `startResize` with `beginResize(id, clientX, current)` writing `grabRef`, and pass `grabRef.current` into `splitWidthFromPointer` inside `dragTo` -- the shell owns the rect, so it owns the grab.
- `src/components/workbench/TreePanel.tsx` -- add a `narrow` state driven by a `matchMedia(SPLIT_NARROW_QUERY)` `change` listener (seeded synchronously inside the effect, guarded on `typeof window`/`window.matchMedia`) and add it as a third dep to both scroll effects -- crossing 900px is the one transition that changes whether this panel is on screen without `tab` or `collapsed` moving.
- `src/app/globals.css` -- set `--wb-split-hit: 24px`; make both modifiers start AT the boundary and extend right (`.wb-split-handle--tree { left: calc(var(--wb-rail) + var(--wb-tree)); }`, `.wb-split-handle--preview { right: calc(var(--wb-preview) - var(--wb-split-hit)); }`) and move `::before` to `left: 0` -- the strip clears both scrollbars while the hairline stays on the boundary.
- `src/lib/__tests__/workbench-split.test.ts` -- execute every new I/O matrix row (`splitGrabOffset`, the compensated and default `splitWidthFromPointer`, both PageUp/PageDown directions and their clamp, the two query strings); assert `SPLIT_HIT_WIDTH` equals the `--wb-split-hit` declaration and both queries appear in `globals.css`; re-derive the CSS position assertions; retarget the `TreePanel` ban from `matchMedia`/`899` to ad-hoc literals (`899`, `900`, `max-width`, `innerWidth`) plus a required `matchMedia(SPLIT_NARROW_QUERY)`; extend the `Workbench.tsx` ban with `min-width`/`max-width` and require `SPLIT_WIDE_QUERY`; update the `[tab, collapsed]` dep count to the new key -- a ban that names the shared constant would forbid the fix DW-47 records.
- `src/lib/__tests__/workbench-chrome.test.ts` -- retarget `:286` from the `(min-width: 900px)` literal to `SPLIT_WIDE_QUERY` -- the assertion's subject is that the shell observes the breakpoint, not where the string is typed.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx`, `src/components/workbench/__tests__/preview-announcements.test.tsx` -- replace the local `WIDE_QUERY` mirrors with the imported `SPLIT_WIDE_QUERY` -- two more ad-hoc copies of the number DW-47 exists to consolidate.

**Acceptance Criteria:**
- Given the Workbench at ≥1200px with the Preview docked, when the owner points at either divider, then the grab strip is 24 CSS px wide, lies entirely to the right of the boundary, and leaves both `.wb-tree-body`'s and `.wb-canvas`'s scrollbars fully clickable, while the visible hairline is still on the boundary itself.
- Given a press anywhere within a 24px strip, when the pointer then moves, then the boundary tracks the pointer's DISPLACEMENT rather than jumping to it, at both dividers and in both directions.
- Given focus on either separator, when the owner presses PageUp or PageDown, then the boundary moves four arrow steps in the same direction that arrow would move it, stops at the same `aria-valuemin`/`aria-valuemax` the drag stops at, and the browser's own page-scroll default is prevented.
- Given a screen reader on either separator, when it reports the control, then `aria-controls` names an element that exists in the document — the left column for the tree divider, the docked Preview `<aside>` for the Preview divider.
- Given a collapsed left column at ≥900px with a tree scroll offset stored, when the owner narrows the window past 900px so the column is force-shown, then the stored offset is restored without a tab switch, and scrolling the force-shown tree records a new offset; widening back past 900px stops recording again.
- Given the repository, when `pnpm test`, `npx tsc --noEmit` and `pnpm lint` run, then all three are clean and `"(min-width: 900px)"` / `"(max-width: 899px)"` appear as string literals in exactly one TypeScript module.

## Spec Change Log

_No bad_spec loopback occurred._

## Review Triage Log

### 2026-08-18 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 2: (high 0, medium 0, low 2)
- reject: 17: (high 0, medium 1, low 16)
- addressed_findings:
  - `[medium]` `[patch]` The Preview separator's focus indicator became invisible. `::before` moved to `left: 0`, which for that handle is exactly the pixel `.wb-preview`'s `border-left: 1px solid var(--wb-border)` already paints — same width, same colour — so focusing it produced no visible change (WCAG 2.4.7). The centred strip used to put the hairline at boundary−0.5px, half of it on the canvas. Added `.wb-split-handle--preview::before { left: 1px; }`, which reads as the same 2px rule the tree side already produces against `.wb-left`'s `border-right`, and pinned the override plus the border it steps over.
  - `[medium]` `[patch]` DW-47's whole behaviour was pinned by source text — the `matchMedia(SPLIT_NARROW_QUERY)` substring, the guard, the `[tab, collapsed, narrow]` dep key. Wired exactly as written it could still restore nothing with every assertion green. Added `workbench-split-wiring.test.tsx`, which seeds an offset through `writeStoredTreeScroll`, mounts the shell, flips the narrow query and asserts `scrollTop`, then dispatches a scroll and asserts the persist side is still live. Mutation-checked: reverting the dep key fails it.
  - `[low]` `[patch]` Neither `aria-controls` was checked against an element that exists — both docblocks argue "pointing at nothing is worse than none", but TypeScript guarantees only a string. The same new suite resolves `#wb-left-column` and `#wb-preview-column` on the mounted shell, asserts the Preview id lands on the `<aside>` the Preview role names, and adds a negative case for the closed Preview. Mutation-checked: removing either id fails it.
  - `[low]` `[patch]` Nothing pinned the number DW-44 exists to satisfy. The token/constant pair test asserted only that the two copies AGREE, so both could be lowered together with the suite green. Added `expect(SPLIT_HIT_WIDTH).toBeGreaterThanOrEqual(24)` naming SC 2.5.8.
  - `[low]` `[patch]` The `SPLIT_STACK_BREAKPOINT` docblock claimed to be "the only place in the app's source where the strings are written out" — false: `globals.css` spells them in four blocks and several node suites slice the stylesheet by those strings. Reworded to the claim the code supports (the only copy any runtime JavaScript module holds, pinned against the stylesheet's blocks).
  - `[low]` `[patch]` The new query test claimed the two constants are "exact complements", which fails at fractional viewport widths — 899.5px, routine under zoom and fractional DPI scaling, matches neither. The query strings were left character-identical (four `globals.css` blocks and three other suites slice by them); the comment now says the constants mirror those blocks and that the gap is inherited from them.

### 2026-08-18 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 2: (high 0, medium 0, low 2)
- reject: 27: (high 0, medium 2, low 25)
- addressed_findings:
  - `[low]` `[patch]` `SPLIT_NARROW_QUERY`'s docblock claimed the two queries are "its exact complement, so no viewport falls between the two" — false at fractional widths, and the direct opposite of what the previous pass had already written into the test that covers them ("NOT complements, and deliberately not made into them"). The shipped module was the copy a reader opens first. Reworded to state the 899.5px gap, where it comes from (the four `@media` blocks these constants mirror) and why it cannot be closed on this side alone.
  - `[low]` `[patch]` `--wb-split-hit`'s token comment still said "`workbench-split.ts` restates exactly those six" — the module now restates a seventh, as `workbench-split.test.ts` says in the same breath ("The grab strip is the seventh (DW-44)"). Corrected the CSS comment, and the two places in the test file that still called the pairing "six numbers".
  - `[low]` `[patch]` `SplitHandle` was never rendered by any executing test, so DW-45's `aria-controls` and DW-44's `onStart(event.clientX)` were pinned only as source text — and the mounted suite's own COVERAGE LIMIT records why the shell cannot mount one (jsdom answers 0 for every box, so `showSplitHandle` is false). The control needs no shell: it takes no geometry, reads no context and holds no state. Added a direct-render block to the existing wiring suite asserting the emitted `aria-controls` and `aria-orientation` off the rendered node, that a primary press forwards its `clientX`, and that a secondary press forwards nothing. Mutation-checked four ways: dropping `aria-controls`, dropping `aria-orientation`, replacing `onStart(event.clientX)` with `onStart(0)`, and removing the `isPrimarySplitPress` guard each fail exactly one of them.

## Design Notes

**Why both strips extend RIGHT of their boundary.** DW-44's decision says "the canvas side", written while reasoning about the tree divider — whose scrollbar (`.wb-tree-body`, `overflow: auto`) sits at the tree/canvas boundary. `.wb-canvas` is also `overflow: auto`, so its scrollbar sits at the canvas/Preview boundary; putting the Preview strip on the canvas side would bury it under 24px of `z-index: 2` handle and make the canvas unscrollable by mouse wherever the platform draws classic scrollbars. The decision's stated purpose — "so the scrollbar stays reachable" — selects the other side there. Offsetting each strip rightwards satisfies both boundaries and collapses to one rule:

```css
.wb-split-handle::before { left: 0; }              /* hairline on the boundary */
.wb-split-handle--tree    { left: calc(var(--wb-rail) + var(--wb-tree)); }
.wb-split-handle--preview { right: calc(var(--wb-preview) - var(--wb-split-hit)); }
```

**Why the grab offset.** With a centred 9px strip the boundary snapped at most 4.5px to the pointer, which reads as nothing. A 24px strip offset entirely to one side makes that snap up to 24px on the first `pointermove` — visible jank, and a regression the target-size fix would otherwise ship with. `splitGrabOffset` is `splitWidthFromPointer(…) - current`, which works unchanged for both ids because the raw function already flips direction for the Preview; the result is clamped to `±SPLIT_HIT_WIDTH` so a press the browser reports from outside the strip cannot offset the drag arbitrarily.

**Why `SPLIT_KEY_PAGE_STEP` is derived.** `SPLIT_KEY_STEP * 4` rather than `64`: the two steps stay on one pixel grid, and the module gains no seventh magic number to assert against the stylesheet. PageDown moves the boundary right and PageUp moves it left at BOTH dividers — the same "the boundary moves the way the key points" rule the arrows already follow, so the Preview's mapping is inverted relative to its own width exactly as `ArrowRight` already is.

## Verification

**Commands:**
- `pnpm test` -- expected: both projects green, including every new `workbench-split.test.ts` row.
- `npx tsc --noEmit` -- expected: clean; the required `controls` and `id` props make an unwired call site a compile error.
- `pnpm lint` -- expected: clean.
- `rg -n '\(min-width: 900px\)|\(max-width: 899px\)' src --glob '!*.css' --glob '!*__tests__*'` -- expected: only the `SPLIT_STACK_BREAKPOINT` docblock prose in `src/lib/workbench-split.ts`. The `__tests__` exclusion is deliberate and was added after the first run: the remaining matches there are `@media (…)` strings used to SLICE `globals.css` inside `workbench-chrome.test.ts`, `workbench-left-column.test.ts` and `workbench-settings.test.ts` — files this spec's read-only constraints forbid editing, and stylesheet-block selectors rather than JS copies of the breakpoint. The check's subject is runtime source.


## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** No new behaviour this pass — a follow-up review of the DW-44/45/47 bundle already committed as `77a8ef2`. That change closes three Story 1.6 ledger debts under their recorded decisions: the grab strip is 24px (SC 2.5.8's minimum) and offset entirely off the scrollbar at each boundary, with the hairline still on the boundary and a grab-offset term so the divider tracks the pointer's displacement rather than snapping to it (DW-44); both separators carry `aria-controls` and PageUp/PageDown move the boundary four arrow steps, clamped to the announced range (DW-45); one exported breakpoint constant feeds the shell and a new `matchMedia` listener in `TreePanel`, so both scroll effects re-run when the viewport crosses 900px (DW-47). This pass applied three patches, all to the verification and documentation surfaces.

**Files changed in this pass**
- `src/lib/workbench-split.ts` — `SPLIT_NARROW_QUERY`'s docblock no longer claims the two queries are exact complements; it states the fractional-width gap and where it is inherited from.
- `src/app/globals.css` — `--wb-split-hit`'s comment corrected: the module restates those six plus this one, not "exactly those six".
- `src/lib/__tests__/workbench-split.test.ts` — the two comments that still described the token/constant pairing as "six numbers" now describe it as one set.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — a direct-render block for `SplitHandle` (three tests) executing the attributes it emits and the press x it forwards, plus a locally scoped pointer-capture stub (jsdom 30 ships none) and an amended COVERAGE LIMIT docblock.

**Review findings breakdown.** 3 patches applied (0 high, 0 medium, 3 low), 2 items deferred (both low, appended to frontmatter `deferred`), 27 rejected. No intent gap and no spec loopback.

**Follow-up review recommendation:** `false`. Patched counts — high 0, medium 0, low 3; score `3 × 0 + 1 × 3 = 3`, which is below 5.

**Verification performed.**
- `npx vitest run` — 226 files / 4745 tests, all passing (up from 226 / 4742 before this pass; the three new tests are the `SplitHandle` render block).
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0; the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing stderr warnings, not lint errors.
- `rg -n '\(min-width: 900px\)|\(max-width: 899px\)' src --glob '!*.css' --glob '!*__tests__*'` — no matches. The `SPLIT_STACK_BREAKPOINT` docblock prose the first pass reported no longer spells the strings out; only the derived template literals remain.
- Mutation checks on the three new tests: dropping `aria-controls={controls}`, dropping `aria-orientation="vertical"`, replacing `onStart(event.clientX)` with `onStart(0)`, and removing the `isPrimarySplitPress` guard each fail exactly one test and leave the other seven green. `SplitHandle.tsx` was restored byte-identical afterwards.
- Claims checked and found already sound, so not patched: `aria-orientation="vertical"` is present on the separator; `grabRef` cannot go stale because `dragTo` is reachable only through a capture that `beginResize` always precedes; `TreePanel`'s `addEventListener`-only `matchMedia` subscription matches the two the shell already had; DW-45's "~30 presses" figure is correct against the live `splitBounds` (200→672 at 1400px, ÷16 ≈ 30), not the synthetic `{min:200,max:900}` used in the adjacent assertions.

**Residual risks.**
- The four deferred items are the substantive ones: 24px of canvas and Preview content sits under the strip; the tree's stored scroll offset is one number per tab across a breakpoint that changes the scroll range; the divider's focus and hover indicators are pixel-identical and probably short of SC 1.4.11's 3:1; and the persist effect's cleanup drops a pending frame's write.
- DW-44's user-facing property is still unobserved at the surface where it lands. Whether a 24px strip actually clears both scrollbars, and what it now covers, is a rendered-layout question; the node project reads `globals.css` as text and jsdom has no layout engine. A real-browser check at 1200px and above remains the only thing that can close DW-44's "Verify against the tree's scrollbar at both collapsed and expanded widths."
- The intent contract's `Never` list says "Do not add a DOM (`.test.tsx`) suite for this work". The previous pass added `workbench-split-wiring.test.tsx` as an argued exception and recorded it in the triage log; this pass extended that same file rather than adding another, but the divergence stands and is not re-litigated here. It is the one place where the delivered work reads against the frozen intent's letter.
- DW-47's decision says the constant should be "consumed by the stylesheet build". There is no stylesheet build in this repo, so the constant is pinned against `globals.css` by an assertion rather than generating it. Drift is caught, not prevented.
- The persist half of the DW-47 mounted test pins the path surviving the re-run, not the `narrow` dependency itself — jsdom reports a rect for every attached element, so `treeBodyShowing` cannot be made to answer false there. The restore test above it is what pins the dependency.
