---
title: 'Settings keeps the mode canvas mounted (DW-373)'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Opening Settings with `g s` while a modal dialog inside the mode canvas holds focus
      drops the keyboard on `<body>`, because the section it is in goes `display: none`.
    evidence: |-
      `openSettings` sets `settingsOpen` and nothing moves focus. With the Create Wiki
      dialog focused (`useDialogA11y` focuses the container on open), hiding the section
      blurs the focused node in a real browser; jsdom leaves `activeElement` on the hidden
      node, so no mounted case can observe the outcome either way. Not a regression —
      the old code unmounted the section, which lost focus the same way — but DW-373 makes
      the state survivable, so where focus should land (the Settings canvas already carries
      `tabIndex={-1}`) is now a decidable question rather than a moot one. The rail path is
      unaffected: the owner's click puts focus on the control before the hide.
    location: >-
      src/components/workbench/Workbench.tsx (openSettings)
    severity: medium
  - summary: >-
      Global `g <key>` shortcuts fire while a modal dialog holds focus, so the keyboard can
      leave a dialog the owner is mid-way through without closing it.
    evidence: |-
      `isEditableTarget` in src/hooks/useKeyboardShortcuts.ts guards only INPUT / TEXTAREA /
      SELECT / contenteditable, so a keydown on the dialog container or any of its buttons
      reaches the dispatcher. Pre-existing and unrelated to DW-373, but more visible now that
      the dialog survives the resulting surface change instead of being torn down: the owner
      presses `g s`, Settings appears, and an open modal is still mounted behind it.
    location: >-
      src/hooks/useKeyboardShortcuts.ts:19-26 (isEditableTarget)
    severity: medium
baseline_revision: '410c0a1726e1e1c4c079ef48bbe65a761fd4d594'
---

<intent-contract>

## Intent

**Problem:** `Workbench.tsx` renders `settingsOpen ? <SettingsCanvas/> : <ModeCanvas>{children}</ModeCanvas>`, so opening Settings — by the rail control or by `g s` — unmounts the whole mode canvas and with it the Wiki subtree (`WikiWorkbench`), destroying an open Create Wiki dialog, the name typed into it and the error it was showing. DW-26 buys that subtree survival for MODE SWITCHES only; the code's own comment at `Workbench.tsx:631-636` records the gap.

**Approach:** Render `ModeCanvas` in every state and put it behind `hidden` while Settings is open — the same withdrawal DW-26 already uses one level down for `.wb-canvas-mode`. `SettingsCanvas` is rendered ALONGSIDE it (not instead of it) and still unmounts when Settings closes, so it keeps owning discard-on-leave for its own draft. Pin the survival with a mounted jsdom test.

## Boundaries & Constraints

