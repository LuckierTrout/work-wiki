---
title: 'Workbench scroll restores: suppress the clamp echo, branch on the real scroller, restore before paint'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '1eab69894330c4d6c409d2cf5279b0915946cde8'
deferred:
  - summary: >-
      ModeCanvas picks its scroller once per `hidden` transition, so docking or
      undocking a Preview, or crossing the stacking breakpoint, leaves the
      listener on the element that no longer scrolls.
    evidence: |-
      `canvasScroller` answers a layout question but the effect is keyed on
      `[hidden]` alone, and `globals.css` flips which element scrolls on three
      conditions that never change `hidden`: docking a Preview below 899px
      (`:5341-5370`), crossing the breakpoint, and opening the mode sheet, which
      re-applies the clamp (`:5372-5382`). `previewOpen` flips when the owner
      picks a tree row (`Workbench.tsx` `onDockPreview={selectRow}`) with the
      canvas still showing, so at narrow width the listener stays on `.wb-canvas`
      after the document has become the scroller and records nothing for the rest
      of the visit -- DW-523's failure shape reached by dock rather than by
      width. Across runs the single `canvasScrollRef` can also re-apply an offset
      recorded on one scroller to the other. Closing it needs either a
      preview/breakpoint input threaded into `ModeCanvas` (it takes neither
      today) or a re-probe trigger; the spec's contract forbids listening on both
      surfaces at once, so it is a mechanism decision rather than a patch.
    location: >-
      src/components/workbench/ModeCanvas.tsx (the DW-416/DW-523 effect)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Both workbench scroll restores assign `scrollTop` and then keep a live `scroll` listener, so the restore's own event — which the browser dispatches at the next rendering update whether or not the listener existed yet — records the browser's CLAMP over the offset the owner actually left (DW-521). The mode canvas additionally reads only `.wb-canvas`, although below 900px with a docked Preview `globals.css` releases the shell's clamp and the DOCUMENT scrolls instead, so the ref records and restores 0 at that width (DW-523). And both restores run in `useEffect`, which is after paint, so an un-withdrawn surface visibly paints at the top before it jumps back (DW-524).

**Approach:** Arm each restore with the value the browser actually landed on and have the persist side drop exactly one matching event — the restore's own echo — before it starts recording. In `ModeCanvas`, pick the element that is genuinely scrolling (the document's scrolling element when the document overflows, otherwise `.wb-canvas`) and read, write and listen on that one element. Move both restores to a layout effect through one shared SSR-safe hook, since both components render on the server.

## Boundaries & Constraints

**Always:**
- Keep `TreePanel`'s two effects as two, with their existing guards and dependency arrays verbatim — `workbench-split.test.ts` pins `treeBodyShowing(panel, collapsed)` twice, `panel.scrollTop = readStoredTreeScroll()[tab][band]`, `let pending = -1;`, `pending = panel.scrollTop;`, the cleanup flush order, and exactly two `}, [tab, band, collapsed, narrow, hidden]);` keys. Merging the effects breaks all of them.
- The echo suppression must DISARM itself on the first `scroll` event whatever its value, so a restore that changed nothing (and therefore fires no event) can never swallow a later genuine scroll.
- Type no width and no breakpoint literal in either component — `globals.css` owns 900px and `workbench-split` owns the query.
- `ModeCanvas`'s ref stays a ref: no new localStorage key, nothing keyed per mode.
- The layout-effect switch must not introduce React's "useLayoutEffect does nothing on the server" warning; both components are server-rendered from `src/app/page.tsx`.

**Block If:**
- A pinned source-scan assertion in `workbench-split.test.ts` cannot be satisfied without changing the assertion's intent (as opposed to extending it).

