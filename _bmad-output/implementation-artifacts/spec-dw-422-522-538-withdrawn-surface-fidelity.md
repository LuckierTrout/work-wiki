---
title: 'Withdrawn surface fidelity: Preview lifecycle, canvas-pad floor, dialog predicate'
type: 'bugfix'
created: '2026-09-04'
baseline_revision: '2e189623e66bec513c70da04f92dbf3bf21e53b0'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three surfaces are withdrawn in name only. `PreviewColumn` keeps its whole data lifecycle running behind `hidden`, so a `dataVersion` bump during a Settings visit refetches the row, can flip it to the stale note or the removal branch, and writes a sentence into a polite live region that is out of the accessibility tree (DW-422). The eight `.wb-canvas-pad` mode panes carry `hidden` with no backing CSS rule at all, so their withdrawal rests on the user-agent default, which loses to any author `display` (DW-538). `useDialogA11y`'s `withdrawn()` asks `getClientRects()`, which is non-empty for `visibility: hidden` — and blind to `content-visibility: hidden` and `inert` — so a `focus()` restore aimed into any of those three is still silently dropped (DW-522).

**Approach:** Gate the Preview column's fetch effect, its `requestDataVersionCheck()` nudges and its live-region writes on the column's own `hidden` prop, resuming with exactly one refresh and at most one deferred nudge on return. Add `.wb-canvas-pad[hidden] { display: none !important; }` beside its four siblings and extend the cascade suite to cover it. Move `withdrawn()` from `getClientRects()` to `Element.checkVisibility({ visibilityProperty: true })` plus an `[inert]` leg, keeping the `[hidden]` attribute route, and shim `checkVisibility` in `vitest.setup.dom.ts` so the node-mounted suites can state the three new hiding mechanisms.

## Boundaries & Constraints

**Always:**
- The column stays MOUNTED behind `hidden` — nothing here unmounts it, clears its payload, closes its editor or discards a draft (DW-412 is the reason it is mounted at all).
- Coming back from a Settings visit issues exactly ONE preview read, however many `dataVersion` bumps landed while hidden. An open editor still defers that read, as `previewFetchPlan` already decides.
- No decision moves into JSX or an effect body: `previewFetchPlan` keeps deciding what a run may touch; the visibility gate is a separate, stated precondition on the effect.
- Every shim lives in `vitest.setup.dom.ts` and nothing in `src/`; the new `checkVisibility` shim delegates to nothing and states its fidelity limit.
- The new stylesheet rule carries `display: none !important`, sits outside every media query, and is stated with the attribute in the selector, matching the four rules beside it.

**Block If:**
- The cascade suite's competitor cases cannot express `.wb-canvas-pad` without changing how the other four are asserted.

