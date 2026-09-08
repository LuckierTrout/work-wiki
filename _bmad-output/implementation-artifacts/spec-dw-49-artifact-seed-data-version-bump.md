---
title: 'Seeding and re-template move the dataVersion refresh signal (DW-49, DW-57)'
type: 'bugfix'
created: '2026-08-18'
status: 'done'
baseline_revision: '64da8248ec7719a0a62a17283a5eae094c289b3d'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `renameWiki` rewrites `purpose.md` under the tenant lock without moving
      `dataVersion`, so a Preview open on that artifact keeps the old heading.
    evidence: |-
      `retitlePurpose` (src/lib/wikis.ts) writes the retitled `purpose.md`
      through the same tail-less `putWikiArtifact` the seeder uses, and
      `renameWiki` adds no bump. Renaming a NON-current Wiki changes no
      `currentWikiId`, so `Workbench`'s selection-reset effect does not fire
      either — the same DW-57 shape, one artifact over. Milder than DW-57
      because `purpose.md` is not in `EditableArtifactFile`, so the stale column
      is read-only and there is no silent-revert half. Out of scope here: the
      bundle intent names the seeding and re-apply paths only.
    location: >-
      src/lib/wikis.ts (renameWiki / retitlePurpose)
    severity: low
  - summary: >-
      A re-apply whose `restoreSeededFiles` compensation itself fails leaves
      changed bytes on disk with no `dataVersion` bump at all.
    evidence: |-
      `restoreSeededFiles` is fail-soft per entry: it warns and swallows, so a
      restore that cannot write leaves the wiki with some NEW template bytes
      (the state its own warning calls "may now describe two different scenario
      templates") while `applyScenarioTemplate` re-throws and skips the tail.
      An open Preview then holds bytes that really did change with nothing to
      tell it so. Rare and already-degraded, but the one path where "no commit
      means nothing to refresh to" is not true.
    location: >-
      src/lib/wikis.ts (applyScenarioTemplate catch / restoreSeededFiles)
    severity: low
  - summary: >-
      DW-49's raw-source half is untouched — no writer under `tenants/<t>/raw/`
      exists yet, so it needs re-checking when Epic 2 Ingest lands one.
    evidence: |-
      DW-49 names three classes of bypassing writer: template seeding, raw
      source files, and "any later writer that lands bytes the Files tab
      renders". Only the first is closed here. A grep of `src/lib` finds no
      writer under `tenants/<t>/raw/` today, so there is nothing to bump; the
      guard test in `workbench-data-version.test.ts` will fail the moment a
      fourth bump site appears, which is the intended tripwire.
    location: >-
      src/lib/wikis.ts, src/lib/lifecycle.ts
    severity: low
  - summary: >-
      `dataVersion` is one global key with no tenant segment, so the two new
      bumps force a `router.refresh()` in every open Workbench of every other
      tenant too.
    evidence: |-
      `DATA_VERSION_KEY = "data-version"` (src/lib/data-version.ts:31) has no
      owner in it, and `GET /api/workbench/version` serves that single integer
      to everyone. Pre-existing — `writeWikiArtifact` and the page lifecycle
      already bump the same global key — but this change widens the set of
      operations that trigger a cross-tenant server re-render from "someone
      edited a page" to "someone anywhere created a Wiki". Not a correctness
      bug: a refresh is idempotent and each client re-renders its own tenant's
      data. The fix is a per-tenant key, which is a storage-layout change well
      outside this bundle.
    location: >-
      src/lib/data-version.ts:31 (DATA_VERSION_KEY), src/app/api/workbench/version/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** `seedWikiArtifacts` (`src/lib/wikis.ts`) writes `purpose.md` and `schema.md` through the unlocked, tail-less `putWikiArtifact`, so neither create nor a Scenario Template re-apply raises `dataVersion` — only `writeWikiArtifact` does. A Preview left open on `schema.md` across a confirm-gated re-apply therefore keeps pre-template bytes (its fetch effect is keyed on `[selection, dataVersion, editing]` and a re-apply moves none of the three), and the owner is left editing and saving a Schema that no longer exists on disk.

**Approach:** Give the two seeding callers — `createWiki` and `applyScenarioTemplate` — the same fail-soft `bumpDataVersion()` tail `writeWikiArtifact` already has, fired after the tenant lock is released and only when the whole seed committed. Update the `seedWikiArtifacts` docblock, which currently states as a deliberate design fact that seeding does not bump.

## Boundaries & Constraints

**Always:**
- Fire `bumpDataVersion()` OUTSIDE `withFileLock(wikiLockKey(owner))`. `bumpDataVersion` takes `DATA_VERSION_LOCK`, and `withFileLock` is not reentrant; nesting the two keys here would invent a lock order nothing else in the codebase takes and risks a tenant-wide deadlock. The existing tail at `writeWikiArtifact` is the shape to copy.
- Fail-soft: wrap the bump in `try/catch` and `logger.warn` on failure, exactly like `writeWikiArtifact`'s tail. A create or re-apply whose bytes landed must never be reported as failed because the counter did not move.
- Bump only on SUCCESS. The compensation paths (`discardCreatedWikiDirectory`, `restoreSeededFiles`) re-throw; a run that reaches the `catch` must not bump, because it restored or discarded the bytes.
- Exactly one bump per successful call, not one per seeded file — the signal is monotonic and a consumer only needs "it moved forward".
- Keep `putWikiArtifact` and `seedWikiArtifacts` tail-less and unlocked. The bump belongs with the callers that own the operation, matching the docblock's own "belongs with whichever story owns create and re-template".

**Block If:**
- Firing the bump at either caller cannot be done without holding `wikiLockKey(owner)` across `DATA_VERSION_LOCK`.

**Never:**
- Do NOT route artifact seeding through `runPageLifecycleOp` / `writeWikiPageWithSideEffects` — that would move the files into `tenants/<t>/wiki/`, where `readActiveWikiSchema()` does not look and `reconcileSilos()` would sweep them.
- Do NOT add an activity-log line to seeding. Create and re-template are registry operations, not edits; only the log tail of `writeWikiArtifact` names a Schema edit.
- Do NOT add a bump to `setCurrentWiki`, `renameWiki`, `deleteWiki` or `saveWorkspaceProfile` — out of scope; `WikiSwitcher` owns the registry-change refresh.
- Do NOT touch raw-source writes (DW-49's other half): no writer under `tenants/<t>/raw/` exists in `src/lib` yet, so there is nothing to bump; it arrives with Epic 2 Ingest.
- Do NOT change `PreviewColumn.tsx`, `previewFetchPlan`, or the artifact route's version precondition — the read-side wiring already refreshes on a bump, and DW-38's precondition already 409s a stale save.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create succeeds | `createWiki(owner, {name, scenario})` on a tenant under `MAX_WIKIS` | Returns the record; `readDataVersion()` is exactly one higher than before the call | No error expected |
| Re-apply succeeds | `applyScenarioTemplate(owner, id, otherScenario)` on an existing Wiki | Returns the record; `readDataVersion()` is exactly one higher | No error expected |
| Counter store is down | `putIndex` rejects during the tail | Create/re-apply still resolve with the record; the seeded bytes are on disk; a `logger.warn` names the unmoved signal | Swallowed, never thrown |
| Seed faults | any `writeFile` in `seedWikiArtifacts` or `writeRegistry` rejects | The original storage error propagates; compensation runs; `readDataVersion()` is UNCHANGED | Original error re-thrown, not the bump's |
| Unknown wiki id | `applyScenarioTemplate(owner, "nope", scenario)` | Returns `null`, writes nothing; `readDataVersion()` is UNCHANGED | No error expected |
| Rejected input | `createWiki` over `MAX_WIKIS`, or a non-creatable scenario | Throws `ClientInputError`; `readDataVersion()` is UNCHANGED | Error propagates unchanged |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:296-317` -- `putWikiArtifact`: the one place artifact bytes are written; unlocked and tail-less on purpose. Leave as is.
- `src/lib/wikis.ts:320-353` -- `seedWikiArtifacts` + its docblock. The docblock's "no `dataVersion` bump — seeding's half of that signal belongs with whichever story owns create and re-template" is the sentence this story makes false; rewrite it to say the callers own the bump and why it cannot live here (already inside `wikis:<tenant>`).
- `src/lib/wikis.ts:513-579` -- `writeWikiArtifact`: the EXACT tail shape to copy — lock released first, then `try/catch` + `logger.warn` per effect. Its "WHY THE TAIL IS OUTSIDE THE LOCK" paragraph is the lock-ordering rationale to reference.
- `src/lib/wikis.ts:608-644` -- `createWiki`: `withFileLock(wikiLockKey(owner), …)` wraps read-registry → seed → registry write, with `discardCreatedWikiDirectory` compensation. The bump goes AFTER this `withFileLock` resolves, before returning the record.
- `src/lib/wikis.ts:654-692` -- `applyScenarioTemplate`: same lock, `snapshotSeededFiles`/`restoreSeededFiles` compensation, and an early `return null` for an unknown id — the bump must not fire on that path.
- `src/lib/data-version.ts` -- `bumpDataVersion()` already swallows its own errors and returns `0` on failure (`DATA_VERSION_LOCK` is taken inside). The caller-side `try/catch` is belt-and-braces, consistent with `writeWikiArtifact`.
- `src/components/workbench/PreviewColumn.tsx:252-349` -- read-only evidence: the fetch effect's deps are `[selection, dataVersion, editing, retryNonce]` and `previewFetchPlan` returns `{fetch:true, reset:false}` for a same-row bump while not editing (a silent refresh), `{fetch:false}` while editing (the draft survives). No change needed here.
- `src/lib/workbench-data-version.ts:180-190` -- `previewFetchPlan`, the executed decision above. Read-only.
- `src/app/api/workbench/artifact/route.ts:145-166` -- read-only evidence: the PUT already carries DW-38's version precondition, so a save from a stale editor 409s rather than silently reverting.
- `src/lib/__tests__/wikis.test.ts` -- suites `create a wiki from a scenario template` (:77), `applying a different scenario template` (:305), and the compensation suite (:855) with its per-write fault injection; the new assertions belong alongside these.
- `src/lib/__tests__/wiki-schema-edit.test.ts:35,~415,~450` -- the pattern for `readDataVersion()` before/after assertions and for the `putIndex`-rejects fail-soft test.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- add a fail-soft `bumpDataVersion()` tail after the `withFileLock` in `createWiki`, guarded so it runs only when the locked body committed -- create seeds `schema.md`/`purpose.md`, and a second open tab must see them.
- `src/lib/wikis.ts` -- add the same tail to `applyScenarioTemplate`, skipped when the locked body returned `null` (unknown id) -- this is the DW-57 path: a re-apply moves no selection, mode or tree tab, so only the counter can un-stale an open Preview.
- `src/lib/wikis.ts` -- rewrite the `seedWikiArtifacts` docblock's no-bump sentence to state that the two callers now fire it after releasing `wikis:<tenant>`, and why it cannot be fired from inside the seeder -- the comment currently asserts the opposite as a design decision.
- `src/lib/__tests__/wikis.test.ts` -- add `readDataVersion()` assertions covering every I/O Matrix row: bump on create, bump on re-apply, no bump on unknown id, no bump on rejected input, no bump when a seed write faults (reuse the existing fault-injection helpers), and resolution-despite-`putIndex`-failure -- these are the only guards against a future refactor moving the bump back inside the lock or dropping it.

**Acceptance Criteria:**
- Given a Preview open on `schema.md` for the active Wiki and not in edit mode, when a Scenario Template is re-applied to that Wiki, then `dataVersion` moves forward and the Preview's fetch effect re-runs and renders the newly seeded Schema bytes.
- Given the same Preview open WITH an unsaved draft (editing), when a re-apply lands, then the draft is not taken from the owner (`previewFetchPlan` defers the read) and the deferred read happens when the editor closes.
- Given a create or re-apply whose seed or registry write faults, when the call rejects, then `dataVersion` is the same value it was before the call and the original storage error — not a bump error — is what propagates.
- Given a create or re-apply that succeeds while the config store rejects `putIndex`, when the call returns, then it resolves normally with the seeded bytes on disk and a warning is logged.
- Given `pnpm test`, when the suite runs, then `wikis.test.ts` and `wiki-schema-edit.test.ts` pass with no change to the existing `writeWikiArtifact` tail assertions.

## Spec Change Log

- 2026-08-18 -- Implementation found one file the Code Map did not name:
  `src/lib/__tests__/workbench-data-version.test.ts:600` ("has exactly one site
  inside wikis.ts, and it is the artifact writer"). That test ENCODES the
  design fact this story reverses -- it counts `bumpDataVersion()` in
  `wikis.ts` and asserts exactly one, with a comment saying `createWiki` and
  `applyScenarioTemplate` "are all forbidden from bumping (DW-49's seeding half
  belongs to whichever story owns those flows)". Rewritten rather than relaxed:
  it now pins three call sites, names which three, and additionally asserts
  each bump sits AFTER its `withFileLock(wikiLockKey(owner))` close -- so the
  "Always: fire the bump OUTSIDE the tenant lock" constraint is now guarded by
  a test rather than only by a comment. `seedWikiArtifacts` staying tail-less
  is guarded there too.
- 2026-08-18 -- Eight assertions in `src/lib/__tests__/wiki-schema-edit.test.ts`
  read `expect(await readDataVersion()).toBe(0)` after a `seed()` (which is a
  `createWiki`) to mean "this refused save moved nothing". Create now bumps, so
  `0` is no longer the post-seed baseline; each was rebased onto a `before`
  captured right after the seed. The intent ("the refused save moved nothing")
  and the `writeWikiArtifact` tail assertions are unchanged.

## Review Triage Log

### 2026-08-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 0, low 7)
- defer: 3: (high 0, medium 0, low 3)
- reject: 11
- addressed_findings:
  - `[low]` `[patch]` The two `putIndex`-rejects rows asserted on a substring only `data-version.ts`'s internal warn carries, so both passed with the callers' `try/catch` deleted. `bumpDataVersion` wraps its whole body and cannot reject, so that wrapper is unreachable redundant defence — kept per the Design Notes, but the rows now assert `scope === "data-version"` plus "bump failed; the signal did not move", say why, and gained the missing `expect(await readDataVersion()).toBe(before)`.
  - `[low]` `[patch]` `applyScenarioTemplate`'s docblock claimed the bump stops the owner saving a vanished Schema. `previewFetchPlan` returns `{fetch:false}` while `editing`, so the mid-edit read is deferred by design and DW-38's If-Match 412 is what refuses that save. Split into "WHY THE TAIL MATTERS MOST HERE" (a READING Preview) and "WHAT THE BUMP DOES NOT DO".
  - `[low]` `[patch]` The `seedWikiArtifacts` docblock named only `schema.md`; a seed rewrites `purpose.md` too, which goes stale identically. Both artifacts named now, in the source docblock and the test-suite docblock.
  - `[low]` `[patch]` `DataVersionWatcher.tsx:16-20` said creating a Wiki "moves no `dataVersion` at all" — false as of this change. Rewritten: a switch, rename or delete still moves nothing (so `WikiSwitcher` keeps its own `router.refresh()`); create and re-template now bump and reach the watcher.
  - `[low]` `[patch]` The `seedWikiArtifacts` tail-less guard sliced between two unchecked `indexOf` results and spanned ~90 lines through the compensation block, so a rename made `not.toContain` pass vacuously. Slice narrowed to the seeder alone with `-1` and ordering assertions on both bounds.
  - `[low]` `[patch]` `bodyOf` sliced to the next `\nexport `, pulling in the following export's JSDoc and any helper between them, so a bump could be attributed to the wrong function. Now bounded by the function's own close over comment-stripped source.
  - `[low]` `[patch]` The narrowed count regex made a `void bumpDataVersion()` or `.then()` chain inside the lock invisible. Both counts kept: identifier-level at 3 and await-form at 3.
  - `[low]` `[patch]` `beforeEach` mints a fresh `DATA_DIR`, so every `before` was 0 and the rows could not tell correct behaviour from a degraded store. Create-bump row now creates twice off a non-zero baseline; re-template and unknown-id rows assert `before > 0`; capped and rejected-input rows seed the counter to 7 and assert it.

Mutation checks run against the finished tests (each mutant applied, suite run, then reverted): bump moved inside the lock unawaited → caught by the identifier count; moved inside the lock awaited → caught by the ordering assertion; `createWiki`'s bump deleted → 7 rows fail; `previous + 1` replaced with a literal `1` → 2 rows fail.

Rejected (11, dropped): the unreachable caller `try/catch` itself (by design, mirrors `writeWikiArtifact` and the idiom `data-version.ts` endorses); "add a `requestDataVersionCheck()` nudge" (the originating tab already re-renders via `router.refresh()`; a second tab waits one poll tick, as every other write does); "create now fires two refreshes"; a bump for `deleteWiki` (it refuses the current Wiki, so no open Preview shows its artifacts); the lock-ordering guard's string-offset brittleness (its siblings in that file are source scans by design, and a bump inside the lock deadlocks the suite); the `putIndex` mock's breadth; the one `wiki-schema-edit` row that never asserted `dataVersion`; route-level 401/403/400 counter coverage; a bump timeout; "the mid-edit Preview is still stale" (deliberate, and covered by the docblock patch); and "no component test for the counter → refetch chain" (`preview-announcements.test.tsx` already exercises a `dataVersion` bump on an unchanged selection).

### 2026-08-18 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 13
- addressed_findings:
  - `[low]` `[patch]` `retitlePurpose`'s docblock still read "a `dataVersion` bump the sibling lifecycle operations do not have" — this change made that false for create and re-template. Rewritten to name the activity-log line as the reason it avoids `writeWikiArtifact`, and to record that `renameWiki` alone still rewrites bytes (`purpose.md`'s heading) without a bump, as DW-209.
  - `[low]` `[patch]` `applyScenarioTemplate`'s docblock called the `restoreSeededFiles` branch a "non-committing path" without qualification. `restoreSeededFiles` is fail-soft per entry, so a failed restore can leave new template bytes on disk with no bump at all — qualified in place and pointed at DW-210.
  - `[low]` `[patch]` `DataVersionWatcher.tsx` asserted as settled design that renaming a Wiki "moves no `dataVersion` at all", which is the shape of an open bug rather than a decision. Marked DW-209 without changing the switcher's refresh rationale.
  - `[low]` `[patch]` The guard test's comment said `lib/wikis.ts` has "eight exported writers" (it has seven) and its deliberately-absent list omitted `retitlePurpose` and `sweepOrphanWikiDirectories`. Count corrected and the list completed.

Rejected (13, dropped): the callers' unreachable `try/catch` (already rejected last pass — `data-version.ts`'s own docblock endorses the double guard, and the spec's Always clause requires the shape); the three new comments quoting `PreviewColumn`'s deps as `[selection, dataVersion, editing]` when the effect also lists `retryNonce` (the argument is unaffected and `workbench-data-version.ts:162` uses the identical pre-existing shorthand); "`DataVersionWatcher` names `WikiSwitcher` as the only other refresh site" (the docblock scopes itself to that directory, and `WikiSwitcher` does drive create — the claim checks out); the `toBe(0)` in "answers 404 when the registry names no current Wiki" (its own comment says there is no `createWiki` in that row); the "truncate and refuse to edit" row's missing counter assertion (rejected last pass, unchanged); the guard test's `closes[0]` earliest-close heuristic, its unasserted `bodyOf` disjointness, and `stripComments`' blanket block-comment pass (all speculative future-formatting risks in a guard that already carries two independent counts plus a direct seeder assertion); `BUMP_FAILED_WARN` reusing `data-version.ts`'s literal sentence; a bump for `deleteWiki` (an explicit Never in the intent); "re-applying the same scenario still bumps" (the seeder does not byte-compare, and the intent says bump on success); "the lock-ordering invariant has only source-text coverage" (unreproducible behaviorally — the two keys differ and nothing takes them in the opposite order); and "the ledger and spec updates are not in the reviewed diff" (finalization, not a defect).

## Design Notes

The tail belongs at the two callers, not inside `seedWikiArtifacts`, for the same reason `writeWikiArtifact` puts its tail after the lock: the seeder always runs while `wikis:<tenant>` is held, and `bumpDataVersion` takes `DATA_VERSION_LOCK`. Nesting them would be the only place in the repo that orders those two keys.

Shape to mirror (from `writeWikiArtifact`):

```ts
const wiki = await withFileLock(wikiLockKey(owner), async () => { /* …seed… */ });
if (!wiki) return null;            // applyScenarioTemplate's unknown-id path only
try {
  await bumpDataVersion();
} catch (error) {
  logger.warn("wikis", "the refresh signal did not move after …", error);
}
return wiki;
```

`bumpDataVersion` already swallows internally, so the `catch` is redundant defence — kept anyway so the tail reads identically at all three call sites and stays correct if that guarantee changes.

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/wikis.test.ts src/lib/__tests__/wiki-schema-edit.test.ts` -- expected: all pass, including the new `dataVersion` assertions
- `pnpm test` -- expected: no regressions anywhere in the suite
- `pnpm lint` -- expected: clean


## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `createWiki` and `applyScenarioTemplate` (`src/lib/wikis.ts`) each fire one fail-soft `bumpDataVersion()` after `withFileLock(wikiLockKey(owner))` releases, on the committed path only — the same tail shape `writeWikiArtifact` already carries. `putWikiArtifact` and `seedWikiArtifacts` stay tail-less and unlocked, so the bump belongs to the callers that own the operation. This is what un-stales a Preview left open on `purpose.md` or `schema.md` across a confirm-gated Scenario Template re-apply (DW-49, DW-57).

**Files changed.**
- `src/lib/wikis.ts` — the two out-of-lock `bumpDataVersion()` tails, plus docblocks on `createWiki`, `applyScenarioTemplate`, `seedWikiArtifacts` and `retitlePurpose`.
- `src/components/workbench/DataVersionWatcher.tsx` — comment only: create and re-template are now the two registry operations that also reach this watcher; rename is marked as the remaining gap (DW-209).
- `src/lib/__tests__/wikis.test.ts` — the new DW-49 suite: one bump per successful create and re-template, none on unknown id, cap rejection, input rejection, or either compensation path.
- `src/lib/__tests__/wiki-schema-edit.test.ts` — refusal rows now compare against a post-seed baseline instead of a literal `0`, since `createWiki` itself moves the counter.
- `src/lib/__tests__/workbench-data-version.test.ts` — the guard is rewritten from "exactly one bump site in `lib/wikis.ts`" to "exactly three, each outside the tenant lock".

**Review findings breakdown (this pass).** 4 patches applied (all low, all comment accuracy): the stale `retitlePurpose` docblock; the unqualified "non-committing path" claim on the `restoreSeededFiles` branch; `DataVersionWatcher` stating rename's staleness as settled design; and the guard test's writer count and absent-list. 1 item deferred (low): `dataVersion` is a single global key, so these bumps refresh every tenant's open Workbench. 13 findings rejected — listed in full in the triage-log entry above.

**Verification performed.**
- `npx vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/workbench-data-version.test.ts` — 154 passed.
- `npx vitest run` — 226 files, 4752 tests, all passed.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, no errors).
- `pnpm test` from the spec's Verification block is not a script in this repo (`pnpm` errors with `packages field missing or empty`); `npx vitest run` is the equivalent and was run in its place.

**Residual risks.**
- The lock-ordering constraint ("bump OUTSIDE `wikis:<tenant>`") is pinned by a source-text scan, not by an executed test. Nothing in the repo takes `DATA_VERSION_LOCK` before the tenant key, so the deadlock it guards against is not reachable today and cannot be demonstrated behaviourally.
- No test joins the writer half to the reader half: nothing drives a create or re-template and then observes a Preview refetching. The two halves are each covered independently (`wikis.test.ts` for the counter, `preview-announcements.test.tsx` for the refetch), and the intent's Never list forecloses touching the read side.
- The callers' `try/catch` is unreachable — `bumpDataVersion` swallows internally and answers `0`. Kept deliberately, per the spec's Always clause and the idiom `data-version.ts` documents; the consequence is that a failed bump is attributable only to the generic `data-version` log scope, not to which caller triggered it.
- Three deferred gaps stay open by scope: rename (DW-209), a failed `restoreSeededFiles` compensation (DW-210), and raw-source writers, which do not exist yet (DW-211).