**Never:**
- Do not move the mode canvas's offset into storage, and do not add a scroll-restore key to `workbench-state`.
- Do not touch `globals.css`'s narrow/Preview block — the stylesheet is the source of truth this branch follows, not something to re-decide.
- Do not add a `scroll` listener to `window` in addition to `document`, and do not listen on both the canvas and the document at once — one run of the effect picks one scroller and reads, writes and listens on that one.
- Do not change `TreePanel`'s band keying, tab keying, or the DW-208 flush.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clamped restore (DW-521) | Stored offset 900; the surface can only reach 200 when the restore runs | `scrollTop` lands at 200; the echoed `scroll` is dropped; storage/ref still holds 900 | No error expected |
| Genuine scroll after a clamped restore | Same, then the owner scrolls to 260 | 260 is recorded, replacing 900 | No error expected |
| Restore that changes nothing | Stored offset equals the current `scrollTop`, so no `scroll` fires | The arm is spent by the owner's next real scroll, which is still recorded | No error expected |
| Document is the scroller (DW-523) | `documentElement.scrollHeight > clientHeight` (narrow + docked Preview) | Read/write/listen on `document.scrollingElement`, with the listener on `document` | Falls back to `documentElement` when `scrollingElement` is null |
| Canvas is the scroller | Document does not overflow (desktop, and jsdom) | Read/write/listen on `.wb-canvas`, exactly as today | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/TreePanel.tsx` -- `:213-217` restore effect (`panel.scrollTop = readStoredTreeScroll()[tab][band]`), `:245-261` persist effect (rAF-coalesced, DW-208 cleanup flush). `treeBodyShowing` at `:129`. Imports `useEffect` at `:5`. Both effects share the key `[tab, band, collapsed, narrow, hidden]`.
- `src/components/workbench/ModeCanvas.tsx` -- `:119-131` docblock claiming "`.wb-canvas` is the mode canvas's SCROLL CONTAINER" (unqualified by width — DW-523's wrong claim), `:132-152` the DW-416 effect with `canvasRef`/`canvasScrollRef`; the `<section ref={canvasRef} className="wb-canvas">` at `:155`. Imports `useEffect` at `:3`.
- `src/app/globals.css` -- `:2693` `.wb-canvas { overflow: auto }`; `:3731` narrow block re-points it to `grid-column: 1`; `:5341-5370` the `@media (max-width: 899px)` `[data-preview="true"]` block whose own comment states the canvas row "resolves to its content instead of scrolling inside `.wb-canvas`'s own `overflow: auto`" and sets `overflow: visible` on `.wb-shell`. READ-ONLY evidence for DW-523; do not edit.
- `src/hooks/` -- home for shared hooks (`useSurfaceVisibility.ts` is the local style reference: `"use client"` + a long docblock). New file lands here.
- `src/components/HtmlPreview.tsx:52` -- the repo's own note that a bare `useLayoutEffect` "would warn under SSR"; `src/components/workbench/ResearchCanvas.tsx:377` uses one directly in a subtree that does not server-render. Together these are why the new hook exists rather than a bare import.
- `src/lib/__tests__/workbench-split.test.ts:1609-1700` -- the TreePanel source scans listed under **Always**. Extend, do not rewrite.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` -- `renderShell()` at `:139`, `treeBody()` at `:153`, `setMediaQuery` from `@/test/dom-helpers`, and the Settings-visit re-key idiom at `:674-731` (click `SETTINGS_LABEL` twice). Where DW-521's mounted case belongs.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- `renderShell()` `:181`, `closeSettings()` `:316`, `modeCanvas()` `:467`, and the DW-416 case at `:803-854`. Where DW-523's mounted case belongs.
- `src/lib/__tests__/workbench-chrome.test.ts:301` -- the `describe("ModeCanvas")` source-scan block; the natural home for DW-524's ModeCanvas scan.

## Tasks & Acceptance

