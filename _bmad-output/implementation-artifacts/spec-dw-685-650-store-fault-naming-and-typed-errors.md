---
title: 'Store-fault naming honesty and the typed poison decision at the task door'
type: 'refactor'
created: '2026-09-03'
status: 'done'
baseline_revision: '342637f68b7d583d3fc8cb4841db7f4bcb3b5547'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `isStoreFault` (`src/lib/errors.ts:81`) probes the SHAPE of `code` with `/^E[A-Z0-9]+$/`, so an outbound-network failure (`ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`) is classified and logged as a "store fault" — `POST /api/tasks/run` prints `task "<kind>" hit a store fault` and sends an operator to the disk for a network fault. In the same catch, the poison-vs-retry verdict still reads `/not found/i` over the message, and `run-research` is now the consumer of `runResearchProject`'s typed `ResearchProjectNotFoundError`, so a permanent 422 is silently coupled to that class's DEFAULT message string with nothing pinning the coupling.

**Approach:** Rename the predicate and its log line to what they actually detect — a fault in the infrastructure beneath us, disk **or** network — leaving the classification (500, bounded retry) and the `StoreFaultError` class untouched. Then give the poison decision the `instanceof ResearchProjectNotFoundError` arm that `POST /api/research/[id]/run` already uses for its 404, keeping `/not found/i` as the residual branch for the doors that still throw untyped misses, and pin the decoupling with a typed throw whose message does not say "not found".

## Boundaries & Constraints

