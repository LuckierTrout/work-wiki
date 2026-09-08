---
title: 'DW-213/DW-214 — artifact revision recovery: re-template snapshot and a Workbench history panel'
type: 'feature'
created: '2026-08-21'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The re-template confirm still presents the Schema overwrite as unrecoverable, which
      DW-213 has just made false.
    evidence: |-
      `src/components/WikiWorkbench.tsx:415-419` tells the owner "This overwrites purpose.md,
      Schema, and the Workspace Purpose for this wiki", and the comments at `:222` and `:348`
      call it "an irreversible rewrite" / "an irreversible overwrite". Since this story a
      committed re-template records the replaced `schema.md` as a revision the Preview's
      History panel can list and revert, so the confirm understates what the owner can get
      back. `purpose.md` and the Workspace Purpose are still unrecoverable, so the sentence
      is not simply wrong — it needs to separate the two halves. Copy only; no behaviour.
    location: >-
      src/components/WikiWorkbench.tsx:415-419
    severity: low
baseline_revision: '99fdca7100a5ee6048aae1f5b9ac383be6277421'
---

<intent-contract>

## Intent

**Problem:** DW-59 gave `schema.md` a revision history and an API, but the recovery path is neither complete nor reachable. (a) A COMMITTED re-template (`applyScenarioTemplate` → `seedWikiArtifacts` → `putWikiArtifact`) overwrites an owner-edited `schema.md` with template bytes and takes no snapshot — `snapshotSeededFiles`/`restoreSeededFiles` is a rollback for a FAILED seed only, so a successful one destroys the edited Schema exactly as DW-59 describes. (b) `GET/POST /api/workbench/artifact/revisions` has no client at all, so nothing in the running app lists, views or reverts an artifact revision.

**Approach:** Record the pre-seed `schema.md` bytes as a revision inside `applyScenarioTemplate`'s existing `wikis:<tenant>` lock, after the seed and registry write COMMIT, fail-soft and distinct from the failure rollback — reusing the snapshot `snapshotSeededFiles` already took rather than reading twice. Then give the API a client: history helpers and copy in `src/lib/workbench-preview.ts`, and an expand → list → view → revert panel in `PreviewColumn`, mirroring the shape of `src/components/RevisionHistory.tsx`.

## Boundaries & Constraints

**Always:**
- The re-template snapshot goes through `saveWikiArtifactRevision` — the one writer — inside the lock `applyScenarioTemplate` already holds. Never a second lock key, never `bumpDataVersion`/`appendToLog` from inside it.
- It runs ONLY on the committed path (after `seedWikiArtifacts` + `writeRegistry` both return) and is FAIL-SOFT: a throw is `logger.warn`ed and swallowed, because a re-template that reached storage must not be reported as failed for a history miss. The `catch` branch keeps `restoreSeededFiles` as its only compensation.
- Only `schema.md` is snapshotted — `EDITABLE_ARTIFACT_FILES`, the subset the history API can list and revert. `purpose.md` has no editor and no reachable history.
- The client speaks to `GET/POST /api/workbench/artifact/revisions?path=<file>` and nothing else; the browser names the file only — never a tenant, Wiki id or storage key. The URL is built in `workbench-preview.ts` beside `artifactWriteUrl`, not typed in the component.
- Every fetch helper RESOLVES a result union (never throws), relays only a server-supplied `{ error }` sentence, and otherwise shows a Copy-table fallback — the `savePreviewBody` contract.
- Every rule about WHEN the panel shows or WHAT it says is a pure exported function or constant in `workbench-preview.ts` (node-project tested); the component maps state to elements only.
- Revert is confirm-gated through the existing `ConfirmDialog` (one overlay level, UX-DR17), and is withheld on a read-only deployment BEFORE the confirm (DW-149), with a sentence saying why.
- After a landed revert the panel re-lists and calls `requestDataVersionCheck()` — the same signal a save uses — so the body refetches through the one fetch effect rather than a second read path.
- The panel never shows while the editor is open: a revert under an open draft would replace bytes the draft is measured against.

**Block If:** Nothing — both halves are named surfaces with an existing model to mirror.

