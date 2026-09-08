---
title: 'Workbench URL, history and focus lifecycle (DW-512, DW-513, DW-514)'
type: 'bugfix'
created: '2026-09-02'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
baseline_revision: '8162efabd080eeb13fd63875c90938ea32c0cbaf'
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three residues left by DW-167/DW-423's Settings-in-the-URL work. A `?settings=1` deep link opened in a fresh tab is the first entry of its session, so Back leaves the app with the unsaved Settings draft in it (DW-512). The `popstate` focus bump fires whatever held the keyboard, so Back pressed from the rail yanks focus to `#wb-canvas` (DW-513). And the URL names the Settings surface but not the pane, so a copied link reopens General while the live region announces whatever the sender was reading (DW-514).

**Approach:** Seed a SECOND history entry on a deep-linked `?settings=1` load — replace to the surface with Settings closed, then push the open one — so Back has somewhere to land; narrow the `popstate` bump to traversals where focus was actually inside the canvas being swapped; and add a settings-category param to `workbench-url.ts`, written on category change and restored on load and traversal.

## Boundaries & Constraints

**Always:**
- The category param is `workbench-url.ts`'s to define, read and write, exactly as `mode` and `settings` are — one builder (`surfaceHref`) assembles the whole query, and one narrowing function rejects an untrusted value.
- The category param is DELETED when Settings is closed OR the category is `DEFAULT_SETTINGS_CATEGORY`, the same rule the `settings` flag follows for its closed state — so the ordinary URL is the short one and `surfaceHref` stays a fixed point on its own output.
- A category pick writes the URL with `replaceState`, never `pushState`: DW-512 shows a Back-contract change needs its own recorded decision, and DW-514 asks only that the address bar and the announcement agree.
- The mount seed's extra entry is conditional on `readSettingsFromSearch` being true. A load with Settings closed keeps today's single `replaceState` and today's Back contract.
- Query param POSITION survives: compute both seed hrefs from the pre-seed `window.location` so a `/?settings=1` link still normalizes to `?settings=1&mode=…` rather than being reordered by the two-step write.
- Every history call stays inside the existing `try {} catch {}` degrade — a `SecurityError` costs the linkable URL and nothing else.
- Restores stay silent: the mount seed announces nothing and moves no focus, category included.

**Block If:** Nothing. The three decisions are recorded in the bundle; the param name and the push/replace choice are settled in Design Notes.

