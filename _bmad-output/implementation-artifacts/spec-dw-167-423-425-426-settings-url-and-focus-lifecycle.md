---
title: 'Give the Workbench Settings surface a URL and one keyboard landing site'
type: 'bugfix'
created: '2026-08-28'
baseline_revision: '40f313b75191792f0ae8e5960232f0eaa5d4d80b'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The DW-373 rail rows pin a state the rail control itself cannot produce: with a
      Create Wiki dialog open, a real user can reach Settings through neither opener.
    evidence: |-
      `CreateWikiDialog.tsx:109` and `ConfirmDialog.tsx:67` both render the dialog root as
      `fixed inset-0 z-[120] ... bg-black/40` — a full-viewport overlay above `.wb-rail`,
      which carries no z-index of its own — so a pointer click aimed at the rail's Settings
      control lands on the backdrop. `useDialogA11y` traps Tab inside the dialog, so the
      control is unreachable by keyboard too. `fireEvent.click(rail(...))` succeeds only
      because jsdom does no hit-testing. This is the same class of defect DW-426 named,
      reached through the pointer surface instead of the keyboard one, and it is
      PRE-EXISTING: those rows drove the rail control before this change as well. DW-167
      does now create a reachable path to the state (Settings entry -> mode pick -> open
      the dialog -> Back), so the preservation the rows check is still real; what is stale
      is the block's claim that the rail control is how a user gets there.
    location: >-
      src/components/workbench/__tests__/settings-canvas-persistence.test.tsx (the rail-only block)
    severity: medium
  - summary: >-
      Back from a deep-linked `?settings=1` still leaves the app holding the unsaved
      Settings draft, because the mount seed adds no entry.
    evidence: |-
      The seed uses `replaceState`, matching the mode restore's own contract that Back must
      still leave the app on the first press. So a `?settings=1` link opened in a fresh tab
      is the first entry of its session and has nothing behind it to close the surface on —
      verbatim the symptom DW-167 describes, now reachable through the URL the fix
      introduces. Fixed for the in-session case only; the code comment states the residue
      rather than claiming otherwise. Closing it needs a decision about seeding a second
      entry on load, which would change the mode's Back contract too.
    location: >-
      src/components/workbench/Workbench.tsx (the mount seed)
    severity: low
  - summary: >-
      The popstate focus bump is unconditional on where the keyboard was, so Back pressed
      with focus on the rail still pulls it to `#wb-canvas`.
    evidence: |-
      DW-423's own text scopes the defect to "if the owner is inside the Settings surface".
      The rail-close path deliberately leaves focus alone for exactly that reason — the
      control the owner pressed holds the keyboard — so the two paths are asymmetric. A
      narrowing (`document.getElementById(CANVAS_ID)?.contains(document.activeElement)`
      sampled in the handler, before the commit) would restore the symmetry; nothing pins
      the case today.
    location: >-
      src/components/workbench/Workbench.tsx (the popstate listener)
    severity: low
  - summary: >-
      The URL names the Settings surface but not its category, so a copied link reopens the
      default pane while the live region announces it.
    evidence: |-
      `settingsCategoryId` is local `useState` with no URL and no storage. DW-167 asks only
      that the link reopen the surface, so this is within intent — but it means the address
      bar and the announced sentence can disagree about which pane the visitor lands on.
      Documented as an exclusion in `workbench-url.ts`'s header alongside the tab, the
      collapse flag, the selection and the widths.
    location: >-
      src/lib/workbench-url.ts (the not-in-the-URL list)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `toggleSettings` writes no history entry, so with Settings open the URL still names the underlying mode: a copied link reopens the mode canvas, and Back on the first entry leaves the app holding an unsaved Settings draft (DW-167). The same close path loses the keyboard — `applyMode` ends with `setSettingsOpen(false)` and the `popstate` listener calls it unconditionally, unmounting `SettingsCanvas` with nothing catching focus (DW-423) — while a second `g s` announces Settings but moves no focus, because the focus effect keys on the boolean alone (DW-425). Separately, `settings-canvas-persistence.test.tsx` fires `g s` at `document.body`, so its rows that press the key over an open modal pin a path `isInModalDialog` means a real keyboard user cannot take (DW-426).

