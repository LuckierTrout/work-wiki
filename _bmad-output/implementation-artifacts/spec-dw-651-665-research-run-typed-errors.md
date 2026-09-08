---
title: 'Research run: typed refusals and owner-legible condensation failures (DW-651, DW-665)'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      The three sibling research doors still answer 500 for the contended-store
      fault this bundle made a 503 at the run door.
    evidence: |-
      `applyResearchProjectMutation` is the shared mutation primitive, and its
      exhausted-CAS refusal is now `ResearchProjectBusyError`
      (`src/lib/research-projects.ts`). `POST /api/research`
      (`src/app/api/research/route.ts:156`), `PATCH` and
      `DELETE /api/research/[id]` (`src/app/api/research/[id]/route.ts:99`,
      `:132`) all still classify with `error instanceof ClientInputError ? 400 :
      500`, so the identical transient contention — whose own sentence says
      "retry the request." — is a retryable 503 at one door and a permanent
      server fault at three. DW-651 names only `POST /api/research/[id]/run`, so
      the siblings were out of this bundle's scope; the split is now recorded in
      `ResearchProjectBusyError`'s docblock but nothing pins it as intended.
    location: >-
      src/app/api/research/route.ts:156
    severity: low
baseline_revision: '04b024b3f6e07d4860338002f76208b1f945f2c5'
---

<intent-contract>

## Intent

**Problem:** Two owner-visible faults on the research run path still speak in the
wrong voice. (DW-651) Four refusals in `queueResearchProject` and
`applyResearchProjectMutation`'s CAS exhaustion are plain `Error`, so
`POST /api/research/[id]/run` answers 500 for all of them — a retired project
that the GET on the same path answers 404 for, and transient store contention
reported as a permanent server fault with no retry signal. (DW-665) The evidence
condensation and hierarchical reduction `callLLM` calls are unwrapped, so a
fired LLM deadline reaches `runResearchProject`'s catch as the SDK's own "The
operation was aborted due to timeout", is stored as `project.error`, and is
rendered verbatim in the research panel.

**Approach:** Type the four refusals — reusing `ResearchProjectNotFoundError`
for the retired row, widening `ResearchProjectConflictError` to the
delivery-in-progress refusals, and adding `ResearchProjectBusyError` for
contention — and give the door `instanceof` branches for 404/409/503. Wrap both
research `callLLM` sites in the same deadline-to-sentence helper the synthesis
fallback already applies inline, extracted so all three share it.

## Boundaries & Constraints

**Always:**
- Error messages stay VERBATIM. `research-runtime.test.ts` and
  `research-completion.test.ts` assert several by regex (`/retired/i`,
  `/already running/i`), the response body still echoes the message, and
  `POST /api/tasks/run` still poisons a task by `/not found/i` over
  `runResearchProject`'s message. Only the CLASS changes at these sites.
- New classes follow the file's existing idiom (`ClientInputError`,
  `ResearchLeaseError`, the two DW-480 classes): plain `extends Error`,
  `this.name` set to the class name, exported from `src/lib/research-projects.ts`.
- The POST catch keeps returning `availableProviders` alongside `error` on every
  status, and keeps the read-only 403 branch FIRST (DW-657).
- Every status stays decided by TYPE alone. No regex over a message returns.
- The owner-visible condensation/reduction sentence is a CONSTANT from
  `src/lib/llm-deadline.ts`, never `error.message`, and is picked by the
  existing `streamCutShortMessage()` gate — `LLM_DEADLINE_RESEARCH_COPY` when a
  deadline is configured, `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` when not.
- Docblocks that RECORD the old exclusions must be corrected in the same pass:
  `ResearchProjectConflictError`'s "DELIBERATELY NARROW" list and
  `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`'s "TWO USES" both become false here.

**Block If:** Two faults that need different statuses turn out to share one of
the three types at this door, so preserving each fault's intended status and
classifying by type conflict.

