---
title: 'Narrow the embedding-drift re-arm to a whole-window model match'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: '6762241bca65eda90fc07a50db9a562ca23e21f1'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      DW-404's own recorded reproduction (topK 1, one stale-tagged and one
      current-tagged vector, alternating queries) still emits four drift lines
      under the narrowed whole-window gate, so the entry's named symptom
      survives this change.
    evidence: |-
      `queryEmbeddings` sorts and slices to topK BEFORE `searchByVector`
      applies the model filter, so with `topK: 1` the window holds a single
      match; when that match is the current-tagged vector the window matches
      wholly and re-arms exactly as `kept.length > 0` did. Reproduced
      independently by two reviewers against the patched code: four lines
      before, four lines after. Closing it needs a corpus-level signal (the
      rebuild-completion epoch the ledger names as the alternative fix), which
      the 2026-08-22 decision did not authorize and this spec forbids.
    location: >-
      src/lib/embeddings.ts (searchByVector re-arm branch)
    severity: medium
  - summary: >-
      After the narrowing, one stale ORPHAN vector wedges `drift:<model>` shut
      permanently, so a second genuine drift ships silent on any store that has
      ever deleted, renamed, or emptied a page.
    evidence: |-
      `rebuildVectorStore` never deletes (its own docblock says so) and
      `continue`s past pages with empty content or a failed embed, so a
      COMPLETED rebuild can still leave stale-tagged vectors behind. Every
      window containing one is mixed forever, and a mixed window no longer
      re-arms. Verified by probe: two vectors, a completed rebuild re-tagging
      only the live one, then a genuine re-drift under the same active model
      produced ONE warning where the DW-332 pins assert two. Documented in
      prose on `warnedMisconfigurations` by this change, but not mitigated and
      not pinned by any test — mitigating it would need the rebuild to delete,
      or persisted rebuild state, both Block-If conditions here.
    location: >-
      src/lib/embeddings.ts (warnedMisconfigurations drift bullet; rebuildVectorStore)
    severity: medium
  - summary: >-
      `spec-dw-404-405-406-embedding-drift-rearm-gate.md` is still
      `status: in-review` though it was never implemented, and now prescribes a
      predicate that contradicts the 2026-08-22 human decision.
    evidence: |-
      That spec reconciles DW-404 and DW-405 into
      `matches.every((m) => m.metadata.model === model)` and also rewrites
      `relatedByVector` (DW-406). HEAD before this run still had
      `kept.length > 0`, so none of it ever landed. A later run routing on its
      `in-review` status would re-derive the strict-label gate and silently
      close DW-405, which the human decision deliberately left open, and would
      pull DW-406 in with it. It needs to be withdrawn or re-scoped by whoever
      owns the ledger.
    location: >-
      _bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md
    severity: medium
  - summary: >-
      No test discriminates the permissive whole-window gate from the
      strict-label variant, so the DW-405 decision point rests on one code line
      with zero coverage in either direction.
    evidence: |-
      Mutating the gate to `matches.every((m) => m.metadata?.model ===
      currentModel)` leaves all 173 tests in `embeddings.test.ts` passing. This
      is deliberate — the intent forbids pinning the unlabelled-legacy case
      either way while DW-405 is open — but it means whichever way DW-405 is
      eventually decided, the change will be unguarded until that entry adds
      its own pin.
    location: >-
      src/lib/__tests__/embeddings.test.ts (describe("searchByVector") drift suite)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `searchByVector` re-arms the `drift:<active model>` warning key on `kept.length > 0` — a property of the per-query top-K *window*, not of the corpus. `queryEmbeddings` sorts and slices to `topK` BEFORE the model filter runs, and `rebuildVectorStore` upserts page by page with no bulk swap (leaving stale orphans behind), so during the very rebuild the re-arm exists to detect, a window holding one stale and one current vector re-arms the key. Eight alternating queries over such a mixed corpus emitted FOUR drift lines instead of the one DW-310 guarantees.

**Approach:** Apply the human decision of 2026-08-22 (option 1, "whole-window match only"): re-arm only when the model filter dropped NOTHING from a non-empty window — `matches.length > 0 && kept.length === matches.length`. Record the narrowed trigger, and the residue it does not close, against the 2026-08-21 `kept.length > 0` decision in the module's own doc comments.

## Boundaries & Constraints