**Always:**
- Exactly ONE element carries `id={CANVAS_ID}` and `tabIndex={-1}` at any moment — the canvas that is SHOWING. The hidden `ModeCanvas` section must carry neither.
- Exactly one `<h2>` id is live: `ModeCanvas` and `SettingsCanvas` must not both render `<h2 id={headingId}>` with the same id.
- The hidden section's withdrawal is backed by an author rule in `globals.css` with the attribute in the selector, outside every media query — the UA `display: none` loses to any author `display` rule, exactly as the `.wb-canvas-mode[hidden]` comment already argues.
- `SurfaceVisibilityProvider` must publish `false` while the section is hidden, so `useDialogA11y` releases the body scroll lock and the capture-phase Tab trap that `hidden` does not remove.
- `SettingsCanvas` stays UNMOUNTED whenever `settingsOpen` is false — that unmount is the whole of "unsaved edits are discarded on leave".
- Hiding must not move focus (DW-26's rule); the owner put focus on the rail control themselves.

**Block If:**
- Preserving the mode canvas would require `SettingsCanvas` to hold its draft across a close (it must not).

**Never:**
- Do not touch `previewOpen = shouldDockPreview(mode, selection) && !settingsOpen`. The docked Preview undocking under Settings is deliberate (a tree row the owner cannot point at) and out of scope here.
- Do not persist `settingsOpen` or the settings category; do not add a router push or `next/link` to the shell.
- Do not spell hiding as closing the Create Wiki dialog — `CreateWikiDialog` resets its fields on close.
- Do not change `/settings` route behaviour or the `open-settings` shortcut claim.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open Settings over a live draft | Create Wiki dialog open with a typed name and a shown error; owner clicks the rail Settings control | Settings shows; the dialog node is still in the DOM holding the name and error, inside a `hidden` `.wb-canvas` section | No error expected |
| Return from Settings | Same state, then the rail Settings control is clicked again | The dialog is on screen again with the SAME name and error — not a rebuilt empty card | No error expected |
| `g s` opens Settings | Wiki mode, dialog open with a draft | Identical to the rail path: the subtree survives, `router.push` is not called | No error expected |
| A11y while hidden | Settings open over an open dialog | Dialog/field/heading unreachable by role; `document.body.style.overflow` is `""`; Tab is not trapped | No error expected |
| Skip-link target | Settings open, any mode | Exactly one `#wb-canvas` and one `[tabindex="-1"]` canvas in the document, and it is the Settings one | No error expected |
| Settings draft on leave | Edit a Settings field, then close Settings and reopen | The edit is gone — `SettingsCanvas` was unmounted | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/Workbench.tsx:1086-1094` -- the canvas swap to replace. `headingId` at `:226` (one `useId`, shared by both canvases today — the duplicate-id source once both mount). `settingsOpen` at `:174`. `previewOpen` at `:295` (leave alone). Stale comment at `:631-636` inside `openSettings` says the mode canvas is NOT saved — must be rewritten.
- `src/components/workbench/ModeCanvas.tsx` -- `CANVAS_ID` export at `:59`; the single `<section className="wb-canvas" id={CANVAS_ID} tabIndex={-1}>` at `:65-72`; `SurfaceVisibilityProvider visible={wikiActive}` at `:78`; inner `<div className="wb-canvas-mode" hidden={!wikiActive}>` at `:79`. This is the reuse point: add a `hidden` prop and mirror the existing withdrawal one level up.
- `src/components/workbench/SettingsCanvas.tsx:811-841` -- the `Frame` component carrying `id={CANVAS_ID}`, `tabIndex={-1}` and `<h2 id={headingId}>`. Doc at `:80-82` and `:814-816` both assert "the shell renders one canvas or the other, never both" — now false.
- `src/hooks/useSurfaceVisibility.ts` -- `SurfaceVisibilityProvider` / `useSurfaceVisible`; consumed by `src/hooks/useDialogA11y.ts` to stand the scroll lock and Tab trap down. No change needed, only a correct `visible` value.
- `src/app/globals.css:2665-2692` -- `.wb-canvas { grid-column: 3; … }` (no `display` of its own) and the `.wb-canvas-mode[hidden] { display: none; }` rule with the comment that explains why the rule is stated rather than left to the UA sheet. Add the sibling rule beside it.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- the DW-26 mounted suite. COPY ITS SHAPE for the new suite: `renderShell` helper, `nameFieldNode()` (raw DOM query, because role queries respect `hidden`), `openCreateWith`, `clickRail`, the scroll-lock/Tab-trap case, and the `readFile` assertion that reads the CSS rule from the real stylesheet.
- `src/lib/__tests__/workbench-settings.test.ts:4680-4689` -- source scan `"takes the canvas id from ModeCanvas rather than restating it"`. `expect(shell).toContain("{settingsOpen ? (")` currently claims to pin one-canvas-at-a-time but would silently keep passing on the left-column ternary at `Workbench.tsx:1029`. Must be re-pointed at the new invariant.
- `src/lib/__tests__/workbench-chrome.test.ts:522-531` -- asserts `ModeCanvas.tsx` contains EXACTLY ONE `id={CANVAS_ID}` and one `tabIndex={-1}` literal, and (`:202`) `<h2 id={headingId}`. A conditional expression keeps both counts at one; do not duplicate the literals.
- `src/lib/__tests__/workbench-split.test.ts:1114-1115` and `src/lib/__tests__/workbench-left-column.test.ts:89` -- source-order scans: `id="tree"` < `<ModeCanvas` < `id="preview"` and `<ModeCanvas` < `<PreviewColumn`. Any new JSX must keep `<ModeCanvas` in that window.
- `src/hooks/useKeyboardShortcuts.ts:73-76` and `src/components/workbench/__tests__/settings-shortcut.test.tsx:29-34` -- prose stating the shortcut does not preserve the mode canvas. Both become false.
- Read-only: `src/components/SiteChrome.tsx:39` (`#wb-canvas` skip target), `src/components/WikiWorkbench.tsx`, `src/hooks/useDialogA11y.ts`.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/ModeCanvas.tsx` -- add a `hidden: boolean` prop to `ModeCanvasProps`; put it on the `<section>`, make `id`/`tabIndex` conditional (`hidden ? undefined : CANVAS_ID` / `hidden ? undefined : -1`, each literal still appearing exactly once), and pass `visible={wikiActive && !hidden}` to `SurfaceVisibilityProvider`; extend the file doc to record that Settings now hides this section rather than replacing it -- the withdrawal has to happen where the subtree lives, and the a11y/id contracts move with it.
- `src/components/workbench/Workbench.tsx` -- add a second `useId()` for the Settings heading; render `{settingsOpen && <SettingsCanvas category={settingsCategoryId} headingId={settingsHeadingId} />}` immediately before an unconditional `<ModeCanvas … hidden={settingsOpen}>{children}</ModeCanvas>`, keeping `<ModeCanvas` between the `tree` and `preview` split handles; rewrite the `openSettings` comment at `:631-636` and the canvas comment at `:1086-1088` -- the showing canvas must be the first `.wb-canvas` in the document, and two heading ids are what let both canvases mount without a duplicate id.
- `src/app/globals.css` -- add `.wb-canvas[hidden] { display: none; }` beside `.wb-canvas-mode[hidden]`, outside every media query, with a comment naming DW-373 -- `.wb-canvas` sets no `display` of its own, so the UA hint is one author rule away from being defeated.
- `src/components/workbench/SettingsCanvas.tsx` -- correct the two doc comments (`:80-82`, `:814-816`) so they say the surface is rendered BESIDE a hidden mode canvas and takes the canvas id and `tabIndex` from it, while its own unmount on close still owns discard-on-leave -- prose asserting "never both" would be the next reader's licence to undo this.
- `src/hooks/useKeyboardShortcuts.ts` -- rewrite the `:73-76` paragraph so `g s` no longer claims to destroy the mode canvas.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- NEW mounted suite covering every I/O Matrix row above, modelled on `wiki-canvas-persistence.test.tsx` -- the defect is what React does to a subtree that stops being rendered, so only a live document can observe it.
- `src/lib/__tests__/workbench-settings.test.ts` -- replace the `toContain("{settingsOpen ? (")` assertion in `"takes the canvas id from ModeCanvas rather than restating it"` with one that pins the new shape (`SettingsCanvas` rendered conditionally, `ModeCanvas` unconditionally with `hidden={settingsOpen}`), and update the surrounding comment -- an assertion that passes on an unrelated ternary is not pinning anything.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` -- update the `:29-34` doc paragraph to point at the new suite.

**Acceptance Criteria:**
- Given the Create Wiki dialog is open with a typed name and a shown error, when Settings is opened and then closed by the rail control, then the same dialog is on screen with the same name and the same error.
- Given Settings is open over that dialog, when the document is queried by role, then the dialog, its name field and the Wiki heading are all unreachable, while the field node is still in the DOM holding its value.
- Given Settings is open in any mode, when the document is queried for `#wb-canvas`, then exactly one node matches and it is the Settings canvas.
- Given a Settings field has been edited, when Settings is closed and reopened, then the edit is gone.
- Given `pnpm test` and `pnpm lint` are run, when they complete, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 4, low 3)
- defer: 2: (high 0, medium 2, low 0)
- reject: 11
- addressed_findings:
  - `[medium]` `[patch]` `.wb-canvas[hidden]` is specificity (0,2,0) and any later `.wb-shell[...] .wb-canvas { display: … }` rule beats it, stacking the hidden canvas over Settings — while the case named "the layout cannot defeat" still passed, because it only text-matched the rule. The case now extracts every `.wb-canvas` rule from the real `globals.css`, injects them into the test document, and asserts `getComputedStyle(hiddenSection).display === "none"` with the showing canvas as positive control; proved by temporarily adding the competing rule and watching it fail.
  - `[medium]` `[patch]` The "SettingsCanvas FIRST" ordering invariant was stated in a comment and pinned by nothing — a reviewer swapped the JSX blocks and 687 tests still passed. Pinned twice: a source-order assertion in `workbench-settings.test.ts` and a runtime assertion that `document.querySelector(".wb-canvas")` is the showing canvas.
  - `[medium]` `[patch]` No case covered a mode switch out of Settings, which `applyMode` performs in ONE commit (unmount `SettingsCanvas`, un-hide `ModeCanvas`, move `CANVAS_ID`/`tabIndex`, flip the mode branch). Added a case driving that transition with a live Create Wiki draft and back.
  - `[medium]` `[patch]` New prose in `useKeyboardShortcuts.ts` and the suite header overclaimed, reading as though nothing behind Settings is lost. Corrected to say the mode canvas and its subtree are what survive, and to name what does not: the docked Preview (unmounted, its unsaved markdown discarded — a separate deferral) and the left column handing its space to `SettingsNav`.
  - `[low]` `[patch]` Two new comments (`globals.css`, the new suite) still said Settings "replaces the canvas", the behaviour DW-373 removes. Both now say the canvas is hidden at all three widths whenever Settings is showing.
  - `[low]` `[patch]` New source scans pinned formatting rather than invariants — a one-line `<SettingsCanvas …/>` literal and a whitespace/prop-order regex on `<ModeCanvas>`. Replaced with an `opening(tag)` slice helper so each load-bearing prop is asserted independently of order and wrapping.
  - `[low]` `[patch]` `.wb-canvas` is the `overflow: auto` scroll container that `display: none` collapses, so a scrolled canvas returns from Settings at the top. Not a regression and out of scope, but the suite read as claiming a pixel-identical return; named in the coverage-limit paragraph.

