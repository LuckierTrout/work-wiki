---
title: 'The last two scroll surfaces come back where the owner left them'
type: 'bugfix'
created: '2026-09-02'
baseline_revision: '61924b98eb406f779b112d2e02fae7276c9c5c35'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      WorkspacePreview, the Agent-output Preview column, renders the same two
      `.wb-preview` / `.wb-preview-body` scroll boxes under the same `hidden`
      withdrawal and did not get DW-520's scroll memory.
    evidence: |-
      `Workbench.tsx:1917-1923` mounts `WorkspacePreview` from the same block as
      `PreviewColumn`, with the same `id={PREVIEW_ID}` and the same
      `hidden={!previewOpen}` (`previewOpen = previewDocked && !settingsOpen`,
      `Workbench.tsx:401`). `WorkspacePreview.tsx:77-113` renders
      `<aside className="wb-preview">` around `<div className="wb-preview-body">`
      — both `overflow: auto` (`globals.css:4214`, `:4262`) and both discarded by
      `.wb-preview[hidden] { display: none }` (`globals.css:2782`) — and holds no
      ref, no restore and no listener. In Chat mode with an `agent-workspace/`
      file picked (`shouldDockPreview` docks for `mode === "chat"`,
      `workbench-tree.ts:511-525`) an owner who scrolls a long Agent report,
      opens Settings and closes it lands back at the top of both boxes: exactly
      the loss DW-520 names, at a component neither ledger entry mentions. The
      only suite that mounts it (`epic8-chat-ui.test.tsx:233`) passes no `hidden`
      prop and asserts only the fetched body.
    location: >-
      src/components/workbench/WorkspacePreview.tsx:77-113
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two scroll surfaces were left out of the DW-206/208/416/521/524 pass and nothing mounts either of them. (DW-519) `SourcesTree`'s persist effect is byte-for-byte the pre-DW-208 shape — the frame reads `panel.scrollTop` and the cleanup only removes the listener and cancels the frame, so a scroll in the last frame before a mode switch or a Settings visit is lost — and its restore is a `[]`-keyed mount effect reading ONE un-banded number, the DW-206 shape that lets a 900px crossing clamp the desktop offset and write the clamp back over it. `Workbench` renders the component as `mode === "sources" && …` inside a `settingsOpen ? null : …` branch, so it genuinely unmounts and that cleanup really runs; no suite mounts it, so deleting the effect outright would leave the suite green. (DW-520) `.wb-preview` and `.wb-preview-body` are both `overflow: auto`, `.wb-preview[hidden] { display: none }` withdraws the column for exactly the visit DW-416 fixes for the canvas, and `PreviewColumn` holds no scroll ref and no effect at all — so two of the three surfaces that visit withdraws come back where the owner left them and the third does not.

**Approach:** Give each surface the shape its sibling already has. `SourcesTree` gets `TreePanel`'s event-time capture with a flushing cleanup, a band-keyed restore that is a LAYOUT effect with the DW-521 echo, and `readStoredSourcesScroll`/`writeStoredSourcesScroll` gain the banded storage shape with the same read-time legacy migration `readStoredTreeScroll` performs. `PreviewColumn` gets `ModeCanvas`'s ref-and-restore keyed on `hidden` for both boxes, persisted through ONE capture-phase listener on the `<aside>` so a `.wb-preview-body` that renders after the effect ran is still recorded. Both surfaces get their first mounted coverage.

## Boundaries & Constraints

**Always:** The band is `workbench-split`'s `treeScrollBand(narrow)` applied to what `matchMedia(SPLIT_NARROW_QUERY)` answered — `SourcesTree` spells no width, no breakpoint and no `innerWidth`. The Sources offset stays in localStorage under `WORKBENCH_SOURCES_SCROLL_KEY` (it genuinely unmounts) and a pre-existing bare number under that key is migrated ON READ into the WIDE band, exactly as `readStoredTreeScroll` migrates its legacy shape. The Preview's offsets live in REFS and die with the tab — DW-416's scope is the visit, not FR-8. Every restore arms the echo with the value the browser ACTUALLY landed on and every echo is a VALUE spent by the first `scroll` event whatever that event says. Every restore is a `useLayoutEffect`; every persist stays a passive `useEffect`. `SourcesTree`'s persist captures `scrollTop` AT THE SCROLL EVENT and its cleanup flushes a pending value after cancelling the frame.

