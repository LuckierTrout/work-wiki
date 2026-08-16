---
title: 'DOM test environment (DW-15, DW-24, DW-52)'
type: 'chore'
created: '2026-08-16'
status: 'done'
baseline_revision: '985ebb6ae661c30e494789eb9543ae71b75f2d98'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The shared dialog hook `useDialogA11y` — the richest DOM-only behaviour in reach — still has no
      mounted coverage.
    evidence: |-
      Esc dismissal, the deliberate "an open <select> eats its own Esc" carve-out, Tab trapping and
      pull-back, the `document.body.style.overflow` lock/restore, and the `fallbackFocusRef` path
      (whose own comment names the case: confirming Create Wiki unmounts the button that opened it)
      are all invisible to a source scan and all still pinned only by `create-wiki-ui.test.ts`'s
      greps. The DOM environment this pass established is what makes them testable.
    location: >-
      src/hooks/useDialogA11y.ts
    severity: medium
  - summary: >-
      WikiWorkbench's other write paths have no mounted coverage — switchWiki's rollback and
      re-entry guard, the degraded `unavailable` render, and create()'s failure branch.
    evidence: |-
      `switchWiki` exists because overlapping PUTs settle out of order and roll the selection back to
      a stale id; the `unavailable` branch must NOT show "No wiki yet." or a Create button; the
      `!wiki?.id` guard's comment says the alternative is "a blank page rather than the error
      message"; and `create()`'s catch has no equivalent of the template flow's
      "keeps the dialog open and shows the failure inside it". None of these are observable from a
      source scan, and this pass covered only the confirm gate the bundle intent named.
    location: >-
      src/components/WikiWorkbench.tsx:108
    severity: medium
  - summary: >-
      Nothing pins the `busy` gate on either dialog, so a double-submit would issue two destructive
      writes with the suite green.
    evidence: |-
      No test clicks `Overwrite` or `Create` twice before the first request settles. Dropping
      `disabled={busy}` from `ConfirmDialog` would double-apply a template overwrite; the labels
      ("Working…", "Creating…") and the mid-flight refusal of Cancel/Esc are likewise unasserted.
    location: >-
      src/components/ConfirmDialog.tsx:93
    severity: medium
  - summary: >-
      Seventeen source files still tell the reader this repository has no DOM test environment, and
      several use that as the stated justification for their design.
    evidence: |-
      `src/lib/workbench-data-version.ts:9`, `workbench-split.ts:8`, `workbench-settings.ts:10`,
      `workbench-preview.ts:243`, four components under `src/components/workbench/`, and nine
      `__tests__` files say so in prose — e.g. "a rule living inside a React effect could only ever
      be grepped for". After this pass that premise is false, so a future agent will reproduce the
      workaround on a reason that no longer holds. The spec's Never forbade touching `src/` in this
      pass, which is why it was not done here.
    location: >-
      src/lib/workbench-data-version.ts:9
    severity: medium
  - summary: >-
      Most of DW-24's own verbatim list is still scan-only — the collapse toggle, badge rendering at
      0 vs > 0, the sidecar dot's three states, and the live-region announcement.
    evidence: |-
      DW-24 enumerates more surfaces than the bundle intent's shortlist. The shortlist (sheet
      open/close/Esc/focus-restore) is now mounted and exceeded, but `workbench-chrome.test.ts` is
      still the only thing covering the rest, by `readFile` + `toContain`. Each is now cheaply
      mountable against the environment this pass added.
    location: >-
      src/components/workbench/IconRail.tsx
    severity: medium
  - summary: >-
      The two polling suites have no mounted case for a rejecting fetch, a malformed body, or a
      wedged (never-settling) probe.
    evidence: |-
      `data-version-watcher.test.tsx` covers `ok: false` but not a transport failure or
      `{ dataVersion: "4" }`; `useSidecarStatus.test.tsx` covers a rejection but not a non-2xx answer
      or the `SIDECAR_PROBE_TIMEOUT_MS` race. The pure halves are executed by the node suite, so this
      is about the effect's handling of them, not the parsing.
    location: >-
      src/components/workbench/__tests__/data-version-watcher.test.tsx
    severity: low
  - summary: >-
      The new `*.test.tsx` ⇒ jsdom / `*.test.ts` ⇒ node convention is documented only in a
      `vitest.config.ts` comment.
    evidence: |-
      `AGENTS.md`'s "Running and verifying" section says nothing about it, so a contributor who names
      a DOM suite `*.test.ts` gets `document is not defined` with no pointer to why. That section sits
      inside the `bmad:context` managed block, which a refresh rewrites — so the note needs to be
      placed deliberately rather than appended here.
    location: >-
      AGENTS.md
    severity: low
  - summary: >-
      The DOM suites import their shim helpers through a relative ladder out of `src`
      (`../../../../vitest.setup.dom`), hardcoding each file's directory depth.
    evidence: |-
      Every other import in the suite uses the `@` alias. Moving a test file requires fixing the
      depth. The natural fix — helpers in `src/test/dom-helpers.ts` re-exported by the setup file —
      adds a file under `src/`, which the spec's Never forbade in this pass.
    location: >-
      src/hooks/__tests__/useSidecarStatus.test.tsx:5
    severity: low
  - summary: >-
      No mounted test can reach the shell's width-derived decisions, because a mounted
      `Workbench` measures `shellWidth === 0`.
    evidence: |-
      The DOM setup file shims `getClientRects()` to a fixed 1x1 but deliberately leaves
      `getBoundingClientRect()` as jsdom's all-zeros, so every `workbench-split` decision the
      mounted shell makes — the clamp, the divider bounds, whether a `SplitHandle` renders at
      all — runs at a width no browser reports, and the window `resize` listener is never
      exercised. The split RULES have their own node-project suite; what stays unpinned is the
      shell's reaction to a width. A `getBoundingClientRect` shim would open this up, and needs
      its own fidelity argument rather than being added in passing.
    location: >-
      vitest.setup.dom.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** `vitest.config.ts` is `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]` and the repo has no jsdom, happy-dom or Testing Library, so nothing renders a component, mounts an effect, advances a timer or dispatches an event. The Create Wiki confirm gate, the workbench sheet, `DataVersionWatcher`'s effect lifecycle and `useSidecarStatus` are pinned only by `readFile` + `toContain` over their own source (DW-15, DW-24, DW-52) — assertions that survive a broken rewrite and break on a harmless reflow.

