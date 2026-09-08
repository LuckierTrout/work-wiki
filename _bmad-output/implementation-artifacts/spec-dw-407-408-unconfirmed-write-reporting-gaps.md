---
title: 'Unconfirmed-write reporting gaps: latch the card''s Create confirm, stop reporting an unparseable 200 as a failed save'
type: 'bugfix'
created: '2026-08-22'
status: 'done'
baseline_revision: 'b7d5aea6e4d307a73f1ef43da3fcc24f18ce7e1c'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      DW-408's prescribed fix does not remove the harm its own ledger entry states: an
      unparseable 200 still answers `unconfirmed: false`, so the owner keeps a version the
      save superseded and the next save is refused as a 412 against an actor that does not
      exist.
    evidence: |-
      The intent prescribes landing the throwing parse on the existing shapeless-200 branch,
      which returns `{ status: "error", message: fallback, unconfirmed: false }`. But
      `SettingsCanvas.save` clears the held `version` ONLY inside `if (result.unconfirmed)`
      (src/components/workbench/SettingsCanvas.tsx:209-231), and its own comment there spells
      out the tie-break: a cleared version yields the truthful 428, a kept one yields 412's
      "somebody else changed this while you were editing". So the verdict the ledger entry
      names as the defect is the same verdict its prescribed fix produces. Verified by
      reverting the change: the whole settings suite, including the new DW-408 cases, passes
      against the unfixed source, because `SyntaxError` was never an `unconfirmedCause` and
      already reached the identical fallback through the outer catch. What the change does buy
      is that the arrived-answer verdict is now DECIDED on the shapeless-200 branch rather than
      coinciding with it by accident. Closing the stated harm needs a third verdict shape — a
      "landed but unreadable" result that clears the held version without claiming the outcome
      is unknown — which is an intent-level decision this bundle's intent prescribed against.
    location: >-
      src/lib/workbench-settings.ts:2143 and src/components/workbench/SettingsCanvas.tsx:209
    severity: medium
  - summary: >-
      No canvas-level test drives SettingsCanvas with a 2xx whose body read fails, so the
      DW-408 verdict is pinned only at the client's return value and never at the seam that
      acts on it.
    evidence: |-
      `settings-read-only.test.tsx`'s own docblock says the client-level suite "cannot see the
      seam this describe exists for: that the canvas ACTS on `unconfirmed` by clearing the
      version it is holding". Its UNCONFIRMED table carries a 504 (which never reaches a 2xx
      body parse) and a TypeError thrown from the fetch call itself; there is no `ok: true`
      case anywhere in the file whose `json` rejects. So what `If-Match` the NEXT save carries
      after an unparseable or dead-stream 200 is unobserved end to end.
    location: >-
      src/components/workbench/__tests__/settings-read-only.test.tsx:565-600
    severity: medium
  - summary: >-
      When the unconfirmed-write latch lifts with the dialog still open, the confirm comes back
      live underneath a now-stale "the outcome is unknown" alert, on both the card and the
      switcher.
    evidence: |-
      Both release effects do only `setAwaitingCreate(false)` / `setAwaitingWrite(false)` keyed
      on `[wikis, currentWikiId]` (src/components/WikiWorkbench.tsx:147-149,
      src/components/workbench/WikiSwitcher.tsx:182-184) and neither clears the error. The
      reset effect that would close the dialog keys on the ACTIVE wiki, which a refresh
      answering "nothing changed" need not move. WikiSwitcher.tsx:428's comment asserts the
      opposite — "The release effect drops both together, because a server render is what makes
      both stale at once" — so the intended behaviour is documented and not implemented.
      Pre-existing on both surfaces; DW-407 brings the card into the same shape rather than
      creating it.
    location: >-
      src/components/WikiWorkbench.tsx:147-149
    severity: medium
  - summary: >-
      Dismissing the card's create dialog on the unconfirmed path destroys the only explanation
      the owner has, and the disabled opener behind it says nothing.
    evidence: |-
      The unknown-outcome sentence lives inside the overlay, and the latch deliberately leaves
      Cancel and Esc live so the owner can go and look at the screen. After that dismissal the
      empty state offers a `Create Wiki` button that is `disabled`, carries no
      `aria-describedby`, and cannot be pressed to reopen the dialog and re-read the message —
      so a screen-reader user gets "dimmed" and nothing else, which is the exact failure mode
      the neighbouring read-only note exists to avoid. Pre-existing since `awaitingCreate`
      began covering the unconfirmed path; DW-407 does not widen it.
    location: >-
      src/components/WikiWorkbench.tsx:296-318
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two holes left by `spec-dw-374-375-376-unconfirmed-write-reporting`. (DW-407) `WikiWorkbench` mounts `CreateWikiDialog` with no `confirmDisabled` and `create` guards only `readOnly`/`busy` with `setBusy(false)` in `finally`, so on the unconfirmed path — where the dialog deliberately stays open — the confirm and its Enter path are both live over a POST that may already have seeded a wiki; nothing enforces unique wiki names, so a second press seeds a duplicate and moves every prompt onto its template. (DW-408) `saveWorkbenchSettings` parses its 2xx body with a bare `await response.json()`, unlike every refusal parse in the same file, so a truncated or HTML 200 throws `SyntaxError` into the outer catch and the owner is told the save failed over a patch the route accepted — while the version they hold is now stale, making the next save a 412 conflict against an actor that does not exist.

