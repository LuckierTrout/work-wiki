---
title: 'Opening Settings hides the mode canvas instead of unmounting it (DW-373)'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Opening Settings still unmounts the Preview column, silently discarding its
      unsaved markdown draft — the same loss DW-373 fixed one column over.
    evidence: |-
      `Workbench.tsx:295` computes `previewOpen = shouldDockPreview(mode, selection) && !settingsOpen`,
      so `PreviewColumn` (which owns `draft`/`draftSeed`) leaves the tree whenever the Settings
      surface opens. `selectRow`'s own comment at `Workbench.tsx:719` already records it:
      "A mode switch, a Wiki switch, a tab switch and Settings all still discard silently."
      Pre-existing: the `&& !settingsOpen` undock predates DW-373 and the intent named the mode
      canvas only.
    location: >-
      src/components/workbench/Workbench.tsx:295
    severity: medium
  - summary: >-
      Opening Settings moves focus nowhere, so in a real browser a keyboard user
      inside the canvas is dropped on <body> when it goes `display: none`.
    evidence: |-
      `g s` fires from the document and the rail control focuses itself; neither focuses the
      Settings section, which carries `tabIndex={-1}` precisely to be a landing place. A real
      engine blurs focus out of a subtree that becomes `display: none`; jsdom does not, which is
      why `settings-canvas-persistence.test.tsx`'s "does not move focus when it hides the canvas"
      can assert the keystroke leaves focus put. Not a DW-373 regression — the previous unmount
      dropped focus the same way — but the mounted canvas makes it observable and testable.
    location: >-
      src/components/workbench/Workbench.tsx (openSettings / toggleSettings)
    severity: medium
  - summary: >-
      `useDialogA11y`'s close path can restore focus into a hidden canvas while
      Settings is showing.
    evidence: |-
      Its teardown early-returns only when the dialog is still open AND hidden
      (`if (openRef.current && !visibleRef.current) return;`). `WikiWorkbench.tsx:131` resets
      `createOpen` to false whenever `currentWikiId`/`currentId` moves, which a
      `DataVersionWatcher`-driven `router.refresh()` can do while the canvas is withdrawn — the
      close branch then focuses `openerRef.current`, a connected but `display: none` node, which
      is a silent no-op that leaves the keyboard on `<body>` mid-Settings. Pre-existing hook
      behaviour; keeping the canvas permanently mounted widens the window.
    location: >-
      src/hooks/useDialogA11y.ts (teardown / close branch)
    severity: medium
  - summary: >-
      The `[hidden]` withdrawal rules have no specificity floor, so a later
      shell-scoped `display` rule beats them.
    evidence: |-
      `.wb-canvas[hidden]` and `.wb-canvas-mode[hidden]` are both (0,2,0). `globals.css` already
      writes (0,3,0) shell-scoped rules that set `display` (e.g.
      `.wb-shell[data-collapsed="true"] .wb-left { display: none }`), so a future
      `.wb-shell[data-preview="true"] .wb-canvas { display: flex }` would put the withdrawn canvas
      back on screen underneath Settings — while both rules' comments claim the attribute "cannot
      be undone by accident". Nothing asserts that no later rule sets `display` on either
      selector. Pre-existing pattern inherited from DW-26; a fix belongs to both rules together.
    location: >-
      src/app/globals.css:2690-2710
    severity: low
  - summary: >-
      The mode canvas's scroll offset is not preserved across a Settings visit.
    evidence: |-
      `.wb-canvas` is the scroll container (`overflow: auto`, `globals.css:2665`) and
      `display: none` discards the scroll box, so returning from Settings drops the owner at the
      top of a long canvas. DW-373's premise is that the visit costs nothing; this is the one
      thing it still costs, and the `hidden` mechanism the intent itself names cannot reach it.
      Not a regression — the previous unmount lost it too.
    location: >-
      src/components/workbench/ModeCanvas.tsx (the hidden `.wb-canvas` section)
    severity: low
baseline_revision: '410c0a1726e1e1c4c079ef48bbe65a761fd4d594'
---

<intent-contract>

## Intent

**Problem:** `Workbench.tsx:1089-1094` renders `settingsOpen ? <SettingsCanvas/> : <ModeCanvas>{children}</ModeCanvas>`, so opening Settings — from the rail control or from `g s` — unmounts the whole mode canvas and with it the Wiki subtree (`WikiWorkbench`), destroying an open Create Wiki dialog, the name typed into it and the error it was showing. That is the very loss DW-26 removed for mode switches; Settings reintroduces it.