**Approach:** Mirror the open Settings surface into the URL as a `settings=1` param ALONGSIDE `?mode=`, through one generalized href builder in `src/lib/workbench-url.ts`, accepted on load by the same mount seed that restores the mode — so Back closes Settings before it leaves the app. Replace the boolean-keyed focus effect with a nonce bumped by every path that swaps the canvas without a control holding the keyboard (both openers, and a traversal that moves the settings flag), keeping exactly one landing site. Then correct the persistence suite: drive the modal-holding rows from the rail control only, and say why.

## Boundaries & Constraints

**Always:**
- ONE URL convention. `src/lib/workbench-url.ts` owns both params; the shell never assembles a query string itself. The href builder is idempotent — applying it twice yields the same string — and preserves every other param's value and position plus the hash.
- Settings is a SURFACE over a mode, never a mode value. `readModeFromSearch("?mode=settings")` stays `null` (already pinned), and a URL naming Settings still names the mode underneath it, so closing Settings reveals the right canvas.
- The mount seed accepts the Settings flag exactly as it accepts the mode: URL-first, one `replaceState` that adds no entry, and SILENT — no announcement and no focus move, because a restore is not a change the owner made.
- `g s` still OPENS rather than toggles (DW-62) and still writes no second history entry when Settings is already open; only the rail control toggles.
- Focus moves to `#wb-canvas` — the one landing site — on both openers and on a traversal that MOVES the settings flag. It does NOT move when the rail control closes Settings (the control the owner pressed holds the keyboard), and does NOT move on a traversal that only changes the mode.
- Source forms `src/lib/__tests__/workbench-chrome.test.ts` pins stay spelled verbatim in `Workbench.tsx`: `initialMode(window.location.search, readStoredMode())`, `writeStoredMode(next)`, `announce(workbenchMode(next).label)`, `window.history.pushState(`, `window.history.replaceState(`, `window.addEventListener("popstate", onPopState)`. No `router.push(`, no `next/navigation` import.
- Every history call stays inside the existing `try/catch` degrade: a `SecurityError` costs the linkable URL and nothing else.

**Block If:**
- The `settings=1` param cannot be added without persisting Settings to `workbench-state.ts` (it must stay URL-only — there is no stored Settings preference).

