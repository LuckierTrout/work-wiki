---
title: 'Wiki sweep age guard and create-failure compensation read-back (DW-674, DW-675)'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `POST /api/wikis` answers 500 while the wiki was in fact created and made
      current, whenever `writeRegistry` stores `wikis.json` and then rejects.
    evidence: |-
      DW-675's fix makes `createWiki` keep the new wiki's directory when the
      read-back positively finds the record, and bump `dataVersion` — but the
      original storage error is still re-thrown unwrapped, so the route answers
      500. The owner is told the create failed while the switcher, the workbench
      heading and every artifact read now resolve against the new wiki, and a
      retry mints a second one against `MAX_WIKIS`. This is the create-route
      sibling of the shape DW-676 already records for
      `POST /api/wikis/[id]/template` after DW-484; neither the bundle intent nor
      either ledger entry names the route surface, both stop at the bytes.
    location: >-
      src/app/api/wikis/route.ts (POST); src/lib/wikis.ts createWiki failure tail
    severity: low
baseline_revision: 'd3665ad0b1efa326598334efc7e00b4b5e0e1a57'
---

<intent-contract>

## Intent

**Problem:** Two fail-soft assumptions in `src/lib/wikis.ts` are unverified. (1) `newestWriteTime` accepts any `Number.isFinite` mtime and silently DROPS one it cannot use, so a file whose `stat` returns an unrepresentable date (`Invalid Date` → `getTime()` NaN) leaves `newest` set from an older sibling — or from the directory-stat fallback — and the sweep then age-qualifies and DELETES a directory whose newest write it never read, against the module's own rule that an age it cannot trust must never gate a delete (DW-290). (2) `createWiki`'s catch calls `discardCreatedWikiDirectory` on the belief that "no registry entry names it" without ever reading the registry back; a `writeRegistry` whose bytes landed and whose acknowledgement did not leaves the stored registry naming the new wiki AND `currentId` pointing at it while the compensation deletes that wiki's whole directory — a tenant whose CURRENT wiki has no `purpose.md`, no `schema.md` and no profile, which `normalizeRegistry` keeps and no sweep can reclaim.

**Approach:** Make both guards read rather than assume. `newestWriteTime` gets one explicit predicate for "a write time this isolate can use" — finite AND inside `Date`'s ±8.64e15 ms range — and an unusable per-file time now poisons the whole answer (`null` → skip) exactly as the depth bound already does, instead of being skipped. `createWiki` mirrors the DW-484 read-back that `applyScenarioTemplate` already uses: when the registry write was attempted, read `wikis.json` back before discarding; if it names the freshly minted id the write landed, so the destructive discard is skipped, the divergence is warned about, and the refresh signal is bumped outside the lock — while the original error is still re-thrown unwrapped.

## Boundaries & Constraints

**Always:**
- Uncertainty resolves towards NOT destroying bytes. A registry read that THROWS means "unknown", and unknown skips the discard — orphan bytes are reclaimable by the sweep, a deleted current wiki's artifacts are not.
- The read-back runs only when `writeRegistry` was actually attempted (a control-flow flag set immediately before the call), for the same reason DW-484 guards its own: a seed fault never issued a registry write, so asking would put "a registry write that landed" in the log for a write that never ran.
- The original error from the locked body is re-thrown unwrapped and unreplaced; compensation never replaces the diagnosis.
- `bumpRefreshSignal` stays OUTSIDE `withWikiLock` (it takes `DATA_VERSION_LOCK`; `withFileLock` is not reentrant), so the failure fact is carried out of the locked callback as a value — the `RetemplateOutcome` shape already in this file.
- Every new branch is covered by a row that FAILS against the current code and passes after the change.

