---
title: 'Unconfirmed-write latch: drop the stale sentence with the latch, describe the shut opener, hold the picker on an unconfirmed switch'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
baseline_revision: 'ddf9e7dcab997aa77ca60e6f9d2917200c1d3c83'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `applyTemplate`'s unconfirmed sentence is never dropped when the server render
      lands, so the card's re-template confirm comes back live under a stale "the
      outcome is unknown" alert — DW-429's harm on a third surface.
    evidence: |-
      `applyTemplate` (src/components/WikiWorkbench.tsx) composes the same unconfirmed
      sentence through `writeFailure` and fires `router.refresh()`, but raises no latch,
      so there is nothing for the new release effect to gate on and `templateError` is not
      among the errors it clears. The dialog stays open (`setTemplateOpen(false)` runs only
      on success) and the reset effect keys on `[currentWikiId, currentId]`, which a
      re-template does not move. After the refresh the owner sees a live `Overwrite` under
      an alert saying nobody knows what happened, over a card already showing the new
      scenario. Deliberately out of this bundle's scope — the confirm is idempotent per
      scenario, which answers the double-write risk but not the stale-sentence one.
    location: >-
      src/components/WikiWorkbench.tsx (applyTemplate)
    severity: medium
  - summary: >-
      The card's `awaitingCreate` and the header switcher's `awaitingWrite` are independent
      flags on two components rendered in the same viewport, so an unconfirmed create on one
      surface leaves the other's create control fully live.
    evidence: |-
      `Workbench.tsx` renders `WikiSwitcher` in the left column header and `WikiWorkbench`
      as `children` at the same time. An unconfirmed create from the card raises
      `awaitingCreate` and dims its `Create Wiki`, while the header's `New Wiki` — which
      opens the same `CreateWikiDialog` onto the same `POST /api/wikis` — is not latched at
      all, and the inverse holds. Nothing enforces unique wiki names, so one click on the
      other surface seeds the second wiki the latch exists to prevent. Pre-existing since
      DW-375/DW-407 shipped the two flags separately; no suite mounts both surfaces together.
    location: >-
      src/components/WikiWorkbench.tsx and src/components/workbench/WikiSwitcher.tsx
    severity: medium
  - summary: >-
      A latched `<select>` refuses a switch silently: it reports as enabled, snaps back with
      no announcement, and `selectDescribedBy` names no reason.
    evidence: |-
      While `awaitingWrite` is up the picker carries `disabled={switching}` (false) and
      `aria-disabled` only for `readOnly`, so it announces as an ordinary live combobox; the
      change is swallowed by `switchWiki`'s early return and React re-applies the value. The
      switcher's own `<p role="alert">` is on screen and was announced when it appeared, but
      it carries no id and is not in `selectDescribedBy`, so a keyboard or screen-reader
      owner who tries again gets nothing at all. This is the shape the neighbouring
      `WIKI_READ_ONLY_COPY` description exists to avoid for the read-only refusal.
    location: >-
      src/components/workbench/WikiSwitcher.tsx (the switcher <select> and selectDescribedBy)
    severity: low
  - summary: >-
      DW-429's recorded `decision:` names a kernel remedy this bundle did not implement, and
      its cited coordinates no longer match the tree.
    evidence: |-
      The ledger entry's decision reads "Add a fail-soft `bumpDataVersion()` tail to
      `setCurrentWiki` outside the lock ... rewrite the exemption rationale at
      workbench-data-version.test.ts:1067-1071 and raise the count guard at :1088-1089 to 6".
      This bundle's intent directed implementing the entry's REASON instead, which is a
      client-side release-effect fix, so nothing in `src/lib/wikis.ts` was touched. The
      decision's own line numbers are also stale: that suite already asserts six
      `bumpRefreshSignal` sites around line 1213 and states the `setCurrentWiki` exemption
      rationale near line 1174. So the decision's separate concern — that a switch moves no
      `dataVersion` — is neither implemented nor retired, and a future sweep re-reading it
      would chase dead coordinates.
    location: >-
      _bmad-output/implementation-artifacts/deferred-work.md (DW-429 decision text)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three holes in how the unconfirmed-write latch RECOVERS. (DW-429) Both release effects do only `setAwaitingCreate(false)` / `setAwaitingWrite(false)` keyed on `[wikis, currentWikiId]` and neither clears the error, so a server render hands the confirm back live underneath a now-stale "the outcome is unknown" alert — on the card and on the switcher alike — while `WikiSwitcher.tsx:427-428`'s own comment asserts the release "drops both together". (DW-430) The card's unknown-outcome sentence lives only inside the overlay the message invites the owner to dismiss; behind it the empty state's `Create Wiki` opener is `disabled` with `aria-describedby` supplied only in the read-only case, so dismissing destroys the owner's only explanation and leaves a dimmed button that says nothing. (DW-409) `switchWiki` guards only on `switching`, which `finally` clears, so once the unconfirmed sentence appears the `<select>` is live again and a second `PUT /api/wikis/current` can be issued over a first whose outcome is unknown — and the active wiki decides which `schema.md` every prompt executes.

