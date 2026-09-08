---
title: 'Withdrawn and remounted workbench surfaces: ask the element, keep the offset, bound the budget per tab'
type: 'bugfix'
created: '2026-08-28'
baseline_revision: 'a809d3d1069fd40c62c7e80e880fce6151b5f19d'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      SourcesTree carries the exact rAF-cancel-without-flush cleanup DW-208
      removed from TreePanel, plus DW-206's single-offset-across-the-breakpoint
      storage shape, and has no test coverage at all.
    evidence: |-
      `src/components/workbench/SourcesTree.tsx` scroll-memory effect is
      byte-for-byte the pre-DW-208 shape: the frame writes
      `writeStoredSourcesScroll(panel.scrollTop)` and the cleanup is only
      `removeEventListener` + `cancelAnimationFrame` with no flush. Its restore
      is a `[]`-keyed mount effect, and `Workbench.tsx` renders it as
      `mode === "sources" && ...` inside a `settingsOpen ? null : ...` branch, so
      the component genuinely unmounts on a mode switch and on opening Settings
      and the cleanup path really runs. `readStoredSourcesScroll` /
      `writeStoredSourcesScroll` / `WORKBENCH_SOURCES_SCROLL_KEY` appear only in
      those two files; no suite mounts SourcesTree, so deleting the effect
      outright would leave the suite green. `readStoredSourcesScroll()` is also a
      single number shared across the 900px breakpoint, and `.wb-sources-tree` is
      `overflow: auto` inside a column whose narrow layout is a stacked row.
    location: >-
      src/components/workbench/SourcesTree.tsx (the scroll-memory effect)
    severity: medium
  - summary: >-
      The Preview column's scroll boxes are discarded by the same Settings visit
      DW-416 fixes for the mode canvas, with no restore and no test.
    evidence: |-
      `globals.css` gives `.wb-preview` and `.wb-preview-body` `overflow: auto`
      (the latter capped at `50vh` below 899px) and `.wb-preview[hidden] {
      display: none }` withdraws the column for the same visit under DW-412, so
      `display: none` discards those scroll boxes exactly as it discards the
      canvas's. `PreviewColumn.tsx` holds no ref or effect for scroll. The
      existing DW-412 case only compares the editor node and its value, never
      `scrollTop`. Two of the three surfaces that visit withdraws now come back
      where the owner left them and the third does not.
    location: >-
      src/components/workbench/PreviewColumn.tsx (the `.wb-preview` aside)
    severity: medium
  - summary: >-
      The restore-clamp-persist echo DW-206 describes still exists WITHIN a band
      and on the mode canvas; band keying removes the cross-breakpoint route
      only.
    evidence: |-
      Both TreePanel's and ModeCanvas's restores assign a stored offset and then
      leave a `scroll` listener live. A `scrollTop` assignment's own `scroll`
      event is dispatched at the next rendering update (CSSOM View), so the
      listener receives it regardless of attachment order. Where the surface has
      not reached its previously persisted content height (async tree data, a
      shorter list after a refresh, a shorter viewport against `40vh`), the
      browser clamps the assignment and the echo records the clamp over the
      owner's offset. Closing it means suppressing a write the restore itself
      provoked - the second fix DW-206's ledger entry offered and the intent did
      not choose - which is a mechanism decision, not a patch.
    location: >-
      src/components/workbench/TreePanel.tsx (restore + persist effects),
      src/components/workbench/ModeCanvas.tsx (the DW-416 effect)
    severity: low
  - summary: >-
      `useDialogA11y`'s widened `withdrawn()` still misses `visibility: hidden`,
      `content-visibility: hidden` and `inert`, which drop a focus() the same way.
    evidence: |-
      `getClientRects()` is non-empty for a `visibility: hidden` element, and
      `globals.css`'s `@media (max-width: 899px)` block hides the closed rail
      exactly that way (`.wb-rail { transform: translateX(-100%); visibility:
      hidden }`, its own comment saying visibility is what "takes them out of
      both"). The predicate's docblock claims "only the ELEMENT can answer it ...
      a node cannot lie about it", which is broader than what it covers. No
      currently reachable dialog has a rail control as its opener, so this is not
      a demonstrated failure - but closing it needs a mechanism the node suites
      can execute (`Element.checkVisibility` is the candidate), and this spec's
      Never list rules out the computed-style route.
    location: >-
      src/hooks/useDialogA11y.ts (withdrawn)
    severity: medium
  - summary: >-
      Below 900px with a docked Preview the DOCUMENT scrolls rather than
      `.wb-canvas`, so DW-416's ref records and restores 0 at that width.
    evidence: |-
      `globals.css`'s narrow block makes `.wb-shell` `overflow: visible` /
      `height: auto` while a Preview is docked, and its own comment says the
      canvas row then "resolves to its content instead of scrolling inside
      `.wb-canvas`'s own `overflow: auto`". At that width the owner's real
      position lives on the scrolling element, which the new effect never reads,
      and ModeCanvas's comment states "`.wb-canvas` is the mode canvas's SCROLL
      CONTAINER" without qualifying the width.
    location: >-
      src/components/workbench/ModeCanvas.tsx (the DW-416 effect)
    severity: low
  - summary: >-
      Both scroll restores run in `useEffect` rather than `useLayoutEffect`, so
      the surface paints at the top before it is scrolled back.
    evidence: |-
      `TreePanel`'s restore (pre-existing) and `ModeCanvas`'s new one both assign
      `scrollTop` from a passive effect, which runs after paint. The `hidden`
      attribute is removed in the commit, the browser paints the surface at 0,
      and only then is the offset re-applied - a visible jump on every
      un-withdrawal. `useLayoutEffect` puts the pixels back before paint. jsdom
      cannot observe the difference, so no suite would catch a regression either
      way.
    location: >-
      src/components/workbench/TreePanel.tsx, src/components/workbench/ModeCanvas.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** Five holes in how surfaces that go OFF SCREEN and components that REMOUNT behave. (DW-421) `useDialogA11y`'s `withdrawn()` guard answers `closest("[hidden]")`, which is this shell's withdrawal convention — but `globals.css:2663-2665` also hides with `.wb-shell[data-collapsed="true"] .wb-left { display: none }`, so an opener or `fallbackFocusRef` inside a collapsed left column is `isConnected`, has no `[hidden]` ancestor, and takes a `focus()` a browser silently drops: DW-414's failure reached by the CSS route. (DW-208) `TreePanel`'s persist effect cancels its pending `requestAnimationFrame` write in the cleanup without flushing it (`TreePanel.tsx:228-231`), so a scroll in the last frame before a tab switch, a collapse, a breakpoint crossing or a Settings visit is lost and the restore that follows re-applies a one-frame-stale offset. (DW-206) One stored offset per tab is shared across the 900px breakpoint, where `.wb-tree-body` is capped at `40vh`: crossing into the narrow layout restores a desktop offset the browser clamps, the clamp fires a `scroll`, and the persist writes the clamp back — so widening again lands the tree somewhere it never was. (DW-416) `.wb-canvas` is the mode canvas's scroll container and `display: none` discards its scroll box, so a Settings visit — DW-373's premise being that the visit costs nothing — still drops the owner at the top of a long canvas. (DW-410) `DataVersionWatcher`'s refresh budget is seeded from `NO_DATA_VERSION_REFRESH` into a ref on every mount, so StrictMode's double-mount or any remount of the shell hands the watcher a fresh budget for a version it has already spent one on — while both its docblock and `data-version.ts`'s prose read as a per-TAB guarantee.

**Approach:** Ask the ELEMENT whether a node is reachable rather than reading a convention off an attribute — `getClientRects().length`, which `vitest.setup.dom.ts` already shims and `treeBodyShowing` already uses, so the node and dom suites can both execute it. Capture the tree's scroll offset AT THE SCROLL EVENT rather than at frame time, so the cleanup has a value to flush that was read while the panel was still on screen. Key the stored tree offset by WIDTH BAND as well as by tab, so the two layouts' scroll ranges stop overwriting each other. Give the mode canvas the same withdrawal-keyed restore `TreePanel` already has, in memory rather than in storage. And move the refresh budget out of the watcher's ref into module state in `workbench-data-version.ts`, which is per tab by construction — the same scope `listeners` already has — then correct the three docblocks that promised it.

## Boundaries & Constraints

**Always:** `withdrawn()` stays ONE predicate used by both restore arms. The rule a node suite can execute stays in a pure module: the width BAND is derived in `workbench-split.ts` beside `treeScrollActive`, never spelled in a component. `TreePanel` continues to spell no width, no `innerWidth` and no breakpoint literal. Every storage read keeps narrowing what it gets back — a hand-edited or older-build value degrades to the top of that tab and band, never to a wrong offset. The canvas restore keys on `hidden` alone, the prop that IS the withdrawal. The refresh budget stays the rule's answer assigned verbatim: the watcher still spells no comparison, no arithmetic and no bound of its own.

**Block If:** `getClientRects()` cannot answer for a node the existing DW-414 cases restore focus to (i.e. making the guard element-based would disable restores the suite currently pins) — that would mean the mechanism cannot be executed in jsdom and the guard needs a different one.

**Never:** Do not add a `visibility`/`opacity` check or a `getComputedStyle` call — jsdom applies no stylesheets, so either would be a claim no suite can execute. Do not use `offsetParent` (always `null` in jsdom; it would disable every restore this suite pins). Do not add a new localStorage key for the canvas offset and do not claim FR-8 cross-session restore for it — DW-416's scope is the Settings visit. Do not key the canvas offset per MODE. Do not persist the refresh budget to storage or make it survive a reload. Do not change `dataVersionRefreshPlan`'s arithmetic, the two wall-clock bounds, or the `40vh` cap and the breakpoint in `globals.css`. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dialog closes, opener hidden by CSS alone | Opener `isConnected`, no `[hidden]` ancestor, inside a `display: none` subtree | No `focus()` on the opener; the fallback is tried the same way, and if it is unreachable too focus is left where the owner put it | No error expected |
| Dialog closes, opener on screen | Opener connected and rendered | Focus restored to the opener, unchanged from today | No error expected |
| Dialog closes, opener inside `[hidden]` | The DW-414 case | Still refused — the attribute route keeps working | No error expected |
| Tree scrolled in the frame before a tab switch | `scroll` fires, then `tab` changes before the rAF runs | The pending offset is written for the OLD tab, then the new tab's offset is restored | A cleanup with no pending write flushes nothing |
| Tree scrolled while the panel is being withdrawn | `scroll` fires, then `collapsed`/`hidden` goes true | The captured offset is still written — it was read at event time, while the panel was showing | Never writes a `scrollTop` read from a `display: none` panel |
| Crossing 900px with a desktop offset stored | Wide band holds 900, viewport narrows | The NARROW band's own offset is restored; a clamp the browser then applies is written back to the narrow band only | Wide band still reads 900 on widening |
| Legacy stored tree offset (a bare number per tab) | `{"knowledge":120}` from before this change | Read as the WIDE band's offset for that tab; the narrow band starts at the top | Anything else degrades to 0 for both bands |
| Settings visit over a scrolled canvas | `.wb-canvas` scrolled, Settings opens then closes | The canvas comes back at the same offset | An unscrolled canvas restores 0, a no-op |
| Watcher remounts mid-budget | A version already refreshed for, watcher unmounts and remounts | The budget is unchanged: the ceiling for that version still holds across the remount | A reload starts a fresh tab and a fresh budget |

</intent-contract>

## Code Map

- `src/hooks/useDialogA11y.ts` -- DW-421 fix site. `withdrawn(node)` :65-67 with its docblock :51-64; the two restore arms :163-164 (`opener?.isConnected && !withdrawn(opener)` / `fallback?.isConnected && !withdrawn(fallback)`), which `create-wiki-ui.test.ts:126-141` pins as source text and must keep their spelling.
- `src/components/workbench/TreePanel.tsx` -- DW-206 + DW-208 fix site. `treeBodyShowing` :125-127 (the `getClientRects().length > 0` precedent DW-421 copies); `narrow` state + `matchMedia` effect :174-187; restore effect :197-201 (`panel.scrollTop = readStoredTreeScroll()[tab]`, key `[tab, collapsed, narrow, hidden]`); persist effect :216-232 with the rAF coalescing :219-226 and the cleanup :228-231 that cancels without flushing.
- `src/lib/workbench-state.ts` -- DW-206 storage shape. `WORKBENCH_TREE_SCROLL_KEY` :50; `readStoredRecord` :131 / `writeStoredJson` :147 (reuse, do not duplicate); `storedOffset` :256-260; `readStoredTreeScroll` :267-274 and `writeStoredTreeScroll` :276-281 — both signatures change.
- `src/lib/workbench-split.ts` -- where the band rule belongs. `SPLIT_STACK_BREAKPOINT` :106, `SPLIT_NARROW_QUERY` :119, and `treeScrollActive` (further down, exported) — the precedent for "the component asks, this module says what the answer means".
- `src/components/workbench/ModeCanvas.tsx` -- DW-416 fix site. Imports `type { ReactNode }` only :3 (needs `useEffect`/`useRef`); `hidden` prop :70-77; the `<section className="wb-canvas" hidden={hidden}>` :119-138 — the scroll container, which currently takes NO ref.
- `src/components/workbench/DataVersionWatcher.tsx` -- DW-410 fix site. `refreshStateRef` :76 with the docblock :69-75 whose last sentence ("Ref state, so it resets on remount") is the false claim; the plan call :94-100.
- `src/lib/workbench-data-version.ts` -- where the budget moves. Module-level `listeners` :383 and `_resetDataVersionListeners` :413 are the precedent for per-tab module state plus a test-only reset; `NO_DATA_VERSION_REFRESH` :186-199 ("handed into every mounted watcher's ref") and `DataVersionRefreshState` :170-184 ("Ref state in the watcher, so it resets on remount") are the two docblocks to correct.
- `src/lib/data-version.ts` -- `readDataVersion`'s docblock :53-71 states the budget as a per-observed-version guarantee without naming the scope. Make the per-tab scope explicit; change no code.
- `src/app/globals.css` -- READ-ONLY evidence. `.wb-shell[data-collapsed="true"] .wb-left { display: none }` :2663-2665 (DW-421's CSS route); `.wb-canvas { overflow: auto }` :2679-2685 (DW-416's scroll container); `.wb-tree-body { max-height: 40vh }` inside the `@media (max-width: 899px)` block :5215 (DW-206's second range).
- `vitest.setup.dom.ts` -- the mechanism that makes DW-421 executable. `displayHidden` :180-184 walks ancestors for `hidden` or INLINE `display: none`; `getClientRects` :348-361 returns `[]` for a node that fails it. So a test states the CSS route with `style={{ display: "none" }}` on an ancestor.
- `src/hooks/__tests__/useDialogA11y.test.tsx` -- DW-421's suite. `WithdrawnHost` :164-200 is the shape to copy for a CSS-hidden host; the DW-414 describe :325-406 must stay green unchanged.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` -- DW-206/208's mounted suite. `renderShell` :137-149, `treeBody()` :151-155; the DW-47 pair :500-553 and the Settings pair :554-613 all call `writeStoredTreeScroll("knowledge", 120)` / `readStoredTreeScroll().knowledge` and WILL BREAK on the new signature.
- `src/lib/__tests__/workbench-split.test.ts` -- the node-side pins that WILL BREAK: the `readStoredTreeScroll` describe :988-1035 (shape, rounding, degrade, throwing store) and the source scans :1449-1450 (`panel.scrollTop = readStoredTreeScroll()[tab]`, `writeStoredTreeScroll(tab, panel.scrollTop)`), plus the dep-key and rAF scans :1462-1466/:1532-1538 which stay but need extending.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- DW-416's suite. `renderShell`/`open()`/`closeSettings()` helpers and the "keeps the Preview editor's unsaved markdown" case :529-554 are the shape to copy for "the canvas comes back where it was".
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- DW-410's suite. `mountWatcher` :84+, `REFRESH_CEILING` :53-55, and the budget cases :228-360 are what a remount case must sit beside; the file needs the new module reset in its `beforeEach` beside `_resetDataVersionListeners`.
- `src/lib/__tests__/workbench-data-version.test.ts` -- the source scans that WILL BREAK: :1534 `refreshStateRef.current = plan.state;`, :1537 `useRef(NO_DATA_VERSION_REFRESH)`, :1545 `state: refreshStateRef.current,`, :1579 and :1616 (the ordering pin, anchored on the same string).

## Tasks & Acceptance

**Execution:**
- `src/hooks/useDialogA11y.ts` -- widen `withdrawn()` to `node.closest("[hidden]") !== null || node.getClientRects().length === 0`, keeping both routes: the attribute is the shell's stated convention and survives an author rule that overrides the UA sheet's `display: none`, while the rect check is what catches a node hidden by CSS alone. Rewrite the docblock to name the CSS route (`.wb-shell[data-collapsed="true"] .wb-left`), to say why `offsetParent` is not the mechanism (always `null` in jsdom — it would disable every restore the suite pins), and to point at `treeBodyShowing` as the same question asked elsewhere in the shell. Leave both call sites' spelling exactly as `create-wiki-ui.test.ts` pins it.
- `src/lib/workbench-split.ts` -- add `TreeScrollBand` (`"wide" | "narrow"`), `TREE_SCROLL_BANDS`, and `treeScrollBand(narrow: boolean): TreeScrollBand` beside `treeScrollActive`, with a docblock saying the band is a property of the LAYOUT (the 900px stack, where `.wb-tree-body` is capped at 40vh) and not of the storage — so the component keeps spelling no width and the node suite executes the mapping.
- `src/lib/workbench-state.ts` -- key the stored offset by band: `readStoredTreeScroll(): Record<TreeTabId, Record<TreeScrollBand, number>>` and `writeStoredTreeScroll(tab, band, offset)`, both still going through `readStoredRecord`/`writeStoredJson`/`storedOffset`. Accept a legacy per-tab NUMBER as that tab's WIDE offset (an offset stored before this change was recorded against a range only the desktop layout has) and start the narrow band at the top; anything else degrades to 0 for both bands. Explain in the docblock why one offset per tab was wrong.
- `src/components/workbench/TreePanel.tsx` -- derive `const band = treeScrollBand(narrow);` and use it in both effects (`readStoredTreeScroll()[tab][band]`, `writeStoredTreeScroll(tab, band, …)`). In the persist effect, capture the offset AT THE SCROLL EVENT into a local (`pending`) instead of reading `panel.scrollTop` inside the frame callback, and make the cleanup flush a pending value before cancelling the frame. Explain in the comment why the flush cannot read the element at cleanup time (React has already committed, so on a collapse the panel is `display: none` and `scrollTop` reads 0, and `treeBodyShowing(panel, collapsed)` would close over the stale `collapsed`) and why capturing at event time removes the question entirely.
- `src/components/workbench/ModeCanvas.tsx` -- add a `canvasRef` on the `<section className="wb-canvas">` and one effect keyed on `[hidden]`: while showing, re-apply the remembered offset, then attach a `passive` `scroll` listener that records `scrollTop` into a ref; the cleanup removes the listener. Document that the offset lives in a ref rather than in storage (the section survives the visit MOUNTED, which is DW-373's whole premise, so nothing has to cross a reload) and that the restore must precede the listener so the position is established before anything can observe it — while stating plainly that this does NOT keep the assignment's own `scroll` away from the listener (that event is dispatched at the next rendering update, not synchronously), so the listener re-records the value just re-applied: a no-op except where the browser clamped it.
- `src/lib/workbench-data-version.ts` -- move the budget to module state: a module-level `DataVersionRefreshState` seeded from `NO_DATA_VERSION_REFRESH`, with `readDataVersionRefreshState()`, `recordDataVersionRefreshState(state)` and a test-only `_resetDataVersionRefreshState()`, all beside `listeners` and `_resetDataVersionListeners` and documented as the same per-tab scope. Correct `DataVersionRefreshState`'s and `NO_DATA_VERSION_REFRESH`'s docblocks, which both currently promise ref-per-watcher semantics.
- `src/components/workbench/DataVersionWatcher.tsx` -- drop `refreshStateRef` for `state: readDataVersionRefreshState()` and `recordDataVersionRefreshState(plan.state);`, keeping the record ABOVE the `if (!plan.refresh) return;` guard. Rewrite the ref's docblock into the per-tab statement, naming the remount routes it now survives (StrictMode's double-mount, a route change, a shell remount) and what still resets it (a reload — a new tab, a new budget).
- `src/lib/data-version.ts` -- amend `readDataVersion`'s docblock so the bound it describes is stated as per observed version PER TAB, with the remount escape hatch named as closed. No code change.
- `src/lib/__tests__/workbench-split.test.ts` -- extend the `treeScrollActive` describe with `treeScrollBand`/`TREE_SCROLL_BANDS`; rewrite the `readStoredTreeScroll` describe for the banded shape (defaults, per-tab-per-band round trip, rounding, the legacy-number migration, the degrade table, the throwing store and the server render); update the two source scans to the banded spellings and add pins for the band derivation (`treeScrollBand(narrow)` present, no band literal typed in the component) and for the flush (`pending` captured in `onScroll`, written in the cleanup before `cancelAnimationFrame`).
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` -- update the four existing calls to the banded signature; add a DW-206 case (a wide offset stored, the viewport narrows, the narrow band's own offset is restored and a scroll recorded there leaves the wide band untouched) and a DW-208 case (a scroll dispatched in the same act as a tab switch, with no frame allowed to run, still lands the old tab's offset in storage).
- `src/hooks/__tests__/useDialogA11y.test.tsx` -- add a DW-421 describe beside the DW-414 one: a host whose opener sits inside an ancestor with inline `display: none` and no `[hidden]` anywhere (the collapsed left column, as far as jsdom can state it) — the close refuses that opener, falls through to a fallback that IS on screen, and refuses the fallback too when it is inside the same subtree. Assert the positive control in the same block: an ordinary connected opener still gets focus.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- add a DW-416 case in the DW-373 block: scroll `.wb-canvas`, open Settings (the section is `hidden`, the browser's `scrollTop = 0` stood in for as the tree cases do), close it, and assert the SAME node comes back at the same offset — plus that a scroll recorded after the visit replaces it.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- reset the new module state in `beforeEach`; add a DW-410 case that spends part of a version's budget, unmounts and remounts the watcher, and asserts the ceiling for that version still holds across the remount (compare against `REFRESH_CEILING`, never a retyped 3), and a companion asserting the reset itself re-arms it so the case cannot be passing vacuously.
- `src/lib/__tests__/workbench-data-version.test.ts` -- update the five `refreshStateRef` source scans to the new accessor spellings, keep the record-before-guard ordering pin anchored on `recordDataVersionRefreshState(plan.state);`, and add a scan that the watcher holds no `useRef(NO_DATA_VERSION_REFRESH)` any more — the ref being gone is the fix.

**Acceptance Criteria:**
- Given a dialog whose opener is connected but unreachable by either route (a `[hidden]` ancestor or CSS alone), when it closes, then focus is never sent into that subtree and the fallback is judged by the same predicate.
- Given the tree is scrolled and the panel is then withdrawn or re-keyed in the same commit, when the effect's cleanup runs, then the offset captured while the panel was on screen is what storage holds — never a `scrollTop` read from a `display: none` panel, and never nothing.
- Given offsets recorded on both sides of the 900px breakpoint, when the viewport crosses it in either direction, then each layout restores the offset recorded in that layout and neither write reaches the other band.
- Given the mode canvas is scrolled, when Settings opens and closes, then the same section node is back at the same offset, and no new localStorage key exists.
- Given a version whose refresh budget is partly spent, when the watcher unmounts and remounts in the same tab, then the total refreshes issued for that version still stop at the ceiling the two wall-clock bounds derive.

## Spec Change Log

### 2026-08-28 — ModeCanvas echo rationale corrected (no implementation loopback)

- **Triggering finding:** the DW-416 execution task instructed the code to document "the restore must precede the listener so it does not echo its own write". That is factually wrong: per CSSOM View a `scrollTop` assignment's `scroll` event is dispatched at the next rendering update, not synchronously, so a listener attached on the following line still receives it.
- **Amended:** the DW-416 execution task's documentation clause, to state the real reason the ordering is kept (the position is established before anything observes it) and to name the echo as real but harmless except under a clamp.
- **Known-bad state avoided:** shipping a comment that tells the next reader a hazard is guarded when it is not — the exact way the clamp-echo residual would have been re-closed as "already handled".
- **KEEP:** the effect's shape is correct and unchanged — `canvasRef` on the `.wb-canvas` section, one effect keyed on `[hidden]` alone, restore then passive listener, offset in a ref rather than storage, no per-mode key. Only the comment's rationale was wrong; the code was not re-derived.

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 6: (high 0, medium 3, low 3)
- reject: 14: (high 0, medium 2, low 12)
- addressed_findings:
  - `[medium]` `[patch]` `ModeCanvas.tsx` claimed that attaching the scroll listener after the restore keeps the restore's own `scroll` out of it. A `scrollTop` assignment's event is dispatched at the next rendering update, so the listener does receive it. Comment rewritten to state the real reason for the ordering and to name the clamp-echo residual; the residual itself is deferred. Spec task wording corrected in the Spec Change Log.
  - `[low]` `[patch]` `data-version.ts`'s new DW-410 scope sentences were spliced into the middle of the DW-377 clause, leaving a run-on and two over-wide lines. Moved after the "Per version, not in total" clause and reflowed; the per-tab statement and the closed remount escape hatch are unchanged in substance.

## Design Notes

**One predicate, two routes.** `getClientRects()` subsumes `[hidden]` in a real browser and in the dom shim, so the `||` looks redundant — it is not. `globals.css` argues at length that `hidden` is only a presentation hint an author rule can defeat, and the attribute is the shell's STATED withdrawal; keeping it means the convention still answers even where a stylesheet has overridden `display`. The rect check is the one a node CANNOT lie about.

**The flush needs no element question.** The obvious fix — read `panel.scrollTop` in the cleanup — cannot work: React has committed by then, so on a collapse the panel is `display: none` and reads 0, and `treeBodyShowing(panel, collapsed)` closes over the STALE `collapsed`. Capturing at event time removes the question:

```ts
let frame = 0;
let pending = -1;
const onScroll = () => {
  pending = panel.scrollTop; // read while the panel is demonstrably showing
  if (frame !== 0) return;
  frame = requestAnimationFrame(() => { frame = 0; writeStoredTreeScroll(tab, band, pending); pending = -1; });
};
return () => {
  panel.removeEventListener("scroll", onScroll);
  if (frame === 0) return;
  cancelAnimationFrame(frame);
  if (pending >= 0) writeStoredTreeScroll(tab, band, pending);
};
```

`scrollTop` cannot move without a `scroll` event, so the value the frame would have read and the value the event captured are the same one — this loses nothing and gains a flush.

**Per tab, by construction.** `workbench-data-version.ts` already holds `listeners` at module scope precisely because that scope IS the tab: one module instance per document, gone on reload, shared by every mount inside it. Putting the budget there makes the docblocks' existing promise true without inventing a store, and the existing `_resetDataVersionListeners` is the precedent for the test-only reset the suites need.

## Verification

**Commands:**
- `pnpm exec vitest run src/hooks/__tests__/useDialogA11y.test.tsx src/components/workbench/__tests__/workbench-split-wiring.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx src/components/workbench/__tests__/data-version-watcher.test.tsx src/lib/__tests__/workbench-split.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/workbench-chrome.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline (capture the baseline by stashing `src/` at HEAD and re-running)
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

### Summary

Five holes in how withdrawn and remounted workbench surfaces behave, closed together (DW-206, DW-208, DW-410, DW-416, DW-421). Focus restoration now asks the ELEMENT whether a node is reachable (`getClientRects().length`) rather than reading the `[hidden]` convention alone, so an opener inside a CSS-hidden collapsed column is refused the same way a withdrawn one is. The tree's scroll offset is captured at the scroll EVENT and flushed by the effect cleanup instead of being cancelled unwritten, and is keyed by WIDTH BAND as well as by tab so the desktop and 40vh-capped narrow layouts stop overwriting each other. The mode canvas gets `TreePanel`'s withdrawal-keyed restore in memory, so a Settings visit no longer drops the owner at the top. The dataVersion refresh budget moves from a per-mount `useRef` into module state in `workbench-data-version.ts` — per tab by construction, the same scope `listeners` already has — which makes the per-tab guarantee its three docblocks promised actually true.

This run is attempt 2. Attempt 1 implemented the same spec and exceeded its token budget during review; the orchestrator rolled the tree back to `a809d3d1` and preserved the worktree at `refs/attempt-preserve-dirty/20260826-224036-f3da-a809d3d1-1`. This session restored that implementation, re-verified it end to end independently (see Verification below), ran the review layers, and applied the resulting patches.

### Files changed

- `src/hooks/useDialogA11y.ts` — `withdrawn()` widened to `closest("[hidden]") !== null || getClientRects().length === 0`; docblock rewritten to name the CSS route, why `offsetParent`/`getComputedStyle` are not the mechanism, and `treeBodyShowing` as the same question. Both call sites keep their pinned spelling.
- `src/lib/workbench-split.ts` — new `TreeScrollBand`, `TREE_SCROLL_BANDS`, `treeScrollBand(narrow)` beside `treeScrollActive`, so the band is a property of the layout decided in the module and the component still spells no width.
- `src/lib/workbench-state.ts` — stored tree offset becomes `Record<TreeTabId, Record<TreeScrollBand, number>>`; `writeStoredTreeScroll(tab, band, offset)`. A legacy bare number reads as that tab's WIDE offset and is normalised on the first write; anything else degrades to 0 for both bands.
- `src/components/workbench/TreePanel.tsx` — derives `band`, uses it in both effects, captures the offset at the scroll event into `pending`, and flushes it in the cleanup before cancelling the frame.
- `src/components/workbench/ModeCanvas.tsx` — `canvasRef` on `.wb-canvas` plus one `[hidden]`-keyed effect: restore the remembered offset, then attach a passive scroll listener that records it. Offset in a ref, no new storage key, no per-mode key.
- `src/lib/workbench-data-version.ts` — module-level `refreshState` with `readDataVersionRefreshState`, `recordDataVersionRefreshState` and test-only `_resetDataVersionRefreshState`, beside `listeners`; the two docblocks that promised ref-per-watcher semantics corrected.
- `src/components/workbench/DataVersionWatcher.tsx` — `refreshStateRef` dropped for the module accessors, with the record kept above the `if (!plan.refresh) return;` guard.
- `src/lib/data-version.ts` — `readDataVersion`'s docblock now states the bound as per observed version PER TAB with the remount escape hatch named as closed. No code change.
- Suites updated/extended: `src/lib/__tests__/workbench-split.test.ts`, `src/components/workbench/__tests__/workbench-split-wiring.test.tsx`, `src/hooks/__tests__/useDialogA11y.test.tsx`, `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx`, `src/components/workbench/__tests__/data-version-watcher.test.tsx`, `src/lib/__tests__/workbench-data-version.test.ts`.

### Review findings breakdown

- **Patches applied: 2** — `ModeCanvas.tsx`'s false echo-protection rationale (medium) and `data-version.ts`'s spliced, over-wide docblock insertion (low). Both detailed in the Review Triage Log.
- **Deferred: 6** — recorded in frontmatter `deferred`. The two that matter most: `SourcesTree` still carries DW-208's exact unflushed-cleanup shape *and* DW-206's single-offset storage with zero test coverage, and `PreviewColumn` loses its scroll box to the same Settings visit DW-416 fixes for the canvas.
- **Rejected: 14** — including renaming `withdrawn()` (its call-site spelling is pinned by a source scan), the module header's "pure" claim (mutable module state predates this change: `listeners`), the repeated DW-410 rationale (house comment style), and splitting the bundle (the bundle is the unit of work the orchestrator dispatched).
- **Follow-up review recommended: false.** Patched counts: high 0, medium 1, low 1 → score `3×1 + 1×1 = 4`, below the threshold of 5.

### Verification performed

- `pnpm exec tsc --noEmit` — clean.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from baseline).
- Targeted node suites (`workbench-split.test.ts`, `workbench-data-version.test.ts`, `create-wiki-ui.test.ts`, `workbench-chrome.test.ts`) plus `useDialogA11y.test.tsx` and `data-version-watcher.test.tsx` — 287 passed, 0 failed, re-run after the patches.
- `workbench-split-wiring.test.tsx` — 29/29 passed; `settings-canvas-persistence.test.tsx` — 28/28 passed.
- `pnpm test` — 13 test files fail identically before and after this change: **229 failed / 7446 passed** with the change against **224 failed / 7433 passed** at `a809d3d1`. The delta is exactly the 5 new cases this change adds to two of those already-red files; no new failing file and no new failure mode. See the environment note below.
- **Environment fault, pre-existing and unrelated:** on Node v26.8.1 the runtime's own `localStorage` global shadows jsdom's, so `window.localStorage` is `undefined` in the `dom` project and every dom suite that calls `window.localStorage.clear()` in `beforeEach` dies at setup — at `a809d3d1` as much as here (verified by stashing `src/` and re-running). To actually execute this change's DOM assertions the two affected suites were run with `NODE_OPTIONS=--localstorage-file=<tmp>`, one fresh store per file (Node's store is process-wide, so running both in one process leaks state between them and produces three spurious failures). Under that workaround both suites pass in full.
- **Matrix test audit:** all nine I/O & Edge-Case Matrix rows have a covering test that ran and passed — DW-421's three dialog rows in `useDialogA11y.test.tsx` (incl. the positive control and the unchanged DW-414 block), DW-208's two flush rows and DW-206's crossing row in `workbench-split-wiring.test.tsx`, the legacy-shape row in `workbench-split.test.ts`, DW-416's Settings row in `settings-canvas-persistence.test.tsx`, and DW-410's remount row (with its non-vacuity companion) in `data-version-watcher.test.tsx`.