**Never:**
- Do not put the tree tab, the collapse flag, the selection or the column widths in the URL — DW-27's boundary is unchanged.
- Do not add a second href builder beside `modeHref`; generalize the one that exists.
- Do not make `g s` close Settings, and do not move focus when the rail control closes it.
- Do not keep `SettingsCanvas` mounted while closed — that unmount IS the draft's discard.
- Do not delete the DW-373 preservation coverage when de-parameterising the modal rows; move it to the rail opener and keep the both-openers focus case by dropping the dialog from it, not the row.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read the flag | `?mode=chat&settings=1` | `readSettingsFromSearch` is `true` | No error expected |
| Absent / other value | ``, `?settings=`, `?settings=0`, `?settings=yes` | `false` — one accepted spelling only | No error expected |
| Write it on | `{search:"?wiki=abc"}`, `graph`, open | `/?wiki=abc&mode=graph&settings=1` | No error expected |
| Write it off | `{search:"?mode=chat&settings=1"}`, `chat`, closed | `/?mode=chat` — the param is DELETED, not set empty | No error expected |
| Idempotent | Apply the builder to its own output | Byte-identical string | No error expected |
| Deep link | Load `/?mode=chat&settings=1` | Settings open over Chat, no new entry, no announcement, focus untouched | No error expected |
| Open from the rail | Wiki showing, click Settings | One entry pushed, `?mode=wiki&settings=1`, focus on `#wb-canvas` | History throws ⇒ surface still opens |
| Back from Settings | The entry above | Settings closes, mode stays Chat/Wiki, mode announced, focus on `#wb-canvas` | No error expected |
| Second `g s` | Settings already open | No entry added, Settings announced again, focus back on `#wb-canvas` | No error expected |
| `g s` over an open modal | Create Wiki dialog focused | Nothing dispatches (`isInModalDialog`); the rail control is the only opener | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-url.ts` — the URL rules. `WORKBENCH_MODE_PARAM`:26, `readModeFromSearch`:80, `initialMode`:100, `locationHref`:105, `modeHref`:134. Add the settings param + reader; generalize `modeHref` into a builder that writes BOTH params. Header prose at :16-19 currently says the mode is the only thing in the URL — it must be corrected, not left.
- `src/components/workbench/Workbench.tsx` — the shell. `settingsOpen` state :223; `modeRef` :315-316 (the pattern for a `settingsOpenRef`); mount seed :400-489 (restore + `replaceState` at :432-434); `applyMode` :627-642; `selectMode` :644-664 (the push guard at :654); `popstate` listener :675-696 (the `next === modeRef.current` early return at :692 must also consider the flag); `toggleSettings` :707-717; `openSettings` :765-769; the DW-413 focus effect :1272-1306; render `hidden={settingsOpen}` :1534/:1628 and `{settingsOpen && <SettingsCanvas …>}` :1640.
- `src/hooks/useKeyboardShortcuts.ts` — `isInModalDialog`:58-62 and its dispatch guard :263. READ-ONLY here; it is the evidence for DW-426.
- `src/lib/__tests__/workbench-url.test.ts` — executes the URL rules. `?mode=settings` is already pinned `null` at :49 (why `settings=1` and not `mode=settings`). `modeHref` cases :106-166 move to the new builder.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` — mounted URL/traversal behaviour, with the `traverse` helper :191-208. Two cases contradict DW-167 and must be rewritten: "closes Settings on Back…" :331 and "puts the mode in the URL and nothing else" :410-441 (which asserts `history.length` unchanged across two Settings clicks). New DW-167/DW-423 cases belong here.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` — `g s` behaviour; "leaves the surface open on a second press" :~170 is where DW-425's focus assertion belongs.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` — `press()`:216-227, `OPENERS`:241-259, `describe.each` :403-806. Six rows hold an open `aria-modal` dialog when `open()` runs: "keeps the typed name…", "is HIDDEN rather than unmounted…", "holds neither the body scroll lock nor the Tab trap…", "takes the keyboard to the Settings section (DW-413)", "stands the Preview's open confirm down…", "does not pull focus into the hidden canvas…". `openCreateWith`:365-370, `openPreviewEditorWith`:340-350 (its confirm is DISMISSED, so that row holds no dialog).
- `src/lib/__tests__/workbench-chrome.test.ts` — source-form pins on `Workbench.tsx` (:143-158, :229-237). Read before editing the shell.
- `src/lib/__tests__/retired-surfaces.test.ts` — pins `KNOWLEDGE_TREE_HREF` against `WORKBENCH_MODE_PARAM` (:255-290). It must keep naming Wiki mode with Settings closed.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-url.ts` -- add `WORKBENCH_SETTINGS_PARAM` and `readSettingsFromSearch(search)`; replace `modeHref(loc, mode)` with a builder taking the settings flag too, which SETS the param when open and DELETES it when closed -- one convention, one idempotent fixed point, so the shell can compare against `locationHref` and skip a redundant write.
- `src/lib/workbench-url.ts` -- correct the header prose that says the mode is the only thing in the URL, and say what still is not (tab, collapse, selection, widths) -- the comment is the module's contract and would otherwise contradict its own code.
- `src/components/workbench/Workbench.tsx` -- read the flag in the mount seed, seed the URL from mode AND flag, and add a render-assigned `settingsOpenRef` beside `modeRef` -- a deep link must restore the surface, silently.
- `src/components/workbench/Workbench.tsx` -- generalize `applyMode` into a surface applier taking the flag (keeping `applyMode(next)` as the mode-pick wrapper), extend the `popstate` early return to compare the flag as well, and add one shared push helper used by `selectMode`, `toggleSettings` and `openSettings` -- a traversal that only moves Settings must no longer be swallowed by the mode-equality guard.
- `src/components/workbench/Workbench.tsx` -- replace the boolean-keyed focus effect with a nonce-keyed one, bumped by `openSettings`, by `toggleSettings`'s OPEN branch, and by a traversal that moves the flag -- one landing site, reachable a second time, and reached when Back takes the surface away.
- `src/lib/__tests__/workbench-url.test.ts` -- port the `modeHref` cases to the new builder and add the matrix rows for `readSettingsFromSearch` and the on/off/idempotent writes -- the node project is where these rules are executed.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- rewrite the two contradicted cases and add: deep link restores Settings silently and adds no entry; opening pushes exactly one entry; Back closes Settings, keeps the mode, announces it and lands focus on `#wb-canvas`; Forward reopens it; a mode-only traversal still moves no focus -- DW-167 and DW-423 are only observable on a real session history.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` -- extend the second-press case to assert focus returns to `#wb-canvas` with no entry added -- DW-425's whole symptom is an announcement the keyboard did not follow.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- move the six modal-holding rows out of `describe.each` into a rail-only block explaining the `isInModalDialog` reason; rewrite the DW-413 focus row to focus a non-modal control inside the mode canvas so it KEEPS both openers; correct the `OPENERS` and `press` docblocks -- the suite must stop pinning a path a browser keyboard user cannot take.

