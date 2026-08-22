---
title: 'Story 1.5: View-first Preview with GFM and wikilinks'
type: 'feature'
created: '2026-08-15'
status: 'done'
baseline_revision: 'a671f56a42621d8de603b40c03fc7abb168219e8'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Changing the tree selection while the confirm-gated editor is open
      discards the owner's unsaved markdown with no warning.
    evidence: |-
      The fetch effect calls `setEditing(false)` unconditionally on every
      `selection` change, and Cancel discards without a prompt. The story went
      to real lengths to guarantee the opposite for the failure it owns — a
      rejected save keeps the text — but the likelier loss path, one stray
      click on a tree row, has no dirty check at all. Guarding it means
      intercepting a selection change the SHELL owns, not the Preview:
      `selection` lives in `Workbench.tsx:86` and its reset effect's deps
      (`[mode, currentWikiId, treeTab]`) are pinned verbatim by
      `workbench-left-column.test.ts:86-88`, so a pending-selection handshake
      would have to be threaded through the component that cannot grow that
      dependency. The intent asks for a confirm before EDITING, not before
      leaving; deciding what a second gate looks like belongs with Story 1.6,
      which owns durable selection, or with whichever story gives the editor a
      lifecycle of its own.
    location: >-
      src/components/workbench/PreviewColumn.tsx,
      src/components/workbench/Workbench.tsx
    severity: medium
  - summary: >-
      `PUT /api/wiki/[slug]` has no `isReadOnly()` gate, and this story's
      `Edit` affordance is the first surface to offer it to a human.
    evidence: |-
      Every other mutating route consults `isReadOnly()` and answers 403 —
      `api/wikis/route.ts`, `api/wikis/current`, `api/wikis/[id]/template`,
      `api/workspace-profile`. The page write route never has. On a read-only
      deployment the Preview therefore offers `Edit`, opens the dialog, and the
      save SUCCEEDS, because gating `editable` in the preview route would only
      hide a door that is still unlocked. The fix belongs at the write route,
      where it also covers the MCP and agent callers, not at the affordance
      that happens to have surfaced it.
    location: >-
      src/app/api/wiki/[slug]/route.ts
    severity: low
  - summary: >-
      The page write path has no lost-update guard, so a save can silently
      overwrite a page rewritten since the Preview read it.
    evidence: |-
      `savePreviewBody` PUTs `{ content }` with no `updated`, ETag or
      `If-Match`, and `writeWikiPageWithSideEffects` takes it. The storage
      provider already exposes `readFileWithEtag` and `writeFileIfMatch`
      (`src/lib/storage/types.ts:196,205`) and nothing in the kernel write path
      uses them. Not reachable in Epic 1 — one operator, no ingest — but Epic 2
      gives the same pages a second writer, and Epic 8's loopback API a third,
      so whichever of those lands first is where the guard has a real reason to
      exist rather than a hypothetical one.
    location: >-
      src/lib/lifecycle.ts, src/app/api/wiki/[slug]/route.ts
    severity: low
  - summary: >-
      Story 1.2's canvas card keeps saying `Select a file to preview.` while a
      Preview column is docked beside it showing exactly that file.
    evidence: |-
      The sentence is an unconditional element of `WikiWorkbench.tsx:254`,
      rendered on the Wiki canvas at every moment, and this story's first
      acceptance criterion is satisfied by not disturbing it. Once the fourth
      column docks, one viewport carries a rendered page and a sentence saying
      nothing is selected. Retiring or conditioning that sentence means editing
      a file whose in-file occurrence counts `create-wiki-ui.test.ts:118-209`
      asserts — the same freeze that produced `spec-1-4` deferred entry 4, and
      the same owner: whichever story rebuilds the Wiki canvas.
    location: >-
      src/components/WikiWorkbench.tsx:254
    severity: low
  - summary: >-
      A read under `raw/` inherits `resolveRoot`'s fallback to the SHARED flat
      root, so an owner whose raw silo is empty reads the legacy tree's bytes.
    evidence: |-
      `resolveWorkbenchFile` gates only `root === "wiki"`; `raw/…` goes straight
      to `resolveRoot(silo, flat)`, which falls back to the shared `RAW_DIR`
      when the caller's silo lists empty. That is not a deviation — the intent
      ties the file gate to what `listWorkbenchFilePaths` would emit, and the
      listing walks `raw/` with `allowEveryLeaf` through the same `resolveRoot`
      — so read and listing agree exactly, as required. What changed is the
      stakes: Story 1.4 disclosed those FILENAMES, and this story serves their
      contents. Narrowing it here is not available: the intent requires
      `resolveRoot` to have "exactly one definition", and a read gate narrower
      than the listing would show rows that refuse to open (the sibling entry
      below). The real fix is retiring the flat root, or giving `raw/` a
      per-owner gate — both belong with whichever story completes the silo
      migration, since `src/lib/silo.ts` already calls the flat tree
      transitional.
    location: >-
      src/lib/workbench-files.ts (resolveWorkbenchFile, resolveRoot)
    severity: medium
  - summary: >-
      `editable` is every page the READ gate admits, but the write ACL is
      narrower, so a readable-but-unwritable page offers `Edit` and fails at
      Save.
    evidence: |-
      The route sets `editable: true` for any slug in
      `readableSlugsFromKnowledge(...)`, which is `canReadPage`'s set —
      everything not `private`. `canWritePage` (`src/lib/authz.ts:190-197`)
      refuses `writeKind: "body"` for a page where `belongsInCommons(meta)`
      holds, to any principal that is not the service principal or an admin. So
      the read set is strictly larger than the body-write set, and for such a
      principal the Preview shows `Edit`, opens the dialog, seeds the editor and
      only then relays the write route's 403. Not reachable in Epic 1 — the one
      operator is an admin through `isOwnerHandle` — and narrowing it is not
      this story's call either: the intent defines `editable` as "a compiled
      Page is the one thing this story makes editable", with no clause about
      write ACLs. Deriving the affordance from `canWritePage` belongs with
      whichever story introduces a second principal.
    location: >-
      src/app/api/workbench/preview/route.ts
    severity: low
  - summary: >-
      The Files tab lists `wiki/` leaves that are not pages, and the Preview now
      answers every one of them with `This file couldn’t be loaded.`
    evidence: |-
      `wikiLeafFilter` passes every name not ending in `.md`, so `wiki/notes.txt`
      and `wiki/dump.json` are rows the owner can see and click. The read gate
      `readableWikiLeaf` refuses them — deliberately, and for a reason the
      previous review pass recorded at length ("two filters, two reasons — do
      not re-unify them"), because `resolveRoot`'s flat fallback means those
      bytes need not be the caller's. The consequence is a visible row that
      cannot open, which reads as a broken Preview rather than as a gate. The
      coherent fix is at the LISTING — stop showing a leaf the Preview will
      refuse — which means editing the filter the previous pass froze on
      security grounds and re-deciding what the Files tab is for. That is a
      Story 1.4 surface decision, not a patch to this story's reader.
    location: >-
      src/lib/workbench-files.ts (wikiLeafFilter vs readableWikiLeaf)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Story 1.4 docked the Preview column but shipped only its header and frontmatter strip — `PreviewColumn.tsx:72-82` renders `.wb-preview-head` and `.wb-preview-fm` and stops, and `workbench-left-column.test.ts:246-256` freezes that absence in place ("nothing of Story 1.5's"). Selecting a page shows its name and its path and not one byte of its content, so the owner still cannot read a compiled Page in the Workbench. Nothing in the shell can fetch a file's bytes at all: `spec-1-4`'s deferred entry 2 records that the path the strip prints is not the path that addresses the bytes.

**Approach:** Fill `.body`. A new authenticated read route returns the markdown behind a selection, gated by exactly the set the trees are gated by, and resolving a displayed path back to the storage key that holds it. The column renders that markdown as GFM through `react-markdown` + `remark-gfm` with a wikilink pass, in Georgia, with bordered tables; a resolved `[[wikilink]]` re-selects that page inside the shell and an unresolved one renders as a visible missing-link state. Editing stays an escape hatch: an `Edit` control opens `ConfirmDialog`, and only after confirm does the body swap to a raw-markdown `<textarea>` that saves through the existing `PUT /api/wiki/[slug]`, i.e. through `writeWikiPageWithSideEffects`.

## Boundaries & Constraints

**Always:**
- The Preview body renders only for a docked selection. When nothing is picked the column does not exist (`shouldDockPreview`), and the "no selection" sentence stays where Story 1.2 already put it — `WikiWorkbench.tsx:254`, `Select a file to preview.`, frozen by `create-wiki-ui.test.ts:128`. This story does not move, duplicate or re-author that sentence; its first acceptance criterion is a guard, not a change (`mockups/create-wiki.html:121` puts it on the canvas).
- Every byte the Preview shows passes the same gate the trees pass. Pages: the slug must be in `readableSlugsFromKnowledge(buildKnowledgeTree(await listReadableWikiPages(principal)))` — the identical derivation `page.tsx` uses — before any read. Files: the display path must be one `listWorkbenchFilePaths` would emit for the same owner, wiki and slug set. Anything else is `404` with a non-committal body, never `403` and never a distinguishable message (the existence-oracle rule `api/raw/[slug]/route.ts:40-45` already follows).
- Display path → storage key resolution lives in `workbench-files.ts` and reuses `resolveRoot` so silo-first resolution has exactly one definition. `purpose.md` / `schema.md` resolve through `readWikiArtifact(owner, wikiId, file)`; `wiki/<name>.md` and `raw/…` resolve under the root `resolveRoot` picked. Reject any path with an empty, `.` or `..` segment, a backslash, or a leading `/` before touching storage.
- Body markdown is served frontmatter-free. The YAML block is stripped server-side by one pure exported helper, and the same stripped string is what the editor edits and what `PUT /api/wiki/[slug]` receives — that route documents `content` as "the new markdown **body** (no YAML frontmatter)" (`api/wiki/[slug]/route.ts:67-69`) and owns frontmatter end-to-end.
- The renderer is `react-markdown` with `remark-gfm` and the wikilink plugin, and nothing else. Tables render bordered. Images go through the app's existing `urlTransform` policy, which moves to a shared module and is re-exported from `MarkdownRenderer.tsx` so `markdown-url-transform.test.ts` keeps importing it from where it does.
- `[[target]]` and `[[target|label]]` are the two accepted forms — target first, label second, matching what `export.ts:23-26` emits. Resolution is `slugify(target)` against the client's readable slug set. A resolved link is a `<button>` that changes the shell's selection; an unresolved one renders as non-interactive text carrying a visually-hidden `(missing page)` and a distinct class. Wikilinks inside fenced or inline code are not links — the transform runs over mdast `text` nodes, which is why code is structurally out of reach.
- The confirm gate is `ConfirmDialog` (`ConfirmDialog.tsx:14-15` reserves it for exactly this story and 1.8): Cancel and Esc both leave view-first with nothing written, Confirm swaps the body to a `<textarea>` seeded with the same markdown, and Save `PUT`s it. Both requests carry a timeout and reset their busy flag on every exit path, the way `WikiSwitcher.tsx` already does. Failure is an inline `role="alert"` that keeps the owner's text.
- `Georgia` appears in exactly one place in the repo: a `--wb-font-read` token declared inside the single `.wb-shell { … }` block in `globals.css`. It is applied only by `.wb-preview-body` rules. `workbench-chrome.test.ts:418` bans the literal in every rule after that block and `:293-298` bans it in every file directly under `src/components/workbench`; both stay untouched and green. Update the Story 1.3 comment at `globals.css:2824-2825` to say the token is declared here and applied only there.
- Every user-visible string added here is listed in **Design Notes → Copy** and used character-exact.
- `src/components/WikiWorkbench.tsx`, `src/lib/__tests__/create-wiki-ui.test.ts`, `src/lib/__tests__/workbench-chrome.test.ts` and `src/lib/__tests__/markdown-url-transform.test.ts` are not edited. The only pre-existing test this story may touch is `workbench-left-column.test.ts`, and only its `PreviewColumn`-scoped block plus the one clause of its header docblock that describes that block — retargeted to this story's contract, never deleted or weakened.
- `globals.css` adds no second top-level `.wb-shell {` block (`workbench-left-column.test.ts:325`) and no new `@media (max-width: 1199px)` / `(max-width: 899px)` block: the responsive Preview rules extend the existing dock blocks at `:3541-3556` and `:3560-3576`, because `:341-353` reads the LAST block matching each query.

**Block If:**
- Satisfying "renders `[[wikilinks]]`" appears to require a new runtime dependency, an mdast/unist utility package, or a DOM test environment.
- The confirm-gated save appears to require a second markdown write path, a change to `writeWikiPageWithSideEffects`, or editing a frozen file listed under **Always**.

**Never:**
- Do not render Mermaid or KaTeX, and do not import `rehype-katex`, `remark-math`, `@/components/Mermaid` or `@/components/MarkdownRenderer` into any workbench component — Epic 7 Story 7.8 owns them, and `MarkdownRenderer` wires KaTeX unconditionally (`MarkdownRenderer.tsx:6,151-152`).
- Do not ship a WYSIWYG, a rich-text toolbar, an editor library, autosave, or an edit path that skips the confirm dialog. Do not expose the YAML frontmatter block to the owner in either the body or the editor.
- Do not make `purpose.md`, `schema.md` or anything under `raw/` editable — Schema editing is Story 1.8, Sources are Epic 2. Do not add page create or delete.
- Do not navigate. No `next/link`, `router.push` or `<a href>` to `/u/…` from the Preview; a wikilink changes selection inside the shell. `useRouter`/`router.push`/`next/link` remain banned in `Workbench.tsx` (`workbench-chrome.test.ts:130-135`); `router.refresh()` after a save belongs in the Preview's own file.
- Do not add a dep to the selection-reset effect in `Workbench.tsx:117-119` — `workbench-left-column.test.ts:86-88` pins `[mode, currentWikiId, treeTab]` verbatim, and a wikilink jump must not clear the selection it just made.
- Do not build drag-resize (Story 1.6), `dataVersion` refresh (Story 1.7), or announce/scroll the dock (`spec-1-4` deferred entry 5).
- Do not add jsdom, `@testing-library/*` or `.test.tsx` support; `vitest.config.ts` stays `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]`.
- Do not write `WorkWiki` or a bare `yopedia` outside the `yopedia_…` key form (`brand-copy.test.ts:123-141`), and do not import `@/lib/retired` from the new route (`retired-surfaces.test.ts:118-123` derives its list from that import).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Wikilink plain | text `see [[alpha]] now` | one link run, target `alpha`, label `alpha` | No error expected |
| Wikilink aliased | `[[alpha-beta\|Alpha Beta]]` | target `alpha-beta`, label `Alpha Beta` | No error expected |
| Wikilink in code | mdast `inlineCode`/`code` node containing `[[a]]` | node unchanged, no link produced | No error expected |
| Wikilink inside a link | a `text` node whose ancestor is a `link` | left as text — no nested anchors | No error expected |
| Wikilink malformed | `[[]]`, `[[ \| x ]]`, `[[a` | no link produced; text preserved verbatim | No error expected |
| Wikilink resolution | target `Alpha Beta`, slug set has `alpha-beta` | resolved → slug `alpha-beta` | No error expected |
| Wikilink missing | target `ghost`, not in the set | unresolved → missing-link state | No error expected |
| Frontmatter strip | `---\nx: 1\n---\n# T` | `# T` | No error expected |
| Frontmatter absent / unterminated | body starting `# T`; body starting `---\nx: 1` with no close | returned unchanged | Never throws |
| Preview file kind | `a.md`, `a.txt`, `a.pdf`, `a` | `markdown`, `text`, `unsupported`, `unsupported` | No error expected |
| Path validation | `wiki/../secrets.md`, `/etc/x`, `a\\b`, `wiki//a.md` | rejected before any storage call | Read returns null → 404 |
| File read gate | `wiki/hidden.md` whose slug is absent from the set | rejected | 404, same body as a missing path |
| Artifact read | `purpose.md` with a current wiki | resolved via `readWikiArtifact` | Missing artifact → 404 |
| Artifact without a wiki | `purpose.md`, `currentWikiId` null | rejected | 404 |
| Silo-first read | silo listing non-empty | bytes read under the silo prefix | Failed silo listing → no flat fallback, 404 |
| Oversized body | content longer than the cap | body sliced to the cap, `truncated: true` | No error expected |
| Empty file | zero-length content | empty state sentence, no editor error | No error expected |
| Unauthenticated route call | no principal | `401 { error }` | No page read attempted |
| Selection changes mid-fetch | second pick before the first resolves | the stale response is discarded | Abort, no state write |
| Save rejected | `PUT` returns 403/404/500 | inline `role="alert"`, editor stays open with the text | Busy flag reset |

</intent-contract>

## Code Map

**Extend (this story edits these existing files and no other existing source):**
- `src/components/workbench/PreviewColumn.tsx` — currently header + `.wb-preview-fm` only (`:34-70`, `Frame` at `:72-82`). Add: the fetch effect keyed on `selection` with an `AbortController`, the four body states, the `Edit` control in `.wb-preview-head`, `ConfirmDialog`, the editor textarea, the save call, `router.refresh()`. New props `onOpenPage` and (for wikilink resolution) nothing else — the readable slug set is derived from the `knowledge` prop it already receives.
- `src/components/workbench/Workbench.tsx:86` (`selection` state), `:117-119` (reset effect — deps frozen), `:167-169` (`selectRow`), `:342-344` (`<PreviewColumn …>`). Add one non-toggling `openPage` callback (distinct from `selectRow`, whose `isSameSelection(current, next) ? null : next` is pinned at `workbench-left-column.test.ts:90`) and pass it down. No new imports of `next/link`/`useRouter`.
- `src/lib/workbench-files.ts` — add the single-file read beside the walk, reusing `resolveRoot` (`:143-154`), `wikiLeafFilter` (`:207-214`), `wikiArtifactDir` (`:97-100`) and `listSafely` (`:110-119`). `WorkbenchFileOptions.readableSlugs` (`:59-68`) is the same required gate.
- `src/lib/workbench-tree.ts` — add the wikilink-selection helper next to `isSameSelection` (`:132`) / `shouldDockPreview` (`:150`); reuse `findFileNode` (`:326`) and `readableSlugsFromKnowledge` (`:350`).
- `src/lib/markdown.ts` — currently one export, `stripLeadingH1` (`:11`). The frontmatter strip joins it here: pure, client-safe, already the module for exactly this.
- `src/components/MarkdownRenderer.tsx:105-108` — `urlTransform` moves out and is re-exported from here unchanged, because `src/components/__tests__/markdown-url-transform.test.ts:2` imports it from this path and must not be edited.
- `src/app/globals.css` (3576 lines) — one token in the `.wb-shell` block (`:2870-2876` type group), the comment at `:2824-2825`, new `.wb-preview-body*` / `.wb-wikilink*` / `.wb-preview-edit*` rules after `:3518`, and additions inside the two existing dock media blocks (`:3541-3556`, `:3560-3576`).
- `src/lib/__tests__/workbench-left-column.test.ts:246-257` plus the `leaks Story 1.5's markdown surface` clause in its header docblock (`:9-10`) — retarget to this story's contract.

**Reuse as-is (do not fork, do not edit):**
- `src/app/api/wiki/[slug]/route.ts:80-190` — `PUT`, body `{ content: string }` = markdown body without YAML; derives title from the first `# `, bumps `updated`, appends the contributor, re-serializes and calls `writeWikiPageWithSideEffects`. 400 empty content, 404 unknown/cloaked, 403 readable-but-unwritable. This is the whole write path; add none.
- `src/components/ConfirmDialog.tsx:18-37` — `{ open, title, body, confirmLabel, cancelLabel, onConfirm, onCancel, busy?, confirmDisabled?, error?, fallbackFocusRef? }`; Esc, focus trap, restore and scroll-lock come from `src/hooks/useDialogA11y.ts` (Esc on capture). Usable from `PreviewColumn`, never from `Workbench.tsx` (`workbench-chrome.test.ts:250-251`).
- `src/lib/wiki.ts:326` `readWikiPage(slug): Promise<WikiPage|null>` — silo-first, returns full content incl. frontmatter, `null` (never throws) when missing; `:624` `listReadableWikiPages(principal)`; `:181` `validateSlug` (throws).
- `src/lib/wikis.ts:426` `readWikiArtifact(owner, wikiId, file): Promise<string|null>` — null on ENOENT, re-throws otherwise; `:111` `wikiArtifactPath`; `getWikiRegistry(owner)` at `:308`; `WIKI_ARTIFACT_FILES` (`wiki-scenarios.ts:57`).
- `src/lib/storage/types.ts:113` `readFile(path): Promise<string>` — throws when missing; `src/lib/errors.ts:29` `isEnoent`.
- `src/lib/slugify.ts:31` `slugify(title)`; `src/lib/auth.ts:66` `getPrincipal()`; `src/lib/errors.ts:7,21` `getErrorMessage` / `ClientInputError`.
- `src/components/workbench/WikiSwitcher.tsx` — the repo's one client-fetch idiom inside the shell: timeout applied over the caller's `init`, busy flag reset on every exit path, inline `role="alert"`, `router.refresh()` on success.
- `src/components/workbench/WorkbenchData.tsx:19-41` — the server→client seam; its docblock (`:13-14`) already reserves it for this story. Nothing here needs a new field: the body arrives from the route, not from the server render.

**Precedent to copy (read-only):**
- `mockups/chat-cited.html:194-208` — `header` / `.fm` / `.body` split; the body is the Georgia half.
- `DESIGN.md:232` — the empty-Preview sentence is chrome, not Georgia. `UX-DR2` (`epics.md:154`) — body 16px/1.65, headings 22px.
- `src/lib/export.ts:23-26` — the `[[slug|Title]]` shape this story parses back.
- `src/lib/__tests__/workbench-tree.test.ts:1-45` — the temp-`DATA_DIR` fixture convention (own root, own cleanup, never `getDataDir()/tenants`).
- `src/app/api/wikis/current/route.ts` — the smallest authenticated route: `getPrincipal()` → 401 `{ error: "Sign in required." }`, `{ error }` shape throughout, no `runtime`/`dynamic` export.

**Read-only constraints (do not regress):**
- `workbench-chrome.test.ts:293-298` (no `Georgia`/`serif` in any file directly under `src/components/workbench`), `:418` (no `Georgia` in any `globals.css` rule after the `.wb-shell` token block), `:356-358` (no `var(--ink)`/`var(--paper)`/`var(--accent)` there either), `:381-399` (`.dark` parity), `:130-135`, `:250-251`, `:496` (`page.tsx` contains the bare `<Workbench>`).
- `workbench-left-column.test.ts:78-95` (dock wiring and the frozen effect deps), `:259-269` (`Open project folder`), `:319-353` (one `.wb-shell {`, grid variants, both responsive blocks).
- `create-wiki-ui.test.ts:118-209` (`WikiWorkbench.tsx` literals and counts, including `Select a file to preview.`), `markdown-url-transform.test.ts` (import path and policy), `links.test.ts:189-193`, `retired-surfaces.test.ts:118-131`, `single-ia.test.ts:41-78`, `brand-copy.test.ts:123-141`.

## Tasks & Acceptance

**Execution:**
- `src/lib/markdown.ts` -- add `stripFrontmatterBlock(content: string): string`: remove a leading `---\n…\n---` block and the blank line after it, return the input unchanged when there is no terminated block -- one regex-based, never-throwing definition shared by the route and the editor, so the body the owner reads is byte-identical to the body they edit and to what `PUT` expects.
- `src/lib/markdown-url.ts` -- new: move `urlTransform` here verbatim from `MarkdownRenderer.tsx:105-108`, and re-export it from `MarkdownRenderer.tsx` -- the Preview needs the app's data-URI policy without dragging KaTeX and the Mermaid client boundary into the workbench chunk, and `markdown-url-transform.test.ts` must keep importing from the path it imports from.
- `src/lib/workbench-wikilinks.ts` -- new, pure and client-safe: `WIKILINK_HREF_PREFIX`, `parseWikilinkRuns(text): Array<{kind:"text",value:string}|{kind:"link",target:string,label:string}>`, `remarkWikilinks()` (a unified plugin that walks the mdast itself — no new dependency — replacing `text` nodes outside `link`/`linkReference` with `link` nodes whose url is the prefix plus `encodeURIComponent(target)`), `wikilinkTargetFromHref(href): string|null`, and `resolveWikilink(target, readableSlugs): {slug:string; exists:boolean}` using `slugify` -- code fences and inline code are structurally out of reach because mdast gives them their own node types, which a source-level regex could not promise.
- `src/lib/workbench-preview.ts` -- new, pure and client-safe: `PreviewFormat = "markdown"|"text"|"unsupported"`, `previewFileKind(path)`, `PREVIEW_MAX_CHARS`, the request/response types shared by the route and the column, `previewRequestUrl(selection)`, and every sentence the body can show -- the same "one module owns the vocabulary" rule `workbench-tree.ts` follows, so no copy or shape is spelled twice across the client/server boundary.
- `src/lib/workbench-tree.ts` -- add `wikilinkSelection(tab, files, slug): TreeSelection`: a `file` selection at `wiki/<slug>.md` when the Files tab is active AND that node exists, otherwise a `page` selection -- following a wikilink must leave `aria-current` on a row the owner can actually see, and the alternative (switching tabs) would trip the frozen reset effect and clear the selection it just made.
- `src/lib/workbench-files.ts` -- add `readWorkbenchFile(owner, wikiId, displayPath, options): Promise<{content:string}|null>`: validate the path shape, then resolve `purpose.md`/`schema.md` through `readWikiArtifact`, `wiki/<name>.md` through `wikiLeafFilter(readableSlugs)` and `resolveRoot`, `raw/…` through `resolveRoot`; anything else, and every failed read, returns null -- the display path the tree prints is not the storage key that holds the bytes (`spec-1-4` deferred entry 2), and this is where that mapping belongs, beside the walk that produced the path and sharing its silo-first rule.
- `src/app/api/workbench/preview/route.ts` -- new `GET`: 401 without a principal; derive the gate exactly as `page.tsx` does; `kind=page` → gate the slug then `readWikiPage`; `kind=file` → `readWorkbenchFile` with the same gate and the registry's `currentId`; strip frontmatter, cap the length, and answer `{ name, path, slug?, format, body, truncated, editable }`; 400 on bad params and 404 — one body, no distinguishable message — for everything gated out or absent -- the Preview must be able to read exactly what the trees are willing to show and nothing else, so both surfaces derive the set the same way.
- `src/components/workbench/PreviewBody.tsx` -- new client component: `react-markdown` with `remarkPlugins={[remarkGfm, remarkWikilinks]}`, no rehype plugins, the shared `urlTransform` extended to pass the wikilink scheme, an `a` override that turns a wikilink href into a `<button className="wb-wikilink">` (resolved, calling `onOpenPage`) or a non-interactive missing-link `<span>` with a visually-hidden suffix, a `table` override that wraps in an overflow container, and plain text rendered in a `<pre>` for `format: "text"` -- the whole GFM/wikilink surface in one file that contains neither the face name nor an edit control.
- `src/components/workbench/PreviewColumn.tsx` -- extend per the Code Map: an abortable fetch effect keyed on the selection, the loading/empty/failed/unsupported sentences, `<PreviewBody>` under a `.wb-preview-body` wrapper, an `Edit` button rendered only when the payload says `editable`, `ConfirmDialog`, the textarea editor with Save/Cancel and an inline `role="alert"`, the `PUT` and `router.refresh()` -- the confirm gate and the view-first default live at the same seam the mockup draws, and every state is a sentence from `workbench-preview`.
- `src/components/workbench/Workbench.tsx` -- add `openPage` (built on `wikilinkSelection`, non-toggling) and pass it to `<PreviewColumn>`; touch nothing else -- the shell stays the single owner of selection state without gaining a second toggle rule or a new effect dependency.
- `src/app/globals.css` -- declare `--wb-font-read` in the `.wb-shell` type group and correct the Story 1.3 comment; add `.wb-preview-body` (Georgia via the token, 16px/1.65, headings 22px, a `:where(...)` descendant carve-out that excludes `code`/`pre`/`kbd`/`samp` so the mono rule at `:2997-3000` still wins), bordered `th`/`td` with a scroll container, `.wb-wikilink` and `.wb-wikilink--missing`, and the editor rules; extend the two existing dock media blocks -- UX-DR2's type line in CSS, painted only from `--wb-*` tokens.
- `src/lib/__tests__/workbench-preview.test.ts` -- new: execute every I/O matrix row — `parseWikilinkRuns` (plain, aliased, malformed), `remarkWikilinks` over hand-built mdast fixtures (code, inlineCode, inside a link, plain text), `resolveWikilink`, `stripFrontmatterBlock`, `previewFileKind`, `wikilinkSelection`, and `readWorkbenchFile` against a temp `DATA_DIR` covering the gate, traversal rejection, artifact resolution, silo-first and failed-silo -- the gate and the parser are this story's only real logic, and both must be run rather than grepped.
- `src/lib/__tests__/workbench-left-column.test.ts` -- retarget the `PreviewColumn` block: assert it now renders `<PreviewBody`, gates the editor behind `<ConfirmDialog`, still contains `className="wb-preview-fm"`, and still contains no `Georgia`/`serif`, no `rehype`/`remark-math`/`Mermaid`/`MarkdownRenderer` import, and no `next/link`; assert `PreviewBody.tsx` sources every sentence from `@/lib/workbench-preview` and passes `remarkGfm`; assert `globals.css` declares `--wb-font-read` inside the one `.wb-shell` block and applies it only in `.wb-preview-body` -- the frozen "nothing of Story 1.5's" assertions are exactly the ones this story exists to invert, and their replacements must be at least as specific.

**Acceptance Criteria:**
- Given a signed-in owner in Wiki mode with nothing selected, when the Workbench renders, then no Preview column exists in the grid and the Wiki canvas still reads `Select a file to preview.` from `WikiWorkbench.tsx` unchanged.
- Given the owner selects a compiled Page, when the Preview docks, then the body renders that page's markdown as GFM with bordered tables, its headings and prose in Georgia while the header, frontmatter strip and every other surface in the shell stay system sans, and no YAML block is visible.
- Given a page whose markdown contains `[[alpha]]` where `alpha` is a readable page and `[[ghost]]` where it is not, when the body renders, then `alpha` is an actionable control that re-points the Preview at that page without a route change or a full reload, and `ghost` renders as a visible missing-link state that a screen reader announces as missing.
- Given the owner chooses `Edit`, when the confirm dialog appears, then Cancel and Esc both return to the rendered view with nothing written, and Confirm replaces the body with a raw-markdown textarea and no rich-text affordance.
- Given edited markdown, when the owner saves, then the write goes through `PUT /api/wiki/[slug]` — and so through `writeWikiPageWithSideEffects` — the Preview returns to view-first showing the saved text, and a rejected save leaves the editor open with the owner's text and an inline error.
- Given a request for a page or file outside the readable set, a traversal path, or an unauthenticated request, when the preview route is called directly, then the answers are `404` with one indistinguishable body and `401` respectively, and no storage read is attempted for the rejected paths.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean, and the only pre-existing test file changed is `workbench-left-column.test.ts`.

## Spec Change Log

- **Implementation, 2026-08-15 — a failed SAVE gets its own sentence.** The Copy table lists a sentence for a failed read (`This file couldn’t be loaded.`) and none for a failed write, while **Always** requires every user-visible string to be listed there. Reusing the read sentence for a rejected `PUT` would tell the owner their file could not be loaded at the moment the editor is still holding their unsaved text — two different facts, one of them false. `PREVIEW_SAVE_FAILED_COPY` is a new constant in `workbench-preview` and a new row in **Design Notes → Copy**, used only as the FALLBACK: a message the server supplied (400 `content must be a non-empty string`, 403, 404) is always preferred, exactly as `WikiSwitcher.failureMessage` already does. KEEP: it is a fallback, never a replacement for the server's own message.

- **Implementation, 2026-08-15 — `Edit` is not offered for a TRUNCATED body.** The Tasks section gates the control on `payload.editable` alone. With the cap in force that is a data-loss path: the editor is seeded with `payload.body`, which for an oversized page is a 200,000-character PREFIX, and saving it would replace the page with that prefix through `writeWikiPageWithSideEffects`. The control is gated on `editable && !truncated`, so a capped page stays readable and stays whole. KEEP: the two conditions travel together — `editable` alone must not be spellable at the call site.

- **Implementation, 2026-08-15 — the wikilink rules are scoped under `.wb-preview-body`.** **Always** requires `--wb-font-read` to be applied "only by `.wb-preview-body` rules", and `.wb-shell *` re-applies `--wb-font` to every descendant at equal specificity — so the wikilink `<button>` needs the face restated on it or it renders in chrome sans mid-sentence. Writing that as a bare `.wb-wikilink` rule would have been a second reader of the token. The selectors are `.wb-preview-body .wb-wikilink[…]` instead: one reader family, and (0,2,0) beats the blanket regardless of source order. The new test enumerates every `var(--wb-font-read)` occurrence and asserts each one's selector names `.wb-preview-body`, which is stricter than the string check the Tasks section asked for.

- **Implementation, 2026-08-15 — the route is executed, not only inspected.** The Tasks section scopes `workbench-preview.test.ts` to the pure helpers plus `readWorkbenchFile`, but the I/O matrix has three rows that live only in the route: the unauthenticated call (`401`), the oversized body (sliced, `truncated: true`) and the empty file. Those are now a `GET /api/workbench/preview` block in the same file, with `@/lib/auth` mocked to a settable principal — the idiom `vault-pages-route.test.ts` already uses, and safe here because `authz` imports only the `Principal` TYPE from that module. The block also executes the no-existence-oracle rule by asserting that gated-out, absent, traversal, absolute-path and no-current-Wiki all return the identical status AND the identical body. KEEP: that assertion compares the answers to each other, not to a literal — a future change that alters the 404 body must alter all five together or fail.

- **Implementation, 2026-08-15 — the two request decisions moved out of the effect, so a test runs them.** Two I/O matrix rows — `Selection changes mid-fetch → the stale response is discarded` and `Save rejected → inline role="alert", editor stays open with the text, busy flag reset` — were pinned only by matching the source text of a React effect, which the intent's own ban on jsdom makes the ONLY thing a scan can do there. A rewrite that kept the comments and inverted an `aborted` check would have shipped one selection's bytes under another's header with the suite green. Both decisions are now pure exported functions in `workbench-preview` (client-safe, `fetch` as a parameter, no React, no storage), the same technique the shell already used for `shouldDockPreview` and `readableSlugsFromKnowledge`: `fetchPreview(url, signal, fetchImpl)` returns `{status:"ok"|"stale"|"failed"}` and checks `aborted` at BOTH awaits, and `savePreviewBody(slug, content, options)` returns `{status:"ok"}|{status:"error",message}` and resolves rather than throwing, so the caller's "keep the text, show the error" branch cannot be skipped. `failureMessage` MOVED there (not copied) and is exported. `PreviewPane` now maps results to state with one branch per outcome and issues no request of its own — the retargeted scan asserts `\bfetch\(` never appears in the component. Sixteen executed cases were added to `workbench-preview.test.ts`, driven by a stub fetch with no network and no timers. KEEP: the scan assertions stay as the wiring check; the executed tests are additions, not replacements.

- **Implementation, 2026-08-15 — a failed save no longer shows a status line.** Absorbing the save into `savePreviewBody` surfaced that the previous shape produced `Request failed (500)` for a rejection whose body carried no `error` — a user-visible string in no Copy table, naming the transport rather than the failure, and the exact thing **Always** forbids. The rule is now: a `string` `error` from the server wins; anything else (unparseable body, blank message, bare 500, timeout, network) shows `PREVIEW_SAVE_FAILED_COPY`. The 400/403/404 the write route actually returns still reach the owner verbatim, and that is executed. `PAGE_WRITE_ROUTE`/`pageWriteUrl` are named in the same module so the Preview cannot grow a second markdown writer by typing a different URL.

- **Review pass, 2026-08-15 — a deadline abort and a superseded pick are different outcomes.** Both stop the read through the same `AbortController`, and `fetchPreview` mapped every abort to `stale` — which the caller answers by staying silent. So a hung request never cleared `loading` and the column showed `Loading…` for the rest of the session: exactly the state the deadline's own docblock says it exists to prevent. The deadline now aborts with `PREVIEW_TIMEOUT_REASON`, and `fetchPreview` reads `signal.reason` to answer `failed` for a deadline and `stale` for a superseded pick. Both are executed, at both awaits.

- **Review pass, 2026-08-15 — a save is keyed to the row it was started on.** `save()` closed over `payload` and wrote unconditionally on success, so a pick made mid-save stamped page A's draft onto page B's payload (`setPayload(current => ({...current, body: draft}))` does not check who `current` is) and `restoreEditFocus` then pulled focus off the row the owner had just clicked. The slug is captured at save time and compared against `payloadRef.current` — a render-assigned ref, the `useDialogA11y` idiom — before any state write; a superseded save resets the busy flag and returns. Pinned by scan at the call site.

- **Review pass, 2026-08-15 — the READ gate under `wiki/` is narrower than the LISTING filter.** `readWorkbenchFile` reused `wikiLeafFilter`, whose first line is `if (!name.endsWith(".md")) return true` — correct for a listing (a non-page leaf is not the thing the page gate governs) and wrong for a read, because `resolveRoot` falls back to the SHARED flat `wiki/` root when the caller's silo is empty. `wiki/scratch.txt`, `wiki/dump.json` and `wiki/notes.markdown` therefore returned bytes that need not be the caller's: Story 1.4 disclosed such filenames, this would have disclosed their contents. A separate `readableWikiLeaf` now requires a `.md` (case-insensitively, since a filesystem need not be) whose slug is in `readableSlugs`; the listing filter is unchanged. KEEP: two filters, two reasons — do not re-unify them.

- **Review pass, 2026-08-15 — `[text](slug.md)` is a wikilink, not an anchor.** A relative markdown link rendered as a live `<a href="alpha.md">`, which navigates the browser off the Workbench to a URL that does not exist — and `[text](slug.md)` is the form the kernel itself writes and `extractWikiLinks` (`src/lib/links.ts:28`) parses, so it is the common in-content link rather than an edge case. `markdownLinkTarget(href)` (pure, executed) claims a relative `.md` href — dropping a `?`/`#` suffix and keeping the final path segment — and `PreviewBody` routes it through exactly the wikilink treatment: the same button, or the same missing-link state. Schemes, protocol-relative hosts, bare fragments and non-`.md` hrefs are untouched.

- **Review pass, 2026-08-15 — the rendered body is executed, without adding a DOM.** The story's central feature was pinned only by source scan, and two one-line regressions kept the whole suite green: deferring unconditionally in `previewUrlTransform` (react-markdown's sanitizer then drops the wikilink scheme and every link becomes `<a href="">`), and inverting `if (!exists)` (readable pages render as "(missing page)", missing ones as buttons). The house precedent for this — `src/components/__tests__/markdown-math.test.ts` — renders a react-markdown component with `createElement` + `renderToStaticMarkup` from `react-dom/server` inside a `.ts` test under `environment: "node"`, so the intent's **Never** (no jsdom, no `@testing-library/*`, no `.test.tsx`) is untouched. Eleven render cases live in `src/lib/__tests__/workbench-preview.test.ts` — NOT under `src/components/__tests__`, which the Verification section requires to stay clean. `previewUrlTransform` is exported so the scheme passthrough is pinned directly. One consequence: `PreviewBody.tsx` now carries a default `import React from "react"`, because `tsconfig` sets `jsx: "preserve"` and vitest's esbuild transform therefore uses the classic runtime — the same reason the article renderer carries one. Ten mutations (including all of the above) were confirmed to fail the suite.

