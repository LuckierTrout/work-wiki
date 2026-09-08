---
title: 'Workbench Preview announcements, tree reconciliation, and gone-vs-unreachable'
type: 'feature'
created: '2026-08-17'
status: 'done'
baseline_revision: '119cade20cd8c0e95e3994aee50b6d10f4df1f5d'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The `Edit` control stays live over a body a 404 has replaced, so the confirm
      dialog and then a `PUT` can be reached for a page the route says is not there.
    evidence: |-
      The `gone` branch deliberately keeps the last payload, so `canEditPreview(payload)`
      is still true and the header goes on rendering `Edit` while the body shows
      `This file couldn't be loaded.`. `save()`'s guard compares
      `previewWriteTarget(payloadRef.current)?.key` against that same stale payload, so
      it passes and posts. Pre-existing — the old `failed` branch kept the payload the
      same way — but DW-54 narrowing `gone` to mean exactly "the row is not there" is
      what makes it legible as a defect rather than as one undifferentiated failure.
    location: >-
      src/components/workbench/PreviewColumn.tsx (the fetch handler's `gone` branch, and `canEdit`)
    severity: medium
  - summary: >-
      A live region rewritten with the identical string is not re-announced, so two
      consecutive silent refreshes that both change the body report as one.
    evidence: |-
      `refreshAnnouncement` is set to the same `PREVIEW_UPDATED_COPY` literal each time,
      leaving the text node unchanged, and most assistive tech announces only on change.
      The shell's own region has had this shape since Story 1.3 (`setAnnouncement(workbenchMode(next).label)`
      re-announces nothing when the mode already showing is re-picked), so this is a
      house-wide property of both announcers rather than something this change introduced —
      but repeated same-page rewrites are the common case for DW-50 specifically.
      Fixing it needs a decision about the mechanism (a keyed node, an alternating
      suffix) that no test in a node or jsdom project can verify.
    location: >-
      src/components/workbench/PreviewColumn.tsx and src/components/workbench/Workbench.tsx (both polite regions)
    severity: medium
  - summary: >-
      An unreachable refresh is the one refresh outcome that is never announced — the
      stale strip is a purely visual affordance.
    evidence: |-
      A successful silent swap says `Preview updated` and a 404 mounts a `role="alert"`
      body sentence, but an unreachable read only renders `.wb-preview-stale`, which
      carries no live region. A screen-reader user goes on reading bytes with no way to
      learn the column stopped being able to refresh them. Not required by DW-54's
      recorded decision (which asks for an indicator with a retry, not a sentence), and
      announcing every blip politely would chatter — so the wording and the threshold
      are a copy decision rather than a wiring fix.
    location: >-
      src/components/workbench/PreviewColumn.tsx (the stale strip)
    severity: low
  - summary: >-
      Pressing `Retry` produces no in-flight feedback, so a slow retry is
      indistinguishable from a broken button.
    evidence: |-
      A retry takes the silent-refresh path, so `loading` stays false by design (the
      point is not to flash `Loading…` at a reader), the strip renders unchanged, and a
      second failure is a no-op re-render. Adding an `aria-busy`/disabled pending state
      means a fifth flag in the column and a decision about whether the strip's label
      should change while a read is in flight.
    location: >-
      src/components/workbench/PreviewColumn.tsx (the `Retry` control)
    severity: low
  - summary: >-
      No CSS layout rule in this repo is verified by anything that lays out a
      page — every breakpoint claim is a text scan of `globals.css`.
    evidence: |-
      `vitest.config.ts` has exactly two projects, `node` and `dom` (jsdom), and
      jsdom has no layout engine; there is no Playwright config, no `e2e/`
      directory and no browser project anywhere. So DW-34's user-visible payoff
      — "a docked column below 900px is reachable" — is pinned by
      `workbench-left-column.test.ts` asserting that declaration strings appear
      inside a slice of the stylesheet. That scan cannot show the new rule wins
      the cascade, that the released clamp actually makes the row reachable, or
      that the `[data-sheet-open]` counter-rule outranks the docked selectors.
      The mounted suite observes only that the shell ASKS the platform to
      scroll. Pre-existing and repo-wide: every earlier Workbench story verified
      its stylesheet half the same way. Closing it means adding a browser test
      project, which is a project-level decision rather than a fix to this
      change.
    location: >-
      vitest.config.ts (no browser project); src/lib/__tests__/workbench-left-column.test.ts (the CSS scans)
    severity: low
