---
title: 'DW-20 / DW-143 — compensating cleanup for Wiki create and re-template'
type: 'bugfix'
created: '2026-08-17'
status: 'done'
baseline_revision: 'b63baaaa5ed977f2f8cf221739780f236be3b14e'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `FilesystemStorageProvider.writeFile` is a bare `fs.writeFile`, not the
      write-to-tmp + rename that `StorageProvider`'s documented contract claims.
    evidence: |-
      `src/lib/storage/types.ts` states "`writeFile` must be atomic from the
      caller's perspective — partial writes should never be visible. The
      filesystem provider uses write-to-tmp + rename". `filesystem.ts` does
      `await fs.writeFile(abs, content, "utf-8")` with no tmp file. A torn write
      (ENOSPC, process death mid-write) therefore CAN leave a truncated file —
      including `wikis.json`, which `normalizeRegistry` then degrades to an
      empty registry. The compensation added for DW-20/DW-143 reasons from the
      interface contract and cannot detect a torn write; the comment at
      `applyScenarioTemplate`'s catch now says so explicitly. Pre-existing:
      both the implementation and the contradicting doc predate this change.
    location: >-
      src/lib/storage/filesystem.ts:78
    severity: medium
  - summary: >-
      A half-created FIRST Wiki's directory is unreclaimable, because the orphan
      sweep bails on an empty registry and has no scheduled caller.
    evidence: |-
      `sweepOrphans` returns 0 whenever `registry.wikis.length === 0` (a
      deliberate guard against sweeping a lost registry), and
      `sweepOrphanWikiDirectories` is referenced only from `deleteWiki` and
      tests. So when `discardCreatedWikiDirectory` itself fails on a tenant's
      first-ever create, the bytes sit on disk until that tenant has at least
      one Wiki AND a delete runs. Pinned as a fact by the new
      `re-throws the seed error…` test. Pre-existing sweep design; the new code
      only made the gap visible.
    location: >-
      src/lib/wikis.ts
    severity: low
  - summary: >-
      Crash durability is still open — compensating cleanup only covers a
      rejected write, not process death between two writes.
    evidence: |-
      DW-20's own text proposes "a write-ahead or compensating-write facility in
      the storage layer"; the bundle intent chose compensating cleanup, which
      runs in the same process as the failure. A SIGKILL or power loss between
      any two of the four writes still produces exactly the states DW-20 and
      DW-143 describe, and nothing recovers on next start. Closing this needs an
      on-disk pending-restore marker plus a reconcile, i.e. the storage-layer
      route the intent did not take.
    location: >-
      src/lib/wikis.ts
    severity: low
  - summary: >-
      `research-projects.ts` still carries the same untransacted registry
      property DW-20 names, and was not given a compensation.
    evidence: |-
      DW-20's reason cites `research-projects.ts` as "the registry idiom the
      spec directs this module to mirror — has the same property".
      `createResearchProject` is still an unguarded push-then-`writeProjects`.
      The bundle intent scoped the work to `src/lib/wikis.ts`'s two functions,
      so this was left alone deliberately; recording it so the divergence
      between the two registries is tracked rather than forgotten.
    location: >-
      src/lib/research-projects.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** `createWiki` and `applyScenarioTemplate` run `seedWikiArtifacts` (purpose.md → schema.md → `putWorkspaceProfile`) and then `writeRegistry` with no rollback, so a storage fault at any of those four steps leaves durable wreckage: a create leaves an orphaned `tenants/<t>/wikis/<id>/` directory that no registry entry names, and a re-template leaves purpose.md/schema.md on the new template beside a profile still on the old one (DW-20, DW-143).

**Approach:** Keep the four writes untransacted — the storage provider has no transaction — but add a compensating cleanup around each caller. A failed create discards the whole fresh `wikis/<id>/` directory it was building; a failed re-template restores the pre-seed bytes of all three files it overwrites. Both compensations are fail-soft: they warn and re-throw the ORIGINAL storage error, never their own.

## Boundaries & Constraints

