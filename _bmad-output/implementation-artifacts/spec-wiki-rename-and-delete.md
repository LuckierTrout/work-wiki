---
title: 'Wiki rename, delete, and orphan-directory sweep'
type: 'feature'
created: '2026-08-17'
status: 'done'
baseline_revision: 'bc48143f0e7fde7040f98b3991513cb695f10d76'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      The orphan-directory sweep has no trigger other than a successful delete, so a
      tenant that never deletes never reclaims a directory orphaned by a
      normalizeRegistry drop.
    evidence: |-
      `sweepOrphanWikiDirectories` is exported and locked but has no caller in `src/`
      outside the test suite; `deleteWiki` is the only production path that reaches
      the sweep, and deleting the last (always current) Wiki is refused. The repo
      already has a home for this class of work: `scanForMaintenance` in
      `src/lib/maintenance.ts`, cron-driven via `src/app/api/tasks/scan/route.ts`,
      which emits a structurally identical `orphan-page` op for "file on disk, no
      index entry". DW-18's intent names a registry READ as the orphan's cause but
      does not say what should trigger the cleanup, so the delete-side-effect
      reading was chosen at planning time rather than settled by the intent.
    location: >-
      src/lib/wikis.ts (sweepOrphanWikiDirectories) / src/lib/maintenance.ts
    severity: medium
  - summary: >-
      Wiki names are not unique and both the switcher and the new delete picker render
      the name alone, so two Wikis with the same name are indistinguishable at the
      moment of an irreversible delete.
    evidence: |-
      Neither `parseWikiName` nor the registry enforces uniqueness, and every
      `<option>` in `WikiSwitcher` (pre-existing) and in the delete picker (new)
      carries only `wiki.name` — no scenario, created date, or id fragment.
    location: >-
      src/components/workbench/WikiSwitcher.tsx
    severity: low
  - summary: >-
      WikiSwitcher offers its write controls with no client-side read-only signal, so
      on a read-only deployment the 403 arrives only after the owner has confirmed.
    evidence: |-
      All four routes gate on `isReadOnly()`, but the component renders New Wiki, the
      switcher, Rename and Delete unconditionally. Pre-existing for New Wiki and the
      switcher; the new controls inherit it. Other surfaces (PreviewColumn,
      WorkspacePurposeSettings) do carry a read-only signal.
    location: >-
      src/components/workbench/WikiSwitcher.tsx
    severity: low
  - summary: >-
      `withFileLock` is in-process only, so on a multi-isolate deployment the orphan
      sweep can delete the directory of a Wiki whose registry entry has not landed
      yet.
    evidence: |-
      `src/lib/lock.ts` documents the lock as in-process ("does not protect against
      multiple server processes"), and `createWiki` seeds `wikis/<id>/` BEFORE
      pushing the entry and writing the registry — both inside the lock, so a single
      Node process is safe. Under `build:cloudflare` / `open-next.config.ts` two
      isolates can hold the "same" lock at once: isolate A is mid-create with the
      directory on disk and no entry, isolate B deletes an unrelated Wiki and its
      sweep sees A's directory as an orphan. Every other registry operation has the
      same exposure, but this is the first one whose consequence is byte removal
      rather than a lost entry. A mtime grace period on sweep candidates, or a
      cross-process lock, would close it; both are design decisions past DW-18.
    location: >-
      src/lib/wikis.ts (sweepOrphans) / src/lib/lock.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** DW-18. `src/lib/wikis.ts` exposes create, re-template and set-current only, so a Wiki's name — baked into the `# <name>` heading of `purpose.md` at seed time — is permanent, a Wiki can never be removed, and a registry entry dropped by `normalizeRegistry` leaves its `tenants/<t>/wikis/<id>/` artifacts on disk with nothing referencing them (`writeRegistry`'s docstring at :240-250 acknowledges it avoids the problem rather than cleaning it up).

**Approach:** Add three lifecycle operations to `wikis.ts` — `renameWiki` (registry entry + the `purpose.md` heading), a `deleteWiki` that refuses the current Wiki and removes both the registry entry and the Wiki's directory, and `sweepOrphanWikiDirectories` — then wire `PATCH`/`DELETE /api/wikis/<id>` and Rename/Delete controls in the left-column `WikiSwitcher`.

