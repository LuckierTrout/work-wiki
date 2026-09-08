---
title: 'Workbench client state and navigation (DW-26, DW-62, DW-283, DW-320)'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
baseline_revision: '1a6032831d223e41df5236673c362eda35a257fe'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      Opening the in-shell Settings surface still unmounts the whole mode canvas, so the Wiki
      subtree DW-26 keeps mounted across mode switches is destroyed — dialog, typed name and
      error — whenever Settings opens.
    evidence: |-
      `Workbench.tsx` renders `settingsOpen ? <SettingsCanvas …/> : <ModeCanvas …>{children}</ModeCanvas>`,
      so `children` (`WikiWorkbench`) leaves the tree when the rail's Settings control — or, since
      this change, `g s` — opens the surface. Pre-existing: the rail control has behaved this way
      since Story 1.9, and DW-26 names `ModeCanvas` and mode switching only. Closing it means
      deciding how `SettingsCanvas` keeps owning discard-on-leave for its own draft while no longer
      being the thing that unmounts the canvas beside it.
    location: >-
      src/components/workbench/Workbench.tsx (settingsOpen canvas swap)
    severity: medium
  - summary: >-
      Only `TimeoutError`/`AbortError` are treated as unconfirmed, so a dropped connection or a
      502/504 is reported as a known failure — with transport vocabulary — and no refresh runs.
    evidence: |-
      `writeFailure` returns `unconfirmed: true` for the two abort names and otherwise prefers
      `cause.message`. A mid-write network drop arrives as `TypeError: Failed to fetch` (Safari:
      `Load failed`) and a gateway timeout as `send`'s `Request failed (504)`; in both the server
      may have applied the write, so the owner is told it failed over something unknown, and the
      screen is not reconciled. `Failed to fetch` also reaches the owner verbatim, which
      `workbench-settings.ts` already calls transport vocabulary no copy table contains.
      Pre-existing shape: `failureMessage` classified these the same way before this change.
    location: >-
      src/lib/workbench-request.ts (writeFailure)
    severity: medium
  - summary: >-
      `WikiSwitcher`'s create, rename and delete confirms stay live after an unconfirmed write, so
      a retry can seed a duplicate wiki or paint a 404 over a delete that landed.
    evidence: |-
      The card holds its create door shut with `awaitingCreate` on the unconfirmed path; the
      switcher has no equivalent. `busy` is cleared in `finally`, the dialog stays open, and the
      confirm is pressable — over a POST that may have created the wiki (nothing enforces unique
      names) or a DELETE whose second attempt answers 404, which the switcher's own comment calls
      "a failure over an operation that in fact succeeded". Pre-existing: the retry window is the
      same one an aborted write has always left open; this change only renamed the message.
    location: >-
      src/components/workbench/WikiSwitcher.tsx (create, rename, remove)
    severity: medium
  - summary: >-
      `SettingsCanvas.save` and `PreviewColumn` carry their own deadlines and still report a blown
      one as a flat failure, which is the claim DW-283 says the client cannot make.
    evidence: |-
      Both arm their own `AbortSignal` rather than using `send` (each needs the controller), so
      neither reaches `writeFailure`. `SettingsCanvas.save` resolves an abort to
      `SETTINGS_SAVE_FAILED_COPY` ("Settings couldn’t be saved.") over a PUT the server may have
      applied — on the surface this change just made keyboard-reachable through `g s`. Out of
      DW-283's stated scope, which names `workbench-request.ts` and the wiki writes.
    location: >-
      src/components/workbench/SettingsCanvas.tsx (save), src/components/workbench/PreviewColumn.tsx
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The Workbench client loses owner state and reports outcomes it does not know: `ModeCanvas` returns a different subtree per mode so leaving Wiki UNMOUNTS `WikiWorkbench` and discards an open Create Wiki dialog with its typed name and error (DW-26); `g s` still `router.push`es to `/settings`, unmounting the whole shell where the rail control opens the in-shell surface (DW-62); a write cut off by the 15s client deadline is reported as a flat failure although the server may have applied it, with no refresh to reconcile (DW-283); and `WorkspacePurposeSettings.save()` writes state after its await with no unmount or supersede guard, unlike its own load path (DW-320).

