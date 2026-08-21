---
title: 'Wall-clock refresh budget and an in-flight guard for the dataVersion watcher (DW-377)'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
baseline_revision: 'ba0fe7c0b7992113c03439968e8e7162e2d0b1d9'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The dataVersion refresh budget is per MOUNTED WATCHER, not per tab, so any
      remount silently re-arms it.
    evidence: |-
      `refreshStateRef` seeds from `NO_DATA_VERSION_REFRESH` on every mount
      (`DataVersionWatcher.tsx`), so React StrictMode's development double-mount,
      a route change, or any remount of the Workbench shell hands the watcher a
      fresh budget for a version it has already spent one on. Both the rule's
      docblock and `data-version.ts`'s prose read as a per-tab guarantee ("a
      degraded read costs a fixed number of wasted renders per observed
      version") and are really a per-mount one. Pre-existing: DW-48 shipped the
      same ref-seeded shape and its docblock names the reset as a feature
      (nothing persisted) without noting it is also the escape hatch from the
      bound. Not caused by this story, which only changes what the state holds.
    location: >-
      src/components/workbench/DataVersionWatcher.tsx (refreshStateRef)
    severity: low
  - summary: >-
      `pnpm vitest` and `pnpm lint` abort before running, so the repo's own
      documented commands cannot be used and every verification runs through
      `npx`.
    evidence: |-
      Both abort with `ERROR packages field missing or empty` from the pnpm
      workspace config; `npx vitest run` and `npx eslint .` on the same tree run
      clean. `spec-dw-48-data-version-refresh-retry.md`'s Auto Run Result records
      the identical failure, so it long predates this story. It matters because
      `vitest.config.ts`'s own comment states that `.github/workflows/ci.yml`
      runs `pnpm test` and nothing else — whatever the exact script resolution,
      the documented developer entry points are broken.
    location: >-
      package.json / pnpm-workspace.yaml
    severity: low
---

<intent-contract>

## Intent

**Problem:** `dataVersionRefreshPlan` counts refreshes per QUALIFYING POLL and stamps no time on its state, so the budget's meaning changes with the poll cadence and with how many triggers fire: three alt-tabs or three saves spend `DATA_VERSION_REFRESH_ATTEMPTS` in milliseconds and re-strand the version (the DW-48 symptom, now probabilistic). The same shape burns an attempt on a `router.refresh()` that is merely still rendering — the watcher fires `run()` from the interval, the visibility handler and the nudge with only an `AbortController` on the *fetch*, and no guard at all against an in-flight refresh.

**Approach:** Replace the attempt count with a WALL-CLOCK budget for one observed version — a retry window measured from the first refresh, plus a settle interval that declines a re-refresh while the previous one has not had time to land. Both live in the same pure rule the node suite executes; the watcher's only new spelling is the clock reading it hands in.

## Boundaries & Constraints

**Always:**
- The decision AND the next state come back from `dataVersionRefreshPlan` in `workbench-data-version.ts`. `DataVersionWatcher.tsx` keeps spelling no comparison, no arithmetic and no constant of its own — the existing source-scan guards in `workbench-data-version.test.ts` stay, re-pinned to the new spelling.
- Both bounds are wall-clock milliseconds in exported constants, and neither is derived from `DATA_VERSION_POLL_MS`. Changing the cadence must not change either bound — that is the whole of DW-377, and a test pins it.
- Forward-only survives: a polled value at or below `served` never refreshes, and the attempt version stays a high-water mark a backwards read cannot rewrite downward.
- A degraded read (`page.tsx` stuck at `0`, route answering `7`) still costs a FIXED number of wasted renders per observed version, at ANY trigger rate — never a loop.
- State stays in a ref, resets on remount, is never persisted.
- A version ABOVE the one attempted is new data and refreshes immediately; the settle interval guards repeats of the SAME version only.

**Block If:**
- The wall-clock shape cannot be expressed without the watcher re-implementing part of the comparison.

