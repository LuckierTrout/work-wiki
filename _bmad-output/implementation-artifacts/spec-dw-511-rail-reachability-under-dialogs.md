---
title: 'Drive the dialog-holding Settings rows through the path a real owner has'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: '5249148dfa27e9ed4e0da3065c860fd66b339560'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The DW-26 mode-switch block clicks rail controls with a Create Wiki dialog open, the
      same unreachable pointer path DW-511 removed from the Settings suite.
    evidence: |-
      `describe("an open Create Wiki dialog survives a mode switch (DW-26)")` opens the dialog
      with `openCreateWith(...)` and then drives a rail control while the backdrop is live:
      `fireEvent.click(rail("Chat"))` at ~l.178, ~l.198 and ~l.230, and `clickRail("Chat")` /
      `clickRail("Wiki")` at ~l.274 and ~l.279. `CreateWikiDialog`'s root is the same
      `fixed inset-0 z-[120] ... bg-black/40` overlay, and `.wb-rail` carries no `z-index`, so
      in a browser those clicks land on the backdrop — whose `onMouseDown` CANCELS the dialog,
      meaning the mode switch never happens and the draft the block exists to preserve is
      discarded. The cases pass only because jsdom does no hit-testing. PRE-EXISTING: this file
      was not touched by DW-511, which fixed the Settings suite only. The fix shape is the one
      DW-511 used — seed the reachable route before the dialog opens, then traverse — plus the
      executable backdrop pin the Settings suite now carries.
    location: >-
      src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx (the DW-26 block)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The rail-only block in `settings-canvas-persistence.test.tsx` opens Settings with `fireEvent.click(rail(SETTINGS_LABEL))` while an `aria-modal` dialog is on screen, and says in prose that the rail control is how an owner reaches that state (DW-511). It is not: `CreateWikiDialog.tsx:109` and `ConfirmDialog.tsx:67` render the dialog root as `fixed inset-0 z-[120] … bg-black/40`, a full-viewport overlay above `.wb-rail` (no `z-index` at desktop widths, `z-index: 40` in the narrow block), so a pointer click aimed at the rail lands on the backdrop; `useDialogA11y` traps Tab inside the dialog, so the control is unreachable by keyboard too. The click succeeds only because jsdom does no hit-testing — the exact pointer-surface twin of the `g s` path DW-426 already retired.

**Approach:** Do not lift the rail above the backdrop and do not close the dialog on rail activation — both contradict contracts this suite already pins (`aria-modal` inertness plus the Tab trap; and "hiding is not closing", which is the whole draft preservation). Instead drive those rows through the path DW-167 created and a real owner can take: leave a Settings history entry behind the current one *before* the dialog is opened, then reach Settings by **Back** — browser chrome, which no modal traps. Correct the block's prose to say so, and add one executable pin for why the rail is not the opener, so the correction cannot rot back into prose.

## Boundaries & Constraints

**Always:** Keep every existing assertion in the six modal-holding cases intact — this entry changes how the state is *reached*, not what is checked. Keep the rail control as the CLOSER (`closeSettings`) in those cases: by then the mode canvas is `hidden`, the dialog is withdrawn and its backdrop is gone, so the rail really is reachable. Every new or reworded comment must say why the traversal is the opener, not merely that it is.

**Block If:** The traversal opener cannot reproduce the state any existing assertion needs (e.g. the focus landing site does not move, or `popstate` never fires) after one honest attempt to fix the seeding.

