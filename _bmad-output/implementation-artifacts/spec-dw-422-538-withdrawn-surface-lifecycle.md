---
title: 'A withdrawn surface stops working, and the withdrawal holds in the cascade'
type: 'bugfix'
created: '2026-09-02'
baseline_revision: '89e965de72added7acbe7c8bc07d1a7d228132bf'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** (DW-422) `PreviewColumn` publishes `SurfaceVisibilityProvider` for the two `ConfirmDialog`s beneath it, but nothing in the column itself reads the withdrawal: its fetch effect is keyed on `[selection, dataVersion, editing, retryNonce]` with no visibility term, so a `dataVersion` bump landing during a Settings visit still refetches the row, still nudges the watcher through `requestDataVersionCheck()`, and still writes sentences into a polite region that `hidden` has removed from the accessibility tree — the announcement is spent with nobody to hear it and the column the owner comes back to has changed under them with no report. `ModeCanvas` already has the answering shape (`active={mode === X && !hidden}` on every canvas it mounts) but nothing executes it, so it can be undone silently. (DW-538) `ModeCanvas` sets `hidden` on eight `.wb-canvas-pad` divs while `.wb-canvas-pad` declares only `padding` — there is no `.wb-canvas-pad[hidden]` rule at all, so that withdrawal rests on the user-agent default, which loses to ANY author `display`: a strictly weaker position than the (0,2,0) one DW-415 already judged insufficient for the four sibling surfaces.

**Approach:** Make the withdrawal a term in the rule the column already executes rather than a fact only its dialogs are told — `previewFetchPlan` gains a `visible` input that answers "do nothing" while the surface is off screen and leaves `shown` untouched, so returning is one silent refresh of the row the owner left. The watcher nudge and the live-region writes take the same gate through two small helpers that HOLD while withdrawn and flush once on return, so nothing owner-visible is dropped and nothing is spoken into a region nobody is listening to. Pin `ModeCanvas`'s existing gate with a case that executes it. And give `.wb-canvas-pad` the fifth `[hidden]` withdrawal rule with the DW-415 `!important` floor, which the stylesheet's own mechanism scan then enforces.

## Boundaries & Constraints

**Always:** The withdrawal is ONE fact with ONE spelling — the `hidden` prop `PreviewPane` already receives, which is the same boolean its `SurfaceVisibilityProvider` publishes; nothing derives it a second way and nothing calls `useSurfaceVisible()` where the prop is in scope. Every rule a node suite can execute stays in a pure module: `previewFetchPlan` decides whether a run may fetch, and the component types no `hidden &&` beside it. A held nudge and a held sentence are flushed EXACTLY once on return, and a reset (a pick) drops a held sentence, because clearing the region is a request for silence about the previous row. The new CSS rule carries `display: none !important`, the floor DW-415 established, and is stated outside every media query like its four siblings.

**Block If:** Gating the fetch effect on visibility cannot be expressed without also gating the reset/clear path — i.e. if a withdrawn run would still have to discard the editor or the draft to stay correct. That would mean withdrawing had become closing, and the mechanism needs rethinking rather than forcing.

