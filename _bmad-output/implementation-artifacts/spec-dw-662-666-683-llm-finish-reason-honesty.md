---
title: 'Surface finishReason from callLLM so the non-streamed query and research doors stop presenting cut answers as finished'
type: 'bugfix'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The truncation notice never reaches the owner on `html` and `slides`
      answers: it is appended after the baked document, and the renderer drops
      everything past the last `</html>`.
    evidence: |-
      `query()` appends the sentence to `answer` for every format, including the
      baked HTML document / Marp deck built just above it. The client renders
      that string through `HtmlPreview`, whose `composeSrcDoc`
      (`src/lib/html.ts`) deletes anything after the document's closing
      `</html>` — so on a `content-filter` or a clean-document cap the sentence
      is discarded before display and before `/api/query/save`. Where the cap
      cut the document mid-tag there is no closing `</html>`, and the sentence
      is spliced into whatever unterminated tag, script or attribute the cut
      left. This is the same mechanism the stream route's DW-64/DW-547 notices
      already ride, so it predates this bundle — but DW-662's own reason text
      names `slides` and `html` as what `useStreamingQuery` sends to
      `/api/query` ALWAYS, which makes these the formats the door most needs to
      be honest on, and the half-answer-reading-as-whole failure survives there.
      No test in the repo drives a non-`stop` finish at a non-prose format.
    location: >-
      src/lib/query.ts:410-433
    severity: low
baseline_revision: 'ca0e0190c2852e853d66d18e7406fe5a6a2f312a'
---

<intent-contract>

## Intent

**Problem:** `callLLM` (`src/lib/llm.ts:599`) destructures only `{ text }` from `generateText` and throws `finishReason` away, so two doors commit truncated model output as whole: `/api/query` returns a cap-cut answer with no marker (DW-662 — the silent truncation DW-547 closed for the stream route alone), and `synthesizeResearchBrief`'s non-streamed fallback commits a cap-cut brief as a finished wiki page (DW-683). The stream route itself still closes in silence for every `finish` reason but `length` (DW-666) — `content-filter` most concretely: the model stopped and the owner is told nothing.

**Approach:** Add a `callLLMWithFinish` sibling in `src/lib/llm.ts` returning `{ text, finishReason }`, with `callLLM` delegating to it so its `Promise<string>` signature and its ~19 existing callers are untouched. Branch the two non-streamed callers on it. Add one third owner sentence for "the model stopped before it finished" and widen the stream route's `finish` handling so `stop` is the only silent ending.

## Boundaries & Constraints

**Always:**
- `callLLM` keeps its exact signature, its `Promise<string>` return, and its "LLM response contained no text" throw. Every existing caller stays untouched.
- The third sentence lives in `src/lib/llm-deadline.ts` beside the existing five, is query-scoped, carries no Settings pointer (nothing on the Settings surface causes a `content-filter`/`error` ending) and no transport vocabulary (`finishReason`, `token`, `aborted`, `signal`), and is not equal to any existing sentence.
- On the stream route the third notice is a DESCRIPTOR beside `DEADLINE_NOTICE`/`LENGTH_CAP_NOTICE` — copy paired with its own operator log line — never a bare `(copy, log)` pair.
- Deadline wins over finish: an `abort`/deadline-`error` part arriving before the `finish` still emits `DEADLINE_NOTICE`, unchanged.
- Research keeps failing CLOSED on a cap, and `requireResearchActive` runs before the throw so a cancel at that moment still reports `cancelled`.
- Only `stop` is a clean ending on the stream route and in `query()`. `length` keeps its own cap sentence; every other reason gets the third sentence.

**Block If:** none — the scope is fully determined by the three ledger entries and the intent.