- **Review pass, 2026-08-15 — smaller corrections.** (a) A save no longer relays a THROWN error's message — `Failed to fetch`, `signal timed out` and friends are transport vocabulary in no Copy table — and Save is disabled while `draft.trim()` is empty, which is what made the write route's `content must be a non-empty string` reachable one keystroke away; a server-supplied 403/404 sentence still reaches the owner verbatim. `failureMessage` was removed rather than left as dead code. (b) The route gained a top-level `try`/`catch` so a throw answers `{ error }` with a 500 instead of a framework page, matching `api/wikis/current`, and every answer now carries `Cache-Control: private, no-store` like `api/system/health`. (c) `previewFileKind` is computed BEFORE the read, so an unsupported blob is never buffered to be discarded — a new `workbenchFileExists` runs the same validation and gate through a shared `resolveWorkbenchFile`, so an unsupported path outside the caller's reach is still refused rather than described. (d) `canEditPreview(payload)` and `capPreviewBody(body)` are exported pure functions, the latter stepping back one UTF-16 unit when the cap lands on a high surrogate. (e) `openPage` reuses `isSameSelection` so following a link to the row already showing is a no-op instead of a teardown-and-refetch. (f) The `.wb-preview-body` allowlist covers `input`, `section` and `span`, with alignment rules for GFM task lists and a separator for the footnote block. (g) `stripFrontmatterBlock`'s docblock no longer claims to be the only frontmatter stripper — it names the article renderer's private copy and says why the two are deliberately not unified.