**Never:** Do not change `.wb-rail`'s stacking in `globals.css`. Do not change `CreateWikiDialog.tsx`, `ConfirmDialog.tsx`, `useDialogA11y.ts` or `Workbench.tsx` — this entry is located in the test file and no product behaviour is wrong. Do not close or unmount a dialog to make the rail reachable. Do not add a new localStorage key, fixture, or shared helper module.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Seed then Back | Shell mounted; rail Settings pressed then pressed again (entries `…&settings=1` then `…`), Create Wiki dialog opened, `history.back()` | `popstate` applies `settings=true`, mode canvas goes `hidden` with the dialog withdrawn inside it, `#wb-canvas` takes focus | `traverse` rejects if no `popstate` within 1000ms |
| Rail closes it | Settings showing over the withdrawn canvas | `closeSettings()` (rail toggle) closes Settings, re-arms the dialog, pushes one entry | No error expected |
| Back out again | Settings reached by Back, `history.back()` a second time | Lands on the mount-seeded entry (`?mode=wiki`), Settings closes, the re-armed dialog keeps the keyboard | `traverse` rejects on no `popstate` |
| No modal held | The DW-416 scroll case, which opens no dialog | Both openers are legitimately available to it | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- the only file this entry changes. `openFromRail` (~l.311) is the unreachable opener; the block `"a dialog-holding canvas survives Settings, opened from the rail (DW-373)"` (~l.713–1010) holds seven cases. Six hold a modal at open time: "keeps the typed name…", "is HIDDEN rather than unmounted…", "holds neither the body scroll lock nor the Tab trap…", "stands the Preview's open confirm down…", "does not pull focus into the hidden canvas…", "leaves the keyboard in the re-armed dialog when BACK reveals its canvas". The seventh, "brings the canvas back at the offset it was scrolled to (DW-416)" (~l.730), opens NO dialog — the rail is genuinely reachable for it, and it belongs in the parameterised `describe.each(OPENERS)` block above (~l.469).
- Reusable in that same file: `traverse(go)` (~l.335) awaits the `popstate` with a 1000ms deadline; `closeSettings()` (~l.299); `clickRail`/`rail` (~l.211–221); `settingsShowing()` (~l.346); `modeCanvas()`, `previewColumn()`, `nameFieldNode()`, `alertNode()`, `openCreateWith`, `openCreateWithRefusedName`, `refreshShell`; `readFile` + `path` are already imported and `path.resolve(__dirname, "../../../app/globals.css")` is the established way this file reads the stylesheet (~l.1055).
- `src/components/workbench/Workbench.tsx` -- READ-ONLY. `toggleSettings` (~l.822) flips the flag and always calls `pushSurface(mode, !settingsOpen)`, so *each* rail press writes one entry; the `popstate` listener (~l.786) re-applies mode+settings and bumps `canvasFocusNonce` only when the settings flag moved (`movedSettings`), which is what sends the keyboard to `#wb-canvas`; the mount seed (~l.473) uses `replaceState`, so the first entry is `?mode=wiki` with no flag. History for a seeded case is therefore `[?mode=wiki] → [?mode=wiki&settings=1] → [?mode=wiki]`.
- `src/lib/workbench-url.ts` -- READ-ONLY. `surfaceHref` deletes the flag when Settings is closed and `readSettingsFromSearch` accepts only `settings=1`, so the two rail presses really do produce two distinct hrefs and two entries.
- `src/components/CreateWikiDialog.tsx:107-109` and `src/components/ConfirmDialog.tsx:65-67` -- READ-ONLY evidence: both roots are `className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"`.
- `src/app/globals.css:2546` (`.wb-rail`, no `z-index`) and `:3628-3634` (the narrow block, `position: fixed; z-index: 40`) -- READ-ONLY evidence that nothing lifts the rail above 120 at any width. `.wb-shell` (`:2338`) is `position: relative` with no `z-index`, so it opens no stacking context that could rescue the rail.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx:35` -- says the preservation is driven "through both controls" from this file; still true of the parameterised block, so leave it alone.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- replace `openFromRail` with two helpers: `seedSettingsEntry()` (press the rail's Settings control to open, then again to close — leaving one `settings=1` entry behind the current one, with the shell back in its pre-Settings state and no dialog yet open) and `openFromHistory()` (`await traverse(() => window.history.back())`, then assert `settingsShowing()` and that `router.push` was not called). Document on `seedSettingsEntry` why the seeding must happen BEFORE the dialog opens — that is the whole reason it is a second helper rather than one call. -- The rail is only unreachable while a backdrop is on screen; seeding first is the one ordering that keeps every press reachable.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- move the DW-416 scroll case into the parameterised `describe.each(OPENERS)` block, swapping its two `openFromRail()` calls for `opener.open()`. -- It holds no modal, so it is not a rail-only case at all; moving it is what makes the remaining block's docblock true and gains the `g s` row for free.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- in the six modal-holding cases, call `await seedSettingsEntry()` immediately after `renderShell(...)` and before the dialog is opened, and replace each `await openFromRail()` with `await openFromHistory()`. In "leaves the keyboard in the re-armed dialog when BACK reveals its canvas", the exit stays a Back: a second `traverse(() => window.history.back())` lands on the mount-seeded `?mode=wiki` entry and closes Settings. -- Same state, same assertions, reached by a path a browser owner can actually take.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- rewrite the block's `describe` name and docblock (and the `OPENERS` docblock's cross-reference to it) so they name the traversal as the opener and state both halves of the refusal: the pointer half (the `z-[120]` backdrop covers the rail, which has no `z-index` of its own) and the keyboard half (`isInModalDialog` plus the Tab trap, DW-426). Say that the rail remains the CLOSER and why that press is reachable. -- The stale claim is the defect this entry is filed against; leaving it would resolve nothing.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- add one `it` that pins the refusal executably, the pointer twin of the existing "a global shortcut does not fire from inside a modal (DW-413)" block: with a Create Wiki dialog open, the dialog's overlay parent carries `fixed`, `inset-0` and `z-[120]` and does not contain `.wb-rail`; and `globals.css` gives `.wb-rail` no `z-index` in its base rule and `z-index: 40` in the narrow block, both below 120. -- Prose alone does not stop a restyle from silently making the rail an opener again, or from dropping the backdrop that makes it not one.

**Acceptance Criteria:**
- Given the modal-holding block, when its source is searched, then no case reaches Settings by clicking a rail control while a dialog backdrop is on screen, and the helper that did so no longer exists.
- Given a mounted shell with a refused-create dialog open and a seeded Settings entry, when `history.back()` is traversed, then Settings shows, the mode canvas carries `hidden`, the dialog node still holds the typed name and the error, and `router.push` was never called.
- Given that state, when the rail's Settings control is pressed, then Settings closes and the dialog is on screen again with its draft, its scroll lock and its Tab trap — the assertions those cases already make.
- Given the DW-416 scroll case, when the suite runs, then it runs once per opener in the parameterised block and the canvas returns to `scrollTop` 300 then 80 for both.
- Given a Create Wiki dialog on screen, when the new pin runs, then the overlay's classes and the two `.wb-rail` stacking declarations are asserted, and the case fails if the rail is ever lifted to or above the backdrop's level.
- Given the whole change, when `pnpm test` runs, then it passes with no product source file modified.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 4, low 8)
- defer: 1: (high 0, medium 1, low 0)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` The new DW-511 pin read only `CreateWikiDialog`'s overlay, though one of the six re-routed cases is held by `ConfirmDialog` and the block docblock names both — split the block into three cases and added a `ConfirmDialog` case driving the Preview edit confirm.
  - `[medium]` `[patch]` The `.wb-rail` stylesheet scan overclaimed: its regex required `{` immediately after the class, so `.wb-rail:hover`, `.wb-rail[data-x]`, `.wb-shell > .wb-rail` and grouped selectors escaped it — rewrote the extraction to walk every declaration block and match selectors word-bounded, select base/narrow rules by content rather than ordinal, check every `z-index` in a body, and throw loudly on a value that will not parse.
  - `[medium]` `[patch]` `seedSettingsEntry` asserted nothing about the history it claims to write, and jsdom's stack outlives `cleanup()` — a silently unseeded run would traverse onto a previous test's entry and report green. Added per-press `window.location.search` and `history.length` assertions, plus a `settings=1` check on the entry `openFromHistory` lands on.
  - `[medium]` `[patch]` `settings-shortcut.test.tsx`'s header sentence ("driven ... through both controls") became stale for the dialog-holding half — corrected minimally to name BACK for that half.
  - `[low]` `[patch]` `expect(backdropZ).toBe(120)` contradicted the comment above it — dropped; the level is asserted finite and the `<` comparisons carry the contract.
  - `[low]` `[patch]` `.wb-rail-item` — the control actually clicked, `position: relative` with no `z-index` — was outside the scan; the whole `.wb-rail*` family is scanned now.
  - `[low]` `[patch]` `.wb-shell` opening no stacking context was argued in prose and asserted nowhere; its base rule is now checked for `z-index` and `isolation`.
  - `[low]` `[patch]` `seedSettingsEntry`'s "must run before any dialog is opened" was unenforced — added a guard rejecting a mounted `aria-modal` dialog.
  - `[low]` `[patch]` The seed's side effects (an extra `SettingsCanvas` mount/unmount fetch, focus left on the rail control) were understated by "ends exactly where it started" — named in the docblock with why neither matters.
  - `[low]` `[patch]` The pin described the backdrop's `onMouseDown` interception without exercising it — the Create Wiki case now fires it and asserts the dialog closed.
  - `[low]` `[patch]` The block's jsdom fidelity limit was implicit — stated in the file header's COVERAGE LIMIT style, naming what is pinned and what jsdom cannot observe.
  - `[low]` `[patch]` The rewritten `press` docblock read as absolute and the DW-413 block's deliberate positive control contradicts it — added the carve-out. The same edit states why the suite now forbids lifting the rail (one of DW-511's two offered remedies) rather than leaving that silent.