**Always:**
- Compensation runs inside the already-held `wikis:<tenant>` lock, through the unlocked putters/`getStorage()` directly. `withFileLock` is not reentrant — taking `wikiLockKey(owner)` again deadlocks the tenant.
- The caller sees the original failure. A cleanup that itself throws is caught, `logger.warn`-ed under the `"wikis"` scope, and swallowed so the original error propagates unchanged.
- `createWiki`'s compensation is scoped to the id it just minted with `crypto.randomUUID()`, so it can only ever remove a directory this call created.
- `applyScenarioTemplate`'s compensation restores each of the three files to its exact pre-seed bytes, and restores "did not exist" as deletion, not as an empty file.
- `tenants/<t>/wikis.json`, `tenants/<t>/wiki/**`, `tenants/<t>/raw/**` and every OTHER Wiki's directory stay untouched by compensation.
- `tenants/<t>/wikis/<id>/workspace-profile.json` keeps exactly one path expression in the repo; `wiki-paths.ts` is the leaf module that owns Wiki path expressions and must not gain a storage import.

**Block If:**
- Closing this would require changing the `StorageProvider` interface (a write-ahead log, a transaction, or a new primitive). It must not: `writeFile` is already atomic per caller, `deleteDirectory` is already a no-op when absent, and `deleteFile`'s ENOENT is already classifiable via `isEnoent`.