**Acceptance Criteria:**
- Given Settings is open over Chat, when the owner copies the URL and loads it in a new tab, then Settings is showing over the Chat canvas, no history entry was added, nothing was announced, and focus was not moved.
- Given Settings was opened from the rail on the first entry of a session, when the owner presses Back, then Settings closes, the mode underneath is unchanged and announced, focus is on `#wb-canvas`, and the app has not been left.
- Given the keyboard is on `<body>` while Settings is open, when the owner presses `g s`, then Settings is announced again, focus is on `#wb-canvas`, and `window.history.length` is unchanged.
- Given Settings is open, when the owner clicks the rail's Settings control, then Settings closes, one entry is added, the `settings` param is gone from the URL, and focus stays on the control that was pressed.
- Given a Create Wiki dialog is open and focused, when `g s` is dispatched from inside it, then nothing changes — and no suite drives that press from `document.body` as if it were reachable.
- Given the History API throws, when Settings is opened, then the surface still opens, focus still lands on `#wb-canvas`, and only the linkable URL is lost.

## Spec Change Log

## Review Triage Log

### 2026-08-28 - Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 2, low 7)
- defer: 4: (high 0, medium 1, low 3)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` Nothing anywhere asserted that `g s` writes the URL - deleting `pushSurface(modeRef.current, true)` from `openSettings` left the whole suite green. The first-press case in `settings-shortcut.test.tsx` now pins `?mode=wiki&settings=1` and `history.length + 1`, which also makes the second press's "no second entry" assertion meaningful. Mutation-checked.
  - `[medium]` `[patch]` A traversal that CLOSES Settings over a live modal stole the keyboard from the dialog `useDialogA11y` had just re-armed (a child effect, so it runs first). The canvas-focus effect now returns when a `[role="dialog"][aria-modal="true"]` is not inside a `[hidden]` subtree - "live", not merely "present", so a stood-down dialog under the withdrawn canvas still allows the move INTO Settings. Pinned in the rail-only block with the into-Settings move as a positive control; mutation-checked.
  - `[low]` `[patch]` `applySurface` depended on `settingsCategoryId`, re-registering the `popstate` listener on every category pick and contradicting its own docblock. Read through a render-assigned `settingsCategoryIdRef`; deps are stable again.
  - `[low]` `[patch]` The mount-seed comment attached "Back must close the surface, not leave the app" to the `replaceState` that guarantees the opposite on a deep link. Scoped to the in-session case, with the residue named.
  - `[low]` `[patch]` The `workbench-url.ts` header overclaimed that both params are written only through the builder, while `KNOWLEDGE_TREE_HREF` still interpolates one by hand. Prose corrected; the constant was not rerouted.
  - `[low]` `[patch]` The header's not-in-the-URL list omitted the Settings category. Added.
  - `[low]` `[patch]` `workbench-mode-url.test.tsx:274` still named `modeHref`, which no longer exists. Renamed to `surfaceHref`.
  - `[low]` `[patch]` No case covered `?settings=1` with no `?mode=`. Added, pure and mounted.
  - `[low]` `[patch]` `readSettingsFromSearch` had no repeated-param case, though `readModeFromSearch` carries one deliberately. Added, with the writer's duplicate-collapsing noted.

## Design Notes

**Why `settings=1` and not `mode=settings`.** The decision text offers both, but the codebase already answers: `readModeFromSearch` narrows through `isWorkbenchModeId`, `workbench-url.test.ts:49` pins `?mode=settings` as `null`, and DW-167's own text calls Settings "a surface, not a mode". A `mode=settings` value would also destroy the mode UNDERNEATH the surface, so closing Settings would have nowhere to land.

**One nonce, one landing site.** The DW-413 effect deliberately runs in one direction so both openers share exactly one destination. A nonce keeps that property while making the move re-triggerable — and `#wb-canvas` is the right target in BOTH directions, because `ModeCanvas` and `SettingsCanvas` hand the id and `tabIndex={-1}` back and forth. Guarding on the initial value keeps the mount silent.

