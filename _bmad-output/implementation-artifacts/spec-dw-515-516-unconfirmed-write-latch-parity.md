---
title: 'Unconfirmed-write latch parity: latch the re-template, and share one latch across the two wiki create surfaces'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: 'ab263b9826041da00d3c755c7a707e5744186c5a'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two surfaces still miss the latch DW-409/429/430 built. (DW-515) `applyTemplate`
(`src/components/WikiWorkbench.tsx:301-341`) composes the unconfirmed sentence through
`writeFailure` and fires `router.refresh()` but raises no latch: `templateError` is not among the
errors the release effect clears, the dialog stays open (`setTemplateOpen(false)` runs on success
only), and the reset effect keys on `[currentWikiId, currentId]` — which a re-template does not
move. After the refresh the owner sees a live `Overwrite` under a stale "the outcome is unknown"
alert, over a card already showing the new scenario. (DW-516) `WikiWorkbench`'s `awaitingCreate`
(`:111`) and `WikiSwitcher`'s `awaitingWrite` (`:163`) are independent flags on two components
`Workbench.tsx` renders together (`:1681`, `:1821`), both opening the same `CreateWikiDialog` onto
the same `POST /api/wikis`. Nothing enforces unique wiki names, so an unconfirmed create latched on
one surface leaves the other's create fully live and one click seeds the second wiki the latch
exists to prevent.

**Approach:** Lift the unconfirmed half of the latch out of both components into one shared piece of
client state that carries the sentence it was raised beside, so every wiki write control on both
surfaces is shut by an unknown outcome anywhere and every dimmed control can say why. Raise that
same latch from `applyTemplate`'s unconfirmed branch and drop `templateError` with it. Each surface
keeps a private ref recording that IT raised the standing latch, which is what still separates a
sentence an arriving server render makes stale from a stated refusal the owner is still reading.

## Boundaries & Constraints

**Always:** The latch keeps riding `confirmDisabled` and never `busy` — Cancel, Esc and
outside-click stay live on every dialog. A surface clears only its OWN error state, and only when
its own ref says it raised the standing latch. The shared latch is released on the same server
render (`[wikis, currentWikiId]`) by whichever holder's effect runs first; release is idempotent.
`useWikiWriteLatch` degrades to component-local state when no provider is above it, so a bare-mounted
`WikiSwitcher` behaves exactly as it does today. The card's opener keeps `disabled` (transient, like
`switching`) and gains a description rather than flipping to `aria-disabled`.

**Block If:** the shared latch cannot be released without a consumer depending on it (a dependency
fires the release effect on the commit that RAISES the latch); or the shared state cannot be read by
`WikiSwitcher`, which takes props from `Workbench.tsx` rather than reading `WorkbenchData` directly.

