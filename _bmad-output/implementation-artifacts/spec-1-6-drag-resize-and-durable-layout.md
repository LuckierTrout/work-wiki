---
title: 'Story 1.6: Drag-resize and durable layout'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: 'bf0897df75b44d50aee65a3a00775b3b56f413c9'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-view-first-preview-with-gfm-and-wikilinks.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The divider's 9px grab strip is under WCAG 2.2 AA's 24px target-size
      minimum, and its outer half overlaps the tree's own scrollbar.
    evidence: |-
      `--wb-split-hit: 9px` centred on the boundary puts ~4.5px of the strip
      over the tree column, which is exactly where `.wb-tree-body`'s scrollbar
      sits, and leaves the target far short of SC 2.5.8's 24×24 CSS px (the
      spacing exception does not apply — tree rows are adjacent targets). The
      epic's floor calls AA "a target", and 9px is the width every desktop
      splitter uses, so this is a deliberate trade rather than an oversight.
      Widening the strip to 24px is not the obvious fix either: it would cover
      the scrollbar entirely and eat 12px of the canvas edge. Deciding between a
      wider strip, an offset strip, and a documented exception is a chrome
      decision for whichever story revisits the shell's pointer targets.
    location: >-
      src/app/globals.css (.wb-split-handle), src/lib/workbench-split.ts
    severity: low
  - summary: >-
      The separators carry no `aria-controls`, and the keyboard surface has no
      coarse step (PageUp/PageDown).
    evidence: |-
      The ARIA window-splitter pattern names the pane a separator resizes via
      `aria-controls`. The tree divider could point at `LEFT_ID`, which the
      shell already declares — but the Preview divider would need an id on
      `.wb-preview`, and `PreviewColumn.tsx` is outside the set of existing
      files this story's Code Map allows it to edit. Wiring one and not the
      other is worse than wiring neither. The same applies to PageUp/PageDown:
      with `SPLIT_KEY_STEP = 16`, crossing the tree's real range is ~30 presses.
      Both belong with whichever story next opens the Preview column's markup.
    location: >-
      src/components/workbench/SplitHandle.tsx, src/lib/workbench-split.ts
    severity: low
  - summary: >-
      The restore validates a stored row against the two trees and the Wiki id,
      but never against the tree TAB it restores alongside it.
    evidence: |-
      `restorableSelection` takes `(stored, wikiId, knowledge, files)`. The
      shell's reset effect exists to prevent exactly one state — a docked
      Preview describing a row the showing tree cannot mark with
      `aria-current` — and the restore path is the one site that can produce it,
      because the mount effect's signature guard then protects the mismatch from
      being cleared. Reaching it needs the two keys to diverge, which needs the
      persist effect's health guard to skip a write across a tab switch (a
      transient `knowledgeUnavailable` / `filesUnavailable`), so it is narrow.
      The obvious fix is not obviously right either: requiring `kind` to agree
      with `tab` would drop the restore of a page selection made on the Files
      tab, which `wikilinkSelection` deliberately produces when the walk did not
      list that page's file (Story 1.5). Whether that pairing should survive a
      reload is a decision about the wikilink fallback, not about the clamp, and
      it belongs with whichever story next opens that path.
    location: >-
      src/lib/workbench-tree.ts (restorableSelection),
      src/components/workbench/Workbench.tsx (mount effect)
    severity: low
  - summary: >-
      The tree's scroll effects re-run on tab and collapse only, so crossing the
      899px force-show boundary by RESIZING is missed.
    evidence: |-
      `treeScrollActive` correctly asks the element rather than the collapse
      flag, because `@media (max-width: 899px)` force-shows a collapsed column.
      But both effects are keyed `[tab, collapsed]`, and neither changes when the
      viewport crosses 900px mid-session — so an owner who is collapsed and
      narrows the window gets a fully visible, scrollable tree whose offset is
      neither restored nor recorded until they next switch tabs. A load at that
      width is fine; only the live transition is missed. Closing it needs a
      `matchMedia("(max-width: 899px)")` listener in `TreePanel`, which is a
      second copy of a breakpoint this story deliberately keeps in the
      stylesheet (and which `workbench-split.test.ts` bans by name). Whether that
      trade is worth making belongs with whichever story revisits the left
      column's responsive behaviour.
    location: >-
      src/components/workbench/TreePanel.tsx (the two scroll effects)
    severity: low
---

<intent-contract>

## Intent

**Problem:** The shell's column widths are fixed tokens — `--wb-tree: 280px` and `--wb-preview: 360px` in `globals.css:2863,2869` — with no control anywhere that changes them, and `--wb-split-min-chat` has been declared since Story 1.3 with no reader at all. Of the state FR-8 requires to survive a reload, only mode, collapse and tree tab do (`workbench-state.ts`); the tree selection is reset to `null` by the shell's own mount, and the tree's scroll offset is not stored at all. So the Workbench arrives every morning at somebody else's default, and the owner re-picks the page they were reading.