**Never:**
- Do not touch `src/lib/revisions.ts`, `RevisionHistory.tsx`, `RevisionItem.tsx` or any page route.
- Do not snapshot inside `putWikiArtifact`/`seedWikiArtifacts`, and do not change what the failure path restores.
- Do not widen `EditableArtifactFile`, add retention/pruning/diffing, or change the revisions route's wire shape or gates.
- Do not import `wiki-artifact-revisions.ts` (or any storage module) from client code — re-declare the wire type in `workbench-preview.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-template over an edited Schema | `schema.md` holds owner bytes | Seed lands; the owner's bytes are a revision listed by `listWikiArtifactRevisions`, authored `owner`, reason naming the re-template | No error expected |
| Re-template of a never-written Schema | pre-seed read was ENOENT (`content: null`) | Seed lands; NO revision written | Absent is the first-write case |
| Re-template fails mid-seed | `writeRegistry` throws | `restoreSeededFiles` runs and the error re-throws; NO revision written | Unchanged compensation |
| Revision write fails on commit | storage rejects the snapshot | Re-template still succeeds and returns the record; `logger.warn` | Fail-soft |
| Panel expanded, revisions exist | artifact payload on screen | List newest-first with date, size, author, reason | Non-200 → server sentence, else fallback copy |
| Panel expanded, none exist | `{ revisions: [] }` | "No earlier versions…" note, no list | — |
| View one revision | a listed timestamp | Its content shown inline; pressing again collapses it | 404/500 → sentence, view closes |
| Revert confirmed | a listed timestamp | Panel re-lists, `requestDataVersionCheck()` fires, body refetches | Failure keeps the panel open with the sentence |
| Revert on a read-only deployment | `readOnly` true | Revert is withheld with a sentence; no confirm, no request | Route's 403 is the backstop |
| Editor open / non-artifact / 404 row | any | No panel at all | — |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1026-1082` — `applyScenarioTemplate`: `snapshotSeededFiles` at `:1047` already holds the pre-seed bytes for both artifacts and the profile; the `try` at `:1051` commits, the `catch` at `:1057` restores. The new record goes after that `try/catch`, still inside the `withWikiLock` callback, before `return wiki`.
- `src/lib/wikis.ts:467-514` — `SeededFileSnapshot` (`{path, content}`) and `seededFilePaths` order: `WIKI_ARTIFACT_FILES` (`purpose.md`, `schema.md`) then `wikiProfilePath`. Match a snapshot entry to a file through `wikiArtifactPath(owner, wikiId, file)` — never by index.
- `src/lib/wikis.ts:744-870` — `writeWikiArtifact`: the fail-soft `saveWikiArtifactRevision` call shape and warn wording to mirror; `normalizeArtifactEditReason` at `:665`.
- `src/lib/wiki-artifact-revisions.ts:157-180` — `saveWikiArtifactRevision(owner, wikiId, file, content, author?, reason?)`; takes no lock by design (`:44`). `listWikiArtifactRevisions` at `:205`, `ArtifactRevision` at `:70` (`timestamp`, `date`, `file`, `sizeBytes`, `author?`, `reason?`) — the wire shape to re-declare client-side.
- `src/app/api/workbench/artifact/revisions/route.ts` — GET list `{revisions}` / `?timestamp=` `{content, revision}`; POST `{action:"revert", timestamp}` → `{ok:true, version}`; refusals are `{error}`; POST is the only verb refused when read-only.
- `src/lib/workbench-preview.ts:328-340` — `ARTIFACT_WRITE_ROUTE`/`artifactWriteUrl`, where the history route and URL builder belong; `:349-382` `PreviewWriteTarget`/`previewWriteTarget` and `:164-233` `previewEditTarget`/`canEditPreview` — the pure-decision idiom to follow; `:985-1038` `savePreviewBody` — the resolve-don't-throw + server-sentence-else-fallback client contract.
- `src/lib/workbench-preview.ts:86-152` — `PreviewPayload`; `artifact` is present only for an artifact row.
- `src/components/workbench/PreviewColumn.tsx:186-470` — `PreviewPane` state, the fetch effect (`:270-410`, deps `[selection, dataVersion, editing, retryNonce]`), and `startEditing`/`save`; `:641-818` the render, including the `ConfirmDialog` at the end and `requestDataVersionCheck()` at `:560`.
- `src/components/RevisionHistory.tsx` — the shape to mirror: `open` toggle fetching on first expand, `viewingTimestamp`/`viewContent` toggle, confirm-then-revert, `readOnly` withheld before the confirm (DW-149) with one shared `readOnlyNoteId` sentence.
- `src/components/workbench/Workbench.tsx:165,1115-1140` — `readOnly` is already in scope from `useWorkbenchData()` and is passed to `WikiSwitcher` at `:1026`; add the same prop to the `PreviewColumn` element.
- `src/app/globals.css:3313-3390` — `.wb-preview-edit`, `.wb-preview-action`, `.wb-preview-note`, `.wb-preview-error` and the `.wb-preview-stale` strip: the chrome geometry and token-only muted treatment new panel classes must reuse (24px minimum control height, no danger colour).
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` — temp `DATA_DIR` harness, `getPrincipal` mock, seed helpers; the place for the re-template cases.
- `src/lib/__tests__/workbench-preview.test.ts` — node-project suite for the new pure functions and fetch helpers (stubbed fetch).
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — mounted-shell harness (`WorkbenchDataProvider`, `writeStoredSelection`, fetch stub answering `schemaPayload()`), reusable for the panel suite.
- `src/lib/__tests__/read-only-copy-parity.test.ts:78-83` — records where a client read-only sentence deliberately narrows the server's; register the new revert sentence there.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- after the commit `try/catch` in `applyScenarioTemplate`, record the pre-seed `schema.md` bytes from `snapshot` as a revision (author `owner`, a reason naming the re-template and the new scenario) in a fail-soft helper; skip when `content === null` -- the destructive operation DW-59 left uncovered.
- `src/lib/workbench-preview.ts` -- add `ARTIFACT_REVISIONS_ROUTE`, `artifactRevisionsUrl(file, timestamp?)`, a client `ArtifactRevisionSummary` type, `fetchArtifactRevisions` / `fetchArtifactRevision` / `revertArtifactRevision` result-union helpers, a `previewHistoryTarget({gone, payload, editing})` decision, and the panel's copy constants -- one client for the API, every rule executable by the node suite.
- `src/components/workbench/PreviewColumn.tsx` -- render a collapsible History section for `previewHistoryTarget`'s answer: expand-fetches-once, list, view-toggle, confirm-gated revert, read-only withholding, and a `requestDataVersionCheck()` + re-list tail -- the reachable half of the recovery path.
- `src/components/workbench/Workbench.tsx` -- pass the shell's `readOnly` to `PreviewColumn` -- the column must refuse before the confirm, not after the 403.
- `src/app/globals.css` -- styles for the new `.wb-preview-history*` classes reusing the existing chrome tokens -- the panel is chrome, not reading surface.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- cover the four re-template rows of the matrix against the temp `DATA_DIR` -- a snapshot that works is invisible.
- `src/lib/__tests__/workbench-preview.test.ts` -- cover the URL builder, the decision function, and every helper branch (ok, server sentence, unparseable body, transport throw) with a stubbed fetch.
- `src/components/workbench/__tests__/preview-revision-history.test.tsx` -- NEW mounted suite: panel absent for a page row and while editing, expand lists, view toggles, revert confirms then re-lists, read-only withholds -- a rule typed into JSX can only be grepped for otherwise.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- assert the new revert sentence narrows `READ_ONLY_REFUSAL.artifactEdit` deliberately.

**Acceptance Criteria:**
- Given a Wiki whose `schema.md` the owner edited, when a different Scenario Template is applied and COMMITS, then the owner's bytes are the newest entry `listWikiArtifactRevisions` returns and reverting to it restores them.
- Given the Schema is showing in the Preview, when the owner expands History, picks an entry and confirms Revert, then the artifact holds that revision's bytes, the pre-revert bytes are a newer revision, and the column shows the reverted body without a reload.
- Given `YOPEDIA_READONLY=1`, when the owner expands History, then the list still renders and no revert can be started from the panel.
- Given `pnpm test`, `pnpm lint` and `npx tsc --noEmit`, when run, then all pass with no pre-existing failures introduced.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 15: (high 0, medium 3, low 12)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` The three history requests carried no `AbortSignal` and no in-flight guard, so a listing resolving after a row change latched the previous row's list and the expand-once rule (`revisions !== null`) then suppressed the new row's fetch. Added per-kind monotonic request tokens (bumped by every request and by `plan.reset`) plus `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` on all three, with mounted tests for the race and for the armed signal.
  - `[medium]` `[patch]` The fetch effect's `gone` branch cleared `confirmOpen` but not `pendingRevert`, leaving a revert dialog standing over a 404 whose confirm was inert and whose focus fallback pointed at an unmounted button. `pendingRevert` is cleared there now, mirroring DW-181; the existing 404 test opens the gate first.
  - `[medium]` `[patch]` A landed save through the column created a revision server-side but never invalidated the panel's cached list, so History omitted the version the owner most likely wanted back. `refreshHistory()` re-lists when the panel is open and drops the cache when it is closed; both branches tested.
  - `[low]` `[patch]` `Edit` was reachable while a revert was in flight, seeding the editor from pre-revert bytes and version so the owner's own save would conflict. The opener and `startEditing` now refuse while reverting.
  - `[low]` `[patch]` Closing the revert gate dropped focus to `<body>`: `useDialogA11y` restores to a still-connected but now-disabled opener, so neither the restore nor the fallback ran. Focus moves to the disclosure toggle.
  - `[low]` `[patch]` The confirm never named which version it was about to restore. The body is now `previewHistoryRevertConfirmBody(revision)`, naming the entry.
  - `[low]` `[patch]` In-flight `Reverting…`, `aria-busy` and `View`'s busy state were applied to every row. `reverting` became `revertingTimestamp`, so the busy report is per row; list-wide `disabled` stays, since that is what prevents a second concurrent write.
  - `[low]` `[patch]` `isRevisionSummary` validated two of four required fields and neither finiteness nor the route's timestamp rule; it now validates all four, and the declared-but-unused `date` renders inside `<time dateTime>` with `sizeBytes` formatted on `RevisionItem`'s thresholds.
  - `[low]` `[patch]` A non-empty envelope whose rows were all dropped by the guard read as "No earlier versions … recorded yet" — the one sentence that stops an owner looking for bytes that exist. It now returns the failure sentence.
  - `[low]` `[patch]` The panel's alert reused `.wb-preview-error` (`margin: 0`) and collided with the list; it has its own class with the sibling notes' spacing, and the drifted CSS comment was rewritten.
  - `[low]` `[patch]` Both new scrollable regions were unreachable by keyboard (WCAG 2.1.1) and `View`'s `aria-expanded` controlled nothing. Panel and `<pre>` are focusable and named, and the `<pre>` carries a per-timestamp id `aria-controls` points at.
  - `[low]` `[patch]` A landed revert was silent for a screen reader while every failure path announced. `PREVIEW_HISTORY_REVERTED_COPY` goes through the column's existing polite region.
  - `[low]` `[patch]` `recordRetemplatedArtifacts` left `normalizeArtifactEditReason` and `wikiArtifactPath` outside its per-file `try`, so a throw there would have rejected a COMMITTED re-template the docblock calls fail-soft. The whole body is fail-soft now.
  - `[low]` `[patch]` The `revisions/` exclusion added to `wikis.test.ts`'s reads-vs-writes parity guard put nothing back in its place. It is paired with a positive assertion that the re-template DID write there, plus a new test that `createWiki` writes nothing under the namespace.
  - `[low]` `[patch]` Nothing asserted the list renders newest-first though the code and copy both claim it. The listing test compares labels positionally and pins the unattributed row's shape.

