---
title: 'DW-594/595/596: give the graph canvas a keyboard node cursor and pin both activation paths'
type: 'feature'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Clicking a graph node leaves the keyboard cursor where it was, so a reader
      who clicks and then presses an arrow resumes from the first node rather
      than from the node they just acted on.
    evidence: |-
      A `tabIndex={0}` canvas takes focus on mousedown in every browser, so a
      click both focuses the canvas — seeding the cursor at index 0 via
      `handleFocus` — and navigates through `openNode`. `handleClick` never
      writes `cursorIndexRef`, so the pointer and the keyboard disagree about
      where "here" is from the first click onward, and the live region announces
      the first node rather than the clicked one. The fix was implemented during
      review and then REVERTED: this spec's `Never` list forbids "mouse-driven
      cursor movement" and the bundle's recorded 2026-08-29 decision says "keep
      the pointer path unchanged", both of which a click that moves the cursor
      contradicts. Resolving it needs a human to widen that boundary, not an
      unattended reading of it.
    location: >-
      src/hooks/useGraphSimulation.ts (handleClick)
    severity: medium
baseline_revision: 'd9675d177b6311c95cd0bea2d8b0af6357cdc878'
---

<intent-contract>

## Intent

**Problem:** Graph nodes are pointer-only: `handleClick` hit-tests `e.clientX/clientY` and `hoveredRef` is written only by `handleMouseMove`, so a keyboard reader cannot open a page from the lens-scoped graph (DW-595). Meanwhile the canvas's fallback `<a>` child is itself focusable, so that reader still lands on a focus stop rendering nothing on screen (DW-594), and nothing observes that the click path is wired at all — dropping `onClick` would leave the canvas inert with every a11y test green (DW-596).

**Approach:** Build the keyboard node cursor the 2026-08-29 decision describes: the hook owns an index into the node set, arrow keys move it, Enter/Space activates, and both the pointer and the keyboard path route through one activation function. Draw the cursor on the canvas and announce the focused node through a polite live region beside it. Take the phantom fallback anchor out of the tab order, and pin both activation paths against the REAL hook so "click opens a page" and "Enter opens the same page" are observed facts.

## Boundaries & Constraints

**Always:**
- One activation function is the only place that navigates; `handleClick` and the Enter/Space branch both call it, so the two paths cannot diverge on target URL.
- The pointer path's observable behaviour is unchanged: hover, cursor style, tooltip, and click-to-open all still work exactly as today. **SUPERSEDED IN PART by DW-751 (human decision, 2026-09-04):** a click now ALSO seats the keyboard cursor on the node it hit and announces it. Hover, cursor style, tooltip and the click's navigation are still unchanged; only the cursor/announcement effect was added. See the Spec Change Log below.
- The canvas keeps `role="img"` and an `aria-label` that still names the Knowledge tree; the visible `<Link>` outside the canvas stays outside it and stays in the keyboard order (DW-131/DW-461 contracts, pinned in `retired-surfaces.test.ts` and the escape-hatch describe).
- The canvas fallback child stays a real `<a href={KNOWLEDGE_TREE_HREF}>` with `href` as its first attribute — `retired-surfaces.test.ts` matches on that shape.
- Arrow/Enter/Space presses the canvas handles call `preventDefault()`; unhandled keys are left alone.
- Cursor state resets when the scope lens changes, so a cursor cannot point at a node from a previous fetch.

**Block If:**
- An existing test asserts the canvas is NOT focusable in a way that survives this change's intent (i.e. a pin outside `graph-escape-hatch-mounted.test.tsx`'s DW-463 describe). Halt rather than weaken it.