**Approach:** Add jsdom + `@testing-library/react` as dev dependencies, split `vitest.config.ts` into two vitest projects (the existing node project verbatim, plus a jsdom project that owns `*.test.tsx`), and add four mounted suites that drive the real components and observe the rendered DOM and the requests they issue.

## Boundaries & Constraints

**Always:**
- The node project keeps `environment: "node"`, `include: ["src/**/__tests__/**/*.test.ts"]` and `setupFiles: ["./vitest.setup.ts"]` exactly as they are today, and every existing `.test.ts` file stays byte-identical. The DOM environment is additive.
- `pnpm test` (the CI step in `.github/workflows/ci.yml:53`) runs both projects in one invocation — no second script CI would have to opt into.
- New assertions observe the outermost surface: rendered DOM, focus, and the requests the component issues. No `readFile`/`toContain` over source text in the new suites.
- jsdom has no layout engine, so layout-derived properties (`offsetParent`, `getClientRects`) and `matchMedia` must be shimmed in the DOM setup file, each with a comment saying why. Shims live in the setup file, never in `src/`.
- Install with `pnpm --ignore-workspace add -D …`: an empty `~/pnpm-workspace.yaml` outside the repo makes bare `pnpm` in this repo fail with `ERROR packages field missing or empty`. The flag is a local-environment workaround, not a repo change.

**Block If:**
- The dev dependencies cannot be installed (registry unreachable, or a peer/engine conflict that would require pinning React, Vite or vitest to a different major).

