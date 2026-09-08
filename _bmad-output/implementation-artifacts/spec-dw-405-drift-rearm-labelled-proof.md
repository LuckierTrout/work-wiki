---
title: 'Require positive proof of an active-model-labelled vector before re-arming the drift key'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: '945de9bfb9b40aa863b9a9a4a93a60223648b1db'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Two `searchByVector` calls in flight at once can interleave so that a
      window read BEFORE the drift key was burnt applies its re-arm AFTER,
      un-burning the key and letting the same standing drift speak twice.
    evidence: |-
      The gate, the `warnOnceAbout` burn and the `rearmWarningAbout` delete all
      run after `await getStorage().queryEmbeddings(...)`, and nothing carries
      a sequence number across that await. A healthy read that resolves late
      therefore re-arms on evidence gathered before another query burnt the
      key, and the next drifted read emits a second line — the repetition
      DW-310's throttle exists to prevent. Pre-existing and independent of the
      gate's shape: it holds identically under DW-332's `kept.length > 0`,
      DW-404's whole-window gate and this one, so this change neither causes
      nor worsens it. Not reproduced by a test: it needs a specific interleave
      of concurrent in-flight queries, unlike DW-404's and DW-405's
      reproductions, which are deterministic on sequential reads. Cost when it
      does happen is one extra breadcrumb line, and a guard would mean
      threading a burn sequence number through the door.
    location: >-
      src/lib/embeddings.ts:1015 (searchByVector re-arm/warn branch chain)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `searchByVector` re-arms `drift:<active model>` on a whole-window model match (`matches.length > 0 && kept.length === matches.length`), but `modelMatches` deliberately KEEPS unlabelled legacy vectors, so a window carried entirely by vectors with no `model` metadata is a whole-window match and re-arms the key on a corpus where every labelled vector is still stale. Seeding one unlabelled vector beside stale-tagged ones and alternating queries produced TWO drift lines where DW-310's throttle guarantees one.

