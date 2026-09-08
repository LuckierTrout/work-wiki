---
title: 'Read-only surfaces refuse without leaving the tab order (DW-189, DW-191)'
type: 'bugfix'
created: '2026-08-20'
baseline_revision: '60e21dd972869fe652cbffc5a691b265ee357b70'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `/settings` still refuses read-only by disabling its whole form fieldset —
      the identical DW-191 defect, one section above the form this change fixed.
    evidence: |-
      `src/app/settings/page.tsx:118` is
      `<fieldset disabled={readOnly} className="max-w-4xl disabled:opacity-60">`
      around `ProviderForm`, `StructuredKnowledgeSettings`, `EmbeddingSettings`,
      the Save submit (`:161`) and `Test Connection` (`:167`) — and that same
      page renders `<WorkspacePurposeSettings />` at `:205`. So after this change
      one scroll of `/settings` refuses read-only two contradictory ways: the
      lower form keeps every stored value readable and in the tab order, the
      upper one still removes the stored provider, model, base URL, embedding
      model and the (non-writing) `Test Connection` button from it entirely.
      `SettingsCanvas` — the Workbench twin of that same form — already refuses
      per control. No suite mounts `src/app/settings/page.tsx` at all
      (no test file references it), so the inconsistency is invisible in both
      directions. Pre-existing; the bundle intent names WorkspacePurposeSettings
      and WikiWorkbench only.
    location: src/app/settings/page.tsx:118
    severity: medium
  - summary: >-
      `/api/names-terms` and `/api/email/settings` have no `isReadOnly()` gate,
      so those Settings forms silently SUCCEED on a read-only deployment.
    evidence: |-
      `src/app/api/names-terms/route.ts:23` (POST),
      `src/app/api/names-terms/[id]/route.ts:15,39` (PUT, DELETE) and
      `src/app/api/email/settings/route.ts:45` (PUT) contain no `isReadOnly`
      reference and reach no kernel writer, so `YOPEDIA_READONLY=1` does not
      refuse them. `NamesTermsSettings` and `EmailIngestSettings` render
      immediately below `WorkspacePurposeSettings` on the same page, so the owner
      now meets three behaviours in one column: a form that refuses and says so,
      a form that refuses by removing itself from the tab order (the entry
      above), and two that write. Pre-existing and wider than a surface fix —
      the doors need gating before their surfaces can mirror anything.
    location: src/app/api/names-terms/route.ts:23
    severity: medium
  - summary: >-
      The `!wiki` leg of WorkspacePurposeSettings' fieldset carries the same
      tab-order harm DW-191 named, on bytes the route answers so they can be READ.
    evidence: |-
      After this change the gate is `disabled={loading || saving || !wiki}`. The
      `!wiki` leg is also true after a FAILED load, and the route deliberately
      answers a retired tenant-global profile's fields with `wiki: null` "so the
      owner can SEE them" (the component's own comment at :83-88, pinned by
      `workspace-purpose-settings.test.tsx:203` which reads
      `purposeField().value`). A disabled fieldset removes all of it from the tab
      order, so exactly the text that case exists to show is unreachable by
      keyboard and screen reader. Not fixed here because the bundle intent names
      only the read-only refusal mechanism, and the fix is a different decision
      (a form with nothing to save is not the same as a deployment that refuses
      to save).
    location: src/components/WorkspacePurposeSettings.tsx:283
    severity: medium
  - summary: >-
      `WIKI_READ_ONLY_COPY` is the one client refusal sentence with no case in
      `read-only-copy-parity.test.ts`, and it demonstrably differs from its route.
    evidence: |-
      This change added parity cases for `WIKI_TEMPLATE_READ_ONLY_COPY`,
      `WIKI_CREATE_READ_ONLY_COPY` and `WORKSPACE_PURPOSE_READ_ONLY_COPY`, and
      the second of those proves `POST /api/wikis` answers "Wikis cannot be
      created while this deployment is read-only." — so the switcher's
      four-verb `WIKI_READ_ONLY_COPY` (src/lib/workbench-tree.ts:120) does not
      match any single door it sits in front of. That is defensible (it covers
      four routes at once, like the Revert narrowing already recorded), but it is
      unrecorded: the suite's own header says every client constant is compared
      "CHARACTER-IDENTICAL where the door answers its own refusal, and explicitly
      recorded where it deliberately does not", and this one is neither.
      Pre-existing (DW-37 shipped it unpinned).
    location: src/lib/__tests__/read-only-copy-parity.test.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two surfaces state the read-only refusal with the wrong mechanism. `WorkspacePurposeSettings.tsx:222` wraps every field AND the Save button in `<fieldset disabled={… || readOnly || …}>`, and `disabled` on a fieldset removes every descendant from the tab order — so on a read-only deployment a keyboard or screen-reader user cannot read the stored Workspace Purpose at all (the DW-65 harm at full-form scale). `WikiWorkbench` ignores the `readOnly` flag its own `WorkbenchData` context already carries, so `Change template` opens a destructive confirm dialog onto `POST /api/wikis/[id]/template`, which has answered 403 since before this work — the confirm-then-403 shape DW-149 names, one card away from the switcher already fixed.

