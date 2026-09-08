---
title: 'Silent lifecycle skips: strict cascade enumeration + contradicting-artifact signal'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: '3c92e86b550a2e654bdc0ecbaf5b34fe97086bf3'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `cancelJobsForSource` runs before the cascade's enumeration loop, so a cascade that now
      fails loudly leaves the source's ingest jobs cancelled while the source itself survives.
    evidence: |-
      `cascadeDeleteSource` calls `cancelJobsForSource(input.owner, keys)` at
      src/lib/source-cascade.ts:177, before enumeration. Every throw after that point — the
      DW-495 sibling read, `deleteWikiPage`, `writeWikiPageWithSideEffects`, and now the
      DW-737 enumeration read — leaves the cancellation applied to a source whose bytes and
      citations are all still in place. Nothing re-queues them, so pending ingest work for a
      surviving source is silently dropped and the owner sees a 500 with no indication that
      queued jobs were lost. Pre-existing (the cascade could already throw past that line);
      widened, not created, by the strict enumeration read.
    location: >-
      src/lib/source-cascade.ts:177
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two lifecycle sweeps drop work silently. `cascadeDeleteSource`'s enumeration read (`src/lib/source-cascade.ts:193`) calls `readWikiPageWithFrontmatter(entry.slug)` with no options and `continue`s on a falsy result, so a non-ENOENT storage blip drops a page from `summaries`/`others`, PERSISTS that omission into the resume marker written just below it (a retry takes the `if (resumed)` arm and never re-enumerates), and the cascade then deletes the raw source bytes anyway and reports success — leaving a page citing bytes that no longer exist (DW-737). Separately, `scenarioNamedByWikiArtifacts` (`src/lib/wikis.ts:2925`) collapses "no witness" and "the two witnesses disagree" into the same `null`, so `reconcileWikiScenarioDrift` skips the partially-rolled-back re-template — `purpose.md` and `schema.md` naming DIFFERENT Scenario Templates — and nothing detects, repairs or logs it (DW-735).

**Approach:** Pass `{ strict: true }` to the enumeration read so a non-ENOENT fault rethrows and fails the cascade loudly before any marker is written or byte is deleted, matching the sibling read forty lines below. Give `scenarioNamedByWikiArtifacts` a discriminated result that separates "none" from "contradiction", and have `reconcileWikiScenarioDrift` emit a warn-once operator line for the contradiction. Signal only, never repair: both artifacts are owner-editable and a repair would have to guess which of two files is right.

## Boundaries & Constraints

**Always:**
- The enumeration read gets `{ strict: true }` ONLY. `fresh` is deliberately not added: this read decides membership, it does not back a write precondition, and the sibling's `fresh` exists for the merge base it hands to `writeWikiPageWithSideEffects`.
- ENOENT still reads as absence at both sites; `strict` changes only what a non-ENOENT fault does.
- The registry follows the artifacts, never the reverse. The contradiction path writes NOTHING — not `wikis.json`, not an artifact byte, no `bumpRefreshSignal`, and it returns 0 repairs for that Wiki exactly as today.
- The contradiction warn is warn-ONCE per isolate, mirroring `warnOnceAboutFutureDatedWrite`: one module-level collection, one emitter, prune + `@internal` reset. A steady contradiction must not put a recurring line in the operator log on every scan tick.
- An unreadable artifact still throws out of the witness read and is still skipped silently per Wiki by the caller's `catch` — "I could not look" is not a contradiction.
- Update the docblocks that state the OLD contract as an invariant: `scenarioNamedByWikiArtifacts`' "UNANIMITY OR NOTHING … returns null", `reconcileWikiScenarioDrift`'s "SILENT WHEN IT DOES NOT FIRE … Only a REPAIR speaks", and the `strict-merge-base-reads.test.ts:147` comment calling the enumeration read "deliberately left non-strict".

**Block If:**
- Closing DW-735 would require choosing a winner between two contradicting artifacts, or writing an artifact byte.
- `{ strict: true }` on the enumeration read turns out to change behaviour for an ENOENT (genuinely absent) page in existing coverage.

