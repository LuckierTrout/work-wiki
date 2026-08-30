---
title: 'DW-546: make the query-stream route tests exercise a completing route'
type: 'bugfix'
created: '2026-08-30'
baseline_revision: 'fe8b24c670c8e6bc90369d5684018505f0f2cae4'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The `@/lib/wiki` mock stubs `isArtifactType` as `t === "html"`, but the real
      predicate also matches `"slides"`, so the artifact-exclusion test cannot see a
      route that stopped filtering slides.
    evidence: |-
      `src/lib/page-types.ts:32-34` is `type === "html" || type === "slides"`. The
      test factory at `src/lib/__tests__/query-stream-route.test.ts:27` returns true
      for `"html"` only, and the fixture at the artifact test carries no `slides`
      page. Pre-existing (that mock line is untouched by DW-546).
    location: >-
      src/lib/__tests__/query-stream-route.test.ts:27
    severity: low
  - summary: >-
      The 401 test's comment claims "no page selection, no LLM stream" but only
      `selectPagesForQuery` is asserted; nothing pins that `callLLMStream` stayed
      uncalled, on either the 401 or the 400 path.
    evidence: |-
      The claim holds only transitively — the route reaches `callLLMStream`
      (route.ts:174) strictly after `selectPagesForQuery` (route.ts:156). `mockedStream`
      is now in scope in the test file but is never asserted. Confirmed independently by
      two review layers. Left alone because the intent covers only the three filtering
      cases.
    location: >-
      src/lib/__tests__/query-stream-route.test.ts:186
    severity: low
  - summary: >-
      `hasLLMKey` is mocked synchronously (`vi.fn(() => true)`) while production is
      `async` — the same species of mock-shape drift DW-546 just fixed one line below
      it, in the same factory.
    evidence: |-
      `src/lib/llm.ts:248` is `export async function hasLLMKey(): Promise<boolean>`.
      The mock passes only because `await true` works. This repo already treats that
      gate's promise-ness as load-bearing (DW-548 / `llm-key-cold-config.test.ts`).
      Pre-existing; the mock line is untouched by DW-546.
    location: >-
      src/lib/__tests__/query-stream-route.test.ts:31
    severity: low
  - summary: >-
      No test covers an unscoped query whose readable pages are ALL agent-scoped —
      the `#413` filter empties `entries` and the route answers a user-visible
      "The wiki is empty" 400.
    evidence: |-
      route.ts:124-139 — the filter runs, then the empty-entries branch returns 400.
      That outcome is produced entirely by the filter this file exists to test, and
      only the non-streaming path covers it (`query.test.ts:726`). Pre-existing gap.
    location: >-
      src/lib/__tests__/query-stream-route.test.ts:155
    severity: low
  - summary: >-
      The `format: "html"` test's title promises "(and accepts format:html)" but
      nothing asserts the format reached `buildQuerySystemPrompt`; a route that
      coerced every request to `"prose"` would still pass.
    evidence: |-
      `buildQuerySystemPrompt` is mocked and observable (test file line 45), and the
      route passes `queryFormat` to it at route.ts:165-171. The test asserts only a
      200 and the filtered entry list. Pre-existing naming/coverage mismatch.
    location: >-
      src/lib/__tests__/query-stream-route.test.ts:155
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/lib/__tests__/query-stream-route.test.ts:33` mocks `callLLMStream` as `vi.fn(async function* () {})`, whose return value has no `fullStream`; the route's `result.fullStream[Symbol.asyncIterator]()` throws a TypeError, so every call lands in the handler's catch and answers 500. The three `#413` filtering tests pass only because they assert on `selectPagesForQuery` arguments and never look at a status or body — they prove nothing about a route that actually completes.

**Approach:** Replace the generator mock with a resolved fake `StreamTextResult` exposing a `fullStream` async iterable (plus the `text` promise the real result carries), and add status/body assertions to the three filtering cases so each one pins its filtering claim on a route that streamed a 200 to completion.

## Boundaries & Constraints

**Always:** Keep the existing `selectPagesForQuery`-argument assertions in all three filtering tests exactly as they are — they are the `#413` claim and must survive. The fake must carry only what the route reads, cast narrowly (`as unknown as Awaited<ReturnType<typeof callLLMStream>>`) rather than by widening the route's types. The 400 and 401 cases already assert real statuses and must keep passing untouched.

**Block If:** Making the three filtering tests reach a 200 would require changing `src/app/api/query/stream/route.ts` — the route is correct; only the test double is wrong.

