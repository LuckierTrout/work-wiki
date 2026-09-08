---
title: 'Task doors keep the contracts their own docs state (DW-134, DW-746)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: '296d3610a7bda6ec0c466d3b0b888c7211fc263d'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `POST /api/chat/conversations/[id]/save` runs a full inline `ingest()` under the
      same 20 s client deadline this bundle bounded at the intake and Activity doors.
    evidence: |-
      `src/app/api/chat/conversations/[id]/save/route.ts:125` calls `enqueueOrInline`
      with no `inlineBudgetMs`, so where `enqueueTask` returns false the whole compile
      (LLM map/reduce, retries, embeddings) runs inside the request. `saveAnswerToWiki`
      in `src/lib/chat-conversation-store.ts:200` reaches that route through `send`,
      which arms `REQUEST_TIMEOUT_MS = 20_000` (`src/lib/workbench-request.ts:141`), and
      `send`'s body read classifies the abort through `unconfirmedCause` — so the owner
      is told the outcome is unknown about an answer page that is still being written.
      Exactly DW-746's shape at a door this bundle's intent did not name; the
      `inlineBudgetMs` docblock now names it rather than denying it, but nothing tracks
      it. Not caused by this change: the option stays opt-in and every other caller is
      byte-for-byte as it was.
    location: >-
      src/app/api/chat/conversations/[id]/save/route.ts:125
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two task-adjacent doors contradict their own documentation. `POST /api/tasks/scan?dry=1` is documented as the one true inspection switch, yet `rebuildDerivedIndexes()` and `purgeStaleJobs()` both write before the first `forceDry` guard is consulted (DW-134). The Workbench Activity retry and embed-rebuild doors call `enqueueOrInline` with no `inlineBudgetMs`, so an off-Workers inline `ingest()`/`rebuildVectorStore()` outlives the 20 s client deadline `send` arms and the owner is told the outcome is unknown about work that is still running (DW-746).

**Approach:** Move the index rebuild and the ingest-job GC behind the same `!forceDry` guard every other byte-writing block already uses, report zeroed counts under `?dry=1`, and rewrite the route docblock so it says what the code does. At the Activity door, mirror the intake door: capture an answer budget at route entry and hand `enqueueOrInline` the remainder on both retry paths.

## Boundaries & Constraints

**Always:**
- `?dry=1` (`forceDry`) is the gate for the two moved calls — NOT `dry`. `AUTONOMOUS_MAINTENANCE` off must keep self-healing the indexes and purging stale jobs, exactly as the docblock's first paragraph says.
- Under `?dry=1` the scan response keeps every field it has today; `indexRebuild` becomes `{}` and `jobsPurged` becomes `0`.
- The Activity budget is a REMAINDER measured from route entry (`answerBy - Date.now()`, floored at 0), like `intake/route.ts:659` — never a fixed margin.
- Any new budget constant stays strictly below `REQUEST_TIMEOUT_MS` with at least 1 s of room, and is pinned in the existing ladder test.
- Every prose claim touched (route docblock, the inline comments beside the moved calls, `EnqueueOrInlineOptions.inlineBudgetMs`, the scan suite's read-only docblock, the consumer README's inspection step) must match the post-change behavior.

**Block If:**
- Making `?dry=1` write-free would require changing what a non-dry scan does.
- The ladder pin cannot accommodate a second answer budget without weakening what it asserts about the intake rung.

**Never:**
- Do not gate the moved calls on `dry` (that would stop the default-flag deployment from self-healing).
- Do not change `enqueueOrInline` itself, or add a budget to any other caller (`/api/ingest*`, agents, email, chat save, extract-dispatch, `ingest-embed`) — the option stays opt-in.
- Do not touch the read-only 403 ordering at either door, and do not roll back stored bytes on a budget expiry.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dry inspection | `POST /api/tasks/scan?dry=1`, `AUTONOMOUS_MAINTENANCE=on` | 200; `rebuildDerivedIndexes` and `purgeStaleJobs` never called; `indexRebuild: {}`, `jobsPurged: 0`, `enqueued: 0` | No error expected |
| Flag off, no `?dry=1` | `POST /api/tasks/scan`, flag unset | 200 `dry: true`; rebuild + purge still called once each and their real counts reported | Fail-soft inside `maintenance.ts`, unchanged |
| Read-only scan | `YOPEDIA_READONLY=1` | 403 before any of it, unchanged | Refusal copy unchanged |
| Activity ingest retry, queue absent | `POST /api/workbench/activity {action:"retry"}`, inline run longer than the budget | 200 `{queued:true, jobId, retried:true}` before the client deadline; run keeps going and still marks the job | Inline rejection after the budget is logged, not unhandled |
| Activity embed retry, queue absent | same, `job.kind === "embed"` | Same budgeted shape; `rebuildVectorStore()` no longer holds the connection open | As above |
| Activity retry, queue present | `enqueueTask` returns true | `{queued:true, jobId}` immediately; budget never consulted | Unchanged |

