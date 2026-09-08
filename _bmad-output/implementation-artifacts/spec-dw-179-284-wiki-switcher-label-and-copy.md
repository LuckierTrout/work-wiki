---
title: 'Wiki switcher: visible field label, and destructive confirms that name their target'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
baseline_revision: '51f088bd7fa292240ae701e33b09907b31aa958a'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized, multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two WikiSwitcher chrome corrections. (DW-179) The only Wiki switcher's label is `wb-sr-only`, so a sighted owner meets a bare combobox — the tradeoff was made while a visible `Active wiki` label existed on the retired canvas card, and it has not been re-examined since DW-33 removed that card control. (DW-284) Neither destructive confirm names the wiki it acts on: the Rename body says "Renames this wiki…" and the Change-template body says "…for this wiki", so a mis-aimed confirm reads identically to the right one — the same premise DW-148 fixed for the pickers.

**Approach:** Render the `Active wiki` label visibly above the switcher row (a small-caps field label painted from the existing `--wb-*` left-column tokens), drop `wb-sr-only` from it, and add the chrome-test pins that hold it visible. In both destructive confirm bodies, name the target with the same disambiguated spelling the pickers use — `wikiOptionLabel(current)` — and update the copy pins that froze the old sentences.

## Boundaries & Constraints

**Always:**
- The label keeps its DOM text `Active wiki` and its `htmlFor={selectId}` association — the accessible name must not change, so `getByLabelText("Active wiki")` keeps resolving everywhere it is already used. Caps come from CSS `text-transform`, never from retyped uppercase text.
- The label stays under the same `wikis.length > 0` gate as the `<select>` it labels: no caption over a row that holds only `New Wiki`.
- The label sits ABOVE `.wb-wiki-switch-row`, not inside it — the 280px column has no room for a label beside the select and the button.
- New CSS paints only through `--wb-*` tokens (`--wb-muted`, `--wb-weight-strong`, `--wb-space-*`); no Folio token (`var(--ink)`, `var(--paper)`, `var(--accent)`) may appear in a shell rule.
- Both confirm bodies name the target through `wikiOptionLabel(...)` — never a re-spelled `wiki.name`, and never a second label format.
- Every unchanged half of both confirm sentences keeps its exact current wording.

**Block If:**
- `wikiOptionLabel` cannot be reached from `WikiWorkbench.tsx` without a new cross-layer dependency.

**Never:**
- Do not touch the Delete confirm — its `<select>` already carries `wikiOptionLabel` (DW-148).
- Do not change `switchWiki`, `rename`, `applyTemplate`, the latch wiring, `aria-describedby` composition, or any refusal behaviour.
- Do not add a second switcher, a second `Active wiki` label, or a `wb-sr-only` fallback copy of it.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sighted owner, ≥1 wiki | `wikis.length > 0` | A visible `Active wiki` field label renders above the switcher row; the select is still reachable by that accessible name | No error expected |
| Owner with no wikis | `wikis = []` | No label and no select; `New Wiki` still renders alone in the row | No error expected |
| Registry read failed | `unavailable = true` | Neither label nor row renders; only `TREE_UNAVAILABLE_COPY` | No error expected |
| Rename confirm open | `current` = the active wiki | Body names the target with `wikiOptionLabel(current)`; the rest of the sentence is unchanged | Dialog is gated on `current !== null`, so no body renders without a target |
| Change-template confirm open | `current` = the active wiki | Body reads "…for `<label>` — a purpose you wrote in Settings…"; the rest is unchanged | Gated on `templateOpen && current !== null` |

</intent-contract>

## Code Map

