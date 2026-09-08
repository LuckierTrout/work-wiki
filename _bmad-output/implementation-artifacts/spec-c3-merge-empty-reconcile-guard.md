---
title: 'Merge door: an empty reconcile must not destroy the survivor'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: '7f04fefea46ab83b99b98346a3d425705dc860b8'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A merge fold that returns non-empty text carrying no prose still overwrites the
      survivor's body and then hard-deletes the absorbed page.
    evidence: |-
      The new `emptyFallback: "throw"` guard only fires when the parsed body trims to
      empty. Two shapes slip past it and produce the same destruction this bundle set
      out to stop: `parseDisputedMarker` only matches `(yes|true)`, so a response of
      exactly "DISPUTED: no\n" is returned verbatim as the merged body (verified against
      the regex at src/lib/ingest.ts:1183); and a heading-only fold such as
      "# Agent Harness\n" is likewise non-empty. Either becomes `mergedBody`, is written
      over the survivor, lands in `MergeOperationReceipt.mergedContent` (replayed
      verbatim by Retry), and the absorbed page is hard-deleted with its revisions.
      Pre-existing — not introduced by this change, and outside this bundle's intent,
      which names only the empty-response fallback.
    location: >-
      src/lib/merge.ts:530
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `reconcilePage` (`src/lib/ingest.ts`) falls back to `{ body: newBody, disputed: false }` when the model answers empty. That rule is correct for the ingest door, where `newBody` is the freshly synthesized article. At the merge door it is destructive: `src/lib/merge.ts` calls `reconcilePage(into.body, from.body, …)`, so `newBody` is the **absorbed** page's body. The returned body becomes `mergedBody`, is written over the **survivor**, and the absorbed Page is then hard-deleted — the survivor's prose is gone with no revision to recover from.

**Approach:** Make the empty-response fallback door-specific with an `emptyFallback: "new" | "throw"` option on `reconcilePage`. The ingest door keeps today's exact behaviour (`"new"`, the default); the merge door passes `"throw"`, so an empty fold raises and lands in merge's existing reconcile-failed `catch`, which keeps the lossless appended-bodies default.

## Boundaries & Constraints

**Always:**
- `"new"` must be byte-for-byte today's behaviour, including the default when no option is passed — the ingest door is not being changed.
- The merge door's degrade path is the one that already exists (`catch` → appended bodies), not a new one. The merge itself still succeeds; only the fold is abandoned.
- An "empty fold" under `"throw"` covers a response that leaves no prose: an empty/whitespace model response, **and** a response that is nothing but the `DISPUTED:` / `CONCEPT:` markers that get stripped. Both blank the survivor identically.
- Both doors get test coverage: `src/lib/__tests__/merge.test.ts` and `src/lib/__tests__/ingest.test.ts`.

**Block If:** none.

**Never:**
- Do not change the ingest door's behaviour on an empty or marker-only reconcile response.
- Do not change `RECONCILE_SYSTEM_PROMPT`, `parseDisputedMarker`, `parseConceptMarker`, or the merge receipt/linearization logic.
- Do not add a revision/backup mechanism to `mergePages` — out of scope; the fix is that no data is lost in the first place.
- Do not make the option required; existing callers that pass four arguments must keep compiling and behaving identically.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ingest door, normal fold | `callLLM` returns a merged body | Merged body stored, `disputed` from the marker | No error expected |
| Ingest door, empty response | `callLLM` returns `"   \n  "` | Page keeps the freshly synthesized body (`newBody`); page is not blanked; ingest succeeds | No error expected |
| Merge door, normal fold | `callLLM` returns a folded body | Survivor gets the folded body | No error expected |
| Merge door, empty response | `callLLM` returns `"   \n  "` | `reconcilePage` throws; merge falls into its `catch` and writes `into.body + "\n\n" + from.body`; absorbed page still deleted | Warn-logged as `reconcile failed …; appending bodies` |
| Merge door, marker-only response | `callLLM` returns `"DISPUTED: yes\n"` | Same as above — parsed body is empty, so it is a failed fold, not a blank survivor | Same |
| Merge door, no LLM key | `hasLLMKey()` false | Unchanged: appended bodies, `callLLM` never called | No error expected |

</intent-contract>

## Code Map