**Never:**
- Change any file under `src/` other than adding the new `.test.tsx` files — the point is to pin the behaviour that exists, not to reshape it into something easier to test.
- Delete, rewrite or weaken the existing source-scan suites (`create-wiki-ui.test.ts`, `workbench-chrome.test.ts`, `workbench-data-version.test.ts`). Several of their assertions cover CSS and file-level structure that a mounted test cannot replace.
- Add `@vitejs/plugin-react` or a second bundler plugin: the DOM project only needs `esbuild: { jsx: "automatic" }` for `.test.tsx` (repo `tsconfig.json` is `"jsx": "preserve"`, so JSX in tests would otherwise fail to transform).
- Add both jsdom and happy-dom. Pick jsdom.
- Touch `.github/` (protected) or the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cancel the template confirm | A wiki exists; `Change template` opened; a different scenario picked | Dialog closes; **zero** `fetch` calls were made | No error expected |
| Confirm the template overwrite | Same, with scenario ≠ current | One `POST /api/wikis/<id>/template` whose body carries the picked scenario | Failed response renders the message inside the dialog, dialog stays open |
| Confirm gate at the default selection | Dialog opened on the wiki's current scenario | The `Overwrite` button is disabled | No error expected |
| Cancel Create Wiki | Empty state; Create Wiki dialog open | Dialog closes; zero `fetch` calls | No error expected |
| Sheet open → Esc | Sheet trigger pressed, focus inside the rail | Sheet closes, `aria-expanded="false"`, focus returns to the trigger | No error expected |
| Viewport widens past 900px | Sheet open; `matchMedia` change fires with `matches: true` | Sheet closes; focus is NOT moved | No error expected |
| Watcher in a hidden tab | `document.visibilityState === "hidden"` at mount | No request at mount; no request after `DATA_VERSION_POLL_MS` | No error expected |
| Watcher becomes visible | `visibilitychange` with state `visible` | One request immediately, then one per poll interval | Non-`ok` body → no `router.refresh()` |
| Polled version moves forward | served 3, route answers 4 | `router.refresh()` called once; a repeat answer of 4 does not call it again | No error expected |
| Watcher unmounts | Poll in flight | The in-flight request's signal is aborted; no further requests after unmount | No error expected |
| Sidecar probe answers | `fetch` resolves 200 then rejects | Status goes `unknown` → `up` → `down` at the poll cadence | Rejection is `down`, not a throw |

</intent-contract>

## Code Map