**Approach:** Keep the Wiki canvas MOUNTED and hidden while another mode is active, with the dialogs' focus/scroll machinery standing down while off screen; give `g s` an in-shell action that opens the Settings surface on the mounted shell, keeping `/settings` only as the fallback for pages outside it; make the request helper report a deadline abort as an UNCONFIRMED outcome that every write call site surfaces as such and follows with `router.refresh()`; and give `save()` the same cancelled/superseded guard `load()` already has.

## Boundaries & Constraints

**Always:** One `#wb-canvas` and one `tabIndex={-1}` canvas on screen. A surface switch stays `useState` on the one mounted shell — never `router.push`, never a `<Link>` — inside the Workbench. Hidden canvas content stays out of the accessibility tree and out of the tab order, and an off-screen dialog holds neither the body scroll lock nor the Tab trap. Failure copy keeps its existing sentences verbatim for non-deadline failures (`Couldn’t create the wiki.` etc., curly apostrophes included). Frozen identifiers stay frozen (AGENTS.md).

**Block If:** the fix would require changing what `/settings` is or removing the route (DW-61 keeps it), or would require an owner-visible copy decision the ledger entries do not fix.

**Never:** Do not delete or redirect the `/settings` route. Do not make Settings a `WORKBENCH_MODES` entry. Do not lift the Create Wiki dialog's draft fields into the card, and do not close the dialog to hide it — `CreateWikiDialog` resets its fields on close, so closing it discards the typed name this change exists to keep. Do not make writes optimistic. Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mode switch with dialog open | Create Wiki dialog open with a typed name, owner clicks Chat then Wiki | Dialog is off screen in Chat and back on screen in Wiki with the same typed name and error | No error expected |
| Off-screen dialog inertness | Same, while Chat is showing | Dialog is not in the a11y tree, body scroll is unlocked, Tab is not trapped | No error expected |
| `g s` inside the shell | Workbench mounted, owner presses `g` then `s` | In-shell Settings surface opens on the same shell, announced; no route push | No error expected |
| `g s` outside the shell | Any page with no Workbench mounted | `router.push("/settings")` as before | No error expected |
| Write hits the deadline | `send` rejects with `TimeoutError`/`AbortError` | Message says the outcome could not be confirmed; `router.refresh()` fires | This IS the error path |
| Write fails for a stated reason | Route answers 4xx/5xx with `error` | That message, no refresh | Existing behavior kept |
| Save resolves after unmount | PUT settles after `WorkspacePurposeSettings` unmounts | No state write at all | No error expected |
| Save superseded by a newer save | Two PUTs in flight, older settles last | Only the newest answer is adopted, on screen and in `version` | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/ModeCanvas.tsx:40-91` -- returns the Wiki subtree OR the stub subtree; the unmount in DW-26. `CANVAS_ID` (`:38`) is the skip-link target and must stay unique.
- `src/components/workbench/Workbench.tsx:524-604` -- `applyMode` / `selectMode` / `toggleSettings`; `settingsOpen` state (`:173`) and `SettingsCanvas` swap (`:1045`). Settings is NOT a mode (`IconRail.tsx:135-150`).
- `src/hooks/useDialogA11y.ts:67-85,87-` -- both effects key on `open`: focus capture, `document.body.style.overflow` lock, focus restore, Tab trap. This is what must stand down while a dialog is off screen.
- `src/components/CreateWikiDialog.tsx:71-78` -- resets name/scenario/renamed on CLOSE, and returns `null` when `!open`. Hiding by flipping `open` would wipe the typed name.
- `src/hooks/useKeyboardShortcuts.ts:41-48,166-173` -- `SHORTCUTS` and the keydown dispatch (`router.push(match.route)`); `KeyboardShortcutsProvider` wraps the app in `src/components/ClientProviders.tsx:12`.
- `src/lib/workbench-request.ts:28-55` -- `REQUEST_TIMEOUT_MS`, `send`, `failureMessage` (maps aborts onto the caller's sentence — DW-283's defect).
- `src/components/WikiWorkbench.tsx:161-236` -- `create` / `applyTemplate` catch paths, `awaitingCreate` (`:92,147-149`), reset effect (`:131-136`).
- `src/components/workbench/WikiSwitcher.tsx:148-249` -- `switchWiki` / `create` / `rename` / `remove`, the other four `failureMessage` call sites DW-283 names.
- `src/components/WorkspacePurposeSettings.tsx:304-324,441-449,517-598` -- `cancelledRef`, `answerSeqRef`, the mount effect that sets/clears `cancelledRef`, and `save()` (guardless after its await).
- Tests: `src/lib/__tests__/keyboard-shortcuts.test.ts:102-105,196-206` (route pins to retarget), `src/lib/__tests__/workbench-request.test.ts:133-` (`failureMessage` suite), `src/lib/__tests__/workbench-left-column.test.ts:245-257` (source scan: components import the shared helper and declare no local copy), `src/components/__tests__/workspace-purpose-settings.test.tsx` (stub/`gate` idiom), `src/components/workbench/__tests__/workbench-mode-url.test.tsx` (mounted shell + rail idiom), `src/components/__tests__/create-wiki-flow.test.tsx`, `src/components/__tests__/wiki-switcher-lifecycle.test.tsx`.
- Read-only evidence: `_bmad-output/implementation-artifacts/deferred-work.md` is orchestrator-owned — do not edit. `llm-wiki.md` and `.github/` are protected.

## Tasks & Acceptance

**Execution:**
- `src/hooks/useSurfaceVisibility.ts` (new) -- add a client context publishing whether the surface a subtree renders into is on screen, defaulting to `true`, with a provider and a `useSurfaceVisible()` reader -- one signal both the canvas and the dialog hook can share without prop-drilling into a server-rendered child.
- `src/hooks/useDialogA11y.ts` -- arm both effects on `open && useSurfaceVisible()` instead of `open` -- an off-screen dialog must not hold the scroll lock or the Tab trap, and re-showing re-focuses it.
- `src/components/workbench/ModeCanvas.tsx` -- render the Wiki subtree in every mode inside one canvas `<section>`, wrapped in the visibility provider and `hidden` when Wiki is not active; render the stub subtree only when it is not; point `aria-labelledby` at whichever heading is showing -- hiding instead of unmounting is DW-26's fix, and one section keeps `CANVAS_ID` unique.
- `src/app/globals.css` -- add the `[hidden]` display rule for the new canvas wrapper class -- so no future layout rule can defeat the `hidden` attribute.
- `src/hooks/useKeyboardShortcuts.ts` -- add an optional `action` to `ShortcutDef`, a registry on the provider with a `useShortcutAction(id, handler)` hook, give `g s` `action: "open-settings"` (keeping `route: "/settings"` as the no-handler fallback), and run a registered action instead of the route -- the keyboard path must reach the in-shell surface, and pages outside the shell keep a working shortcut.
- `src/components/workbench/Workbench.tsx` -- register `open-settings` to open (idempotently, not toggle) the Settings surface, announcing it exactly as the rail path does -- `g s` reads as "go to Settings", so pressing it twice must not close the surface.
- `src/lib/workbench-request.ts` -- replace `failureMessage` with `writeFailure(cause, action)` returning `{ message, unconfirmed }`, where a deadline abort is `unconfirmed` with a sentence naming the unknown outcome and non-deadline failures keep `Couldn’t ${action}.` / the server's message -- one owner for the verdict rather than a per-caller guess.
- `src/components/WikiWorkbench.tsx` -- adopt `writeFailure` in `create` and `applyTemplate`; on `unconfirmed`, show the sentence, call `router.refresh()`, and (for create) hold `awaitingCreate` so the empty state cannot seed a duplicate -- a write that may have landed must reconcile the screen.
- `src/components/workbench/WikiSwitcher.tsx` -- adopt `writeFailure` in `switchWiki`, `create`, `rename` and `remove` with the same unconfirmed handling -- DW-283 states the fix belongs to both halves.
- `src/components/WorkspacePurposeSettings.tsx` -- capture the answer token after `save()` bumps `answerSeqRef`, and gate every post-await state write (success, catch, and the `setSaving(false)` in `finally`) on `!cancelledRef.current` and a still-current token -- the load path's guard, applied to the write path.
- `src/lib/__tests__/workbench-request.test.ts` -- retarget the `failureMessage` suite onto `writeFailure`: both abort flavours report `unconfirmed` with the unknown-outcome sentence, a server message wins, and a bare failure falls back to `Couldn’t ${action}.`
- `src/lib/__tests__/keyboard-shortcuts.test.ts` -- retarget the two `g s` pins onto the in-shell action while keeping the route fallback assertion.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` (new) -- mount the shell, open Create Wiki, type a name, switch to Chat and back; assert the dialog and its name survive, that it is out of the a11y tree and the body scroll unlocked while hidden, and that the canvas still has exactly one `#wb-canvas`.
- `src/components/workbench/__tests__/settings-shortcut.test.tsx` (new) -- press `g` then `s` on the mounted shell inside `KeyboardShortcutsProvider`; assert the Settings surface opens and announces, `router.push` is never called, and a second press leaves it open.
- `src/components/__tests__/create-wiki-flow.test.tsx` and `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- add the deadline case to one card write and one switcher write: the unconfirmed sentence is shown and `router.refresh()` is called.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- add the supersede case: two PUTs in flight, the older settling last, only the newest answer adopted; and an unmount-mid-PUT case that resolves late and writes nothing.
- `src/lib/__tests__/workspace-purpose-save-guard.test.ts` (new) -- source-scan pin that `save()`'s post-await writes sit behind the cancelled/superseded guard, which a mounted test cannot observe after unmount.

**Acceptance Criteria:**
- Given the Workbench with an open Create Wiki dialog holding a typed name and a shown error, when the owner switches to another mode and back to Wiki, then the dialog is on screen again with that same name and error, and no second `#wb-canvas` ever existed.
- Given the Workbench in a non-Wiki mode with that dialog open, when a screen reader or keyboard user traverses the page, then nothing from the Wiki canvas is reachable and `document.body.style.overflow` is not locked.
- Given the mounted Workbench, when the owner presses `g` then `s`, then the in-shell Settings surface opens with the same announcement the rail control produces and no navigation occurs.
- Given a page with no Workbench mounted, when the owner presses `g` then `s`, then the app still navigates to `/settings`.
- Given a card or switcher write whose request is cut off by the client deadline, when the catch path runs, then the owner is told the outcome could not be confirmed and `router.refresh()` reconciles the screen.
- Given `WorkspacePurposeSettings` unmounted or a newer save started while a PUT is in flight, when that PUT resolves, then its answer is not adopted and `saving` is not cleared by it.

