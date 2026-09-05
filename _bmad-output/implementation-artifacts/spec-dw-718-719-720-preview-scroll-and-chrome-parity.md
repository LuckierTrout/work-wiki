---
title: 'Preview scroll and chrome parity: workspace column, dead class, canvas re-probe'
type: 'bugfix'
created: '2026-09-04'
baseline_revision: '2e189623e66bec513c70da04f92dbf3bf21e53b0'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Opening the mode sheet below the stacking breakpoint with a Preview docked
      re-applies the shell's clamp, and the scroll the browser dispatches for
      that reflow overwrites the canvas's remembered offset with 0.
    evidence: |-
      `globals.css:5462-5468` brings `height: 100dvh; overflow: hidden` back on
      `.wb-shell[data-preview="true"][data-sheet-open="true"]`, so the document
      stops overflowing and the browser clamps page scroll to 0 and dispatches a
      `scroll` at `Document`. `ModeCanvas`'s effect is keyed on
      `[hidden, previewOpen, narrow]` — none of which moves when the sheet
      opens — so the listener is still on `document` with `restoreEchoRef` null,
      and `canvasScrollRef` records the clamp. DW-719's ledger entry names the
      sheet as the third clamp-flipping condition; this bundle's intent
      enumerated only the other two, so it was left out deliberately. Closing it
      needs `data-sheet-open` threaded down as a fourth re-probe trigger, which
      the spec's Never clause forbids here.
    location: >-
      src/components/workbench/ModeCanvas.tsx:283
    severity: low
---

<intent-contract>

## Intent

**Problem:** The Agent-workspace Preview column is a second-class copy of the kernel one: its header carries `wb-preview-header`, one letter off `wb-preview-head` and matched by no rule anywhere in `globals.css`, so the title strip has no padding, no border and a UA-sized `<h2>` (DW-718); and its two `overflow: auto` boxes — `.wb-preview` and `.wb-preview-body`, both discarded by `.wb-preview[hidden] { display: none }` — never got DW-520's scroll memory, so a Settings visit drops the owner at the top of a long Agent report (DW-720). One column over, `ModeCanvas` picks its scroller once per `hidden` transition, but the stylesheet flips which element scrolls when a Preview docks or the 899px breakpoint is crossed with `hidden` unmoved, so the listener stays on the element that no longer scrolls and one `canvasScrollRef` can re-apply an offset recorded on the other surface (DW-719).

**Approach:** Render `wb-preview-head` in `WorkspacePreview` and give `.wb-preview-title` / `.wb-preview-path` the margin and size reset a flex strip needs, then add a node scan that every `wb-*` class the components render matches a rule. Port `PreviewColumn`'s DW-520/521/524 restore into `WorkspacePreview` verbatim in shape, with `selectionKey` as `file:${selection.path}`. Thread `previewOpen` and a narrow-breakpoint boolean from `Workbench` into `ModeCanvas` as effect deps only, re-probe `canvasScroller` on every run, and drop the stored offset whenever the probe answers a different element from the one it was recorded on.

## Boundaries & Constraints

**Always:**
- `WorkspacePreview` stays READ-ONLY and stays MOUNTED behind `hidden`: no version, no `If-Match`, no editor, no wikilink targets, no unmount.
- Both new offsets live in REFS and die with the tab — the scope is the visit, not FR-8. No localStorage key is invented, in either component.
- Every restore is a `useLayoutEffect`; every echo is a VALUE armed with what the browser actually LANDED on and spent by the first `scroll` event whatever that event says; `null` means nothing was recorded and nothing is assigned.
- In `WorkspacePreview` the `selectionKey` clearing effect is declared BEFORE the restore, so a commit that changes both the pick and `hidden` clears then restores from nothing; persistence is ONE capture-phase listener on the `<aside>`, because `scroll` does not bubble.
- `ModeCanvas` still spells no width, no breakpoint, no `matchMedia` and no `max-width`: the narrow boolean is `matchMedia(SPLIT_NARROW_QUERY)`'s answer, subscribed in `Workbench.tsx` through `workbench-split`'s constant and handed down. Neither new prop is read for its meaning — they exist so the effect re-runs.
- `ModeCanvas` reads, writes and listens on exactly ONE surface per run, and when the probe answers an element other than the one the stored offset belongs to, that offset is DROPPED rather than re-applied.
- The class scan takes only static `className` literals, skips fragments flush against a `${…}` interpolation, and names each allowlisted rule-less class with its reason.

**Block If:** The scan reports a rendered `wb-*` class with no rule beyond the five pre-existing Chat/Search cases named in Never and `wb-preview-header` itself — a sixth miss is either a defect this bundle did not price or one its own edits introduced, and widening the allowlist would absorb it silently. HALT rather than extend the list.