**Never:**
- Do not change `role="img"` to `application`/`listbox`/etc., and do not remove the fallback child or the visible link.
- Do not edit `src/lib/__tests__/retired-surfaces.test.ts` — its source pins must stay green untouched.
- Do not add a per-node DOM shadow tree, hit regions, `drawFocusIfNeeded`, panning/zooming, or ~~mouse-driven cursor movement~~ — **that last clause is SUPERSEDED by DW-751 (human decision, 2026-09-04)** and forbids nothing: a click on a node now seats the keyboard cursor on that node. Every other item in this bullet stands. See the Spec Change Log below.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Keyboard reader focuses the canvas | Graph rendered with N>0 nodes, canvas receives focus | Canvas is a tab stop (`tabIndex >= 0`); the cursor lands on the first node; the live region announces that node's label, connection count, position (i of N) and that Enter opens it; a ring is drawn around it | No data yet → no cursor, no announcement, no throw |
| Arrow key moves the cursor | Canvas focused, cursor on node i | Right/Down → i+1, Left/Up → i-1, both wrapping at the ends; announcement and drawn ring follow; the event is `defaultPrevented` so the page does not scroll | No nodes → no-op, no throw |
| Enter or Space activates | Canvas focused, cursor on node n | Router pushes `/u/{n.tenant}/{n.id}` — the same URL a click on that node produces, through the same function; event is `defaultPrevented` | No cursor → no navigation |
| Pointer reader clicks a node | Click whose coordinates hit node n | Router pushes `/u/{n.tenant}/{n.id}` (unchanged behaviour, now via the shared activation function). **SUPERSEDED IN PART by DW-751 (human decision, 2026-09-04):** the click ALSO seats the keyboard cursor on node n and announces it in the live region, before it navigates — same index, same `describeCursor` wording, same redraw as an arrow press | Click hits no node → no navigation, and (per DW-751) no cursor change either |
| Canvas loses focus | Canvas focused with a cursor, then blurred | The cursor ring is no longer drawn and the live region is emptied; refocusing announces again | No error expected |
| Keyboard reader tabs past the canvas | Graph rendered | The canvas's fallback `<a>` is out of the tab order (`tabIndex < 0`), so there is no focus stop that renders nothing on screen | No error expected |

</intent-contract>

## Code Map

- `src/hooks/useGraphSimulation.ts` -- the whole keyboard model lands here. `UseGraphSimulationReturn` (19-27) gains `handleKeyDown`, `handleFocus`, `handleBlur`, `cursorAnnouncement`. `handleClick` (272-291) keeps its hit-test but delegates navigation to a new `openNode(n)` (the single activation function). Refs at 35-41 are the pattern to copy for `cursorRef`/`focusedRef`; `handleMouseMove` (226-258) shows the required "cancel the frame and request a new one" redraw when the simulation has settled — cursor moves need the same. The fetch `.then` (114-151) is where new data lands and where cursor state must reset.
- `src/lib/graph-render.ts` -- `RenderOptions` (206-216) gains an optional `cursor?: GraphNode | null`; `renderGraph` (223+) draws the ring after the node loop. Use only `beginPath/arc/stroke/strokeStyle/lineWidth` — the existing test's `mockCtx` implements no other drawing calls, and `setLineDash` would throw there.
- `src/app/wiki/graph/page.tsx` -- the `<canvas>` (191-204): add `tabIndex={0}`, `onKeyDown`, `onFocus`, `onBlur`; extend the `aria-label` to state the keyboard affordance while STILL containing "Knowledge tree". The fallback `<a>` (202) gets `tabIndex={-1}` after its `href`. Add the live region after the canvas wrapper div (`className="sr-only"`, `role="status"`, `aria-live="polite"` — `ToastContainer.tsx:30-35` is the house shape). The block comment at 151-182 records the DW-463 removal and must be rewritten to record this build instead.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` -- stubs the hook, so its stub object (115-126) must gain the new return fields or `satisfies UseGraphSimulationReturn` fails `tsc`. Its DW-463 describe (274-356) is the pin whose own failure message says it is the thing to update when a real keyboard path arrives; `theCanvas()` (200-210) is the shared helper. The escape-hatch describe (212-272) and the header's DW-461 section are read-only.
- `src/lib/__tests__/retired-surfaces.test.ts:183-460` -- read-only source pins: exactly one `<canvas>`, fallback is `<a href={KNOWLEDGE_TREE_HREF}`, `aria-label` matches `/Knowledge tree/`, no path-shaped `href` string literals on the page.
- `vitest.config.ts:70-103` -- `*.test.ts` → node project, `*.test.tsx` → jsdom `dom` project. Mounted pins must be `.test.tsx` under a `__tests__/` directory.
- Environment facts verified in this repo's jsdom: `canvas.getContext("2d")` returns `null`, so the hook's `simulate()` returns before `stepPhysics` and node positions stay exactly as initialised; `getBoundingClientRect()` is all-zeros; an element with `tabindex="-1"` reports `tabIndex === -1` but still takes `.focus()` — so the fallback-anchor pin must read the TAB ORDER (`tabIndex < 0`), never `.focus()`.

## Tasks & Acceptance

**Execution:**
- `src/lib/graph-render.ts` -- add `cursor?: GraphNode | null` to `RenderOptions` and draw a visible ring around it (a contrasting circle outside the node's own radius) at the end of the node pass -- the decision requires a visible cursor indication on the canvas.
- `src/hooks/useGraphSimulation.ts` -- extract `openNode(node)` and route `handleClick` through it; add cursor/focus refs, `handleKeyDown` (arrows wrap, Enter/Space activate, `preventDefault` on handled keys), `handleFocus`/`handleBlur`, a `cursorAnnouncement` string, cursor reset on new data, a redraw on every cursor/focus change, and the ring pass-through to `renderGraph` (only while focused) -- this is the keyboard-owned node cursor, with both paths funnelled through one activation function.
- `src/app/wiki/graph/page.tsx` -- wire `tabIndex={0}`/`onKeyDown`/`onFocus`/`onBlur` on the canvas, extend its `aria-label`, add the visually-hidden live region rendering `cursorAnnouncement`, put `tabIndex={-1}` on the fallback `<a>`, and rewrite the canvas block comment to record the keyboard path and why the fallback child is out of the tab order -- makes the model reachable and fixes DW-594.
- `src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx` (new) -- mount the real `GraphPage` with the REAL `useGraphSimulation` (mock only `@clerk/nextjs`, `next/navigation`, and `fetch`; `vi.spyOn(Math, "random").mockReturnValue(0)` so every node initialises at (100,100) and a click at client (100,100) deterministically hits `nodes[0]`), and cover every I/O matrix row: click navigation, focus→announce, arrow movement + wrap + `defaultPrevented`, Enter and Space navigation equal to the click's URL, blur clearing, and the no-node no-throw case -- DW-596's missing pin and DW-595's "same page a click does" pin, both against real code rather than a stub.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` -- extend the hook stub with the new return fields; replace the DW-463 describe with one asserting the canvas IS a tab stop and the fallback `<a>` is NOT (`tabIndex < 0`), keeping the `role="img"`/`aria-label` reads; update the header docblock's second section and its now-stale SCOPE paragraph -- the file's own failure message names this as the pin to update.
- `src/lib/__tests__/graph-render.test.ts` -- add a `renderGraph` case (inside the existing describe, reusing `baseOpts`/`mockCtx` with a dedicated `arc` spy) asserting a ring is stroked at the cursor's coordinates with a radius larger than the node's own, and that no ring is drawn when `cursor` is null -- otherwise the visible cursor indication is unobserved.

