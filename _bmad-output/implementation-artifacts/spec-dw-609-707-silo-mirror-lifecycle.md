---
title: 'DW-609: A page delete clears the whole silo; a merge-absorb keeps its Sources'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A merge-absorb strands the absorbed page's raw Sources at the absorbed
      slug's silo addresses, so a page later created at that slug inherits
      them in Files and the Sources pane.
    evidence: |-
      `removeSiloForPage(slug, tenant, { preserveRawSources: true })`
      (src/lib/silo.ts:311-347, reached from src/lib/merge.ts:676,741) leaves
      `tenants/<t>/raw/sources/<from>.md`, `tenants/<t>/raw/<from>.md` and both
      hashed trees in place at the ABSORBED slug's address, with no silo wiki md
      anchoring them. `listWorkbenchFilePaths` resolves `raw/` silo-primary
      (src/lib/workbench-files.ts:707-712) and `rawPathAllowed`'s refusal set
      covers hidden pages, not deleted ones, so those bytes keep listing. Slugs
      are reusable: recreating a page at `<from>` makes another page's
      provenance show up as the new page's Sources, and under a cross-owner
      merge (`bypassOwnerCheck`, src/mcp.ts:489) the survivor's owner cannot
      read the bytes at all because DW-40 resolves `raw/` strictly inside the
      owner's silo. Preserving in place is the recorded decision for this
      bundle, which records that "nothing reaps them"; the slug-reuse and
      cross-tenant consequences are not named anywhere, and no test covers the
      listing surface after a merge.
    location: >-
      src/lib/silo.ts:311
    severity: low
baseline_revision: '0db5a127aaeeef623baf8ebb7f46f2cb6ed9ca98'
---

<intent-contract>

## Intent

**Problem:** A normal page delete never routes through `removeSiloForPage` — `lifecycle.ts:618-639` deletes the silo wiki md, the flat wiki md and both revision layouts directly — so every OTHER per-page silo artifact (flat and hashed raw Sources, the discuss thread, binary assets) leaks, and the reverse-orphan pass cannot recover it because `reconcileSilos` discovers ghosts by scanning the very `tenants/<t>/wiki/*.md` the delete already removed (DW-609).

**Approach:** Add `removeSiloForPage` to the delete branch's existing fail-soft secondary-cleanup batch (2b–2d), leaving the silo wiki md's own delete where it is as the throwing primary step. The shared delete branch must distinguish a **discard** from a **merge-absorb**: `mergePages` hard-deletes the absorbed page through the SAME branch but first unions the absorbed page's `sources` into the SURVIVOR's frontmatter (`merge.ts:567-573`), so dropping the absorbed page's silo raw Sources would destroy provenance the survivor now claims. Thread a `preserveRawSources` flag from the delete entry point through the lifecycle op to the cleanup; when set, skip the raw-Source arms while still clearing discussions and assets.

## Boundaries & Constraints

**Always:**
- The silo wiki md delete stays where it is in step 2 and keeps THROWING. `removeSiloForPage` is added only to the fail-soft `cleanups` batch beside `deleteDiscussions`, so a raw/discuss/asset cleanup failure is logged and never fails an already-committed page delete.
- `removeSiloForPage` is called with `tenantForOwner(deletedOwner)` — the same tenant the primary md delete (`lifecycle.ts:623`) and `deleteRevisions` (`:620`) already use — so a page with an unknown owner cleans the default tenant, exactly as today's silo md delete does.
- Silo-only. Flat `raw/` bytes stay untouched: they belong to `deleteRawSourceBytes` / cascade delete.
- The shared delete branch takes a `preserveRawSources` option, default OFF. A **discard** delete leaves it off and clears the whole silo. The **merge-absorb** delete (`mergePages` → `deleteWikiPageWhileLocked`, BOTH the normal and the resume call site) sets it on, so the absorbed page's silo raw Sources survive while its discussions and assets are still cleaned. The flag reaches the cleanup through the lifecycle op, not bolted onto a caller that bypasses the branch.

**Block If:**
- The delete path turns out to have no fail-soft cleanup batch to extend (the 2b–2d `cleanups` array is gone), which would mean the failure-tolerance contract this change relies on no longer exists.

