---
title: 'DW-640/DW-642: widen the read-only door-coverage registry to the remaining gated writers'
type: 'chore'
created: '2026-09-02'
status: 'done'
baseline_revision: 'ab92ef64d82aff00094eba1551a766a41161fb6d'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `read-only-door-coverage.test.ts` exists to catch the door added TOMORROW, but its `KERNEL_WRITERS`/`WRITER_EXPORTS` roll still names only the page/artifact, wiki-lifecycle and workspace-profile writers. `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm`, the `research-projects.ts` writers, `saveEmailIngestConfig`, and `lifecycle.ts`'s `pruneStaleIndexEntry`/`deleteWikiPageWhileLocked` all carry `assertWritable` and are invisible to the scan, so a new route reaching one ships the 500-shaped refusal the file exists to prevent.

**Approach:** Add those writers to `KERNEL_WRITERS`, add their module keys and writer-reaching exports to `WRITER_EXPORTS`, add the modules that define or call them to `WRITER_MODULES`, rewrite the docblocks so the remaining out-of-scope boundary is stated accurately, and give a read-only treatment to any door the widened scan then reaches that lacks one.

## Boundaries & Constraints

**Always:**
- Every writer added to `KERNEL_WRITERS` must be spelled `export async function <name>(` with `assertWritable(READ_ONLY_REFUSAL.<key>)` inside its first 1200 characters — the third case asserts exactly this, and it must pass unmodified.
- Every writer added to `KERNEL_WRITERS` must appear under exactly ONE `WRITER_EXPORTS` module key whose `<name>.ts` declares it, so the third case's `defining` probe resolves to length 1.
- `WRITER_EXPORTS` stays per-SYMBOL. Read-only helpers from the same modules (`listNamesTerms`, `expandQueryWithNamesTerms`, `getResearchProject`, `listResearchProjects`, `loadEmailIngestConfig`) must NOT be listed, or read-only routes start demanding gates.
- `WRITER_MODULES` must list every `src/lib/*.ts` module whose own code calls one of the writers now in `KERNEL_WRITERS`, per its own docblock — otherwise the staleness case stops being able to say what it claims.
- Any route the widened scan reaches must carry ONE of the two sanctioned treatments (early `isReadOnly()` gate, or an `isReadOnlyError(...)` branch in the catch). Land those in this pass.
- Both `expect(...).toEqual([])` cases must still be evidence: the `reached.length` floor is raised to match the widened corpus, keeping the property the current comment states — losing the largest single `src/app/api` writer-reaching subtree drops the count below the floor.
- Docblocks must describe the roll as it then is. No comment may keep claiming a writer is out of scope once it is in the list.

**Block If:**
- A door the widened scan reaches carries neither treatment AND the correct treatment is not derivable from the existing convention (irreversible/expensive work before the write → early gate; direct writer call → catch branch). That is a design call, not a mechanical one.
- Any writer named in the intent turns out not to be spelled `export async function` (respelled as a `const` arrow, made synchronous, or given a generic parameter list), so adding it would need the third case's probe itself changed.

**Never:**
- Do not widen to the store writers the intent does not name: `todos.ts`, `review-queue.ts`, `graph-insight-dismissals.ts`, `source-meeting.ts`, `maintenance.ts`, `workspace-profile-backfill.ts`. Their doors stay enumerated by name in `read-only-copy-parity.test.ts`.
- Do not add `lifecycle.ts` or `patch-metadata.ts` to `WRITER_MODULES`. They DEFINE the original four writers, and scanning them would flag most of `lifecycle.ts`'s exports and widen the route scan far past this pass's intent.
- Do not weaken any existing assertion, member pin, or floor to make the widened scan green.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not change any writer's own gate, or any route's behaviour beyond adding a missing treatment.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Widened scan, today's tree | Every `route.ts` under `src/app/api` | `untreated` is `[]`; `reached` grows to include the names-terms, research and email-settings doors | No error expected |
| New untreated door | A route importing `createNamesTerm` with neither treatment | First case fails naming the file and the symbol it reaches | Test failure, by name |
| New writer-reaching export | A new export in `research-runtime.ts` calling `deleteResearchProject` | Staleness case fails with `@/lib/research-runtime:<name>` | Test failure, by name |
| Gate deleted from a new writer | `assertWritable` removed from `saveEmailIngestConfig` | Third case fails `email-ingest.ts: saveEmailIngestConfig opens with assertWritable` | Test failure, by name |
| Read-only helper import | A route importing only `loadEmailIngestConfig` | Not counted as reaching a writer; no treatment demanded | No error expected |

