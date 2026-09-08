---
title: 'One honest story for a workbench write whose outcome is unknown'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      WikiWorkbench's CreateWikiDialog confirm stays live on its own unconfirmed
      path, so a second press seeds a duplicate wiki.
    evidence: |-
      `awaitingCreate` gates only the empty-state `Create Wiki` opener, which sits
      BEHIND the open overlay; `WikiWorkbench.create` guards on `readOnly` and
      `busy` only, and the dialog is passed no `confirmDisabled`. On the
      unconfirmed path the dialog deliberately stays open with `busy` cleared in
      `finally`, so both the pointer path and CreateWikiDialog.submit's Enter path
      are live over a POST that may already have created the wiki — nothing
      enforces unique names. This is the exact defect DW-375 closed in the header,
      still open in the card; DW-375's own text asserts the card is already
      covered, which is why it was scoped to the switcher. The `confirmDisabled`
      prop this story added to CreateWikiDialog makes it a one-line fix.
      `create-wiki-flow.test.tsx` currently asserts the opposite (the confirm is
      enabled after an unconfirmed create), so that assertion has to move too.
    location: >-
      src/components/WikiWorkbench.tsx (create, and its CreateWikiDialog mount)
    severity: medium
  - summary: >-
      saveWorkbenchSettings parses a 2xx body with a bare `await response.json()`,
      so an unparseable 200 is reported as a failed save over a patch the route
      accepted.
    evidence: |-
      The success path at src/lib/workbench-settings.ts:2074 has no `.catch()`,
      unlike every refusal-body parse in the same file. A truncated or HTML 200
      throws SyntaxError into the outer catch, where the verdict is the fixed
      fallback with `unconfirmed: false` — the surface tells the owner the save
      failed while the route answered 2xx, and keeps a version the write
      superseded, so the next save is refused as a 412 conflict with an actor that
      does not exist. Pre-existing shape, unchanged by this story: the same throw
      reached the same fallback before the classifier was widened. The parsed-but-
      shapeless case beside it is already handled as a KNOWN error deliberately;
      only the throwing case is inconsistent.
    location: >-
      src/lib/workbench-settings.ts:2074
    severity: medium
  - summary: >-
      WikiSwitcher.switchWiki starts no latch on an unconfirmed switch, so a
      second PUT can be issued over a first whose outcome is unknown.
    evidence: |-
      `switchWiki` guards only on `switching`, which `finally` clears, and the
      `<select>` is live again the moment the unconfirmed sentence appears. Two
      PUTs to /api/wikis/current can then settle out of order, leaving the active
      wiki — which decides which schema.md every prompt executes — set by whichever
      answer landed last. DW-375 names only create, rename and delete, and a
      `<select>` has no confirm to latch, so this needs its own decision about what
      the right affordance is (roll the picker back and hold it, or leave it live
      because a switch is idempotent per target).
    location: >-
      src/components/workbench/WikiSwitcher.tsx (switchWiki)
    severity: low
baseline_revision: 'f2d22becfe7d59f45c9f3b94a0f9ac4675e4a0fe'
---

<intent-contract>

## Intent

**Problem:** `writeFailure` (src/lib/workbench-request.ts:84-99) calls only `TimeoutError`/`AbortError` unconfirmed, so a dropped connection (`TypeError: Failed to fetch`) and a 502/504 reach the owner as a *known* failure — in transport vocabulary no Copy table contains — and no reconciliation runs (DW-374). `WikiSwitcher`'s create/rename/remove leave the dialog open with a live confirm after an unconfirmed write, so a retry can seed a duplicate wiki or paint a 404 over a delete that landed (DW-375). `SettingsCanvas.save`, `PreviewColumn.save` and `PreviewColumn.confirmRevert` arm their own `AbortSignal` and never reach the classifier at all, so a blown deadline is reported as a flat "couldn't" — the claim DW-283 says the client is in no position to make (DW-376).

**Approach:** Widen the shared classifier in `workbench-request.ts` to call transport failures and gateway statuses (502/503/504) unconfirmed, speaking ONE unconfirmed sentence for every surface; latch `WikiSwitcher`'s three confirms while an unconfirmed write is outstanding, released by the arriving server render (the `awaitingCreate` idiom `WikiWorkbench` already uses); and route the resolve-style write clients in `workbench-preview.ts` and `workbench-settings.ts` through that same classifier so their callers get `unconfirmed` and reconcile.

