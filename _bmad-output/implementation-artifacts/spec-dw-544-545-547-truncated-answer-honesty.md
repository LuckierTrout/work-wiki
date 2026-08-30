---
title: 'DW-544/545/547: never present a truncated or deadline-ended answer as a finished one'
type: 'bugfix'
created: '2026-08-30'
baseline_revision: '9cdf1dcee545012f923caaaaa7fc886f510fb6c4'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `/api/query` still returns a cap-truncated answer as a finished one — the
      silent truncation DW-547 closed for the streaming route only.
    evidence: |-
      `src/lib/query.ts:349` passes the same `QUERY_MAX_OUTPUT_TOKENS` to
      `callLLM`, and `callLLM` (`src/lib/llm.ts`) destructures only `{ text }`
      from `generateText`, discarding `finishReason` entirely. So a capped
      answer on this route simply ends, looking whole. Not a dead path:
      `useStreamingQuery` sends `slides` and `html` here ALWAYS
      (`src/hooks/useStreamingQuery.ts:105-119`) and falls back to it on any
      non-2xx from the stream route. Closing it needs `callLLM` to surface
      `finishReason`, which this intent's third sentence scopes to
      `src/app/api/query/stream/route.ts` and the spec's Never list forbids.
    location: >-
      src/lib/query.ts:349
    severity: medium
  - summary: >-
      A research brief truncated by its own 7,000-token output cap is still
      committed as a finished wiki page.
    evidence: |-
      `synthesizeResearchBrief` (`src/lib/research-runtime.ts:1239`) ignores the
      `finish` part, so `finishReason: "length"` — which means the brief was CUT
      at the budget `callLLMStream` was given, not that it fit — falls through
      and `raw` commits. Same owner-visible failure as DW-544 (half a brief
      published as a whole one) from the cap rather than the deadline. Left as
      it was because the intent scopes research to "an abort or deadline error
      part"; the code comment and the covering test now say so explicitly
      instead of claiming the brief finished under its budget.
    location: >-
      src/lib/research-runtime.ts:1239
    severity: medium
  - summary: >-
      A non-deadline `error` part that ENDS the synthesis stream still commits a
      truncated research brief.
    evidence: |-
      `src/lib/research-runtime.ts:1217` fails only on an `error` part
      `isLlmDeadlineAbort` accepts; every other one is skipped as
      "warning-shaped". `ai@6` closes the source after an `error` part (the same
      SDK fact DW-64 relied on for its iterator argument), so an error part that
      terminates the stream ends the `for await` normally and the partial `raw`
      flows into `commitResearchPage`. The new suite only models an `error` part
      followed by more deltas and a `finish`. Pre-existing — `textStream` dropped
      those parts too — and outside an intent naming abort and deadline error
      parts only.
    location: >-
      src/lib/research-runtime.ts:1217
    severity: medium
  - summary: >-
      The research run's other `callLLM` calls still put SDK transport
      vocabulary in the owner-visible `project.error`.
    evidence: |-
      Evidence condensation (`src/lib/research-runtime.ts:1335`) and
      hierarchical reduction (`:1397`) run under the same `llmTimeoutOption()`,
      and `retryWithBackoff` rethrows the original error unwrapped, so a fired
      deadline there reaches `runResearchProject`'s catch as
      "The operation was aborted due to timeout" and
      `src/components/workbench/ResearchCanvas.tsx:374` renders it verbatim.
      Only the synthesis stream and its fallback were in DW-544's scope, so the
      "no transport vocabulary in the research panel" property is true of the
      synthesis, not of the run.
    location: >-
      src/lib/research-runtime.ts:1335
    severity: medium
  - summary: >-
      The stream route still closes silently for a `finish` whose reason is
      `content-filter`, `error` or `other`.
    evidence: |-
      `src/app/api/query/stream/route.ts:282` branches on `length` alone; every
      other non-`stop` reason falls into the bookkeeping tail and the body just
      ends — a half answer reading as a whole one, which is DW-547's own
      failure from a third cause. `content-filter` is the concrete one: the
      model stopped, the owner is told nothing. The intent names
      `finishReason === "length"`, and the covering tests deliberately pin the
      other reasons as emitting nothing.
    location: >-
      src/app/api/query/stream/route.ts:282
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three surfaces still end an answer early without saying so. `synthesizeResearchBrief` (`src/lib/research-runtime.ts:1162`) iterates `stream.textStream`, which drops the `{ type: "abort" }` part `ai@6` emits when the owner's LLM deadline fires — the `for await` ends NORMALLY, so a truncated brief is committed as a finished wiki page. `/api/query` returns `getErrorMessage(error)` verbatim, so the same deadline reaches the owner as transport vocabulary ("The operation was aborted due to timeout") — and because `useStreamingQuery` re-queries that route on any non-2xx and PREFERS its message, those words also overwrite the sentence `/api/query/stream` already emits. And the `QUERY_MAX_OUTPUT_TOKENS` cap truncates a streamed answer as silently as the deadline used to: `finishReason: "length"` arrives on the `finish` part and falls into the route's bookkeeping tail, so the body simply ends.