- `vitest.config.ts` -- the single node config to split into `test.projects`. vitest is `3.2.4`, so inline `projects` is supported (it replaced `workspace`). Each project needs its own `resolve.alias` for `@` — the root-level alias does not cascade to projects.
- `vitest.setup.ts` -- node setup (temp `DATA_DIR`). The DOM project loads this too, then a second DOM-only setup file.
- `package.json` -- `test: "vitest run"` (line 11); React 19.1.0 + `react-dom` 19.1.0 already present, so `@testing-library/react` must be v16+ and needs `@testing-library/dom` installed explicitly (it is a peer, not a dependency).
- `src/components/WikiWorkbench.tsx` -- `send()` (line 38) is plain global `fetch`; `create()` (82), `applyTemplate()` (127); the `ConfirmDialog` wiring at 274-325 carries `confirmDisabled={pendingScenario === current?.scenario}` and `onConfirm={() => void applyTemplate()}` — the exact rewiring DW-15 says the source scan cannot catch. Uses `useRouter()` from `next/navigation` (line 53) → must be mocked.
- `src/components/ConfirmDialog.tsx` / `src/components/CreateWikiDialog.tsx` -- the overlay pair; both delegate focus/Esc to `useDialogA11y`.
- `src/components/workbench/Workbench.tsx` -- sheet trigger at 500-510 (`aria-expanded`, `aria-controls={RAIL_ID}`); Esc + Tab-cycle effect at 362-400; `matchMedia(WIDE_QUERY)` effect at 404-416; focus move-in / restore effect at 420-431 — the restore is guarded by `trigger?.offsetParent`, which jsdom leaves `null` for every element, and the Tab cycle filters on `getClientRects().length > 0`, which jsdom leaves empty for every element. Both need shims or those paths cannot run at all.
- `src/components/workbench/WorkbenchData.tsx` -- `WorkbenchDataProvider`; every field has an empty default, so a test provider only needs the fields it exercises.
- `src/components/workbench/DataVersionWatcher.tsx` -- renders null; the whole subject is the effect at 60-125 (`run`, `startPolling`, `stopPolling`, `onVisibility`, the `subscribeDataVersionCheck` hook-up, and the cleanup that clears the interval, removes the listener, unsubscribes and aborts).
- `src/lib/workbench-data-version.ts` -- `DATA_VERSION_ROUTE` (`/api/workbench/version`), `DATA_VERSION_POLL_MS` (10_000), `fetchDataVersion(signal)` defaults to global `fetch`, `subscribeDataVersionCheck` / `requestDataVersionCheck`, and `_resetDataVersionListeners()` — call it in `afterEach` so files cannot leak listeners.
- `src/hooks/useSidecarStatus.ts` -- `POLL_MS` is 15000 and module-private; the test must drive the cadence by advancing that many ms, not by importing a constant.
- `src/lib/sidecar.ts` -- `probeSidecar` races the fetch against a `SIDECAR_PROBE_TIMEOUT_MS` (1500) timer. Under fake timers the race resolves only when timers are advanced, so the harness must flush both the timer queue and microtasks.
- `src/components/__tests__/markdown-math.test.ts` -- the existing `createElement` + `renderToStaticMarkup` convention the new suites replace for interactive surfaces.
- `.github/workflows/ci.yml:53` -- runs `pnpm test`; read-only evidence that a `projects` split is the right shape and no workflow edit is needed.

## Tasks & Acceptance