**Approach:** Apply DW-375's already-proven shape to the card: pass `confirmDisabled={awaitingCreate}` and put `awaitingCreate` alongside `busy` in `create`'s early return, exactly as `WikiSwitcher` does with `awaitingWrite`. In `workbench-settings.ts`, add `.catch(() => null)` to the success-path parse so a throwing body lands on the existing shapeless-200 branch (`unconfirmed: false`, the route answered) instead of the thrown-error fallback.

## Boundaries & Constraints

**Always:** The latch rides `confirmDisabled` and never `busy` — Cancel, Esc and the outside-click dismiss stay live, because the unconfirmed sentence tells the owner to go and look at the screen. The existing release effect (`setAwaitingCreate(false)` keyed on `wikis`/`currentWikiId`) is the only thing that lifts the latch; do not add a second release path. `.catch(() => null)` must route to the *existing* shapeless-200 branch — no new result shape, no new copy string.

**Block If:** The `confirmDisabled` prop no longer gates both `CreateWikiDialog`'s confirm button and its `submit` Enter path; or the shapeless-200 branch in `saveWorkbenchSettings` no longer exists to catch a `null` body.

**Never:** Do not touch `WikiSwitcher`, the template/`applyTemplate` confirm (idempotent per scenario — the card already says so), `fetchWorkbenchSettings`, or the deferred-work ledger. Do not make the card optimistic. Do not widen `busy`. Do not change any owner-facing copy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Card create, unconfirmed outcome | Empty state, `Create` pressed, POST rejects with `TimeoutError`/`AbortError` | Dialog stays open with the unknown-outcome alert inside it; `Create` is disabled; `Cancel` stays enabled and Esc still dismisses; `router.refresh()` fired | Second press (pointer or Enter) issues no further `/api/wikis` request |
| Card create, server render arrives | Latched as above, then a fresh `wikis` array is rendered through the provider | `Create` is enabled again | No error expected |
| Save settings, unparseable 200 | `PUT /api/settings` answers `ok: true, status: 200`, `response.json()` throws `SyntaxError` | `{ status: "error", message: fallback, unconfirmed: false }` — the arrived-but-shapeless verdict | Never the unconfirmed sentence, never a transport string |
| Save settings, parseable but shapeless 200 | `ok: true`, body `{ saved: true }` | Unchanged: same `unconfirmed: false` error | Unchanged |
| Save settings, transport throw | `send` rejects (abort / `TypeError`) | Unchanged: `unconfirmed: true`, the composed unknown-outcome sentence | Unchanged |

</intent-contract>

## Code Map

