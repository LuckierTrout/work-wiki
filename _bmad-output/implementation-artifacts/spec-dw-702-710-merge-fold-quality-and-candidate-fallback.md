---
title: 'DW-702/DW-710 — merge-path repairs: fold-quality predicate and the merge-candidate fallback'
type: 'bugfix'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The same no-prose fold overwrites an existing page's whole body at the INGEST
      door, where the widened predicate deliberately does not run.
    evidence: |-
      `reconcilePage`'s `"new"` path (the default) still returns the model's text
      verbatim, so a reconcile answering exactly "DISPUTED: no\n" or a bare heading
      becomes `wikiContent` at src/lib/ingest.ts:2408 and replaces the existing
      page's prose with that literal string. This is the identical shape DW-702
      names, minus the hard delete: `spec-c3-merge-empty-reconcile-guard.md` and this
      spec both forbid changing the ingest door, and the new test at
      `src/lib/__tests__/ingest.test.ts` now PINS the verbatim return, so the residue
      is deliberate and enforced rather than merely unnoticed. Less severe than the
      merge door because `writeWikiPage` snapshots a revision first
      (src/lib/wiki.ts:596), so the prose is recoverable; the published page is still
      wrong until someone notices. Deciding whether the ingest door should degrade to
      `newBody` on a no-prose fold is a behaviour change to a door two specs have now
      declared out of scope, so it wants its own decision.
    location: >-
      src/lib/ingest.ts:1351
    severity: low
baseline_revision: '1ed9025d4fe3de69eea3a0124eaa3b868bbb2520'
---

<intent-contract>

## Intent

**Problem:** Two merge-path defects silently produce the wrong page. (DW-702) `reconcilePage`'s `emptyFallback: "throw"` guard fires only when the parsed body trims to EMPTY, so a fold of exactly `"DISPUTED: no\n"` (`parseDisputedMarker` matches only `yes|true`, so the line is returned verbatim as body) or a heading-only `"# Agent Harness\n"` passes as a real fold: it is written over the survivor, lands in `MergeOperationReceipt.mergedContent` where Retry replays it verbatim, and the absorbed page is then hard-deleted with its revisions. (DW-710) `findMergeCandidates` gates on `getVectorSearchSettings().enabled`, which reports `true` on a store with `embeddingProvider: "workers-ai"` + `vectorSearchEnabled: true` running OFF Workers (the `hasWorkersAiBinding: null` hole, DW-225); `resolveEmbeddingProvider` returns `null` there, `searchByVector` answers `[]`, and the function returns that empty list instead of reaching the BM25 branch it took before DW-68 — so every ingest forks a new page instead of merging, silently.

**Approach:** (DW-702) Widen the `"throw"` predicate from "empty after the markers are stripped" to "carries no prose": under `"throw"` only, discard residual marker header lines the parsers did not consume, headings and rules, and throw when nothing else remains — the merge door then takes its existing lossless appended-bodies `catch`. (DW-710) Make the vector branch a preference rather than an exclusive one: when `searchByVector` returns NO hits at all, fall through to the existing BM25 corpus-stats branch instead of returning empty.

## Boundaries & Constraints

**Always:**
- The widened predicate is gated on `emptyFallback: "throw"`. The ingest door (`"new"`, including the no-argument default) stays byte-for-byte as it is today.
- The merge door's degrade path stays the one that already exists (`catch` → `into.body + "\n\n" + from.body`); the merge itself still succeeds and the absorbed page is still deleted.
- The DW-710 fall-through triggers on an EMPTY vector result only (`hits.length === 0`), never on "hits came back but all scored below `CONCEPT_ADJUDICATE_FLOOR`" — a working vector leg that answers "nothing is near" is a real answer and must not be second-guessed.
- DW-68's headline stays pinned: with the switch OFF, `searchByVector` is never called. The existing test at `src/lib/__tests__/ingest.test.ts:2589` must keep passing unchanged.
- Both defects get test coverage: `src/lib/__tests__/merge.test.ts` (survivor prose survives), `src/lib/__tests__/ingest.test.ts` (the `reconcilePage` unit case and a switch-on/empty-vector merge case).

**Block If:** none.

