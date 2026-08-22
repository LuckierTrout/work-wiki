---
title: 'DW-64 — a fired LLM deadline speaks to the owner on /api/query/stream'
type: 'bugfix'
created: '2026-08-21'
baseline_revision: 'f214130fcba45b47bfc8a1475f55deba634ae6f0'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The 504 deadline sentence never reaches the owner: the client falls back to
      POST /api/query on any non-ok answer, and that route still relays the raw
      transport message.
    evidence: |-
      src/hooks/useStreamingQuery.ts:129-155 re-issues the non-streaming query on
      `!res.ok` and shows `fallbackData?.error ?? errMsg`; src/app/api/query/route.ts:74-82
      answers `getErrorMessage(error)` at 500. A deadline that fires on both attempts
      therefore shows "The operation was aborted due to timeout" from the fallback.
      Pre-existing, and out of scope by the frozen decision, which names the stream
      route only.
    location: >-
      src/app/api/query/route.ts:74
    severity: medium
  - summary: >-
      A deadline-truncated answer is recorded by the client as a complete one, now
      with the deadline sentence saved inside the answer text.
    evidence: |-
      The mid-stream path closes at 200, so useStreamingQuery never sets an error;
      it runs extractCitedSlugs over the partial text and calls onComplete with it
      (src/hooks/useStreamingQuery.ts:167-200), which is what query history persists.
      Making the truncation visible is this change's point; persisting the notice as
      model output is the residue.
    location: >-
      src/hooks/useStreamingQuery.ts:167
    severity: medium
  - summary: >-
      A fired deadline inside the retrieval re-rank is swallowed, so it degrades
      answer quality silently instead of surfacing.
    evidence: |-
      src/lib/query-search.ts:250-253 catches every re-rank error (`logger.warn`, fall
      through to fusion results), and the vector half does the same at :194-200. This
      is why the route's own 504 arm has no reachable pre-stream door today: a
      configured deadline that fires during retrieval is absorbed, and the owner is
      answered from BM25 fusion with no sign that the re-rank never ran. Pre-existing.
    location: >-
      src/lib/query-search.ts:250
    severity: low
  - summary: >-
      An answer cut off by the output-token cap still ends silently — the same
      owner-facing silence a deadline used to produce.
    evidence: |-
      The stream carries `finish` with `finishReason: "length"` when QUERY_MAX_OUTPUT_TOKENS
      is reached; nothing in the route or the client says so, so the answer simply stops
      mid-sentence. Same defect shape as DW-64's mid-stream half, different cause, and
      out of scope for a decision about the LLM deadline.
    location: >-
      src/app/api/query/stream/route.ts:255
    severity: low
---

<intent-contract>

## Intent

**Problem:** On `POST /api/query/stream` a fired LLM deadline reaches the owner as transport vocabulary or as silence: fired during retrieval it throws a `TimeoutError` the route's catch relays verbatim (`The operation was aborted due to timeout`); fired during the answer it becomes an AI SDK `abort` part that `toTextStreamResponse` drops, so the answer just stops mid-sentence.

**Approach:** Per the frozen decision (option 2, "Keep deadline, fix the copy"), leave the deadline's semantics untouched and map `TimeoutError`/`AbortError` to ONE owner-facing sentence inside `src/app/api/query/stream/route.ts` — a 504 JSON answer when nothing was produced, the same sentence appended to the partial answer when it fires mid-stream. Pin both with tests.

## Boundaries & Constraints

**Always:** One sentence, defined once in the route, true of both surfaces, naming the Settings control ("LLM timeout") and free of transport vocabulary (no `abort`, no `operation was aborted`, no `signal`). Non-deadline failures keep today's behaviour exactly: a thrown one still answers 500 with `getErrorMessage(error)`; a non-deadline `error` part stays ignored as `toTextStreamResponse` ignores it. `X-Wiki-Sources` and `text/plain; charset=utf-8` survive the response rewrite.

**Block If:** the deadline's semantics (whole-stream vs time-to-first-chunk) would have to change to make the copy true — the decision froze the semantics, so a change there is out of this run's authority.