</intent-contract>

## Code Map

- `src/app/api/tasks/scan/route.ts` -- `POST`. `forceDry` at :106, `dry` at :108. `rebuildDerivedIndexes()` at :121 and `purgeStaleJobs()` at :124 run unguarded; every other byte-writing block (:221, :232, :245, :256, :268) uses `if (!forceDry)`. Response fields at :282/:283. Docblock :31-72 — :37-46 (correct, about `AUTONOMOUS_MAINTENANCE`) versus :48-51 ("suppresses every one of those side-effecting blocks", false today). Read-only comment :79-95 repeats the "every pass" claim.
- `src/lib/maintenance.ts` -- `rebuildDerivedIndexes()` at :226 returns `Record<string, {ok, error?}>` (so the zeroed shape is `{}`); `purgeStaleJobs()` at :295 returns a number.
- `src/lib/__tests__/scan-route.test.ts` -- the executed route suite (mocks `@/lib/maintenance` wholesale). `?dry=1` suppression cases at :275, :317, :361, :406, :444 are the pattern to copy. `"self-heals the derived indexes every run (even in dry-run)"` at :489 pins the flag-off case and stays green; its title becomes inaccurate. Read-only describe docblock at :518-525 repeats the "run every pass" claim.
- `workers/task-consumer/README.md` -- dry-run definition at :65-70 and the "Inspect what it would do" step at :78-85; DW-134 names this as the doc the fix makes true.
- `src/app/api/workbench/activity/route.ts` -- `POST` at :95. Embed rebuild `enqueueOrInline` at :123-137, ingest retry at :184-201. No answer budget anywhere in the file.
- `src/app/api/workbench/intake/route.ts` -- the door to mirror: `answerBy` captured at :110 after the 401/403, threaded through, spent at :658-660 as `Math.max(0, input.answerBy - Date.now())`.
- `src/lib/constants.ts` -- `FETCH_TIMEOUT_MS` :53, `INTAKE_ANSWER_BUDGET_MS` :82 with the three-rung ladder docblock. New Activity budget belongs here.
- `src/lib/workbench-request.ts` -- `REQUEST_TIMEOUT_MS = 20_000` at :72; `send` arms it at :141, which is what `ActivityDock.tsx:143`/:193 inherit.
- `src/lib/ingest-async.ts` -- `EnqueueOrInlineOptions.inlineBudgetMs` docblock :29-55; :40-46 names the Activity door as "still open" and must be rewritten. `enqueueOrInline` :67; the race and the abandoned-run handling need no change.
- `src/lib/__tests__/workbench-request.test.ts` -- ladder pin at :413-426, intake wiring scan at :428-442. Extend both.
- `src/lib/__tests__/workbench-epic2-routes.test.ts` -- executed Activity POST suite; `enqueueOrInline` mocked at :23, retry cases at :264 and :291. Assert the budget argument here.
- `src/lib/__tests__/workbench-left-column.test.ts:1263-1272` -- source scan over the Activity route; keep every string it asserts.

## Tasks & Acceptance