**Never:**
- Do not change `parseDisputedMarker`, `parseConceptMarker`, `RECONCILE_SYSTEM_PROMPT`, or the merge receipt / linearization logic (pinned by `spec-c3-merge-empty-reconcile-guard.md`).
- Do not teach `hasEmbeddingSupport()` about the vector switch, and do not conjoin it into the `findMergeCandidates` gate — `config.ts:1653` and `workbench-settings.ts` both pin that separation.
- Do not change `getVectorSearchSettings`, `vectorSearchMissingLegs`, or the `hasWorkersAiBinding: null` decision (DW-225). The repair is local to `findMergeCandidates`.
- Do not add a revision/backup mechanism to `mergePages`, and do not make the fold-quality check strip prose (blockquotes, lists, tables and paragraphs are all prose).
- Do not change `searchByVector`, the `CONCEPT_ADJUDICATE_FLOOR` value, or `MAX_MERGE_CANDIDATES`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Merge door, `DISPUTED: no` only | fold returns `"DISPUTED: no\n"` | `reconcilePage` throws; survivor keeps `into.body + "\n\n" + from.body`; `disputed` unchanged; absorbed page deleted | Warn-logged `reconcile failed …; appending bodies` |
| Merge door, heading only | fold returns `"# Agent Harness\n"` | Same appended-bodies degrade | Same |
| Merge door, heading + prose | fold returns `"# Agent Harness\n\nThe folded article."` | Normal fold — survivor gets the folded body | No error expected |
| Merge door, `DISPUTED: yes` + prose | fold returns `"DISPUTED: yes\n\n# X\n\nProse."` | Unchanged: `disputed: true`, body is the prose | No error expected |
| Ingest door, same shapes | fold returns `"DISPUTED: no\n"` with no options / `"new"` | Unchanged from today — the string is returned verbatim as the body; no throw | No error expected |
| Vector ON, provider unresolvable | `getVectorSearchSettings().enabled === true`, `searchByVector` → `[]` | Falls through to `listWikiPages` + `buildCorpusStats` + `bm25Score`; merge de-duplication works | No error expected |
| Vector ON, hits all below floor | `searchByVector` → `[{slug, score: 0.2}]` | Returns `[]` (no BM25 fall-through) — the vector leg answered | No error expected |
| Vector OFF (DW-68) | `enabled === false` | `searchByVector` NOT called; BM25 branch, exactly as today | No error expected |

</intent-contract>

## Code Map

- `src/lib/ingest.ts:1237` -- `reconcilePage`. The `"throw"` re-check is the `if (emptyFallback === "throw" && body.trim() === "")` at :1273, after `parseDisputedMarker` (:1266) and `parseConceptMarker` (:1268). This is the only edit site for DW-702; the widened predicate belongs in a small module-local helper beside it. Its docblock (:1215-1236) already states the narrow claim ("A fold that returns non-empty text carrying no actual prose … is NOT caught here") — that sentence must be updated, not left contradicting the code.
- `src/lib/ingest.ts:1197` -- `parseDisputedMarker`, regex `(yes|true)` only. READ-ONLY: a `DISPUTED: no` line is deliberately returned in the body. The new helper must recognise that residual line for the QUALITY check without changing this parser.
- `src/lib/ingest.ts:931` -- `parseConceptMarker`, which strips a LEADING `CONCEPT:` plus optional `ALIASES:`/`TAGS:`. READ-ONLY. Because it only strips when `CONCEPT:` leads, a `DISPUTED: no` first line leaves those headers unstripped too — the quality helper must tolerate all four header spellings.
- `src/lib/ingest.ts:1027` -- `findMergeCandidates`. The vector branch is `if (getVectorSearchSettings().enabled) { const hits = await searchByVector(...); return hits.filter(...).map(...); }` at :1048-1053; the BM25 branch it must fall through to is :1054-1063 (`listWikiPages` → `buildCorpusStats({fullBody:false})` → `bm25Score`). The long DW-68 comment above the gate stays; the fall-through gets its own note. Sole DW-710 edit site.
- `src/lib/embeddings.ts:1141` -- `searchByVector`. READ-ONLY evidence that `[]` is exactly the "the vector leg has nothing to say" signal: it returns `[]` on no query embedding (:1147, the unresolvable-provider case), on a query throw (:1215), and on a model-drift whole-window drop. A populated, healthy store returns topK hits regardless of score, so `hits.length === 0` does not fire on a working leg.
- `src/lib/config.ts:1655` -- `getVectorSearchSettings`. READ-ONLY: its `hasWorkersAiBinding: null` comment block is the DW-225 decision this spec must not disturb.
- `src/lib/merge.ts:517` -- the merge-door caller passing `{ emptyFallback: "throw" }`, with the comment explaining the stakes at :537-545. No code change expected here; only extend the comment if the widened meaning of "empty fold" needs naming.
- `src/lib/__tests__/merge.test.ts:955` -- the parametrised `for (const [label, foldResponse] of [...])` loop (`["comes back empty", "   \n  "]`, `["is nothing but a DISPUTED marker", "DISPUTED: yes\n"]`) asserting the exact append, `frontmatter.disputed === false`, `mockedCallLLM` called, and the absorbed page deleted. Add the two DW-702 shapes as rows here — the assertions already say everything needed.
- `src/lib/__tests__/ingest.test.ts:2777` -- `defaults to the new body on an empty fold, and throws only when asked to`, the direct `reconcilePage` unit case. Extend it: the new shapes must throw under `"throw"` AND be returned verbatim under the default.
- `src/lib/__tests__/ingest.test.ts:60` -- `vectorSearch(enabled)` helper over `mockedGetVectorSearchSettings`; `mockedSearchByVector` is the other lever. `src/lib/__tests__/ingest.test.ts:2567` (`merges via the BM25 fallback when vector search is off`) is the shape to mirror for the DW-710 case, and :2589 (`does NOT retrieve by vector on a STORED KEY with the switch off (DW-68)`) is the pin that must stay green.