**Never:** touch `src/lib/llm.ts`, `src/lib/config.ts`, or the retry wrapper; re-map copy in `src/app/api/query/route.ts` (the decision names the stream route only); change `useStreamingQuery`; edit `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Answer streams normally | `fullStream` yields text deltas then finishes | 200, `text/plain; charset=utf-8`, deltas concatenated, `X-Wiki-Sources` present | No error expected |
| Deadline fires before the stream | a retrieval door rejects with `name: "TimeoutError"` | 504 JSON `{ error: <the sentence> }` | The raw `The operation was aborted due to timeout` never reaches the body |
| Explicit abort before the stream | rejection with `name: "AbortError"` | Same 504 and same sentence | Same |
| Deadline fires mid-answer | `fullStream` yields deltas, then `{ type: "abort" }` | 200, partial text followed by a blank line and the sentence, stream closed cleanly | Body is never errored |
| Deadline surfaces as an `error` part | `{ type: "error", error: TimeoutError }` | Same as mid-answer abort | Same |
| Non-deadline throw | a door rejects with `new Error("boom")` | 500 JSON `{ error: "boom" }` — unchanged | Logged as today |
| Non-deadline `error` part | `{ type: "error", error: Error("boom") }` | Ignored; stream ends with whatever text arrived — unchanged | No sentence appended |

</intent-contract>

## Code Map

- `src/app/api/query/stream/route.ts` — the ONLY production file to change. `POST` ends with `callLLMStream(...)` then `result.toTextStreamResponse({ headers: { "X-Wiki-Sources": ... } })`; the outer `catch` relays `getErrorMessage(error)` at 500. Retrieval (`selectPagesForQuery`, `buildContext`, `buildQuerySystemPrompt`) is where a fired deadline throws INTO that catch.
- `src/lib/config.ts:1171-1197` (`llmTimeoutOption` — an `AbortSignal.timeout`, hence `TimeoutError`) and `src/lib/llm.ts:544-560` (`callLLMStream` spreads it into `streamText`) — read-only context.
- `node_modules/ai/dist/index.mjs:6843-6872` — verified: with `abortSignal.aborted`, streamText enqueues `{ type: "abort" }` and CLOSES the stream rather than erroring it; `TextStreamPart` (dist/index.d.ts) carries `abort` and `error` variants; `toTextStreamResponse` forwards only `text-delta` (hence today's silence) and sets `text/plain; charset=utf-8`.
- `src/lib/workbench-request.ts:107-150` — prior art: `unconfirmedCause` classifies on `name === "TimeoutError" || name === "AbortError"`; `unconfirmedWriteMessage` is ONE sentence true of every cause. Mirror the shape, not the wording.
- `src/components/workbench/SettingsCanvas.tsx:569` — the control reads `LLM timeout (seconds)`, so the sentence may name it.
- `src/lib/__tests__/query-stream-route.test.ts` — extend it. Its `callLLMStream` mock returns a bare async generator (no `fullStream`); that default must become a `{ fullStream }` shape.
- Route files here export handlers only — keep the copy constant module-private and pin its text literally in the test.

## Tasks & Acceptance

**Execution:**
- `src/app/api/query/stream/route.ts` — add a module-private deadline classifier (`Error` whose `name` is `TimeoutError` or `AbortError`) and copy constant; in the outer `catch`, answer 504 with the sentence on a match, leaving every other error on today's 500 + `getErrorMessage` path.
- `src/app/api/query/stream/route.ts` — replace `toTextStreamResponse` with an equivalent text response built from `result.fullStream`: forward `text-delta` text, and on an `abort` part (or an `error` part whose error the classifier matches) append `\n\n` + the sentence and close. Keep the `X-Wiki-Sources` header and the `text/plain; charset=utf-8` content type. Rationale: the SDK closes an aborted stream cleanly, so the sentence cannot be added from a `catch`.
- `src/lib/__tests__/query-stream-route.test.ts` — fix the `callLLMStream` mock to the real `{ fullStream }` shape, then cover every I/O-matrix row, asserting the sentence verbatim and that `The operation was aborted due to timeout` appears nowhere.

**Acceptance Criteria:**
- Given a deadline that fires before any text is produced, when the owner asks a question, then the response is 504 and its `error` is the one sentence, which names the LLM timeout in Settings and contains neither `abort` nor `aborted`.
- Given a deadline that fires after part of the answer streamed, when the owner reads the answer, then the partial text is followed by a blank line and that same sentence, the response status is 200, and the body is closed rather than errored.
- Given a failure that is not a deadline, when the route handles it, then status and message are exactly what they were before this change.

## Design Notes

One sentence, both surfaces — the phrasing has to be true when nothing was produced AND when half an answer stands:

```ts
const QUERY_DEADLINE_COPY =
  "This answer ran past the LLM timeout set in Settings and stopped " +
  "before it was finished. Ask again, or raise that limit in Settings.";