**Never:**
- Do not restyle or rename `wb-chat-msg`, `wb-chat-msg--assistant`, `wb-chat-msg-role`, `wb-chat-thinking` or `wb-search-hit-title`. They match no rule today; the scan RECORDS them with a reason, and inventing chrome for Chat and Search is a UX decision outside this bundle.
- Do not touch the `.wb-preview`, `.wb-preview-body` or `.wb-preview-head` declaration blocks, and add no new selector — the only stylesheet edits are declarations added to the existing `.wb-preview-title` and `.wb-preview-path` rules.
- Do not thread `data-sheet-open` (the third clamp-flipping condition) into `ModeCanvas`, and do not listen on `window`, on both the canvas and the document at once, or on the root element for a viewport scroll.
- Do not change `PreviewColumn.tsx`, `TreePanel.tsx`, `SourcesTree.tsx` or `workbench-split.ts`, and do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Workspace column, Settings round trip | Owner scrolls `.wb-preview` to 150 and `.wb-preview-body` to 320, opens Settings, closes it | The same two nodes, un-withdrawn, back at 150 and 320; no `localStorage` key mentioning preview | No error expected |
| A different Agent file picked | Offsets recorded for `a.md`, then `b.md` picked, then a Settings round trip | Nothing recorded for the new pick, so nothing assigned: both boxes stay where the browser left them | No error expected |
| Mounted already withdrawn | `hidden` true on the first commit, then `hidden` false | No assignment at all — a first restore must not drag a box to a 0 nobody stored | No error expected |
| Restore clamped by a shorter box | Stored 300, box can reach 200 on return | 200 is assigned, the echo the browser dispatches for it is dropped, and 300 survives for the next return | No error expected |
| Preview docks while the canvas is showing | Narrow layout, `previewOpen` false → true, document now overflows | The effect re-runs, the probe answers the document, the canvas-recorded offset is dropped, and the document's scrolls are what get recorded | No error expected |
| Scroller unchanged across a re-run | Wide layout, `previewOpen` flips | Same scroller, stored offset kept, listener re-attached to the same surface, canvas never assigned an offset from the document | No error expected |
| Class scan | Every `.tsx` under `components/workbench` plus `WikiWorkbench.tsx` | Every static `wb-*` class matches a `.wb-…` selector in `globals.css`, allowlist aside | Failure names the class and the file |

</intent-contract>

## Code Map