## Design Notes

Two canvases mount at `grid-column: 3`; only one is displayed, so the grid is unchanged. `SettingsCanvas` is rendered FIRST so that `document.querySelector(".wb-canvas")` — an idiom several existing suites already use — always resolves to the canvas that is showing.

```tsx
{settingsOpen && (
  <SettingsCanvas category={settingsCategoryId} headingId={settingsHeadingId} />
)}
<ModeCanvas mode={mode} sidecar={sidecar} headingId={headingId} hidden={settingsOpen}>
  {children}
</ModeCanvas>
```

Why a second `useId`: `ModeCanvas`'s stub branch renders `<h2 id={headingId}>` for every non-Wiki mode, and `SettingsCanvas`'s `Frame` renders one too. Sharing one id was safe only while the two could never mount together.

Why `SurfaceVisibilityProvider` matters here and not just for pixels: `hidden` withdraws the pixels, the a11y tree entry and the tab-order entry, and nothing a dialog did to the DOCUMENT. Without `visible={false}`, opening Settings over an open Create Wiki dialog would leave `document.body.style.overflow = "hidden"` and a capture-phase Tab trap armed over a canvas nobody can see.

## Verification

**Commands:**
- `pnpm test` -- expected: both vitest projects green, including the new `settings-canvas-persistence.test.tsx` and the amended source scans
- `pnpm lint` -- expected: no new errors
- `npx tsc --noEmit` -- expected: no type errors from the new `hidden` prop