**Never:**
- Do not convert `listWikiPages()` in `cascadeDeleteSource` (or any other read) to strict — only the one enumeration read this bundle names.
- Do not add an owner-facing UI surface for the contradiction; the operator log is the whole signal for this bundle.
- Do not repair, re-seed, or reconcile the workspace profile's own `scenario` field.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cascade, clean run | Pages cite the doomed source; every read succeeds | Unchanged: summaries deleted, others rewritten, raw bytes deleted, marker cleared | No error expected |
| Cascade, absent page | `listWikiPages` names a slug whose file is gone (ENOENT) | `continue` — the slug is skipped, as today | No error expected |
| Cascade, blipped page | Non-ENOENT storage fault on `<slug>.md` during enumeration | `cascadeDeleteSource` REJECTS with the storage error; no marker written, no page deleted, no raw bytes deleted | Storage error propagates verbatim |
| Witness, no labels | Neither artifact names a template (or both absent) | Result is the "none" arm; reconciler skips the Wiki, silently, writes nothing | Non-ENOENT read throws to caller's per-Wiki `catch` |
| Witness, one label | One artifact names a template, the other says nothing | Result is the "named" arm; existing repair behaviour unchanged | — |
| Witness, contradiction | `purpose.md` names Business, `schema.md` names Research | Result is the "contradiction" arm; ONE warn naming both files and both labels; 0 repairs, registry bytes unchanged | — |
| Contradiction, second pass | Same contradiction, same isolate | Silent — no second warn | — |
| Contradiction, then resolved | Contradiction warns, artifacts are then made to agree | Repair fires and warns as today; a LATER contradiction on that Wiki warns again (re-armed) | — |

</intent-contract>

## Code Map

- `src/lib/source-cascade.ts:193` -- `const page = await readWikiPageWithFrontmatter(entry.slug);` inside the `else` (not-resumed) enumeration loop that builds `summaries`/`others`. THE ONE LINE DW-737 CHANGES. `if (!page) continue` sits at :194.
- `src/lib/source-cascade.ts:206-212` -- `writeMarker(...)` immediately after the loop: this is what persists a dropped slug so a retry inherits it.
- `src/lib/source-cascade.ts:231-238` -- the sibling read in the `others` loop, already `{ fresh: true, strict: true }` (DW-495), with the comment stating the exact harm. Copy its rationale shape, not its `fresh`.
- `src/lib/source-cascade.ts:286-288` -- `deleteRawSourceBytes(linked, input.owner)`; the destructive tail that runs regardless today.
- `src/lib/wiki.ts:667` -- `readWikiPageWithFrontmatter(slug, options?)`; forwards `options` verbatim to `readWikiPage`. `ReadWikiPageOptions.strict` is documented at `src/lib/wiki.ts:343-396`.
- `src/lib/wikis.ts:2880-2941` -- `scenarioNamedByWikiArtifacts` and its docblock. The loop reads `WIKI_ARTIFACT_FILES` in order (`purpose.md`, `schema.md`) via `readEffectiveWikiArtifact`, and `return null` at the first disagreement is the line DW-735 replaces.
- `src/lib/wikis.ts:2993-3060` -- `reconcileWikiScenarioDrift`: `assertWritable` gate, `withWikiLock`, `rotatingSweepWindow` over `registry.wikis.map(w => w.id)`, per-Wiki `try/catch`, `if (named === null || named === wiki.scenario) continue` at :3028, repair collection, single `writeRegistry`, then the post-lock warn loop and `bumpRefreshSignal`.
- `src/lib/wikis.ts:2421-2521` -- THE WARN-ONCE PATTERN TO MIRROR: `reportedFutureDatedWrites` (Map, value = the fact, so a CHANGED fact speaks again), `futureDatedKey`, `warnOnceAboutFutureDatedWrite`, `rearmFutureDatedWarning`, `pruneFutureDatedWarnings` (prunes against the full candidate list, never the window), `_resetWikiSweepWarnings` (`@internal`, already called from `wikis.test.ts:86`).
- `src/lib/wiki-scenarios.ts:57` (`WIKI_ARTIFACT_FILES`, `WikiArtifactFile`), `:274` (`scenarioNamedByArtifact`), and `SCENARIO_LABELS` -- pure, client-safe; the witness type must not drag storage into this module. READ-ONLY for this bundle.
- `src/lib/__tests__/strict-merge-base-reads.test.ts:147-160` -- the DW-495 row arms its blip on the `source-cascade/` marker WRITE, which is after the enumeration loop, so it still reaches only the `others` read. Its comment at :147 asserts the enumeration read is "deliberately left non-strict" and MUST be corrected.
- `src/lib/__tests__/wikis.test.ts:4353-4384` -- `"skips a wiki whose two artifacts disagree, silently"` ends with `expect(warned).toEqual([])`. This row pins the behaviour this bundle changes and must be updated, not deleted.
- `src/lib/__tests__/wikis.test.ts:4089-4160` -- reusable helpers inside the reconcile describe: `registryBytes`, `artifactPath`, `nameScenarioIn`, `warnsDuring`, `registryWritesDuring`, `storedScenario`.
- `src/lib/__tests__/lifecycle.test.ts:1862-2008` -- the real (unblipped) cascade coverage; the behaviour-neutral counter-check. Leave unedited.

## Tasks & Acceptance