## Design Notes

Why not the two remedies the ledger names as alternatives. Lifting `.wb-rail` above `z-[120]` would make the rail pointer-operable while `aria-modal="true"` and `useDialogA11y`'s Tab trap still declare the page inert — creating the pointer/keyboard asymmetry DW-511 itself objects to, just inverted. Closing the dialog when a rail control is activated would discard the Create Wiki draft, which is precisely what the DW-373/DW-412 preservation exists to protect ("hiding is not closing", this file's own header). The codebase therefore selects the third reading, which is the one the ledger entry's own closing sentence names and the one its `location` points at: the rows are stale, not the product.

The seeded history, for the record — the mount seed `replaceState`s the current entry, so:

```
[?mode=wiki]                 ← mount seed (replaceState)
[?mode=wiki&settings=1]      ← seedSettingsEntry(): first rail press
[?mode=wiki]                 ← seedSettingsEntry(): second rail press  (current)
   … dialog opened here …
back() → ?mode=wiki&settings=1   Settings shows over the withdrawn canvas
back() → ?mode=wiki              Settings closes, dialog re-arms (the BACK case)
```

`beforeEach` already resets the URL to `/` before each render, so the seed is deterministic per test.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- expected: all cases pass, including the moved DW-416 case running once per opener.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-shortcut.test.tsx` -- expected: pass; its cross-reference to this file is unchanged.
- `pnpm test` -- expected: the full two-project run passes.
- `git status --porcelain -- src` -- expected: exactly one modified path, the test file.

## Auto Run Result

Status: done

**Implemented change.** DW-511's defect is located in the test suite, and that is where it was fixed: the six cases that held an `aria-modal` dialog while reaching Settings no longer click the rail through a live `z-[120]` backdrop. They seed a Settings history entry before any dialog opens (`seedSettingsEntry`, two rail presses while the rail is genuinely reachable) and then reach the surface by Back (`openFromHistory`) — browser chrome, which a modal neither covers nor traps, and the path DW-167 made real. Every prior assertion is intact; the rail remains the closer, which is reachable because the dialog-holding surface is `hidden` by then. The two product remedies the intent offered were declined on the codebase's own authority and the reason is recorded in Design Notes: lifting `.wb-rail` above the backdrop would make it a pointer opener while `aria-modal="true"` and the Tab trap still declare the page inert (the inverse of the asymmetry DW-511 objects to), and closing the dialog on rail activation would discard the Create Wiki draft the DW-373/DW-412 preservation exists to protect. The new block pins the refusal executably so it cannot rot back into prose, and says out loud that it forbids the lift.

**Files changed.**
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- `openFromRail` retired for `seedSettingsEntry` + `openFromHistory`; the six modal-holding cases re-routed through Back; the DW-416 scroll case (which holds no dialog) moved into the parameterised `describe.each(OPENERS)` block; the stale prose corrected in the file header, `press`, `OPENERS` and the block docblock; new block "the rail is not an opener while a dialog backdrop is on screen (DW-511)" pinning both dialogs' overlays, the backdrop's `onMouseDown` interception, and every `.wb-rail*` / `.wb-shell` stacking declaration in `globals.css`.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` -- one header sentence corrected: the render preservation is still driven through both controls in the parameterised block, the dialog-holding half by Back.

