---
title: 'Story 1.8: Edit Schema'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: 'fd2a43eae37fdcda8bd9ec715900715f3e5bbba6'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-dataversion-workbench-refresh.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The Schema write has no lost-update protection, so an editor left open
      across another actor's save silently clobbers it.
    evidence: |-
      `PUT /api/workbench/artifact` carries no ETag, no `If-Match` and no
      `updatedAt` precondition, and `writeWikiArtifact` stores the body
      unconditionally. Story 1.7's refresh deliberately does not disturb an open
      editor, so a draft can legitimately outlive several bumps and then
      overwrite them. `PUT /api/wiki/[slug]` has the same property — this is the
      inherited pattern, not a new one — but the artifact is the single file
      every ingest, chat and lint prompt reads, so the blast radius is larger.
      The storage contract already exposes a compare-and-set write; what is
      missing is a version on the payload and a decision about what the column
      shows on conflict, which is the same conflict-surface design spec-1-7
      deferred for the Preview.
    location: >-
      src/app/api/workbench/artifact/route.ts, src/lib/wikis.ts (writeWikiArtifact)
    severity: medium
  - summary: >-
      A Preview left open on `schema.md` across a Scenario Template re-apply
      shows pre-template bytes, and saving them silently reverts the re-apply.
    evidence: |-
      `applyScenarioTemplate` rewrites `schema.md` through `seedWikiArtifacts`,
      which by this spec's own Never list does not bump `dataVersion` (DW-49).
      `PreviewPane`'s fetch effect re-runs only on `[selection, dataVersion,
      editing]`, and a re-apply moves none of the three — the Wiki id, the mode
      and the tree tab are unchanged, so `Workbench`'s selection-reset effect
      does not fire either. Before this story that stale column was read-only;
      it is now writable, so Edit → Save writes the pre-template Schema back over
      the freshly seeded one with a success message. Closing it means deciding
      whether seeding and re-apply bump the counter, which belongs with the
      story that owns those flows.
    location: >-
      src/lib/wikis.ts (seedWikiArtifacts / applyScenarioTemplate), src/components/workbench/PreviewColumn.tsx
    severity: medium
  - summary: >-
      FR-34's other half is still unbuilt — `purpose.md` is editable from no
      surface, and the narrow allowlist now pins that shut.
    evidence: |-
      PRD FR-34 reads "Christian can view/edit purpose and Schema from Settings
      or Wiki tree", and the UX run names both files. This story's acceptance
      covers Schema alone, so the exclusion is correct here — but it is now an
      asserted invariant (`expect(EDITABLE_ARTIFACT_FILES).not.toContain(
      "purpose.md")`), so a later story must edit a test to open it. Opening it
      also needs an answer to what `purpose.md` must contain to be valid (the
      Schema's `hasPageConventions` has no analogue) and to how it reconciles
      with the tenant-global workspace profile (DW-14, DW-21), which is why it
      was not simply widened here.
    location: >-
      src/lib/wiki-scenarios.ts (EDITABLE_ARTIFACT_FILES)
    severity: low
  - summary: >-
      An overwritten Schema has no recovery path — the artifact write takes no
      revision snapshot, while the page write it is modelled on does.
    evidence: |-
      `writeWikiPageWithSideEffects` calls `saveRevision(slug, existing, …)`
      (`src/lib/wiki.ts:442`) before it overwrites, and `GET/POST
      /api/wiki/[slug]/revisions` can revert a page. `writeWikiArtifact` writes
      through `putWikiArtifact` with no prior read and no snapshot, so the
      previous `schema.md` is simply gone. That was harmless while the file was
      seed-only and immutable; it is not once the file is editable, and this is
      the single file every ingest, chat and lint prompt reads. The story's
      Design Notes deliberately enumerate the artifact tail as log + bump, so
      this is a decided omission rather than a missed one — but revisioning is
      not an index/backlink concern the artifact class lacks, it is the recovery
      path, and closing it needs a decision about where artifact revisions live
      (the `revisions/` silo is slug-keyed) that this story does not own.
    location: >-
      src/lib/wikis.ts (writeWikiArtifact / putWikiArtifact), src/lib/revisions.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** A Wiki's `schema.md` is the executable half of AD-10 — `loadPageConventions()` reads the ACTIVE Wiki's copy and hands its `## Page conventions` body to every ingest, chat and lint prompt — but nothing in the app can change it. `seedWikiArtifacts` (`wikis.ts:280-296`) writes it once at create/re-template and the only other way to move it is applying a different Scenario Template, which overwrites the whole file. The Preview even declares it read-only on purpose: `api/workbench/preview/route.ts:184-187` sets `editable: slug !== undefined`, so `schema.md` renders and cannot be edited. The owner is therefore stuck on whatever their template seeded, and FR-34's "changes apply to subsequent Ingest/Chat/Lint" is unreachable.

**Approach:** Make `schema.md` — and only `schema.md` — an editable target of the Preview's existing confirm-gated editor: the route marks it editable, the column saves it through one new gated `PUT` route, and that route writes through one new artifact writer in `wikis.ts` that fires the two kernel-tail side effects an artifact actually has (activity log + `dataVersion` bump). No second markdown writer, no second copy of the conventions rule, no second editor.

## Boundaries & Constraints