**Approach:** Keep `ModeCanvas` MOUNTED while Settings is open and withdraw it behind `hidden` — the same mechanism DW-26 already uses for the Wiki subtree across modes — while `SettingsCanvas` continues to mount on open and unmount on close, so its draft still dies by unmount. Pin the new behaviour with a mounted test.

## Boundaries & Constraints

**Always:**
- Exactly one element answers to `#wb-canvas` (`CANVAS_ID`) and one `tabIndex={-1}` canvas landing place at any time — the skip link has one target. While Settings is open that element is `SettingsCanvas`'s section; the hidden mode canvas must carry neither the id nor the tab index.
- Exactly one node carries `headingId` at a time. `SettingsCanvas` renders `<h2 id={headingId}>`, and so does `ModeCanvas`'s stub branch, so the stub branch must not render while the mode canvas is hidden (it holds no state to lose — the same reason it is already conditional under Wiki).
- The Wiki subtree behind `hidden` must publish `visible={false}` through `SurfaceVisibilityProvider`, so `useDialogA11y` stands down the body scroll lock and the capture-phase Tab trap exactly as it does for a mode switch.
- Hiding must never be spelled as closing: `CreateWikiDialog` resets its fields when `open` goes false, which would discard the draft this preserves.
- `hidden` is only a presentation hint, so back the withdrawal with an author rule `.wb-canvas[hidden] { display: none; }` in `globals.css`, outside every media query, with the attribute in the selector — the same guard `.wb-canvas-mode[hidden]` already carries and for the same stated reason.
- Hiding must not move focus, and `SettingsCanvas` must keep owning discard-on-leave for its own draft by continuing to unmount when `settingsOpen` goes false.
- Comments that currently record the unmount as a live consequence (`Workbench.tsx:631-636`, the `ONE canvas at a time` comment at :1086-1088, `SettingsCanvas.tsx:80-83` and :814-816, `settings-shortcut.test.tsx:29-34`) must be corrected — a stale comment asserting the opposite of the code is worse than none.

**Block If:**
- Preserving the mode canvas cannot be done without either two live `#wb-canvas` ids or two live `headingId` nodes.

