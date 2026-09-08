---
title: 'Slug-tenant map lifecycle: refresh path and test-facing reset'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
baseline_revision: 'df5cae273989d06bca10b63b79719b3cdecae060'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A component mounted while /api/wiki/routes was failing still keeps its
      DEFAULT_TENANT hrefs for its whole lifetime when no OTHER component mounts
      afterwards, because the only recovery signal is another caller's load.
    evidence: |-
      DW-234 is closed by propagation: `loadSlugTenants` broadcasts a successful
      cache fill to every mounted hook. Verified by grep over src/, e2e/ and
      workers/ that nothing outside `useSlugTenants` calls `loadSlugTenants()`,
      so "the next cold caller" is always a later MOUNT. On a surface that goes
      idle after the outage — a Workbench sitting still, no navigation, no panel
      opening — no later mount occurs, nothing re-fetches, and that component
      stays on the wrong-handle 308 hop until reload. Closing it needs a
      self-initiated refresh (retry-after-degraded, or a visibility/focus
      signal), which this spec's Never clause rules out on the authority of
      DW-234's own reason field ("the next cold caller re-fetches").
    location: >-
      src/hooks/useSlugTenants.ts:165
    severity: low
---

<intent-contract>

## Intent

**Problem:** `useSlugTenants`' effect has an empty dependency array, so a component mounted while `/api/wiki/routes` was failing keeps `DEFAULT_TENANT` hrefs for its whole lifetime even after a later cold caller re-fetches and warms the session cache (DW-234). The same module-level singleton has no exported reset, so no mounted suite can express "map still loading" or "routes failed" — the degraded-map fallback every converted component is built to survive has no component witness (DW-262).

**Approach:** Give the module a subscriber set that `loadSlugTenants` notifies the moment it caches a successful map, and have the hook subscribe for its mounted lifetime so a recovered session cache reaches already-mounted components without a remount. Add a `_reset*` test seam alongside it, then use both to pin the degraded branch and the recovery in `owner-scoped-anchors.test.tsx`.

## Boundaries & Constraints

**Always:**
- Preserve the existing symmetric-failure contract exactly: a rejected fetch, a non-OK response and a malformed body each resolve to `{}` **without** caching, so the next caller retries. A legitimately empty `{}` from an OK response still caches.
- Notify subscribers only on a successful cache fill — never on a degraded `{}`, which would hand mounted components a state change carrying no new information.
- One listener per mount, removed in the effect's cleanup, so a remounted tree cannot accumulate subscribers.
- A throwing listener must not strand its neighbours (copy the set, try/catch per listener) — the `requestDataVersionCheck` idiom in `src/lib/workbench-data-version.ts`.
- The test seam follows this repo's convention: an `_`-prefixed export documented **Test-only** (`_resetLocks`, `_resetDataVersionListeners`).
- Nothing the app ships may call the reset.

**Block If:**
- Recovery cannot be observed on a mounted component without adding a test-only seam to a component itself.