**Always:**
- **`schema.md` is a Wiki ARTIFACT, not a Page, and the write reflects that.** Its bytes live at `tenants/<t>/wikis/<id>/schema.md` (`wikis.ts:110-117`), deliberately outside `tenants/<t>/wiki/` so `reconcileSilos()` cannot delete it as an unindexed orphan (`wikis.ts:12-14`, DW-17). So the save does NOT go through `writeWikiPageWithSideEffects`: that pipeline validates a slug, writes under the wiki root, rewrites `wiki/index.md` and cross-references, and would both put Schema in the Knowledge tree and leave `readActiveWikiSchema()` (`wikis.ts:446-464`) reading the file nobody edited. What the epic's one-write-path rule actually forbids is a SECOND writer for a class of bytes and a bypassed side-effect tail; this story adds exactly one writer for artifacts, beside the seeder that already owns that path, and fires the side effects an artifact has.
- **One expression of the artifact layout.** The new writer and `seedWikiArtifacts` both address bytes through `wikiArtifactPath(owner, wikiId, file)`; nothing else in the repo may spell `tenants/<t>/wikis/<id>/…`.
- **The kernel tail fires.** A successful Schema write appends to `wiki/log.md` through `appendToLog` (`wiki-log.ts:48`) and bumps the counter through `bumpDataVersion()` (`data-version.ts:116`) — both fail-soft, in the same shape as `lifecycle.ts:665-670`: a log or counter hiccup must never turn a save that already landed into a failure.
- **The conventions rule is read, never re-expressed.** Whatever decides "does this Schema still carry page conventions" composes `extractSection` + `sectionBody` + `PAGE_CONVENTIONS_HEADING` from `schema-source.ts:23,58-76` — the same primitives `loadPageConventions()` uses. A second regex over `## Page conventions` anywhere is the forked copy AD-10 forbids.
- **The gate is re-derived server-side.** The write route resolves the principal with `getPrincipal()` and the target Wiki id from `getWikiRegistry(principal.handle).currentId`; the browser never names the Wiki, the tenant or the storage key.
- **One editor, one save client.** The Preview column keeps a single confirm-gated `<textarea>` and a single `savePreviewBody` call; which URL that call targets is decided by one exported pure function, not by a branch typed into the component.
- **Every decision the node suite cannot execute in a DOM is a pure function.** `vitest.config.ts` is `environment: "node"` (DW-15); rules that live inside a React effect can only be grepped for, so the write target, the edit copy and the "may this be edited" test are all functions `workbench-preview.test.ts` runs.

**Block If:**
- Making Schema editable would require partitioning Pages per Wiki, moving the artifacts under `tenants/<t>/wiki/`, or otherwise reopening DW-17.
- The only way to satisfy "save through the kernel write path" turns out to demand that `schema.md` acquire a slug and a page-index entry.

**Never:**
- **Never** write `schema.md` through `writeWikiPage`, `writeWikiPageWithSideEffects`, `runPageLifecycleOp` or `PUT /api/wiki/[slug]`, and never give it a slug or a page-index entry.
- **Never** make `purpose.md` editable in this story. It is the other half of FR-34 and it is deliberately out of scope here: the story's acceptance is about Schema, `purpose.md` has no runtime reader at all today (DW-16), and its content overlaps the tenant-global workspace profile whose reconciliation (DW-14, DW-21) is a design decision this story does not own. The allowlist is a named constant so adding it later is one line.
- **Never** reconcile `schema.md` with the workspace profile, gate a Wiki switch, or touch `saveWorkspaceProfile` — DW-14/DW-21 stay open.
- **Never** bump `dataVersion` from `seedWikiArtifacts`, `createWiki` or `applyScenarioTemplate`. DW-49's seeding half belongs to whichever story owns those flows; this story closes only the Schema-edit half.
- **Never** add a second refresh mechanism. The column still owns no `useRouter`; a landed save calls `requestDataVersionCheck()` exactly as `PreviewColumn.tsx:290` already does.
- **Never** edit the repo-root `SCHEMA.md`, and never change `loadPageConventions`'s fallback ladder or `loadPageTemplates`.
- **Never** add a dependency, a DOM test environment, `@testing-library/*`, a rich-text or WYSIWYG affordance, a second overlay level, a non-English sentence, or `Georgia`/`serif` under `src/components/workbench`.
- **Never** modify a pre-existing test file other than `src/lib/__tests__/workbench-preview.test.ts` and `src/lib/__tests__/workbench-left-column.test.ts`, and in the latter only the three source literals this story deliberately changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Schema is offered for editing | `GET /api/workbench/preview?kind=file&path=schema.md`, signed-in owner, a current Wiki | 200 with `format: "markdown"`, `editable: true`, `artifact: "schema.md"`, no `slug` | No error expected |
| The other artifact stays read-only | same, `path=purpose.md` | 200 with `editable: false` and no `artifact` field | No error expected |
| No current Wiki | registry empty, `path=schema.md` | 404, the same single `{ error: "Not found." }` body every other refusal answers | No existence oracle |
| Owner saves a valid Schema | `PUT /api/workbench/artifact?path=schema.md`, `{ content }` whose `## Page conventions` body is non-empty | 200 `{ ok: true }`; the bytes are at `tenants/<t>/wikis/<id>/schema.md`; one `edit` line in `wiki/log.md`; `dataVersion` exactly one higher | No error expected |
| The edit reaches the prompts | after that save | `loadPageConventions()` with no argument returns the EDITED section | Falls back to root `SCHEMA.md` only per the pre-existing ladder |
| Signed-out save | no principal | 401 `{ error: "Sign in required." }`, nothing written, no bump | Read-only refusal |
| Read-only deployment | `YOPEDIA_READONLY=1` | 403 `{ error }`, nothing written | Same shape as `wikis/[id]/template/route.ts:24-29` |
| Any path that is not the editable artifact | `path=purpose.md`, `path=wiki/alpha.md`, `path=../secrets`, `path` absent | ONE 400 `{ error }`, identical for all four, nothing written | Uniform: the write route grants no oracle either |
| No current Wiki on save | registry empty | 404 `{ error: "Wiki not found." }`, nothing written | — |
| Schema without page conventions | content whose `## Page conventions` section is missing or has an empty body | 400 with a sentence naming the section; nothing written | The editor stays open holding the owner's text |
| Oversized Schema | content longer than `PREVIEW_MAX_CHARS` | 400 with a sentence; nothing written | Prevents saving a Schema the Preview would then truncate and refuse to edit |
| Empty or non-string content | `{ content: "" }`, `{ content: 3 }`, unparseable JSON | 400 `{ error }` | The Save button already refuses a blank draft client-side |
| Storage write throws | provider rejects | 500 `{ error }`, no bump, no log line | Logged via `logger` |
| Log or bump throws | `appendToLog` / `bumpDataVersion` rejects after the bytes landed | still 200 — the save succeeded | Warned, never surfaced as a failed save |
| Save lands while another row is showing | owner picks another file mid-flight | The save completes; nothing is stamped onto the new row's payload and focus is not pulled | Same guard as the page path |