- **Implementation, 2026-08-15 — `grep -rn "Georgia" src` cannot be empty, and should not be.** The Verification section expects no match. The declaration this story is required to add lives in `src/app/globals.css`, and `src/lib/html.ts:78` has carried an unrelated `Georgia` in the static-export stylesheet since before this epic. The executable form of the constraint is the pair the same section already lists — `grep -c "Georgia" src/app/globals.css` is `1`, inside the `.wb-shell` token block — plus `workbench-chrome.test.ts:293-298` (no `Georgia` in any file under `src/components/workbench`) and `:418` (none in any rule after the token block). All three hold.

- **Review pass, 2026-08-15 — a link the Preview will not follow is not an anchor.** The `a` override converted two forms into in-shell controls and fell through to a live `<a href>` for the rest — which left `[text](/u/<handle>/<slug>)` rendering as exactly the thing the intent's **Never** names, and `[text](raw/scan.pdf)` navigating the same tab to a URL that does not exist. `previewLinkKind` (pure, executed) decides the fallback in three ways instead of one: `external` (a scheme, or `//host`) keeps its anchor and opens a new tab, so the Workbench is still there to come back to; `anchor` (a bare `#fragment`) keeps its anchor because `remark-gfm`'s footnotes and back-references are fragments and are the one GFM feature that needs them; `inert` — schemeless relative, root-relative, and an href the sanitizer emptied — renders as `.wb-preview-deadlink` text. KEEP: `markdownLinkTarget` gets first refusal, so a relative `.md` is still a control; only what it declines reaches this decision.