---

<intent-contract>

## Intent

**Problem:** The docked Preview changes what it shows without saying so and cannot tell failure apart from deletion. Docking and undocking are silent layout changes (DW-34) and below 900px the column is placed in a grid cell the shell clips, so a tap appears to do nothing; a silent same-row refresh swaps the body underneath a screen-reader user with no announcement (DW-50); a page another actor deletes leaves the selection alive with no tree row marked current (DW-53); and `fetchPreview` collapses 404, 5xx, a malformed body, the deadline and a bare transport failure into one `failed`, so a network blip replaces the page the owner is reading with `PREVIEW_FAILED_COPY` and never heals (DW-54).

**Approach:** Author the four new sentences in the epic's Copy table — the `Copy` constant blocks in `workbench-preview.ts` / `workbench-tree.ts`, which is where every Workbench sentence is born — then wire each one from the surface that owns the change: dock/undock from the shell's selection setters into the existing polite live region (plus a narrow-width scroll and the CSS that makes a docked column reachable at all); a `Preview updated` announcement from `PreviewColumn`'s own polite region on a silent same-row content swap; a refreshed-tree reconciliation that undocks and announces when the selected row is gone; and a `fetchPreview` that reports `gone` (404) separately from `unreachable` (transport, timeout, 5xx, malformed), so `gone` shows the existing failure copy while `unreachable` keeps the last-good bytes behind a transient, self-healing strip with a Retry.

## Boundaries & Constraints

**Always:**
- Every new user-visible sentence is a named constant (or a pure function returning one) in a module's `Copy` block, with a docblock in the surrounding house style. No string literal in JSX.
- Every DECISION lands in a pure, client-safe function the node project executes — the rule this codebase already applies to `previewBodyState`, `previewFetchPlan` and `shouldDockPreview`. Conditions typed into an effect or JSX are only greppable.
- The selection reset effect at `Workbench.tsx:295-304` keeps its pinned deps `[mode, currentWikiId, treeTab]` exactly. Tree reconciliation is a SEPARATE effect; `knowledge`/`files` never join the reset effect's array.
- Announcements go through polite live regions only. Never `role="alert"` for a dock, an undock or a refresh — nothing failed.
- Restoring state is not a change the owner made: a mount-time restore must announce nothing (the rule `announcement` already documents).
- Typographic apostrophes (`’`) in copy, matching every existing sentence.
- `PreviewColumn` still issues no `fetch(` of its own and never imports `next/navigation` (pinned by `workbench-data-version.test.ts`).
- Source-scan tests that pin a call site this change rewrites must be UPDATED to the new shape, not deleted — and where the DOM project can now observe the behaviour directly, add the mounted assertion beside the scan.

**Block If:**
- The `wb-shell` narrow-width layout cannot be made to reveal a docked Preview without changing a rule another story pins.

