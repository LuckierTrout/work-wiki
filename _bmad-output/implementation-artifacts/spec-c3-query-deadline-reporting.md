---
title: 'Query deadline reporting: a truncated stream is not a finished answer'
type: 'bugfix'
created: '2026-09-01'
status: 'in-review'
baseline_revision: '7f04fefea46ab83b99b98346a3d425705dc860b8'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `/api/query/stream` closes a cut-short answer as a **200** whose body ends with an owner-facing notice sentence (`LLM_DEADLINE_COPY` on a fired deadline, `LLM_LENGTH_CAP_COPY` on the output cap). `useStreamingQuery` cannot tell that apart from a finished answer: it breaks out of the read loop with no error set, runs `extractCitedSlugs` over text that includes the notice, and hands `onComplete` the whole body — so `saveToHistory` POSTs the notice sentence to `/api/query/history` as part of the model's answer, and a half answer is recorded as a complete one.

**Approach:** Give `src/lib/llm-deadline.ts` — which already owns both sentences — one predicate that splits a streamed body into the model's output and the trailing notice, matching exactly the two closing shapes `/api/query/stream` can produce. `useStreamingQuery` uses it to strip the notice, expose the truncation as state, and pass only the model's output to `onComplete`, and `/app/query/page.tsx` renders that state so the owner still reads the sentence.

## Boundaries & Constraints

**Always:**
- The split helper lives in `src/lib/llm-deadline.ts` beside the sentences it recognises; the hook imports the constants rather than restating any literal.
- Recognise exactly the two closings `closeWithNotice` can emit: the notice as the ENTIRE body (nothing was emitted before it), or the body ending in `\n\n` + the notice. Nothing else counts as truncation.
- The owner still reads the sentence: stripping it from `result.answer` obliges the surface to render it from the new state.
- Both notices, not just the deadline's. They are one closing shape from one module and produce the identical defect; recognising one and not the other would leave the same bug standing.

**Block If:** none.

**Never:**
- Do not touch `src/app/api/query/stream/route.ts`, `src/app/api/query/route.ts`, or `src/lib/llm-deadline.ts`'s existing exports/wording — the server side of this intent already shipped (DW-545, DW-547) and its pins in `src/lib/__tests__/query-stream-deadline.test.ts` and `query-route.test.ts` must stay green untouched.
- Do not change the non-streaming `/api/query` fallback path in the hook. That route appends no notice (`/api/query` cap truncation is DW-662, a separate open entry).
- Do not add a notice-stripping pass to `QueryResultPanel`, `/api/query/save`, or `/api/query/history` — the fix is at the one place the body is assembled.
- Do not change what `/api/query/stream` streams, or the wording of any sentence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Finished answer | Stream body `"A full answer."` | `result.answer` unchanged, truncation state null, `onComplete` gets the full text | No error expected |
| Deadline mid-answer | Body `"Half an ans\n\n" + LLM_DEADLINE_COPY` | `result.answer` is `"Half an ans"`, truncation state is `LLM_DEADLINE_COPY`, `onComplete` gets `"Half an ans"` | No error expected |
| Cap mid-answer | Body `"As far as this w\n\n" + LLM_LENGTH_CAP_COPY` | Same, with `LLM_LENGTH_CAP_COPY` as the state | No error expected |
| Notice before any token | Body is exactly `LLM_DEADLINE_COPY` | `result.answer` is `""`, truncation state set, `onComplete` NOT called — there is no model output to record | No error expected |
| Notice text mid-answer | Body `LLM_DEADLINE_COPY + "\n\nmore answer"` | Not a truncation: answer unchanged, state null | No error expected |
| New query after a truncated one | Second `execute` starts | Truncation state cleared before the request goes out | No error expected |
| Non-2xx stream, `/api/query` fallback | Fallback JSON `{answer, sources}` | Unchanged behaviour — no split applied | Existing error handling |

</intent-contract>

## Code Map