**Never:**
- No polling, no timers, no retry loop inside the hook. **Widened by DW-723 (2026-09-05):** the hook may ALSO re-fetch on a `visibilitychange` (guarded `visibilityState === "visible"`) or a `focus` event, and only while the map is still degraded (`cache === null`) — because propagation alone never reaches a surface that goes idle after an outage, where no later mount ever pays for the load this spec's broadcast delivers. Attention events are the only added trigger: `setInterval`, `setTimeout`, backoff and retry counters stay forbidden, and the healthy path is untouched — once a map has cached, no attention event issues another request for the life of the tab. See `spec-dw-723-slug-tenant-idle-recovery.md`.
- Do not change `hrefFromMap`, `resolveSlugPath`, `DEFAULT_TENANT`, or any component's call sites.
- Do not weaken or reorder the existing `loadSlugTenants` assertions in `src/hooks/__tests__/useSlugTenants.test.ts`.
- Do not export the subscribe function to app code; only the hook in this module uses it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mounted during outage, then a cold caller succeeds | Hook mounted while `/api/wiki/routes` rejects; later `loadSlugTenants()` resolves `{target:"alice"}` | The mounted hook re-renders with the recovered map; hrefs move from `/u/yopedia/target` to `/u/alice/target` with no remount | No error expected |
| Cache already warm at mount | `cache` populated before the effect runs | Hook initializes state from `cache`; a subscriber is still registered and simply never fires | No error expected |
| Unmount before recovery | Hook unmounts, then a later load succeeds | No `setState` on the unmounted component; the listener is gone | No error expected |
| Degraded load stays degraded | `/api/wiki/routes` fails and nothing else calls `loadSlugTenants` | Hook keeps `{}`; no subscribers are notified | Fallback hrefs, no throw |
| A listener throws | One subscribed listener throws during notify | Every other listener still runs; `loadSlugTenants` still resolves the map | Swallowed per listener |
| `_resetSlugTenants()` | Any state | `cache`, `inflight` and subscribers all cleared; the next `loadSlugTenants()` re-fetches | No error expected |

</intent-contract>

## Code Map

- `src/hooks/useSlugTenants.ts` -- the whole change. Three test-only exports ship here: `_resetSlugTenants` (the seam the intent names), plus `_subscribeSlugTenants` and `_slugTenantListenerCount`, which the I/O matrix's "a listener throws" and "unmount before recovery" rows have no other way in. The Never clause bars the private `subscribe` from APP code, which stays true: the scan above pins that no non-`__tests__` module references any of the three. `cache`/`inflight` singletons (lines 8-9); `loadSlugTenants` caches at line 52 inside the `.then`, with the shared `.catch(() => ({}))` at line 55 and `.finally` clearing `inflight` at 56-58; `useSlugTenants`' mount effect with the `[]` deps is lines 85-93. `hrefFromMap` (69-71) is untouched.
- `src/lib/workbench-data-version.ts:384-416` -- read-only reuse model for the listener set, the copy+try/catch notify, and `_resetDataVersionListeners`. Follow its shape.
- `src/lib/lock.ts:87-93` -- read-only: the `_reset*` **Test-only** doc-comment convention.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- the suite DW-262 names. File-level `beforeEach` (117-146) builds a `routes` table, stubs one `fetch` that throws on an unmapped URL, and warms the map with `await loadSlugTenants()`; `afterEach` (148-154) runs `cleanup()` before the setup file's. `hrefOf(name)` (157-160) is the assertion helper. `RecentIngests` fixture + describe at 455-537 — two map-driven rows (`target`→alice, `other`→bob), no clock, no `tenant` fallback prop, so the degraded answers are the distinguishable `/u/yopedia/target` and `/u/yopedia/other`. `BulkDocumentImport`'s nested `beforeEach` (600-605) is the precedent for a describe-local hook that runs *after* the file-level one. `act` is already imported.
- `src/hooks/__tests__/useSlugTenants.test.ts` -- node project (no DOM; `renderToStaticMarkup` runs no effects), so it pins `_resetSlugTenants`' cache/in-flight clearing only. `importCold()` (26-28) + `vi.resetModules()` is its existing cold-module idiom.
- `src/components/RecentIngests.tsx:87,637,718` -- read-only: both anchors go through `hrefForSlug`, confirming the degraded/recovered hrefs above.
- `src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx` -- ADDED during implementation. The `dom`-project home for the hook's mount lifecycle: the shipped recovery trigger (a second mount), the loading window, subscribe/unsubscribe balance. The node suite cannot host these — `renderToStaticMarkup` runs no effects.
- `src/lib/__tests__/test-infra-conventions.test.ts:89` -- ADDED a sibling case to "no production module imports the test-only barrel", reusing that file's own `sourceFiles()`/`read()` scan. It is the enforcement behind "nothing the app ships calls this" for the three `_` seams.
- `AGENTS.md` "Test environments" -- read-only: `.test.tsx` ⇒ `dom` project, `.test.ts` ⇒ `node` project; the extension is the only opt-in.