- **Review pass, 2026-08-15 — the draft is keyed to the page it was seeded from.** `save()` read `payload?.slug` at press time, so the guard added in the previous pass compared the new payload to itself and passed. `setEditing(false)` in the selection effect was the whole defence, and no test named it: deleting that one line let an editor opened on page A write its draft over page B through `writeWikiPageWithSideEffects`, suite green. `editingSlugRef` is assigned in `startEditing`, checked before the request and again after it, and cleared by the effect. KEEP: both checks — the pre-flight one is what makes the invariant independent of the effect, and the post-await one is what makes it independent of the render.

- **Review pass, 2026-08-15 — the artifact branch is executed, not assumed.** Every route case ran with an empty registry, so the only assertion about `purpose.md` was a 404 — and `currentId = null` in the route would have kept the whole suite green while both seeded artifacts, which the Files tab renders at the tree root on every load, answered 404 in the product. The new case seeds `tenants/<t>/wikis.json` and the artifact, asserts the 200 body and `editable: false`, and removes the registry in a `finally` so the no-current-Wiki premise every other case depends on is restored. KEEP: the teardown — the 404-indistinguishability case reads `purpose.md` as one of its five answers.

- **Review pass, 2026-08-15 — which body state is showing is a decision, so it is executed.** The column's central job — pick one of loading / failed / unsupported / empty / body — was four conditions spelled inline in `body()`, where the node suite can only grep. Inverting one of them (`payload.body.trim().length === 0` → `> 0`) rendered `This file is empty.` for every readable file and an empty column for an empty one, with all 4,027 tests green; the same held for the `unsupported`-before-`empty` order, which is what keeps a PDF from being described as empty. `previewBodyState({loading, failed, payload})` is a pure exported function in `workbench-preview` returning a discriminated state, and the component only maps a state to an element. KEEP: the branch ORDER is the content of the decision, and the `body` case carries its own payload, so the caller renders the payload the state was judged on rather than re-reading a variable that may have moved on.