**Never:** Do not edit `src/app/api/query/stream/route.ts` or any non-test source. Do not duplicate the deadline / length-cap / cancellation coverage that already lives in `src/lib/__tests__/query-stream-deadline.test.ts` — this file's subject is agent-scope and artifact filtering. Do not export new symbols from the route to make testing easier.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unscoped query completes | `{ question: "what is A?" }`, `resolveScopeSlugs` → `{ scopeSlugs: undefined }`, fake stream yields one `text-delta` then `done` | 200; body is the delta text; `selectPagesForQuery` receives only `concept-a` (no `agent-*`) | No error expected |
| `agent:` scope completes | `{ question, scope: "agent:yoyo" }`, `resolveScopeSlugs` → `{ scopeSlugs: [...] }` | 200; body is the delta text; agent-scoped entries flow through unfiltered | No error expected |
| `format: "html"` completes | `{ question: "?", format: "html" }`, entries include a `type: "html"` artifact | 200; body is the delta text; the `html` artifact is excluded from the entries passed to `selectPagesForQuery` | No error expected |
| Invalid format | `{ question: "?", format: "bogus" }` | 400, `selectPagesForQuery` never called | Validation response, not the catch |
| Anonymous caller | `getPrincipal` → `null` | 401 with a "sign in" message; no page selection | Auth response, not the catch |

</intent-contract>

## Code Map

- `src/lib/__tests__/query-stream-route.test.ts` -- THE ONLY FILE TO CHANGE. Line 33 holds the broken `callLLMStream: vi.fn(async function* () {})` mock inside the `vi.mock("@/lib/llm", ...)` factory (lines 30-34). Tests at lines 81, 93, 105 call `await POST(...)` and discard the response; tests at 122 and 128 already assert `res.status`.
- `src/app/api/query/stream/route.ts:174-194` -- READ-ONLY EVIDENCE. `const result = await callLLMStream(...)` then `const parts = result.fullStream[Symbol.asyncIterator]()`. An async generator has no `fullStream`, so this is the TypeError that reaches the catch at line 315 and returns 500.
- `src/app/api/query/stream/route.ts:219-304` -- READ-ONLY. The `pull` loop enqueues non-empty `text-delta` parts and calls `controller.close()` on `done`; `createTextStreamResponse` (line 306) serves it as `text/plain`, so `await res.text()` yields the concatenated deltas.
- `src/lib/__tests__/query-stream-deadline.test.ts:80-118` -- REUSE POINTER (pattern, not import). Its `delta()` helper and `fakeResult()` build exactly this fake: an iterator over scripted parts, wrapped as `{ fullStream: { [Symbol.asyncIterator]: () => iterator } }`, fed to `mockedStream.mockResolvedValue(... as unknown as Awaited<ReturnType<typeof callLLMStream>>)`. Copy the minimal shape; do not import across test files.
- `src/lib/llm.ts:622-639` -- READ-ONLY. `callLLMStream` is `async`, returning `streamText(...)`'s `StreamTextResult` — hence `mockResolvedValue` on an object, never an async generator.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/query-stream-route.test.ts` -- Change the `@/lib/llm` factory's `callLLMStream` to a bare `vi.fn()`, import it and wrap with `vi.mocked`, and add a local helper that resolves it to a fake result `{ fullStream: { [Symbol.asyncIterator]: () => iterator }, text: Promise.resolve(<answer>) }` scripting one non-empty `text-delta` followed by `done`. Set it up in `beforeEach` so every test gets a completing stream by default. -- The route reads `result.fullStream`; an async generator has none, so the current mock makes the route 500 before it can be observed.
- `src/lib/__tests__/query-stream-route.test.ts` -- In the three filtering tests (unscoped, `agent:` scope, `format: "html"`), capture the response from `await POST(...)` and assert `res.status === 200` and `await res.text()` equals the scripted answer, before the existing `selectPagesForQuery` assertions. -- Without a status/body assertion the tests would silently go back to grading a 500 if the double drifts again.
- `src/lib/__tests__/query-stream-route.test.ts` -- Update the stale comment at line 32 (`// Empty stream so the route completes without a real LLM.`) to describe the fake `StreamTextResult` and why the shape matters. -- The comment currently asserts the very thing that was false.

**Acceptance Criteria:**
- Given the updated `callLLMStream` double, when the unscoped filtering test posts a question, then the response status is 200 and its body is the scripted answer text.
- Given the updated double, when the `agent:yoyo`-scoped test posts a question, then the response status is 200, the body is the scripted answer text, and the entries passed to `selectPagesForQuery` still include the `agent-identity` and `agent-knowledge` types.
- Given the updated double, when the `format: "html"` test posts a question, then the response status is 200, the body is the scripted answer text, and the entries passed to `selectPagesForQuery` still exclude the `html` artifact and equal `["concept-a"]`.
- Given the mock is reverted to an async generator, when the suite runs, then at least one filtering test fails — the status assertions make the 500 visible instead of silent.
- Given the whole change, when `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts src/lib/__tests__/query-stream-deadline.test.ts` runs, then all tests in both files pass and `src/app/api/query/stream/route.ts` is unmodified.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 5: (high 0, medium 0, low 5)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` The new comment on the unscoped test claimed the filtering assertions were "only worth anything on a route that actually streamed an answer" — false, since the filter (route.ts:124-128) and `selectPagesForQuery` (route.ts:156) both run before `callLLMStream` (route.ts:174). Rewritten to say what is true: the argument assertions always held; the status/body lines are what pin completion.
  - `[low]` `[patch]` `[Symbol.asyncIterator]` returned the same iterator object on every call, so a second `POST` in one test would silently answer an empty body. Iterator construction moved into a `makeIterator()` closure; proven with a temporary two-POST test.
  - `[low]` `[patch]` The helper docblock's "created fresh on every call" clause no longer matched the code; rewritten to describe the actual semantics.
  - `[low]` `[patch]` The script emitted a lone `text-delta`, omitting the `start` and `finish` parts every real `fullStream` carries — so the route's loop-past-bookkeeping `pull` never ran in its real shape. Now scripts `start` → delta → `finish` with `finishReason: "stop"` (never `"length"`, which is the DW-547 cap notice).
  - `[low]` `[patch]` The file header still framed the suite as `#413`-only; extended with a DW-546 paragraph so the status/body assertions are not later stripped as noise.