**Acceptance Criteria:**
- Given the graph page mounted with the real hook and graph data, when a click activates a node and then Enter activates the cursor on that same node, then both produce the identical `router.push` argument, and removing `onClick` or `onKeyDown` from the canvas fails a test.
- Given the repository after this change, when `npx tsc --noEmit`, `npx eslint src/app/wiki/graph src/hooks src/lib` and the full `npx vitest run` are executed, then types and lint are clean and no test fails that did not already fail on `d9675d17`, with `src/lib/__tests__/retired-surfaces.test.ts` unmodified and green.
- Given a reviewer reading `page.tsx`, when they reach the canvas block comment, then it records the keyboard activation path, the `role="img"` + live-region choice, and why the fallback anchor is deliberately out of the tab order.

## Spec Change Log

### 2026-09-05 — DW-751 widens the pointer-path boundary (human decision, 2026-09-04)

**What changed.** Three places in this spec were amended so they no longer forbid — or misdescribe — a click seating the keyboard cursor:

- `Never` — "Do not add a per-node DOM shadow tree, hit regions, `drawFocusIfNeeded`, panning/zooming, **or mouse-driven cursor movement**". The final clause is withdrawn. The rest stands.
- `Always` — "The pointer path's observable behaviour is unchanged: hover, cursor style, tooltip, and click-to-open all still work exactly as today". Still true of hover, cursor style, tooltip, and the click's navigation; no longer true of the keyboard cursor and the live region, which a click now writes.
- The **I/O & Edge-Case Matrix** row "Pointer reader clicks a node", whose expected behaviour was navigation only. It now also names the cursor seat and the announcement, and its error column records that a click missing every node changes no cursor.