```ts
const [canvasFocusNonce, setCanvasFocusNonce] = useState(0);
// …bumped in openSettings, in toggleSettings' open branch, and on a traversal
// that moves the flag — never on the rail close.
useEffect(() => {
  if (canvasFocusNonce === 0) return;
  document.getElementById(CANVAS_ID)?.focus();
}, [canvasFocusNonce]);
```

**The popstate guard has to widen.** `if (next === modeRef.current) return;` exists so the skip link's fragment entry does not close Settings. With Settings in the URL, Back from Settings is a traversal with NO mode change — so the guard must compare the pair, or DW-167's headline case is swallowed by the very guard that protects the fragment entry.

**Announcements.** A traversal into Settings announces the Settings sentence; out of it announces the mode. `workbench-chrome.test.ts` pins `announce(workbenchMode(next).label)` as a literal, so the branch must be an `if`/`else`, never a ternary inside the call.

**Bundle note.** Three of these four entries are `severity: low`, which the recorded sweep policy says belongs in `skip` rather than a bundle. Implemented as dispatched; flagged here for the human, not acted on.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/workbench-url.test.ts` -- expected: all pass, including the new settings-param rows.
- `npx vitest run src/components/workbench/__tests__/workbench-mode-url.test.tsx src/components/workbench/__tests__/settings-shortcut.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- expected: all pass.
- `npx vitest run src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/retired-surfaces.test.ts` -- expected: unchanged and green; these are the source-form pins the shell edit could break.
- `npx tsc --noEmit` -- expected: no type errors.
- `npx eslint src/lib/workbench-url.ts src/components/workbench/Workbench.tsx src/components/workbench/__tests__ src/lib/__tests__` -- expected: clean.
- `pnpm test` -- expected: full suite passes with no new failures. (`pnpm` may fail this checkout with `ERROR packages field missing or empty`; fall back to `npx vitest run`, the identical command.)
- Mutation checks (run, then revert): deleting the flag from the `popstate` guard must fail the Back-closes-Settings case; keying the focus effect back on `settingsOpen` must fail the second-`g s` case; dropping the nonce bump from the traversal must fail the DW-423 case.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The open Settings surface is now mirrored into the URL as `?settings=1` beside `?mode=`, through one generalized builder — `modeHref(loc, mode)` became `surfaceHref(loc, mode, settingsOpen)`, which sets the flag when open and DELETES it when closed, so the closed state is one string and the shell can compare against `locationHref` to decide whether an entry is worth writing. The mount seed accepts the flag URL-first and silently, one `replaceState` for the pair. `applyMode` generalized into `applySurface(next, settings)`; one shared `pushSurface` helper serves `selectMode`, both branches of `toggleSettings`, and `openSettings`; the `popstate` early return compares the PAIR, so Back out of Settings — a traversal with no mode change in it — is no longer swallowed by the guard that protects the skip link's fragment entry. The DW-413 focus effect is re-keyed on a nonce bumped by both openers and by a traversal that MOVES the flag, guarded at its initial value so the mount stays silent and guarded against a live modal so a re-armed dialog keeps the keyboard. The DW-373 persistence suite's modal-holding rows moved into a rail-only block naming the `isInModalDialog` reason; the DW-413 focus row keeps both openers by standing on a non-modal control instead of an open dialog.