## Design Notes

Why the re-template snapshot reuses `snapshotSeededFiles`' result rather than reading again: those bytes were read inside the same lock, before the first overwrite, and are exactly what the new template replaced — a second read after the seed would return the TEMPLATE bytes. Matching by `wikiArtifactPath(owner, wikiId, "schema.md")` rather than by array index keeps it correct if `seededFilePaths` ever reorders.

Why AFTER the commit rather than before the seed: written first, a seed that then fails would leave a revision identical to the restored current bytes — history recording an event that did not happen. The failure path already has its compensation; this is history for the path that succeeded.

Why `schema.md` only: `EDITABLE_ARTIFACT_FILES` is the set the history route will list or revert. A `purpose.md` revision would be bytes no surface can reach, and `purpose.md` has no editor for an owner to have personalised it through.

Client type duplication is the module's existing rule (see `REVERT_READ_ONLY_COPY`'s note in `RevisionHistory.tsx`): `wiki-artifact-revisions.ts` pulls `./storage` with it, so the browser re-declares the wire shape instead.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass
- `pnpm vitest run --project dom src/components/workbench/__tests__/preview-revision-history.test.tsx src/components/workbench/__tests__/preview-announcements.test.tsx` -- expected: all pass
- `pnpm test` -- expected: full suite green, no pre-existing failures introduced
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit` -- expected: no type errors

## Auto Run Result

Status: done

**Summary of implemented change.** DW-59 shipped artifact revisions as storage plus an API; this story makes that recovery path cover the operation that destroys the same file, and makes it reachable from the running app. A COMMITTED re-template now records the `schema.md` bytes it overwrote as a revision — inside the `wikis:<tenant>` lock `applyScenarioTemplate` already holds, after the seed and registry write both land, fail-soft, and distinct from the `catch`'s `restoreSeededFiles` rollback — reusing the pre-seed bytes `snapshotSeededFiles` already read rather than reading again (a second read would file the TEMPLATE's bytes as the owner's). And the Preview column grew an expand → list → view → revert History panel over `GET/POST /api/workbench/artifact/revisions`, with every request, sentence and existence rule owned by `workbench-preview.ts`.

**Files changed:**
- `src/lib/wikis.ts` — `retemplateRevisionReason` and the fail-soft `recordRetemplatedArtifacts`, called on the committed path inside the existing lock.
- `src/lib/workbench-preview.ts` — the route/URL builders, the client `ArtifactRevisionSummary` and its guard, three result-union fetch helpers, `previewHistoryTarget`, the label/date/size derivations and the panel's whole copy table.
- `src/components/workbench/PreviewColumn.tsx` — the History panel, its request tokens and deadlines, the confirm-gated revert, the read-only withholding and the announce/re-list tail; new `readOnly` prop.
- `src/components/workbench/Workbench.tsx` — threads the shell's `readOnly` into the column.
- `src/app/globals.css` — the `.wb-preview-history*` chrome, token-only and reusing the existing control geometry.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` — the four re-template matrix rows plus revert-restores and the `purpose.md` exclusion.
- `src/lib/__tests__/workbench-preview.test.ts` — the URL builder, the existence rule, the guard and every helper branch against a stubbed fetch.
- `src/components/workbench/__tests__/preview-revision-history.test.tsx` — NEW mounted suite for the panel.
- `src/lib/__tests__/wikis.test.ts` — the parity guard's `revisions/` exclusion, paired with positive assertions on both the re-template and create paths.
- `src/lib/__tests__/read-only-copy-parity.test.ts` — records the panel's deliberately narrower revert sentence.

