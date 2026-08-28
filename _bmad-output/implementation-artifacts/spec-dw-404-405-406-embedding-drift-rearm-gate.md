---
title: 'Settle the embedding-drift re-arm on one gate, and apply it at both vector doors'
type: 'bugfix'
created: '2026-08-27'
baseline_revision: '40f313b75191792f0ae8e5960232f0eaa5d4d80b'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The drift re-arm gate in `searchByVector` is `kept.length > 0` — a property of the per-query top-K *window*, not of the corpus. A window that dropped vectors still re-arms (DW-404), and because `modelMatches` deliberately keeps unlabelled legacy vectors, a single unlabelled vector re-arms `drift:<active model>` on a corpus whose every labelled vector is stale (DW-405). Separately, `relatedByVector` runs the same model filter but neither warns nor re-arms, so a deployment whose only vector traffic is page-render related lookups observes neither the drift nor its recovery (DW-406).

**Approach:** Two recorded 2026-08-22 decisions prescribe different predicates (`kept.length === matches.length` for DW-404; `kept.some(labelled match)` for DW-405). Reconcile them into the single strictly stronger gate that satisfies both — re-arm only when the read's whole window is present *and* every vector in it is positively LABELLED with the active model — express it as one named module-private predicate, and call that same predicate from both `searchByVector` and `relatedByVector`. Give `relatedByVector` the warn side of the door too, so drift and its recovery are both observable there.

## Boundaries & Constraints

**Always:**
- The re-arm gate is ONE named module-private predicate over a raw query window, used by both doors. It is true only when the window is non-empty AND every match in it carries `metadata.model === currentModel`. A window containing a dropped vector, an unlabelled legacy vector, or nothing at all does not re-arm.
- Both doors keep re-arming and warning on exactly one key, `drift:${currentModel}` — the same shared identity, so the two doors spend and re-arm one throttle between them, never two.
- `relatedByVector` must observe drift on the path that actually happens on a drifted corpus: when the anchor's OWN stored vector is dropped by the model filter it warns before its early return, and when the anchor survives but the filter drops every other candidate it warns there.
- Every warning stays `warnOnceAbout`-throttled, contains the substring `embedding-model drift`, names `active="<model>"`, and ends with the `rebuild embeddings.` remedy. Warn sentences describe the misconfiguration, never a per-query count or slug.
- `searchByVector`'s existing drift sentence stays byte-identical; its warn condition stays "the store returned hits and the filter kept none".
- The re-arm stays on the success path inside each `try`, and keeps using the SAME `currentModel` the filter compared against (DW-313 one-snapshot invariant). Never re-derive the model name for the delete.
- Re-arming and warning must not change what either door RETURNS, or throw.
- Record the narrowed trigger, and what the new gate does and does not establish, in the `warnedMisconfigurations` doc comment plus both doors' JSDoc — replacing the DW-332 text that names `kept.length > 0` and that forbids re-arming from `relatedByVector`.

**Block If:**
- Closing DW-404 or DW-405 would require changing `modelMatches` itself, or making stored vectors' `model` metadata mandatory.

