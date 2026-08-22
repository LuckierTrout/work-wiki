---
title: 'Story 1.4: Knowledge Tree and File Tree'
type: 'feature'
created: '2026-08-15'
status: 'done'
baseline_revision: 'e8ab073c3e19023eafeaf99d6311d5161d4cba35'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Switching Wikis changes only `purpose.md` and `schema.md` in the trees;
      `wiki/` and `raw/` are tenant-flat, so the Knowledge tab shows the same
      pages under every Wiki.
    evidence: |-
      `src/lib/wikis.ts:16-17` states that Pages and Sources are deliberately
      not partitioned per Wiki, and `deferred-work.md` DW-17 already owns that
      migration. `listWorkbenchFilePaths` therefore walks the owner's one silo
      (`tenants/<t>/wiki`, `tenants/<t>/raw`, or the flat roots when the silo is
      empty) regardless of `wikiId`, and
      `buildKnowledgeTree` groups `listReadableWikiPages(principal)` — also
      tenant-wide. The AC's "the trees show that Wiki's files" is met only to
      the extent anything is per-Wiki on disk today: the two seeded artifacts
      under `tenants/<t>/wikis/<id>/`. Closing the gap means repartitioning the
      kernel's storage, which reaches ingest, index, silo, graph and MCP — a
      migration, not a browse story.
    location: >-
      src/lib/workbench-files.ts, src/lib/wikis.ts
    severity: medium
  - summary: >-
      The Files tab shows `purpose.md` and `schema.md` at the tree root, so the
      path the Preview strip prints for them is not the path that addresses
      their bytes.
    evidence: |-
      The I/O matrix fixes those two artifacts at the root of the file tree, but
      they physically live at `tenants/<t>/wikis/<id>/<file>`
      (`wikiArtifactPath`). `listWorkbenchFilePaths` emits them as bare names,
      and `PreviewColumn` prints the selection path verbatim, so a reader is
      shown `purpose.md` where storage holds a three-segment key. Nothing reads
      the printed path in this story, but Story 1.5 has to fetch bytes from a
      selection — it will need either a real storage path on the node or a
      resolver that maps root artifacts back to `wikiArtifactPath`.
    location: >-
      src/lib/workbench-files.ts, src/components/workbench/PreviewColumn.tsx
    severity: medium
  - summary: >-
      The read gate covers `wiki/` leaves only; `raw/` filenames are listed
      unfiltered, and they are derived from page slugs.
    evidence: |-
      `listWorkbenchFilePaths` filters `.md` leaves under the wiki root against
      the slug set `listReadableWikiPages` returned, so a page hidden from the
      Knowledge tab cannot surface in Files by filename. `raw/` is not filtered:
      `saveRawSource` writes `raw/<slug>.md` and `saveRawSourceFor` writes
      `raw/<slug>/<hash>.md`, so the source tree still spells the slug of a page
      the filter excludes. In the single-owner Workbench this epic ships, every
      file under the tenant belongs to the signed-in owner, so nothing crosses
      an owner boundary today — the exposure is limited to agent-scoped pages
      and to legacy flat-tree residue. Filtering `raw/` needs a source→page
      mapping the walk does not have (one raw file can back several pages, and
      an orphaned source backs none), so it belongs with whichever story gives
      Sources a real read model — Epic 2.
    location: >-
      src/lib/workbench-files.ts
    severity: low
  - summary: >-
      Wiki mode now shows two Wiki switchers and two create controls at once —
      the new header pair and Story 1.2's canvas card.
    evidence: |-
      `create-wiki-ui.test.ts:118-209` counts `btn primary`,
      `fallbackFocusRef={headingRef}` and `router.refresh()` occurrences inside
      `src/components/WikiWorkbench.tsx`, so this story was forbidden to edit
      that file at all — its `Active wiki` <select>, its `New wiki` button and
      its `Change template` control all stay. The result is a duplicated
      affordance in one viewport: the header switcher and the card switcher
      drive the same `PUT /api/wikis/current`, and `page.tsx` keys the card on
      `currentId` so they cannot disagree, but the owner is offered the same
      choice twice. Retiring the card's switcher means retargeting those frozen
      counts, which belongs with whatever story rebuilds the Wiki canvas
      (Story 1.5 onwards) rather than with the column that now duplicates it.
    location: >-
      src/components/WikiWorkbench.tsx
    severity: low
  - summary: >-
      Docking and undocking the Preview is a silent layout change, and below
      900px the column arrives off screen below the canvas.
    evidence: |-
      Story 1.3 gave the shell a polite live region, but only `selectMode`
      writes to it — selecting a tree row adds a whole fourth column with no
      announcement and no focus move, and re-selecting the same row removes it
      just as quietly. At `max-width: 899px` the shell is one column and the
      Preview stacks as the last row, so on a phone tapping a tree row appears
      to do nothing until the owner scrolls. Neither behaviour is wrong against
      this story's acceptance criteria, which ask only that selection dock the
      column, and both are cheap to get wrong in isolation: what to announce
      depends on what the column will say, which is Story 1.5's, and where a
      docked column goes at narrow widths is the layout question Story 1.6
      owns. Deciding either here would pre-empt a story that has the context.
    location: >-
      src/components/workbench/Workbench.tsx, src/app/globals.css
    severity: low
---

<intent-contract>

## Intent

**Problem:** Story 1.3 shipped the Workbench shell with an empty left column — `<aside className="wb-left">` holds the `work-wiki` title and one muted label naming the active mode, and a code comment reserving the rest for this story. The owner cannot see what is in their Wiki: compiled Pages live behind `/api/wiki` and the seeded `purpose.md` / `schema.md` have no reader at all (`deferred-work.md` DW-16). The only wiki-switching control is a bare `<select>` buried in Story 1.2's canvas card, and nothing docks a Preview column, so Stories 1.5 and 1.6 have no selection source to build on.

**Approach:** Fill the left column: a header that carries the product title plus a Wiki switcher and New Wiki, `Knowledge | Files` tabs beneath it, and a tree per tab — Knowledge groups the readable page index by `type` with counts; Files renders the real storage layout (`purpose.md`, `schema.md`, `raw/`, `wiki/`). Tree data is loaded server-side in `page.tsx` and passed into the shell as props, so no new API route and no client fetch are introduced. Selecting a row sets shell-level selection state and docks a fourth grid column — this story ships that column's header and frontmatter strip; Story 1.5 fills its body.

## Boundaries & Constraints