**Never:**
- Do not keep `SettingsCanvas` mounted across close (its unmount IS the draft discard).
- Do not add durable storage, a diff or a prompt for the Settings draft.
- Do not change what the rail control or `g s` announce, or the toggle/open asymmetry between them (DW-62).
- Do not touch the `/settings` route (DW-61) or any other surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Settings over an open dialog | Wiki mode, Create Wiki open with a typed name and a shown error; owner opens Settings | Wiki subtree stays in the DOM holding the name and error; it is out of the a11y tree; Settings surface is showing | No error expected |
| Return from Settings | Settings open over the hidden Wiki subtree; owner closes Settings | Same dialog, same typed name, same error — not a rebuilt empty card | No error expected |
| Document state while hidden | Create Wiki open (scroll lock + Tab trap armed), owner opens Settings | `document.body.style.overflow` is `""` and Tab is not trapped; closing Settings re-arms both | No error expected |
| Skip-link target while Settings is open | Settings open | Exactly one `#wb-canvas` in the document, on the Settings section | No error expected |
| Non-Wiki mode under Settings | Chat mode, owner opens Settings | Stub branch not rendered; exactly one node carries `headingId` (the Settings heading); one reachable surface heading | No error expected |
| `g s` path | Same states, reached via `g s` instead of the rail control | Identical to the rail control in every respect above | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/Workbench.tsx:1086-1095` -- the swap to replace: render `ModeCanvas` unconditionally with a new `hidden={settingsOpen}` prop, and render `SettingsCanvas` only when `settingsOpen`. `headingId` (`:226`) is shared by both.
- `src/components/workbench/Workbench.tsx:628-641` -- `openSettings`'s "WHAT IT DOES NOT SAVE is the mode canvas" paragraph; now false, rewrite it to record what is preserved and how.
- `src/components/workbench/ModeCanvas.tsx` -- accepts the new `hidden` prop. Today: `wikiActive = mode === "wiki"` drives `SurfaceVisibilityProvider visible`, the `.wb-canvas-mode` `hidden` attribute, the stub branch and `aria-labelledby`. When the canvas itself is hidden, the section takes `hidden`, drops `id={CANVAS_ID}`/`tabIndex`/`aria-labelledby`, publishes `visible={false}`, and renders no stub branch.
- `src/components/workbench/SettingsCanvas.tsx:58,80-83,814-816,828-833` -- `Frame` carries `CANVAS_ID`/`tabIndex={-1}`/`aria-labelledby={headingId}`; unchanged in behaviour, but the two comments that say it "REPLACES `ModeCanvas`" / "the shell renders one canvas or the other, never both" need correcting to "the mode canvas is still mounted beside it, hidden and id-less".
- `src/app/globals.css:2664-2692` -- `.wb-canvas { grid-column: 3; … }` and the existing `.wb-canvas-mode[hidden] { display: none; }` rule with its rationale comment; add the sibling `.wb-canvas[hidden]` rule next to it, outside every media query (the `@media` block at `:2843` re-points `.wb-canvas` to `grid-column: 1`, which is why the withdrawal must not live in a media query).
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- the DW-26 mode-switch suite and the reuse model for the new one: `renderShell`, `rail`, `clickRail`, `openCreateWith`, `nameFieldNode` (DOM-not-a11y lookup), the `globals.css` read-back assertion and its media-query depth check.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx:29-34` -- doc comment stating the mode canvas is NOT preserved; must be corrected. Its `settingsShowing` helper (`:146`) shows how these suites detect the Settings surface.
- `src/hooks/useSurfaceVisibility.ts` -- `SurfaceVisibilityProvider` / `useSurfaceVisible`; no change needed, it is the seam `ModeCanvas` publishes through.
- `src/components/WikiWorkbench.tsx:265` -- owns `#wiki-workbench-heading`, which `ModeCanvas` borrows for `aria-labelledby` under Wiki; read-only here.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/ModeCanvas.tsx` -- add an optional `hidden` prop to `ModeCanvasProps`; when true put `hidden` on the `<section>`, omit `id`/`tabIndex`/`aria-labelledby`, pass `visible={false}` to `SurfaceVisibilityProvider` (so the Wiki wrapper is `hidden` too) and skip the stub branch -- keeps the subtree mounted while withdrawing it, without a duplicate `#wb-canvas` or a duplicate `headingId`.
- `src/components/workbench/Workbench.tsx` -- render `ModeCanvas` unconditionally with `hidden={settingsOpen}` and `SettingsCanvas` only when `settingsOpen`; rewrite the `ONE canvas at a time` comment and the `openSettings` paragraph at `:628-641` -- opening Settings must no longer unmount the Wiki subtree.
- `src/app/globals.css` -- add `.wb-canvas[hidden] { display: none; }` beside `.wb-canvas-mode[hidden]`, outside every media query, with a comment naming DW-373 and why the attribute is in the selector -- an author `display` rule on `.wb-canvas` would otherwise defeat the UA `hidden` default.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- new mounted suite covering every I/O Matrix row, driving both the rail control and `g s`, and reading the `.wb-canvas[hidden]` rule back out of `globals.css` (including the media-query depth check) -- jsdom sees no pixels, so the attribute and the stylesheet rule must be pinned separately.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` -- correct the `IT DOES NOT PRESERVE THE MODE CANVAS` paragraph to point at the new suite -- the comment now asserts the opposite of the behaviour.

**Acceptance Criteria:**
- Given the Wiki canvas with an open Create Wiki dialog holding a typed name and a shown error, when the owner opens Settings and then closes it, then the same dialog is showing with the same name and the same error, and no remount occurred.
- Given Settings is open over the Wiki canvas, when the a11y tree is queried, then the dialog, its `Wiki name` textbox and the Wiki heading are unreachable by role while the name field node is still in the document holding its value.
- Given a mode with no Wiki surface (Chat) and Settings open, when the document is queried, then no stub surface heading is rendered and exactly one node carries the shell's `headingId`.
- Given Settings is open in any mode, when the document is queried for `#wb-canvas`, then exactly one element matches and it is the Settings section.
- Given `pnpm test` and `pnpm lint`, when run, then both pass with the existing DW-26 and settings suites still green.

## Spec Change Log

## Design Notes

The shape mirrors DW-26 one level up: DW-26 hid the Wiki subtree INSIDE the canvas section; DW-373 hides the canvas SECTION itself. Two attributes end up nested when Settings is opened from a non-Wiki mode, which is correct — the wrapper is hidden because Wiki is not the active mode, the section because Settings is over it.

```tsx
{/* The mode canvas stays MOUNTED while Settings is open (DW-373) and goes
    behind `hidden`; `SettingsCanvas` takes CANVAS_ID because the hidden one
    gives it up. Settings still unmounts on close — that IS its draft discard. */}
<ModeCanvas mode={mode} sidecar={sidecar} headingId={headingId} hidden={settingsOpen}>
  {children}
</ModeCanvas>
{settingsOpen && <SettingsCanvas category={settingsCategoryId} headingId={headingId} />}
```

Order matters for the tab order the shell documents (rail → left column → canvas → Preview): the mode canvas renders first and is `display: none` while hidden, so Settings occupies `grid-column: 3` alone and reads in the same place.