**Never:**
- Do not put the tree tab, the collapse flag, the selection or the column widths in the URL — the `workbench-url.ts` header's exclusion list keeps all four, and only the category leaves it.
- Do not add a stored (localStorage) Settings preference of any kind, category included.
- Do not introduce `router.push`, `<Link>`, `useRouter` or `useSearchParams` into `Workbench.tsx` (`workbench-chrome.test.ts` bans them).
- Do not change the rail-close focus behaviour (it must still leave the keyboard on the control that was pressed) or make the mount restore bump focus.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `surfaceHref` with default category | `at("?mode=chat")`, `"chat"`, open, `DEFAULT_SETTINGS_CATEGORY` | `/?mode=chat&settings=1` — no category param | No error expected |
| `surfaceHref` with a non-default category | `at("?mode=chat")`, `"chat"`, open, `"about"` | `/?mode=chat&settings=1&category=about` | No error expected |
| `surfaceHref` with Settings closed | any location, closed, `"about"` | category param DELETED alongside the flag | No error expected |
| `readSettingsCategoryFromSearch` | `"?category=about"` | `"about"` | Absent, empty or unknown → `null` |
| Deep-linked `?settings=1` load | fresh tab, stored mode `wiki` | Settings open, `history.length` +1, address bar unchanged in content, nothing announced, focus untouched | History throws → surface still restored |
| Back from that deep link | the seeded pair | Settings closes onto the mode the link named, app not left | No error expected |
| Back with focus on the rail | Settings open, focus on a rail button | Surface changes; focus STAYS on the rail button | No error expected |
| Back with focus in the canvas | Settings open, focus on `#wb-canvas` | Surface changes; focus lands on the new `#wb-canvas` | No error expected |
| Category pick | Settings open on General, "About" clicked | URL gains `category=about`, `history.length` unchanged, "About" announced | History throws → pane still moves |
| Traversal onto an entry naming a category | Back onto `?mode=wiki&settings=1&category=about` | Surface opens on About and announces About | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-url.ts` -- the rules. Header documents the two params and lists the category among the deliberate exclusions (`:36-40`) — that paragraph is the one that must move, not be deleted. `WORKBENCH_MODE_PARAM`/`WORKBENCH_SETTINGS_PARAM`/`SETTINGS_ON` constants; `readSettingsFromSearch` is the narrowing pattern to copy; `surfaceHref(loc, mode, settingsOpen)` is the ONE query builder and is idempotent by construction.
- `src/lib/workbench-settings.ts` -- `SettingsCategoryId` union (`:48-56`), `SETTINGS_CATEGORIES` (`:83`), `DEFAULT_SETTINGS_CATEGORY` (`:99`), `settingsCategory`, `settingsAnnouncement`. Has NO `isSettingsCategoryId` yet; add one here, modelled verbatim on `isWorkbenchModeId` in `src/lib/workbench-modes.ts:106-111` (a module-level `ReadonlySet` of ids + a type guard).
- `src/components/workbench/Workbench.tsx` -- the shell.
  - `:228-231` `settingsOpen` / `settingsCategoryId` `useState`; `:339-340` `settingsCategoryIdRef` mirrors the category for listeners registered once.
  - `:425-536` the mount effect. `:445` pins the literal `initialMode(window.location.search, readStoredMode())` (`workbench-chrome.test.ts:234`) — keep it byte-identical. `:456-489` the seed and its `try/catch`; the long comment at `:465-475` concedes DW-512 verbatim and must be rewritten, not left standing.
  - `:696-724` `applySurface(next, settings)` — announces from `settingsCategoryIdRef.current` at `:713`; `:737-763` `pushSurface`; `:766-772` `selectMode`; `:783-819` the `popstate` listener (guard at `:812`, `movedSettings`/`bumpCanvasFocus` at `:814-815`); `:832-856` `toggleSettings`; `:907-917` `openSettings`; `:925-928` `selectSettingsCategory`; `:1015-1016` `applyArtifactNavigation`'s `applySurface("wiki", false)` + `pushSurface("wiki", false)` pair.
  - `:1503-1536` the focus effect keyed on `canvasFocusNonce`; `document.getElementById(CANVAS_ID)?.focus()` at `:1535`. Its `:1526-1529` comment explains why THAT effect is deliberately not keyed on `document.activeElement` — the new sampling belongs in the popstate handler, not here, and that comment stays true.
  - `CANVAS_ID` is imported at `:117` from `./ModeCanvas`; whichever section is on screen carries it (the hidden one gives it up), so `getElementById(CANVAS_ID)` names the surface about to be swapped.
- `src/components/workbench/SettingsNav.tsx` -- rows are real `<button>`s carrying `item.label` and `aria-current="page"`; `onSelect` is `selectSettingsCategory`.
- `src/lib/__tests__/workbench-url.test.ts` -- node-env suite that EXECUTES the rules. `at(search, pathname, hash)` helper; `surfaceHref` is called with 3 args throughout (`:160-300`), so the new parameter must be optional-with-default or every call site breaks. `"names the param once"` cases at `:75` and `:155` are the pattern for pinning the new key.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- the mounted suite. Helpers: `renderShell`, `railItem`, `current`, `announced`, `settingsShowing`, `landingSite`, `traverse`, `SETTINGS_ANNOUNCEMENT`. **Three cases change**: `:395` "restores an open Settings surface from a deep link, silently" and `:422` "honours a settings flag that carries no mode…" both assert `history.length === before` and must become `before + 1` with re-written comments; `:606` "puts the mode and the Settings surface in the URL, and nothing else" pins the exclusion list in prose and now has a third thing in the URL. Cases at `:337`, `:360`, `:450`, `:478`, `:498`, `:555` must stay green unchanged.
- `src/lib/__tests__/workbench-chrome.test.ts:151-152, 234` -- source-scan pins on `window.history.pushState(`, `window.history.replaceState(`, `window.addEventListener("popstate", onPopState)` and the `initialMode(...)` call literal. All four must survive the edit.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` -- add a module-level `ReadonlySet` of `SETTINGS_CATEGORIES` ids and export `isSettingsCategoryId(value: unknown): value is SettingsCategoryId`, mirroring `isWorkbenchModeId` -- a query param is exactly as untrusted as a hand-edited storage value, and the vocabulary module is where the union lives.
- `src/lib/workbench-url.ts` -- export `WORKBENCH_SETTINGS_CATEGORY_PARAM = "category"` and `readSettingsCategoryFromSearch(search): SettingsCategoryId | null`; widen `surfaceHref` with an optional fourth `category: SettingsCategoryId = DEFAULT_SETTINGS_CATEGORY` that is written only when `settingsOpen && category !== DEFAULT_SETTINGS_CATEGORY` and DELETED otherwise -- one builder still assembles the whole query, and the delete rule keeps the fixed point. Move the "NOR IS THE SETTINGS CATEGORY" paragraph out of the exclusion list and rewrite the header to state the three params and why the category is the one position-inside-a-surface that earned a place.
- `src/components/workbench/Workbench.tsx` (mount seed) -- read the category alongside the flag, restore it only when the surface is open, and split the seed into `replaceState` of the Settings-CLOSED href followed by `pushState` of the open one when `readSettingsFromSearch` was true; compute BOTH hrefs from the pre-seed `window.location` -- the replace gives the deep link something behind it and the push is the entry Back consumes, while pre-computing preserves param position. Replace the `:465-475` concession comment with what the seed now does and why the mode's Back contract changed for this one case.
- `src/components/workbench/Workbench.tsx` (popstate) -- read the category from the entry, include it in the skip guard alongside the mode/flag pair, pass it into `applySurface`, and sample `document.getElementById(CANVAS_ID)?.contains(document.activeElement) ?? false` BEFORE `applySurface` so the bump fires only when it is true and the flag moved -- the rail-close path already leaves focus with the control that owns it, and this makes the traversal path symmetric.
- `src/components/workbench/Workbench.tsx` (surface writers) -- give `applySurface` and `pushSurface` an optional trailing `category` defaulting to `settingsCategoryIdRef.current`, announce from that argument rather than the ref, thread it through `surfaceHref`, and add a `replaceState` sibling used by `selectSettingsCategory` so a pane pick rewrites the entry in place -- callers that never touch Settings keep their two-argument spelling and no new history entry appears for a pane.
- `src/lib/__tests__/workbench-url.test.ts` -- cover the I/O matrix rows for the new param: the key's one spelling, the reader's absent/empty/unknown collapse to `null`, the write-when-non-default and delete-when-default-or-closed branches, the round trip through its own reader, and idempotence with a non-default category in play.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- re-pin `:395` and `:422` to `before + 1` and add: Back out of a deep-linked `?settings=1` closes the surface instead of leaving; a traversal that moves the flag with focus on a rail button leaves that button focused; a category pick writes the param without adding an entry; and a traversal onto an entry carrying a category reopens that pane and announces it. Update `:606`'s prose so the URL's contents are stated correctly.

**Acceptance Criteria:**
- Given a load where `readSettingsFromSearch` is false, when the shell mounts, then exactly one `replaceState` runs and `history.length` is unchanged.
- Given the shell was rendered on a `?settings=1` link and Settings is showing, when the rail's Settings control is clicked to close it, then the URL keeps the mode the link named and the keyboard stays on that control.
- Given a category was picked and then a mode was picked from Settings, when Back is pressed, then Settings reopens on the picked category with that category's announcement.
- Given `window.history.replaceState` throws, when the shell mounts on a `?settings=1` link, then the surface, the restored row and `setMounted(true)` all still happen.

## Design Notes

**Why `category` and why replace, not push.** The param key is `category`; `settings` already scopes it, so `settings-category` would restate the scope in the key. A pick uses `replaceState` because DW-512 is the recorded decision that a Back-contract change is a decision — DW-514 asks only that the address bar and the announcement agree, and pushing per pane would silently add a second contract change nobody recorded. Under replace, no two adjacent entries can differ by category alone, so the widened `popstate` guard is defensive rather than load-bearing; include it anyway so a future pusher is not silently swallowed.

**The seed, both hrefs from the pre-seed location:**

```ts
const beneath = surfaceHref(window.location, restoredMode, false);
const seeded = surfaceHref(window.location, restoredMode, restoredSettings, restoredCategory);
if (beneath !== locationHref(window.location)) window.history.replaceState(null, "", beneath);
if (restoredSettings) window.history.pushState(null, "", seeded);
```

Computed before either write, `/?settings=1` still seeds to `?settings=1&mode=lint` — recomputing `seeded` from the replaced location would reorder it to `?mode=lint&settings=1` and break a pin for no gain. When `restoredSettings` is false, `beneath === seeded` and this is byte-for-byte today's behaviour.

**The bump, sampled in the handler:**

```ts
const movedSettings = settings !== settingsOpenRef.current;
const hadCanvas = document.getElementById(CANVAS_ID)?.contains(document.activeElement) ?? false;
applySurface(next, settings, category);
if (movedSettings && hadCanvas) bumpCanvasFocus();
```

`contains` is true for the node itself, which is what the existing cases rely on: every path that opens Settings already bumps focus onto `#wb-canvas`, so a Back out of it still lands the keyboard. The sampling has to be in the handler, not in `bumpCanvasFocus` or the nonce effect — by the time the effect runs the canvas has already been swapped, and the effect's own comment explains why it must not read `activeElement`.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-url.test.ts src/lib/__tests__/workbench-chrome.test.ts src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- expected: all pass, including the three re-pinned cases and the new ones.
- `pnpm vitest run src/components/workbench/__tests__ src/lib/__tests__` -- expected: no collateral failures in the settings, sheet, rail or hidden-withdrawal suites.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean; in particular every `surfaceHref`, `applySurface` and `pushSurface` call site still type-checks.