**Approach:** Give the two column boundaries a real separator control — pointer drag and keyboard — that writes the two width tokens as inline custom properties on `.wb-shell`, clamped so the canvas keeps the Chat floor and the tree and Preview keep theirs. Persist those widths, the tree selection and the tree scroll offset browser-locally beside the three keys already there, and restore them on mount: the selection only when it still names a row in the trees the server sent for the Wiki that is current.

## Boundaries & Constraints

**Always:**
- The floors are the epic's numbers and they live in exactly one place each. `--wb-split-min-tree: 200px`, `--wb-split-min-preview: 200px`, `--wb-split-min-chat: 320px`, `--wb-rail: 48px`, `--wb-tree: 280px` and `--wb-preview: 360px` are already declared in the single `.wb-shell` token block; the TypeScript constants that clamp a drag must be asserted equal to those declarations by a test that parses `globals.css`, so the two copies cannot drift.
- The canvas floor is `--wb-split-min-chat` in EVERY mode, not only Chat mode. Chat is one rail click away at any moment and a mode switch changes no widths, so a layout Chat could not live in would have to snap the moment the owner clicks it. This is also the "maximum" FR-6 asks for: the tree and the Preview cannot consume the frame because the canvas keeps 320px.
- Every resize decision is a pure exported function that the node suite EXECUTES — the bounds, the clamp, pointer-x → width, and key → width. The component may hold state, read `getBoundingClientRect()` in an event handler and call those functions; it may not spell a bound, a comparison or a step of its own. There is no DOM test environment (`vitest.config.ts` is `environment: "node"`, `include: ["src/**/__tests__/**/*.test.ts"]`), so a condition typed into a handler can only ever be grepped for.
- One definition of the bounds: the `min`/`max` a handle reports through `aria-valuemin` / `aria-valuemax` are the same numbers the clamp uses, from the same function. A drag that stops somewhere the ARIA value says it should not is a lie to a screen reader.
- Each separator is `role="separator"` with `aria-orientation="vertical"`, `tabIndex={0}`, `aria-valuenow` / `aria-valuemin` / `aria-valuemax` as integer pixels, and an accessible name from **Design Notes → Copy**. Arrow keys move the divider the way the arrow points; Home and End take that column to its minimum and maximum. Resizing is functionality, so it is keyboard-operable (WCAG 2.1.1) rather than pointer-only.
- Stored layout is read in an effect and never during the first render: `data-mounted` and the three existing restores already establish that the first paint is the server's tree. The width custom properties are set inline only once mounted, and a handle is rendered only once mounted and measured — a handle in the SSR markup would be a hydration mismatch.
- The breakpoints stay in CSS. Handles are hidden below 1200px by a media query, not by a width comparison in JavaScript; the 900–1199px block already pins both side columns to their minimums, so an inline width token has nothing to do there.
- A restored selection is validated against the trees this render actually has (`knowledge`, `files`) and against the current Wiki id, and is dropped when it names neither. Docking the Preview onto a page that was deleted, or onto another Wiki's row, puts `aria-current` on nothing and answers with `This file couldn’t be loaded.`
- Storage keys keep the `yopedia_` runtime prefix and the `yopedia_[a-z_]+` shape (AD-7; `brand-copy.test.ts:22-36` allowlists exactly that form). Every accessor follows the shape already in `workbench-state.ts`: SSR guard, `try`/`catch` around every access, runtime narrowing of what comes back, and a silent degrade to the default.
- No pre-existing test file is edited. Every new assertion — executed or scan — lands in one new file. The frozen literals in `Workbench.tsx` stay exactly as they are: `setModeState(readStoredMode())`, `setCollapsed(readStoredCollapsed())`, `setTreeTab(readStoredTreeTab())`, `writeStoredMode(next)`, `writeStoredCollapsed(next)`, `writeStoredTreeTab(next)`, `isSameSelection(current, next) ? null : next`, `isSameSelection(current, next) ? current : next`, `shouldDockPreview(mode, selection)`, and the reset effect's `setSelection(null);` immediately above `}, [mode, currentWikiId, treeTab])`.
- New CSS paints from `--wb-*` tokens only, adds no second `.wb-shell {` block, and adds no new `@media (max-width: 1199px)` / `(max-width: 899px)` block — `workbench-left-column.test.ts:534-543` reads the LAST block matching each query, and `workbench-chrome.test.ts:356-358,418` bans `var(--ink)` / `var(--paper)` / `var(--accent)` / `Georgia` in every rule after the token block.

**Block If:**
- Honouring the minimum widths appears to require changing the base `grid-template-columns` of `.wb-shell`, a new grid row, or moving `.wb-left` / `.wb-canvas` / `.wb-preview` out of columns 2 / 3 / 4.
- Persisting the selection or the scroll offset appears to require a server round-trip, a new route, or a change to `WorkbenchDataProvider`'s payload.
- Restoring the selection appears to require adding a dependency to the reset effect in `Workbench.tsx` whose deps `workbench-left-column.test.ts:93-95` pins verbatim.