## Tasks & Acceptance

**Execution:**
- `src/lib/ingest.ts` -- add a module-local fold-quality helper and use it in place of `body.trim() === ""` in the `emptyFallback === "throw"` re-check; leave the `"new"` path untouched -- localises the widening at the one door that asked for it.
- `src/lib/ingest.ts` -- update `reconcilePage`'s docblock so the `"throw"` clause describes what the predicate now catches -- the current text explicitly promises the opposite.
- `src/lib/ingest.ts` -- in `findMergeCandidates`, fall through to the BM25 branch when the vector branch produced no hits at all, and comment why an empty vector answer is not the same as "nothing is near" -- restores merge de-duplication on a deployment whose switch is on but whose provider never resolves.
- `src/lib/__tests__/merge.test.ts` -- add the `DISPUTED: no` and heading-only fold shapes to the existing parametrised degrade case -- covers the two I/O matrix rows that used to destroy the survivor.
- `src/lib/__tests__/ingest.test.ts` -- extend the direct `reconcilePage` case with the new shapes under both `"throw"` and the default, and add a merge case with the switch ON and `searchByVector` resolving `[]` that still merges through BM25, plus one where a below-floor hit does NOT fall through -- pins both halves of the DW-710 predicate and the unchanged ingest door.

**Acceptance Criteria:**
- Given a merge whose fold returns text carrying no prose, when `mergePages` completes, then the survivor's stored body still contains both pages' prose and the absorbed page is deleted exactly as on the no-LLM-key path.
- Given the same fold text at the ingest door, when `reconcilePage` runs with no options, then it returns that text as the body and does not throw.
- Given vector search switched on and a vector leg that answers nothing, when an ingest looks for merge candidates, then candidates come from the BM25 corpus-stats branch and a duplicate concept merges instead of forking.
- Given vector search switched off, when an ingest looks for merge candidates, then `searchByVector` is not called at all.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[low]` `[patch]` The new DW-710 fall-through test cleared `mockedSearchByVector`'s call history BEFORE the seeding ingest, which itself calls the vector leg — so `toHaveBeenCalled()` was already satisfied before the behaviour under test ran and did not pin "this is not the DW-68 path". Moved the clear after the seeding ingest and tightened the assertion to `toHaveBeenCalledTimes(1)`.
  - `[low]` `[patch]` The widened predicate silently drops a `DISPUTED: yes` verdict that arrives over a bare heading — that fold now throws, so the survivor keeps its own frontmatter verdict and `computeConfidence` never sees the escalation. Intended (it is the rule the marker-only case already followed) but undocumented; added a `THE VERDICT GOES WITH THE BODY` paragraph to `reconcilePage`'s docblock and assertions pinning the shape at both doors.
  - `[low]` `[patch]` `foldCarriesProse`'s docblock disagreed with its code twice: it implied the marker test applied only to leading residue when it runs at any position, and it promised an indented code line counts as prose while `    # step one` was classified as a heading. Corrected the wording for the first and the CODE for the second — a line indented 4+ columns is now prose before any scaffolding test — with five new assertions holding it.
  - `[low]` `[patch]` A reported BOM/whitespace ordering hole in `foldCarriesProse` (`replace(/^\uFEFF/)` running before `trim()`) did NOT reproduce: ECMAScript `trim()` already removes U+FEFF, and restoring the original line under the new tests still passes. Normalized both in one pass anyway so the behaviour does not rest on an unobvious spec detail, and pinned both BOM orderings as no-prose.


## Auto Run Result

Status: done

**Implemented change.** Two merge-path repairs, both local to `src/lib/ingest.ts`. (DW-702) `reconcilePage`'s `emptyFallback: "throw"` re-check now asks a new module-local `foldCarriesProse` helper instead of `body.trim() === ""`, so a fold that survives marker-stripping while carrying no prose — `"DISPUTED: no\n"`, a bare heading, a horizontal rule, stranded `CONCEPT:`/`ALIASES:`/`TAGS:` headers — raises and the merge door takes its existing lossless appended-bodies `catch` rather than overwriting the survivor and hard-deleting the absorbed page. (DW-710) `findMergeCandidates`' vector branch became a preference: zero hits from `searchByVector` fall through to the existing BM25 corpus-stats branch, so a deployment whose switch reads `enabled: true` while no embedding provider resolves merges duplicates again instead of forking every ingest. Hits that came back but scored below `CONCEPT_ADJUDICATE_FLOOR` still return empty — a working vector leg's "nothing is near" is a real answer.

