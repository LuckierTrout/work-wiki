---
title: 'Classify store faults by type at three sibling routes and the task classifier'
type: 'bugfix'
created: '2026-08-31'
baseline_revision: '63f09c4092ddee40feaa4780f3dd79d48fc22566'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `isStoreFault`'s `/^E[A-Z0-9]+$/` errno probe matches any errno-shaped
      code, so non-storage failures (network `ECONNREFUSED`, `ETIMEDOUT`,
      `ECONNRESET`) classify and log as "store fault", while Node's
      underscore-style storage codes (`ERR_FS_FILE_TOO_LARGE`) match neither
      it nor the message ladders.
    evidence: |-
      The predicate keys on the SHAPE of `code`, not on a storage errno set.
      No status outcome changes today: at `POST /api/tasks/run` a network
      errno reached the same 500 by fall-through before this change, and its
      message ("getaddrinfo ENOTFOUND host") never matched `/not found/i`.
      What is wrong today is the NAME and the log line
      `task "<kind>" hit a store fault`, which sends an operator to the disk
      for an outbound-network fault. An allowlist was considered and not
      taken here: it would have to enumerate storage errnos, and it would
      still miss the `ERR_FS_*` family, so it trades one wrong answer for
      another without the intent to say which is preferred.
    location: >-
      src/lib/errors.ts:41
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three sibling POST routes classify a failure by message regex — `/required|invalid|blocked|threshold|at most/i` (`src/app/api/monitors/route.ts:53`), `/required|invalid|add at least/i` (`src/app/api/system/evaluations/route.ts:58`) and `/required|invalid|owner|does not change|too large/i` (`src/app/api/review/proposals/route.ts:78`) — so a storage fault whose sentence reads `EINVAL: invalid argument, open '…'` is reported to the caller as their own 400 and retried forever (DW-481). Separately, `POST /api/tasks/run`'s ladder has rows for `/not found/i`, `ClientInputError` and an ingest-only auto-retry cap and nothing else, so the corrupt-registry refusal DW-297 introduced reaches the final 500 by fall-through — bounded retry to the DLQ, arguably right, but an unpinned accident with no test at the task surface and no row anyone can read (DW-482).

**Approach:** Introduce one store-fault type in `src/lib/errors.ts` — `StoreFaultError` plus an `isStoreFault` predicate that also recognises Node errno failures (`EINVAL`, `EACCES`, `ENOSPC`, …) — throw it from `research-projects.ts`'s `parseRegistry`, then test on it at both surfaces: the three routes classify a store fault as 500 ahead of their message ladder, and `POST /api/tasks/run` gains an explicit store-fault row that returns 500 ahead of `/not found/i` so the refusal can never be poisoned as a missing page.

## Boundaries & Constraints

**Always:** The three routes classify by type first (store fault → 500, `ClientInputError` → 400) and only then fall through to the existing message ladder, which stays for those modules' still-untyped validation throws. `parseRegistry`'s three messages and its `cause` chaining are preserved verbatim — only the constructor changes. `StoreFaultError` extends `Error` directly and subclasses nothing, so every existing `instanceof` ladder that ends in a 500 keeps returning 500. Behaviour comments in every touched file must be rewritten to match the new code.

**Block If:** Ingest task classification would change. `POST /api/tasks/run`'s ingest auto-retry cap (`queueAttempt >= 3` → 422) must still win for `task.kind === "ingest"`, store fault or not — this bundle pins `run-research`, it does not re-decide ingest.

**Never:** Do not retype `validateSlug`, `validateTenant` or `validateUrlSafety` (`src/lib/wiki.ts`, `src/lib/url-safety.ts`) — they are shared by the whole app and their throws are what the three ladders legitimately 400. Do not touch the other ~18 message ladders under `src/app/api`, the sibling `[id]` routes of these three, or `runSourceMonitor`'s throws. Do not change any status code any surface returns today. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Storage fault on create | `createSourceMonitor` rejects with a Node error carrying `code: "EINVAL"` and message `EINVAL: invalid argument, open '…'` | `POST /api/monitors` returns 500, message unchanged | `isStoreFault` true — was a 400 on `/invalid/` |
| Storage fault, sibling doors | Same errno shape from `saveRetrievalEvalCase` / `createMemoryChangeProposal` | `POST /api/system/evaluations` and `POST /api/review/proposals` return 500 | Same |
| Caller's bad input | `createSourceMonitor` throws `Error("Monitor name is required")` | `POST /api/monitors` still returns 400 | Message ladder, unchanged |
| Typed caller input | Any of the three stores throws a `ClientInputError` | 400 | By type, ahead of the ladder |
| Corrupt registry on a task | `run-research` task; `runResearchProject` rejects with `StoreFaultError("Research projects file is not a list.")` | `POST /api/tasks/run` returns 500 (bounded queue retry → DLQ), message unchanged | Explicit store-fault row, not fall-through |
| Store fault worded like a miss | Store fault whose message contains "not found" | Still 500, never the 422 poison | Store-fault row runs before `/not found/i` |
| Ingest at the auto-retry cap | `kind: "ingest"`, `queueAttempt >= 3`, any failure incl. a store fault | 422, exactly as today | Ingest cap still wins |

