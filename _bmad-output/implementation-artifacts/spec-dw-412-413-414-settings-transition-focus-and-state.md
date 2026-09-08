---
title: 'Opening Settings strands the keyboard and still discards column state (DW-412, DW-413, DW-414)'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      `useDialogA11y`'s new `withdrawn()` guard knows only the `hidden`
      attribute, so an opener hidden by CSS alone still takes a focus() that a
      browser silently drops.
    evidence: |-
      `withdrawn()` (`src/hooks/useDialogA11y.ts`) answers `closest("[hidden]")`, which is this
      shell's withdrawal convention — but `globals.css` also hides with shell-scoped rules, e.g.
      `.wb-shell[data-collapsed="true"] .wb-left { display: none }`. An opener or
      `fallbackFocusRef` inside a collapsed left column is `isConnected`, has no `[hidden]`
      ancestor, and gets focused into a `display: none` subtree — the exact failure DW-414 is
      about, reached by the other route. `offsetParent` would catch it but is always `null` in
      jsdom, so it would disable every restore this suite pins; a fix needs a mechanism the node
      suites can execute. Pre-existing for the CSS route; this change narrowed the attribute
      route only.
    location: >-
      src/hooks/useDialogA11y.ts (withdrawn)
    severity: medium
  - summary: >-
      A withdrawn Preview column keeps its whole data lifecycle running, so a
      refresh during a Settings visit can refetch and announce into a live
      region nobody can hear.
    evidence: |-
      Keeping `PreviewColumn` mounted (DW-412) keeps its fetch effect, `requestDataVersionCheck()`
      and its polite live region live while the column is `hidden`. A `DataVersionWatcher` bump
      mid-visit can therefore refetch the row, flip to the stale note, or report a removal into a
      region that is out of the accessibility tree — the announcement is spent with nobody to
      hear it, and the column the owner comes back to has changed under them with no report. The
      spec's Never clause held the fetch/edit lifecycle out of scope, but the mount change is what
      makes it run off screen at all. `ModeCanvas` has the same shape and the same unanswered
      question.
    location: >-
      src/components/workbench/PreviewColumn.tsx (fetch effect / refresh announcements)
    severity: medium
  - summary: >-
      Back or a popstate that closes Settings unmounts `SettingsCanvas` under
      the keyboard, and DW-413 makes focus-in-Settings the normal case rather
      than the rare one.
    evidence: |-
      `applyMode` (`src/components/workbench/Workbench.tsx`) sets `settingsOpen` false from the
      `popstate` listener as well as from a rail pick. The rail pick is safe — the control the
      owner pressed holds focus — but a Back press moves focus nowhere, so if the owner is inside
      the Settings surface its section unmounts under them and the keyboard lands on `<body>`.
      The new focus effect deliberately runs in one direction only, and this is the case that
      argues for a second: pre-existing, but widened by the fact that opening Settings now always
      puts the keyboard inside it.
    location: >-
      src/components/workbench/Workbench.tsx (applyMode / popstate)
    severity: medium
  - summary: >-
      `ShortcutsHelp` renders `role="dialog"` without `aria-modal`, so a global
      `g <key>` still fires from inside the open help overlay.
    evidence: |-
      `src/components/ShortcutsHelp.tsx:39` renders the overlay as `role="dialog"` with only an
      `aria-label`. `isInModalDialog`'s selector requires `aria-modal="true"` — correctly, because
      `?` has to keep toggling the overlay from inside it — so the new guard does not cover this
      surface: `g i` typed over the help overlay still navigates out from under it, and the
      overlay itself is not announced as modal to a screen reader. Fixing it means deciding
      whether that overlay is modal at all (it locks no scroll and traps no Tab), which is a
      surface decision this change did not make.
    location: >-
      src/components/ShortcutsHelp.tsx:39
    severity: medium
  - summary: >-
      A second `g s` while Settings is already open announces Settings but moves
      no focus, so the key cannot be used to recover a lost keyboard.
    evidence: |-
      `g s` OPENS rather than toggles (DW-62), so a second press leaves `settingsOpen` true and
      the new focus effect — keyed on the state transition — does not re-run. The announcement is
      still made (`settings-shortcut.test.tsx` pins the repeat), so the owner is told they arrived
      somewhere the keyboard did not go. Making the key idempotent about focus needs a nonce or a
      move inside the callbacks, which the effect deliberately avoided so that both openers share
      exactly one landing site.
    location: >-
      src/components/workbench/Workbench.tsx (the settings focus effect)
    severity: low
  - summary: >-
      The `g s`-over-an-open-dialog rows of the DW-373 suite now pin a path a
      real keyboard user can no longer take.
    evidence: |-
      The new modal guard suppresses dispatch from inside `[role="dialog"][aria-modal="true"]`,
      and `useDialogA11y` traps focus there — so with a Create Wiki dialog on screen a browser
      keyboard user cannot reach `g s` at all; only the rail control can open Settings over an
      open dialog. The suite's `press()` fires at `document.body` (deliberately, so
      `isInputElement` does not swallow it), which keeps those rows green while making them
      unreachable in a browser. The preservation they check is real and still reached by the rail
      control; what is stale is the claim that both openers reach that state identically.
    location: >-
      src/components/workbench/__tests__/settings-canvas-persistence.test.tsx (the `g s` opener)
    severity: low