**Never:**
- Never widen `listRawSourceFilePaths`, `sourcesTreeFromFiles`, `isV1FileInScope`, the `/api/v1/.../sources/rescan` explicit-`paths` validator, or any Workbench UI shaping. **DW-707 is out of scope by recorded human decision** (run `20260902-121800-87bf`, escalation resolve #1): the surface on which a legacy-address Source must become visible — library reach vs. v1 rescan reach vs. Workbench Sources-pane reach — is a separate product decision, and DW-707 stays OPEN in the ledger. This bundle must not pre-empt it.
- Never change `rawPathSlug`/`rawPathAllowed`, `syncSiloForPage`, `reconcileSilos`' reverse-orphan discovery, or `listWorkbenchFilePaths`. `removeSiloForPage`'s body may change ONLY to accept the optional `{ preserveRawSources }` option; its unconditional behaviour stays byte-identical.
- Never make the new delete-time cleanup throwing, and never move it up beside `deleteRevisions` into the required pre-delete steps.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete clears the silo | Page `alpha` owned by `alice`, silo holds md, `raw/sources/alpha.md`, `raw/alpha.md`, `raw/sources/alpha/<hex>.md`, `discuss/alpha.json`, `raw/assets/alpha/<file>` | After `deleteWikiPage("alpha")` none of those silo objects remain | Cleanup failures logged and swallowed |
| Silo cleanup fails | A `deleteFile`/`deleteDirectory` under `tenants/<t>/` rejects with a non-ENOENT error | The page delete still succeeds and a `wiki` warn names the failed cleanup | Logged, never rethrown |
| Owner unknown on delete | Frontmatter read failed, so `deletedOwner` is `undefined` | The DEFAULT tenant's silo is cleaned — the same tenant the md delete targeted | As above |
| Shared hashed dir on delete | Silo holds `tenants/<t>/raw/sources/papers/{<hex>.md, note.md}`, page `papers` deleted | Only `<hex>.md` goes; `note.md` and the directory survive (`removeHashedTree` unchanged, DW-611) | ENOENT swallowed |
| Merge-absorb preserves Sources | `mergePages` absorbs `alpha` into `beta`; alpha's silo holds raw Sources and alpha's `sources` were unioned into beta's frontmatter | Alpha's silo raw Sources survive; alpha's discuss thread and assets are still cleaned | Cleanup failures logged and swallowed |
| Merge-absorb flag | `removeSiloForPage(slug, tenant, { preserveRawSources: true })` | All four raw-Source addresses stay; md, discuss, revisions and assets arms still run | ENOENT swallowed |

</intent-contract>

## Code Map

- `src/lib/lifecycle.ts:675-689` -- the delete branch's `cleanups` array (`embedding remove`, `deleteDiscussions`) run through `Promise.allSettled` with a per-entry `logger.warn`. THE insertion point for `removeSiloForPage`.
- `src/lib/lifecycle.ts:615-639` -- the required pre-delete `deleteRevisions` pair and the throwing silo/flat md deletes. `deleteTenant = tenantForOwner(deletedOwner)` is derived at `:623` INSIDE that block, so the cleanup batch must re-derive it from the outer `let deletedOwner` (`:426`). `tenantForOwner` is already imported (`:18`).
- `src/lib/lifecycle.ts:903-906` -- the "3c. (Retired)" comment asserting the `syncSiloForPage`/`removeSiloForPage` mirror is no longer needed here. Must be rewritten: true for the WRITE path and for the wiki md, false for every other delete-side artifact once this lands.
- `src/lib/lifecycle.ts:1206-1256` -- `deleteWikiPage` and `deleteWikiPageWhileLocked`; the latter already ends in a defaulted `skipDeleteBacklinks = false` positional, the pattern the new flag follows, and builds the `{ kind: "delete", … }` op at `:1247-1249`.
- `src/lib/lifecycle.ts:170-186` -- the `delete` variant of `PageLifecycleOp`; the flag is added here so it travels with the op.
- `src/lib/lifecycle.ts:42-46` -- the static import block. Add `import { removeSiloForPage } from "./silo";`. `silo.ts` top-level imports only storage/errors/wiki/raw/logger, so this adds no cycle beyond the tolerated `lifecycle → wiki → lifecycle` one.
- `src/lib/silo.ts:299-323` -- `removeSiloForPage`. MAY gain an options argument (`{ preserveRawSources?: boolean }`) that skips the four raw-Source arms; default behaviour unchanged. Already idempotent, ENOENT-safe at every arm, and selective over shared hashed directories (`removeHashedTree`, `:158-179`). Its silo-md `deleteSafe` is a harmless no-op once step 2 removed that file.
- `src/lib/silo.ts:413-448` -- the reverse-orphan pass, `removeSiloForPage`'s only current production caller and the evidence for DW-609's "cannot recover" claim: it enumerates `tenants/<t>/wiki/*.md` (`:432`), which a hard delete has already removed. READ-ONLY.
- `src/lib/merge.ts:663,724` -- `mergePages` hard-deletes the absorbed page via `deleteWikiPageWhileLocked` (resume path and normal path) AFTER unioning its sources into the survivor's frontmatter (`:567-573`). BOTH call sites must set the preserve flag.
- `src/lib/raw.ts:765-773` -- `deleteRawSourceBytes`' doc comment, which claims `removeSiloForPage` "clears the entire per-page hashed silo directory in one `deleteDirectory` (DW-435)". Stale since DW-611 made that removal selective, and about to describe a path that now really runs on delete.
- `src/lib/talk.ts:80-82,186-192` -- READ-ONLY evidence that `deleteDiscussions` targets the FLAT `discuss/<slug>.json` only, so the silo `tenants/<t>/discuss/<slug>.json` is genuinely leaked today and the two cleanups do not contend for one key.
- `src/lib/__tests__/silo.test.ts:1-30,477+` -- temp-dir harness (`DATA_DIR`/`RAW_DIR` under tmp) and the existing `removeSiloForPage` tests; the model for the new delete-time assertions.
- `src/lib/__tests__/lifecycle.test.ts` -- the `deleteWikiPage` suite and its `DATA_DIR`-isolated harness, so silo paths land under tmp. New DW-609 delete tests belong here.
- `src/lib/__tests__/merge.test.ts` -- the `mergePages` suite, including the "resumes delete lifecycle side effects when Page bytes were already removed" test that is the only coverage reaching the resume call site.

The DW-707 listing sites — `listRawSourceFilePaths` (`workbench-files.ts:726`), `sourcesTreeFromFiles` (`workbench-tree.ts`), `isV1FileInScope` / the rescan validator, and their tests — are deliberately OUT of scope and must stay byte-identical.

## Tasks & Acceptance

**Execution:**
- `src/lib/lifecycle.ts` -- statically import `removeSiloForPage`; add `preserveRawSources?: boolean` to the `delete` op variant and a defaulted trailing `preserveRawSources = false` parameter on `deleteWikiPageWhileLocked` that feeds it; add a `removeSiloForPage(slug, tenantForOwner(deletedOwner), { preserveRawSources })` entry to the fail-soft `cleanups` batch; rewrite the "3c. (Retired)" comment to say the WRITE mirror is retired while the delete-side silo cleanup now lives at 2b–2d -- a hard delete must not leave the page's Sources, thread and assets in the silo (DW-609).
- `src/lib/silo.ts` -- give `removeSiloForPage` an optional `{ preserveRawSources?: boolean }`; when true, skip the flat `raw/sources/<slug>.md`, legacy flat `raw/<slug>.md` and both `removeHashedTree` arms while the md, discuss, revisions and asset arms still run -- a merge-absorb hands those Sources to the survivor rather than dropping them.
- `src/lib/merge.ts` -- set the preserve flag at BOTH `deleteWikiPageWhileLocked` call sites (resume `:663`, normal `:724`), each with a comment naming why -- the survivor's frontmatter already claims the absorbed page's sources.
- `src/lib/raw.ts` -- correct `deleteRawSourceBytes`' doc comment to describe the selective per-page removal that now runs on every hard delete, and the `preserveRawSources` escape -- the comment currently describes a `deleteDirectory` that no longer exists.
- `src/lib/__tests__/lifecycle.test.ts` -- add delete-time silo tests covering the first three I/O rows: a full-artifact page delete clears md, both flat raw addresses, the hashed tree, discuss and assets from the silo; a rejecting silo cleanup still completes the delete and warns; an owner-unknown delete cleans the default tenant.
- `src/lib/__tests__/silo.test.ts` -- add tests for the "Shared hashed dir on delete" and "Merge-absorb flag" rows: a real `deleteWikiPage` spares a foreign file and its shared hashed directory; a `preserveRawSources` call keeps all four raw-Source addresses while clearing the rest.
- `src/lib/__tests__/merge.test.ts` -- add a merge-absorb test for the "Merge-absorb preserves Sources" row, and extend the existing resume test to seed silo artifacts so the resume call site's flag is pinned (mutating either call site to `false` must fail a test).

**Acceptance Criteria:**
- Given a page whose silo holds every mirrored artifact, when it is hard-deleted as a discard, then no object under `tenants/<t>/` for that slug remains in the object store — asserted at the storage surface, not via `reconcileSilos().removed`, which is vacuous here because the reverse-orphan pass discovers ghosts by scanning the silo wiki md step 2 already deleted.
- Given a merge of page `alpha` into `beta` where alpha's silo holds raw Sources, when the merge completes, then alpha's silo raw Sources are still present while alpha's silo discuss thread and assets are gone.
- Given `npx tsc --noEmit` and `pnpm lint`, when run after the change, then both exit clean.

## Spec Change Log

### 2026-09-03 — Escalation resolve #2 (carried forward): merge-absorb preserves silo Sources
Recorded decision (`.bmad-loop/runs/20260902-121800-87bf/resolve/dw-silo-mirror-lifecycle/resolution.json`): **a merge is not a discard.** `mergePages` hard-deletes the absorbed page through the SAME delete branch this spec extends, but first unions the absorbed page's sources into the survivor's frontmatter — so the raw-Source cleanup DW-609 adds would destroy provenance the survivor now claims. The delete branch takes a `preserveRawSources` flag: discard deletes leave it off and clean the whole silo; merge-absorb deletes (both `deleteWikiPageWhileLocked` call sites in `merge.ts`, normal and resume) set it on so the absorbed page's silo raw Sources survive **while discussions and assets still get cleaned**. `removeSiloForPage` may gain the matching optional option.

### 2026-09-03 — Escalation resolve #1 (carried forward): narrow to DW-609, split DW-707 out
Recorded decision on the first intent-gap escalation: **DW-707 stays open in the ledger.** The surface on which legacy-address Sources must become visible (library reach vs. v1 rescan reach vs. Workbench Sources-pane reach) is a separate product decision for its own bundle. This spec therefore covers **DW-609 only**; the DW-707 widening is removed from the intent, boundaries, I/O matrix, code map and tasks, and is a Never clause above.

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The new fail-soft-cleanup test's `vi.spyOn(logger, "warn")` was never restored. `lifecycle.test.ts`'s `afterEach` has no `vi.restoreAllMocks()`, `vitest.config.ts` sets no `restoreMocks`, and `logger` is a module singleton — so the no-op stub survived for every remaining test in the file and silently suppressed their warnings. Wrapped the assertions in `try`/`finally` with `warn.mockRestore()`, so the stub comes off even when an assertion throws; deliberately did NOT add a blanket restore to the shared `afterEach`, which would change behaviour for pre-existing tests.
  - `[low]` `[patch]` The DW-609 delete test ended in `expect((await reconcileSilos()).removed).toBe(0)` under a comment presenting it as coverage of the leak. It asserts nothing: the reverse-orphan pass discovers ghosts by scanning `tenants/<t>/wiki/*.md`, which step 2 of the delete already removed, so `removed` is 0 with or without the fix — and this spec's own acceptance criterion says to assert at the storage surface and not this way. Dropped the assertion, its comment and the now-unused import; the `fileExists` loop that is the real coverage stays. Mutation-rechecked: removing the `removeSiloForPage` cleanup entry still fails 4 tests, so no coverage was lost.
  - `[low]` `[patch]` `deleteWikiPage`'s doc block still claimed "Raw source files in `raw/` are intentionally NOT touched (the raw layer is immutable per the founding vision)", which this change makes false as a reader will take it. Reworded to distinguish the two trees: the FLAT `raw/` layer stays immutable and untouched (its bytes are `deleteRawSourceBytes`' job), while the tenant silo raw mirror is cleared on a hard delete, except on a merge-absorb.
  - `[low]` `[patch]` The "2b–2d. Secondary storage cleanup" comment asserted "Revision erasure is intentionally absent here", directly above the new entry whose `removeSiloForPage` calls `deleteDirSafe` on `tenants/<t>/wiki/.revisions/<slug>` — the same path `deleteRevisions(slug, tenant)` targets. Reworded: the required erasure is still the pre-delete step above, and the silo cleanup's revisions arm is a deliberate ENOENT-safe overlap on an already-cleared path, not a second erasure policy.
  - `[low]` `[patch]` `RemoveSiloForPageOptions`' doc and the "Merge-absorb flag" matrix row both claim the revisions arm still runs under `preserveRawSources`, but the test's `cleared` array covered only the wiki md, the discuss json and an asset — a regression that skipped `.revisions` alongside the raw-Source arms would have passed. Seeded a revision file and added it to `cleared`. Mutation-checked: removing the revisions `deleteDirSafe` fails exactly that test.