**Never:**
- Do not change `ModeCanvas`'s data lifecycle: each sub-canvas already receives `active={mode === "…" && !hidden}`, which is the same shape DW-422's decision asks for, and re-gating it is separate work.
- Do not touch the `SurfaceVisibilityProvider` contract or its default — the Preview already publishes `visible={!hidden}` and this gate reads the column's own prop, not the context.
- Do not drop the `closest("[hidden]")` leg from `withdrawn()`: it is the STATED withdrawal and answers where a stylesheet has overridden `display`.
- Do not add `checkOpacity`/`opacityProperty` (opacity-0 elements are focusable) or `contentVisibilityAuto` (a `content-visibility: auto` subtree is revealed on focus).
- Do not add a `typeof checkVisibility === "function"` capability guard in `src/`; the shim is the test-side answer.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bump while withdrawn | Preview docked on a row, Settings open (`hidden`), `dataVersion` bumps twice | No preview fetch is issued while hidden | No error expected |
| Return from Settings | The same column, Settings closed | Exactly one preview read, `loading` untouched, payload swapped silently | No error expected |
| Return with editor open | Draft typed, Settings opened and closed | No read at all; the draft and the `<textarea>` node are the same ones | No error expected |
| Save lands while withdrawn | Save in flight when Settings opens, resolves while hidden | No `requestDataVersionCheck()` while hidden; exactly one fires on return | No error expected |
| Announcement while withdrawn | A revert or a late fetch resolves while hidden | The polite region's text is unchanged | No error expected |
| Opener behind `visibility: hidden` | Dialog closes, opener connected inside a `visibility: hidden` ancestor | Focus is left where the owner put it | No focus call |
| Opener behind `content-visibility: hidden` / `inert` | Same, with each mechanism | Focus is left where the owner put it | No focus call |
| Ordinary opener | Dialog closes, opener on screen | Focus returns to the opener, unchanged | No error expected |
| `.wb-canvas-pad` withdrawal | `hidden` pane plus a (0,3,0) shell-scoped `display` competitor | Computes `display: none` | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/PreviewColumn.tsx` -- `PreviewPane`, the whole DW-422 surface. The fetch effect is `:595-782` (deps `[selection, dataVersion, editing, retryNonce]` at `:782`); `previewFetchPlan` is called at `:601`, the reset block writes `setRefreshAnnouncement("")` at `:636`, the sentence writes are `:713` (refresh) and `:767` (stale). `requestDataVersionCheck()` is called at `:955` (landed save), `:985` (unconfirmed save), `:1185` (unconfirmed revert) and `:1217` (landed revert). The polite region renders at `:1501-1503`. The `hidden` prop is documented at `:190-205`; `PreviewColumn` wraps `PreviewPane` in `SurfaceVisibilityProvider visible={!hidden}` at `:248`. The scroll-restore effect already keys on `[hidden]` (`:592`) — the precedent for adding it to a dep list. `payloadRef`/`goneRef` at `:277-286` are the assigned-during-render ref idiom to copy for a visibility ref.
- `src/lib/workbench-data-version.ts` -- `previewFetchPlan` (fetch/reset/shown, unchanged) and `requestDataVersionCheck` (a nudge to the watcher; the 10s interval still polls, so a deferred nudge loses nothing). READ-ONLY here.
- `src/hooks/useDialogA11y.ts` -- `withdrawn()` at `:89-91`, with its docblock at `:51-88` (the "only the ELEMENT can answer it" claim DW-522 says is broader than what it covers). Called twice, both in the arm effect's cleanup at `:187-188`.
- `vitest.setup.dom.ts` -- `displayHidden()` walks `hidden` + inline `display: none` up the chain and backs both `offsetParent` and `getClientRects`. The new `checkVisibility` shim goes beside them; the file's header states the "every shim lives HERE" rule.
- `src/test/dom-helpers.ts` -- the aliased door; its docblock enumerates the shims. No new export needed (a prototype override, not a control).
- `src/app/globals.css` -- `.wb-canvas-pad` at `:2720-2723` (padding only). The four withdrawal rules with their `!important` floor and their DW-415 argument: `.wb-canvas-mode[hidden]` `:2751`, `.wb-canvas[hidden]` `:2773`, `.wb-preview[hidden]` `:2798`, `.wb-tree-panel[hidden]` `:2819`.
- `src/components/workbench/ModeCanvas.tsx` -- the eight `.wb-canvas-pad` divs carrying `hidden={mode !== "…" || hidden}` at `:273, 294, 306, 321, 337, 351, 368, 387`. READ-ONLY: each sub-canvas already takes `active={… && !hidden}`.
- `src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` -- `SURFACES` at `:109-127` (className + a (0,3,0) competitor keyed on a `data-` attribute `Workbench` really writes), `mountShell`/`displays` at `:139-166`, `ALL_NONE` at `:167`, the three cascade cases at `:169-232`, and the mechanism scan at `:234-283` whose `expect(rules.map(…).sort())` hardcodes the four selectors.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- the DW-412 harness the new Preview cases belong in: `TREE_DATA` `:111-125`, `PREVIEW_PAYLOAD` `:129-137`, `fetchMock` `:155-159` (routes `/api/workbench/preview` by URL), `renderShell`/`refreshShell` `:181-211` (a rerender with a new provider payload is how `dataVersion` moves), `OPENERS` `:282` and `closeSettings`, `previewColumn()` `:485`, `editorNode()` `:494`, `openPreviewEditorWith()` `:506`.
- `src/hooks/__tests__/useDialogA11y.test.tsx` -- `CssHiddenColumnHost` at `:225-267` is the host to mirror for DW-522 (an inline style stating the CSS route, dialog rendered OUTSIDE the hidden column, surface NOT withdrawn so the hook really reaches the restore); the DW-421 describe block at `:475-561` is the shape for the new cases.
- `AGENTS.md:147-158` -- the prose list of what `vitest.setup.dom.ts` overrides.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/PreviewColumn.tsx` -- add a `hidden` gate to the fetch effect (early return above the `previewFetchPlan` call, `hidden` added to the dep list) so a withdrawn column reads nothing and records no `shown` row; add an assigned-during-render `hiddenRef` plus one `announce(sentence)` helper that no-ops while withdrawn, and route `:713`, `:767` and `:1217` through it; replace the four bare `requestDataVersionCheck()` calls with one helper that fires when showing and otherwise sets a `pendingVersionCheckRef`, and add a small `[hidden]`-keyed effect that fires exactly one deferred nudge on return. Comment each in the file's voice: WHY a withdrawn column must not read, announce or nudge, and why the return is one refresh rather than a replay. -- The DW-422 fix.
- `src/app/globals.css` -- add `.wb-canvas-pad[hidden] { display: none !important; }` beside the four sibling withdrawals, outside every media query, with a comment saying the pane currently rests on the UA default alone (which loses to ANY author `display`), that this is a strictly weaker position than the (0,2,0) one DW-415 already judged insufficient, and that the floor is what closes it. -- The DW-538 fix.
- `src/hooks/useDialogA11y.ts` -- rewrite `withdrawn()` as the `[hidden]` attribute route, an `[inert]` route, and `!node.checkVisibility({ visibilityProperty: true })`; update the docblock so its claim matches what it now covers, naming `visibility: hidden` (the closed rail below 899px), `content-visibility: hidden` and `inert`, and stating why opacity and `contentVisibilityAuto` are deliberately not asked. -- The DW-522 fix.
- `vitest.setup.dom.ts` -- add an `Element.prototype.checkVisibility` shim in its own section: `false` when not connected, when `displayHidden()` answers true, when an inline `content-visibility: hidden` is found up the chain, or — under `visibilityProperty`/`checkVisibilityCSS` — when the nearest ancestor-or-self carrying an inline `visibility` declares `hidden`/`collapse`. State the fidelity limit (no stylesheet, inline declarations only) as the neighbouring shims do. -- Makes the DW-522 predicate executable in the dom project.
- `src/test/dom-helpers.ts` and `AGENTS.md` -- add `checkVisibility` to the two prose enumerations of what the setup file overrides. -- Keeps both lists true.
- `src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` -- add `.wb-canvas-pad` to `SURFACES` with a (0,3,0) competitor keyed on a `data-` attribute the shell really writes, add its expected `display` to the `!important`-competitor case, and add `.wb-canvas-pad[hidden]` to the mechanism scan's hardcoded selector list; extend the file docblock from "four" to five. -- Covers the new rule's floor for real rather than only by text.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- add the DW-422 cases to the DW-412 block: no read while withdrawn across two bumps, exactly one read on return, no read on return with the editor open, no nudge while withdrawn and exactly one on return, and an unchanged live region for a resolution that lands while withdrawn. Mock `requestDataVersionCheck` the way `chat-conversation-crud.test.tsx` does. -- Pins the gate at the seam it is about.
- `src/hooks/__tests__/useDialogA11y.test.tsx` -- add a DW-522 describe block mirroring `CssHiddenColumnHost` for `visibility: hidden`, `content-visibility: hidden` and `inert`, each refusing the restore, plus the on-screen positive control. -- Pins the widened predicate.