## Tasks & Acceptance

**Execution:**
- `src/hooks/useSlugTenants.ts` -- add a module-level `Set` of `(map: SlugTenantMap) => void` listeners, a module-private `subscribe` returning its unsubscribe, and a notify inside `loadSlugTenants`' success `.then` immediately after `cache = m` (copy the set, try/catch per listener). Change `useSlugTenants`' effect to register a listener that `setMap`s the recovered map and to unsubscribe in cleanup alongside the existing `on` guard; deps stay `[]` — module scope is the tab, and the listener is what makes the mount durable. Export `_resetSlugTenants()` clearing cache, in-flight and listeners, documented **Test-only**. -- DW-234 needs mounted components to see a recovered session cache; DW-262 needs the singleton to be un-warmable.
- `src/hooks/__tests__/useSlugTenants.test.ts` -- add `_resetSlugTenants` cases to the `loadSlugTenants` describe: after a successful warm, a reset makes the next call re-fetch (fetch called twice); a reset while a request is in flight does not leave the stale in-flight promise wired up (the next call issues its own fetch). -- The reset is a contract, not a convenience; nothing else pins it.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- extend the file-level stub with a sentinel a `routes` entry can be set to so the stub *rejects* that URL, then add a final describe that (a) sets `/api/wiki/routes` to that sentinel and calls `_resetSlugTenants()` in its own `beforeEach`, mounts `RecentIngests`, and asserts both rows fall back to `/u/yopedia/target` and `/u/yopedia/other`; and (b) from that same degraded mount, restores the good route, awaits `loadSlugTenants()` inside `act`, and asserts both rows become `/u/alice/target` and `/u/bob/other` with no remount. Header prose must say why the sentinel exists rather than reusing the "unexpected fetch" guard. -- The degraded branch and the recovery both need a component witness.

**Acceptance Criteria:**
- Given a component using `useSlugTenants` mounted while `/api/wiki/routes` fails, when a later caller's `loadSlugTenants()` succeeds, then that still-mounted component re-renders with map-driven canonical hrefs without being remounted.
- Given a component using `useSlugTenants` that has unmounted, when a later `loadSlugTenants()` succeeds, then no state update is attempted on it and no React act/unmounted-update warning is emitted.
- Given a warmed session cache, when a test calls `_resetSlugTenants()`, then the next `loadSlugTenants()` issues a fresh `/api/wiki/routes` request.
- Given the full suite, when `pnpm test` runs, then every pre-existing `useSlugTenants`, `owner-scoped-anchors` and `renderer-slug-tenant-adoption` assertion still passes unchanged.

## Spec Change Log

### 2026-09-05 — Never clause widened by DW-723