**Block If:** A capture-phase `scroll` listener on the `<aside>` does not receive an event dispatched at `.wb-preview-body` in this jsdom — a non-bubbling event still runs the capture path, and if it does not here the persist side needs a different attachment point rather than an untestable one.

**Never:** Do not add a `collapsed` or `hidden` prop to `SourcesTree`, and do not touch `Workbench.tsx`'s render of it — the component unmounts for both of those transitions today and that is the mechanism this preserves. Do not invent a localStorage key for the Preview's offsets and do not claim FR-8 cross-session restore for them. Do not touch `.wb-preview`, `.wb-preview-body` or `.wb-sources-tree` CSS. Do not change `TreePanel.tsx`, `ModeCanvas.tsx` or `workbench-split.ts`. Do not cancel or reset anything the owner is holding — no closing the editor, no dropping the draft. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sources scrolled in the frame before an unmount | `scroll` fires, the component unmounts before the rAF runs | The cleanup writes the value captured AT THE EVENT for the band it was in | A cleanup with no pending write flushes nothing |
| Sources offset across the 900px breakpoint | Wide offset stored, viewport narrows | The NARROW band's own offset is restored, and a scroll there writes the narrow band alone | Neither band's write can reach the other |
| A pre-DW-519 bare number under the Sources key | `localStorage` holds `"120"` | Read as `{ wide: 120, narrow: 0 }`; the first write normalises the key to the banded shape | Any other stored value degrades to `{ wide: 0, narrow: 0 }` |
| The Sources restore is clamped | Stored offset exceeds what the box can reach | The clamp's own `scroll` echo is dropped, so the stored offset survives to the visit that can reach it | A restore that changes nothing leaves an arm the owner's next real scroll spends harmlessly |
| Preview scrolled, then Settings visited | Both boxes scrolled, column withdrawn and handed back | The SAME two nodes come back at the same two offsets, and a scroll after the visit replaces them | Nothing is written to localStorage for either box |
| `.wb-preview-body` renders after the restore effect ran | Column mounts loading, payload lands, owner scrolls the body | The body scroll is still recorded — the listener is on the stable `<aside>`, in the capture phase | A body branch not rendered on return restores nothing and starts at the top |
| Column mounts already withdrawn | `hidden` true at first render | No read and no write; the first restore happens when it comes on screen | Nothing recorded means nothing assigned — the box starts where the browser left it |

</intent-contract>

## Code Map