**Always:**
- The left column renders, top → bottom: `.wb-left-head` (the existing `<h1 className="wb-title">{APP_NAME}</h1>` verbatim, then the Wiki switcher and New Wiki), then the `Knowledge | Files` tabs, then the active tree. Tabs and trees render in Wiki mode only; every other mode keeps Story 1.3's `.wb-left-surface` label unchanged (UX-DR5, `epics.md:387-391`).
- Tabs are `role="tablist"` / `role="tab"` with `aria-selected` and a `role="tabpanel"`; exactly one tab is selected. Labels are `Knowledge` and `Files`, in that order (`DESIGN.md:259`, `mockups/todos.html:183`).
- The Wiki switcher is a native `<select>` with a visually-hidden label `Active wiki`; New Wiki is a `<button>` labelled `New Wiki` that opens the existing `src/components/CreateWikiDialog.tsx` (UX-DR5, `EXPERIENCE.md:91`).
- Tree rows are real `<button>`s inside nested `<ul>`/`<li>`; the selected row carries `aria-current="true"`. Group rows are `<button aria-expanded>` disclosures, expanded by default. Indentation is 12px per level (`mockups/todos.html:111`).
- Knowledge groups by `IndexEntry.type`; entries with no `type` form one group labelled `Pages`, placed first, and the remaining groups follow in ascending label order. Every group shows its count. Entries sort by `title`, ties by `slug` (`reconcile-nashsu-screenshots.md:23`).
- Files renders the storage layout the kernel actually uses: the current Wiki's `purpose.md` and `schema.md` at root, plus the `raw/` and `wiki/` directories walked from the same relative roots `listRawSources()` and `listWikiPages()` read (`rawRelPath("")`, `wikiRelPath("")`). Directories sort before files, each alphabetically. The walk is bounded — depth 3, 2000 nodes — and reports truncation.
- All tree data is loaded in `src/app/page.tsx` from the authenticated `Principal` (`getPrincipal()` → `listReadableWikiPages(principal)`, `getWikiRegistry(principal.handle)`). No listing function may be called with a hard-coded owner or tenant, and nothing may bypass `listReadableWikiPages`'s authz filter (`prd.md:143`).
- Selecting a row sets shell-level selection state and sets `data-preview="true"` on `.wb-shell`; the docked column is a fourth grid column at `minmax(var(--wb-split-min-preview), var(--wb-preview))`, DOM-ordered after the canvas so Tab order stays rail → left column → canvas → Preview (`EXPERIENCE.md:165`). Deselecting, switching Wikis, or leaving Wiki mode undocks it.
- The active tab persists to `localStorage` under `yopedia_workbench_tree_tab` through the same SSR-guarded, try/catch, value-validating accessors as `src/lib/workbench-state.ts:27-37`.
- New chrome is styled from `--wb-*` tokens only, carries `data-no-localize`, and adds no serif. Copy is one unsentimental sentence per empty state, no emoji, no illustration (UX-DR2, UX-DR15, UX-DR23).
- Every user-visible string added here is listed in **Design Notes → Copy**; use those strings character-exact.
- No pre-existing test file may be modified or weakened. In particular `src/components/WikiWorkbench.tsx` is not edited at all: `create-wiki-ui.test.ts:118-209` counts `btn primary` (1), `fallbackFocusRef={headingRef}` (2) and `router.refresh()` (3) inside that file, so relocating its switcher or its create path would break a frozen test.
- `src/app/globals.css` stays append-only *above* line 2814: `:root`, `.dark` and `@theme inline` must remain byte-identical. Rules inside the Story 1.3 block may be extended, and new tokens are declared in a **second** `.wb-shell { … }` block appended at end of file, because `workbench-chrome.test.ts:33-58` parses only the first one.

**Block If:**
- Satisfying "the trees show that Wiki's files" appears to require partitioning Pages or Sources per Wiki id (see **Never**), or editing `src/components/WikiWorkbench.tsx`, `src/lib/__tests__/create-wiki-ui.test.ts`, or `src/lib/__tests__/workbench-chrome.test.ts`.