**Approach:** Adopt on both surfaces the refusal convention `WikiSwitcher` and `SettingsCanvas` already established: `readOnly` on text inputs and textareas, `aria-disabled` plus a handler that returns early on `<select>`s and buttons, never `disabled`, with the standing sentence wired to each refused control through `aria-describedby`. `WikiWorkbench` takes no props (DW-174), so the fact is read from `useWorkbenchData()` — one line, no new seam.

## Boundaries & Constraints

**Always:**
- A read-only refusal keeps the control in the tab order and readable: `readOnly` for `<input>`/`<textarea>`, `aria-disabled` plus an early return for `<select>` and `<button>`. `disabled` stays ONLY for transient states (`saving`, `busy`, `awaitingCreate`).
- Every control refused for read-only resolves the refusal sentence through `aria-describedby`; a control's own existing hint is kept and the refusal appended, as `SettingsCanvas.describedBy` does.
- The early return IS the whole refusal — no handler puts a control back by hand (`WikiSwitcherProps.readOnly` owns the explanation of why React re-applies the controlled value).
- A refusal is stated BEFORE any `window.confirm` or dialog opens, never after.
- Client refusal copy lives as an exported constant beside its surface and is pinned against the server sentence it mirrors in `src/lib/__tests__/read-only-copy-parity.test.ts`.
- Runtime identifier stays `YOPEDIA_READONLY`; copy says work-wiki.

**Block If:**
- Making a control readable on a read-only deployment cannot be done without changing an observable outcome for a writable (`YOPEDIA_READONLY` unset) deployment.

**Never:**
- Do not change the non-read-only legs of `WorkspacePurposeSettings`'s gate. `loading`, `saving` and `!wiki` keep the `disabled` fieldset exactly as today — `!wiki` carries the same tab-order harm but is a separate, unnamed defect; record it, do not widen.
- Do not restyle beyond keeping a read-only affordance visible, add a dependency, add i18n, or touch the deferred-work ledger.
- Do not gate `Load scenario draft`'s `!selectedTemplate` leg or the `ConfirmDialog`'s `confirmDisabled` leg — those are value-state, not deployment-state.
- Do not change any route, status code or response body.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Purpose fields, read-only | `GET /api/workspace-profile` answers `readOnly: true` with a stored purpose and a wiki | Every textarea/input focusable and carrying the stored text, reporting `readonly`; the scenario `<select>` focusable and `aria-disabled`; the read-only sentence resolvable from each through `aria-describedby` | No request issued |
| Purpose save, read-only | Same, owner activates `Save Workspace Purpose` | Button focusable, `aria-disabled`, not `disabled`; `save()` returns before `fetch` | No `PUT`, no feedback banner |
| Scenario draft, read-only | Same, owner activates `Load scenario draft` | `aria-disabled`; form values unchanged, so the stored purpose the owner is reading is not overwritten by a template draft | No state change |
| Purpose, writable | `readOnly: false`, wiki present | Every control interactive exactly as today; the read-only sentence absent | Unchanged |
| Purpose, no wiki | `readOnly: false`, `wiki: null` | Unchanged from today: the fieldset stays `disabled`, Save stays `disabled` | Unchanged |
| Change template, read-only | `WorkbenchData.readOnly` true, a current wiki | Button focusable, `aria-disabled`, reason announced; no `ConfirmDialog` opens | No request |
| Create Wiki (canvas empty state), read-only | `readOnly` true, no current wiki | Button focusable, `aria-disabled`, reason announced; no `CreateWikiDialog` opens | No request |
| Canvas, writable | `readOnly` false | `Change template` and `Create Wiki` open their dialogs as today; no read-only sentence rendered | Unchanged |
| Canvas, registry unavailable | `registryUnavailable` true | Unchanged: the read-error panel only, no read-only sentence competing with it | Unchanged |