## Design Notes

Delete-side placement. `removeSiloForPage` is fail-soft cleanup, not a required pre-delete step: the required ones (`deleteRevisions` at both layouts, the silo md itself) exist so that a cleanup failure leaves a VISIBLE page the operator can retry. Raw Sources, the discuss thread and assets are derived, recoverable, and already represented in the same `allSettled` batch by `deleteDiscussions`, so they belong there too. Overlap with the steps around it is deliberate and free: `removeSiloForPage`'s md `deleteSafe` and `.revisions` `deleteDirSafe` hit paths step 2 already cleared and swallow ENOENT.

Accepted residuals:
- **Forward-only.** The reverse-orphan pass discovers ghosts by scanning the very `tenants/<t>/wiki/*.md` a hard delete removes, so silos leaked by deletes that ALREADY happened are not repaired by this change. A backlog-repair path is a separate decision.
- A merge-absorb deliberately leaves the absorbed page's raw Sources in the silo at the ABSORBED slug's address, with no wiki md anchoring them. That is the recorded decision (preserve in place, do not re-key); the reverse-orphan pass cannot see them, so nothing reaps them.

Provenance of this implementation: this bundle was driven twice before under run `20260902-121800-87bf` and escalated twice; the second re-drive completed, was reviewed, and was preserved by the orchestrator at git ref `attempt-preserve/20260902-121800-87bf-d698f921` (parent `0db5a127`, identical to this spec's baseline) when the run restarted an in-flight phase. That work implements exactly the two recorded resolutions above, so this run restores it rather than re-deriving a divergent second answer, and re-verifies it independently against the current baseline.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/silo.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/raw.test.ts` -- expected: all tests pass, old and new.
- `npx tsc --noEmit` -- expected: exit 0.
- `pnpm lint` -- expected: clean (the pre-existing `jsx-ast-utils` notices are warnings, not errors).
- `pnpm test` -- expected: no failures beyond any confirmed pre-existing ones; confirm against the baseline if any appear.
- Mutation checks -- removing the `removeSiloForPage` cleanup entry must fail the new delete tests; flipping either `merge.ts` preserve argument to `false` must fail a merge test.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

DW-609 only. A hard page delete now clears the page's **whole** tenant silo, not just its wiki md.
`removeSiloForPage` runs in the delete branch's existing fail-soft `cleanups` batch (2b–2d,
`Promise.allSettled` + per-entry `logger.warn`), beside `deleteDiscussions` — so the flat and hashed
raw Sources, the discuss thread and the binary assets that previously leaked on every delete are
cleaned, and a cleanup failure still cannot fail an already-committed delete. It is called with
`tenantForOwner(deletedOwner)`, the same tenant the throwing step-2 md delete and `deleteRevisions`
use, so an unknown owner cleans the default tenant exactly as before.

