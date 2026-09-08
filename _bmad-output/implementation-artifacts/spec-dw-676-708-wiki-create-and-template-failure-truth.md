---
title: 'Wiki lifecycle failure truth: a scenario-drift reconciler and a create that reports what landed (DW-676, DW-708)'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The partially-rolled-back re-template — the divergence flavour where
      `purpose.md` and `schema.md` name DIFFERENT Scenario Templates — is
      skipped by the new reconciler and reported by nothing.
    evidence: |-
      `applyScenarioTemplate`'s failure tail carries `rollbackIncomplete`
      (DW-210) alongside `registryLanded` (DW-484): a restore that could not put
      every file back leaves one artifact on the new template and one on the
      old. `scenarioNamedByWikiArtifacts` answers null the moment its two
      witnesses disagree, and `reconcileWikiScenarioDrift` is deliberately
      SILENT when it does not fire — so that state is now detected by nobody,
      repaired by nobody and logged by nobody, while the switcher still carries
      whichever label the registry write left. The unanimity rule is correct as
      written (there is no unambiguous answer to re-derive from two contradicting
      files, and both artifacts are owner-editable so a guess would overwrite the
      wrong one), which is exactly why closing this needs its own decision —
      probably a distinct signal rather than a repair.
    location: >-
      src/lib/wikis.ts (scenarioNamedByWikiArtifacts / reconcileWikiScenarioDrift)
    severity: low
baseline_revision: 'c0e35b2b98162e14050cf768ab1405c53a76585b'
---

<intent-contract>

## Intent

**Problem:** Two wiki-lifecycle doors report a failure over a state that in fact landed. (1) `POST /api/wikis` answers 500 whenever `writeRegistry` stores `wikis.json` and then rejects: DW-675's read-back proves the registry names the new Wiki and `currentId` points at it, all three artifacts are seeded, and `dataVersion` was bumped — yet `createWiki` re-throws the storage error, so the switcher, the workbench heading and every artifact read resolve against a Wiki the owner was told was not created, and a retry mints a second one against `MAX_WIKIS`. (2) After DW-484, `registryNamesScenario` DETECTS the registry/artifact divergence a failed re-template leaves behind and reconciles nothing: the registry names the new Scenario Template while the restored `purpose.md`/`schema.md` describe the old one, and the switcher silently re-labels itself on the next `DATA_VERSION_POLL_MS` poll.

**Approach:** Give the divergence an owner in the maintenance scan, on the `sweepOrphanWikiDirectories` precedent — a scan step that reads each Wiki's artifacts, derives the Scenario Template they name, and re-derives the REGISTRY from them when they unambiguously disagree, reporting what it repaired. And stop `createWiki` reporting a failure it has already disproved: when the read-back POSITIVELY found the record, the create resolves with that record, so `POST /api/wikis` answers its ordinary 201 and the storage fault is logged rather than served.

## Boundaries & Constraints

**Always:**
- The reconciler repairs the REGISTRY from the artifacts, never the artifacts from the registry. `purpose.md` and `schema.md` are both owner-editable (`EDITABLE_ARTIFACT_FILES`), so re-seeding them from a registry label would destroy owner bytes; rewriting one `scenario` field destroys nothing.
- A repair needs UNAMBIGUOUS evidence: at least one artifact witness, every witness present agreeing, and their answer differing from the stored `scenario`. A missing, unreadable or unrecognised witness, or two witnesses that disagree, is skipped silently — an owner-edited artifact is a normal state, not an anomaly to warn about on every scan tick.
- A witness is derived from the exact line the renderer emits (`Scenario Template: <Label> — ` in `purpose.md`, `# Schema — <Label>` in `schema.md`), matched against `SCENARIO_LABELS` for the five `CREATABLE_SCENARIOS` only. More than one label matching inside one file is ambiguous, and ambiguous is no witness.
- The reconciler gates read-only BEFORE taking `wikis:<tenant>` (its own `READ_ONLY_REFUSAL` key), bounds its per-pass work with the existing `rotatingSweepWindow`, writes `wikis.json` at most ONCE per pass, and bumps `dataVersion` exactly once and OUTSIDE the lock — the switcher's label is what moved, so another open tab has to be told.
- `createWiki` still re-throws the original error unwrapped on every arm that is NOT a positively-observed landed registry write (`absent` and `unknown` both keep throwing, `unknown` still bumps nothing and still writes no tombstone).
- `createWiki` keeps exactly TWO `bumpRefreshSignal` sites, both outside the lock; `workbench-data-version.test.ts` pins the count, the bodies and the placement.
- Every new branch is covered by a row that FAILS against the current code and passes after the change.