**Never:** Do not cancel, abort or reset anything the owner is holding when the surface goes off screen — no closing the editor, no dropping the draft, no aborting an in-flight save or revert; withdrawing is not closing. Do not gate `requestDataVersionCheck()` or `subscribeDataVersionCheck()` inside `workbench-data-version.ts` — the bus is shared, and the gate belongs to the caller. Do not touch `.wb-canvas-pad`'s existing `padding`/`padding-left` declarations (`workbench-split.test.ts:1873` reads that rule body by literal `".wb-canvas-pad {"`). Do not make `previewFetchPlan`'s new input optional — a default would let the component drop it silently. Do not add a sixth `[hidden]` surface, restyle any pane, or edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `dataVersion` bumps while the Preview is withdrawn | Settings open, column `hidden`, provider payload bumped | No request is issued, no sentence reaches the column's live region, and the row the column last read stays recorded | Nothing is reset; the payload, the editor and the draft are untouched |
| Settings closes over that bump | The same column comes back on screen | Exactly one refresh of the SAME row with `reset: false`, so `Loading…` never flashes, and its outcome announces normally | An unreachable refresh leaves the last-good bytes, as it does on screen |
| A read settles while the column is withdrawn | A fetch started on screen resolves after `hidden` went true | The sentence it computed is HELD, not written, and lands in the region once when the column returns | A second held sentence replaces the first; only one is ever flushed |
| A save or revert settles while withdrawn | `save()`/`confirmRevert()` reaches a nudge site with `hidden` true | The watcher nudge is HELD, not dropped, and fires once on return | Any number of writes while withdrawn collapse into that single nudge |
| First render already withdrawn | Column mounts with `hidden` true and a selection | No read at all; the first read happens when it comes on screen, and it is a full reset because no row was ever recorded | `loading` stays true, which is what it means |
| A pick resets the column | `plan.reset` is true | The region is cleared AND any held sentence is dropped — no sentence about the previous row survives into this one | No error expected |
| A mode canvas is withdrawn over a bump | Graph mode showing, Settings opened, `dataVersion` bumped | `GraphCanvas` issues no read while `active` is false, and exactly one when it comes back | No error expected |
| An author rule sets `display` on a withdrawn `.wb-canvas-pad` | `.wb-shell[data-collapsed="true"] .wb-canvas-pad { display: flex }` appended after the stylesheet | The pane still computes `display: none` — the floor outranks the (0,3,0) competitor | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-data-version.ts` -- DW-422's rule site. `PreviewFetchPlan` :320-339 and `previewFetchPlan` :362-374 (the three-outcome function; `visible` becomes a REQUIRED fourth input and the FIRST term, returning `{ fetch: false, reset: false, shown: input.shown }`). `requestDataVersionCheck` :396-408 and `subscribeDataVersionCheck` :387 are UNCHANGED — the gate belongs to the caller.
- `src/components/workbench/PreviewColumn.tsx` -- DW-422's fix site. `SurfaceVisibilityProvider` wrapper :246-260 (published for the two `ConfirmDialog`s; `PreviewPane` takes the same `hidden` as a PROP :274 and that prop is the gate). The `payloadRef`/`goneRef` render-time ref idiom :276-290 is the shape a `hiddenRef` copies. The DW-520 scroll block :447-566 shows the `hidden`-keyed effect convention. Fetch effect :568-755, deps :755. The three live-region writers: :686 (`ok`), :740 (unreachable), :1178 (revert landed). The reset clear `setRefreshAnnouncement("")` :610. The four `requestDataVersionCheck()` calls: :928 and :958 in `save()`, :1151 and :1183 in the revert path. Live region `<p className="wb-sr-only" aria-live="polite">` :1461.
- `src/lib/live-region.ts` -- READ-ONLY. `nextAnnouncement` :60-64 (`""` clears and is never marked; an identical sentence gets the alternating repeat mark). Every write stays a state UPDATER through it.
- `src/components/workbench/ModeCanvas.tsx` -- READ-ONLY for DW-422 (the shape is already there: `active={mode === X && !hidden}` at :297, :312, :328, :342, :361, :375 with `wikiShowing` :145 and `SurfaceVisibilityProvider` :248), and DW-538's evidence: the eight `.wb-canvas-pad` divs carrying `hidden` at :255, :268, :276, :288, :303, :319, :333, :350, :369.
- `src/components/workbench/GraphCanvas.tsx` -- READ-ONLY. `if (!active) return;` over `[active, load, dataVersion]` :165-168 is the exact "gate while withdrawn, one refresh on return" property the new ModeCanvas case executes; `load` reads `/api/graph/workbench` :142.
- `src/app/globals.css` -- DW-538's fix site. `.wb-canvas-pad` :2704-2707 (padding only — leave both declarations alone). The four floored withdrawals `.wb-canvas-mode[hidden]` :2735, `.wb-canvas[hidden]` :2757, `.wb-preview[hidden]` :2782, `.wb-tree-panel[hidden]` :2803 are the precedent and the comment style; the new rule goes directly after the `.wb-canvas-pad` block, outside every media query.
- `src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` -- where DW-538 is observed. `SURFACES` :101-118 (each with a (0,3,0) competitor keyed on a `data-` attribute `Workbench` really writes), `mountShell` :131-148, and the mechanism scan's hardcoded four-selector list :258-264.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` -- where DW-422's column half is observed. `renderShell`/`refresh` and the `answer` fetch stub, `columnAnnounced()` :242-244 (reads `.wb-preview .wb-sr-only` directly, so it works while the column is `hidden`), `announced()` :238, `row()` :263, and the existing Settings case :578-601 for how Settings is opened and closed here.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- where DW-422's ModeCanvas half is observed. `renderShell`/`refreshShell` :181-211 (a bump is a new provider payload), `clickRail` :219, `closeSettings` :316, `fetchMock` :139-165.
- `src/lib/__tests__/workbench-data-version.test.ts` -- the `previewFetchPlan` describe :953-1010 (ten calls that WILL BREAK on the new required input) and the source scan :1468 pinning the call's exact spelling and :1479 pinning the dep array.
- `src/components/workbench/Workbench.tsx` -- READ-ONLY. `previewOpen = previewDocked && !settingsOpen` :401 and `hidden={!previewOpen}` :1954 are why a Settings visit is what withdraws the column.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-data-version.ts` -- add a required `visible: boolean` to `previewFetchPlan`'s input and make it the FIRST branch, returning `{ fetch: false, reset: false, shown: input.shown }`; extend the docblock with the fourth outcome and say why `shown` is left UNCHANGED (so the return is one silent refresh, not a row that looks read but never was). -- The rule the node suite executes is where the withdrawal belongs; a condition typed in the component could not be run.
- `src/components/workbench/PreviewColumn.tsx` -- add a render-assigned `hiddenRef` plus `heldAnnouncementRef`/`heldNudgeRef` and two helpers (`announce(sentence)`, `nudgeWatcher()`) that hold while withdrawn; route the three live-region writers and the four `requestDataVersionCheck()` calls through them; pass `visible: !hidden` to `previewFetchPlan` and add `hidden` to the fetch effect's deps; drop a held sentence beside the existing `setRefreshAnnouncement("")` in the reset block; add one `hidden`-keyed effect that flushes both held values exactly once on return. -- Async callbacks close over an older render, so the withdrawal has to be readable from a ref; holding rather than dropping is what keeps an owner-visible outcome from being spent unheard.
- `src/app/globals.css` -- add `.wb-canvas-pad[hidden] { display: none !important; }` directly after the `.wb-canvas-pad` block, with a comment naming the eight panes it withdraws, why the attribute is in the selector, why the floor rather than specificity is what holds (DW-415), and why it sits outside every media query. -- The eight mode panes are withdrawn by the same mechanism as the four floored surfaces and currently rest on the UA default alone.
- `src/lib/__tests__/workbench-data-version.test.ts` -- add `visible: true` to the ten existing `previewFetchPlan` calls, add a withdrawn describe covering the matrix rows (no fetch, no reset, `shown` unchanged and returned by IDENTITY; a withdrawn NEW row still records nothing), and widen the source scan at :1468 to require `visible` in the call and `hidden` in the dep array. -- The input is required precisely so the component cannot drop it; the scan is what makes that true of the call site too.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` -- add a DW-422 describe: with a row picked and Settings open, a bump changing the bytes issues NO preview request and leaves the column's region unchanged; closing Settings then issues exactly one request and announces `PREVIEW_UPDATED_COPY` once; and a case that the editor's draft and the recorded row survive the visit untouched. -- This is the failure as an owner meets it, on a mounted shell, in the region a screen reader listens to.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- add a DW-422 case pinning `ModeCanvas`'s existing gate: in Graph mode, opening Settings and bumping `dataVersion` issues no `/api/graph/workbench` read, and closing Settings issues exactly one. -- The property is already true and nothing executes it, so it can be undone silently.
- `src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` -- add `wb-canvas-pad` as a fifth `SURFACES` entry with a (0,3,0) competitor keyed on a `data-` attribute the shell really writes, and add `.wb-canvas-pad[hidden]` to the mechanism scan's expected selector list. -- The suite's competitor case is what proves the new rule wins rather than merely exists.