</intent-contract>

## Code Map

- `src/components/WorkspacePurposeSettings.tsx:222` -- `<fieldset disabled={loading || saving || readOnly || !wiki}>` with `className="disabled:opacity-60"`; `readOnly` is local state set from the GET at `:89`. `:230` scenario `<select>`, `:243` `Load scenario draft` button (`disabled={!selectedTemplate}`), `:259`/`:273`/`:283`/`:293`/`:316` textareas, `:306` `outputLanguage` input, `:328` submit (`disabled={saving || readOnly || !wiki}`), `:344` the already-correct sentence "Workspace Purpose cannot be changed while this deployment is read-only." — it needs an `id` and an owning exported constant. `save()` at `:125` fetches with no read-only guard. `applyTemplate()` at `:114` mutates form state only.
- `src/components/workbench/SettingsCanvas.tsx:266-370` -- the convention to copy verbatim: `field()` id helper, `readOnlyNoteId`, `describedBy(hintId)` appending the note id to the control's own hint, `readOnly={stored.readOnly}` on `<input>`, `aria-disabled` + `if (stored.readOnly) return;` on `<select>`, and the note rendered with an `id` at `:617`.
- `src/components/workbench/WikiSwitcher.tsx:50-72` -- the docstring that OWNS the convention's rationale (`aria-disabled` not `disabled`; the early return is the whole refusal). New comments point here rather than restating it. `:264-272` is the `aria-describedby` list join; `:333-345` and `:364-371` are the button + note render to mirror.
- `src/components/WikiWorkbench.tsx:54` -- `const { wikis, currentWikiId, registryUnavailable } = useWorkbenchData();` — `readOnly` is already on that context and is destructured here in one line. `:231` empty-state `Create Wiki` (`disabled={awaitingCreate}`, transient — keep), `:270` `Change template` opening `setTemplateOpen(true)`, `:177` `applyTemplate()` posting to `/api/wikis/[id]/template`, `:141` `create()` posting to `/api/wikis`. The card takes NO PROPS (DW-174) — do not add one.
- `src/components/workbench/WorkbenchData.tsx:58-69` -- `readOnly: boolean` already on the context with `EMPTY_DATA` defaulting to `false`; `src/app/page.tsx` feeds it `isReadOnly()`.
- `src/app/api/wikis/[id]/template/route.ts:25-29` -- 403 "Templates cannot be applied while this deployment is read-only."; `src/app/api/wikis/route.ts:43` -- 403 "Wikis cannot be created while this deployment is read-only."; `src/app/api/workspace-profile/route.ts:68` -- 403 "Settings are read-only in this deployment." These are the sentences parity is measured against.
- `src/lib/workbench-tree.ts:120` -- `WIKI_READ_ONLY_COPY` (switcher: created/switched/renamed/deleted). It does NOT cover templates, so the canvas needs its own constant; that module is the established home for left-column/canvas sentences.
- `src/lib/__tests__/read-only-copy-parity.test.ts:22-24` -- imports each client constant and compares it to `READ_ONLY_REFUSAL`; character-identical where the door answers its own refusal, explicitly recorded where it narrows.
- `src/lib/read-only.ts:24-43` -- why client copy cannot import `READ_ONLY_REFUSAL` (it pulls `./config` and `process.env` into the browser bundle), and the rule that a client sentence MAY narrow the server's.
- `src/lib/__tests__/create-wiki-ui.test.ts:232-240` -- comment-stripped negative scan over `WikiWorkbench.tsx`: bans `/new wiki/i` and `/active wiki/i`. Any constant or comment added to that file must avoid both phrases. `:305` pins `router.refresh()` at exactly 2 occurrences.
- `src/components/__tests__/workspace-purpose-settings.test.tsx:55-63` -- `formFieldset()` reads the gate off `saveButton().closest("fieldset")` because jsdom's `.disabled` on a descendant reflects only its own attribute. `:158-208` are the `!wiki` / load-failed cases that MUST stay green (fieldset still `disabled`). No read-only case exists yet.
- `src/components/workbench/__tests__/workbench-read-only-seam.test.tsx:37-50,84-116` -- `data(readOnly)` fixture and the mounted refusal assertions for the switcher; the canvas card is rendered as `<p>canvas</p>` there, so the card needs its own mounted coverage.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx:36-49` -- the `WikiRecord` fixture and provider-mount pattern for `WikiWorkbench`.
- `src/app/globals.css:2929-2956` -- `.wb-wiki-switch-note` / `.wb-wiki-switch-readonly` rules; `:3619` `.wb-set-bar-note`. A canvas note reuses an existing note face rather than inventing a third.
- `vitest.config.ts` -- two projects: `node` collects `src/**/__tests__/**/*.test.ts`, `dom` collects `*.test.tsx`. Mounted assertions must live in a `.test.tsx` file.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-tree.ts` -- export two constants, `WIKI_TEMPLATE_READ_ONLY_COPY` and `WIKI_CREATE_READ_ONLY_COPY`, each documented like `WIKI_READ_ONLY_COPY` -- two constants, not one: the two canvas controls sit in mutually exclusive branches (`Change template` needs a current wiki, `Create Wiki` renders only when there is none), so a merged sentence would name an action the owner cannot see beside either. Each must mirror its route's sentence character-for-character and must not contain the phrases the DW-33 scan bans.
- `src/components/WorkspacePurposeSettings.tsx` -- export `WORKSPACE_PURPOSE_READ_ONLY_COPY` holding the existing `:344` sentence verbatim, give that `<p>` an `id`, drop `readOnly` from the fieldset's `disabled` predicate (keep `loading || saving || !wiki`), put `readOnly` on all five textareas and the `outputLanguage` input, `aria-disabled` + an early return on the scenario `<select>` and on `Load scenario draft`, `aria-disabled={readOnly}` on the submit (keeping `disabled={saving || !wiki}`), an early return at the top of `save()`, and `aria-describedby` wiring the sentence to every control refused this way -- the refusal must stop removing readable text from the tab order while still refusing.
- `src/components/WorkspacePurposeSettings.tsx` -- keep a visible read-only affordance now that `disabled:opacity-60` no longer fires for it (a `readOnly`-conditioned class on the fieldset or the existing note's prominence) -- an unstyled read-only form that silently discards a keystroke is the sighted half of the same defect.
- `src/components/WikiWorkbench.tsx` -- destructure `readOnly` from `useWorkbenchData()`, add `aria-disabled` + a pre-dialog early return to `Change template` and to the empty state's `Create Wiki`, render the owning sentence with an `id` in each branch, and wire both with `aria-describedby` -- the fact is one line away on a context the card already reads, and the confirm dialog names an irreversible overwrite the route will refuse. Add nothing matching `/new wiki/i` or `/active wiki/i` (DW-33 scan).
- `src/app/globals.css` -- add the canvas note face only if no existing class fits -- a third bespoke note style for one sentence is drift, not design.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add the three new client constants: the two canvas sentences against the template and wikis-create route sentences, and `WORKSPACE_PURPOSE_READ_ONLY_COPY` recorded as a deliberate NARROWING of `/api/workspace-profile`'s "Settings are read-only in this deployment." -- the file exists precisely because these halves drift silently.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- add a read-only describe asserting the matrix's first four rows: fields focusable and `readonly` with the stored text present, the `<select>` and both buttons `aria-disabled` and NOT `disabled`, the sentence resolvable through `aria-describedby`, no `fetch` on submit or on `Load scenario draft`, and the writable control -- the existing `!wiki` cases stay untouched and must stay green.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` or a new `.test.tsx` beside it -- mount `WikiWorkbench` inside `WorkbenchDataProvider` with `readOnly: true`, once with a current wiki and once without, asserting each control is focusable and `aria-disabled`, that clicking opens NO dialog, and the writable controls -- every existing fixture hard-codes `readOnly: false`, which is why no suite can express this case today.

**Acceptance Criteria:**
- Given a read-only deployment, when the Workspace Purpose form has loaded, then every stored value is reachable by keyboard and exposed to assistive technology, and no control on the form reports `disabled`.
- Given a read-only deployment, when the owner activates any refused control on either surface, then no dialog opens, no `fetch` is issued, and no on-screen value changes.
- Given a writable deployment, when the full suite runs, then every existing assertion about both surfaces passes unchanged.
- Given the copy-parity suite, when it runs, then each new client sentence either matches the server sentence its door answers or is recorded as a deliberate narrowing.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 4: (high 0, medium 3, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The fieldset carried `opacity-60` while read-only, dimming the stored purpose, key questions and scope lists — the sighted half of the very defect this change removes, since that text is what the owner is entitled to read. Removed; the visible affordance is now the amber sentence plus `opacity-60` on the three controls that refuse and hold no content.
  - `[medium]` `[patch]` The scenario picker's `if (readOnly) return;` was the only thing refusing that control (`aria-disabled` does not stop interaction) and no test fired a change on it — deleting the guard left the whole suite green while `fireEvent.change` moved the value off the stored scenario. Added a read-only case asserting the value is unchanged and no draft banner appears; verified by mutation that it is the only case that fails without the guard.
  - `[low]` `[patch]` `Load scenario draft` could be `disabled` AND `aria-disabled` at once (read-only plus `scenario: "custom"`), so the control left the tab order and its `aria-describedby` refusal was never announced — the exact harm this change exists to remove, in a reachable combination. The value-state leg now yields to deployment state (`disabled={!readOnly && !selectedTemplate}`), with cases for both the read-only/custom and writable/custom combinations.
  - `[low]` `[patch]` `applyTemplate()` and `create()` in `WikiWorkbench` had no read-only guard of their own. `readOnly` arrives on a server render, so a `router.refresh()` can flip it true while a confirm or create dialog is open, and the dialog-reset effect keys on the active wiki, which such a refresh need not move — Confirm would then POST into the 403 this change exists to stop. Added `if (readOnly) return;` as a backstop beside the existing `if (busy) return;`; the opener guards are unchanged.
  - `[low]` `[patch]` The new `routeSource()` parity assertions used a bare `toContain`, which matches the sentence anywhere in the handler — a reworded response body with the old sentence surviving in a comment or dead branch would still pass. All three now pin against the served field (`error: "<sentence>"`).
  - `[low]` `[patch]` `WorkbenchData.readOnly`'s docstring enumerated its consumers and had gone stale — `WikiWorkbench` is now a third, reading the context directly because the card takes no props (DW-174). Rewritten.

## Design Notes

`SettingsCanvas` shows the shape to copy, including the reason a `<select>` gets `aria-disabled` where an `<input>` gets `readOnly` (there is no `readonly` for `<select>`) and why the early return alone restores the value:

```tsx
const describedBy = (hintId: string) =>
  readOnly ? `${hintId} ${readOnlyNoteId}` : hintId;

<select
  aria-disabled={readOnly || undefined}
  onChange={(e) => { if (readOnly) return; setScenario(e.target.value); }}
  aria-describedby={describedBy(hintId)}
/>
```

DW-282 in the ledger names both `WikiWorkbench` controls (`Create Wiki` and `Change template`) where DW-189 names only the second. Gating just one would leave the card threaded with a fact it applies to half its buttons, so both are done here; the orchestrator records which entries that resolves.

## Verification

**Commands:**
- `npx vitest run` -- expected: both projects green, including the new read-only cases and the untouched `!wiki` / load-failed cases in `workspace-purpose-settings.test.tsx`.
- `npx tsc --noEmit` -- expected: no new type errors.
- `npx eslint` -- expected: no new errors (`jsx-a11y` in particular, since `aria-disabled` on interactive elements is the intended pattern).

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Both read-only surfaces now refuse with the convention `WikiSwitcher` and `SettingsCanvas` established, instead of by removing content from the tab order or by opening a dialog onto a 403.

`WorkspacePurposeSettings` (DW-191): `readOnly` is no longer a leg of the form's `<fieldset disabled>`, so on a read-only deployment every stored value stays focusable and readable. The five textareas and the `outputLanguage` input carry `readOnly`; the scenario `<select>`, `Load scenario draft` and the Save submit carry `aria-disabled` plus handler guards that return before any state change or fetch; the existing sentence at the foot of the form gained an id and every refused control points at it through `aria-describedby`. `loading`, `saving` and `!wiki` keep the fieldset exactly as before.

`WikiWorkbench` (DW-189, and DW-282 in full): the card reads `readOnly` off the `WorkbenchData` context it already consumes — no prop, so DW-174 stands. `Change template` and the empty state's `Create Wiki` are `aria-disabled`, described by their own owned sentence, and return before their dialogs open; `applyTemplate()` and `create()` carry backstop guards for a `readOnly` that flips while a dialog is already open.

### Files changed

- `src/components/WorkspacePurposeSettings.tsx` -- per-control read-only refusal replaces the whole-form `disabled` fieldset; exports `WORKSPACE_PURPOSE_READ_ONLY_COPY`.
- `src/components/WikiWorkbench.tsx` -- reads `readOnly` from context; both write controls refuse before their dialogs open, with backstop guards in the handlers.
- `src/lib/workbench-tree.ts` -- `WIKI_TEMPLATE_READ_ONLY_COPY` and `WIKI_CREATE_READ_ONLY_COPY`, one owner per canvas sentence.
- `src/components/workbench/WorkbenchData.tsx` -- `readOnly`'s docstring names the card as a third consumer.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- three sentences pinned against the `error:` field their routes actually serve; the Workspace Purpose narrowing recorded as a deliberate difference.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- a read-only describe covering reachability, the refused controls, the picker guard, the draft guard, the custom-scenario combination and the writable control.
- `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` (new) -- the card mounted under a real provider with `readOnly: true`, with and without a current wiki, plus the writable and `registryUnavailable` controls.

### Review findings breakdown

- Patches applied: 6 (medium 2, low 4) -- see the Review Triage Log entry for 2026-08-20.
- Items deferred: 4 (medium 3, low 1) -- `/settings`'s own disabled fieldset, four ungated Settings write routes, the `!wiki` leg of this form's gate, and the unpinned `WIKI_READ_ONLY_COPY`.
- Items rejected: 10 (all low) -- hover-face styling (the cited exemplar `DeletePageButton` does the same), test-helper duplication, a shared read-only primitive/copy module, two true sentences for one door, the generic parity invariants' stated scope, untested Tailwind classes, focus-on-refused-activation, ledger bookkeeping (orchestrator-owned), and the scope expansion being invisible to a diff-only reader (it is recorded in this spec).

### Follow-up review recommendation

`true`. Patched counts: high 0, medium 2, low 4. Score = 3 x 2 + 1 x 4 = 10, which is >= 5.

### Verification performed

- `npx vitest run` -- 252 files / 5324 tests passed (5321 before triage; +3 from the patch cases). Every I/O matrix row is covered by a case that ran and passed, and the pre-existing `!wiki` and failed-load cases in `workspace-purpose-settings.test.tsx` are untouched and green.
- `npx tsc --noEmit` -- clean.
- `npx eslint` -- exit 0; the three `jsx-ast-utils` TSNonNullExpression notices are pre-existing and byte-identical to the baseline.
- The picker guard was verified by mutation: deleting `if (readOnly) return;` fails the new case and only that case.

### Residual risks

- The four deferred items above are the real residue, and the first two matter most: `/settings` now refuses read-only two contradictory ways within one scroll, and two of the forms on that page still write on a read-only deployment because their routes are ungated.
- Reachability is asserted through DOM attributes and programmatic focus in jsdom (`hasAttribute("disabled")`, `.readOnly`, `document.activeElement`), not through real tab traversal or an accessibility-tree read. `describedByText()` resolves each id through `document.getElementById`, so a dangling pointer fails, but announcement itself is not observed.
- The visible read-only affordance (the amber sentence plus `opacity-60` on the refusing controls) carries no test; a styling regression there would not fail the suite.