</intent-contract>

## Code Map

**New:**
- `src/app/api/workbench/artifact/route.ts` — the gated write. Structure copied from `api/wikis/[id]/template/route.ts:19-48` (principal → `isReadOnly()` → `request.json()` → `ClientInputError` ⇒ 400 / else 500) with the `NO_STORE` + `json()` helpers of `api/workbench/preview/route.ts:47-62`. Reads `?path=` from the URL, refuses anything not in `EDITABLE_ARTIFACT_FILES` with one 400, resolves `currentId` exactly as `preview/route.ts:137-144` does, validates the content, calls `writeWikiArtifact`, answers `{ ok: true }`.
- `src/lib/__tests__/wiki-schema-edit.test.ts` — the one new test file. Fixture shape from `wiki-schema-source.test.ts:24-45` (temp `DATA_DIR`, `NEXT_PUBLIC_OWNER_HANDLE`, `_resetLocks()`, `_resetStorage()`) plus the hoisted `getPrincipal` mock and lazy route import of `workbench-preview.test.ts:28-31,893-897`.

**Extend:**
- `src/lib/wiki-scenarios.ts:57-58` — beside `WIKI_ARTIFACT_FILES`/`WikiArtifactFile`, add `EDITABLE_ARTIFACT_FILES = ["schema.md"] as const`, `EditableArtifactFile`, and `isEditableArtifactFile(value: unknown)`. This module is pure and client-safe (`wikis.ts:72-75` says so, and `workbench-files.ts:44` and the create dialog both import it), which is why the allowlist lives here rather than in `wikis.ts`: `workbench-preview.ts` is imported by the browser and must be able to name the type.
- `src/lib/schema-source.ts:23,58-76` — add `hasPageConventions(content: string): boolean` composed from the existing `extractSection` + `sectionBody` + `PAGE_CONVENTIONS_HEADING`, and the refusal sentence that names the section. Nothing new about `##` parsing is written here.
- `src/lib/wikis.ts:280-296` — split the byte-write out of `seedWikiArtifacts` into an UNLOCKED helper (`seedWikiArtifacts` already runs inside `withFileLock(lockKey(owner))` via `createWiki:330`/`applyScenarioTemplate:368`, and `withFileLock` is NOT reentrant — `lock.ts:41-52` chains on the key, so taking `wikis:<tenant>` again from inside would deadlock). Add the exported `writeWikiArtifact(owner, wikiId, file, content)`: take `lockKey(owner)` for the write alone, then, AFTER the lock is released, `appendToLog("edit", …)` and `bumpDataVersion()`, each in its own warning `try/catch`. Both imports are new to this module and neither closes a cycle — `data-version.ts` imports only storage/lock/logger, and `wiki-log.ts` imports `./wiki`, which `wikis.ts:44` already imports.
- `src/lib/workbench-preview.ts:84-125,182-186,225-244,389-415` — `artifact?: EditableArtifactFile` on `PreviewPayload` beside `slug?`; `ARTIFACT_WRITE_ROUTE = "/api/workbench/artifact"` and `artifactWriteUrl(file)` beside `PAGE_WRITE_ROUTE`/`pageWriteUrl`; `previewWriteTarget(payload)` returning `{ kind, key, url } | null`; `previewEditCopy(target)` returning the confirm title/body and the save fallback; `canEditPreview` re-expressed over `previewWriteTarget`; `savePreviewBody`'s first parameter becomes the write URL instead of a slug; `isPreviewPayload` unchanged (it checks only fields the column reads during render).
- `src/app/api/workbench/preview/route.ts:177-189` — the file payload gains `...(artifact ? { artifact } : {})` and `editable` becomes "a `wiki/` page slug OR the editable artifact". The page branch at `:106-128` and the `NOT_FOUND` discipline at `:53-58` are untouched.
- `src/components/workbench/PreviewColumn.tsx:138,186-197,240-250,252-296,454-463` — `editingSlugRef` becomes `editingTargetRef` holding the `PreviewWriteTarget` the editor was seeded from; `save` reads it, re-checks `previewWriteTarget(payloadRef.current)?.key`, and passes `target.url` to `savePreviewBody`; the reset block clears the ref; the `ConfirmDialog` title/body and the save fallback come from `previewEditCopy`. `useRouter` stays absent, `requestDataVersionCheck()` at `:290` stays, the deps at `:223` stay `[selection, dataVersion, editing]`.
- `src/lib/__tests__/workbench-preview.test.ts:34-48,477-497,1262-1360` — the `savePreviewBody` call sites take `pageWriteUrl("alpha")`, `canEditPreview` grows the artifact cases, and the route describe block gains a current-Wiki fixture. Its existing 404-parity test at `:933-948` (which relies on `purpose.md` resolving to nothing without a Wiki) must keep passing in its own no-Wiki block.
- `src/lib/__tests__/workbench-left-column.test.ts:319,336,345` — exactly three pinned source literals: `savePreviewBody(slug, draft`, `const slug = editingSlugRef.current;`, `editingSlugRef.current = null`. Re-pin them at the new names, and keep `if (payloadRef.current?.slug !== slug) return;` (`:331`) pinned as its target-key equivalent. Nothing else in that file changes.