**Execution:**
- `src/lib/source-cascade.ts` -- pass `{ strict: true }` to the enumeration `readWikiPageWithFrontmatter` at :193 and add a short comment naming the harm (dropped slug persisted into the marker, raw bytes deleted anyway) and why `fresh` is NOT included -- so a storage blip fails the cascade before anything is deleted.
- `src/lib/wikis.ts` -- replace `scenarioNamedByWikiArtifacts`' `CreatableScenario | null` return with a discriminated result carrying `none` / `named` / `contradiction`, where the contradiction arm names both artifact files and both scenarios; update its docblock so "unanimity or nothing" describes the new shape -- so the caller can tell absence from contradiction.
- `src/lib/wikis.ts` -- add the contradiction warn-once record beside `reportedFutureDatedWrites`: keyed by owner+wiki id, VALUED by the contradiction so a different contradiction speaks again, with an emitter, a re-arm for a Wiki that reads clean, a prune against the registry's full id list, and an extension of `_resetWikiSweepWarnings` to clear it -- so a standing contradiction costs one operator line per isolate, not one per tick.
- `src/lib/wikis.ts` -- have `reconcileWikiScenarioDrift` collect contradictions inside the lock and emit them AFTER it (beside the repair warns), keep the `named`/`no-change` arms as no-ops, and correct the "SILENT WHEN IT DOES NOT FIRE / Only a REPAIR speaks" paragraph -- so logging stays out of `wikis:<tenant>` and the docblock stops asserting the old contract.
- `src/lib/__tests__/strict-merge-base-reads.test.ts` -- add a row driving the enumeration blip (fail `<slug>.md` on the FIRST read, before any `source-cascade/` marker write): assert the call rejects with the storage error, that no marker was written, that the cited page still exists, and that the raw source bytes are still on disk. Correct the :147 comment.
- `src/lib/__tests__/wikis.test.ts` -- rewrite the `"disagree, silently"` row as a "disagree, and says so once" row: same 0-repairs / 0-writes / unchanged-bytes / unchanged-dataVersion assertions, plus exactly one warn naming both templates, plus a second pass in the same isolate that is silent, plus a re-arm check (make the artifacts agree, let it repair, re-introduce a contradiction, and see it warn again).

**Acceptance Criteria:**
- Given a page whose `<slug>.md` read fails with a non-ENOENT storage error during cascade enumeration, when `cascadeDeleteSource` runs, then it rejects with that error and no resume marker, page delete, or raw-source delete has occurred.
- Given a page that is genuinely absent (ENOENT), when `cascadeDeleteSource` enumerates, then it is skipped exactly as before and the cascade completes.
- Given a Wiki whose `purpose.md` and `schema.md` name different Scenario Templates, when `reconcileWikiScenarioDrift` runs, then it repairs nothing, writes no registry or artifact byte, and emits exactly one operator warning identifying the Wiki and both named templates.
- Given that contradiction is still present on a later pass in the same isolate, when the reconciler runs again, then it emits no further warning for it.
- Given a Wiki with no witness or a single witness, when the reconciler runs, then its behaviour and its silence are byte-for-byte what they are today.

## Design Notes

WHY THE ENUMERATION READ IS THE WORSE OF THE TWO SITES, even though `:229` was converted first: the `others` read only mis-handles a page already known to cite the source, while a drop HERE removes the page from the cascade's world entirely — and the marker write below turns a transient fault into a permanent one, because `if (resumed)` skips enumeration on every retry.

The witness result shape (naming both halves so the operator line can be specific):

```ts
type WikiScenarioWitness =
  | { kind: "none" }
  | { kind: "named"; scenario: CreatableScenario }
  | { kind: "contradiction"; between: readonly [
      { file: WikiArtifactFile; scenario: CreatableScenario },
      { file: WikiArtifactFile; scenario: CreatableScenario },
    ] };
```

WHY THE WARN-ONCE VALUE IS THE CONTRADICTION AND NOT A BOOLEAN: an owner who edits `schema.md` from Research to Personal Growth has produced a NEW contradiction, and an operator who has only ever seen the old line would otherwise never learn the pair changed. (There is no Legal Scenario Template — `SCENARIO_LABELS` is Research / Reading / Personal Growth / Business / General / Custom.) This is exactly why `reportedFutureDatedWrites` carries the instant rather than a flag.