- **What changed:** the first Never bullet ("no polling, no timers, no retry loop inside the hook — the only recovery signal is another caller's successful load") now also permits a self-initiated re-fetch on `visibilitychange`/`focus`, bounded to the degraded state (`cache === null`). Nothing else in this spec moves: the subscriber set, the broadcast-on-successful-cache-fill rule, the symmetric-failure contract, the `[]` deps, the three `_` seams and every existing assertion are as shipped.
- **Why:** this spec closed DW-234 by PROPAGATION, and nothing outside `useSlugTenants` calls `loadSlugTenants()`, so "the next cold caller" is always a later MOUNT. A surface that goes idle after an `/api/wiki/routes` outage never mounts anything again and kept its DEFAULT_TENANT hrefs — and their extra 308 hop — until a full reload. That is the harvested deferred item below, raised as DW-723 and implemented in `spec-dw-723-slug-tenant-idle-recovery.md`.
- **Still forbidden:** `setInterval`, `setTimeout`, backoff, retry counters, and any re-fetch on the healthy path. The bound is the cache, not a clock: production never clears it, so the first successful load turns the retry into a permanent no-op.
- **The `deferred:` frontmatter entry is left exactly as written.** It is the harvest record that produced DW-723, not a live TODO — rewriting it would erase the provenance of the widening this entry documents.

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 0, medium 6, low 8)
- defer: 1: (high 0, medium 0, low 1)
- reject: 6
- addressed_findings:
  - `[medium]` `[patch]` `_resetSlugTenants()` left an in-flight request able to write its map into the cache and broadcast it AFTER the reset — added a `generation` counter the chain captures; an abandoned request now answers its own caller and touches no module state.
  - `[medium]` `[patch]` The abandoned chain's `.finally` freed the in-flight slot of the request that replaced it, so the next caller opened a duplicate fetch — now `if (inflight === request)`.
  - `[medium]` `[patch]` `_resetSlugTenants()` cleared `listeners`, silently detaching every mounted hook and turning its cleanup into a no-op — a suite resetting mid-life would have read the DW-234 bug back as product behavior. It no longer touches listeners; mounts own their own removal.
  - `[medium]` `[patch]` Both mounted recovery cases could have joined the still-pending failed request (and been answered `{}`) because `await act(async () => {})` drains an unknown number of microtask turns — added a `settleLoad()` macrotask drain in each file.
  - `[medium]` `[patch]` "Nothing the app ships calls this" was prose only, on a client module the app ships — added a production-import scan for all three `_` seams to `test-infra-conventions.test.ts`.
  - `[medium]` `[patch]` The SHIPPED recovery trigger (a second component mounting; nothing outside the hook calls `loadSlugTenants`) was never exercised — both recovery tests played the third-party caller themselves. Added a two-probe case where the second mount pays for the re-fetch the first adopts.
  - `[low]` `[patch]` The in-flight reset test asserted nothing after releasing the abandoned request — now pins the cache, the fetch count and an empty broadcast.
  - `[low]` `[patch]` The matrix row "a degraded load notifies nobody" was unpinned (moving the notify below the `.catch` left every suite green) — added a node case.
  - `[low]` `[patch]` DW-262's "map still loading" state had no witness — added a parked-fetch case pinning the loading window and the transition out of it.
  - `[low]` `[patch]` The warm-mount test's comment claimed the subscription guarded a reachable bug; production never clears the cache, so it is uniform-by-construction. Comment corrected.
  - `[low]` `[patch]` The `[...listeners]` copy comment (inherited from `workbench-data-version.ts`) claimed a guarantee `Set` iteration already gives — rewritten to state what the snapshot actually does.
  - `[low]` `[patch]` Neither mounted case constrained the `/api/wiki/routes` request count, so a hook re-fetching per render would have passed — added counts, with `fetchMock.mockClear()` so they are the case's own rather than the file's running total.
  - `[low]` `[patch]` The acceptance criterion "no act/unmounted-update warning" was never asserted — added a `console.error` spy to the unmount case.
  - `[low]` `[patch]` The Code Map named neither the added lifecycle suite nor the two extra `_` seams — recorded, with why the matrix requires them and why the Never clause still holds.

## Design Notes

The recovery signal is deliberately *another caller's* successful load, not a retry the hook owns. `loadSlugTenants`' failure contract already guarantees the session recovers on the next cold call; DW-234 is only that mounted components never re-read the result. A subscriber set turns that existing recovery into a broadcast:

```ts
const listeners = new Set<(map: SlugTenantMap) => void>();
// ...inside loadSlugTenants' success .then, after `cache = m`:
for (const listener of [...listeners]) {
  try { listener(m); } catch { /* one bad listener must not strand the rest */ }
}
```