- `src/components/workbench/SourcesTree.tsx` -- the two effects to replace: the `[]`-keyed mount restore at :66-70 and the pre-DW-208 persist at :84-105. `bodyRef` (:55) is the `.wb-sources-tree` container. The window-growth `setWindowLimit` inside the frame at :93-97 must survive.
- `src/components/workbench/TreePanel.tsx` -- THE MODEL, do not edit. `restoreEchoRef` (:208-213), the layout restore (:230-252), the event-time capture + flushing cleanup (:279-311). Copy the mechanism, not the `tab`/`collapsed`/`hidden` keys.
- `src/components/workbench/ModeCanvas.tsx` -- THE MODEL for DW-520, do not edit. `canvasScrollRef` starting `null` (:172-176), `restoreEchoRef` (:181), the `[hidden]`-keyed layout effect (:186-224).
- `src/lib/workbench-state.ts` -- `readStoredSourcesScroll` (:328-337) and `writeStoredSourcesScroll` (:339-348) to reshape. `readStoredTreeScroll` (:286-311) is the legacy-migration model; `storedOffset` (:258), `writeStoredJson` (:149) and `WORKBENCH_SOURCES_SCROLL_KEY` (:53) are the reuse points. The key has NO other reference anywhere in the repo.
- `src/lib/workbench-split.ts` -- read-only reuse: `SPLIT_NARROW_QUERY` (:119), `TreeScrollBand` (:469), `TREE_SCROLL_BANDS` (:472), `treeScrollBand` (:492).
- `src/components/workbench/PreviewColumn.tsx` -- `PreviewPane` takes `hidden` (:273) and `ref` (:210, forwarded onto the `<aside>` at :1232). `.wb-preview-body` is the `<div>` at :1218, rendered only on the text branch of `body()`. `Workbench.tsx:363` passes a plain `RefObject`, so the merge is `asideRef.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node;`.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` -- the mounted-scroll case style to follow: `panel.scrollTop = 0` standing in for the browser's reset, the `Object.defineProperty` clamp stand-in (:747-760), and the rAF flush idiom.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- the DW-416/521 canvas cases (:803-930) and its `renderShell` / `open` / `closeSettings` / `openPreviewEditorWith` helpers.
- `src/test/dom-helpers.ts` -- `setMediaQuery` (throws unless the component has already called `matchMedia` with that exact query).
- `src/lib/__tests__/workbench-left-column.test.ts:912` -- scans `SourcesTree.tsx` for `SOURCES_WINDOW_INITIAL`, `nextSourceWindowLimit`, `workbenchMode("sources").emptyState`; all must survive.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-state.ts` -- change `readStoredSourcesScroll()` to return `Record<TreeScrollBand, number>` and `writeStoredSourcesScroll(band, offset)` to read-modify-write the banded object through `writeStoredJson`; migrate a bare stored number into the `wide` band on read and degrade anything else to zeros -- one offset shared across the 900px crossing is not one offset (DW-206's argument, DW-519's surface).
- `src/components/workbench/SourcesTree.tsx` -- add the `matchMedia(SPLIT_NARROW_QUERY)` subscription and `band = treeScrollBand(narrow)`; turn the restore into a `useLayoutEffect` keyed on `[band]` that arms `restoreEchoRef` with the landed value; rewrite the persist effect to capture at the scroll event, drop the echo, key on `[leafCount, band]` and FLUSH the pending value in the cleanup after cancelling the frame -- the lost last frame and the cross-band clamp are the two named defects.
- `src/components/workbench/PreviewColumn.tsx` -- add `asideRef`/`bodyRef` element refs, `null`-seeded offset refs and echo refs for both boxes, a merged `<aside>` ref callback, a `ref` on the `.wb-preview-body` div, and one `useLayoutEffect` keyed on `[hidden]` that restores both boxes and attaches ONE capture-phase `scroll` listener on the `<aside>` -- the withdrawal is the only key, and capture is what reaches a body that mounts later.
- `src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` -- new mounted suite covering every I/O Matrix row: `SourcesTree` rendered directly for the flush, band and echo cases, and the full shell with a docked Preview for the Settings round trip -- both components have zero mounted coverage today, so either effect could be deleted with the suite green.

**Acceptance Criteria:**
- Given a mounted `SourcesTree` whose panel is scrolled and whose `scroll` event is followed by an unmount inside the same `act` with no animation frame between them, when the cleanup runs, then `readStoredSourcesScroll()` reports the scrolled offset for the band the panel was in.
- Given `SourcesTree` mounted with distinct wide and narrow offsets stored, when `matchMedia(SPLIT_NARROW_QUERY)` moves to `true`, then the panel holds the narrow band's offset and a scroll recorded there leaves the wide band untouched.
- Given a mounted shell with a docked Preview whose `<aside>` and `.wb-preview-body` are scrolled, when Settings is opened and closed, then both are the same nodes at the same offsets and no `localStorage` key mentioning the Preview exists.
- Given the whole `dom` and `node` vitest projects, when they run, then every previously passing assertion still passes.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 4, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 17: (high 0, medium 0, low 17)
- addressed_findings:
  - `[medium]` `[patch]` `SourcesTree`'s layout restore was keyed on `[band]` alone, but `.wb-sources-tree` is not rendered while `!hasWiki`, `filesUnavailable` or the tree is empty — so on the ordinary path the panel did not exist when the effect ran and `band` never moved afterwards, leaving a tree that RECORDED an offset it would never restore. Added `treeShowing` (the same three conditions the render branches on) to both effects' keys.
  - `[medium]` `[patch]` Both new comments justified the band split with a `globals.css` narrow cap on `.wb-sources-tree` that does not exist. Rewrote them to the mechanism that is there — the shell stacks and `.wb-left` goes `overflow: visible` below the breakpoint — and said explicitly that this is NOT `.wb-tree-body`'s 40vh cap.
  - `[medium]` `[patch]` The DW-521 echo branch returned before the `setWindowLimit` bottom check, so a restore landing at the bottom of the current window no longer grew it and the list refused to continue. Extracted `growWindowAtBottom()` and run it on the echo path too — the echo suppresses the WRITE, not the position.
  - `[medium]` `[patch]` `PreviewColumn`'s two offset refs were never cleared when the previewed row changed, so picking a new row and making a Settings round trip assigned the previous row's offset to different content. Added a `[selectionKey]`-keyed reset, declared before the restore, on a primitive derived from the pick rather than the object.
  - `[low]` `[patch]` The DW-524 layout-effect choice is unobservable in jsdom (either restore reverts to `useEffect` with every dom suite green). Added the repo's source-pin convention for both new sites in `workbench-left-column.test.ts`.
  - `[low]` `[patch]` The I/O matrix row for an absent `.wb-preview-body` on return had no test, and DW-519's flush was proven only through a bare `view.unmount()` rather than the shell transitions the ledger entry cites. Added both cases.