- `src/components/workbench/WikiSwitcher.tsx` -- `:583-586` the `wb-sr-only` label + its comment; `:582` opens the `{wikis.length > 0 && (` fragment that wraps label and `<select>`; `:579` `.wb-wiki-switch-row` opens; `:653` the `New Wiki` button, ungated, must stay in the row. `:494` `const current = wikis.find((wiki) => wiki.id === value) ?? null`. `:840-842` the Rename body `<p className="mt-2">`. `wikiOptionLabel` is already imported (`:14`) and used at `:634` for the switcher options and again in the delete picker.
- `src/components/WikiWorkbench.tsx` -- `:634-641` the Change-template confirm body `<p>`; `:181` `const current = wikis.find(...) ?? null`. Imports from `@/lib/wiki-scenarios` at `:10-14` (`CREATABLE_SCENARIOS`, `SCENARIO_LABELS`, `WIKI_ARTIFACT_FILES`, `CreatableScenario`) — `wikiOptionLabel` must be added to that existing import.
- `src/lib/wiki-scenarios.ts` -- `:118-128` `wikiOptionLabel(wiki)` → `` `${name} — ${SCENARIO_LABELS[scenario]} · ${createdAt.slice(0,10)} · ${id.slice(0,8)}` ``. Read-only; this is the one disambiguated spelling.
- `src/app/globals.css` -- `:3768-3866` the `/* ---- Wiki switcher (left column header) */` block (`.wb-wiki-switch`, `-row`, `-select`, `-actions`, `-note`, `-error`, `-scope`, `-readonly`). New `.wb-wiki-switch-label` rule belongs here. `:3610` `.wb-sr-only` stays — six other components use it. Type tokens at `:2413-2416`; `--wb-muted` at `:2344`; `--wb-space-*` at `:2367-2370`. There is no existing `text-transform` rule inside the shell; 12px is the shell's established secondary size (e.g. `:4248`, `:4256`).
- `src/lib/__tests__/workbench-left-column.test.ts` -- `:569-585` "labels the switcher for assistive tech…" pins `Active wiki`, `htmlFor={selectId}`, and slices the first `{wikis.length > 0 && (` gate to `</select>`. `:640-654` shows the house pattern for pinning a switcher CSS rule by regex. Read `:47-52` for the `globals()`/`read()` helpers.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- `:228` pins the whole template sentence against whitespace-collapsed source; `:236` pins `the Preview’s ${PREVIEW_HISTORY_COPY} and can be restored`. Both need re-shaping around the interpolated target.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx`, `src/components/__tests__/wiki-write-latch-parity.test.tsx` -- ~30 call sites use `getByLabelText("Active wiki")`. They must keep passing untouched; that is the guard on "accessible name unchanged".

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/WikiSwitcher.tsx` -- Lift the `Active wiki` `<label>` out of the `.wb-wiki-switch-row` fragment into its own `{wikis.length > 0 && (…)}` block immediately before the row, swap `className="wb-sr-only"` for `className="wb-wiki-switch-label"`, and rewrite the adjacent comment: the label is visible because the retired card control that carried the only visible `Active wiki` is gone (DW-33/DW-179), and the caps come from CSS so the accessible name is still the DOM text. Leave the `<select>` under its own gate inside the row. -- A sighted owner must be able to read what the combobox is.
- `src/components/workbench/WikiSwitcher.tsx` -- In the Rename confirm body, replace `this wiki` with the target named by `wikiOptionLabel(current)` (wrapped in `<strong>`), keeping the remaining sentence verbatim. Comment it as DW-284 / DW-148's premise. -- A rename that names no target reads identically whichever wiki is active.
- `src/components/WikiWorkbench.tsx` -- Add `wikiOptionLabel` to the existing `@/lib/wiki-scenarios` import and replace `for this wiki` in the Change-template body with `for <strong>{wikiOptionLabel(current)}</strong>`, keeping every other clause verbatim. `body` is a PROP, built on every render whether the dialog is open or not, so the call still needs `{current && wikiOptionLabel(current)}` — the `open` gate keeps a targetless body off screen, it does not keep the expression from evaluating. -- Same premise, on the confirm that rewrites purpose.md and the Workspace Purpose.
- `src/app/globals.css` -- Add `.wb-wiki-switch-label` to the Wiki-switcher block: block display, `margin-bottom: var(--wb-space-1)`, `color: var(--wb-muted)`, `font-size: 12px`, `font-weight: var(--wb-weight-strong)`, `letter-spacing: 0.06em`, `text-transform: uppercase`. Comment why this is the shell's first caps rule and why caps are CSS-side. -- The decision asks for a small-caps field label in the left column's type scale.
- `src/lib/__tests__/workbench-left-column.test.ts` -- Extend the switcher-labelling test: the label carries `wb-wiki-switch-label` and NOT `wb-sr-only`, and it sits before `<div className="wb-wiki-switch-row">` in source order. Add a CSS assertion (regex over `globals()`, in the style of `:647`) that `.wb-wiki-switch-label` declares `text-transform: uppercase` and paints through `var(--wb-muted)`. -- The clipped label came back once already; nothing pinned it visible.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- Re-shape the template-copy assertion into head / target / tail: the head ends at `Workspace Purpose for`, `wikiOptionLabel(current)` appears in the body, and the tail from `a purpose you wrote in Settings` onward is unchanged and still pinned whole. Keep the `PREVIEW_HISTORY_COPY` assertion working. -- The pin must survive the interpolation without going vacuous.
- `src/lib/__tests__/workbench-left-column.test.ts` -- Add a pin that the Rename confirm body names its target through `wikiOptionLabel(current)` and no longer contains `this wiki`. -- Otherwise DW-284 can regress silently.