**Never:**
- No new route, no new API, no server change. `/api/workbench/preview` and its answers are untouched.
- No auto-retry timer or polling loop for an unreachable read — self-healing means the next read that already happens (a `dataVersion` bump, a pick, or the Retry control) clears it.
- Do not change what a FRESH pick shows on failure: with no last-good payload, both `gone` and `unreachable` still render `PREVIEW_FAILED_COPY`.
- Do not touch the deferred-work ledger, `sprint-status.yaml`, or `epics.md`.
- No focus move on dock or undock — the announcement is the whole of the report.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Dock | Wiki mode, no selection; owner clicks tree row `Alpha` | Preview docks; shell live region reads `Preview, Alpha` | No error expected |
| Undock by re-click | Row `Alpha` selected; owner clicks it again | Selection clears; live region reads `Preview closed` | No error expected |
| Narrow dock | `matchMedia("(min-width: 900px)").matches === false`; owner docks a row | Docked column is scrolled into view | `scrollIntoView` absent → no throw, dock still happens |
| Wikilink follow | Preview docked on `Alpha`; owner follows `[[beta]]` | Live region reads `Preview, Beta`; a link to `Alpha` itself announces nothing (React bails out) | No error expected |
| Silent refresh, changed bytes | Same row, not editing, `dataVersion` bumps, body differs | Body swaps; Preview's own live region reads `Preview updated` | No error expected |
| Silent refresh, same bytes | Same row, bump, body identical | Body unchanged; nothing announced | No error expected |
| Pick (reset) read | New row picked, read succeeds | Nothing announced by the fetch handler — the dock announcement already reported it | No error expected |
| Row deleted elsewhere | Preview docked; refresh drops the row from both trees | Preview undocks; shell live region reads the removal sentence | No error expected |
| Trees unavailable | Refresh lands with `knowledgeUnavailable` or `filesUnavailable` | Selection survives; nothing announced | Read failure is not a deletion |
| Layout moved same commit | Wiki/mode/tab change AND a refresh land together | Reset effect owns the clear; reconciliation stays silent | No error expected |
| 404 on silent refresh | Same row, read answers 404 | Body replaced by `PREVIEW_FAILED_COPY`; no stale strip | The one sentence, unchanged |
| Transport/timeout on silent refresh | Same row, read throws or hits `REQUEST_TIMEOUT_MS` | Last-good bytes stay on screen; transient strip + `Retry` appears | Nothing said about deletion |
| Retry succeeds | Stale strip showing; owner presses `Retry` | Same-row re-read; strip clears on success | On failure the strip stays |
| Superseded read | Owner picks another row mid-flight | `stale`; nothing written to state | No error expected |
| Fresh pick fails | Reset path, no payload held, `gone` or `unreachable` | `PREVIEW_FAILED_COPY`, no stale strip | Unchanged from today |

</intent-contract>

## Code Map

