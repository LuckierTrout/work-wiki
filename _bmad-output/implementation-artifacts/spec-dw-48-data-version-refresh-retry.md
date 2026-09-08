---
title: 'Bounded retry for a dataVersion refresh whose re-render did not catch up (DW-48)'
type: 'bugfix'
created: '2026-08-21'
status: 'done'
baseline_revision: 'cd2f2b651ac97d2ea9dcbe47c725ff040fa02609'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Retry attempts are counted per qualifying poll rather than per settled
      re-render, so a nudge or visibility burst — or a merely slow refresh — can
      spend the whole budget before any new baseline has had a chance to land.
    evidence: |-
      `run()` has three triggers: the `DATA_VERSION_POLL_MS` interval,
      `visibilitychange` -> visible, and the `requestDataVersionCheck()` save
      nudge (`PreviewColumn.tsx`). Every qualifying poll from any of them spends
      an attempt, so three alt-tabs or three saves that all still answer the same
      version drive `attempts` from 0 to `DATA_VERSION_REFRESH_ATTEMPTS` in
      milliseconds and re-strand that version — the DW-48 symptom, now
      probabilistic rather than certain. The same shape covers an in-flight
      `router.refresh()` still rendering when the next tick fires: a merely slow
      re-render reads as "did not catch up" and burns an attempt. A wall-clock
      window (which DW-48's own wording offered as an alternative to a count) or
      an in-flight guard would close it; both are refresh-policy decisions beyond
      the bounded-count reading this story implemented, and the count reading is
      strictly better than the single-shot stamp it replaced in every case.
    location: >-
      src/components/workbench/DataVersionWatcher.tsx (run),
      src/lib/workbench-data-version.ts (DATA_VERSION_REFRESH_ATTEMPTS)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `DataVersionWatcher` stamps `refreshedForRef.current = result.version` *before* `router.refresh()` and never checks that the new server render's `dataVersion` actually caught up. If the RSC read answers the pre-bump integer, `served` stays behind while `refreshedFor` is ahead, and `shouldRefreshForDataVersion` returns `false` for that version forever — the trees then sit stale until the *next* write.

**Approach:** Replace the single-shot stamp with a bounded retry. The watcher records the version it *attempted* plus how many refreshes it has issued for it; while the served baseline has not caught up, the next poll re-refreshes, up to a fixed attempt cap, then gives up. The whole rule stays a pure function in `src/lib/workbench-data-version.ts` so the `node` vitest project executes it, and the watcher spells no comparison and no increment of its own.

## Boundaries & Constraints

**Always:**
- The decision AND the new attempt state come back from one pure function in `workbench-data-version.ts`; the watcher assigns what it is handed. No `<`/`>` comparison and no `+ 1` in `DataVersionWatcher.tsx` (the existing source-scan guard in `workbench-data-version.test.ts` pins this).
- Forward-only survives: a polled value at or below `served` never refreshes (KV is eventually consistent — a backwards read is not a change).
- The retry is bounded by a single exported constant. A degraded server read (`page.tsx` stuck at `0`, route answering `7`) must cost a *fixed* number of wasted renders, never a loop.
- Attempt state lives in a ref, resets naturally on remount, and is never persisted.

**Block If:**
- The bounded-retry shape cannot be expressed without the watcher re-implementing part of the comparison.

**Never:**
- No wall-clock timer, `setTimeout` backoff, or second polling cadence — the bound is an attempt count over the existing `DATA_VERSION_POLL_MS` loop.
- No change to `fetchDataVersion`, `previewFetchPlan`, the route, the cadence, or the nudge registry.
- No new client-side fetch of tree data; `router.refresh()` stays the tree refetch.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

Attempt state is `{ version, attempts }` — the polled version refreshes were issued for, and how many have gone out for it. Cap is `DATA_VERSION_REFRESH_ATTEMPTS` (3).

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New version observed | served 3, polled 4, state `{0,0}` | refresh, state → `{4,1}` | No error expected |
| Re-render caught up | served 4, polled 4, state `{4,1}` | no refresh, state unchanged | No error expected |
| Re-render did NOT catch up (DW-48) | served 3, polled 4, state `{4,1}` | refresh, state → `{4,2}` | No error expected |
| Attempts exhausted (give up) | served 0, polled 7, state `{7,3}` | no refresh, state unchanged | Bounded: 3 wasted renders, not a loop |
| New bump after giving up | served 0, polled 8, state `{7,3}` | refresh, state → `{8,1}` | No error expected |
| Backwards read | served 5, polled 4, state `{0,0}` | no refresh, state unchanged | Eventual consistency is not a change |
| Poll behind an outstanding attempt | served 3, polled 3, state `{4,1}` | no refresh, state unchanged | No error expected |
| Poll not `ok` | `stale` / `unavailable` | never reaches the decision | Swallowed; loop survives |

</intent-contract>

## Code Map

- `src/lib/workbench-data-version.ts:113-135` -- `shouldRefreshForDataVersion(input: {served, polled, refreshedFor}): boolean` is the rule being replaced. Its docblock (lines 116-127) states the forward-only and `refreshedFor` rationale and must be rewritten for the retry policy. `previewFetchPlan` (same file, ~line 175) is the *house idiom to follow*: it returns the caller's next state (`shown`) rather than letting the caller assign it, and its docblock explains exactly why — copy that shape.
- `src/components/workbench/DataVersionWatcher.tsx:62-95` -- `servedRef` (assigned during render), `refreshedForRef = useRef(0)` (line 68, the state to replace), and `run()`'s guard + stamp (lines 83-93). Docblock line 54 names `shouldRefreshForDataVersion`; update it.
- `src/lib/__tests__/workbench-data-version.test.ts` -- node project. Line 54 import; `describe("shouldRefreshForDataVersion")` at 422-456 (four cases) is replaced. Source-scan `describe("DataVersionWatcher")` at ~903-955 pins the watcher's literal source: line 912 `refreshedForRef.current = result.version;`, 917-920 the call shape, and the polarity test at 933-950 (`/if \(\s*!shouldRefresh.../`, exactly one `router.refresh()`, ordered after the guard). All must be re-pinned to the new spelling, keeping every guard's *intent* (executed decision, correct polarity, single refresh call site, `status !== "ok"` early return).
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- dom project. `mountWatcher(served)` returns `serve(next)` which re-renders with a new baseline — that is how a caught-up re-render is simulated (`router.refresh` is a `vi.fn()` and re-renders nothing). Three tests change: "refreshes once when the served version moves forward, and not again" (line ~152), "compares against the version now on screen" (~163), and the wedge test's closing "Exactly once" assertion (~310-318).
- `src/lib/data-version.ts:54, :91` -- prose only: both reference `refreshedFor` / `shouldRefreshForDataVersion` by name. Correct the names; the eventual-consistency claims themselves still hold.
- `vitest.config.ts:90-103` -- `node` project runs `src/**/__tests__/**/*.test.ts`, `dom` runs the `.test.tsx` suites. Read-only.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-data-version.ts` -- replace `shouldRefreshForDataVersion` with the bounded-retry rule: export `DATA_VERSION_REFRESH_ATTEMPTS = 3`, a `DataVersionRefreshState` type (`{ version: number; attempts: number }`), a `NO_DATA_VERSION_REFRESH` initial value, and a plan function taking `{ served, polled, state }` and returning `{ refresh: boolean; state: DataVersionRefreshState }` per the I/O matrix -- one pure rule the node project executes, with the caller's next state returned rather than assigned.
- `src/components/workbench/DataVersionWatcher.tsx` -- swap `refreshedForRef` for a state ref seeded with `NO_DATA_VERSION_REFRESH`; in `run()`, call the plan function, assign the returned state, then return early unless it says refresh -- the watcher keeps spelling no comparison and no increment.
- `src/lib/__tests__/workbench-data-version.test.ts` -- replace the `shouldRefreshForDataVersion` describe with one covering every I/O matrix row (both the catch-up and the give-up path), and re-pin the `DataVersionWatcher` source scan to the new spelling, preserving each existing guard's intent.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- update the three affected lifecycle tests and add mounted coverage of both paths: a re-render that catches up (via `serve`) stops the retries, and one that never does stops after the cap.
- `src/lib/data-version.ts` -- update the two prose references to the renamed rule -- the docs there are the explaining half of this signal and must not name a function that no longer exists.

**Acceptance Criteria:**
- Given a refresh was issued for polled version `V` and the next server render still serves a baseline below `V`, when the following poll answers `V` again, then the watcher calls `router.refresh()` again.
- Given the retry cap has been reached for version `V` with the baseline still behind, when further polls answer `V`, then no further `router.refresh()` is issued, and the total for `V` equals `DATA_VERSION_REFRESH_ATTEMPTS`.
- Given a refresh was issued for `V` and the next render's baseline reaches `V`, when polls keep answering `V`, then no further refresh is issued.
- Given the cap was exhausted for `V`, when a later poll answers a version above `V`, then a refresh is issued again for the new version.
- Given `DataVersionWatcher.tsx` source, when scanned, then it contains no `<`/`>` version comparison and no attempt arithmetic, and exactly one `router.refresh()` call reached only after the rule's negated answer returns early.

## Spec Change Log

## Review Triage Log

### 2026-08-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 4, low 3)
- defer: 1: (high 0, medium 1, low 0)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The retry branch's `polled === state.version` equality was unpinned — a `<=` mutation kept all 5724 tests green while re-arming the cap on a flapping route (unbounded refresh loop). Added the attempts-remaining case and a driven flap test; mutation now fails 2 node tests.
  - `[medium]` `[patch]` The DW-48 success narrative (refresh -> lag -> retry -> catch up -> stop) was asserted at no surface; catch-up was only covered from the first attempt. Added the full sequence to both the node and the mounted suite.
  - `[medium]` `[patch]` `DATA_VERSION_REFRESH_ATTEMPTS`'s docblock described the bound as a count "over the DATA_VERSION_POLL_MS loop" and was ambiguous about whether the initial refresh counts. Corrected: total per version (one initial plus two retries), counted over qualifying polls from all three `run()` triggers.
  - `[medium]` `[patch]` `data-version.ts` prose lost the still-true high-water-mark half and claimed a degraded server read costs at worst `DATA_VERSION_REFRESH_ATTEMPTS` refreshes without saying "per observed version". Both corrected, with the 3x per-write amplification named honestly and the constant's module pointed at.
  - `[low]` `[patch]` No-op branches were asserted with `toEqual`, so a branch returning `{ ...state }` would pass while the docblocks claim the state object is handed back unchanged. Pinned with `toBe` via a shared helper, matching `previewFetchPlan`'s idiom.
  - `[low]` `[patch]` New source-scan guards were over-broad: a whole-file `+ 1` ban, a case-sensitive `/attempts/`, and a stripper that only removed whole-line comments. Narrowed to the plan-to-refresh slice, made case-insensitive, and trailing comments now stripped.
  - `[low]` `[patch]` `NO_DATA_VERSION_REFRESH` was an unfrozen shared object seeded into every watcher ref and returned by three branches, with `readonly` erased at build time. `Object.freeze`d, and `DataVersionRefreshPlan`'s fields marked `readonly`.

## Design Notes

The give-up path is the reason the old guard existed at all: with `page.tsx` degraded to `0` and the route answering `7`, dropping the guard refreshes every tick forever. Trading "at most one wasted render, and a real bump possibly stranded forever" for "at most three wasted renders, and a real bump always retried" is the whole of DW-48. Three attempts covers a narrow read-replica window (both reads go through the same Worker) without making a genuinely degraded read expensive.

Shape to follow — the plan returns the caller's next state, as `previewFetchPlan` does:

```ts
const plan = dataVersionRefreshPlan({
  served: servedRef.current,
  polled: result.version,
  state: refreshStateRef.current,
});
refreshStateRef.current = plan.state;
if (!plan.refresh) return;
router.refresh();
```

Assigning before the guard is deliberate: every branch returns the state that branch should leave behind, so there is no ordering for a later tidy-up to reverse.

## Verification

**Commands:**
- `pnpm vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` -- expected: all pass, including the new matrix rows and the re-pinned source scan.
- `pnpm vitest run --project dom src/components/workbench/__tests__/data-version-watcher.test.tsx` -- expected: all pass, including the catch-up and give-up lifecycle cases.
- `pnpm vitest run` -- expected: no new failures anywhere (the brand-copy and doc-drift scans also read these files).
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `DataVersionWatcher`'s single-shot `refreshedFor` stamp is
replaced with a bounded retry. The watcher now records `{ version, attempts }` —
the polled version refreshes were issued FOR and how many have gone out for it —
and while the served baseline has not caught up, the next qualifying poll
re-refreshes, up to `DATA_VERSION_REFRESH_ATTEMPTS` (3, initial refresh
included), then gives up for that version. A version above the attempted one is
a new bump and restarts the count even after a give-up. The whole rule is
`dataVersionRefreshPlan`, a pure function in `workbench-data-version.ts` that
the `node` vitest project executes; it returns the caller's next state rather
than letting the watcher compute it, the same idiom `previewFetchPlan` uses.

**Files changed.**
- `src/lib/workbench-data-version.ts` — `shouldRefreshForDataVersion` replaced by
  `DATA_VERSION_REFRESH_ATTEMPTS`, `DataVersionRefreshState`, a frozen
  `NO_DATA_VERSION_REFRESH`, `DataVersionRefreshPlan`, and `dataVersionRefreshPlan`.
- `src/components/workbench/DataVersionWatcher.tsx` — `refreshedForRef` becomes
  `refreshStateRef`; `run()` calls the rule, assigns the returned state, then
  returns early unless it says refresh. No comparison and no arithmetic of its own.
- `src/lib/__tests__/workbench-data-version.test.ts` — the rule's describe
  rewritten to cover every I/O-matrix row plus the flap and catch-up sequences;
  the `DataVersionWatcher` source scan re-pinned to the new spelling.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` — mounted
  coverage of the retry, the give-up, and a later render catching up mid-sequence.
- `src/lib/data-version.ts` — prose only: renamed references, restored
  high-water-mark explanation, per-observed-version cost corrected.

**Review findings breakdown.** 7 patches applied (medium 4, low 3); 1 deferred
(medium — attempts counted per poll rather than per settled render); 6 rejected.
No intent gaps and no spec repairs; `review_loop_iteration` stayed 0.

**Follow-up review recommendation: true.** Patched this pass: high 0, medium 4,
low 3 → score `3 x 4 + 1 x 3 = 15`, which is at or above 5.

**Verification performed.**
- `npx vitest run --project node src/lib/__tests__/workbench-data-version.test.ts` — 51 passed.
- `npx vitest run --project dom src/components/workbench/__tests__/data-version-watcher.test.tsx` — 16 passed.
- `npx vitest run` — 263 files / 5727 tests passed, 0 failures.
- `npx eslint` — exit 0. `npx tsc --noEmit` — exit 0.
- Matrix test audit: all eight I/O-matrix rows are covered by tests that ran and
  passed (the `ok`-only row by the existing mounted non-ok / transport-failure /
  non-integer cases and the `status !== "ok"` source pin).
- Mutation checks, each reverted: disabling the retry branch, relaxing its
  equality to `<=`, moving the state assignment below the guard, and inlining
  attempt arithmetic in the watcher each fail tests.
- `pnpm vitest` / `pnpm lint` abort with `ERROR packages field missing or empty`,
  a pre-existing repo pnpm-config issue unrelated to this change; everything was
  run through `npx`.

**Residual risks.**
- The deferred finding above: the budget is a count of qualifying polls, not a
  wall-clock window, so a save or alt-tab burst during a replica-lag stretch can
  spend it before any re-render lands. Strictly better than the single-shot stamp
  in every case, but weaker than the docblock's original wording implied.
- The real coupling DW-48 describes — `router.refresh()` → RSC re-render →
  `readDataVersion()` answering the pre-bump integer — is stubbed at both ends in
  vitest (`router.refresh` is a mock; "the render lagged" is modelled as the
  provider prop not moving). Correctness rests on that modelling assumption.
- A degraded server read now costs up to three renders per observed version
  instead of one — a 3x amplification, accepted deliberately and documented.