**Never:** Do not touch `writeFailure`, `unconfirmedWriteMessage` or any wording either composes,
and do not add a copy constant — every sentence a control shows is the one `writeFailure` already
made. Do not make either surface optimistic. Do not widen `busy`. Do not put the card's SUCCESS-path
latch into the shared state: a succeeded create shuts a control that is stale on the card only
(`No wiki yet.`), and it carries no sentence to explain a dimmed control anywhere else. Do not add a
second `role="alert"` on the card. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-template, unconfirmed outcome | `POST /api/wikis/[id]/template` rejects with `TimeoutError`/`AbortError`/502 | Unknown-outcome alert inside the dialog, `router.refresh()` fired, `Overwrite` latched dead, Cancel and Esc live | A second `Overwrite` press issues no second POST |
| Re-template, latch released | Latched as above, then a fresh `wikis` array arrives | `Overwrite` is live again and the unknown-outcome sentence is gone from the dialog | No error expected |
| Re-template, stated refusal | `POST` answers 400/404 with a reason | Reason shown in the dialog, no latch, confirm live, and an unrelated server render leaves the sentence alone | Next `Overwrite` is taken immediately |
| Card create unconfirmed, header watching | Card's `POST /api/wikis` unconfirmed, both surfaces mounted | The header's `New Wiki` dialog opens with a DEAD `Create` and the card's sentence inside it; no second `POST /api/wikis` is issued from either surface | Sentence and both confirms return on a server render |
| Header create unconfirmed, card watching | Switcher's `POST /api/wikis` unconfirmed, both surfaces mounted | The card's empty-state `Create Wiki` is `disabled` (never `aria-disabled`) and its `aria-describedby` resolves to the switcher's sentence | Both released together on a server render |
| Unconfirmed switch, card watching | `PUT /api/wikis/current` unconfirmed | The card's create controls are shut too and describe themselves with the switch's sentence | Released together on a server render |
| Stated refusal on one surface, latch raised on the other | Card holds a STATED create refusal; switcher raises an unconfirmed latch; a server render arrives | The card's stated sentence is still on screen — only the surface that raised the latch clears its own errors | Never cleared by a render the owner did not cause |
| No provider above the switcher | `WikiSwitcher` mounted bare (its own suite) | Every DW-375/DW-409 behaviour is unchanged: the latch raises, holds and releases locally | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/WikiWriteLatch.tsx` -- NEW. The shared latch: context, provider and
  `useWikiWriteLatch()`. Copy `WorkbenchData.tsx`'s "degrades outside the provider" convention
  (`:19-21`), but degrade to component-LOCAL state rather than to a constant, because a bare
  `WikiSwitcher` must still latch.
- `src/components/workbench/WorkbenchData.tsx` -- the seam. `WorkbenchDataProvider` :92-133 wraps
  every consumer of both surfaces (`page.tsx:135-147` puts `Workbench` and `WikiWorkbench` inside
  it), so the latch provider nests INSIDE its context provider at :126-132 and takes
  `value.wikis` / `value.currentWikiId` as its release keys. Props, not `useWorkbenchData()`, to
  keep the import acyclic.
- `src/components/WikiWorkbench.tsx` -- fix site 1 (DW-515) and half of fix site 2 (DW-516).
  `createNoteId` :74, `createUnknownNoteId` :83; `createError` :88, `templateError` :89;
  `awaitingCreate` docblock+state :90-111 and its ref :112-126; `createUnknownNote` :148-164 and
  `createDescribedBy` :165-173; reset effect :191-196 (`[currentWikiId, currentId]`); release effect
  :216-221; `create` guard :248 and its two raises :265-266 / :292-293; `applyTemplate` :301-341
  (guard :310, unconfirmed branch :337); empty-state opener :368-411 (`disabled` :389,
  `aria-describedby` :399, handler guard :405) and the retained note :426-430; `CreateWikiDialog`
  :498-507 (`confirmDisabled` :502); template `ConfirmDialog` :509-566 (`confirmDisabled` :523,
  `error={templateError}` :524, body `<select disabled={busy}>` :544).
- `src/components/workbench/WikiSwitcher.tsx` -- the other half of fix site 2. `awaitingWrite`
  docblock :125-162, state :163, ref docblock+ref :164-178; release effect :229-237; `switchWiki`
  guard :246 and its unconfirmed branch :277-303 (the P1 pre-emptive clear gated on
  `awaitingWriteRef.current` :295); `create` :314, `rename` :353, `remove` :386 guards and their
  raises :339-340 / :373-374 / :418-419; `<select>` :470-512; the three openers' `if (!awaitingWrite)
  set*Error(null)` guards :532 / :581 / :605; the three dialogs' `confirmDisabled` and
  `error={... ?? (awaitingWrite ? error : null)}` :625/:635, :650/:652, :715/:717; rename Enter guard
  :693.
- `src/lib/workbench-request.ts` -- READ-ONLY. `writeFailure` :227 is still the only thing that
  raises a latch, and the only place a sentence is composed.
- `src/lib/__tests__/workbench-left-column.test.ts` -- source scans that WILL BREAK: :331, :350-352,
  :359 (guard spellings), :374-379 (the card's guard counts and `confirmDisabled={awaitingCreate}`),
  :401-409 (the raise/ref parity pin).
- `src/lib/__tests__/create-wiki-ui.test.ts` -- source scans that WILL BREAK: :196
  (`confirmDisabled={pendingScenario === current?.scenario}`), :209 (`error={templateError}`), :231
  (`if (switching || awaitingWrite) return;`).
- `src/components/__tests__/create-wiki-flow.test.tsx` -- the card mounted under
  `WorkbenchDataProvider`. `data()` :47-64, `mount()` :67-77, `button()` :105, `describedByText()`
  :115-121, `openTemplateDialog()` :123-127. The re-template unconfirmed case :495-521 WILL BREAK at
  :519 (`Overwrite` is now latched dead until a server render). The create latch cases :523-677 must
  stay green.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- the switcher mounted BARE (`mount()`
  :91-93), which is the local-degradation case. `deferNextRequest()` :101-107, `switchTo()` :115-119,
  `currentWrites()` :85-89. Everything in :728-1171 must stay green unchanged.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- pins the read-only opener's
  description to exactly `WIKI_CREATE_READ_ONLY_COPY`; `describedByText` helper :65-71. Must stay
  green.
- Test environment: the `dom` project fails 13 files under `src/components/workbench/__tests__`
  on `window.localStorage` at baseline (`ab263b98`). New mounted suites go in
  `src/components/__tests__/`, which is unaffected.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/WikiWriteLatch.tsx` -- NEW. Export `WikiWriteLatchProvider({ wikis,
  currentWikiId, children })` holding one `useState<string | null>` (the sentence; `latched` is
  `message !== null`) plus a `latchedRef` mirror, and `useWikiWriteLatch()` returning `{ latched,
  message, latchedRef, raise(message), release() }` with `raise`/`release` stable across renders.
  Outside a provider the hook returns an equivalent object backed by its own local state, so a
  bare-mounted consumer keeps today's behaviour. Document why the ref exists (a release effect
  cannot depend on the flag it releases) and why the success path is not admitted here.
- `src/components/workbench/WorkbenchData.tsx` -- nest `WikiWriteLatchProvider` inside
  `WorkbenchDataContext.Provider`, fed the same `value.wikis` / `value.currentWikiId` both surfaces'
  release effects already key on.
