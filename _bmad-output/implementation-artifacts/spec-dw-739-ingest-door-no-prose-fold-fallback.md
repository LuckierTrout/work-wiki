---
title: 'DW-739: degrade to newBody on a no-prose fold at the ingest door'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: '4508f674463024ce40179e2067f3e2f2f1d088d0'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `reconcilePage` (`src/lib/ingest.ts`) only applies the widened `foldCarriesProse` refusal under `emptyFallback: "throw"` (the merge door). At the ingest door (`"new"`, the default) a fold that survives the parsers but carries no prose — `"DISPUTED: no\n"`, a bare heading, a stranded marker block — is returned verbatim, becomes `wikiContent`, and replaces the existing page's whole body with that literal string.

**Approach:** Run the `foldCarriesProse` check for BOTH fallbacks. Under `"throw"` it keeps throwing; under `"new"` it now falls back to `newBody` — the fresh synthesis — exactly as the empty/whitespace path one branch above already does. Invert the test that pins the verbatim return so it asserts the fallback instead.

## Boundaries & Constraints

**Always:**
- The no-prose fallback under `"new"` must be byte-identical to the existing empty-response fallback: `return { body: newBody, disputed: false }`. THE VERDICT GOES WITH THE BODY — a fold that produced no prose produces no verdict, so a `DISPUTED: yes` over a bare heading no longer escalates.
- `foldCarriesProse` keeps its current predicate and its safety bias. Both doors now share one rule; only the degrade differs (throw vs. fall back).
- `"throw"` behaviour stays byte-for-byte as it is today, including the message text.
- A fold that DOES carry prose is unaffected at both doors: body and parsed `disputed` are returned as before.

**Block If:**
- `foldCarriesProse` would have to be loosened or tightened to make the ingest door behave — the predicate is shared and pinned by the merge door's tests.

**Never:**
- Do not change `parseDisputedMarker`, `parseConceptMarker`, `RECONCILE_SYSTEM_PROMPT`, `foldCarriesProse`'s predicate, or anything in `src/lib/merge.ts`.
- Do not change the ingest door's `try/catch` degrade at `src/lib/ingest.ts:2541` or the "only escalate, never clear" `disputed` rule at its call site.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md` — the orchestrator records resolution.
- Do not retro-edit `spec-c3-merge-empty-reconcile-guard.md` or `spec-dw-702-710-merge-fold-quality-and-candidate-fallback.md`; their out-of-scope clauses are superseded by this spec, recorded here in Design Notes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ingest door, real fold | fold returns `"# X\n\nProse."`, no options | `{ body: "# X\n\nProse.", disputed: false }` — unchanged | No error expected |
| Ingest door, verdict over prose | fold returns `"DISPUTED: yes\n\n# X\n\nProse."`, no options | `{ body: "# X\n\nProse.", disputed: true }` — unchanged | No error expected |
| Ingest door, empty response | fold returns `"   \n  "`, no options | `{ body: newBody, disputed: false }` — unchanged | No error expected |
| Ingest door, no-prose fold | fold returns `"DISPUTED: no\n"` / `"# X\n"` / stranded marker block / BOM-prefixed marker, no options or `"new"` | `{ body: newBody, disputed: false }` — the CHANGE: fallback, not the literal | No error expected |
| Ingest door, verdict over a bare heading | fold returns `"DISPUTED: yes\n\n# X\n"`, no options | `{ body: newBody, disputed: false }` — the verdict is discarded with the body | No error expected |
| Ingest door, end to end | existing page has prose; second ingest's fold returns `"DISPUTED: no\n"` | Page body is the fresh synthesis; the literal never reaches `wikiContent`; `disputed` stays whatever the page preserved | No error expected |
| Merge door, no-prose fold | same shapes with `emptyFallback: "throw"` | Throws `/empty body/` — unchanged | Caller's reconcile-failed append |

</intent-contract>

## Code Map