**Execution:**
- `src/app/api/tasks/scan/route.ts` -- move `rebuildDerivedIndexes()` and `purgeStaleJobs()` into `if (!forceDry)` blocks that leave `indexRebuild = {}` and `jobsPurged = 0` otherwise; rewrite the docblock so the `AUTONOMOUS_MAINTENANCE` paragraph no longer lists them as running regardless and the `?dry=1` paragraph is true; correct the moved calls' inline comments and the read-only comment's "run on every pass" claim -- the route's doc is the contract DW-134 is about.
- `src/lib/__tests__/scan-route.test.ts` -- add a `?dry=1` case asserting neither mock is called and both response fields are zeroed; retitle/annotate the `:489` case so it pins the flag-off half rather than "every run"; fix the read-only describe docblock -- the ledger's decision names this test explicitly.
- `workers/task-consumer/README.md` -- state at the inspection step that `?dry=1` writes nothing at all, so the recommended "inspect what it would do" is safe against a live deployment.
- `src/lib/constants.ts` -- add `ACTIVITY_ANSWER_BUDGET_MS` with a docblock naming its rung (below `REQUEST_TIMEOUT_MS`, no fetch rung beneath it) and why it is a remainder.
- `src/app/api/workbench/activity/route.ts` -- capture `answerBy` after the 401/403 and pass `{ inlineBudgetMs: Math.max(0, answerBy - Date.now()) }` at both `enqueueOrInline` calls, with a comment naming the client deadline it is ordered against.
- `src/lib/ingest-async.ts` -- rewrite the `inlineBudgetMs` docblock: the Activity door is now bounded, not "still open".
- `src/lib/__tests__/workbench-request.test.ts` -- extend the ladder pin to the new constant and add a wiring scan for the Activity route mirroring the intake one.
- `src/lib/__tests__/workbench-epic2-routes.test.ts` -- assert both Activity retry paths hand `enqueueOrInline` an `inlineBudgetMs` that is positive and no larger than the budget -- the wiring is otherwise invisible to the executed suite.

**Acceptance Criteria:**
- Given `AUTONOMOUS_MAINTENANCE=on` and a service token, when `POST /api/tasks/scan?dry=1` runs, then `rebuildDerivedIndexes` and `purgeStaleJobs` are not called and the 200 body carries `indexRebuild: {}` and `jobsPurged: 0`.
- Given `AUTONOMOUS_MAINTENANCE` unset, when `POST /api/tasks/scan` runs with no `dry` param, then both still run once and their counts are reported, so a default-flag deployment keeps self-healing.
- Given the scan route's docblock, when it is read against the handler, then no sentence claims a block runs that `?dry=1` now suppresses.
- Given the queue is absent and the inline run outlasts the budget, when the Activity door retries an `ingest` or `embed` job, then the route answers `{queued:true, jobId, retried:true}` inside the budget and the abandoned run still marks the job.
- Given either Activity retry path, when `enqueueOrInline` is called, then its fourth argument carries `inlineBudgetMs` derived from a route-entry deadline, floored at 0.
- Given the budget ladder, when the constants are compared, then `ACTIVITY_ANSWER_BUDGET_MS < REQUEST_TIMEOUT_MS` with at least 1 s of room.
- Given `pnpm test` and `pnpm exec tsc --noEmit`, when they run, then both pass with no new failures.

## Design Notes

`dry` versus `forceDry` is the whole of DW-134. `dry = forceDry || !enabled`; gating on `dry` would stop a default-flag deployment from ever rebuilding an index or purging a job, which is a behavior change nobody asked for. `forceDry` is what the other five blocks use and what the docblock's inspection paragraph is about.

The Activity budget is a second constant rather than a reuse of `INTAKE_ANSWER_BUDGET_MS`: the intake rung sits above `FETCH_TIMEOUT_MS` because it wraps a server fetch, and the Activity door reaches no fetch, so the two are justified independently even where their values agree today.