## Spec Change Log

- **Implementation, 2026-08-21 — `useDialogA11y` restores focus on CLOSE, not on hide.** The Execution note says only "arm both effects on `open && useSurfaceVisible()`". Taken literally, the first effect's teardown then runs when the surface goes off screen and calls `opener.focus()` — and the opener is inside the subtree that just went behind `hidden`, so the restore either no-ops (browsers, dropping the keyboard on `<body>`) or pulls focus into hidden content (jsdom). The teardown now reads `open` and the visibility flag through refs assigned in the render body — which hold the NEW values by the time React runs a cleanup — and skips the focus restore only in the "still open, merely hidden" case. Scroll unlock, listener removal and the unmount-while-open restore are unchanged.
- **Implementation, 2026-08-21 — the unconfirmed sentence.** The spec asks for "a sentence naming the unknown outcome" without fixing the words. `writeFailure` composes `The request to ${action} ran out of time before answering, so whether it went through is unknown. The screen has been refreshed with the current state.` from the same phrase as `Couldn’t ${action}.`, so the five call sites pass one phrase and neither sentence can drift from the other.
- **Implementation, 2026-08-21 — `ShortcutActionId` is a union, and `useShortcutAction` is a no-op with no provider.** The action id is `type ShortcutActionId = "open-settings"` rather than a bare `string`, so a `SHORTCUTS` entry and a registration cannot disagree by a typo — the one drift that would silently put `g s` back on `router.push`. And the hook returns without registering when no `KeyboardShortcutsProvider` is above it: several suites (and nothing in the app that needs a dispatcher) mount `Workbench` bare, and a hook that threw there would make the provider a hard dependency of the shell.
- **Implementation, 2026-08-21 — three source-scan pins outside the task list had to move with the behaviour.** `workbench-chrome.test.ts` counted TWO `id={CANVAS_ID}` and two `tabIndex={-1}` in `ModeCanvas.tsx` (one per branch); one section for both branches makes that one of each, which is what the Boundaries require. `create-wiki-ui.test.ts` counted two `router.refresh()` calls in `WikiWorkbench.tsx`; each of the two writes now has a success path and a deadline path, so it counts four. `workbench-left-column.test.ts`'s "no local copy of the helper" scan was retargeted from `failureMessage` to `writeFailure` and given the positive half (the consumers must CALL it).
- **Implementation, 2026-08-21 — the existing abort suites are retargeted, not supplemented.** `create-wiki-flow.test.tsx` and `wiki-switcher-lifecycle.test.tsx` already drove both abort flavours and asserted the flat `Couldn’t …` sentence with `refresh` NOT called — which is precisely the behaviour DW-283 removes. Those cases now assert the unconfirmed sentence and the refresh, rather than a second copy being added beside a pin that contradicts it. The switcher also gained the other half of the verdict: a route that answers 4xx with a reason is a KNOWN outcome and must not refresh.
- **Implementation, 2026-08-21 — `WikiWorkbench.create` holds `awaitingCreate` on the unconfirmed path.** Spelled in the Execution note and worth restating as a behaviour: the empty state behind the dialog still reads `No wiki yet.` with an enabled `Create Wiki`, and the POST may have seeded one. The door is held exactly as a succeeding create holds it, until a server render says what is there.
- **Review, 2026-08-21 — the unconfirmed sentence's second clause was removed.** The implementation entry above records the sentence as it was first written, ending "The screen has been refreshed with the current state." Review found that clause asserts a side effect `writeFailure` does not perform, and the patch replaced it with "Check what the screen shows before trying again." The composition rule (one phrase per call site, both sentences built from it) is unchanged.