- `src/lib/workbench-preview.ts` — the Preview's vocabulary and Copy block (`:271-376`). `PreviewFetchResult` (`:434-437`) and `fetchPreview` (`:476-496`) are what DW-54 splits; `previewBodyState` (`:151-171`) is where "failed AHEAD of a held payload" lives. New sentences and the two new pure decisions belong here.
- `src/lib/workbench-tree.ts` — selection vocabulary. `selectionExists` (`:181-192`) is the reconciliation predicate DW-53 needs; `findKnowledgePage` (`:469-478`) / `findFileNode` (`:434-444`) are the two lookups the name resolution uses.
- `src/components/workbench/Workbench.tsx` — the shell. Polite live region at `:788-790`, fed only by `setAnnouncement`. Selection setters: `selectRow` (`:466-468`, toggles) and `openPage` (`:476-489`, never toggles, bails out on the same row). Reset effect `:295-304` — deps frozen. `latestRef` (`:198-199`) already carries `knowledge`/`files` for dep-free callbacks. `WIDE_QUERY` (`:123`). `previewOpen` (`:612`). `<PreviewColumn>` mount at `:769-782`.
- `src/components/workbench/PreviewColumn.tsx` — the fetch effect (`:164-232`) and its response handler (`:212-226`); `payloadRef` (`:128-129`) already holds what is on screen. `failed`/`loading` state at `:130-131`. `body()` at `:345-387`. The name-resolution block at `:326-333` is duplicated logic the shell now needs — lift it.
- `src/lib/workbench-data-version.ts` — `previewFetchPlan` (`:180-190`) already answers `reset`; `plan.reset === false` is exactly "silent same-row refresh". Do not change it.
- `src/app/globals.css` — `.wb-shell` grid + `height/max-height: 100dvh; overflow: hidden` (`:2481-2496`), the `≤899px` block (`:2737-2830`) which re-columns `.wb-left` and `.wb-canvas` to column 1 but NOT `.wb-preview`, and `.wb-preview { grid-column: 4 }` (`:3049-3058`). READ-ONLY EVIDENCE: at ≤899px a docked Preview is placed in an implicit 4th column of a one-column grid and past the clipped 100dvh — it is unreachable, not merely below the fold.
- `vitest.config.ts` — two projects: `node` (`*.test.ts`) and `dom` (jsdom, `src/**/__tests__/**/*.test.tsx`). Mounted assertions are available now; the "no DOM environment" premise in older docblocks is stale.
- `vitest.setup.dom.ts` — `matchMedia` shim defaults `matches: false` (narrow), `setMediaQuery` drives it. No `scrollIntoView` shim yet; the file is the sanctioned home for one.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` — the mounted-shell pattern to copy (hoisted router mock, `WorkbenchDataProvider` fixture, sidecar probe stub).
- Pinned source scans that this change rewrites: `src/lib/__tests__/workbench-left-column.test.ts:338` (`previewBodyState({ loading, failed, payload })`), `src/lib/__tests__/workbench-data-version.test.ts:739,764-777` (the `[selection, dataVersion, editing]` dep array and the ok/else branch slice).

## Tasks & Acceptance

**Execution:**

- `src/lib/workbench-preview.ts` — (a) Copy block: add `previewDockAnnouncement(name)` → `Preview, ${name}` (mirroring `settingsAnnouncement`), `PREVIEW_CLOSED_COPY`, `PREVIEW_REMOVED_COPY` (undocked because the row left the tree), `PREVIEW_UPDATED_COPY`, `PREVIEW_UNREACHABLE_COPY`, `PREVIEW_RETRY_COPY`. (b) Replace `PreviewFetchResult`'s `{ status: "failed" }` with `{ status: "gone" }` (404 only) and `{ status: "unreachable" }` (transport, timeout, 5xx, malformed body, non-payload JSON); update `abortOutcome` so a deadline abort is `unreachable`. (c) Rename `previewBodyState`'s input field `failed` → `gone`; the branch ORDER and the returned `kind: "failed"` are unchanged. (d) Add `previewStaleNotice({ loading, gone, unreachable, payload })` → the strip shows only when a payload is still held. (e) Add `previewRefreshAnnouncement({ reset, shown, next })` → `PREVIEW_UPDATED_COPY` or `null`. — Rationale: one module owns every Preview sentence and every Preview decision; a 404 and a blip are different facts and must be different values.
- `src/lib/workbench-tree.ts` — add `selectionName(selection, knowledge, files)` (page title else slug; file node name else last non-empty path segment else the path — the exact rule `PreviewColumn.tsx:326-333` spells today) and `selectionLostOnRefresh({ selection, knowledge, files, unavailable, layoutMoved })` returning whether to undock and announce. — Rationale: the shell and the column must not derive the same name two ways, and "is this pick still real after a refresh?" is the decision DW-53 turns on.
- `src/components/workbench/Workbench.tsx` — (a) announce from `selectRow` (dock vs. toggle-off) and `openPage` (dock only when React does not bail out), reading `knowledge`/`files` through the existing `latestRef` so neither callback grows a dependency; (b) add a reconciliation effect keyed on `[mounted, knowledge, files, knowledgeUnavailable, filesUnavailable]` that reads the live selection and the layout signature through a ref, calls `selectionLostOnRefresh`, and on a lost row clears the selection and announces `PREVIEW_REMOVED_COPY`; (c) add a `previewRef` and an effect on `previewOpen` that scrolls the docked column into view when `matchMedia(WIDE_QUERY).matches` is false. — Rationale: the shell owns selection and the live region, so all three announcements originate where the change does.
- `src/components/workbench/PreviewColumn.tsx` — (a) accept and forward a `ref` onto the `<aside>`; (b) rename the `failed` state to `gone`, add `unreachable` and a `retryNonce` (added to the fetch effect deps); (c) in the response handler branch on `ok` / `gone` / `unreachable`, call `previewRefreshAnnouncement` for the silent-swap sentence and write it to a new polite live region inside the column; (d) render the stale strip (`PREVIEW_UNREACHABLE_COPY` + a `Retry` button that bumps `retryNonce`) when `previewStaleNotice` says so; (e) replace the inline name block with `selectionName`. — Rationale: last-good bytes must survive a blip, and the owner needs one control to try again.
- `src/app/globals.css` — inside the `≤899px` block, place `.wb-preview` in column 1 with a top border instead of a left one, and let the shell scroll when `[data-preview="true"]` so a docked column is reachable; add `.wb-preview-stale` (muted strip above the body, no alert colour) and its `Retry` control styling. — Rationale: `scrollIntoView` cannot reveal a child of a clipped `100dvh` grid; the layout has to admit a fourth row first.
- `vitest.setup.dom.ts` — add an `Element.prototype.scrollIntoView` shim with the file's existing fidelity-limit docblock style. — Rationale: jsdom ships none, and the component must not be reshaped to stop asking the platform.
- `src/lib/__tests__/workbench-preview.test.ts` — extend for every I/O Matrix row this module owns: `gone` vs `unreachable` from `fetchPreview` (404, 500, malformed JSON, non-payload shape, throw, deadline abort, superseded abort), `previewBodyState` with the renamed input, `previewStaleNotice`'s four inputs, `previewRefreshAnnouncement` (reset, no prior payload, identical body, changed body), and the new copy constants.
- `src/lib/__tests__/workbench-tree.test.ts` — execute `selectionName` (page hit/miss, file hit/miss, trailing-slash path, bare path) and `selectionLostOnRefresh` (null selection, unavailable trees, layout moved, row present, row gone, directory).
- `src/lib/__tests__/workbench-left-column.test.ts` + `src/lib/__tests__/workbench-data-version.test.ts` — update the pinned call-site strings and the dep array to the new shape; keep every rule the scans encode (plan-before-reset, one branch per outcome, no re-derived `response.ok`, `setLoading(false)` on every settled path).
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — new mounted suite over the shell and the column: dock/undock/wikilink announcements, silence on a mount-time restore, narrow-width `scrollIntoView` (and none when wide), refreshed-tree undock + announcement, silence when the trees are unavailable, `Preview updated` on a changed silent refresh and silence on an identical one, 404 replacing the body, an unreachable read keeping the bytes and offering `Retry`, and `Retry` re-reading the same row.

**Acceptance Criteria:**

- Given the shell is mounted in Wiki mode with a stored selection that still exists, when the mount restore docks the Preview, then the shell's live region stays empty — a restore is not a change the owner made.
- Given a docked Preview, when the reset effect's dependency array is read from source, then it is still exactly `[mode, currentWikiId, treeTab]`.
- Given the owner is mid-edit in the Preview's textarea, when a `dataVersion` bump lands, then the draft, the editor and the confirm state are untouched and nothing is announced — `previewFetchPlan` still returns `fetch: false`.
- Given a page is deleted by another actor while its Preview is docked, when the refreshed trees arrive, then no tree row is left carrying `aria-current` and the Preview is closed with a spoken reason rather than silently.
- Given the last-good bytes are on screen and a silent refresh cannot reach the server, when the read settles, then the rendered body is still the last-good bytes and the transient strip offers a way to try again; and given a later read of the same row succeeds, then the strip disappears without the owner doing anything.
- Given the viewport is below 900px and a docked Preview exists, when the shell is inspected, then the column occupies the single grid column and is reachable by scrolling rather than clipped by the shell.
- Given every new user-visible sentence, when the components are scanned, then each is referenced by constant and none appears as a literal in JSX.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 1, medium 4, low 6)
- defer: 4: (high 0, medium 2, low 2)
- reject: 10: (high 0, medium 2, low 8)
- addressed_findings:
  - `[high]` `[patch]` The reconciliation effect wrote `reconciledSignatureRef` only from inside itself, so a tab/mode/Wiki change left the recorded signature stale and the NEXT tree-only refresh stood down as if the layout had just moved — a deletion after any layout change went unnoticed until a second refresh. Fixed by adding the layout signature to that effect's deps so it records the move and returns; the reset effect's deps stay `[mode, currentWikiId, treeTab]`.
  - `[medium]` `[patch]` `PREVIEW_REMOVED_COPY` was announced with no column on screen (Settings open leaves the selection alive while `previewOpen` is false). The predicate became `selectionRefreshAction` returning `keep | clear | report` with a `docked` input: the stale pick is still cleared, nothing is spoken.
  - `[medium]` `[patch]` The narrow-width reveal was keyed on `[previewOpen]` alone, so picking a DIFFERENT row while already docked below 900px scrolled nothing. Now keyed on the docked row too.
  - `[medium]` `[patch]` `Retry` was a dead control while the editor was open (`previewFetchPlan` returns `fetch: false`). `previewStaleNotice` gained an `editing` input and the strip withdraws.
  - `[medium]` `[patch]` Every non-404 non-ok status mapped to `unreachable`, so a deterministic 400/401/403 held last-good bytes behind a `Retry` that could never succeed. Any 4xx now replaces the body (`gone`); 5xx, transport, deadline, unparseable body and non-payload 200 stay `unreachable`.
  - `[low]` `[patch]` The reconciliation passed `knowledgeUnavailable || filesUnavailable` regardless of `selection.kind` and ignored `filesTruncated`, so a healthy tree was suppressed by the other's failure and a capped walk could report a still-existing file as removed. Both flags are now kind-matched inside the pure function.
  - `[low]` `[patch]` `previewRefreshAnnouncement` compared only `body`, missing a `truncated` flip that adds or removes the truncation sentence and the `Edit` control. Now compares both.
  - `[low]` `[patch]` The ≤899px clamp release let the document scroll behind an open off-canvas sheet and its backdrop. The clamp is restored while `[data-sheet-open="true"]`.
  - `[low]` `[patch]` `.wb-preview-retry` was roughly a 20px target, under WCAG 2.2 SC 2.5.8's 24×24 minimum, on the one new control built for the touch breakpoint. Given a 24px floor.
  - `[low]` `[patch]` `announced()`'s new docblock attributed the Preview-region exclusion to the wrong mechanism; reworded to match the child combinator it actually uses.
  - `[low]` `[patch]` The new sentences had no character-exact Copy table in this spec's Design Notes, which is the documentary surface the ledger names. Added, in `spec-1-5`'s shape.

### 2026-08-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 2, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 17: (high 0, medium 3, low 14)
- addressed_findings:
  - `[medium]` `[patch]` `isDeterministicRefusal` ranged the whole 4xx family into `gone`, so a 408, 425 or 429 — the statuses that say WHEN rather than WHAT — replaced the page the owner was reading and offered no `Retry` that could ever succeed. That is the DW-54 failure one status class over, and a CDN or platform rate limiter in front of the route is exactly the intermediary the split exists to stop reading as a deletion. The three are now `unreachable`; `workbench-preview.test.ts` moved 429 out of the `gone` loop and pins 408/425 beside the 5xx.
  - `[medium]` `[patch]` The narrow-width reveal fired on the MOUNT RESTORE, so every page load below 900px opened already scrolled past the tree and the canvas to the bottom row — a movement the owner did not ask for, contradicting the same rule the restore already follows for the live region. An `ownerPickedRef`, written only by `selectRow` and `openPage`, now gates it; the restore test asserts `scrollIntoView` is not called.
  - `[low]` `[patch]` `previewRefreshAnnouncement`'s docblock justified ignoring an `updated` field that `PreviewPayload` does not have (and the matching test comment sat over an assertion that mutates `name`). Both reworded to the real reason: everything not compared is identity for the row already showing, and `editable` follows from deployment-level facts that do not move between two reads.
  - `[low]` `[patch]` `previewStaleNotice`'s docblock opened "The branch order is the whole content of the decision" over a flat conjunction in which every term is order-independent — the framing belongs to `previewBodyState`, where order genuinely is the content. Reworded to name the SET of conditions, and to contrast the two functions explicitly.
  - `[low]` `[patch]` The clamp-release comment claimed "nothing here grows without bound" while enumerating only the tree and Preview bodies; the canvas row is the one child with no cap, and `minmax(0, 1fr)` under `height: auto` resolves to its content. The comment now names the canvas and states the trade the rule makes deliberately.
  - `[low]` `[patch]` The CSS scan asserted three of the release's four declarations — `height: auto` alone could have been deleted with the suite green, and it is the one that stops `height: 100dvh` from re-clipping the fourth row. Asserted.
  - `[low]` `[patch]` `openPage`'s "a link to the row already showing announces nothing" guard was unpinned: the assertion re-read the same string the unguarded call would have written. A Settings round trip now interposes a different sentence, so a spurious dock announcement is visible as the region changing.
  - `[low]` `[patch]` The reset path's `setRefreshAnnouncement("")` was unpinned — deleting it kept 106 tests green, because the success path rewrites the region anyway. A new case updates Alpha, then picks a row whose read 404s, and asserts the column's region is empty rather than still claiming `Preview updated`.
  - `[low]` `[patch]` The mounted "keeps the selection when the trees could not be read" case passed its `filesUnavailable` half for the wrong reason: the refresh spread restored the knowledge tree, so a PAGE pick survived via `selectionExists` with the flag never consulted. Split out a file-selection case that actually exercises the kind-matching.
  - `[low]` `[patch]` Nothing pinned the stale strip ABOVE the body — every assertion was a text query, which would not notice the sentence rendering below the bytes it describes. Pinned with `compareDocumentPosition`.

## Design Notes

**Where the Copy table is.** There is no copy table in `epics.md`; the sanctioned home — the one `spec-1-5` and DW-30 both used — is the `Copy — every user-visible sentence …` block in the owning `workbench-*` module. Preview sentences go in `workbench-preview.ts`. The table below is this spec's half of that convention, matching `spec-1-5`'s Design Notes: the strings are fixed HERE, character for character, and the module is where they are named.

**Copy (character-exact; do not paraphrase).**

| Where | String | Constant | Answers |
|---|---|---|---|
| Shell live region, on dock — from a tree pick or a followed wikilink | `Preview, <name>` (e.g. `Preview, Alpha`) | `previewDockAnnouncement(name)` | DW-34 |
| Shell live region, when the owner re-clicks the docked row | `Preview closed` | `PREVIEW_CLOSED_COPY` | DW-34 |
| Shell live region, when a refreshed tree no longer holds the docked row | `Preview closed — that item was removed.` | `PREVIEW_REMOVED_COPY` | DW-53 |
| Preview column's own live region, after a silent same-row refresh changed the body | `Preview updated` | `PREVIEW_UPDATED_COPY` | DW-50 |
| Transient strip above the body, over last-good bytes an unreachable read could not replace | `Couldn’t refresh — showing the last version that loaded.` | `PREVIEW_UNREACHABLE_COPY` | DW-54 |
| The one control in that strip | `Retry` | `PREVIEW_RETRY_COPY` | DW-54 |

Notes on the wordings: the dock sentence mirrors `settingsAnnouncement`'s `Settings, <category>` because it reports the same kind of event (a surface appeared showing a named thing, EXPERIENCE.md:175); `PREVIEW_CLOSED_COPY` carries no name, because naming what a vanished column used to show reads as a report that something opened; `PREVIEW_REMOVED_COPY` says "removed" rather than "deleted" because all the shell knows is that a refreshed tree no longer contains the row; and `PREVIEW_UNREACHABLE_COPY` is deliberately not `PREVIEW_FAILED_COPY` — that sentence replaces the body, and shown above bytes that are still on screen it would tell the owner their page is gone while they are reading it.

**Why `gone` and `unreachable` rather than adding one value.** `failed` currently means five things. Keeping the name for four of them and adding `gone` would leave the component holding a `failed` flag that now means "deleted", which is exactly the conflation DW-54 is about. Two named outcomes, and `previewBodyState`'s input renamed with them.

```ts
// workbench-preview.ts — the branch order is the whole content of the decision.
export function previewStaleNotice(input: {
  loading: boolean; gone: boolean; unreachable: boolean; payload: PreviewPayload | null;
}): boolean {
  // Never over a body that is not there: with no payload the column already
  // shows PREVIEW_FAILED_COPY, and a Retry beside it would promise to restore
  // bytes it never had.
  return input.unreachable && !input.loading && !input.gone && input.payload !== null;
}
```

**Why reconciliation is its own effect with a signature guard.** A Wiki, mode or tab change and a server re-render can land in the same commit; the reset effect owns the clear in that case and clearing again — with a sentence about deletion — would report something that did not happen. `layoutMoved` is that guard, passed into `selectionLostOnRefresh` so the rule is executed rather than typed into the effect.

**Why the shell scrolls at ≤899px.** `.wb-shell` is `height: 100dvh; overflow: hidden`, so nothing placed in a fourth row can be scrolled into view. The narrow layout has to release the clamp while a Preview is docked; the wide layout is untouched.

## Verification

**Commands:**
- `pnpm test` — expected: both projects green, `dom` collects the new `.test.tsx`.
- `pnpm lint` — expected: clean, no new `react-hooks/exhaustive-deps` suppressions.
- `npx tsc --noEmit -p tsconfig.json` — expected: clean (the `PreviewFetchResult` rename must have no unhandled consumer).

**Manual checks (if no CLI):**
- Read `Workbench.tsx`'s reset effect and confirm its dependency array is byte-for-byte `[mode, currentWikiId, treeTab]`.
- Read the `≤899px` CSS block and confirm `.wb-preview` resolves to `grid-column: 1` there, with the wide-layout rules unchanged.

## Auto Run Result

Status: done

**Implemented change.** The docked Preview now reports every change it makes on its own. Dock and undock announce through the shell's polite live region and, below 900px, the docked column is both reachable (the shell's `100dvh`/`overflow: hidden` clamp is released while a Preview is docked, and restored while the mode sheet is open) and scrolled into view (DW-34). A silent same-row refresh that changed the rendered body announces `Preview updated` from the column's own polite region (DW-50). A refreshed tree that no longer holds the selected row undocks and says why, through a separate effect whose pure decision (`selectionRefreshAction`) also knows to stay silent when no column was on screen and to stand down when the layout moved in the same commit (DW-53). And `fetchPreview` now answers `gone` (a 4xx the next attempt would meet again) separately from `unreachable` (5xx, transport, deadline, unparseable body, non-payload 200, plus 408/425/429), so a blip keeps the last-good bytes behind a transient strip with a `Retry` instead of replacing the page the owner is reading (DW-54).

**Files changed.**
- `src/lib/workbench-preview.ts` — six new Copy constants; `PreviewFetchResult` split into `gone`/`unreachable`; `previewBodyState`'s input renamed; `previewStaleNotice` and `previewRefreshAnnouncement` added.
- `src/lib/workbench-tree.ts` — `selectionName` and `selectionRefreshAction`.
- `src/components/workbench/Workbench.tsx` — dock/undock announcements, the reconciliation effect, the narrow-width reveal (owner-picks only), a forwarded `previewRef`.
- `src/components/workbench/PreviewColumn.tsx` — `gone`/`unreachable`/`retryNonce` state, the column's own live region, the stale strip and its `Retry`, `selectionName` in the header, a forwarded `ref`.
- `src/app/globals.css` — the ≤899px clamp release and sheet re-clamp, `.wb-preview` in column 1, `.wb-preview-stale` and `.wb-preview-retry`.
- `vitest.setup.dom.ts` — an `Element.prototype.scrollIntoView` shim.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — new mounted suite (28 cases).
- `src/lib/__tests__/workbench-preview.test.ts`, `workbench-tree.test.ts`, `workbench-left-column.test.ts`, `workbench-data-version.test.ts`, `src/components/workbench/__tests__/workbench-mode-url.test.tsx` — new coverage and updated pinned scans.

**Review findings breakdown (this pass).** 10 patches applied (high 0, medium 2, low 8): the 408/425/429 classification, the reveal firing on a mount restore, three docblock/comment accuracy repairs, and five verification gaps (a missing CSS declaration assertion, the unpinned `openPage` guard, the unpinned reset-time clear, a mounted unavailability case that passed for the wrong reason, and the strip's unpinned DOM position). 1 item deferred (low): no CSS layout rule in this repo is verified by anything that lays out a page — pre-existing and repo-wide, since jsdom has no layout engine and there is no browser test project. 17 rejected (high 0, medium 3, low 14), of which five were re-reports of items already deferred from the previous pass (the live region's same-string limitation, the silent stale strip, `Retry`'s missing in-flight feedback, `Edit` staying live over a 404) and one was refuted outright: `ConfirmDialog` is not exposed by the released clamp, because `useDialogA11y` sets `document.body.style.overflow = "hidden"` for as long as it is open.

**Follow-up review recommendation:** `true`. Patched this pass: high 0, medium 2, low 8 → score `3 × 2 + 1 × 8 = 14`, at or above the threshold of 5.

**Verification performed.**
- `vitest run` (via `./node_modules/.bin/vitest`, since `pnpm` in this environment errors with `packages field missing or empty` before reaching the script) — 219 files, 4580 tests, all passing; the `dom` project collects `preview-announcements.test.tsx` with 28 cases.
- `eslint` — exit 0, no new suppressions. (jsx-ast-utils prints pre-existing `TSNonNullExpression` notices on unrelated files; they are not findings.)
- `npx tsc --noEmit -p tsconfig.json` — exit 0.
- One patch was caught by the suite mid-pass: a `}` inside the new CSS comment truncated the scan's rule slice, since that scan bounds the rule at the first `}`. The comment was reworded rather than the scan loosened.

**Residual risks.**
- The DW-34 stylesheet half is still verified only by text scans (now deferred, above); a cascade change from a future sibling selector would not fail a test.
- Two announcement limitations remain deferred rather than fixed: an identical string rewritten into a live region is not re-announced, and an unreachable refresh is never spoken at all.
- `gone` still leaves the `Edit` control live over a replaced body (deferred), and this pass moved three more statuses out of that branch rather than into it, which narrows but does not close the exposure.

