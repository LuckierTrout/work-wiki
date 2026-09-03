---
title: 'Pin the read-only queue contract DEPLOY.md publishes to operators'
type: 'chore'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
baseline_revision: 'a7d2b07f714ef04efa73b3b80cfa71012a40567d'
deferred:
  - summary: >-
      "Queued work is replayable, not lost" rests on the consumer's queue
      CONFIG, and no test reads that config at all.
    evidence: |-
      `workers/task-consumer/wrangler.jsonc` declares the `yopedia-tasks`
      consumer's `dead_letter_queue: "yopedia-tasks-dlq"` and `max_retries: 3`,
      which paired with `MAX_DELIVERY_ATTEMPTS = 4`
      (`workers/task-consumer/index.ts:56`) is what turns "the consumer retried"
      into "the message survived". Repo-wide, the only tests that open either
      wrangler file are `src/lib/__tests__/e2e-identity.test.ts:147-157`, which
      asserts only `not.toMatch(/YOPEDIA_E2E\b/)`, and
      `brand-copy.test.ts:952,1000`, which are frozen spelling-list entries that
      never read the file. DW-647's new pins build `bindings` by hand and never
      touch the config. Deleting the `dead_letter_queue` line leaves the whole
      suite green while a read-only deployment DISCARDS every queued message
      once retries are exhausted — the exact inversion those pins exist to
      prevent. Bumping `max_retries` to 5 likewise stays green while `attempts =
      4` stops being the final delivery, staling DEPLOY.md's "up to four
      delivery attempts". Only the code->config direction is covered: changing
      `MAX_DELIVERY_ATTEMPTS` does break the `attempts = 4` receipt assertion.
    location: >-
      workers/task-consumer/wrangler.jsonc:27
    severity: low
---

<intent-contract>

## Intent

**Problem:** DEPLOY.md now publishes the read-only queue behaviour as an operator alerting contract — `POST /api/tasks/run` answers 403 with `READ_ONLY_REFUSAL.queuedWork`, and the consumer retries that 403 rather than dropping it, so "queued work is replayable, not lost" — yet all three halves are unpinned: no test drives the route's 403 (the one door-coverage scan matching it also matches `isReadOnlyError(`, which the route's catch already spells, so deleting the early gate stays green), `task-consumer.test.ts` never drives a 403 (adding `|| res.status === 403` to the poison set stays green and inverts the documented outcome), and the two refusal sentences DEPLOY.md quotes inline are reachable by neither existing DEPLOY.md parity pin because both harvest only lines beginning with `>`.

**Approach:** Add three test pins in the repo's established idioms — a read-only `describe` in `tasks-route.test.ts` modelled on `scan-route.test.ts`'s, a 403 case in `task-consumer.test.ts` asserting retry-not-ack, and a DEPLOY.md inline-quote parity case in `read-only-copy-parity.test.ts` comparing against `READ_ONLY_REFUSAL`.

## Boundaries & Constraints

**Always:** Tests only — no production behaviour changes. Follow each host suite's existing idiom (env save/clear/restore around `YOPEDIA_READONLY`, `READ_ONLY_REFUSAL` imported rather than string literals retyped, comments that state *why* the case exists). The `tasks-route.test.ts` read-only pin must fail if the early `isReadOnly()` gate is deleted, which means asserting the 403 status AND the exact body AND that no work ran. The `task-consumer.test.ts` pin must fail if `403` is appended to the consumer's poison set, which means asserting `retry()` was called and `ack()` was not.

**Block If:** Nothing. Every fact needed is already established in the code and DEPLOY.md.

