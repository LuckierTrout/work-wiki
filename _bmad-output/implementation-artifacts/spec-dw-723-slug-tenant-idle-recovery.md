---
title: 'Slug-tenant map: self-initiated recovery on visibility/focus'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: 'b134df7105f23b7429d81af6baa765da6852cf09'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `useSlugTenants` recovery only ever *propagates*, never *originates* (DW-723): `loadSlugTenants` broadcasts a successful cache fill to every mounted hook, but nothing outside the hook calls it, so the "next cold caller" is always a later MOUNT. A surface that goes idle after an `/api/wiki/routes` outage — a Workbench sitting still, no navigation, no panel opening — never mounts anything again, so it keeps its `DEFAULT_TENANT` hrefs (and their extra 308 hop) for the whole life of the tab until a full reload.

**Approach:** Give the hook a self-initiated recovery signal bounded by user attention rather than a clock: while and only while the map is still degraded, re-fetch when the tab becomes visible or the window regains focus. The healthy path stays exactly as it is — unchanged and unpolled — and the widened contract is recorded in the originating spec's Never clause.

## Boundaries & Constraints

**Always:**
- The retry fires only while the map is degraded — i.e. no successful map has ever been cached (`cache === null`). Once a load succeeds, production never clears the cache, so the handler is a permanent no-op for the rest of the tab's life. That is what makes the signal bounded.
- `visibilitychange` is guarded on `document.visibilityState === "visible"`, following the existing repo idiom in `src/hooks/useSidecarStatus.ts:51-64` and `src/components/workbench/DataVersionWatcher.tsx:132-148`. A tab going *hidden* must not re-fetch.
- Both listeners are registered in the hook's existing mount effect and removed in its existing cleanup, so an unmounted hook leaves nothing behind — the same discipline the subscription already follows.
- The recovered map reaches the mounted hook through the EXISTING broadcast (`loadSlugTenants`' success `.then` notifies every subscriber). The retry starts a load; it does not add a second path into `setMap`.
- Preserve the symmetric-failure contract exactly: a rejected fetch, a non-OK response and a malformed body each resolve to `{}` **without** caching, so a still-degraded retry leaves the hook degraded and eligible to retry again.
- Concurrent retries are absorbed by the existing `inflight` slot — N mounted hooks × 2 events must still produce at most one `/api/wiki/routes` request.

**Block If:**
- The degraded state cannot be distinguished from a legitimately-empty successful map without changing `loadSlugTenants`' caching contract.

**Never:**
- No polling, no `setInterval`, no `setTimeout`, no retry counter, no backoff — attention events are the only new trigger.
- Do not re-fetch on the healthy path: a visible/focus event with a warm cache must issue zero requests.
- Do not change `loadSlugTenants`, `hrefFromMap`, `resolveSlugPath`, `DEFAULT_TENANT`, the `generation` reset semantics, or any component call site.
- Do not add a new `_`-prefixed test seam — the new behavior is observable through `/api/wiki/routes` request counts and rendered hrefs.
- Do not weaken, reorder or delete any existing assertion in `src/hooks/__tests__/useSlugTenants.test.ts`, `src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx` or `src/components/__tests__/owner-scoped-anchors.test.tsx`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Idle degraded surface regains focus | Hook mounted while `/api/wiki/routes` failed; routes recover; `window` `focus` fires; no remount, no other mount | One new `/api/wiki/routes` request; the mounted hook re-renders with canonical hrefs | No error expected |
| Idle degraded surface becomes visible | Same, but `document` `visibilitychange` fires with `visibilityState === "visible"` | Same as above | No error expected |
| Tab going hidden | Degraded hook; `visibilitychange` fires with `visibilityState === "hidden"` | No request issued; hook stays degraded | No error expected |
| Healthy map, attention event | Warm cache (successful map, including a legitimately empty `{}`); focus/visibility fires | Zero new requests; no state change | No error expected |
| Retry fails again | Degraded hook; routes still down; focus fires | One request, resolves `{}`, nothing cached, hrefs stay `DEFAULT_TENANT`; a later focus retries again | Swallowed by the existing `.catch` |
| Many mounted hooks, one event | Three degraded hooks mounted; one focus event | Exactly one `/api/wiki/routes` request (shared `inflight`); all three adopt the recovered map | No error expected |
| Unmounted hook | Hook unmounted, then focus/visibility fires | No request attributable to it; no `setState` on the dead hook | No error expected |

</intent-contract>

## Code Map

- `src/hooks/useSlugTenants.ts` -- the whole product change, confined to `useSlugTenants`' mount effect (lines 192-215). The effect already owns `on`, `subscribe(...)`'s `unsubscribe`, and a cleanup returning both; add the two attention listeners beside them and remove them in that same cleanup. `cache` is the module `let` at line 8 — read it at EVENT time, not at effect time, so the degraded check is always current. `loadSlugTenants` (62-125) is read-only: its `inflight` dedupe (64, 120-122), success-only cache write + broadcast (91-113), and shared degrading `.catch` (115) are exactly what make the retry cheap and safe. `_resetSlugTenants` (166-170), `_subscribeSlugTenants`, `_slugTenantListenerCount`, `hrefFromMap` (178-180): untouched.
- `src/hooks/useSidecarStatus.ts:51-64` -- read-only: the repo's `onVisibility` idiom — `document.visibilityState === "visible"` guard, `document.addEventListener("visibilitychange", ...)`, symmetric `removeEventListener` in cleanup. Follow its shape and naming.
- `src/components/workbench/DataVersionWatcher.tsx:132-155` -- read-only: the same idiom a second time, with the "a backgrounded tab does not poll at all" rationale. Confirms the convention rather than inventing one.
- `src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx` -- the `dom`-project home for the new cases. Reuse its existing harness verbatim: `Probe` (45-48), `routesUp` flag + one `fetch` stub (50-63), `settleLoad()` (81-85) — the deterministic macrotask drain, required here because a retry issued while the failed request is still in `inflight` would JOIN it and be answered `{}` — `href(id)` (88-90), `routeFetches()` (93-95), and the `_resetSlugTenants()` in both hooks. Existing cases 97-219 must all still pass unchanged.
- `src/components/__tests__/owner-scoped-anchors.test.tsx:993-1055` -- the `RecentIngests with a failing /api/wiki/routes` describe: the component witness. Its `beforeEach` (994-1005) stages the outage with `ROUTE_UNAVAILABLE` (138) + `_resetSlugTenants()` + `fetchMock.mockClear()`; `settleLoad()` (982-986), `routeFetches()` (988-990), `DEGRADED_TARGET`/`DEGRADED_OTHER` (972-973), `ALICE_TARGET`/`BOB_OTHER` and `EMAIL_SUBJECT` are all already in scope. The "adopts a recovered map without a remount" case (1026-1055) is the pattern to mirror — held DOM nodes, `isConnected` assertions — with the attention event replacing its `await loadSlugTenants()`.
- `_bmad-output/implementation-artifacts/spec-dw-234-262-slug-tenant-map-lifecycle.md` -- the originating spec (`status: done`). Its Never clause ("No polling, no timers, no retry loop inside the hook — the only recovery signal is another caller's successful load") is the contract DW-723 widens; its `deferred:` frontmatter entry is the harvest record that produced DW-723 and stays as written.
- `src/lib/__tests__/test-infra-conventions.test.ts:89` -- read-only: the production-import scan over the three `_` seams. No new seam is added, so this case needs no change; it is named so the implementer does not think one is owed.
- `AGENTS.md` "Test environments" -- read-only: `.test.tsx` ⇒ `dom` project, `.test.ts` ⇒ `node` project. The new cases need a real DOM and real effects, so they belong in the two `.tsx` suites above, never in `useSlugTenants.test.ts`.

## Tasks & Acceptance

**Execution:**
- `src/hooks/useSlugTenants.ts` -- in `useSlugTenants`' mount effect, add one `retryIfDegraded` handler that returns immediately when `cache !== null` (healthy — nothing to recover) or when `document.visibilityState !== "visible"`, and otherwise calls `void loadSlugTenants()`; register it for `document`'s `visibilitychange` and `window`'s `focus`, and remove both in the existing cleanup alongside `unsubscribe()`. Deps stay `[]`. Comment why the check reads module `cache` at event time, why this is bounded (it stops permanently on the first success, since production never clears the cache), and why the retry needs no `.then` (the broadcast already delivers). -- An idle surface has no later mount, so propagation alone never reaches it (DW-723).
- `src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx` -- add a describe covering the matrix rows against the mounted `Probe`: focus recovers a degraded hook without a remount (href flips, exactly one new request); `visibilitychange` while visible does the same; `visibilitychange` while `visibilityState` is stubbed `"hidden"` issues no request; a warm-cache mount issues no request on either event; a still-failing retry leaves the hook degraded and a later focus retries again; three mounted degraded probes share ONE request per event and all adopt the map; after unmount neither event issues a request. Use `settleLoad()` between staging and asserting, and `fetchMock.mockClear()` where a count must be the case's own. -- Every new row is a mount-lifecycle fact only the `dom` project can hold.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- extend the existing failing-routes describe with a case mirroring "adopts a recovered map without a remount": hold the `target` and `EMAIL_SUBJECT` link nodes, restore `routes["/api/wiki/routes"]`, fire the attention event instead of calling `loadSlugTenants()`, then assert both nodes are still `isConnected`, carry `ALICE_TARGET`/`BOB_OTHER`, and that exactly two route requests were made. -- The intent is about a real idle surface; the hook's bookkeeping is not the surface the user sees.
- `_bmad-output/implementation-artifacts/spec-dw-234-262-slug-tenant-map-lifecycle.md` -- amend the Never clause's first bullet to record the widened contract (attention-driven re-fetch while degraded is now permitted; interval/timer/retry-loop and the untouched healthy path are still forbidden), and append a dated Spec Change Log entry naming DW-723, what was widened, and that the `deferred:` harvest entry is left as written. -- The intent requires the originating contract to record the widening rather than be silently contradicted.

**Acceptance Criteria:**
- Given a component using `useSlugTenants` that mounted while `/api/wiki/routes` was failing and has had no remount and no other mount since, when the tab regains focus after the route recovers, then that same on-screen component re-renders with canonical `/u/<tenant>/<slug>` hrefs without a reload.
- Given a session whose map loaded successfully, when any number of `focus` or `visibilitychange` events fire, then no further `/api/wiki/routes` request is issued for the life of the tab.
- Given the full suite, when `pnpm test` runs, then every pre-existing `useSlugTenants`, `useSlugTenantsLifecycle`, `owner-scoped-anchors`, `renderer-slug-tenant-adoption` and `test-infra-conventions` assertion still passes unchanged.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 0
- reject: 7
- addressed_findings:
  - `[low]` `[patch]` The "legitimately EMPTY successful map" case's comment claimed an emptiness-keyed guard "would re-fetch forever for this viewer and pass every other case in this file". Mutation showed the opposite: a warm `cache = {}` is truthy, so `loadSlugTenants`' own `if (cache)` short-circuit absorbs the call and no test in the file can distinguish `cache !== null` from an emptiness test — deleting the guard entirely leaves 43/43 dom and 26/26 node cases green. Both comments rewritten to state what is true; the guard is kept as the legible, still-correct half if that short-circuit ever gains a TTL or revalidation.
  - `[low]` `[patch]` The three-probe case claimed it proved the recovered map arrives "through the EXISTING broadcast, not through a second path into `setMap`". All three probes call `loadSlugTenants()` and share the promise, so each is served by its own `.then` too — adding a second `setMap` path passes 43/43. Comment reworded to claim only the request count and the three hrefs.
  - `[low]` `[patch]` The `visibilityState` guard was pinned only through the `visibilitychange` path; a variant guarding only that path passed everything. `fireFocus()` added inside the `hideTab()` block, still asserting zero requests.
  - `[low]` `[patch]` An attention event landing while a failing request is still in `inflight` joins it, is answered the degraded `{}`, and buys no retry of its own — undocumented and unpinned, and slow failures are exactly when a user switches away and back mid-request. Behavior kept (bypassing `inflight` would stampede an endpoint that is already struggling); stated in the `retryIfDegraded` comment and pinned with a new case built on the file's `release` park seam.
  - `[low]` `[patch]` "collapses every mounted hook's retry into ONE request per event" asserted one request across TWO events — the stronger fact. Retitled to match.
  - `[low]` `[patch]` The component witness was titled "with nothing else on screen changing" and commented "the only thing that happens is the user coming back to the window", both false: `RecentIngests.tsx:245-252` registers its own `window` `focus` listener that resets `polls` and re-runs `tick()`. Retitled and rewritten to say the focus event drives that refresh too, and why DW-723 is still isolated (hrefs come only from `hrefForSlug`; `routeFetches()` counts `/api/wiki/routes` alone).

**Rejected (7):** the deferred-work ledger entry is still `status: open` (orchestrator-owned; this session must not edit it); the originating spec's `deferred:` frontmatter entry still reads "which this spec's Never clause rules out" (deliberate — it is the harvest provenance for DW-723, and the Spec Change Log entry beside it says so); adding a `window` `online` listener (neither trigger the intent names, and the human decision pinned visibility/focus); a time-based throttle on repeated attention events (`setTimeout`/counters are forbidden by both Never clauses, and `inflight` already serializes attempts); `expect(consoleError).not.toHaveBeenCalled()` cannot fail under React 19 (belt-and-braces beside the load-bearing listener-count assertion, and the comment already says so); per-mount listener registration vs one ref-counted module listener (the Always clause chose per-mount deliberately, and `inflight` collapses the fan-out); `loadSlugTenants`' `if (cache)` and `retryIfDegraded`'s `cache !== null` being different predicates (they cannot diverge — the malformed-body guard rejects `null`; folded into the first patch's comment instead).

## Design Notes

The bound is the cache, not a counter. `loadSlugTenants` caches only on success and production never clears the cache, so `cache === null` is exactly "no map has ever arrived". Reading it inside the handler (not closing over the hook's `map` state) means the check is current without re-running the effect, and it turns off for good the moment recovery lands:

```ts
const retryIfDegraded = () => {
  // Healthy: a map is cached (a legitimately empty `{}` from an OK response
  // counts), and production never clears it — so this is a no-op for the rest
  // of the tab. That, not a counter, is what bounds the retry.
  if (cache !== null) return;
  if (document.visibilityState !== "visible") return;
  // No `.then`: a successful load broadcasts to every subscriber, and this
  // hook is one. A failed one degrades to `{}`, caches nothing, and stays
  // eligible for the next attention event.
  void loadSlugTenants();
};
```

Two events, not one: `visibilitychange` covers tab switching and un-minimising, but a browser window that merely lost OS focus to another app usually stays `visibilityState === "visible"`, and returning to it fires only `focus`. The idle Workbench in DW-723 is exactly that case. Both share one handler, and the `inflight` slot collapses the duplicate calls (and every other mounted hook's) into a single request.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx` -- expected: all pass, old cases and new.
- `pnpm exec vitest run --project dom src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` -- expected: all pass, including the new attention-driven recovery case, with no unmounted-update warnings.
- `pnpm exec vitest run --project node src/hooks/__tests__/useSlugTenants.test.ts src/lib/__tests__/test-infra-conventions.test.ts` -- expected: all pass, unchanged.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm exec next lint` -- expected: no warnings or errors.
- `pnpm test` -- expected: the full run is green, no pre-existing suite regressed.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `useSlugTenants` now originates its own recovery instead
of only propagating somebody else's (DW-723). Its mount effect registers one
`retryIfDegraded` handler on `document`'s `visibilitychange` and `window`'s
`focus`; the handler returns immediately when a map has already cached
(`cache !== null`) or when the tab is not visible, and otherwise starts a plain
`loadSlugTenants()`. So a surface that goes idle after an `/api/wiki/routes`
outage — no navigation, no panel opening, no later mount — sheds its
DEFAULT_TENANT hrefs, and their extra 308 hop, the next time the user comes
back, rather than keeping them until a full reload. The bound is the module
cache, not a clock: production never clears it, so the first successful load
turns the handler into a permanent no-op for the life of the tab. No polling, no
timer, no counter, no backoff, and no new test seam. `loadSlugTenants`,
`hrefFromMap`, `resolveSlugPath`, `DEFAULT_TENANT`, the `generation` reset
semantics and every component call site are unchanged.

**Files changed**
- [../../src/hooks/useSlugTenants.ts](../../src/hooks/useSlugTenants.ts) -- the only product change: `retryIfDegraded` plus the two attention listeners inside the existing mount effect, removed in its existing cleanup beside `unsubscribe()`. Deps stay `[]`.
- [../../src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx](../../src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx) -- ADDED a `dom`-project describe (9 cases) over every matrix row plus the mid-flight-join contract, with `fireFocus`/`fireVisibilityChange`/`hideTab` helpers.
- [../../src/components/__tests__/owner-scoped-anchors.test.tsx](../../src/components/__tests__/owner-scoped-anchors.test.tsx) -- ADDED the component witness: `RecentIngests` rows recover on a native `focus` event with no remount and no other caller.
- [spec-dw-234-262-slug-tenant-map-lifecycle.md](spec-dw-234-262-slug-tenant-map-lifecycle.md) -- Never clause widened to record the new contract, plus a dated Spec Change Log entry. Its `deferred:` frontmatter entry is left verbatim as the harvest provenance.

**Review findings breakdown:** 6 patches applied (high 0, medium 0, low 6), 0 deferred, 7 rejected, 0 intent_gap, 0 bad_spec.

**Follow-up review recommendation:** `false`. No patched finding was `high` severity — patched counts high 0, medium 0, low 6.

**Verification** (every command re-run after the patches)
- `pnpm exec vitest run --project dom src/hooks/__tests__/useSlugTenantsLifecycle.test.tsx src/components/__tests__/owner-scoped-anchors.test.tsx src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` -- 51 passed, no unmounted-update warnings.
- `pnpm exec vitest run --project node src/hooks/__tests__/useSlugTenants.test.ts src/lib/__tests__/test-infra-conventions.test.ts` -- 26 passed, unchanged.
- `pnpm exec tsc --noEmit` -- clean. `pnpm exec next lint` -- no warnings or errors.
- `pnpm test` -- 398 files, 9948 passed, 1 pre-existing skip, 0 failed.
- Every I/O matrix row has a covering test that ran and passed. Mutation-checked: dropping the `focus` registration fails 3 cases (2 lifecycle + the component witness); dropping the `visibilitychange` registration fails 2; dropping the `visibilityState` guard fails 1; leaking either listener past unmount fails 1.

**Residual risks**
- A tab that is never blurred does not recover. The trigger is an attention EVENT, but the intent's condition is an idle SURFACE: a user sitting in front of a foreground tab while `/api/wiki/routes` comes back fires neither event and keeps the fallback hrefs until they leave and return, or reload. This is the contract the human decision pinned ("Pin that a degraded hook recovers on the next focus without a mount"), and the amended Never clause records it — a `window` `online` listener, which would fire without any attention change, was considered and rejected as neither trigger the intent names.
- The `cache !== null` guard is redundant-by-construction today: `loadSlugTenants`' own `if (cache)` short-circuit produces the same zero-request outcome, so no test can distinguish them, and the healthy-path cases would stay green if the guard were deleted. It is kept because it is where the bound is legible and the half that stays correct if that short-circuit ever gains a TTL or revalidation. Recorded rather than hidden — the comments now say so.
- An attention event that lands while a failing request is still in flight joins that request and buys no retry of its own; the next event is the one that recovers. Deliberate (bypassing `inflight` would stampede an endpoint that is already struggling), now stated in the code and pinned by a test.