## Design Notes

`scroll` does not bubble, so a listener on the `<aside>` cannot hear `.wb-preview-body` in the bubble phase — but a non-bubbling event still runs the CAPTURE path from the root to the target, and a capture listener registered on the target itself also fires at `AT_TARGET`. One capture listener on the stable `<aside>` therefore covers both boxes and survives the body div appearing after the payload lands, which a per-element listener attached in a `[hidden]`-keyed effect would not:

```tsx
const onScroll = (event: Event) => {
  const box = boxes.find((candidate) => candidate.node() === event.target);
  if (!box) return;
  const landed = (event.target as HTMLElement).scrollTop;
  const echo = box.echo.current;
  box.echo.current = null;          // spent unconditionally — a VALUE, not a latch
  if (echo !== null && landed === echo) return;
  box.stored.current = landed;      // a ref, not storage: the visit is the scope
};
aside.addEventListener("scroll", onScroll, { passive: true, capture: true });
```

`SourcesTree` takes NO withdrawal key. `Workbench.tsx:1777` renders it as `mode === "sources" && …` inside `settingsOpen ? null : …`, so a mode switch and a Settings visit both UNMOUNT it — which is why its memory is in localStorage and why the flushing cleanup is the whole fix. Keying on a `hidden` it never receives would be a dependency on a prop that does not exist.

## Verification