**Files changed.**
- `../../src/lib/workbench-url.ts` — `WORKBENCH_SETTINGS_PARAM`, `readSettingsFromSearch`, `surfaceHref` replacing `modeHref`; header prose corrected to name both params and what the URL still does not carry.
- `../../src/components/workbench/Workbench.tsx` — flag restored at mount; `settingsOpenRef` and `settingsCategoryIdRef`; `applySurface`/`applyMode`/`pushSurface`; widened `popstate` guard; nonce-keyed canvas-focus effect with the live-modal guard.
- `../../src/lib/__tests__/workbench-url.test.ts` — `surfaceHref` cases, reader rows, repeated-param and round-trip pins.
- `../../src/components/workbench/__tests__/workbench-mode-url.test.tsx` — two contradicted cases rewritten; deep link, one-entry-per-open, Back/Forward with focus and announcements, rail close, mode pick from Settings, mode-only traversal, History-refuses.
- `../../src/components/workbench/__tests__/settings-shortcut.test.tsx` — second `g s` returns the keyboard; first press pins the URL and the entry.
- `../../src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` — modal rows relocated to a rail-only block; docblock claims corrected; Back-over-a-re-armed-dialog case added.

**Review findings.** 9 patches applied (2 medium, 7 low); 4 items deferred (1 medium, 3 low — see frontmatter); 8 rejected as noise. No intent gaps, no spec repairs.

**Follow-up review.** Patched this pass: 0 high, 2 medium, 7 low. Score = 3x2 + 1x7 = 13, which is >= 5, so `followup_review_recommended: true`.

**Verification.**
- `npx vitest run` (full, the `pnpm test` fallback): 330 files, 7647 passed, 1 skipped.
- `npx vitest run src/lib/__tests__/workbench-url.test.ts src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/retired-surfaces.test.ts`: 123 passed — the source-form pins the shell edit could have broken are intact.
- `npx tsc --noEmit`: clean. `npx eslint` over the changed files and both `__tests__` trees: clean.
- Matrix audit: every I/O row has a covering case that ran and passed — the five reader/writer rows in `workbench-url.test.ts`; deep link, rail open (and its History-refuses twin), and Back in `workbench-mode-url.test.tsx`; the second `g s` in `settings-shortcut.test.tsx`; `g s` over an open modal in `settings-canvas-persistence.test.tsx`.
- Mutation checks run and reverted: dropping the flag from the `popstate` guard, re-keying the focus effect on `settingsOpen`, dropping the traversal bump, deleting the push from `openSettings`, and removing the live-modal guard each fail their own cases.

**Residual risks.**
- Every focus claim is verified in jsdom, which by its own admission does not model the failure — it does not blur through an ancestor `hidden`. The tests assert the positive landing site; the `<body>` baseline DW-423 describes is argued, not executed. A browser pass (Back out of Settings, a second `g s`, a deep link) would close that.
- `workbench-mode-url.test.tsx`'s standing coverage limit applies to the new cases too: Next 15 patches `pushState`/`replaceState` into its router, and that patch is installed by the router this suite mocks away — so "the address bar moves and nothing remounts" is verified as React keeping the tree, not as App Router behaviour.
- Opening and closing Settings each emit an `Analytics` `$pageview`, so a Settings visit is now two. Accepted for the same reason a mode switch already was — the surface has an address — and stated in the shell's header, but it moves a metric somebody reads.
- Environment, PRE-EXISTING and unrelated to this change: on this checkout the whole `dom` vitest project dies at `window.localStorage.clear()`, because Node 26's experimental Web Storage global shadows jsdom's and is `undefined` without `--localstorage-file`. Confirmed on the unmodified baseline. Every dom run above used `NODE_OPTIONS="--no-experimental-webstorage"`. Worth folding into the test script separately.
- Bundle note, unchanged from planning: three of the four entries are `severity: low`, which the recorded sweep policy puts in `skip` rather than a bundle. Implemented as dispatched, flagged for the human.
