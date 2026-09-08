---
title: 'One unconfirmed-write latch across the wiki card and the header switcher, raised by the re-template and announced by the picker'
type: 'bugfix'
created: '2026-09-02'
baseline_revision: '89e965de72added7acbe7c8bc07d1a7d228132bf'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A create that SUCCEEDS on either wiki surface leaves the other surface's create fully
      live for the length of `router.refresh()`, so one click there still seeds the second
      wiki the latch exists to prevent.
    evidence: |-
      Pre-existing and unchanged by DW-515/516/517, which share the UNCONFIRMED half only.
      `WikiWorkbench.create`'s success path raises the component-local `awaitingCreate`
      (read by that card's opener and confirm alone); `WikiSwitcher.create`'s success path
      raises nothing at all. Both surfaces stay mounted together and both POST `/api/wikis`,
      and nothing enforces unique wiki names. Demonstrated by mounting both under one
      `WorkbenchDataProvider`, letting the card's create resolve 2xx, and pressing the
      header's `Create`: a second `POST /api/wikis` is issued while every existing suite
      stays green. The consequence is the one the shared latch was built for — a duplicate
      wiki made active, moving every prompt onto its template.
    location: >-
      src/components/WikiWorkbench.tsx (create, success branch) and
      src/components/workbench/WikiSwitcher.tsx (create, success branch)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three holes in the DW-409/429/430 latch. (DW-516) `WikiWorkbench`'s `awaitingCreate`
(`:113`) and `WikiSwitcher`'s `awaitingWrite` (`:163`) are independent `useState` flags on two
components `page.tsx`/`Workbench.tsx` render together, both opening the same `CreateWikiDialog` onto
the same `POST /api/wikis`; nothing enforces unique wiki names, so an unconfirmed create latched on
one surface leaves the other's create fully live and one click seeds the second wiki the latch exists
to prevent. (DW-515) `applyTemplate` (`:303-344`) composes the same unconfirmed sentence through
`writeFailure` and fires `router.refresh()` but raises no latch, `templateError` is not among the
errors the release effect clears, the dialog stays open and the reset effect keys on
`[currentWikiId, currentId]` — which a re-template does not move — so after the refresh the owner
sees a live `Overwrite` under a stale "the outcome is unknown" alert, over a card already showing the
new scenario. (DW-517) While the latch is up the switcher `<select>` carries `disabled={switching}`
(false) and `aria-disabled` only for `readOnly`, so it announces as an ordinary live combobox, the
change is swallowed by `switchWiki`'s early return, React re-applies the value, and
`selectDescribedBy` (`:446`) names only the scope and read-only notes — the picker refuses in total
silence.

**Approach:** Lift the unconfirmed half of the latch out of both components into one shared piece of
client state that carries the SENTENCE it was raised beside, so every wiki write control on both
surfaces is shut by an unknown outcome anywhere and every dimmed control can resolve to a sentence
saying why. Raise that same latch from `applyTemplate`'s unconfirmed branch and drop `templateError`
with it. Give the latched `<select>` the `aria-disabled` its read-only sibling already carries and
put the latch's sentence in `selectDescribedBy`, so the refusal announces its reason instead of
snapping back mute.

## Boundaries & Constraints

**Always:** The latch keeps riding `confirmDisabled` and never `busy` — Cancel, Esc and
outside-click stay live on every dialog, and the rename field stays editable. A surface clears only
its OWN error state, and only when its own ref says it raised the standing latch. The shared latch is
released by whichever holder's release effect runs on the arriving server render
(`[wikis, currentWikiId]`); release is idempotent. `useWikiWriteLatch` degrades to component-LOCAL
state when no provider is above it, so a bare-mounted `WikiSwitcher` behaves exactly as it does
today. Every raise of any latch is mirrored into the ref its release effect reads, on the adjacent
line. The `<select>` keeps `aria-disabled` and NEVER `disabled` — a keyboard owner must still reach
it and read which wiki is active — while the card's transient opener keeps `disabled`.

**Block If:** The shared latch cannot be released without a consumer depending on it (a dependency
that fires the release effect on the commit that RAISES the latch); or the shared state cannot be
read by `WikiSwitcher`, which takes props from `Workbench.tsx` rather than reading `WorkbenchData`
directly.

**Never:** Do not touch `writeFailure`, `unconfirmedWriteMessage` or any wording either composes, and
do not add a copy constant — every sentence a control shows is the one `writeFailure` already made.
Do not make either surface optimistic. Do not widen `busy`. Do not put the card's SUCCESS-path latch
into the shared state: a succeeded create shuts a control that is stale on the card only
(`WIKI_EMPTY_COPY`), and it carries no sentence to explain a dimmed control anywhere else. Do not add
a second `role="alert"` announcing a sentence an open dialog is already announcing. Do not edit the
deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-template, unconfirmed outcome | `POST /api/wikis/[id]/template` rejects with `TimeoutError`/`AbortError` | Unknown-outcome alert inside the dialog, `router.refresh()` fired, `Overwrite` latched dead, Cancel and Esc live | A second `Overwrite` press issues no second POST |
| Re-template, latch released | Latched as above, then a fresh `wikis` array arrives | `Overwrite` is live again and the unknown-outcome sentence is gone from the dialog | No error expected |
| Re-template, stated refusal | `POST` answers 404 with a reason | Reason shown in the dialog, no latch, confirm live once a different scenario is picked, and an unrelated server render leaves the sentence alone | Next `Overwrite` is taken immediately |
| Card create unconfirmed, header watching | Card's `POST /api/wikis` unconfirmed, both surfaces mounted | The header's `New Wiki` dialog opens with a DEAD `Create` carrying the card's sentence; no second `POST /api/wikis` from either surface | Both confirms return on a server render |
| Header create unconfirmed, card watching | Switcher's `POST /api/wikis` unconfirmed, both surfaces mounted | The card's empty-state `Create Wiki` is `disabled` (never `aria-disabled`) and its `aria-describedby` resolves to the switcher's sentence | Both released together on a server render |
| Unconfirmed switch, picker refuses again | `PUT /api/wikis/current` unconfirmed, then a second change event | No second PUT, the value snaps back, and the `<select>` is `aria-disabled="true"` with `aria-describedby` resolving to the unknown-outcome sentence | Picker live and mute again after a server render |
| Latch raised elsewhere, picker watching | Card create or switcher create/rename/delete unconfirmed | The `<select>` is `aria-disabled` and describes itself with that write's sentence, rendered once and NOT as a second alert | Released with the latch |
| Stated refusal on one surface, latch raised on the other | Card holds a stated create refusal; switcher raises an unconfirmed latch; a server render arrives | The card's stated sentence is still on screen — only the surface that raised the latch clears its own errors | Never cleared by a render the owner did not cause |
| No provider above the switcher | `WikiSwitcher` mounted bare (its own suite) | Every DW-375/DW-409 behaviour unchanged: the latch raises, holds and releases locally | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/WikiWriteLatch.tsx` -- NEW. The shared latch: context, provider and
  `useWikiWriteLatch()`. Follow `WorkbenchData.tsx`'s "degrades outside the provider" convention
  (`:88`, `EMPTY_DATA`), but degrade to component-LOCAL state rather than to a constant, because a
  bare `WikiSwitcher` must still latch.
- `src/components/workbench/WorkbenchData.tsx` -- the seam. `WorkbenchDataProvider` :91-127 wraps
  every consumer of both surfaces (`src/app/page.tsx:114-147` puts `Workbench` and `WikiWorkbench`
  inside it), so the latch provider nests INSIDE `WorkbenchDataContext.Provider` at :121-126. It
  needs no props: each surface's existing release effect calls `release()`.
- `src/components/WikiWorkbench.tsx` -- DW-515 and half of DW-516. `createNoteId` :76,
  `createUnknownNoteId` :85; `createError`/`templateError` :90-91; `awaitingCreate` docblock+state
  :92-113 and `awaitingCreateRef` :114-128; `createUnknownNote` :150-166 and `createDescribedBy`
  :167-176; reset effect :192-201 (`[currentWikiId, currentId]`); release effect :216-221; `create`
  guard :250 and raises :267-268 / :294-295; `applyTemplate` :303-344 (guard :314, unconfirmed
  branch :341); empty-state opener :371-414 (`disabled` :393, `aria-describedby` :401, handler guard
  :409) and the retained note :428-432; `CreateWikiDialog` :500-509 (`confirmDisabled` :507);
  template `ConfirmDialog` :511-570 (`confirmDisabled` :528, `error={templateError}` :529, body
  `<select disabled={busy}>` :545).
- `src/components/workbench/WikiSwitcher.tsx` -- DW-517 and the other half of DW-516.
  `awaitingWrite` docblock :125-162, state :163, ref :164-178; release effect :229-237; `switchWiki`
  guard :246, unconfirmed branch :277-303 (the pre-emptive clear gated on `awaitingWriteRef.current`
  :295); `create` :314, `rename` :353, `remove` :386 guards and raises :339-340 / :373-374 /
  :418-419; `selectDescribedBy` :446-450; the `<select>` :470-512 (`disabled={switching}` :482,
  `aria-disabled` :488, `onChange` :489-505); the switcher's `<p role="alert">` :615-619; the three
  openers' `if (!awaitingWrite) set*Error(null)` :532 / :581 / :605; the three dialogs'
  `confirmDisabled` and `error={... ?? (awaitingWrite ? error : null)}` :625/:635, :650/:652,
  :715/:717; rename Enter guard :693.
- `src/lib/workbench-request.ts` -- READ-ONLY. `writeFailure` is still the only thing that decides a
  latch is warranted, and the only place a sentence is composed.
- `src/app/globals.css` -- READ-ONLY evidence. `.wb-wiki-switch-select[aria-disabled="true"]`
  (:3832-3837) already carries the dimmed face, so the latched picker needs no new rule;
  `.wb-wiki-switch-error` (:3843) is the note face to reuse.
- `src/lib/__tests__/workbench-left-column.test.ts` -- source scans that WILL BREAK: :401-402
  (`if (busy || awaitingWrite) return;` ×3), :423 (`if (switching || awaitingWrite) return;`),
  :431 (rename Enter guard literal), :446-450 (the card's guard counts and
  `confirmDisabled={awaitingCreate}`), :472-481 (the DW-429 raise/ref parity counts).
- `src/lib/__tests__/create-wiki-ui.test.ts` -- source scans that WILL BREAK: :243
  (`confirmDisabled={pendingScenario === current?.scenario}`).
- `src/components/__tests__/create-wiki-flow.test.tsx` -- the card mounted under
  `WorkbenchDataProvider`. `data()` :48-64, `mount()` :67-77, `answer()` :81-83, `button()` :102,
  `describedByText()` :112-118, `openTemplateDialog()` :120-124. The re-template unconfirmed case
  :513-536 WILL BREAK at :534 (`Overwrite` is now latched dead until a server render). The create
  latch cases :540-694 must stay green.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- the switcher mounted BARE
  (`mount()` :91-93), which is the local-degradation case; everything in :728-1171 must stay green.
  The read-only a11y pins :1355-1362 and :1379-1391 assert exact `aria-describedby` lists and the
  absence of `aria-disabled` on a writable, UNLATCHED deployment — both still hold.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- pins the read-only opener's
  description to exactly `WIKI_CREATE_READ_ONLY_COPY` (:148). Must stay green.
- Test environment: the `dom` project is fully green at `89e965de` (70 files, 1070 tests), so a new
  mounted suite has no baseline failures to work around.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/WikiWriteLatch.tsx` -- NEW. Export `WikiWriteLatchProvider({ children })`
  holding one `useState<string | null>` (the sentence; `latched` is `message !== null`) and
  `useWikiWriteLatch()` returning `{ latched, message, raise(message), release() }` with
  `raise`/`release` stable across renders (`useCallback`). Outside a provider the hook returns an
  equivalent object backed by its own local state, so a bare-mounted consumer keeps today's
  behaviour. Document why the provider holds no release effect of its own (each surface already owns
  a ref-gated one, and that gate is what separates a stale sentence from a stated refusal) and why
  the card's success path is not admitted here.
- `src/components/workbench/WorkbenchData.tsx` -- nest `WikiWriteLatchProvider` inside
  `WorkbenchDataContext.Provider` so both surfaces share one latch under the seam `page.tsx` already
  composes.
- `src/components/WikiWorkbench.tsx` -- consume the shared latch; narrow `awaitingCreate` to the
  SUCCESS path only and say so in its docblock; shut the opener, the create confirm and both
  handlers on `awaitingCreate || latched`; derive `createUnknownNote` from the shared message so the
  dimmed opener explains a latch raised by the header too; raise the shared latch from BOTH
  unconfirmed branches (`create` and `applyTemplate`), guard `applyTemplate` on it, gate the
  `Overwrite` `confirmDisabled` on it and give the template dialog the same `error ?? shared message`
  fallback the switcher's three dialogs carry; clear `templateError` alongside `createError` in the
  release effect, gated on the card's own raise ref, and note why that cannot wipe a stated refusal.
- `src/components/workbench/WikiSwitcher.tsx` -- replace the local `awaitingWrite` state with the
  shared latch across its four guards, three `confirmDisabled`, the rename Enter guard, the three
  opener keep-the-sentence guards and the three dialogs' fallback (which now falls back to the SHARED
  message, since the latch may be the card's); keep a private "this switcher raised the standing
  latch" ref for the release effect's error clearing and read the SHARED latch in `switchWiki`'s
  pre-emptive clear so a card-raised latch is recognised as somebody else's. DW-517: add
  `aria-disabled` for the latch beside `readOnly` on the `<select>`, render the refusal's sentence
  once (the existing `role="alert"` node when the switch itself failed, otherwise a muted note
  carrying the shared message and NO alert role), give that node an id and append it to
  `selectDescribedBy` while and only while the latch is up. Update the `awaitingWrite` docblock: one
  latch, now six writes across two components, and what a shared release means.
- `src/lib/__tests__/workbench-left-column.test.ts` -- retarget the guard-spelling, guard-count and
  DW-429 raise/ref parity pins onto the new spellings, keeping each pin's stated reason true: the
  parity pin must still make "every raise is mirrored" enforceable, now counting shared-latch raises
  against each surface's ref lines.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- update the template `confirmDisabled` literal and
  extend its comment: the confirm is now latched by an unknown outcome as well as by a no-op
  scenario.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- fix the re-template unconfirmed case to
  assert the latch (dead `Overwrite`, live Cancel and Esc, no second POST) and add: a server render
  gives `Overwrite` back and takes the sentence away; a STATED template refusal never latches and
  survives an unrelated render.
- `src/components/__tests__/wiki-write-latch-parity.test.tsx` -- NEW. Mount `WikiSwitcher` and
  `WikiWorkbench` together under one `WorkbenchDataProvider`, as `Workbench.tsx` renders them, and
  cover the cross-surface matrix rows including the negative one (a stated refusal on one surface is
  not cleared by the other's latch release) and DW-517's picker announcement for a latch raised on
  the card.

**Acceptance Criteria:**
- Given an unconfirmed re-template, when the owner presses `Overwrite` again, then no second
  `/api/wikis/[id]/template` request is issued and the dialog is still dismissible.
- Given an unconfirmed write on either wiki surface with both mounted, when the owner reaches the
  other surface's create control, then it cannot issue a second `POST /api/wikis` and it resolves to
  a sentence saying why.
- Given a latch released by a server render, when the release lands, then no unknown-outcome sentence
  survives on either surface and every control the latch shut is live again.
- Given `WikiSwitcher` mounted with no latch provider above it, when an unconfirmed write latches,
  then it holds and releases exactly as it does today.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 24: (high 0, medium 0, low 24)
- addressed_findings:
  - `[medium]` `[patch]` `switchWiki`'s pre-emptive clear had gained a second condition
    (`&& !latchedRef.current`) that inverted the branch's purpose in the cross-surface case:
    the sentences it drops are the SWITCHER's own dialogs' stated refusals, so a latch the
    card raised is somebody else's and those stale messages should be cleared — skipping the
    clear re-presented a stale 409 beside a confirm dead for the card's re-template, which is
    exactly the mis-attached-sentence shape the branch exists to prevent. Restored
    `if (!raisedLatchRef.current)`, deleted the `latchedRef` mirror and its effect (removing a
    one-commit lag and an entirely untested branch), and rewrote the comment.
  - `[medium]` `[patch]` The latched `<select>`'s description could name the wrong write: with
    a STATED switch refusal standing and a latch raised elsewhere, the picker went
    `aria-disabled` for the latch but was described by the answered 404. The single node also
    toggled `role="alert"` on an element React reuses, which is not reliably announced. Split
    into two nodes — the `role="alert"` error node (now with an id) and a description-only
    latch note — and pointed `selectDescribedBy` at whichever carries the LATCH's sentence.
  - `[low]` `[patch]` The provider nesting that makes the latch shared in the real shell was
    pinned by nothing, and `useWikiWriteLatch`'s local fallback makes its loss silent rather
    than a crash. Added a source scan over `WorkbenchData.tsx`, and retargeted the picker's
    description pin onto the Patch 2 spelling.
  - `[low]` `[patch]` The rename and delete overlays' new cross-surface `error` fallback was
    exercised by no test — either line could be deleted with the suite green. Added parity
    cases asserting each overlay shows the card's sentence beside its dead confirm.
  - `[low]` `[patch]` The `wikis.length > 0` gate on the latch note was untested; removing it
    left every suite green while putting a second copy of the sentence on a screen with no
    picker to describe. Added a single-copy assertion, plus a case for the mis-attribution
    Patch 2 fixed. Also replaced a `not.toContain(" ")` inference with a resolved-id-list
    comparison in two suites.

## Design Notes

One shared sentence, and a private "I raised it" ref per surface:

```tsx
// WikiWriteLatch.tsx — the shared half
const [message, setMessage] = useState<string | null>(null);
const raise = useCallback((next: string) => setMessage(next), []);
const release = useCallback(() => setMessage(null), []);

// each surface — the private half, unchanged in shape from DW-429
useEffect(() => {
  if (!raisedHereRef.current) return;  // a stated refusal is not made untrue by a render
  raisedHereRef.current = false;
  releaseLatch();                      // idempotent; the other holder's effect is a no-op
  setCreateError(null); setTemplateError(null);  // this surface's errors only
}, [wikis, currentWikiId, releaseLatch]);
```

`releaseLatch` is safe in the dependency list precisely because it is stable, which `latched` and
`message` are not — either would fire the effect on the commit that RAISES the latch and drop it
before the write has any answer. That is also why the provider holds no release effect of its own:
the ref gate is what tells a stale sentence from a stated refusal, and it lives per surface. Both
surfaces stay mounted for the life of the shell (`ModeCanvas` keeps the Wiki subtree behind `hidden`
and never unmounts it; the switcher sits in `.wb-left-head`), so no holder can disappear holding the
latch.

The shared state carries the SENTENCE, not just a boolean, because that is what lets a control dimmed
by another surface's write explain itself — DW-430's rule, now across the seam. The card's
success-path latch stays local for the same reason in reverse: it has no sentence, and the control it
guards is stale on that card alone.

DW-517's node is one element, not two: while the switch itself failed, the existing
`<p role="alert" className="wb-wiki-switch-error">` already carries the sentence and was announced
when it appeared — it only needs an id and a place in `selectDescribedBy`. When the latch came from
somewhere else the same node renders the shared message with NO alert role, because the dialog that
raised it is already announcing that sentence, and a second live region would say it twice.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec vitest run src/components/__tests__/create-wiki-flow.test.tsx src/components/__tests__/wiki-switcher-lifecycle.test.tsx src/components/__tests__/wiki-write-latch-parity.test.tsx src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/create-wiki-ui.test.ts` -- expected: all pass.
- `pnpm test` -- expected: both projects green, no new failures against the `89e965de` baseline.
- `pnpm lint` -- expected: no new findings.

## Auto Run Result

Status: done

**Implemented change.** The unconfirmed half of the wiki write latch was lifted out of both
surfaces into one shared piece of client state that carries the SENTENCE `writeFailure` composed,
mounted inside `WorkbenchDataProvider` — the seam `page.tsx` already wraps around both the header
`WikiSwitcher` and the `WikiWorkbench` card. All six writes now raise it (the switcher's create,
rename, delete and switch; the card's create and, newly, `applyTemplate`), every write control on
both surfaces is shut by an unknown outcome anywhere, and every control the latch dims resolves to
the sentence for the write actually in doubt. `applyTemplate` gained the latch it never had and
`templateError` now drops with it. The latched `<select>` reports `aria-disabled` (never
`disabled`) and appends the latch's sentence to `selectDescribedBy`, so the refusal announces its
reason instead of snapping back silently. Each surface keeps a private "I raised the standing
latch" ref, which is what still separates a stale unknown-outcome sentence from a stated refusal
the owner is still reading; outside a provider the hook degrades to component-local state, so a
bare-mounted `WikiSwitcher` behaves exactly as before.

**Files changed**
- `src/components/workbench/WikiWriteLatch.tsx` — NEW. The shared latch: context, provider and
  `useWikiWriteLatch()`, with a local-state fallback outside the provider.
- `src/components/workbench/WorkbenchData.tsx` — nests `WikiWriteLatchProvider` inside
  `WorkbenchDataContext.Provider`, around the same children.
- `src/components/WikiWorkbench.tsx` — `awaitingCreate` narrowed to the success path; the
  unconfirmed create and `applyTemplate` raise the shared latch; opener, both handlers and both
  dialogs gated on it; `templateError` cleared with `createError` in the release effect.
- `src/components/workbench/WikiSwitcher.tsx` — local `awaitingWrite` replaced by the shared latch
  across four guards, three confirms, the rename Enter path, the three opener guards and the three
  dialogs' fallback; DW-517's `aria-disabled`, the split error/latch notes and the picker's
  description.
- `src/lib/__tests__/workbench-left-column.test.ts` — guard-spelling, guard-count and DW-429
  raise/ref parity pins retargeted; new scans for the picker's description and the provider nesting.
- `src/lib/__tests__/create-wiki-ui.test.ts` — the template confirm and error literals updated.
- `src/components/__tests__/create-wiki-flow.test.tsx` — the re-template unconfirmed case now
  asserts the latch; release and stated-refusal cases added.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` — the picker's latched announcement
  and its release asserted.
- `src/components/__tests__/wiki-write-latch-parity.test.tsx` — NEW. Both surfaces under one
  provider: the cross-surface create rows, the picker announcing a card-raised latch, the
  rename/delete overlay fallback, the single-copy gate, the mis-attribution case and the negative
  row.

**Review findings breakdown.** 5 patches applied (2 medium, 3 low), 1 item deferred (low), 24
rejected. Follow-up review recommended: true — no high-severity patch, and
`3 × 2 medium + 1 × 3 low = 9`, which is at or above 5.

**Verification.**
- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec vitest run` over the six suites named above — 192 tests, 6 files, all pass.
- `pnpm test` — 362/363 files pass. The single failure is
  `src/lib/__tests__/storage-fs.test.ts` (`reapStrandedScratchFiles`, a 5s timeout and `ENOTEMPTY`
  on a temp directory under parallel load). It passes on its own, an earlier full run of this
  branch was 363/363 green, and it touches no file this change edits.
- `pnpm lint` — no findings; output identical to the `89e965de` baseline's three pre-existing
  `jsx-ast-utils` notices.
- Every I/O matrix row is covered by a named case that ran and passed in the runs above.

**Residual risks.**
- A second unconfirmed write raised while the latch is already up overwrites the standing
  sentence with its own. Both writes are genuinely unresolved and every control stays correctly
  shut, so the sentence remains a true statement about a write in doubt — but the surface that
  raised the first one now names the second.
- Release still depends on a fresh `wikis` identity arriving from `router.refresh()`. That was
  already true of both per-surface latches; sharing the latch widens the blast radius of a refresh
  that never lands from one surface to two.
- The parity suite composes the two surfaces directly rather than through `Workbench`, so the real
  shell's nesting is pinned by a source scan rather than by a mounted render.
