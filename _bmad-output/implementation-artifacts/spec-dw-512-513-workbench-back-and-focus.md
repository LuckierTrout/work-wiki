---
title: 'Workbench Back: an entry behind a deep-linked Settings, and a focus bump that asks where the keyboard was (DW-512, DW-513)'
type: 'bugfix'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized, multiple-goals]
baseline_revision: 'c8ed17de1b1fd87cb8430b7cf4660cf3080ff84c'
deferred:
  - summary: >-
      A traversal that moves the Settings flag no longer rescues a keyboard sitting in a
      region the same commit withdraws but which is not `#wb-canvas` — a `SettingsNav`
      pane row most reachably — so Back out of Settings from there drops focus to `<body>`.
    evidence: |-
      DW-513 narrowed the popstate bump to
      `document.getElementById(CANVAS_ID)?.contains(document.activeElement)`, which is the
      expression the recorded decision names. But `selectSettingsCategory` deliberately does
      not bump, so after a pane pick the keyboard is on a `SettingsNav` button — and that nav
      renders in the left `<aside>`, OUTSIDE `#wb-canvas`, and is unmounted by the very commit
      that closes the surface.

      Reproduced against this change: open Settings, click a pane row, Back (pane undone, focus
      stays on the row — already pinned), Back again (surface closes) → `document.activeElement`
      is `<body>`. Before the narrowing it was `#wb-canvas`. That is DW-423's own symptom,
      re-opened for one class of focus position. The trees, `ActivityDock` and the Preview column
      have the same shape on a traversal that OPENS Settings.

      Not fixed here: DW-513's decision fixes the sample at the canvas, and the code comment now
      states the cost rather than claiming otherwise. Widening it to "any region this commit
      withdraws" is what DW-423's prose ("inside the Settings surface") would support, and needs
      its own ruling.
    location: >-
      src/components/workbench/Workbench.tsx (the popstate listener's `hadCanvas` sample)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two Back-button defects left in `src/components/workbench/Workbench.tsx` by DW-167/DW-423's Settings-in-the-URL work. The mount seed (`:499-507`) writes one `replaceState`, so a `?settings=1` link followed into a fresh tab is the first entry of its session and Back leaves the app holding the unsaved Settings draft with no way to close the surface (DW-512). And the `popstate` bump (`:878-884`) fires whenever the Settings flag moved, whatever held the keyboard, so Back pressed with focus on the rail still yanks it to `#wb-canvas` (DW-513) — asymmetric with the rail-close path, which deliberately leaves focus on the control that was pressed.

**Approach:** On a load where `readSettingsFromSearch` is true, seed TWO entries — `replaceState` the Settings-CLOSED href, then `pushState` the open one — so Back has somewhere to land. And sample `document.getElementById(CANVAS_ID)?.contains(document.activeElement)` in the `popstate` handler BEFORE `applySurface`, bumping only when the flag moved AND the keyboard was actually in the canvas about to be swapped. Both in-code comments currently argue the opposite of these decisions and are rewritten with the behaviour.

## Boundaries & Constraints

**Always:**
- The extra entry is conditional on `readSettingsFromSearch` being true. A load with Settings closed keeps today's single `replaceState`, today's `history.length`, and today's Back contract.
- Query-param POSITION survives: compute BOTH seed hrefs from the pre-seed `window.location` so `/?settings=1` still normalizes to `?settings=1&mode=lint` rather than being reordered by the two-step write.
- Both history calls stay inside the existing single `try {} catch {}` — a `SecurityError` costs the linkable URL and nothing else, and the selection restore plus `setMounted(true)` still run.
- The restore stays SILENT: the seed announces nothing and moves no focus, the extra entry included.
- The focus sample is taken in the `popstate` handler, before `applySurface` — not in `bumpCanvasFocus` and not in the `canvasFocusNonce` effect, whose own comment (`:1616-1619`) explains why that effect must not read `activeElement`.
- `contains` is true for the node itself, which is what keeps every existing path green: every route that opens Settings already lands the keyboard on `#wb-canvas`, so a Back out of it still bumps.
- The recorded decisions are the authority for both behaviour changes: the mode's Back contract really does change for the deep-linked-Settings load, and the traversal bump really does become conditional.

**Block If:** Nothing. Both decisions are recorded on the ledger entries.

**Never:**
- Do not change the rail-close path (`toggleSettings`) — it must still leave the keyboard on the control that was pressed and must still push one entry on both edges.
- Do not change `selectSettingsCategory`'s `pushState`, the `popstate` skip guard's triple, or anything else DW-514 settled.
- Do not make the `canvasFocusNonce` effect read `document.activeElement`, and do not widen the bump to surfaces other than the canvas (the Preview column and the tree panel are out of scope here).
- Do not introduce `router.push`, `<Link>`, `useRouter` or `useSearchParams` into `Workbench.tsx` (`workbench-chrome.test.ts:155-170` bans them), and keep `window.history.pushState(`, `window.history.replaceState(`, `window.addEventListener("popstate", onPopState)` and the `initialMode(window.location.search, readStoredMode())` literal spelled exactly as they are (`:165-167`, `:248`).
- Do not add a stored (localStorage) Settings preference of any kind.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Load with Settings closed | `/?mode=chat`, stored `wiki` | one `replaceState`, `history.length` unchanged | No error expected |
| Deep-linked `?settings=1` load | `/?mode=chat&settings=1` in a fresh tab | surface open, URL unchanged in content, `history.length` is `before + 1`, nothing announced, focus untouched | History throws → surface, restored row and `setMounted(true)` all still happen |
| Deep link with no mode | `/?settings=1`, stored `lint` | URL still `?settings=1&mode=lint` (position preserved), `history.length` `before + 1` | No error expected |
| Deep link naming a pane | `/?mode=chat&settings=1&category=embeddings` | URL left exactly as written, `history.length` `before + 1`, pane restored silently | No error expected |
| Back from a deep-linked Settings | the seeded pair, focus never moved | Settings closes onto the mode the link named; the app is not left; keyboard stays where the visitor had it | No error expected |
| Back with focus on the rail | Settings open, a rail button focused | surface changes and announces; focus STAYS on that rail button | No error expected |
| Back with focus in the canvas | Settings open, focus on `#wb-canvas` | surface changes; focus lands on the new `#wb-canvas` | No error expected |
| Traversal that moves only the mode | focus anywhere | no bump, exactly as today | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/Workbench.tsx` -- the only source file that changes.
  - `:454` `initialMode(window.location.search, readStoredMode())` — pinned as a literal by `workbench-chrome.test.ts:248`; keep byte-identical.
  - `:459` `restoredSettings`, `:468-470` `restoredCategory` — already read before the seed; reuse them.
  - `:481-498` the seed's comment block. `:491-498` ("It does NOT cover a `?settings=1` deep link…", "Unfixable from here…") is the DW-512 concession and must be REPLACED with what the seed now does and why the mode's Back contract changed for this one load.
  - `:499-517` the seed itself: one `surfaceHref(window.location, restoredMode, restoredSettings, restoredCategory)`, one guarded `replaceState`, one `catch` whose comment explains why it is scoped here rather than around the effect. The catch and its comment stay; only the body of the `try` grows.
  - `:786-808` `pushSurface` — the model for the guarded write and the same degrade; do NOT route the seed through it (it reads `window.location` after the replace has already moved it).
  - `:873-884` the `popstate` tail: the `:873-877` comment states the DW-423 rule unconditionally and must be rewritten; `:878` `movedSettings`; `:879` `applySurface(next, settings, category)`; `:884` `if (movedSettings) bumpCanvasFocus();`.
  - `:118` `CANVAS_ID` is imported from `./ModeCanvas`; whichever section is on screen carries it (the hidden one gives it up), so `getElementById(CANVAS_ID)` names the surface about to be swapped.
  - `:899-925` `toggleSettings` — the rail-close path this change restores symmetry with; unchanged.
  - `:1594-1637` the `canvasFocusNonce` effect; its `:1616-1619` comment ("Deliberately NOT keyed on `document.activeElement`") stays TRUE and unchanged — the sampling belongs in the handler.
- `src/lib/workbench-url.ts:370-396` `surfaceHref(loc, mode, settingsOpen, settingsCategory)` -- read-only. Deletes both `settings` and `category` when `settingsOpen` is false, which is what makes the "closed" href computable from the same location. `locationHref` at `:263`. No change here.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- the mounted suite. Helpers `renderShell`, `railItem`, `current`, `announced`, `settingsShowing`, `landingSite`, `paneRow`, `currentPane`, `traverse`, `SETTINGS_ANNOUNCEMENT`, `OTHER_CATEGORY`. **Four cases assert `history.length === before` on a deep link that opens Settings and must become `before + 1`, comments rewritten**: `:414`, `:441`, `:574`, `:597`. `:617` (stray pane on a CLOSED surface) and `:277`/`:292` (closed loads) must stay at "no entry". The degrade block at `:865` is where a throwing-history deep-link case belongs.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- read-only, but the collateral risk. `openFromHistory()` (`:401`) traverses INTO Settings and `:1283`/`:1222` assert the keyboard lands on `#wb-canvas`; in every one of those cases a Create Wiki dialog INSIDE the mode canvas holds focus, so the sample is true and they stay green. `:1191`'s Preview-column confirm is the one case where focus is outside the canvas, and it asserts nothing about focus.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx:299-306` -- read-only; mode-only traversals, which never bumped and still do not.
- `src/lib/__tests__/workbench-chrome.test.ts:151-170, 248, 425-434` -- source-scan pins that must all survive: the three history/listener literals, the `initialMode(...)` call, and `stripComments(shell)` still not matching `/getElementById\(CANVAS_ID\)\?\.focus\(\)/` (the new `?.contains(` call does not match it).

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/Workbench.tsx` (mount seed) -- inside the existing `try`, compute `beneath = surfaceHref(window.location, restoredMode, false, restoredCategory)` and `seeded = surfaceHref(window.location, restoredMode, restoredSettings, restoredCategory)` BOTH from the pre-seed `window.location`, `replaceState` `beneath` when it differs from `locationHref(window.location)`, then `pushState` `seeded` when `restoredSettings` is true -- the replace gives the deep link something behind it, the push is the entry Back consumes, and pre-computing keeps `/?settings=1` normalizing to `?settings=1&mode=lint`. Replace the `:491-498` concession with what the seed now does.
- `src/components/workbench/Workbench.tsx` (popstate) -- sample `const hadCanvas = document.getElementById(CANVAS_ID)?.contains(document.activeElement) ?? false;` alongside `movedSettings`, BEFORE `applySurface`, and gate the bump on `movedSettings && hadCanvas` -- the rail-close path already leaves focus with the control that owns it, and this makes the traversal path symmetric. Rewrite the `:873-877` comment so it states the narrowed rule rather than the unconditional one.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- re-pin `:414`, `:441`, `:574` and `:597` to `before + 1` with comments that say WHY a restore now costs an entry, and add: Back out of a deep-linked `?settings=1` closes the surface, leaves the mode the link named and leaves the keyboard where the visitor had it; a traversal that moves the flag with a rail button focused leaves that button focused; a traversal that moves the flag with `#wb-canvas` focused still lands on the new `#wb-canvas`; and, in the `when the History API refuses` block, a `?settings=1` deep link whose `replaceState` throws still restores the surface and still finishes mounting.
- `src/lib/__tests__/workbench-chrome.test.ts` -- extend the shell's source-scan case to pin the narrowing itself: `Workbench.tsx` must contain `getElementById(CANVAS_ID)?.contains(document.activeElement)` and, in the stripped copy, must not contain a bare `if (movedSettings) bumpCanvasFocus();` -- the sample has to be read before the commit, and only a source pin can stop it drifting back into the nonce effect where jsdom cannot tell the two apart.

**Acceptance Criteria:**
- Given a load where `readSettingsFromSearch` is false, when the shell mounts, then exactly one `replaceState` runs, no `pushState` runs, and `history.length` is unchanged.
- Given the shell was rendered on a `?settings=1` link and Settings is showing, when the rail's Settings control is clicked to close it, then the URL keeps the mode the link named and the keyboard stays on that control.
- Given `pnpm exec tsc --noEmit` and `pnpm lint`, when they run over the change, then both are clean.

## Spec Change Log

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` The seed's two history calls could fail independently: a landed `replaceState(beneath)` followed by a thrown `pushState(seeded)` left the address bar naming the surface CLOSED while Settings was open, rewriting the visitor's own `?settings=1` away. Gave the push its own nested `try` that repairs by putting `seeded` back with `replaceState`, and added a degrade case pinning it.
  - `[low]` `[patch]` The seed comment implied the pair is written only for a first-of-session entry. The predicate is `restoredSettings` alone, so a reload of an in-session Settings URL seeds a pair too, leaving two adjacent closed entries and one Back press the triple guard swallows. Comment now states that, and the dev-only StrictMode double-seed.
  - `[low]` `[patch]` The `hadCanvas` comment asserted "every route that OPENED Settings already landed the keyboard on `#wb-canvas`", which a pane pick falsifies. Rewritten to state the narrowing's real cost (see `deferred`), guard left as decided.
  - `[low]` `[patch]` `bumpCanvasFocus`'s docstring and the `canvasFocusNonce` effect's docstring both enumerated the non-bumping paths exhaustively and were made false by the narrowing. Corrected.
  - `[low]` `[patch]` `settings-canvas-persistence.test.tsx`'s `openFromHistory` JSDoc still said the bump fires "because the flag MOVED". Corrected to the conditional rule; no assertion changed.
  - `[low]` `[patch]` The new source-scan pin claimed to stop the sample drifting below `applySurface` but only asserted its presence — the reorder passed all 78 tests. Now compares the two anchors' indices in the stripped source; verified failing on the reorder.

## Design Notes

**The seed, both hrefs from the pre-seed location:**

```ts
const beneath = surfaceHref(window.location, restoredMode, false, restoredCategory);
const seeded = surfaceHref(window.location, restoredMode, restoredSettings, restoredCategory);
if (beneath !== locationHref(window.location)) window.history.replaceState(null, "", beneath);
if (restoredSettings) window.history.pushState(null, "", seeded);
```

When `restoredSettings` is false, `beneath === seeded` and this is byte-for-byte today's behaviour. Recomputing `seeded` from the replaced location would reorder `/?settings=1` to `?mode=lint&settings=1` and break `:441`'s pin for no gain.

**The bump, sampled in the handler:**

```ts
const movedSettings = settings !== settingsOpenRef.current;
const hadCanvas = document.getElementById(CANVAS_ID)?.contains(document.activeElement) ?? false;
applySurface(next, settings, category);
if (movedSettings && hadCanvas) bumpCanvasFocus();
```

By the time the nonce effect runs the canvas has already been swapped, so the sample cannot live there — and that effect's own comment explains why it must not read `activeElement` at all.

## Verification

**Commands:**
- `pnpm vitest run src/components/workbench/__tests__/workbench-mode-url.test.tsx src/lib/__tests__/workbench-chrome.test.ts` -- expected: all pass, including the four re-pinned cases and the new ones.
- `pnpm vitest run src/components/workbench/__tests__ src/lib/__tests__` -- expected: no collateral failures, in particular in `settings-canvas-persistence` and `wiki-canvas-persistence`.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** DW-512: on a load whose URL carries `?settings=1`, the mount seed writes a PAIR — `replaceState` of the Settings-CLOSED href, then `pushState` of the open one, both computed from the pre-seed `window.location` so param position survives — giving Back somewhere to land instead of walking out of the app with the unsaved Settings draft. A load with Settings closed is byte-for-byte unchanged. DW-513: the `popstate` focus bump now samples `document.getElementById(CANVAS_ID)?.contains(document.activeElement)` before `applySurface` and fires only when the flag moved AND the keyboard was in the canvas being swapped, so Back pressed with focus on the rail leaves it there — symmetric with the rail-close path. Both rationale comments that argued the opposite were rewritten.

**Files changed.**
- `../../src/components/workbench/Workbench.tsx` -- the seeded pair (with an independent degrade for the push) and the narrowed bump, plus the three rationale comments the change falsified.
- `../../src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- four deep-link cases re-pinned to `before + 1`; six new cases (Back off a deep link, rail-focus, canvas-focus, and two seed-refusal degrades).
- `../../src/lib/__tests__/workbench-chrome.test.ts` -- source pins for the sample's presence and its position before `applySurface`.
- `../../src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- `openFromHistory` JSDoc corrected; no assertion touched.

**Review findings.** 6 patches applied (1 medium, 5 low); 1 deferred (medium — see frontmatter `deferred`); 3 rejected; 0 intent gaps; 0 spec repairs.

**Follow-up review recommendation.** `false` — patched findings by severity: high 0, medium 1, low 5. No patched finding was high.

**Verification.**
- `pnpm vitest run src/components/workbench/__tests__ src/lib/__tests__` -- 336 files, 8999 passed, 1 skipped.
- `pnpm exec tsc --noEmit` -- exit 0. `pnpm lint` -- exit 0.
- Mutation checks: deleting the `pushState` fails 5 cases; widening the bump back to `if (movedSettings)` fails 3; moving the sample below `applySurface` fails the new order pin; removing the push's nested `try` fails the partial-refusal case.
- Matrix audit: every I/O row is covered by a case in `workbench-mode-url.test.tsx` that ran and passed.

**Residual risks.**
- The deferred finding: focus in a withdrawn region that is not `#wb-canvas` (a `SettingsNav` pane row most reachably) is no longer rescued on a traversal that moves the flag. Recorded rather than fixed — DW-513's decision fixes the sample at the canvas — and the code comment states it.
- The seed's pair is keyed on the flag alone, so a reload of an in-session Settings URL leaves one Back press the `popstate` triple guard swallows; documented at the seed. React StrictMode seeds twice in dev only.