- `src/lib/ingest.ts:1287` -- `foldCarriesProse`. Predicate is correct as-is; only its GATING changes. Its docstring's last paragraph ("used ONLY under `emptyFallback: \"throw\"`") becomes false and must be rewritten to name both degrades and both biases.
- `src/lib/ingest.ts:1308-1352` -- `reconcilePage` docstring. Two claims go stale: the `"new"` bullet's parenthetical ("A response that survives that check but strips down to nothing still returns an empty body at this door") and the paragraph ending "Under `\"new\"` the predicate is still the narrow `trim() === \"\"` … because `newBody` there is the fresh synthesis and changing that door is out of scope."
- `src/lib/ingest.ts:1388-1393` -- the empty/whitespace branch. `return { body: newBody, disputed: false }` is the exact shape the new no-prose fallback must mirror.
- `src/lib/ingest.ts:1397-1404` -- THE EDIT SITE. The `emptyFallback === "throw" && !foldCarriesProse(body)` guard plus the two comment lines above it and the final `return { body, disputed }`.
- `src/lib/ingest.ts:2541` -- the ingest door caller. `reconcilePage(existing.body, wikiContent, …)`, so `newBody` is the fresh synthesis; result assigned to `wikiContent`, and `if (reconciled.disputed) frontmatter.disputed = true` only escalates. Read-only: no change needed — the fallback lands here as a normal resolve.
- `src/lib/merge.ts:560` -- the merge door caller, passes `emptyFallback: "throw"`. Read-only: untouched by this change.
- `src/lib/__tests__/ingest.test.ts:2902-2924` -- THE PIN TO INVERT. The `for (const noProse of [...])` loop's second assertion ("The ingest door is untouched: no throw, no fallback, the text as-is") resolves to `{ body: noProse, disputed: false }`.
- `src/lib/__tests__/ingest.test.ts:2968-2983` -- a SECOND pin on the same rule: `"DISPUTED: yes\n\n# X\n"` asserted to resolve `{ body: "# X\n", disputed: true }` at the ingest door ("its predicate is untouched"). Must invert too.
- `src/lib/__tests__/ingest.test.ts:2871-2892` -- the empty-response and marker-only `"DISPUTED: yes\n"` assertions. The `"new"`/default empty cases stay; the marker-only case currently only exercises `"throw"`.
- `src/lib/__tests__/ingest.test.ts:2844` -- `"keeps the freshly synthesized body when reconcile answers empty"`, the end-to-end template for the new end-to-end case (`wire`/`mockedCallLLM.mockImplementation` discriminating on `system.includes("canonical page about one concept")`).
- `src/lib/__tests__/merge.test.ts` -- read-only evidence: merge-door behaviour must not move.

## Tasks & Acceptance

**Execution:**
- `src/lib/ingest.ts` -- move the `!foldCarriesProse(body)` check out of the `"throw"`-only guard: when it fires, throw under `"throw"` and `return { body: newBody, disputed: false }` under `"new"`. Rewrite the stale docstring claims in `reconcilePage` and the closing paragraph of `foldCarriesProse` so both name the shared predicate and the two different degrades -- one rule, two doors; the ingest door's degrade is the fresh synthesis rather than the fold's nothing.
- `src/lib/__tests__/ingest.test.ts` -- invert both ingest-door pins (the `noProse` loop and the `"DISPUTED: yes\n\n# X\n"` verdict-over-heading case) to assert the `newBody` fallback with `disputed: false`; extend the marker-only `"DISPUTED: yes\n"` case with a default-door assertion; add an end-to-end `ingest` case where the reconcile answers `"DISPUTED: no\n"` and the stored page keeps the fresh synthesis. Covers every row of the I/O matrix.