- **Review pass, 2026-08-15 — a link is a control only when it names a page.** `markdownLinkTarget` kept the final path segment of any relative `.md` href, so `[source](raw/notes.md)` — a SOURCE — was resolved against the page slug `notes`: a button that silently opens an unrelated page, or a real file labelled `(missing page)`. The kernel's own parser agrees these are not the same thing (`extractWikiLinks` reads that href as the slug `raw/notes`). The directory must now be one a page is addressed by — none, `./`, or the tree's own `wiki/` — and anything else falls through to `previewLinkKind`, which already renders a link the Preview will not follow as text. KEEP: `./wiki/alpha.md` and `WIKI/alpha.md` still resolve; the fix is about the directory, not about case or depth.

- **Review pass, 2026-08-15 — one name→slug rule, not two.** The route re-derived `wiki/<name>.md` → slug inline while `readableWikiLeaf` derived it for the gate; the previous pass fixed a bug that was exactly those two expressions disagreeing about case. `wikiLeafSlug` is exported from `workbench-files.ts` and both call it. Same pass: `canEditPreview` now also requires a non-empty `slug`, because the editor writes to `pageWriteUrl(slug)` and a payload that is `editable` without one opens the editor, enables `Save`, and then does nothing at all when it is pressed — neither a write nor a message. And `.wb-preview-body :where(a)` is painted from `--wb-foreground`: both non-navigating link states were token-painted while the one link the Preview does follow took the user agent's blue and visited purple.

## Review Triage Log

### 2026-08-15 — Review pass (follow-up 2)

- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 21: (high 0, medium 3, low 18)
- addressed_findings:
  - `[medium]` `[patch]` The column's body-state choice — loading / failed / unsupported / empty / body, the five things this story exists to show — was four conditions inline in `body()`, pinned by nothing but source greps that name none of them. Inverting `payload.body.trim().length === 0` showed `This file is empty.` for every readable file and an empty column for an empty one with the full suite green; deleting the `loading` branch made `Loading…` unreachable; reordering `unsupported` after `empty` described a PDF as empty. `previewBodyState` is now a pure exported function with all five branches and the order between them executed in `workbench-preview.test.ts`, and the retargeted scan asserts the column asks it rather than re-deriving the conditions.
  - `[low]` `[patch]` `markdownLinkTarget` kept the last segment of ANY relative `.md` href, so `[source](raw/notes.md)` resolved against the page slug `notes` — a control that opens an unrelated page, or a real source file rendered as `(missing page)`. `extractWikiLinks`, the kernel's own parser, reads that href as `raw/notes` and finds no page either. Only a directory a page is addressed by (none, `./`, `wiki/`) is accepted now; the rest fall through to `previewLinkKind` and render as text, which is what the previous pass established for every other link the Preview will not follow.
  - `[low]` `[patch]` `canEditPreview` did not require a slug, and `isPreviewPayload` does not check one either — so an `editable` payload without a slug opened the editor, enabled `Save`, and did nothing at all when it was pressed: no write, no message, no way to tell. Executed as a third condition beside `editable` and `!truncated`.
  - `[low]` `[patch]` The route derived `wiki/<name>.md` → slug with its own expression while the read gate derived it with another; the previous pass fixed a shipped bug that was exactly those two disagreeing about extension case. Both call `wikiLeafSlug` now.
  - `[low]` `[patch]` `.wb-preview-body` styled the wikilink and the dead link from `--wb-*` tokens and left a real `<a>` — the external link the Preview does follow — to the user agent, so the one live link in the column rendered in browser blue and visited purple. Painted from `--wb-foreground`, with a test that every coloured link rule in the body reads a `--wb-` token.

Note on routing: nothing reached `intent_gap` or `bad_spec`, so no loopback ran and `review_loop_iteration` stayed 0. The one medium is a test-surface finding whose fix was the technique this spec's own change log already established twice — relocate a decision out of the component into a pure module so the node suite can run it — and the four lows are each one expression at the seam that owns it. Deferred: `editable` is derived from the READ gate while `canWritePage` refuses body writes on a commons page to a non-admin, so a second principal would be offered `Edit` and refused at Save; unreachable with one operator, and the intent defines `editable` without reference to write ACLs, so narrowing it is not this story's call. Rejected: the frontmatter strip applying to read-only `raw/` and artifact markdown as well as to pages (the **Never** clause forbids exposing a YAML block to the owner at all, and narrowing the strip to pages would break it for the two artifacts the Files tab renders on every load); the 500 branch relaying `getErrorMessage` and the whole-file buffering before the cap (both re-raised verbatim from the previous pass, and rejected for the reasons recorded there); `resolveWorkbenchFile` listing a root to resolve one key (one listing per click, against a silo-first rule the intent requires to have exactly one definition); `payloadRef.current` being assigned during render (the `useDialogA11y` house idiom, named as such in the code); `mailto:`/`tel:` being classified `external` without `target="_blank"` (neither navigates the tab away, and `defaultUrlTransform` empties every other non-http scheme before it reaches the override, so the case the finding describes cannot arrive); `[see](#heading)` rendering as a live anchor that scrolls nowhere because no heading ids are emitted (rehype plugins are banned outright and the fragment must stay live for `remark-gfm`'s footnotes, which is the decision the previous pass recorded); `[x](wikilink:target)` written by an author becoming a page button (it can only reach a slug the gate already admits — the same reach `[[target]]` has); `PreviewBody` not branching on `format: "unsupported"` (the column returns before mounting it — rejected as unreachable in the previous pass on the same evidence); an all-whitespace `.txt` reported as empty (now executed as the intended answer); the deadline timer surviving a settled request (it aborts a controller nothing is listening to); no `aria-live` on the loading→content swap and no announcement of the dock (`spec-1-4` deferred entry 5 owns that design); no copy explaining why `Edit` disappears on a truncated page (rejected in the previous pass; the truncation sentence above the body is that explanation); the `.wb-shell` mono rule and the body allowlist tying on specificity (react-markdown emits no elements inside `<pre><code>` for the tie to reach, since no highlighter runs); `PREVIEW_TRUNCATED_COPY` being computed rather than typed (the locale is pinned to `en-US`, so the sentence is character-exact by construction and cannot outlive the cap); `pageWriteUrl("../secrets")` asserting a property of the URL rather than of the handler (an integration test of `PUT /api/wiki/[slug]` is a surface this story does not own); the route test file's shared fixtures and its length (no assertion depends on the accumulated state, and the one case needing a clean premise restores it); `page.tsx` never being compared to the route's gate derivation (both call the same two functions in the same order — the comparison a test could make is the one the code already makes); `listWorkbenchFilePaths` never being invoked in this story's tests to prove listing/read equivalence (the read gate is deliberately narrower, which the previous pass established on security grounds and this spec records as a deferred consequence); "tables render bordered" not being asserted (no CSS engine runs in the suite and the story is forbidden a browser); and the residue of the column that is still grep-pinned — the confirm gate, focus restoration and the editor lifecycle (`PreviewPane` calls `useRouter`, so rendering it needs a router context, i.e. exactly the DOM test environment the intent's **Block If** names).

### 2026-08-15 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 2: (high 0, medium 1, low 1)
- reject: 15: (high 0, medium 3, low 12)
- addressed_findings:
  - `[medium]` `[patch]` A markdown link that was neither a wikilink nor a relative `.md` still rendered as a live `<a href>` in the same tab — including `[text](/u/<handle>/<slug>)`, which is `<a href>` to `/u/…` from the Preview by name, the shape the intent's **Never** forbids outright, and `[text](raw/scan.pdf)`, which navigates to a URL that does not exist. The previous pass fixed exactly this class for `[text](slug.md)` and left the fallback branch of the same override untouched. `previewLinkKind` (pure, executed) now splits the three cases: a scheme or protocol-relative host stays an anchor and opens in a new tab, a bare `#fragment` stays an anchor because that is what `remark-gfm` emits for footnotes in both directions, and everything else — schemeless relative, root-relative, and an href the sanitizer emptied — renders as non-navigating text.
  - `[medium]` `[patch]` The confirm-gated editor's draft was keyed to whatever the column was showing when Save was pressed, not to the page it was seeded from, and `setEditing(false)` in the selection effect was the only thing keeping the two the same — pinned by nothing. Deleting that one line turned the editor into a cross-page overwrite (edit A, click B, Save writes A's markdown over B through `writeWikiPageWithSideEffects`) with the whole suite green, because the existing `payloadRef.current?.slug !== slug` guard compared B to B. The slug is captured in `startEditing` into `editingSlugRef` and checked both before the request and after it, so the invariant no longer depends on the effect remembering; the effect's `setEditing(false)` and the ref reset are both pinned by a scan scoped to the effect body.
  - `[medium]` `[patch]` The route's artifact branch was never executed. `purpose.md` and `schema.md` resolve only through `getWikiRegistry(principal.handle).currentId`, and every route case ran against an empty registry asserting 404 — so `currentId = null` (or the wrong owner argument) passed the whole suite while both artifact rows answered 404 in the product and the column showed `This file couldn’t be loaded.` for two rows the Files tab always renders. That is the I/O matrix's own `Artifact read` row, previously executed only below the route. A case now seeds a valid registry plus the artifact and asserts the 200, its body and `editable: false`, then removes the registry so every other case keeps its empty-registry premise.
  - `[low]` `[patch]` `markdownLinkTarget` never percent-decoded, so `[Alpha Beta](Alpha%20Beta.md)` — the escaped form most editors write — carried the target `Alpha%20Beta` and rendered as a missing page, while `[[Alpha Beta]]` resolved. One link, two answers. The final segment is now decoded through the same never-throwing helper `wikilinkTargetFromHref` uses.
  - `[low]` `[patch]` The route derived the slug with a case-SENSITIVE `.endsWith(".md")` while the read gate is case-insensitive, so `wiki/alpha.MD` was served with no slug: the same page the Knowledge tab edits was read-only from the Files tab.
  - `[low]` `[patch]` The truncation sentence rendered after the body, so the only way to learn a page was cut off was to scroll past 200,000 characters to an end that is not there — and it is also the explanation for the `Edit` control being absent, which is visible from the top. It renders above the body now.
  - `[low]` `[patch]` `disabled={saving}` on the focused textarea moves focus to `<body>` for the length of the save, dropping the caret and handing a failed save back to an editor the owner is no longer in. `readOnly` plus `aria-busy` preserves both; the two buttons still disable.
  - `[low]` `[patch]` `fetchPreview` cast any 200's JSON to `PreviewPayload` unchecked, and the column calls `payload.body.trim()` during render — where a non-string throws and takes the column down instead of showing the one sentence a failed read exists to show. The fields the column actually reads are now verified before the result is called `ok`.
  - `[low]` `[patch]` The **Verification** section still listed `grep -rn "Georgia" src` — expected: no match — which this spec's own Spec Change Log explains can never hold, since the declaration this story is required to add lives in `globals.css` and `src/lib/html.ts:78` has carried an unrelated one since before this epic. Replaced with the executable pair the change log names, so the checklist no longer produces a false red.

Note on routing: nothing reached `intent_gap` or `bad_spec`, so no loopback ran and `review_loop_iteration` stayed 0. The three medium findings are one branch of one override, one ref in one component, and one missing test case — each fixable at the seam that owns it, so re-deriving would have bought nothing a patch did not. The link finding is arguably a deviation from a clear **Never**, but the intent-contract is correct as written and the plan sections outside it are silent only on the fallback branch of an override the Tasks section otherwise specifies in full; reverting ~3,600 lines of verified work over five lines of one branch would be the same trade the previous pass declined for the same class of finding. Deferred: `raw/` reads inherit `resolveRoot`'s shared-flat-root fallback (real, and not narrowable here without contradicting the intent's own "one definition" and "same as the listing" rules); and the Files tab lists `wiki/` non-page leaves the Preview now refuses, whose coherent fix is at the listing filter the previous pass deliberately froze. Rejected: the 500 branch relaying `getErrorMessage(error)` (verbatim the shape of `api/wikis/current`, which this route models, and reachable only by the authenticated owner of the tenant whose paths it names); `PreviewPayload.name`/`path` being computed by the route and re-derived by the column (no user-visible consequence, and the payload describing itself is the contract); the gate being derived before the `kind` branch splits so a `raw/` request pays for an index read it does not consult (one read per click, against a guarantee the intent asks for by construction); the route test block's monotonic fixture (no assertion depends on the slug set being empty, and the one case that needed a clean premise cleans up after itself); `savePreviewBody`'s field name and method being pinned only against a stub (true of every client/route pair in the repo, and an integration test of `PUT /api/wiki/[slug]` is a surface this story does not own); missing `:focus-visible` on the new controls (`globals.css:3018` already covers every `button` inside `.wb-shell` — the finding is factually wrong); no `aria-live` on the loading→content swap (announcing the dock is `spec-1-4` deferred entry 5, and this story must not pre-empt its design); a save that times out after the server applied it (the text is preserved, the message is honest about uncertainty, and `PUT` is idempotent so the retry is safe); a selection change during a save stranding the busy flag (`setSaving(false)` runs before the superseded check, and the new row renders no Save button anyway); `sprint-status.yaml` reading `done` while the spec did not (the orchestrator owns that file); DW-37's severity being understated (the ledger is the orchestrator's, and its entries are not this session's to re-open); a large `.md`/`.txt` being buffered whole before the cap (the storage interface exposes no ranged read, and an unbounded text file is not an Epic 1 reality); no copy explaining why `Edit` disappears on a truncated page (the truncation sentence, now above the body, is that explanation — a second string would be copy bloat); `tenantForOwner` throwing and widening the read to the flat root (the same mechanism as the deferred `raw/` entry, and under `wiki/` the page gate has already run); and `isListablePath` not enforcing `WORKBENCH_FILE_LIMIT`, so a path squeezed out of a truncated listing is still readable (the budget is a rendering cap, never a permission).