**Approach:** Make each release effect clear the sentence it raised the latch beside, conditioned on the latch actually having been up (a server render must not wipe a CONFIRMED refusal the owner is still reading). Render the card's retained unknown-outcome sentence in the empty state and point the disabled opener's `aria-describedby` at it. Give `switchWiki` the same `busy || awaitingWrite` shape create/rename/delete already carry — guard on `switching || awaitingWrite` and raise the latch on the unconfirmed path — so the controlled `<select>` puts itself back on the pre-switch value until a server render says what is actually live.

## Boundaries & Constraints

**Always:** The latch keeps riding `confirmDisabled` and never `busy` — Cancel, Esc and outside-click stay live on every dialog. The error clear happens ONLY when the latch was up: a release effect that fires on an unrelated server render must leave a stated refusal's sentence alone. `awaitingWrite` stays ONE flag for every write on the switcher, now four rather than three. The card's opener keeps `disabled` (transient, like `switching`) and gains a description rather than flipping to `aria-disabled`. The switcher's refusal of a latched switch is the handler's early return alone — React re-applies a controlled `<select>`'s value when a change handler commits no state, which is what holds the picker; no handler puts a control back by hand.

**Block If:** the release effect cannot read the latch without also depending on it (adding `awaitingCreate`/`awaitingWrite` to the dependency list fires the effect the moment the latch goes UP and drops it on the same commit — the latch must survive that); or `writeFailure`'s `unconfirmed` verdict stops being the only thing that raises a latch.

**Never:** Do not touch `writeFailure`, `unconfirmedWriteMessage` or any wording it composes. Do not add a copy constant — the card's retained sentence IS `createError`. Do not add `role="alert"` to the retained note (the dialog's alert already owns that channel, and a second one breaks `findByRole("alert")` across two suites). Do not widen `busy`, do not make either surface optimistic, do not touch `applyTemplate` (idempotent per scenario), and do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Card create, latch released with dialog open | Unconfirmed create latched, then a fresh `wikis` array arrives through the provider | `Create` is enabled again AND the unknown-outcome alert is gone from the dialog | No error expected |
| Card create, owner dismisses the dialog | Unconfirmed create latched, Esc pressed | Empty state shows the same unknown-outcome sentence; the `disabled` `Create Wiki` opener's `aria-describedby` resolves to it | Sentence disappears only when the latch lifts |
| Card create, read-only deployment | `readOnly` true, no latch | Unchanged: `aria-disabled`, described by `WIKI_CREATE_READ_ONLY_COPY` only | No unknown-outcome note rendered |
| Switcher, latch released | Unconfirmed create/rename/delete/switch latched, then a fresh `wikis` array | Confirms enabled again AND `createError`/`renameError`/`deleteError`/`error` all cleared | No error expected |
| Switcher, stated refusal then unrelated render | 400/404 answered, no latch, then a fresh `wikis` array | The refusal sentence STAYS on screen | Never cleared by a render the owner did not cause |
| Switch, unconfirmed outcome | `PUT /api/wikis/current` rejects with `TimeoutError`/`AbortError`/502 | Unknown-outcome alert, `router.refresh()` fired, picker back on the pre-switch id, latch up | A second `change` on the `<select>` issues no further PUT and leaves the value on the pre-switch id |
| Switch, stated refusal | `PUT` answers 404 with a reason | Unchanged: reason shown, no refresh, `<select>` back on the confirmed id, NO latch | Next switch is taken immediately |

</intent-contract>

## Code Map