## Boundaries & Constraints

**Always:** Every registry mutation runs inside `withFileLock(wikiLockKey(owner))`, and code already holding that key writes through the unlocked `putWikiArtifact` / `getStorage()` directly — `withFileLock` is not reentrant. Address Wiki files only through `wikiArtifactPath` / `wikiDirPath` (both validate the id). Rejections that a caller could have avoided are `ClientInputError` so routes answer 400; an unknown id returns `null` so routes answer 404. Routes mirror the existing ladder in `[id]/template/route.ts`: 401 → 403 read-only → 400 bad body → 404 unknown id.

**Block If:** nothing — the recorded decision fixes the semantics.

**Never:** Do not delete the current Wiki, and do not silently re-point `currentId` to make a delete succeed. Do not touch `tenants/<t>/wiki/**`, `tenants/<t>/raw/**`, the page index, Pages, or Sources. Do not add rename/delete controls to `src/components/WikiWorkbench.tsx` — `create-wiki-ui.test.ts:118-215` counts literals in that file (`btn primary` ×1, `router.refresh()` ×3, `fallbackFocusRef={headingRef}` ×2) and adding a control there breaks frozen assertions. Do not add an activity-log line or a `dataVersion` bump: `createWiki`, `applyScenarioTemplate` and `setCurrentWiki` have neither, and the UI refreshes with `router.refresh()`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rename happy path | id in registry, name `"  Q4   plan "` | Registry entry name is `"Q4 plan"` (trimmed, whitespace collapsed), `updatedAt` bumped, `purpose.md` first line is `# Q4 plan`, rest of the file byte-identical | No error expected |
| Rename rejected input | blank name, non-string, or > `MAX_WIKI_NAME_CHARS` | Nothing written | `ClientInputError` → 400 |
| Rename unknown id | id absent from registry | Returns `null`, nothing written | Route answers 404 |
| Rename with no `purpose.md`, or a file whose first line is not `# …` | artifact missing or unexpected shape | Registry still renamed; artifact left untouched | `logger.warn`, no throw |
| Delete non-current Wiki | id ≠ `currentId` | Entry removed from registry, `tenants/<t>/wikis/<id>/` removed, `currentId` unchanged | No error expected |
| Delete current Wiki | id === `currentId` | Nothing removed | `ClientInputError` → 400 |
| Delete unknown id | id absent from registry | Returns `null`, nothing removed | Route answers 404 |
| Orphan sweep | `wikis/<uuid>/` on disk with no registry entry | That directory removed and counted; directories whose name is not a UUID, and loose files, are left alone | Sweep failure inside delete is warned, never fails the delete |

</intent-contract>

## Code Map