## Auto Run Result

Status: done

**Change:** Opening the in-shell Settings surface no longer unmounts the mode canvas. `Workbench` renders `SettingsCanvas` (still conditional) BESIDE an unconditional `ModeCanvas`, and passes `hidden={settingsOpen}` — the same `hidden` withdrawal DW-26 already uses one level down at `.wb-canvas-mode`, moved up to the `<section>` that holds the Wiki subtree. An open Create Wiki dialog, the name typed into it and the error it was showing now survive a trip through Settings, by the rail control and by `g s` alike. `SettingsCanvas` still unmounts on close, so it keeps owning discard-on-leave for its own draft — the question DW-373's ledger entry left open.

**Files changed:**
- `src/components/workbench/ModeCanvas.tsx` — required `hidden` prop; `hidden` on the `<section>`; `id`/`tabIndex` conditional so only the SHOWING canvas carries `CANVAS_ID` and the landing place; `SurfaceVisibilityProvider visible={wikiActive && !hidden}`.
- `src/components/workbench/Workbench.tsx` — the canvas swap becomes two mounted siblings; a second `useId` for the Settings heading; the stale `openSettings` and canvas comments rewritten.
- `src/app/globals.css` — `.wb-canvas[hidden] { display: none; }` beside the DW-26 rule, outside every media query.
- `src/components/workbench/SettingsCanvas.tsx` — doc comments corrected; the surface now sits beside the hidden canvas rather than replacing it.
- `src/hooks/useKeyboardShortcuts.ts` — `g s` prose corrected, including what is NOT preserved (the Preview undock, the left-column swap).
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` — NEW, 11 mounted cases covering every I/O Matrix row plus the single-commit mode switch out of Settings and a real-cascade `getComputedStyle` check.
- `src/lib/__tests__/workbench-chrome.test.ts` — the `CANVAS_ID`/`tabIndex` count scans widened to admit the conditional, with exact-expression assertions added alongside.
- `src/lib/__tests__/workbench-settings.test.ts` — the vacuous `toContain("{settingsOpen ? (")` (which passed on the unrelated left-column ternary) replaced with order- and wrap-tolerant pins on the real shape, plus a source-order assertion for the canvas ordering.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` — doc paragraph re-pointed at the new suite.