**Approach:** Apply the 2026-08-22 human decision for DW-405 (option 1: fold into DW-404's conjunction). Add a positive-proof conjunct to the same single gate — `kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)` — so only a window that (a) the filter dropped nothing from and (b) demonstrably contains a vector labelled with the ACTIVE model re-arms. `modelMatches` stays permissive, so unlabelled vectors keep surviving the filter for RESULTS.

## Boundaries & Constraints

**Always:**
- The re-arm gate is exactly `kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)` over the RAW query window, evaluated against the SAME `currentModel` snapshot the filter compared with (DW-313 one-snapshot invariant).
- DW-404's non-empty requirement survives, now carried by the new conjunct rather than by a separate one: `Array.prototype.some` is false on an empty array, so an empty window cannot re-arm. The standalone `matches.length > 0` conjunct is therefore dropped as redundant, and the empty-window pin must still fail if the `some` conjunct is removed.
- `modelMatches` and its permissiveness are untouched; what the door RETURNS is unchanged in every scenario, and the warn branch keeps its exact condition `kept.length === 0 && matches.length > 0` and byte-identical sentence.
- The `warnedMisconfigurations` `drift:` bullet stays the CANONICAL statement of the gate (`searchByVector`'s JSDoc and the inline comment point at it rather than restating it). It currently lists the unlabelled-legacy case as a LIVE gap citing "DW-405, open"; that gap is closed here and the text must say so, dated 2026-08-22, without deleting the two residues that remain (topK slicing before the filter; a stale orphan wedging the key shut).
- The new conjunct's own cost is recorded honestly: a corpus whose vectors are ALL unlabelled can never re-arm, so if such a corpus ever burns the key it stays burnt.

**Block If:**
- Closing DW-405 would require changing `modelMatches`, making stored `model` metadata mandatory, or introducing persisted rebuild state.

**Never:**
- Do NOT use `matches.every((m) => m.metadata.model === currentModel)` (the predicate in the superseded `spec-dw-404-405-406-embedding-drift-rearm-gate.md`). It differs observably from the decided gate: a window holding one active-model-labelled vector beside an unlabelled one re-arms under the decision and does not under `every`.
- Do not touch `relatedByVector` (DW-406, a separate open entry), `rebuildVectorStore`, `modelMatches`, `warnOnceAbout`, `rearmWarningAbout`, `_resetEmbeddingWarnings`, the DW-401 `ollama-endpoint:sdk-default` re-arm, or the three never-clearing env/binding identities.
- Do not export new public API, add a rebuild-completion epoch, add an info/"drift cleared" log line, or edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unlabelled-only window (DW-405) | Drift line said under M; one vector with NO `model` metadata is added beside the stale-tagged ones; reads run over the whole window; the unlabelled vector is then removed so the corpus is fully stale under M | Those reads do NOT re-arm, so the drift line has still been said exactly ONCE; they still RETURN the unlabelled vector | No error expected |
| Labelled + unlabelled window | Drift line said under M; the corpus is rebuilt so the window holds one M-tagged vector and one unlabelled legacy vector; a read runs; the corpus then drifts fully again under M | Re-arms (positive proof is present, and the filter dropped nothing), so the drift line is emitted a SECOND time; both vectors are returned | No error expected |
| Mixed window (DW-404) | Window holds one stale-tagged and one M-tagged vector | Does NOT re-arm; still returns the M-tagged vector | No error expected |
| Empty window | Drift line said under M; every vector removed; a read runs; corpus re-seeded fully stale | Does NOT re-arm (and does not warn); drift line still said exactly ONCE | No error expected |
| Completed rebuild | Every vector in the window is tagged M | Re-arms, so a later real drift under M speaks a second time | No error expected |
| Whole window still stale | Store returns hits, filter keeps none | Warns once per `drift:M` identity, unchanged; returns `[]` | No error expected |
| Query throws | `queryEmbeddings` rejects (dimension mismatch) | `[]` via the existing catch; no warn, no re-arm | Existing `logVectorQueryFailure` path, unchanged |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:65-97` -- the `drift:<active model>` bullet of the `warnedMisconfigurations` doc comment: the CANONICAL gate statement. Line 68-69 names `matches.length > 0 && kept.length === matches.length`; lines 85-92 list three LIVE gaps, the second of which ("An unlabelled legacy vector counts as a match ... DW-405, open") is the one this change closes. The topK-slicing gap (85-89) and the stale-orphan gap (92-97) stay true and must survive.
- `src/lib/embeddings.ts:949-964` -- `searchByVector` JSDoc. Line 949-958 states the re-arm signal and its residue list (which names DW-405 at 955); the one-snapshot paragraph (958-964) stays verbatim.
- `src/lib/embeddings.ts:965-1023` -- `searchByVector` body: `currentModel` 973 (the single snapshot), `matches` 978, `kept` 979, the re-arm branch at 995-1007, the warn branch at 1008-1018, `return kept.map(...)` 1019, catch 1020-1023. ONLY the re-arm condition (995) and its inline comment (996-1006) change.
- `src/lib/embeddings.ts:809-818` -- `EmbeddingMeta` (`model: string`) and `modelMatches`. READ-ONLY. Its `!metadata.model` branch is exactly why the unlabelled case survives DW-404, and its permissiveness is pinned by the test at 1268.
- `src/lib/embeddings.ts:514-520` -- `getEmbeddingModelName` returns `string | null`. With a null active model the filter keeps everything, so the warn branch can never fire and the key is never burnt; `m.metadata.model === null` being false costs nothing. Worth one clause in the comment, no code branch.
- `src/lib/storage/filesystem.ts` `queryEmbeddings` (contract in `src/lib/storage/types.ts`) -- sorts and slices to `topK` BEFORE the model filter. READ-ONLY; the reason no window is corpus proof.
- `src/lib/__tests__/embeddings.test.ts:84-91` -- `seedVector(slug, vector, model, hash)` for labelled vectors. An UNLABELLED vector is seeded directly: `await getStorage().upsertEmbedding("legacy", [1, 0, 0], { contentHash: "x" })` (the pattern at line 1271).
- `src/lib/__tests__/embeddings.test.ts:169-190` -- `withWarnSpy` returning `{ result, warnings }` filtered to the `embeddings` channel; the suite's `beforeEach` (132) already calls `_resetEmbeddingWarnings()`.
- `src/lib/__tests__/embeddings.test.ts:870-912` -- "does NOT re-arm on a PARTIALLY rebuilt (MIXED) window" (DW-404). The new DW-405 pins belong immediately after it — same burn → probe-read → re-drift shape.
- `src/lib/__tests__/embeddings.test.ts:913-942` -- "does NOT re-arm on an EMPTY window". Its comment attributes the empty case to the separate `matches.length > 0` conjunct, which no longer exists; it must be re-attributed to `some` on an empty array. The assertions themselves still hold.
- `src/lib/__tests__/embeddings.test.ts:817-869`, `969-1006`, `1007-1043`, `1044-1084`, `1108-1145` -- the positive re-arm pins (rebuild, FAMILIES, own-identity, one-snapshot, real-rebuild). All seed labelled vectors under `DEFAULT_TEST_MODEL` (or the snapshot's model), so all still re-arm unchanged. READ-ONLY except where a comment names the superseded gate.
- `src/lib/__tests__/embeddings.test.ts:1187-1209` -- "stays SILENT when the filter keeps even one match": the sole guard on the warn branch's explicit condition. Unchanged.
- `src/lib/__tests__/embeddings.test.ts:1268-1277` -- "keeps unlabelled (legacy) vectors with no model metadata": pins `modelMatches`' permissiveness for RESULTS. Must keep passing untouched — it is the invariant the new conjunct must not disturb.
- `_bmad-output/implementation-artifacts/spec-dw-404-drift-rearm-whole-window.md` -- the immediately preceding change (`status: done`); its fourth deferred entry records that nothing discriminated this gate from the strict-label variant. READ-ONLY.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- change the re-arm condition at line 995 to `kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)`, dropping the now-redundant `matches.length > 0` conjunct -- only positive proof of a vector labelled with the active model may re-arm, and `some` is already false on an empty window.
- `src/lib/embeddings.ts` -- rewrite the re-arm's inline comment and the `drift:` bullet of the `warnedMisconfigurations` doc comment (and the JSDoc's residue sentence, which names DW-405) so the canonical statement is the two-conjunct gate, dates the 2026-08-22 DW-405 narrowing beside DW-404's, moves the unlabelled-legacy case from LIVE gap to closed, keeps the topK and stale-orphan residues, and records the new conjunct's own cost (an all-unlabelled corpus can never re-arm) -- all three sites currently assert the superseded gate.
- `src/lib/__tests__/embeddings.test.ts` -- add two DW-405 pins beside the DW-404 mixed-window pin: (1) an unlabelled-ONLY window does not re-arm, shaped burn-the-key → reads over the unlabelled+stale window → full drift again → drift line said exactly ONCE, asserting the probe reads still returned the unlabelled vector; (2) a window holding one active-model-labelled vector beside an unlabelled one DOES re-arm, so the corpus drifting again speaks a second time -- (1) fails under the old gate, (2) fails under the `matches.every(...)` variant the decision rejected.
- `src/lib/__tests__/embeddings.test.ts` -- re-attribute the empty-window pin's comment (line 913-917) from the deleted `matches.length > 0` conjunct to `some` on an empty array -- the assertion is unchanged but its stated reason becomes false.

**Acceptance Criteria:**
- Given the drift line has been said under active model M and the window is then carried entirely by vectors the filter kept only because they are UNLABELLED, when any number of reads run and the corpus then drifts fully again under M, then the drift line has still been emitted exactly once and those reads still returned the unlabelled vectors.
- Given the drift line has been said under M and the window then holds one M-tagged vector beside an unlabelled legacy one, when a read runs and the corpus later drifts fully again under M, then the drift line is emitted a second time.
- Given `npx vitest run src/lib/__tests__/embeddings.test.ts`, when run, then every test passes, including all pre-existing DW-310/DW-332/DW-404 pins with their ASSERTIONS unchanged (one task deliberately rewrites the empty-window pin's COMMENT, and no other pre-existing pin is edited at all).
- Given the `drift:` bullet of the `warnedMisconfigurations` doc comment (the canonical gate statement), when it is read after the change, then it states the two-conjunct gate, no longer lists the unlabelled-legacy case as a LIVE gap, still records the topK-slicing and stale-orphan residues WITH their ledger citations (DW-598, open; DW-599, open), and records the cost the proof conjunct itself introduces (an all-unlabelled corpus can never re-arm, so a key burnt before the labels went missing stays burnt).
- Given `pnpm lint` and `npx tsc --noEmit`, when run over the repository, then both are clean and the full test run shows no failures beyond those already present at `baseline_revision` (13 `src/components/workbench/__tests__/*.tsx` files crash in `beforeEach` on an undefined `window.localStorage`; DW-411 can make `pnpm` itself abort — use `npx vitest run` / `npx eslint` as the fallback).

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 0, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 3, low 8)
- addressed_findings:
  - `[low]` `[patch]` The labelled+unlabelled pin asserted its middle read through `.sort()`, discarding score order that every neighbouring pin asserts directly. `page-a` `[1,0,0]` outranks `legacy` `[0.9,0.1,0]` against a `[1,0,0]` query deterministically, so the sort masked a ranking regression for nothing; it now asserts `["page-a", "legacy"]`.
  - `[low]` `[patch]` The warn branch's fall-through comment named only a MIXED window. Since this narrowing a whole-window UNLABELLED read also falls through both branches (`kept.length === matches.length` holds, `some` does not, `kept.length === 0` is false), and "the narrowing" had become ambiguous between two. Both windows and both narrowings are now named; the condition is byte-identical.
  - `[low]` `[patch]` The doc comment reasoned about a NULL active model as a live case. It is unreachable: `embedText` and `getEmbeddingModelName` read the same `cfg` snapshot and both refuse only on a missing provider (`resolveEmbeddingModelName` returns `string`), so a null model returns `[]` at the `if (!queryEmbedding)` guard before the branch chain. Replaced with that fact and an explicit "do not add a null case".
  - `[low]` `[patch]` The rewrite dropped the file's `(DW-nnn, open)` citation convention — the old text cited `(DW-405, open)` and nothing replaced it. The two surviving residues now cite `(DW-598, open)` for topK slicing and `(DW-599, open)` for the stale-orphan wedge.
  - `[low]` `[patch]` Nothing recorded that the state the gate turns on is invisible to the type system: `EmbeddingMeta` declares `model: string` while `queryEmbeddings` returns `Record<string, string>` and legacy vectors carry no `model` key, so on those the comparison is `undefined === string` at runtime. Stated once in the re-arm comment (the interface itself is read-only here).
  - `[low]` `[patch]` "Narrowed twice on 2026-08-22" dated the code by its DECISIONS; both narrowings landed 2026-08-29, so the source and `git log` disagreed. Reworded at all three sites that carried the claim.
  - `[low]` `[patch]` The last mutation row understated its signal: dropping the `some` conjunct fails TWO pins (empty-window and unlabelled-only), not one. Corrected, with a note that a single failure means one of them is not gating.
  - `[low]` `[patch]` Three of four Execution tasks are documentation rewrites and no acceptance criterion could fail if they were skipped. Added a criterion over the canonical `drift:` bullet (closed gap, both residues with citations, the new cost), reworded the vitest criterion from "pins unchanged" to "ASSERTIONS unchanged" (one task deliberately rewrites the empty-window pin's comment), and recorded in Design Notes that the labelled+unlabelled pin is what closes DW-601.

## Design Notes

The decided predicate is a CONJUNCTION, not `matches.every(...)`. The two differ on exactly one window — one active-model-labelled vector beside an unlabelled legacy one — and the decision keeps that window re-arming, because `modelMatches` is permissive by design and a legacy vector riding along with a genuinely rebuilt one is not evidence the rebuild failed. The rejected `every` variant lives on in `spec-dw-404-405-406-embedding-drift-rearm-gate.md` (status `in-review`, never implemented); do not import it. The "DOES re-arm ... beside an unlabelled one" pin is what closes ledger entry DW-601 ("no test discriminates the permissive whole-window gate from the strict-label variant"): it is the one test that fails under `every` and passes under the decided conjunction, so from here the two variants are no longer interchangeable in the suite.

```ts
if (kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)) {
  rearmWarningAbout(`drift:${currentModel}`);
} else if (kept.length === 0 && matches.length > 0) {
  warnOnceAbout(`drift:${currentModel}`, /* ...existing sentence, byte-identical... */);
}
```

`kept.some(...)` rather than `matches.some(...)`: the two are interchangeable only because the first conjunct already forces `kept === matches` elementwise, and reading the proof off `kept` keeps the branch talking about what the filter KEPT, as the warn branch does.

What is bought: a genuinely un-rebuilt corpus can no longer re-arm through a legacy vector. What is paid: a corpus with no labelled vectors at all never re-arms — harmless in the normal case, since such a corpus keeps every match and therefore never burns the key in the first place, but permanent if the key was burnt before the labels disappeared. Say this plainly in the doc comment rather than over-claiming corpus proof; the topK-slicing and stale-orphan residues from DW-404 are untouched and stay recorded.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- expected: all pass, including the two new DW-405 pins and every pre-existing drift pin.
- `pnpm test` -- expected: no new failures vs baseline (fall back to `npx vitest run` if pnpm aborts with `ERROR packages field missing or empty`).
- `pnpm lint` -- expected: clean (fall back to `npx eslint`).
- `npx tsc --noEmit` -- expected: no type errors.
- Mutation checks (run, then revert): loosening the gate back to `matches.length > 0 && kept.length === matches.length` must fail the unlabelled-only pin; replacing it with `matches.length > 0 && matches.every((m) => m.metadata.model === currentModel)` must fail the labelled+unlabelled pin; dropping the `kept.length === matches.length` conjunct must fail the DW-404 mixed-window pin; dropping the `some` conjunct must fail TWO pins, the empty-window pin AND the unlabelled-only pin (a single failure means one of them is not actually gating).


## Auto Run Result

Status: done

**Implemented change.** `searchByVector`'s embedding-drift re-arm gate now requires POSITIVE proof of a vector labelled with the active model: `kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)`, applying the 2026-08-22 human decision for DW-405 (fold into DW-404's conjunction). Because `modelMatches` deliberately keeps unlabelled legacy vectors, a window carried entirely by them was a whole-window match under DW-404's gate and re-armed `drift:<active model>` on a corpus where every LABELLED vector was still stale — letting a genuinely un-rebuilt corpus repeat the drift line that DW-310 guarantees once. The standalone `matches.length > 0` conjunct was dropped as redundant, not as a relaxation: `some` is false on an empty array, so DW-404's non-empty requirement is carried by the new conjunct, and the empty-window pin is what fails if it is removed. A window holding one active-model vector BESIDE an unlabelled one still re-arms, deliberately — that is the difference between the decided conjunction and the `matches.every(...)` variant the decision rejected. `modelMatches`, the warn branch, `relatedByVector` (DW-406) and what the door RETURNS are unchanged.

**Files changed.**
- `src/lib/embeddings.ts` -- the gate itself, plus the two-conjunct statement, its history, its cost and the surviving residues (DW-598, DW-599) recorded canonically in the `warnedMisconfigurations` `drift:` bullet, with `searchByVector`'s JSDoc and the inline re-arm comment pointing at it.
- `src/lib/__tests__/embeddings.test.ts` -- two new pins (an unlabelled-only window does NOT re-arm; a labelled+unlabelled window DOES), and the empty-window pin's comment re-attributed from the deleted conjunct to `some` on an empty array.
- `_bmad-output/implementation-artifacts/spec-dw-405-drift-rearm-labelled-proof.md` -- this spec.

**Review findings.** 8 patched (0 high, 0 medium, 8 low), 1 deferred (low), 11 rejected. 0 intent gaps, 0 spec defects. Rejected on the authority of the invocation intent or as already tracked: that the spec's Problem paragraph repeats the ledger's pre-DW-404 reproduction, which no longer reproduces at `baseline_revision` (the paragraph is inside the read-only `<intent-contract>`, and the live shape — whole-window unlabelled — is stated in the new test's own comment); that `EmbeddingMeta.model` should become optional (the interface is read-only here; the runtime fact is now recorded in the comment); matrix rows for a null active model, topK slicing, the all-unlabelled cost and `relatedByVector` (the matrix is inside the contract and those cases are out of scope, DW-406 explicitly so); a sentence about DW-406's asymmetry in the canonical bullet (a separate open entry); a test for the new residue (the unlabelled-only pin IS that pin — after the probe reads the key stays burnt and step 4 is silent); a shared test-scaffold helper and a rename/trim of the first new pin; `context: []` (the spec body carries the distilled context); that the DW-404 ledger decision line ends "Also answers DW-405" while this bundle's intent asks for the fold (the invocation intent governs); that DW-405 stays `open` in the ledger (this run is forbidden to edit it — the orchestrator records resolution); and that `spec-dw-404-405-406-embedding-drift-rearm-gate.md` is still `in-review` with the rejected `every` predicate (already tracked as ledger entry DW-600).

**Follow-up review recommended: true.** Patched findings by severity: high 0, medium 0, low 8. Score = 3 x 0 + 1 x 8 = 8, which is >= 5.

**Verification performed.**
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- 175/175 pass (173 at baseline, +2 new pins).
- `npx tsc --noEmit` -- clean. `pnpm lint` -- clean (only the pre-existing `jsx-ast-utils` notices; no errors).
- `npx vitest run` (full) -- 7747 pass, 1 skipped, 233 fail across 13 files, identical to `baseline_revision`; every failure is a `src/components/workbench/__tests__/*.tsx` file crashing in `beforeEach` on an undefined `window.localStorage`. No `src/lib` failures.
- Mutation checks, run directly and each reverted (twice: before the review patches and again after): reverting to DW-404's `matches.length > 0 && kept.length === matches.length` fails only the unlabelled-only pin; `matches.length > 0 && matches.every(...)` fails only the labelled+unlabelled pin; dropping `kept.length === matches.length` fails only the DW-404 mixed-window pin; dropping the `some` conjunct fails the empty-window AND unlabelled-only pins.
- Matrix audit: all seven I/O rows are covered by tests that ran and passed -- unlabelled-only and labelled+unlabelled by the two new pins, mixed window and empty window by the DW-404 pins, completed rebuild by the two DW-332 rebuild pins, whole-window-still-stale by the DW-310 drift pins, and query-throws by "does NOT re-arm when the query THROWS".

**Residual risks.** The gate's own residues are unchanged and stay named in the source: topK slicing runs before the filter, so a window too small to SEE the stale vectors still re-arms (DW-598, open), and one stale orphan wedges the key shut for that model for good (DW-599, open). The proof conjunct adds a mirror-image cost, now documented: a corpus whose vectors are ALL unlabelled can never re-arm — unreachable in the normal case, since such a corpus keeps every match and so never burns the key, but permanent if the key was burnt before the labels went missing. One new deferred finding: a concurrency interleave that can un-burn the key across an `await`, pre-existing and independent of the gate's shape.