### Residual risks

- **Every one of these five expectations lives at the browser layout surface, and jsdom has none.** The clamp DW-206 is about is stood in for by a hand-dispatched scroll; DW-421's class rule (`.wb-shell[data-collapsed="true"] .wb-left`) is stated through an *inline* `display: none`, which is all `vitest.setup.dom.ts`'s shim can walk; DW-416's discarded scroll box is stood in for by writing `scrollTop = 0`; and DW-208's "the flushed number is not the 0 a `display: none` panel reports" is enforced by source-text scans, not behaviour — a cleanup that re-read the element would pass the mounted cases. Each substitution is disclosed in a comment at its site.
- The restore→clamp→persist echo is closed across the breakpoint but not within a band, and the same shape now exists on the canvas — deferred above, since closing it is the second fix DW-206's ledger offered and the intent did not choose.
- `_resetDataVersionRefreshState` is a test-only export in a production module: correctness of the suite now depends on every file that mounts a watcher calling it in `beforeEach`. Only `data-version-watcher.test.tsx` does today.
- The refresh budget is now shared by every simultaneously mounted watcher in the document rather than held per watcher. That is the intended per-tab semantics, and the shell mounts one watcher — but the previous shape isolated them and nothing pins the new invariant.
- Node 26's localStorage shadowing leaves 13 dom suites red in a plain `pnpm test`. It predates this change and is out of this bundle's scope, but it means CI cannot currently execute three of the five items' DOM assertions.
