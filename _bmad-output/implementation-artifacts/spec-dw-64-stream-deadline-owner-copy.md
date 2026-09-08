---
title: 'DW-64: an owner-facing sentence when the LLM deadline cuts a streamed answer short'
type: 'bugfix'
created: '2026-08-29'
baseline_revision: 'a7c6aebbe8545770aec901d23025ff6a650bd101'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `synthesizeResearchBrief` still reads `textStream`, so a fired deadline
      commits a truncated research brief as a finished wiki page.
    evidence: |-
      `src/lib/research-runtime.ts:1136-1157` is the only other caller of
      `callLLMStream`. It iterates `stream.textStream`, which drops the
      `{ type: "abort" }` part, so the `for await` ends NORMALLY and
      `receivedStreamContent` suppresses the `callLLM` fallback at :1153. `raw`
      is the partial text and flows through `runResearchProject` (:1613) into
      `commitResearchPage` (:1645). Neither existing test models a short close:
      research-runtime.test.ts:842 ends normally with full content, :858 throws.
      Out of scope by the intent, which names only the query stream route.
    location: >-
      src/lib/research-runtime.ts:1136
    severity: medium
  - summary: >-
      `/api/query` still returns `getErrorMessage(error)` verbatim, so a fired
      deadline reaches the owner as raw transport vocabulary there.
    evidence: |-
      `src/app/api/query/route.ts:74-81`. It is also the streaming route's own
      fallback: `useStreamingQuery` (`src/hooks/useStreamingQuery.ts:129-155`)
      re-queries it on any non-2xx and PREFERS `fallbackData?.error` over the
      streaming route's sentence, so "The operation was aborted due to timeout"
      can still be what the owner reads after this change. Out of scope by the
      intent, which names only src/app/api/query/stream/route.ts.
    location: >-
      src/app/api/query/route.ts:74
    severity: medium
  - summary: >-
      `query-stream-route.test.ts`'s `callLLMStream` mock returns an async
      generator, so all three #413 filtering tests run through the route's 500
      catch and prove nothing about a completing route.
    evidence: |-
      `src/lib/__tests__/query-stream-route.test.ts:33` mocks
      `callLLMStream: vi.fn(async function* () {})`. That value has neither
      `toTextStreamResponse` (before this change) nor `fullStream` (after), so
      `POST` throws a TypeError and answers 500. The tests pass only because
      they assert on `selectPagesForQuery` arguments and never read a status or
      body. Pre-existing — the pre-change route was equally undefined on that
      mock — and left untouched so this story's "existing assertions untouched"
      acceptance stayed honest.
    location: >-
      src/lib/__tests__/query-stream-route.test.ts:33
    severity: medium
  - summary: >-
      The `QUERY_MAX_OUTPUT_TOKENS` cap truncates a streamed answer as silently
      as the deadline used to.
    evidence: |-
      `finishReason: "length"` arrives on the `finish` part and falls into the
      route's bookkeeping tail, so the body simply ends. Same owner-visible
      failure as DW-64 — a half answer that reads as a whole one — from a
      different cause, and the notice machinery this change adds is one branch
      away from covering it. Not the deadline, so outside an intent that names
      TimeoutError/AbortError only.
    location: >-
      src/app/api/query/stream/route.ts:253
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `callLLMStream` (`src/lib/llm.ts:566-582`) spreads `llmTimeoutOption()` as one deadline over the whole stream. When it fires on `/api/query/stream`, the owner is told nothing: the AI SDK turns the abort into an `{ type: "abort" }` part and CLOSES the stream (`ai@6` `streamText`), and `result.textStream` — which `toTextStreamResponse()` serves — drops every non-`text-delta` part, so a truncated half-answer arrives looking finished. In the racing case where the abort is thrown instead of parted, nothing maps it either, and `TimeoutError`'s own words ("The operation was aborted due to timeout") are transport vocabulary no Copy table in this repo contains.

