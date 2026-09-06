---
title: 'DW-751: a click on a graph node moves the keyboard cursor to that node'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
baseline_revision: '0d209b1f237c754501e16f0106818acba1979add'
---

<intent-contract>

## Intent

**Problem:** A `tabIndex={0}` canvas takes focus on mousedown, so clicking a graph node both seats the keyboard cursor at index 0 (via `handleFocus`) and navigates (via `openNode`). `handleClick` never writes `cursorIndexRef`, so from the first click onward the pointer and the keyboard disagree about where "here" is: the live region announces the first node rather than the clicked one, and the next arrow key resumes from node 1 instead of from the node the reader just acted on.

**Approach:** Have `handleClick` seat the cursor on the node its hit test found — writing `cursorIndexRef` and announcing exactly the way `moveCursor` does — before it calls `openNode`. This deliberately widens the DW-594/595/596 spec's `Never: no mouse-driven cursor movement` clause and supersedes the 2026-08-29 decision's "keep the pointer path unchanged", on the human decision recorded for DW-751 on 2026-09-04; both supersessions are recorded in that spec.

## Boundaries & Constraints

**Always:**
- The cursor is seated only when the hit test finds a node, and the write happens BEFORE `openNode`, so a click that hits empty canvas leaves the cursor exactly where it was.
- Seating from a click produces the same three effects, in the same words, as an arrow press: `cursorIndexRef` set, `cursorAnnouncement` set from `describeCursor`, and one redraw requested. The click path must not grow its own copy of that wording — pointer and keyboard announcing one node two ways is the defect DW-751 is about, restated.
- The click's navigation is unchanged: the same `openNode`, the same hit test, the same URL, still the only navigation site in the hook.
- `UseGraphSimulationReturn`'s shape is unchanged, so `graph-escape-hatch-mounted.test.tsx`'s hook stub keeps satisfying it.

**Block If:**
- An existing test asserts that a click leaves the keyboard cursor or the announcement untouched. That would be a second recorded boundary this bundle's decision did not name — halt rather than rewrite it.

