---
title: 'Research synthesis: a truncated brief must fail, not commit (DW-663, DW-664)'
type: 'bugfix'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The non-streamed `callLLM` synthesis fallback passes the same 7,000-token
      cap but cannot see `finishReason`, so a fallback brief cut by that cap is
      still committed as a finished wiki page.
    evidence: |-
      `synthesizeResearchBrief`'s catch takes the `callLLM` fallback whenever the
      stream ended before producing text (`receivedStreamContent === false`),
      including on the two endings DW-663/DW-664 just made fatal. That call
      passes the identical `{ maxOutputTokens: 7_000 }`, and `callLLM`
      (`src/lib/llm.ts:513-537`) destructures only `{ text }` from
      `generateText`, discarding `finishReason` — so a fallback brief cut at the
      cap is indistinguishable from a whole one and commits. Pinned by the two
      boundary tests added in this pass, which assert the fallback path
      completes and writes a page. Closing it means surfacing `finishReason`
      from `callLLM`, which this spec's Never list rules out.
    location: >-
      src/lib/research-runtime.ts:1451
    severity: low
baseline_revision: '40e3ed2640e995794f4a1319b882bbe9dd490f9e'
---

<intent-contract>

## Intent

**Problem:** `synthesizeResearchBrief` (`src/lib/research-runtime.ts`) reads `fullStream` but acts on only two endings. A `finish` part with `finishReason: "length"` — the brief was CUT at the 7,000-token `maxOutputTokens` the call passes — falls through `if (part.type !== "text-delta") continue` and the partial `raw` is committed as a finished wiki page (DW-663). So does a non-deadline `error` part, which in `ai@6` CLOSES the source: the `for await` then ends normally and the half brief flows into `commitResearchPage` (DW-664).

**Approach:** Make both endings fatal in that loop, with research-scoped owner copy. A `length` finish fails the run outright. An `error` part is remembered rather than acted on immediately and fails the run only when nothing follows it — so the pre-existing "warning-shaped error, then more text, then `finish`" brief still commits. Pin both endings with tests.

## Boundaries & Constraints

**Always:**
- Owner-visible strings are CONSTANTS exported from `src/lib/llm-deadline.ts`, never `error.message`. `runResearchProject`'s catch stores the thrown message as `project.error` and it is rendered in the research panel.
- Research fails CLOSED on either ending: no page write, no second synthesis bought to paper over the first.
- Cancellation outranks both: `await requireResearchActive(owner, id, attemptId)` before every new throw, exactly as the existing abort branch does.
- The `length` sentence is UNGATED by `llmDeadlineConfigured()` — the 7,000 cap is passed on every call, so a `length` finish is always this repo's own — and carries NO Settings pointer, because nothing on the Settings surface writes that cap.
- A stream-ending non-deadline `error` reuses `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` ungated: its words name no field, so they stay true whether or not a deadline is configured. Blaming the timeout for an unrelated error would be the wrong sentence.

**Block If:**
- The `finish` part's `finishReason` is not reachable on the `fullStream` part union in this repo's `ai` version (it is at `src/app/api/query/stream/route.ts:282`; if that changed, HALT).

**Never:**
- Do not change `callLLMStream` / `callLLM` signatures or the frozen single whole-stream deadline mechanism (`src/lib/llm.ts`).
- Do not touch `/api/query/stream` or `LLM_LENGTH_CAP_COPY` — that sentence is query-scoped ("Ask again for a narrower part of the question") and false for research, which writes nothing.
- Do not make a `finish` with any other `finishReason` fatal, and do not make an `error` part fatal when the stream continued past it.
- Do not remove the existing `callLLM` fallback for a stream that died before emitting anything.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Brief fits | deltas, then `finish`/`stop` | Run completes; page committed | No error expected |
| Cap cut it (DW-663) | deltas, then `finish`/`length` | Run `failed`, nothing written | Throws `LLM_RESEARCH_LENGTH_CAP_COPY` |
| Cap cut it, deadline configured | same, `getLlmTimeoutMs()` set | Same sentence — the gate does not apply | Throws `LLM_RESEARCH_LENGTH_CAP_COPY` |
| Error ENDS the stream (DW-664) | deltas, then `{type:"error"}`, nothing after | Run `failed`, nothing written | Throws `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`; SDK words logged, not shown |
| Error ends stream, deadline configured | same, timeout set | Same cut-short sentence, NOT the deadline one | Throws `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` |
| Warning-shaped error | delta, `error`, delta, `finish`/`stop` | Run completes; page committed (unchanged) | No error expected |
| Cancelled at the cut | owner cancels as the `length`/error ending lands | Run `cancelled`, not `failed` | `ResearchCancelledError` rethrown untouched |
| Deadline abort | `abort` part / deadline `error` part | Unchanged DW-544 behaviour | Deadline or cut-short sentence per gate |