**Never:** Do not touch `workers/task-consumer/index.ts`, `src/app/api/tasks/run/route.ts`, `src/app/api/tasks/scan/route.ts`, `src/lib/read-only.ts` or `DEPLOY.md`. In particular, do NOT correct the stale "4xx means the consumer ACKS AND DROPS / discarded rather than replayable" comments in `tasks/run/route.ts`, `tasks/scan/route.ts` or `scan-route.test.ts` — that is DW-645, a separate open ledger entry outside this bundle. Do not widen `read-only-door-coverage.test.ts`'s regex or restructure either existing DEPLOY.md parity pin. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read-only run door | `YOPEDIA_READONLY=1`, valid service token, well-formed task body | `POST /api/tasks/run` answers 403 with `{ error: READ_ONLY_REFUSAL.queuedWork }`; no ingest/reingest/lint-fix/rebuild mock is called | No error expected — the refusal is the answer |
| Gate sits behind auth | `YOPEDIA_READONLY=1`, no service principal | 401 `{ error: "Unauthorized" }`, not 403 | No error expected |
| Gate precedes body parse | `YOPEDIA_READONLY=1`, malformed/unparseable body | 403 with the refusal, not 400 | No error expected |
| Writable deployment unchanged | `YOPEDIA_READONLY` unset | Existing suite behaviour (200/400/…) — no case turns into a 403 | No error expected |
| Consumer meets a 403 | Queue message whose `/api/tasks/run` call answers 403 | `message.retry()` called once; `message.ack()` never called | No error expected |
| Consumer 403 on last attempt | Same, `attempts = 4` | Still retried (DLQ parking is the queue's job); a final failure receipt is mailed | No error expected |
| DEPLOY.md inline quotes | DEPLOY.md read off disk | Contains `{"error": "<sentence>"}` for `maintenanceScan` and `queuedWork`, character-identical to the constants | Test fails naming the drifted key |

</intent-contract>

## Code Map

- `src/lib/__tests__/tasks-route.test.ts` -- DW-646 host. `run(body, headers?)` helper at :188; `beforeEach` at :199 does `vi.clearAllMocks()` and sets `mockedGetService` to the service principal; `describe("POST /api/tasks/run")` at :236. **Has no `YOPEDIA_READONLY` handling at all today** — a value in a developer's shell would turn every existing case into a 403, so the save/clear/restore has to be added to the shared `beforeEach`/`afterEach` alongside the new pin. `@/lib/config` is mocked with `...(await orig())`, so `isReadOnly()` is the real env-reading implementation.
- `src/lib/__tests__/scan-route.test.ts:70-100, 432-480` -- the idiom to copy: `savedReadOnly` capture + `delete` in `beforeEach` (with the "a developer's shell" comment), restore in `afterEach`, and a separate `describe("… on a read-only deployment")` that sets `YOPEDIA_READONLY = "1"` in its own `beforeEach` and asserts status, body against `READ_ONLY_REFUSAL.maintenanceScan`, and `not.toHaveBeenCalled()` on every worker.
- `src/app/api/tasks/run/route.ts:150-179` -- the door. 401 first, then `if (isReadOnly()) return NextResponse.json({ error: READ_ONLY_REFUSAL.queuedWork }, { status: 403 })`, then `req.json()`. READ-ONLY for this spec (its comment is DW-645).
- `src/lib/read-only.ts:316` -- `queuedWork: "Queued work cannot run while this deployment is read-only."`; `maintenanceScan` is its sibling. READ-ONLY.
- `src/lib/__tests__/task-consumer.test.ts` (98 lines) -- DW-647 host. `message(attempts = 1)` returns an email-carrying `ingest` body with `ack`/`retry` spies; `env(response)` builds bindings whose `YOPEDIA.fetch` resolves that one `Response`. Existing cases cover 200 → ack, 422 → ack, 503 (attempts 4) → retry + final failure receipt.
- `workers/task-consumer/index.ts:114` -- the poison set: `res.status === 400 || res.status === 404 || res.status === 422` → ack. `:126-139` is the transient branch a 403 falls to → `message.retry()`, with a final failure email once `message.attempts >= MAX_DELIVERY_ATTEMPTS` (`= 4`, :55). READ-ONLY.
- `src/lib/__tests__/read-only-copy-parity.test.ts` (615 lines) -- DW-648 host. Already imports `readFile`/`path` from node and `READ_ONLY_REFUSAL`; `routeSource()` reads route files off disk; the file's last cases iterate `Object.entries(READ_ONLY_REFUSAL)` for whole-table invariants. Add the DEPLOY.md case near those.
- `DEPLOY.md:583-584` and `:604-606` -- the two inline quotes, both in the JSON-body form `{"error": "…"}` inside prose. Verified: these are the ONLY two `READ_ONLY_REFUSAL` sentences present anywhere in DEPLOY.md. READ-ONLY.
- `src/lib/__tests__/workbench-settings.test.ts:6240` and `src/components/__tests__/embedding-substitution-copy-parity.test.tsx:191` -- the two existing DEPLOY.md pins. Both build `blocks` from lines starting with `>`; neither can see an inline quote. Read them for voice; do not modify them.
- `AGENTS.md:32-60` -- `*.test.ts` ⇒ node project, `*.test.tsx` ⇒ dom project. All three host suites are node-project `.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/tasks-route.test.ts` -- add `YOPEDIA_READONLY` save/clear/restore to the shared `beforeEach`/`afterEach` (adding an `afterEach` if none exists), then add a `describe("POST /api/tasks/run on a read-only deployment")` covering the first four I/O rows: the 403 + exact `READ_ONLY_REFUSAL.queuedWork` body with every ingest/maintain worker mock un-called, the 401-still-wins case, and the gate-before-body-parse case -- DW-646: the door's status and sentence are an operator alerting contract with zero test references, and the one scan that reaches it passes with the gate deleted.
- `src/lib/__tests__/task-consumer.test.ts` -- add a 403 case asserting `retry()` once and `ack()` never, plus a `attempts = 4` variant showing the final failure receipt still goes out -- DW-647: the poison set is what "replayable, not lost" rests on, and today many poison sets (including one containing 403) satisfy every case.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add a case reading `DEPLOY.md` off disk and asserting it contains the `{"error": "<sentence>"}` JSON form for `READ_ONLY_REFUSAL.maintenanceScan` and `READ_ONLY_REFUSAL.queuedWork`, failing by key name -- DW-648: the repo established this idiom twice for this same file, but both harvest only `>`-prefixed lines and cannot reach an inline quote.

**Acceptance Criteria:**
- Given the early `isReadOnly()` gate is deleted from `src/app/api/tasks/run/route.ts`, when `pnpm exec vitest run --project node src/lib/__tests__/tasks-route.test.ts` runs, then it fails.
- Given `|| res.status === 403` is appended to the poison-set condition at `workers/task-consumer/index.ts:114`, when `pnpm exec vitest run --project node src/lib/__tests__/task-consumer.test.ts` runs, then it fails.
- Given either `READ_ONLY_REFUSAL.maintenanceScan` or `READ_ONLY_REFUSAL.queuedWork` is reworded without editing DEPLOY.md, when `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts` runs, then it fails and the message names which key drifted.
- Given `YOPEDIA_READONLY=1` is exported in the shell, when the full node project runs, then no pre-existing `tasks-route.test.ts` case changes outcome.
- Given no production file is edited, when `git diff --name-only` is inspected, then it lists only the three test files (plus the spec).

## Design Notes

The DEPLOY.md pin must match the JSON-body form, not the bare sentence, because that is what the doc actually publishes and what an operator's alert rule would be copied from. Build the expected needle from the constant so the test never retypes the sentence:

```ts
const doc = await readFile(path.resolve(__dirname, "../../../DEPLOY.md"), "utf8");
for (const key of ["maintenanceScan", "queuedWork"] as const) {
  expect({ key, quoted: doc.includes(`{"error": "${READ_ONLY_REFUSAL[key]}"}`) })
    .toEqual({ key, quoted: true });
}
```

For the consumer 403 case, `env()` already returns a single canned `Response`; `env(Response.json({ error: READ_ONLY_REFUSAL.queuedWork }, { status: 403 }))` is enough — but the worker imports no `src/lib`, so retype nothing: import the constant in the test, which also ties the doc-quoted body to the fixture.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/task-consumer.test.ts src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project node` -- expected: no new failures versus the pre-change baseline.
- `pnpm lint` -- expected: clean.
- Mutation checks (revert each after): delete the `isReadOnly()` block in `tasks/run/route.ts`; append `|| res.status === 403` to the consumer poison set; reword `READ_ONLY_REFUSAL.queuedWork`. Each must make the corresponding suite fail.

## Auto Run Result

Status: done

**Change.** Three test-only pins for the read-only queue contract DEPLOY.md publishes to operators. No production file was touched.

**Files changed:**
- `src/lib/__tests__/tasks-route.test.ts` — `YOPEDIA_READONLY` save/clear/restore added to the shared hooks (the suite had none, so an exported shell value would have turned every case into a 403), plus a `POST /api/tasks/run on a read-only deployment` describe: the 403 with the exact `READ_ONLY_REFUSAL.queuedWork` body and ten worker mocks un-called, both `maintain` arms, 401-still-wins, and refusal ahead of the body parse.
- `src/lib/__tests__/task-consumer.test.ts` — a 403 driven through `worker.queue`, asserting `retry()` once, `ack()` never and no receipt at `attempts = 1`; and the `attempts = 4` variant still retrying and mailing a receipt that quotes the refusal.
- `src/lib/__tests__/read-only-copy-parity.test.ts` — `tasks/run` added to the by-NAME door list, and a new case holding DEPLOY.md's inline `{"error": "…"}` quotes to `maintenanceScan` and `queuedWork`, whitespace-normalized, with a whole-table sweep for future inline quotes.

**Review findings:** 8 patches applied (0 high, 3 medium, 5 low), 1 deferred, 5 rejected. Followup review recommendation: **false** — 0 of the 8 patched findings were high severity.

**Verification:**
- `pnpm exec vitest run --project node` — 295 files, 7959 passed, 1 skipped.
- The three suites alone — 95 passed; identical with `YOPEDIA_READONLY=1` exported, so the env hygiene isolates correctly.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices). `pnpm exec tsc --noEmit` — clean.
- Mutation checks, each reverted: deleting the `isReadOnly()` gate → 3 failures in `tasks-route.test.ts` (and, as the ledger predicted, `read-only-door-coverage.test.ts` stays green); appending `|| res.status === 403` to the consumer poison set → 2 failures; rewording `queuedWork` or `maintenanceScan` → the DEPLOY.md pin fails naming the key; retyping the refusal as a literal in the route → the new by-NAME row fails while `tasks-route.test.ts` stays green; hoisting the receipt out of the final-attempt guard → the `attempts = 1` case fails; re-wrapping DEPLOY.md's quote across two lines → passes, correctly not read as drift.

**Residual risks:**
- The repo now carries tests asserting the direct opposite of the prose in `src/app/api/tasks/run/route.ts:166-173` and `src/lib/__tests__/scan-route.test.ts`. That contradiction is DW-645, deliberately outside this bundle; both new comment blocks point at it so the next reader is not misled.
- "Not lost" still rests on `workers/task-consumer/wrangler.jsonc`'s DLQ and retry settings, which no test reads. Recorded in `deferred`.
- The DW-648 whole-table sweep only fires on sentences DEPLOY.md quotes; a doc that stops mentioning a door altogether is still unpinned.