A **merge is not a discard**: `mergePages` hard-deletes the absorbed page through this same branch
but first unions its sources into the survivor's frontmatter. A `preserveRawSources` flag is
therefore threaded from the delete entry point through the lifecycle op to the cleanup; both
`merge.ts` call sites (normal and resume) set it, so the absorbed page's silo raw Sources survive
while its discussions and assets are still cleaned.

**DW-707 was not touched**, per the recorded escalation decision — it stays open in the ledger for
its own surface decision. `workbench-files.ts`, `workbench-tree.ts`, `v1-contract.ts`, the rescan
validator and all Workbench shaping are byte-identical.

### Files changed

- `src/lib/lifecycle.ts` — static `removeSiloForPage` import; `preserveRawSources?: boolean` on the `delete` variant of `PageLifecycleOp`; the new fail-soft `removeSiloForPage` cleanup entry; `deleteWikiPageWhileLocked` gained a defaulted trailing `preserveRawSources` parameter; the "3c. (Retired)" comment rewritten to say the WRITE mirror is retired while the delete-side cleanup lives at 2b–2d; `deleteWikiPage`'s doc block and the 2b–2d batch comment corrected so neither contradicts the new behaviour.
- `src/lib/silo.ts` — `removeSiloForPage` takes an optional `RemoveSiloForPageOptions { preserveRawSources }`; when set, the four raw-Source arms are skipped and the wiki md, discuss, revisions and asset arms still run. Default behaviour byte-identical.
- `src/lib/merge.ts` — both `deleteWikiPageWhileLocked` call sites (resume and normal) pass the preserve flag, each with a comment naming why.
- `src/lib/raw.ts` — doc comment only: `deleteRawSourceBytes` no longer claims `removeSiloForPage` does "one `deleteDirectory`"; it describes the selective per-page removal, that it now runs on every hard delete, and the `preserveRawSources` escape.
- `src/lib/__tests__/lifecycle.test.ts` — +3 delete-time silo tests (full-artifact silo clear asserted at the object store; a rejecting silo cleanup that still completes the delete and warns; an ownerless delete cleaning the default tenant), with the `logger.warn` spy restored in a `finally`.
- `src/lib/__tests__/silo.test.ts` — +2 tests in a new `removeSiloForPage on page delete` block (a real `deleteWikiPage` spares a foreign file and its shared hashed directory; `preserveRawSources` keeps all four raw-Source addresses while md, discuss, revisions and assets still clear).
- `src/lib/__tests__/merge.test.ts` — +1 merge-absorb preservation test, and the existing resume test extended to seed silo artifacts so the resume call site's flag is pinned.