**Commands:**
- `npx vitest run --project dom src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` -- expected: all new cases pass.
- `npx vitest run` -- expected: both projects green, no previously passing file regressed.
- `npx tsc --noEmit` -- expected: no errors (the `readStoredSourcesScroll` signature change has exactly one call site).
- `npx eslint src/components/workbench/SourcesTree.tsx src/components/workbench/PreviewColumn.tsx src/lib/workbench-state.ts src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

The two scroll surfaces the DW-206/208/416/521/524 pass left behind now remember where the owner left them, and both have their first mounted coverage.

`SourcesTree` keeps its memory in localStorage — `Workbench` renders it as `mode === "sources" && …` inside a `settingsOpen ? null : …` branch, so a mode switch and a Settings visit genuinely unmount it. Its persist effect now captures `scrollTop` at the scroll EVENT and its cleanup FLUSHES a pending value after cancelling the frame, so the last frame before that unmount is no longer lost; the offset is keyed per width band, restored from a `useLayoutEffect` with the DW-521 echo, and both effects key on whether the panel is rendered at all.

`PreviewColumn` survives the same visit mounted (DW-412), so its two boxes keep their offsets in REFS that die with the tab — no localStorage key, no FR-8 claim. One `[hidden]`-keyed layout effect restores `.wb-preview` and `.wb-preview-body` and attaches ONE capture-phase `scroll` listener on the stable `<aside>`: `scroll` does not bubble, but a non-bubbling event still runs the capture path, which is what covers a body div that renders after the payload lands. A `[selectionKey]`-keyed reset keeps one row's offsets off another row's content.

### Files changed

- `src/lib/workbench-state.ts` — `readStoredSourcesScroll` returns `Record<TreeScrollBand, number>` and `writeStoredSourcesScroll(band, offset)` read-modify-writes it; a pre-DW-519 bare number migrates on read into the `wide` band. New private `readStoredValue` (the same read without `readStoredRecord`'s object narrowing, which would erase the scalar the migration exists to carry).
- `src/components/workbench/SourcesTree.tsx` — `matchMedia(SPLIT_NARROW_QUERY)` subscription, `treeScrollBand(narrow)`, `treeShowing`, the layout restore with its echo, and the event-time capture with the flushing cleanup.
- `src/components/workbench/PreviewColumn.tsx` — two element refs, two `null`-seeded offset refs, two echo refs, a merged `<aside>` ref callback, a `ref` on `.wb-preview-body`, the `[selectionKey]` reset and the `[hidden]`-keyed restore + capture-phase persist.
- `src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` (new) — 17 mounted cases: `SourcesTree` rendered directly and driven through the shell, `PreviewColumn` through a real Settings round trip.
- `src/lib/__tests__/workbench-left-column.test.ts` — the DW-524 source pins for both new restores, and one pre-existing scan loosened from `'<div className="wb-preview-body">'` to the opening-tag prefix (the case asserts note-before-body ORDER; the div now carries a `ref`).

### Review findings breakdown

- Patches applied: 6 (medium 4, low 2) — see the Review Triage Log.
- Items deferred: 1 (`WorkspacePreview`, the sibling Agent-output Preview column, keeps the DW-520 bug — see frontmatter `deferred`).
- Items rejected: 17 — pre-existing gaps outside this intent (a left-column collapse in Sources mode, banding the Preview's boxes, the editor `<textarea>` as a third box, `ModeCanvas`'s DW-523 scroller choice applied to the Preview), established-pattern complaints the siblings already ship (read-modify-write per frame, degrade-to-0 on a corrupt record, the `narrow` seed running in a passive effect, the echo spent by the first event whatever it says), unreachable failures (the `-1` sentinel reaching a write), and refactor/style preferences (extracting a shared `useScrollMemory` hook, renaming the suite, helper null-assertion style).

### Follow-up review recommendation

`true`. Patched findings only: high 0, medium 4, low 2 — score `3 × 4 + 1 × 2 = 14`, which is ≥ 5. No patched finding was high severity.

### Verification performed

- `npx vitest run --project dom src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` — 17 passed.
- `npx vitest run` — 362 files, 8957 passed, 1 skipped. The only failures anywhere in the run were two `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles` cases timing out at 5s under full parallel load; **the identical two cases fail at the clean baseline with this change stashed** (`git stash push -u` → `npx vitest run --project node` → same two names), and the file passes 95/95 in isolation in under a second. Pre-existing, load-dependent, and on a real-filesystem grace-window path nothing here touches.
- `npx tsc --noEmit` — clean. `npx eslint` over all five touched files — clean.
- Matrix test audit: all seven I/O matrix rows are covered by cases that ran and passed in the run above.
- Every new case was mutation-checked rather than trusted: removing the cleanup flush, dropping `capture: true`, re-keying the Sources restore to `[]` or `[band]`, deleting the `[selectionKey]` reset, removing the Preview echo comparison, dropping `growWindowAtBottom()` from the echo path, and reverting both restores to passive `useEffect` each fail exactly the intended case or pin and nothing else.

### Residual risks

- The Preview's offsets are un-banded and its restore never re-keys on the breakpoint, so an offset recorded above 900px and clamped below it is replaced by the clamp for the next visit. The echo keeps a RESTORE's own clamp out of the ref, which is the failure DW-520 names; a live crossing is a wider claim than either ledger entry makes and would need `ModeCanvas`'s DW-523 scroller choice alongside it.
- A left-column collapse and re-expand in Sources mode still loses the offset. `SourcesTree` receives neither `collapsed` nor `hidden` — it is unmounted by the transitions it does care about — and the spec's Never list rules out adding the prop, so closing this is a mechanism decision rather than a patch.
- `.wb-preview-textarea` is a third scroll box inside the same `<aside>`, discarded by the same `display: none`. The capture listener sees its events and drops them, so an owner scrolled down mid-draft still returns to the top of the editor.
- `storage-fs.test.ts`'s `reapStrandedScratchFiles` cases are flaky at baseline under full-suite load (5s `testTimeout` against real filesystem mtimes). Unrelated to this change, but it will read as a red CI run.

