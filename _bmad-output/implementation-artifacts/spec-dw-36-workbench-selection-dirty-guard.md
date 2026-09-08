---
title: 'Workbench selection: dirty guard and tab-correcting restore (DW-36, DW-46)'
type: 'bugfix'
created: '2026-08-17'
status: 'in-review'
baseline_revision: '2a6c629867237186069a780e80e1c00f07d4fa02'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two ways the tree selection mishandles a pick. (DW-36) `PreviewColumn`'s fetch effect calls `setEditing(false)` on every new pick, so one stray click on a tree row silently destroys unsaved markdown the owner typed into the confirm-gated editor. (DW-46) `restorableSelection` validates a stored row against the Wiki id and the two trees but never against the tree TAB restored alongside it, so a stored page/Files pairing — which `wikilinkSelection` deliberately produces — docks a Preview describing a row the showing tree cannot mark with `aria-current`, and the mount effect's signature guard then protects the mismatch from being cleared.

**Approach:** (DW-36) The column reports one boolean UP — "the editor holds unsaved text" — and the shell gates the pick on it: a pick made while dirty is HELD behind a discard confirm instead of applied, so Cancel leaves the editor, the selection and the marked row exactly where they were. (DW-46) `restorableSelection` returns the row AND the tab that can mark it; the mount effect restores into that tab, and the restore signature it arms names the same tab so the reset effect still cannot clear what was just restored.

## Boundaries & Constraints

**Always:**
- The reset effect's dependency array stays exactly `[mode, currentWikiId, treeTab]`, and the frozen restore call sites (`setModeState(restoredMode)`, `setCollapsed(readStoredCollapsed())`, `setTreeTab(readStoredTreeTab())`, `writeStoredTreeTab(next)`, …) stay verbatim — this work adds beside them.
- Every decision is an executed pure function in `src/lib/*` (`selectionTab`, `previewDraftDirty`), never a condition typed into JSX or an effect.
- The restore signature `restoreSignatureRef.current` is armed with the SAME tab the restore actually switches to, or the reset effect never re-arms and stops clearing forever.
- Reuse `ConfirmDialog` — no second dialog implementation, and never two overlays open at once.
- A failed/held pick changes nothing: no announcement, no `ownerPickedRef` write, no storage write.

**Block If:** nothing — DW-46's pairing decision is recorded in the ledger ("Restore the tab, not reject the row").