- `src/lib/ingest.ts:1198` -- `reconcilePage(existingBody, newBody, owner?, cache?)`. The empty-response fallback is the `if (!out || out.trim() === "")` block right after `callLLM`; the marker strip is `parseDisputedMarker` → `parseConceptMarker` below it. This is the only place to add the option.
- `src/lib/ingest.ts:2205` -- ingest door caller. `existing.body` + `wikiContent` (the fresh synthesis), wrapped in a `try/catch` that already degrades to "use new body" on a throw. Passes no option ⇒ keeps `"new"`.
- `src/lib/merge.ts:517` -- merge door caller, inside `if (!receipt)`. `mergedBody` is initialised to `` `${into.body}\n\n${from.body}` `` at :444 and the surrounding `catch` at :525 only warn-logs, so a throw here leaves that append in place. This is the call that gets `{ emptyFallback: "throw" }`.
- `src/lib/merge.ts` (downstream of the fold) -- `mergedBody` → `MergeOperationReceipt.mergedContent`, written over the survivor and replayed verbatim by any Retry; the absorbed page is hard-deleted after. This is why a wrong `mergedBody` is unrecoverable, and why the guard has to be before the receipt is published.
- `src/lib/__tests__/merge.test.ts` -- mocks `../llm` (`hasLLMKey`, `callLLM`) at the top; `mockedCallLLM.mockResolvedValue(...)` per test. The `appends both bodies (no reconcile) when there's no LLM key` case is the shape to mirror for the new merge-door cases.
- `src/lib/__tests__/ingest.test.ts` -- `describe("ingest — reconcile on merge")` keys its `callLLM` mock on the system prompt (`system.includes("canonical page about one concept")`) so synthesis and reconcile don't cross-contaminate. `degrades to the new body … when reconcile throws` is the neighbouring case.
- `src/lib/__tests__/read-only-door-coverage.test.ts:140` -- READ-ONLY. Lists `reconcilePage` by name only; the signature change does not affect it.

## Tasks & Acceptance

**Execution:**
- `src/lib/ingest.ts` -- add an optional 5th `options?: { emptyFallback?: "new" | "throw" }` parameter to `reconcilePage`, defaulting to `"new"`; under `"throw"`, raise on an empty/whitespace `callLLM` response and on a post-marker-strip body that is empty; document why the two doors differ -- localises the door-specific decision at the one function that makes it.
- `src/lib/merge.ts` -- pass `{ emptyFallback: "throw" }` at the merge-door call and comment why -- the returned body is written over the survivor before the absorbed page is deleted.
- `src/lib/__tests__/merge.test.ts` -- add cases for an empty fold and a marker-only fold, asserting the survivor's prose AND the absorbed page's prose both survive -- covers the I/O matrix's two merge-door failure rows.
- `src/lib/__tests__/ingest.test.ts` -- add a case for an empty reconcile response asserting the page keeps the fresh synthesis and is not blanked -- pins the ingest door's unchanged behaviour so a future refactor can't quietly flip the default.