**Reuse as-is (do not fork, do not edit):**
- `src/lib/schema.ts:39-55` `loadPageConventions` — the ONE loader. This story adds no reader and changes no fallback; the round-trip test proves the edit arrives through it.
- `src/lib/wikis.ts:110-117` `wikiArtifactPath`, `:426-437` `readWikiArtifact`, `:119-121` `lockKey` — the layout, the read and the lock key already exist.
- `src/lib/workbench-files.ts:377-379` `isArtifactFile`, `:426-461` `resolveWorkbenchFile` — the read side already resolves `schema.md` through `readWikiArtifact` and already refuses it without a current Wiki. The write route does not re-use `resolveWorkbenchFile` (it resolves reads under `wiki/`/`raw/` too), it re-uses the same allowlist idea via `isEditableArtifactFile`.
- `src/lib/data-version.ts:116` `bumpDataVersion`, `src/lib/wiki-log.ts:48` `appendToLog`, `src/lib/auth.ts` `getPrincipal`, `src/lib/config.ts:79` `isReadOnly`, `src/lib/errors.ts` `ClientInputError`/`getErrorMessage`, `src/lib/logger.ts`.
- `src/components/ConfirmDialog.tsx` — the one overlay level; only its props change.

**Read-only constraints (do not regress):**
- `workbench-left-column.test.ts:253-364` — the whole view-first pin set: `setEditing(true)` appears exactly once, no `fetch(` and no `method: "PUT"` in the column, `readOnly={saving}` not `disabled`, `draft.trim().length === 0`, `canEditPreview(payload)`, `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`, the `[selection, dataVersion, editing]` deps, `setEditing(false)` inside the fetch effect.
- `workbench-left-column.test.ts:367-376` (no `router.push(`), `:437-446` (no `useRouter` in `Workbench`), `workbench-chrome.test.ts:130-134,284-299` (no router, no serif under `src/components/workbench`).
- `workbench-preview.test.ts:923-1081` — the route's existing payloads: a page is `editable: true`, a `raw/` file is `editable: false` with no slug, an unsupported format reads no bytes, and gated-out/absent/traversal answer one identical 404.
- `workbench-data-version.test.ts` — the watcher, the poll and the bump wiring; this story adds a second bump SOURCE and must not move the counter's definition, its route, or `lifecycle.ts`'s single call site.
- `wiki-schema-source.test.ts` — `loadPageConventions` resolves the active Wiki's Schema and degrades to the root file; every assertion must still hold with an artifact writer in the module.
- `wikis.test.ts`, `create-wiki-ui.test.ts` — create/re-template/switch semantics, including that seeding writes `purpose.md`, `schema.md` and the profile and nothing else.
- `brand-copy.test.ts` — new user-visible sentences say work-wiki, never `Yopedia`; new identifiers keep `yopedia` spellings where they exist.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-scenarios.ts` -- add `EDITABLE_ARTIFACT_FILES`, `EditableArtifactFile` and `isEditableArtifactFile` beside the existing artifact list -- the allowlist has to be nameable from the browser bundle (`workbench-preview.ts`) and from the route, and this module is the one place that is already both pure and shared; declaring it in `wikis.ts` would drag storage into the client chunk.
- `src/lib/schema-source.ts` -- add `hasPageConventions(content)` composed from `extractSection`/`sectionBody`/`PAGE_CONVENTIONS_HEADING`, plus the sentence the route returns when it is false -- a Schema saved without that section is silently INERT (`loadPageConventions` falls back to the root file, `schema.ts:42-51`), so the owner would edit a file that no longer steers anything and nothing would say so; composing the loader's own primitives is also what keeps AD-10's "no forked copy of the conventions" true.
- `src/lib/wikis.ts` -- extract the unlocked artifact byte-write, add `writeWikiArtifact(owner, wikiId, file, content)` that locks only the write and then fires `appendToLog` and `bumpDataVersion` fail-soft outside the lock -- one function is what makes "an artifact write has a tail" true for every future caller, and doing the tail outside `wikis:<tenant>` keeps a non-reentrant lock from being taken twice and avoids the lock-ordering hazard DW-22 already records.
- `src/app/api/workbench/artifact/route.ts` -- new `PUT`: `getPrincipal()` gate, `isReadOnly()` refusal, one 400 for every path that is not the editable artifact, `currentId` from the registry, content validation (non-empty string, within `PREVIEW_MAX_CHARS`, `hasPageConventions`), then `writeWikiArtifact` and `{ ok: true }` with `private, no-store` -- the browser cannot address storage, and a write route that accepted a client-named Wiki id or an arbitrary display path would be a second, wider door onto the same bytes than the read route has.
- `src/lib/workbench-preview.ts` -- add `artifact?` to the payload, the artifact route + URL builder, `previewWriteTarget`, `previewEditCopy`, re-express `canEditPreview` over the target, and change `savePreviewBody`'s first argument to the write URL -- there is no DOM test environment, so "which URL does Save go to" and "which sentence does the confirm dialog show" must be functions the node suite executes rather than branches typed into JSX, and one save client is what stops a second `fetch` from appearing in the column.
- `src/app/api/workbench/preview/route.ts` -- emit `artifact` and set `editable` for the editable artifact in the file branch only -- the column decides nothing about what may be written; the same server that gates the read decides what it will accept a write for.
- `src/components/workbench/PreviewColumn.tsx` -- replace the slug-keyed editor refs and the save call with the target-keyed pair, and take the confirm copy from `previewEditCopy` -- the epic requires Schema editing to SHARE 1.5's implementation rather than duplicate it, and the cross-row guard has to compare the same key the save targets or a pick made mid-save could write one file's draft to another's URL.
- `src/lib/__tests__/workbench-preview.test.ts` -- update the `savePreviewBody` call sites to pass a URL, add `canEditPreview` cases for an artifact payload and for a payload that is `editable` with neither slug nor artifact, and add a route block with a real current Wiki asserting the `schema.md` payload -- these are this story's own surfaces; every other assertion in the file must still pass untouched.
- `src/lib/__tests__/workbench-left-column.test.ts` -- re-pin only the three literals named in the Code Map -- the pin is what this story deliberately changes; the rest of the view-first pin set is a read-only constraint.
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- new: execute every I/O matrix row against a temp `DATA_DIR` (the route for each status, the writer for the bytes/log/bump, `hasPageConventions` directly, `previewWriteTarget`/`previewEditCopy`/`canEditPreview` directly), prove the round trip `createWiki` → `writeWikiArtifact` → `loadPageConventions()` returns the EDITED conventions, prove the page index and page count are unchanged by a Schema save, and source-scan `PreviewColumn.tsx` and the two routes for the wiring a node suite cannot execute -- the whole story is invisible when it works, and the two things most likely to rot silently are the tail (log + bump) and the target selection.

**Acceptance Criteria:**
- Given a signed-in owner with a current Wiki, when they select `schema.md` in the Files tab and press Edit, then the confirm dialog names the Schema rather than a page, confirming opens the raw markdown of that Wiki's own `schema.md`, and Cancel or Esc leaves with nothing written.
- Given the owner saves an edited Schema, when the save returns 200, then a subsequent no-argument `loadPageConventions()` returns the edited `## Page conventions` section — so the next ingest, chat and lint prompt carries it — and no copy of those conventions exists anywhere in code.
- Given the owner saves, when `dataVersion` bumps, then the watcher refreshes and the Preview re-reads `schema.md` and shows the saved text without a full page reload, with the mode, tree tab, selection, scroll offset and column widths all preserved.
- Given a Schema save succeeds, when the storage is inspected, then `tenants/<t>/wikis/<id>/schema.md` is the only changed file: no `wiki/` file, no `wiki/index.md` entry, no page-count change, no workspace-profile write, and `purpose.md` untouched.
- Given a Page selection, when the owner edits and saves it, then it still writes through `PUT /api/wiki/[slug]` and behaves exactly as Story 1.5 shipped — the shared editor gains a second target without changing the first one's behaviour.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and the only pre-existing test files modified are `workbench-preview.test.ts` and `workbench-left-column.test.ts`.