**Never:**
- Do not touch `modelMatches` — unlabelled legacy vectors must keep surviving the filter for RESULTS; the narrowing is on the re-arm gate only.
- Do not change `warnOnceAbout`, `rearmWarningAbout`'s signature, `_resetEmbeddingWarnings`, the DW-401 `ollama-endpoint:sdk-default` re-arm, or the three never-clearing env/binding identities.
- Do not re-arm from `rebuildVectorStore`, `upsertEmbedding`, `removeEmbedding`, or introduce a rebuild-completion epoch or any new persisted state.
- Do not export a new public API, and do not add an info/"drift cleared" log line.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed corpus, `searchByVector` (DW-404) | Drift line already said under M; a partial rebuild leaves the window holding one stale-tagged and one M-tagged vector; reads run; then the corpus fully drifts again | The mixed reads do NOT re-arm, so the drift line is still said exactly ONCE; reads still return the kept vector | No error expected |
| Unlabelled legacy only (DW-405) | Drift line already said under M; an unlabelled (no `model` metadata) vector is added and is the only match the filter keeps; then it is removed and the corpus is fully stale again | The unlabelled-only read does NOT re-arm, so the drift line is still said exactly ONCE; the unlabelled vector is still RETURNED | No error expected |
| Completed rebuild | Drift line said under M; every vector in the window is then labelled M | Re-arms, so a later real drift under M speaks a second time | No error expected |
| Stale anchor, `relatedByVector` (DW-406) | The anchor page's own stored vector is labelled with a model other than the active M | `[]` returned as today, and the drift line is said ONCE from this door | No error expected |
| Recovery seen only at `relatedByVector` | Drift said under M; corpus rebuilt; the only later vector traffic is `relatedByVector` over an all-M window; then drift under M again | The related lookup re-arms, so the second drift is audible | No error expected |
| Related lookup, no active model | No embedding provider configured, so `currentModel` is null; `relatedByVector` still answers from stored vectors | Results unchanged; neither warns nor re-arms (`drift:null` is never spent) | No error expected |
| Query throws at either door | `queryEmbeddings` rejects (dimension mismatch) | `[]` via the existing catch; no warn, no re-arm | Existing `logVectorQueryFailure` path, unchanged |

</intent-contract>

## Code Map

- `src/lib/embeddings.ts:32-104` -- `warnedMisconfigurations` doc comment. Lines 64-72 are the `drift:<active model>` bullet that names `kept.length > 0` as the signal and `searchByVector` as the only door — both statements become false here.
- `src/lib/embeddings.ts:107-129` -- `warnOnceAbout` and `rearmWarningAbout`, the Set's only two mutators. `rearmWarningAbout`'s docblock (112-126) points readers at "the re-arm branch in `searchByVector`" for how strong the evidence is; it must now name the shared predicate and both doors. Signatures unchanged.
- `src/lib/embeddings.ts:783-793` -- `EmbeddingMeta` (`model`, `contentHash`) and `modelMatches`, which returns true when either the active model or `metadata.model` is absent. READ-ONLY: the permissiveness is pinned by "keeps unlabelled (legacy) vectors with no model metadata" (test line 1159) and is the reason DW-405 exists. The new predicate is the strict counterpart that lives beside it.
- `src/lib/embeddings.ts:904-933` -- `searchByVector` JSDoc; 918-932 describe the re-arm signal and the one-snapshot rule for the delete.
- `src/lib/embeddings.ts:934-984` -- `searchByVector`. `cfg` 938, `currentModel` 942, `try` 946, `matches` 947, `kept` 948, the `if (kept.length > 0) { rearm } else if (matches.length > 0) { warn }` chain 964-978, `return kept.map(...)` 979, catch 980-983. The warn branch must gain an explicit `kept.length === 0` test, because re-arm and warn are no longer complementary.
- `src/lib/embeddings.ts:987-1020` -- `relatedByVector`. `getEmbeddingById` 999, `currentModel = getEmbeddingModelName()` 1002 (one read, no embed call — leave the snapshot handling as-is), the stale-anchor early return 1003, `queryEmbeddings(self.vector, topK + 1)` 1010, and the single combined `.filter((m) => m.id !== slug && modelMatches(...))` at 1012 that must be split into "drop self" then "apply the model filter" so the window is inspectable.
- `src/lib/embeddings.ts:1023+` -- `rebuildVectorStore`: upserts page by page with no bulk swap and leaves orphans, which is WHY a live rebuild produces mixed windows. Read-only context; nothing re-arms from here.
- `src/lib/storage/filesystem.ts` `queryEmbeddings` (contract in `src/lib/storage/types.ts`) -- sorts and slices to `topK` BEFORE either door's model filter runs. This is why no per-window predicate can be a corpus proof; say so rather than over-claiming.
- `src/lib/search.ts:294` -- the only production caller of `relatedByVector` (`findSimilarPages`, article render path). Confirms the door must stay cheap and non-throwing.
- `src/lib/__tests__/embeddings.test.ts:78-89` -- `seedVector(slug, vector, model, hash)`; pass an explicit stale model, or call `getStorage().upsertEmbedding(slug, vec, { contentHash })` with no `model` for an unlabelled legacy vector (pattern at line 1161).
- `src/lib/__tests__/embeddings.test.ts:157-179` -- `withWarnSpy`, returning `{ result, warnings }` filtered to the `embeddings` channel. Global `beforeEach` (line 115) already calls `_resetEmbeddingWarnings()`.
- `src/lib/__tests__/embeddings.test.ts:486-556` -- `describe("relatedByVector")`, with `seedAnchorSet` and its own tmpdir/`_resetStorage` lifecycle. The DW-406 tests belong here. Line 537's "returns [] when the anchor's vector is from a different model (stale)" now also emits a warning — extend it rather than leaving the line unasserted.
- `src/lib/__tests__/embeddings.test.ts:705-1173` -- `describe("searchByVector")`, holding the DW-310/DW-332 drift suite. The DW-404/DW-405 pins belong beside "SPEAKS again after the corpus is REBUILT..." (817).
- `src/lib/__tests__/embeddings.test.ts:917-941` -- "re-arms ONLY the read's OWN drift identity, not every drift key". MUST BE AMENDED: its step-2 "healthy" read leaves a stale `page-a` in the window, so under the new gate it no longer re-arms and the test passes vacuously. Re-tag `page-a` instead of adding `page-b` so step 2 still exercises a real re-arm.
- `src/lib/__tests__/embeddings.test.ts:880-916` -- "re-arms ONLY the drift key — other warning FAMILIES keep theirs". Assertions still hold (its window is a single current-tagged vector); its inline comment naming `kept.length > 0` needs the new wording.
- `src/lib/__tests__/search.test.ts:19` -- mocks `relatedByVector`, so widening the door cannot disturb that suite.