**Never:**
- No two-phase commit, journal, or write-ahead facility in the storage layer — DW-20's "closing it means a write-ahead facility" is explicitly NOT the chosen route.
- Do not change `deleteWiki`, `renameWiki`, `setCurrentWiki`, `sweepOrphans`, or the `research-projects.ts` registry idiom.
- Do not make a create or re-template that genuinely failed report success; compensation removes wreckage, it does not convert a failure into a result.
- Do not re-seed or re-parse the profile through `getWorkspaceProfile`/`putWorkspaceProfile` to restore it — that would re-stamp `updatedAt` and lose the byte-identical guarantee.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create succeeds | Empty tenant, valid name + scenario | Three files under `wikis/<id>/`, registry entry, `currentId` = new id | No error expected |
| Create faults on purpose.md | `writeFile` rejects for `*/purpose.md` | Rejects with that error; no `wikis/<id>/` directory; no registry entry | Original error propagates |
| Create faults on schema.md | `writeFile` rejects for `*/schema.md` | Rejects; `wikis/<id>/` removed including the purpose.md already written | Original error propagates |
| Create faults on the profile write | `writeFile` rejects for `*/workspace-profile.json` | Rejects; `wikis/<id>/` removed including both artifacts | Original error propagates |
| Create faults on the registry write | `writeFile` rejects for `*/wikis.json` | Rejects; `wikis/<id>/` removed; a pre-existing Wiki's directory and the old registry bytes are untouched | Original error propagates |
| Create cleanup itself fails | Seed faults AND `deleteDirectory` rejects | Rejects with the SEED error, not the cleanup error; warn logged | Cleanup error swallowed |
| Re-template succeeds | Existing `business` Wiki, apply `reading` | All three files on `reading`; registry `scenario` = `reading` | No error expected |
| Re-template faults on schema.md or the profile | `writeFile` rejects mid-seed | Rejects; purpose.md, schema.md and workspace-profile.json all byte-identical to pre-call; registry still `business` | Original error propagates |
| Re-template faults on the registry write | Seed lands, `writeFile` rejects for `*/wikis.json` | Rejects; all three files restored to the `business` bytes; registry still `business` | Original error propagates |
| Re-template of a Wiki with no profile file | `workspace-profile.json` absent, seed faults after it is written | The profile file is DELETED again, not left as the new template's | ENOENT on the delete is tolerated |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:334-353` `seedWikiArtifacts` -- the three unguarded sequential writes (purpose.md, schema.md, `putWorkspaceProfile`). Leave its body alone; wrap its CALLERS.
- `src/lib/wikis.ts:445-471` `createWiki` -- `seedWikiArtifacts` then push/point/`writeRegistry`, all inside `withFileLock(wikiLockKey(owner))`. The `MAX_WIKIS` `ClientInputError` throws BEFORE any write, so it must stay outside the new try.
- `src/lib/wikis.ts:481-499` `applyScenarioTemplate` -- mutates the in-memory record, seeds, then `writeRegistry`. The in-memory mutation needs no undo (the registry is re-read every call); the FILES do.
- `src/lib/wikis.ts:311-318` `putWikiArtifact` -- the unlocked artifact putter, and `:271-276` `writeRegistry`. Both go straight to `getStorage().writeFile`.
- `src/lib/wikis.ts:625-648` `sweepOrphans` / `:690-726` `deleteWiki` -- the existing fail-soft cleanup idiom to mirror: try/catch, `logger.warn("wikis", …)`, never fail the caller over cleanup.
- `src/lib/wikis.ts:729-740` `readWikiArtifact` -- the `isEnoent` → `null` read shape to reuse for snapshotting.
- `src/lib/workspace-profile.ts:45-47` private `profilePath`, `:175-194` `putWorkspaceProfile` -- the profile's address and its unlocked putter. Snapshot/restore needs that path; promote it to `wiki-paths.ts` and have `profilePath` delegate (or be replaced), so the address keeps ONE expression.
- `src/lib/wiki-paths.ts` -- leaf module owning `wikiDirPath`, `wikiArtifactPath`, `wikiLockKey`. Its header forbids storage imports; a pure `wikiProfilePath(owner, wikiId)` belongs here and closes no cycle.
- `src/lib/storage/types.ts` -- contract: `writeFile` is atomic from the caller's view (a throw means nothing landed), `deleteDirectory` is "no-op if the directory doesn't exist".
- `src/lib/storage/filesystem.ts:84` `deleteFile` = `fs.unlink` (throws ENOENT when absent), `:128` `deleteDirectory` = `fs.rm({recursive, force})` (safe when absent).
- `src/lib/errors.ts:29` `isEnoent` -- classify the tolerated delete failure.
- `src/lib/__tests__/wikis.test.ts` -- temp-`DATA_DIR` recipe (`beforeEach` at :61), and the two fault-injection precedents to copy: `vi.spyOn(storage, "writeFile")` with a path-conditional mock at :620-647, and the `deleteDirectory` spy at :715-738. `profileBytes(wikiId)` at :53 and `exists()` at :520 already exist for byte-identity and directory assertions.
- Read-only evidence: `src/lib/__tests__/workspace-profile.test.ts` and `src/lib/__tests__/wiki-schema-edit.test.ts` also address the profile/artifact files; their expectations must keep passing.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-paths.ts` -- add `wikiProfilePath(owner, wikiId)` returning `` `${wikiDirPath(owner, wikiId)}/workspace-profile.json` ``, documented as the third sibling the Wiki lock covers -- so snapshot/restore and the profile store share one address expression instead of two.
- `src/lib/workspace-profile.ts` -- source the profile address from `wikiProfilePath` instead of the local `profilePath` literal -- keeps the promotion above from becoming a second copy.
- `src/lib/wikis.ts` -- add the compensation helpers (a snapshot of the three seeded paths' bytes-or-null, a fail-soft restore, and a fail-soft discard of a freshly seeded directory), then wrap the seed+registry pair in `createWiki` (discard on failure) and `applyScenarioTemplate` (restore on failure), re-throwing the original error in both -- this is the whole of DW-20/DW-143.
- `src/lib/__tests__/wikis.test.ts` -- add a describe block covering every I/O-matrix fault row: a fault injected at each of the four writes for create and for re-template, the byte-identity assertions, and the cleanup-fails-too case -- the matrix is the test list.

**Acceptance Criteria:**
- Given a create that faults at any one of its four writes, when the caller awaits it, then the rejection carries the storage error and `tenants/<t>/wikis/` contains no directory for the attempted id — verifiable afterwards by `listWikis` returning only the Wikis that existed before.
- Given a re-template that faults at any one of its four writes, when the caller awaits it, then the Wiki's registry `scenario` and all three of its files are exactly what they were before the call, so `readActiveWikiSchema()` and `buildWorkspaceGuidance()` still describe one single template.
- Given compensation that itself throws, when the caller awaits the operation, then the error it receives is the original storage failure and the run logs a `"wikis"` warning about the failed cleanup.
- Given a create or re-template that succeeds, when the run completes, then its observable behaviour is byte-for-byte what it was before this change — every existing assertion in `wikis.test.ts`, `workspace-profile.test.ts` and `wiki-schema-edit.test.ts` still passes.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 4: (high 0, medium 1, low 3)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `restoreSeededFiles`'s documented per-entry independence was untested — a `break;` after the warn passed 48/48. Added a re-template test that faults the RESTORE write of `purpose.md` and asserts `schema.md` and the profile still get restored.
  - `[medium]` `[patch]` `snapshotSeededFiles`'s non-ENOENT rethrow was untested — degrading it to an unconditional `null` passed 59/59, and under that regression a transient read error makes the restore DELETE the owner's `schema.md`. Added a `readFile` fault test asserting the error surfaces and `writeFile` is never called.
  - `[low]` `[patch]` The new `not.toContain("wikiId}/workspace-profile.json")` guard in `wiki-schema-edit.test.ts` was INERT (the interpolation closes `)}`), so it could never match the literal it forbade. Replaced with a `wikiDirPath(...)}/workspace-profile.json` regex that does, and folded the duplicated source-reading loop into the existing one.
  - `[low]` `[patch]` Nothing pinned that `wikis.ts` — the module the address promotion exists for — reaches the profile through `wikiProfilePath`. Added that assertion for both modules.
  - `[low]` `[patch]` The re-template fault loop had no bystander Wiki and no `tenants/<t>/wiki`/`raw` assertions, so the spec's "no other Wiki's directory is touched" constraint was pinned on the create side only. Added both across all four fault rows.
  - `[low]` `[patch]` `discardCreatedWikiDirectory`'s warn promised "leaving it for the orphan sweep", which is false after a failed first create (the sweep bails on an empty registry and has no scheduled caller). Corrected the warn and made the real behaviour a pinned test fact.
  - `[low]` `[patch]` The catch comment cited `writeFile` atomicity as fact; it is the interface contract, which `FilesystemStorageProvider` does not yet honour. Reworded to name the provider gap and scope it out explicitly.

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 0
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` The `wikiProfilePath(owner, wikiId)` guard added last pass was itself INERT: it read `wikis.ts`/`workspace-profile.ts` raw, and `workspace-profile.ts`'s own docblock contains that exact string, so re-deriving the address through `wikiDirPath` kept 44/44 green (confirmed by mutation). Both lib sources now go through the file's existing `code()` comment-stripper, the call is matched as a shape (`/wikiProfilePath\(\s*\w+\s*,\s*\w+\s*\)/`, so a parameter rename is not a failure), and the negative guard counts `workspace-profile.json` literals — 0 in `wikis.ts`, 1 legacy singleton in `workspace-profile.ts` — instead of forbidding one spelling of the interpolation that a two-step derivation would slip past. `wiki-paths.ts` is stripped too: its new docblock likewise satisfied the `/workspace-profile.json\`` check on its own.
  - `[medium]` `[patch]` Three of the four re-template fault rows never exercised a restore. `failWritesTo` rejected EVERY write to the faulting path, so it also rejected the compensation's own restore of that file; the byte assertions then passed because nothing had been overwritten, and a compensation that failed on every entry passed them identically. The injector now fails only the FIRST write to each matching path, and every row asserts zero `"wikis"` warns — the signal that separates "restored" from "never touched". Reverting the injector fails three rows.
  - `[low]` `[patch]` `restoreSeededFiles`'s ENOENT-tolerated delete was untested: replacing `if (!isEnoent(error)) throw error` with a bare `throw` kept 52/52 green, and under that regression a compensation that fully succeeded warns that the Wiki may describe two templates — a false alarm on the one signal an operator reads. Added a row (profile absent, seed faults on `purpose.md`, restore lands) asserting the compensation is silent.
  - `[low]` `[patch]` The create fault rows had no `tenants/<t>/wiki` / `tenants/<t>/raw` controls, even though `discardCreatedWikiDirectory` is the only compensation issuing a recursive directory delete. Added via `seedTenantTrees`/`expectTenantTreesIntact`, shared with the re-template rows.
  - `[low]` `[patch]` Nothing pinned that the snapshot set equals the set the seed writes — `seededFilePaths` derives from `WIKI_ARTIFACT_FILES` while `seedWikiArtifacts` spells its writes out, so a fourth seeded file would be overwritten with nothing to put it back. Added a happy-path comparison of reads-before-the-first-write against writes, scoped to the Wiki's directory. The naive reads-vs-writes form does NOT bite (`putWorkspaceProfile` reads the profile itself just before writing it); the write boundary is what makes it fail when the profile is dropped from the snapshot.
  - `[low]` `[patch]` `seedWikiArtifacts`'s docblock said the caller's compensation covers "a fault at write two or three", excluding writes one and four, which it also covers; the sibling block comment counted four while the docblock said three. Corrected both, and fixed the ragged wrap left by an earlier edit.