**Files changed.**
- `src/lib/ingest.ts` — added `foldCarriesProse`; widened the `"throw"` predicate; made the vector branch fall through on zero hits; rewrote the `reconcilePage` docblock clause that promised the opposite.
- `src/lib/__tests__/merge.test.ts` — two rows added to the existing parametrised degrade case (`DISPUTED: no`, heading-only), reusing its exact-append / absorbed-page-deleted assertions.
- `src/lib/__tests__/ingest.test.ts` — extended the direct `reconcilePage` case with the no-prose shapes under both `"throw"` and the default, plus false-positive pins (heading+prose, `DISPUTED: yes`+prose, list/table/blockquote/code); added the two DW-710 branch cases.
- `src/lib/merge.ts` — unchanged (zero-line diff); the widening lives entirely behind the option it already passes.

**Review findings.** 4 patches applied (all low, listed in the triage log above); 1 item deferred (the same no-prose overwrite at the ingest door, which two specs now declare out of scope and the new tests pin); 9 rejected. Rejections covered speculative fold shapes the predicate deliberately treats as prose (HTML-only residue, a lone `-`, an empty fenced block), a pre-existing `searchByVector` rejection path this change does not touch, a proposal to fall through on below-floor hits (contrary to this spec's Always clause), the restored BM25 cost on a broken-provider deployment (the pre-DW-68 behaviour, deliberately restored), the untouched deferred-work ledger (orchestrator-owned by invocation), and two descriptive test-fidelity observations from the intent auditor.

**Follow-up review recommendation.** `false` — patched findings by severity: high 0, medium 0, low 4. No high-severity patch, so no further loop.

**Verification.**
- `pnpm vitest run src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts` — 324 passed, 2 files, including the pre-existing DW-68 pin and both original empty-fold rows.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec eslint src/lib/ingest.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts` — clean.
- Matrix audit: every I/O row has a covering test that ran and passed, confirmed by name in a verbose run.
- Negative control: reverting `src/lib/ingest.ts` alone fails exactly the new pins; a mutation deleting the indented-code escape fails the `reconcilePage` case.
- 10 adjacent suites touching `reconcilePage` / `searchByVector` — 486 passed.

**Residual risks.**
- The below-floor case never reaches BM25 by design, so a deployment whose vector leg returns stale-but-scored hits gets no lexical second opinion.
- `foldCarriesProse` re-encodes the `DISPUTED|CONCEPT|ALIASES|TAGS` vocabulary a third time, alongside `parseDisputedMarker` and `parseConceptMarker`; the three can drift independently, and the Never clause forbade consolidating them here.
- The zero-hit fall-through also fires on a healthy provider with an un-backfilled store and on model drift, adding a `listWikiPages` + `buildCorpusStats` pass per ingest there. That is the pre-DW-68 cost, deliberately restored.
- Nothing exercises the `MergeOperationReceipt.mergedContent` / Retry leg directly; it follows from `mergedBody` staying the append, which the merge tests pin byte-for-byte.

## Design Notes

The fold-quality helper answers "did this fold leave any prose?", not "is this valid Markdown". It drops, line by line: blank lines; residual `DISPUTED:` / `CONCEPT:` / `ALIASES:` / `TAGS:` header lines the parsers did not consume; ATX headings; and horizontal-rule / setext-underline lines. Anything else — a sentence, a list item, a table row, a quote — is prose and the fold stands. Biasing toward "throw" is safe at this door and only there: the degrade is the lossless append, so a false positive costs an unfolded survivor while a false negative costs the survivor's prose.

DW-710 is repaired by the first of the three candidate fixes the ledger names (fall through on empty results), sharpened to `hits.length === 0` rather than "no hits above the floor". The other two are ruled out by this spec's **Never** list: conjoining `hasEmbeddingSupport()` re-entangles the predicate DW-68 deliberately separated from the switch, and closing the binding hole reopens the DW-225 decision. The sharpened form also makes the function's existing docblock promise true — it already claims BM25 serves "before the vector store is backfilled", which an empty store now actually gets.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts` -- expected: all pass, including the pre-existing DW-68 and empty-fold cases.
- `pnpm exec tsc --noEmit` -- expected: no new errors.
- `pnpm exec eslint src/lib/ingest.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts` -- expected: clean.