**Never:**
- Do not remap `ResearchLeaseError` ("The previous research lease could not be
  retired…", "Research attempt for <id> was replaced.") — not named by either
  ledger entry, and it stays 500.
- Do not widen the DW-665 wrap beyond a deadline abort. A provider 500 or an
  empty-response error keeps its own message, exactly as the synthesis
  fallback's `isLlmDeadlineAbort` branch already decides.
- Do not change `callLLM` / `callLLMStream` signatures, `retryWithBackoff`, or
  the frozen single-deadline mechanism in `src/lib/llm.ts`.
- Do not add a `Retry-After` header, remap the GET, touch the 202-and-poll
  contract, or alter the read-only gate ordering.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Run a retired project | `queueResearchProject` throws `ResearchProjectNotFoundError("Research project is retired")` | 404, `{ error: "Research project is retired", availableProviders }` | Matches the GET's 404 for the same row |
| Run while a completion is being delivered | `ResearchProjectConflictError("Research project completion is still being delivered")` (both sites) | 409 | Existing state refuses the transition |
| Run while already running | `ResearchProjectConflictError("Research project is already running")` | 409 (unchanged) | Existing branch |
| Delivery-retry CAS lost | `ResearchProjectBusyError("Research project changed while delivery retry started")` | 503 | Transient contention |
| Rerun-baseline CAS lost | `ResearchProjectBusyError("Research project changed while the rerun baseline was captured; retry")` | 503 | Transient contention |
| Store CAS exhausted | `applyResearchProjectMutation` throws `ResearchProjectBusyError("Research projects were busy; retry the request.")` | 503 | Transient contention |
| Lease could not be retired | `ResearchLeaseError` | 500 (unchanged) | Out of scope, deliberately |
| Storage fault saying "not found"/"busy" | plain `new Error(...)` | 500 (unchanged) | Type-only classification |
| Deadline fires during condensation | `callLLM` for `"Extract only evidence…"` rejects `TimeoutError`, timeout configured | Run `failed`; `project.error` is `LLM_DEADLINE_RESEARCH_COPY`; no page written | Thrown as the constant |
| Deadline fires during reduction, no timeout set | `callLLM` for `"Reduce these evidence notes…"` rejects `TimeoutError`, `getLlmTimeoutMs()` null | Run `failed`; `project.error` is `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` | Ungated, mirroring the fallback |
| Non-deadline condensation failure | `callLLM` rejects `new Error("provider 500")` | Run `failed`; `project.error` is `"provider 500"` (unchanged) | Rethrown untouched |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` -- the class home. `ResearchProjectNotFoundError`
  at :27 (docblock needs the retired row added), `ResearchProjectConflictError`
  at :47 (its "DELIBERATELY NARROW" list at :36-45 names exactly the refusals
  this bundle is now typing — rewrite it). `applyResearchProjectMutation`'s
  `lastError` is built at :459 and thrown at :477 after `CAS_ATTEMPTS` (8)
  failed compare-and-swaps.
- `src/lib/research-runtime.ts` -- the throw sites, all plain `new Error(...)`:
  - :410 `"Research project is retired"` (`queueResearchProject`, `deleteRequested`) → not-found
  - :413 `"Research project completion is still being delivered"` (pre-mutation) → conflict
  - :431 `"Research project changed while delivery retry started"` → busy
  - :478 `"Research project completion is still being delivered"` (inside the `mutateResearchProjectOrRefusal` mutator) → conflict
  - :481 `"Research project changed while the rerun baseline was captured; retry"` → busy
  Mutator throws propagate out through `mutateResearchProject` → `lockedMutation`
  → `applyResearchProjectMutation` unswallowed (established by DW-480).
- `src/lib/research-runtime.ts:1281-1285` -- `streamCutShortMessage()`, the
  deadline-gated sentence picker; place the new shared `callLLM` wrapper beside it.
- `src/lib/research-runtime.ts:1456-1487` -- `synthesizeResearchBrief`'s catch;
  :1471 is the fallback `callLLM` and :1472-1486 the inline
  `isLlmDeadlineAbort` → `streamCutShortMessage()` conversion to EXTRACT (its
  "UNGATED, mirroring the loop branch above" rationale moves to the helper).
- `src/lib/research-runtime.ts:1539` and `:1601` -- the two unwrapped `callLLM`
  calls inside `researchEvidenceForSynthesis` (condensation, then hierarchical
  reduction), both `{ maxOutputTokens: 1_500 }`. DW-665's subjects.
- `src/lib/research-runtime.ts:2005` -- `runResearchProject`'s catch:
  `const message = error instanceof Error ? error.message : String(error)`,
  written to `project.error`.
- `src/components/workbench/ResearchCanvas.tsx:408` -- `{project.error}` rendered
  verbatim in the panel. Read-only for this bundle; it is why the sentence matters.
- `src/app/api/research/[id]/run/route.ts:117-127` -- the POST catch's
  `instanceof` ladder to extend with the 503 branch (the read-only 403 at :96
  stays ahead of it). GET at :133-160 is unchanged.
- `src/lib/llm-deadline.ts:120-142` -- `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`,
  reused as-is; its "TWO USES" docblock gains the third (a non-streamed research
  `callLLM` whose deadline fired). `:99` `LLM_DEADLINE_RESEARCH_COPY` is the
  gated sibling. No new constant is needed — both sentences are already true of
  a run cut during condensation (nothing is written before synthesis commits).
- `src/lib/llm.ts:513-537` -- `callLLM`; `retryWithBackoff` rethrows the original
  rejection unwrapped, which is how the SDK sentence escapes today. Read-only.
- `src/lib/__tests__/research-run-route.test.ts` -- door suite. `:26-33` already
  uses the `importOriginal` spread mock, so new class imports resolve. `:182`
  is the 404/409 test to extend; `:216-229` the "500s a storage fault whose
  message says X" table.
- `src/lib/__tests__/research-runtime.test.ts` -- runtime suite. `:433` is the
  condensation-path recipe to copy (a `600_000`-char source forces the map/reduce
  branch); `:141` `mockedLLM`, `:143` `mockedTimeout`, `:198` `abortError`,
  `:204` `project()`, `:144` `mockedWritePage`. `:1594` asserts `/retired/i` on
  `queueResearchProject` — keep the message assertion, add the type.
  `:2756` is the sentence suite.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- add exported `ResearchProjectBusyError`
  (same idiom, required `message`), widen `ResearchProjectNotFoundError`'s and
  `ResearchProjectConflictError`'s docblocks to state what each now covers and
  that `ResearchLeaseError` alone stays untyped, and throw
  `ResearchProjectBusyError` for the CAS exhaustion -- gives the door a third
  thing to classify by type.
- `src/lib/research-runtime.ts` -- retype the five throw sites per the Code Map
  with messages unchanged; extract the synthesis fallback's deadline conversion
  into one shared wrapper beside `streamCutShortMessage()` and route the
  fallback and both `researchEvidenceForSynthesis` `callLLM` calls through it --
  closes DW-651's runtime half and all of DW-665.
- `src/app/api/research/[id]/run/route.ts` -- add the
  `ResearchProjectBusyError → 503` branch to the `instanceof` ladder and update
  the catch comment, which currently states that "…is retired" and the rerun
  baseline race keep their 500 -- closes DW-651's door half.
- `src/lib/llm-deadline.ts` -- record the third, non-streamed use in
  `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`'s docblock -- so the constant's stated
  scope matches its call sites.
- `src/lib/__tests__/research-run-route.test.ts` -- pin every DW-651 row of the
  I/O matrix: 404 for the retired sentence, 409 for both delivery-in-progress
  sentences, 503 for all three busy sentences, and 500 for `ResearchLeaseError`
  and for a plain `Error` carrying the same words.
- `src/lib/__tests__/research-runtime.test.ts` -- assert the runtime seam by
  TYPE at each retyped throw (so a revert to `new Error` fails), and add
  condensation/reduction deadline tests asserting `project.error` is the gated
  constant, the ungated constant, and — for a non-deadline rejection — the
  original message, with no page written in any of them.

**Acceptance Criteria:**
- Given any fault reaching the POST catch that is not one of the four typed
  classes or a read-only refusal, when the response is built, then it is 500
  regardless of the words in its message.
- Given a run cut by an LLM deadline anywhere in evidence condensation or
  hierarchical reduction, when the panel renders `project.error`, then it shows
  a research-scoped constant and contains none of "aborted", "signal",
  "TimeoutError" or "AbortError" — the repo's existing transport-vocabulary
  list. ("timeout" is deliberately NOT on it: `LLM_DEADLINE_RESEARCH_COPY`
  names the LLM timeout the owner set in Settings, which is a control they
  have, not the SDK's word for a signal.)
- Given a throw site retyped by this bundle is reverted to `new Error(...)` with
  the same message, when the suite runs, then it fails.
- Given the full suite, when `pnpm test` runs, then nothing that depended on the
  previous 500s or on the SDK sentence remains, and nothing else regresses.

## Spec Change Log

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 3, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The delivery-retry branch called the sentinel-COLLAPSING
    `updateResearchProjectIf`, so a mid-request read-only flip arrived as `null`
    and left as `ResearchProjectBusyError` → 503 — telling the owner to retry a
    write the deployment will never accept, and bypassing the route's 403
    branch. Switched to `updateResearchProjectIfOrRefusal` with the sentinel
    converted to `ReadOnlyError`, matching the four sibling entry points (and
    making `research-projects.ts`'s "five throwing entry points" claim true
    again). Pinned in `read-only-store-gate.test.ts`.
  - `[medium]` `[patch]` `callResearchLLM` threw the cut-short sentence without
    the `requireResearchActive` check every other producer of that sentence
    performs first, so an owner who cancelled during a condensation call whose
    deadline then fired was relabelled `failed` under a deadline sentence. The
    helper now takes `owner`/`id`/`attemptId` and checks before throwing.
  - `[medium]` `[patch]` `callResearchLLM` discarded the SDK error entirely, no
    log and no `cause` — which made false the property
    `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`'s docblock asserts and this diff widened
    ("the SDK's own error goes to `logger.warn`"). Now logged before the throw.
  - `[low]` `[patch]` Two contradictions introduced into that docblock: "whose
    deadline fired with no deadline set", and "THREE USES, and only the first is
    gated" against a later sentence naming DW-665's use as the same gate as
    DW-544's. Both rewritten.
  - `[low]` `[patch]` `ResearchProjectBusyError`'s docblock claimed contention is
    "answered 503" without qualification, while the three sibling research doors
    still answer 500 for the identical fault. Narrowed to name the run door and
    record the siblings as deliberately unchanged.
  - `[low]` `[patch]` The mid-request-refusal suite's new comment claimed "the
    503 sits BEHIND the 403" about a row where no `ReadOnlyError` is in play.
    Corrected, and the delivery-retry branch's two outcomes (403 vs 503) pinned.
  - `[low]` `[patch]` `workbench-request.ts`'s enumeration of routes that emit
    503 as a definite verdict — the premise `UNCONFIRMED_STATUSES` excluding 503
    rests on — did not name this door. Added with its premise.
  - `[low]` `[patch]` The new status table drove `queueResearchProject` only,
    though `cancelResearchProject` reaches the same CAS. Cancel verb covered.
  - `[low]` `[patch]` The CAS-exhaustion test asserted the class but never that
    the ladder ran, so a one-attempt regression passed a test named for
    exhaustion. Now asserts the 8 attempts; the mock's dead branch throws.
  - `[low]` `[patch]` The reduction test relied on `mockedTimeout` still holding
    a `null` set ~330 lines earlier; now set explicitly.
  - `[low]` `[patch]` Several retyped throws overran the file's prevailing wrap.
    Wrapped.

## Design Notes

Three classes, not one with a `kind`: the door branches on three distinct
statuses, and `instanceof` on three names reads at the call site without a
second lookup — the shape DW-480 established here.

503, not 409, for contention. A lost CAS and an exhausted CAS ladder are both
"the store was busy; come back in a moment", and the sentences already say
`retry`. 409 would tell the caller their request conflicts with a state they can
inspect and resolve; nothing here is inspectable, and the DW-651 evidence names
the missing retry signal exactly. 409 stays for the two refusals that ARE about
the project's own state (already running, completion in flight).

One wrapper, three call sites — the fallback's rationale travels with it:

```ts
async function callResearchLLM(system, user, options) {
  try {
    return await callLLM(system, user, options);
  } catch (error) {
    // UNGATED: `isLlmDeadlineAbort`, not `isOwnLlmDeadline`. With no deadline
    // configured the SDK's own "aborted due to timeout" would be stored as
    // `project.error` and rendered in the panel. Only the WORDS turn on
    // whether a deadline was set; the run fails either way.
    if (isLlmDeadlineAbort(error)) throw new Error(streamCutShortMessage());
    throw error;
  }
}
```

No new copy constant: `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` ("the model's
response stopped before it was finished. Nothing was written to the wiki.") and
`LLM_DEADLINE_RESEARCH_COPY` are both already true of a run cut during
condensation — the page write happens only after synthesis, so nothing is
written either way — and inventing a fourth sentence for the same owner-visible
outcome would split one fact across two strings.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-delivery.test.ts src/lib/__tests__/research-completion.test.ts` -- expected: all pass
- `npx vitest run src/lib/__tests__/query-stream-deadline.test.ts` -- expected: all pass; the query route's sentences are untouched
- `pnpm test` -- expected: full suite green, no new failures
- `npx tsc --noEmit` -- expected: no type errors
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done

**Implemented.** Two owner-visible faults on the research run path now speak in
the right voice. `POST /api/research/[id]/run` no longer answers 500 for every
same-shaped refusal: a retired project is a 404, agreeing with the GET on that
same path for that same row; a completion still being delivered joins "already
running" at 409; and a lost or exhausted compare-and-swap is a 503, so transient
store contention carries a retry signal instead of reading as a permanent server
fault. Every status is still decided by `instanceof` alone and every message is
unchanged. Separately, a fired LLM deadline during evidence condensation or
hierarchical reduction no longer reaches the research panel as the SDK's "The
operation was aborted due to timeout" — those two calls now go through the same
deadline-to-sentence conversion the synthesis fallback already applied, extracted
so all three share it, with cancellation still outranking the sentence and the
SDK's own words logged for operators.

**Files changed:**
- `src/lib/research-projects.ts` -- adds exported `ResearchProjectBusyError` and
  throws it for the exhausted CAS ladder; the two existing classes' docblocks,
  which recorded the now-lifted exclusions, are rewritten.
- `src/lib/research-runtime.ts` -- five throw sites retyped (retired → not-found,
  both delivery-in-progress → conflict, both CAS losses → busy), the delivery-retry
  branch moved onto `updateResearchProjectIfOrRefusal` so a read-only flip stays a
  `ReadOnlyError`, and the new `callResearchLLM` wrapper shared by the synthesis
  fallback, condensation and reduction.
- `src/app/api/research/[id]/run/route.ts` -- `ResearchProjectBusyError → 503`
  added to the ladder; read-only 403 still first, `availableProviders` still on
  every status.
- `src/lib/llm-deadline.ts` -- records the third use of
  `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` and its gating.
- `src/lib/workbench-request.ts` -- adds this door to the enumeration of routes
  that emit 503 as a definite verdict.
- `src/lib/__tests__/research-run-route.test.ts` -- a status table over every
  refusal the door can raise, for both verbs, plus `ResearchLeaseError` and
  untyped faults carrying the same words at 500.
- `src/lib/__tests__/research-runtime.test.ts` -- type assertions at each retyped
  throw, and condensation/reduction tests for the gated sentence, the ungated
  sentence, a preserved non-deadline message, and cancellation outranking both.
- `src/lib/__tests__/research-projects.test.ts` -- the CAS ladder's type and its
  eight attempts.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- the delivery-retry branch
  under a read-only deployment.

**Review findings:** 11 patches applied (3 medium, 8 low), 1 deferred (low,
recorded in frontmatter `deferred`), 11 rejected. Follow-up review recommended:
true — patched severities were high 0, medium 3, low 8, scoring
`3x3 + 1x8 = 17`, at or above the threshold of 5.

**Verification:**
- `npx vitest run` over `research-run-route`, `research-runtime`,
  `research-projects`, `research-delivery`, `research-completion`,
  `query-stream-deadline` and `read-only-store-gate` -- 362 passed, 1 skipped
  (pre-existing).
- `pnpm test` -- 354 files, 8457 passed, 1 skipped.
- `npx tsc --noEmit` -- clean. `pnpm lint` -- clean (only the pre-existing
  `jsx-ast-utils` plugin warnings).
- Revert checks: reverting the five typed throws and both wrapper call sites
  fails the suite, as does re-collapsing the read-only sentinel or dropping the
  cancellation check.

**Residual risks:**
- The same contended-store fault is a 503 at this door and a 500 at the three
  sibling research doors. Out of DW-651's named scope, recorded in
  `ResearchProjectBusyError`'s docblock and in frontmatter `deferred`.
- No single test spans runtime throw to HTTP status: the route suite mocks
  `research-runtime` wholesale and feeds hand-built instances, while the runtime
  suite asserts the classes at the throw sites. Both halves are pinned; the join
  is by convention, as it was before this change.
- The condensation and reduction calls pass `maxOutputTokens: 1_500` and
  `callLLM` surfaces no `finishReason`, so a note silently clipped at that cap
  still flows into synthesis. That is the already-open deferral about `callLLM`
  not exposing `finishReason`, not something this bundle introduced.