## Design Notes

The fake carries only what the route touches. `text` is included because a real `StreamTextResult` has it and its absence is part of what made the old double indefensible, but the route never awaits it — do not build assertions on it.

```ts
const ANSWER = "A is a concept.";
function scriptStream(text = ANSWER) {
  const parts = [{ type: "text-delta", id: "t0", text }];
  let i = 0;
  const iterator = {
    async next() {
      return i < parts.length
        ? { done: false as const, value: parts[i++] }
        : { done: true as const, value: undefined };
    },
  };
  mockedStream.mockResolvedValue({
    fullStream: { [Symbol.asyncIterator]: () => iterator },
    text: Promise.resolve(text),
  } as unknown as Awaited<ReturnType<typeof callLLMStream>>);
}
```

A fresh iterator per call matters: `beforeEach` must re-script, or a second `POST` in one test would read an exhausted iterator and answer an empty body.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts` -- expected: all 5 tests pass, including the three new 200/body assertions.
- `pnpm vitest run src/lib/__tests__/query-stream-deadline.test.ts` -- expected: unchanged, all pass (proves the neighbouring deadline suite was not disturbed).
- `git diff --name-only` -- expected: `src/lib/__tests__/query-stream-route.test.ts` only.
- `pnpm lint` -- expected: no new errors or warnings.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `src/lib/__tests__/query-stream-route.test.ts`'s `callLLMStream` double was an async generator, which has no `fullStream`; `route.ts:194` therefore threw a TypeError into the handler's catch and every one of these tests ran against a 500. It is now a bare `vi.fn()` resolved by a local `scriptStream()` helper to a stand-in `StreamTextResult` — `fullStream` scripting `start` → one non-empty `text-delta` → `finish (stop)`, plus the `text` promise a real result carries — and the three `#413` filtering tests assert `res.status === 200` and `await res.text() === ANSWER` alongside their unchanged `selectPagesForQuery` assertions.

One correction worth recording: the bundle intent said the tests "pass without ever reaching the filtering code they claim to cover." That is not what was happening. The filter and `selectPagesForQuery` both run before `callLLMStream`, so the filtering assertions were reached and were pinning the filter all along — DW-546's own `reason` field states the accurate version ("prove nothing about a completing route"). The fix is therefore additive: the three cases now also pin completion. The first draft of the code repeated the intent's over-claim in a comment; review caught it and it was rewritten.

**Files changed:**
- `src/lib/__tests__/query-stream-route.test.ts` -- replaced the async-generator `callLLMStream` double with a fake `StreamTextResult`, added 200/body assertions to the three filtering tests, and corrected the file header and helper comments.

No non-test source was touched; `src/app/api/query/stream/route.ts` is unmodified.

**Review findings:** 5 patches applied (all low), 5 items deferred (all low, all pre-existing), 10 rejected. No intent gaps, no spec repairs.

**Follow-up review recommendation:** true. Patched counts — high 0, medium 0, low 5. Score = (3 x 0 medium) + (1 x 5 low) = 5, which meets the threshold of 5.

**Verification performed:**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts src/lib/__tests__/query-stream-deadline.test.ts` -- 34 passed (5 + 29); the neighbouring deadline suite is undisturbed.
- Negative check: reverting the double to an async generator fails all three filtering tests with `expected 500 to be 200`, while the 400 and 401 tests still pass — the 500 is now visible instead of silent. Restored and re-run green.
- Two-POST check on the patched helper: the second `POST` returns 200 with the full body, proving the fresh-iterator fix.
- `pnpm lint` -- no errors or warnings (three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing plugin chatter from unrelated JSX files).
- `npx tsc --noEmit` -- clean.
- `git diff --name-only` -- `src/lib/__tests__/query-stream-route.test.ts` only.
- Matrix audit: all five I/O rows are covered by the five tests in the file, and all five ran and passed.

**Residual risks:**
- The double omits `return` on its iterator. The route's `cancel()` calls `parts.return?.()` optionally and nothing in this file cancels a response; that path is covered in `query-stream-deadline.test.ts`.
- `text` is present on the double but nothing asserts on it, by design.
- This is now the third independently-maintained `StreamTextResult` stand-in under `src/lib/__tests__/` (`fakeResult` in `query-stream-deadline.test.ts`, `fakeStream` in `research-runtime.test.ts`). Consolidating them was judged out of scope for DW-546 and was not deferred, since no defect follows from it today.