- `src/components/WikiWorkbench.tsx` -- consume the shared latch; narrow `awaitingCreate` to the
  SUCCESS path only and say so in its docblock; shut the opener, the create confirm and both
  handlers on `awaitingCreate || latched`; derive `createUnknownNote` from the shared message so the
  dimmed opener explains a latch raised by the header too; raise the shared latch from
  `applyTemplate`'s unconfirmed branch, guard `applyTemplate` on it, gate the `Overwrite`
  `confirmDisabled` on it and give the template dialog the same `error ?? shared message` fallback
  the switcher's three dialogs carry; add `setTemplateError(null)` to the release effect and note
  why clearing both errors there cannot wipe a stated refusal (the reset effect at
  `[currentWikiId, currentId]` plus the two mutually exclusive branches).
- `src/components/workbench/WikiSwitcher.tsx` -- replace the local `awaitingWrite` state with the
  shared latch (its four guards, three `confirmDisabled`, the rename Enter guard, the three opener
  keep-the-sentence guards and the three dialogs' fallback), keep a private "this switcher raised
  the standing latch" ref for the release effect's error clearing, and read the SHARED ref in
  `switchWiki`'s pre-emptive clear so a card-raised latch is recognised as somebody else's. Update
  the `awaitingWrite` docblock: one latch, now six writes across two components, and what a shared
  release means.
- `src/lib/__tests__/workbench-left-column.test.ts` -- retarget the guard-spelling, guard-count and
  raise/ref parity pins onto the new spellings, keeping each pin's stated reason true: the parity pin
  must still make "every raise is mirrored" enforceable, now counting shared-latch raises against
  the per-surface ref lines.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- update the three broken literals and extend the
  comments: the template confirm is now latched by an unknown outcome as well as by a no-op
  scenario, and the switch guard reads the shared latch.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- fix the re-template case to assert the
  latch (dead `Overwrite`, live Cancel, no second POST) and add: a server render gives `Overwrite`
  back and takes the sentence away; a STATED template refusal never latches and survives an unrelated
  render.
- `src/components/__tests__/wiki-write-latch-parity.test.tsx` -- NEW. Mount `WikiSwitcher` and
  `WikiWorkbench` together under one `WorkbenchDataProvider`, as `Workbench.tsx` renders them, and
  cover the four cross-surface rows of the matrix, including the negative one (a stated refusal on
  one surface is not cleared by the other's latch release).

**Acceptance Criteria:**
- Given an unconfirmed re-template, when the owner presses `Overwrite` again, then no second
  `/api/wikis/[id]/template` request is issued and the dialog is still dismissible.
- Given an unconfirmed write on either wiki surface, when both surfaces are mounted together, then
  neither surface's create path can issue a second `POST /api/wikis`, and every control the latch
  dims resolves to a sentence saying why.
- Given a latch released by a server render, when the release lands, then no unknown-outcome sentence
  survives on either surface and every confirm the latch shut is live again.
- Given `WikiSwitcher` mounted with no latch provider above it, when an unconfirmed write latches,
  then it holds and releases exactly as it does today.

## Spec Change Log

## Review Triage Log

## Design Notes

One flag, two release owners, and a private ref per surface:

```tsx
// WikiWriteLatch.tsx — the shared half
const [message, setMessage] = useState<string | null>(null);
const latchedRef = useRef(false);
const raise = useCallback((next: string) => { latchedRef.current = true; setMessage(next); }, []);
const release = useCallback(() => { latchedRef.current = false; setMessage(null); }, []);

// each surface — the private half, unchanged in shape from DW-429
const raisedHereRef = useRef(false);
useEffect(() => {
  if (!raisedHereRef.current) return;   // a stated refusal is not made untrue by a render
  raisedHereRef.current = false;
  setCreateError(null); /* …this surface's errors only… */
  releaseLatch();                       // idempotent; both surfaces key on the same render
}, [wikis, currentWikiId, releaseLatch]);
```

`releaseLatch` is safe in the dependency list precisely because it is stable, which `latched` and
`message` are not — adding either would fire the effect on the commit that raises the latch and drop
it before the write has any answer. Both surfaces stay mounted for the life of the shell (the Wiki
canvas is hidden, never unmounted — see `useSurfaceVisibility.ts:8-12`), so no holder can disappear
while holding the latch.

The shared latch carries the SENTENCE, not just a boolean, because that is what lets a control
dimmed by another surface's write explain itself — the whole point of DW-430, now across the seam.
The card's success-path latch stays local for the same reason in reverse: it has no sentence, and
the control it guards (`No wiki yet.`) is stale on that card alone.

## Verification

**Commands:**
- `pnpm exec vitest run src/components/__tests__/create-wiki-flow.test.tsx src/components/__tests__/wiki-switcher-lifecycle.test.tsx src/components/__tests__/wiki-write-latch-parity.test.tsx src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/create-wiki-ui.test.ts` -- expected: all pass
- `pnpm test` -- expected: the failing-file set is byte-identical to the `ab263b98` baseline (13 files, all `src/components/workbench/__tests__`, `window.localStorage` undefined)
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: no new findings