## Review Triage Log

### 2026-08-21 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 5, low 0)
- defer: 4: (high 0, medium 4, low 0)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The comments justifying the in-shell `g s` claimed it avoids unmounting an open Create Wiki dialog. It does not — `settingsOpen` swaps `ModeCanvas` for `SettingsCanvas`, so either control unmounts the Wiki subtree. Every such claim in `useKeyboardShortcuts.ts`, `Workbench.openSettings`, `keyboard-shortcuts.test.ts` and `settings-shortcut.test.tsx` was reworded to state only what is true (the action avoids the ROUTE CHANGE, which unmounts the whole shell) and to say plainly that the mode canvas is swapped out either way and that DW-26's subtree survival covers mode switches only. No behaviour changed. The docblock spells the router call without its `(` token, because `workbench-chrome.test.ts` and `workbench-left-column.test.ts` ban that literal from the file.
  - `[medium]` `[patch]` `writeFailure` asserted a refresh it does not perform ("The screen has been refreshed with the current state."), in the past tense, while the refresh is each caller's `if (unconfirmed) router.refresh()`. The sentence now reads `The request to ${action} ran out of time before answering, so whether it went through is unknown. Check what the screen shows before trying again.`; `unconfirmed` and all five call-site refreshes are unchanged.
  - `[medium]` `[patch]` Three of the four new `WikiSwitcher` unconfirmed branches were unverified — deleting `router.refresh()` from `create`, `rename` and `remove` left the suite green. A new describe drives a client-deadline abort through the New Wiki POST, the Rename PATCH and the Delete DELETE for both abort flavours, asserting the unconfirmed sentence for that action and the refresh. Mutation-verified per line.
  - `[medium]` `[patch]` `useDialogA11y` lost the opener across a hide: the teardown promised to keep `openerRef` for the eventual close, but the re-arm reassigned it from `document.activeElement` — the rail button that hid the surface. The capture is now gated on `openerRecordedRef`, set on a true open and cleared only by the close teardown, and a round-trip case pins all three moments (focus stays on the rail at hide, lands in the dialog on re-show, returns to the original `Create Wiki` opener on close).
  - `[medium]` `[patch]` The conditional `finally` could strand `saving`: `if (current()) setSaving(false)` skipped the clear whenever `answerSeqRef` moved, and every `load` — a recheck included — moves it, so a recheck starting after `setSaving(true)` left the form disabled for the session. `saving` is now owned by a save-scoped `saveSeqRef` (`ownsSaving()` gates the `finally`) while the answer token still gates adoption; a mounted case enters the window deterministically and the scan pins the two-token shape.