**Block If:**
- The read-back cannot be scoped to the id `createWiki` minted this call (it must never consult or act on another wiki's record).

**Never:**
- Do not change `setCurrentWiki`, `renameWiki` or `deleteWiki`. DW-675 names them as carrying "the milder version": none of them runs a destructive compensation, so a landed-then-threw registry write there costs a misreported outcome and a missed bump, not bytes. Out of scope for this bundle.
- Do not reconcile: no repair write, no re-seed, no removal of the registry entry, and do not convert the failed create into a returned success.
- Do not touch the ledger at `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not change the future-dated warn sentence, `ORPHAN_SWEEP_*` constants, `rotatingSweepWindow`, or the tombstone protocol.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordinary aged orphan | every file mtime readable and older than the grace window | removed, count includes it | No error expected |
| Unrepresentable file mtime | aged orphan whose `stat` returns `lastModified: new Date(NaN)` for one file, an older readable sibling beside it | NOT removed; the "could not read the age … treating it as too young to sweep" warn fires; a readable sibling orphan in the same pass is still removed | Walk throws; outer catch warns and returns null |
| Unrepresentable directory-fallback mtime | file-less aged orphan whose directory `stat` is unrepresentable | NOT removed | `newestWriteTime` returns null → skipped |
| Future-dated but representable | orphan stamped four grace windows ahead | unchanged: warn-once future-dated line, skipped, ISO date in the sentence | No error expected |
| Create faults on a seed write | `writeFile` rejects `purpose.md` / `schema.md` / `workspace-profile.json` without calling through | unchanged: directory discarded, registry and `currentId` untouched, no bump, seed error re-thrown | Seed error re-thrown |
| Create faults on `wikis.json`, bytes did NOT land | `writeFile` rejects `wikis.json` without calling through | read-back finds no record → directory discarded as today, no bump, error re-thrown | Error re-thrown |
| Create faults on `wikis.json`, bytes DID land | `writeFile` writes `wikis.json` through, then throws | directory KEPT with all three seeded files; a `wikis` warn names the id and says the registry names it under a reported failure; `dataVersion` bumped once; original error re-thrown | Error re-thrown |
| Read-back itself throws | `writeRegistry` landed-or-not, `readRegistry` rejects | directory KEPT (unknown never authorises the discard); a warn says the read failed; original error re-thrown | Read error warned, never re-thrown |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1832-1865` -- `newestWriteTime`: the walk's `if (Number.isFinite(at) && …) newest = at` (:1846-1847) is the silent drop; `return Number.isFinite(at) ? at : null` (:1855) is the directory fallback. The `depth > 4` throw at :1839-1841 is the in-function precedent for "unknown poisons the answer".
- `src/lib/wikis.ts:1922-1946` -- `warnOnceAboutFutureDatedWrite`, whose `new Date(newest).toISOString()` is the consumer that requires the range invariant. Sentence is byte-pinned by rows; do not touch it.
- `src/lib/wikis.ts:2180-2216` -- `sweepOrphans`' per-candidate loop: `newest === null` already means "too young to sweep", so a `null` return needs no call-site change.
- `src/lib/wikis.ts:1213-1290` -- `registryNamesScenario`: the DW-484 read-back to mirror. Copy its structure (try/find/warn/return, fail-soft catch) but map "record absent" to NOT landed here — absent is the EXPECTED state for a freshly minted id, so it is positive evidence, unlike the re-template case where absent meant the registry stopped naming a wiki it had named.
- `src/lib/wikis.ts:1292-1310` -- `RetemplateOutcome`: the exact "carry the failure out of the lock as a value" shape to copy for a create outcome type.
- `src/lib/wikis.ts:1485-1505` -- `applyScenarioTemplate`'s `registryWriteAttempted` flag and guarded read-back; :1512-1524 its tail (bump on the failure path, then `throw outcome.error`).
- `src/lib/wikis.ts:1160-1207` -- `createWiki`: the locked body, its `catch` (:1197-1202) and the post-lock bump to restructure.
- `src/lib/wikis.ts:715-775` -- `discardCreatedWikiDirectory`: unchanged, but its "The registry never named this id" comment is now a claim the caller has VERIFIED; adjust that comment to say so.
- `src/lib/__tests__/wikis.test.ts:1004-1030` -- `ageDirectory` / `stampDirectory`; :1326-1330 `plantOrphan` (one `purpose.md`); :1471-1500 the `stat`-throws row whose spy shape the new mtime row copies.
- `src/lib/__tests__/wikis.test.ts:2625-2655` -- `failWritesTo` (rejects WITHOUT calling through, which is why every existing create row is unaffected); :3059-3068 the DW-484 write-through-then-throw spy to copy for the landed row.
- `src/lib/__tests__/wikis.test.ts:2706-2749` -- the four existing per-write create-compensation rows that must keep passing verbatim.
- `src/lib/storage/types.ts:106` / `filesystem.ts:532` / `r2.ts:172` -- read-only evidence: `lastModified` is a real `Date` on both providers, so a *finite* out-of-range value cannot arrive today and the `toISOString()` RangeError DW-674 names is not reachable through them. The predicate states the invariant the warn depends on; the REACHABLE half of DW-674 is the NaN drop above. Say this plainly in the comment rather than claiming a fix for an unreachable throw.

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- add a module-private `MAX_TIME_VALUE_MS = 8.64e15` and a predicate over it (finite AND within range); use it at both `newestWriteTime` sites, THROWING from the walk on an unusable per-file time (so the outer catch warns and returns null) and returning null from the directory fallback -- an age the isolate cannot trust must not gate a delete, and the predicate is the invariant `warnOnceAboutFutureDatedWrite`'s `toISOString()` depends on.
- `src/lib/wikis.ts` -- add `registryNamesWiki(owner, wikiId)` beside `registryNamesScenario`, fail-soft towards "landed"/skip-the-discard, plus a create outcome type modelled on `RetemplateOutcome` -- the read-back that replaces `createWiki`'s unverified belief.
- `src/lib/wikis.ts` -- restructure `createWiki` so its locked body returns the outcome instead of throwing: set `registryWriteAttempted` immediately before `writeRegistry`, and in the catch call `discardCreatedWikiDirectory` ONLY when the read-back says the registry does not name the id; the post-lock tail bumps once when it did, then re-throws the original error -- the bump must sit outside `wikis:<tenant>`.
- `src/lib/wikis.ts` -- update the `createWiki` catch comment and `discardCreatedWikiDirectory`'s "The registry never named this id" line so both state that the claim is now read, not assumed, and note the untouched milder residual in `setCurrentWiki`/`renameWiki`/`deleteWiki`.
- `src/lib/__tests__/wikis.test.ts` -- add sweep rows for the unrepresentable per-file mtime (with a readable sibling orphan removed in the same pass) and the unrepresentable directory-fallback mtime, using the existing `stat` spy shape.
- `src/lib/__tests__/wikis.test.ts` -- add create-compensation rows for the landed-then-threw registry write and for a read-back that throws, using the DW-484 write-through-then-throw spy; assert the directory and its three seeded files survive, the registry names the wiki, `currentId` points at it, the warn fires, `dataVersion` moved by exactly one, and the original error is what rejected.

**Acceptance Criteria:**
- Given an aged orphan directory whose newest write cannot be represented as a date, when a scheduled sweep runs, then that directory is still on disk, the pass reports 0 removals for it, and a readable aged orphan in the same pass is still removed.
- Given a `writeRegistry` that stores `wikis.json` and then rejects, when `createWiki` fails, then the new wiki's directory and all three seeded artifacts are still on disk, the stored registry names that wiki with `currentId` pointing at it, `dataVersion` has moved by exactly one, and the caller received the storage error unwrapped.
- Given a `createWiki` that faults on a seed write, when compensation runs, then behaviour is byte-for-byte what it is today: directory discarded, registry unchanged, no bump.
- Given the registry read-back itself throws, when `createWiki`'s compensation runs, then no directory is deleted and the original error is what rejected.

## Design Notes

Why "record absent" means NOT landed here but "unknown" in `registryNamesScenario`: there, the id was already in the registry when the call started, so its disappearance said the registry stopped naming a wiki it named moments ago. Here the id was minted by this call under `wikis:<tenant>`, so absence is the state the registry was in before `writeRegistry` ran — positive evidence the bytes did not land. Only a THROWN read is unknown, and unknown skips the destructive branch.

Shape to mirror (from `applyScenarioTemplate`):

```ts
let registryWriteAttempted = false;
try {
  await seedWikiArtifacts(held, owner, wiki, { seedProfile: true });
  registry.wikis.push(wiki); registry.currentId = wiki.id;
  registryWriteAttempted = true;
  await writeRegistry(owner, registry);
} catch (error) {
  const registryLanded =
    registryWriteAttempted && (await registryNamesWiki(owner, wiki.id));
  if (!registryLanded) await discardCreatedWikiDirectory(owner, wiki.id);
  return { kind: "failed", error, wikiId: wiki.id, registryLanded };
}
```

Note the `registry.wikis.push` must stay before the flag so the flag means "the write was issued", not "the array was mutated".

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts` -- expected: all rows pass, including the four pre-existing create-compensation rows and every DW-290/DW-383/DW-483 sweep row, unchanged.
- `pnpm lint` -- expected: no new errors or warnings.
- `pnpm exec tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Both unverified fail-soft assumptions in `src/lib/wikis.ts` now read rather than assume. `newestWriteTime` gained `MAX_TIME_VALUE_MS` / `isUsableWriteTime` (finite AND inside `Date`'s ±8.64e15 range): an unusable per-file mtime now THROWS out of the walk — so the whole candidate resolves to "age unknown" and is skipped, instead of being silently dropped and letting an older sibling's mtime age-qualify a delete — and the directory-stat fallback returns `null` with the same operator warn. `createWiki`'s compensation reads `wikis.json` back through a new three-way `registryNamesWiki` (`named | absent | unknown`) whenever a registry write was issued: only `absent` authorises `discardCreatedWikiDirectory`, only `named` earns a `bumpRefreshSignal` on the failure tail, and `unknown` keeps the bytes and moves nothing. The failure now leaves the locked body as a `CreateWikiOutcome` value so the bump can sit outside `wikis:<tenant>`; the original error is re-thrown unwrapped in every case.

**Files changed.**
- `src/lib/wikis.ts` — the timestamp predicate and both `newestWriteTime` sites; `registryNamesWiki`, `RegistryReadBack`, `CreateWikiOutcome`, and the restructured `createWiki` body and tail; corrected compensation doc comments.
- `src/lib/__tests__/wikis.test.ts` — 9 new rows (five sweep, four create-compensation), plus the landed-warn negative assertion added to the four pre-existing `failWritesTo` discard rows.
- `src/lib/__tests__/workbench-data-version.test.ts` — the structural bump-site guard follows the second `createWiki` bump (module-wide 8→9, `createWiki` 1→2).

**Review findings breakdown.** 10 patches applied (1 medium, 9 low); 1 item deferred (low — `POST /api/wikis` answers 500 for a create that landed); 6 rejected as noise (a `±8.64e15` boundary row for a trivially correct `<=`; a second guard at the `toISOString()` render site, whose only producer now refuses unusable values and whose non-abort is already pinned by the two-candidate NaN row; rejecting pre-epoch mtimes, which would change behaviour with no defect behind it; first-ever-create and `MAX_WIKIS` interactions that are correct consequences of the wiki genuinely existing; stale line anchors in this spec's own Code Map; and `workbench-data-version.test.ts` missing from the Verification list, since the full suite was run). No intent gaps and no spec defects.

**Follow-up review recommendation.** true. Patched this pass: high 0, medium 1, low 9 → 3 × 1 + 1 × 9 = 12, which is ≥ 5.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts` — 177 passed.
- `pnpm vitest run` (full suite) — 359 files, 8789 passed, 1 skipped, 0 failed. An earlier full run failed `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP`; it passes in isolation and on two subsequent full runs, touches neither `wikis.ts` nor anything this change reaches, and is a load-sensitive flake.
- `pnpm exec tsc --noEmit` — clean. `pnpm lint` — no errors or warnings.
- Every matrix row is covered by a row that ran and passed, and each new guard was mutation-checked: reverting it fails its row. The one exception is stated rather than hidden — the NaN directory-fallback row also passes against the old `Number.isFinite`, which is why the finite out-of-range bare-directory row exists.

**Residual risks.**
- The `unknown` arm (registry write issued, read-back threw) keeps an untombstoned directory. On a tenant that owns no wiki yet, `sweepOrphans` runs in `tombstonedOnly` mode and cannot reclaim it until a create succeeds — the documented DW-162 residual, reached by a second route. Accepted deliberately: writing `.discarded` there would arm a delete of a possibly-live CURRENT wiki's artifacts in exactly the lost-`wikis.json` state this change exists to survive. Pinned by a row.
- `setCurrentWiki`, `renameWiki` and `deleteWiki` still carry the milder landed-then-threw shape DW-675 names — a misreported outcome and a missed bump, never bytes, since none of them runs a destructive compensation. Out of scope by the spec's Never list; recorded in a code comment.
- The finite-out-of-range half of the predicate states an invariant rather than closing a live path: `StorageProvider.stat` types `lastModified` as a real `Date`, which cannot hold a finite out-of-range value, so the `RangeError` DW-674 names is unreachable through either shipped provider. Its rows use a stubbed `Date` and say so.