**Review findings:** 7 patches applied (4 medium, 3 low), 2 items deferred (both medium), 11 rejected, 0 intent gaps, 0 spec defects.

**Follow-up review recommended:** true. Patched this pass: high 0, medium 4, low 3 — score `3 × 4 + 1 × 3 = 15`, which is ≥ 5.

**Verification:**
- `npx vitest run` — 271 files / 6066 tests passed, exit 0 (`pnpm test` itself fails in this environment with a pnpm workspace-resolution error on the clean tree too; this is the identical invocation the script wraps).
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0, no errors; output matches the pre-change baseline (three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- Negative control: reverting only the `Workbench.tsx` JSX to the old ternary failed 7 of the then-9 new cases. Each of the two new guards (the cascade check and the canvas ordering) was proved by temporarily introducing the exact defect it exists to catch.

**Residual risks:**
- The mode canvas's effects now keep running while Settings is showing. Already true across mode switches since DW-26, so this is consistency rather than a new class, but it is a real widening.
- `.wb-canvas` is the `overflow: auto` scroll container that `display: none` collapses, so a scrolled canvas returns from Settings at the top. React state survives; a DOM scroll offset is not React state. Not a regression — the old code unmounted the section — and named in the suite's coverage-limit paragraph.
- One full-suite run during this session reported a single failure in `src/components/__tests__/workspace-purpose-settings.test.tsx:926` (a `waitFor` timeout). It was observed BEFORE any test in this change existed, passes in isolation, and did not reproduce across six subsequent full runs — a pre-existing load-dependent flake in an untouched file, not caused here.