**Acceptance Criteria:**
- Given a surface that goes off screen while holding owner state, when it is withdrawn, then nothing it holds is closed, reset or aborted — the withdrawal only stops work nobody could observe.
- Given the Preview column comes back on screen after a withdrawal that spanned a bump, when its effect re-runs, then the owner is told what changed by exactly one refresh of the row they left, never by a sentence spoken while they were away.
- Given a write settles while the column is withdrawn, when the column returns, then the watcher is nudged exactly once however many writes settled.
- Given `.wb-canvas-pad` carries `hidden` and a higher-specificity author `display` rule targets it, when the engine resolves the cascade, then the pane computes `display: none`.
- Given a new `[hidden]` withdrawal rule in the stylesheet, when the mechanism scan runs, then it is named in the expected list and carries the floor.

## Spec Change Log

## Review Triage Log

## Design Notes

`previewFetchPlan`'s withdrawn outcome returns the UNCHANGED `shown`, and that is the whole of the resume behaviour:

```ts
if (!input.visible) return { fetch: false, reset: false, shown: input.shown };
if (!isSameSelection(input.shown, input.next)) return { fetch: true, reset: true, shown: input.next };
```

A run while withdrawn records nothing, so the row the column last read is still the recorded one on return — `isSameSelection` then answers `true` and the plan is `{ fetch: true, reset: false }`: one silent refresh, no `Loading…` flash, no discarded draft. Had the withdrawn branch advanced `shown`, the return would have looked like a row that was already read.