**Acceptance Criteria:**
- Given a workbench with at least one wiki, when the left column renders, then a visible `Active wiki` field label appears above the switcher row and `screen.getByLabelText("Active wiki")` still resolves to the `<select>`.
- Given a workbench with no wikis, when the left column renders, then no `Active wiki` label is present and `New Wiki` still renders.
- Given the registry read failed (`unavailable`), when the left column renders, then neither the label nor the switcher row is present.
- Given the Rename confirm is open on a wiki, when its body is read, then it names that wiki with the same disambiguated spelling the delete picker uses, and the Scenario Template / Schema / Pages / Sources sentence is unchanged.
- Given the Change-template confirm is open on a wiki, when its body is read, then it names that wiki in place of "this wiki" and every other clause of the warning is unchanged.
- Given the full suite, when `pnpm test` and `pnpm lint` run, then both pass with no assertion loosened to accommodate the change.

## Design Notes

The label markup, after the lift — the row keeps the select and the ungated `New Wiki` on one line:

```jsx
{wikis.length > 0 && (
  <label htmlFor={selectId} className="wb-wiki-switch-label">
    Active wiki
  </label>
)}
<div className="wb-wiki-switch-row">
  {wikis.length > 0 && (
    <select id={selectId} className="wb-wiki-switch-select" …>
```

Caps via `text-transform` and not retyped text is the load-bearing detail: the accessible name stays the DOM string `Active wiki`, so the ~30 `getByLabelText("Active wiki")` call sites keep passing and screen readers do not spell the word out letter by letter.

`wikiOptionLabel` in prose, e.g. `Renames <strong>{current && wikiOptionLabel(current)}</strong> and the heading of its purpose.md.` — the `<strong>` sets the target apart from the sentence at a glance, which is the point of naming it at all, and the `current &&` is required because `body` is a prop evaluated on every render, open or not.

## Verification

**Commands:**
- `pnpm test -- src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/components/__tests__/wiki-switcher-lifecycle.test.tsx src/components/__tests__/wiki-write-latch-parity.test.tsx` -- expected: all pass, including the untouched `getByLabelText("Active wiki")` call sites
- `pnpm test` -- expected: full suite green
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** Two WikiSwitcher chrome corrections from the `wiki-switcher-label-and-copy` bundle. DW-179: the `Active wiki` label is no longer clipped to `wb-sr-only` — it is lifted out of `.wb-wiki-switch-row` into its own `{wikis.length > 0 && (…)}` block above the row and painted as a small-caps field label from the left column's own `--wb-*` tokens, so a sighted owner reads what the combobox is. The caps are CSS (`text-transform`), never retyped text, so the accessible name stays the DOM string `Active wiki` and the ~30 existing `getByLabelText("Active wiki")` call sites keep resolving unchanged. DW-284: both destructive confirms now name their target in the pickers' own disambiguated spelling (`wikiOptionLabel(current)`, wrapped in `<strong>`) — the Rename body in `WikiSwitcher.tsx` and the Change-template body in `WikiWorkbench.tsx` — so a mis-aimed confirm no longer reads identically to the right one. Every other clause of both sentences is verbatim.

