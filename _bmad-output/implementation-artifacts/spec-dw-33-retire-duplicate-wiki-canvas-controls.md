---
title: 'Retire the duplicate Wiki canvas controls (DW-33, DW-39)'
type: 'refactor'
created: '2026-08-17'
status: 'done'
baseline_revision: '1efde5ef6f6f898949b1dc04bf33f26427a0b7bb'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A header Rename leaves the Wiki canvas card naming the old wiki until a reload.
    evidence: |-
      `WikiWorkbench` seeds `useState(initialWikis)`/`useState(initialCurrentId)` from
      props, and `page.tsx:135` keys it on the wiki ID — which a rename does not
      change. So `router.refresh()` delivers the new name, the key stays the same, the
      card does not remount, and `current.name` keeps the pre-rename string while the
      header switcher shows the new one. Pre-existing (it shipped with rename), and the
      root fix is the one `spec-1-4` recorded as blocked by the now-lifted freeze: have
      the card read `wikis`/`currentWikiId` from `WorkbenchDataProvider`, which already
      carries both, instead of seeding local state and keying the remount.
    location: >-
      src/components/WikiWorkbench.tsx:62-63 with src/app/page.tsx:135
    severity: medium
  - summary: >-
      `WikiWorkbench.send()` has no request deadline, so a hung create or re-template leaves the dialog spinning for the session.
    evidence: |-
      `WikiSwitcher.tsx:42-47` documents exactly this failure and guards it with
      `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`; the near-identical helper at
      `WikiWorkbench.tsx:46-54` has neither that nor `failureMessage`, and `finally`
      cannot rescue a promise that never settles — `busy` stays true. It also spreads
      `...init` AFTER `headers`, the ordering `WikiSwitcher.tsx:50-52` warns against.
      With switching gone the two helpers differ only in hardening, so they should be
      one shared module.
    location: >-
      src/components/WikiWorkbench.tsx:38-46
    severity: medium
  - summary: >-
      The zero-wiki viewport shows two byte-identical `No wiki yet.` sentences.
    evidence: |-
      The canvas empty state inlines the literal while the left column's tree renders
      `TREE_NO_WIKI_COPY` (`src/lib/workbench-tree.ts:71`) — the same string, on two
      surfaces, at the same moment. Same class of defect as DW-33, and the new mounted
      suite scopes its assertion to `.wb-canvas` to work around it. Deciding which
      surface owns the sentence is a UX call, not a mechanical de-duplication.
    location: >-
      src/components/WikiWorkbench.tsx:160 with src/lib/workbench-tree.ts:71
    severity: low
  - summary: >-
      `Select a file to preview.` is still an inline literal restated in three files while every sibling sentence is an exported constant.
    evidence: |-
      `TREE_NO_WIKI_COPY`, `TREE_UNAVAILABLE_COPY`, `WIKI_SCOPE_COPY` and
      `PREVIEW_EMPTY_COPY` all live in `src/lib/`, so a copy change is one edit and the
      node suite can execute it. This AC-quoted sentence is inline in the component and
      restated in `create-wiki-ui.test.ts` and `wiki-canvas-duplication.test.tsx`.
      Extracting it changes what `create-wiki-ui.test.ts:128` freezes, so it belongs
      with a deliberate copy-consolidation pass.
    location: >-
      src/components/WikiWorkbench.tsx:210
    severity: low
  - summary: >-
      Collapsing the left column now leaves no Wiki switch, create, rename or delete control reachable.
    evidence: |-
      `globals.css:2645-2647` sets `.wb-shell[data-collapsed="true"] .wb-left { display: none }`,
      and `collapsed` is durable. Before DW-33 the canvas card's own switcher and
      `New wiki` survived the collapse; now every Wiki control lives in the hidden
      column. The rail's collapse chevron is always visible, so nothing is a dead end
      and this is arguably just what "collapse" means — but it is a reachability change
      the retirement caused, and whether the rail should carry a Wiki affordance in
      that state is a UX decision.
    location: >-
      src/app/globals.css:2645 with src/components/workbench/WikiSwitcher.tsx
    severity: low
  - summary: >-
      The only Wiki switcher's label is `wb-sr-only`, so a sighted user now meets a bare combobox.
    evidence: |-
      The retired card control carried a VISIBLE `Active wiki` label; the survivor's is
      clipped (`WikiSwitcher.tsx:262-264`), justified on the 280px column width. The
      accessibility floor is still met — the input is labelled beyond a placeholder —
      but that tradeoff was made while a visible label existed elsewhere on the same
      viewport, and it has not been re-examined now that it does not.
    location: >-
      src/components/workbench/WikiSwitcher.tsx:262-264
    severity: low
  - summary: >-
      Hiding the preview note leaves the canvas grid's second track empty, so a docked Preview strands the card at 320px beside blank space.
    evidence: |-
      The card's wrapper is `grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]`
      (`WikiWorkbench.tsx:172`). `display: none` removes the second child from
      layout but not the track it sat in, so at the `lg:` breakpoint with
      `data-preview="true"` the receipt card stays pinned at 320px and the `1fr`
      column renders empty — space the sentence used to fill. The intent
      authorized a visibility change only ("Only its visibility while a Preview
      is docked changes"), so the diff is spec-compliant; whether the card should
      reflow to the full canvas width when the Preview docks is a UX call, not a
      mechanical fix. Adding a `grid-template-columns` override to the DW-39 rule
      would be cascade-safe (`workbench-split.test.ts:1247` keys on
      `lastIndexOf`, and this rule sits far ahead of the docked grid variants),
      so the blocker is the design decision, not the mechanism.
    location: >-
      src/components/WikiWorkbench.tsx:172 with src/app/globals.css:2696
    severity: low
---

<intent-contract>

## Intent

**Problem:** Wiki mode puts two Wiki switchers and two create controls in one viewport — the left-column header `WikiSwitcher` and Story 1.2's canvas card, which still carries its own `Active wiki` `<select>` and `New wiki` button (DW-33) — and the same card prints `Select a file to preview.` unconditionally, so a docked Preview column renders a page while the sentence beside it says nothing is selected (DW-39). Both survived only because `create-wiki-ui.test.ts` freezes in-file occurrence counts for `WikiWorkbench.tsx`, which forbade earlier stories from editing it.

**Approach:** Delete the canvas card's switcher and its `New wiki` button (and the now-dead `switchWiki`/`switching`/`error` machinery), leaving the header as the single owner of switching and creating. Keep the sentence — Story 1.2 and 1.5 ACs quote it verbatim as the undocked-Preview copy — but make it mutually exclusive with the docked column by hiding it from CSS off the shell's existing `data-preview` attribute, the same mechanism `.wb-title-fallback` and the Graph's width pair already use. Retarget the frozen counts and move the in-flight-switch guard assertions onto `WikiSwitcher.tsx`, where that guard now lives.

## Boundaries & Constraints

**Always:**
- `Change template` stays on the canvas card: the header offers Rename and Delete but no template control, so it is not duplicated and is the card's remaining reason to exist. The artifact receipt (`purpose.md`, `schema.md`) and the wiki name/scenario heading stay with it as its context.
- The `No wiki yet.` empty state and its single `btn primary` `Create Wiki` action stay. It is the canvas's AC-quoted empty state naming the next step, not a second copy of the header's persistent chrome control, and it is the only `btn primary` in the file.
- `Select a file to preview.` stays present in `WikiWorkbench.tsx` — Story 1.2 AC (`epics.md:338`) and Story 1.5 AC (`epics.md:415`) both quote it. Only its visibility while a Preview is docked changes.
- Every invariant an assertion currently pins in `WikiWorkbench.tsx` must end up pinned somewhere real — retargeted to its new owner, never merely deleted.
- One `<h2>` only; the shell keeps the page `<h1>` (`create-wiki-ui.test.ts:202-210`).

**Block If:**
- Making the sentence conditional turns out to need shell selection state plumbed into `WikiWorkbench` (a new context or prop through `page.tsx`). That is a shell refactor, not this cleanup — HALT rather than widen scope.

**Never:**
- Do not delete the sentence outright, and do not move it into the shell or `ModeCanvas`.
- Do not touch `WikiSwitcher.tsx`'s behaviour, `page.tsx`, `Workbench.tsx`, or the `deferred-work.md` ledger.
- Do not add a client fetch, a second write path, or a `router.push`/`<Link>` anywhere.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two wikis, Wiki mode, no row picked | `wikis.length === 2`, `currentWikiId` set, `selection === null` | Exactly one `Active wiki` combobox (the header's) and exactly one `New Wiki` button in the document; the card shows name, scenario, receipt, `Change template`, and the preview sentence | No error expected |
| Header switch | Owner changes the header `<select>` | One `PUT /api/wikis/current`; the canvas card issues none because it has no switcher | Failure renders in the header's own alert, unchanged |
| Row picked | `selection` set, so the shell writes `data-preview="true"` | The docked `PreviewColumn` is the only preview surface on screen; the canvas sentence is hidden by CSS | No error expected |
| One wiki | `wikis.length === 1` | Header still renders `New Wiki` (and its `<select>`); the card renders no switcher — as before, since its old `<select>` was gated on `wikis.length > 1` | No error expected |
| Registry read failed | `unavailable` | Unchanged: `Your wikis couldn’t be loaded. Reload to try again.` as `role="alert"`, no create action | Read failure already flagged, not flattened |

</intent-contract>

## Code Map

- `src/components/WikiWorkbench.tsx` -- the canvas card. Delete: `New wiki` button (~:199-208), `Active wiki` label + `<select>` (~:211-233), `switching` state (:68), `switchWiki` (:109-127), and the `error` state (:62) plus its render block (:262-266) — `switchWiki` is `error`'s only writer, so it goes dead with it (`setError(null)` in `create` goes too). Add class `wb-canvas-preview-note` to the preview placeholder `<div>` (:256). Keep: heading + `headingRef`, `unavailable` branch, empty state, `create`, `replace`, `applyTemplate`, both dialogs, `busy`/`createError`/`templateError`/`pendingScenario`.
- `src/components/workbench/WikiSwitcher.tsx` -- READ ONLY. The surviving owner: `Active wiki` `<select>` (:262-285), `New Wiki` (:288-298), `switching` guard (:88, :144), Rename/Delete. Its header doc comment at :15-28 explains the duplication as deliberate — that paragraph is now stale and is the one edit allowed here.
- `src/app/globals.css` -- Canvas section. `.wb-empty--narrow { display: none; }` at :2683-2687 is the "two sentences, CSS reveals one" precedent; `.wb-shell[data-collapsed="true"] .wb-title-fallback` at :2656-2658 is the shell-attribute precedent. Add the new rule immediately after `.wb-empty--narrow`.
- `src/components/workbench/Workbench.tsx` -- READ ONLY. Publishes `data-preview={previewOpen}` on `.wb-shell` (:636) from `shouldDockPreview(mode, selection) && !settingsOpen` (:612). This is the attribute the new CSS rule reads; do not change it.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- the frozen counts. `:119` `fallbackFocusRef={headingRef}` × 2 (unchanged — both dialogs stay). `:128` the sentence (unchanged). `:134` `btn primary` × 1 (unchanged — empty state only). `:170-178` `disabled={switching}` / `if (switching) return;` **must retarget to `workbench/WikiSwitcher.tsx`**. `:214` `router.refresh()` × 3 **→ 2** (create + applyTemplate).
- `src/components/__tests__/create-wiki-flow.test.tsx` -- READ ONLY, must stay green. Mounts `WikiWorkbench` and clicks `Change template` (:70) and `Create Wiki` (:196, :208); renders with one wiki, so it never saw the removed `<select>`.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx` -- the mount pattern to copy for the new suite: `WorkbenchDataProvider` + `Workbench` + fetch stub for the sidecar probe + `await act(async () => {})` (:60-72).
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- READ ONLY, must stay green. `getByLabelText("Active wiki")` against `WikiSwitcher` alone (:83, :414).
- `src/lib/__tests__/workbench-left-column.test.ts:585-600` and `src/lib/__tests__/workbench-split.test.ts:1240-1250` -- CSS-ordering assertions keyed on the literal `.wb-shell[data-preview="true"] {` and on `lastIndexOf("grid-template-columns")`. The new rule is a descendant selector carrying neither literal, so placing it in the Canvas section cannot disturb them — verify, do not edit.
- `src/lib/__tests__/workbench-chrome.test.ts:51-58, 386-400, 531-535` -- `shellBlocks().rules` spans from `.wb-shell {` to EOF and bans `var(--ink)`/`var(--paper)`/`var(--accent)`; `:534` pins `className="wb-canvas-pad"` on the card. The new rule must use no banned token and the `wb-canvas-pad` class must stay.

## Tasks & Acceptance

**Execution:**
- `src/components/WikiWorkbench.tsx` -- delete the `New wiki` button and the `Active wiki` label + `<select>`, then delete `switching`, `switchWiki` and the `error` state with its render block; collapse the now single-child flex wrapper around the name/scenario block -- the header owns switching and creating, and the leftover state has no writer once the switcher is gone.
- `src/components/WikiWorkbench.tsx` -- add `wb-canvas-preview-note` to the preview placeholder `<div>` (keeping its existing utility classes) and rewrite the component doc comment -- the sentence needs a CSS hook, and the current comment describes a card that owns controls it no longer has.
- `src/app/globals.css` -- add `.wb-shell[data-preview="true"] .wb-canvas-preview-note { display: none; }` directly after `.wb-empty--narrow`, with a comment naming DW-39 and why the state's owner decides in CSS -- the canvas is `children` of the shell and cannot see `previewOpen`.
- `src/components/workbench/WikiSwitcher.tsx` -- rewrite only the "This is a SECOND switcher, not a moved one" paragraph of the header doc comment -- it now documents a duplication that no longer exists.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- retarget the two switching-guard assertions to `workbench/WikiSwitcher.tsx`, change the `router.refresh()` count to 2, and add negative pins that `WikiWorkbench.tsx` contains no `Active wiki`, no `wiki-workbench-switcher`, no `/api/wikis/current` and no `New wiki`, plus positive pins for `wb-canvas-preview-note` in both the component and the CSS rule -- the counts are the freeze this bundle exists to lift, and the negatives are what stops the controls coming back.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- NEW mounted suite, two describes: (1) render `WorkbenchDataProvider` + `Workbench` with `WikiWorkbench` (two wikis) as children and assert the one-viewport counts on the rendered DOM; (2) prove the DW-39 rule really hides the sentence — slice the `.wb-shell[data-preview="true"] .wb-canvas-preview-note` block out of the real `src/app/globals.css`, inject only that block into a `<style>` element, render `WikiWorkbench` inside a `<div className="wb-shell" data-preview="true">` host, and assert `getComputedStyle(note).display === "none"`; then assert the real mounted shell publishes `data-preview="false"` by default with the sentence visible -- the source scan is a proxy; "two switchers at once" and "hidden while docked" are only observable on rendered DOM. Slice the rule rather than restating it so the test cannot pass against a literal that has drifted from the stylesheet, and inject only that block because jsdom cannot parse the whole Tailwind v4 file.

**Acceptance Criteria:**
- Given the shell mounted in Wiki mode with two wikis and a current wiki, when the document is queried, then exactly one element is labelled `Active wiki`, exactly one button is named `New Wiki`, exactly one button is named `Change template`, and exactly one node holds the text `Select a file to preview.`
- Given that mounted shell, when the header `<select>` is changed to the other wiki, then exactly one `fetch` to `/api/wikis/current` is issued.
- Given the shell mounted with no wiki at all, when the canvas renders, then `No wiki yet.` and one `btn primary` `Create Wiki` are still on screen and the header still offers `New Wiki`.
- Given the canvas card rendered under a host carrying `data-preview="true"` with the stylesheet's own rule applied, when the preview sentence's computed style is read, then `display` is `none`; and given the real shell with no row picked, then it carries `data-preview="false"` and the sentence is on screen.
- Given the full suite, when `pnpm test` runs, then every existing suite is green with no assertion deleted rather than retargeted.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 6: (high 0, medium 2, low 4)
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` The mounted create-control count used the exact string `New Wiki`, so restoring the deleted `New wiki` (lower-case `w`) passed every mounted assertion. Counts now match `/new wiki/i`, one `<select>` is counted document-wide, and a new label-proof test presses every canvas button and asserts none opens the `Create Wiki` dialog. Verified by mutation: restoring the deleted JSX fails 3 tests.
  - `[medium]` `[patch]` The retargeted switching-guard assertions were satisfied by `WikiSwitcher`'s Rename/Delete copies of `disabled={switching}`, so the `<select>`'s own guard could be deleted with the suite green, and no test executed the switch-failure path. Added mounted tests: mid-flight the switcher is disabled and a second pick starts no second PUT; a failed switch renders the switcher's own alert, keeps the live wiki selected, and does not refresh. Verified by mutation: removing either half of the guard fails the lock test.
  - `[medium]` `[patch]` Retiring the card's `switchWiki` made `page.tsx`'s `key={currentId}` the only thing keeping the card's `useState`-seeded id in sync — and `applyTemplate` aims its overwrite at that id — while the only pin was a source-text match. Added an end-to-end mounted test over the keyed composition (switch → refreshed data → canvas names the new wiki and `Change template` POSTs to its id) plus the unkeyed control case that shows the card going stale.
  - `[low]` `[patch]` The new CSS comment claimed "same mechanism as the Graph pair", which swaps on a media query; the actual precedent is `.wb-title-fallback`'s shell-attribute rule. Comment corrected and the deliberate absence of any at-rule wrapper stated.
  - `[low]` `[patch]` `previewNoteRule()` sliced the rule out of its cascade context, so wrapping it in `@media` would keep all four DW-39 assertions green while the narrow stacked layout showed both surfaces. The helper now checks brace depth ahead of the rule and throws a named error. Verified by mutation.
  - `[low]` `[patch]` The source-scan negatives banned one label spelling (`New wiki`) and nothing mechanical. Now comment-stripped and banning `wikis.map`, `switchWiki`, `setSwitching`, the write route, the old element id, and both labels case-insensitively.
  - `[low]` `[patch]` `WikiSwitcher`'s `pendingId`-reset comment still justified itself with "a later switch made from Story 1.2's canvas card" — a path this change deleted. Rewritten to name the paths that remain.
  - `[low]` `[patch]` `create-wiki-ui.test.ts`'s docblock claimed there is no jsdom or testing-library while the same file now points at a jsdom suite, and the `router.refresh()` test title claimed both remaining writes change the live wiki. Both corrected.

### 2026-08-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 18
- addressed_findings:
  - `[low]` `[patch]` `previewNoteRule()` counted raw braces across the whole 73KB preceding the rule, comments included, so one unbalanced brace in any future `globals.css` comment would make the helper throw "is nested N block(s) deep (an @media or @supports wrapper)" — a false diagnosis taking all four DW-39 cases down with it. Comments are now stripped before counting. (Checked: the file's existing comment braces are balanced today, so this was latent, not live.)
  - `[low]` `[patch]` The rule slice ended at `css.indexOf("}", start)`, so a rule that ever gained a nested block — Tailwind v4 permits native nesting — would be injected truncated and jsdom would drop it silently. Replaced with a brace-depth walk to the matching close.
  - `[low]` `[patch]` The label-proof test's one load-bearing negative, `queryByRole("dialog", { name: "Create Wiki" })`, was an exact-string match in the suite that had deliberately moved every other count to case-insensitive regex for that exact reason, and it had no positive control — a query that could never resolve would pass the loop while proving nothing. Now `/create wiki/i`, followed by opening the header's create control and asserting the query does find the dialog.
  - `[low]` `[patch]` The read-failure test set `unavailable` on the card while the provider hard-coded `registryUnavailable: false`, rendering a document `page.tsx` cannot produce (both come from the same `wikiRegistry.unavailable` at `page.tsx:113,138`) — so the I/O matrix row's "no create action" was only ever checked canvas-scoped, while the header went on offering `New Wiki` beside the alert. `data()` now takes the flag and the assertion is document-wide. Verified by mutation: setting it back to `false` fails the test.

## Design Notes

Why CSS and not a prop: `WikiWorkbench` is server-rendered in `page.tsx` and reaches the shell as `children`, so it cannot read `previewOpen` without a new context. The shell already publishes that state as `data-preview` on `.wb-shell`, and this file already resolves two other "exactly one of these is visible" questions the same way — `.wb-title-fallback` (collapsed column) and `.wb-empty--wide`/`--narrow` (Graph width, UX-DR24). `display: none` removes the sentence from the accessibility tree as well as the viewport, so no user perceives the contradiction DW-39 names.

```css
/* Exactly one preview surface at a time (DW-39): the docked column and this
   sentence describe the same slot, and the canvas is `children` of the shell,
   so the state's owner decides it here rather than through a prop it cannot
   see — same mechanism as the Graph pair above. */
.wb-shell[data-preview="true"] .wb-canvas-preview-note {
  display: none;
}
```

## Verification

**Commands:**
- `pnpm test` -- expected: both the `node` and `dom` projects green, including the new `wiki-canvas-duplication` suite; `create-wiki-flow`, `wiki-switcher-lifecycle`, `workbench-left-column`, `workbench-split` and `workbench-chrome` unchanged and passing.
- `pnpm lint` -- expected: clean; in particular no unused `useState`/`error`/`switching` binding left behind in `WikiWorkbench.tsx`.
- `pnpm exec tsc --noEmit` -- expected: clean.

**Manual checks (if no CLI):**
- Read the final `WikiWorkbench.tsx` and confirm the card renders exactly one control cluster (`Change template`) plus the receipt and the preview sentence, and that no `PUT` to `/api/wikis/current` remains in the file.

## Auto Run Result

Status: done

**Summary of implemented change.** This run was a follow-up review pass on an
already-`done` spec (`followup_review_recommended: true` from the previous
pass); no product code was re-derived. The shipped change stands: the Wiki
canvas card's `Active wiki` `<select>` and `New wiki` button are retired along
with the dead `switchWiki`/`switching`/`error` machinery (DW-33), leaving
`WikiSwitcher` the single owner of switching and creating, and the card's
`Select a file to preview.` sentence is withdrawn by CSS off the shell's own
`data-preview` attribute while the real Preview column is docked (DW-39). Four
low-severity defects, all in the test scaffolding this bundle added, were
patched in this pass.

**Files changed in this pass.**
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` — hardened `previewNoteRule()` (comment-stripped brace counting, brace-depth walk to the matching close), made the label-proof dialog negative case-insensitive and gave it a positive control, and made the read-failure fixture a composition `page.tsx` can actually produce so its "no create action" claim holds document-wide.
- `_bmad-output/implementation-artifacts/spec-dw-33-retire-duplicate-wiki-canvas-controls.md` — this pass's triage-log entry, one new deferred item, this result.

**Review findings breakdown.** 4 layers ran (blind-hunter, edge-case-hunter,
verification-gap, intent-alignment). 0 intent_gap, 0 bad_spec, 4 patched, 1
deferred, 18 rejected.

Notable rejections, with the authority for each:
- *Two create entry points survive (header `New Wiki` + canvas `Create Wiki`)* — the intent sanctions this explicitly: the empty state's action "is the canvas's AC-quoted empty state naming the next step, not a second copy of the header's persistent chrome control."
- *Collapsing the left column leaves no Wiki control reachable* — raised independently by three layers and demonstrated empirically by the verification-gap reviewer, but already captured as deferred item 5 from the previous pass; not re-filed.
- *`Change template` can race a header switch before the keyed remount lands* — the same root cause as deferred item 1 (the card seeds `useState` from props instead of reading `WorkbenchDataProvider`), already filed.
- *The DW-39 rule sits at `globals.css:2696`, away from the `[data-preview]` cluster at 3604+* — placement was directed by the spec, and the rule is a descendant `display: none` with no specificity tie to the shell grid, so ordering is cascade-safe. Discoverability only.
- The remainder were test-organization preferences (suite naming, `describe` scope, which file two `WikiSwitcher` cases belong in), prose-drift notes in historical implementation artifacts, and restatements of the above.

**Follow-up review recommendation.** `false`. Patched this pass: high 0,
medium 0, low 4. Score = 3×0 + 1×4 = 4, below the threshold of 5, and no
patched finding was high severity.

**Verification performed.**
- `vitest run` (via `./node_modules/.bin/vitest`) — 218 files, 4523 tests, all passing; both the `node` and `dom` projects green, `wiki-canvas-duplication` at 15 tests. Note: `pnpm test` and `pnpm exec` both fail in this working copy with `ERROR packages field missing or empty`, a pnpm/workspace resolution problem unrelated to this change, so the binary was invoked directly.
- `eslint` — exit 0. (Three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, not from this change.)
- `tsc --noEmit` — exit 0, no output.
- Mutation check on the patched read-failure assertion: reverting `registryUnavailable` to `false` fails that test, confirming the new document-wide negative bites.

**Residual risks.**
- The DW-39 rule is still exercised sliced out of its cascade rather than as `globals.css` computes. The brace-depth guard catches a wrapper opened *before* the rule; it cannot see a later, higher-specificity override of `.wb-canvas-preview-note`. jsdom cannot parse the whole Tailwind v4 file, so this is a floor, not an oversight.
- The two `page.tsx` keyed-remount tests assert against `keyedShell()`, a hand-built replica with the key hardcoded in the test file. If `page.tsx` dropped its key those tests would still pass; `page.tsx` itself remains pinned only by the literal scan in `workbench-left-column.test.ts:239-250`.
- DW-39 is verified at one width. The narrow (<900px) layout, where the Preview stacks as a fourth row beside this sentence, has no rendered coverage — the brace-depth guard stands in for it structurally.
- `_bmad-output/implementation-artifacts/deferred-work.md` carries uncommitted orchestrator edits (DW-33/DW-39 marked resolved, DW-174–179 filed). Per this run's instructions the ledger is the orchestrator's to own, so it was neither modified nor committed here and remains staged for the caller.