</intent-contract>

## Code Map

- `src/lib/__tests__/read-only-door-coverage.test.ts` -- the only file that must change structurally. `KERNEL_WRITERS` :74, its docblock :34-73 (states the current OUT OF SCOPE boundary that this pass invalidates), `WRITER_EXPORTS` :107, `WRITER_MODULES` :170, `writerImports` :190 (per-symbol named-import match plus a whole-module dynamic-`import()` rule), member pins + count floors :239-270, staleness case :285, `assertWritable` case :318.
- `src/lib/names-terms.ts` -- `createNamesTerm` :322 (gate :333), `updateNamesTerm` :354 (:360), `deleteNamesTerm` :378 (:380). All `export async function`, gate within the first ~450 chars. Read helpers `listNamesTerms` :291 and `expandQueryWithNamesTerms` :437 must stay off the roll.
- `src/lib/research-projects.ts` -- `repairResearchRegistry` :629 (gate :634), `createResearchProject` :871 (:880), `editResearchProject` :1042 (:1050), `deleteResearchProject` :1232 (:1237). All `export async function`. NOT writers for this purpose: `applyResearchProjectMutation` :756 and the `*OrRefusal` wrappers, which return the `RESEARCH_WRITE_REFUSED` sentinel rather than calling `assertWritable`.
- `src/lib/email-ingest.ts` -- `saveEmailIngestConfig` :107 (gate :120). `loadEmailIngestConfig` :75 is the read.
- `src/lib/lifecycle.ts` -- `pruneStaleIndexEntry` :1099 (gate :1103), `deleteWikiPageWhileLocked` :1200 (:1208). No route imports either; the only callers are `lint-fix.ts:144` (inside `fixStaleIndex`, declared :116 — NOT `fixStalePage` :632, and `fixStaleIndex` was absent from `WRITER_EXPORTS["@/lib/lint-fix"]`, so adding `pruneStaleIndexEntry` to the roll makes the staleness case flag it and the entry must be added) and `merge.ts:663,724` (inside the private `mergePagesWhileSourceLocked` :354, reached from the already-declared `mergePages` :334). Both modules are already in `WRITER_MODULES`. `src/lib/wiki.ts:943` re-exports only `writeWikiPageWithSideEffects` and `deleteWikiPage`, so `@/lib/wiki` needs no change. A THIRD sibling, `writeWikiPageWithSideEffectsWhileLocked` :1393, must go into `WRITER_EXPORTS` but NOT `KERNEL_WRITERS`: its gate is one frame down in the private `writeWikiPageWithSideEffectsInternal` :1288 (:1297), so the third case's head probe would fail on it — and `writerImports`' `\b`-anchored match means the `writeWikiPageWithSideEffects` row does not cover an import of the longer name. Only caller `merge.ts:206,688`.
- `src/lib/research-runtime.ts` -- MIXED, not purely writer-reaching. `retireResearchProject` :586 is itself an `export async function` gating at its own entry with `assertWritable(READ_ONLY_REFUSAL.researchMutate)` :596 (well inside the third case's 1200-char head), because it TOMBSTONES through the CAS mutator before reaching `deleteResearchProject` :655 — so it belongs on `KERNEL_WRITERS` as well as `WRITER_EXPORTS`, and `research-runtime.ts` is the module that declares it (`defining` resolves to 1). `reconcileResearchProjects` :696 (:728, :798, :812) is writer-REACHING only, the shape of the `@/lib/ingest`/`@/lib/lint-fix` entries already in the map. Only route callers: `src/app/api/research/[id]/route.ts:7` and `src/app/api/research/route.ts:16`, both already reached and treated.
- `src/lib/source-cascade.ts` -- a LIVE uncovered door before this pass. `cascadeDeleteSource` :167 calls the kernel writer `deleteWikiPage` :216/:235 and `writeWikiPageWithSideEffects` :255, and `src/app/api/workbench/source/route.ts:7` imports it — yet `@/lib/source-cascade` was in neither map, so that route never entered `reached` and neither of its treatments was ever demanded. Add `"@/lib/source-cascade": ["cascadeDeleteSource"]` (writer-REACHING shape) and `"source-cascade"` to `WRITER_MODULES`. The route carries both treatments already, so no route edit; it does add one route to `reached`.
- `src/lib/research-completion.ts` -- reaches `deleteResearchProject` :166 only through the private `deleteRetiredProjectIfLeaseGone`, so the staleness case cannot see it (its documented KNOWN LIMIT). No route imports this module.
- Doors the widened scan reaches — READ-ONLY EVIDENCE, all verified to carry both treatments already, so no route edit is expected: `src/app/api/names-terms/route.ts` :37/:54, `src/app/api/names-terms/[id]/route.ts` :24/:45/:62/:79, `src/app/api/research/route.ts` :76/:145, `src/app/api/research/[id]/route.ts` :17/:90/:107/:127, `src/app/api/research/[id]/run/route.ts` :32/:98 (reached via the dynamic `import("@/lib/research-projects")` at :159), `src/app/api/research/repair/route.ts` :42/:66, `src/app/api/email/settings/route.ts` :59/:190, `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` :65/:160.
- `src/app/api/sources/search/route.ts` :4, `src/app/api/query/stream/route.ts` :22, `src/app/api/settings/route.ts` :14 -- import only read helpers from these modules. They are the reason the map must stay per-symbol.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the sibling suite that enumerates these doors by name today; referenced by the docblock, not changed here.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add `pruneStaleIndexEntry`, `deleteWikiPageWhileLocked`, `createNamesTerm`, `updateNamesTerm`, `deleteNamesTerm`, `createResearchProject`, `editResearchProject`, `deleteResearchProject`, `repairResearchRegistry` and `saveEmailIngestConfig` to `KERNEL_WRITERS` -- these are the gated writers the scan cannot currently see.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- also add `retireResearchProject` to `KERNEL_WRITERS` -- it gates at its own entry (`research-runtime.ts:596`), so registering it as writer-reaching only would leave that gate deletable with all three cases green. It is already in `WRITER_EXPORTS["@/lib/research-runtime"]`, the module that declares it, so `defining` resolves to 1 and `reached` does not change.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add `fixStaleIndex` to `WRITER_EXPORTS["@/lib/lint-fix"]` -- putting `pruneStaleIndexEntry` on the roll makes `lint-fix.ts`'s one production caller writer-reaching, and the staleness case fails on it otherwise. Writer-reaching only; NOT a `KERNEL_WRITERS` entry.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add `writeWikiPageWithSideEffectsWhileLocked` to `WRITER_EXPORTS["@/lib/lifecycle"]` and NOT to `KERNEL_WRITERS` -- the `\b`-anchored symbol match means the shorter entry does not cover an import of it, so a future route importing it is skipped entirely; its gate sits in the private internal, so the third case's head probe would fail on it. Say both in the comment.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add `"@/lib/source-cascade": ["cascadeDeleteSource"]` to `WRITER_EXPORTS` and `"source-cascade"` to `WRITER_MODULES` -- closes the live uncovered `/api/workbench/source` door; adds one route to `reached`.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add one member pin per subtree the widening newly covers (`src/app/api/names-terms/route.ts`, `src/app/api/email/settings/route.ts`, `src/app/api/research/route.ts`) -- without them, dropping `names-terms` or `email` from the walk leaves the count above the floor and the case green while covering less.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- extend `WRITER_EXPORTS`: append the two new symbols to `@/lib/lifecycle`; add `@/lib/names-terms`, `@/lib/research-projects`, `@/lib/email-ingest` (definers) and `@/lib/research-runtime` (`retireResearchProject`, `reconcileResearchProjects`, writer-reaching) -- this is what makes the route scan see the doors.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add `names-terms`, `research-projects`, `email-ingest`, `research-runtime` and `research-completion` to `WRITER_MODULES` -- keeps the staleness case's own claim ("every module whose code calls a kernel writer") true after the widening.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- rewrite the `KERNEL_WRITERS` and `WRITER_MODULES` docblocks and the `@/lib/wikis` inline note so the stated OUT OF SCOPE boundary is the one that actually remains (`todos`, `review-queue`, `graph-insight-dismissals`, `source-meeting`, `maintenance`, `workspace-profile-backfill`, and the definer modules `lifecycle`/`patch-metadata`), and record why `research-completion` carries no `WRITER_EXPORTS` entry -- a docblock that still calls a listed writer out-of-scope is worse than none.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- raise the `reached.length` floor to the value the widened corpus supports, and update its comment with the new count and the subtree the headroom is sized against -- an unraised floor lets the whole widening be lost without the case going red.
- `src/app/api/**/route.ts` -- ONLY IF the widened first case reports an untreated door: add the sanctioned treatment (early `isReadOnly()` gate where irreversible or expensive work precedes the write, otherwise an `isReadOnlyError(err)` branch in the catch) -- the intent requires the doors the widening reaches to be treated in the same pass. Investigation found every door the widening reaches — the eight above plus `src/app/api/workbench/source/route.ts` — already treated, so expect no edit here.

**Acceptance Criteria:**
- Given the widened registry, when `read-only-door-coverage.test.ts` runs, then all three cases pass with no assertion, pin or floor weakened.
- Given a route that imports `createNamesTerm`, `saveEmailIngestConfig`, `deleteResearchProject` or `retireResearchProject` and carries neither treatment, when the first case runs, then it fails naming that file and the `module:symbol` it reaches.
- Given a new exported function in `names-terms.ts`, `research-projects.ts`, `email-ingest.ts`, `research-runtime.ts` or `research-completion.ts` whose own body calls one of the listed writers, when the staleness case runs, then it fails naming `@/lib/<module>:<export>`.
- Given `assertWritable` removed from any newly listed writer, when the third case runs, then it fails naming that module and writer.
- Given a route that imports only a read helper from one of the newly added modules, when the first case runs, then that route is not reported as untreated.
- Given `src/app/api/workbench/source/route.ts` — which imports `cascadeDeleteSource` and reaches `deleteWikiPage` through it — when the first case runs, then that route is counted in `reached`, and stripping both of its treatments fails the case by name.
- Given `assertWritable` removed from `retireResearchProject`, when the third case runs, then it fails naming `research-runtime.ts: retireResearchProject`.
- Given the `names-terms` or `email` subtree dropped from the walk, when the first case runs, then a member pin fails by name rather than the case passing on a smaller corpus.
- Given the full suite, when `npx vitest run` completes, then no previously passing test has regressed.

## Design Notes

The three cases read from one another, so the four edits are not independent. `KERNEL_WRITERS` is the roll; the staleness case re-derives which of those writers each `WRITER_MODULES` entry reaches; the `assertWritable` case iterates the roll and finds each writer's definer through `WRITER_EXPORTS`. Adding a writer to the roll without a `WRITER_EXPORTS` entry that declares it fails the third case with `expected exactly one module` and length 0.

`@/lib/research-runtime` is a MIXED entry after review: `retireResearchProject` is on the roll (it carries its own `assertWritable`, so the third case pins that gate), while `reconcileResearchProjects` is writer-REACHING only, the same shape as `@/lib/ingest` and `@/lib/lint-fix`. `@/lib/source-cascade` is the pure writer-REACHING shape: `cascadeDeleteSource` reaches `deleteWikiPage`, so its route is scanned, but the module declares no writer of its own.

`research-completion.ts` goes into `WRITER_MODULES` with no `WRITER_EXPORTS` key. That is deliberate and needs a comment: it means "scan this module — if an EXPORT here ever calls the writer directly, say so by name", while today's only path runs through a private helper the case cannot see.

## Spec Change Log

_No spec amendment was required; no `bad_spec` loopback occurred._

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 0
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` The first case's member pins were never extended to the three subtrees the widening newly covers, so dropping `names-terms` or `email` from the walk left the count above the floor and the case green while covering less. Added pins for `src/app/api/names-terms/route.ts`, `src/app/api/email/settings/route.ts` and `src/app/api/research/route.ts`.
  - `[medium]` `[patch]` `retireResearchProject` (`src/lib/research-runtime.ts:586`, gated at `:596`) is named verbatim by DW-640 but was registered writer-REACHING only, so its own gate could be deleted with the suite green. Added it to `KERNEL_WRITERS`; the third case now pins it.
  - `[medium]` `[patch]` `src/lib/source-cascade.ts:167 cascadeDeleteSource` reaches `deleteWikiPage` and has a live door at `src/app/api/workbench/source/route.ts:7`, but the module was in neither map, so that route never entered `reached`. Added `@/lib/source-cascade` to `WRITER_EXPORTS` and `source-cascade` to `WRITER_MODULES`; the route already carried both treatments.
  - `[low]` `[patch]` `writeWikiPageWithSideEffectsWhileLocked` (`src/lib/lifecycle.ts:1393`) was invisible: the `\b`-anchored symbol match does not cover the longer name. Added to `WRITER_EXPORTS["@/lib/lifecycle"]` as registry-only, with the reason it cannot join the roll (its gate lives in the private `writeWikiPageWithSideEffectsInternal`).
  - `[low]` `[patch]` Three rewritten-docblock claims were untrue as written: the lifecycle additions read as a census of that family, `canonicalizeWikiPurpose` was an unnamed exclusion beside `sweepOrphanWikiDirectories`, and `WRITER_MODULES` named only the two definers as deliberate absences. Corrected, and the dynamic-`import()` branch is now named as the deliberate module-level exception to the per-symbol rule.
  - `[low]` `[patch]` The Code Map credited `pruneStaleIndexEntry`'s `lint-fix.ts:144` call to `fixStalePage` rather than `fixStaleIndex` and recorded it as already covered, leaving the `@/lib/lint-fix` registry edit unspecified. Corrected, with Execution rows and acceptance criteria added for it and for the three review patches above.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/read-only-door-coverage.test.ts` -- expected: 3 passed, 0 failed.
- `npx vitest run src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: the sibling door suite still passes untouched.
- `npx tsc --noEmit` -- expected: no new type errors.
- `npx eslint src/lib/__tests__/read-only-door-coverage.test.ts` -- expected: clean.
- `npx vitest run` -- expected: the full suite is no worse than the pre-change baseline; capture the baseline first if any failure appears.

## Auto Run Result

Status: done

**Implemented change.** `src/lib/__tests__/read-only-door-coverage.test.ts`'s hand-written registry was widened from the page/artifact + wiki-lifecycle + workspace-profile roll to the gated writers DW-640/DW-642 named, so the source scan now demands a read-only treatment on the doors in front of them. `KERNEL_WRITERS` gained `pruneStaleIndexEntry`, `deleteWikiPageWhileLocked`, `createNamesTerm`, `updateNamesTerm`, `deleteNamesTerm`, `repairResearchRegistry`, `createResearchProject`, `editResearchProject`, `deleteResearchProject`, `saveEmailIngestConfig` and (from review) `retireResearchProject`. `WRITER_EXPORTS` gained `@/lib/names-terms`, `@/lib/research-projects`, `@/lib/email-ingest`, `@/lib/research-runtime` and `@/lib/source-cascade`, plus `fixStaleIndex` under `@/lib/lint-fix` and two more symbols under `@/lib/lifecycle`. `WRITER_MODULES` gained `names-terms`, `research-projects`, `email-ingest`, `research-runtime`, `research-completion` and `source-cascade`. Writer-reaching routes went 31 → 39 and the evidence floor was raised 25 → 33. No route or library source needed editing: every door the widened scan reaches already carried a sanctioned treatment.

**Files changed.**
- `src/lib/__tests__/read-only-door-coverage.test.ts` — widened `KERNEL_WRITERS`/`WRITER_EXPORTS`/`WRITER_MODULES`, added member pins for the three newly covered subtrees, raised the `reached` floor, and rewrote the docblocks so the stated out-of-scope boundary is the one that actually remains.
- `_bmad-output/implementation-artifacts/spec-dw-640-642-read-only-kernel-writer-registry.md` — this spec (new).

**Review findings breakdown.** 6 patches applied (medium 3, low 3); 0 deferred; 4 rejected. Rejected, with reasons: a proposed `READ_HEAVY` exception set for `writerImports`' dynamic-`import()` branch (it would weaken a deliberately conservative over-approximation, which the spec's Always clause forbids); pre-registering `commitResearchPage`/`drainResearchOutbox` from `research-completion.ts` (their path to the writer runs through a private helper — the case's documented KNOWN LIMIT, already recorded in the docblock — and no route imports the module); `tenant-admin.ts:40 deleteTenant`'s own gate not being pinned by the third case (pre-existing, outside this bundle's intent); and `src/app/api/tasks/run/route.ts:53`'s import of `runResearchProject` (transitive reach only, which this file's one-hop model deliberately excludes; the route carries both treatments today).

**Follow-up review recommendation:** false. Patched findings by severity: high 0, medium 3, low 3. Score: no high-severity patch, so no further review pass is warranted.

**Verification performed.**
- `npx vitest run src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/read-only-copy-parity.test.ts` — 29 passed, 0 failed.
- `npx tsc --noEmit` — clean. `npx eslint src/lib/__tests__/read-only-door-coverage.test.ts` — clean.
- `npx vitest run` (full) — 369 files, 9091 passed, 1 skipped, 0 failed.
- Every I/O matrix row was exercised first-hand by temporary mutation and reverted: an untreated probe route importing `createNamesTerm` failed the first case by name; a `probeRetire` export in `research-runtime.ts` failed the staleness case by name; `assertWritable` stripped from `saveEmailIngestConfig` failed the third case by name; and the read-only-helper row is covered live by `/api/sources/search` and `/api/query/stream`, which import only `expandQueryWithNamesTerms`, carry no treatment, and are not flagged. Review patches were mutation-tested the same way (gate stripped from `retireResearchProject`; both treatments stripped from `workbench/source/route.ts`; `skipDirs` set to drop the `names-terms` subtree, which the new pin catches and the floor alone would not).
- Probed the raised floor directly: with the floor temporarily set to an impossible value the case reported `reached` = 39, so the floor of 33 sits below the real count with the stated headroom (39 − 7 for the `ingest` subtree = 32 < 33).

**Residual risks.**
- The registry is still hand-written. This pass widened it and made its stated boundary accurate, but the deeper defect both ledger entries note — that these doors are enumerated rather than derived — is untouched; the same class of omission recurs the next time a writer is added without a registry edit.
- Deliberately still off the roll, recorded in the docblock rather than closed: the remaining DW-385 store writers (`todos.ts`, `review-queue.ts`, `graph-insight-dismissals.ts`, `source-meeting.ts`, `maintenance.ts`, `workspace-profile-backfill.ts`), whose doors stay pinned by name in `read-only-copy-parity.test.ts`.
- `npx prettier --check` warns on the changed file, but warned identically on it before this change — the repo carries no prettier config and its house style is ~100 columns against prettier's default 80. Not a regression, and not in this spec's verification set.