- `src/lib/wikis.ts` -- the whole server-side change. `parseCreateWikiInput:148` holds the name rules to extract; `createWiki:419`, `applyScenarioTemplate:455`, `setCurrentWiki:491` are the shape to copy (lock, `readRegistry`, mutate, `writeRegistry`, return record or `null`); `putWikiArtifact:285` is the unlocked artifact putter; `readWikiArtifact:506` reads one artifact or `null`; `writeRegistry:245`'s docstring names the orphan problem this closes.
- `src/lib/wiki-paths.ts` -- `wikiDirPath` (the per-Wiki directory), `wikiArtifactPath`, `WIKI_ID_RE`, `validateWikiId`, `wikiLockKey`. Leaf module — do not make it touch storage.
- `src/lib/storage/types.ts` -- `deleteDirectory` (recursive, no-op when absent) and `listFiles(prefix)` (names only, `isDirectory` flag, `[]` on ENOENT) already exist; no provider change is needed.
- `src/lib/wiki-scenarios.ts:122` -- `renderPurposeMarkdown` puts `# <name>` on line 1; `MAX_WIKI_NAME_CHARS` is 80.
- `src/app/api/wikis/[id]/template/route.ts` -- the route template to mirror (auth, `isReadOnly()`, JSON parse guard, `ClientInputError` → 400, `null` → 404).
- `src/components/workbench/WikiSwitcher.tsx` -- where the controls go. Already has `wikis`, `currentWikiId`, the `send()` helper with `AbortSignal.timeout`, `failureMessage()`, and `router.refresh()`. Its tests (`workbench-left-column.test.ts:210-251`) are `toContain` only — no frozen counts.
- `src/components/ConfirmDialog.tsx` -- `body` is a `ReactNode`, so rename's input and delete's target picker live inside it; `confirmDisabled`, `error`, `busy`, `fallbackFocusRef` are already supported. Do not add a new dialog component.
- `src/app/globals.css:2845-2886` -- `.wb-wiki-switch*` rules. Chrome rules must resolve through `--wb-*` tokens only (`workbench-chrome.test.ts:358-370` bans `var(--ink|--paper|--accent)` in the shell block).
- `src/lib/__tests__/wikis.test.ts` -- real temp-`DATA_DIR` recipe for the lib suite. `src/lib/__tests__/wikis-routes.test.ts` -- mocked-collaborator recipe for the route contract. `src/components/__tests__/create-wiki-flow.test.tsx` -- mounted-component recipe (`render`/`fireEvent`/`waitFor`, stubbed `fetch`, mocked `next/navigation`).

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- extract the name rules from `parseCreateWikiInput` into a `parseWikiName(value)` helper and add `parseRenameWikiInput`; add `renameWiki`, `deleteWiki`, and `sweepOrphanWikiDirectories` -- one parser for both create and rename keeps the 80-char cap and the whitespace collapse in a single place.
- `src/app/api/wikis/[id]/route.ts` -- new file exporting `PATCH` (body `{ name }` → `{ wiki }`) and `DELETE` (→ `{ wiki }`) -- the id already sits in the path segment that `[id]/template` uses.
- `src/components/workbench/WikiSwitcher.tsx` -- add Rename (acts on the current Wiki) and Delete (target picked from the non-current Wikis, rendered only when `wikis.length > 1`), each behind a `ConfirmDialog` -- the switcher's selection IS `current`, so a delete control aimed at it would always be refused by the server.
- `src/app/globals.css` -- add a `.wb-wiki-switch-actions` row and give the new buttons the existing `.wb-wiki-switch-new` treatment -- three controls do not fit the 280px column on one line.
- `src/lib/__tests__/wikis.test.ts` -- cover every I/O matrix row against the temp `DATA_DIR`, including that a rename leaves the rest of `purpose.md` byte-identical and that a delete leaves the OTHER Wiki's directory intact.
- `src/lib/__tests__/wikis-routes.test.ts` -- cover the 401/403/400/404/200 ladder for `PATCH` and `DELETE`, and that a rejected request never reaches the lib call.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- mounted: Rename issues one `PATCH` to the encoded current id and refreshes; Cancel issues none; Delete confirms against the chosen non-current Wiki; the Delete control is absent with a single Wiki.