**Execution:**
- `package.json` / `pnpm-lock.yaml` -- add `jsdom`, `@testing-library/react`, `@testing-library/dom` to `devDependencies` via `pnpm --ignore-workspace add -D` -- the DOM environment and the mounting library; the lockfile update is part of the change.
- `vitest.config.ts` -- replace the single `test` block with `test.projects: [node, dom]`; the node project restates today's `environment`/`include`/`setupFiles` unchanged, the dom project is `environment: "jsdom"`, `include: ["src/**/__tests__/**/*.test.tsx"]`, `setupFiles: ["./vitest.setup.ts", "./vitest.setup.dom.ts"]`, `esbuild: { jsx: "automatic" }`, and both carry the `@` alias -- one `pnpm test` runs both, and `.test.ts` files stay out of jsdom.
- `vitest.setup.dom.ts` (new) -- Testing Library `cleanup` in `afterEach`, plus commented shims for `window.matchMedia`, `HTMLElement.prototype.offsetParent` and `HTMLElement.prototype.getClientRects`, and a helper to set `document.visibilityState` -- jsdom ships no layout engine and no `matchMedia`, so without these the very code paths under test bail out early.
- `src/components/__tests__/create-wiki-flow.test.tsx` (new) -- mount `WikiWorkbench` with a mocked `next/navigation` router and a `fetch` spy; drive Create Wiki and the Change-template confirm gate -- DW-15's confirm gate and "Cancel writes nothing", asserted as issued requests rather than as source text.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx` (new) -- mount `Workbench` inside `WorkbenchDataProvider`; assert sheet open/close via trigger, backdrop, Esc and a `matchMedia` widening, plus focus move-in and focus restore -- DW-24's shell behaviours.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` (new) -- mount `DataVersionWatcher` with fake timers, a stubbed `fetch` and a `router.refresh` spy; cover hidden-at-mount, becoming visible, poll cadence, forward-only refresh, the `requestDataVersionCheck` nudge, and unmount teardown -- DW-52's effect lifecycle.
- `src/hooks/__tests__/useSidecarStatus.test.tsx` (new) -- mount a harness component that renders the hook's status; cover the `unknown` start, `up`/`down` transitions, the 15s cadence, no polling while hidden, an immediate re-probe on becoming visible, and abort on unmount -- the hook DW-24 records as having no test at all.

**Acceptance Criteria:**
- Given the repo after this change, when `pnpm test` runs, then both a `node` and a `dom` project execute and every suite passes, with the pre-existing `.test.ts` suites reporting the same results as before.
- Given the new suites, when any one of them is run against a component whose interactive wiring has been broken (e.g. `onConfirm` calls `applyTemplate()` without the dialog, or `startPolling()` is deleted from the watcher's `visible` branch), then at least one assertion fails — the failure mode DW-15/DW-24/DW-52 name as currently undetectable.
- Given `pnpm lint` and `tsc --noEmit`, when they run over the new `.test.tsx` files, then neither reports an error.
- Given a run of the DOM project, when suites finish, then no test leaves a React `act(...)` warning or an unhandled rejection in the output.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 4, low 4)
- defer: 8: (high 0, medium 5, low 3)
- reject: 7
- addressed_findings:
  - `[medium]` `[patch]` Neither Tab **wrap** branch of the sheet's focus loop was exercised — the one Tab test blurred first, so it always took the `!inside` arm. A reviewer dropped both wrap clauses and all 30 DOM tests stayed green. Added `Tab` off the last control → first and `Shift+Tab` off the first → last.
  - `[medium]` `[patch]` The rail's `getClientRects().length > 0` filter was unobservable (the shim reports every element visible), so deleting it left the suite green. Added a case that hides the collapse chevron the one way the shim honours and asserts the hidden control is not the wrap point.
  - `[medium]` `[patch]` The `trigger?.offsetParent` focus-restore guard was unobservable — every test that reached the path expected focus **on** the trigger, which the unguarded rewrite also produces. Added a case that hides the trigger inline before an Esc dismissal and asserts focus is unchanged.
  - `[medium]` `[patch]` `DataVersionWatcher`'s per-render `servedRef.current = dataVersion` was unobservable: no test re-rendered the provider, so the stale-closure rewrite (`served: dataVersion`) passed. Added a `rerender` case, and made the router mock one stable object so the effect is not torn down by it.
  - `[low]` `[patch]` RTL `cleanup()` ran after each file's own `afterEach` (reverse hook order), so trees unmounted against a disposed fake clock, a restored `fetch` and a cleared listener registry — which made `_resetDataVersionListeners()` mask a leak. `cleanup()` is now the first statement of every suite's `afterEach`; the setup file's call remains a backstop.
  - `[low]` `[patch]` The `matchMedia` shim advertised `onchange` that `setMediaQuery` never invoked, and `resetMediaQueries()` cleared the map, orphaning any list a component still held. Both fixed, and the two fidelity limits (`displayHidden` sees only inline/`hidden`, `getBoundingClientRect()` is all zeros so the shell runs at `shellWidth === 0`) are now documented in the setup file.
  - `[low]` `[patch]` The immediate-check test asserted `refresh` straight out of `act` with no `settle()` — the one timing-incidental assertion in the change. Settle added.
  - `[low]` `[patch]` The fake `Response` carried no `status`, so `send()`'s `Request failed (${status})` fallback would have rendered "undefined" unseen, and the fixture id needed no percent-encoding, so `encodeURIComponent` could be deleted with the suite green. Both fixed, each with a case that fails on the mutation.

### 2026-08-16 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 25
- addressed_findings:
  - `[medium]` `[patch]` Not one of the four Tab tests observed `preventDefault()` — jsdom moves focus for nobody on a synthetic keydown, so asserting where `document.activeElement` lands was satisfied by the handler's own `focus()` call alone. Deleting BOTH `preventDefault()` calls from `Workbench.tsx` left all 10 sheet tests green, while a real browser would honour the `focus()` and then walk on to the next control — the exact strand the cycle exists to prevent. Added a `pressTab()` helper that reports whether the press was cancelled; the mutation now fails 4 tests.
  - `[medium]` `[patch]` A `dom` project that collects zero files does not fail `pnpm test`: the run is satisfied by the node project and exits 0 with the project absent from the report. Demonstrated by breaking the include glob — 206 files, 4301 tests, exit 0, every mounted assertion silently gone, and a report indistinguishable from the pre-change baseline. `vitest.config.ts` now applies the include to what is on disk at config load and refuses to run when it matches nothing, or when a `.test.tsx` sits somewhere the include cannot reach. Both drift modes verified to fail loudly.
  - `[low]` `[patch]` Neither POST assertion looked at headers, so deleting `Content-Type: application/json` from `send()` — which the routes parse the body on — kept the suite green. Asserted on both requests; the mutation now fails 2 tests.
  - `[low]` `[patch]` `router.refresh()` after a successful Create was unasserted (the template path asserted it), so the staleness fix for a call that rewrites the tenant workspace profile was unpinned. Asserted; the mutation now fails.
  - `[low]` `[patch]` `send()`'s `.json().catch(() => ({}))` was unreachable in test — the fake `Response`'s `json` never rejected — so the ordinary "route died and returned an HTML error page" case would have surfaced a `SyntaxError` to nobody, leaving the dialog on "Working…". Added a 502-with-non-JSON-body case; the mutation now fails.
  - `[low]` `[patch]` `setVisibilityState` moved `visibilityState` but left `document.hidden` pinned at `false`, so every "does not poll while hidden" test would have quietly asserted nothing the moment a component read the equally idiomatic property. Both now move together.
  - `[low]` `[patch]` `setMediaQuery` minted a registry entry for any string, so a query the component had renamed (they are module-private, so tests repeat the literal) would move something nothing listens to and pass as a no-op. It now refuses a query no `matchMedia()` call has asked for; verified against a typo'd `WIDE_QUERY`.
  - `[low]` `[patch]` Three sheet tests indexed a control list or clicked a `querySelector` result without a guard, so a rail that stopped rendering them would throw on `undefined.focus()` / `click(null)` instead of failing where the claim is. Guarded.

## Design Notes

Two projects rather than a second config file plus a second script: CI runs `pnpm test` and nothing else, so a separate `vitest.dom.config.ts` would be a suite nobody runs. Shape:

```ts
const alias = { "@": path.resolve(__dirname, "./src") };
export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", environment: "node", include: ["src/**/__tests__/**/*.test.ts"],
                setupFiles: ["./vitest.setup.ts"] }, resolve: { alias } },
      { test: { name: "dom", environment: "jsdom", include: ["src/**/__tests__/**/*.test.tsx"],
                setupFiles: ["./vitest.setup.ts", "./vitest.setup.dom.ts"] },
        esbuild: { jsx: "automatic" }, resolve: { alias } },
    ],
  },
});
```

"Cancel writes nothing" is asserted on the `fetch` spy's call count, not on a state flag: the claim is that no request was issued, and a spy that was never called is the only observation that actually makes it.

## Verification

**Commands:**
- `pnpm --ignore-workspace add -D jsdom @testing-library/react @testing-library/dom` -- expected: installs cleanly, `package.json` `devDependencies` and `pnpm-lock.yaml` updated.
- `pnpm --ignore-workspace test` -- expected: both projects run; all suites green; the node project still reports its baseline of **206 test files / 4301 tests** (measured at `985ebb6`, before this change), with the DOM project's files and tests on top.
- `pnpm --ignore-workspace exec tsc --noEmit` -- expected: no errors.
- `pnpm --ignore-workspace lint` -- expected: no new errors.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** A second vitest project gives this repository a DOM test environment for the first time: jsdom + `@testing-library/react` as dev dependencies, `vitest.config.ts` split into a `node` project (today's config, restated unchanged) and a `dom` project that owns `*.test.tsx`, a DOM setup file carrying the three shims jsdom's missing layout engine forces, and four mounted suites (37 tests) that drive the real components and assert on rendered DOM, focus and issued requests instead of on their own source text. This follow-up review pass added no new surface; it hardened what the previous pass built.

**Files changed** (since `985ebb6`):
- `package.json` / `pnpm-lock.yaml` -- `jsdom`, `@testing-library/react`, `@testing-library/dom` added as dev dependencies.
- `vitest.config.ts` -- single config split into `test.projects`; plus a config-load guard that refuses to run when the dom project would collect nothing or would leave a `.test.tsx` uncollected.
- `vitest.setup.dom.ts` (new) -- RTL `cleanup`, and commented shims for `matchMedia`, `offsetParent`, `getClientRects` and `visibilityState`/`hidden`, each with its fidelity limits stated.
- `src/components/__tests__/create-wiki-flow.test.tsx` (new) -- the Create Wiki and Change-template confirm gates, asserted as issued requests (9 tests).
- `src/components/workbench/__tests__/workbench-sheet.test.tsx` (new) -- the sheet's open/close/Esc/backdrop/breakpoint behaviour and its focus cycle (10 tests).
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` (new) -- the watcher's whole effect lifecycle (11 tests).
- `src/hooks/__tests__/useSidecarStatus.test.tsx` (new) -- the hook DW-24 recorded as having no test at all (7 tests).