## Spec Change Log

### 2026-08-16 — Implementation run

Two deviations from the **Never** list, both forced by an incomplete enumeration
in the spec rather than by a design choice. In each case a THIRD pre-existing
test file pins something this story is explicitly instructed to change, so
satisfying the Never clause and the Code Map at once is impossible.

- **`workbench-data-version.test.ts:724` pinned `editingSlugRef.current = null`**
  inside `PreviewColumn`'s reset block (Story 1.7 added it). The Code Map
  requires `editingSlugRef` → `editingTargetRef`, and lists the re-pin only for
  `workbench-left-column.test.ts:345` — it did not notice the second copy. One
  string literal changed; the assertion still pins the same line for the same
  reason.
- **`workbench-data-version.test.ts:590` asserted that `bumpDataVersion(` appears
  in exactly two files.** This story adds a third by design — the spec's own
  Read-only-constraints entry says so ("this story adds a second bump SOURCE")
  while the Never list forbids editing the file that asserts it. The expected
  list gained `lib/wikis.ts`; the surrounding claim (seeding and every other
  bypasser of the write path still do not bump) is unchanged and still enforced.

Nothing else in that file was touched. The acceptance criterion "the only
pre-existing test files modified are `workbench-preview.test.ts` and
`workbench-left-column.test.ts`" reads as three files instead of two.

## Review Triage Log