## Tasks & Acceptance

**Execution:**
- `src/lib/embeddings.ts` -- add a module-private predicate beside `modelMatches` (e.g. `windowProvesRebuild(matches, model)`) returning true only when `matches.length > 0` and every match carries `metadata.model === model` -- one named place that is BOTH decisions at once: nothing was dropped by the filter (DW-404) and every survivor is positively labelled (DW-405, strengthened from `some` to `every`); a null active model therefore never re-arms.
- `src/lib/embeddings.ts` -- in `searchByVector`, gate the re-arm on that predicate over the raw `matches` window, and make the warn branch test `kept.length === 0 && matches.length > 0` explicitly -- the two branches are no longer complementary, so an implicit `else` would warn on a mixed window that legitimately kept results.
- `src/lib/embeddings.ts` -- in `relatedByVector`, split the combined filter into `others` (self dropped) then `kept` (model filter), re-arm on the same predicate over the raw window, warn once when `others.length > 0 && kept.length === 0`, and warn once before the stale-anchor early return -- on a fully drifted corpus every anchor is stale, so without that first warn the door stays mute in exactly the case DW-406 names.
- `src/lib/embeddings.ts` -- rewrite the `drift:<active model>` bullet in the `warnedMisconfigurations` doc comment, `rearmWarningAbout`'s docblock, and both doors' JSDoc to record the narrowed gate, that BOTH doors now share the one key, and the limit that survives (`queryEmbeddings` slices to topK before the filter, so no window is a corpus proof) -- the current text asserts the opposite on all three points.
- `src/lib/__tests__/embeddings.test.ts` -- add the DW-404 mixed-corpus pin and the DW-405 unlabelled-legacy pin to `describe("searchByVector")`, each shaped as burn-the-key -> a read the OLD gate would have re-armed on -> full drift again -> assert still ONE line, asserting the middle read's results so the cause is pinned as well as the effect.
- `src/lib/__tests__/embeddings.test.ts` -- amend "re-arms ONLY the read's OWN drift identity" so its step-2 window is fully re-tagged under the active model, and update the `kept.length > 0` inline comments that the new gate falsifies.
- `src/lib/__tests__/embeddings.test.ts` -- add DW-406 coverage to `describe("relatedByVector")`: the stale anchor warns (once across repeated renders) while still returning `[]`; a related lookup over an all-current window re-arms a key burnt by `searchByVector`; a mixed window does not; a healthy never-drifted corpus and a null-active-model corpus stay silent.