- `src/lib/llm-deadline.ts` -- owns `LLM_DEADLINE_COPY` (:81) and `LLM_LENGTH_CAP_COPY` (:181), plus `isOwnLlmDeadline` / `llmDeadlineConfigured`. **It is NOT browser-safe**: line 1 is `import { getLlmTimeoutMs } from "./config"`, and `src/lib/config.ts:1` is `import path from "node:path"` with `./storage` -> `./storage/filesystem` -> `node:fs/promises` behind it. Webpack builds every statically imported module in a client graph, so a `"use client"` file that imports this one drags `config.ts` into the browser bundle. `pnpm build` already fails this way today for two OTHER components (`SystemHealthDesk.tsx` -> `backups.ts`, `KnowledgeStudio.tsx` -> `research-panel.ts`); a third edge from the query hook must not be added. Its docblock's "dependency-light" claim is about NODE callers, not browsers.
- `src/lib/workbench-settings.ts` -- imports NOTHING (verified: no `import` line in the file). `settingsPointer` / `SETTINGS_LABEL` are therefore safe in a client bundle, which is what makes the leaf module below possible.
- `src/app/api/query/stream/route.ts` -- READ-ONLY evidence for the two closing shapes. `DEADLINE_NOTICE` (:39) and `LENGTH_CAP_NOTICE` (:43); `closeWithNotice` (:207-215) enqueues `emitted ? "\n\n" + copy : copy` then `controller.close()` — a 200 either way. Those two are the only notices this route appends.
- `src/hooks/useStreamingQuery.ts` -- the defect. Read loop :185-192 (`setResult({ answer, sources })` per chunk), citation refine :194-199, `onComplete` :203. Reset block :93-97. `UseStreamingQueryReturn` :13-37.
- `src/app/query/page.tsx` -- `saveToHistory` :30-54 POSTs `answer` to `/api/query/history`; hook wired at :105-126 with `onComplete: saveToHistory`; render has an `{error && <Alert variant="error" …>}` block at :450-454 immediately above `{result && <QueryResultPanel …>}` — the place the new notice renders.
- `src/components/Alert.tsx` -- `variant`: `error | success | info | warning`. Reuse it; a truncation is `warning`.
- `src/lib/__tests__/query-stream-deadline.test.ts` -- READ-ONLY. Already pins every server-side shape this depends on (`"Half an ans\n\n" + LLM_DEADLINE_COPY` at :230, notice-alone at :248, cap variants at :438/:446). Do not edit.
- `vitest.config.ts` -- two projects. A hook test must be `src/hooks/__tests__/*.test.tsx` (jsdom); `*.test.ts` under `src/**/__tests__/` is the node project. A pure helper test for `llm-deadline.ts` belongs in `src/lib/__tests__/*.test.ts`.
- `src/hooks/__tests__/useSidecarStatus.test.tsx` -- the mounted-hook pattern to copy: a `Harness()` component rendering the hook's state, `@testing-library/react`, `vi.stubGlobal("fetch", …)`.

## Tasks & Acceptance