- `src/components/WikiWorkbench.tsx` -- fix site 1 and 2. `createNoteId` :74; `createError` :79; `awaitingCreate` docblock+state :81-102; release effect :151-159 (`setAwaitingCreate(false)` keyed `[wikis, currentWikiId]`) -- the DW-429 site; `setAwaitingCreate(true)` on the success path :203 and the unconfirmed path :229; empty state :302-341 with `disabled={awaitingCreate}` :313, `aria-disabled={readOnly || undefined}` :319, `aria-describedby={readOnly ? createNoteId : undefined}` :320, handler guard `if (awaitingCreate) return;` :326, read-only note :332-339 -- the DW-430 site. `CreateWikiDialog` mount :407-416 (unchanged).
- `src/components/workbench/WikiSwitcher.tsx` -- fix site 3. `error` :92; `awaitingWrite` docblock :125-143, state :144; release effect :177-184 -- the DW-429 site here; `switchWiki` :186-213 with `if (switching) return;` :187, rollback `setPendingId(null)` :199, unconfirmed branch `if (unconfirmed) router.refresh();` :210 -- the DW-409 site; `setAwaitingWrite(true)` in create :246, rename :279, remove :323; `<select>` :374-408 (`value={value}` :385, `disabled={switching}` :386, `onChange` :393-399); New Wiki opener :411-433, whose comment at :424-429 ("The release effect drops both together") is the assertion this change makes true; the `if (!awaitingWrite) set*Error(null)` opener guards :428/:477/:501 STAY (they are the only cleanup for a confirmed refusal).
- `src/lib/workbench-request.ts` -- READ-ONLY. `unconfirmedCause` :154, `unconfirmedWriteMessage` :176, `writeFailure` :227. The `unconfirmed` verdict is the only thing that raises a latch.
- `src/lib/__tests__/workbench-left-column.test.ts` -- source scan. :304-306 pins `if (busy || awaitingWrite) return;` ×3 and `if (busy) return;` ×0 in the switcher (unaffected -- `switchWiki` guards on `switching`, not `busy`); the surrounding comment at :296-299 says "`switchWiki` is guarded on `switching`, its own flag" and must be brought in line; :319-321 pins the card's guard counts.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- source scan that WILL BREAK: :222 `expect(switcher).toContain("if (switching) return;")`.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- the card's mounted surface. `mount(wikis, currentWikiId)` :66-76 returns the RTL result so `view.rerender` simulates a server render; `button(name)` :103; the latch cases :479-563, and `gives the create confirm back once a server render arrives` :527-548 is where the released sentence is observable.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- the card's read-only surface, with the `describedByText(element)` DOM-resolving helper at :65-71 to copy. Its `the empty state's Create Wiki refuses the same way` cases :131-167 pin the unchanged read-only description.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- the switcher's mounted surface. `mount(wikis)` :80-82, `switchTo` :104-108, `currentWrites()` :73-78, `deferNextRequest()` :90-96; switch unconfirmed cases :558-585; `starts exactly ONE PUT…` :499-531 is the shape to copy for a second-change-is-refused case; DW-375 latch describe :720-945, whose `gives ${label}'s confirm back once a server render arrives` :791-810 is where the released sentence is observable and whose `keeps ${label}'s sentence when the owner dismisses and reopens` :853-884 must stay green (no server render there).

## Tasks & Acceptance

**Execution:**
- `src/components/WikiWorkbench.tsx` -- mirror `awaitingCreate` into a ref set wherever the state is set (:203, :229), make the release effect return early unless that ref is up and otherwise clear the ref, the latch and `createError` together; add a `createUnknownNote` derivation (`awaitingCreate ? createError : null`), render it as a plain muted `<p id={createUnknownNoteId}>` beside the read-only note in the empty state, and replace the opener's `aria-describedby` with a space-joined list of the read-only id and that id (the switcher's `selectDescribedBy` idiom). Explain in the ref's docblock why the effect cannot simply depend on the state.
- `src/components/workbench/WikiSwitcher.tsx` -- the same ref+release shape, clearing `createError`, `renameError`, `deleteError` and `error` with the latch; change `switchWiki`'s guard to `if (switching || awaitingWrite) return;` and set the latch in its unconfirmed branch alongside `router.refresh()`; update the `awaitingWrite` docblock to name four writes and to state that the release drops the sentence with the latch, and note at the `<select>`'s `onChange` that a latched switch is refused by the same commit-nothing route `readOnly` uses.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- update :222 to `if (switching || awaitingWrite) return;` and extend the comment: overlapping switches settle out of order, and so does a switch issued over one whose outcome nobody knows.
- `src/lib/__tests__/workbench-left-column.test.ts` -- extend the guard-pin comment at :296-299 and add an assertion for the switcher's `if (switching || awaitingWrite) return;`, so the fourth write's handler-level guard is pinned like the other three (a `disabled`-free `<select>` refusal is invisible to a mounted test).
- `src/components/__tests__/create-wiki-flow.test.tsx` -- assert in the server-render case that the alert is GONE once the confirm returns; add a case that after Esc the empty state still carries the unknown-outcome sentence and the disabled opener's `aria-describedby` resolves to it (local `describedByText` helper), and that a later server render takes both away.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- assert in each `gives ${label}'s confirm back once a server render arrives` case that no alert survives the release; add switch cases: an unconfirmed switch refuses a second `change` (no second `/api/wikis/current`, picker still on the pre-switch id) and gives the picker back after a server render, and a STATED refusal still takes the next switch immediately.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- add an assertion that on a read-only deployment the opener is described by `WIKI_CREATE_READ_ONLY_COPY` and by nothing else, so the joined describedby list cannot regress into naming a note that is not rendered.