**Approach:** Extend the DW-64 machinery to the three surfaces it stopped one branch short of. `synthesizeResearchBrief` reads `fullStream` the way the query stream route does and FAILS the run on an abort or a deadline-carrying `error` part, so nothing truncated is written. `/api/query` maps a deadline it owns to the same `LLM_DEADLINE_COPY` the stream route emits. The stream route gains one more branch — `finish` with `finishReason === "length"` — closing with a cap-specific notice. The shared `ownDeadline` predicate moves into `src/lib/llm-deadline.ts` so both routes ask the identical question.

## Boundaries & Constraints

**Always:** Every owner-facing sentence is an exported constant in `src/lib/llm-deadline.ts`, with any Settings destination composed via `settingsPointer("llm-models", SETTINGS_LABEL)` (DW-369) and never hand-typed — in sources or in tests. Deadline sentences stay gated on `llmDeadlineConfigured()`: naming a limit the owner never set is the dead end that gate exists to close. The deadline MECHANISM stays frozen (2026-08-21, DW-64): no retry wrapper, no per-token deadline, no change to `llmTimeoutOption`/`getLlmTimeoutMs`. Research keeps streaming token-by-token and keeps its existing thinking flush, its `requireResearchActive` cancellation check per text part, and its `callLLM` fallback for a stream that died before emitting anything.

**Block If:** `fullStream`'s `finish` part turns out not to carry `finishReason` in the installed `ai` version, or `text-delta` parts are not what `textStream` was yielding for research — either would mean the SDK contract this rests on is not what `node_modules/ai/dist/index.d.ts` shows.