```

Accepted residue (out of scope): on any non-ok answer the client falls back to `POST /api/query` (src/hooks/useStreamingQuery.ts:129-155), which still relays `getErrorMessage(error)` raw — so a deadline that fires on both attempts can still show the transport sentence. The decision names the stream route only.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/query-stream-route.test.ts` — expected: all tests pass, including the new deadline rows.
- `pnpm exec tsc --noEmit` — expected: no new errors.
- `pnpm exec eslint src/app/api/query/stream/route.ts src/lib/__tests__/query-stream-route.test.ts` — expected: clean.

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 4, low 8)
- defer: 4: (high 0, medium 2, low 2)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[medium]` `[patch]` A deadline firing before any `text-delta` emitted a body of two leading newlines plus the sentence — a `sentAnyText` flag and a single `deadlineTail()` helper now drop the separator when no partial answer stands in front of it.
  - `[medium]` `[patch]` No test drove an abort with no preceding text; one now pins the bare-sentence body.
  - `[medium]` `[patch]` Neither branch of the in-`pull` catch was exercised — two tests now reject the iterator, with a deadline (clean close + sentence) and with a plain error (body errors).
  - `[medium]` `[patch]` `cancel` was untested; a test now cancels a partly-read body and asserts the iterator was finalized.
  - `[low]` `[patch]` `parts.return?.()` could reject and turn a clean close into an errored body (or an unhandled rejection from `cancel`) — both calls now go through a swallowing `endParts()`.
  - `[low]` `[patch]` The mid-stream deadline branch was invisible to operations; it now logs `logger.warn("query", ...)` with `sentAnyText`.
  - `[low]` `[patch]` `isDeadlineError` ignored a wrapped abort — it now checks exactly one level of `.cause`, with a test.
  - `[low]` `[patch]` Docblock wording reflowed where "part part-way" read as a duplication.
  - `[low]` `[patch]` The copy test asserted a constant against itself; the owner-facing properties are now asserted on real 504 and mid-stream response bodies.
  - `[low]` `[patch]` Test doubles used a plain `Error` with a reassigned name; a real `DOMException(..., "TimeoutError")` now drives the primary 504 and iterator-rejection cases.
  - `[low]` `[patch]` `setStream` handed out an already-constructed generator; it and the `beforeEach` default now use `mockImplementation` so every call builds a fresh stream.
  - `[low]` `[patch]` The mid-stream response asserted no headers; it now pins `text/plain; charset=utf-8` and `X-Wiki-Sources`.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `POST /api/query/stream` now speaks to the owner when the configured LLM deadline fires, on both surfaces and in one sentence: `This answer ran past the LLM timeout set in Settings and stopped before it was finished. Ask again, or raise that limit in Settings.` A `TimeoutError`/`AbortError` thrown before any text answers 504 with that sentence instead of relaying `The operation was aborted due to timeout`; a deadline that fires mid-answer — which the AI SDK delivers as an `abort` part on a cleanly closing stream, not as a throw — appends the same sentence to the partial answer instead of stopping silently. The deadline's whole-stream semantics are untouched, as the frozen decision requires: `src/lib/llm.ts` and `src/lib/config.ts` are unmodified.

**Files changed.**
- `../../src/app/api/query/stream/route.ts` — the deadline classifier (`isDeadlineError`, one level of `.cause`), the sentence, the 504 arm in the outer catch, and a pull-driven `ReadableStream` over `result.fullStream` that replaces `toTextStreamResponse` so the `abort` part is visible; `text/plain; charset=utf-8` and `X-Wiki-Sources` are preserved, `cancel` finalizes the iterator.
- `../../src/lib/__tests__/query-stream-route.test.ts` — the `callLLMStream` mock now carries the real `{ fullStream }` shape (it previously returned a bare async generator, so every "successful" case was silently exercising the 500 path), plus 12 tests covering every I/O-matrix row and the review's added cases.

**Review findings.** 12 patches applied (4 medium, 8 low), 4 items deferred (2 medium, 2 low — see frontmatter `deferred`), 13 rejected. No intent gaps and no spec repairs; `review_loop_iteration` stayed 0.

**Follow-up review recommendation:** `true`. Patched findings this pass: 0 high, 4 medium, 8 low → 3 × 4 + 1 × 8 = 20, at or above the threshold of 5.

**Verification.** `pnpm` is unusable in this environment (a `pnpm-workspace.yaml` in the user's home directory has no `packages` field, so every `pnpm exec` fails with `packages field missing or empty` — pre-existing and unrelated); the binaries were run directly from `node_modules/.bin`.
- `vitest run src/lib/__tests__/query-stream-route.test.ts` — 17 passed.
- `vitest run` (whole suite) — 274 files, 6259 tests, all passed.
- `tsc --noEmit` — exit 0. `eslint` on both changed files — exit 0.
- Matrix audit: every row of the I/O & Edge-Case Matrix is covered by a test that ran and passed in that output.

**Residual risks.**
- The 504 arm has no reachable pre-stream door today: retrieval's only LLM call swallows its own errors (`src/lib/query-search.ts:250-253`), so the branch is currently defensive. It is what the decision asked for and costs nothing; the mid-stream path is where a fired deadline actually lands.
- Even when it does fire, the client discards a non-ok body and retries `POST /api/query`, whose raw message wins — deferred above, and out of scope by the decision.
- The response body is now assembled in the route rather than by the SDK helper. Parity was checked against `createTextStreamResponse` (status, content type, nothing else) and pinned by tests, but any future SDK change to part shapes lands here rather than behind the helper.