```ts
// activity/route.ts, after the 401/403
const answerBy = Date.now() + ACTIVITY_ANSWER_BUDGET_MS;
// ... at each enqueueOrInline
{ inlineBudgetMs: Math.max(0, answerBy - Date.now()) }
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/scan-route.test.ts src/lib/__tests__/workbench-epic2-routes.test.ts src/lib/__tests__/workbench-request.test.ts src/lib/__tests__/ingest-async.test.ts src/lib/__tests__/workbench-left-column.test.ts` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm test` -- expected: no new failures against the pre-change baseline.

## Auto Run Result

Status: done

### What was implemented

Two task-adjacent doors were made to match their own documentation.

**DW-134 — `?dry=1` is now genuinely write-free.** `rebuildDerivedIndexes()` and `purgeStaleJobs()` moved behind `if (!forceDry)`, joining the five byte-writing blocks already gated there, and report `indexRebuild: {}` / `jobsPurged: 0` on a dry pass. The guard is `forceDry`, not `dry`: `AUTONOMOUS_MAINTENANCE` gates unattended page EDITS, so a default-flag deployment must keep healing its indexes and collecting its garbage — that half is pinned by its own test. The route docblock's self-contradiction (the flag paragraph listing both as running regardless versus the `?dry=1` paragraph claiming it suppresses everything) is resolved in favour of what the code now does.

**DW-746 — both Activity retry doors are bounded.** `answerBy` is captured at route entry from the new `ACTIVITY_ANSWER_BUDGET_MS`, and the remainder is handed to `enqueueOrInline` at the embed-rebuild and stored-Source re-ingest call sites, mirroring `intake/route.ts`. Past the budget the route answers `{ queued: true, jobId, retried: true }` — the shape `ActivityDock` already polls — while the run goes on marking the job, instead of leaving the client to abort on work that is still going.

### Files changed

- `src/app/api/tasks/scan/route.ts` — both upkeep calls gated on `forceDry` with zeroed defaults; docblock and the read-only comment rewritten to match.
- `src/lib/__tests__/scan-route.test.ts` — `?dry=1` case asserting the whole mocked write set stays uncalled and both counts are empty; the flag-off case widened to pin the half that must not change.
- `workers/task-consumer/README.md` — the dry-run definition, the flag parenthetical, the inspection step and the sample response all name the two upkeep blocks.
- `workers/task-consumer/index.ts` — the cron's own enumeration extended (comment only).
- `src/lib/constants.ts` — new `ACTIVITY_ANSWER_BUDGET_MS = 17_000` with its rung documented.
- `src/app/api/workbench/activity/route.ts` — route-entry `answerBy`; `inlineBudgetMs` remainder at both `enqueueOrInline` calls.
- `src/lib/ingest-async.ts` — `inlineBudgetMs` docblock names the two budgeted doors and the one still-open door (`chat save`) instead of denying that any remain.
- `src/lib/__tests__/workbench-epic2-routes.test.ts` — shape assertions on both retry paths plus a stall case pinning the budget as a remainder.
- `src/lib/__tests__/workbench-request.test.ts` — Activity ladder pin and a two-call-site wiring scan.
- `src/lib/__tests__/ingest-async.test.ts` — a budget is never consulted when the enqueue succeeds.

### Review findings

- Patches applied: 4 (medium 1, low 3) — see the Review Triage Log.
- Deferred: 1 (low) — the chat-save door, recorded in frontmatter `deferred`.
- Rejected: 5 — the elapsed-budget outcome (already exercised: the mocked `enqueueOrInline` returns exactly the abandoned shape and the route's composition over it is asserted); a `forceDry` response field to tell the two dry modes apart (a response contract addition the intent does not ask for, and the only automated caller — the cron — never sends `?dry=1`); `?dry=true`/`?dry=yes` not matching `=== "1"` (pre-existing parse, unchanged in kind by this diff); a budget clamped to 0 abandoning immediately (by design, identical to the intake door — the run continues and marks the job, which is what the client polls); and the `!dry`-versus-`!forceDry` reading (`!dry` would stop a default-flag deployment from ever self-healing, contradicting the same documentation this bundle exists to honour).
- Follow-up review recommended: **false** — patched severities were medium 1, low 3; no `high` patch.

### Verification

- `pnpm exec tsc --noEmit` — clean.
- `pnpm test` — 388 files, 9782 passed, 1 skipped, 0 failed.
- `pnpm exec eslint` on every changed source and test file — clean.
- Negative checks: reverting the two route files fails exactly the new assertions and no others; simulating a per-call-site `answerBy` capture fails only the new remainder pin, confirming the shape assertions cannot catch it.
- Every I/O matrix row has a covering test that ran and passed.

### Residual risks

- Both answer budgets are 17 s today. They are separate constants with separately argued rungs and separate ladder pins, so a future move of the intake rung will not silently drag the Activity door — but nothing forces them apart either.
- The Activity wiring scan pins `inlineBudgetMs` and `answerBy - Date.now()` at exactly two occurrences in that route; a legitimate third budgeted call site there would need the count updated.
- `?dry=1` writing nothing is asserted at this route's mocked collaborator boundary (every write-capable module in the handler is mocked wholesale), not at the storage adapter. That set is the route's whole write surface today; a future writer reached by some other import would not be caught by it.