**Always:**
- The rename is name-only: every current true/false answer of the predicate stays identical, and every route's status mapping is byte-identical afterwards.
- The typed arm is ADDITIVE — `/not found/i` stays as the residual branch, so the untyped misses (`reingest`'s `page "x" not found`) keep their 422, and a duplicated module graph that defeats `instanceof` still falls back to the regex.
- Update every reference to the old symbol name, including doc comments that name it (`src/lib/ingest.ts:543`, `src/lib/__tests__/store-fault-routes.test.ts:47`).

**Block If:**
- The rename cannot be applied without changing a status outcome at any of the four doors.

**Never:**
- Do NOT narrow the errno probe to a storage-errno allowlist. DW-685 explicitly considered and rejected it: an allowlist must enumerate storage errnos and would still miss the `ERR_FS_*` family, trading one wrong answer for another.
- Do NOT rename or retire the `StoreFaultError` class, or change what `research-projects.ts` throws.
- Do NOT touch `isStoreFault`'s leading `instanceof StoreFaultError` identity check — that is DW-725, a separate open ledger row.
- Do NOT change the `graphifyFailureIsTerminal` regex at `src/app/api/tasks/run/route.ts:904`; `extract-knowledge` never receives a `ResearchProjectNotFoundError`.
- Do NOT reorder the catch ladder: the infrastructure-fault row stays AHEAD of the poison row (DW-482), and the ingest auto-retry-cap guard stays as it is.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Renamed predicate, store fault | `isInfrastructureFault(new StoreFaultError("…is not a list."))` | `true` | No error expected |
| Renamed predicate, disk errno | `Error` with `code: "EINVAL"` | `true` | No error expected |
| Renamed predicate, network errno | `Error` with `code: "ECONNREFUSED"` | `true` — the name now tells the truth about it | No error expected |
| Renamed predicate, non-errno | `ClientInputError`, plain `Error`, `{ code: "EINVAL" }`, `null` | `false` | Never throws on a hostile `code` getter — `instanceof Error` is proven first |
| Task door, typed research miss | `run-research` task; `runResearchProject` rejects with `new ResearchProjectNotFoundError("Research project is retired")` | 422, message echoed | Poisoned by TYPE, not by the message string |
| Task door, default-message research miss | `runResearchProject` rejects with `new ResearchProjectNotFoundError()` | 422 | Unchanged from today |
| Task door, untyped miss | `reingest` rejects with `page "x" not found` | 422 | Residual `/not found/i` branch still decides it |
| Task door, network errno | any task kind rejects with `code: "ECONNREFUSED"` | 500, log line names an infrastructure fault (not the disk) | Bounded queue retry, never the 422 poison |

</intent-contract>

## Code Map

- `src/lib/errors.ts:66-91` -- `StoreFaultError` (unchanged) and `isStoreFault` (`:81`) — the predicate to rename. Its docblock's "storage fault … off the filesystem itself" framing is the lie DW-685 names. `src/lib/errors.ts:41` cites it from `isClientInputError`'s docblock as the guard-before-read precedent; that cross-reference must follow the rename.
- `src/app/api/tasks/run/route.ts:26` -- the import. `:940-956` is the catch's decision pair: the store-fault row (`:948`, guarded `&& !ingestRetriesExhausted`) and its log line (`:949`), then the poison row (`:953`). `:904` is `graphifyFailureIsTerminal` — same regex, different door, out of scope.
- `src/app/api/tasks/run/route.ts:351-360` -- the `run-research` arm calling `runResearchProject`; its throws land in the catch above.
- `src/lib/research-projects.ts:57-62` -- `ResearchProjectNotFoundError`, default message `"Research project not found"` (the string the regex agreed with by accident). Import it into the task route. The module is NOT mocked in `tasks-route.test.ts`, so the test and the route share one class instance.
- `src/lib/research-runtime.ts:1722` and `:1910` -- the two `runResearchProject` throws, both with the DEFAULT message today.
- `src/app/api/research/[id]/run/route.ts:129` -- the established `instanceof ResearchProjectNotFoundError` arm (DW-480/DW-577) this change mirrors.
- `src/app/api/monitors/route.ts:3,51-60`, `src/app/api/system/evaluations/route.ts:3,56-65`, `src/app/api/review/proposals/route.ts:3,76-85` -- the three sibling POST doors. Import + call + the "A store fault (…)" comment lead-in; no log line to change.
- `src/lib/__tests__/errors.test.ts:7,111-149` -- the `isStoreFault` describe block: import and every call site.
- `src/lib/__tests__/tasks-route.test.ts:113-115` -- `@/lib/research-runtime` is mocked to `{ runResearchProject }` only. `:144` imports `StoreFaultError`. `:848-893` is the existing `run-research` describe where the new typed row belongs; `:891` already pins the untyped miss at 422.
- `src/lib/ingest.ts:543` and `src/lib/__tests__/store-fault-routes.test.ts:47` -- prose naming `isStoreFault` directly; must follow the rename. `src/lib/research-projects.ts:485` names the route's "store-fault row" and should read the new row name.

## Tasks & Acceptance

**Execution:**
- `src/lib/errors.ts` -- rename `isStoreFault` to `isInfrastructureFault` and rewrite its docblock to state what it detects: a `StoreFaultError` we threw, or ANY Node errno failure from the infrastructure beneath us — the filesystem or the network — never the caller's input. Record why the errno probe stays shape-based (an allowlist must enumerate storage errnos and still misses `ERR_FS_*`). Update the `{@link}` in `isClientInputError`'s docblock. Body logic unchanged. -- the predicate's name, not its verdict, is what was wrong.
- `src/app/api/tasks/run/route.ts` -- swap the import and call to `isInfrastructureFault`; change the log line to `task "<kind>" hit an infrastructure fault`; add `err instanceof ResearchProjectNotFoundError ||` ahead of `/not found/i` in the poison row, importing the class from `@/lib/research-projects`; comment why the regex survives as the residual branch. -- stops routing an operator to the disk for a network fault, and decouples the 422 from a message string.
- `src/app/api/monitors/route.ts`, `src/app/api/system/evaluations/route.ts`, `src/app/api/review/proposals/route.ts` -- swap import + call, and reword each catch comment's "A store fault (…)" lead-in to name an infrastructure fault. -- keep the three sibling doors reading true after the rename.
- `src/lib/ingest.ts`, `src/lib/research-projects.ts`, `src/lib/__tests__/store-fault-routes.test.ts` -- update the doc comments that name `isStoreFault` or the route's "store-fault row" by name. -- prose that names a symbol must name the symbol that exists.
- `src/lib/__tests__/errors.test.ts` -- rename the describe block and every call; add a row asserting the network errnos (`ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`) return `true`, with a comment that this is now the NAMED behavior rather than an accident. -- pins the honesty the rename buys.
- `src/lib/__tests__/tasks-route.test.ts` -- in the existing `run-research` describe, add a row rejecting with `new ResearchProjectNotFoundError("Research project is retired")` and asserting 422; keep the existing untyped-miss row. Import the class from `@/lib/research-projects`. -- the message deliberately does NOT match `/not found/i`, so the row fails against the regex-only decision and passes only against the typed arm.

**Acceptance Criteria:**
- Given a `run-research` task whose runtime rejects with a `ResearchProjectNotFoundError` carrying a message that does not contain "not found", when `POST /api/tasks/run` handles it, then the response is 422 (permanent poison), not 500.
- Given any task failing with a network errno, when the task door classifies it, then the emitted log line names an infrastructure fault rather than a store fault, and the status is still 500.
- Given the full suite, when `pnpm test` runs, then no source or test file references the identifier `isStoreFault`, and every status assertion at the four doors is unchanged from before this spec.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 0, low 7)
- defer: 0
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[low]` `[patch]` `src/lib/errors.ts` docblock claimed the probe "matches every errno Node attaches" and that an outbound `ECONNREFUSED` answers `true`. Verified false on two counts: `/^E[A-Z0-9]+$/` has no `_` in its class (`EAI_AGAIN`, `ERR_FS_*` miss), and undici's `fetch` rejects with `TypeError: fetch failed` keeping the errno on `.cause`, so a fetch-shaped network failure answers `false`. Rewrote the paragraph to state both limits explicitly as pre-existing and out of this pass's scope.
  - `[low]` `[patch]` The poison-row comment claimed the surviving regex "also catches the typed miss under a duplicated module graph" — true only for a DEFAULT-message miss, not a reworded one. Qualified, and the residue pointed at DW-725.
  - `[low]` `[patch]` The same comment attributed `"Research project is retired"` to `runResearchProject`; that wording is `queueResearchProject`'s, at the research door. Reattributed.
  - `[low]` `[patch]` The comment did not say why `graphifyFailureIsTerminal` keeps its bare regex. Added the reason: it decides `extract-knowledge`, a kind this class can never reach.
  - `[low]` `[patch]` Two residual "store fault" / "store-fault row" phrases survived inside the catch prose the rename touched (`route.ts` hoist comment and the DW-482 paragraph). Renamed.
  - `[low]` `[patch]` The new hostile-getter test comment overclaimed — the `instanceof Error` guard protects only NON-Error values; an `Error` subclass with a throwing `code` getter would still throw. Scoped the comment to what the guard actually reaches.
  - `[low]` `[patch]` The three sibling-door comments were left with a 119-character line and ragged wrap after the reword. Rewrapped to the surrounding ~80 columns.

## Design Notes

The predicate keeps its shape-based errno probe on purpose. The ledger already priced the alternative: an allowlist would have to enumerate storage errnos, would still miss `ERR_FS_*`, and DW-685 declined to pick a winner between two wrong answers. What the rename buys is that the over-broad answer is no longer a LIE — every errno it matches really is infrastructure beneath us, and 500-plus-bounded-retry is the right verdict for all of them.

The typed arm is additive rather than a replacement because the door serves ten task kinds and only `run-research` throws typed. Ordering, with the reason each row sits where it does:

```ts
// infrastructure fault → transient 500 (DW-482), ahead of the poison row
if (isInfrastructureFault(err) && !ingestRetriesExhausted) { … }
// permanent → 422. Typed first (DW-650), regex as the residual branch.
if (err instanceof ResearchProjectNotFoundError || /not found/i.test(message)) { … }
```

`ResearchProjectNotFoundError` carries no errno `code` and is not a `StoreFaultError`, so the two rows stay disjoint and the ingest-cap guard is untouched.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/errors.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/store-fault-routes.test.ts` -- expected: all pass, including the new network-errno and typed-poison rows.
- `pnpm test` -- expected: no new failures against the pre-change baseline.
- `pnpm lint` -- expected: clean.
- `grep -rn "isStoreFault" src/` -- expected: no matches.