**Never:**
- Do not gate the seating on `focusedRef`. A real browser focuses the canvas on mousedown, so the gate would be dead code that also makes the behaviour untestable in jsdom, where `fireEvent.click` moves no focus.
- Do not touch hover, cursor style, tooltip, `handleMouseMove`, or `handleMouseLeave` — nothing about hovering seats the cursor.
- Do not change `role="img"`, the `aria-label`, the fallback `<a>`, or the live region's markup.
- Do not edit `src/lib/__tests__/retired-surfaces.test.ts`.
- Do not edit the deferred-work ledger (`_bmad-output/implementation-artifacts/deferred-work.md`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Click seats the cursor | Canvas focused, click whose coordinates hit node i | `router.push` for node i as today, AND the live region now names node i with "i+1 of N" | No data / no canvas → the existing early return, no throw |
| Arrow after a click | Focused canvas, click hits node i, then ArrowRight | The cursor moves to i+1 (wrapping), not to 1 — the reader resumes from the node they acted on | No nodes → no-op |
| Click that hits nothing | Cursor on node i, click on empty canvas | No navigation and no cursor change: the announcement still names node i | No error expected |
| Refocus after a click | Click node i, blur, refocus | The announcement names node i, not node 1 | No error expected |
| Click after a lens change | Cursor reset by the fetch effect, then a click hits node i | The announcement names node i | No error expected |

</intent-contract>

## Code Map

- `src/hooks/useGraphSimulation.ts` -- the whole change. `describeCursor` (55-61) is the wording. `cursorIndexRef` (83) is the state to write. `moveCursor` (407-421) is the three-line seat-and-announce shape to share: `cursorIndexRef.current = next; setCursorAnnouncement(describeCursor(...)); redraw();` — extract it as a `seatCursor(index, nodes)` `useCallback` (deps `[redraw]`) and call it from `moveCursor`, from `handleFocus` (424-436, which already clamps its index first), and from `handleClick`. `handleClick` (378-397) iterates `for (const n of data.nodes)` and so has no index — switch to an indexed loop and call `seatCursor(i, data.nodes)` immediately before `openNode(n)`. Its `useCallback` deps (396) gain `seatCursor`. Do NOT move the seat after `openNode`: `router.push` is mocked in tests but real in the browser, and the ordering is what the AC reads.
- `src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx` -- the pins. `mountGraph()` (143), `announcement()` (150), `focusCanvas`/`blurCanvas` (166-176), `pressKey` (185-196), `positionNodes` (208-215) and `SPREAD` (222-226) are the existing helpers; `NODES` (99-103) is Alpha/Beta/Gamma and `HREF_OF` (106) their URLs. Note the environment facts in the header docblock (1-59): `getContext` is `null` so positions never drift, `getBoundingClientRect` is all-zeros so a client coordinate is a canvas coordinate, and `Math.random` is pinned to 0 so all three nodes stack at (100, 100) unless `positionNodes` spreads them. A click-then-arrow case MUST use `positionNodes(SPREAD)` — with the nodes stacked, "the clicked node" and "node 0" are the same node and the case proves nothing.
- `src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx:414-433` -- "Enter opens exactly what a click on the same node opens" clicks (100, 100) (node 0) then focuses and presses Enter. It stays green under this change because seating index 0 is what `handleFocus` would have done anyway; do not restructure it.
- `src/app/wiki/graph/page.tsx:157-204` -- the canvas block comment. Its "This replaces the DW-463 state" paragraph describes the keyboard path; it currently says nothing about the pointer seeding the cursor, and now must, since a reader of that comment is the person who would otherwise re-revert this.
- `_bmad-output/implementation-artifacts/spec-dw-594-596-graph-canvas-keyboard-cursor.md` -- the superseded boundary: the `Never` bullet "Do not add a per-node DOM shadow tree, hit regions, `drawFocusIfNeeded`, panning/zooming, or mouse-driven cursor movement" (line ~65) and the `Always` bullet "The pointer path's observable behaviour is unchanged: hover, cursor style, tooltip, and click-to-open all still work exactly as today". Both need the amendment, plus a `## Spec Change Log` entry naming DW-751 and the 2026-09-04 human decision. Its `deferred:` frontmatter entry stays as the record of what was deferred; do not delete it.
- `src/lib/graph-render.ts` -- read-only here. `connectionsLabel` and the `cursor` ring are unchanged; nothing about the ring's drawing changes.
- `src/lib/__tests__/retired-surfaces.test.ts` -- read-only source pins, untouched.
- `vitest.config.ts:70-103` -- `*.test.tsx` under `__tests__/` runs in the jsdom project; the existing file is already there.

## Tasks & Acceptance

**Execution:**
- `src/hooks/useGraphSimulation.ts` -- extract `seatCursor(index, nodes)` from `moveCursor`, reuse it in `moveCursor` and `handleFocus`, and call it from `handleClick`'s hit branch (indexed loop) immediately before `openNode` -- one function is what keeps the pointer and the keyboard from wording or placing the cursor two different ways, which is the defect itself.
- `src/hooks/useGraphSimulation.ts` -- update `handleClick`'s comment and the `cursorIndexRef` docblock to record that the pointer now seats the cursor and why (a click focuses the canvas, so without this the two paths disagree from the first click) -- the previous implementation of this fix was reverted for want of that record.
- `src/app/wiki/graph/page.tsx` -- extend the canvas block comment's keyboard paragraph to state that a click seats the cursor on the clicked node, citing DW-751 -- the comment is the standing explanation of this canvas's a11y model and currently implies the pointer path is inert with respect to the cursor.
- `src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx` -- add a describe covering every I/O matrix row: a focused click seating and announcing the clicked node, an arrow after that click resuming from it, a click on empty canvas leaving the cursor alone, a refocus after a click returning to the clicked node, and a click after a lens change -- without these the seat is unobserved and deleting it leaves the suite green, which is exactly how DW-751 survived the original build.
- `_bmad-output/implementation-artifacts/spec-dw-594-596-graph-canvas-keyboard-cursor.md` -- amend the `Never` bullet and the `Always` pointer bullet to record that DW-751's 2026-09-04 human decision supersedes them, and append a `## Spec Change Log` entry saying what was widened and why -- the reverted fix is only safe to reinstate if the boundary that forbade it visibly no longer does.

**Acceptance Criteria:**
- Given the graph page mounted with the real hook and three nodes at distinct positions, when the canvas is focused and a click hits the second node and then ArrowRight is pressed, then the live region names the third node ("3 of 3"), and reverting the `seatCursor` call in `handleClick` fails that test.
- Given the repository after this change, when `npx tsc --noEmit`, `npx eslint src/app/wiki/graph src/hooks src/lib` and the full `npx vitest run` are executed, then types and lint are clean and no test fails that did not already fail on `0d209b1f`, with `src/lib/__tests__/retired-surfaces.test.ts` unmodified and green.
- Given a reader of `spec-dw-594-596-graph-canvas-keyboard-cursor.md`, when they reach its `Never` list, then it no longer forbids the behaviour this change adds and names DW-751's decision as what superseded it.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 0
- reject: 7: (high 0, medium 1, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The "seat BEFORE `openNode`" ordering — an `Always` clause of this spec, restated in the `handleClick` comment and the Code Map — was observed nowhere: `router.push` is an inert mock, so swapping the two statements left the whole suite green (verified). A `renderHook` case now drives `handleClick` with a router whose `push` throws and asserts the cursor was already seated; the mutation fails exactly that case and nothing else.
  - `[low]` `[patch]` Two docblocks in `useGraphSimulation.ts` still stated invariants this change falsifies: `cursorAnnouncement`'s "Empty while the canvas is unfocused" and `focusedRef`'s "Gates BOTH the ring and the announcement". Both corrected, and the remaining ring/announcement asymmetry is now explained where `focusedRef` is declared.
  - `[low]` `[patch]` `seatCursor` has three effects and the click path pinned only two — nothing observed that a click asks for a repaint, so the ring could stop following the pointer's seat silently. A case in the quiescent frame-counting describe now asserts a hitting click requests a frame and a missing click requests none.
  - `[low]` `[patch]` The amended `Never` bullet in `spec-dw-594-596-graph-canvas-keyboard-cursor.md` no longer parsed as a sentence: the original clause had been lifted out of the list and a struck fragment stranded after a full stop, so the bullet no longer showed what it used to say. Restored to one sentence with the clause struck in place.
  - `[low]` `[patch]` That spec's I/O & Edge-Case Matrix was not amended — its "Pointer reader clicks a node" row still described navigation only, three lines under an `Always` bullet that now says otherwise. The row now names the seat and the announcement, and its error column records that a miss changes no cursor; the change-log entry records the matrix amendment too.
  - `[low]` `[patch]` The new prose mixed 0-based and 1-based node numbering inside single paragraphs ("at index 0" then "resumes from node 1"), in commentary whose whole subject is which node the cursor is on. Now consistently "the first node" / "index 0".
  - `[low]` `[patch]` The empty-canvas case's comment claimed the click was "hundreds of pixels from all three of SPREAD's points"; it is ~180px from the middle node. Replaced with the real distances against the ~16px hit radius, since this file's coordinate comments are load-bearing.

Rejected (dropped): the change log's reference to `spec-dw-751-graph-click-moves-cursor.md` "dangling" because that file was untracked at review time (it is committed with this change); adding a resolution marker to the source spec's `deferred:` frontmatter entry (its `origin: spec-deferred 87acd760c2fe` identity is content-derived, so editing it risks a re-harvest as a new entry — resolution is the orchestrator's to record, in the ledger); the focus-then-click double write to the live region, which speaks the first node before the clicked one (`[medium]` — real, but strictly better than the previous state where the region said the first node and stayed wrong, and suppressing the focus announcement for pointer-originated focus is a separate design change; recorded as a residual risk instead); a click that does not move focus (an iOS tap, a programmatic `.click()`) leaving an announcement no blur can clear (the page navigates away in the same gesture); clicking the node the cursor already sits on producing an identical string and so no re-announcement (nothing needed announcing — the region was already correct); the announcement's "Press Enter to open." reaching a reader whose page is already navigating (the wording is the cursor's standing description, shared with the keyboard path by design); and the change's footprint exceeding the intent's literal naming — `moveCursor` and `handleFocus` refactored, five tests rather than one, two clauses rather than one (the intent's "announce it the way `moveCursor` does" and its second decision line's "record the supersession of the spec's `Never` clause and the 2026-08-29 decision" ask for exactly this).

## Design Notes

The seat is a shared function rather than three copies, because the announcement is the thing the two paths must not diverge on — the same argument `openNode` already makes for the URL:

```ts
const seatCursor = useCallback(
  (index: number, nodes: GraphNode[]) => {
    cursorIndexRef.current = index;
    setCursorAnnouncement(describeCursor(nodes[index], index, nodes.length));
    redraw();
  },
  [redraw],
);
// handleClick's hit branch: seatCursor(i, data.nodes); openNode(n); return;
```

Why announce from a click at all, when a sighted pointer user does not need it: the canvas is focused by the same gesture, so after the click the live region is the standing description of where the keyboard cursor is. Leaving it naming node 1 while the cursor sits on node 5 is a live region that lies — worse than one that is silent. A pointer-and-keyboard user (a magnifier reader, a trackpad user who then tabs) is the case this serves.

## Verification

**Commands:**
- `npx vitest run src/app/wiki/graph src/hooks src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/graph-render.test.ts` -- expected: green, including the new click-then-arrow pins.
- `npx tsc --noEmit` -- expected: no type errors.
- `npx eslint src/app/wiki/graph src/hooks/useGraphSimulation.ts src/lib/graph-render.ts` -- expected: clean.
- `npx vitest run` -- expected: no failure that is not also present on `0d209b1f`.
- `git diff --stat -- src/lib/__tests__/retired-surfaces.test.ts` -- expected: empty.
- Mutation check: delete the `seatCursor` call from `handleClick` and confirm the new cases fail; move it after `openNode` and confirm the ordering still holds; restore.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** A click on a graph node now moves the keyboard cursor to that node. `handleClick` keeps its hit test and its single `openNode` navigation, but before it navigates it seats the cursor on the node it found — writing `cursorIndexRef`, announcing the node in the live region, and asking for a repaint — through the same `seatCursor` the arrow keys and focus use. So a reader who clicks and then presses an arrow resumes from the node they just acted on rather than from the first one, and the live region names the node they clicked rather than the one focus seeded. The seat happens only on a hit-test hit and is deliberately not gated on `focusedRef`: a real browser focuses the canvas on the same mousedown, so a click already seated a cursor — at the first node, whatever node was clicked — which is why leaving the pointer path silent bought a wrong cursor rather than no cursor. This widens the `Never: no mouse-driven cursor movement` clause of `spec-dw-594-596-graph-canvas-keyboard-cursor.md` and supersedes the 2026-08-29 decision's "keep the pointer path unchanged", on the human decision recorded for DW-751 on 2026-09-04; both supersessions are recorded in that spec.

**Files changed.**
- [../../src/hooks/useGraphSimulation.ts](../../src/hooks/useGraphSimulation.ts) -- `seatCursor(index, nodes)` extracted as the one definition of "the cursor is here" (index + announcement + redraw) and shared by `moveCursor`, `handleFocus` and now `handleClick`, whose loop became indexed; the `cursorIndexRef`, `focusedRef` and `cursorAnnouncement` docblocks rewritten to record that both input paths seat the cursor and that only the ring stays focus-gated.
- [../../src/app/wiki/graph/page.tsx](../../src/app/wiki/graph/page.tsx) -- a paragraph in the canvas block comment recording that a click seats the cursor, why the pointer path cannot be inert with respect to it, and which boundary this supersedes.
- [../../src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx](../../src/app/wiki/graph/__tests__/graph-activation-mounted.test.tsx) -- a DW-751 describe covering every I/O matrix row (seat-and-announce, arrow-after-click, no-hit leaves the cursor, refocus returns to the clicked node, click after a lens change with no prior focus), plus an ordering pin driven through a router whose `push` throws, plus a frame-scheduling case in the existing repaint describe. The pre-existing `router()` stub factory was hoisted to module scope; no other existing test code changed.
- [spec-dw-594-596-graph-canvas-keyboard-cursor.md](spec-dw-594-596-graph-canvas-keyboard-cursor.md) -- the `Never` clause, the `Always` pointer bullet and the "Pointer reader clicks a node" matrix row amended with the supersession, and a Spec Change Log entry recording what was widened, why, and what still stands. Its `deferred:` entry was left in place as the record of what was deferred.

**Review findings breakdown.** 7 patches applied (1 medium, 6 low) -- see the Review Triage Log. 0 items deferred. 7 rejected. 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation.** `false`. Patched findings this pass: high 0, medium 1, low 6. The recommendation counts high-severity patches only, and there were none.

**Verification performed.**
- `npx vitest run src/app/wiki/graph src/hooks src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/graph-render.test.ts` -- 11 files, 219 passed, 0 failed (28 in the graph activation file).
- `npx vitest run` (full suite) -- 398 files, 9987 passed, 1 skipped, 0 failed. Also green before the patch pass at 9985.
- `npx tsc --noEmit` -- clean. `npx eslint src/app/wiki/graph src/hooks src/lib` -- clean.
- `git diff --stat -- src/lib/__tests__/retired-surfaces.test.ts` -- empty, as its Never clause requires; `_bmad-output/implementation-artifacts/deferred-work.md` likewise untouched.
- Mutation checks, each restored and re-verified afterwards: deleting `seatCursor(i, data.nodes)` from `handleClick` fails 6 cases (the no-hit case correctly stays green, since it asserts the absence of a change); moving the seat after `openNode` fails exactly the ordering case and nothing else.
- Matrix audit: all five rows ran and passed -- "announces the clicked node, not the one focus landed on"; "resumes an arrow press from the clicked node"; "leaves the cursor alone when the click hits nothing"; "returns to the clicked node when the canvas is refocused"; "seats the cursor on a click after a lens change, with no focus first". Each row's error column is covered by that case or by the pre-existing `no nodes` describe.

**Residual risks.**
- In a real browser the gesture is mousedown → `handleFocus` (announces the first node) → click → `handleClick` (announces the clicked node), so a polite live region has two strings written in quick succession and may speak the first node before the correction. Strictly better than the previous state, where it said the first node and stayed wrong, but the transient is real; suppressing the focus announcement when focus arrived from a pointer is a separate design change and was not made here.
- The browser gesture itself is still never exercised: jsdom's `fireEvent.click` dispatches no focus, so the tests seat focus programmatically (or, in the lens-change case, not at all). What is pinned is "`handleClick` seats the cursor", not "a click focuses and then seats". That interleaving is argued in comments and unobserved.
- The ring is pinned for the click path only through the repaint it schedules; no test reads a `cursor` argument reaching `renderGraph` from a click, because the one describe with a 2D context runs live physics and its coordinates drift, which is exactly what makes a click unaimable there.
- The seated cursor's lifetime after a click is bounded by the navigation `openNode` starts. The refocus and arrow-after-click cases model a graph page that is still mounted, which is the real window Next's client-side transition leaves open, not an indefinite one.