- `src/components/WikiWorkbench.tsx` -- the fix site. `awaitingCreate` state + docblock at :81-92 (docblock says "a create that SUCCEEDED" but :214 also sets it on the unconfirmed path — bring the wording in line). `create` at :160-220: guards `if (readOnly) return;` (:165) then `if (busy) return;` (:171); success sets `setAwaitingCreate(true)` (:186); the unconfirmed catch sets it again (:214); `finally { setBusy(false) }` (:217-219). Release effect at :147-149 keyed on `[wikis, currentWikiId]`. Empty-state opener already `disabled={awaitingCreate}` (:297) with an `if (awaitingCreate) return;` handler guard (:310) — that opener sits *behind* the overlay, which is why it is not the fix. `CreateWikiDialog` mount at :392-398 — no `confirmDisabled`.
- `src/components/workbench/WikiSwitcher.tsx` -- the reference implementation to mirror, not to change. `awaitingWrite` docblock :125-144, `if (busy || awaitingWrite) return;` at :221/:259/:291, `confirmDisabled={awaitingWrite}` at :521.
- `src/components/CreateWikiDialog.tsx` -- the prop already works: declared :45, defaulted :58, gates the Enter path in `submit` (`if (busy || confirmDisabled) return;` :103) and the confirm button (`disabled={busy || confirmDisabled || !name.trim()}` :197). READ-ONLY.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- the mounted surface for the card. The contradicting assertion is :495 (`await waitFor(() => expect(button("Create").disabled).toBe(false));`) inside `reports a create's outcome as unknown, and shuts the door, on a ${name}` (:479-503), with its comment at :494. `mount(wikis, currentWikiId)` (:66-76) returns the RTL render result, so `view.rerender(...)` with a fresh provider value simulates the arriving server render. `button(name)` helper at :103. `answer(body, {ok,status})` at :84.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- DW-375's mounted cases (:706-808): the shape to copy for both the latch case and the "gives the confirm back once a server render arrives" case.
- `src/lib/__tests__/workbench-left-column.test.ts` -- source scan that WILL BREAK: :314 asserts `card.match(/if \(busy\) return;/g)` has length 2 for `WikiWorkbench.tsx`. After the change it is 1 (`applyTemplate`), plus one `if (busy || awaitingCreate) return;` for `create`. The surrounding comment (:280-298) already explains why unreachable guards are pinned by a scan — extend it in the same voice.
- `src/lib/workbench-settings.ts` -- the fix site. `saveWorkbenchSettings` :2078-2134; refusal parse `(await response.json().catch(() => null))` at :2110; **success parse `const body: unknown = await response.json();` at :2122** — the bare one; shapeless-200 branch :2123-2128; outer catch :2129-2133. `workbenchSettingsFrom(null)` returns `null` (:719-723), so a `null` body falls straight into that branch. The docblock at :2074-2077 already states the shapeless-200 rule.
- `src/lib/__tests__/workbench-settings.test.ts` -- `stubFetch` helper :2733-2751 (its `json` cannot throw, so the new case needs a bare `SettingsFetch` literal). Existing neighbours: shapeless-200 :2925-2928, thrown/abort :2896-2922.

## Tasks & Acceptance

**Execution:**
- `src/components/WikiWorkbench.tsx` -- add `awaitingCreate` to `create`'s early return (`if (busy || awaitingCreate) return;`, replacing `if (busy) return;` at :171) and pass `confirmDisabled={awaitingCreate}` on the `CreateWikiDialog` mount (:392-398); update the `awaitingCreate` docblock so it covers the unconfirmed path as well as the successful one -- the confirm and its Enter path are the two live routes to a duplicate wiki, and `busy` is back to false while the dialog is still open.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- flip :495 to assert `Create` is DISABLED after an unconfirmed create, rewrite its comment (:494) to say why, add a press-does-nothing assertion on the fetch spy, an assertion that `Cancel` stays enabled and Esc still dismisses, and a new case that a fresh `wikis` array through `view.rerender` gives the confirm back -- the mounted surface is where the deliverable is observable.
- `src/lib/__tests__/workbench-left-column.test.ts` -- update the `WikiWorkbench.tsx` guard pin at :314 to expect one `if (busy) return;` and one `if (busy || awaitingCreate) return;`, extending the existing comment -- the handler guard is unreachable behind `confirmDisabled`, which is exactly what the scan exists for.
- `src/lib/workbench-settings.ts` -- change the success parse at :2122 to `await response.json().catch(() => null)` and note beside it that a throwing 2xx body is the ROUTE's arrived answer, not an unknown outcome -- so it lands on the shapeless-200 branch instead of the thrown fallback.
- `src/lib/__tests__/workbench-settings.test.ts` -- add a case beside the shapeless-200 test: a `SettingsFetch` returning `ok: true, status: 200` whose `json` rejects with a `SyntaxError` resolves to `{ status: "error", message: SETTINGS_SAVE_FAILED_COPY, unconfirmed: false }`, and assert `unconfirmed` is false explicitly -- the whole point is that the owner is not told the outcome is unknown over a patch the route accepted.