## Boundaries & Constraints

**Always:**
- ONE owner for the verdict and ONE unconfirmed sentence: `src/lib/workbench-request.ts`. No surface composes its own.
- A thrown cause's message NEVER reaches the owner on the preview/settings paths — those helpers relay only a server-supplied `{ error }`, exactly as their docblocks state today.
- `unconfirmed` means the write may have landed: the caller must reconcile (refresh, re-list, or drop the precondition it now cannot trust) and must never claim the write failed.
- A failed save keeps every edit on screen; the latch must never disable Cancel, Esc, or the outside-click dismiss.
- Curly apostrophes in copy, matching the existing Copy table.

**Block If:** the change would require inventing a reconciliation the surface does not already have wired (a new fetch path, a new route, or a new global refresh).

**Never:**
- Do not widen `unconfirmed` to 4xx or to a plain 500 — those are the route's own verdict, arrived and answered.
- Do not touch the READ helpers (`fetchPreview`, `fetchWorkbenchSettings`, `fetchArtifactRevisions`, `fetchArtifactRevision`): a read has no outcome to be unknown about.
- Do not change `WikiWorkbench`'s create/template paths or `WikiSwitcher.switchWiki`'s behaviour beyond what the widened classifier gives them for free.
- Do not re-seed a draft or payload from the server on an unconfirmed save.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deadline fired | `writeFailure(Error{name:"TimeoutError"}, "create the wiki")` | `unconfirmed: true`; message names the action, not the mechanism | n/a |
| Connection dropped | `writeFailure(new TypeError("Failed to fetch"), "rename the wiki")` | `unconfirmed: true`; the shared sentence; `Failed to fetch` never appears | n/a |
| Gateway gave up | `send` non-ok 502/503/504 → `RequestFailedError` | `unconfirmed: true`; the shared sentence replaces `Request failed (504)` | n/a |
| Route refused | `writeFailure(new Error("Wiki name is required."), …)` | `{ message: "Wiki name is required.", unconfirmed: false }` | n/a |
| Bad 2xx shape | caller throws `new Error("Couldn’t create the wiki.")` | `unconfirmed: false` — the server answered | n/a |
| Non-Error / empty | `"boom"`, `undefined`, `new Error("")` | `Couldn’t {action}.`, `unconfirmed: false` | n/a |
| Refusal that arrived | `savePreviewBody` gets 409 `{error:"…"}` | `{ status:"error", message:"…", unconfirmed:false }` | server sentence relayed |
| Refusal from a gateway | `savePreviewBody` gets 504 | `{ status:"error", message: shared sentence, unconfirmed:true }` | body ignored |
| Transport throw | `saveWorkbenchSettings`'s fetch rejects with `TypeError` | `{ status:"error", message: shared sentence, unconfirmed:true }` | cause's message discarded |
| Switcher latched | create/rename/remove answered unconfirmed | dialog stays open, confirm dead, Cancel/Esc live | latch released by the next server render |

</intent-contract>

## Code Map