## Design Notes

Two callers, two DIFFERENT compensations, and the difference is the whole design:

- **create** is building a directory that did not exist a moment ago (`crypto.randomUUID()`), so "undo" is `deleteDirectory(wikiDirPath(owner, id))` — one call, force-recursive, safe when the fault came before the first byte landed.
- **re-template** is OVERWRITING files an owner may have edited, so "undo" must be a byte snapshot taken before the seed and written back after a failure, with `content === null` meaning "delete it again".

Shape to follow, mirroring `deleteWiki`'s fail-soft tail:

```ts
const restore = await snapshotSeededFiles(owner, wiki.id);
try {
  await seedWikiArtifacts(owner, wiki);
  await writeRegistry(owner, registry);
} catch (error) {
  await restoreSeededFiles(restore); // warns internally, never throws
  throw error;                        // the ORIGINAL failure, always
}
```

`writeRegistry` throwing means the registry bytes never landed (`writeFile` is atomic per the provider contract), which is what makes "remove the directory" and "restore the old artifacts" the correct compensations rather than a guess.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workspace-profile.test.ts src/lib/__tests__/wiki-schema-edit.test.ts` -- expected: all pass, including the new fault-injection block.
- `pnpm lint` -- expected: no new errors.
- `npx tsc --noEmit` -- expected: no new type errors.

## Auto Run Result

Status: done

**Implemented change.** `createWiki` and `applyScenarioTemplate` keep their four untransacted writes, but each now runs them inside a compensation: a failed create discards the whole `wikis/<id>/` directory it minted, a failed re-template writes back a byte snapshot of the three files the seed overwrites (with "did not exist" restored as a delete). Both are fail-soft — they `logger.warn` under `"wikis"` and re-throw the ORIGINAL storage error — and both run through `getStorage()` inside the already-held `wikis:<tenant>` lock. `wikiProfilePath` was promoted into `wiki-paths.ts` so the profile keeps one address expression across the putter and the restore.

**Files changed.**
- `src/lib/wiki-paths.ts` -- new `wikiProfilePath(owner, wikiId)`, the third sibling the Wiki lock covers.
- `src/lib/workspace-profile.ts` -- the private `profilePath` literal replaced by that helper at both call sites.
- `src/lib/wikis.ts` -- `snapshotSeededFiles` / `restoreSeededFiles` / `discardCreatedWikiDirectory`, and the two catch blocks that use them.
- `src/lib/__tests__/wikis.test.ts` -- the fault-injection block: every I/O-matrix row for create and re-template, the cleanup-fails-too cases, and the snapshot/restore invariants.
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- the one-path-expression guard extended to the promoted helper.

**Review findings this pass.** 6 patches applied (2 medium, 4 low), 0 deferred, 12 rejected (all low). No intent_gap and no bad_spec: the intent-alignment audit found every Always/Never/Block-If clause satisfied. This pass was a follow-up review of an already-`done` spec, and its yield was concentrated in the tests rather than the implementation — two of the six patches were guards from the PREVIOUS pass that did not actually bite, each confirmed inert by mutation before being replaced. Rejected findings were dominated by durability designs the intent forecloses (registry snapshotting, a cleanup timeout, an on-disk repair marker, discarding only after re-reading the registry) — all premised on a `writeFile` that lands despite throwing, which the intent declares out of scope and DW-161 already tracks.

**Verification performed.**
- `npx vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workspace-profile.test.ts src/lib/__tests__/wiki-schema-edit.test.ts` -- 107 passed (3 files). (`pnpm vitest` errors with "packages field missing or empty" in this repo; `npx` is the working invocation.)
- `npx vitest run` (full suite) -- 4466 passed, 215 files.
- `npx eslint` -- clean; only the pre-existing `jsx-ast-utils` TSNonNullExpression notices.
- `npx tsc --noEmit` -- clean.
- Mutation checks, each confirming a new or repaired assertion fails when the behaviour it names is broken: re-deriving the profile path in `workspace-profile.ts`; reverting the injector to reject every matching write; dropping the `isEnoent` guard from the restore's delete; removing `wikiProfilePath` from `seededFilePaths`; adding a `break` to the restore loop. All five bite; the tree was restored after each.
- Note: `npx prettier --write` reformats these files wholesale (its 80-column default is not this repo's style), so the patches were applied by hand and no formatting churn is in the diff.

**Residual risks.** Unchanged from the previous pass and all recorded in `deferred`: the filesystem provider does not implement the atomic `writeFile` the compensation reasons from (DW-161); a half-created FIRST Wiki's directory has no reclaim path (DW-162); process death between two writes is still uncovered, since compensation runs in the failing process (DW-163); `research-projects.ts` keeps the same untransacted registry idiom (DW-164). One property added by this change and pinned rather than closed: `snapshotSeededFiles` now reads `purpose.md` and `schema.md` on the re-template path, so an unreadable-but-writable artifact blocks a re-template that would previously have overwritten it — the fail-closed choice, widening DW-144's existing property from one file to three.

Follow-up review recommendation: `true` — patched findings this pass were high 0, medium 2, low 4; score = 3×2 + 1×4 = 10, which is ≥ 5.