**Acceptance Criteria:**
- Given a merge whose fold returns nothing usable, when `mergePages` completes, then the survivor's stored body still contains both pages' prose and the absorbed page is deleted exactly as on the no-LLM-key path.
- Given an ingest onto an existing page whose reconcile returns nothing usable, when the ingest completes, then the page holds the freshly synthesized body and `source_count` still counts both sources.
- Given an existing four-argument `reconcilePage` call, when it is type-checked and run, then it compiles unchanged and behaves as it did before this change.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 1, low 0)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[low]` `[patch]` The new prose asserted "no revision to recover from" about the survivor, but `writeWikiPageWithSideEffectsWhileLocked` → `writeWikiPage` snapshots a revision before overwriting (src/lib/wiki.ts:596). Rewrote the `reconcilePage` docstring and the merge-door comment to state the real stakes: the substitution becomes the receipt's `mergedContent`, is replayed verbatim by Retry, and the absorbed page's revisions are hard-deleted.
  - `[low]` `[patch]` The docstring claimed `"new"` means "a reconcile hiccup never blanks the page" and that `"throw"` catches "anything that leaves no prose". Neither is true — a marker-only fold still returns an empty body at the ingest door, and a heading-only fold is non-empty. Narrowed both claims to what the code actually checks.
  - `[low]` `[patch]` Four code/test comments cited `DW-454`, which the ledger records as the email-Worker `attachmentNames` entry (done 2026-08-31), not this defect. Removed the wrong citations rather than mint a new id.
  - `[low]` `[patch]` The two new merge cases were indistinguishable from the pre-existing no-LLM-key path and asserted only `toContain`. Collapsed them into one parametrised case that additionally asserts `mockedCallLLM` was called, pins the exact `into.body + "\n\n" + from.body` append (survivor first), and pins `frontmatter.disputed` so the marker-only path's dropped verdict cannot flip silently. Added a direct `reconcilePage` unit case pinning the `"new"` default and the `"throw"` raise, which no end-to-end test could distinguish.

## Design Notes

The option is named for the *fallback*, not for the caller, so the call site reads as a statement about what an empty fold means there rather than as a mode flag:

```ts
const reconciled = await reconcilePage(
  into.body, from.body, guidanceOwner, guidance,
  { emptyFallback: "throw" },
);
```

The marker-only re-check is deliberately gated on `"throw"`. Under `"new"` a marker-only response returns the empty parsed body today; changing that would be a behaviour change at the ingest door, which this spec forbids.

## Verification

**Commands:**
- `npx tsc --noEmit -p tsconfig.json` -- expected: no output.
- `npx vitest run src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts` -- expected: all pass, including the four new cases.
- Negative control: flip the merge door to `{ emptyFallback: "new" }` and re-run the two new merge cases -- expected: both fail (they pin the defect, not the mock).

## Auto Run Result

Status: done

**Implemented change.** `reconcilePage` now takes an optional `options?: { emptyFallback?: "new" | "throw" }`, defaulting to `"new"`. Under `"throw"` it raises when the model's response is empty/whitespace **and** when the response strips down to an empty body after `parseDisputedMarker` / `parseConceptMarker`. The merge door passes `"throw"`, so an empty fold lands in the pre-existing reconcile-failed `catch` and keeps the lossless `into.body + "\n\n" + from.body` append instead of writing the absorbed page's body over the survivor and then hard-deleting the absorbed page. The ingest door is untouched — it takes the default and behaves byte-identically.

**Files changed.**
- `../../src/lib/ingest.ts` — `emptyFallback` option on `reconcilePage`, plus the docstring explaining why the two doors disagree and exactly what the guard does and does not catch.
- `../../src/lib/merge.ts` — the merge-door call passes `{ emptyFallback: "throw" }`, with the rationale at the call site.
- `../../src/lib/__tests__/merge.test.ts` — one parametrised case over the empty and marker-only folds: asserts the exact append (survivor first), that the LLM path actually ran, that `disputed` is unchanged, and that the absorbed page is still deleted.
- `../../src/lib/__tests__/ingest.test.ts` — an end-to-end case pinning the ingest door's unchanged behaviour, and a direct `reconcilePage` case pinning the `"new"` default and the `"throw"` raise.

**Review findings breakdown.** 4 patches applied (all low), 1 item deferred (medium), 12 rejected, 0 intent gaps, 0 spec repairs. Patched counts by severity: high 0, medium 0, low 4. Follow-up score = 3×0 + 1×4 = 4, below 5 ⇒ `followup_review_recommended: false`.

**Verification.**
- `npx tsc --noEmit -p tsconfig.json` — clean, no output.
- `npx vitest run src/lib/__tests__/merge.test.ts src/lib/__tests__/ingest.test.ts src/lib/__tests__/read-only-door-coverage.test.ts` — 307 passed, 0 failed.
- Negative control (merge door): flipped to `{ emptyFallback: "new" }` — both merge cases failed; restored and re-confirmed.
- Negative control (default): flipped the default to `"throw"` — the direct `reconcilePage` case failed; restored and re-confirmed.
- Matrix audit: all six I/O rows are covered by tests that ran and passed (rows 1/3/6 by pre-existing cases, rows 2/4/5 by the new ones).

**Residual risks.**
- Safety at the merge door is opt-in: a future third caller of `reconcilePage` inherits the destructive `"new"` default silently. The intent chose the option shape, so this was not moved to the write site.
- The guard covers emptiness only. A non-empty fold with no real prose (a bare `DISPUTED: no` line, a heading-only body) still overwrites the survivor — recorded in frontmatter `deferred`.
- The ingest door still returns an empty body on a marker-only fold. Pre-existing and explicitly preserved by the intent ("the ingest door keeps today's correct behavior"); documented in the `reconcilePage` docstring rather than filed, since the intent scopes it out.
- The bundle's `dw_ids: DW-454` does not match the ledger, where DW-454 is the email-Worker `attachmentNames` entry closed 2026-08-31. No ledger entry covers this defect. The ledger was not edited, per the invocation.