### Review findings breakdown

- **Patches applied: 5** (medium 1, low 4) — see the Review Triage Log entry above.
- **Items deferred: 1** (low) — the merge-absorb residual at the listing surface; recorded in frontmatter `deferred`.
- **Items rejected: 10** — all either settled by the recorded escalation decisions (DW-707 left unimplemented; merge-absorb preserving Sources while cleaning discussions and assets), verified pre-existing and unchanged by this diff (a cross-tenant merge-absorb leaves the absorbed owner's silo exactly as every delete did before this change; a page whose owner changed after mirroring; the absence of a cleanup-debt retry; concurrent `reconcileSilos` re-mirroring), cosmetic (the two adjacent boolean positionals on `deleteWikiPageWhileLocked`, both `true` at both call sites with explaining comments; hardcoded tenant literals in test fixtures), or false on inspection (the "owner unknown" matrix row is covered at the state it names — `deletedOwner === undefined` — and the read-failure path is only one way to reach it). One reviewer reported the two merge tests failing on its first two invocations and passing on six subsequent runs: that is an artifact of the review layers running in parallel against one working tree — a sibling reviewer was mutation-testing `merge.ts`/`lifecycle.ts` at the time, and both reported failure modes map exactly onto its two mutations. Re-verified afterwards on an unmutated tree.
- **Follow-up review recommendation: `false`** — patched findings this pass were high 0, medium 1, low 4. Only a `high`-severity patched finding recommends another pass; score = 0 high.

### Verification performed

- `npx tsc --noEmit` — exit 0 (before and after the patches).
- `pnpm lint` — exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing library warnings, not errors).
- `pnpm vitest run src/lib/__tests__/{silo,lifecycle,merge,raw}.test.ts` — 4 files, 213/213 pass.
- `pnpm test` — 372 files, **9259 passed, 1 skipped, 0 failures**, re-run after the patches. No pre-existing failures appeared.
- **Matrix test audit** — all six I/O rows covered by named tests that ran and passed: "Delete clears the silo", "Silo cleanup fails" and "Owner unknown on delete" by the three new `lifecycle.test.ts` tests; "Shared hashed dir on delete" and "Merge-absorb flag" by the two new `silo.test.ts` tests; "Merge-absorb preserves Sources" by the new `merge.test.ts` test.
- **Mutation checks, all run in this session and all biting:** removing the `removeSiloForPage` cleanup entry fails 4 tests across `lifecycle.test.ts` and `silo.test.ts`; flipping `merge.ts`'s resume flag to `false` fails the extended resume test; flipping the normal flag to `false` fails the preservation test and the resume test; removing the revisions `deleteDirSafe` from `removeSiloForPage` fails the extended `preserveRawSources` test. Every mutation was reverted and the tree re-verified byte-identical afterwards.

### Residual risks

- **Forward-only** (accepted in Design Notes): silos leaked by deletes that already happened are not repaired, because the reverse-orphan pass still discovers ghosts by scanning the wiki md a hard delete removes. A backlog-repair path is a separate decision.
- A merge-absorb deliberately leaves the absorbed page's raw Sources in the silo at the absorbed slug's address with no wiki md anchoring them. That is the recorded decision; the consequences at the listing surface and under slug reuse are the deferred item above.
- `deleteWikiPageWhileLocked` now ends in two adjacent boolean positionals (`skipDeleteBacklinks`, `preserveRawSources`). Both production call sites are in `merge.ts` and both pass `true` with an explaining comment, so a transposition is currently unobservable — but the signature is long positionally.
- DW-707 remains open and untouched.