### 2026-08-16 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 3: (high 0, medium 2, low 1)
- reject: 22: (high 0, medium 2, low 20)
- addressed_findings:
  - `[medium]` `[patch]` A Schema with a leading YAML block round-tripped LOSSILY. `bodyFor` ran `stripFrontmatterBlock` for every markdown payload, artifacts included, while the artifact `PUT` stores `content` as the whole file — so an owner who put a `---` block at the top of `schema.md` read it back without the block and the next save deleted it silently, answered with a 200 and a `dataVersion` bump. `bodyFor` gained a `whole` flag that the file branch passes for an artifact; the Page branch and the `raw/` branch strip exactly as before. Pinned by a full PUT → GET → re-PUT round trip and by a companion test that a PAGE still strips.
  - `[medium]` `[patch]` The write was gated on `getPrincipal()` alone, so any signed-in principal could save. Their bytes land under their OWN tenant while `readActiveWikiSchema()` resolves the executing Schema from `getOwnerHandle()` — a 200, a log line and a bump for a save that reaches no prompt, which is the silently-inert save `hasPageConventions` exists to prevent arriving by another door. The route now refuses a non-owner with `isOwnerHandle(principal.handle)` → 403, in the same shape as the read-only refusal.
  - `[low]` `[patch]` `writeWikiArtifact`'s `file` parameter was `WikiArtifactFile`, so the allowlist lived only in the route and a future caller could write `purpose.md` through the one writer without ever passing `isEditableArtifactFile` — at which point its log line, which names the Schema, would be a lie. Narrowed to `EditableArtifactFile`, so the compiler carries the guarantee; pinned by a `@ts-expect-error` (enforced by `npx tsc --noEmit`) and by a source pin on the signature, since a suite that never type-checks would stay green on the widened form.
  - `[low]` `[patch]` `hasPageConventions(content: string)` branched on `typeof content !== "string"`, a guard its own signature said was unreachable — which is why the test had to reach it through a cast. Typed `unknown`, like its sibling `isEditableArtifactFile`; the cast is gone and the non-string cases are asserted directly.
  - `[low]` `[patch]` `startEditing` guarded on `payload` but not on there being a write TARGET, so a silent same-row refresh (Story 1.7) landing a truncated or no-longer-editable payload while the confirm dialog was open opened the editor with `editingTargetRef.current = null` — and `Save` then neither wrote nor said why, the outcome `previewWriteTarget`'s own docblock names as the worst of the three. It now computes the target, closes the dialog and stays view-first when there is none.
  - `[low]` `[patch]` `PAGE_CONVENTIONS_REQUIRED_COPY` used straight double quotes beside siblings that use typographic marks (`couldn’t`, `Wiki’s`), and `PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE` lowercased the domain noun `Wiki`. Both corrected, and the register is now pinned rather than left to review.

### 2026-08-16 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1: (high 0, medium 1, low 0)
- reject: 26: (high 0, medium 2, low 24)
- addressed_findings:
  - `[medium]` `[patch]` The story's own edit to `workbench-data-version.test.ts`
    RETIRED an enforcement of this spec's Never list. The `bumpDataVersion` guard
    is file-granular: it collects filenames containing `bumpDataVersion(` and
    compares the set. Adding `lib/wikis.ts` to the expected set bought a blanket
    exemption for the whole module — and `seedWikiArtifacts`, `createWiki` and
    `applyScenarioTemplate` all live in that module and are all forbidden from
    bumping. The companion count assertion (`toHaveLength(1)`) is scoped to
    `lib/lifecycle.ts` only, so a bump added to `applyScenarioTemplate` would
    have passed every test in the suite. Added the matching count assertion for
    `lib/wikis.ts`, plus a position check that its one bump sits inside
    `writeWikiArtifact`.
  - `[low]` `[patch]` `GET /api/workbench/preview` marked `schema.md`
    `editable: true` on a read-only deployment, where `PUT
    /api/workbench/artifact` answers 403 to every save — so the owner would open
    the confirm dialog, retype an executable Schema and be refused at `Save`.
    The artifact half of `editable` now consults the same `isReadOnly()` the
    write route refuses on. The page half deliberately does NOT: `PUT
    /api/wiki/[slug]` has no read-only check at all, so a page save on such a
    deployment still lands and claiming otherwise would be the drift. Pinned by
    an executed route test, not only by the source scan.
  - `[low]` `[patch]` The activity-log line was `Schema — schema.md` with no
    Wiki. `wiki/log.md` is tenant-global while `schema.md` is per Wiki, so with
    a second Wiki the entry could not say whose Schema moved. The id now rides
    `appendToLog`'s existing `details` argument, so it is still exactly ONE
    entry.