The hook's effect keeps `[]` deps on purpose — it must run once per mount, and the listener (not a dependency) is what keeps it live afterwards. Both the `.then` and a later notify call `setMap`; when they carry the same object React bails out, so the double path costs nothing.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/hooks/__tests__/useSlugTenants.test.ts` -- expected: all pass, including the new reset cases.
- `pnpm exec vitest run --project dom src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` -- expected: all pass, including the new degraded and recovery cases, with no unmounted-update warnings.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm test` -- expected: the full run is green, no pre-existing suite regressed.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `loadSlugTenants` now broadcasts a successful cache fill
to a module-level listener set, and `useSlugTenants` subscribes for its mounted
lifetime — so a component that mounted while `/api/wiki/routes` was failing
adopts the recovered map on the next caller's successful load instead of keeping
DEFAULT_TENANT hrefs until it remounts (DW-234). Three `_`-prefixed **test-only**
exports make the singleton addressable from a suite (DW-262): `_resetSlugTenants`
(drop the cache and disown any in-flight request, via a `generation` counter),
`_subscribeSlugTenants` and `_slugTenantListenerCount`. The degraded branch and
the recovery out of it now have component witnesses. The symmetric-failure
contract, `hrefFromMap`, `resolveSlugPath`, `DEFAULT_TENANT` and every component
call site are unchanged.

**Files changed**
- `../../src/hooks/useSlugTenants.ts` -- listener set + private `subscribe`, broadcast inside the success `.then` only, `generation`-guarded cache write and in-flight ownership, the three test-only exports, and the hook's subscribe/unsubscribe in its effect (deps stay `[]`).
- `../../src/hooks/__tests__/useSlugTenants.test.ts` -- node project: four cases for the reset (re-fetch, in-flight disowning, in-flight slot ownership) and the notify loop (throwing listener, degraded load notifies nobody).
- `../../src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx` -- ADDED. dom project: the loading window, the shipped two-mount recovery trigger, warm-mount subscription, listener balance across unmount, and survival across a reset.
- `../../src/components/__tests__/owner-scoped-anchors.test.tsx` -- `ROUTE_UNAVAILABLE` route-table sentinel + a `RecentIngests` describe pinning both degraded rows and their recovery on held DOM nodes.
- `../../src/lib/__tests__/test-infra-conventions.test.ts` -- ADDED case: no production module references any of the three `_` seams.

**Review findings breakdown:** 14 patches applied (medium 6, low 8), 1 deferred (low), 6 rejected, 0 intent_gap, 0 bad_spec.

**Follow-up review recommendation:** `true`. Patched counts — high 0, medium 6, low 8; score = 3x6 + 8 = 26, which is >= 5.

**Verification**
- `pnpm exec vitest run --project node src/hooks/__tests__/useSlugTenants.test.ts` -- 19 passed.
- `pnpm exec vitest run --project dom src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx src/components/__tests__/owner-scoped-anchors.test.tsx` -- 25 passed.
- `pnpm exec vitest run --project node src/lib/__tests__/test-infra-conventions.test.ts` -- 6 passed.
- `pnpm exec tsc --noEmit` -- clean. `pnpm exec next lint` -- no warnings or errors.
- `pnpm test` -- 366 files, 9031 passed, 1 skipped, 0 failed.
- Every I/O matrix row has a covering test that ran and passed, and each was mutation-checked: dropping the subscription, the cleanup unsubscribe, the try/catch, the `generation` guard, the `inflight === request` guard, the reset's listener retention, or the parked fetch each turns a specific new case red.

**Residual risks**
- The deferred item above: recovery propagates but never originates, so a surface that goes idle after an outage still keeps its DEFAULT_TENANT hrefs until reload. Ruled out of this bundle by the Never clause on the authority of DW-234's own reason field.
- `AGENTS.md` was modified in the working tree by a concurrent process during this run (Clerk force-redirect and bmad-loop policy notes, unrelated to this bundle). This session did not touch it and left it uncommitted.
- One pre-existing load-sensitive flake in the same verification path: `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles` timed out on one full run under full parallelism, and passes 95/95 in isolation and on re-run. Unrelated to this change.