**Acceptance Criteria:**
- Given the card's empty state and a `Create` press whose POST never answers, when the unknown-outcome alert appears inside the still-open dialog, then the `Create` confirm is disabled, `Cancel` is enabled, Esc dismisses the dialog, and a further press issues no second `/api/wikis` request.
- Given that latched state, when a fresh `wikis` array arrives through the provider, then the `Create` confirm is enabled again.
- Given a successful create (2xx with a well-shaped `wiki`), when the dialog has closed and the refresh has not landed, then the empty state's `Create Wiki` opener stays disabled exactly as before this change.
- Given `PUT /api/settings` answering 200 with a body that fails to parse, when `saveWorkbenchSettings` resolves, then the result is the shapeless-200 error (`unconfirmed: false`, the fixed fallback sentence) and never the unknown-outcome sentence.
- Given a transport throw or an abort, when `saveWorkbenchSettings` resolves, then it still answers `unconfirmed: true` with the composed unknown-outcome sentence.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 1, medium 3, low 1)
- defer: 4: (high 0, medium 3, low 1)
- reject: 8: (high 0, medium 1, low 7)
- addressed_findings:
  - `[high]` `[patch]` `.catch(() => null)` on the success parse was too broad: an
    `AbortError`/`TimeoutError`/`TypeError` thrown from `response.json()` on a 200 flipped from
    `unconfirmed: true` to `unconfirmed: false`, contradicting this spec's I/O matrix row
    ("transport throw — Unchanged") and newly producing the stale-version/412 harm DW-408 names.
    Narrowed to `.catch(cause => { if (unconfirmedCause(cause)) throw cause; return null; })` so
    only a genuine parse failure lands on the shapeless-200 branch.
  - `[medium]` `[patch]` The comment above that parse argued its case backwards — it blamed
    `unconfirmed: true` for the 412, when `SettingsCanvas` clears the held version precisely on
    `unconfirmed: true` and keeps it on `false`. Rewritten in the consumer's actual direction.
  - `[medium]` `[patch]` The new body-read test pinned the wrong verdict (`unconfirmed: false`).
    Inverted to assert the three unconfirmed causes still answer `unconfirmed: true`, converted
    to `it.each` so a failure names which cause regressed, and the `SyntaxError` case's comment
    corrected to say plainly that it pins the intended verdict rather than flipping it.
  - `[medium]` `[patch]` `create-wiki-flow.test.tsx`'s spy assertion claimed to prove the
    handler's early return, which a `disabled` button makes unreachable in jsdom; comment
    corrected, and the Enter path DW-407 names — untested at the card until now — covered with a
    `fireEvent.submit` case per abort flavour.
  - `[low]` `[patch]` The empty-state opener's inline comment still said the create "has
    landed", contradicting the `awaitingCreate` docblock this change rewrote to cover both
    halves. Brought in line, `disabled` vs `aria-disabled` argument kept intact.

## Design Notes

The card's latch is deliberately the same three-part shape DW-375 shipped in the header, so the two surfaces stay one mental model:

```tsx
if (busy || awaitingCreate) return;   // backstop; unreachable behind the prop, pinned by a source scan
...
<CreateWikiDialog
  open={createOpen}
  busy={busy}
  // Cancel and Esc stay live behind it — see `awaitingCreate`.
  confirmDisabled={awaitingCreate}
```