baseline_revision: '6df3e0caf76622fbb3262d45b73a8605cc55b2a1'
---

<intent-contract>

## Intent

**Problem:** DW-373 kept the mode canvas mounted across a Settings visit, but the rest of the transition still costs the owner something. `Workbench.tsx:295` computes `previewOpen = shouldDockPreview(mode, selection) && !settingsOpen`, so opening Settings UNMOUNTS `PreviewColumn` and silently destroys its unsaved markdown draft (DW-412); the left column's `settingsOpen ? <SettingsNav/> : …<TreePanel/>` swap unmounts `TreePanel` and with it the group/directory disclosure state it holds in `closed` (`TreePanel.tsx:116`); `openSettings`/`toggleSettings` move focus nowhere, so a keyboard user standing in the canvas that just went `display: none` is dropped on `<body>` (DW-413); and `useDialogA11y`'s restore can aim focus at an opener inside a withdrawn subtree (DW-414).

**Approach:** Apply DW-373's mechanism to the two columns it did not reach — mount `PreviewColumn` and `TreePanel` for as long as their own condition holds and withdraw them behind `hidden` while Settings is showing, publishing `visible={false}` for the Preview's dialogs — then give the transition a focus contract: opening Settings moves focus to the Settings canvas (which already carries `CANVAS_ID`/`tabIndex={-1}`), a global `g <key>` no longer dispatches from inside an open modal dialog, and `useDialogA11y` neither restores focus into a withdrawn subtree nor keeps a stale opener capture when a dialog closes off screen.

## Boundaries & Constraints