**Block If:** the artifact witnesses cannot be derived without importing storage into `wiki-scenarios.ts` (it is client-safe and the Create Wiki dialog imports it) — the derivation must stay pure.

**Never:**
- Do not change `POST /api/wikis/[id]/template`'s failure response. DW-676's recorded decision is explicit: the scan closes the window, and the 500 stays as it is.
- Do not change `applyScenarioTemplate`, `registryNamesScenario`, `restoreSeededFiles`, or either failure tail's bump arithmetic.
- Do not reconcile the workspace profile's own `scenario` field, and do not re-seed or rewrite any artifact byte from the reconciler. Profile-vs-artifact drift is a separately recorded design decision (`setCurrentWiki`'s docblock) and is out of scope.
- Do not touch `setCurrentWiki`, `renameWiki` or `deleteWiki`, the `ORPHAN_SWEEP_*` constants, `sweepOrphans`, or the tombstone protocol.
- Do not touch the ledger at `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create faults on `wikis.json`, bytes DID land | `writeFile` writes `wikis.json` through, then throws | `createWiki` RESOLVES with the new record; directory and all three artifacts kept; registry names it with `currentId` on it; `dataVersion` moved by exactly one; a `wikis` warn names the id and the swallowed fault | Storage error logged, not thrown |
| The same create through the door | `POST /api/wikis` over that provider | 201 with `{ wiki }`, not 500 — so a retry cannot mint a second Wiki against `MAX_WIKIS` | n/a |
| Create faults on `wikis.json`, bytes did NOT land | `writeFile` rejects `wikis.json` without calling through | unchanged: directory discarded, registry untouched, no bump, error re-thrown | Error re-thrown |
| Create faults on a seed write | `writeFile` rejects `purpose.md`/`schema.md`/the profile | unchanged: directory discarded, no read-back, no bump, seed error re-thrown | Seed error re-thrown |
| Read-back itself throws | `writeRegistry` landed-or-not, `readRegistry` rejects | unchanged: directory KEPT, nothing bumped, no tombstone, original error re-thrown | Read error warned, never re-thrown |
| Reconciler on a healthy tenant | every Wiki's artifacts name the scenario the registry names | 0 repairs, `wikis.json` not rewritten, no bump | No error expected |
| Reconciler after a failed re-template that landed | registry says Reading; restored `purpose.md` and `schema.md` both say Business | 1 repair: the record's `scenario` is Business, one registry write, one bump, one warn naming the id and both scenarios | No error expected |
| Reconciler on an owner-edited artifact | `purpose.md` names Business, `schema.md` names Reading, registry says Reading | 0 repairs, no write, no bump, no warn — witnesses disagree | No error expected |
| Reconciler with one witness only | `purpose.md` canonicalized (no template line), `schema.md` names Business, registry says Reading | 1 repair — one witness is enough while nothing contradicts it | No error expected |
| Reconciler with no witness | both artifacts missing or unreadable | 0 repairs; a missing artifact is not evidence | Read error swallowed per Wiki, pass continues |
| Reconciler on a read-only deployment | `YOPEDIA_READONLY` set | refuses with its own sentence before the lock; the scan wrapper answers 0 | `ReadOnlyError` thrown, wrapper logs and returns 0 |
| Scan wiring | `POST /api/tasks/scan` without `?dry=1` | the reconciler runs once and its count is in the JSON body and the log line; `?dry=1` suppresses it and reports 0 | Wrapper is fail-soft, returns 0 |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:1186-1292` -- `createWiki`: the locked body's `catch` (`readBack`/`discardCreatedWikiDirectory`), the `CreateWikiOutcome` return, and the post-lock tail whose `if (outcome.registryLanded)` bump is followed by `throw outcome.error`. The tail is what changes: on `registryLanded` it returns the record instead of throwing.
- `src/lib/wikis.ts:1509-1512` -- `CreateWikiOutcome`. The `failed` arm carries `wikiId`; it needs the WHOLE `WikiRecord` so the tail can resolve with it. Its docblock's "What it deliberately does not cover" paragraphs stay true and must be extended, not replaced.
- `src/lib/wikis.ts:1389-1508` -- `RegistryReadBack` / `registryNamesWiki`: unchanged three-way read-back. Its `named` warn sentence is the one that must now also say the create is being REPORTED AS SUCCEEDED.
- `src/lib/wikis.ts:1343-1374` -- `registryNamesScenario`: the "DETECTS, DOES NOT RECONCILE" helper DW-676 names. Read-only reference; the reconciler is its missing owner, not a replacement.
- `src/lib/wikis.ts:2025-2055` -- `rotatingSweepWindow(names, now)` and `ORPHAN_SWEEP_CANDIDATE_CAP` (25): the per-pass bound to reuse over registry ids. Pure over `string[]`, so it takes wiki ids as-is.
- `src/lib/wikis.ts:2620-2650` -- `sweepOrphanWikiDirectories`: the exported-maintenance-entry precedent to copy — gate before the lock, `withWikiLock(owner, …)`, return a count.
- `src/lib/wikis.ts:865-871` -- `bumpRefreshSignal(after)`; `after` completes "the refresh signal did not move after …". Must be called OUTSIDE the lock.
- `src/lib/wikis.ts:300-331` -- `readRegistry` / `writeRegistry`, both plain and lock-free; `src/lib/wikis.ts:2751-2763` -- `readWikiArtifact(owner, wikiId, file)`, ENOENT → null, other errors thrown. Use it, not raw storage, and catch per Wiki.
- `src/lib/wiki-scenarios.ts:31-50` -- `CREATABLE_SCENARIOS` and `SCENARIO_LABELS`; `:155-184` `renderPurposeMarkdown` (emits `Scenario Template: <Label> — <description>` as its third line); `:204-235` `renderSchemaMarkdown` (emits `# Schema — <Label>` first and `Seeded from the <Label> Scenario Template.`). The witness derivation belongs here, beside the renders it inverts — the module is pure and client-safe, which the Block If protects.
- `src/lib/workspace-purpose.ts:26-54` -- `renderCanonicalPurposeMarkdown`: emits NO template line, so a canonicalized Wiki has no `purpose.md` witness. Read-only evidence for the one-witness row.
- `src/lib/read-only.ts:294-303` -- `READ_ONLY_REFUSAL.wikiDirectorySweep`, the model for a scan-only key with no route to mirror. `read-only-copy-parity.test.ts:665-690` requires every sentence to be unique, start uppercase, end with `.`, and contain "while this deployment is read-only.".
- `src/lib/maintenance.ts:308-378` -- `sweepOrphanWikiDirs`: the fail-soft wrapper shape to copy verbatim (`getOwnerHandle()` → 0, `await import("./wikis")`, catch → `logger.error` → 0).
- `src/app/api/tasks/scan/route.ts:202-262` -- the `!forceDry` block, the `logger.info` line and the JSON body. Add one step beside `orphanWikiDirsRemoved`.
- `src/lib/__tests__/wikis.test.ts:2960-3040` -- `landRegistryWriteThenThrow`, `mintedWikiId`, and the DW-675 landed row that currently asserts `rejects.toThrow(FAULT)`. That assertion is what inverts. `:3040-3130` the `unknown` row, which must stay byte-for-byte in behaviour. Helpers in scope: `failWritesTo`, `warnsDuring`, `seededBytes`, `readDataVersion`, `wikisRootEntries`, `wikiDir`, `exists`, `seedTenantTrees`, `expectTenantTreesIntact`, `FAULT`.
- `src/lib/__tests__/workbench-data-version.test.ts:1225-1295` -- the structural bump guard: module total 9 → 10, seven bodies → eight, and the new `["reconcileWikiScenarioDrift", 1]` row. The lock-placement loop applies to it too, so the reconciler must open `withWikiLock(owner, …)` and close it at the top indent before the bump.
- `src/lib/__tests__/read-only-kernel-gate.test.ts:690-730` -- the gated-writer table (`["wikis", "sweepOrphanWikiDirectories"]` etc.); the reconciler is a new row. `:463-525` the sweep's own refusal row is the shape for the reconciler's.
- `src/lib/__tests__/scan-route.test.ts:1-50, 236-276` -- the `@/lib/maintenance` mock list and the three-row pattern (normal scan, enabled production, `?dry=1` suppresses) to mirror.
- `src/lib/__tests__/maintenance.test.ts:393-441` -- `sweepOrphanWikiDirs`' wrapper suite: `wikisRoot()`, the no-owner-handle case, the fail-soft case.
- `src/lib/__tests__/wikis-routes.test.ts:282-292` -- `POST /api/wikis` is tested with `createWiki` MOCKED, so the route needs no change and no new row: 201 already follows a resolved create. Read-only evidence for why the door's truth is pinned in `wikis.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-scenarios.ts` -- add a pure `scenarioNamedByArtifact(file, content)` returning a `CreatableScenario` or null, anchored line-by-line on the exact strings `renderPurposeMarkdown`/`renderSchemaMarkdown` emit, answering null when no label or more than one distinct label matches -- the inverse of the renders belongs beside them, and it must stay storage-free so the dialog can keep importing this module.
- `src/lib/read-only.ts` -- add one `READ_ONLY_REFUSAL` key for the reconciler, distinct from `wikiDirectorySweep`, with the parity suite's sentence shape -- it is a scheduled repair of registry labels, not a directory reclaim, and an owner reading the sweep's sentence beside it would look for a delete nobody asked for.
- `src/lib/wikis.ts` -- add exported `reconcileWikiScenarioDrift(owner)`: gate, then `withWikiLock` over `rotatingSweepWindow` of the registry's ids, deriving witnesses through `readWikiArtifact` (per-Wiki catch), repairing only on unambiguous disagreement, writing `wikis.json` at most once, returning the repairs; bump once outside the lock and warn per repair naming the id, the stored scenario and the one the artifacts name.
- `src/lib/wikis.ts` -- carry the whole `WikiRecord` on `CreateWikiOutcome`'s `failed` arm and make the tail RESOLVE with it when `registryLanded`, after the existing single bump; extend the outcome and `registryNamesWiki` docblocks (and the `named` warn) to say the create is reported as SUCCEEDED because the read-back observed the stored record, while `absent` and `unknown` still re-throw unwrapped.
- `src/lib/maintenance.ts` -- add `reconcileWikiScenarios()`, the fail-soft `sweepOrphanWikiDirs`-shaped wrapper, with a docblock stating why it is not inside `scanForMaintenance`.
- `src/app/api/tasks/scan/route.ts` -- call it in the `!forceDry` block beside the sweep, add its count to the `logger.info` line and to the JSON body.
- `src/lib/__tests__/wikis.test.ts` -- invert the DW-675 landed row to assert `createWiki` resolves with the stored record (registry, `currentId`, artifacts, single bump, warn, no tombstone all unchanged), leave the `absent`/`unknown`/seed-fault rows asserting the throw, and add a reconciler suite covering every matrix row.
- `src/lib/__tests__/workbench-data-version.test.ts` -- update the structural bump guard for the module's tenth site and eighth body.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- add the reconciler to the gate-precedes-lock table and a refusal row proving a diverged registry is left unrepaired on a read-only deployment.
- `src/lib/__tests__/wikis-create-door-landed.test.ts` -- new: drive `POST /api/wikis` against the real kernel and a temp `DATA_DIR` over the landed-then-threw provider, asserting 201 and the stored record, with a not-landed negative control still answering 500 -- the door row is the one the ledger entry is about and `wikis-routes.test.ts` mocks `createWiki`, so nothing there could pin it.
- `src/lib/__tests__/maintenance.test.ts` and `src/lib/__tests__/scan-route.test.ts` -- add the wrapper suite (count, no owner handle, fail-soft) and the three scan rows (normal, enabled production, `?dry=1` suppresses).