**Files changed**
- `src/components/workbench/WikiSwitcher.tsx` -- label lifted above the row and unclipped; Rename confirm body names its target.
- `src/components/WikiWorkbench.tsx` -- `wikiOptionLabel` added to the existing `@/lib/wiki-scenarios` import; Change-template confirm body names its target.
- `src/app/globals.css` -- new `.wb-wiki-switch-label` rule (block, `--wb-space-1` gap, `--wb-muted`, 12px, `--wb-weight-strong`, 0.06em tracking, uppercase) in the Wiki-switcher block.
- `src/lib/__tests__/workbench-left-column.test.ts` -- new source/CSS pins for the visible label and the named Rename target; the pre-existing switcher-labelling test updated for the split gates.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- template-copy pin re-shaped into head / target / tail around the interpolation, with the previously vacuous phrase-ban repointed at the collapsed string.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- mounted pins: the rendered label is visible and outside the row; no caption in the empty or `unavailable` renders; the Rename confirm names its target among same-named twins.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- mounted pin on the Change-template confirm's rendered body, including the `{" "}` seam.

**Review findings breakdown.** 11 patches applied (2 medium, 9 low); 0 deferred; 11 rejected (all low/cosmetic — e.g. the DESIGN.md type-scale entry not being extended for a 12px caps face, `--wb-muted` contrast on a label that matches the column's existing `.wb-left-surface` face, the two em dashes now in the template sentence, the "Pick a different template to overwrite this wiki." hint that sits under a body already naming the target, and an empty `<strong>` on a null `current` that no open dialog can render). 0 intent gaps, 0 spec repairs, 0 review loopbacks.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 2, low 9 → score `3 × 2 + 1 × 9 = 15`, which is ≥ 5.

**Verification performed**
- `pnpm test -- src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/components/__tests__/wiki-switcher-lifecycle.test.tsx src/components/__tests__/wiki-write-latch-parity.test.tsx src/components/__tests__/create-wiki-flow.test.tsx` -- 5 files, 190 passed.
- `pnpm test` -- 362 of 363 files pass, 8973 passed / 1 skipped / 1 failed. The single failure is `src/lib/__tests__/storage-fs.test.ts` (`reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP…`, a 5s timeout plus an `ENOTEMPTY` on its temp dir under parallel load). It passes in isolation every time, and a full-suite run on the untouched baseline commit `51f088bd` fails the same single file — pre-existing, and this change touches no storage code.
- `pnpm lint` -- exit 0 (three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unrelated; this change adds no `!`).
- `npx tsc --noEmit` -- exit 0.
- Mutation checks proving the new pins are not vacuous: re-clipping the label to `wb-sr-only` fails `wiki-switcher-lifecycle`; dropping `display: block` fails `workbench-left-column`; dropping the `{" "}` seam fails `create-wiki-flow`.

**Residual risks**
- `src/lib/__tests__/storage-fs.test.ts` flakes under full-suite parallel load (timeout-sensitive, temp-dir cleanup race). Pre-existing and unrelated, but it can redden CI.
- `.wb-wiki-switch-label` is the shell's first `text-transform` rule and its 12px / 0.06em tracking are literals rather than type tokens; the DESIGN.md type scale (`typography.ui` / `ui-strong` at 13px) does not describe this face. Deliberate — the recorded DW-179 decision asks for a small-caps field label — but the stylesheet and the design doc now differ on that one rule.
- The template confirm's sentence now carries two em dashes doing different jobs (the target's own, inside the bold run, and the sentence's clause break). Judged readable because `<strong>` separates them visually, but it is denser than it was.
