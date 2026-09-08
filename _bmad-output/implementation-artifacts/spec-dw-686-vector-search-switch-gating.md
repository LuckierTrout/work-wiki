---
title: 'DW-686 — one switch governs every vector-backed door'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: '9a18b94e4ebbddb05735b9501c187d6fcdca7598'
---

<intent-contract>

## Intent

**Problem:** `getVectorSearchSettings().enabled` is the switch a deployment turns vector search off with, but only three of the seven `searchByVector`/`relatedByVector` callers read it (`lifecycle`'s embed step, `rebuildVectorStore`, `mergeVectorHits`, `findMergeCandidates`). Four readers do not: `findRelatedPages`' prefilter, `findSimilarPages` (the article render path behind the "Related pages" section), `hybridRank` (browse) and `searchIndex` (the query fallback). `searchByVector` does not gate itself, so a deployment that switched vector search off still runs vector work on every article render, every browse query and every `/query` — and DW-406's drift breadcrumb can now tell such a deployment to "rebuild embeddings" for a feature it believes is off.

**Approach:** Human decision (option 1, "gate all four call sites"). Each of the four doors reads `getVectorSearchSettings().enabled` for itself and, when it is off, takes the non-vector path it already has — the same shape `findMergeCandidates` (DW-68) established. No behaviour changes with the switch on.

## Boundaries & Constraints

**Always:**
- The gate is read at the four CALL SITES, not inside `searchByVector`/`relatedByVector`. `mergeVectorHits` needs to tell "off" from "failed" at its own door, and the primitives stay the honest low-level answer.
- With the switch off, each door degrades to the behaviour it already has for an empty/unavailable vector store: `findRelatedPages` classifies against the full candidate list, `findSimilarPages` returns `[]` (so the "Related pages" section is not rendered), `hybridRank` and `searchIndex` rank by BM25 alone.
- With the switch off, no vector primitive is CALLED — not called-and-discarded. The point is that no vector work runs, including the drift breadcrumb `relatedByVector` would emit.
- With the switch on, every door behaves exactly as it does today.
- Where a cheap local test already decides the door (`findRelatedPages`' `candidates.length > RELATED_CANDIDATE_POOL`), the free test stays FIRST — the DW-548 convention already written in `search.ts`.

**Block If:**
- Closing the gap would require a new operator setting, env var, or frozen identifier (AGENTS.md "Frozen identifiers").

**Never:**
- Do not gate inside `searchByVector` or `relatedByVector`, and do not change what they return.
- Do not touch `wiki-retrieve.ts`'s `mergeVectorHits` or `ingest.ts`'s `findMergeCandidates` gating behaviour — both already read the switch; only `ingest.ts`'s now-false PROSE about the ungated readers changes.
- Do not widen the gate to the embed/write side (`upsertEmbedding`, `rebuildVectorStore`) — already gated.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not add a second predicate beside the switch (`hasEmbeddingSupport()` is not the gate — DW-68).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Related pages, switch off | `enabled: false`, article rendered | `findSimilarPages` ⇒ `[]`, `relatedByVector` never called, no "related pages" section in `ArticleView` | none |
| Related pages, switch on | `enabled: true`, anchor has neighbours | unchanged: scored, scope-matched, visibility-filtered list | none |
| Browse query, switch off | `enabled: false`, query with BM25 matches | `searchByVector` never called; results are BM25 order | none |
| Browse query, switch on | `enabled: true`, vector hits present | unchanged: RRF fusion of BM25 + vector | vector throw ⇒ BM25 only (existing) |
| Query fallback, switch off | `enabled: false`, non-empty question | `searchByVector` never called; fusion pool is BM25 only, rerank still runs | none |
| Related-page classify prefilter, switch off | `enabled: false`, candidates > `RELATED_CANDIDATE_POOL` | prefilter skipped; the LLM classifies against the full candidate list | none |
| Prefilter, empty candidate set | `candidates.length <= RELATED_CANDIDATE_POOL` | prefilter skipped without reading the switch (free test first) | none |

</intent-contract>

## Code Map

- `src/lib/config.ts:1655` — `getVectorSearchSettings()`; `enabled` is `cfg.vectorSearchEnabled === true && canEnableVectorSearch(inputs)`, a SYNC cached read (`loadConfigSync`). This is the only value any door needs.
- `src/lib/ingest.ts:1055-1071` — `findMergeCandidates`' gate: the PRECEDENT to copy, including its "THE SWITCH, NOT THE PREDICATE (DW-68)" reasoning. **Its second paragraph (`:1064-1070`) explicitly names `search.ts`'s `findRelatedPages`, `browse.ts`'s `hybridRank` and `query-search.ts`'s `searchIndex` as still ungated — that sentence becomes false with this change and must be rewritten, not deleted:** its point (the claim was deliberately narrow) is worth keeping as "now every reader reads it".
- `src/lib/search.ts:66` — door 1, inside `if (candidates.length > RELATED_CANDIDATE_POOL)`. Note the DW-548 comment at `:47-51` establishing "THE FREE TEST GOES FIRST" for exactly this kind of conjunct.
- `src/lib/search.ts:299` — door 2, first statement inside `withPageCache` in `findSimilarPages`. Gate BEFORE `withPageCache` (`src/lib/wiki.ts:280`, a begin/finally wrapper) so an off deployment pays no cache setup either.
- `src/components/ArticleView.tsx:169` and `:504` — the render path: `findSimilarPages(...)` then `{related.length > 0 && (…)}`. `[]` removes the section; no component change needed. `findSimilarPages` is re-exported through `@/lib/wiki`, which is how the component imports it (`:6`).
- `src/lib/browse.ts:126-136` — door 3, `hybridRank`'s try/catch. `fused` already falls back to `bm25Results` when `vectorResults` is empty.
- `src/lib/query-search.ts:191-199` — door 4, `searchIndex`'s try/catch. Same empty-vector fallback at `:205-211`.
- `src/lib/embeddings.ts:1397` / `:1495` — `searchByVector` / `relatedByVector`. READ-ONLY. The `warnedMisconfigurations` docblock (`:273-286`) claims "a deployment whose only vector traffic is related-page lookups still hears it" — still true for a switched-ON deployment, so it needs no edit.
- `src/lib/__tests__/search.test.ts:15-22` — mocks `../embeddings` with `importOriginal` SPREAD, so the real `config.ts` (which imports `./embeddings` at `:3`) still loads. Use a PARTIAL `../config` mock here.
- `src/lib/__tests__/browse.test.ts:18-24` and `src/lib/__tests__/query-search.test.ts:15-20` — both mock `../embeddings` with a factory exporting ONLY `searchByVector`. **Hazard:** importing `./config` from `browse.ts`/`query-search.ts` would make `config.ts` load against that stub and die on its missing `getEmbeddingResolution`/`hasEmbeddingSupport` imports. Mock `../config` with a FULL factory in these two suites (nothing else in their graphs imports it) so the real `config.ts` never evaluates.
- `src/lib/__tests__/wiki-retrieve.test.ts:9-30` — the established idiom for stubbing `getVectorSearchSettings` (and the exact object shape: `enabled`/`provider`/`baseUrl`/`model`/`hasKey`).
- `src/components/__tests__/owner-scoped-anchors.test.tsx:81-118, 226-233` — the working `ArticleView` mount harness (`next/navigation` + `@clerk/nextjs` mocks, awaiting the async server component then `render`). It stubs `findSimilarPages` itself, so it CANNOT pin this gate; copy its harness into a new suite that leaves `findSimilarPages` real.
- `SCHEMA.md:594-598` — the Query step says vector search runs "When an embedding provider is configured" and points at `src/lib/query.ts`. The CONDITION is wrong after this change: it is the switch, not a configured provider. The POINTER is merely indirect rather than wrong — `src/lib/query.ts:52-58` re-exports `searchIndex` from `./query-search` for backwards compatibility, so the named symbol really is reachable there; `query-search.ts` is where it is defined and is the more useful pointer. `SCHEMA.md` is loaded into ingest prompts at runtime (AGENTS.md) — keep the edit to that clause. (The same provider-configured framing recurs in the "Known gaps" bullet around `SCHEMA.md:732-737` and needs the same correction.)
- `AGENTS.md` — "every feature packet must drive its composition root end-to-end at least once". The render door's composition root is `ArticleView`, which is why the dom suite below is required rather than optional.

## Tasks & Acceptance

**Execution:**

- `src/lib/search.ts` — import `getVectorSearchSettings` from `./config`. At `:66`, add the switch as the SECOND conjunct of the existing `candidates.length > RELATED_CANDIDATE_POOL` test. In `findSimilarPages`, return `[]` before entering `withPageCache` when the switch is off. Comment each in the DW-68 register: the switch, not the predicate, and what the door falls back to.
- `src/lib/browse.ts` — import `getVectorSearchSettings` from `./config`; wrap `hybridRank`'s vector try/catch in the switch so `searchByVector` is not called when off, leaving the existing `vectorResults.length > 0 ? fusion : bm25` fall-through to do the degrading.
- `src/lib/query-search.ts` — same shape for `searchIndex`'s Phase 1b block.
- `src/lib/ingest.ts` — rewrite the `:1064-1070` paragraph: the three readers it names now read the same switch, so the whole set of vector-backed doors answers "do we do vector work?" one way (DW-686). Keep the narrowness of the original claim rather than replacing it with a broad one.
- `SCHEMA.md` — in the Query step, replace the provider-configured condition with the vector-search switch and correct the `searchIndex()` location to `src/lib/query-search.ts`.
- `src/lib/__tests__/search.test.ts` — add a partial `../config` mock (spread `importOriginal`, override `getVectorSearchSettings`) defaulting to `enabled: true` and reset in `beforeEach` so today's assertions are unchanged. Add cases: switch off ⇒ `findSimilarPages` returns `[]` and `relatedByVector` was NOT called (with a stored hit that would otherwise be returned, so the assertion cannot pass vacuously); switch off ⇒ `findRelatedPages` with more than `RELATED_CANDIDATE_POOL` candidates does not call `searchByVector` and still classifies (the LLM prompt carries the full candidate list); switch off with a SHORT candidate list ⇒ still no `searchByVector` call.
- `src/lib/__tests__/browse.test.ts` — add a `../config` factory mock (`getVectorSearchSettings` only), default `enabled: true`, reset per test. Add a case: with the switch off and a query whose vector hit would reorder the results, `searchByVector` is not called and the returned order is the BM25 order — pinned against the same fixture as the existing fusion case so the two orders are actually distinguishable.
- `src/lib/__tests__/query-search.test.ts` — same `../config` factory mock. Add a case: with the switch off, `searchIndex` does not call `searchByVector` and its candidate pool is the BM25 pool, driven by a fixture where a vector-only hit would otherwise enter the pool.
- `src/components/__tests__/related-pages-vector-switch.test.tsx` — new dom suite. Mount `ArticleView` (harness copied from `owner-scoped-anchors.test.tsx`) with `@/lib/wiki` partially mocked (`buildSlugTenantMap`, `findBacklinks` ⇒ `[]`) but `findSimilarPages` LEFT REAL, `@/lib/embeddings` partially mocked so `relatedByVector` answers one sibling hit, and `@/lib/config` partially mocked for the switch. Assert the "related pages" section renders with the switch ON and is absent with it OFF, querying through the render's own `container` (`within(...)`) rather than the global `screen`, since the OFF case asserts an ABSENCE and any tree left in `document.body` by another render would read as a gate failure. This is the composition root for the render door.
  - **`listReadableWikiPages` CANNOT be stubbed through that same `@/lib/wiki` mock, though it looks like it can.** `wiki.ts` re-exports `findSimilarPages` FROM `search.ts`, so `importOriginal("@/lib/wiki")` evaluates `search.ts`, and the `./wiki` binding `search.ts` captures is that ORIGINAL module — not the object the mock factory returns. The stub registers, the component sees it, and `findSimilarPages` does not: the call count stays zero and the door answers `[]` from an empty readable set, which is indistinguishable from the gate under test firing. Seed the anchor and its sibling as REAL pages in a temp `WIKI_DIR` instead (`ensureDirectories` + `writeWikiPage` + `updateIndex`, plus `_resetStorage()`, the way `search.test.ts` does), so the scope-match and visibility filtering downstream of `relatedByVector` run against real entries.

**Acceptance Criteria:**
- Given a deployment with vector search switched off, when any of the four doors runs, then no vector primitive is called and the door returns its documented non-vector result.
- Given a deployment with vector search switched on, when any of the four doors runs, then its behaviour is byte-for-byte what it is today — every existing assertion in the three suites passes unchanged.
- Given the switch is off, when an article is rendered, then the rendered output contains no "related pages" section.
- Given any one of the four gates is reverted, then at least one test fails.

## Spec Change Log

_No bad_spec loopback occurred; this section is empty by design._

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 0
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` Every `getVectorSearchSettings` stub made the predicate legs co-vary with `enabled`, so substituting `.hasKey`/`.provider` for `.enabled` at all four doors kept the whole 9917-test suite green — the doors' own "THE SWITCH, NOT THE PREDICATE" claim was unpinned. All four stubs now hold `provider`/`model`/`hasKey` satisfied in both states so only `enabled` flips; the substitution now fails 3/3/1/2 tests.
  - `[medium]` `[patch]` Gating `searchIndex` silently voided `query.test.ts`'s "hybrid search in searchIndex" block: that suite mocks no `../config` and runs on a fresh temp `DATA_DIR`, so it read the switch as off and never reached the vector call — its fusion assertions AND its `mockRejectedValue` case became vacuous, leaving the "vector failure is non-fatal" contract for `/query` pinned nowhere. Added the switch mock (default on) plus the two `config`-facing stubs its `../embeddings` factory was missing; rethrowing from the catch now fails a test.
  - `[medium]` `[patch]` The new composition-root dom suite asserted absence against the global `screen`, and two reviewers independently saw its OFF case fail on a cold run with the heading still in `document.body`. Both cases now query through the render's own `container`; three repeat runs are green.
  - `[low]` `[patch]` `SCHEMA.md`'s "Known gaps" bullet still conditioned vector work on "an embedding-capable provider … configured" — the same claim corrected 140 lines earlier, and this file is loaded into ingest prompts at runtime. Rewritten to the switch.
  - `[low]` `[patch]` `browse.test.ts`'s justification for a full `../config` factory ("nothing else in `browse.ts`'s graph reads `../config`") was false — `browse.ts` → `query-search.ts` → `llm.ts` imports twelve `config` exports. Converted to a partial mock, matching the other suites.
  - `[low]` `[patch]` The DW-548 conjunct ordering was defended in five lines of comment and in the matrix but pinned by nothing: swapping the operands left all 109 `search.test.ts` tests green, because the short-list case set the switch OFF and so could not tell short-circuit from read-and-false. That case now runs with the switch ON and asserts the settings read never happened.
  - `[low]` `[patch]` Mock hygiene: `search.test.ts` restored `relatedByVector`'s default on a test's last line (a failing assertion above it would leak a sticky hit), and `query-search.test.ts` re-pointed `callLLM`'s implementation without clearing its call history. Defaults moved into `beforeEach`; `mockClear` added.
  - `[low]` `[patch]` Docstrings the change falsified while `ingest.ts`'s equivalent was rewritten: `searchIndex`'s own "if an embedding provider is configured" Phase 1b line (verbatim the sentence corrected in `SCHEMA.md`, 45 lines above the new comment contradicting it), `browse.ts`'s module docblock and `hybridRank`'s docstring, and `findSimilarPages`' return contract. All four corrected.
  - `[low]` `[patch]` Two claims in this spec were wrong and it is the checked-in record: the dom-suite task prescribed stubbing `listReadableWikiPages` through `@/lib/wiki` — an approach the implementation correctly rejected and documented as unworkable — and the Code Map called both halves of the old `SCHEMA.md` pointer wrong when `src/lib/query.ts` does re-export `searchIndex`. Both corrected outside `<intent-contract>`.

## Design Notes

The gate belongs at the doors, not in the primitives, because the callers do not agree on what "off" MEANS to them. `mergeVectorHits` (`src/lib/wiki-retrieve.ts:321`) must distinguish `status: "off"` from `status: "failed"` — a stored-on switch that the predicate refuses is a FAILURE it tells the user about — and it can only do that by reading the switch itself. Sinking the gate into `searchByVector` would hand every caller the same `[]` for both states and delete that distinction.

```ts
// src/lib/search.ts — findSimilarPages
export async function findSimilarPages(slug, principal = null, ...) {
  // THE SWITCH, NOT THE PREDICATE (DW-68, DW-686). Off means the render path
  // does no vector work at all — not "does it and discards it" — so the
  // drift breadcrumb `relatedByVector` writes cannot tell a deployment to
  // rebuild embeddings for a feature it turned off.
  if (!getVectorSearchSettings().enabled) return [];
  return withPageCache(async () => { /* unchanged */ });
}
```

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/search.test.ts src/lib/__tests__/browse.test.ts src/lib/__tests__/query-search.test.ts src/components/__tests__/related-pages-vector-switch.test.tsx` -- expected: all pass, including the four new switch-off cases.
- `pnpm exec tsc --noEmit` -- expected: no type errors.
- `pnpm lint` -- expected: clean.
- `pnpm test` -- expected: full suite green across both projects, no new failures (watch `ingest.test.ts` and `brand-copy.test.ts`, which scan prose).

## Auto Run Result

Status: done

### Summary

`getVectorSearchSettings().enabled` is now read at all four previously ungated vector-backed doors, so one switch governs every vector read in the app. With the switch off no vector primitive is CALLED (not called-and-discarded), and each door falls through to the non-vector path it already had: `findSimilarPages` answers `[]` — which removes the "Related pages" section from a rendered article — `hybridRank` and `searchIndex` rank by BM25 alone, and `findRelatedPages` classifies against the full candidate list. With the switch on, behaviour is unchanged. The gate stays at the call sites rather than inside `searchByVector`/`relatedByVector`, because `mergeVectorHits` must keep telling "off" from "failed" at its own door.

### Files changed

- `src/lib/search.ts` — gate on `findRelatedPages`' prefilter (as the second conjunct, free test first per DW-548) and on `findSimilarPages` (before `withPageCache`); `findSimilarPages`' docstring records the unconditional `[]`.
- `src/lib/browse.ts` — gate on `hybridRank`'s vector leg; module docblock and `hybridRank` docstring corrected.
- `src/lib/query-search.ts` — gate on `searchIndex`'s Phase 1b; the function's own Phase 1b docstring line corrected.
- `src/lib/ingest.ts` — the DW-68 comment that enumerated the three still-ungated readers rewritten to "and now every reader", keeping its deliberate narrowness (call sites, not primitives).
- `SCHEMA.md` — the Query step and the "Known gaps" bullet both moved from the provider-configured framing to the switch; the `searchIndex()` pointer updated to `src/lib/query-search.ts`.
- `src/lib/__tests__/search.test.ts`, `browse.test.ts`, `query-search.test.ts` — switch mocks (predicate legs held satisfied so only `enabled` flips) plus switch-off cases for all four doors, a rerank-survives-the-gate case, and the conjunct-ordering pin.
- `src/lib/__tests__/query.test.ts` — switch mock added so its "hybrid search in searchIndex" block, which this change had silently made vacuous, runs again.
- `src/components/__tests__/related-pages-vector-switch.test.tsx` — new dom suite driving the composition root: `ArticleView` mounted with the real `findSimilarPages` over real seeded pages, asserting the section renders with the switch on and is absent with it off.

### Review findings

- Patches applied: 9 (medium 3, low 6). Items deferred: 0. Items rejected: 10.
- Follow-up review recommendation: **false** — patched severities were medium 3, low 6, high 0; only a patched `high` would recommend another pass.

### Verification

- `pnpm exec vitest run` over the five touched suites — 277 passed.
- `pnpm exec tsc --noEmit` — exit 0. `pnpm lint` — exit 0.
- `pnpm test` — 397 files, 9917 passed, 1 skipped, 0 failed.
- Mutation-checked: removing any one of the four gates fails a test (1/2/1/2); substituting `.hasKey` or `.provider` for `.enabled` fails; swapping the DW-548 conjunct operands fails; rethrowing from `searchIndex`'s vector catch fails.
- The previously flaky dom suite passed three consecutive repeat runs after the container-scoped queries.
- Matrix audit: all seven I/O rows are covered by tests that ran and passed.

### Residual risks

- `searchIndex` sits under `selectPagesForQuery`, so this gate also changes page selection for chat, agent runs, knowledge compilation and source search. That is the intended "one switch" semantics (chat already degraded this way through `mergeVectorHits`), but no test drives those outer surfaces — the shared gate is pinned at `searchIndex` only.
- The gate is `getVectorSearchSettings().enabled`, which is also false for a deployment that never turned the switch ON and for a cold `loadConfigSync` cache (DW-550). Observably this changes nothing: `upsertEmbedding` and `rebuildVectorStore` read the same gate, so a store that was never switched on is empty and every door already degraded. Noted because the tests stub the settings function and so do not exercise the config-read path itself.
- `searchCommons` currently has no production caller (`/api/wiki/browse` is retired under AD-21), so the browse gate is pinned at the library function the intent named rather than at a live route.