**Never:**
- No `setTimeout`, no backoff timer, no second polling cadence, nothing to cancel on unmount — the rule reads a clock, it does not schedule.
- No change to `fetchDataVersion`, `previewFetchPlan`, the route, `DATA_VERSION_POLL_MS`, the nudge registry, or the watcher's supersede-the-wedged-poll behaviour (`abortRef` per run) — that is pinned and deliberate.
- No new client-side fetch of tree data; `router.refresh()` stays the tree refetch.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

State is `{ version, firstRefreshAt, lastRefreshAt }`. `WINDOW` = `DATA_VERSION_REFRESH_WINDOW_MS` (30_000), `SETTLE` = `DATA_VERSION_REFRESH_SETTLE_MS` (10_000). All times below are `now` in ms.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New version observed | served 3, polled 4, now 1000, seed state | refresh, state → `{4, 1000, 1000}` | No error expected |
| Re-render caught up | served 4, polled 4, state `{4,1000,1000}` | no refresh, SAME state object back | No error expected |
| Refresh still in flight (DW-377) | served 3, polled 4, now 1500, state `{4,1000,1000}` | no refresh, SAME state object back | Not "did not catch up" |
| Settled, still behind — retry (DW-48) | served 3, polled 4, now 11_000, state `{4,1000,1000}` | refresh, state → `{4, 1000, 11_000}` | No error expected |
| Window closed — give up | served 0, polled 7, now 31_000, state `{7,1000,21_000}` | no refresh, SAME state object back | Bounded; not a loop |
| New bump after giving up | served 0, polled 8, now 31_500, state `{7,1000,21_000}` | refresh, state → `{8, 31_500, 31_500}` | New data always wins |
| Backwards read | served 5, polled 4, seed state | no refresh, SAME state object back | Eventual consistency is not a change |
| Poll behind an outstanding attempt | served 0, polled 5, state `{7,1000,1000}` | no refresh, SAME state object back | High-water mark not rewritten down |
| Clock jumps BACKWARDS | served 3, polled 4, now 500, state `{4,1000,1000}` | no refresh, SAME state object back | Degrades to fewer refreshes, never a loop |
| Poll not `ok` | `stale` / `unavailable` | never reaches the decision | Swallowed; loop survives |

</intent-contract>

## Code Map