No product source was modified.

**Review findings breakdown.** 12 patches applied (medium 4, low 8); 1 item deferred (medium); 5 rejected. No intent_gap, no bad_spec, no loopback.

**Follow-up review recommendation:** true. Patched by severity: high 0, medium 4, low 8. Score = 3 x 4 + 1 x 8 = 20, which is >= 5.

**Verification performed** (Node 22.16.0 via nvm — this machine's default Node 26.8.1 fails the whole dom project at `window.localStorage.clear()` on the unmodified baseline too, a pre-existing environment issue; CI pins Node 22, and `pnpm` is broken under the nvm shim here, so vitest was invoked as `node node_modules/vitest/vitest.mjs`):
- `vitest run --project dom settings-canvas-persistence.test.tsx settings-shortcut.test.tsx` -- 37 passed (32 + 5); the suite grew from 28 to 32 cases.
- Full `vitest run` -- 340 files, 7896 passed, 1 skipped.
- `tsc --noEmit` and `eslint` on both files -- clean.
- `git status --porcelain -- src` -- exactly the two test files.
- Mutation checks, each reverted afterwards: `z-index: 130` on `.wb-rail-item`; a grouped `.wb-rail, .wb-sheet-trigger { z-index: 200 }`; `.wb-rail:hover { z-index: 999 }`; the narrow rule's `40` replaced by a `var()`; `isolation: isolate` on `.wb-shell`; `ConfirmDialog`'s root `fixed` changed to `absolute`; `seedSettingsEntry()` moved after the dialog opens; `pushSurface`'s `pushState` swapped for `replaceState`. All eight were caught.
- I/O matrix audit: all four rows are covered by cases that ran and passed -- "is HIDDEN rather than unmounted..." and "does not pull focus into the hidden canvas..." (seed then Back), "keeps the typed name and the shown error..." (rail closes it), "leaves the keyboard in the re-armed dialog when BACK reveals its canvas" (Back out again), and the relocated DW-416 case, now once per opener (no modal held).

**Residual risks.**
- The stacking argument is still a textual proxy. jsdom does no layout and no hit-testing, so the pin asserts the two facts the unreachability is composed of -- a full-viewport backdrop at a level, and every rail rule below it -- plus the backdrop's `onMouseDown` interception. Real pointer behaviour across platforms remains Playwright's (`pnpm test:e2e`), which is not in CI.
- The seed adds one `SettingsCanvas` mount/unmount to six cases (one extra stubbed fetch) and leaves focus on the rail's Settings control before each dialog opens. Both are named in `seedSettingsEntry`'s docblock; neither affects an assertion, because every dialog opener in the file focuses its own control before clicking.
- One untracked file from an earlier, unrelated bundle -- `_bmad-output/implementation-artifacts/spec-dw-422-519-520-522-withdrawn-surface-lifecycle.md`, status `in-review` -- was present when this run started and was deliberately left alone: it is another bundle's in-flight artifact, not this session's to commit.