**Execution:**
- `src/hooks/useIsomorphicLayoutEffect.ts` -- new: export `useIsomorphicLayoutEffect`, resolving to `useLayoutEffect` in the browser and `useEffect` on the server (`typeof window !== "undefined"` at module scope). Docblock states why: both scroll restores must put pixels back before paint, and both components server-render, so a bare `useLayoutEffect` would warn. -- one definition instead of two copies.
- `src/components/workbench/TreePanel.tsx` -- switch the restore effect to `useIsomorphicLayoutEffect` (DW-524); after the (unchanged) `panel.scrollTop = …` line record `panel.scrollTop` into a new `restoreEchoRef` (`useRef<number | null>(null)`); in the persist effect's `onScroll`, after `pending = panel.scrollTop;`, consume the arm — clear the ref unconditionally and, when the arm was non-null and equals `pending`, reset `pending = -1` and return without queueing a frame (DW-521). Leave the guards, the dep arrays, the rAF coalescing and the cleanup flush untouched.
- `src/components/workbench/ModeCanvas.tsx` -- switch the DW-416 effect to `useIsomorphicLayoutEffect` (DW-524); add a local `canvasScroller(canvas)` helper returning `document.scrollingElement ?? documentElement` when that root's `scrollHeight > clientHeight`, else the canvas (DW-523); read, write and listen through the chosen scroller, attaching the listener to the document when the scroller is not the canvas (viewport `scroll` events fire at `Document` and do not bubble from `documentElement`); suppress the restore's own echo with the same arm-and-disarm rule (DW-521). Rewrite the `:119-131` docblock so it no longer claims `.wb-canvas` is unconditionally the scroll container.
- `src/lib/__tests__/workbench-split.test.ts` -- extend the `TreePanel remembers where each tree was left` describe with scans for the echo arm and for `useIsomorphicLayoutEffect` on the restore; keep every existing assertion.
- `src/lib/__tests__/workbench-chrome.test.ts` -- add a `ModeCanvas` scan: the restore uses `useIsomorphicLayoutEffect`, branches through `canvasScroller`, spells no `900`, and no longer claims `.wb-canvas` is the scroll container unconditionally.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` -- add a mounted DW-521 case: store 900, render, install a clamping `scrollTop` accessor on the tree body (`Object.defineProperty`, max 200) standing in for a shorter box the way the file's existing `scrollTop = 0` stand-ins do, re-key with a Settings visit, dispatch `scroll`, assert `panel.scrollTop === 200` and stored `wide` still 900; then a genuine scroll to 150 IS recorded.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- add a mounted DW-523 case: declare an overflowing document (`Object.defineProperty` on `documentElement.scrollHeight`/`clientHeight`, restored afterwards), scroll the document to 300 and dispatch `scroll` on `document`, open and close Settings, assert the document scrolling element is back at 300 and the canvas's own `scrollTop` was never written.

**Acceptance Criteria:**
- Given a tree body whose box cannot reach the stored offset, when the restore runs and the browser clamps it, then the persisted offset is unchanged and the clamp is not written back.
- Given the mode canvas after a Settings visit, when the restore assigns an offset the surface cannot reach, then `canvasScrollRef` still holds the owner's offset rather than the clamp.
- Given the surface has been restored and the echo consumed, when the owner scrolls for real, then that offset is recorded exactly as before this change.
- Given a restore that assigns the offset the surface already held (no `scroll` event fires), when the owner next scrolls, then that scroll is recorded — the arm never swallows it.
- Given `pnpm test`, when the full suite runs, then it passes with the existing `workbench-split.test.ts` TreePanel scans still green.

## Design Notes

The arm is a VALUE, not a boolean, and it disarms on the first event whatever that event says:

```ts
const echo = restoreEchoRef.current;
restoreEchoRef.current = null;
if (echo !== null && pending === echo) {
  pending = -1;
  return;
}
```

A boolean would be a latch with no way to spend it: a restore that assigns the offset the element already holds fires no `scroll` at all, so a boolean arm would still be set when the owner's next genuine scroll arrived and would swallow it — the tree would then stop remembering its offset with every other assertion green. Comparing against the value the browser actually landed on makes a stale arm harmless: a genuine scroll reports a different number and is recorded.

`ModeCanvas` asks the DOCUMENT whether it overflows rather than asking the canvas, and defaults to the canvas. That polarity matters: the canvas reports `scrollHeight === clientHeight === 0` in jsdom and under any not-yet-laid-out first run, so `canvas.scrollHeight > canvas.clientHeight` would hand the document every restore it should not have. The document overflows only where `globals.css` releases `.wb-shell`'s clamp, which is exactly the DW-523 case.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/workbench-split-wiring.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- expected: pass, including the two new mounted cases.
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-split.test.ts src/lib/__tests__/workbench-chrome.test.ts` -- expected: pass, with the new scans.
- `pnpm test` -- expected: the whole suite passes.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** The two workbench scroll restores no longer record the browser's own clamp, the mode canvas restores on the element that is actually scrolling, and both restores run before paint.