**Acceptance Criteria:**
- Given a Wiki created with a typo in its name, when the owner renames it from the Workbench, then the switcher shows the corrected name after the refresh and `purpose.md`'s heading reads the new name.
- Given two Wikis, when the owner deletes the non-active one, then it disappears from the switcher, the active Wiki is unchanged, and its directory is gone from storage.
- Given a single Wiki, when the owner opens the Wiki controls, then no Delete control is offered.
- Given a `wikis/<uuid>/` directory with no registry entry, when any Wiki is deleted, then the orphaned directory is removed too and the delete still reports success even if that cleanup fails.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 5, low 4)
- defer: 3: (high 0, medium 1, low 2)
- reject: 11: (high 0, medium 1, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The exported sweep would delete every Wiki directory when `wikis.json` is missing (`readRegistry` degrades to an empty registry) — skip the sweep and return 0 when the registry names no Wikis, with tests for a deleted and an empty registry against a populated disk.
  - `[medium]` `[patch]` Rename/Delete derived their target from `currentWikiId` while the `<select>` showed the optimistic `pendingId`, so a rename during an in-flight switch renamed the previous Wiki — both now derive from `value` and are disabled while `switching`, covered by three mounted tests.
  - `[medium]` `[patch]` A `deleteDirectory` throw propagated after the registry write had landed, 500ing a delete that had effectively happened — now warned and left to the sweep, with the record still returned.
  - `[medium]` `[patch]` The post-delete focus fallback never fired (the opener was still mounted at dialog close and unmounted afterwards, dropping the keyboard user on `<body>`) — focus is now moved to New Wiki via a flag-and-effect, asserted on `document.activeElement` after the list shrinks.
  - `[medium]` `[patch]` `wikisRootPath` re-expressed the `tenants/<t>/wikis` layout inside `wikis.ts`, slipping past the single-expression guard in `wiki-schema-edit.test.ts` — moved into `wiki-paths.ts` and the guard strengthened to catch the trailing-slash-free form.
  - `[low]` `[patch]` Enter did not submit the single-field rename dialog — now submits under exactly the `confirmDisabled` gate, with tests for both the ready and blank cases.
  - `[low]` `[patch]` The module docblock still claimed the repo has no DOM test environment, which the mounted suite added here disproves — justification restated on grounds that still hold.
  - `[low]` `[patch]` The route 404 tests built the URL from one id and passed another through `params`, so a route reading the id from the URL would still pass — both now carry the same id, and `idContext` no longer aliases `templateContext`.
  - `[low]` `[patch]` `.wb-wiki-switch-actions` could overflow the 280px left column — `flex-wrap: wrap` added.

### 2026-08-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 27: (high 0, medium 3, low 24)
- addressed_findings:
  - `[low]` `[patch]` A successful delete moved focus to New Wiki unconditionally, so with three or more Wikis it stole focus from a Delete button that survived the refresh and was correctly restored by `useDialogA11y` — the refocus is now claimed only when the control will unmount (`wikis.length <= 2`), with a mounted test for the surviving-opener case.
  - `[low]` `[patch]` `.wb-wiki-switch-action` had no disabled treatment, so both controls kept `cursor: pointer` and lit up on hover while disabled during an in-flight switch — the shell's existing `[disabled] { opacity: 0.6; cursor: default }` added and `:hover` narrowed to `:not([disabled])`.
  - `[low]` `[patch]` The rename input's Enter handler fired on the Enter that commits an IME composition, submitting a half-composed CJK name — guarded on `event.nativeEvent.isComposing`, with a test.
  - `[low]` `[patch]` A test comment claimed the route needs the `Content-Type` header to parse the body, which `Request.json()` ignores — the assertion is kept, the rationale restated on grounds that hold.
  - `[low]` `[patch]` The sweep test named "no wiki directory exists at all" returned at the empty-registry guard and never reached `listFiles`, so the missing-root path was unverified — it now creates a Wiki and removes only the `wikis/` tree (`wikis.json` is its sibling).
  - `[low]` `[patch]` `retitlePurpose`'s outer catch — the reason a rename does not 500 after the registry write has landed — had no test; the mirror of the delete path's `deleteDirectory` spy now pins it. Verified failing when the catch rethrows.

## Design Notes

**Delete order.** Write the registry first, then `deleteDirectory`. A crash between the two leaves an orphan directory — which the sweep in the same function is built to reclaim. The reverse order leaves a registry entry pointing at artifacts that no longer exist, which is the failure the UI cannot recover from.

**The sweep's trigger.** `normalizeRegistry` drops unusable entries during a plain *read*, so the sweep cannot run there without making reads destructive. It runs inside `deleteWiki`, under the lock it already holds, using the registry it has just written — the one moment a Wiki directory is legitimately removed. `sweepOrphanWikiDirectories(owner)` is exported (taking the lock itself) so it is directly testable and callable; `deleteWiki` uses the unlocked internal form.

**Sweep safety.** Only entries with `isDirectory === true` whose name matches `WIKI_ID_RE` and is absent from `registry.wikis` are removed. Anything else under `tenants/<t>/wikis/` is left alone, so a future sibling file or directory there is not collateral damage.

**Rename's artifact edit.** Replace only a leading `# …` line:

```ts
const lines = purpose.split("\n");
if (!/^#\s+/.test(lines[0] ?? "")) { logger.warn(...); return; }
lines[0] = `# ${name}`;
await putWikiArtifact(owner, wikiId, "purpose.md", lines.join("\n"));
```

Not `writeWikiArtifact` — that takes the lock this code already holds and fires a log/bump tail the sibling lifecycle operations do not have.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/wikis-routes.test.ts src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: the full suite still passes, in particular `create-wiki-ui.test.ts`, `workbench-left-column.test.ts` and `workbench-chrome.test.ts`.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** Wiki lifecycle for DW-18: `renameWiki`, `deleteWiki` and
`sweepOrphanWikiDirectories` in `src/lib/wikis.ts`, a `PATCH`/`DELETE
/api/wikis/<id>` route, and Rename/Delete controls in the left-column
`WikiSwitcher`. This run was a follow-up review pass over an already-`done`
spec: no production behaviour was re-derived, six low-severity patches were
applied.

**Files changed** (since `bc48143`):
- `src/lib/wikis.ts` — `parseWikiName`/`parseRenameWikiInput`, `renameWiki`, `retitlePurpose`, `sweepOrphans`/`sweepOrphanWikiDirectories`, `deleteWiki`.
- `src/lib/wiki-paths.ts` — `wikisRootPath`, the single expression for `tenants/<t>/wikis`.
- `src/app/api/wikis/[id]/route.ts` — new; `PATCH` and `DELETE` on the 401 → 403 → 400 → 404 ladder.
- `src/components/workbench/WikiSwitcher.tsx` — the two controls, their confirm dialogs, and post-delete focus handling.
- `src/app/globals.css` — `.wb-wiki-switch-actions` row, shared button face, disabled treatment.
- `src/lib/__tests__/wikis.test.ts` — lib coverage for every I/O matrix row, plus both fail-soft paths.
- `src/lib/__tests__/wikis-routes.test.ts` — the status ladder for both verbs.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` — new mounted suite (19 tests).
- `src/lib/__tests__/wiki-schema-edit.test.ts` — path-layout guard strengthened to catch the trailing-slash-free form.

**Review findings.** 6 patched (all low, listed in the triage log above), 1
deferred (in-process lock vs. the sweep on a multi-isolate deployment), 27
rejected. The rejected set was dominated by the sweep's treatment of a
`normalizeRegistry`-dropped entry — which the Intent names explicitly as the
orphan class to reclaim, so removing those directories is the requested
behaviour, not a defect — plus items already carried in `deferred` (name
uniqueness in the delete picker, no client-side read-only signal) and
suggestions the Intent's **Never** clause forbids (activity-log line,
`dataVersion` bump).