- `src/lib/workbench-data-version.ts:118-135` -- `DATA_VERSION_REFRESH_ATTEMPTS` and its docblock (which currently asserts "It is emphatically not a wall-clock window" and names the three triggers as the leak) are what this story deletes and replaces. `:137-158` `DataVersionRefreshState` / frozen `NO_DATA_VERSION_REFRESH` / `DataVersionRefreshPlan`; `:160-219` the rule's docblock; `:220-238` `dataVersionRefreshPlan` itself — four branches, each returning the state it should leave behind. `previewFetchPlan` (`:262-268`) is the house idiom the returned-state shape copies; leave it alone.
- `src/components/workbench/DataVersionWatcher.tsx:74-102` -- `refreshStateRef = useRef(NO_DATA_VERSION_REFRESH)` (`:77`) and `run()`'s plan call (`:88-98`). Only change: add `now: Date.now(),` to the plan input. `abortRef`, the supersede-on-every-trigger behaviour, `startPolling`/`stopPolling`/`onVisibility` and the whole cleanup are READ-ONLY — the wedge test pins them. Docblock `:56-58` describes the attempt arithmetic and must be re-worded.
- `src/lib/__tests__/workbench-data-version.test.ts` -- node project. Line 49 imports `DATA_VERSION_REFRESH_ATTEMPTS`; `describe("dataVersionRefreshPlan")` at `:425-580` is rewritten (its `expectUnchanged` and `drive` helpers are the shape to keep — `drive` must gain a cadence argument so a fast and a slow cadence can be driven). `describe("DataVersionWatcher")` source scan at `:1041-1194`: `:1057` `useRef(NO_DATA_VERSION_REFRESH)`, `:1062-1066` the plan-input pins, `:1073-1082` the comment stripper plus the `[<>]` / `/attempts/i` / `DATA_VERSION_REFRESH_ATTEMPTS` bans, `:1086-1094` the `stateHandling` slice's `/[+\-]\s*\d/` ban, `:1105-1130` the polarity/ordering pins. Every guard's INTENT is preserved; only the names change, plus a new pin that the clock reading is passed and no window/settle constant appears in the watcher.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- dom project. `mountWatcher(served)`/`serve(next)` (`:67-73`) simulate a re-render; `settle(ms)` (`:75-80`) advances fake timers — and `vi.useFakeTimers()` fakes `Date` too, so wall clock is drivable. `DATA_VERSION_REFRESH_ATTEMPTS` is used at `:10, :207, :226, :230, :231, :239, :396` and must be re-expressed against the new constants. The tests at `:157`, `:181`, `:210`, `:242`, `:346` all keep passing on their existing timelines with SETTLE = 10_000 / WINDOW = 30_000 (verify, do not rewrite their intent).
- `src/lib/data-version.ts:54` and `:91-101` -- prose only. `:54` says the attempt state holds a high-water mark (still true, re-word); `:94-101` names `DATA_VERSION_REFRESH_ATTEMPTS` and the "3× per-write amplification" — both must be restated in wall-clock terms without losing the honest amplification admission.
- `vitest.config.ts:86-107` -- `node` runs `src/**/__tests__/**/*.test.ts`, `dom` runs the `.test.tsx` suites. Read-only.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-data-version.ts` -- delete `DATA_VERSION_REFRESH_ATTEMPTS`; export `DATA_VERSION_REFRESH_WINDOW_MS = 30_000` and `DATA_VERSION_REFRESH_SETTLE_MS = 10_000` (plain millisecond literals, neither derived from `DATA_VERSION_POLL_MS`); widen `DataVersionRefreshState` to `{ version, firstRefreshAt, lastRefreshAt }` (seed frozen at all zeroes); add `now: number` to `dataVersionRefreshPlan`'s input and implement the matrix with the branch order in Design Notes -- one pure rule, still returning the caller's next state, with docblocks that say why the budget is spent by REFRESHES ISSUED rather than by elapsed wall clock.
- `src/components/workbench/DataVersionWatcher.tsx` -- pass `now: Date.now(),` into the plan call and re-word the docblock's attempt-arithmetic sentences -- the reading is the watcher's to take, the policy is not.
- `src/lib/__tests__/workbench-data-version.test.ts` -- rewrite the rule's describe to cover every matrix row, both budget edges, the two constants' relationship, a non-finite clock, an idle/hidden gap, and fast/slow cadence drives proving the ceiling is trigger-independent; re-pin the watcher source scan to the new spelling with its guards' intent intact and the `Date.now()` occurrence guard anchored to the state-handling slice -- the node project is where the decision is executed.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- re-express the attempt-count assertions against the new constants and add mounted coverage of an overlapping trigger burst, of a hidden stretch longer than the budget, and of a trigger stream running past the budget -- the lifecycle claims can only be made where the watcher is mounted.
- `src/lib/data-version.ts` -- restate the two prose passages in wall-clock terms -- these docs are the explaining half of this signal and must not name a constant that no longer exists.

**Acceptance Criteria:**
- Given a refresh went out for version `V` and the baseline is still behind it, when a burst of triggers polls `V` again within `DATA_VERSION_REFRESH_SETTLE_MS`, then no further `router.refresh()` is issued and the budget for `V` is not spent — a later poll past the settle interval still retries.
- Given a refresh went out for `V` and the baseline is still behind it, when the tab is hidden (or the machine asleep) for longer than `DATA_VERSION_REFRESH_WINDOW_MS` and then becomes visible, then the immediate re-check still issues the retry `V` is owed — time in which the watcher issued nothing must not spend the budget.
- Given the same degraded route and baseline, when the rule is driven at a poll cadence far faster and far slower than `DATA_VERSION_POLL_MS`, then the refreshes issued for one observed version never exceed `DATA_VERSION_REFRESH_WINDOW_MS / DATA_VERSION_REFRESH_SETTLE_MS`, and that ceiling is unchanged by the cadence.
- Given the budget for `V` is spent (refreshes for it already span the budget) with the baseline still behind, when further polls answer `V`, then no further refresh is issued — and a later poll answering a version above `V` refreshes again.
- Given a `now` that is not a finite number, when the rule is called for a version already refreshed for, then it declines rather than refreshing — the degenerate direction of every clock case is fewer refreshes, never a loop.
- Given `DataVersionWatcher.tsx` source, when scanned, then it contains no version comparison, no arithmetic on the clock reading it takes, no window/settle constant, and exactly one `router.refresh()` reached only after the rule's negated answer returns early.
- Given the watcher's existing lifecycle guarantees (hidden tab silence, immediate check on becoming visible, supersede-a-wedged-poll, full teardown on unmount), when the dom suite runs, then all of them still hold unchanged.

## Spec Change Log

### 2026-08-21 — Amendment 1 (review loop 1)

**Triggering finding.** `[medium]` The give-up bound was specified as raw elapsed wall clock since the first refresh (`now - firstRefreshAt >= WINDOW`). The watcher stops polling entirely while the tab is hidden, so that clock runs while nothing can be issued and nothing can land: a demonstrated mounted run showed a version refreshed for at `t=0`, hidden for 60s, then returned to visible, declining its owed retry forever — the DW-48 symptom (a real bump whose re-render lagged, stranded until the next write) reinstated by the very bound meant to replace the count. A machine asleep past the window, or a forward NTP correction, does the same.

**What was amended.** Sections outside `<intent-contract>` only. The budget is now spent by the REFRESHES ISSUED for a version — the span between the first and the last — rather than by wall clock the watcher was not polling through: give up when `state.lastRefreshAt - state.firstRefreshAt >= WINDOW - SETTLE`. Every I/O-matrix row's verdict and expected state is unchanged under this rule (verified row by row, including `{7,1000,21_000}` at `now 31_000` still giving up on a span of exactly 20_000), so no intent-contract content moved. Design Notes gained the branch order, the ceiling proof, and the clock-jitter note; the ACs gained the hidden-stretch case, the non-finite clock case, and a budget-spent restatement; Tasks gained the new test obligations.

**Known-bad state avoided.** A wall-clock give-up that an idle or hidden watcher can burn without issuing anything — which strands exactly the lagged bump DW-48 exists to catch, in the single most likely way for 30s to pass without polls (alt-tabbing away). The rejected alternative of re-opening the window after a long gap was rejected because it breaks the Always clause "a degraded read still costs a FIXED number of wasted renders per observed version".

**KEEP — must survive re-derivation.**
- The two exported wall-clock constants, their values, and the source-scan test that both are plain millisecond literals not derived from `DATA_VERSION_POLL_MS`.
- The `{ version, firstRefreshAt, lastRefreshAt }` state shape, the frozen all-zeroes seed, and the returned-state idiom in which every declining branch hands back the caller's OWN object (pinned with `toBe`, not `toEqual`).
- The watcher's one-line behavioural diff (`now: Date.now(),`) and every pre-existing source-scan guard in `workbench-data-version.test.ts`, re-pinned rather than dropped.
- The node suite's `drive(served, polls, cadenceMs)` helper, the away-from-zero `T0 = 1_000` clock, `expectUnchanged`, `repeated`, and the "measures the window from the FIRST refresh, so retries cannot slide it" test.
- The mounted DW-377 burst test, and all pre-existing dom lifecycle tests passing on their existing timelines unchanged.
- `data-version.ts`'s prose rewrite, including the honest per-version amplification admission.

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 8: (high 0, medium 1, low 7)
- patch: 0
- defer: 2: (high 0, medium 0, low 2)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[bad_spec]` The wall-clock give-up was consumed by time in which the watcher issued nothing (hidden tab, sleep, forward clock jump), stranding an un-caught-up version and reinstating DW-48. Spec amended to spend the budget by refreshes issued (the span between first and last) rather than by elapsed wall clock; every matrix row verified unchanged.
  - `[low]` `[bad_spec]` `now` was never validated. A non-finite reading makes every elapsed comparison `false`, so the rule would refresh on every poll forever — breaking the "never a loop" invariant. Spec now requires a finite-number guard.
  - `[low]` `[bad_spec]` The `polled === state.version` case was implicit: three sequential guards hung off an equality spelled only in a comment, so any branch inserted above them would silently change their meaning. Spec now requires it spelled.
  - `[low]` `[bad_spec]` Nothing pinned the relationship between the two constants — `SETTLE = 0` makes the ceiling `Infinity` and `SETTLE > WINDOW` deletes the retry, and both test files would happily assert against either. Spec now requires the relationship asserted.
  - `[low]` `[bad_spec]` The budget's upper edge was never asserted reachable: with the last refresh of every drive landing at `T0 + 20_000`, tightening the bound by up to a third kept the whole suite green. Spec now requires the last legal refresh pinned as well as the first illegal one.
  - `[low]` `[bad_spec]` Deterministic timelines asserted ranges where exact numbers are knowable (the flap drive, the give-up drive's final state, the mounted burst's poll count, which also borrowed the render ceiling for an unrelated quantity). Spec now requires exact assertions where the timeline is deterministic.
  - `[low]` `[bad_spec]` The `Date.now()` occurrence guard in the watcher source scan was whole-file, so any future unrelated clock read in that component breaks it. Spec now requires it anchored to the state-handling slice, as the arithmetic ban already is.
  - `[low]` `[bad_spec]` No mounted coverage of a trigger stream running PAST the budget, nor of a hidden stretch longer than it — the two lifecycle claims the node suite's list of numbers cannot make. Spec now requires both.

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 17: (high 0, medium 0, low 17)
- addressed_findings:
  - `[low]` `[patch]` The rule's deliberate carve-out — a NEW bump (`polled > state.version`) still refreshes on a non-finite clock reading — was argued for in two docblocks and executed by no assertion: hoisting the finiteness guard above the new-bump branch left all 77 tests in both suites green. The non-finite test now asserts `refresh: true` for NaN / ±Infinity against both an outstanding state and the seed, and the hoist mutation was confirmed to fail it.
  - `[low]` `[patch]` The `DATA_VERSION_REFRESH_SETTLE_MS` docblock claimed a slipped retry "only DELAYS a retry; it costs nothing", which is false and was the stated reason `SETTLE == DATA_VERSION_POLL_MS` was called tolerable. Measured at the real cadence with latency alternating 200/150 ms against a degraded read, refreshes land at 1_200 and 21_200 only — two, not three, because the whole 20_000 ms to the next eligible answer is charged to the span. Reworded to say the slip costs a retry and that this is why the equality is tolerable — fewer refreshes is the safe direction. Prose only.
  - `[low]` `[patch]` "Refreshes for one version … may span at most `WINDOW - SETTLE`" was inaccurate in four places (both docblocks in `workbench-data-version.ts`, the `data-version.ts` prose, and the ceiling comments in both test files): the span is read BEFORE a refresh is issued, so the achieved span can far exceed the bound — measured 60_000 against a bound of 20_000 after a hidden stretch, which is precisely what the idle-gap test relies on. Reworded to bound the span *at the moment of the decision*; the `ceil(WINDOW / SETTLE)` = 3 conclusion is unchanged and carries its derivation.