</intent-contract>

## Code Map

- `src/lib/research-runtime.ts:1318-1397` -- `synthesizeResearchBrief`. The `fullStream` loop opens at :1329; the fatal abort/deadline branch at :1330-1342; the "warning-shaped" and KNOWN-GAP comments at :1343-1354; `if (part.type !== "text-delta") continue` at :1355; `return raw || await stream.text` at :1374; the catch with `receivedStreamContent` and the `callLLM` fallback at :1375-1396.
- `src/lib/research-runtime.ts:1327` -- `callLLMStream(system, user, { maxOutputTokens: 7_000 })`, the cap a `length` finish reports; repeated at :1383 for the fallback.
- `src/lib/research-runtime.ts:1280-1284` -- `streamCutShortMessage()`, the deadline-gated sentence picker. The new endings do NOT go through it.
- `src/lib/llm-deadline.ts:91-95` -- `LLM_DEADLINE_RESEARCH_COPY`; `:120-122` -- `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` (reuse target, doc needs widening); `:143-145` -- `LLM_LENGTH_CAP_COPY` (query-scoped, the shape to mirror, NOT to reuse); `:34-39` -- the module header's Settings-pointer dividing line, which lists which constants get no pointer.
- `src/app/api/query/stream/route.ts:282` -- read-only precedent: `part.type === "finish" && part.finishReason === "length"`, with the ungated rationale at :268-281.
- `src/lib/__tests__/research-runtime.test.ts:2310-2530` -- the DW-544 suite. `:2422` is the test asserting the cap gap COMMITS (must be inverted); `:2400` is the warning-shaped-error test (must keep passing); `:2508` opens the sentence suite to extend. Helpers `fakeStream`, `delta`, `project`, `abortError`, `GOOD_BRIEF`, `mockedTimeout`, `mockedWritePage` are defined earlier in the file.
- `src/lib/__tests__/query-stream-deadline.test.ts:379-406` -- read-only: the copy assertions to mirror for the new research constant.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm-deadline.ts` -- add `LLM_RESEARCH_LENGTH_CAP_COPY`: research-scoped, states the run is incomplete, says nothing was written to the wiki, tells the owner to ask a narrower research question and run it again. No Settings pointer, no transport vocabulary (`finishReason`, `token`, `maxOutputTokens`, `aborted`, `signal`). Docblock states why it is ungated and why `LLM_LENGTH_CAP_COPY` is not reused. Widen `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`'s docblock to record its second, ungated use (a stream-ending non-deadline `error`), and add the new constant to the module header's no-pointer list.
- `src/lib/research-runtime.ts` -- in `synthesizeResearchBrief`, fail on `finish`/`length` and on an `error` part that ends the stream: track the last non-deadline `error` part, clear that tracking on any subsequent part (proof the stream continued), and after the loop throw the cut-short sentence if one is still pending. Log the SDK error object through `logger.warn` so diagnostics survive while the panel reads the constant. Replace the KNOWN-GAP and "warning-shaped" comments with what the code now does and why the deltas-after-error case still commits.
- `src/lib/__tests__/research-runtime.test.ts` -- invert the cap test to assert failure, add the deadline-configured variant, add stream-ending-`error` tests (with and without a deadline configured, asserting the SDK's words are absent from `project.error`), keep the warning-shaped-error test, and extend the sentence suite to cover `LLM_RESEARCH_LENGTH_CAP_COPY`.

**Acceptance Criteria:**
- Given a synthesis stream whose last part is `finish` with `finishReason: "length"`, when the run executes, then `runResearchProject` rejects with `LLM_RESEARCH_LENGTH_CAP_COPY`, the project ends `failed` with that exact string as `error`, and `writePage` was never called.
- Given a synthesis stream whose last part is a non-deadline `error`, when the run executes, then it fails with `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` and no page is written, whether or not an LLM timeout is configured.
- Given a synthesis stream with a non-deadline `error` followed by further deltas and a `finish`/`stop`, when the run executes, then it completes and the page is committed — unchanged from today.
- Given the owner cancels while either new ending lands, when the run resolves, then its status is `cancelled` and no failure sentence replaces it.
- Given the two research sentences, when inspected, then neither contains a Settings pointer or `SETTINGS_LABEL`, both contain "Nothing was written", and neither contains `finishReason`, `token`, `maxOutputTokens`, `aborted`, or `signal`.

## Design Notes

An `error` part is remembered, not thrown on immediately, because the two shapes are indistinguishable at the moment the part arrives — only what follows tells them apart:

```ts
for await (const part of stream.fullStream) {
  // Any part at all proves the error part before it did not end the stream.
  pendingStreamError = null;
  ...
  if (part.type === "error") { pendingStreamError = { error: part.error }; continue; }
  if (part.type === "finish" && part.finishReason === "length") { /* fatal */ }
  ...
}
if (pendingStreamError) { /* the stream ended ON that error — fatal */ }
```

Both new throws sit INSIDE the existing `try`, so they inherit its rules: `receivedStreamContent` is true in the ordinary case (deltas arrived), which rethrows without buying a second synthesis; an ending with no text at all still takes the pre-existing `callLLM` fallback for a stream that died before saying anything.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/research-runtime.test.ts` -- expected: all pass, including the inverted cap test and the new stream-ending-error tests.
- `npx vitest run src/lib/__tests__/query-stream-deadline.test.ts` -- expected: all pass; the query route's `length` handling and `LLM_LENGTH_CAP_COPY` are untouched.
- `npx tsc --noEmit` -- expected: no errors.
- `npm run lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `synthesizeResearchBrief` now fails the research run on the two stream endings that used to fall through its `fullStream` loop's bookkeeping tail and commit a fragment as a finished wiki page: a `finish` carrying `finishReason: "length"` (the 7,000-token output cap CUT the brief — DW-663), and a non-deadline `error` part that ends the stream (DW-664). Both fail closed with research-scoped owner copy that names no field the owner does not have, and cancellation still outranks both.

**Files changed.**
- `src/lib/llm-deadline.ts` — new `LLM_RESEARCH_LENGTH_CAP_COPY` (research-scoped, ungated, no Settings pointer); `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`'s docblock widened to its second, ungated use; module header prose brought up to five sentences and corrected on the two caps.
- `src/lib/research-runtime.ts` — the two new fatal endings in `synthesizeResearchBrief`, with a `pendingStreamError` / `sawCleanFinish` discriminator that tells a stream-ending error from a warning-shaped one, and `logger.warn` carrying the SDK's cause to the operator.
- `src/lib/__tests__/research-runtime.test.ts` — the old "known gap" cap test inverted to assert failure, plus cap/error endings with and without a deadline configured, the `ai@6` post-error bookkeeping shape, both cancellation orderings, the zero-delta fallback boundary, and the widened sentence-invariant suite.

**Review findings breakdown.** 7 patches applied (1 high, 3 medium, 3 low); 1 item deferred (low); 9 rejected.

**Follow-up review recommendation:** `true` — a `high`-severity finding was patched this pass. Patched counts: high 1, medium 3, low 3; score `3 × 3 + 1 × 3 = 12`, and the high alone already sets it.

**Verification performed.**
- `npx vitest run src/lib/__tests__/research-runtime.test.ts src/lib/__tests__/query-stream-deadline.test.ts src/lib/__tests__/query-route.test.ts` — 171 passed, 1 skipped (the pre-existing `TAVILY_API_KEY`-gated skip).
- `npx tsc --noEmit` — exit 0.
- `npm run lint` — clean apart from the pre-existing `jsx-ast-utils` TSNonNullExpression notices, which predate this change.
- The high-severity patch was mutation-checked: relaxing the new guard so any `finish` clears a pending error fails exactly the test that pins the `ai@6` provider-error shape.
- Matrix audit: every I/O matrix row has a covering test that ran and passed.

**Residual risks.**
- The zero-text boundary is pinned rather than closed: an ending that arrives before any `text-delta` still takes the pre-existing `callLLM` fallback, which passes the same cap and cannot observe it. Recorded in frontmatter `deferred`.
- `/api/query/stream` still drops a non-deadline `error` part (`src/app/api/query/stream/route.ts:286-289`). DW-664's SDK premise applies there too, so a query whose stream ends on such a part closes with a half answer and no notice. Pre-existing and out of scope for an intent naming `research-runtime.ts` only; left untouched deliberately.
- `finishReason` values `content-filter` and `other` remain non-fatal, as this spec's Never list requires.