- Each restore arms a `restoreEchoRef` with the value the browser LANDED on after the assignment. The persist side clears that arm on the first `scroll` event whatever the event says, and drops the event only when it matches — so a clamped restore no longer overwrites the owner's offset, and a restore that moved nothing (and so fires no event) cannot swallow the owner's next real scroll (DW-521).
- `canvasScroller()` asks the DOCUMENT whether it overflows and defaults to `.wb-canvas`. Below the stacking breakpoint with a Preview docked, `globals.css` releases `.wb-shell`'s clamp and the page is what moves; the effect then reads, writes and listens through the scrolling element, with the listener on `document` because a viewport scroll is dispatched at `Document` and does not bubble from `documentElement`. No width or media query is spelled in TypeScript (DW-523).
- Both restores are `useLayoutEffect`, so the pixels are back before the paint instead of one frame after it. The persist effect stays passive — it attaches a listener and has nothing to put on screen (DW-524).

**Files changed.**
- `src/components/workbench/ModeCanvas.tsx` — scroller branch, echo suppression, layout effect; the docblock no longer claims `.wb-canvas` is unconditionally the scroll container; the offset ref starts `null` so a first mount writes nothing.
- `src/components/workbench/TreePanel.tsx` — echo suppression across its restore/persist pair and a layout-effect restore; guards, dependency arrays, band keying and the DW-208 flush untouched.
- `src/components/workbench/Workbench.tsx` — the canvas focus restore uses `preventScroll`, so a passive `focus()` cannot undo the layout-effect restore.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` — mounted DW-523 (document is the scroller, both directions, nothing written on mount) and mounted DW-521 (clamped restore keeps the pre-clamp offset) cases.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — mounted DW-521 case for the tree, plus the restore-that-changed-nothing case a boolean latch would fail.
- `src/lib/__tests__/workbench-split.test.ts`, `src/lib/__tests__/workbench-chrome.test.ts` — source scans for the echo arm's shape and ordering, the scroller branch, the layout effect and the `preventScroll` guard; every prior assertion kept.

**Review findings.** 6 patches applied (3 medium, 3 low), 1 deferred (low), 6 rejected. Rejected as out of the bundle's scope or as residue: `SourcesTree` and `HtmlPreview` carry the same shapes at sibling call sites; `stripComments` is duplicated per suite by this repo's existing convention; `TreePanel`'s `pending = -1` on the echo path is unreachable by construction; the CSS makes a both-overflow layout impossible; and the deferred-work ledger is orchestrator-owned.

**Follow-up review recommendation:** true. Patched findings: 0 high, 3 medium, 3 low; score `3x3 + 1x3 = 12`, which is at or above 5.

**Verification.**
- `pnpm exec vitest run --project dom` on the two mounted suites — 67 passed.
- `pnpm exec vitest run --project node` on the two scan suites — 174 passed.
- `pnpm test` — 8938 passed, 1 skipped. One intermittent failure appeared in two of five full runs: `storage-fs.test.ts` "stops at STRANDED_SCRATCH_CANDIDATE_CAP" timing out at 5000ms under full-suite load. It is a pre-existing load-dependent flake — the file and its subject are untouched by this diff, and it passes in isolation (95 passed) and passed in the other full runs.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices). `tsc --noEmit` — clean.
- The new mounted cases were mutation-checked: removing the echo suppression, reverting the ref to `useRef(0)` with an unconditional write, or shaping the arm as a boolean latch each fails them.

**Residual risks.**
- The scroller pick is made once per `hidden` transition and can go stale within a visit — recorded as deferred work above.
- DW-524 is verified by source scan only. jsdom computes no layout and paints nothing, so no suite in this repo can observe paint ordering; the ledger entry says the same.
- The DW-523 mounted case declares document overflow rather than rendering the narrow, Preview-docked layout that produces it. jsdom applies no stylesheet, so the link between the CSS condition and the overflow the implementation probes is argued in comments and would only be executable under Playwright.