## Verification

**Commands:**
- `pnpm test src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- expected: all new cases pass
- `pnpm test src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx src/components/workbench/__tests__/settings-shortcut.test.tsx src/components/workbench/__tests__/icon-rail.test.tsx` -- expected: green, no regression in DW-26 / DW-62 coverage
- `pnpm lint` -- expected: clean
- `pnpm test` -- expected: full suite green

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** `Workbench` no longer renders `SettingsCanvas` *instead of* `ModeCanvas`. The mode canvas is now rendered unconditionally with `hidden={settingsOpen}` and `SettingsCanvas` beside it under `{settingsOpen && …}`, so opening Settings — from the rail control or from `g s` — withdraws the mode canvas behind `hidden` rather than unmounting it. An open Create Wiki dialog, the name typed into it and the error it was showing all survive the visit, which is DW-26's mechanism applied to the canvas SECTION rather than to the subtree inside it. `SettingsCanvas` still mounts on open and unmounts on close, so its own draft's discard is unchanged.

**Files changed**
- `src/components/workbench/ModeCanvas.tsx` — new optional `hidden` prop; while set the `<section>` takes `hidden`, gives up `CANVAS_ID`, `tabIndex={-1}` and `aria-labelledby`, publishes `visible={false}` through `SurfaceVisibilityProvider`, and skips the stub branch so nothing else carries `headingId`.
- `src/components/workbench/Workbench.tsx` — the swap becomes a mount-plus-hide; the `openSettings` paragraph and the render comment rewritten (the old ones recorded the unmount as a live consequence).
- `src/components/workbench/SettingsCanvas.tsx` — comments corrected: it no longer "REPLACES" the mode canvas, it takes the ids the hidden one gives up.
- `src/hooks/useKeyboardShortcuts.ts` — the `g s` definition's "does NOT preserve the mode canvas" paragraph corrected.
- `src/app/globals.css` — `.wb-canvas[hidden] { display: none; }` beside `.wb-canvas-mode[hidden]`, outside every media query, with the attribute in the selector.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` (new) — 15 cases; a `describe.each` drives every I/O-matrix row through both the rail control and `g s`, plus a `globals.css` read-back with the media-query depth check.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` — doc comment corrected and pointed at the new suite.
- `src/lib/__tests__/workbench-chrome.test.ts` — the `id={CANVAS_ID}` / `tabIndex={-1}` source scan retargeted at the conditional spelling, plus two assertions that both are gated on `hidden`.
- `src/lib/__tests__/workbench-settings.test.ts` — the DW-373 canvas case retargeted at `hidden={settingsOpen}` / `{settingsOpen && (`; the old `{settingsOpen ? (` match had become vacuous.

**Review findings breakdown.** 7 patches applied (4 medium, 3 low — see the Review Triage Log), 5 items deferred (3 medium, 2 low — see frontmatter `deferred`), 12 rejected as noise (optional-prop typing, source-scan brittleness, comment volume, helper-sharing preferences, browser-level coverage that this repo has no harness for, and the ledger update the orchestrator owns).

**Follow-up review recommendation:** `true`. Patched findings only: high 0, medium 4, low 3 → `3 × 4 + 1 × 3 = 15`, which is ≥ 5.

**Verification.**
- `npx vitest run` (what `pnpm test` invokes) — 273 files, 6099/6099 pass. `pnpm test`/`pnpm exec` themselves error with "packages field missing or empty" in this working copy, which is unrelated to this change.
- `npx eslint` — exit 0.
- Targeted: `settings-canvas-persistence` 15/15; `wiki-canvas-persistence`, `settings-shortcut`, `icon-rail`, `workbench-chrome`, `workbench-settings`, `keyboard-shortcuts` all green.
- Mutation checks: reverting the render to the old ternary fails 9 of the 15 new cases and the retargeted `workbench-settings` case; `tabIndex={undefined}` fails the round-trip case in both opener paths.
- Matrix audit: all six I/O rows are covered by cases that ran and passed — dialog survival, the return trip, the document state (scroll lock and Tab trap), the single `#wb-canvas`, the non-Wiki `headingId`, and the `g s` path via `describe.each`.

**Residual risks.**
- jsdom sees no pixels, so the `display: none` half is pinned only by reading `globals.css`; the repo has no browser-level harness. The specificity hazard that follows from this is deferred.
- Another session's unrelated in-flight work (`config.ts`, `types.ts`, `useSettings.ts`, `ProviderForm.tsx`, `StatusBadge.tsx`, `api/status/route.ts`, their tests and `spec-dw-402-403-…md`) is dirty in the same working copy. Nothing here touched it and it is deliberately left uncommitted.