**Acceptance Criteria:**
- Given a `writeRegistry` that stores `wikis.json` and then rejects, when the owner creates a Wiki through `POST /api/wikis`, then the response is 201 carrying that Wiki and a second create is never provoked.
- Given a registry entry whose `scenario` disagrees with what both of its artifacts name, when the maintenance scan runs, then the registry entry names what the artifacts name, `dataVersion` has moved by exactly one, and no artifact byte changed.
- Given a tenant with no drift, when the scan runs, then `wikis.json` is not rewritten and `dataVersion` does not move.
- Given more Wikis than `ORPHAN_SWEEP_CANDIDATE_CAP`, when the scan runs on successive UTC days, then every Wiki is examined within `ceil(n / cap)` days.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 1, low 10)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The witness anchors were pinned only against hand-written fixtures, so a reword of `renderPurposeMarkdown`/`renderSchemaMarkdown` would silently kill the reconciler with the suite green — added a round-trip row that writes REAL renderer output for one scenario over a Wiki created on another, and corrected `nameScenarioIn`'s docblock, which claimed coverage it does not have.
  - `[low]` `[patch]` The witness read bypassed the `artifactAuthority` boundary — switched it to `readEffectiveWikiArtifact` with the record threaded in, so an unmarked Wiki's served (projected) `purpose.md` decides rather than stored bytes the same scan request is about to overwrite via `canonicalizeWikiPurpose`; added a row proving the projection is what is consulted.
  - `[low]` `[patch]` "One registry write and one bump per pass" was tested only for a single repair — the rotation row now asserts both across its 25-repair pass, which also reaches the bump message's plural branch.
  - `[low]` `[patch]` Nothing pinned that a repair leaves the rest of the record alone — the repair row now asserts `name`, `createdAt`, `updatedAt` and `currentId` are byte-identical afterwards.
  - `[low]` `[patch]` `scenarioNamedByArtifact`'s two-way ternary gave any future `WIKI_ARTIFACT_FILES` entry the `schema.md` anchor by inheritance — the `schema.md` arm is explicit now and anything else answers null.
  - `[low]` `[patch]` The deliberate CRLF strip was unexercised (deleting it failed nothing) — added a row whose `\r\n` `schema.md` is the sole witness.
  - `[low]` `[patch]` `read-only.ts` claimed the parity suite pins the mirrors-no-route property for all three scan-only keys while only two had rows — added the `wikiScenarioReconcile` row.
  - `[low]` `[patch]` `read-only-door-coverage.test.ts`'s census of gated writers excluded from the door sweep did not name the reconciler — added, with the same reason as its two siblings.
  - `[low]` `[patch]` The scan route's module docblock listed neither the new step nor `wikiScenariosReconciled` among its response fields.
  - `[low]` `[patch]` `read-only-kernel-gate.test.ts`'s "all seven are unchanged" control now covers eight writers — retitled, and its body actually exercises the reconciler on a writable deployment rather than only counting.
  - `[low]` `[patch]` The new door row justified 201 with "all three artifacts" and read back two — it reads the seeded workspace profile too.