**Never:**
- Do not gate the LEAVE paths (mode switch, Wiki switch, tab switch, Settings) on the dirty check — the ledger defers that to whichever story gives the editor a lifecycle; only the tree-selection path is in scope.
- Do not change the live `wikilinkSelection` behaviour or make it switch tabs.
- Do not persist the corrected tab: the correction is a pure function of the restored row, so a reload reproduces it, and writing it would overwrite the owner's last explicit tab choice.
- No routing, no `next/link`, no `useRouter` in `Workbench.tsx`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clean pick | Editor closed, or open with `draft === seed` | Pick applies exactly as today: dock/undock, announcement, fetch | No error expected |
| Dirty pick | Editor open, `draft !== seed`, another row clicked | Selection unchanged, editor untouched, discard confirm opens naming the loss | No error expected |
| Dirty pick → Discard | Confirm pressed | The held pick applies: announcement, editor closes, new bytes fetched | No error expected |
| Dirty pick → Keep editing | Cancel / Esc / backdrop | Dialog closes, draft intact, old row still marked `aria-current` | No error expected |
| Dirty re-pick of the shown row | Editor dirty, same row clicked (would deselect) | Held too — undocking unmounts the editor, which is the same loss | No error expected |
| Column unmounts while dirty | Mode/Wiki/tab change undocks the Preview | Dirty flag reports `false` on unmount, so the next pick is not falsely gated | No error expected |
| Restore, kinds agree | Stored `{page alpha}` + stored tab `knowledge` | Row restored, tab stays `knowledge` | No error expected |
| Restore, kinds disagree | Stored `{page alpha}` + stored tab `files` | Row restored AND tab switched to `knowledge`; the row carries `aria-current` | No error expected |
| Restore declined | Stored row absent / another Wiki / no Wiki | `null` — nothing restored, stored tab untouched | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/PreviewColumn.tsx` -- `PreviewPane` holds the editor. Fetch effect `:200-295`; the `plan.reset` block `:231-247` is the unconditional `setEditing(false)` DW-36 names. `editingTargetRef` `:183` is the capture idiom to copy for the seed; `startEditing` `:312-337` seeds `draft` from `payload.body`; Cancel `:551-562`. Props interface `:80-105` gains `onDirtyChange`.
- `src/components/workbench/Workbench.tsx` -- the shell owns `selection` `:166`. `selectRow` `:575-591` is the pick site to split; `openPage` `:599-623` cannot fire while editing (the editor REPLACES the body, `PreviewColumn.tsx:523-578`) — document, do not guard. Mount restore `:296-310`; reset effect `:343-352` (deps frozen); `<PreviewColumn>` render `:933-950`. `latestRef`/`liveRef` `:205-221` are the render-assigned-ref idiom for dependency-free callbacks.
- `src/lib/workbench-tree.ts` -- `restorableSelection` `:296-305` (return type changes; parameters do NOT), `wikilinkSelection` `:336-346` (docstring gains the restore-path pointer), `TreeTabId` `:42`, `selectionExists` `:181-192`.
- `src/lib/workbench-preview.ts` -- copy constants `:375-441`; add the discard block beside `PREVIEW_EDIT_*` and `previewDraftDirty` beside `canEditPreview` `:134`.
- `src/components/ConfirmDialog.tsx` -- reuse as-is; `open/title/body/confirmLabel/cancelLabel/onConfirm/onCancel`, Esc + backdrop both call `onCancel`, focus restores to the opener (the tree row) — which is correct for both outcomes.
- Tests to UPDATE: `src/lib/__tests__/workbench-split.test.ts:571-602` (six `restorableSelection` expectations now compare `{ selection, tab }`), `:944-956` (`setSelection(restored)` becomes `setSelection(restored.selection)`), `:1005-1015` (signature pin). Leave `:997-1004` and `workbench-left-column.test.ts:72-82` frozen strings intact.
- Test harness to COPY: `src/components/workbench/__tests__/preview-announcements.test.tsx` — `renderShell`, the `fetch` stub routing `/api/workbench/preview` to `answer`, `row()`, `announced()`, `writeStoredSelection` seeding, `afterEach` ordering. `vitest.config.ts` puts `*.test.tsx` on jsdom, `*.test.ts` on node.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-tree.ts` -- add `selectionTab(selection): TreeTabId` ("page" → `knowledge`, "file" → `files`) and change `restorableSelection` to return `{ selection, tab } | null` -- the tab is the one that can MARK the row, which is the invariant the reset effect exists to protect.
- `src/lib/workbench-preview.ts` -- add `previewDraftDirty({ editing, draft, seed })` and the four discard sentences (`PREVIEW_DISCARD_CONFIRM_TITLE/BODY/CONFIRM_LABEL`, `PREVIEW_KEEP_EDITING_COPY`) -- one owner per wording, and a dirty rule a node test can execute.
- `src/components/workbench/PreviewColumn.tsx` -- capture the seed at `startEditing`, clear it wherever the editor closes, compute dirty via `previewDraftDirty`, and report it through a new required `onDirtyChange` prop in an effect whose cleanup reports `false` -- an unmounted column must not leave the shell gating picks on a draft that no longer exists.
- `src/components/workbench/Workbench.tsx` -- add `previewDirtyRef` + a stable `reportPreviewDirty`, split `selectRow` into `applySelection` (today's body) and a guard that parks the pick in `pendingSelection` state while dirty, render one `ConfirmDialog` for it, and correct the restored tab from `restorableSelection`'s new `tab` (including the armed signature) -- the pick site is the only place that can hold a selection change without touching the frozen reset effect.
- `src/lib/__tests__/workbench-split.test.ts` + `src/lib/__tests__/workbench-preview.test.ts` -- update the six `restorableSelection` expectations, add `selectionTab` and the kinds-disagree restore cases, add `previewDraftDirty` cases (closed editor, unedited draft, edited draft, null seed), and pin the new shell wiring by source scan -- these are the I/O matrix rows a node project can execute.
- `src/components/workbench/__tests__/preview-dirty-guard.test.tsx` -- NEW jsdom suite mounting the shell: dirty pick held, Discard applies, Keep editing preserves draft + `aria-current`, clean pick unaffected, dirty re-pick held, and a stored page + stored `files` tab restoring onto the Knowledge tab with the row marked -- the held pick is only observable on a mounted tree.

**Acceptance Criteria:**
- Given the Preview editor is open with edited text, when the owner clicks a different tree row, then the selection, the marked row and the textarea contents are all unchanged and a discard confirm is on screen.
- Given that confirm, when the owner presses the discard action, then the clicked row becomes the selection, the editor closes, and the dock announcement names the new row.
- Given that confirm, when the owner cancels it (button or Esc), then no second overlay ever appeared, the editor still holds the same text, and no announcement was made.
- Given the editor is open but nothing was typed into it, when the owner clicks another row, then the pick applies immediately with no confirm.
- Given a stored selection of kind `page` and a stored tree tab of `files`, when the shell mounts, then the Knowledge tab is selected, the page row carries `aria-current`, and a later tab switch still undocks the Preview (the reset effect re-armed).
- Given `pnpm test` and `pnpm lint`, when run, then both pass with no new warnings.

## Design Notes

The dirty flag travels UP as a boolean, not as the draft: the shell must decide whether to apply a pick, which needs one bit, and a shell that could read the text would become a second owner of the editor's state.

`pendingSelection` is state (it renders the dialog); `previewDirtyRef` is a ref (nothing renders from it, and it is read inside a click handler) — the same split `sheetOpenRef` and `liveRef` already use.

Two overlays cannot coexist: the discard dialog opens only when the editor is open, and the column's edit-confirm dialog is reachable only from an `Edit` button that renders `canEdit && !editing`.

```ts
// workbench-tree.ts — the tab a restored row can be MARKED on (DW-46).
export function selectionTab(selection: TreeSelection): TreeTabId {
  return selection.kind === "page" ? "knowledge" : "files";
}
```

```ts
// Workbench.tsx — inside the mount effect, after the frozen setTreeTab line.
const restored = restorableSelection(readStoredSelection(), wikiId, groups, nodes);
if (restored) {
  if (restored.tab !== restoredTab) setTreeTab(restored.tab);
  restoreSignatureRef.current = layoutSignature(restoredMode, wikiId, restored.tab);
  setSelection(restored.selection);
}
```

## Verification

**Commands:**
- `pnpm test` -- expected: both vitest projects green, including the new `.test.tsx` suite (the config throws if the DOM include collects nothing).
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean; the `restorableSelection` return-type change must surface every caller.