- `src/lib/workbench-request.ts` -- THE classifier. `send` (l.30-42) throws a bare `Error` on non-ok, discarding the status; `writeFailure` (l.81-102) checks only the two abort names. `WriteFailure.unconfirmed`'s docstring (l.48-56) says "The deadline fired" and must widen with the rule.
- `src/lib/__tests__/workbench-request.test.ts` -- exercises `send` against a stubbed fetch and `writeFailure` against synthetic causes. Aborts are built with `Object.assign(new Error(msg), { name })`, NOT `DOMException` (jsdom's does not extend Error). No test freezes the unconfirmed sentence verbatim — they assert it contains "unknown" and the action, and not the mechanism.
- `src/components/workbench/WikiSwitcher.tsx` -- `create` (l.173-206), `rename` (l.208-235), `remove` (l.237-274) each `setBusy(false)` in `finally` and leave the dialog open on the unconfirmed path. `busy` reaches the dialogs as the `busy` prop, which also kills Cancel and Esc — so the latch must ride `confirmDisabled`, not `busy`. Existing effects at l.134-146 show the "clear on a new server render" idiom.
- `src/components/WikiWorkbench.tsx` -- the model to copy: `awaitingCreate` (l.92), released by `useEffect(… , [wikis, currentWikiId])` (l.147-149), set on both the success and unconfirmed paths (l.188, l.210).
- `src/components/ConfirmDialog.tsx` -- already has `confirmDisabled` (l.97: `disabled={busy || confirmDisabled}`). No change needed.
- `src/components/CreateWikiDialog.tsx` -- has NO `confirmDisabled`. Submit is `disabled={busy || !name.trim()}` (l.178) and `submit()` guards only `busy` (l.85-89) — the Enter path. Both need the new prop.
- `src/lib/workbench-preview.ts` -- `savePreviewBody` (l.1239-1291): non-ok relays `served || fallback`, `catch` returns `fallback`. `revertArtifactRevision` (l.1517-1540): same shape via `refusalSentence`. `PreviewSaveResult`/`ArtifactRevertResult` (l.1208, l.1353) are the error shapes to widen. `previewEditCopy` (l.852-865) is where the per-target action phrase belongs, beside `saveFallback`. Leave `fetchArtifactRevisions`/`fetchArtifactRevision` alone.
- `src/lib/workbench-settings.ts` -- `saveWorkbenchSettings` (l.1991-2032) and `SettingsSaveResult` (l.1974). `SETTINGS_SAVE_FAILED_COPY` at l.192. Leave `fetchWorkbenchSettings` alone.
- `src/components/workbench/SettingsCanvas.tsx` -- `save` (l.169-208): arms `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`, reads `payloadRef.current?.version` as `If-Match`, and on error only `setSaveError`. `payloadRef` is assigned during render (l.130-132). The docblock at l.184-198 already argues that clearing an unknowable version is the truthful move — the same argument applies here.
- `src/components/workbench/PreviewColumn.tsx` -- `save` (l.658-746): `editingVersionRef.current` is the `If-Match` seed; `requestDataVersionCheck()` (imported l.15, used l.732) is the wired reconciliation signal. `confirmRevert` (l.860-919): `loadRevisions(file)` (l.777-790) is the panel's re-read. The read effect at l.402-411 uses `PREVIEW_TIMEOUT_REASON` — out of scope.
- `src/lib/__tests__/workbench-preview.test.ts` (~l.2242-3010) and `src/lib/__tests__/workbench-settings.test.ts` (~l.2852-2915) -- assert error results with `toEqual({ status: "error", message: … })`; a required new field means updating each of those.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx`, `create-wiki-flow.test.tsx`, `dialog-busy-gate.test.tsx` -- mounted suites over the switcher and the dialogs.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-request.ts` -- Add `RequestFailedError extends Error` carrying `status`, and throw it from `send` (message unchanged). Add `UNCONFIRMED_STATUSES` (502, 503, 504) with `unconfirmedStatus()`, `unconfirmedCause()`, and `unconfirmedWriteMessage(action)` — the ONE sentence, widened past "ran out of time" so it is true of a timeout, a dropped connection and a gateway alike. Rewrite `writeFailure` on top of them, and add `thrownWriteFailure(cause, action, fallback)` and `refusedWriteFailure(status, served, action, fallback)` for the resolve-style clients (a thrown cause's message is never relayed there). Widen `WriteFailure.unconfirmed`'s docstring and the module header. -- One owner for the verdict; the whole of DW-374.
- `src/lib/__tests__/workbench-request.test.ts` -- Cover the matrix rows above: both abort names, a `TypeError`, each of 502/503/504 through `send`, a 4xx and a 500 staying confirmed, the bad-2xx-shape throw staying confirmed, and both new entry points. -- The classification is the deliverable, so it must be executed rather than read.
- `src/components/CreateWikiDialog.tsx` -- Add a `confirmDisabled?: boolean` prop mirroring `ConfirmDialog`'s: applied to the submit button AND to `submit()`'s early return, so the Enter path cannot reach past a dead button. -- The latch needs a door on this dialog; `busy` cannot be it without taking Cancel and Esc with it.
- `src/components/workbench/WikiSwitcher.tsx` -- Add an `awaitingWrite` latch set by the unconfirmed branch of `create`, `rename` and `remove`; release it in a `useEffect` keyed on `[wikis, currentWikiId]` (a server render arrived, whatever it says); guard all three handlers with an early return; pass it into the three dialogs' `confirmDisabled` and into the rename input's Enter guard and `disabled`. -- DW-375.
- `src/lib/workbench-preview.ts` -- Add `saveAction` to `PreviewEditCopy` (page vs Schema) and a revert action constant. Give `savePreviewBody` an `action` option beside `fallback`; route its non-ok and `catch` branches through the shared helpers; widen `PreviewSaveResult`'s and `ArtifactRevertResult`'s error member with a required `unconfirmed: boolean`. Do the same for `revertArtifactRevision`. Leave the three read helpers untouched. -- Half of DW-376.
- `src/lib/workbench-settings.ts` -- Add a `SETTINGS_SAVE_ACTION` phrase and an `action` option to `saveWorkbenchSettings`; route its non-ok and `catch` branches through the shared helpers; widen `SettingsSaveResult`'s error member with a required `unconfirmed: boolean`. Leave `fetchWorkbenchSettings` untouched. -- Half of DW-376.
- `src/components/workbench/SettingsCanvas.tsx` -- On an unconfirmed save, keep every edit on screen and CLEAR the held `payload.version`, so the next save sends no `If-Match` and is refused as "could not be checked" (428) rather than clobbering, or being refused as a conflict with an actor that does not exist (412). -- The only reconciliation this surface has that does not lose the owner's edits.
- `src/components/workbench/PreviewColumn.tsx` -- On an unconfirmed save: keep the editor open, clear `editingVersionRef.current` for the same reason, and `requestDataVersionCheck()`. On an unconfirmed revert: `requestDataVersionCheck()` and re-run `loadRevisions(file)` — a landed revert added an entry, so the list is how the panel finds out. -- Both surfaces already have these signals wired.
- `src/lib/__tests__/workbench-preview.test.ts`, `src/lib/__tests__/workbench-settings.test.ts` -- Update the error-result assertions for the new field and add rows for a gateway status and a transport throw on each write helper. -- The result shape changed and the new branch is the point.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- Add a mounted case per operation: an unconfirmed write leaves the dialog open with the confirm dead and Cancel live, and a following server render brings the confirm back. -- DW-375's whole claim is about what the owner can press.

**Acceptance Criteria:**
- Given a workbench write that fails with a network `TypeError`, a 502, a 503, a 504, or an abort, when the classifier runs, then the owner reads one sentence that names the action, says the outcome is unknown, and contains no transport vocabulary — and the caller receives `unconfirmed: true`.
- Given a write refused by the route itself (any 4xx, or a 500 with a body), when the classifier runs, then the server's sentence is relayed unchanged and `unconfirmed` is false.
- Given `WikiSwitcher`'s create, rename or delete answered unconfirmed, when the owner looks at the open dialog, then the confirm is disabled while Cancel and Esc still work — and the confirm becomes live again only once a new server render has arrived.
- Given `SettingsCanvas.save` or `PreviewColumn.save` answered unconfirmed, when the owner looks at the surface, then every edit is still on screen, the message says the outcome is unknown, and the next save carries no stale `If-Match`.
- Given `PreviewColumn.confirmRevert` answered unconfirmed, when the panel settles, then the revision list has been re-read and the shell has been asked to re-check `dataVersion`.
- Given `pnpm test` and `pnpm lint`, when run, then both pass with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 4, low 2)
- defer: 3: (high 0, medium 2, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `UNCONFIRMED_STATUSES` included 503, but `PUT /api/settings` emits 503 itself as a definite refusal (`configUnreadable`, src/app/api/settings/route.ts:61) — the route's actionable sentence was discarded, the outcome called unknown, and the held version cleared for a write that provably did not land. Narrowed to `[502, 504]` (the pair the ledger named) with the real rule stated: 502/504 are answers no origin gave, 503 is a status this app's own routes emit as a verdict. Tests now iterate the constant and pin a 503 as `unconfirmed: false`.
  - `[medium]` `[patch]` The unconfirmed save did not invalidate the History cache, though the landed save calls `refreshHistoryRef.current()` and the unconfirmed revert re-lists on the same DW-59 ground. Added the call, with the reasoning stated once and the revert branch pointing at it.
  - `[medium]` `[patch]` The `awaitingWrite` latch survived dialog close while all three openers cleared the error unconditionally, so Esc-then-reopen showed a dead confirm with no sentence explaining it. The openers now keep the standing message while latched.
  - `[medium]` `[patch]` No executing component test covered any DW-376 reconciliation. Added cases to `settings-read-only.test.tsx`, `preview-dirty-guard.test.tsx` and `preview-revision-history.test.tsx` for the 504 and `TypeError` paths — the sentence, surviving edits, the dropped `If-Match`, the `dataVersion` nudge, the revert re-list and its ordering, and the post-await token re-check.
  - `[low]` `[patch]` The rename input was disabled while latched, contradicting the latch's own "the confirm ALONE" rule and dropping the field out of the tab order. Restored to `disabled={busy}`; the Enter guard stays and its test now asserts a live field.
  - `[low]` `[patch]` Docblock drift: `WikiSwitcher.switchWiki` and both `WikiWorkbench` handlers still named a fired deadline as the only way in. Reworded to the cause-neutral fact.

## Design Notes

Why 502/503/504 and nothing else: those answers come from a proxy that either never reached the route or never got its verdict, so the origin may have applied the write. A 4xx and a plain 500 are the route's OWN answer — it ran, it decided, and it said so; calling those unknown would send the owner to reconcile a screen that is already correct.

Why `RequestFailedError` rather than parsing `Request failed (504)`: the status is the fact, and a message is a rendering of it. Re-deriving the fact from the rendering is how the two come apart the first time somebody rewords the sentence.

Why `thrownWriteFailure` differs from `writeFailure` on relaying a cause's message: `send` throws the SERVER's sentence, so relaying it there is right. `savePreviewBody` and `saveWorkbenchSettings` return the server's sentence and only ever THROW on transport — so a thrown message there is `Failed to fetch`, which is exactly the vocabulary those docblocks already refuse.

Why the switcher's latch rides `confirmDisabled` and not `busy`: the unconfirmed sentence tells the owner to check what the screen shows, and `busy` would disable Cancel and swallow Esc, leaving them behind a modal they were just told to look past.

Not fixed here, and deliberately: `WikiWorkbench`'s `CreateWikiDialog` stays live on ITS unconfirmed path too — `awaitingCreate` gates only the empty-state opener behind the overlay, not the dialog's own Create. The new `confirmDisabled` prop makes that a one-line fix, but it is `WikiWorkbench`, which DW-375 does not name.

## Verification

**Commands:**
- `pnpm test` -- expected: the whole suite passes; the new `workbench-request`, `workbench-preview`, `workbench-settings` and `wiki-switcher-lifecycle` cases pass.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean; the widened result unions must have no unhandled construction site.

## Auto Run Result

Status: done

### What was implemented

One owner for the verdict on a workbench write whose outcome is unknown, and one sentence for it on every surface.

- **DW-374** — `send` now throws `RequestFailedError` carrying the HTTP status, so the classifier reads a fact rather than parsing `Request failed (504)`. `unconfirmedCause` admits both abort names, a `TypeError` (the only thing `fetch` rejects with on a dead connection), and a gateway status; `UNCONFIRMED_STATUSES` is `[502, 504]` — deliberately not 503, which this app's own routes emit as a definite refusal. `unconfirmedWriteMessage` is the one sentence, widened past "ran out of time" so it is true of a timeout, a dropped connection and a gateway alike, and containing no transport vocabulary.
- **DW-375** — `WikiSwitcher` holds an `awaitingWrite` latch through create, rename and delete, released by the next server render. It rides `confirmDisabled` (a new prop on `CreateWikiDialog`, matching `ConfirmDialog`'s), never `busy`, so Cancel, Esc and the backdrop stay live — the sentence sends the owner to look at the screen, so the modal must be dismissible. Both ways in are guarded: the button and the Enter path.
- **DW-376** — `savePreviewBody`, `revertArtifactRevision` and `saveWorkbenchSettings` route their non-ok and thrown branches through `refusedWriteFailure`/`thrownWriteFailure` and return a required `unconfirmed: boolean`. Their callers reconcile with what each surface already has wired: the held `If-Match` version is cleared (an unconfirmed write may have superseded it, so the next save is honestly refused as 428 rather than as a 412 conflict with an actor that does not exist), `requestDataVersionCheck()` is nudged, and the revision list is re-read.

### Files changed

- `src/lib/workbench-request.ts` — `RequestFailedError`, `UNCONFIRMED_STATUSES`, `unconfirmedStatus`, `unconfirmedCause`, `unconfirmedWriteMessage`, `thrownWriteFailure`, `refusedWriteFailure`; `writeFailure` rebuilt on them.
- `src/lib/workbench-preview.ts` — action phrases and `PreviewEditCopy.saveAction`; `savePreviewBody` and `revertArtifactRevision` classified; error results widened.
- `src/lib/workbench-settings.ts` — `SETTINGS_SAVE_ACTION`; `saveWorkbenchSettings` classified; error result widened.
- `src/components/CreateWikiDialog.tsx` — `confirmDisabled` prop, applied to the button and to the Enter path.
- `src/components/workbench/WikiSwitcher.tsx` — the `awaitingWrite` latch and its release effect.
- `src/components/workbench/PreviewColumn.tsx` — unconfirmed handling for the save and the revert.
- `src/components/workbench/SettingsCanvas.tsx` — unconfirmed handling for the save.
- `src/components/WikiWorkbench.tsx` — cause-neutral comments only.
- Tests: `workbench-request.test.ts`, `workbench-preview.test.ts`, `workbench-settings.test.ts`, `workbench-left-column.test.ts`, `wiki-schema-edit.test.ts`, `wiki-switcher-lifecycle.test.tsx`, `create-wiki-flow.test.tsx`, `settings-read-only.test.tsx`, `preview-dirty-guard.test.tsx`, `preview-revision-history.test.tsx`.

### Review findings breakdown

- Patches applied: 6 (medium 4, low 2)
- Items deferred: 3 (medium 2, low 1) — see frontmatter `deferred`
- Items rejected: 10 (all low) — an over-broad `TypeError` rule whose trigger no write route in this repo can produce and whose direction is the safe one; focus landing on `<body>` when the pressed confirm goes dead (the `useDialogA11y` Tab trap pulls it back, and `busy` has always done the same); 408/425/429; the unconfirmed sentence not being a `*_COPY` export; `RequestFailedError.message` still carrying `Request failed (n)` as its fallback; the action phrases staying inline at their call sites; source-text regex brittleness in `workbench-left-column.test.ts`; the revert branch's unconsumed body on the gateway path; the copy telling the owner to check the screen while the retry is latched; and an import-ordering nit.
- Follow-up review recommended: **true** — patched high 0, medium 4, low 2; score `3×4 + 1×2 = 14`, which is ≥ 5.

### Verification

- `./node_modules/.bin/vitest run` — 270 files, 6046 tests, all pass.
- `./node_modules/.bin/eslint` — exit 0.
- `./node_modules/.bin/tsc --noEmit` — exit 0.
- Every I/O matrix row is covered by a case that ran and passed. The new coverage was mutation-checked rather than trusted green: removing the save's history invalidation fails 3 cases, setting the revert sentence before the re-list fails 2, widening the status set back to 503 fails 4, clearing the openers' errors unconditionally fails 3, and disabling the rename input fails 1.
- `pnpm test` / `pnpm exec` do not run in this checkout (`ERR packages field missing or empty`); the vitest, eslint and tsc binaries were invoked directly.

### Residual risks

- `unconfirmedCause` treats any `TypeError` as transport. Inside the resolve-style clients the `try` also spans `JSON.stringify` and header construction, and a 200 whose body is literal `null` would make a caller's own destructure throw one. No write route in this repo produces either, and the direction of the error is the safe one (reconcile rather than claim failure); narrowing by message would reintroduce exactly the string coupling `RequestFailedError` exists to remove.
- The latch releases on any server render, including an unrelated one (a `DataVersionWatcher` poll). That is deliberate — a refresh answering "nothing changed" must still give the owner their button back — but it means the door can reopen before the create/rename/delete ambiguity is settled. The opposite failure, a confirm dead for the rest of the session, was judged worse.
- Clearing the held version on an unconfirmed save is honest but one-way: nothing re-arms it, so the next save is refused as 428 until the owner reloads, which loses unsaved edits. Neither surface has a re-read that preserves a draft, so there was no better reconciliation available to write.