**Always:**
- The re-arm gate is `matches.length > 0 && kept.length === matches.length` over the RAW query window: a window that dropped anything, or that is empty, does not re-arm. The non-empty half is not optional — `kept.length === matches.length` alone is vacuously true for an empty store and would re-arm on zero evidence, which is strictly worse than today.
- The warn branch keeps its exact meaning — "the store returned hits and the filter kept none" — and must now say so explicitly (`kept.length === 0 && matches.length > 0`). Re-arm and warn stopped being complementary, so an implicit `else` would warn on a mixed window that legitimately returned results.
- `searchByVector`'s drift sentence stays byte-identical, and neither branch changes what the door RETURNS.
- The re-arm stays on the success path inside the existing `try`, keyed `drift:${currentModel}` using the SAME `currentModel` snapshot the filter compared against (DW-313 one-snapshot invariant). Never re-derive the model name for the delete.
- The narrowed trigger, and the residue it leaves (topK slicing means no window is a corpus proof; an unlabelled legacy vector still counts as a match — DW-405, still open), are recorded in the `warnedMisconfigurations` `drift:` bullet and `searchByVector`'s JSDoc, which today assert `kept.length > 0`.

**Block If:**
- Closing DW-404 would require changing `modelMatches`, making stored `model` metadata mandatory, or introducing persisted rebuild state.