## Design Notes

Two exported wall-clock constants, deliberately independent of `DATA_VERSION_POLL_MS`:

- **WINDOW (30s)** — the budget for ONE observed version.
- **SETTLE (10s)** — the in-flight guard. `router.refresh()` returns `void` and its render lands asynchronously, so "still rendering" is unobservable; elapsed time is the honest proxy. Within SETTLE of the last refresh for the SAME version, a repeat answer is not read as "did not catch up".

**The budget is spent by refreshes, not by elapsed time.** Give up when the refreshes already issued for a version SPAN the budget — `state.lastRefreshAt - state.firstRefreshAt >= WINDOW - SETTLE` — never when `now` has merely drifted past `firstRefreshAt + WINDOW`. A hidden tab issues nothing, a sleeping machine issues nothing, and a forward clock correction is not evidence of anything; time in which no refresh could go out must not close the budget, or the watcher strands exactly the lagged bump DW-48 exists to catch.

Branch order (each declining branch returns the caller's OWN state object):

```ts
if (polled <= served) return { refresh: false, state };            // forward-only
if (polled > state.version) return { refresh: true, state: { version: polled, firstRefreshAt: now, lastRefreshAt: now } };
if (polled !== state.version) return { refresh: false, state };    // behind the high-water mark
if (!Number.isFinite(now)) return { refresh: false, state };       // a clock that cannot be compared
if (now - state.lastRefreshAt < SETTLE) return { refresh: false, state };            // still in flight
if (state.lastRefreshAt - state.firstRefreshAt >= WINDOW - SETTLE) return { refresh: false, state }; // spent
return { refresh: true, state: { ...state, lastRefreshAt: now } };
```

**Ceiling.** Refreshes for one version are at least SETTLE apart and may span at most `WINDOW - SETTLE`, so there are at most `ceil(WINDOW / SETTLE)` = 3 of them — the same fixed price DW-48 chose, now independent of both the cadence and the trigger rate. A gap (hidden tab) makes the span jump, so the degenerate direction is always FEWER refreshes, never more. A backwards clock leaves `now - lastRefreshAt` negative, which the settle guard reads as "not landed yet" and declines.

`SETTLE` and `DATA_VERSION_POLL_MS` are both 10_000 today. That is tuning, not derivation: the watcher stamps `now` when the poll ANSWERS, so consecutive ticks are `POLL_MS ± latency jitter` apart and a retry can slip one tick when the later poll answers faster. Under a span-spent budget that only delays a retry — it costs nothing — which is why the equality is tolerable; the fast/slow cadence drives exist to prove the ceiling survives changing either constant alone.

**Where the in-flight guard lives.** DW-377's wording suggests a guard in the watcher. It goes in the rule instead: the watcher's own single-flight machinery (one `AbortController` per run, every trigger superseding the previous poll) is pinned by the wedge test and must not change, and a guard spelled in `DataVersionWatcher.tsx` would be exactly the policy the source scan forbids there. Expressed as SETTLE it is executable by the node project and observable at the mounted surface — the overlapping-trigger test is the watcher-level proof.

The watcher's whole behavioural diff:

```ts
const plan = dataVersionRefreshPlan({
  served: servedRef.current,
  polled: result.version,
  now: Date.now(),
  state: refreshStateRef.current,
});
refreshStateRef.current = plan.state;
if (!plan.refresh) return;
router.refresh();
```

## Verification

**Commands:**
- `npx vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` -- expected: all pass, including every matrix row, both budget edges, the constants' relationship, the non-finite clock, the idle-gap case, and both cadence drives.
- `npx vitest run --project dom src/components/workbench/__tests__/data-version-watcher.test.tsx` -- expected: all pass, including the overlapping-trigger burst, the hidden-stretch retry, the burst-past-the-budget case, and every pre-existing lifecycle case unchanged.
- `npx vitest run` -- expected: no new failures anywhere.
- `npx eslint .` -- expected: exit 0. (`pnpm lint`/`pnpm vitest` abort with a pre-existing `packages field missing or empty` repo-config error; use `npx`.)
- `npx tsc --noEmit` -- expected: exit 0.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

`dataVersionRefreshPlan` no longer counts qualifying polls. It takes a clock reading and bounds one observed version's refreshes with two wall-clock constants — `DATA_VERSION_REFRESH_WINDOW_MS` (30_000) and `DATA_VERSION_REFRESH_SETTLE_MS` (10_000), neither derived from `DATA_VERSION_POLL_MS`. A repeat answer within SETTLE of the last refresh for the same version is declined (the in-flight guard DW-377 asks for, spelled in the rule rather than the watcher so the node project executes it and `DataVersionWatcher.tsx` keeps owning no policy). The budget is given up when the refreshes ALREADY ISSUED span `WINDOW - SETTLE`, never when wall clock has merely drifted — so a hidden tab or a sleeping machine cannot burn a budget it could not spend. The ceiling is `ceil(WINDOW / SETTLE)` = 3, independent of both the poll cadence and the trigger rate; every degenerate clock (a gap, a jump either way, a non-finite reading) costs FEWER refreshes, never more, and never a loop.

### Files changed

- `../../src/lib/workbench-data-version.ts` — `DATA_VERSION_REFRESH_ATTEMPTS` deleted; the two wall-clock constants added; `DataVersionRefreshState` widened to `{ version, firstRefreshAt, lastRefreshAt }` with a frozen all-zeroes seed; `dataVersionRefreshPlan` takes `now` and implements the branch order, every declining branch returning the caller's own state object.
- `../../src/components/workbench/DataVersionWatcher.tsx` — one behavioural line (`now: Date.now(),`) plus the two prose passages that described attempt arithmetic.
- `../../src/lib/data-version.ts` — both prose passages restated in wall-clock terms, the honest per-write amplification admission intact.
- `../../src/lib/__tests__/workbench-data-version.test.ts` — the rule's describe rewritten: every matrix row, both budget edges, the constants' values and their relationship, source scans that both bounds are plain literals and the cadence is referenced nowhere in the module's code, the non-finite and backwards clocks, the idle-gap case, the flap drive, and three cadence drives (250 ms / 10 s / 60 s). Watcher source scan re-pinned to the new spelling with every prior guard's intent intact.
- `../../src/components/workbench/__tests__/data-version-watcher.test.tsx` — attempt-count assertions re-expressed against a derived ceiling; three new mounted tests (an overlapping trigger burst, a hidden stretch longer than the budget, a trigger stream running past the budget). Every pre-existing lifecycle test passes on its original timeline, unmodified.

### Review findings breakdown

- Patches applied: 3 (all low) — the unexecuted non-finite carve-out, and two false or imprecise prose claims in the new docblocks.
- Items deferred: 0 new. The two entries already in frontmatter `deferred` (the budget re-arming per MOUNTED WATCHER, and `pnpm vitest`/`pnpm lint` aborting on a repo workspace-config error) are unchanged and remain open; both are pre-existing.
- Items rejected: 17 (all low). Chiefly: a burst of real saves each bumping the counter refreshes per bump (the intent-contract mandates that new data refreshes immediately, and it is identical under the old rule); the post-gap retry spending the whole budget in one step (deliberate, and the subject of Amendment 1); renaming `WINDOW` for what it bounds, and asserting the constants' relationship at the definition site rather than in a test (both spec-mandated and KEEP-pinned as they are); several test-shape preferences the spec's own KEEP list requires as written; and the ledger entry's `status: open`, which this session is forbidden to edit.

### Follow-up review recommendation

`false`. Patched this pass: high 0, medium 0, low 3. Score = 3 × 0 + 1 × 3 = 3, below the threshold of 5, and no patched finding was high severity.

### Verification performed

- `npx vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` — 58 passed.
- `npx vitest run --project dom src/components/workbench/__tests__/data-version-watcher.test.tsx` — 19 passed.
- `npx vitest run` — 270 files / 6056 tests passed, no new failures (re-run after the patches).
- `npx eslint .` — exit 0. `npx tsc --noEmit` — exit 0.
- Matrix test audit: all ten I/O-matrix rows are covered by tests that ran and passed — nine in the node suite's rule describe, and the "poll not `ok`" row by the mounted `does not refresh on a non-ok answer` / `swallows a transport failure` / `not an integer` cases, which prove the decision is never reached.
- Findings were confirmed by driving `dataVersionRefreshPlan` directly rather than taken on report: the jitter case (2 refreshes, at 1_200 and 21_200), the achieved span after a gap (60_000 against a 20_000 bound), and the new-bump-on-a-broken-clock carve-out all reproduce.

### Residual risks

- `DATA_VERSION_REFRESH_SETTLE_MS` and `DATA_VERSION_POLL_MS` are both 10_000. Under fake timers a retry lands exactly on the `>=` boundary; in production, latency jitter can push an answer a few milliseconds early and slip the retry a full tick, and that slip is charged to the span — so a degraded read usually costs two refreshes rather than three. Bounded and in the safe direction, and now stated as such in the constant's docblock rather than dismissed.
- The in-flight guard is an elapsed-time PROXY. `router.refresh()` returns `void` and its render lands asynchronously, so no test at any surface separates "a refresh has not had time to land" from "a refresh is actually still rendering"; `router.refresh` is a synchronous `vi.fn()` in the mounted suite. This is inherent to what the DOM makes observable, not a gap in coverage.
- The budget still resets on remount (frontmatter `deferred`, item 1): the per-tab guarantee the prose reads as is really per-mounted-watcher. Pre-existing since DW-48 and untouched here.