**Verification.**
- `npx vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/wikis-routes.test.ts src/components/__tests__/wiki-switcher-lifecycle.test.tsx` — pass.
- `npx vitest run` — 213 files, 4421 tests, all pass; `create-wiki-ui.test.ts`, `workbench-left-column.test.ts` and `workbench-chrome.test.ts` included.
- `npx eslint` — exit 0 (only pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `npx tsc --noEmit` — clean.
- Both new component tests were confirmed to FAIL against the pre-patch component, and the new rename fail-soft test to FAIL when its catch rethrows, so none of the three is vacuous.
- Note: `pnpm vitest`/`pnpm exec` error with "packages field missing or empty" in this working copy; `npx` was used instead.

**Residual risks.**
- Follow-up review recommended: **true** — patched this pass: high 0, medium 0, low 6; score `3×0 + 1×6 = 6` (≥ 5).
- The sweep is reachable only through `deleteWiki`, so a tenant that never deletes never reclaims a directory (deferred item 1).
- A `normalizeRegistry` drop now costs that Wiki's artifacts at the next delete rather than leaving them recoverable on disk. This is what the Intent asks for; the blast radius grows if `WikiRecord` gains a required field, since every previously-written entry would then normalize away.
- `retitlePurpose` splits on `"\n"`, so a hand-authored CRLF `purpose.md` loses the `\r` on its heading line. Seeded files are LF.