**Never:**
- Do not change `callLLMStream`, `callVisionLLM`, the frozen single whole-stream deadline mechanism, `QUERY_MAX_OUTPUT_TOKENS`, the research 7,000-token budget, or `src/hooks/useStreamingQuery.ts`.
- Do not reuse `LLM_LENGTH_CAP_COPY` or `LLM_RESEARCH_LENGTH_CAP_COPY` for a non-`length` ending, and do not add a Settings pointer to any of the ungated sentences.
- Do not make research's condensation or hierarchical-reduction calls fail on a cap — DW-683 names the synthesis fallback only; those two sites keep today's behaviour exactly.
- Do not make the research fallback fatal for any reason but `length`, and do not remove the fallback itself.
- Do not export anything but the HTTP handler from `route.ts`.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `callLLM` unchanged | any call | Returns the text string exactly as today; empty text still throws | Unchanged |
| `callLLMWithFinish` normal | `generateText` returns text + `stop` | `{ text, finishReason: "stop" }` | Empty text throws the same message |
| `/api/query` cap cut | answer call finishes `length` | `answer` is the baked answer, blank line, `LLM_LENGTH_CAP_COPY`; `sources` unchanged | `logger.warn("query", …)` once |
| `/api/query` other ending | finishes `content-filter`/`error`/`tool-calls`/`other` | Same shape with the third sentence | Same log, its own line |
| `/api/query` clean | finishes `stop` | Answer verbatim, no notice, no log | No error |
| `/api/query` cut before any text | `length` with empty-ish answer | Notice alone, no leading blank line | Same log |
| Stream route cap | `finish`/`length` | Unchanged: deltas, blank line, `LLM_LENGTH_CAP_COPY` | Cap log |
| Stream route other ending | `finish`/`content-filter`, `error`, `tool-calls`, `other` | Deltas, blank line, third sentence, 200, headers unchanged | Third log line, once |
| Stream route clean | `finish`/`stop` | Deltas alone, no notice | No log |
| Stream route deadline then finish | `abort` then `finish`/`length` | Deadline sentence, as today | Deadline log |
| Research fallback cap | stream produced NO text, fallback finishes `length` | Run `failed`, nothing written, `project.error` is `LLM_RESEARCH_LENGTH_CAP_COPY` | Thrown after `requireResearchActive` |
| Research fallback clean | fallback finishes `stop` | Unchanged: brief commits, page written | No error |
| Research fallback cancelled at the cap | owner cancels as `length` lands | Run `cancelled`, not `failed` | `ResearchCancelledError` rethrown |
| Research condensation/reduction cap | those calls finish `length` | Unchanged — text used as today | No error |

</intent-contract>

## Code Map