### 2026-08-16 — Review pass (follow-up 2)

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 0
- reject: 27: (high 0, medium 4, low 23)
- addressed_findings:
  - `[medium]` `[patch]` The read route's `editable` consulted `isReadOnly()` but
    not the OTHER 403 the write route answers. `isOwnerHandle` is false for
    everyone when `NEXT_PUBLIC_OWNER_HANDLE` is unset (`owner.ts`), and the
    Workbench is signed-in-gated rather than owner-gated (`page.tsx`) — so on an
    owner-less deployment `Edit` was offered for `schema.md` while every save
    answered 403, which is exactly the walk-the-dialog-then-refuse drift the
    previous pass folded `isReadOnly()` in to prevent. `editable`'s artifact half
    now carries both conditions. The signed-in NON-owner case turned out not to
    be reachable at all — the read resolves the Wiki from the caller's own
    registry, so someone else's tenant 404s — and the new test asserts that
    rather than the reviewer's claim. `workbench-preview.test.ts`'s route block
    had to start naming an owner: its `editable: true` assertion was being made
    in the one configuration where no save can land.
  - `[low]` `[patch]` Nothing asserted that a SEEDED Schema satisfies the gate it
    is later validated against. The story makes `seedWikiArtifacts`' own bytes
    editable, so `hasPageConventions` over every creatable scenario's rendered
    Schema is a precondition of the round trip — without it a template that ever
    rendered an empty section would let the owner open the seeded Schema, change
    one word, and be told it is invalid. Pinned for every scenario plus an
    end-to-end read → save of the seeded bytes.
  - `[low]` `[patch]` `PreviewPayload.body`'s docblock still read "never the YAML
    block, which the server strips" — flatly false for the artifact case this
    story added, at the field an implementer reads. Restated per kind.

Rejected as noise or as already-recorded, notably: the raw `getErrorMessage`
message on a 500 (the inherited shape of `wikis/[id]/template/route.ts`, which
the Code Map instructs copying); an unanchored `## Page conventions` match
(anchoring it would FORK the predicate from `loadPageConventions`' own
primitives, which is what AD-10 forbids); lost-update and missing-revision
protection (already deferred); and the claim that a Wiki switch leaves the editor
open — `Workbench`'s reset effect calls `setSelection(null)` on `currentWikiId`,
which closes it. See Residual risks for what survives of that last one.

## Design Notes

**Why not `writeWikiPageWithSideEffects`.** The epic's one-write-path rule exists so index, log, backlink and embedding side effects cannot be skipped by a second markdown writer. `schema.md` has none of the first, third or fourth: it has no slug, it is not in the page index, nothing links to it, and it is not embedded. Routing it through the page pipeline would not "add" those side effects — it would MOVE the file into `tenants/<t>/wiki/`, where `readActiveWikiSchema()` does not look and where the Knowledge tree would show it as a page. The two tail effects an artifact genuinely has are the activity log and the refresh counter, and this story fires both from one function, which is the same guarantee applied to the right class of bytes.

**Why the tail runs outside the lock.**

```ts
export async function writeWikiArtifact(owner, wikiId, file, content) {
  await withFileLock(lockKey(owner), () => putWikiArtifact(owner, wikiId, file, content));
  // AFTER the lock: `appendToLog` takes "log.md" and `bumpDataVersion` takes
  // DATA_VERSION_LOCK, and holding `wikis:<tenant>` across either is the
  // lock-ordering hazard DW-22 already records against this module.
  try { await appendToLog("edit", `Schema — ${file}`); } catch (err) { logger.warn(...); }
  try { await bumpDataVersion(); } catch (err) { logger.warn(...); }
}
```