**Approach:** Apply the recorded 2026-08-21 decision — keep the whole-stream deadline exactly as frozen, fix only the sentence. Serve the answer from `result.fullStream` instead of `textStream` so the route can SEE the abort, and emit one owner-facing sentence naming the Settings control the owner set, in place of the silent truncation. Pin it with a test.

## Boundaries & Constraints

**Always:** The deadline itself is untouched — no retry wrapper, no per-token deadline, no change to `llmTimeoutOption` or `getLlmTimeoutMs`. The sentence is ONE exported constant with the Settings pointer composed via `settingsPointer("llm-models", SETTINGS_LABEL)`, never hand-typed, so renaming that category cannot orphan it. The test asserts against the imported constant, never a restated literal. Text deltas still stream token-by-token and the `X-Wiki-Sources` header keeps its current value and percent-encoding.

**Block If:** The frozen `abort`-part behaviour of `ai@6` `streamText` turns out to be different from what `node_modules/ai/dist/index.mjs` shows (an abort that ERRORS the stream rather than closing it) — that would change which branch is the live one.

**Never:** Do not touch `src/lib/config.ts`, `src/hooks/useStreamingQuery.ts`, `/api/query`, or the non-streaming path. Do not change how non-deadline mid-stream `error` parts behave (today they are dropped; that is DW-64's neighbour, not DW-64). Do not export anything but HTTP handlers from `route.ts` — Next 15 type-checks route exports, and no `route.ts` in this repo exports anything else.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal answer | `fullStream` yields `text-delta` parts then `finish` | Body is the concatenated deltas, unchanged; `content-type: text/plain; charset=utf-8`; `X-Wiki-Sources` set | No error expected |
| Deadline mid-answer | Deltas, then `{ type: "abort" }` | Body is the streamed deltas, then a blank line, then `LLM_DEADLINE_COPY`; stream closes cleanly (200) | Logged once via `logger.warn("query", …)` |
| Deadline before any token | First part is `{ type: "abort" }` | Body is exactly `LLM_DEADLINE_COPY` with no leading blank line | Same log |
| Deadline THROWN mid-read | Iterating `fullStream` rejects with an `Error` named `TimeoutError` or `AbortError` | Same as the two rows above — notice appended, stream closed | Same log |
| Other mid-stream throw | Iterating rejects with any other error | Stream errors exactly as it does today | Propagates unchanged |
| Deadline before the stream exists | `callLLMStream` itself rejects with `TimeoutError`/`AbortError` | `500` with `{ error: LLM_DEADLINE_COPY }` — the route's own verdict, so not a gateway status | Logged by the existing `catch` |
| Owner cancels | Client aborts the fetch | Response body is cancelled; no notice is written | No error expected |

</intent-contract>

## Code Map

- `src/app/api/query/stream/route.ts` — the whole change. `POST` ends at `callLLMStream(...)` then `result.toTextStreamResponse({ headers: { "X-Wiki-Sources": … } })`; the `catch` returns `getErrorMessage(error)` at 500. Neither mentions a deadline.
- `src/lib/llm.ts:566-582` — `callLLMStream`; spreads `...llmTimeoutOption()` with the "One deadline for the whole stream" comment. Its docblock's **Why no retry wrapper** paragraph is the explaining half; add the frozen-decision note and a pointer to the new copy owner. NO behaviour change here.
- `src/lib/config.ts:1453-1479` — `getLlmTimeoutMs` / `llmTimeoutOption`. Read-only: the deadline is opt-in (`llmTimeoutSeconds` unset ⇒ no `abortSignal` at all).
- `src/components/workbench/SettingsCanvas.tsx:803-804` — the control the sentence must name: the `llm-models` category, heading "Timeout", row label "LLM timeout (seconds)".
- `src/lib/workbench-settings.ts:86-100, 122, 179-184` — `SETTINGS_CATEGORIES` (`llm-models` ⇒ "LLM Models"), `SETTINGS_LABEL`, `settingsPointer`. `src/lib/llm.ts:55` shows the runtime-error form: `settingsPointer("llm-models", SETTINGS_LABEL)` ⇒ `Settings → LLM Models` (DW-369 — never hand-typed).
- `src/lib/workbench-request.ts:139-183` — the precedent for the predicate (`unconfirmedCause` name-checks `TimeoutError`/`AbortError`) and for refusing transport vocabulary. Do NOT reuse it: it also matches `TypeError`/502/504 and means "the write's outcome is unknown", which is false here.
- `node_modules/ai/dist/index.mjs:6840-6875` — the frozen SDK fact: on abort the SDK enqueues `{ type: "abort", reason? }` and CALLS `controller.close()`; only a thrown abort with `signal.aborted === false` reaches `controller.error`. `index.mjs:7690-7702` — `textStream` keeps `text-delta` only. `index.d.ts:2601-2685` — the `TextStreamPart` union, incl. `abort` and `error`. `index.mjs:4925-4938` — `createTextStreamResponse` (exported from `ai`), which is what `toTextStreamResponse` is: `textStream.pipeThrough(new TextEncoderStream())` plus the `text/plain; charset=utf-8` default header.
- `src/lib/__tests__/query-stream-route.test.ts` — the existing suite. It mocks `@/lib/llm` wholesale and `callLLMStream` as an empty async generator, so it never reaches a real stream; its assertions are all on `selectPagesForQuery` calls and must keep passing. New assertions go in a new file so the real copy constant can be imported unmocked.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm-deadline.ts` -- NEW. Export `LLM_DEADLINE_COPY` (composed with `settingsPointer("llm-models", SETTINGS_LABEL)`) and `isLlmDeadlineAbort(cause: unknown): boolean` (an `Error` named `TimeoutError` or `AbortError`). -- A separate light module, not `llm.ts`: the test must import the real sentence while mocking `callLLMStream`, and `route.ts` cannot export it itself (Next 15 validates route exports).
- `src/app/api/query/stream/route.ts` -- Replace `result.toTextStreamResponse({ headers })` with `createTextStreamResponse({ textStream: <wrapper>, headers })` from `ai`, where the wrapper pulls `result.fullStream`: enqueue `text-delta.text`; on `abort` (or a caught deadline throw, or an `error` part carrying one) enqueue the notice and close; propagate any other throw; ignore every other part. Prefix the notice with a blank line only when text was already emitted. Log once with `logger.warn`. Also map a deadline thrown by `callLLMStream` itself to `{ error: LLM_DEADLINE_COPY }` at 500. -- The route is where the decision says the mapping belongs, and `fullStream` is the only place the abort is visible.
- `src/lib/llm.ts` -- Docblock only, on `callLLMStream`: record that the single whole-stream deadline is the frozen 2026-08-21 decision (DW-64) and name `src/lib/llm-deadline.ts` as the copy owner. -- The ledger entry's location; a reader here must not "fix" the deadline.
- `src/lib/__tests__/query-stream-deadline.test.ts` -- NEW node-project suite covering every I/O Matrix row, driving `callLLMStream` with a fake `{ fullStream }` and asserting on the imported `LLM_DEADLINE_COPY`. -- Pins the sentence the decision asked for.

**Acceptance Criteria:**
- Given the owner has set an LLM timeout and it fires after some tokens, when the answer streams, then the body ends with `LLM_DEADLINE_COPY` and contains none of `aborted`, `signal`, `TimeoutError` or `AbortError` outside that sentence.
- Given `LLM_DEADLINE_COPY`, when it is read, then it names the Settings destination as `settingsPointer("llm-models", SETTINGS_LABEL)` produces it, with that pointer not spelled as a literal anywhere in the new sources or the suite.
- Given a stream that never aborts, when it completes, then the response bytes, status, `content-type` and `X-Wiki-Sources` header are what `toTextStreamResponse` produced before this change.
- Given `pnpm test`, when the full suite runs, then it passes with the existing `query-stream-route.test.ts` assertions untouched.

## Spec Change Log

_No `bad_spec` loopback occurred; the spec was implemented as written._

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 4: (high 0, medium 4, low 0)
- reject: 13: (high 0, medium 2, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The deadline sentence fired for aborts no configured deadline caused, and the `catch` branch's stated rationale was false. Added `llmDeadlineConfigured()` to `src/lib/llm-deadline.ts` and one module-level `ownDeadline(cause)` in the route, required at all three mapping sites; with no timeout configured every branch falls back to its pre-DW-64 behaviour. Rewrote the `catch` comment to name what it actually catches (`expandQueryWithNamesTerms`, `selectPagesForQuery` and `buildQuerySystemPrompt` all reach `callLLM`, which spreads the same `llmTimeoutOption()`) and to state that `callLLMStream`'s own signal cannot fire in that window.
  - `[low]` `[patch]` A zero-length `text-delta` flipped `emitted`, so an empty delta followed by an abort opened the body with the blank line that rule exists to prevent. Empty deltas are now skipped entirely.
  - `[low]` `[patch]` `cancel()` did `void parts.return?.(reason)`: `void` leaves a rejecting `return()` as an unhandled rejection, and `return(value)` takes a return value, not a cancel reason. Now `async cancel() { await parts.return?.(); }`, and the comment no longer claims it releases the provider connection — `fullStream` is one branch of a `tee()`.
  - `[low]` `[patch]` Two inaccurate sentences: the `logger.warn` line said "mid-stream" on a path that also runs before the first token, and `llm.ts`'s docblock read as a claim that the route is the only caller of `callLLMStream`. Both reworded; the docblock now names `synthesizeResearchBrief` as the second caller, deferred.
  - `[low]` `[patch]` Suite gaps: no coverage of an empty delta, a zero-part stream, notice-path headers, or the no-deadline-configured fallback, and the cancellation assertion depended on propagation taking exactly one macrotask. All five added or fixed; `@/lib/config` is mocked through `importOriginal` so only `getLlmTimeoutMs` is replaced.

## Design Notes

The trap: DW-64 says the `TimeoutError` message "propagates verbatim". Under `ai@6` it does not — it is swallowed, which is worse, because a half answer reads as a whole one. So the fix cannot be a `catch` around the existing call; the route has to read `fullStream` to see the `abort` part at all. The thrown branch is still written, because the SDK's own guard (`isAbortError(error) && signal.aborted`) has a race in which an abort reaches `controller.error` instead.

```ts
// src/app/api/query/stream/route.ts — shape only
const parts = result.fullStream[Symbol.asyncIterator]();
let emitted = false;
const notice = () => (emitted ? `\n\n${LLM_DEADLINE_COPY}` : LLM_DEADLINE_COPY);
// pull(): read one part; "text-delta" → enqueue + emitted = true;
// "abort" → enqueue notice, close; catch → deadline ? notice + close : rethrow.
```

`pull` may resolve without enqueueing (a bookkeeping part); the stream simply pulls again. `cancel` must forward to `parts.return?.()` so an owner-cancelled fetch releases the provider connection.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/query-stream-deadline.test.ts src/lib/__tests__/query-stream-route.test.ts` -- expected: all pass, new suite covers every I/O Matrix row.
- `pnpm test` -- expected: exit 0, no suite regressed.
- `pnpm exec tsc --noEmit` -- expected: clean (confirms the `TextStreamPart` narrowing and the route's export surface).
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

A fired LLM deadline no longer ends a streamed answer in silence. `/api/query/stream` now serves the answer from `result.fullStream` rather than `toTextStreamResponse()`, because that is the only place the abort is visible: under `ai@6.0.146` `streamText` does NOT propagate the `TimeoutError` — it enqueues an `{ type: "abort" }` part and closes the stream, and `textStream` keeps `text-delta` parts only. The route appends one owner-facing sentence (`LLM_DEADLINE_COPY`) in place of the silence, on a blank line when text was already emitted and alone when it was not, and maps the same fact wherever else it can arrive: a thrown `TimeoutError`/`AbortError` mid-read (the SDK's own `isAbortError(error) && signal.aborted` guard has a race), a deadline-carrying `error` part, and a deadline that fired in one of the LLM calls the handler makes before the stream exists (500 JSON). Every mapping is gated on a deadline actually being configured, so with the field blank each branch behaves exactly as it did before. The deadline MECHANISM is untouched, per the frozen 2026-08-21 decision.

Note for the ledger: DW-64's premise that "The operation was aborted due to timeout" propagates verbatim on this path does not hold under `ai@6` — the SDK swallows it, which is worse, because a half answer reads as a whole one. The decision's remedy (an owner-facing sentence, pinned by a test) is what was implemented; the surface it had to be written at is the 200 answer body, not the `catch`.

### Files changed

- `src/lib/llm-deadline.ts` (new) — `LLM_DEADLINE_COPY` (Settings destination composed via `settingsPointer("llm-models", SETTINGS_LABEL)`, never typed), `isLlmDeadlineAbort`, `llmDeadlineConfigured`.
- `src/app/api/query/stream/route.ts` — reads `fullStream` behind a `ReadableStream` wrapper, serves it through `createTextStreamResponse`, maps the deadline to the sentence at three sites; `catch` maps a pre-stream deadline to the same sentence at 500.
- `src/lib/llm.ts` — docblock only on `callLLMStream`: records the frozen deadline decision and names the copy owner and the second, still-unmapped caller. No behaviour change.
- `src/lib/__tests__/query-stream-deadline.test.ts` (new) — 17 tests covering every I/O Matrix row plus the review-added cases.

### Review findings breakdown

Patches applied: 5 (1 medium, 4 low) — see the Review Triage Log. Items deferred: 4 (all medium) — see frontmatter `deferred`. Items rejected: 13, the notable ones with their evidence: `DOMException` is `instanceof Error` in Node (verified by running it), so the predicate misses nothing; the SDK's own `isAbortError` is a name check too, so walking `error.cause` would not match it; `LLM_MODELS_POINTER` cannot be imported from `llm.ts` because the suite mocks that module wholesale, which is why the copy has its own home; the notice paths leak no iterator, because the SDK closes the source after both the `abort` and `error` parts and a thrown iterator is already done; and no test drives a real `AbortSignal.timeout` through `streamText`, but `tsc` fails on `part.type === "abort"` if that union member ever disappears, which pins the load-bearing half.

### Follow-up review recommendation

Patched findings this pass: high 0, medium 1, low 4. Score = 3 × 1 + 1 × 4 = 7, which is ≥ 5 → `followup_review_recommended: true`.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/query-stream-deadline.test.ts src/lib/__tests__/query-stream-route.test.ts` — 22 passed (2 files). Every I/O Matrix row is covered by a test that ran and passed.
- `pnpm exec vitest run --project node` — 278 files, 6884 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm lint` — exit 0 (output is the three pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `pnpm test` (both projects) exits non-zero on 13 dom-project files / 229 tests failing with `window.localStorage` undefined. Confirmed pre-existing: the same suite fails identically on a stashed clean tree at `a7c6aebbe8545770aec901d23025ff6a650bd101`. Not caused by this change, which touches node-project code only.

### Residual risks

- The two SDK facts this design rests on (abort arrives as a part and closes; `textStream` drops it) are pinned by the fixture's shape and by `tsc`'s narrowing of `TextStreamPart`, not by an integration test against a real `AbortSignal.timeout`. An `ai` upgrade that kept the `abort` member but changed when it is emitted would leave the suite green.
- The 500 branch's sentence rarely reaches the Workbench: `useStreamingQuery` answers any non-2xx by re-querying `/api/query` and prefers that route's message. That sibling route still returns `getErrorMessage(error)` verbatim — deferred above.