### 2026-08-15 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 0, medium 5, low 9)
- defer: 4: (high 0, medium 1, low 3)
- reject: 12: (high 0, medium 2, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The 15-second read deadline could only produce `stale`. It aborted the SAME controller a selection change uses, `fetchPreview` mapped every abort to `stale`, and the handler returns early on `stale` — so the one case the deadline exists to rescue left the column on `Loading…` for the rest of that selection, with no error, which is verbatim the state its own docblock says it prevents. The deadline now aborts with a reason both awaits read: a timeout renders the failure sentence, a superseded pick stays silent.
  - `[medium]` `[patch]` `save()` was not keyed to the selection. A pick that landed while a `PUT` was in flight let the success path stamp page A's draft onto page B's payload and pull focus back to a button beside it — the column would have shown one page's text under another's header and path. The slug is captured at save time and compared before any state write.
  - `[medium]` `[patch]` The read gate under `wiki/` was the LISTING filter, whose first line passes every name not ending in `.md`. So `wiki/scratch.txt`, `wiki/dump.json` and `wiki/notes.markdown` were served in full — and because `resolveRoot` falls back to the shared flat root when a silo is empty, those bytes need not have belonged to the caller. Story 1.4 disclosed such filenames; this would have disclosed their contents. The reader now requires a `.md` whose slug is in the gate, while the listing filter keeps its own reasons.
  - `[medium]` `[patch]` A relative markdown link rendered as a live `<a href="alpha.md">` that navigates the browser off the Workbench to a 404. `[text](slug.md)` is the form the kernel actually writes and `links.ts:28` parses, so it is the common case, not the exotic one, and the intent forbids leaving the shell. It now takes the identical wikilink treatment: a button, or the same missing-link state.
  - `[medium]` `[patch]` The story's central feature was pinned by grep alone. Two demonstrated mutations kept the whole suite green — making `previewUrlTransform` unconditional turned every `[[link]]` into a dead `<a href="">`, and inverting one branch made readable pages render as "(missing page)" and missing ones as clickable buttons. `markdown-math.test.ts` already renders a react-markdown component under `environment: "node"` with `renderToStaticMarkup`, so no DOM was needed and none was added: 11 render cases now execute the resolved/missing/code/table/relative-link behaviour, and all ten mutations tried this pass fail.
  - `[low]` `[patch]` A save relayed thrown transport vocabulary (`Failed to fetch`) as product copy, and clearing the textarea surfaced the write route's `content must be a non-empty string` one keystroke away. Only server-supplied `{error}` sentences reach the owner now, and Save is disabled on an empty draft.
  - `[low]` `[patch]` The route had no top-level `try`/`catch`, so a throw broke its own `{ error }` contract with a framework 500.
  - `[low]` `[patch]` The format was decided after the bytes were read, so an unsupported blob under `raw/` was fully buffered and then discarded.
  - `[low]` `[patch]` The truncation half of the edit guard — the thing standing between a 200,000-character prefix and a `PUT` that replaces the page with it — was an unverified boolean in a component. It is `canEditPreview(payload)` now, executed.
  - `[low]` `[patch]` `remarkGfm` emits task-list checkboxes and footnotes; the body's element allowlist covered neither, so both rendered in chrome sans mid-body.
  - `[low]` `[patch]` The 200,000-character cap is UTF-16-indexed and could cut through a surrogate pair, shipping a lone surrogate in the JSON payload.
  - `[low]` `[patch]` Following a wikilink to the row already showing tore down the body and refetched bytes the column already had, because `wikilinkSelection` returns a fresh object and the effect is keyed by identity.
  - `[low]` `[patch]` A per-principal gated body was served with no cache directive; every answer now carries `private, no-store`.
  - `[low]` `[patch]` `stripFrontmatterBlock`'s docblock claimed to be the only frontmatter stripper while the article renderer still carries its own with a different regex.

Note on routing: nothing reached `intent_gap` or `bad_spec`, so no loopback ran and `review_loop_iteration` stayed 0. The four medium code findings are all narrowings of seams this story built — one abort reason, one stale-write guard, one gate, one link shape — fixable at the call site that owns each, so re-deriving the implementation would have bought nothing a patch did not; the fifth medium is a test-surface finding whose fix was available inside the intent's own constraint (it bans jsdom, `@testing-library` and `.test.tsx`, none of which `renderToStaticMarkup` needs). Deferred: an editor's unsaved text is discarded silently when the selection changes; `PUT /api/wiki/[slug]` has no `isReadOnly()` gate, which this story's `Edit` affordance now surfaces; the page write path has no lost-update guard; and Story 1.2's canvas card keeps saying `Select a file to preview.` while a Preview is docked beside it. Rejected on the intent's own authority: rendering the page's own leading `# Title` under a header that names it (stripping it would desync what is read from what is edited, and the route derives the title from that same H1); a truncated body offering no route to the rest (download and open-full are surfaces this epic does not have); unifying `stripFrontmatterBlock` with the article renderer's private copy (a behaviour change to `/u/<handle>/<slug>`, not to the Preview); the absence of `deferred-work.md` and a sprint-status edit from the change set (the orchestrator owns both, as `spec-1-4` also found); and that `Esc closes the dialog` is inherited from `useDialogA11y` rather than asserted here (the house convention `create-wiki-ui.test.ts:81-109` established). Rejected as unreachable: a body with no frontmatter that opens with `---` as a thematic break (every markdown tool reads a leading `---` block as frontmatter, and the kernel writes one); `PreviewBody` mishandling `format: "unsupported"` (the column returns before mounting it); and `wiki/<dir>/<file>.md` being listable but unreadable (the kernel writes `wiki/` flat). Rejected as noise: that the executed filesystem suite covers the read gate more heavily than any AC line names (the gate is what makes the AC safe); that copy authored here is not in `epics.md` (the Copy table is the sanctioned mechanism); and that computed style and the `.wb-shell *` outranking mechanism are not asserted (no CSS engine runs in the suite, and the story is forbidden a browser).

## Design Notes

**Copy (character-exact; do not paraphrase).**

| Where | String | Source |
|---|---|---|
| Body loading | `Loading…` | authored, UX-DR23 voice |
| Body read failed | `This file couldn’t be loaded.` | authored, matches the tree's `Your files couldn’t be loaded.` register |
| Body empty | `This file is empty.` | authored |
| Body not previewable | `This file can’t be previewed here.` | authored |
| Body truncated | `Preview truncated at 200,000 characters.` | authored, numeral derived from `PREVIEW_MAX_CHARS` |
| Missing wikilink (visually hidden) | `(missing page)` | authored |
| Edit control | `Edit` | `epics.md:423` |
| Confirm title | `Edit this page?` | authored |
| Confirm body | `Preview is view-first. Editing opens the raw markdown — there is no rich-text editor. Saving writes through the wiki and updates its index and links.` | authored, UX-DR23 voice |
| Confirm / cancel labels | `Edit markdown`, `Cancel` | authored |
| Editor actions | `Save`, `Cancel` | authored |
| Saving | `Saving…` | `ConfirmDialog` busy idiom |
| Save failed (fallback) | `This page couldn’t be saved.` | authored, UX-DR23 voice — see the Spec Change Log |

**Where the empty sentence already lives.** `epics.md:413` reads "copy is `Select a file to preview.`" and `epics.md:414` reads "Preview is not a third column until a tree pick" — one sentence, one column that does not exist yet, and no contradiction once you look at the mockup: `mockups/create-wiki.html:121` puts the sentence on `<main class="canvas">`. Story 1.2 already shipped it there (`WikiWorkbench.tsx:254`) and `create-wiki-ui.test.ts:128` freezes it. So this criterion is satisfied by not breaking it, and `DESIGN.md:232` confirms the reading by calling that sentence chrome rather than Georgia.

**Why the wikilink pass is a remark plugin and not a source rewrite.** Rewriting `[[x]]` to `[x](wikilink:x)` in the markdown string before parsing is fewer lines, and it corrupts every code fence that mentions the syntax — including this repo's own docs, which do (`mcp.ts:1483`). mdast gives `code` and `inlineCode` their own node types, so a transform that only visits `text` nodes cannot reach inside them. That is a structural guarantee rather than a regex that has to be right about fences, and it is what makes the "wikilink in code" matrix row a one-line test.

**Why a wikilink does not become an `<a href>`.** `/u/<tenant>/<slug>` is live and is what `resolveSlugPath` produces, but following it leaves the Workbench for the legacy article view — a route change out of the shell Epic 1 exists to make the job surface, and the opposite of Story 1.4's "leaving Wiki mode undocks it without a route change". A `<button>` that re-points the selection keeps the reader in one column, reuses the selection machinery the shell already owns, and keeps `links.test.ts:189-193` irrelevant because this story emits no page URL at all.

**Why Georgia is declared in the chrome token block.** `workbench-chrome.test.ts:418` bans the literal `Georgia` in every `globals.css` rule after `.wb-shell { … }`, and `:293-298` bans it in every workbench component file. The one remaining place is the token block itself, whose Story 1.3 comment says the face "must never appear here". The test is the executable constraint and the comment is prose; declaring `--wb-font-read` beside `--wb-font` and `--wb-font-mono` — and applying it only in `.wb-preview-body` — honours what the comment was protecting (chrome stays sans) without editing a single assertion, which the alternative reading would have required.

**Why the route re-derives the gate instead of trusting the client.** The column already holds `knowledge` and `files`, so it could send a slug it believes is readable. That makes the browser the authority on what the server will read. Deriving `readableSlugsFromKnowledge(buildKnowledgeTree(await listReadableWikiPages(principal)))` inside the route costs one index read and makes the Preview's reach identical to the tree's by construction — the same reasoning `spec-1-4`'s change log applies to the Files tab, and the reason the file branch checks the path against `listWorkbenchFilePaths`'s own resolution rather than a second path grammar.

**Why the editor edits the body, not the file.** `PUT /api/wiki/[slug]` documents `content` as the body without YAML and owns frontmatter end-to-end — it merges `updated`, backfills `created`, appends the contributor and re-serializes (`api/wiki/[slug]/route.ts:144-168`). Handing it a body it then wraps is the whole write; handing it a full file would double the frontmatter. That is also why the route strips before sending: read and edit see one string.

## Verification

**Commands:**
- `npx vitest run` -- expected: the full suite green (201 files, 3914 tests at baseline) plus the new file; only `workbench-left-column.test.ts` modified among pre-existing tests.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors.
- `npx vitest run src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/links.test.ts src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/brand-copy.test.ts src/components/__tests__/markdown-url-transform.test.ts` -- expected: green, unchanged.
- `git diff --stat -- src/components/WikiWorkbench.tsx src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/components/__tests__` -- expected: empty.
- `grep -c "Georgia" src/app/globals.css` -- expected: 1, inside the `.wb-shell` token block. `grep -rn "Georgia" src/components/workbench` -- expected: no match. (A repo-wide `grep -rn "Georgia" src` is NOT the check: `src/lib/html.ts:78` has carried one in the static-export stylesheet since before this epic, and the declaration this story is required to add is the `globals.css` one counted above. `workbench-chrome.test.ts:293-298` and `:418` are the executable form.)
- `grep -rn "rehype\|remark-math\|Mermaid\|MarkdownRenderer\|next/link" src/components/workbench` -- expected: no match.
- `grep -rn "useRouter\|router.push" src/components/workbench/Workbench.tsx` -- expected: no match.
- `git diff --numstat -- src/app/globals.css` -- expected: deletions confined to the `:2824-2825` comment; `:root`, `.dark` and `@theme inline` unchanged.

**Manual checks (if no CLI):**
- Inspect `src/app/api/workbench/preview/route.ts` for `getPrincipal()` flowing into both the gate and every read — no hard-coded owner, tenant or handle, and no branch that reads before gating.
- Inspect the diff of `workbench-left-column.test.ts` to confirm each removed assertion was replaced by a stricter one, not dropped.




## Auto Run Result

Status: done

**Summary.** This run was a follow-up REVIEW pass over the already-implemented Story 1.5 change set (the spec arrived at `status: done` with `followup_review_recommended: true`). Four review layers ran in parallel over the full diff since `a671f56`. Nothing reached `intent_gap` or `bad_spec`, so no loopback ran and `review_loop_iteration` stayed 0. Five findings were patched, one deferred, twenty-one rejected. The story's behaviour is unchanged apart from one link case (`[x](raw/notes.md)` is now inert text rather than a control pointing at the page `notes`) and one colour (a live external link in the body is painted from a token instead of by the browser).

**Files changed in this pass:**
- `src/lib/workbench-preview.ts` — added `previewBodyState` (pure, five-state, order-bearing); `canEditPreview` gained the slug condition.
- `src/components/workbench/PreviewColumn.tsx` — `body()` now maps a `previewBodyState` result to an element instead of re-deriving the conditions inline.
- `src/lib/workbench-wikilinks.ts` — `markdownLinkTarget` accepts only a directory a page is addressed by (none, `./`, `wiki/`).
- `src/lib/workbench-files.ts` — extracted and exported `wikiLeafSlug`, the one name→slug rule; `readableWikiLeaf` calls it.
- `src/app/api/workbench/preview/route.ts` — the file branch derives its slug through `wikiLeafSlug` rather than a second expression.
- `src/app/globals.css` — `.wb-preview-body :where(a)` painted from `--wb-foreground`, with a hover from `--wb-rail-hover`.
- `src/lib/__tests__/workbench-preview.test.ts` — executed cases for `previewBodyState` (all five branches plus the order between them), the slug half of `canEditPreview`, and the refused link directories.
- `src/lib/__tests__/workbench-left-column.test.ts` — the truncation-order assertion retargeted to `state.payload.truncated`; new assertions that the column asks `previewBodyState` and no longer spells the conditions, that the fetch handler settles `loading`, and that every coloured link rule in the body reads a `--wb-` token.

**Review findings breakdown:** patches applied 5 (medium 1, low 4); deferred 1 (low — `editable` derived from the read gate while the write ACL is narrower); rejected 21 (medium 3, low 18). Details and reasons in the Review Triage Log entry for this pass.

**Follow-up review recommendation:** patched this pass — high 0, medium 1, low 4. Score = 3 × 1 + 1 × 4 = 7, which is 5 or more, so `followup_review_recommended: true`.

**Verification performed:**
- `npx vitest run` — 202 files, 4,028 tests, all green (baseline for this pass was 202 files / 4,027 tests; the net +1 is this pass's new cases inside existing and new describes).
- `npx tsc --noEmit` — exit 0. `npx eslint` — exit 0 (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices, which are not errors).
- Frozen-suite re-run (`workbench-chrome`, `create-wiki-ui`, `links`, `retired-surfaces`, `brand-copy`, `markdown-url-transform`) — 143 tests green.
- `git diff --stat -- src/components/WikiWorkbench.tsx src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/components/__tests__` — empty.
- `grep -c "Georgia" src/app/globals.css` — 1, inside the `.wb-shell` token block; `grep -rn "Georgia" src/components/workbench` — no match.
- `grep -rn "rehype\|remark-math\|Mermaid\|MarkdownRenderer\|next/link" src/components/workbench` — no match. `grep -rn "useRouter\|router.push" src/components/workbench/Workbench.tsx` — one docblock mention of what the shell must never do; no call.

**Residual risks.**
- The confirm gate, focus restoration and the editor lifecycle in `PreviewColumn` remain pinned by source scan only. `PreviewPane` calls `useRouter`, so rendering it needs a router context — the DOM test environment the intent's **Block If** names — and this pass moved out the one decision that could leave without it. Anything further at that surface is a spec-level decision, not a patch.
- The `deferred` list now carries seven entries; the two rated medium (an open editor's unsaved text discarded on a selection change, and `raw/` reads inheriting the shared flat-root fallback) both need a story that owns a surface this one does not.