**Acceptance Criteria:**
- Given a latched unconfirmed write on either surface, when a server render arrives that says nothing changed, then the confirm is live again and no unknown-outcome sentence is left anywhere on that surface.
- Given a STATED refusal (a route that answered with a reason) on either surface, when an unrelated server render arrives, then that sentence is still on screen and the confirm was never latched.
- Given a latched unconfirmed create on the card, when the owner dismisses the dialog with Esc, then the empty state shows the same sentence and the `Create Wiki` opener stays `disabled` (never `aria-disabled`) with `aria-describedby` resolving to that sentence.
- Given a read-only deployment with no latch, when the empty state renders, then the opener's description is exactly `WIKI_CREATE_READ_ONLY_COPY`, unchanged from before this spec.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 4: (high 0, medium 2, low 2)
- reject: 11: (high 0, medium 1, low 10)
- addressed_findings:
  - `[medium]` `[patch]` A switch-raised latch suppressed the three openers'
    `if (!awaitingWrite) set*Error(null)` guards, so reopening a dialog re-presented a
    STATED refusal the route had already answered, beside a confirm dead for an unrelated
    reason. `switchWiki`'s unconfirmed branch now clears the three dialog errors before
    raising the latch, gated on `awaitingWriteRef.current` so a create that latched while
    the switch was in flight keeps its own sentence.
  - `[medium]` `[patch]` A dialog opened under a switch-raised latch had a dead confirm and
    nothing inside the overlay saying why — the switcher's `role="alert"` sits behind a
    `fixed inset-0` `aria-modal` backdrop, both covered and outside the modal for assistive
    tech. The three dialogs now fall back to `awaitingWrite ? error : null`, with mounted
    cases pinning the fallback, its precedence, and the pre-emptive clear.
  - `[low]` `[patch]` Two comments on the card's opener argued opposite rationales — the
    pre-existing one said `disabled` because the state needs no sentence, the new one gave
    it a sentence. Reconciled into one, naming the retracted claim.
  - `[low]` `[patch]` Both ref docblocks assert "every raise sets the ref on the adjacent
    line" with nothing enforcing it; a forgotten line strands the latch permanently UP with
    the suite green. Added a source-scan pin on raise-count == ref-count in both components.
  - `[low]` `[patch]` The new guard-pin comment claimed deleting `if (switching ||
    awaitingWrite) return;` leaves every mounted case green, which the new DW-409 case
    disproves. Reasoning corrected to what the pin actually adds.
  - `[low]` `[patch]` The `awaitingWrite` docblock claimed `busy` and `switching` guarantee
    only one write in flight; false in both directions. Replaced with the real reason for
    one flag, both counterexamples named.

## Design Notes

The release effect cannot read the latch it is releasing. Adding `awaitingWrite` to `[wikis, currentWikiId]` fires the effect on the commit that RAISES the latch and drops it immediately; clearing the error unconditionally wipes a confirmed refusal on any unrelated refresh. So the flag is mirrored in a ref the effect reads without depending on:

```tsx
const awaitingWriteRef = useRef(false);
// ... every `setAwaitingWrite(true)` sets the ref on the same line.
useEffect(() => {
  if (!awaitingWriteRef.current) return;
  awaitingWriteRef.current = false;
  setAwaitingWrite(false);
  setCreateError(null); setRenameError(null); setDeleteError(null); setError(null);
}, [wikis, currentWikiId]);
```