The nudge and the sentence are HELD rather than dropped because both are about something that really happened. A save settling mid-visit really did bump the kernel's tail and the other readers are withdrawn too, so one pending flag collapses any number of writes into the single check the return needs; a read that settled off screen really did change what the column shows, and the return refresh compares against the payload that read already installed, so dropping the sentence would leave the change unreported by anyone.

WHERE THE HOLD IS ACTUALLY REACHED. `hidden` joining the fetch effect's deps means the withdrawal re-runs that effect, and its cleanup aborts the in-flight read — so a read started on screen answers `stale` rather than settling, and the fetch branch's hold is a guard rather than a live path. The reachable instance of the same rule is `confirmRevert`, which is a plain callback nothing withdraws: a Restore the owner presses and then leaves settles against a `hidden` column, and its sentence — the one destructive success this panel produces — is held and read out on the way back (`preview-revision-history.test.tsx`, "a restore that lands off screen is HELD, not spent"). Matrix row 3's expected behaviour is pinned there; its stated input (a fetch, rather than a write, settling off screen) is what the abort removed.

Matrix row 6's second clause is a guard for the same structural reason: a sentence can only be held while `hidden`, the flush effect is declared ahead of the fetch effect so it empties the ref on the return commit, and no pick is reachable while the column is withdrawn (the tree panel is behind the same Settings surface). Its first clause — no sentence about the previous row survives into the next — is executed by `preview-announcements.test.tsx`, "does not carry one row's update sentence onto the next row".

DW-422's `ModeCanvas` half is coverage, not a rewrite: every canvas it mounts already takes `active={mode === X && !hidden}` and guards its read with `if (!active) return;`, which IS the property `PreviewColumn` is being brought up to. `SearchCanvas` and `ChatCanvas` take no `active` and issue no unprompted read (`SearchCanvas` fetches only from its form; `ChatCanvas`'s loads are `[]`-keyed) — evidence, not a change.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/workbench-split.test.ts src/lib/__tests__/workbench-chrome.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__` -- expected: all pass, including the three new blocks.
- `pnpm test` -- expected: both projects green, no new warnings.
- `pnpm lint` -- expected: clean.