**Execution:**
- `src/lib/llm-answer-notice.ts` (NEW) -- the browser-safe home for the query surfaces' copy. MOVE `LLM_DEADLINE_COPY` and `LLM_LENGTH_CAP_COPY` here verbatim, docblocks and all, and add `INCOMPLETE_ANSWER_NOTICES` (both, in the order the route declares them) and `splitIncompleteAnswerNotice(body): { answer: string; notice: string | null }`. Its ONLY import may be `./workbench-settings`. `splitIncompleteAnswerNotice` matches exactly the two shapes `closeWithNotice` emits -- `body === notice`, or `body.endsWith("\n\n" + notice)` -- and returns `{ answer: body, notice: null }` otherwise. Never `includes`/`indexOf`. Docblock: why the file exists (llm-deadline.ts reaches `node:path` through `./config`, so a client import of it breaks the browser bundle), why only two closing shapes count, and the one accepted false positive named in Design Notes.
- `src/lib/llm-deadline.ts` -- re-export the moved names so every existing import site is untouched: `export { LLM_DEADLINE_COPY, LLM_LENGTH_CAP_COPY, INCOMPLETE_ANSWER_NOTICES, splitIncompleteAnswerNotice } from "./llm-answer-notice";` and import what its own remaining docblocks/`{@link}`s need. Its export surface must stay a superset of today's, its predicates and every other sentence must stay put, and the four existing importers (`api/query/route.ts`, `api/query/stream/route.ts`, `research-runtime.ts`, and the three server suites) must need no edit. Leave a one-line note at the re-export saying the leaf exists because this module is server-only.
- `src/hooks/useStreamingQuery.ts` -- import `splitIncompleteAnswerNotice` from `@/lib/llm-answer-notice` (NEVER from `@/lib/llm-deadline`). Add `truncationNotice: string | null` state plus a `setTruncationNotice` setter on `UseStreamingQueryReturn`, beside the `setError` the interface already exposes. Clear the notice in three places: the reset block beside `setError(null)`, the `catch` beside `setError("Failed to connect…")` -- an in-loop match followed by a network drop must not leave a truncation warning beside a connection error -- and nowhere else. Accumulate the RAW body; flush the `TextDecoder` (`decoder.decode()` with no argument) after the loop, since the body's exact tail is now load-bearing for the suffix match. Apply the split inside the loop as well as after it, and while the accumulated tail is still a PROPER PREFIX of a notice preceded by the blank line, withhold that tail from `result` instead of painting a half sentence into the answer. Run `extractCitedSlugs` over the stripped text. When the stripped answer is blank (`answer.trim() === ""`) there is no model output: set `result` to `null` rather than an empty-answer object, and do not call `onComplete` at all. Otherwise `onComplete` gets the stripped answer.
- `src/app/query/page.tsx` -- destructure `truncationNotice` and `setTruncationNotice`; render the notice in an `<Alert variant="warning">` directly above the `{result && <QueryResultPanel …>}` block; and clear it in `loadHistoryEntry` beside the `setError(null)` already there, so selecting an older finished answer does not leave the previous query's warning standing over it.
- `src/lib/__tests__/llm-answer-notice.test.ts` -- unit-test the pure function over both notices: split off a body ending with it after a blank line, the notice alone as the whole body, text following the notice (not a truncation), a single `\n` before it (not a truncation), mid-body (not a truncation), a finished answer returned byte-for-byte with its own trailing blank line intact, and an empty body. Import the constants; restate no literal.
- `src/hooks/__tests__/useStreamingQuery.truncation.test.tsx` -- mount the hook over a stubbed chunked `fetch`. Cover, for BOTH notices: the stripped answer reaching `onComplete`, the notice surfaced as state, and -- with the chunk boundary landing INSIDE the notice and a flush between chunks so each streaming frame renders separately -- that no rendered frame contains any part of the notice (assert each frame is a prefix of the model's own text, not merely that it lacks the whole sentence; the assertion must fail if the in-loop withholding is removed). Also: a finished answer untouched end to end, a notice the model quoted mid-answer left whole, a notice-only body producing `result === null` and no `onComplete`, an empty 200 body producing no `onComplete`, the notice cleared before the next request goes out, the notice cleared when the stream throws mid-read, and no split applied on the non-streaming `/api/query` fallback.
- `src/app/query/__tests__/query-page-truncation.test.tsx` -- mount the query page itself over a stubbed `fetch` streaming a body that ends in `LLM_DEADLINE_COPY`, and assert the sentence is on screen as a `warning` alert and is NOT inside the answer panel. Without this, deleting the JSX block leaves every other suite green while the owner sees a half answer with no notice at all -- strictly worse than before this change. Follow the mounting precedent in `src/app/settings/__tests__/`; if the page cannot be mounted there (Clerk or another provider makes it infeasible), say so in `## Auto Run Result` rather than silently dropping the task.

**Acceptance Criteria:**
- Given `/api/query/stream` closes 200 with a body ending `"\n\n" + LLM_DEADLINE_COPY`, when the hook finishes reading, then `onComplete` receives the answer with that sentence removed -- so the body `saveToHistory` POSTs to `/api/query/history` holds model output only.
- Given the same response, when the query page renders, then the owner reads the notice sentence exactly once, as a warning above the answer panel, and never inside the answer.
- Given the notice is still arriving and the accumulated tail is a partial notice, when a frame renders, then that frame contains no part of the sentence.
- Given a body that never carried a notice, when the hook finishes reading, then `result.answer`, the cited-source refinement, and the `onComplete` arguments are byte-identical to today's.
- Given a deadline that fires before any token, when the hook finishes reading, then `result` is `null`, `onComplete` is not called, and no empty answer panel with Copy and Save controls is rendered.
- Given a truncated answer on screen, when the owner selects an older history entry, then the truncation warning is gone.
- Given a stream that matched a notice and then threw, when the error is reported, then the truncation warning is not also on screen.
- Given `src/hooks/useStreamingQuery.ts` and `src/app/query/page.tsx`, when their transitive import graphs are followed, then neither reaches `src/lib/config.ts` or `src/lib/storage/`.
- Given the existing server suites, when `pnpm test` runs, then `query-stream-deadline.test.ts`, `query-route.test.ts` and `research-runtime.test.ts` pass unmodified.

## Spec Change Log

### 2026-09-01 -- Review pass 1 (bad_spec)

**Triggering findings.** (1) The Code Map called `llm-deadline.ts` "dependency-light … so a jsdom suite can import it" and the task list put the split helper there, so the hook imported it and added a THIRD client-to-server edge to a browser bundle that webpack already refuses to build -- `llm-deadline.ts` -> `./config` -> `node:path`, `./storage/filesystem` -> `node:fs/promises`. Verified against `pnpm build` output at HEAD. (2) The mounted test asserting the notice is "never painted, even for one frame" checked `not.toContain(<whole sentence>)`, which a PARTIAL notice tail never trips; a reviewer deleted the in-loop split and all ten tests still passed. (3) `truncationNotice` had no lifecycle beyond the reset block: the `catch` path and `loadHistoryEntry` both leave a stale warning on screen, and the interface exposed no setter to clear it. (4) A notice-only body left `result` as `{ answer: "", sources: <every loaded slug> }`, rendering an empty answer panel with live Copy and Save-to-wiki controls. (5) Nothing mounted the query page, so the `<Alert>` block -- the only place the owner reads the stripped sentence -- could be deleted with every suite green, which is strictly worse than before the change.

**What was amended.** Code Map now records the exact server-only import chain and that `workbench-settings.ts` imports nothing. Tasks now specify a browser-safe leaf module `src/lib/llm-answer-notice.ts` with `llm-deadline.ts` re-exporting from it, the full `truncationNotice` lifecycle (setter, `catch`, `loadHistoryEntry`), withholding a partial-notice tail, the `TextDecoder` flush, `result === null` on a blank stripped answer, and a page-level mounted suite. Acceptance criteria now include an import-graph criterion and a partial-frame criterion. Design Notes record the accepted false positive and why the re-export satisfies the contract's Always.

**Known-bad state avoided.** A `/query` page that cannot be bundled for the browser; a test suite that passes while the behaviour it names is absent; a warning sentence that outlives the answer it describes; and an empty answer offered for saving to the wiki.

**KEEP -- must survive re-derivation.**
- `splitIncompleteAnswerNotice` semantics: exact suffix test on `body === notice` and `body.endsWith("\n\n" + notice)`; never `includes`/`indexOf`, with the docblock reasoning about a model quoting the sentence.
- `INCOMPLETE_ANSWER_NOTICES` holding both query sentences with the research sentences excluded, and the stated reason (research fails closed and never appends to a body).
- Hook: split inside AND after the read loop; `extractCitedSlugs` over the stripped text; notice cleared beside `setError(null)` in the reset block; `onComplete` skipped when there is no model output.
- Page: `<Alert variant="warning">` above `QueryResultPanel`, with the comment explaining why a truncation is a warning and not an error.
- Suites: import the constants, restate no literal; parameterise over BOTH notices; keep the "model quoted the notice mid-answer" case and the "no split on the `/api/query` fallback" case (citing DW-662 as the reason that path is left alone).
- Every server file untouched, and `query-stream-deadline.test.ts` / `query-route.test.ts` green without modification.

## Design Notes

The two closing shapes come from one place -- `closeWithNotice` in the stream route:

```ts
controller.enqueue(emitted ? `\n\n${notice.copy}` : notice.copy);
controller.close();
```

So the split is a suffix test, not a search.

**The accepted false positive, which must be documented in the helper's docblock rather than fixed here.** A model whose own answer genuinely ends with this repo's exact sentence after a blank line is indistinguishable from a truncation, and its last paragraph would be stripped. The structural fix is an out-of-band signal (a trailer header, or a sentinel the model cannot emit), which means changing what the route streams -- outside this intent. State the limitation where the suffix test is written; do not widen the match to compensate.

**Why a leaf module and a re-export, not a new export on `llm-deadline.ts`.** The contract requires the helper to live beside the sentences it recognises and the hook to import rather than restate them. Both still hold: the sentences and the helper share `llm-answer-notice.ts`, and `llm-deadline.ts` still exports all of them. What changes is only which FILE the bytes sit in, so that a `"use client"` importer stops dragging `node:path` and `node:fs/promises` into the browser bundle through `./config`.

Stripping from `result.answer` rather than only from the `onComplete` argument is deliberate: `result.answer` is also what `QueryResultPanel` copies to the clipboard and POSTs to `/api/query/save`, so one strip at the assembly point gives every downstream consumer model output only, and the surface owes the owner the sentence back -- which is what `truncationNotice` is for.

## Verification

**Commands:**
- `pnpm test` -- expected: all suites pass, including the untouched `query-stream-deadline.test.ts` and the two new suites.
- `pnpm lint` -- expected: no new errors.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `grep -rn "llm-deadline" src/hooks src/app/query src/components` -- expected: no hit. The client surfaces import `@/lib/llm-answer-notice` only.
- `grep -n "^import" src/lib/llm-answer-notice.ts` -- expected: at most one line, importing `./workbench-settings`.

**Manual checks (if no CLI):**
- `pnpm build` is already broken at HEAD on two pre-existing client-to-server edges (`SystemHealthDesk.tsx`, `KnowledgeStudio.tsx`), so it is not a pass/fail gate here. Confirm instead that no webpack import trace in its output names `useStreamingQuery.ts` or `src/app/query/page.tsx`.