**Never:**
- Do not add a resize library, a drag library, `ResizeObserver`-driven layout branching, or a DOM test environment (no jsdom, no `@testing-library/*`, no `.test.tsx`).
- Do not persist widths, selection or scroll server-side. Panel widths are explicitly browser-local (epic Requirements & Constraints); this story adds no kernel write and no `dataVersion` read — Story 1.7 owns refresh.
- Do not build a second gate on leaving an open Preview editor with unsaved text (`spec-1-5` deferred entry 1). It is a lifecycle guard on the editor, not on the layout: this story restores a selection on mount, where no editor can be open, and changes nothing about how a selection change reaches `PreviewColumn`.
- Do not persist Conversations, Review items or Chat drafts (epic AC: not required until those epics), and do not add Activity dock behaviour (Epic 2).
- Do not make the left column collapse chevron, the tree tabs, the mode rail or the Wiki switcher behave differently; the Wiki selection already survives reload server-side through the registry's `currentId`, and this story must not fork a browser-local copy of it.
- Do not write `WorkWiki` or a bare `yopedia` outside the `yopedia_…` key form, and do not name `Georgia` or `serif` in any file directly under `src/components/workbench`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tree bounds, Preview docked | shell 1400, preview 360, not collapsed | tree max `1400-48-320-360 = 672`, min 200 | No error expected |
| Tree bounds, Preview closed | shell 1400, preview closed | tree max `1400-48-320 = 1032` | No error expected |
| Preview bounds | shell 1400, tree clamped 280 | preview max `1400-48-320-280 = 752`, min 200 | No error expected |
| Preview bounds, collapsed | shell 1400, collapsed | tree contributes 0 → preview max `1032` | No error expected |
| Viewport too small for every floor | shell 700, preview docked | each max floors at its own min (never below) | No throw, no negative track |
| Stored widths larger than the frame | tree 900, preview 900, shell 1400 | tree clamped first, then preview against the clamped tree | No error expected |
| Unmeasured shell | shell width 0 (pre-mount) | widths returned unchanged, no inline vars set | No error expected |
| Pointer → tree width | clientX 700, shell left 0 | `700 - 0 - 48 = 652`, then clamped | No error expected |
| Pointer → preview width | clientX 1100, shell left 0, width 1400 | `1400 - 1100 = 300`, then clamped | No error expected |
| Key on tree handle | `ArrowRight` / `ArrowLeft` | `+step` / `-step`, clamped | Other keys → `null` (not handled) |
| Key on preview handle | `ArrowLeft` / `ArrowRight` | `+step` / `-step` — the divider follows the arrow | Other keys → `null` |
| Key Home / End | either handle | that column's min / max | No error expected |
| Stored widths round-trip | `{tree:320,preview:420}` | same object read back | Unparseable / non-finite / negative → that side falls back to its default |
| Stored selection round-trip | `{wikiId:"w1",kind:"page",slug:"alpha"}` | same selection read back for `w1` | Wrong shape or unknown `kind` → `null` |
| Restore against another Wiki | stored `wikiId:"w1"`, current `w2` | not restored | No error expected |
| Restore of a deleted row | stored page `ghost` absent from `knowledge` | not restored | No error expected |
| Restore of a file row | stored file `wiki/a.md` present in `files` | restored, Preview docks | Absent → not restored |
| Stored tree scroll | `{"knowledge":120,"files":0}` | offset per tab | Unparseable / negative / non-integer → 0 for that tab |
| Scroll write while collapsed | column hidden, browser resets `scrollTop` to 0 | nothing written — the stored offset survives the collapse | No error expected |
| localStorage throws | private mode / quota on read or write | every accessor degrades to its default, never throws | Silent |
| Server render | no `window` | every accessor returns its default; no inline vars, no handles | No error expected |

</intent-contract>

## Code Map

**Extend (this story edits these existing files and no other existing source):**
- `src/components/workbench/Workbench.tsx` — `:80-102` state block, `:106-111` mount restore (the three frozen call sites), `:118-120` reset effect (frozen deps), `:168-170` `selectRow`, `:178-191` `openPage`, `:277` `previewOpen`, `:279-286` the shell `<div>` (needs a `ref` and the inline width vars), `:364-371` the `<PreviewColumn>` mount. Adds: preferred-width state, measured shell width, the restore guard, the selection persist effect, the two `<SplitHandle>` mounts, `data-resizing`.
- `src/components/workbench/TreePanel.tsx` — `:216-224` `.wb-tree-body` is the scroll container (`role="tabpanel"`, `tabIndex={0}`). Adds a `ref`, an rAF-coalesced scroll persist, a restore effect keyed on `[tab, collapsed]`, and a `collapsed` prop.
- `src/lib/workbench-state.ts` — three keys and six accessors today (`:27-29`, `:34-95`). The new accessors follow that file's shape exactly; it already imports narrowing helpers from `workbench-modes` and `workbench-tree`.
- `src/lib/workbench-tree.ts` — `isSameSelection` (`:132`), `findFileNode` (`:352`), `findKnowledgePage` (`:387`), `TreeSelection` (`:123`). The "does this stored pick still exist?" predicate belongs beside them.
- `src/app/globals.css` — the token block ends at `:2984`; `.wb-shell` needs `position: relative` there. New rules go after the Preview-dock block (`:3779`) and BEFORE the docked grid variants at `:3785`, which must stay the last grid rules in the file (`workbench-left-column.test.ts:523-530`). The two responsive blocks (`:3802`, `:3833`) gain the handle's `display: none` — inside the existing blocks, never a new one.

