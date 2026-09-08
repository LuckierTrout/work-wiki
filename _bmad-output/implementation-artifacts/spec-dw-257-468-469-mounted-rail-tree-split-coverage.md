---
title: 'Mounted pins for the rail current-rule, the collapsed tree divider, and the tree keyboard surface'
type: 'chore'
created: '2026-09-02'
status: 'done'
baseline_revision: '4e5742968614aa1b0e020d65cf27de28909efdb2'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `storage-fs.test.ts`'s `reapStrandedScratchFiles` cases fail under full
      `node`-project load, so `pnpm test` — the repo's own CI command — is not
      reliably green independent of any change.
    evidence: |-
      Reproduced at BASELINE with every file from this bundle removed from the
      working tree (`git stash` + the new file moved aside): three consecutive
      `pnpm vitest run --project node` runs failed, 2/2/1 cases respectively,
      always in `FilesystemStorageProvider > reapStrandedScratchFiles`
      ("stops at STRANDED_SCRATCH_CANDIDATE_CAP…" and "honours an explicit
      window…", `AssertionError: expected 3 to be 1`). The same file passes in
      685ms when run alone. The cases plant scratch files at explicit mtimes
      and reap against a grace window measured in wall-clock milliseconds
      (1_000 / 5_000), so under parallel load a candidate crosses the window
      mid-pass. Independently observed by a review layer on the unmodified
      tree. This bundle touches only the `dom` project, which is fully green
      (72 files, 1111 tests).
    location: >-
      src/lib/__tests__/storage-fs.test.ts:1229
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three component rules the `dom` project can now mount are asserted nowhere. `IconRail`'s "exactly one `aria-current` control" rule, its per-mode `onSelect` id and the UX-DR3 rail order all pass unobserved because `icon-rail.test.tsx` only ever mounts with `settingsActive: false` and inert callbacks (DW-257); `showSplitHandle("tree", …)`'s `!layout.collapsed` branch has no mounted case, so a shell that drew a tree divider over a zero-width track stays green (DW-468); and `TreePanel`'s docblock now concedes focus order is executable, leaving its deliberate not-an-ARIA-tree keyboard surface — both tabs in the tab order, native rows, no roving `tabindex` — untested (DW-469).

**Approach:** Add mounted assertions only. Extend `icon-rail.test.tsx` with a `settingsActive` describe, a per-mode `onSelect` case and an order case sourced from `WORKBENCH_MODES`; add one width-declared, `writeStoredCollapsed(true)` case to `workbench-split-wiring.test.tsx`'s existing width describe; add a new `tree-keyboard-surface.test.tsx` that mounts `TreePanel` directly and pins the platform-semantics keyboard surface it ships instead of a roving one.

## Boundaries & Constraints

**Always:** Assert on rendered DOM, `document.activeElement` and spy calls — never on source text (that is `workbench-split.test.ts`'s job). Source the rail's mode inventory and order from `WORKBENCH_MODES` and the tab inventory from `TREE_TABS`, so a rename cannot leave a loop asserting nothing. Declare widths with `setElementRect(".wb-shell", …)` BEFORE `render()`, matching the file's existing cases. Follow each file's established comment voice: say what regression the case catches.

**Block If:** A new assertion fails against unmodified production code in a way that reveals a real defect rather than a test-authoring mistake — report it rather than editing the component to make the test pass.

**Never:** Do not modify `IconRail.tsx`, `TreePanel.tsx`, `Workbench.tsx`, `workbench-split.ts` or any other production source — this bundle is test coverage only. Do not add roving `tabindex` or arrow-key handling to `TreePanel` (the docblock's decision stands; the pin records it, it does not overturn it). Do not touch the deferred-work ledger. Do not weaken or rewrite existing cases.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Settings current suppresses the mode | `<IconRail settingsActive mode="wiki">` | Exactly one `[aria-current]` in the rail, and it is the Settings button; the Wiki button has none and drops `wb-rail-item--active` | No error expected |
| Mode current while Settings is closed | `<IconRail settingsActive={false} mode="graph">` | Exactly one `[aria-current="page"]`, and it is the Graph button; the Settings button has none | No error expected |
| Per-mode select id | Click each of the ten mode buttons with an `onSelect` spy | Each click reports that mode's own id, once — ten distinct ids in `WORKBENCH_MODES` order | No error expected |
| Settings toggle is not a select | Click the Settings button | `onToggleSettings` called once, `onSelect` never called | No error expected |
| Rail order (UX-DR3) | Default mount | The rail's mode buttons, in DOM order, name `WORKBENCH_MODES`' ten labels in order; Settings and the chevron follow them | No error expected |
| Collapsed left column withdraws its divider | `writeStoredCollapsed(true)`, shell declared at 1400px, Preview docked | No `separator` named `SPLIT_TREE_LABEL`; the Preview separator is still there and the shell is measured | No error expected |
| Tabs stay in the tab order | `TreePanel` mounted on the `knowledge` tab | Both `role="tab"` buttons are native `<button>`s with no `tabindex` attribute; the unselected one is focusable | No error expected |
| Rows carry no roving tabindex | `TreePanel` with knowledge groups and a nested file tree | No row, group disclosure or tab carries `tabindex="-1"`; the tab panel carries `tabIndex={0}` | No error expected |
| Arrows are not tree navigation | ArrowDown / ArrowRight on a focused row and on a focused tab | Focus does not move, no selection is made, no disclosure toggles | No error expected |
| Click is the activation | Click a group row, then a page row | The disclosure toggles `aria-expanded`; the page row reports its own `onSelect` payload | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/IconRail.tsx` — READ-ONLY. `:101` `const active = !settingsActive && item.id === mode` is DW-257's rule; `:109` writes `aria-current={active ? "page" : undefined}`; `:139-146` is the Settings button, which carries its own `aria-current={settingsActive ? "page" : undefined}`. Mode buttons come from `WORKBENCH_MODES.map` at `:85`, each wired `onClick={() => onSelect(item.id)}`.
- `src/components/workbench/__tests__/icon-rail.test.tsx` — the file to extend. `BASE` (`:49`) is the props fixture; `mountRail()` (`:79`) renders and returns `{ rail }`. Existing describes: badge, sidecar dot, chevron, chevron-against-the-shell. Add the new describes beside them; reuse `mountRail`, do not add a second harness.
- `src/lib/workbench-modes.ts:35` — `WORKBENCH_MODES`, the ten modes in UX-DR3 order (Wiki · Chat · Sources · Search · Graph · Lint · Todos · Review · Deep Research · Skills). Already imported by `icon-rail.test.tsx`.
- `_bmad-output/planning-artifacts/epics.md:155` — UX-DR3, the rail-order authority.
- `src/lib/workbench-split.ts:441` — `showSplitHandle(id, mounted, layout)`; returns `!layout.collapsed` for `"tree"`. READ-ONLY.
- `src/components/workbench/Workbench.tsx:1834` — the `showSplitHandle("tree", …)` guard around `<SplitHandle id="tree" …>`. READ-ONLY.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — the file to extend. `renderShell()` (`:139`), `separator(label)` (`:200`), `shellElement()` (`:194`). The describe *"the shell's width-derived decisions, mounted (DW-113)"* (`:213`) is where DW-468's case belongs — its siblings already use `setElementRect(".wb-shell", { width })` before `render()` and `writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" })` to dock the Preview. `writeStoredCollapsed` is already imported (`:19`).
- `src/lib/workbench-state.ts` — `writeStoredCollapsed`, `writeStoredSelection`, `writeStoredSplitWidths`. Storage accessors the fixtures write through.
- `src/components/workbench/TreePanel.tsx` — READ-ONLY. Docblock `:35-54` is DW-469's subject. `:427` tablist (`role="tablist"`, `aria-label="Left column trees"`), `:429-441` the tab buttons (no `tabIndex`), `:449-453` the tab panel (`role="tabpanel"`, `tabIndex={0}`), `:343` knowledge group disclosure, `:365` page row, `FileRows` `:480` (file rows `:503`, empty-dir static `<span>` `:530`, dir disclosure `:546`).
- `src/lib/workbench-tree.ts:77` — `TREE_TABS` (`knowledge`, `files`); `buildFileTree` builds the `FileNode[]` fixture.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx:78-105` — the reference for focus-order assertions in this repo: `getClientRects()`-filtered control lists and `fireEvent.keyDown` + `document.activeElement`. Read for voice; do not import from it.
- `src/test/dom-helpers.ts` — `setElementRect`, `setMediaQuery`.
- `vitest.config.ts` — the `dom` project is `src/**/__tests__/**/*.test.tsx`, so a new `.test.tsx` under `src/components/workbench/__tests__/` is collected automatically.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/__tests__/icon-rail.test.tsx` — add a describe pinning the "exactly one `aria-current`" rule (both directions: Settings open suppresses the mode; Settings closed leaves the mode current and Settings not), a describe pinning `onSelect`/`onToggleSettings` with `vi.fn()` spies (each mode button reports its OWN id, exactly once; Settings toggles and never selects), and a case pinning the rail's mode order against `WORKBENCH_MODES` — DW-257: the file's single `settingsActive: false` fixture and inert stubs leave all three unobserved.
- `src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — add one case to the *"the shell's width-derived decisions, mounted (DW-113)"* describe: `writeStoredCollapsed(true)` plus a docked Preview at a declared 1400px, asserting the tree separator is absent while the Preview separator is present — DW-468: this is the only way to tell `showSplitHandle`'s collapsed branch from an unmeasured shell, where NEITHER divider exists.
- `src/components/workbench/__tests__/tree-keyboard-surface.test.tsx` — new file mounting `TreePanel` directly with knowledge groups and a nested file tree; pin that both tabs and every row stay natively focusable with no roving `tabindex`, that the panel keeps `tabIndex={0}`, that ArrowDown/ArrowRight move nothing and change nothing, and that click is what activates — DW-469: the docblock's not-an-ARIA-tree decision is now executable and nothing executes it.

**Acceptance Criteria:**
- Given a rail mounted with `settingsActive: true` and any `mode`, when the rendered rail is queried for `[aria-current]`, then exactly one element matches and it is the Settings button.
- Given a rail mounted with `settingsActive: false` and `mode` set to a mode that is not the first, when the rendered rail is queried for `[aria-current="page"]`, then exactly one element matches and it is that mode's button.
- Given a rail mounted with an `onSelect` spy, when each of the ten mode buttons is clicked in turn, then the spy's calls are exactly `WORKBENCH_MODES`' ten ids in order, one call per click.
- Given a rail mounted with `onSelect` and `onToggleSettings` spies, when the Settings button is clicked, then `onToggleSettings` is called once and `onSelect` is not called at all.
- Given a default rail mount, when its `.wb-rail-item` buttons are read in DOM order, then the first ten accessible names are `WORKBENCH_MODES`' ten labels in order, followed by Settings and the collapse chevron.
- Given a stored collapsed left column and a stored page selection with the shell declared at 1400px, when the shell renders, then it is measured (`--wb-tree` is set), no separator named `SPLIT_TREE_LABEL` exists, and the separator named `SPLIT_PREVIEW_LABEL` does exist.
- Given `TreePanel` mounted on the `knowledge` tab, when every `role="tab"` button and every `.wb-tree-row` button is inspected, then none carries a `tabindex` attribute and the `role="tabpanel"` element carries `tabindex="0"`.
- Given a focused tree row, when ArrowDown and then ArrowRight are dispatched on it, then `document.activeElement` is unchanged, no `onSelect` call is made, and no `aria-expanded` value changes.
- Given a focused unselected tab, when ArrowRight is dispatched on it, then `document.activeElement` is unchanged and `onTabChange` is not called.
- Given a group disclosure and a page row, when each is clicked, then the disclosure's `aria-expanded` flips and the page row calls `onSelect` with its own `{ kind: "page", slug }`.
- Given the whole suite, when `pnpm test` runs, then it passes with no new act(...) warnings and no production source file has changed.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 3, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The rail-order case's comment claimed it pinned the tail controls' position BELOW the spacer, but it walked `.wb-rail-item` and the spacer's class is `wb-rail-spacer` — mutation-confirmed twice (moving and deleting the spacer both left 15/15 green). Rewritten to walk `rail.children`, so the asserted sequence is now UX-DR3 in full: ten mode labels, spacer, sidecar dot, Settings, chevron.
  - `[medium]` `[patch]` The `settingsActive: true` case asserted the active CLASS only in the negative (absent on Wiki), never that Settings carries it — mutation-confirmed: a literal `"wb-rail-item"` className on Settings left the whole dom project green while Settings announced itself current with no active wash and no forced-colours outline. Added the positive assertion.
  - `[medium]` `[patch]` The tree suite's arrow cases only ever landed on one page row, so an `onKeyDown` collapsing a GROUP row on ArrowLeft/ArrowUp — the canonical first step toward a real ARIA tree, the exact edit the file's docblock claims every case catches — passed all 7. Replaced with a `NAVIGATION_KEYS` sweep (ArrowUp/Down/Left/Right, Home, End) applied to a knowledge disclosure, a page row, the tabpanel, a Files-tab directory row, a file row and a tab.
  - `[low]` `[patch]` Settings' `aria-current` VALUE was unpinned (`[aria-current]` queried without one); added an explicit `toBe("page")` while keeping the count query value-agnostic.
  - `[low]` `[patch]` "The arrow keys are the page's" rested on `fireEvent`'s return value, which reports only `preventDefault` — a `stopPropagation()` on the rows passed all 7 cases. The sweep now watches from `document` and asserts each event both arrived there and arrived uncancelled.
  - `[low]` `[patch]` DW-468 reached the collapsed state only from storage before mount, so a shell that failed to withdraw the handle when the owner presses the chevron still passed. Added a runtime case: collapse via the chevron, assert the separator withdraws, expand, assert it returns — and it is the only case that fails when the tree handle is memoized without `collapsed` in its deps.
  - `[low]` `[patch]` The DW-468 case wrapped `queryByRole(...).not.toBeNull()` around a presence its own `separator()` helper already proves by not throwing — the redundancy the sibling case spells out a comment against. Dropped.
  - `[low]` `[patch]` The added rail docblock claimed "every case above … inert callbacks" when the pre-existing chevron case already drives a `vi.fn()`; narrowed to `onSelect`/`onToggleSettings`.
  - `[low]` `[patch]` The rail's per-control callback describe only looked one way; added that a mode press leaves `onToggleSettings`/`onToggleCollapsed` untouched and a new case pressing the chevron, which must fire `onToggleCollapsed` alone.
  - `[low]` `[patch]` The tabpanel's focusability was asserted by attribute alone, against the file's own comment that a missing attribute does not prove focus. Added a real `.focus()` + `document.activeElement` check.
  - `[low]` `[patch]` `onTabChange` appeared only as a negative, so a tab whose `onClick` was dropped satisfied every case. Added the positive: clicking the unselected tab calls it once with that tab's own id.

## Design Notes

The rail's "exactly one current" rule is asserted as a COUNT over the rendered rail (`rail.querySelectorAll("[aria-current]")`), not as two independent attribute checks — a rail that marked both a mode and Settings is precisely the state two separate `toBe("page")` assertions would let through:

```tsx
const { rail } = mountRail({ settingsActive: true, mode: "wiki" });
const current = rail.querySelectorAll("[aria-current]");
expect(current).toHaveLength(1);
expect(current[0]).toBe(screen.getByRole("button", { name: "Settings" }));
expect(screen.getByRole("button", { name: "Wiki" }).getAttribute("aria-current")).toBeNull();
```

DW-468's case must keep the Preview divider present. Asserting only the tree separator's absence would pass on an unmeasured shell, where `isSplitMeasured` short-circuits both — the same trap the sibling "renders no Preview separator" case names at `:320`.

For DW-469, "arrows do nothing" is the assertion because that IS the shipped decision: `TreePanel` is native buttons in document order, so a browser's own Tab walks the tree and arrow keys are the page's, not the tree's. jsdom moves focus for nobody on a synthetic keydown, so the meaningful observation is that nothing in the component *prevented* the event and nothing re-focused, re-selected or re-toggled — assert `document.activeElement`, the spies and the `aria-expanded` values are all unchanged after the dispatch.

## Verification

**Commands:**
- `pnpm vitest run --project dom src/components/workbench/__tests__/icon-rail.test.tsx src/components/workbench/__tests__/workbench-split-wiring.test.tsx src/components/workbench/__tests__/tree-keyboard-surface.test.tsx` — expected: all three files pass, with the new cases visible in the report.
- `pnpm test` — expected: the full run passes, both projects collected.
- `pnpm lint` — expected: clean.
- `git status --short` — expected: only the two extended test files and the one new test file appear; no production source under `src/components/` or `src/lib/` is modified.

## Auto Run Result

Status: done

**Implemented change.** Test coverage only — no production source was modified. Three mounted pins that the `dom` project can now reach were added for DW-257, DW-468 and DW-469.

**Files changed:**
- `../../src/components/workbench/__tests__/icon-rail.test.tsx` — DW-257: three new describes. "Exactly one `aria-current` control" asserted as a COUNT over the rail in both directions (Settings open suppresses the mode; Settings closed leaves the mode current and Settings not), with the active class and the literal `"page"` value pinned alongside it. Per-control callbacks: the ten mode buttons each report their OWN id once, sourced from `WORKBENCH_MODES`, and no control fires a sibling's callback. Rail order: the rail's full child sequence — ten mode labels, spacer, sidecar dot, Settings, chevron — against UX-DR3.
- `../../src/components/workbench/__tests__/workbench-split-wiring.test.tsx` — DW-468: two cases in the existing width describe. `writeStoredCollapsed(true)` at a declared 1400px with the Preview docked proves the tree separator withdraws while the Preview's stays (distinguishing a collapsed shell from an unmeasured one, where neither exists), and the Preview's `aria-valuemax` widens to 1032 as the collapsed track is given up. A second case drives the same transition at runtime through the rail chevron, in both directions.
- `../../src/components/workbench/__tests__/tree-keyboard-surface.test.tsx` — NEW. DW-469: mounts `TreePanel` directly and records the deliberate not-an-ARIA-tree decision — both tabs natively focusable with no `tabindex`, no roving index on any row, the tabpanel focusable at `tabIndex={0}`, and six navigation keys passing through to `document` uncancelled from a disclosure, a page row, a file row, a directory row, the panel and a tab. Click remains the activation for disclosures, rows and tabs.

**Review findings breakdown:** 11 patches applied (3 medium, 8 low), 1 item deferred (low), 10 items rejected. No intent gaps and no spec defects — every finding was a local assertion that fell short of its own stated claim.

**Follow-up review recommendation:** `true`. Patched findings this pass: high 0, medium 3, low 8. Score = 3 × 3 + 1 × 8 = 17, which is ≥ 5.

**Verification performed:**
- `pnpm vitest run --project dom` on the three files — 58 passed (54 before the patch pass).
- `pnpm vitest run --project dom` (whole project) — 72 files, 1111 tests, all passing.
- `pnpm lint` — exit 0. `npx tsc --noEmit` — exit 0.
- `git status --short` — only the two extended test files and the one new test file; nothing under `src/components/`, `src/lib/`, `src/app/` or `src/hooks/` production source is modified.
- Every new pin was mutation-checked and every mutation reverted: dropping `!settingsActive &&` from `IconRail.tsx:101`, a literal `"wb-rail-item"` className on Settings, a cross-wired chevron, moving or deleting `wb-rail-spacer`, `showSplitHandle("tree", …)` returning `true`, the tree handle memoized without `collapsed` in its deps, `tabIndex={-1}` on the rows, a roving index on the tablist, an ArrowLeft-collapses handler on a group row, `stopPropagation()` on the rows, a container `onKeyDown` on `.wb-tree-body`, a dropped tab `onClick` — each reddens the case that claims it, and none of the new cases is vacuous.
- `pnpm test` reports one pre-existing `node`-project failure in `storage-fs.test.ts`; see residual risks.

**Residual risks:**
- `pnpm test` is not reliably green at HEAD, independent of this work. `storage-fs.test.ts`'s two `reapStrandedScratchFiles` cases fail under full `node`-project load and pass in isolation. Confirmed at BASELINE with every file from this bundle removed from the working tree — three consecutive runs failed 2/2/1 cases. Recorded in frontmatter `deferred`. This bundle touches only the `dom` project, which is fully green.
- Fidelity limit, inherent rather than incidental: jsdom performs no Tab traversal and its shimmed `getClientRects()` answers for every attached element, so the tree suite pins the ABSENCE of focus machinery (no `tabindex` written, keys reaching `document` uncancelled, nothing re-focused or re-disclosed) rather than real browser focus movement. That is the strongest available observation in this environment, and the file's docblock says so.
- The tree suite mounts `TreePanel` in isolation, so the rows' place in the assembled shell's tab order (rail → left column → divider → canvas → Preview) is still held only by `workbench-sheet.test.tsx`'s rail cycle.
- `TreePanel.tsx`'s docblock still presents the focus decision as prose-only and does not cite this new suite, though it already cites `workbench-sheet.test.tsx` for the half it concedes is executable. Not filed as deferred work: the intent's remedy for DW-469 was the pin, and a stale cross-reference is not a wrong answer, lost data or a broken door.