</intent-contract>

## Code Map

- `src/lib/errors.ts` -- the new type lives here beside `ClientInputError` (`:22`), whose docblock ("Lets routes classify by type rather than by string-matching the message") is the precedent to mirror. `isEnoent` (`:30`) is the existing errno-probing shape to reuse for `isStoreFault`'s Node branch.
- `src/lib/research-projects.ts:383-398` -- `parseRegistry`'s three throws (`unreadable`, `not a list`, `entry N is invalid`) become `StoreFaultError`. Its long docblock (`:333-382`) says the throw "is a plain `Error` on purpose"; that paragraph is now stale and must be rewritten. Messages and the `{ cause: error }` on the parse throw are preserved verbatim — tests match on them.
- `src/app/api/tasks/run/route.ts:860-933` -- the classifier. `const exhausted = …queueAttempt >= 3` at `:868` and the final ingest cap at `:929` compute the same predicate twice; hoist it once and reuse it so the new store-fault row can exclude ingest without a third copy. `graphifyFailureIsTerminal` (`:883`) is read-only evidence — it keeps its own `/not found/i` + `ClientInputError` shape, unchanged.
- `src/app/api/monitors/route.ts:48-54`, `src/app/api/system/evaluations/route.ts:54-59`, `src/app/api/review/proposals/route.ts:74-79` -- the three identical catch blocks. Each gains the two typed branches ahead of its own regex; the regexes themselves stay.
- `src/app/api/research/[id]/run/route.ts:126-136` -- read-only evidence: an `instanceof` ladder ending in a bare 500. `StoreFaultError` subclasses none of its classes, so the corrupt-registry refusal keeps the 500 `src/lib/__tests__/research-run-route.test.ts:784-798` (DW-576) already pins.
- `src/lib/__tests__/tasks-route.test.ts` -- task-surface suite. `run()` (`:180`) posts a task body; the top-of-file `vi.mock` block is where `@/lib/research-runtime` must be added (it is not mocked today, and no `run-research` row exists yet). `:787` is the pattern for a classification row.
- `src/lib/__tests__/research-route.test.ts:1-9` -- the route-classification test recipe to copy for the three sibling routes: mock `@/lib/auth` and the store module, import the handler directly, assert status only.
- `src/lib/__tests__/errors.test.ts` -- 71 lines, `getErrorMessage` + `isEnoent`; the new type's rows append here.
- `src/lib/__tests__/research-projects.test.ts:385-460`, `:588` -- read-only evidence: rows asserting `rejects.toThrow("Research projects file is not a list.")` and the `cause` chain. They must keep passing untouched — proof the retype is message-preserving.

## Tasks & Acceptance