## Auto Run Result

Status: done

**Implemented change.** `isStoreFault` is now `isInfrastructureFault` — a name-only rename whose body is byte-identical, so no status outcome moved at any of the four doors. The task door's operator sentence changed from `task "<kind>" hit a store fault` to `task "<kind>" hit an infrastructure fault`, which is the DW-685 harm: a refused socket was sending an operator to the disk. The poison-vs-retry row gained `err instanceof ResearchProjectNotFoundError ||` ahead of `/not found/i`, so a research miss is 422 by TYPE instead of by that class's default message string (DW-650); the regex survives as the residual branch for the nine untyped task kinds.

**Files changed.**
- `src/lib/errors.ts` -- renamed the predicate; docblock now states the union it detects and both limits of the shape-based probe (`.cause`-wrapped fetch errnos, underscore-bearing codes).
- `src/app/api/tasks/run/route.ts` -- renamed call + log line; typed arm on the poison row; `ResearchProjectNotFoundError` imported from `@/lib/research-projects`.
- `src/app/api/monitors/route.ts`, `src/app/api/system/evaluations/route.ts`, `src/app/api/review/proposals/route.ts` -- renamed call, comment reworded; no logic change.
- `src/lib/ingest.ts`, `src/lib/research-projects.ts`, `src/lib/__tests__/store-fault-routes.test.ts` -- doc comments naming the old symbol or the old row name.
- `src/lib/__tests__/errors.test.ts` -- renamed describe/calls; new network-errno rows; hostile-getter row.
- `src/lib/__tests__/tasks-route.test.ts` -- three new rows in the `run-research` describe (network errno + log sentence, typed miss with a non-matching message, default-message typed miss).