**Acceptance Criteria:**
- Given a docked Preview and an open Settings surface, when the shell re-renders with a higher `dataVersion` twice, then no `/api/workbench/preview` request is issued.
- Given that state, when Settings closes, then exactly one `/api/workbench/preview` request is issued and the column's `loading` state is never re-entered.
- Given a Preview whose editor holds an unsaved draft, when Settings opens and closes, then no `/api/workbench/preview` request is issued and the `<textarea>` node and its value are the same ones.
- Given a write whose `requestDataVersionCheck()` would fire while the column is withdrawn, when it fires, then no check is requested until the column returns, and on return exactly one is requested.
- Given a resolution that writes an announcement while the column is withdrawn, when it resolves, then the polite region's text content is unchanged.
- Given the shipped stylesheet plus a (0,3,0) shell-scoped `display` rule aimed at `.wb-canvas-pad`, when a `.wb-canvas-pad[hidden]` element is mounted, then its computed `display` is `none`.
- Given the stylesheet scan, when it enumerates every `[hidden]` selector, then it finds exactly the five withdrawals and each carries `display: none !important`.
- Given a dialog whose opener is connected inside a `visibility: hidden`, a `content-visibility: hidden`, or an `inert` ancestor, when the dialog closes, then focus is not moved to the opener; and given an opener on screen, when it closes, then focus returns to the opener.

## Design Notes

The gate is the column's own `hidden` prop, not `useSurfaceVisible()`: `PreviewColumn` is the component that PUBLISHES the context, and reading back what it just published would be a longer way to say the same thing.

`requestDataVersionCheck()` is a nudge, not the only path — the watcher's 10s interval still polls — so deferring one costs at most a tick. Replaying exactly one on return is what keeps a save that landed just before the visit from waiting on that tick.

Shape for the helpers (the assigned-during-render ref idiom the file already uses at `:277-286`):

```ts
const hiddenRef = useRef(hidden);
hiddenRef.current = hidden;
const pendingVersionCheckRef = useRef(false);

function announce(sentence: string) {
  if (hiddenRef.current) return;
  setRefreshAnnouncement((current) => nextAnnouncement(current, sentence));
}
```

`checkVisibility` is called without a capability guard, in the same spirit as the `AbortSignal.timeout` this codebase already calls unguarded (`PreviewColumn.tsx`): it is Baseline across the browsers this app targets, and a guard would be the "reshape the component so it stops asking the platform" move `vitest.setup.dom.ts`'s header exists to refuse.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx src/hooks/__tests__/useDialogA11y.test.tsx` -- expected: all pass
- `pnpm test` -- expected: the whole run passes, both projects
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