`withFileLock` is not reentrant (`lock.ts:41-52` chains a new call onto the key's existing promise), so the byte-write helper must stay callable from inside `seedWikiArtifacts`, which already holds `wikis:<tenant>`.

**Why the write target is a function, not a branch.** The column must decide two things it cannot decide from a slug alone: which URL Save posts to, and whether the thing on screen is still the thing the draft came from. Both are one value.

```ts
export type PreviewWriteTarget =
  | { kind: "page"; key: string; url: string }
  | { kind: "artifact"; key: string; url: string };

export function previewWriteTarget(p: PreviewPayload | null): PreviewWriteTarget | null {
  if (!p || !p.editable || p.truncated) return null;
  if (typeof p.slug === "string" && p.slug) {
    return { kind: "page", key: `page:${p.slug}`, url: pageWriteUrl(p.slug) };
  }
  if (isEditableArtifactFile(p.artifact)) {
    return { kind: "artifact", key: `artifact:${p.artifact}`, url: artifactWriteUrl(p.artifact) };
  }
  return null;               // editable with no target = a Save that does nothing
}
```

`canEditPreview` becomes `previewWriteTarget(payload) !== null`, which keeps the truncation half of Story 1.5's rule (saving a capped PREFIX over the whole file) attached to the decision instead of beside it — and now covers the Schema, where the same mistake would replace an executable Schema with its first 200,000 characters.

**Why a Schema without page conventions is refused.** `loadPageConventions` deliberately falls back to the repo-root `SCHEMA.md` when the Wiki's section is empty, so that a hand-emptied file cannot strip the prompt (`schema.ts:22-24,45-51`). That fallback is right for a file nobody edited and wrong as a response to a deliberate save: the owner would be told the save succeeded while their Schema stopped steering anything. The route answers with a sentence instead, and the client already relays a server-supplied `{ error }` verbatim (`workbench-preview.ts:386-388`), so no new Copy-table entry is needed for it.

## Verification

**Commands:**
- `npx vitest run` -- expected: green. Baseline is 204 files / 4,166 tests; this story adds one file.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors (the pre-existing `jsx-ast-utils` TSNonNullExpression notices are not errors).
- `git status --porcelain src/lib/__tests__ src/components/__tests__` -- expected: exactly three entries — the untracked `wiki-schema-edit.test.ts` and the modified `workbench-preview.test.ts` and `workbench-left-column.test.ts`.
- `grep -rn "wikis/" src --include=*.ts --include=*.tsx | grep -v "from \"" ` -- expected: no new expression of the `tenants/<t>/wikis/<id>/` layout outside `wikis.ts`.
- `grep -rn "writeWikiArtifact(" src` -- expected: its definition, exactly one call site in the artifact route, and the new test file.
- `grep -rn "Page conventions" src --include=*.ts --include=*.tsx` -- expected: only `schema-source.ts` (the heading const and the new predicate), `schema.ts`'s docblock, `wiki-scenarios.ts`'s renderer, and tests — no second parser.
- `grep -rn "useRouter\|router.refresh" src/components/workbench` -- expected: `WikiSwitcher.tsx` and `DataVersionWatcher.tsx` only.
- `grep -rn "Georgia\|[^-]serif" src/components/workbench` -- expected: only `sans-serif` matches.

**Manual checks (if no CLI):**
- Inspect the artifact route's diff for any use of a client-supplied Wiki id or storage key — there must be none; the id comes from `getWikiRegistry(principal.handle)`.
- Inspect `PreviewColumn.tsx` for any literal `"/api/"` string or a second `savePreviewBody` call — there should be neither.

## Auto Run Result

Status: done

### Summary of implemented change

`schema.md` is now an editable target of the Preview's existing confirm-gated
editor. The read route marks it `editable` and stamps `artifact: "schema.md"`;
the column saves it through one new gated `PUT /api/workbench/artifact`; and that
route writes through one new `writeWikiArtifact` in `wikis.ts` which fires the
two side effects an artifact actually has — the activity log and the
`dataVersion` bump — both fail-soft, outside the tenant lock. No second markdown
writer, no second copy of the conventions rule, no second editor. This pass was a
follow-up review of an already-implemented story; it applied three patches and
made no structural change.

### Files changed

- `src/app/api/workbench/artifact/route.ts` — new gated `PUT`: owner + read-only
  refusals, one uniform 400 for every non-allowlisted path, server-derived Wiki
  id, content validation, then the one writer.
- `src/app/api/workbench/preview/route.ts` — emits `artifact`, serves an artifact
  whole-file, and gates `editable` on the same refusals the write route answers.
- `src/components/workbench/PreviewColumn.tsx` — the editor is keyed to a write
  TARGET rather than a slug; confirm copy and save fallback come from
  `previewEditCopy`.
- `src/lib/workbench-preview.ts` — `artifact` on the payload,
  `ARTIFACT_WRITE_ROUTE`/`artifactWriteUrl`, `previewWriteTarget`,
  `previewEditCopy`, `canEditPreview` re-expressed over the target,
  `savePreviewBody` takes a URL.
- `src/lib/wikis.ts` — `putWikiArtifact` (unlocked bytes, shared with the seeder)
  and the exported `writeWikiArtifact` with its tail.
- `src/lib/schema-source.ts` — `hasPageConventions` composed from the loader's own
  primitives, plus its refusal sentence.
- `src/lib/wiki-scenarios.ts` — `EDITABLE_ARTIFACT_FILES`, `EditableArtifactFile`,
  `isEditableArtifactFile`.
- `src/lib/__tests__/wiki-schema-edit.test.ts` — new: the writer, every route
  status, the round trip to `loadPageConventions()`, the pure decisions, and the
  source scans a node suite cannot execute.
- `src/lib/__tests__/workbench-preview.test.ts`,
  `workbench-left-column.test.ts`, `workbench-data-version.test.ts` — updated
  pins (the third is logged as a deviation in the Spec Change Log).

### Review findings breakdown

- Patches applied: 3 — high 0, medium 1, low 2.
- Items deferred: 0 this pass (four entries from earlier passes stand unchanged).
- Items rejected: 27 — high 0, medium 4, low 23.

### Follow-up review recommendation

`true`. Patched this pass: high 0, medium 1, low 2 → score `3 × 1 + 1 × 2 = 5`,
which meets the threshold of 5.

### Verification performed

- `npx vitest run` — 205 files / 4,220 tests, all passing.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0 (only the pre-existing `jsx-ast-utils` TSNonNullExpression
  notices, which are not errors).
- `grep -rn "wikis/" src …` — the storage layout is constructed only at
  `wikis.ts:119`; every other hit is docblock prose or an `/api/wikis/…` URL.
- `grep -rn "writeWikiArtifact(" src` — its definition, exactly one call site in
  the artifact route, and tests.
- `grep -rn "Page conventions" src …` — no second parser; the new
  `workbench-preview.ts` hit is a Copy sentence.
- `git status --porcelain src/lib/__tests__ src/components/__tests__` — two
  entries this pass rather than the three the spec anticipated, because
  `wiki-schema-edit.test.ts` was already committed by the previous run.

### Residual risks

- **A Wiki switch made mid-edit has a narrow race.** The write route re-derives
  `currentId` at save time while the client's target key is Wiki-agnostic.
  `Workbench`'s reset effect closes the editor when `currentWikiId` changes, so
  the reviewer's claim of an open-ended window does not hold — but that reset
  arrives only when `router.refresh()` lands, so a `Save` clicked inside that
  round trip would write the old Wiki's draft to the new Wiki's `schema.md`.
  Closing it needs a decision that conflicts with the intent's "the browser never
  names the Wiki" rule, so it is recorded here rather than patched.
- The 500 branch relays `getErrorMessage(error)` verbatim, which can carry a
  storage path. This is the inherited shape of `wikis/[id]/template/route.ts`
  that the Code Map instructs copying, so it was not changed here.
- Lost-update protection and a revision snapshot for the artifact write remain
  open; both are already in the `deferred` list above.