**Acceptance Criteria:**
- Given a fold response carrying no prose, when `reconcilePage` runs with no options or `emptyFallback: "new"`, then it resolves `{ body: newBody, disputed: false }` and does not throw.
- Given a fold response of `"DISPUTED: yes"` over a bare heading, when `reconcilePage` runs at the ingest door, then the returned `disputed` is `false` — the verdict is discarded with the body it described.
- Given an existing wiki page with prose, when a second ingest's reconcile answers `"DISPUTED: no\n"`, then the stored page body is the freshly synthesized article and never the literal `"DISPUTED: no"`.
- Given any fold response, when `reconcilePage` runs with `emptyFallback: "throw"`, then its outcome is unchanged from before this change.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 0
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[low]` `[patch]` The direct-`reconcilePage` test made every POSITIVE assertion (real fold, verdict over prose) only under `"throw"`, so a regression making `"new"` always fall back, or dropping `disputed: true` on a prose-bearing fold, would slip past the door the change actually touches. Added default-door assertions for both.
  - `[low]` `[patch]` The verdict consequence had no end-to-end coverage — both e2e cases used `DISPUTED: no`, whose verdict path never changed. Added an e2e case whose fold answers `"DISPUTED: yes\n\n# X\n"`: the page keeps the fresh synthesis and `disputed` stays `false`. The two ingests were given distinct source URLs so `confidence` lands at 0.65, above the 0.5 dispute cap and therefore actually discriminating.
  - `[low]` `[patch]` The comment above the direct-call tests still said "The two end-to-end cases above"; the new case made it three. Dropped the brittle count rather than re-incrementing it.
  - `[low]` `[patch]` The new ingest-door degrade resolved silently, so the caller could not tell a real fold from a discarded one — unlike the adjacent call-site degrade, which logs. Added one `logger.warn` on that branch only; the `"throw"` path and the empty/whitespace branch are untouched and the returned value is unchanged.
  - `[low]` `[patch]` The rewritten `reconcilePage` docblock paragraph was left unreflowed. Reflowed to the block's uniform wrapping.

Rejected (5, all low): the proposal to degrade to the no-provider branch's lossless `prior + "---" + next` join instead of `newBody` (foreclosed by the human decision, which names `newBody`); a guard preserving the fold's `DISPUTED: yes` via the existing page's frontmatter (contradicts the Always clause — the verdict goes with the body); a guard against `newBody` itself being scaffolding-only (the `"new"` fallback's shape is pinned byte-identical to the empty-response path, and the risk is unchanged in kind by this diff); a test that a preserved `disputed: true` survives the fallback (exercises the caller's untouched escalate-only rule); and the descriptive observations that the intent's line anchors are stale, that the two superseded specs still carry now-false statements, and that the ledger entry is still open (the Never clause forbids retro-editing those specs; the ledger is orchestrator-owned).

## Design Notes

The change is a single control-flow move — the predicate already exists and is already tested; only its gate changes:

```ts
// One rule, two degrades: a fold that carries no prose is the same empty fold
// as an empty response (DW-702, DW-739).
if (!foldCarriesProse(body)) {
  if (emptyFallback === "throw") {
    throw new Error("reconcile returned an empty body (the fold carried no prose)");
  }
  return { body: newBody, disputed: false };
}
return { body, disputed };
```

**Superseded scope clauses.** `spec-c3-merge-empty-reconcile-guard.md` ("Do not change the ingest door's behaviour on an empty or marker-only reconcile response") and `spec-dw-702-710-merge-fold-quality-and-candidate-fallback.md` ("The ingest door … stays byte-for-byte as it is today") both deliberately fenced this door off, and the tests they added PIN the verbatim return. DW-739 is the human decision that lifts both fences for this one rule; the tests those specs added are inverted here rather than deleted, so the door stays pinned — to the new answer.

**Why the ingest door's bias is also safe.** `newBody` here is the fresh synthesis, so falling back degrades to the pre-reconcile overwrite: the page keeps a real article. A false "no prose" costs an unfolded page (the old body's prose is still in its revision history via `writeWikiPage`); a false "prose" was the bug — the page published the literal.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/ingest.test.ts` -- expected: all pass, including the inverted pins and the new end-to-end case.
- `npx vitest run src/lib/__tests__/merge.test.ts` -- expected: all pass unchanged (merge door untouched).
- `npx tsc --noEmit` -- expected: no new errors.