**Never:**
- Do not repartition Pages or Sources per Wiki. Story 1.2 deliberately left them tenant-flat (`src/lib/wikis.ts:16-17`), `deferred-work.md` DW-17 owns that migration, and this story's acceptance criteria ask for a browse surface, not a storage change.
- Do not render markdown, GFM, tables, wikilinks, Georgia body type, or an Edit control in the Preview column — Story 1.5. Do not build drag-resize splitters or restore tree selection/scroll — Story 1.6. Do not build `dataVersion` refresh — Story 1.7. Do not add Import, Upload, drag-drop or an ingest queue to the tree header — Story 2.1 (`epics.md:530`).
- Do not render the string `Open project folder` anywhere (UX-DR5, `EXPERIENCE.md:202`).
- Do not add an API route, a client-side fetch of tree data, a server action, `stat()` per file, or a recursive listing helper to the storage provider.
- Do not use `next/link`, `useRouter` or `router.push` inside `src/components/workbench/Workbench.tsx` — `workbench-chrome.test.ts` bans all three there. `router.refresh()` belongs in the switcher component.
- Do not add jsdom, `@testing-library/*`, or `.test.tsx` support; `vitest.config.ts` stays `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]`.
- Do not restyle the app outside the shell, add a dark theme, a shadcn component, or a second overlay level; `CreateWikiDialog` is the only modal this story opens.
- Do not introduce `MobileNavigationDock`, `mobile-navigation`, `navigator.userAgent` or `isMobileDevice` in any new file or comment (`single-ia.test.ts:41-69`), and do not write `WorkWiki` or a bare `yopedia` outside the `yopedia_…` key form (`brand-copy.test.ts:123-141`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Knowledge grouping | entries with `type` `concept`, `concept`, undefined | groups `[{label:"Pages",count:1},{label:"Concept",count:2}]`, untyped first | No error expected |
| Knowledge label casing | `type: "agent-identity"` | group label `Agent identity` | No error expected |
| Knowledge sort | same-type entries `Zeta`/`Alpha` | ordered `Alpha`, `Zeta`; equal titles ordered by `slug` | No error expected |
| Knowledge empty | `[]` | zero groups; panel shows the empty sentence | No error expected |
| File tree nesting | paths `wiki/a.md`, `raw/x/y.md`, `purpose.md` | root has `purpose.md`, `raw/` (→ `x/` → `y.md`), `wiki/` (→ `a.md`) | No error expected |
| File tree ordering | `wiki/b.md`, `raw/`, `schema.md` | directories `raw/`, `wiki/` before files `schema.md` | No error expected |
| File walk truncation | more than 2000 nodes | tree holds 2000 nodes and `truncated: true` | Walk stops, no throw |
| File walk depth | a path 4 levels deep | levels beyond depth 3 are omitted, `truncated: true` | No error expected |
| Listing failure | `storage.listFiles` rejects for `raw/` | that subtree is empty, the rest of the tree still renders | Error logged, page still renders |
| No wiki | registry `currentId: null` | both trees show `No wiki yet.`; switcher hidden; New Wiki still offered | No error expected |
| Registry unavailable | `getWikiRegistry` threw | left column shows the load-failure sentence; no switcher | Caught in `page.tsx`, `unavailable: true` |
| Default tab | no stored tab | `readStoredTreeTab()` → `"knowledge"` | No error expected |
| Corrupt stored tab | value `"filez"`, `""`, `"[1]"` | `readStoredTreeTab()` → `"knowledge"` | Unknown value ignored |
| localStorage throws | accessor throws | read → default, write → silent no-op | try/catch swallows |
| Server render | `typeof window === "undefined"` | read → default, write → no-op | No error expected |

</intent-contract>

## Code Map

**Extend (this story edits these four files and no other existing source):**
- `src/components/workbench/Workbench.tsx:35-41` props, `:233-243` left column. Add props `wikis`, `currentWikiId`, `registryUnavailable`, `knowledge`, `files`; add `treeTab`, `selection` state (restore the tab in the existing mount effect beside `readStoredMode`/`readStoredCollapsed` at the same call sites the chrome test pins); render `<WikiSwitcher>` inside `.wb-left-head` after the untouched `<h1 className="wb-title">{APP_NAME}</h1>`, `<TreePanel>` after it when `mode === "wiki"` (otherwise keep the existing `.wb-left-surface` `<p>`), `data-preview` on `.wb-shell`, and `<PreviewColumn>` after `<ModeCanvas>`. No `useRouter`, no `next/link`.
- `src/app/page.tsx:8-34` — already `force-dynamic` and already the `getPrincipal()`/`getWikiRegistry()` call site. Add the two tree loads, pass them plus the registry into `<Workbench>`, and give `<WikiWorkbench>` a `key` derived from `currentId`. Keep `redirect("/sign-in")`, `unavailable: true` and `unavailable={wikiRegistry.unavailable}` verbatim — `create-wiki-ui.test.ts:181-183` and `workbench-chrome.test.ts:495` read them.
- `src/lib/workbench-state.ts` — add `WORKBENCH_TREE_TAB_KEY = "yopedia_workbench_tree_tab"`, `readStoredTreeTab()`, `writeStoredTreeTab()`, copying the accessor idiom at `:27-37` exactly (SSR guard, try/catch, narrow on read).
- `src/app/globals.css` — extend `.wb-left` (`:3080-3089`) so the header stays put and the tree body scrolls, and append the new `.wb-tab*`, `.wb-tree*`, `.wb-wiki-switch*` and `.wb-preview*` rules plus a second `.wb-shell { --wb-preview: 360px; }` token block at end of file (currently 3294 lines). The docked grid variants are new `.wb-shell[data-preview="true"]` selectors, including the `[data-collapsed="true"]` combination and both media blocks (`:3185` 1199px, `:3192` 899px).

**Reuse as-is (do not fork, do not edit):**
- `src/components/CreateWikiDialog.tsx:31-39` — `{ open, busy?, error?, onCancel, onCreate({name, scenario}), fallbackFocusRef? }`. Self-contained; `WikiWorkbench.tsx:265-272` is the usage to copy. Posts nothing itself — the caller owns `POST /api/wikis`.
- `src/lib/wikis.ts` — `WikiRecord {id,name,scenario,createdAt,updatedAt}` (`:52-58`), `WikiRegistry` (`:60-65`), `getWikiRegistry(owner)` (`:308`), `wikiArtifactPath(owner, wikiId, file)` → `tenants/<t>/wikis/<id>/<file>` (`:110-117`), `WIKI_ARTIFACT_FILES === ["purpose.md","schema.md"]` (`wiki-scenarios.ts:57`).
- `src/lib/wiki.ts` — `listReadableWikiPages(principal)` (`:624-630`, the sole visibility gate), `wikiRelPath(filename)` → `wiki/<filename>` (`:42-44`). `src/lib/raw.ts` — `rawRelPath` root (`raw/`, flat by convention, with optional `raw/<slug>/` subdirectories).
- `src/lib/types.ts:10-34` — `IndexEntry`; `type` is a free `string`, there is no union. `src/lib/page-types.ts` — `isAgentScopedType(type)`; exclude those from Knowledge, matching `/api/wiki`'s default (`src/app/api/wiki/route.ts:32`).
- `src/lib/storage/types.ts:69-75` — `FileEntry { name, isDirectory }`; `listFiles(prefix)` is single-level in both providers (`filesystem.ts:88-103`, `r2.ts:80`). There is no recursive helper and no size in the listing — hence the bounded walk and no per-file `stat`.
- `src/lib/auth.ts:18-24,66` — `Principal { id, handle }`, `getPrincipal(): Promise<Principal|null>`.
- `src/lib/vault-explorer-view.ts:55-96` — `buildExplorerFacets` is the repo's existing "count by path prefix" idiom; copy its shape for grouping, not its types.

**Precedent to copy (read-only):**
- `mockups/todos.html:95-111,182-201` — the tree panel: `width:280px; min-width:200px; border-right`, `.tabs span { flex:1; text-align:center; padding:8px }` with `.on { font-weight:600; border-bottom:2px solid }`, `.tree-head { padding:10px 12px; font-weight:600 }`, `.tree-body { padding:8px 12px }`, `li { padding:2px 0 2px 12px }`, groups rendered as `raw/` and `wiki/`.
- `mockups/chat-cited.html:108-127,194-208` — the docked Preview: `width:360px; min-width:200px`, `header { padding:10px 14px; border-bottom }` with `<strong>Preview</strong>`, then `.fm { padding:8px 14px; border-bottom; color:muted; font-size:12px }` with a `.mono` line, then `.body` (Georgia — Story 1.5, not this story).
- `src/lib/__tests__/single-ia.test.ts:19-38` and `create-wiki-ui.test.ts:1-10,143-146` — the `walk()` + read-as-text + `expect(offenders).toEqual([])` scan recipe, including `source.replace(/\s+/g," ")` before matching wrapped copy.
- `src/components/workbench/RailIcons.tsx:13-41` — the `Glyph` wrapper authoring style if a disclosure chevron glyph is needed; reuse the exported `ChevronLeftIcon` geometry rather than adding an icon dependency.

**Read-only constraints (do not regress):**
- `src/lib/__tests__/workbench-chrome.test.ts` — `Workbench.tsx` must keep `<h1 className="wb-title">{APP_NAME}</h1>`, `<h1 className="wb-sr-only wb-title-fallback">`, the `aria-live="polite"` block, `setModeState`, `aria-controls={RAIL_ID}`, the `getClientRects()` focus filter, the pure-updater patterns, and must contain none of `router.push(`, `from "next/link"`, `useRouter(`. Its CSS assertions read only the *first* `.wb-shell {` block plus the rules after it, which must not contain `var(--ink)`, `var(--paper)`, `var(--accent)` or `Georgia`; every property `.dark` overrides must stay present and equal in `:root` and `.wb-shell`.
- `src/lib/__tests__/create-wiki-ui.test.ts:118-209` — the `WikiWorkbench.tsx` literals and counts listed under **Always**; `HomeDashboard.tsx` still needs its `<h1>` (DW-28 owns its retirement).
- `src/lib/__tests__/single-ia.test.ts:41-78`, `brand-copy.test.ts:66-83,123-141`, `links.test.ts:189-194` (never emit `/wiki/<slug>`; use `pagePath`/`slugPath`/`resolveSlugPath` if this story emits any page URL — it should not need to).

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-tree.ts` -- new pure, client-safe module: `TreeTabId = "knowledge" | "files"`, `DEFAULT_TREE_TAB = "knowledge"`, `isTreeTabId()`, `TREE_TABS` (ordered `[{id,label}]`), the `KnowledgeGroup`/`FileNode`/`TreeSelection` types, `buildKnowledgeTree(entries: IndexEntry[]): KnowledgeGroup[]`, `buildFileTree(paths: readonly string[]): FileNode[]`, `knowledgeGroupLabel(type?: string)`, and the empty/truncation copy constants -- one testable source for every ordering, label and count rule in the I/O matrix, importable from both the client tree and a node-environment test.
- `src/lib/workbench-files.ts` -- new server-only module: `WORKBENCH_FILE_LIMIT = 2000`, `WORKBENCH_FILE_MAX_DEPTH = 3`, `listWorkbenchFilePaths(owner: string, wikiId: string | null): Promise<{ paths: string[]; truncated: boolean }>` -- a bounded breadth-first walk of `wikiRelPath("")` and `rawRelPath("")` through `storage.listFiles`, prefixed by the current Wiki's `purpose.md`/`schema.md`, each subtree wrapped so one rejected listing degrades to an empty branch instead of failing the page. Returns storage-relative paths only; `buildFileTree` does the nesting.
- `src/lib/workbench-state.ts` -- add the tree-tab key and its read/write accessors as described in the Code Map -- FR-8 durability for which tree is showing, with no server round-trip.
- `src/components/workbench/WikiSwitcher.tsx` -- new client component: props `{ wikis, currentWikiId, unavailable }`; renders a visually-hidden-labelled `<select>` (rendered only when at least one Wiki exists) that `PUT`s `/api/wikis/current` then calls `router.refresh()`, a `New Wiki` button opening `CreateWikiDialog` which `POST`s `/api/wikis` then refreshes, an inline `role="alert"` for either failure, and the load-failure sentence when `unavailable` -- UX-DR5's "header is the Wiki switcher plus New Wiki" without touching the frozen `WikiWorkbench.tsx`.
- `src/components/workbench/TreePanel.tsx` -- new client component: props `{ tab, onTabChange, knowledge, files, truncated, hasWiki, unavailable, selection, onSelect }`; renders the tablist, the active `role="tabpanel"`, and the tree — Knowledge as group disclosures with count spans over page rows, Files as nested directory disclosures over file rows — each row a `<button>` calling `onSelect`, the selected one `aria-current="true"`; renders the matching empty sentence when a tab has nothing, and the truncation note under Files when `truncated` -- UX-DR5 and the AC's "expand Knowledge and Files" in one component.
- `src/components/workbench/PreviewColumn.tsx` -- new client component: props `{ selection, knowledge, files }`; renders `<aside className="wb-preview">` with a `Preview` header naming the selection and a `.wb-preview-fm` frontmatter strip (page: title, `wiki/<slug>.md` in mono, `type`, `updated`, `sourceCount` where present; file: name and storage path in mono). Renders nothing when `selection` is null -- the dock this story owes Story 1.5, split at the mockup's own `header` / `.fm` / `.body` seam.
- `src/components/workbench/Workbench.tsx` -- wire the above per the Code Map: new props, `treeTab` and `selection` state, tab restore in the mount effect and `writeStoredTreeTab` on change, `data-preview` on the shell, selection cleared when `mode` leaves `wiki` or `currentWikiId` changes -- the shell stays the single owner of layout state, so Story 1.6 restores selection from one place.
- `src/app/page.tsx` -- load `listReadableWikiPages(principal)` and `listWorkbenchFilePaths(principal.handle, registry.currentId)` beside the existing registry read, each degrading to empty on failure the way the registry already does; pass `wikis`, `currentWikiId`, `registryUnavailable`, `knowledge`, `files`, `filesTruncated` to `<Workbench>`; add `key={wikiRegistry.registry.currentId ?? "none"}` to `<WikiWorkbench>` -- server-loaded data with `router.refresh()` as the refresh signal (Story 1.7 replaces it), and the key stops Story 1.2's `useState`-seeded card from showing a stale Wiki after a header switch.
- `src/app/globals.css` -- extend `.wb-left` and append the tabs, tree, switcher and preview rules plus the docked-grid variants and the second `.wb-shell` token block, per the Code Map. Tree rows use `--wb-rail-hover` for hover and `--wb-active-wash` for the selected row, 12px indent per level, counts in `--wb-muted`; the preview column uses `--wb-preview`/`--wb-split-min-preview` and no serif -- UX-DR1/2/24 in CSS, width-driven, no UA branching.
- `src/lib/__tests__/workbench-tree.test.ts` -- new: cover every `buildKnowledgeTree`, `buildFileTree` and tab-persistence row of the I/O matrix (grouping, untyped-first, label casing, sort and tie-break, empty, nesting, directory-first ordering, node cap, depth cap, default/corrupt/throwing/SSR tab reads with a stubbed `globalThis.window.localStorage`), and assert `WORKBENCH_TREE_TAB_KEY` starts with `yopedia_` -- the ordering and count rules are the story's only real logic.
- `src/lib/__tests__/workbench-left-column.test.ts` -- new source-scan test (the `single-ia.test.ts` convention): `Workbench.tsx` renders `<WikiSwitcher` and gates `<TreePanel` on Wiki mode while keeping the `.wb-left-surface` branch, restores the tab through `readStoredTreeTab()` and writes through `writeStoredTreeTab(`, sets `data-preview`, and still contains no `useRouter(`/`router.push(`/`next/link`; `TreePanel.tsx` has `role="tablist"`, two `role="tab"` with `aria-selected`, `role="tabpanel"`, `aria-expanded` disclosures and `aria-current="true"`, and sources every sentence from `@/lib/workbench-tree`; `WikiSwitcher.tsx` opens `CreateWikiDialog` and calls `router.refresh()`; `PreviewColumn.tsx` contains no `Georgia`, no markdown renderer import and no `Edit` control; no file under `src/` contains `Open project folder`; `globals.css` contains `.wb-shell[data-preview="true"]` grid variants in the base block and both media blocks, and `--wb-preview` -- pins the AC's structural invariants where no DOM test can.

**Acceptance Criteria:**
- Given a signed-in owner in Wiki mode at ≥1200px, when the left column renders, then it shows the `work-wiki` title, a Wiki switcher and a `New Wiki` control in its header, `Knowledge | Files` tabs below it, and the active tab's tree — and no source file anywhere renders the string `Open project folder`.
- Given the template Wiki created by Story 1.2, when the owner opens the Files tab and expands the tree, then `purpose.md`, `schema.md`, `raw/` and `wiki/` are all present, and opening the Knowledge tab shows the readable pages grouped by type with a count on each group.
- Given a tree row, when the owner selects it, then a Preview column docks as a fourth column after the canvas showing that row's name and its storage path, selecting another row replaces it, and leaving Wiki mode undocks it without a route change.
- Given more than one Wiki, when the owner picks another from the header switcher, then the trees and the Wiki-mode canvas both show the newly current Wiki, the Preview column undocks, and no request is made that would return another owner's pages.
- Given the owner reloads after choosing the Files tab, when the shell mounts, then the Files tab is active again; and given `localStorage` is unavailable, then the tab falls back to Knowledge with no error surfaced.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and no pre-existing test file was modified or weakened.

## Spec Change Log

- **Implementation, 2026-08-15 — the working set reaches the shell as context, not as `<Workbench>` props.** The Tasks section says `page.tsx` passes `wikis`, `currentWikiId`, `registryUnavailable`, `knowledge`, `files`, `filesTruncated` to `<Workbench>`. Doing that turns the element into `<Workbench\n  wikis={…}`, and `workbench-chrome.test.ts:496` asserts `page.tsx` contains the literal `<Workbench>` — a frozen assertion whose only remaining way to pass would be a comment somewhere in the file that happens to spell the string, which satisfies the test without checking anything. `src/components/workbench/WorkbenchData.tsx` provides the same six values through a client provider that wraps a bare `<Workbench>`; the shell reads them with `useWorkbenchData()`. Same server-loaded data, same single load site, and the mount assertion stays a markup check. KEEP: `page.tsx` must not grow a client fetch, and the provider is where Stories 1.5 and 1.7 add fields rather than adding a prop each.

- **Implementation, 2026-08-15 — the Files tab reads the tenant silo first, and is gated by the same read filter as Knowledge.** The Tasks section describes `listWorkbenchFilePaths` as a walk of `wikiRelPath("")` / `rawRelPath("")` only. Left there, the Files tab listed the FILENAME of every page `listReadableWikiPages` excludes (agent-scoped pages, another owner's private page in the legacy flat tree) — which the Always bans (`prd.md:143`). Two changes: `tenantWikiRelPath(tenant, "")` / `tenantRawRelPath(tenant, "")` are tried first because `src/lib/silo.ts` documents the silo as PRIMARY and the flat tree as a transitional copy, with the flat roots used only when the silo is empty; and in either branch a `.md` leaf under the wiki root is listed only when its slug is in the set `listReadableWikiPages(principal)` returned, passed in as a required `readableSlugs` option. Displayed paths are unchanged (`wiki/…`, `raw/…`). KEEP: the slug set is a required argument, not an optional one — "no filter" must not be spellable. `WORKBENCH_FILE_LIMIT` / `WORKBENCH_FILE_MAX_DEPTH` moved to the client-safe `workbench-tree` module (and are re-exported from `workbench-files`) so the truncation sentence can derive its numeral from the cap.

- **Implementation, 2026-08-15 — the Files gate is the Knowledge tree, not the index behind it, and a failed index read flags both tabs.** The previous Change Log entry made `readableSlugs` "the set `listReadableWikiPages(principal)` returned". That set is wider than what the Knowledge tab renders: `buildKnowledgeTree` also drops agent-scoped pages, so an `agent-identity` page was hidden from Knowledge and listed by filename in Files — the same disclosure the gate exists to prevent, and the one `workbench-files.ts`'s own READ GATE docstring names first. `page.tsx` now derives the set from the built tree (`knowledge.flatMap(g => g.pages.map(p => p.slug))`), so the two tabs share one set by construction. Second: because the gate IS the page index, a failed index read filtered every page out of `wiki/` while `filesUnavailable` stayed false, showing an empty silo where the truth was "we could not find out" — `filesUnavailable` now carries `pageIndex.unavailable` too. KEEP: the gate must be read off the rendered tree, not off `pageIndex.entries`; both properties are pinned by execution in `workbench-tree.test.ts` and by scan in `workbench-left-column.test.ts`.

- **Implementation, 2026-08-15 — each failed read names the read that failed.** `TREE_UNAVAILABLE_COPY` ("Your wikis couldn’t be loaded.") was reused for all three failure states. On a page-index or file-walk failure the registry had loaded fine, so the Knowledge tab asserted the wikis were unreadable while the switcher directly above it listed them — one viewport, two contradictory claims. `KNOWLEDGE_UNAVAILABLE_COPY` and `FILES_UNAVAILABLE_COPY` are new constants in the same module and are added to **Design Notes → Copy**; the registry sentence keeps its own state. KEEP: three states, three sentences — a test asserts the two new ones are not equal to the registry's.

- **Implementation, 2026-08-15 — the gate's derivation is a function, and a failed silo read is not an empty silo.** Two refinements to constraints already logged above. First: the previous entry required the Files gate to be read off the rendered Knowledge tree, and it was — but as a `flatMap` typed into `page.tsx`, where only a source scan could reach it, and where an equivalent expression over `pageIndex.entries` passes that scan. The derivation is now `readableSlugsFromKnowledge(groups)` in `workbench-tree`, executed by the node suite. Second: `resolveRoot`'s silo-first resolution treated a rejected silo listing as "the silo is empty" and fell back to the flat tree; since both providers answer a missing prefix with an empty list, a rejection means unreadable, and falling back on it widens what the tab shows in response to an error. KEEP: the gate stays a required argument derived from the rendered tree, and the flat fallback stays reachable for a genuinely absent silo — only the failed-read path changed.

## Review Triage Log

### 2026-08-15 — Review pass (follow-up 2)

- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 0, low 8)
- defer: 0
- reject: 27: (high 0, medium 4, low 23)
- addressed_findings:
  - `[low]` `[patch]` The Files gate's derivation was a `flatMap` typed inline in `page.tsx`, so at that layer the story's privacy rule was pinned only by a source scan matching the expression's exact text. Rewriting it as `new Set(pageIndex.entries.map((e) => e.slug))` slips past the negative assertion (which was keyed to the parameter name `entry`) while the positive one is satisfiable by the surviving comment — the whole suite stays green and the Files tab starts naming pages the Knowledge tab hides. The derivation is now `readableSlugsFromKnowledge()` in `workbench-tree`, executed by the node suite, with the scan reduced to pinning the call site — the same technique this story already used for `shouldDockPreview` and `isSameSelection`.
  - `[low]` `[patch]` `resolveRoot` read a FAILED silo listing as an empty silo and fell back to the shared flat tree. Both providers answer a missing prefix with an empty list, so a rejection there means unreadable — and answering a transient error by widening what the tab shows is the opposite of degrading. A failed silo read now keeps the silo selected and renders the empty branch the I/O matrix asks for; a genuinely absent silo still falls back.
  - `[low]` `[patch]` The CSS test's "carries the docked variants into both responsive blocks" sliced from `lastIndexOf(query)` to end of file, so for `@media (max-width: 1199px)` the slice also contained the 899px block — deleting the 1199px docked variant entirely would have left the assertion green. The slice is bounded at the next `@media`.
  - `[low]` `[patch]` Nothing executed the seeded-artifact presence check: every artifact case seeded BOTH files, so deleting the `present` filter and pushing `WIKI_ARTIFACT_FILES` unconditionally kept the suite green — and would have shown `purpose.md` / `schema.md` rows for files a half-completed `seedWikiArtifacts` never wrote. A case now seeds one artifact and asserts only that one is listed, plus a Wiki whose artifact directory does not exist claiming neither.
  - `[low]` `[patch]` The walk fixture's `openGate` helper was documented "Every slug readable, i.e. the filter lets the whole flat tree through" but builds a set of exactly the slugs named — so the bare `openGate()` most cases pass is a fully CLOSED gate. Name and doc inverted the behaviour; renamed to `gate()` and the doc corrected.
  - `[low]` `[patch]` "stops at the node cap and reports it" asserted only `paths.length <= 4`, which also passes for a walk that returned nothing — the one outcome a cap must never be confused with. It now also pins both roots present and at least one leaf listed.
  - `[low]` `[patch]` A whitespace-only page title produced a tree row that is a button with no content and a blank Preview header beside it. The slug backstops it in `toKnowledgePage`, so the row, the sort and the Preview agree from one place.
  - `[low]` `[patch]` A one-element `for (const dir of ["wiki"] as const)` loop left over from a two-root version of the gate test.

Note on routing: nothing reached `intent_gap` or `bad_spec`, and nothing new was deferred. Every patch this pass is durability rather than live misbehaviour — no reviewer found a case where the shipped column tells the owner something untrue — which is why none is above `low`. Rejected as re-finds of entries already in this spec's `deferred` list: `raw/` walked with no gate while `wiki/` is gated, including the sharper framing that the flat-root fallback is what exposes it (entry 3); the Preview printing `wiki/<slug>.md` for artifacts whose bytes live elsewhere (entry 2); two switchers and two create controls in one viewport (entry 4); and the dock being neither announced nor focus-moved nor scrolled into view, including the absence of a close control (entry 5). Rejected on the intent's own authority: the "listing failure degrades that subtree to empty" behaviour, which the I/O matrix specifies in as many words; `hasWiki` blanking both tabs when the registry is empty, likewise; the CSS tokens living in the first `.wb-shell` block (settled two passes ago, with the frozen parser re-verified); the tab switch as a fourth undock trigger; and the source-scan test surface itself, which the intent mandates by forbidding jsdom — and which this pass again narrowed by moving one more rule into executed code. Rejected as unreachable: the budget going negative and `wiki/` losing its root (needs `limit <= 2`; the shipped cap is 2000); `FILES_EMPTY_COPY` shown while truncated (both roots always render); the `<select>` gate diverging from the matrix's `currentId: null` predicate (`normalizeRegistry` falls `currentId` back to `wikis[0].id`, so wikis-without-a-current is not a state that reaches the component); and the ≤899px comment contradicting `overflow: hidden` (Story 1.3's own media block already sets `.wb-left { overflow: visible }` there — verified). Rejected as noise: the new controls missing `font-family` (Tailwind preflight is imported at `globals.css:1` and sets `font: inherit` on `button`/`select`); the Preview header scrolling away under a body Story 1.5 has not written yet; `EMPTY_DATA` defaulting its failure flags to false outside a provider that always wraps the shell; forced-colors for the selected row; the docked grid not honouring `--wb-split-min-chat` (the canvas keeps ~450px at the narrowest docked width); `queue.shift()` being O(n²) at a 2000-node cap; `wikiArtifactDir`'s unguarded `lastIndexOf("/")`; exhaustiveness for a third `TreeSelection` member that does not exist; arrow-key traversal of the `<select>` firing repeat writes (the `switching` guard drops all but the first, and the refresh converges); and `switching` clearing before `router.refresh()` settles.

### 2026-08-15 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 0
- reject: 24: (high 0, medium 3, low 21)
- addressed_findings:
  - `[medium]` `[patch]` The Files tab still named a page the Knowledge tab hides. The previous pass gated `wiki/` on the slug set `listReadableWikiPages` returned, but `buildKnowledgeTree` narrows that set further by dropping agent-scoped types, so an `agent-identity` page was absent from Knowledge and present by filename in Files — the exact disclosure `workbench-files.ts`'s READ GATE docstring claims to prevent, and a case its test never constructed. `page.tsx` now derives `readableSlugs` from the built Knowledge tree, and a new test in `workbench-tree.test.ts` executes the parity rather than grepping for it.
  - `[medium]` `[patch]` A failed page-index read was reported to the owner as an empty `wiki/`. The walk's gate is that index, so an empty slug set filtered every page out of the wiki root while `filesUnavailable` stayed false — the Knowledge tab correctly said the read failed and the Files tab beside it showed an empty silo. `filesUnavailable` now carries `pageIndex.unavailable`, because a failed gate is a failed listing.
  - `[low]` `[patch]` Three failure states shared one sentence. "Your wikis couldn’t be loaded." was shown when the page index or the file walk failed, contradicting the switcher above it, which was at that moment listing those wikis. Two new constants name the read that actually failed.
  - `[low]` `[patch]` Every collapsed disclosure pointed `aria-controls` at an element it does not render — a dangling IDREF, which assistive tech reports as a broken relationship rather than a closed one. The attribute is now set only while open, matching the idiom the tablist in the same file already uses.
  - `[low]` `[patch]` Disclosure ids were built from a free-form page `type` and from raw file paths. `aria-controls` is an IDREF *list*, so one space in a page type or a filename split the value into two references that resolve to nothing, and a literal `type: untyped` collided with the untyped group's own fallback id. Ids are positional now, chained through the parent list's id so they stay unique across sibling subtrees at equal depth.
  - `[low]` `[patch]` The Preview header could render blank: `path.split("/").at(-1)` is the empty string for a trailing separator, and the `??` fallback beside it only catches nullish.
  - `[low]` `[patch]` `send()` spread the caller's `init` last, so any future call passing `headers` or `signal` would silently lose both the JSON content type and the 15-second deadline the comment above it promises. `init` is spread first and the two invariants are applied over it.
  - `[low]` `[patch]` Tree labels and the Preview name ellipsize at 280px with no horizontal scroll, so a long page title or filename was unreadable with no way to recover it. Rows carry a `title` — the page title on Knowledge rows, the full storage path on file rows.

Note on routing: nothing reached `intent_gap` or `bad_spec`, and nothing new was deferred. The two medium findings are both narrowings of a gate this story built, fixable in two lines at the one call site that derives it, so re-deriving the implementation would have bought nothing a patch did not. Rejected as re-finds of entries already in this spec's `deferred` list: `raw/` filenames unfiltered and the flat-root fallback surfacing sources whose pages the gate excludes (entry 3 — filtering them still needs a source→page mapping the walk has no access to); the Preview printing a path that does not address the bytes (entry 2); the two-switcher duplication (entry 4); and the dock being neither announced nor scrolled into view at narrow widths, including the absence of a close control (entry 5). Rejected on the intent's own authority or as already-settled: the second `.wb-shell` block and the `.wb-left` `overflow: hidden` (both resolved in the previous pass, the first with the frozen parser re-verified); the fourth undock trigger — a tab switch — which the intent lists three of but whose alternative is a docked Preview for a row the owner can no longer see; `New Wiki` suppressed when the registry read failed, which the I/O matrix does not require and which would invite a duplicate against a registry nobody could read; and the source-scan test surface, which the intent mandates in as many words ("Do not add jsdom, `@testing-library/*`, or `.test.tsx` support") and which this pass again narrowed by moving one more rule into executed code. Rejected as noise: the per-root budget starving `wiki/` (reachable only at `limit ≤ 2`; the shipped cap is 2000); `buildFileTree` mis-typing a path emitted both as leaf and as directory (the walker emits neither shape twice); the `.MD`/`.txt` bypass in the wiki gate (the kernel writes `wiki/<slug>.md` and nothing else); no forced-colors rule for the selected row (`font-weight` is not discarded in forced-colors, and the selected row is the only bold non-group row); the focused `<select>` losing focus while disabled for the length of a bounded request; a `pendingId` flicker when a second switch overtakes the first refresh (self-correcting, single operator); `EMPTY_DATA` claiming an available registry outside a provider that always wraps the shell; the `Left column trees` tablist `aria-label` being absent from the Copy table (an AT-only name, not a rendered sentence); the injectable `limit`/`maxDepth` test seam; the empty directory rendering as a `<span>` (deliberate, previous pass); and `TREE_UNAVAILABLE_COPY` drifting from `WikiWorkbench`'s own literal, which cannot import the constant without editing a file whose occurrence counts a frozen test asserts.

### 2026-08-15 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 23: (high 0, medium 5, low 18)
- defer: 2: (high 0, medium 0, low 2)
- reject: 14: (high 0, medium 3, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The Files tab bypassed the read gate the Knowledge tab enforces. `listWorkbenchFilePaths` walked the flat `wikiRelPath("")` / `rawRelPath("")` with no authz filter while Knowledge went through `listReadableWikiPages(principal)`, so a page that tab excludes — an agent-scoped page, or another owner's private page in the legacy flat tree — still had its filename listed in Files. That is the one thing the intent's third AC forbids, and the **Always** list bans it in as many words. Fixed on both axes: the owner's tenant silo is now tried first (`src/lib/silo.ts` documents it as PRIMARY and the flat tree as a transitional copy), and in either branch a `.md` leaf under the wiki root is listed only when its slug is in the set `listReadableWikiPages` returned — passed as a required option, so "no filter" is unspellable.
  - `[medium]` `[patch]` A failed page-index or file read was reported to the owner as "you have nothing". Both loads caught and degraded to empty, after which the Knowledge tab said `No pages yet. Ingest a source to compile one.` — advice premised on a fact the server did not have, and the exact mistake the registry's own `unavailable` flag exists to prevent. `WorkbenchData` now carries `knowledgeUnavailable` / `filesUnavailable` and the affected tab says the read failed.
  - `[medium]` `[patch]` `WikiSwitcher` never cleared its optimistic `pendingId`, so after a header switch followed by a switch from Story 1.2's canvas card the header `<select>` kept naming the previous Wiki — and re-selecting the displayed option fires no change event, so the two controls stayed disagreeing until a reload. It also seeded `pendingId` on create, when the new id is not yet in `wikis` and matches no option.
  - `[medium]` `[patch]` The new test's `afterEach` ran `fs.rm(getDataDir()/tenants, { recursive: true, force: true })`. `vitest.setup.ts` only defaults `DATA_DIR` when it is unset, so with `DATA_DIR` pointed at real data the suite deleted it, and within a worker it could delete tenant state an earlier test file wrote. The fixture owns its own `DATA_DIR` now and removes only its temp root.
  - `[medium]` `[patch]` The story's headline behaviour — select a row, the Preview docks — was pinned only by source-text greps; inverting the condition to `selection === null` left the whole suite green. The decision is a pure exported `shouldDockPreview(mode, selection)` now, executed by the node suite across every mode rather than asserted as a string.
  - `[low]` `[patch]` Two layout tokens were declared in a second `.wb-shell` block whose comment explained that it existed because `workbench-chrome.test.ts` parses only the first one. That check only requires every property `.dark` overrides to be present and equal, so extra properties were always fine and the second block bought nothing but the appearance of dodging a test. Both tokens moved into the one block; the scan now pins that `.wb-shell {` appears exactly once.
  - `[low]` `[patch]` Eight defects in the tree itself: a selection surviving a tab switch with nothing carrying `aria-current`; no way to undock short of leaving Wiki mode; a whitespace-only `type` producing a second group also labelled `Pages`; a path arriving as both leaf and parent staying an unexpandable leaf; a `raw/` larger than the node cap starving `wiki/` to nothing, which reads as a missing silo rather than as truncation; an unrecognised tab id falling through to the file tree; a childless directory rendering a chevron over silence; and `.wb-tree-row` at ~23px, under the target-size floor its own neighbours clear.
  - `[low]` `[patch]` Three accuracy fixes where the code and its own account of itself disagreed: `aria-controls` on both tabs for one panel and none on the group disclosures; a docstring arguing the seeded artifacts sort first when directory-first ordering puts them last; and `TREE_UNAVAILABLE_COPY` claiming to be the same sentence `WikiWorkbench` shows when that file's is longer.
  - `[low]` `[patch]` Four durability and hygiene fixes: the truncation sentence's numeral derived from `WORKBENCH_FILE_LIMIT` instead of typed; the registry and page-index reads run concurrently; the unused `selectionKey` export replaced by the `isSameSelection` the deselect path needed; and tests added for the dotfile skip and the artifact-directory throw path.
  - `[low]` `[patch]` A `PUT` that never settled left `switching` true for the session with the switcher permanently disabled. Both requests carry a timeout, and the flag resets on every exit path.
  - `[low]` `[patch]` Two presentation nits: a docblock ending mid-sentence, and the Preview strip printing `title:` directly beneath the same string in its own header.

Note on routing: nothing reached `intent_gap` or `bad_spec`. The two findings that came closest were the Files tab's missing read gate and the flat-tree walk — both trace to an **Always** clause naming `rawRelPath("")` / `wikiRelPath("")` as the walk roots, which sits inside the read-only intent contract beside the authz clause it contradicts. They were resolved as patches rather than as a contract problem because the contract does select between them: the third AC ("I cannot see another owner's Wiki") and the authz **Always** are explicit, and the path clause's own stated purpose — that the trees and the page index agree — is better served by the silo-first resolution `readWikiPage` already uses than by the constants. Both changes are recorded in the Spec Change Log. Deferred: `raw/` filenames are still unfiltered (filtering them needs a source→page mapping the walk has no access to — one raw file can back several pages and an orphan backs none, so it belongs with Epic 2), and the Preview dock is neither announced nor scrolled into view at narrow widths (what to announce depends on what Story 1.5 puts in the column, and where it goes below 900px is Story 1.6's layout question). Rejected on the intent's own authority: the two-switcher duplication and the title-as-switcher reading of UX-DR5 (already an entry in this spec's `deferred` list — the frozen occurrence counts in `create-wiki-ui.test.ts` are what forbid the relocation); the `PreviewColumn` page path and the lossy `TreeSelection` (re-finds of `deferred` entry 2); `hasWiki` blanking both tabs when the registry is empty (the I/O matrix fixes that behaviour, and "No wiki yet." plus Create Wiki is the epic's own onboarding state); and that the `Open project folder` criterion was already true before the diff, which makes the scan a guard rather than a removal — which is what the AC asks for. Rejected as noise: the truncation sentence naming the node cap when the depth cap fired (`wiki/` and `raw/` are flat by convention, so depth 3 is not reachable, and "the file list is truncated" stays true either way); `FILES_EMPTY_COPY` being unreachable now that the roots always render; group disclosure state not persisting across a mode switch (Story 1.6 owns durable tree state); tab persistence living in the new test file rather than `workbench-state.test.ts` (that file is frozen); `KnowledgeGroup.count` duplicating `pages.length`; `KnowledgePage` dropping `summary` and `expiry` (Story 1.5 decides what the Preview body reads); the switcher rendering in every mode while the trees are Wiki-only (the header is mode-independent chrome and the active Wiki scopes every mode); two switchers racing on one endpoint (single operator, and the loser is corrected by the next refresh); the left column clipping if its header ever outgrew the column; and the absence of `sprint-status.yaml` and `deferred-work.md` from the change set, both of which the orchestrator owns.

## Design Notes

**Copy (character-exact; do not paraphrase).**

| Where | String | Source |
|---|---|---|
| Tab labels | `Knowledge`, `Files` | `DESIGN.md:259`, `mockups/todos.html:183` |
| Switcher label (visually hidden) | `Active wiki` | `WikiWorkbench.tsx` precedent |
| Create control | `New Wiki` | UX-DR5 (`epics.md:157`), `EXPERIENCE.md:91` |
| Preview header | `Preview` | `mockups/chat-cited.html:196` |
| No Wiki exists (either tab) | `No wiki yet.` | `mockups/create-wiki.html:119` |
| Registry read failed | `Your wikis couldn’t be loaded.` | `WikiWorkbench.tsx:163-171` (same state, same sentence) |
| Page-index read failed | `Your pages couldn’t be loaded.` | authored, UX-DR23 voice (the registry sentence would be false here) |
| File walk read failed | `Your files couldn’t be loaded.` | authored, UX-DR23 voice |
| Knowledge tab empty | `No pages yet. Ingest a source to compile one.` | authored, UX-DR23 voice |
| Files tab empty | `No files yet.` | authored, UX-DR23 voice |
| Files truncated | `File list truncated at 2,000 entries.` | authored, UX-DR23 voice |
| Untyped Knowledge group | `Pages` | authored |

**What "that Wiki's files" means here.** The AC says switching Wikis makes the trees show that Wiki's files, but Pages and Sources are not partitioned per Wiki — `src/lib/wikis.ts:16-17` says so explicitly, and `deferred-work.md` DW-17 already records the migration as owed. So the per-Wiki part of the tree is what is per-Wiki on disk today: `purpose.md` and `schema.md` under `tenants/<t>/wikis/<id>/`, which change on every switch. `wiki/` and `raw/` are the single owner's one silo and are the same under either Wiki. This is a browse story; repartitioning the kernel's storage is not in its acceptance criteria and would touch ingest, index, silo, graph and MCP. Record the residual gap as a deferred entry rather than closing it here.

**Why Knowledge and Files are shaped differently.** `imports/15-knowledge-tree.png` shows the Knowledge tab "grouped by type with counts", while `mockups/todos.html:186-201` shows the Files tab as `raw/` and `wiki/` containers. That is the real distinction the PRD draws (`prd.md:98-99`): Knowledge browses Pages *by wiki structure*, Files browses the Wiki's *files*. The mockup's `meetings`/`concepts`/`entities` subfolders under `wiki/` do not exist in this codebase — pages are stored flat as `wiki/<slug>.md` — so they are not invented into the Files tree; that semantic grouping is exactly what the Knowledge tab provides instead.

**Where the Preview seam falls.** UX-DR2 already splits Preview in two: header and frontmatter in system sans, body and headings in Georgia. `mockups/chat-cited.html:194-208` has the same three parts — `header`, `.fm`, `.body`. This story ships `header` and `.fm` (it has the metadata already, from the page index and the file path) and leaves `.body` to Story 1.5, which owns GFM, wikilinks and the serif. That way "selecting a file docks the Preview column" is observably true without this story rendering a line of markdown or inventing placeholder copy that 1.5 would delete.

**Why a native `<select>` and not a popover.** There is no DOM test environment (DW-15, DW-24), so a hand-rolled listbox's focus management, Esc handling and outside-click dismissal would ship entirely unverified. A `<select>` gets all of that from the platform, matches the idiom already in `WikiWorkbench.tsx`, and leaves the `<h1 className="wb-title">{APP_NAME}</h1>` literal — which `workbench-chrome.test.ts` pins verbatim — untouched. The header therefore *carries* the switcher rather than the title *being* the switcher; that is the closest reading of UX-DR5 available without editing a frozen assertion.

**Why the tree is a nested list, not `role="tree"`.** A real ARIA tree needs roving `tabindex` and arrow-key navigation, none of which can be verified in a node-only suite. Nested `<ul>` with native `<button>` rows, `aria-expanded` disclosures and `aria-current="true"` on the selection is a complete keyboard surface with no unverifiable focus machinery.

**Why `page.tsx` gets a `key`.** `WikiWorkbench` seeds `useState` from `initialWikis`/`initialCurrentId`, so a `router.refresh()` triggered by the *header* switcher would leave its canvas card naming the previous Wiki. Keying the element on `currentId` remounts it with the fresh props. One line, and it avoids the alternative — lifting registry state into a context that `WikiWorkbench` consumes, which cannot be done without moving code whose in-file occurrence counts a frozen test asserts.

## Verification

**Commands:**
- `npx vitest run` -- expected: the full suite green (199 files, 3850 tests at baseline) plus the two new files; no pre-existing test file modified.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors.
- `npx vitest run src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/single-ia.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/links.test.ts` -- expected: green unchanged.
- `git diff --stat -- src/components/WikiWorkbench.tsx src/lib/__tests__` -- expected: empty.
- `grep -rn "Open project folder" src` -- expected: no match.
- `grep -rn "Georgia\|serif" src/components/workbench` -- expected: no match.
- `grep -rn "useRouter\|router.push\|next/link" src/components/workbench/Workbench.tsx` -- expected: no match.
- `git diff --numstat -- src/app/globals.css` -- expected: deletions confined to the `.wb-left` rule; `:root`, `.dark` and `@theme inline` unchanged.

**Manual checks (if no CLI):**
- Inspect the appended `globals.css` for a second `.wb-shell {` block after the chrome rules, and confirm the first one is unedited.
- Inspect `src/app/page.tsx` for the authenticated `principal` flowing into both new loads — no hard-coded owner, tenant or handle.


## Auto Run Result

Status: done

**Summary.** Second follow-up review pass over the Story 1.4 diff (baseline `e8ab073c3e19023eafeaf99d6311d5161d4cba35`). No feature work: the left column, both trees, the header switcher and the docking Preview all ship as the previous passes left them. This pass found no case where the shipped column tells the owner something untrue. What it did close was eight durability defects — two in the code, six in the tests that are supposed to hold the code — the largest being that the story's privacy rule, at its `page.tsx` layer, was enforced by a string match that an equivalent rewrite walks straight past.

**Files changed in this pass** (the full story change set is the 15 files in the diff since the baseline):
- `src/lib/workbench-tree.ts` — new exported `readableSlugsFromKnowledge()`; a blank or whitespace-only page title now falls back to the slug.
- `src/app/page.tsx` — calls that function instead of deriving the gate inline.
- `src/lib/workbench-files.ts` — `listSafely` reports whether a listing failed; `resolveRoot` no longer reads a failed silo read as an empty silo.
- `src/lib/__tests__/workbench-tree.test.ts` — executes the gate derivation and the title fallback; new cases for partial/absent seeded artifacts and for the failed-silo path; `openGate` renamed to `gate` with its inverted doc corrected; the node-cap assertion tightened; a leftover one-element loop removed.
- `src/lib/__tests__/workbench-left-column.test.ts` — the responsive-block assertion bounded at the next `@media`; the `page.tsx` scan retargeted to the call site.
- `_bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md` — one Spec Change Log entry and this pass's triage log.

**Review findings breakdown.** 8 patches applied (0 high, 0 medium, 8 low); 0 items deferred — every genuinely pre-existing finding surfaced was already an entry in this spec's `deferred` list; 27 rejected. No finding routed to `intent_gap` or `bad_spec`, so no loopback ran and `review_loop_iteration` stayed 0.

**Follow-up review recommendation:** `true`. Patched this pass: high 0, medium 0, low 8 → score `3×0 + 1×8 = 8`, at or above the threshold of 5. It is worth reading that number with its content: eight low findings of which six are test hygiene is a weaker signal than the previous pass's two mediums in the read gate, and the yield per pass is now clearly falling.

**Verification performed.**
- `npx vitest run` — 201 files, 3914 tests, all passing (the previous pass ended at 3910; this pass added four cases).
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0 (the three `jsx-ast-utils` notices are pre-existing informational output, not diagnostics).
- `git diff --stat e8ab073 -- src/components/WikiWorkbench.tsx src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/single-ia.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/links.test.ts` — empty; no frozen file was touched in any of the three passes.
- `grep -rn "Open project folder" src` — matches only inside the scanner that bans it. `grep -rn "Georgia\|serif" src/components/workbench` — no match. `grep -rn "useRouter\|router.push\|next/link" src/components/workbench/Workbench.tsx` — one comment, no code.
- `git diff --numstat e8ab073 -- src/app/globals.css` — `283 1`, unchanged by this pass; the single deletion is still the `.wb-left` `overflow` line.

**Residual risks.**
- Unchanged and structural: every component-level rule in this story is verified by source scan, not by rendering, because the intent forbids adding a DOM environment (DW-24 owns that). Four rules have now been lifted into executed functions (`shouldDockPreview`, `isSameSelection`, the Knowledge/Files gate parity, and now the gate derivation itself), but the tablist semantics, the tab restore and the dock wiring remain pinned by wording. A refactor that preserves the matched strings while changing the wiring would still pass.
- The five `deferred` entries in this spec's frontmatter are unchanged and remain open. Three reviewers independently re-found the `raw/` gate gap (entry 3) this pass, two of them arguing the flat-root fallback is the sharper end of it — worth weighting when Epic 2 gives Sources a read model.
- `resolveRoot` now holds an unreadable silo rather than falling back, which is the correct reading of a failed read but means a broken silo shows an empty `wiki/` where the flat tree might still have had content. The tree cannot say which of those it is; the Files tab's failure sentence only fires when the whole walk throws.