The bundle's recorded 2026-08-29 decision, "keep the pointer path unchanged", is superseded to the same extent.

**Why.** This spec's `deferred:` entry (kept above, as the record of what was deferred) describes the defect: a `tabIndex={0}` canvas takes focus on mousedown, so a click seats a cursor whether or not `handleClick` writes one — `handleFocus` puts it at index 0, whatever node was clicked. The boundary as written therefore did not buy an inert pointer path; it bought a cursor pointing at the wrong node, a live region naming the first node while the reader had just acted on the fifth, and an arrow key that resumed from node 1. The original fix was written during this bundle's review and then REVERTED for contradicting the two clauses above, which is why resolving it required a human to widen them rather than an unattended reading. That decision was taken on 2026-09-04 and implemented as DW-751; see `spec-dw-751-graph-click-moves-cursor.md`.

**What is still forbidden.** Everything else in the `Never` list, and every other `Always`: one activation function is still the only navigation site, hover/tooltip/cursor-style are untouched, `role="img"` and the fallback `<a>` are untouched, and `retired-surfaces.test.ts` stays unmodified. The seat happens only on a hit-test hit, and only through the one function the keyboard path also uses — a second copy of the announcement wording in the pointer path would be the same divergence defect restated.

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 4, low 9)
- defer: 1: (high 0, medium 1, low 0)
- reject: 7: (high 0, medium 1, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `handleKeyDown` swallowed modified presses: Alt+Arrow (browser Back) and Cmd/Ctrl+Enter (open in new tab) moved the cursor or navigated and were `preventDefault`ed. Now bails out before the switch when Ctrl/Meta/Alt is held, with plain Shift still handled; pinned by Alt+ArrowRight and Cmd+Enter cases.
  - `[medium]` `[patch]` `redraw()` — the only repaint once the rAF chain settles — was unobserved: replacing its body with `return` left every suite green, because the fixture's overlapping nodes keep `totalVelocity` above the threshold so frames arrive anyway. Now pinned as SCHEDULING in the default (quiescent) setup: an arrow and a blur each request a frame, an unhandled key requests none.
  - `[medium]` `[patch]` The lens-change cursor reset was unobserved — deleting all of its clears kept the suite green. Added a `renderHook` case that arrows to a later node, re-renders with a new scope whose fetch returns different nodes, and asserts the announcement is empty and the index reset (the refocus announces "1 of 2" of the NEW set).
  - `[medium]` `[patch]` The click hit test was not pinned to the RIGHT node: with every fixture node at (100, 100) a `handleClick` that always returned `nodes[0]` would pass. Added a distinct-positions case (a sequenced `Math.random` spy) clicking the second node's coordinates.
  - `[low]` `[patch]` Holding Enter/Space auto-repeated `router.push`; the activation branch now returns on `e.repeat` while arrows still repeat.
  - `[low]` `[patch]` `focusedRef` was cleared only on the fetch's success path while the cursor index and announcement were cleared for all three outcomes; the clear moved up beside them and both comments were corrected.
  - `[low]` `[patch]` The "N connection(s)" wording existed twice with the ternary inverted — `describeCursor` and `renderGraph`'s tooltip — in a change whose argument is that one function keeps the two paths from diverging. Extracted `connectionsLabel()` in `graph-render.ts` and used it in both.
  - `[low]` `[patch]` The ring's "drawn AFTER the node pass" claim was unasserted (moving the block above the node loop stayed green); the ring arc's call index is now asserted to exceed every node arc's.
  - `[low]` `[patch]` The singular branch of the connection count was never read; asserted on the `linkCount: 1` node with a trailing comma so "1 connections" fails.
  - `[low]` `[patch]` The live-region query demanded `[role="status"][aria-live="polite"]`, so removing the redundant explicit attribute failed with a message naming a defect that did not exist. Relaxed to either.
  - `[low]` `[patch]` `graph-escape-hatch-mounted.test.tsx`'s header still enumerated two claims while the file pins three; the map now lists the live region too.
  - `[low]` `[patch]` The `aria-label`'s new keyboard sentence was load-bearing in prose but unpinned — trimming it stayed green. Now read for the arrow keys and Enter alongside the existing Knowledge tree match.
  - `[low]` `[patch]` A docblock describing `NODES` had been separated from it by the inserted `vi.mock`, and the live-region comment cited `ToastContainer` as "the house shape" for a pairing that component does not use (two elements, unmounted when empty, visible). Both corrected.

Deferred (see frontmatter `deferred`): the click/keyboard cursor disagreement — implemented during this pass and reverted, because the `Never` clause inside the read-only intent contract forbids mouse-driven cursor movement and the bundle's decision says to keep the pointer path unchanged.

Rejected (dropped): a "the diff does not match the working tree" finding reporting an `if (true) return;` in `redraw` (a concurrent reviewer's own in-flight mutation; verified absent from the tree before and after); the single-node graph announcing nothing on an arrow press (the cursor genuinely does not move); focus/blur bubbling from the fallback `<a>` (unreachable — a canvas-capable client never renders fallback content, and the anchor is now `tabIndex={-1}`); `tabIndex={-1}` costing a canvas-less client its in-canvas link (the deliberate, documented trade-off DW-594 asks for, with the visible link outside the canvas still reachable); DW-596's pin living in a new real-hook file rather than at the ledger's suggested address (the ledger proposed one sufficient shape, and the mutation check confirms the risk is closed); the "i of N" announcement exposing an ordering the wrap comment calls meaningless (progress through the set is what a reader has no other source for); and a cursor whose node lies outside the drawn area having no visible ring (a pre-existing property of a layout with no viewport clamping — the pointer path cannot reach those nodes either).

## Design Notes

Why `role="img"` survives: the canvas is still a picture with a text alternative, and DW-131/DW-461 pin that semantics. An operable `role="img"` is unusual, so the announcement is carried by a sibling live region rather than by the canvas's own name, and the label tells a screen-reader user the keys exist. `role="application"` was rejected — it suppresses browse mode for a surface whose text alternative is one link away.

Why the fallback anchor loses the tab order rather than the page losing the anchor: `retired-surfaces.test.ts` pins the fallback as a real link, and only clients that cannot render a canvas at all ever display it — while every browser that does render it still puts focusable fallback content in the sequential focus order. `tabIndex={-1}` removes the invisible stop for that (universal) case; the visible `<Link>` above the canvas remains the reachable escape hatch either way.

Shape of the shared activation function:

```ts
const openNode = useCallback(
  (n: GraphNode) => router.push(`/u/${n.tenant}/${n.id}`),
  [router],
);
// handleClick: hit-test clientX/clientY -> openNode(hit)
// handleKeyDown: Enter/" " -> cursorRef.current && openNode(cursorRef.current)
```

## Verification

**Commands:**
- `npx vitest run src/app/wiki/graph src/hooks src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/graph-render.test.ts` -- expected: green, including both new pins.
- `npx tsc --noEmit` -- expected: no type errors.
- `npx eslint src/app/wiki/graph src/hooks/useGraphSimulation.ts src/lib/graph-render.ts` -- expected: clean.
- `npx vitest run` -- expected: no failure that is not also present on `d9675d17`.
- Mutation check: temporarily drop `onKeyDown` (then `onClick`) from the canvas and confirm the new mounted suite fails each time; restore.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The graph canvas now has a keyboard node cursor, and both ways of opening a page go through one function. `useGraphSimulation` owns an index into the node set: the arrow keys move it (wrapping at both ends), Enter and Space activate it, focus seats it and announces where it is, blur withdraws both of its observable effects, and a scope-lens change drops it before the new fetch. `handleClick` keeps its pointer hit test but now delegates navigation to the same `openNode`, so "Enter opens the page a click opens" is a property of the code rather than of two copies staying in step (DW-595). The cursor is drawn as a ring outside the node's own radius and announced through a polite `role="status"` region beside the canvas, since a `role="img"` element carries a static name. The canvas's fallback `<a>` is out of the sequential tab order, so a keyboard reader no longer lands on a focus stop that renders nothing on screen while the link itself stays for a client that cannot render a canvas at all (DW-594). Both activation paths are now observed against the real hook rather than a stub (DW-596).

**Files changed.**
- `../../src/hooks/useGraphSimulation.ts` -- the keyboard model: `openNode` as the single navigation site, cursor index and focus refs, `handleKeyDown`/`handleFocus`/`handleBlur`, `cursorAnnouncement`, a `redraw()` for a settled graph, and the cursor reset on a lens change.
- `../../src/lib/graph-render.ts` -- optional `cursor` in `RenderOptions`, the ring stroked after the node pass, and `connectionsLabel()` shared with the hook's announcement.
- `../../src/app/wiki/graph/page.tsx` -- canvas `tabIndex={0}` with the three new handlers, an `aria-label` naming the keys, the visually hidden live region, `tabIndex={-1}` on the fallback anchor, and a rewritten block comment recording every one of those decisions.
- `../../src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx` (new) -- the whole I/O matrix against the REAL hook: click navigation and its hit test, focus/arrow/wrap/blur announcements, `defaultPrevented`, modifier and auto-repeat handling, Enter and Space equal to the click's URL, the lens-change reset, the repaint scheduling, and the cursor-follows-focus render argument.
- `../../src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` -- stub extended to the hook's new return shape; the DW-463 describe replaced by one asserting the canvas IS a tab stop, the fallback `<a>` is not, the picture semantics hold and a polite live region exists outside the canvas.
- `../../src/lib/__tests__/graph-render.test.ts` -- the ring's radius, its exclusivity to the cursor node, its absence when no cursor is passed or the field is omitted, its draw order, and `connectionsLabel`'s singular/plural.

**Review findings breakdown.** 13 patches applied (4 medium, 9 low) -- see the Review Triage Log. 1 item deferred (1 medium) -- see frontmatter `deferred`. 7 rejected. 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation.** `false`. Patched findings this pass: high 0, medium 4, low 9. The recommendation counts high-severity patches only, and there were none.

**Verification performed.**
- `npx vitest run src/app/wiki/graph src/hooks src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/graph-render.test.ts` -- 196 passed across 10 files.
- `npx vitest run` (full suite) -- 376 files, 9418 passed, 1 skipped, 0 failed. The baseline's `window.localStorage` failures recorded in the DW-463 spec are gone; the suite is green on `d9675d17` too.
- `npx tsc --noEmit` -- clean. `npx eslint src/app/wiki/graph src/hooks/useGraphSimulation.ts src/lib/graph-render.ts src/lib/__tests__/graph-render.test.ts` -- clean.
- `src/lib/__tests__/retired-surfaces.test.ts` unmodified (`git diff` empty) and green at 74 tests, as its Never clause requires.
- Mutation checks, each restored afterwards: removing `onClick` from the canvas fails 2 cases; removing `onKeyDown` fails 8; ungating the cursor from `focusedRef` fails the blur read; stubbing out `redraw` fails the two scheduling cases; deleting the lens-change clears fails the scope case; forcing `handleClick` to pick `nodes[0]` fails 3; moving the ring above the node loop fails the ordering case; trimming the keyboard sentence from the `aria-label` fails its pin.
- Matrix audit: all six rows ran and passed -- focus/announce/tab-stop and the ring (`announces the first node...`, `takes focus...`, `spells that focus stop...`, `strokes a ring OUTSIDE...`, `passes the cursor node while focused...`); arrows with wrap and `defaultPrevented`; Enter and Space equal to the click, and Enter with no cursor; click navigation and a click that hits nothing; blur clearing both the announcement and the ring; and the fallback anchor out of the tab order. Each row's no-data/no-node error column is covered by the `no nodes` describe.

**Residual risks.**
- A click focuses the canvas in a real browser, so the keyboard cursor is seated at the first node rather than the clicked one and the two paths disagree about where "here" is. Real, fixed during review, then reverted: the `Never` clause and the bundle's own decision both forbid moving the cursor from the pointer. Deferred for a human to widen that boundary.
- Nothing runs the real `renderGraph` against a real 2D context, because jsdom has none. The ring is pinned in two halves -- its drawing contract against a mock context, and the hook handing a cursor to `renderGraph` only while focused -- so "focus produces a visible mark" is not closed end-to-end anywhere.
- The cursor walks the API's node order, which carries no spatial meaning, and a node whose position lies outside the drawn area gets a ring the reader cannot see. Both are properties this graph already had for the pointer; neither is made worse here.
- `tabIndex={-1}` costs a canvas-less client the ability to Tab to the in-canvas link. Deliberate: that client still reaches the visible Knowledge tree link above the canvas, which is the escape hatch DW-131 exists for.