**Never:**
- Do not touch `modelMatches` — unlabelled legacy vectors must keep surviving the filter for RESULTS, and the narrowing is on the re-arm gate only.
- Do not close DW-405 here: the human decision deliberately leaves the unlabelled-legacy-vector case open, so do NOT strengthen the gate to "every match is positively labelled with the active model", and do not add a test pinning the unlabelled case in either direction.
- Do not touch `relatedByVector` (that is DW-406, a separate open entry), `rebuildVectorStore`, `warnOnceAbout`, `rearmWarningAbout`'s signature, `_resetEmbeddingWarnings`, the DW-401 `ollama-endpoint:sdk-default` re-arm, or the three never-clearing env/binding identities.
- Do not export new public API, add a rebuild-completion epoch, or add an info/"drift cleared" log line.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed window (DW-404) | Drift line said under M; a partial rebuild leaves the window holding one stale-tagged and one M-tagged vector; reads run; the corpus then fully drifts again under M | The mixed reads do NOT re-arm, so the drift line has still been said exactly ONCE; those reads still RETURN the M-tagged vector | No error expected |
| Empty window | Drift line said under M; every vector is then removed; a read runs; the corpus is re-seeded fully stale under M | The empty read does NOT re-arm (and does not warn), so the drift line has still been said exactly ONCE | No error expected |
| Completed rebuild | Drift line said under M; every vector in the window is then tagged M | Re-arms, so a later real drift under M speaks a second time | No error expected |
| Whole window still stale | Store returns hits, filter keeps none | Warns once per `drift:M` identity, exactly as today; returns `[]` | No error expected |
| Query throws | `queryEmbeddings` rejects (dimension mismatch) | `[]` via the existing catch; no warn, no re-arm | Existing `logVectorQueryFailure` path, unchanged |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:64-72` -- the `drift:<active model>` bullet of the `warnedMisconfigurations` doc comment. Line 67 names `kept.length > 0` as the signal; that becomes false here. The bullet's closing sentence ("The signal is narrower than 'the corpus is healthy', which the branch itself records") stays true and should now point at the tightened gate.
- `src/lib/embeddings.ts:107-129` -- `warnOnceAbout` / `rearmWarningAbout`, the Set's only two mutators. READ-ONLY: signatures and bodies unchanged. `rearmWarningAbout`'s docblock already defers to "the re-arm branch in `searchByVector`" for how strong the evidence is, so it stays accurate.
- `src/lib/embeddings.ts:783-793` -- `EmbeddingMeta` and `modelMatches`. READ-ONLY. Its permissiveness ("Unknown active model or unlabelled legacy vector → don't filter it out") is pinned by the test at line 1159 and is exactly why DW-405 survives this change.
- `src/lib/embeddings.ts:904-933` -- `searchByVector` JSDoc. Lines 924-932 describe the re-arm signal ("a read that KEEPS at least one match") and the one-snapshot rule for the delete. The signal sentence is rewritten; the one-snapshot paragraph stays verbatim.
- `src/lib/embeddings.ts:934-984` -- `searchByVector` body: `cfg` 938, `currentModel` 942, `try` 946, `matches` 947, `kept` 948, the `if (kept.length > 0) { rearm } else if (matches.length > 0) { warn }` chain at 964-978, `return kept.map(...)` 979, catch 980-983. Only the branch conditions and the re-arm's inline comment (965-969) change.
- `src/lib/storage/filesystem.ts` `queryEmbeddings` (contract in `src/lib/storage/types.ts`) -- sorts and slices to `topK` BEFORE the model filter runs. READ-ONLY, and the reason the doc comment must not over-claim corpus proof.
- `src/lib/embeddings.ts:1023+` -- `rebuildVectorStore`: per-page upserts, no bulk swap, orphans left behind. READ-ONLY context; it is WHY mixed windows occur mid-rebuild.
- `src/lib/__tests__/embeddings.test.ts:84-113` -- `seedVector(slug, vector, model, hash)`; pass an explicit stale model for a drifted vector.
- `src/lib/__tests__/embeddings.test.ts:169-190` -- `withWarnSpy`, returning `{ result, warnings }` filtered to the `embeddings` channel. The global `beforeEach` (line 132) already calls `_resetEmbeddingWarnings()`.
- `src/lib/__tests__/embeddings.test.ts:705-1173` -- `describe("searchByVector")`, holding the DW-310/DW-332 drift suite. The new DW-404 pins belong beside "SPEAKS again after the corpus is REBUILT and drifts a second time" (817).
- `src/lib/__tests__/embeddings.test.ts:917-941` -- "re-arms ONLY the read's OWN drift identity, not every drift key". MUST BE AMENDED: step 2's window keeps a stale `page-a` beside the newly current `page-b`, so under the tightened gate it no longer re-arms and the test would pass VACUOUSLY. Re-tag `page-a` under the active model instead of adding a second vector, so step 2 is a real whole-window match. Step 3 stays drifted under `text-embedding-3-large` either way.
- `src/lib/__tests__/embeddings.test.ts:880-916` -- "re-arms ONLY the drift key — other warning FAMILIES keep theirs". Its window is a single current-tagged vector, so the assertions still hold; only the inline comment at 903 naming `kept.length > 0` needs rewording.
- `src/lib/__tests__/embeddings.test.ts:1087-1099` -- "stays SILENT when the filter keeps even one match" (mixed window). Assertions still hold — a mixed window now neither warns nor re-arms — but it no longer exercises the re-arm, which is what the new DW-404 pin covers.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- in `searchByVector`, change the re-arm condition to `matches.length > 0 && kept.length === matches.length` and make the warn branch test `kept.length === 0 && matches.length > 0` explicitly -- the two branches are no longer complementary, so a mixed window must fall through both, and an empty window must not re-arm on no evidence.
- `src/lib/embeddings.ts` -- rewrite the re-arm's inline comment (the "A kept match establishes only that THIS read was answerable" block), the `drift:<active model>` bullet in the `warnedMisconfigurations` doc comment, and the re-arm signal sentence in `searchByVector`'s JSDoc so all three name the whole-window gate, cite the 2026-08-22 narrowing of the 2026-08-21 `kept.length > 0` decision, and state the residue plainly (topK slicing before the filter; an unlabelled legacy vector still counts as a match, DW-405) -- the current text asserts the superseded gate in all three places.
- `src/lib/__tests__/embeddings.test.ts` -- add the DW-404 mixed-window pin and the empty-window pin to `describe("searchByVector")`, each shaped burn-the-key → a read the OLD gate would have re-armed on → full drift again → assert the drift line was still said exactly ONCE, asserting the middle read's results so the cause is pinned as well as the effect.
- `src/lib/__tests__/embeddings.test.ts` -- amend "re-arms ONLY the read's OWN drift identity" so its step-2 window is entirely re-tagged under the active model, and reword the `kept.length > 0` inline comment at line 903 that the new gate falsifies.

**Acceptance Criteria:**
- Given the drift line has been said under active model M and the corpus is then only PARTIALLY rebuilt, when any number of reads run over the mixed window and the corpus then fully drifts again under M, then the drift line has still been emitted exactly once and those reads still returned their surviving matches.
- Given the drift line has been said under M and the store is then emptied, when a read runs over the empty store and the corpus is re-seeded fully stale under M, then the drift line has still been emitted exactly once.
- Given a corpus that drifted under M and was then fully rebuilt so every vector in the window is tagged M, when a read runs and the corpus later drifts again under M, then the drift line is emitted a second time.
- Given `pnpm test`, `pnpm lint`, and `npx tsc --noEmit`, when run over the repository, then lint and typecheck are clean and the test run shows no failures beyond those already present at `baseline_revision` (13 `src/components/workbench/__tests__/*.tsx` files crash in `beforeEach` on an undefined `window.localStorage`, and DW-411 can make `pnpm` itself abort — see Verification for the `npx` fallback).

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 4: (high 0, medium 3, low 1)
- reject: 7: (high 0, medium 2, low 5)
- addressed_findings:
  - `[medium]` `[patch]` No positive re-arm test had a window wider than ONE match, so the mutant `matches.length === 1 && kept.length === 1` survived the whole 173-test file (and the identity-test amendment had shrunk the last multi-vector case). Widened "SPEAKS again after the corpus is REBUILT and drifts a second time" to a two-vector corpus re-tagged wholesale — the one place a re-arm is directly observable — and widened the identity test's step-2 window to two current matches. The mutant now fails.
  - `[medium]` `[patch]` The residue list omitted the narrowing's largest cost: `rebuildVectorStore` never deletes and skips empty/failed pages, so one stale ORPHAN vector leaves every window containing it permanently mixed and the key can never re-arm again for that model. Recorded in the `warnedMisconfigurations` `drift:` bullet.
  - `[medium]` `[patch]` "eight alternating queries emitted four drift lines" was written in the past tense, reading as a defect this change fixed; the ledger's reproduction uses `topK: 1` and still oscillates under the new gate. Reworded in the doc comment and in the mixed-window test's header to state what the narrowing does and does not close.
  - `[low]` `[patch]` "An early re-arm costs a repeated line; a missing one loses the next outage" was the rationale for the LOOSER gate and argued against the branch it annotated; replaced with the trade the narrowing actually makes.
  - `[low]` `[patch]` The narrowing history and residue were restated in near-identical words at three sites; the `warnedMisconfigurations` bullet is now the canonical statement and the JSDoc and inline comment point at it.
  - `[low]` `[patch]` Swept the test comments still describing the superseded "a kept match is the signal" gate (the DW-332 rebuild pin, "does NOT re-arm while the drift is still standing", the FAMILIES test), and recorded that "stays SILENT when the filter keeps even one match" is now the sole guard on the warn branch's explicit condition. One over-claim introduced in that sweep — that its silence also proves no re-arm — was corrected: a re-arm is silent too.
  - `[low]` `[patch]` Spec-side: corrected two Code Map line references (`withWarnSpy` starts at 169, not 157; the "stays SILENT" test at 1087) and reworded the verification acceptance criterion, which demanded `pnpm test` "all pass" in a checkout with 233 pre-existing DOM-project failures and a DW-411 `pnpm` abort.

## Design Notes

A superset spec exists at `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` (status `in-review`, never implemented — HEAD still has `kept.length > 0`). It reconciled DW-404 + DW-405 into `matches.every((m) => m.metadata.model === model)`. That is NOT what the human chose: option 1 is whole-window match only, and DW-405's unlabelled-legacy case stays open. Do not import the `every`-labelled predicate from it.

The gate stays two plain conditions inline rather than a named predicate — it is one branch in one door, and inlining keeps the contrast with the warn branch's `kept.length === 0` readable side by side:

```ts
if (matches.length > 0 && kept.length === matches.length) {
  rearmWarningAbout(`drift:${currentModel}`);
} else if (kept.length === 0 && matches.length > 0) {
  warnOnceAbout(`drift:${currentModel}`, /* ...existing sentence, byte-identical... */);
}
```

Be honest about the residue rather than over-claiming. `queryEmbeddings` slices to `topK` before the filter, so a window that never SEES the stale vectors still re-arms; and because `modelMatches` keeps unlabelled vectors, a window carried by one is still a whole-window match (DW-405). What the narrowing buys is precisely that a window which demonstrably DROPPED something no longer counts as proof a rebuild landed — which is the oscillation DW-404 names.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- expected: all pass, including the amended identity test and the new DW-404 pins.
- `pnpm test` -- expected: full suite passes with no new failures. (`pnpm` may fail this checkout with `ERROR packages field missing or empty`; fall back to `npx vitest run`, the identical command.)
- `pnpm lint` -- expected: clean (fall back to `npx eslint` on the same failure).
- `npx tsc --noEmit` -- expected: no type errors.
- Mutation check (run, then revert): loosening the gate back to `kept.length > 0` must fail the mixed-window pin; dropping the `matches.length > 0` half must fail the empty-window pin.


## Auto Run Result

Status: done

**Implemented change.** `searchByVector`'s embedding-drift re-arm gate is now a whole-window model match — `matches.length > 0 && kept.length === matches.length` — instead of `kept.length > 0`, applying the 2026-08-22 human decision (option 1) that narrows the frozen 2026-08-21 trigger. A window the model filter demonstrably dropped something from no longer counts as evidence a rebuild landed, so a partially-rebuilt (mixed-model) corpus can no longer oscillate warn -> re-arm -> warn and defeat DW-310's once-per-identity guarantee. The non-empty conjunct is deliberate: the bare predicate is vacuously true of an empty window and would have re-armed on no evidence at all. Because re-arm and warn stopped being complementary, the warn branch now tests `kept.length === 0 && matches.length > 0` explicitly, so a mixed window that legitimately returned results falls through both. `modelMatches` is untouched, so unlabelled legacy vectors still survive the filter for RESULTS and DW-405 stays open as the decision intends; `relatedByVector` (DW-406) is untouched.

**Files changed.**
- `src/lib/embeddings.ts` -- the gate itself, plus the narrowing and its residue recorded canonically in the `warnedMisconfigurations` `drift:` bullet, with `searchByVector`'s JSDoc and the inline re-arm comment pointing at it.
- `src/lib/__tests__/embeddings.test.ts` -- new mixed-window and empty-window pins; the DW-332 rebuild pin and the drift-identity pin widened to two-vector windows so a degenerate single-match gate fails; comment sweep over the pins that described the superseded gate.
- `_bmad-output/implementation-artifacts/spec-dw-404-drift-rearm-whole-window.md` -- this spec.

**Review findings.** 7 patched (0 high, 3 medium, 4 low), 4 deferred (0 high, 3 medium, 1 low), 7 rejected. 0 intent gaps, 0 spec defects. Rejected as out of scope on the authority of the intent: that the ledger's DW-404 decision line ends "Also answers DW-405" while the invocation intent explicitly leaves DW-405 open (the invocation intent governs); that the ledger is not updated (this run is forbidden to edit it — the orchestrator records resolution); a suggested new `partial-drift:` warning and a corpus-count/rebuild-epoch gate (both new behaviour the decision did not authorize); a matrix row for the unlabelled-legacy case (the intent forbids pinning it in either direction); the observation that the empty-window pin also passes against the old gate (true, and its comment already says the re-arm on empty would be strictly worse than the old gate); and a reviewer's concurrency aside about probe edits appearing in the working tree.

**Follow-up review recommended: true.** Patched findings by severity: high 0, medium 3, low 4. Score = 3 x 3 + 1 x 4 = 13, which is >= 5.

**Verification performed.**
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- 173/173 pass.
- `npx tsc --noEmit` -- clean.
- `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` notices; no errors).
- `pnpm test` -- 7745 pass, 1 skipped, 233 fail. Every failure is in one of 13 `src/components/workbench/__tests__/*.tsx` files crashing in `beforeEach` at `window.localStorage.clear()`; confirmed pre-existing by stashing this change and re-running (29/29 fail on the clean baseline in `workbench-split-wiring.test.tsx` too). No `src/lib` failures.
- Mutation checks, run directly and each reverted: `kept.length > 0` fails only "does NOT re-arm on a PARTIALLY rebuilt (MIXED) window"; dropping the `matches.length > 0` conjunct fails only "does NOT re-arm on an EMPTY window"; `matches.length === 1 && kept.length === 1` fails "SPEAKS again after the corpus is REBUILT and drifts a second time". A bare `else if (matches.length > 0)` warn branch fails "stays SILENT when the filter keeps even one match".
- Matrix audit: all five I/O rows are covered by tests that ran and passed -- mixed window and empty window by the two new pins, completed rebuild by the two DW-332 rebuild pins, whole-window-still-stale by the DW-310 drift pins, and query-throws by "does NOT re-arm when the query THROWS".

**Residual risks.** Three, all recorded as deferred entries above and named in the code's own doc comment rather than papered over: DW-404's literal reproduction (`topK: 1`) still oscillates, because topK slicing runs before the filter; one stale orphan vector wedges `drift:<model>` shut permanently, since `rebuildVectorStore` never deletes; and no test discriminates this permissive gate from the strict-label variant, so whichever way DW-405 is decided the change lands unguarded. The first two are inherent to the gate the decision names -- closing either needs a rebuild-completion epoch or a deleting rebuild, both Block-If conditions here.