- `src/components/workbench/WorkspacePreview.tsx` -- `:84` renders the dead `wb-preview-header`; `:77-113` are the two scroll boxes with no ref, no restore, no listener. `.wb-preview-body` here is UNCONDITIONAL (it wraps the loading, failed and rendered branches alike), unlike `PreviewColumn`'s.
- `src/components/workbench/PreviewColumn.tsx:474-590` -- the model to port: `asideRef`/`bodyRef`, `asideScrollRef`/`bodyScrollRef` (`number | null`), the two echo refs, the `selectionKey` clearing layout effect, then the `[hidden]`-keyed restore with one `{ passive: true, capture: true }` listener. `:1380`, `:1394-1396` show the markup the head/title/path classes belong to. READ-ONLY.
- `src/components/workbench/ModeCanvas.tsx:100-120` -- `canvasScroller`, which asks the DOCUMENT and defaults to the canvas; `:186-242` the refs and the `[hidden]`-keyed layout effect to re-key and re-probe; `:66-88` the props interface the two new inputs join.
- `src/components/workbench/Workbench.tsx:401-410` (`previewOpen`), `:1605-1618` (the existing `SPLIT_WIDE_QUERY` subscription, the shape to copy), `:2041-2056` (the `<ModeCanvas …>` call site).
- `src/components/workbench/TreePanel.tsx:179-192` -- the exact `narrow` state + `matchMedia(SPLIT_NARROW_QUERY)` subscription idiom to reuse in `Workbench`, seeding synchronously inside the effect.
- `src/app/globals.css:4296` (`.wb-preview-head`), `:4305` (`.wb-preview-title`), `:4326` (`.wb-preview-path`) -- the three rules involved; `:2798` (`.wb-preview[hidden]`), `:5413-5440` (the clamp release) are the read-only context.
- `src/lib/__tests__/workbench-chrome.test.ts` -- home for the class scan; already has `stripComments`, `globals()` and a `globals.css` describe. `:495` pins `"}, [hidden]);"` for `ModeCanvas` and `:439` bans `matchMedia` in it — the first must move to the new deps, the second must keep passing.
- `src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` -- home for both mounted suites: it already stubs `fetch`, mounts the shell (`renderShell`), imports `setMediaQuery`/`SPLIT_NARROW_QUERY`, and documents the jsdom limits (`scrollTop` stand-ins, declared clamps).
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx:929-1020` -- the DW-523 document-branch case, the pattern for declaring `documentElement.scrollHeight/clientHeight` and watching canvas writes. READ-ONLY.
- `src/components/workbench/__tests__/epic8-chat-ui.test.tsx:230-247` -- the only existing `WorkspacePreview` mount; shows `workspaceSelection` and the `loopbackFetch` URL. READ-ONLY.

## Tasks & Acceptance

**Execution:**
- `src/app/globals.css` -- add `margin: 0` and `font-size: var(--wb-font-size)` to the existing `.wb-preview-title` rule, and `margin: 0`, `min-width: 0`, `overflow-wrap: anywhere` to `.wb-preview-path` -- the strip is a flex row: an `<h2>` at UA size with UA margins, and an unbreakable path that cannot shrink, are what stop the renamed header from reading like its sibling.
- `src/components/workbench/WorkspacePreview.tsx` -- render `wb-preview-head`, and port the DW-520/521/524 restore: `asideRef`, `bodyRef`, two `number | null` offset refs, two echo refs, a `selectionKey` (`file:${selection.path}`) clearing layout effect declared first, then the `[hidden]`-keyed restore with one capture-phase listener -- the column withdraws the same way `PreviewColumn` does and must come back the same way.
- `src/components/workbench/ModeCanvas.tsx` -- add `previewOpen` and `narrow` props (defaulting false, documented as re-probe triggers that are never read for meaning), key the restore effect on `[hidden, previewOpen, narrow]`, and hold the probed scroller in a ref so a change clears `canvasScrollRef` before the restore reads it.
- `src/components/workbench/Workbench.tsx` -- subscribe to `SPLIT_NARROW_QUERY` in a `narrow` state the TreePanel way and pass `previewOpen={previewOpen} narrow={narrow}` to `<ModeCanvas>` -- the shell already owns both facts; `ModeCanvas` may not ask for either itself.
- `src/lib/__tests__/workbench-chrome.test.ts` -- add the `wb-*` class-coverage scan with its documented allowlist, and update the `ModeCanvas` deps assertion to the new key -- a dead class is invisible in every other suite.
- `src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` -- add a `WorkspacePreview scroll memory (DW-720)` suite (direct render, `hidden` toggled by rerender) covering the matrix's first four rows, and a `ModeCanvas scroller re-probe (DW-719)` suite covering rows five and six through the mounted shell; extend the `fetch` stub with the workspace-file URL.

**Acceptance Criteria:**
- Given the Agent-workspace column is on screen, when the DOM is inspected, then its header element carries `wb-preview-head` and no element in the repo renders `wb-preview-header`.
- Given a rendered `wb-*` class with no rule in `globals.css` and no allowlist entry, when `pnpm test` runs, then the scan fails and names the class and the file it is rendered from.
- Given the narrow layout with the canvas as scroller and an offset recorded on it, when a Preview docks and the document becomes the scroller, then the canvas offset is not applied to the document and the canvas is never written to afterwards.
- Given the whole run, when `pnpm test` and `pnpm lint` are executed, then both pass with no assertion deleted or weakened to make room for these changes.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `.wb-preview-title` had no shrink treatment while now holding a variable-length filename in the flex strip — a long unbroken name refused to shrink and pushed the path out of a 200px column. Given `min-width: 0` and the ellipsis treatment `.wb-preview-name` already carries, and the rule's comment corrected: the title elides, the path wraps inside the column.
  - `[medium]` `[patch]` The class scan matched selectors against `globals.css` with comments intact, so a rename that left its explanatory comment behind would reproduce the DW-718 defect with the scan green. CSS comments are now stripped before matching, in the miss scan and the allowlist-honesty case alike; no sixth miss appeared, so the allowlist was not widened.
  - `[medium]` `[patch]` `narrow` — one of DW-719's two named conditions — was pinned only by source-text assertions: removing it from the deps left every mounted case green. A third mounted case now crosses the breakpoint with a Preview already docked, and the mutation turns it red.
  - `[low]` `[patch]` The seven new CSS declarations had no assertion at any surface; a declaration pin on `.wb-preview-title` and `.wb-preview-path` was added to the `globals.css` describe.
  - `[low]` `[patch]` The allowlist-honesty case scanned a narrower file list than the miss scan; both now share one list including `WikiWorkbench.tsx`.
  - `[low]` `[patch]` `expect(canvas.scrollTop).toBe(180)` observed nothing — the node was never reset between the recording and the assertion. It is now zeroed before the dock, and an unconditional drop turns the case red.
  - `[low]` `[patch]` The second DW-719 case left its `documentElement.scrollTop` override installed on an early failure; it is now wrapped in `try`/`finally` like its sibling.

## Design Notes

The re-probe is a THREE-line addition to an effect that already does the right thing once:

```ts
const scroller = canvasScroller(canvas);
// The offset belongs to the element it was recorded on. The stylesheet moves
// that element without `hidden` moving, so re-applying it to the other surface
// would scroll the page to a canvas offset — or the canvas to a page one.
if (scrollerRef.current !== scroller) {
  scrollerRef.current = scroller;
  canvasScrollRef.current = null;
}
```

`previewOpen` and `narrow` are inputs to WHEN the effect runs, never to WHAT it decides: the stylesheet still owns which element scrolls, and `canvasScroller` still answers by asking the document. That is what keeps the existing bans (`matchMedia`, `900`, `max-width`) true inside `ModeCanvas` while the shell subscribes to the query on its behalf.

## Verification

**Commands:**
- `pnpm test` -- expected: the full run passes, including the new `wb-*` scan and both new mounted suites.
- `pnpm lint` -- expected: clean.
- `grep -rn "wb-preview-header" src` -- expected: no matches.

## Auto Run Result

Status: done

**Implemented change.** The Agent-workspace Preview column now matches the kernel column's chrome and scroll behaviour, and the mode canvas re-probes which element is really scrolling. `WorkspacePreview`'s header renders `wb-preview-head` — the class `globals.css` actually declares — instead of the dead `wb-preview-header`; the column carries `PreviewColumn`'s DW-520/521/524 restore (two offset refs, two echo refs, a `file:${selection.path}` clearing layout effect declared ahead of the `[hidden]`-keyed restore, one capture-phase listener on the `<aside>`); and `ModeCanvas` takes `previewOpen` and `narrow` as re-run triggers, re-probes `canvasScroller` on every run, and drops the stored offset when the probe answers a different element from the one it was recorded on.

**Files changed.**
- `src/app/globals.css` -- `.wb-preview-title` and `.wb-preview-path` gain the margin, size and shrink declarations a flex strip needs for an `<h2>` and an unbreakable path; no new selector, no change to `.wb-preview`, `.wb-preview-body` or `.wb-preview-head`.
- `src/components/workbench/WorkspacePreview.tsx` -- renders `wb-preview-head`; ported scroll memory for both `overflow: auto` boxes, in refs only.
- `src/components/workbench/ModeCanvas.tsx` -- `previewOpen`/`narrow` props, `[hidden, previewOpen, narrow]` deps, `scrollerRef` and the offset drop on a changed probe answer.
- `src/components/workbench/Workbench.tsx` -- subscribes to `SPLIT_NARROW_QUERY` in the TreePanel idiom and hands both booleans down.
- `src/lib/__tests__/workbench-chrome.test.ts` -- the rendered-`wb-*`-class coverage scan with its five-entry allowlist and an allowlist-pruning case, a declaration pin for the new CSS, a DW-719 wiring case, and the updated deps assertion.
- `src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx` -- `WorkspacePreview scroll memory (DW-720)` (4 cases) and `ModeCanvas scroller re-probe (DW-719)` (3 cases), plus the workspace-file branch in the fetch stub.

**Review findings.** 7 patches applied (medium 3, low 4); 1 deferred (low — the mode sheet's re-clamp, DW-719's third condition, deliberately outside this bundle's intent); 8 rejected (mechanism choices the intent itself made — the verbatim port rather than a shared hook, dropping rather than keeping a per-surface offset map, the third copy of the media-query idiom — plus edge cases already true of `PreviewColumn` and unreachable parser cases).

**Follow-up review recommendation:** false. Patched findings by severity: high 0, medium 3, low 4; no high-severity patch, so the score does not recommend another pass.

**Verification.** `pnpm test` -- 386 files, 9663 passed, 1 skipped, 0 failed. `pnpm lint` -- exit 0. `grep -rn "wb-preview-header" src` -- no matches. `npx tsc --noEmit` -- clean. Every I/O matrix row is covered by a named case that ran and passed, and each new behaviour was mutation-checked: removing the scroller drop, reverting the deps to `[hidden]`, removing `narrow` from the deps, disabling the workspace restore, deleting the `selectionKey` clearing effect, deleting the new CSS declarations, and hiding a rule-less class behind a CSS comment each turn the corresponding case red.

**Residual risks.**
- jsdom runs no layout, so the document-overflow branch, the browser's reset on a `display: none` box and every clamp are DECLARED through `Object.defineProperty` rather than laid out. The suites pin the components' reaction to those facts, not the browser's own behaviour; the CSS itself is pinned as declarations, not as computed geometry.
- The `previewOpen`/`narrow` "trigger, never read" rule is enforced by an occurrence count of exactly three per identifier in the stripped source. That is precise but brittle: a rename or an extra mention will fail it, which is the intent but will read as a surprising failure.
- The DW-720 cases render `WorkspacePreview` directly; the shell path to it needs a streamed Chat turn, so the integration `Workbench` provides (`hidden={!previewOpen}` from the same block as `PreviewColumn`) is pinned by the existing source scans rather than by a mounted dock.