- `src/lib/llm.ts:588-614` — `callLLM`; the `const { text } = await retryWithBackoff(() => generateText(...))` that discards `finishReason`. Split here. `FinishReason` is a type export of `ai@6.0.146` (`'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`). `callLLMStream` (line 701) and `callVisionLLM` (line 622) are read-only neighbours.
- `src/lib/llm-deadline.ts` — owns all five owner sentences and the `llmDeadlineConfigured`/`isLlmDeadlineAbort`/`isOwnLlmDeadline` predicates. Its `LLM_RESEARCH_STREAM_CUT_SHORT_COPY` docblock already reserves this slot: "A general 'a stream ended early' sentence for the query surfaces does not exist yet, and if one is ever needed it is a new constant beside this one." Add it there; keep the module dependency-light (config + workbench-settings only).
- `src/app/api/query/stream/route.ts:38-45` — `DEADLINE_NOTICE` / `LENGTH_CAP_NOTICE` descriptors. `:282` — the `part.type === "finish" && part.finishReason === "length"` branch inside `pull`, with the bookkeeping tail comment just below it. `closeWithNotice` (:210) takes the descriptor.
- `src/lib/query.ts:348-367` — the answer call, then `bakeYoyoIllustrations` for `slides`/`html`, then `extractCitedSlugs`. Append the notice AFTER sources are extracted so no notice text is scanned for citations. `logger` is not imported here yet; it is silent under `NODE_ENV=test`.
- `src/lib/research-runtime.ts:1370-1387` — `callResearchLLM`, the shared deadline conversion for three call sites: the synthesis fallback (`:1576`, `maxOutputTokens: 7_000`) and condensation (`:1631`) / reduction (`:1696`), both `1_500`. Make it return the pair; the two evidence sites take `.text`.
- `src/lib/research-runtime.ts:1481-1495` — the streamed `finish`/`length` branch to mirror: `await requireResearchActive(...)` then `throw new Error(LLM_RESEARCH_LENGTH_CAP_COPY)`.
- `src/lib/__tests__/query-stream-deadline.test.ts:477-482` — the `it.each(["tool-calls", "content-filter", "other"])` rows pinning silence; invert them. Its `vi.mock("@/lib/llm")` factory (`:44`) mocks `hasLLMKey` + `callLLMStream` only. Operator log lines are restated as `DEADLINE_LOG`/`LENGTH_CAP_LOG` near `:135`.
- `src/lib/__tests__/query.test.ts:18-21` and `src/lib/__tests__/research-runtime.test.ts:36-42` — `vi.mock` factories for `../llm`. 36 and ~50 assertions respectively hang off the `callLLM` mock (call counts, prompt indices, throw implementations). Add `callLLMWithFinish` INSIDE each factory delegating to the same `callLLM` mock (`{ text: await callLLM(...), finishReason: "stop" }`) so every existing expectation keeps holding; individual new tests override it.
- Other suites mocking the llm module (`integration`, `mcp`, `structured-knowledge`, `x-mention-integration`, `research-delivery`, `query-search`, …) may reach `query()` or the research fallback — apply the same delegating stub wherever the run reports `callLLMWithFinish is not a function`.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm.ts` -- add `export async function callLLMWithFinish(systemPrompt, userMessage, options?): Promise<{ text: string; finishReason: FinishReason }>` holding today's `callLLM` body plus the empty-text throw, and reduce `callLLM` to `(await callLLMWithFinish(...)).text` -- surfaces the discarded field additively so ~19 `Promise<string>` callers are untouched.
- `src/lib/llm-deadline.ts` -- add one exported query-scoped constant for a non-`stop`, non-`length` ending, with a docblock saying why it is ungated, why it carries no Settings pointer, and why neither cap sentence fits -- the third sentence DW-666 needs.
- `src/app/api/query/stream/route.ts` -- add the third notice descriptor beside the two, and widen the `finish` branch so `length` keeps the cap notice while every other non-`stop` reason closes with the third one -- DW-666.
- `src/lib/query.ts` -- call `callLLMWithFinish`, and after `extractCitedSlugs` append the matching sentence to `answer` (blank-line separated only when there is an answer already), logging the operator line once -- DW-662.
- `src/lib/research-runtime.ts` -- have `callResearchLLM` return `{ text, finishReason }` via `callLLMWithFinish`; the two evidence sites take `.text` unchanged, and the synthesis fallback runs `requireResearchActive` then throws `LLM_RESEARCH_LENGTH_CAP_COPY` on `length` -- DW-683, mirroring the streamed branch exactly.
- `src/lib/__tests__/query-stream-deadline.test.ts` -- invert the three silence rows into notice rows, add an `error` row and a `stop` row, and add the copy-property tests for the new sentence (no Settings pointer, no transport vocabulary, distinct from the other two, never the operator log line) -- the I/O matrix's stream rows.
- `src/lib/__tests__/query.test.ts` -- add the delegating `callLLMWithFinish` mock and cover the `/api/query` cap, other-ending, clean and no-prior-text rows -- the I/O matrix's query rows.
- `src/lib/__tests__/research-runtime.test.ts` -- add the delegating mock, add a fallback-`length` row asserting `failed` + `LLM_RESEARCH_LENGTH_CAP_COPY` + no page write, a cancel-at-the-cap row, and keep the three existing "takes the fallback" boundary tests green -- the I/O matrix's research rows.

**Acceptance Criteria:**
- Given a repo-wide search for `callLLM(` call sites, when the change is complete, then every pre-existing site still compiles unchanged and only `query.ts` and `research-runtime.ts` use the new sibling.
- Given `pnpm test`, when the full suite runs, then it passes with no suite left mocking `@/lib/llm` in a way that makes `callLLMWithFinish` undefined on a path it reaches.
- Given `pnpm exec tsc --noEmit` and `pnpm lint`, when run, then both are clean.

## Design Notes

The sibling, not an options flag: a flag would make the return type conditional on an argument, and every one of the ~19 existing callers would then depend on inference staying `string`. Two functions with two return types is the additive shape the intent asks for, and `callLLM` delegating keeps one `generateText` call in the file.

Only `stop` is silent. `content-filter` and `error` are the reasons DW-666 names; `tool-calls` and `other` join them because this repo passes no tools on these calls, so either one means the model stopped somewhere that is not the end of the answer — and a rule keyed on "did the model finish" needs no per-reason table.

Research narrows in the other direction on purpose: its streamed loop already treats every reason but `length` as a clean ending (DW-663/DW-664's frozen shape), so the fallback mirrors `length` alone rather than inventing a second rule for the same door.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/query-stream-deadline.test.ts src/lib/__tests__/query.test.ts src/lib/__tests__/research-runtime.test.ts` -- expected: all pass, including the inverted rows.
- `pnpm test` -- expected: full suite green.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: no errors.

## Spec Change Log

_No bad_spec loopback occurred; this spec was implemented as written._

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[low]` `[patch]` The non-streamed operator log MESSAGES were counted but never read, so the two `stoppedEarlyNotice` log strings could be transposed — the exact failure the copy/log descriptor exists to prevent — with every row still green. Added restated log constants and a `warnedOnce()` helper to `query.test.ts`; the cap row and all four stopped-early rows now assert the full `(scope, message)` pair, the interpolated finish reason, and that neither non-streamed line equals the stream route's wording. Mutation-checked: transposing the two strings now fails 5 rows, and failed none before.
  - `[low]` `[patch]` `LLM_STOPPED_EARLY_COPY`'s docblock contradicted its own constant — it justified not reusing the cap sentence by saying narrowing does not address a content filter, while itself telling the owner to narrow. Rewrote the rationale to name the real distinction (the cap sentence's "to see the rest" asserts a retrievable remainder, which a filter or a dead provider cannot promise) and left the copy unchanged. Added a guard row pinning that property, replacing a `not.toBe` that would have passed for two sentences differing by one word.
  - `[low]` `[patch]` The new DW-683 comment misstated its neighbour: it claimed the streamed loop treats every non-`length` finish reason as a clean ending, but that loop deliberately does NOT clear a pending `error` part on a `finishReason: "error"` (DW-664). Restated it accurately.
  - `[low]` `[patch]` Four docblocks in `research-runtime.ts` still named `callLLM` as this module's non-streamed call after the import moved to `callLLMWithFinish`. Updated all four.
  - `[low]` `[patch]` `mcp.test.ts`'s `vi.mock("../llm")` spreads `importOriginal` and overrode `callLLM` alone, so `query()`'s new `callLLMWithFinish` call escaped the double entirely and stayed green only because the rows that exist take the no-key fallback. Added a delegating `callLLMWithFinish` to that factory.
  - `[low]` `[patch]` `query.test.ts`'s "emits the notice alone" row pins a state production cannot reach — the sibling's empty-text throw stands between the provider and that branch. Kept the row and the branch (it mirrors the stream route, where an empty body IS reachable) and labelled it so it is not mistaken for production coverage.

## Auto Run Result

Status: done

### What was implemented

`callLLM` discarded `generateText`'s `finishReason`, so every non-streamed door committed a cut model answer as a whole one. `src/lib/llm.ts` now exports `callLLMWithFinish`, returning `{ text, finishReason }` and holding the former `callLLM` body including its empty-text throw; `callLLM` is `(await callLLMWithFinish(...)).text`, so its signature, its `Promise<string>` return and all 17 pre-existing call sites are untouched. `query()` and the research synthesis fallback branch on the surfaced field, and the stream route's `finish` handling widened so `stop` is its only silent ending.

### Files changed

- `src/lib/llm.ts` — new `callLLMWithFinish` sibling; `callLLM` delegates to it.
- `src/lib/llm-deadline.ts` — new `LLM_STOPPED_EARLY_COPY`, the query-scoped, ungated, pointer-free sentence for an ending that is neither the cap nor the owner's deadline.
- `src/app/api/query/stream/route.ts` — third notice descriptor `STOPPED_EARLY_NOTICE`; the `finish` branch is now `!== "stop"`, keeping the cap sentence for `length` (DW-666).
- `src/lib/query.ts` — calls the sibling, appends the matching sentence after `extractCitedSlugs`, logs one operator line (DW-662).
- `src/lib/research-runtime.ts` — `callResearchLLM` returns the pair; the synthesis fallback fails closed on `length` after `requireResearchActive`; condensation and reduction take `.text` unchanged (DW-683).
- `src/lib/__tests__/llm-finish-reason.test.ts` — new: pins the split itself against a mocked `ai`.
- `src/lib/__tests__/query-stream-deadline.test.ts` — the three silence rows inverted; a DW-666 block; copy-property rows for the new sentence.
- `src/lib/__tests__/query.test.ts` — DW-662 block covering cap, the four other endings, clean, no-prior-text, sources, and the no-key early return.
- `src/lib/__tests__/research-runtime.test.ts` — fallback cap rows, cancel-at-the-cap, the five reasons that still commit, and condensation/reduction untouched.
- `src/lib/__tests__/integration.test.ts`, `research-delivery.test.ts`, `mcp.test.ts` — delegating `callLLMWithFinish` added to their `../llm` mocks so the existing doubles still intercept.

### Review findings

Patches applied: 5 (all low). Deferred: 1 (low). Rejected: 4.

Follow-up review recommended: **false** — patched counts by severity are high 0, medium 0, low 5; the score is `true` only when a patched finding was high.

### Verification performed

- `pnpm test` — 386 files, 9579 passed, 1 skipped, 0 failed.
- `pnpm exec tsc --noEmit` — exit 0.
- `pnpm lint` — exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing and come from `.tsx` files this change does not touch).
- Every I/O matrix row has a covering test that ran and passed; the two `callLLM`/`callLLMWithFinish` rows are covered by the new `llm-finish-reason.test.ts`.
- Mutation check on the log-line patch: transposing the two `stoppedEarlyNotice` log strings fails 5 rows after the patch and failed none before it.

### Residual risks

- **`"other"` is a provider default, not only a real early ending.** `ollama-ai-provider-v2` maps an absent or unrecognised `done_reason` to `"other"`, and its stream adapters initialise the reason to `"other"` before the final chunk. On an Ollama or `custom` endpoint that omits the reason, every complete answer would now carry "This answer is incomplete". Modern Ollama sends `done_reason: "stop"`, and the intent explicitly directs inverting the `other` row, so the rule stands as written — but a deployment on such a provider would see a false notice on every query rather than silence.
- **The research fallback still commits on `content-filter` and `error`.** It fails closed on `length` alone, mirroring the streamed loop's frozen shape and DW-683's own wording. A fallback stopped by a content filter is still published as a finished wiki page — the same failure class under a reason the bundle did not name.
- **A saved answer carries the notice into the wiki.** `saveAnswerToWiki` writes `result.answer` verbatim, so an owner who saves an interrupted answer persists this repo's sentence as page body text. Pre-existing in shape for the DW-547 cap sentence; four more endings can now reach it.