**Execution:**
- `src/lib/errors.ts` -- add `StoreFaultError` (a stored-artifact fault: a server fault, never the caller's, repairable in place) and `isStoreFault(error)` returning true for it and for Node errno errors whose `code` matches `/^E[A-Z0-9]+$/` -- the errno branch is what closes DW-481, since the `EINVAL` the ledger names is thrown by the filesystem, not by us.
- `src/lib/research-projects.ts` -- throw `StoreFaultError` from `parseRegistry`'s three refusals and rewrite the "plain `Error` on purpose" paragraph -- this is the store fault the task classifier and the route ladders now test on.
- `src/app/api/monitors/route.ts`, `src/app/api/system/evaluations/route.ts`, `src/app/api/review/proposals/route.ts` -- classify store fault → 500 and `ClientInputError` → 400 ahead of the message ladder, with a comment naming the ladder as the residual branch for the module's untyped validation throws -- the ladder alone reported a broken disk as the caller's 400.
- `src/app/api/tasks/run/route.ts` -- hoist the `queueAttempt >= 3` predicate to one const, then add a store-fault row returning 500 ahead of `/not found/i`, excluded for an ingest task at the cap -- gives the classifier the row DW-482 says it lacks without re-deciding ingest.
- `src/lib/__tests__/errors.test.ts` -- add rows for `StoreFaultError`'s name/message/`cause` and for `isStoreFault` across a `StoreFaultError`, an `EINVAL` errno error, a `ClientInputError`, a plain `Error` and a non-Error value.
- `src/lib/__tests__/store-fault-routes.test.ts` -- new suite covering the Matrix's first four rows across all three sibling routes.
- `src/lib/__tests__/tasks-route.test.ts` -- mock `@/lib/research-runtime` and add the Matrix's `run-research` rows: a `StoreFaultError` is 500, a store fault worded "not found" is still 500, and an ingest task at the cap is still 422.

**Acceptance Criteria:**
- Given the three sibling POST routes, when the store rejects with a Node `EINVAL` error, then the response is 500 and the body carries the store's own message; when it rejects with a validation message those routes 400 today, the response is still 400.
- Given a `run-research` task whose project store refuses a corrupt registry, when `POST /api/tasks/run` handles it, then the response is 500 and the run is left to the queue's bounded retry rather than poisoned at 422.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-31 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 18: (high 0, medium 0, low 18)
- addressed_findings:
  - `[medium]` `[patch]` The `research-projects.ts` retype was unverified: the three corrupt-registry rows in `src/lib/__tests__/research-projects.test.ts` asserted only the message plus `not.toBeInstanceOf(ClientInputError)`, which a plain `Error` satisfies — and the run's own comments had been rewritten to claim `StoreFaultError`. Added a positive `rejects.toBeInstanceOf(StoreFaultError)` to all three rows. Mutation-verified: reverting the retype now fails 13 tests where it previously failed 0.
  - `[low]` `[patch]` `isStoreFault` read `.code` off an arbitrary `unknown` before proving `instanceof Error`, so a throwing `code` getter would raise a second fault inside a catch block. Reordered to guard first, then read; dropped the redundant `| null` cast.
  - `[low]` `[patch]` The rewritten `parseRegistry` docblock's closing "Matches `parseSlots` … the same way" read, after a paragraph about the new type, as claiming `parseSlots` is also typed. Reworded to say what is actually shared (the fail-closed refusal) and to state that `parseSlots` still throws plain `Error`s and is out of scope.
  - `[low]` `[patch]` `src/lib/__tests__/store-fault-routes.test.ts` never asserted the mocked store was reached, so any body that stopped passing the routes' real un-mocked pre-store validation would have let the two 400 rows pass off the wrong 400. Added `toHaveBeenCalledTimes(1)` per case, and replaced all three invented `untypedValidationMessage` values with the modules' verbatim throws. Mutation-verified: breaking the monitors `targetSlug` now fails 7 rows where it previously failed 0.

## Design Notes

`isStoreFault` is what makes DW-481 fixable without a repo-wide retype. The `EINVAL` the ledger names never passes through our code as a typed throw — it comes off the filesystem — so no amount of `ClientInputError` conversion in `source-monitors.ts` / `retrieval-evals.ts` / `memory-proposals.ts` would catch it. Probing the errno `code` does, and it is the same shape `isEnoent` already uses one function up.

```ts
export function isStoreFault(error: unknown): boolean {
  if (error instanceof StoreFaultError) return true;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return error instanceof Error && typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}
```

The ladders stay because the three POST paths all run `validateSlug` (and monitors `validateUrlSafety`), whose "Invalid slug: …" / "URL blocked: …" throws are genuinely the caller's and are shared by the whole app. Deleting the regex without retyping those would turn a caller's bad slug into a 500 — a worse bug than the one being fixed.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/errors.test.ts src/lib/__tests__/store-fault-routes.test.ts src/lib/__tests__/tasks-route.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-run-route.test.ts` -- expected: all pass, including the untouched `parseRegistry` message rows
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
- `pnpm test` -- expected: full suite green

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Store faults are now classified by TYPE at the four surfaces the bundle names, instead of by message regex. `StoreFaultError` and `isStoreFault` were added to `src/lib/errors.ts`; `parseRegistry`'s three refusals throw the new type with their messages and `cause` chaining byte-identical; the three sibling POST doors test on type ahead of their (retained) ladders; and `POST /api/tasks/run` gained an explicit store-fault row ahead of `/not found/i`, guarded so the ingest auto-retry cap still wins.

DW-481 closes on the errno half of the predicate: the `EINVAL: invalid argument, open '…'` the ledger names comes off the filesystem, never through our code as a typed throw, so no amount of retyping in the store modules would have caught it. DW-482 closes by giving the classifier a readable row: the corrupt-registry refusal reaches its 500 by decision rather than by fall-through, and can no longer be poisoned at 422 if its sentence happens to read like a miss.

### Files changed

- `src/lib/errors.ts` -- added `StoreFaultError` (extends `Error` directly, accepts `ErrorOptions`) and `isStoreFault`, which recognises that type plus Node errno failures.
- `src/lib/research-projects.ts` -- `parseRegistry`'s three throws retyped; the stale "plain `Error` on purpose" paragraph rewritten.
- `src/app/api/monitors/route.ts`, `src/app/api/system/evaluations/route.ts`, `src/app/api/review/proposals/route.ts` -- each POST catch classifies store fault → 500 and `ClientInputError` → 400 ahead of its unchanged regex ladder, now documented as the residual branch.
- `src/app/api/tasks/run/route.ts` -- hoisted the twice-computed ingest auto-retry predicate into `ingestRetriesExhausted`; added the store-fault 500 row ahead of `/not found/i`, excluded at the ingest cap.
- `src/lib/__tests__/errors.test.ts` -- rows for the new type and predicate.
- `src/lib/__tests__/store-fault-routes.test.ts` (new) -- the Matrix's route rows across all three doors, each asserting the store was actually reached.
- `src/lib/__tests__/tasks-route.test.ts` -- mocks `@/lib/research-runtime`; adds the `run-research` and ingest-cap classification rows.
- `src/lib/__tests__/research-projects.test.ts` -- positive `StoreFaultError` type assertions on the three corrupt-registry rows, plus comment corrections.

### Review findings breakdown

- Patches applied: 4 (1 medium, 3 low) — see the Review Triage Log entry above.
- Items deferred: 1 (low) — `isStoreFault`'s errno probe matches on shape, so it over-claims network errnos and under-claims `ERR_FS_*` codes. Recorded in frontmatter `deferred`.
- Items rejected: 18 (all low) — predominantly pre-existing behaviour not caused by this change (the doors have always echoed the store's sentence and have never logged; a malformed JSON body has always 500'd), speculative shapes with no instance in the tree (a `ClientInputError` carrying an errno `code`), work the intent's Never clause excludes (the `[id]` sibling routes, the other ~18 ladders, `parseSlots`/`ResearchLeaseError`), and design choices the spec makes explicitly (keeping the residual ladders per-route rather than extracting a shared helper).

### Follow-up review recommendation

`true`. Patched findings this pass: high 0, medium 1, low 3. Score = (3 x 1) + (1 x 3) = 6, which is >= 5.

### Verification performed

- `pnpm exec vitest run --project node` over the five spec-named files -- 5 files, 223 passed.
- `pnpm exec tsc --noEmit` -- clean, exit 0.
- `pnpm lint` -- clean; only the three pre-existing `jsx-ast-utils` notices.
- `pnpm test` -- 355 files, 8507 passed, 1 skipped, exit 0.
- Matrix test audit -- all seven I/O Matrix rows have a covering test that ran and passed; test names confirmed via `--reporter=verbose`.
- Both high-value pins were mutation-verified rather than assumed: reverting the `parseRegistry` retype fails 13 tests, and breaking a request body so a route 400s before the store fails 7 tests. Both failed 0 before the patches.

### Residual risks

- The producer-to-consumer chain is pinned at each end, not end-to-end. `research-projects.test.ts` now proves `parseRegistry` throws `StoreFaultError`, and `tasks-route.test.ts` proves the classifier answers 500 for one; nothing asserts that `runResearchProject` passes the refusal through uncaught. It does today (`src/lib/research-runtime.ts:1693` calls `getResearchProject` outside any `try`), but a future `try` there would break DW-482's guarantee with both suites still green.
- The store-fault row at `POST /api/tasks/run` applies to every task kind, not only `run-research`. The only case where that differs from the old behaviour is an error that is both a store fault and worded "not found" — which the Matrix explicitly wants at 500 — but for an `extract-knowledge` task, `graphifyFailureIsTerminal` would still mark the Graphify page terminally failed while the route returns 500 for retry. No such error exists in the tree today (Node's ENOENT reads "no such file or directory", and `R2NotFoundError` carries the same sentence).
- The full-suite green was observed in a working tree that also held another session's in-flight DW-406 work (`src/lib/embeddings.ts`, `src/lib/__tests__/embeddings.test.ts`). Those files are excluded from this run's commit. The five spec-named suites pass in isolation.