Deferred this pass (recorded in frontmatter `deferred`): the Settings surface still unmounts the mode canvas; non-abort transport failures classified as known outcomes; the switcher's confirms staying live after an unconfirmed write; `SettingsCanvas`/`PreviewColumn` carrying their own deadline verdicts.

Rejected as noise or cosmetic: the CSS-regex test style and an `!important` on the hidden rule; harness duplication across the two new suites; `awaitingCreate` being lifted by an unrelated server render (pre-existing and documented); the unconfirmed-create door staying shut until a render lands (the open dialog holds the explanation, and a reload restores the button); the `g s` route fallback on pages with no shell (deliberate — DW-61 keeps `/settings`); the two `keyboard-shortcuts.test.ts` pins asserting that fallback alongside the new action; the `switch wiki` phrase reading tersely in the new frame (rewording it would move pinned failure copy); the unconfirmed sentence living in `workbench-request.ts` rather than a copy module (it IS the one owner); the action registry clobbering a live registration (its cleanup is already identity-guarded); a handler throwing inside the keydown listener; focus falling to `<body>` when a Back traversal hides a surface holding focus (unchanged from the pre-change unmount).

## Design Notes

Hiding, not closing: `CreateWikiDialog` resets its fields when `open` goes false, so hiding must leave `open` true and remove the subtree from view — hence a `hidden` wrapper plus a visibility signal that only the a11y hook reads:

```tsx
<section className="wb-canvas" id={CANVAS_ID} tabIndex={-1} aria-labelledby={wikiActive ? "wiki-workbench-heading" : headingId}>
  <SurfaceVisibilityProvider visible={wikiActive}>
    <div className="wb-canvas-mode" hidden={!wikiActive}>{children}</div>
  </SurfaceVisibilityProvider>
  {!wikiActive && <div className="wb-canvas-pad">…stub…</div>}
</section>
```

The stub subtree stays unmounted when Wiki is active: it holds no state, and rendering it would put a second "Wiki" heading in the DOM.

`writeFailure` takes ONE phrase per call site (`"create the wiki"`, `"apply the template"`, `"switch wiki"`, `"rename the wiki"`, `"delete the wiki"`) and composes both sentences from it, so today's failure copy is reproduced exactly rather than retyped beside a new one.

Only Wiki-mode state is preserved here. Opening the Settings surface still unmounts the whole mode canvas (`Workbench.tsx:1045`), and `SettingsCanvas` owning the discard-on-leave rule is why that swap is left alone; if that hole matters it belongs in a follow-up, not in this change.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-request.test.ts src/lib/__tests__/keyboard-shortcuts.test.ts src/lib/__tests__/workspace-purpose-save-guard.test.ts` -- expected: pass
- `pnpm vitest run src/components/workbench/__tests__ src/components/__tests__` -- expected: pass
- `pnpm test` -- expected: the whole suite passes, including the source scans in `workbench-left-column.test.ts` and `brand-copy.test.ts`
- `pnpm lint` -- expected: no new errors
- `pnpm exec tsc --noEmit` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** Four deferred-work items on the Workbench client, all owner-state or
outcome-truth defects. The Wiki canvas is now rendered in every mode and hidden when another mode
is active, so an open Create Wiki dialog keeps its typed name and error across a mode switch
(DW-26), with a surface-visibility signal that makes an off-screen dialog release the body scroll
lock and the Tab trap. `g s` no longer routes out of the shell: it runs a registered in-shell
action that opens the Settings surface on the one mounted shell, with `/settings` kept only as the
fallback where no shell is mounted (DW-62). A write cut off by the 15s client deadline is now
reported as an outcome nobody knows and followed by `router.refresh()` at all six write call sites
(DW-283). And `WorkspacePurposeSettings.save()` gained the unmount/supersede guard its load path
already had, with the `saving` flag owned by a save-scoped token (DW-320).

**Files changed**

- `src/hooks/useSurfaceVisibility.ts` (new) -- publishes whether the surface a subtree renders into is on screen; defaults to `true` everywhere no provider exists.
- `src/components/workbench/ModeCanvas.tsx` -- one canvas `<section>`; the Wiki subtree renders in every mode behind `hidden`, the stub branch stays conditional, `aria-labelledby` follows whichever heading is showing.
- `src/hooks/useDialogA11y.ts` -- both effects arm on `open && surface visible`; the hide teardown skips the focus restore and keeps the recorded opener for the eventual close.
- `src/app/globals.css` -- `.wb-canvas-mode[hidden] { display: none }`, outside every media query.
- `src/hooks/useKeyboardShortcuts.ts` -- optional `action` on `ShortcutDef`, an identity-guarded action registry on the provider, `useShortcutAction`, and dispatch that prefers a registered handler over the route.
- `src/components/workbench/Workbench.tsx` -- registers `open-settings`, opening (not toggling) the Settings surface with the rail control's announcement.
- `src/lib/workbench-request.ts` -- `failureMessage` replaced by `writeFailure(cause, action)` returning `{ message, unconfirmed }`, both sentences composed from one phrase per call site.
- `src/components/WikiWorkbench.tsx` -- both writes adopt the verdict; an unconfirmed create refreshes and holds `awaitingCreate`.
- `src/components/workbench/WikiSwitcher.tsx` -- all four writes adopt the verdict and refresh on an unconfirmed outcome.
- `src/components/WorkspacePurposeSettings.tsx` -- captured answer token gates adoption; a save-scoped token owns `saving`.
- Tests: `wiki-canvas-persistence.test.tsx`, `settings-shortcut.test.tsx`, `workspace-purpose-save-guard.test.ts` (all new); deadline and guard cases added to `create-wiki-flow.test.tsx`, `wiki-switcher-lifecycle.test.tsx`, `workspace-purpose-settings.test.tsx`; retargeted pins in `workbench-request.test.ts`, `keyboard-shortcuts.test.ts`, `workbench-chrome.test.ts`, `create-wiki-ui.test.ts`, `workbench-left-column.test.ts`.

**Review findings breakdown.** 5 patches applied (all medium), 4 items deferred (all medium, in
frontmatter `deferred`), 11 rejected. No intent gaps and no spec repairs; one review pass.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 5, low 0 —
score `3 × 5 + 1 × 0 = 15`, which is 5 or more.

**Verification.** `npx vitest run` — 263 files, 5719 tests, all passing. `npx tsc --noEmit` — clean.
`npx eslint` — exit 0 (only the three pre-existing `jsx-ast-utils` parser notices). Every row of the
I/O & Edge-Case Matrix is covered by a test that ran in that pass: mode-switch persistence and
off-screen inertness by `wiki-canvas-persistence.test.tsx`; `g s` inside and outside the shell by
`settings-shortcut.test.tsx`; the deadline and stated-failure rows by `workbench-request.test.ts`
plus the mounted abort cases in `create-wiki-flow.test.tsx` and `wiki-switcher-lifecycle.test.tsx`;
the unmount and supersede rows by `workspace-purpose-settings.test.tsx` with the source-scan pin in
`workspace-purpose-save-guard.test.ts`. The three unconfirmed switcher branches and both new guards
were mutation-verified.

**Residual risks.**

- Opening the Settings surface still unmounts the mode canvas, so `g s` and the rail control both
  discard an open Create Wiki dialog. Deferred, with the reasoning recorded in `deferred`.
- The unmount half of DW-320 is unobservable in jsdom (React silently drops a state update aimed at
  an unmounted tree), so it is held by a source-scan pin plus the mounted supersede case rather than
  by a direct behavioural assertion.
- `hidden` is enforced by one stylesheet rule pinned with a regex over `globals.css`; a reflow or a
  wrapping at-rule could make that pin fail for reasons unrelated to the invariant.
- Coverage limit inherited from the mounted suites: the router is mocked, so "no route change" is
  observed as `push` never being called, not as App Router behaviour.