## Design Notes

**Why the registry follows the artifacts, and not the reverse.** After a failed re-template whose registry write landed, the artifacts are the state the owner was told they were left in — the rollback restored them — and the registry is the liar. After DW-210's incomplete rollback the reverse landed on disk, and the same rule still gives the coherent answer: `schema.md` is what actually executes in every ingest, chat and lint prompt, so a registry label that names what the bytes say is true either way. It is also the only direction that cannot destroy work, which is what makes it safe to run unattended on a timer.

**Why a repair is silent when it does not fire.** Both artifacts are owner-editable, so "no witness" and "witnesses disagree" are ordinary states a scan will meet on every tick for the life of a Wiki. Warning on them would put a permanent recurring line in the operator log for a healthy deployment, which is how the sweep's own warn-once machinery came to exist. Only the repair speaks.

Witness shape (both anchors are the renderer's own literals, not a fuzzy match):

```ts
// purpose.md, third line as rendered:
"Scenario Template: Business — …"   → "business"
// schema.md, first line as rendered:
"# Schema — Business"               → "business"
// canonicalized purpose.md has neither → null (no witness, not a disagreement)
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/scan-route.test.ts src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/wikis-create-door-landed.test.ts` -- expected: all pass, with every pre-existing create-compensation, sweep and re-template row unchanged except the one landed row this spec inverts.
- `pnpm vitest run` -- expected: no new failures.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm lint` -- expected: no new errors or warnings.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two wiki-lifecycle doors stop reporting a failure over a state that landed. `createWiki`'s failure tail now RESOLVES with the new record on the one arm where the DW-675 read-back POSITIVELY found it in `wikis.json` — the registry names the Wiki, `currentId` points at it, all three seeded artifacts are on disk and `dataVersion` has moved, which is exactly what a successful create leaves behind — so `POST /api/wikis` answers its ordinary 201 instead of a 500 the owner would retry into a second Wiki against `MAX_WIKIS`. The storage fault is relocated to the operator log, not lost. The `absent` and `unknown` arms are untouched and still re-throw the original error unwrapped. Separately, the registry/artifact scenario divergence that `registryNamesScenario` has detected since DW-484 finally has an owner: `reconcileWikiScenarioDrift` runs from the maintenance scan on the `sweepOrphanWikiDirectories` precedent, derives from each Wiki's SERVED artifacts which Scenario Template they name, and re-derives the REGISTRY from them — never the reverse — when the witnesses are unanimous and disagree with the stored label. `POST /api/wikis/[id]/template`'s failure response is unchanged, per DW-676's recorded 2026-08-31 decision.

**Files changed.**
- `src/lib/wiki-scenarios.ts` — pure `scenarioNamedByArtifact`, the inverse of the two renderers, anchored on their own literals.
- `src/lib/wikis.ts` — `CreateWikiOutcome` carries the record and the tail returns it on the landed arm; `scenarioNamedByWikiArtifacts` (unanimity over `readEffectiveWikiArtifact`) and the exported `reconcileWikiScenarioDrift`.
- `src/lib/read-only.ts` — `READ_ONLY_REFUSAL.wikiScenarioReconcile`, the third scan-only key with no route literal to mirror.
- `src/lib/maintenance.ts` — `reconcileWikiScenarios()`, the fail-soft wrapper.
- `src/app/api/tasks/scan/route.ts` — the step, the log line and `wikiScenariosReconciled`.
- Tests — `wikis.test.ts` (inverted landed row plus an 11-row reconciler suite), the new `wikis-create-door-landed.test.ts` (the door, end to end), `maintenance.test.ts`, `scan-route.test.ts`, `read-only-kernel-gate.test.ts`, `read-only-copy-parity.test.ts`, `read-only-door-coverage.test.ts`, `workbench-data-version.test.ts`.

**Review findings breakdown.** 11 patches applied (1 medium, 10 low); 1 deferred (low — the partially-rolled-back divergence, where the two artifacts name different templates, is now skipped silently by design and reported by nothing); 8 rejected as noise or out of scope on the intent's own authority: DEPLOY.md's read-only operator list (a pre-existing omission that already misses the scratch reaper); duplicate registry ids, which no writer can produce; a read-deadline for artifact reads under the tenant lock, which `sweepOrphans` does not have either; the reconciler's write persisting a `normalizeRegistry` repair, which every other registry writer in the module already does and which cannot happen here without a repair; relabelling after a crash mid-re-template, which is the spec's argued direction rather than a defect; BOM/leading-whitespace tolerance on the schema anchor, where strictness is the documented choice; escalating the relocated storage fault from `warn` to `error`, which would diverge from every sibling fail-soft line in the module; and DW-676's owner-session surfaces (`WikiWorkbench.applyTemplate`, the 10s poll), which the ledger's recorded decision routes to the maintenance scan instead. No intent gaps and no spec defects.

**One reading recorded rather than assumed.** The bundle header says "make each route's status describe what actually happened" while DW-676's recorded decision says "leave the failure response as it is once the scan closes the window". The decision wins for the template route, and the two entries are not in fact the same shape at the point that decides a status: for a create, the landed registry state IS the success state, so 201 is honest; for a re-template, the landed registry write sits beside rolled-back artifacts, so the operation genuinely failed and only the label lied — which is what the reconciler corrects.

**Follow-up review recommendation.** false. Patched this pass: high 0, medium 1, low 10 — no high-severity patch, so no further loop.

**Verification performed.**
- `pnpm vitest run src/lib/__tests__/wikis.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/maintenance.test.ts src/lib/__tests__/scan-route.test.ts src/lib/__tests__/wikis-routes.test.ts src/lib/__tests__/wikis-create-door-landed.test.ts` — all pass.
- `pnpm vitest run` (full suite) — 370 files, 9167 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` — clean. `pnpm lint` — no errors or warnings beyond the pre-existing `jsx-ast-utils` notices on unrelated JSX.
- Every I/O matrix row is covered by a row that ran and passed, and each new guard was mutation-checked: reverting the create tail's return, the repair, the unanimity rule, the one-write-per-pass rule, the rotation bound, the per-Wiki read-error skip, the bump gate, the ambiguity refusal, either renderer anchor, the `readEffectiveWikiArtifact` switch and the `\r` strip each fails at least one row.
- The rotation row was rewritten to PLANT its 26 Wikis rather than drive 26 `createWiki` calls: at ~5.2s under a full parallel run it was flaking against vitest's 5s default timeout. It now runs in ~40ms and still fails if the pass walks the whole registry on day one.

**Residual risks.**
- The reconciler's per-Wiki read-error skip is SILENT, so an artifact that is permanently unreadable produces no line from this pass. Deliberate — "no witness" is an ordinary state of an owner-editable file and warning on it would put a recurring line in a healthy deployment's log — but it means a genuinely broken artifact is invisible here.
- `POST /api/tasks/scan` is the repair's only trigger of any kind, and the pass is bounded to `ORPHAN_SWEEP_CANDIDATE_CAP` Wikis rotating once per UTC day. A deployment that never scans keeps a switcher label its artifacts contradict, and a tenant at `MAX_WIKIS` takes four days to be fully examined.
- Scope is the single `getOwnerHandle()` tenant, inheriting `sweepOrphanWikiDirs`' documented pre-gate-tenant residual. The cost there is a stale label, never lost bytes.
- The create now answers 201 over a provider that reported a write failure. That is what the disk says, and the read-back is direct observation rather than inference — but a deployment whose object store is dropping acknowledgements will no longer surface that through this door's error rate, only through the `wikis` warn.