**Review findings breakdown.** 8 patches applied (0 high, 2 medium, 6 low), 1 item deferred (low), 25 rejected. Both medium patches were failures of the new tests to observe what they claimed: the sheet's Tab cycle never checked that the press was cancelled, and a dom project collecting zero files could not fail a `pnpm test` run. Each patch was proved by mutation — the defect it names now fails the suite.

**Follow-up review recommendation:** `true`. Patched this pass: 0 high, 2 medium, 6 low; score = 3x2 + 1x6 = 12, which is >= 5.

**Verification performed.**
- `pnpm --ignore-workspace test` -- 210 files / 4338 tests pass in one invocation, both projects. The node project holds its `985ebb6` baseline exactly (206 files / 4301 tests); the dom project adds 4 files / 37 tests.
- `pnpm --ignore-workspace exec tsc --noEmit` -- clean. (`fs.globSync` was tried first for the include guard and rejected: `@types/node@^20` does not declare it.)
- `pnpm --ignore-workspace lint` -- exit 0, no new findings; the only output is the repo's pre-existing `jsx-ast-utils` notices.
- `vitest run --project dom` -- 37 pass with no React `act(...)` warning and no unhandled rejection.
- Mutation checks, each run against the working tree and reverted: deleting both `preventDefault()` calls (4 failures), breaking the dom include glob (config refuses; previously exit 0), moving a suite out of `__tests__` (config refuses), deleting the `Content-Type` header (2 failures), deleting `.json()`'s `.catch` (1 failure), deleting `router.refresh()` from `create()` (1 failure), and typo-ing the `WIDE_QUERY` literal (`setMediaQuery` throws).

**Residual risks.**
- The three shims are approximations of a layout engine. `displayHidden` sees only the `hidden` attribute and an inline `display: none`, so the three tests that need an element to count as hidden produce that state themselves rather than getting it from the app's stylesheet — the DOM state under test is the test's, not the app's CSS's.
- `getBoundingClientRect` stays all-zeros, so a mounted `Workbench` runs at `shellWidth === 0` and no mounted test reaches the split/resize decisions. Recorded as deferred.
- The behaviour these suites pin is now asserted twice: the source-scan suites still grep for the same wiring, since the intent's Never forbids weakening them. The reflow-brittleness the Problem statement opened with is supplemented rather than retired.
- Request assertions stop at the `fetch` boundary. They pin the URL, method, headers and body the component builds — not that the route accepts them.