## Auto Run Result

Status: done

**Implemented change.** `reconcilePage` (`src/lib/ingest.ts`) now runs the `foldCarriesProse` check for BOTH doors instead of only under `emptyFallback: "throw"`. One rule, two degrades: the merge door still throws into its lossless append; the ingest door (`"new"`, the default) now returns `{ body: newBody, disputed: false }` — the fresh synthesis — exactly as the empty/whitespace branch above it does, and logs a warn saying it did. A fold that survives both parsers but carries no prose (`"DISPUTED: no\n"`, a bare heading, a stranded marker block) is no longer published verbatim over the existing page's whole body, and a `DISPUTED: yes` over such a fold no longer escalates the page's `disputed` flag — the verdict goes with the body. `foldCarriesProse`'s predicate, `parseDisputedMarker`, `parseConceptMarker`, `RECONCILE_SYSTEM_PROMPT`, `src/lib/merge.ts`, and the ingest caller's try/catch and escalate-only rule are all untouched.

**Files changed.**
- `../../src/lib/ingest.ts` — the guard ungated to both doors with the `"new"` fallback and its warn; `foldCarriesProse` and `reconcilePage` docstrings rewritten to state the shared predicate, the two degrades, and each door's safety bias.
- `../../src/lib/__tests__/ingest.test.ts` — the two ingest-door pins inverted from the verbatim return to the `newBody` fallback, default-door assertions added for the marker-only case and for folds that DO carry prose, and two end-to-end `ingest` cases added (a no-prose fold keeps the fresh synthesis; a verdict over a bare heading does not escalate `disputed`).

**Review findings.** 5 patches applied (all low, listed in the triage log above); 0 items deferred; 5 rejected.

**Follow-up review recommendation:** false. Patched findings by severity — high 0, medium 0, low 5. No patched finding was high severity, so no further review pass is recommended.

**Verification.**
- `npx vitest run src/lib/__tests__/ingest.test.ts src/lib/__tests__/merge.test.ts` — 332 passed (277 ingest, 55 merge), 0 failed.
- `npx tsc --noEmit` — exit 0, no output.
- Two-directional mutation check confirmed the assertions are load-bearing: restoring the pre-DW-739 `"throw"`-only guard failed 3 tests (both new e2e cases plus the direct-call test), and making the default door ALWAYS fall back to `newBody` failed 3 different tests (the two pre-existing e2e fold cases plus the direct-call test). Working tree restored green after both.
- Matrix test audit: all seven I/O rows are covered by tests that ran and passed — rows 1 and 2 by the pre-existing e2e fold and dispute cases plus the new default-door direct assertions, row 3 by the empty-response assertions, rows 4 and 5 by the inverted pins, row 6 by the new no-prose e2e case, row 7 by the unchanged `"throw"` assertions.

**Residual risks.**
- The existing page's prose is still replaced wholesale on a no-prose fold — by the fresh synthesis rather than the literal. That is the chosen option working as specified; `writeWikiPage` snapshots a revision first, so the prior body remains recoverable.
- `spec-c3-merge-empty-reconcile-guard.md` and `spec-dw-702-710-merge-fold-quality-and-candidate-fallback.md` still carry out-of-scope clauses and an acceptance criterion that this change makes false. Superseding them is what DW-739 decided; the Never clause forbids retro-editing them, so the record lives in this spec's Design Notes and in the `ingest.ts` docstrings.
- The pre-existing e2e dispute test scores `confidence` at exactly 0.5 whether or not the dispute cap fires, so it cannot discriminate the cap. The new e2e case avoids that blind spot with distinct source URLs; the older test was left alone as out of scope.