**Review findings breakdown:** 15 patches applied (3 medium, 12 low); 1 item deferred (low — the re-template confirm still presents the Schema overwrite as unrecoverable); 10 rejected as noise or as readings the intent itself forecloses (a log line for the re-template, revision retention, reuse of `RevisionHistory.tsx`, CSS rule dedup, duplicate-timestamp keys).

**Follow-up review recommendation:** true. Patched severities: high 0, medium 3, low 12 → 3 × 3 + 1 × 12 = 21, at or above the threshold of 5.

**Verification performed:**
- `npx vitest run` — 264 files, 5835 tests, all pass (`pnpm test` is `vitest run`; `pnpm` itself fails in this environment with `ERROR packages field missing or empty`, caused by a stray `~/pnpm-workspace.yaml` outside the repo and unrelated to this change).
- `npx vitest run` over the four node suites and the two DOM suites named in `## Verification` — 316 and 70 pass respectively.
- `npx eslint .` — exit 0 (three pre-existing `TSNonNullExpression` notices from `jsx-ast-utils`, identical count on a stashed tree).
- `npx tsc --noEmit` — exit 0.
- Every I/O matrix row is covered by a named test that ran and passed in the output above.

**Residual risks:**
- The panel is verified against stubs on both sides — the pure helpers with an injected `fetchImpl`, the mounted shell with a stubbed global `fetch` — while the re-template half is verified against the real route handlers over a temp `DATA_DIR`. No test drives the panel through the route, so the wire contract is asserted from each side and joined by neither; the two were compared by hand and agree.
- The mounted deadline test asserts the column ARMS an `AbortSignal` on all three requests rather than driving it to expiry: `AbortSignal.timeout` is not advanced by `vi.useFakeTimers()`. The helper end of that contract — the signal reaches `fetch`, an abort resolves to the fallback sentence — is covered in the node suite.
- Revisions still have no retention cap or pruning (a deliberate DW-59 decision, already tracked as a low-severity ledger entry), and this change adds a second unbounded writer: one full copy of `schema.md` per re-template.