DW-409 needs no new affordance: the `<select>` keeps `disabled={switching}` and the latched refusal is `switchWiki`'s early return, which commits no state — so React re-applies the controlled value and the picker is showing the pre-switch wiki again by the time anyone looks. That is the mechanism `WikiSwitcherProps.readOnly` already documents in full; the unconfirmed sentence is already rendered as the switcher's own `role="alert"` beneath the control, so the hold is explained without a second sentence.

## Verification

**Commands:**
- `pnpm exec vitest run src/components/__tests__/create-wiki-flow.test.tsx src/components/__tests__/wiki-switcher-lifecycle.test.tsx src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/create-wiki-ui.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** DW-429: both release effects now drop the unknown-outcome sentence
with the latch, gated on a mirror ref (`awaitingCreateRef`, `awaitingWriteRef`) so an
unrelated server render cannot wipe a stated refusal the owner is still reading — the
behaviour `WikiSwitcher`'s own opener comment had asserted since DW-375 without implementing.
DW-430: the card retains that sentence OUTSIDE the overlay the message invites the owner to
dismiss, rendered as ordinary empty-state text, with the still-`disabled` opener's
`aria-describedby` resolving to it through a joined list. DW-409: `switchWiki` guards on
`switching || awaitingWrite` and raises the shared latch on the unconfirmed path, so the
controlled `<select>` puts itself back on the pre-switch wiki — the commit-nothing refusal
`WikiSwitcherProps.readOnly` already documents — until a server render says which wiki is
live.

**Files changed.**
- `../../src/components/WikiWorkbench.tsx` — mirror ref, error-clearing release effect, the
  retained note and the joined `aria-describedby`.
- `../../src/components/workbench/WikiSwitcher.tsx` — mirror ref, four-error release effect,
  the switch latch and its guard, the pre-emptive dialog-error clear, and the three dialogs'
  latched-error fallback.
- `../../src/components/__tests__/create-wiki-flow.test.tsx` — the released sentence, the
  dismiss-and-retain case, and a stated refusal surviving an unrelated render.
- `../../src/components/__tests__/wiki-switcher-lifecycle.test.tsx` — the released sentence
  on all three dialog writes, the DW-409 switch describe, and the P1/P2 patch cases.
- `../../src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` — the read-only
  description pinned to exactly one sentence.
- `../../src/lib/__tests__/create-wiki-ui.test.ts` — the switch guard's new spelling.
- `../../src/lib/__tests__/workbench-left-column.test.ts` — the switch guard pin and the new
  raise/ref parity pin.

**Review findings breakdown.** 6 patches applied (2 medium, 4 low); 4 items deferred (2
medium, 2 low); 11 rejected.

**Follow-up review recommendation:** true. Patched this pass: 0 high, 2 medium, 4 low →
score 3x2 + 1x4 = 10, which is 5 or more.

**Verification performed.**
- `pnpm exec vitest run` over the five spec-named suites: 174 passed / 5 files.
- `pnpm exec tsc --noEmit`: exit 0. `pnpm lint`: exit 0 (only the pre-existing
  `jsx-ast-utils` `TSNonNullExpression` notices).
- `pnpm test`: 13 files fail, and the failing-file set is byte-identical to the pre-change
  baseline captured by stashing `src/` at `ddf9e7dc` and re-running. Those suites die on
  `window.localStorage` being undefined in the `components/workbench/__tests__` dom project —
  a pre-existing environment issue this change neither causes nor touches.
- Mutation-checked so no new pin is vacuous: removing the ref gate from either release effect
  fails the two stated-refusal cases; reverting the `switchWiki` guard fails the DW-409 case;
  removing the retained note fails two cases; reverting the three dialog fallbacks fails two;
  dropping the pre-emptive clear fails the stale-sentence case; removing one ref mirror in
  either component fails the parity pin.
- Matrix audit: all seven I/O rows are covered by named cases that ran and passed.

**Residual risks.**
- The one behavioural widening: `awaitingWrite` is now raised by an unconfirmed switch too,
  so during that window the create, rename and delete confirms are latched as well. That is
  the intent's "matching create/rename/delete which all guard on `busy || awaitingWrite`",
  and the two patches above close the reachable harms it introduced, but it is a broader
  shutdown than DW-409 alone required.
- The latch is still released only by a `wikis` identity change. If the `router.refresh()`
  issued on the unconfirmed path also fails, the picker and the create confirms stay shut
  until some later server render lands — the DW-375 contract, now extended to the switcher's
  primary navigation control.
- The joined `createDescribedBy` list has no reachable two-id case; the read-only suite pins
  it resolving to exactly one sentence, so a regression into a dangling id fails there.