**New:**
- `src/lib/workbench-split.ts` — pure, client-safe: the geometry constants, `splitBounds`, `clampSplitWidths`, `splitWidthFromPointer`, `nextSplitWidthFromKey`, and the two accessible names.
- `src/components/workbench/SplitHandle.tsx` — the separator control; no numbers, no bounds, no storage.
- `src/lib/__tests__/workbench-split.test.ts` — every matrix row executed, plus the scan assertions for the shell, the handle, the tree panel and the stylesheet.

**Reuse as-is (do not fork, do not edit):**
- `src/lib/workbench-state.ts:31-32,41-44` — the `COLLAPSED_TRUE` / try-catch / narrow-on-read idiom, and `recent-ingests.ts`, which it follows.
- `src/lib/workbench-tree.ts:352,387` — `findFileNode(files, path)` and `findKnowledgePage(knowledge, slug)` already answer "is this row in the tree?" for both selection kinds.
- `src/components/workbench/WorkbenchData.tsx:19-41` — `currentWikiId` comes from here; no new field is needed.
- `src/app/globals.css:2862-2870` — `--wb-rail`, `--wb-tree`, `--wb-split-min-tree`, `--wb-split-min-chat`, `--wb-split-min-preview`, `--wb-preview`. All six already exist; declare no seventh geometry token except the handle's own hit width.