**Acceptance Criteria:**
- Given the drift line has been said under active model M and the corpus is then only PARTIALLY rebuilt, when any number of reads run over the mixed window and the corpus then fully drifts again under M, then the drift line has still been emitted exactly once.
- Given the drift line has been said under M and the only vector the filter keeps is an unlabelled legacy one, when that read runs, then it still RETURNS the unlabelled vector and the drift line is still emitted exactly once after the corpus goes fully stale again.
- Given a corpus that drifted under M and was then fully rebuilt, when the only vector traffic proving the rebuild is a `relatedByVector` call and the corpus later drifts again under M, then the drift line is emitted a second time.
- Given `pnpm test`, `pnpm lint`, and `npx tsc --noEmit`, when run over the repository, then all pass with no new failures.

## Spec Change Log

## Review Triage Log

## Design Notes

The two 2026-08-22 decisions cannot both be applied verbatim, so one predicate has to satisfy each. `matches.length > 0 && matches.every((m) => m.metadata.model === model)` is exactly that: because `kept ⊆ matches` and `modelMatches` keeps anything labelled with `model`, it is equivalent to "`kept.length === matches.length` (DW-404) AND every kept match is labelled `model` (DW-405, strengthened from `some` to `every`)". Writing it over `matches` keeps it a single readable whole-window property; the docblock should state the equivalence so the narrowing is auditable against both decisions.

```ts
const rearms = windowProvesRebuild(matches, currentModel);
if (rearms) {
  rearmWarningAbout(`drift:${currentModel}`);
} else if (kept.length === 0 && matches.length > 0) {
  warnOnceAbout(`drift:${currentModel}`, /* ...existing sentence... */);
}
```

Be honest about the residue rather than over-claiming: `queryEmbeddings` slices to `topK` before the filter, so a window that never SEES the stale vectors still re-arms. What the narrowing buys is that a window which demonstrably dropped something, or which is carried only by an unlabelled legacy vector, no longer counts as proof. A rebuild-completion epoch would close the rest and is explicitly out of scope.

At `relatedByVector` the anchor is checked before any query, and on a drifted corpus that check fails for every page — so the warn has to sit at that early return, not only in the post-query branch. The key stays `drift:${currentModel}`, shared with `searchByVector`: one drifted deployment is one piece of news however many doors notice it. Keep the two sentences distinct in what they report (the anchor's own vector was dropped, versus every candidate was dropped) while both carry `embedding-model drift` and the `rebuild embeddings.` remedy.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- expected: all pass, including the amended identity test and the new DW-404/405/406 cases.
- `npx vitest run src/lib/__tests__/search.test.ts` -- expected: unaffected (it mocks `relatedByVector`).
- `pnpm test` -- expected: full suite passes with no new failures. (`pnpm` may fail this checkout with `ERROR packages field missing or empty`, a pre-existing workspace-resolution problem; fall back to `npx vitest run`, which runs the identical command.)
- `pnpm lint` -- expected: clean (fall back to `npx eslint` on the same failure).
- `npx tsc --noEmit` -- expected: no type errors.
- Mutation checks (run, then revert): loosening the gate back to `kept.length > 0` must fail the DW-404 and DW-405 pins; relaxing `every` to `some` must fail the DW-405 pin; deleting the `relatedByVector` warn or re-arm must fail the DW-406 cases.