**Never:** Do not change `src/hooks/useStreamingQuery.ts`, `src/lib/llm.ts` behaviour (docblock only), `src/lib/config.ts`, or `QUERY_MAX_OUTPUT_TOKENS` itself. Do not make research fail on a `finish`/`length` cap or on a non-deadline `error` part — the intent names abort and deadline-error parts there, and a research brief that fits under its own cap today must keep committing. Do not add a Settings pointer to the cap sentence: `QUERY_MAX_OUTPUT_TOKENS` is a source constant, not a control the owner can raise. Do not export anything but HTTP handlers from either `route.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Research brief aborted mid-synthesis | `fullStream` yields deltas then `{ type: "abort" }`, deadline configured | Run fails: no `writeWikiPageWithSideEffects`, project `error` is `LLM_DEADLINE_RESEARCH_COPY`, no `callLLM` retry | Thrown from `synthesizeResearchBrief`, surfaced by `runResearchProject`'s catch |
| Research brief aborted, NO deadline configured | Same, `getLlmTimeoutMs()` is `null` | Same failure, message is `LLM_STREAM_CUT_SHORT_COPY` (no Settings pointer) | Same |
| Research deadline on an `error` part | Deltas then `{ type: "error", error: TimeoutError }` | Same as the abort rows | Same |
| Research abort before any token | First part is `{ type: "abort" }` | `receivedStreamContent` is false, so the existing `callLLM` fallback still runs | If that call rejects with a deadline the run fails with `LLM_DEADLINE_RESEARCH_COPY`, not transport words |
| Research non-deadline `error` part | `{ type: "error", error: Error("warning-shaped") }` mid-stream | Ignored exactly as today; the brief completes and commits | No error |
| Research happy path | Deltas then `{ type: "finish", finishReason: "stop" }` | Unchanged: thinking flushes, page commits, `callLLM` never called | No error |
| `/api/query` deadline | `query()` rejects with `TimeoutError`/`AbortError`, deadline configured | `500` with `{ error: LLM_DEADLINE_COPY }` | Logged by the existing `catch` |
| `/api/query` non-deadline failure, or no deadline configured | Any other rejection | `500` with `getErrorMessage(error)`, exactly as today | Unchanged |
| Stream route hits the output cap | `{ type: "finish", finishReason: "length" }` after deltas | Body is the deltas, a blank line, then `LLM_LENGTH_CAP_COPY`; 200, headers unchanged | `logger.warn("query", …)` once |
| Stream route finishes normally | `{ type: "finish", finishReason: "stop" }` | Body is the deltas alone, no notice | No error |
| Cap fires with no deadline configured | `finish`/`length`, `getLlmTimeoutMs()` is `null` | Notice still emitted — the cap is always installed, so it is never someone else's | Same log |

</intent-contract>

## Code Map

- `src/lib/llm-deadline.ts` — the copy owner (DW-64). Holds `LLM_DEADLINE_COPY`, `isLlmDeadlineAbort`, `llmDeadlineConfigured`. Gains `isOwnLlmDeadline` (moved verbatim in spirit from the route's module-scope `ownDeadline`), `LLM_DEADLINE_RESEARCH_COPY`, `LLM_STREAM_CUT_SHORT_COPY`, `LLM_LENGTH_CAP_COPY`. Its module docblock must be widened: it is now the home for "why a streamed answer stopped early", not the deadline alone. The FILENAME stays — `src/lib/llm.ts:609` and DW-64's spec name it.
- `src/app/api/query/stream/route.ts:38-40` — `ownDeadline`, to be replaced by the import. `:203-262` — the `ReadableStream` `pull` loop; `closeWithNotice` at `:192-201` takes the copy as a parameter and the `finish`/`length` branch goes beside the existing `abort`/`error` branch at `:243-249`. `:280-296` — the `catch` already maps a pre-stream deadline.
- `src/app/api/query/route.ts:73-81` — the `catch`. One conditional, mirroring the stream route's.
- `src/lib/research-runtime.ts:1150-1188` — `synthesizeResearchBrief`. `receivedStreamContent` at `:1157` suppresses the `callLLM` fallback at `:1186`; `raw` flows through `runResearchProject` (`:1636`) into `commitResearchPage` (`:1667`). `runResearchProject`'s catch (`:1705-1723`) turns a throw into `status: "failed"`, `error: message`, "Research failed. Nothing was written to the wiki." — the message is owner-visible, which is why it must be copy, not `error.message` from the SDK.
- `node_modules/ai/dist/index.d.ts:2601-2694` — the frozen `TextStreamPart` union: `finish` carries `finishReason: FinishReason` (`'stop' | 'length' | …`, `:108`), `abort` carries `reason?`, `error` carries `error: unknown`. `index.mjs:7690-7702` — `textStream` enqueues `text-delta` only and drops `abort` AND `error` silently, which is the whole bug on the research side.
- `src/lib/constants.ts:160` — `QUERY_MAX_OUTPUT_TOKENS = 8192`. Read-only, and NOT owner-settable: nothing in `SettingsCanvas` writes it, so the cap sentence must not point at Settings.
- `src/hooks/useStreamingQuery.ts:129-155` — read-only evidence for DW-545: `setError(fallbackData?.error ?? errMsg)` prefers `/api/query`'s message over the stream route's, so fixing that route is what makes the sentence actually arrive.
- `src/lib/__tests__/query-stream-deadline.test.ts` — the DW-64 suite and the fixture shape to extend (`fakeResult`, `delta`, `abortError`, the `getLlmTimeoutMs` partial mock via `importOriginal`).
- `src/lib/__tests__/research-runtime.test.ts:36-42` mocks `../llm`; `:871`/`:888` are the only two `textStream` fixtures in the repo and must become `fullStream`. `:167` sets the default rejection. The suite does NOT mock `../config` today — a partial mock defaulting `getLlmTimeoutMs` to `null` preserves every existing row.
- `src/lib/__tests__/query-route.test.ts` — the `/api/query` suite; mocks `@/lib/query`, `@/lib/auth`, `@/lib/logger`, and needs the same `@/lib/config` partial mock for the DW-545 rows.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm-deadline.ts` -- Widen the module docblock to own every "this answer stopped early" sentence, and add: `isOwnLlmDeadline(cause)` = `llmDeadlineConfigured() && isLlmDeadlineAbort(cause)` (with the route's existing rationale moved here); `LLM_DEADLINE_RESEARCH_COPY` (deadline, nothing written, run it again); `LLM_STREAM_CUT_SHORT_COPY` (a cut stream with no deadline configured — no Settings pointer); `LLM_LENGTH_CAP_COPY` (the answer hit the maximum length — no Settings pointer, since the cap is a source constant). -- One home, one composition of the pointer; two callers must not each own a copy of the predicate.
- `src/app/api/query/stream/route.ts` -- Import `isOwnLlmDeadline` and drop the local `ownDeadline`; give `closeWithNotice` a copy parameter plus its own log line; add a branch on `part.type === "finish" && part.finishReason === "length"` that closes with `LLM_LENGTH_CAP_COPY`, ungated (the cap is always installed). -- DW-547; the notice machinery was one branch away.
- `src/app/api/query/route.ts` -- In the `catch`, return `LLM_DEADLINE_COPY` when `isOwnLlmDeadline(error)`, else `getErrorMessage(error)` as today. -- DW-545; this is the route `useStreamingQuery` prefers, so it is where the owner actually reads the sentence.
- `src/lib/research-runtime.ts` -- `synthesizeResearchBrief`: iterate `stream.fullStream`; on `abort`, or an `error` part `isLlmDeadlineAbort` accepts, throw `LLM_DEADLINE_RESEARCH_COPY` / `LLM_STREAM_CUT_SHORT_COPY` (by `llmDeadlineConfigured()`); handle only `text-delta` parts as today (cancellation check per part, empty deltas still not counting as content) and ignore the rest; wrap the `callLLM` fallback so a deadline there is reported in the same words. -- DW-544; the run must fail rather than commit a half brief.
- `src/lib/llm.ts` -- Docblock only on `callLLMStream`: `synthesizeResearchBrief` is no longer the unmapped second caller; both readers now map the abort. -- The paragraph currently states the opposite as a live fact.
- `src/lib/__tests__/query-stream-deadline.test.ts` -- Add a DW-547 describe: cap notice after text, cap notice with no deadline configured, `finishReason: "stop"` emits nothing, and constant-shape assertions (no Settings pointer, no `finishReason`/token vocabulary). -- Every new I/O Matrix row for the stream route.
- `src/lib/__tests__/query-route.test.ts` -- Add a DW-545 describe with the `@/lib/config` partial mock: deadline ⇒ `LLM_DEADLINE_COPY` at 500; non-deadline and no-deadline-configured ⇒ the error's own words. -- The two `/api/query` rows.
- `src/lib/__tests__/research-runtime.test.ts` -- Convert the two `textStream` fixtures to `fullStream`, add the `@/lib/config` partial mock defaulting to `null`, and add rows for: abort after content (fails, writes nothing, no `callLLM`), deadline `error` part, abort with no deadline configured, non-deadline `error` part still ignored. -- The research half of the I/O Matrix.

**Acceptance Criteria:**
- Given a research synthesis stream that aborts after emitting text, when the run finishes, then `writeWikiPageWithSideEffects` was never called and the project's stored `error` is an imported constant, not `error.message` from the SDK.
- Given any sentence this change adds, when the files this change touches are searched, then the composed string `Settings → LLM Models` appears as a literal in none of them (four pre-existing hits elsewhere — `workbench-settings.ts` and three suites — are baseline and out of scope), and the cap sentence does not contain that pointer at all.
- Given `pnpm exec tsc --noEmit` and `pnpm lint`, when they run, then both are clean.
- Given the full node test project, when it runs, then every previously passing suite still passes — in particular `query-stream-route.test.ts` and every research row that does not model a short close.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 5: (high 0, medium 4, low 1)
- reject: 14: (high 0, medium 2, low 12)
- addressed_findings:
  - `[low]` `[patch]` `closeWithNotice(controller, notice, reason)` took two adjacent bare `string`s — a transposed call type-checked and would have enqueued the operator log line into the owner's body — and no test read `logger.warn`'s second argument (proved by mutation: passing `DEADLINE_LOG` at the cap branch left all 28 rows green, so a cap could log as a deadline). Replaced with one `{ copy, log }` descriptor per ending, and pinned the emitted log line in four rows.
  - `[low]` `[patch]` The abort branch ran before `requireResearchActive`, so a run cancelled as its stream aborted was reported `failed` with the deadline sentence instead of taking the `ResearchCancelledError` cancel path — a regression against `textStream`, where the cancellation check was the first thing each chunk hit. Moved the check ahead of the throw; new row asserts `cancelled`.
  - `[low]` `[patch]` The `finish`/`length` comment ("a brief that fits under it today must keep committing") and its test title ("finished under its own output budget") both claimed the opposite of the fixture: `length` means the brief was CUT at the budget. Reworded both to state the real, deliberate gap; behaviour unchanged and the gap deferred.
  - `[low]` `[patch]` `LLM_STREAM_CUT_SHORT_COPY` promised a general "a stream ended early" sentence in a module documented as owning every early-stop sentence, but its text is research-specific and would be false on either query route. Renamed to `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` with a scope note.
  - `[low]` `[patch]` `isOwnLlmDeadline`'s docblock opened "ONE rule for every abort shape this repo maps", which `research-runtime.ts` contradicts on the same diff. Reworded to the rule it actually is, naming the research exception and why research cannot use it.
  - `[low]` `[patch]` The `callLLM`-fallback catch mapped only `isOwnLlmDeadline`, so with no deadline configured an abort there still stored "The operation was aborted due to timeout" as the owner-visible `project.error` — inconsistent with the loop branch above it. Mirrored to `isLlmDeadlineAbort` + `streamCutShortMessage()`; new row covers it.

## Design Notes

The asymmetry between the two `abort` branches is deliberate. The stream route gates its abort branch on `llmDeadlineConfigured()` because falling back means silence, which is what it did before DW-64. Research CANNOT fall back that way: its pre-DW-544 behaviour on an abort is to commit the truncated brief, the exact failure being fixed. So research fails closed on any abort and only the WORDS depend on whether a deadline was configured.

```ts
// src/lib/research-runtime.ts — shape only
for await (const part of stream.fullStream) {
  if (part.type === "abort" || (part.type === "error" && isLlmDeadlineAbort(part.error))) {
    throw new Error(llmDeadlineConfigured() ? LLM_DEADLINE_RESEARCH_COPY : LLM_STREAM_CUT_SHORT_COPY);
  }
  if (part.type !== "text-delta") continue;
  await requireResearchActive(owner, id, attemptId);   // per part, as textStream did
  // …unchanged: receivedStreamContent, raw +=, the 400 ms thinking flush
}
```

`finish`/`length` needs no gate: `maxOutputTokens: QUERY_MAX_OUTPUT_TOKENS` is passed on every call, so a `length` finish is always this repo's cap.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/query-stream-deadline.test.ts src/lib/__tests__/query-stream-route.test.ts src/lib/__tests__/query-route.test.ts src/lib/__tests__/research-runtime.test.ts` -- expected: all pass; every I/O Matrix row is covered by a test that ran.
- `pnpm exec vitest run --project node` -- expected: no suite regressed against the baseline at `9cdf1dcee545012f923caaaaa7fc886f510fb6c4`.
- `pnpm exec tsc --noEmit` -- expected: exit 0 (also proves the `finish`/`abort`/`error` narrowing against the real `TextStreamPart` union).
- `pnpm lint` -- expected: exit 0 apart from the three pre-existing `jsx-ast-utils` notices.
- `grep -rn "Settings → LLM Models"` over the files this change touches -- expected: no hits; the pointer is only ever composed. (Repo-wide the string is pre-existing in `src/lib/workbench-settings.ts` and three suites, unchanged from baseline.)

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Three surfaces that ended an answer early in silence now say so, reusing the DW-64 machinery they each stopped one branch short of.

`synthesizeResearchBrief` reads `result.fullStream` instead of `stream.textStream`. `textStream` enqueues `text-delta` parts and drops everything else, including the `{ type: "abort" }` part `ai@6` emits when the owner's deadline fires — the `for await` ended NORMALLY and a half-written brief was published as a finished wiki page. The run now FAILS on an abort or a deadline-carrying `error` part, so nothing truncated is committed. It fails closed whatever the timeout field says, and only the words turn on it: the route can fall through to its pre-DW-64 silence, research cannot, because its fall-through is the truncated page.

`/api/query` maps a deadline it owns to `LLM_DEADLINE_COPY` instead of `getErrorMessage(error)`. That route matters because `useStreamingQuery` re-queries it on any non-2xx and PREFERS its message, so transport words there overwrote the sentence the stream route already emitted.

`/api/query/stream` gained one branch: a `finish` part carrying `finishReason: "length"` closes the body with `LLM_LENGTH_CAP_COPY`. Ungated, unlike the deadline branches — `QUERY_MAX_OUTPUT_TOKENS` is passed on every call, so a `length` finish is always this repo's own cap.

The shared predicate moved to `src/lib/llm-deadline.ts` as `isOwnLlmDeadline`, so both routes ask the identical question, and that module now owns every "why this stopped early" sentence rather than the deadline alone.

### Files changed

- `src/lib/llm-deadline.ts` — widened remit; added `isOwnLlmDeadline`, `LLM_DEADLINE_RESEARCH_COPY`, `LLM_RESEARCH_STREAM_CUT_SHORT_COPY`, `LLM_LENGTH_CAP_COPY`. Settings pointers composed via `settingsPointer("llm-models", SETTINGS_LABEL)`; the two sentences with no control behind them carry none.
- `src/app/api/query/stream/route.ts` — imports the shared predicate; `closeWithNotice` takes one `{ copy, log }` descriptor; new `finish`/`length` branch.
- `src/app/api/query/route.ts` — the `catch` answers 500 with the deadline sentence when the deadline is the repo's own, otherwise the error's own words.
- `src/lib/research-runtime.ts` — `synthesizeResearchBrief` reads `fullStream` and fails the run on a cut stream; cancellation still outranks that throw; the `callLLM` fallback reports a deadline in the same words.
- `src/lib/llm.ts` — docblock only: both `callLLMStream` callers now map the abort, and what they do about it differs by design.
- `src/lib/__tests__/query-stream-deadline.test.ts`, `query-route.test.ts`, `research-runtime.test.ts` — new coverage for every I/O Matrix row; the repo's only two `textStream` fixtures became `fullStream`.

### Review findings breakdown

Patches applied: 6 (all low) — see the Review Triage Log. Items deferred: 5 (4 medium, 1 low) — see frontmatter `deferred`; the substantive ones are the same silent cap truncation on the non-streaming `/api/query` and on the research brief's own 7,000-token budget. Items rejected: 14, the notable ones with their evidence: closing the deferred-work ledger is the orchestrator's job and this session is forbidden to edit it; an abort part followed by a `finish` part cannot occur, because `ai@6` closes the stream when it enqueues `abort`; walking `error.cause` in the predicate was rejected in DW-64 with evidence that the SDK's own `isAbortError` is a name check too; the stream route's silence on an abort with no deadline configured is DW-64's frozen decision, not a defect introduced here; and the duplicated "Nothing was written to the wiki" between `progress.message` and the sentence is deliberate, since `project.error` is stored and read on its own, not only beside that line.

### Follow-up review recommendation

Patched findings this pass: high 0, medium 0, low 6. Score = 3 × 0 + 1 × 6 = 6, which is >= 5 -> `followup_review_recommended: true`.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/query-stream-deadline.test.ts src/lib/__tests__/query-stream-route.test.ts src/lib/__tests__/query-route.test.ts src/lib/__tests__/research-runtime.test.ts` — 156 passed, 1 skipped, 4 files. Every I/O Matrix row is covered by a test that ran and passed.
- `pnpm exec vitest run --project node` — 286 files, 7322 passed, 1 skipped, 0 failed (7319 at the pre-review implementation, 6884 at baseline `9cdf1dce`; no suite regressed).
- `pnpm exec tsc --noEmit` — exit 0, which is also what narrows `finish`/`abort`/`error` against the real `TextStreamPart` union.
- `pnpm lint` — exit 0 (output is the three pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `grep -rn "Settings → LLM Models"` over the eight files this change touches — no hits; the pointer is only ever composed. Repo-wide the string is pre-existing in `src/lib/workbench-settings.ts` and three unrelated suites, byte-identical to baseline.
- Mutation checks (the implementation agent's, re-verified green afterwards): disabling the `finish`/`length` branch, the `/api/query` conditional and the research abort condition each fails exactly the new rows; after the patch pass, mis-passing the cap's log descriptor, moving the throw ahead of the cancellation check, and re-gating the fallback each fail their new row too.

### Residual risks

- The `dom` vitest project is not part of this evidence. Only node-project code was touched, and the node project is green.
- No test drives a real `AbortSignal.timeout` through `streamText`: the `abort`/`error`/`finish` part shapes are literals in both the branches and the fixtures, so an `ai` upgrade that kept the union members but changed when they are emitted would leave the suite green. `tsc` pins the shapes, not the timing — the same residual DW-64 recorded.
- `/api/query`'s sentence is a 500 body. `useStreamingQuery` reaches it by re-running the whole query under a fresh deadline, so on a slow-but-not-hopeless model the owner may get a full answer rather than the notice. That hook is on this spec's Never list and is unchanged.