**Read-only constraints (do not regress):**
- `workbench-left-column.test.ts:72-102` (the frozen restore call sites, the dock wiring, the reset deps), `:430-448` (the wikilink open), `:510-530` (one `.wb-shell {`, both docked variants, their source order), `:532-544` (both responsive blocks name `[data-preview="true"]`), `:546-576` (the reading face declared once and read only by `.wb-preview-body`).
- `workbench-chrome.test.ts:195-205` (mode/collapse call sites), `:231-241` (no side effects inside a state updater), `:284-299` (no `Georgia`/`serif` in any file under `src/components/workbench`), `:339-347` (`--wb-rail: 48px`, both media queries present), `:349-359` (chrome rules resolve no Folio token), `:381-399` (`.dark` parity for every token the shell restates), `:421-426` (the shell slice contains no `var(--maxw)`).
- `create-wiki-ui.test.ts:118-209`, `brand-copy.test.ts:123-141`, `single-ia.test.ts`, `retired-surfaces.test.ts`, `markdown-url-transform.test.ts` — untouched surfaces.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-split.ts` -- new, pure and client-safe: `SPLIT_RAIL_WIDTH`, `SPLIT_MIN_TREE`, `SPLIT_MIN_PREVIEW`, `SPLIT_MIN_CANVAS`, `SPLIT_DEFAULT_TREE`, `SPLIT_DEFAULT_PREVIEW`, `SPLIT_KEY_STEP`; `type SplitId = "tree" | "preview"`; `interface SplitWidths { tree: number; preview: number }`; `interface SplitLayout { shellWidth: number; previewOpen: boolean; collapsed: boolean }`; `splitBounds(id, widths, layout)`; `clampSplitWidths(widths, layout)` defined as two `splitBounds` calls, tree first; `splitWidthFromPointer(id, clientX, shellLeft, shellWidth)`; `nextSplitWidthFromKey(id, key, current, bounds)` returning `number | null`; and `SPLIT_TREE_LABEL` / `SPLIT_PREVIEW_LABEL` -- one module owns the geometry, so the clamp a drag obeys and the range a screen reader is told are the same two numbers.
- `src/lib/workbench-state.ts` -- add `WORKBENCH_SPLIT_KEY`, `WORKBENCH_SELECTION_KEY`, `WORKBENCH_TREE_SCROLL_KEY` and their six accessors: `readStoredSplitWidths()` → `SplitWidths` (each side falling back to its default independently), `writeStoredSplitWidths(widths)`, `readStoredSelection()` → `{ wikiId: string; selection: TreeSelection } | null`, `writeStoredSelection(wikiId, selection)` (a `null` selection clears the key's value rather than storing `null` under a live shape), `readStoredTreeScroll()` → `Record<TreeTabId, number>`, `writeStoredTreeScroll(tab, offset)` -- same SSR guard, same try/catch, same narrow-on-read as the three accessors already there, because a hand-edited or stale value must degrade to the default rather than restore a row that is not on screen.
- `src/lib/workbench-tree.ts` -- add `selectionExists(selection, knowledge, files): boolean` beside `isSameSelection`, built on `findKnowledgePage` and `findFileNode` -- restoring a pick the trees no longer contain docks a Preview that cannot load and marks `aria-current` on nothing.
- `src/components/workbench/SplitHandle.tsx` -- new client component: `role="separator"`, `aria-orientation="vertical"`, `aria-label`, `aria-valuenow`/`min`/`max`, `tabIndex={0}`, `className="wb-split-handle wb-split-handle--{id}"`; `onPointerDown` captures the pointer and reports the press, `onPointerMove` reports `clientX` while captured, `onPointerUp`/`onLostPointerCapture` end it, `onKeyDown` reports the key and calls `preventDefault()` only when the parent's handler claims it -- the control carries no number and no bound of its own, so everything it can get wrong is executed in `workbench-split.test.ts`.
- `src/components/workbench/Workbench.tsx` -- add `shellRef`, `shellWidth` state measured on mount and on `resize`, `widths` state seeded from `readStoredSplitWidths()` in the existing mount effect, `applied = clampSplitWidths(widths, layout)` at render, the inline `--wb-tree` / `--wb-preview` vars applied only when mounted, `data-resizing`, the two `<SplitHandle>` mounts (tree when not collapsed, preview when `previewOpen`), the selection restore guarded by a signature ref so the frozen reset effect cannot clear the very pick it just restored, and an effect that persists the selection for `currentWikiId` -- the shell already owns selection, collapse and the grid, so the widths belong in the same place and the restore lands where the other three already land.
- `src/components/workbench/TreePanel.tsx` -- add a `collapsed` prop, a ref on `.wb-tree-body`, a scroll listener that coalesces through `requestAnimationFrame` and writes nothing while `collapsed`, and a restore effect keyed on `[tab, collapsed]` -- a hidden column has `scrollTop === 0` by the browser's own rules, so a persist that ran there would overwrite the offset the owner is about to come back to.
- `src/app/globals.css` -- add `--wb-split-hit: 9px` to the token block and `position: relative` to `.wb-shell`; add `.wb-split-handle` (absolutely positioned, full height, `col-resize`, transparent with a `--wb-border` hairline on hover/focus), `.wb-split-handle--tree { left: calc(var(--wb-rail) + var(--wb-tree) - var(--wb-split-hit) / 2); }`, `.wb-split-handle--preview { right: calc(var(--wb-preview) - var(--wb-split-hit) / 2); }`, and `.wb-shell[data-resizing="true"] { user-select: none; cursor: col-resize; }`; add `.wb-split-handle { display: none; }` inside the existing `@media (max-width: 1199px)` block -- positioning the handle from the same custom properties the grid tracks read is what keeps the divider on the boundary without measuring anything in CSS.
- `src/lib/__tests__/workbench-split.test.ts` -- new: execute every I/O matrix row against `workbench-split` and the new `workbench-state` accessors (window stubbed per test, the `workbench-state.test.ts` fixture), assert the TS constants equal the `globals.css` token declarations by parsing the stylesheet, and scan `Workbench.tsx` / `SplitHandle.tsx` / `TreePanel.tsx` / `globals.css` for the wiring the node suite cannot execute -- the geometry is this story's only real logic and the wiring is where the previous stories' regressions all landed.

**Acceptance Criteria:**
- Given a signed-in owner at ≥1200px with the Preview docked, when they drag the divider between the tree and the canvas and the divider between the canvas and the Preview, then each column's width follows the pointer and stops at 200px, the canvas never falls below 320px, and both dividers are operable from the keyboard with the range they enforce reported to assistive tech.
- Given widths the owner dragged, when they reload, then the same two widths are applied to the grid without a full-page reload having been needed to set them, and a stored width that no longer fits the frame is reduced to what fits rather than overflowing the shell or crushing the canvas.
- Given a mode, a tree tab, a tree row and a tree scroll offset the owner left behind, when they reload, then all four restore, the Preview docks on the restored row, and the Wiki the trees describe is the one the registry still calls current.
- Given a stored row that names a deleted page, another Wiki, or a tab whose tree does not contain it, when the shell mounts, then nothing is restored, no Preview column docks, and no row carries `aria-current`.
- Given a browser where `localStorage` throws on read or write, when the Workbench loads and the owner drags a divider, then the shell renders at its defaults, the drag still works for the session, and nothing throws.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and no pre-existing test file has been modified.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 1, low 11)
- defer: 2: (high 0, medium 0, low 2)
- reject: 25: (high 0, medium 4, low 21)
- addressed_findings:
  - `[medium]` `[patch]` The selection persist effect wrote `null` whenever the restore declined, so a failed registry, page-index or file read cleared the stored row permanently — one bad minute on the server forgot the owner's pick. The effect now returns early when `currentWikiId` is null or either tree read was unavailable, with both flags in its deps; a genuine deselect with healthy reads still clears the key.
  - `[low]` `[patch]` `endResize` ran twice per drag — the browser releases an implicit capture right after `pointerup`, so `lostpointercapture` followed every gesture and both were wired to `onEnd`. `onLostPointerCapture` is now the sole end, which still covers `pointercancel` and a capture the browser takes for itself.
  - `[low]` `[patch]` A secondary-button press armed a drag: right- or middle-click took pointer capture and set `data-resizing`, after which the divider followed a pointer with no button held. Gated on a new executed predicate `isPrimarySplitPress`.
  - `[low]` `[patch]` A modified arrow press was claimed and its default prevented, breaking Alt+Left (back), word-jump and selection-extension from a focused divider. Gated on `isUnmodifiedSplitKey` (Shift included — the control implements no modified gesture).
  - `[low]` `[patch]` `if (collapsed) return;` disabled the tree's scroll memory below 900px, where `@media (max-width: 899px)` force-shows the column for a persisted collapse — a visible, scrollable tree whose offset was neither restored nor remembered. Both effects now ask the element (`treeBodyShowing`, using `getClientRects()`, the shell's own idiom) instead of the flag; `collapsed` stays the re-run trigger and no breakpoint moved into JS.
  - `[low]` `[patch]` `layoutSignature` took bare `string`s for two closed unions and joined with a space, in the one function whose whole job is an identity comparison. Now typed `WorkbenchModeId` / `TreeTabId` and serialized unambiguously.
  - `[low]` `[patch]` The persist effect's comment claimed "The pick outlives the tab", which the shell's own reset effect makes false. Reworded to say what happens: the pick outlives the session, and a mode, Wiki or tab change clears it and the key with it.
  - `[low]` `[patch]` Deleting the mount effect's immediate `measure()` left `shellWidth` at 0 forever — no divider ever renders and no stored width is ever applied — with the whole suite green. Now pinned.
  - `[low]` `[patch]` Gutting `startResize` left `data-resizing` false for every drag (text selection sweeping the tree, cursor reverting off the strip) with the suite green. Now pinned.
  - `[low]` `[patch]` Moving `ref={bodyRef}` off `.wb-tree-body` onto the non-scrolling panel made the entire scroll-memory feature dead while every assertion stayed green. The ref is now pinned to the element that carries `className="wb-tree-body"`.
  - `[low]` `[patch]` `.wb-split-handle`'s `width`, `position`, `z-index` and `touch-action: none` were in no assertion — deleting `touch-action: none` makes every touch drag scroll the page instead of moving the divider. The existing rule-slice check now covers all four.
  - `[low]` `[patch]` `SPLIT_KEY_STEP`'s docblock claimed it restates `--wb-space-4` with nothing asserting it. Added to the parsed constants/token parity pairs.

### 2026-08-16 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 2: (high 0, medium 0, low 2)
- reject: 26: (high 0, medium 4, low 22)
- addressed_findings:
  - `[low]` `[patch]` `treeBodyShowing` was a module-private predicate inside a `.tsx` — unreachable by `environment: "node"` and by the `*.test.ts` include glob, so inverting `!collapsed || rendered` killed the entire scroll-memory feature (no offset ever restored, none ever written) with every assertion green. The rule is now `treeScrollActive(collapsed, rendered)` in `workbench-split.ts`, executed over all four cases; the component only asks the element and passes the answer in.
  - `[low]` `[patch]` The `.wb-shell[data-resizing="true"]` rule could be emptied green: `expect(css).toContain("cursor: col-resize;")` searched the whole file and was already satisfied by `.wb-split-handle`'s own declaration, and `user-select: none` was in no assertion at all. The test now slices that rule and asserts both declarations inside it.
  - `[low]` `[patch]` `user-select: none` was unprefixed, so on Safari below 17.4 every divider drag swept a text selection across the tree labels the pointer passed over — the exact outcome the rule exists to prevent. `-webkit-user-select: none;` added and asserted.
  - `[low]` `[patch]` `workbench-state.ts`'s docblock contradicted itself — its opening list says "which row was picked" is stored here, and two paragraphs later "the Wiki SELECTION is deliberately absent from this file". Reworded to name the current **Wiki id** as the absent thing and to say the picked row is stored and scoped to one.

## Design Notes

**Copy (character-exact; do not paraphrase).**

| Where | String | Source |
|---|---|---|
| Tree divider accessible name | `Resize the left column` | authored, UX-DR23 voice |
| Preview divider accessible name | `Resize the Preview column` | authored, UX-DR23 voice |

**Why the canvas floor is 320px in every mode.** `epics.md:440` reads "Chat (when visible) cannot go below 320px", and in Epic 1 Chat is not a column — it is what the canvas renders when the rail's second icon is active (`ModeCanvas.tsx:79-85`). Nothing about a mode switch changes a width, so a tree dragged to leave 240px of canvas in Wiki mode would either crush Chat on the next click or snap the layout under the owner. Applying the floor to the canvas itself makes the rule true at every moment instead of only while Chat is showing, and it is simultaneously the maximum FR-6 asks for ("trees/Preview cannot consume the whole frame") — expressed once, in the clamp, rather than as a second invented number.

**Why the floor is enforced in JavaScript rather than in the grid.** `minmax(var(--wb-split-min-chat), 1fr)` on the canvas track would look like the same rule, but a grid cannot express "when there is not enough room, shrink the TREE" — it overflows instead, and `.wb-shell` is `overflow: hidden`, so the Preview would be clipped out of existence rather than the tree giving up 40px. The clamp orders the two columns explicitly (tree first, then Preview against the clamped tree), which is a decision, so it is a pure function the suite runs.

**Why the handle is positioned from the same custom properties.** The applied width and the divider's position must agree to the pixel or the owner grabs a strip of nothing. Computing `left` in JavaScript would be a second derivation of the layout; reading `calc(var(--wb-rail) + var(--wb-tree) - …)` in CSS makes the handle read the exact value the grid track read. It also means the 1199px block — which pins both side columns to their minimums and ignores the inline vars — is the same place the handle is hidden, so there is no width at which the divider can be somewhere the boundary is not.

**Why the restore needs a signature ref.** `Workbench.tsx:118-120` clears the selection whenever `mode`, `currentWikiId` or `treeTab` changes, and `workbench-left-column.test.ts:93-95` pins those deps verbatim. Restoring mode, tab and selection in the mount effect makes that effect fire again with the restored deps and clear the pick that was just restored — the restore would be invisible and the test would stay green. The mount effect records the signature of the state it restored; the reset effect returns without clearing while a restore is pending, clears the record once the signature matches, and behaves exactly as before for every later change. Its last statement is still `setSelection(null);`, so the frozen assertion still describes it.

```ts
// The shape of the guard — the reset effect keeps its deps and its last line.
const signature = layoutSignature(mode, currentWikiId, treeTab);
const pending = restoreSignatureRef.current;
if (pending !== null) {
  if (pending === signature) restoreSignatureRef.current = null;
  return;
}
setSelection(null);
```

**Why the Wiki selection needs no new storage.** The epic AC asks that "project/Wiki selection restores". It already does, server-side: `WikiSwitcher` PUTs `/api/wikis/current` and `page.tsx` renders from `wikiRegistry.registry.currentId` (`workbench-left-column.test.ts:490`), which is durable across browsers as FR-8 requires and is the opposite of browser-local. A second copy in `localStorage` would be a rival source of truth for the one piece of state this epic deliberately keeps in the kernel. What this story owes that AC is that the restored ROW is scoped to that Wiki id, which is why the stored selection carries one.

**Why the first paint is still the default.** Widths, like mode and collapse, are read in an effect. A stored 460px tree therefore paints at 280px for one frame. Storing them in a cookie so the server could render them is the only way around it, and that would make a browser-local view preference part of every server render for the sake of one frame. `data-mounted="false"` already suppresses transitions during exactly this window (`globals.css:3192-3199`), so the correction is a jump, not an animation played back at the owner.

## Verification

**Commands:**
- `npx vitest run` -- expected: green. Baseline is 202 files / 4,028 tests; this story adds one file.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors (the pre-existing `jsx-ast-utils` TSNonNullExpression notices are not errors).
- `git status --porcelain src/lib/__tests__ src/components/__tests__` -- expected: exactly one entry, the untracked `src/lib/__tests__/workbench-split.test.ts`.
- `grep -c "Georgia" src/app/globals.css` -- expected: 1. `grep -rn "Georgia\|[^-]serif" src/components/workbench` -- expected: only `sans-serif` matches, none in `SplitHandle.tsx`.
- `grep -c "^\.wb-shell {$" src/app/globals.css` -- expected: 1.
- `grep -n "@media (max-width: 1199px)\|@media (max-width: 899px)" src/app/globals.css` -- expected: the same two occurrences of each as before this story (no new block).
- `grep -rn "innerWidth\|matchMedia(\"(min-width: 1200" src/components/workbench` -- expected: no match; the breakpoint is CSS only.

**Manual checks (if no CLI):**
- Inspect the diff of `Workbench.tsx` to confirm the reset effect's deps and its final `setSelection(null);` are unchanged, and that the three `readStored…` call sites still read verbatim.
- Inspect `SplitHandle.tsx` for any literal pixel number, comparison or bound — there should be none; every value arrives as a prop.


## Auto Run Result

Status: done

**Summary of implemented change.** The two column boundaries of the Workbench shell now carry a real separator control — pointer drag and keyboard — that writes `--wb-tree` and `--wb-preview` as inline custom properties on `.wb-shell`, clamped so the canvas keeps its 320px floor in every mode and the tree and Preview keep theirs. Those widths, the tree selection and the per-tab tree scroll offset are persisted browser-locally beside the three keys already in `workbench-state.ts` and restored on mount, with the selection restored only when it still names a row in the trees this render was given, for the Wiki the registry still calls current. Every geometry decision — the bounds, the clamp, pointer-x → width, key → width, the press and key gates, the show/hide rule and now the scroll-memory rule — is a pure exported function the node suite executes; the component holds state and reads a rect, and spells no bound of its own.

This pass was a follow-up review of an already-`done` spec, not a re-implementation. It applied four low-severity patches (below) on top of that change.

**Files changed (since `bf0897df75b44d50aee65a3a00775b3b56f413c9`).**
- `src/lib/workbench-split.ts` — new: the geometry constants, `splitBounds`, `clampSplitWidths`, `splitWidthFromPointer`, `nextSplitWidthFromKey`, `splitStyleVars`, `showSplitHandle`, `isPrimarySplitPress`, `isUnmodifiedSplitKey`, `layoutSignature`, `treeScrollActive`, and the two accessible names.
- `src/components/workbench/SplitHandle.tsx` — new: the `role="separator"` control; no number, no bound, no storage.
- `src/components/workbench/Workbench.tsx` — width state, measured shell, the two handle mounts, `data-resizing`, the signature-guarded selection restore and the guarded selection persist.
- `src/components/workbench/TreePanel.tsx` — a `collapsed` prop, a ref on `.wb-tree-body`, an rAF-coalesced scroll persist and a restore, both gated on the executed `treeScrollActive`.
- `src/lib/workbench-state.ts` — three new keys and six accessors, in the file's existing SSR-guard / try-catch / narrow-on-read shape.
- `src/lib/workbench-tree.ts` — `selectionExists` and `restorableSelection` beside `isSameSelection`.
- `src/app/globals.css` — `--wb-split-hit`, `position: relative` on `.wb-shell`, the handle rules, the `data-resizing` rule, and `display: none` for the handles inside the existing 1199px block.
- `src/lib/__tests__/workbench-split.test.ts` — new: every I/O matrix row executed, the TS-constants ↔ CSS-token parity check, and the scans the node suite cannot execute.

**Review findings breakdown (this pass).** 4 patches applied (0 high, 0 medium, 4 low) — the unexecutable `treeBodyShowing` predicate, the gutted-green `data-resizing` rule assertion, the missing `-webkit-user-select`, and a self-contradicting docblock. 2 items deferred (both low) — the restore's lack of a tab check, and the scroll effects missing the live 899px transition. 26 rejected, including several already covered by the two existing deferred entries (the 9px target size, the ARIA `aria-controls` / PageUp gaps) and several that would contradict the frozen intent (a pointer grab-offset, a `ResizeObserver`, a JS breakpoint, re-ordering the clamp the I/O matrix pins).

**Follow-up review recommendation:** `false`. Patched this pass: 0 high, 0 medium, 4 low → score `3×0 + 1×4 = 4`, below the threshold of 5, and no patched finding was high severity.

**Verification performed.**
- `npx vitest run` — green: 203 files, 4,122 tests, 0 failures.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0 (the three pre-existing `jsx-ast-utils` TSNonNullExpression notices are not errors).
- `git status --porcelain src/lib/__tests__ src/components/__tests__` — one entry, `src/lib/__tests__/workbench-split.test.ts` (tracked as of the story commit, modified by this pass). No pre-existing test file was edited.
- `grep -c "Georgia" src/app/globals.css` — 1. `grep -rn "Georgia\|[^-]serif" src/components/workbench` — no matches.
- `grep -c "^\.wb-shell {$" src/app/globals.css` — 1.
- `@media (max-width: 1199px)` and `@media (max-width: 899px)` — two occurrences each, unchanged; no new block.
- `grep -rn "innerWidth\|matchMedia(\"(min-width: 1200" src/components/workbench` — no match; the breakpoint is CSS only.
- Manual: `Workbench.tsx` was not touched this pass, so the reset effect's pinned deps, its final `setSelection(null);` and the three frozen `readStored…` call sites are unchanged; `SplitHandle.tsx` was not touched and still carries no literal number beyond `tabIndex={0}`.

**Residual risks.**
- No DOM test environment exists, so the component wiring — the ARIA attributes, the pointer-capture protocol, the effects — is verified by source scans rather than by rendering. The scans are whitespace- and formatter-sensitive by construction and will need updating alongside any reformat of these files.
- The two newly deferred items are both real and both narrow: the restore can be reached in a tab/row-mismatched state only after a transient server read failure spanning a tab switch, and the scroll memory misses only the live 899px resize transition, not a load at that width.
- Arrow-key auto-repeat writes `localStorage` once per repeat (the drag deliberately writes once per gesture); the payload is two integers, so this was judged not worth a debounce.