**Review findings breakdown.** 7 patches applied (all low — see the Review Triage Log). 0 items deferred. 7 items rejected: `isInfrastructureFault`'s leading identity check (already open as DW-725); swapping `instanceof` for a `name` check (the intent names `instanceof`); converting `graphifyFailureIsTerminal` (spec Never clause, and the class cannot reach that kind); unwrapping `.cause`, widening the regex to `_`, or admitting `TimeoutError` (all re-scope the predicate, which DW-685 declined to do); an `Error` subclass with a throwing `code` getter (pre-existing, unchanged here); "a transient admission miss is poisoned at 422" — checked at `research-runtime.ts:1907-1910` and it is not transient, `getResearchProject` returns `null` only for a genuinely absent row, and the outcome is identical before and after; and the unmodified deferred-work ledger, which is orchestrator-owned.

**Follow-up review recommendation.** false. Patched findings by severity: high 0, medium 0, low 7. Score: 0 high patches ⇒ no further iteration.

**Verification performed.**
- `pnpm exec vitest run src/lib/__tests__/errors.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/store-fault-routes.test.ts` -- 126 passed.
- `pnpm test` -- 374 files, 9347 passed, 1 skipped, 0 failures (run before and after the review patches).
- `pnpm lint` -- exit 0 (only the pre-existing `jsx-ast-utils` plugin warnings).
- `grep -rn "isStoreFault" src/` -- no matches.
- Mutation check: reverting the poison row to regex-only makes `422s a typed ResearchProjectNotFoundError whose message never says 'not found'` fail with `expected 500 to be 422`; the row is not vacuous.
- Every I/O matrix row is covered by a test that ran and passed, including the log-sentence row, pinned through a `console.error` spy.

**Residual risks.**
- The predicate's over-claim is now named rather than removed: a network errno still classifies as an infrastructure fault. That is the reading DW-685 selected, and the verdict (500 + bounded retry) is right for it.
- Its under-claim is unchanged and now documented: `EAI_AGAIN`, the `ERR_FS_*` family, and any `fetch`-shaped failure (errno on `.cause`) answer `false` and reach the same 500 by fall-through instead of by decision.
- `runResearchProject` still throws only the default message, so the typed arm and the regex agree in production today; the new test is what keeps them from silently diverging when either throw is reworded.