**Always:**
- Withdrawal is spelled `hidden` on the element, backed by an author `display: none` rule in `globals.css` with the attribute in the selector, stated outside every media query. `.wb-preview` and `.wb-tree-panel` both already carry author `display` declarations, so the UA default alone would not withdraw either.
- A withdrawn column publishes `visible={false}` through `SurfaceVisibilityProvider` when it can contain a dialog, so `useDialogA11y` stands its body scroll lock and capture-phase Tab trap down exactly as the mode canvas does.
- Hiding is never spelled as closing: no `open` prop flips, no state resets, no selection clears. `previewOpen` keeps its meaning — the Preview is ON SCREEN — so every layout consumer (`data-preview`, `SplitLayout`, `showSplitHandle`, the narrow reveal) reads exactly what it reads today.
- Exactly one element answers to `#wb-canvas` and one node carries `headingId` at any time (DW-373's invariant, unchanged here).
- Opening Settings moves focus to the live `#wb-canvas`; closing it does not move focus (the rail control the owner pressed already holds it).
- Comments that record the old behaviour as a live consequence must be corrected in the same change — `Workbench.tsx`'s `openSettings` paragraph (:641-646), the `PREVIEW_ID` docblock (:143-153), and the source-scan assertions that pin the spellings being replaced.

**Block If:**
- Keeping a column mounted cannot be done without a duplicate `id` or a second live `headingId` node.

**Never:**
- Do not add durable storage for any draft, and do not change what the rail control or `g s` announce, or the open/toggle asymmetry between them (DW-62).
- Do not unmount `SettingsCanvas` any later than it does today — that unmount IS the Settings draft's discard.
- Do not touch the `/settings` route (DW-61), the dock rule in `workbench-tree`, or the Preview's fetch/edit lifecycle.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Preview draft across a Settings visit | Wiki mode, a row picked, the Preview editor open with typed markdown; owner opens Settings and closes it | Same editor, same unsaved text, no remount; while Settings shows, the `<aside>` is `hidden`, out of the a11y tree and still in the document | No error expected |
| Tree disclosure state across a visit | Wiki mode, a Knowledge group collapsed by the owner; owner opens Settings and closes it | The same group is still collapsed; `TreePanel` was hidden, not unmounted | No error expected |
| Left column while Settings shows | Any mode, Settings open | `SettingsNav` is the reachable content of `.wb-left`; the tree panel (Wiki mode) is `hidden`; no `.wb-left-surface` stub renders; `.wb-left`'s `aria-label` names Settings | No error expected |
| Focus on open | Focus anywhere; owner opens Settings via the rail control or `g s` | Focus lands on the Settings section (`#wb-canvas`, `tabindex="-1"`) on both paths | No error expected |
| `g <key>` from inside a modal dialog | Create Wiki dialog open, focus inside it, owner types `g s` | Nothing dispatches: no surface change, no navigation | No error expected |
| Dialog closes while its surface is withdrawn | Create Wiki open, Settings opened over it, the active Wiki moves so `WikiWorkbench` resets `createOpen` | Focus is not pulled into the hidden subtree; the opener capture is released, so the next open records its own opener | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/Workbench.tsx:295` -- `previewOpen`; split into `previewDocked` (mount) and `previewOpen = previewDocked && !settingsOpen` (on screen). `liveRef` (:296), the narrow reveal (:952-964), `layout` (:969) and `data-preview` (:988) all keep reading `previewOpen`.
- `src/components/workbench/Workbench.tsx:1037-1061` -- the left-column swap; `TreePanel` becomes `mode === "wiki"` with `hidden={settingsOpen}`, the `.wb-left-surface` stub stays conditional on `!settingsOpen`, `SettingsNav` renders when `settingsOpen`.
- `src/components/workbench/Workbench.tsx:1141-1169` -- the `{previewOpen && <PreviewColumn …/>}` gate; becomes `previewDocked` with `hidden={!previewOpen}`. Its `PREVIEW_ID` docblock at :143-153 claims the `<aside>` lives exactly as long as the separator — now false.
- `src/components/workbench/Workbench.tsx:641-646, 866-874` -- the `openSettings` paragraph that records the Preview unmount as live; and the sheet's focus-restore effect, the precedent the new focus effect sits beside (declare it after, so a Settings pick from the sheet lands in Settings rather than back on the trigger).
- `src/components/workbench/ModeCanvas.tsx` -- the reference implementation of the whole pattern (`hidden` prop, id/tabIndex/label handoff, `SurfaceVisibilityProvider`) and the home of `CANVAS_ID`.
- `src/components/workbench/PreviewColumn.tsx:104-181, 1061` -- `PreviewColumnProps` and the `<aside id={id} className="wb-preview" …>`; add `hidden` and wrap the pane in `SurfaceVisibilityProvider visible={!hidden}` (the column owns a `ConfirmDialog` edit gate and a History panel).
- `src/components/workbench/TreePanel.tsx:110-160, 287-288` -- `closed` state (:116), the scroll effects guarded by `treeBodyShowing` (`getClientRects().length > 0`, already correct for a hidden panel), and the `<div className="wb-tree-panel">` root that takes `hidden`. The restore effect's deps must gain `hidden` so the offset is re-applied when the panel comes back.
- `src/hooks/useDialogA11y.ts:100-137` -- the armed effect: `armed = open && surfaceVisible`, the capture, and the teardown whose `if (openRef.current && !visibleRef.current) return;` distinguishes hiding from closing. VERIFIED: when a dialog closes while hidden, `armed` is already `false`, so the teardown never runs at all — the capture leaks rather than the restore firing, which is the real shape of DW-414.
- `src/hooks/useKeyboardShortcuts.ts:19-28, 222-224` -- `isInputElement` and the pre-dispatch guard in `handleKeyDown`.
- `src/app/globals.css:2688-2711` -- `.wb-canvas-mode[hidden]` / `.wb-canvas[hidden]`, the rules the two new ones sit beside. `.wb-preview` (:3109) is re-pointed inside `@media (max-width: 899px)` (:4027), the same reason the withdrawal must not live in a media query.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- the reuse model: `renderShell`, `OPENERS` (`describe.each` over the rail control and `g s`), `closeSettings`, `settingsShowing`, `nameFieldNode`, `modeCanvas`, and the `globals.css` read-back with its media-query depth check. Its "does not move focus when it hides the canvas" case (:388-402) asserts today's DW-413 defect and must be rewritten.
- `src/hooks/__tests__/useDialogA11y.test.tsx` -- mounted hook suite with `TemplateHost` / `BareHost`; the place for a withdrawn-surface host.
- Read-only, but must be retargeted where they pin a replaced spelling: `src/lib/__tests__/workbench-left-column.test.ts:67` (`mode === "wiki" ? (<TreePanel`), `src/lib/__tests__/workbench-settings.test.ts:4721` (`shouldDockPreview(mode, selection) && !settingsOpen`), `src/lib/__tests__/workbench-split.test.ts:1340-1344` (`id={PREVIEW_ID}` "exists whenever that separator does").

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/PreviewColumn.tsx` -- add an optional `hidden` prop, put it on the `<aside>` and wrap the pane's content in `SurfaceVisibilityProvider visible={!hidden}` -- the column can hold an unsaved draft AND an open confirm, so it needs both halves of DW-373's withdrawal.
- `src/components/workbench/TreePanel.tsx` -- add an optional `hidden` prop onto `.wb-tree-panel` and add it to the scroll-restore effect's deps -- `closed` is local state, and a revealed panel has just had its `scrollTop` reset by the browser.
- `src/components/workbench/Workbench.tsx` -- split `previewDocked`/`previewOpen`, render `PreviewColumn` and `TreePanel` mounted-and-hidden while Settings shows, add the focus effect that lands the keyboard on `#wb-canvas` when `settingsOpen` goes true, and correct the `openSettings` and `PREVIEW_ID` paragraphs -- the shell owns both the mount decision and the transition's focus.
- `src/hooks/useDialogA11y.ts` -- refuse a restore whose target sits inside a `[hidden]` subtree, and release the opener capture when the dialog closes while its surface is off screen -- a focus move into withdrawn content is a silent no-op, and a leaked capture aims the NEXT close at a stale opener.
- `src/hooks/useKeyboardShortcuts.ts` -- suppress dispatch when the event target is inside `[role="dialog"][aria-modal="true"]` -- a global navigation key must not walk the owner out of a modal.
- `src/app/globals.css` -- add `.wb-preview[hidden]` and `.wb-tree-panel[hidden]` `display: none` rules beside the existing pair, outside every media query, each with a comment naming why the attribute is in the selector -- both blocks already set `display`, which beats the UA default outright.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- extend the existing `describe.each` with the Preview-draft, tree-disclosure, left-column and focus-on-open rows, rewrite the focus case, and read the two new CSS rules back with the media-query depth check -- every row of the I/O matrix runs through both openers.
- `src/hooks/__tests__/useDialogA11y.test.tsx` -- add a withdrawn-surface host covering the refused restore and the released capture -- neither branch is reachable through the existing hosts.
- `src/lib/__tests__/workbench-left-column.test.ts`, `src/lib/__tests__/workbench-settings.test.ts`, `src/lib/__tests__/workbench-split.test.ts` -- retarget the three assertions that pin replaced spellings, with comments explaining the new one -- a scan that still matched would be vacuous.

**Acceptance Criteria:**
- Given the Preview editor holding unsaved markdown, when the owner opens Settings and closes it again, then the same editor is showing the same text and the column never unmounted.
- Given a collapsed Knowledge group, when the owner opens Settings and closes it again, then the group is still collapsed.
- Given Settings is open, when the a11y tree is queried, then neither the tree panel nor the Preview is reachable by role while both nodes are still in the document, and exactly one element answers to `#wb-canvas`.
- Given the owner opens Settings from either the rail control or `g s`, when the commit settles, then `document.activeElement` is the Settings section.
- Given `pnpm test` and `pnpm lint`, when run, then both pass with the DW-26, DW-373 and DW-62 suites still green.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 6, low 4)
- defer: 6: (high 0, medium 4, low 2)
- reject: 10: (high 0, medium 2, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `TreePanel`'s scroll-PERSIST effect kept its old deps, so a `narrow` or `collapsed` change during a Settings visit attached no listener and nothing re-ran on reveal — `hidden` added to that effect too, comment corrected.
  - `[medium]` `[patch]` `workbench-settings.test.ts`'s `{settingsOpen && (` pin became vacuous once `SettingsNav` rendered the same literal — retargeted at `{settingsOpen && (<SettingsCanvas`.
  - `[medium]` `[patch]` `isInModalDialog` had no node-level coverage and a docblock that overclaimed the selector — six cases added beside `isInputElement`'s, including a non-modal `role="dialog"` (the help overlay must NOT be suppressed), and the paragraph rewritten.
  - `[medium]` `[patch]` the left column's new non-Wiki `settingsOpen ? null` branch was pinned by an assertion that ran only in Wiki mode (deleting the guard left the suite green) — a Chat-mode row added.
  - `[medium]` `[patch]` the tree scroll restore across a Settings visit was pinned only by a dep-array regex — mounted cases added to `workbench-split-wiring.test.tsx`, mirroring the DW-47 precedent.
  - `[medium]` `[patch]` DW-414's real trigger path (a provider refresh moving `currentWikiId` while the canvas is withdrawn) was never driven in the shell — case added, and extended to observe the leaked capture, which is what actually fails without the fix.
  - `[low]` `[patch]` `useSurfaceVisibility`'s docblock still listed the Preview column among the provider-less dialogs.
  - `[low]` `[patch]` the focus effect's docblock claimed closing Settings never moves focus, which is false when the revealed surface re-arms an open dialog.
  - `[low]` `[patch]` the withdrawn-`fallbackFocusRef` branch was pinned only by a source scan — `WithdrawnHost` extended to cover it.
  - `[low]` `[patch]` the tree-disclosure work was labelled DW-412 throughout, though that ledger entry is about the Preview's markdown draft — re-phrased as its sibling in the same bundle.

## Design Notes

The ledger's DW-414 mechanism does not fire as written: while the surface is withdrawn `armed` is already `false`, so a close in that window re-runs no effect and the restore branch is never reached. What actually leaks is the capture — `openerRecordedRef` stays `true`, so the next open skips recording ITS opener and the next close aims at the previous one. The fix therefore has two halves: release the capture on a close that happens off screen (moving focus nowhere, because the owner is standing on the live surface), and refuse any restore whose target is inside a `[hidden]` subtree so a surface that forgets its visibility provider cannot focus into withdrawn content.

```tsx
const previewDocked = shouldDockPreview(mode, selection);
// ON SCREEN, which is what the layout reads. Mounting is the line above:
// Settings withdraws this column, it does not take the draft down with it.
const previewOpen = previewDocked && !settingsOpen;
```

jsdom has no layout engine, so `hidden` is only an attribute there and `.focus()` still lands on withdrawn nodes. That cuts both ways: the focus-on-open assertion can only pin the explicit `.focus()` call, and the withdrawn-restore case is observable precisely because jsdom would otherwise move focus into the hidden subtree.

## Verification

**Commands:**
- `npx vitest run src/components/workbench/__tests__/settings-canvas-persistence.test.tsx src/hooks/__tests__/useDialogA11y.test.tsx` -- expected: all cases pass
- `npx vitest run src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx src/components/workbench/__tests__/settings-shortcut.test.tsx src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/workbench-split.test.ts` -- expected: green, no regression
- `npx vitest run` -- expected: full suite green
- `npx eslint` -- expected: exit 0

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** A Settings visit no longer costs the owner state or the keyboard. `PreviewColumn` and `TreePanel` now mount on their own conditions and are withdrawn behind `hidden` while Settings shows — DW-373's mechanism applied to the two columns beside the canvas — so an unsaved markdown draft and the tree's collapsed groups both survive the round trip. Opening Settings moves focus to the Settings section (`#wb-canvas`, which `ModeCanvas` gives up while hidden), from the rail control and from `g s` alike. A global `g <key>` no longer dispatches from inside a modal dialog. And `useDialogA11y` neither restores focus into a withdrawn subtree nor keeps a stale opener capture when a dialog closes off screen — the latter being what DW-414's mechanism actually is: while the surface is hidden `armed` is already `false`, so the teardown never runs and the capture leaks instead of the restore misfiring.

**Files changed**
- `src/components/workbench/Workbench.tsx` — `previewDocked` (mount) split from `previewOpen` (on screen); `PreviewColumn` and `TreePanel` rendered mounted-and-hidden while Settings shows; new effect landing focus on `#wb-canvas` when `settingsOpen` goes true; the `openSettings`, `PREVIEW_ID` and `selectRow` paragraphs corrected.
- `src/components/workbench/PreviewColumn.tsx` — optional `hidden` on the `<aside>`, plus `SurfaceVisibilityProvider visible={!hidden}` so its two confirms stand their document work down.
- `src/components/workbench/TreePanel.tsx` — optional `hidden` on `.wb-tree-panel`; both scroll effects keyed on it.
- `src/hooks/useDialogA11y.ts` — a `withdrawn()` guard on both restore targets, and an `[open]`-keyed effect that releases the opener capture when a dialog closes off screen.
- `src/hooks/useKeyboardShortcuts.ts` — exported `isInModalDialog` and a pre-dispatch guard; the help overlay is deliberately outside its selector.
- `src/hooks/useSurfaceVisibility.ts` — docblock corrected: the Preview column publishes a provider now.
- `src/app/globals.css` — `.wb-preview[hidden]` and `.wb-tree-panel[hidden]` `display: none` rules beside the existing pair, outside every media query (both blocks already declare `display`, so the UA default alone would not withdraw either).
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` — the DW-373 `describe.each` extended over both openers with the Preview draft, the Preview confirm's stand-down, the tree disclosures, the left column (Wiki and Chat), focus on open and focus on close; plus the modal-shortcut case, the DW-414 shell path, and a CSS read-back for the two new rules.
- `src/hooks/__tests__/useDialogA11y.test.tsx` — a `WithdrawnHost` covering the refused restore, the refused fallback and the released capture.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — mounted cases for the tree scroll offset across a Settings visit.
- `src/lib/__tests__/keyboard-shortcuts.test.ts` — node-level cases for `isInModalDialog`.
- `src/lib/__tests__/create-wiki-ui.test.ts`, `workbench-left-column.test.ts`, `workbench-settings.test.ts`, `workbench-split.test.ts` — source scans retargeted where this change replaced the spelling they pinned.

**Review findings breakdown.** 10 patches applied (6 medium, 4 low — see the Review Triage Log), 6 deferred (4 medium, 2 low — see frontmatter `deferred`), 10 rejected as noise (a document-wide instead of target-scoped shortcut guard, which the intent's own wording rules out; the `[hidden]` specificity floor, already open as DW-415; the ledger update the orchestrator owns; the announcement-plus-section-label overlap; naming and Prettier-fragility preferences; and pre-existing discards a Wiki switch has always made).

**Follow-up review recommendation:** `true`. Patched findings only: high 0, medium 6, low 4 → `3 × 6 + 1 × 4 = 22`, which is ≥ 5.

**Verification.**
- `npx vitest run` (what `pnpm test` invokes) — 273 files, 6141/6141 pass; 6114 at the baseline commit. `pnpm test` / `pnpm lint` themselves still error with "packages field missing or empty" in this working copy, unrelated to this change, so the acceptance criterion's checks were run through the underlying binaries.
- `npx eslint` — exit 0. `npx tsc --noEmit` — clean.
- Matrix audit: all six I/O rows are covered by cases that ran and passed — the Preview draft round trip (by node identity), the tree disclosure round trip, the left column in Wiki and Chat modes, focus on open through both openers, the suppressed `g s` inside a modal, and the off-screen close in both the hook suite and the real shell path.
- Every new or retargeted assertion was mutation-checked against the code it pins, including the four the review pass added because the first version of the test could not fail.

**Residual risks.**
- jsdom has no layout engine, so `hidden` is only an attribute there: the focus-on-open assertion can pin the explicit `.focus()` call and nothing about the blur a real engine performs, and the `display: none` half of every withdrawal is pinned by reading `globals.css` as text. The repo has no browser-level harness.
- Keeping two more surfaces mounted widens the window in which effects run off screen; the Preview's fetch and announcement lifecycle in that window is deferred above rather than answered here.
- `npx vitest run` failed once, before these changes were complete, in `src/components/__tests__/workspace-purpose-settings.test.tsx` ("abandons a recheck that was already in flight when the owner saved"). That file is untouched by this change and the case passed on every subsequent run, in isolation and in the full suite — a pre-existing timing-sensitive test, recorded here rather than left unmentioned.
