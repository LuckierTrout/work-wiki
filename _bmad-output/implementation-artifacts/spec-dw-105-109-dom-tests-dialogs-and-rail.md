---
title: 'DOM tests: dialogs and rail (DW-105, DW-106, DW-107, DW-109)'
type: 'chore'
created: '2026-08-19'
baseline_revision: '29ccc44964f47224a291dbf315183a7f2d390485'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `ConfirmDialog`'s `busy` gate is pinned at one consumer only — `WikiSwitcher`'s Rename and
      Delete confirms reach the same gate with nothing asserting it.
    evidence: |-
      `dialog-busy-gate.test.tsx` drives the gate through `WikiWorkbench` (template overwrite and
      create), which is enough to fail on a dropped `disabled={busy}`. But `rename()` and `remove()`
      in `WikiSwitcher.tsx` have no handler-level `if (busy) return` behind the button's `disabled`,
      unlike `CreateWikiDialog.submit`. Delete is the irreversible one, and a double-submit there is
      exactly the failure DW-107 describes.
    location: >-
      src/components/workbench/WikiSwitcher.tsx:236
    severity: medium
  - summary: >-
      Only `create()`'s `!wiki?.id` malformed-2xx guard is tested; the identical guards in
      `applyTemplate`, `rename` and `remove` are not.
    evidence: |-
      `create-wiki-flow.test.tsx` now answers `create` with `{}` and 200 and asserts the message
      rather than a blank render. `applyTemplate` (WikiWorkbench.tsx:121) and `rename`/`remove`
      (WikiSwitcher.tsx:225, :244) carry the same guard against the same failure — a 2xx whose body
      is not the documented shape — and deleting any of them leaves the suite green.
    location: >-
      src/components/WikiWorkbench.tsx:121
    severity: low
  - summary: >-
      `IconRail`'s "exactly one `aria-current` control" rule and its mode-select callbacks have no
      mounted pin.
    evidence: |-
      `icon-rail.test.tsx` mounts the rail with `settingsActive: false` throughout and passes inert
      stubs for `onSelect`/`onToggleSettings`, so a rail that marked both a mode and Settings current
      (the case the component's own comment forbids: "two current controls would describe two
      surfaces the owner cannot both be looking at"), or wired every mode button to the same id,
      passes. Rail ORDER is likewise unasserted, though UX-DR3 fixes the ten modes top to bottom.
    location: >-
      src/components/workbench/IconRail.tsx:101
    severity: low
  - summary: >-
      `Workbench`'s `aria-live="polite"` mode announcement — the OTHER live region — is still
      pinned only by source scan.
    evidence: |-
      DW-109's "live-region announcement" resolved to `IconRail`'s `role="status"` sidecar dot, which
      is now mounted. `Workbench.tsx`'s own `<p className="wb-sr-only" aria-live="polite">` and its
      interesting half — a RESTORED mode must not be announced, only a changed one — remain covered
      by `workbench-chrome.test.ts` greps for `useState("")` and `setAnnouncement(...)`.
    location: >-
      src/components/workbench/Workbench.tsx:1095
    severity: low
---

<intent-contract>

## Intent

**Problem:** The jsdom project added by `spec-dom-test-environment.md` is still unspent on four surfaces that only a mounted test can observe: `useDialogA11y` (Esc, the `<select>` carve-out, the Tab trap and pull-back, the scroll lock, `fallbackFocusRef`) has no mounted coverage at all; `IconRail` is touched by no test; `WikiWorkbench`'s `create()` failure and malformed-2xx branches and the degraded `unavailable` render are unpinned, as is `switchWiki`'s re-entry guard; and nothing clicks a destructive confirm twice, so deleting `disabled={busy}` from `ConfirmDialog` would double-apply a template overwrite with the suite green.

**Approach:** Add three mounted suites (`useDialogA11y`, `IconRail`, the `busy` gate) and extend two existing ones (`create-wiki-flow`, `wiki-switcher-lifecycle`), driving the real components and asserting on rendered DOM, `document.activeElement`, `document.body.style.overflow` and issued requests. Test files only — no `src/` behaviour changes.

## Boundaries & Constraints

**Always:**
- Assertions observe the outermost surface: rendered DOM, focus, body style, and the requests the component issues. No `readFile` + `toContain` over source text in the new or extended cases.
- Every new file is `*.test.tsx` under a `__tests__` directory, so `vitest.config.ts`'s DOM include collects it (an uncollected suite is indistinguishable from a passing one, and the config throws on a miss).
- Each suite's own `afterEach` calls `cleanup()` as its FIRST statement, before `vi.unstubAllGlobals()` / `vi.useRealTimers()` — vitest runs `afterEach` in reverse registration order, so the setup file's backstop lands last.
- Components that call `useRouter()` are mounted behind one hoisted `vi.mock("next/navigation", …)` with a single stable router object.
- Where the intent names a surface that has since moved, cover it where it now lives and say so: `switchWiki` is in `src/components/workbench/WikiSwitcher.tsx`, not `WikiWorkbench` (DW-33 retired the canvas copy).
- Where a named surface already has a mounted case, do not restate it — add the case that is actually missing (see Design Notes).

**Block If:**
- A new assertion can only be made green by changing a file under `src/` — that would mean the behaviour the ledger describes does not exist, which is a finding, not a test.

**Never:**
- Change any file under `src/` other than adding/extending `.test.tsx` files. No component, hook or lib edits.
- Change `vitest.config.ts`, `vitest.setup.ts` or `vitest.setup.dom.ts`. The existing shims are sufficient; a new shim would need its own fidelity argument.
- Delete, rewrite or weaken any existing suite, including the source-scan suites (`create-wiki-ui.test.ts`, `workbench-chrome.test.ts`) — several of their assertions cover CSS and file structure a mounted test cannot replace.
- Add a testing dependency (no jest-dom): `toBeDisabled` and friends are not available; assert on `.disabled` and attributes directly, as the existing suites do.
- Touch `.github/` or the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Esc inside a dialog | Template confirm open, focus in the dialog | Dialog closes; a bubble-phase `keydown` listener on `document` never fires (one overlay level) | No error expected |
| Esc from an open `<select>` | Same dialog, event target is the scenario `<select>` | Dialog stays open; the event is NOT prevented | No error expected |
| Tab off the last control | Focus on the dialog's last focusable | Focus wraps to the first; the press is prevented | No error expected |
| Shift+Tab off the first control / the container | Focus on first focusable, or on the dialog container | Focus moves to the last focusable; press prevented | No error expected |
| Tab while focus has drifted outside | Focus on a button behind the overlay | Focus is pulled to the dialog's first focusable (last, with Shift); press prevented | No error expected |
| Tab with nothing focusable inside | Dialog whose body has no focusable descendant | Press prevented; focus stays on the dialog container | No error expected |
| Dialog opens / closes | `document.body.style.overflow` was `scroll` | `hidden` while open; restored to `scroll` on close | No error expected |
| Close with the opener still mounted | Opened from a button that survives | Focus returns to that button | No error expected |
| Close with the opener unmounted | Create Wiki confirmed from the empty state | Focus lands on the canvas heading (`fallbackFocusRef`), not `<body>` | No error expected |
| Double-click Overwrite | Template confirm, first POST unsettled | Exactly ONE `POST …/template`; confirm reads `Working…`; Cancel disabled; Esc and backdrop refused | No error expected |
| Double-submit Create | Create dialog, first POST unsettled | Exactly ONE `POST /api/wikis`; submit reads `Creating…`; Cancel, name and scenario cards disabled; Esc refused | No error expected |
| `create()` fails | `POST /api/wikis` answers 409 with a message | Dialog stays open, message rendered inside it, empty state intact, no `router.refresh()` | Message shown in-dialog |
| `create()` answers 2xx with no wiki | `{ }` body, `ok: true` | `Couldn’t create the wiki.` inside the dialog; no crash, no blank canvas, no refresh | Guarded, not thrown |
| Registry read failed | `unavailable`, even with wikis and a current id | Read-failure alert only; no `No wiki yet.`, no Create Wiki, no wiki card | Alert is `role="alert"` |
| Second switch while one is in flight | Two `change` events before the first PUT settles | Exactly ONE `PUT /api/wikis/current`; a switch after it settles issues a second | Re-entry refused |
| Switch times out | `fetch` rejects with a `TimeoutError` | Alert reads `Couldn’t switch wiki.`, not the mechanism's own message | Fallback sentence |
| Rail badge at 0 vs > 0 | `todoCount` 0, then 3 | No pill and the plain label at 0; pill `3` (`aria-hidden`) and `Todos, 3 todo candidates` at 3 | No error expected |
| Sidecar dot | `unknown` / `up` / `down` | Live region text `Checking sidecar` / `Sidecar running` / `Sidecar not running`; `wb-status--live` only on `up` | No error expected |
| Collapse chevron | `collapsed` false, then clicked in the real shell | Label and `title` flip, `aria-expanded` flips, `aria-controls` names the left column; the shell's `data-collapsed` flips | No error expected |

</intent-contract>

## Code Map

- `src/hooks/useDialogA11y.ts` -- the subject of DW-105. Effect at 68-85 (opener capture, `document.body.style.overflow` lock/restore, `fallbackRef.current?.current?.focus()` when `opener?.isConnected` is false); keydown effect at 87-128, registered on `document` in CAPTURE phase — Escape returns early for an `HTMLSelectElement` target (94), otherwise `preventDefault` + `stopPropagation` and dismiss unless `busyRef.current`; Tab branches at 100-124 cover no-focusables, the outside pull-back, and both wraps. `focusables()` (42) is the selector the wrap points come from.
- `src/components/ConfirmDialog.tsx` -- real consumer: `cancel` is gated on `busy` (53-55), confirm button is `disabled={busy || confirmDisabled}` and reads `Working…` while busy (93-100), Cancel is `disabled={busy}` (90), backdrop dismiss is `onMouseDown` on the overlay (68-70) — the mouse event that must be used, not `click`.
- `src/components/CreateWikiDialog.tsx` -- the other consumer: `submit` returns early while `busy` (85-89), submit button reads `Creating…` and is `disabled={busy || !name.trim()}` (178-180), name input and the five scenario cards are `disabled={busy}` (126, 145).
- `src/components/WikiWorkbench.tsx` -- `create()` at 86-110 (the `!wiki?.id` guard at 97 and the `catch` at 105); `unavailable` branch at 148-157; `headingRef` (72) is the `fallbackFocusRef` both dialogs receive; the template `ConfirmDialog` at 224-277 carries a `<select id="wiki-workbench-template">` inside its body — the only real dialog with a native select, so it is the carve-out's natural host.
- `src/components/workbench/WikiSwitcher.tsx` -- where `switchWiki` actually lives now (176-190): `if (switching) return` re-entry guard, optimistic `setPendingId`, rollback `setPendingId(null)` in the catch, `setSwitching(false)` in `finally`. `failureMessage` (96-102) maps `TimeoutError`/`AbortError` onto the caller's sentence. `send()` (77-89) arms `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`.
- `src/components/workbench/IconRail.tsx` -- DW-109's subject: `showBadge = Boolean(noun) && count > 0` (95) with `badgeAccessibleName` on the label (97), the badge pill `aria-hidden` (113-117), the `role="status"` live region whose visible content (not an `aria-label`) carries `sidecarLabel` (127-133), `wb-status--live` only when `sidecar === "up"` (78, 129), and the chevron's `title`/`aria-label`/`aria-expanded`/`aria-controls` (153-165).
- `src/lib/workbench-modes.ts` -- `WORKBENCH_MODES`, `BADGE_MODE_NOUNS` (`todos` → `todo candidates`, `review` → `pending reviews`) and `badgeAccessibleName` — import them rather than retyping the strings.
- `src/components/workbench/Workbench.tsx` -- `toggleCollapsed` (591-595) writes through `writeStoredCollapsed`; the shell publishes `data-collapsed` (902) and mounts `IconRail` at 925-938. Needed only for the one shell-level collapse case.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx` -- the harness convention to copy for shell mounts: hoisted router mock, `WorkbenchData` literal, `fetch` stubbed to `{ ok: true }` so `useSidecarStatus` settles, `await act(async () => {})` after render.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- extend. Has `answer()`, `button()`, `openTemplateDialog()`, the percent-encoding-sensitive `WIKI` id, and the `afterEach` ordering comment; reuse them rather than re-deriving.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- extend, in its existing `an in-flight switch` describe. Already has a deferred-resolution `fetch` harness for in-flight cases.
- `vitest.setup.dom.ts` -- read-only. Provides `setMediaQuery`, `resetMediaQueries`, `setVisibilityState`, `fireVisibilityChange`, and the `offsetParent` / `getClientRects` / `scrollIntoView` shims. Imported through the relative ladder (`../../../../vitest.setup.dom`) as the existing suites do.
- `vitest.config.ts` -- read-only. Throws at config load if a `.test.tsx` sits outside `src/**/__tests__/**`.

## Tasks & Acceptance

**Execution:**
- `src/hooks/__tests__/useDialogA11y.test.tsx` (new) -- mount `ConfirmDialog` (with a `<select>` and two buttons in its body) plus a tiny no-focusables harness; cover Esc + one-level dismissal, the `<select>` carve-out, both Tab wraps, the outside pull-back, the empty-focusables branch, the overflow lock/restore, opener restore, and `fallbackFocusRef` via the real `WikiWorkbench` create flow -- DW-105; every branch of the hook driven through a real consumer rather than grepped.
- `src/components/workbench/__tests__/icon-rail.test.tsx` (new) -- mount `IconRail` directly for badge 0 vs > 0 (both badge modes and one un-badged mode), the three sidecar states and their live-region CONTENT, and the chevron's labels/`aria-expanded`/`aria-controls`/callback; plus one mount of the real shell asserting a chevron click flips `.wb-shell`'s `data-collapsed` -- DW-109; the component no test touches today.
- `src/components/__tests__/dialog-busy-gate.test.tsx` (new) -- drive both dialogs from `WikiWorkbench` against a deferred `fetch`; double-click `Overwrite` and double-submit `Create`, asserting exactly one request each, the mid-flight labels, and that Cancel, Esc and the backdrop are all refused until it settles -- DW-107; deleting `disabled={busy}` must fail the suite instead of double-applying a destructive write.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- extend with `create()`'s catch, the `!wiki?.id` malformed-2xx guard, and an `unavailable` render that also carries wikis and a current id -- DW-106's `WikiWorkbench` half.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- extend the `an in-flight switch` describe with the `if (switching) return` re-entry guard (two changes → one PUT; a third after settle → a second PUT) and the `TimeoutError` → fallback-sentence mapping -- DW-106's `switchWiki` half, at the file it moved to.

**Acceptance Criteria:**
- Given the repo after this change, when `pnpm test` runs, then both projects pass and every pre-existing suite reports the same result as before (234 DOM tests today, all passing).
- Given each new assertion, when the behaviour it names is broken in `src/` (drop `disabled={busy}`, drop the `HTMLSelectElement` early return, drop `count > 0`, drop `if (switching) return`, drop the `!wiki?.id` guard), then at least one test fails — and no test needed a `src/` change to pass in the first place.
- Given `pnpm lint` and `npx tsc --noEmit`, when they run over the new and extended files, then neither reports an error.
- Given a DOM-project run, when it finishes, then the output carries no React `act(...)` warning and no unhandled rejection.

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 3, low 1)
- defer: 4: (high 0, medium 1, low 3)
- reject: 42: (high 0, medium 0, low 42)
- addressed_findings:
  - `[medium]` `[patch]` The switch-timeout test's `new DOMException(..., "TimeoutError")` fixture is
    NOT `instanceof Error` in this jsdom environment (probed directly), so `failureMessage` never
    reached the name check it claimed to pin — deleting `WikiSwitcher.tsx:98` left the whole suite
    green. Replaced with `Object.assign(new Error(msg), { name })` and driven over both `TimeoutError`
    and `AbortError`, since one line maps both.
  - `[medium]` `[patch]` Nothing asserted the `busy` gate ever LIFTS: every release in
    `dialog-busy-gate.test.tsx` was a success, so removing `finally { setBusy(false) }` from either
    `create()` or `applyTemplate()` left 4927 tests green while stranding the owner in a locked
    dialog. Added a failure-release test per dialog asserting the controls come back, a retry
    reaches the route, and the dialog can be dismissed; corrected the two comments that claimed this
    without testing it.
  - `[medium]` `[patch]` `useDialogA11y`'s own `busy` refusal was unpinned — both real consumers
    guard independently in their `cancel`, so making line 97 unconditional left the suite green.
    `BareHost` now takes a `busy` prop (the harness for branches no real dialog reaches) and pins the
    hook's branch; the misattributing comment in `dialog-busy-gate.test.tsx` was rewritten.
  - `[low]` `[patch]` `icon-rail.test.tsx`'s docblock overclaimed twice ("every label and noun is
    IMPORTED", "the component no test touched"). Both sentences corrected to say what is actually
    imported, why the sidecar sentences cannot be, and that it is IconRail's own rules that were
    unasserted.

## Design Notes

Two of DW-106's four named surfaces already have mounted cases, and restating them would add no signal. `switchWiki`'s rollback is pinned by `wiki-canvas-duplication.test.tsx:385` ("keeps the live wiki selected"), and the degraded `unavailable` render by the same file at 473. What is left, and what this pass adds: the re-entry guard, the timeout mapping, `create()`'s catch, the malformed-2xx guard, and an `unavailable` render that is degraded *despite* having wikis to show — the case the shell-level test cannot make because it feeds the flag and an empty list together.

The busy gate needs a `fetch` whose promise the test resolves by hand, so both clicks land while the first request is still in flight:

```tsx
let release!: (value: Response) => void;
fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
fireEvent.click(button("Overwrite"));
fireEvent.click(screen.getByRole("button", { name: "Working…" })); // second press
expect(fetchMock).toHaveBeenCalledTimes(1);
await act(async () => release(answer({ wiki: WIKI })));
```

The confirm's accessible name CHANGES to `Working…` while busy, so the second press must be located by that name — re-querying `Overwrite` throws instead of asserting.

For the `<select>` carve-out, dispatch Escape with the select as the event target (`fireEvent.keyDown(select, { key: "Escape" })`) and assert both that the dialog survives and that the event was not prevented; `fireEvent` returns `false` only when a cancelable event was prevented, which is the half that distinguishes the carve-out from a dismiss that happens to be ignored.

## Verification

**Commands:**
- `npx vitest run --project dom` -- expected: all suites pass; the new files appear in the report; no `act(...)` warning in the output.
- `pnpm test` -- expected: both `node` and `dom` projects pass, with the node project's counts unchanged.
- `npx tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: no errors.
- `git diff --name-only` -- expected: only `.test.tsx` files under `src/**/__tests__/` plus this spec.

## Auto Run Result

Status: done

**Implemented change.** Spent the jsdom project on the four surfaces DW-105/106/107/109 named. Test
files only — nothing under `src/` outside `__tests__`, no dependency and no vitest-config change. The
DOM project went from 234 to 269 tests; the full run is 4931 across both projects.

**Files changed**
- `src/hooks/__tests__/useDialogA11y.test.tsx` (new) — the hook's every branch through its real
  consumers plus a bare harness: container focus, scroll lock/restore, one-level Esc, the `<select>`
  carve-out, both Tab wraps, the container Shift+Tab, the outside pull-back both ways, the
  empty-focusables branch, the hook's own `busy` refusal, and both focus-restore paths.
- `src/components/workbench/__tests__/icon-rail.test.tsx` (new) — badge at 0 vs > 0 across both badge
  modes and every un-badged mode, the sidecar dot's three states asserted on live-region CONTENT, the
  chevron's labels/`aria-expanded`/`aria-controls`/callback, and one real-shell mount proving a
  chevron press moves `.wb-shell`'s `data-collapsed`.
- `src/components/__tests__/dialog-busy-gate.test.tsx` (new) — the `busy` gate on both dialogs against
  a hand-released `fetch`: one request per double-press, the mid-flight labels and disabled controls,
  Cancel/Esc/backdrop refused while in flight, and the gate lifting again on a FAILED write.
- `src/components/__tests__/create-wiki-flow.test.tsx` — `create()`'s catch, the `!wiki?.id`
  malformed-2xx guard, and an `unavailable` render that also carries wikis and a current id.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` — `switchWiki`'s `if (switching) return`
  re-entry guard (one PUT for two picks, a second once it settles) and `failureMessage`'s
  `TimeoutError`/`AbortError` mapping with the optimistic rollback.

**Review findings.** intent_gap 0, bad_spec 0, patch 4 (medium 3, low 1), defer 4 (medium 1, low 3),
reject 42. All four patches applied and independently mutation-checked; the four defers are recorded
in frontmatter `deferred`.

**Follow-up review recommended:** true. Patched severities: high 0, medium 3, low 1 →
3 × 3 + 1 × 1 = 10, which is ≥ 5.

**Verification.** `npx vitest run` — 239 files, 4931 tests, all passing (run twice, both green).
`npx vitest run --project dom` — 25 files, 269 tests, no `act(...)` warning, no unhandled rejection.
`npx tsc --noEmit` clean. `npx eslint` exit 0 (the three pre-existing `jsx-ast-utils`
`TSNonNullExpression` notices are unchanged from baseline). Every I/O-matrix row has a covering test
that ran and passed. Independently re-ran three mutations after the patch pass, restoring the tree
each time: dropping `WikiSwitcher.tsx:98` fails 2 tests, dropping `create()`'s
`finally { setBusy(false) }` fails 1, and making `useDialogA11y.ts:97` unconditional fails 1 — each
of which left the suite green before the patches. `pnpm test` / `pnpm lint` cannot run in this
environment (`ERROR packages field missing or empty`, a pre-existing local pnpm-workspace issue
unrelated to this change), so the same commands were run through `npx`.

**Residual risks.**
- The intent placed `switchWiki`'s cases in `WikiWorkbench`; DW-33 moved that function to
  `WikiSwitcher.tsx`, and `create-wiki-ui.test.ts:215` actively forbids its return to the canvas. The
  cases were therefore written against `WikiSwitcher`. The ledger entry's location line is stale.
- The re-entry-guard test relies on React dispatching `change` on a `disabled` `<select>`. That holds
  today (the mutation run produces two PUTs, proving the assertion is live), but a change in React's
  behaviour there would make it pass for the wrong reason.
- `getBoundingClientRect` is still jsdom's all-zeros, so a mounted shell measures `shellWidth === 0`.
  Nothing here touches width-derived behaviour, but the shell-level collapse test runs at that width.