WHY THE PRUNE RUNS AGAINST THE REGISTRY'S FULL ID LIST, not the rotating window: pruning against what was WALKED would evict every entry outside today's window and re-warn the whole tail tomorrow, turning the per-day rotation back into per-tick repetition.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/strict-merge-base-reads.test.ts src/lib/__tests__/lifecycle.test.ts` -- expected: all pass, including the unedited real-cascade rows (behaviour-neutral without a blip).
- `pnpm exec vitest run --project node src/lib/__tests__/wikis.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-door-coverage.test.ts` -- expected: all pass; the reconciler's read-only gate and door coverage are untouched.
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: no new errors.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Two lifecycle sweeps stopped dropping work silently. (1) DW-737: `cascadeDeleteSource`'s enumeration read now passes `{ strict: true }`, so a non-ENOENT storage fault rethrows and fails the cascade before the resume marker freezes the omission and before `deleteRawSourceBytes` runs. `fresh` is deliberately not added — the read classifies membership, it does not back a write precondition. (2) DW-735: `scenarioNamedByWikiArtifacts` now returns a discriminated `WikiScenarioWitness` (`none` / `named` / `contradiction`, the contradiction carrying both `{file, scenario}` halves), and `reconcileWikiScenarioDrift` emits a warn-once operator line for the contradiction — collected inside the tenant lock, emitted after it, repairing nothing and writing nothing.

**Files changed.**
- `src/lib/source-cascade.ts` — enumeration read converted to `{ strict: true }`, with the harm and the `strict`-reaches-`getPageIndex` consequence recorded in comment.
- `src/lib/wikis.ts` — `WikiScenarioWitness` union; `scenarioNamedByWikiArtifacts` rewritten to return it; new warn-once record `reportedScenarioContradictions` with key/fact/emitter/re-arm/prune mirroring `reportedFutureDatedWrites`; `_resetWikiSweepWarnings` clears both; `reconcileWikiScenarioDrift` collects and emits contradictions; three docblocks corrected to state the new contract.
- `src/lib/__tests__/strict-merge-base-reads.test.ts` — corrected the stale "deliberately left non-strict" comment; added an enumeration-blip row (rejects, zero marker writes, page bytes unchanged, raw source intact) and a non-vacuous ENOENT counter-check row.
- `src/lib/__tests__/wikis.test.ts` — rewrote the "disagree, silently" row as "disagree, and says so ONCE"; added rows for re-arm after resolution, a changed contradiction speaking again, an unreadable artifact staying silent, every contradicting wiki being named in one pass, and the prune running against the registry rather than the rotation window.

**Review findings breakdown.** 7 patches applied (0 high, 3 medium, 4 low) — see the Review Triage Log. 1 item deferred (low). 12 rejected: chiefly the pre-existing multi-tenant and invalid-slug enumeration edges, the non-strict `listWikiPages` above the converted read (out of scope on the intent's own authority), speculative third-artifact and lock-interleaving races whose worst case is one missed or duplicated log line, and three descriptive intent-alignment observations recorded under residual risks below rather than as defects.

**Follow-up review recommendation.** Patched findings this pass: high 0, medium 3, low 4. Score: no high-severity patch, so `followup_review_recommended: false`.

**Verification performed.**
- `pnpm exec vitest run --project node src/lib/__tests__/strict-merge-base-reads.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-door-coverage.test.ts` — 244 passed.
- `pnpm test` — 388 files, 9777 passed / 1 skipped.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `npx tsc --noEmit` — clean.
- Mutation checks (all reverted): removing `{ strict: true }` fails the enumeration-blip row; throwing at the enumeration `continue` fails the ENOENT row; pruning against the rotation window, deleting the prune call, and collapsing the collect to the first contradiction each fail their new rows.
- Matrix audit: every I/O & Edge-Case Matrix row is covered by a row that ran and passed, confirmed by name via `--reporter=verbose`.

**Residual risks.**
- The ledger's DW-735 decision reads "logged **and surfaced to the owner**"; the bundle intent narrows that to "a warn-once operator signal", which is what shipped. There is no owner-facing operator-diagnostics surface in this repo that could carry it (`LintIssue` is page-scoped, `OperationKind` has no wiki/maintenance member, the `/wiki/log` Trail is not written by the reconciler), so the owner half remains unimplemented by design of the bundle intent.
- The contradiction signal rides on `reconcileWikiScenarioDrift`, which `assertWritable` refuses whole on a read-only deployment — so contradictions are neither detected nor named there. Recorded in the docblock; the gate was deliberately not moved.
- Detection is rotation-delayed: at most `ORPHAN_SWEEP_CANDIDATE_CAP` wikis are examined per pass, so a tenant above the cap sees a contradiction reported within `ceil(n / cap)` days.
- `strict` reaches into `getPageIndex`, so a corrupt `derived-indexes/pages.json` now fails every cascade rather than only those touching a citing page. Accepted: the sibling read already carried that reach, and failing closed is the direction DW-737 asks for.
- The intra-file collapse (one artifact naming two labels answers `none`) is untouched — `wiki-scenarios.ts` was read-only for this bundle and the ledger's harm is cross-file.