No error-clear-on-reopen change is needed here (the switcher's `if (!awaitingWrite) setCreateError(null)`): the card's only opener is the empty-state button, which is already `disabled={awaitingCreate}` and already returns early on it, so the reopen-while-latched path the switcher has does not exist on this surface.

For DW-408, `.catch(() => null)` is the whole fix because `workbenchSettingsFrom(null)` is already `null`: the throwing body and the parsed-but-shapeless body then answer identically, which is correct — in both cases the route ran and replied, and the only thing lost is the ability to re-seed the draft.

## Verification

**Commands:**
- `pnpm vitest run src/components/__tests__/create-wiki-flow.test.tsx src/components/__tests__/wiki-switcher-lifecycle.test.tsx src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/create-wiki-ui.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** DW-407: the card's `CreateWikiDialog` now gets `confirmDisabled={awaitingCreate}`, and `WikiWorkbench.create` guards `if (busy || awaitingCreate) return;` — the same pair DW-375 shipped in the header — so on the unconfirmed path neither the confirm nor the Enter path behind it can issue a second `POST /api/wikis` over a create that may already have landed. Cancel and Esc stay live; the existing release effect on a fresh `wikis` array is still the only thing that lifts the latch. DW-408: `saveWorkbenchSettings`'s success parse became `await response.json().catch(...)`, guarded so that a body which fails to PARSE answers `null` and lands on the existing shapeless-200 branch, while a body read that DIES mid-stream (an unconfirmed cause) is rethrown and still answers `unconfirmed: true`.

**Files changed.**
- `../../src/components/WikiWorkbench.tsx` — `confirmDisabled={awaitingCreate}` on the dialog mount, `awaitingCreate` alongside `busy` in `create`, docblock and opener comment brought in line with the unconfirmed path.
- `../../src/lib/workbench-settings.ts` — guarded `.catch` on the 2xx parse, with the two failures and their opposite verdicts spelled out.
- `../../src/components/__tests__/create-wiki-flow.test.tsx` — the unconfirmed-create case now asserts the confirm is dead, that no second `/api/wikis` leaves the surface, and that Cancel/Esc still work; plus new cases per abort flavour for the Enter path and for the confirm coming back on a server render.
- `../../src/lib/__tests__/workbench-settings.test.ts` — the unparseable-200 verdict pinned, and an `it.each` over the three unconfirmed causes asserting a dead body read is still `unconfirmed: true`.
- `../../src/lib/__tests__/workbench-left-column.test.ts` — the card's guard pin updated for the new `create` line and the `confirmDisabled` prop.

**Review findings.** 5 patched (1 high, 3 medium, 1 low), 4 deferred (3 medium, 1 low — see frontmatter `deferred`), 8 rejected. Rejected as out of scope on the intent's own authority or as by-design: content-type sniffing to call a proxy's HTML 200 unconfirmed; the latch never lifting if no server render ever lands (deliberate, identical in `WikiSwitcher`); the release effect lifting on any server render (documented as intended); `fetchWorkbenchSettings`'s bare parse (a read with no `unconfirmed` verdict to get wrong); the `WikiWorkbench` pins living inside a `describe("WikiSwitcher")` and the brittleness of count-based regex pins (both pre-existing placement); and the intent's stale line citations.

**Follow-up review recommendation:** true. Patched severities: high 1, medium 3, low 1 — a high-severity patch was applied, which sets the flag on its own (score `3 × 3 + 1 = 10`, also ≥ 5).

**Verification.** `./node_modules/.bin/vitest run` — 273 files / 6149 tests passed. Targeted suites (`create-wiki-flow`, `wiki-switcher-lifecycle`, `workbench-left-column`, `workbench-settings`, `create-wiki-ui`) — 376 passed. `tsc --noEmit` — exit 0. `eslint` — exit 0 (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices). Every I/O matrix row is covered by a test that ran and passed. Non-vacuity was checked per change by reverting it: removing `confirmDisabled` fails the pointer and Enter cases; widening the `.catch` back to `() => null` fails all three body-read cases. `pnpm run <script>` is broken in this environment (a stray `~/pnpm-workspace.yaml` makes pnpm treat `$HOME` as a workspace root), so the binaries were invoked directly — pre-existing and outside this spec's scope.

**Residual risks.** The DW-408 change is, with the guard in place, behaviourally a no-op for the exact case its ledger entry names: a `SyntaxError` was never an `unconfirmedCause`, so it already reached the same `{ fallback, unconfirmed: false }` through the outer catch. What it buys is that the arrived-answer verdict is decided on the shapeless-200 branch instead of coinciding with it, keeping the two in step if the thrown fallback ever diverges. The harm the entry describes — the owner told the save failed, holding a superseded version whose next save is a 412 — survives the fix and is recorded as the first `deferred` item. The card's `create` guard is unreachable behind `confirmDisabled` and is pinned by a source scan rather than a mounted test, deliberately and as the switcher's equivalent already is.
