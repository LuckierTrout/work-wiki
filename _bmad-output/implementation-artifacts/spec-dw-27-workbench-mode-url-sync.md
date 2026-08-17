---
title: 'DW-27 — mirror the Workbench mode into a ?mode= query param'
type: 'feature'
created: '2026-08-17'
status: 'done'
baseline_revision: '500d6461d79507ddeae350a35130acc3b8938d86'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The repo now carries two independent conventions for reading a query param
      on the client, and neither references the other.
    evidence: |-
      `src/app/wiki/graph/page.tsx:41` already does
      `new URLSearchParams(window.location.search).get("scope")`, with a comment
      at `:35` giving the same "avoid the useSearchParams bailout" rationale that
      `src/lib/workbench-url.ts` was introduced under. Pre-existing — DW-27 did
      not create it — but `workbench-url.ts` is now presented as the home for URL
      rules, so the divergence is easier to inherit than it was.
    location: >-
      src/app/wiki/graph/page.tsx:35-42
    severity: low
  - summary: >-
      With Settings open the URL still names the underlying mode, so a link
      copied there reopens the mode canvas and Back on the first entry leaves the
      app with the unsaved Settings draft.
    evidence: |-
      DW-27 is scoped to the mode by its own ledger text ("the active mode has no
      URL representation"), and Settings is a surface, not a mode — so this is
      not a regression: Back left the app before this change too, on every
      surface. What changed is that modes now have a Back that stays, which makes
      Settings the one surface where it still does not. Worth an explicit
      decision alongside whatever story owns the Settings draft lifecycle.
    location: >-
      src/components/workbench/Workbench.tsx (toggleSettings)
    severity: low
  - summary: >-
      A deep link followed by a signed-out browser loses its `?mode=` at the
      sign-in redirect, which is the case a shared or bookmarked link is most
      likely to be in.
    evidence: |-
      `src/app/page.tsx:38` is `redirect("/sign-in")` with no return-to, and
      `src/app/sign-in/[[...sign-in]]/page.tsx` renders `<SignIn />` with no
      `forceRedirectUrl` / `fallbackRedirectUrl`, so Clerk returns to `/`. The
      whole original URL is dropped, not just the param — pre-existing, and it
      predates DW-27 by every commit. DW-27 is what gives it a cost: before this
      there was nothing in the URL to lose.
    location: >-
      src/app/page.tsx:38
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The active Workbench mode lives only in React state plus the `yopedia_workbench_mode` localStorage key (`Workbench.tsx:121,126,177-182`), so a mode cannot be linked or bookmarked and pressing Back leaves the app entirely (DW-27). Stories 1.4–1.6 have since layered tab, selection and width state on the same persisted-state contract, so changing it later is a breaking change.

**Approach:** Implement the recorded decision — mirror the active mode into a `?mode=` query param using the native History API (`window.history.pushState` / `replaceState`, Next 15's sanctioned shallow-routing mechanism), accept the param on load *ahead of* the localStorage restore, and restore the mode from the URL on `popstate`. The URL rules live in a new pure module the node suite can execute; the shell keeps the router ban that `epics.md:367` requires.

## Boundaries & Constraints

**Always:**
- Mode switching stays `setState` on ONE mounted shell. History writes are `window.history.pushState` / `replaceState` only — never `router.push`, never `<Link>`, never `useRouter()`. The existing bans in `workbench-chrome.test.ts:141-143` and `workbench-left-column.test.ts:376-378` must still hold verbatim after this change.
- On load the URL wins: a valid `?mode=` selects the mode; an absent, unknown or malformed value falls back to `readStoredMode()`, which itself falls back to `DEFAULT_WORKBENCH_MODE`. This ordering is the same one every later restore in the mount effect observes — tab, collapse, widths and selection are unchanged and still read storage.
- Restoring a mode on load stays silent: `announcement` is only filled by a mode change the owner made (`Workbench.tsx:141-143`). A `popstate` mode change *is* one, and announces the surface name (epic accessibility floor, EXPERIENCE.md:175).
- Every history entry the shell writes names a mode explicitly, so Back never lands on an entry whose mode is implied.
- Storage writes stay OUTSIDE React state updaters (StrictMode invokes updaters twice) — the rule `toggleCollapsed` and `selectTreeTab` already follow.
- The URL rules are pure functions in `src/lib/`, executed by the node suite, not conditions inlined in the component where only a grep could reach them (the `shouldDockPreview` convention).
- Other query params and the hash are preserved when `mode` is written.

**Block If:**
- The change would require `useSearchParams()` (it forces a Suspense boundary and dynamic rendering on `src/app/page.tsx`) or any other `next/navigation` hook inside `Workbench.tsx`.

**Never:**
- Do not put Settings, the tree tab, the selection, the collapse state or the widths in the URL — DW-27 is the mode only.
- Do not remove or weaken the localStorage mode restore; the URL is layered on top of it, not a replacement.
- Do not rename `WORKBENCH_MODE_KEY` (`yopedia_workbench_mode`) — runtime identifiers keep the `yopedia` prefix (AD-7).
- Do not add a route, a route segment, or a `[mode]` dynamic path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deep link | Load `/?mode=chat`, storage holds `wiki` | Chat is the active mode; URL still reads `?mode=chat` | No error expected |
| No param | Load `/`, storage holds `lint` | Lint is active; URL is rewritten to `?mode=lint` via `replaceState` (no new history entry) | No error expected |
| Unknown param | Load `/?mode=nope`, storage holds `graph` | Graph is active; URL is corrected to `?mode=graph` | Value rejected by `isWorkbenchModeId`, storage used |
| Empty param | Load `/?mode=`, no storage | Wiki (`DEFAULT_WORKBENCH_MODE`) is active; URL becomes `?mode=wiki` | Same rejection path |
| Mode switch | Active `wiki`, owner clicks Chat | `pushState` to `?mode=chat`; one new history entry; shell not unmounted | No error expected |
| Re-click active mode | Active `chat`, owner clicks Chat | No history entry added (Back still reaches the previous mode); Settings still closes | No error expected |
| Back | `?mode=wiki` → clicked Chat → Back | Mode returns to `wiki`, Settings closes, surface name announced, no page reload | No error expected |
| Forward | …then Forward | Mode returns to `chat` | No error expected |
| Other params kept | `/?wiki=abc&mode=wiki`, owner clicks Search | URL becomes `/?wiki=abc&mode=search` | No error expected |
| SSR | Module imported on the server | No `window` access at import time or during render; the URL read happens in the mount effect | Guarded, same as `readStoredMode` |

</intent-contract>

## Code Map

- `src/components/workbench/Workbench.tsx` -- the shell. `mode` is `useState` at `:121`; the mount effect restores mode/tab/collapse/widths/selection at `:172-195` (note the deliberate double `readStoredMode()` / `readStoredTreeTab()` reads at `:177-182`, pinned by tests); `selectMode` at `:269-281` writes storage, sets the announcement, closes Settings and closes the sheet; the router ban is documented at `:74-88`. `restoreSignatureRef` at `:162,191` must be built from the *effective* restored mode, not the stored one, or a restored tree selection is cleared by the reset effect at `:210-219`.
- `src/lib/workbench-modes.ts` -- `WorkbenchModeId`, `DEFAULT_WORKBENCH_MODE`, `isWorkbenchModeId` (`:91`). Reuse `isWorkbenchModeId` for URL narrowing; do not write a second validator.
- `src/lib/workbench-state.ts` -- `readStoredMode` / `writeStoredMode` (`:55-75`), the guarded-accessor shape (SSR guard + try/catch) the new module should echo. Read-only for this change.
- `src/lib/workbench-split.ts`, `src/lib/workbench-tree.ts` -- the pure-module + node-suite convention to follow for the new URL module. Read-only.
- `src/lib/__tests__/workbench-chrome.test.ts` -- `:134-145` is the router-ban pin to update; `:204-214` pins `setModeState(readStoredMode())`, which this change replaces with the URL-first resolution. Source-scan suite (node env).
- `src/lib/__tests__/workbench-left-column.test.ts` -- `:71-81` pins `setTreeTab(readStoredTreeTab())` (unchanged by this work); `:363-380` restates the router ban for the shell — keep it holding.
- `src/components/workbench/__tests__/workbench-sheet.test.tsx` -- the mounted-shell harness to copy: `vi.mock("next/navigation")` at `:20-24`, the `WorkbenchData` fixture at `:29-38`, the `fetch` stub for `useSidecarStatus` and the `cleanup()`-first `afterEach` at `:41-58`.
- `vitest.config.ts` -- two projects: `src/**/__tests__/**/*.test.ts` on node, `src/**/__tests__/**/*.test.tsx` on jsdom. A new `.test.tsx` must live under a `__tests__` directory or config load throws.
- `src/app/page.tsx:130` -- where `<Workbench>` mounts. Read-only: nothing here changes, and it must not gain `searchParams`.
- Verified: jsdom 30 implements `history.pushState` / `back()` / `forward()` and fires `popstate` asynchronously — a `await new Promise(r => setTimeout(r, 0))` inside `act` is enough to observe it.
- Verified against Next 15.5.18 docs: `window.history.pushState(null, '', url)` is the App Router's supported shallow-routing call and does not re-run the server.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-url.ts` -- new pure module: export `WORKBENCH_MODE_PARAM = "mode"`; `readModeFromSearch(search: string): WorkbenchModeId | null` (parse with `URLSearchParams`, narrow with `isWorkbenchModeId`); `initialMode(search: string, stored: WorkbenchModeId): WorkbenchModeId` (URL first, stored second); `locationHref(loc)` and `modeHref(loc, mode)` over a `{ pathname, search, hash }` shape, preserving other params and the hash -- keeps the whole URL rule executable by the node suite and free of `window`.
- `src/lib/__tests__/workbench-url.test.ts` -- new node suite executing every I/O Matrix row that is a pure URL/storage-precedence question (valid, absent, unknown, empty param; other params and hash preserved; `modeHref` idempotence) -- these rules must be run, not grepped.
- `src/components/workbench/Workbench.tsx` -- resolve the mount mode as `initialMode(window.location.search, readStoredMode())`, use it for both `setModeState` and the `restoreSignatureRef` layout signature, and `replaceState` the corrected href when it differs from the current one; extract the body of `selectMode` into `applyMode(next)` (state, `writeStoredMode(next)`, `setAnnouncement(workbenchMode(next).label)`, close Settings, close sheet) so `selectMode` = `applyMode` + `pushState`, skipping the push when the URL already names `next`; add a `popstate` effect that calls `applyMode(initialMode(window.location.search, readStoredMode()))` -- one resolution rule for load and traversal.
- `src/lib/__tests__/workbench-chrome.test.ts` -- update the router-ban pin: keep `router.push(` / `next/link` / `useRouter(` banned, and add that the shell syncs the mode through `window.history.pushState` / `replaceState` and a `popstate` listener; update the persistence pin from `setModeState(readStoredMode())` to the URL-first call site -- the ban is now "no routing", not "no URL".
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` -- new mounted suite (jsdom): deep link, URL rewrite on load, push on switch, Back and Forward, reset `window.history.replaceState(null, "", "/")` in `beforeEach` because jsdom's session history outlives `cleanup()`.

**Acceptance Criteria:**
- Given the shell is mounted at `/?mode=chat` while storage holds `wiki`, when the first paint settles, then the rail marks Chat current and no mode-change announcement is made.
- Given the shell is mounted at `/` while storage holds `lint`, when the mount effect runs, then Lint is active, the URL reads `?mode=lint`, and `window.history.length` is unchanged.
- Given Wiki is active, when the owner clicks Chat in the rail, then the URL becomes `?mode=chat`, a history entry is added, and the mounted shell is not remounted (the tree state, sidecar probe and measured shell width are untouched).
- Given the owner switched from Wiki to Chat, when they navigate Back, then Chat gives way to Wiki, Settings is closed, the surface name is announced, and no navigation leaves the page.
- Given the owner navigated Back to Wiki, when they navigate Forward, then Chat is active again.
- Given Chat is active and Settings is open, when the owner clicks Chat in the rail again, then Settings closes and no new history entry is created.
- Given `Workbench.tsx` is read as text, when the source-scan suite runs, then it contains no `router.push(`, no `from "next/link"` and no `useRouter(` call, and it does contain the `pushState`, `replaceState` and `popstate` call sites.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 5, low 6)
- defer: 2: (high 0, medium 0, low 2)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` The `popstate` handler called `applyMode` unconditionally, so a traversal that did not move the mode still closed Settings (discarding the draft), rewrote storage and announced a switch that never happened — reachable today via `SiteChrome.tsx:39,47`'s `<a href="#wb-canvas">` skip link. Added a `modeRef` assigned during render and an early return when the resolved mode equals the one on screen; pinned by a new mounted case.
  - `[medium]` `[patch]` A deep link did not write storage, contradicting `applyMode`'s own stated invariant: `/?mode=chat` over stored `wiki` showed Chat but a later bare `/` restored Wiki. The mount effect now writes the resolved mode when it differs — silently, storage only — placed last in the effect so no read in it observes a value it wrote.
  - `[medium]` `[patch]` No test read storage back (mutation-verified: moving `writeStoredMode(next)` from `applyMode` into `selectMode` left every suite green). Added `readStoredMode()` assertions after a deep link, a rail switch, and Back.
  - `[medium]` `[patch]` The `restoreSignatureRef` path became URL-dependent and nothing executed it (mutation-verified: building the signature from `readStoredMode()` kept all 514 workbench tests green while silently breaking selection reset for deep-link sessions). Added a mounted case with a loaded fixture, a stored selection, and storage mode ≠ `?mode=`.
  - `[medium]` `[patch]` Both history writes were unguarded; a `SecurityError` in the mount seed would have skipped the selection restore and `setMounted(true)`, leaving the split handles unrendered. Wrapped both in try/catch in `workbench-state.ts`'s shape, scoped so a history failure costs only the linkable URL.
  - `[low]` `[patch]` `modeHref`'s doc claimed other params were "untouched"; `URLSearchParams.toString()` re-encodes (`%20`→`+`, `?flag`→`?flag=`, `,`→`%2C`). Comment corrected to values-and-positions preserved, query string normalized, with the once-per-load seed rewrite recorded.
  - `[low]` `[patch]` The idempotence test fed `modeHref`'s own normalized output back in, so it could not fail for its stated reason. Rebuilt over raw inputs with an explicit normalization case.
  - `[low]` `[patch]` The `useSearchParams` ban comment cited dynamic rendering, but `src/app/page.tsx:20` is already `force-dynamic`. Dropped that half; kept the Suspense-boundary reason.
  - `[low]` `[patch]` Nothing recorded that URL-first is an effect, not an SSR guarantee — `/?mode=chat` paints the default for one frame. Noted in the mount effect, cross-referenced to `mounted`.
  - `[low]` `[patch]` Nothing pinned the "mode only" boundary. Added a case asserting a tree-tab switch and a collapse toggle move neither `window.location.search` nor `window.history.length`.
  - `[low]` `[patch]` The targeted Verification command omitted `workbench-split.test.ts`, which this change modifies (a third verbatim pin on the mount effect). Added to the command.

### 2026-08-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 1: (high 0, medium 1, low 0)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` Neither history `catch` was executed by anything (mutation-verified: widening the mount `try` to swallow nothing, and deleting the `selectMode` catch outright, both left all 4496 tests green). Added two mounted cases that make `replaceState`/`pushState` throw `SecurityError`. The first asserts the mount effect still reaches the selection restore and `data-mounted="true"`; the second had to catch what ESCAPES the click handler — `applyMode` runs before the push, so mode, storage and announcement land either way and no state assertion can tell the two apart. Both mutation-verified to fail without their guard.
  - `[low]` `[patch]` `announced()` took the FIRST `[aria-live="polite"]` in the document, but `SettingsCanvas.tsx:518` renders one earlier in DOM order than the shell's announcer at `Workbench.tsx:779` — so the one test that reads it with Settings open was measuring the Settings status span, not the shell's live region. Scoped to `.wb-sr-only[aria-live="polite"]`.
  - `[low]` `[patch]` Nothing recorded that mirroring the mode makes every mode switch a PostHog `$pageview`: Next patches the history methods, so the search-params hook `Analytics` (mounted app-wide by `ClientProviders`) keys on sees each write. Recorded in the shell header with the reason it is accepted rather than suppressed.
  - `[low]` `[patch]` The once-per-load normalization rewrite was documented but unpinned at mount — only the pure suite saw the string. Added a mounted case loading `/?q=a%20b&mode=chat` that asserts the rewrite happens, adds no history entry, and leaves `q` parsing back to `a b`.
  - `[low]` `[patch]` A repeated `?mode=chat&mode=wiki` was untested, though the module's stated premise is that a query param is exactly as untrusted as a hand-edited storage value. Pinned that `get` takes the first occurrence — the same one `set` overwrites in place — and that being first does not exempt it from narrowing.
  - `[low]` `[patch]` The "mode only" boundary test pinned the tree tab and the collapse flag but not Settings, the surface the rail marks `aria-current` exactly as it marks a mode and so the one most easily mistaken for one. Added open-and-close assertions to the same case.
  - `[low]` `[patch]` The mounted suite's header implied broader coverage than it has: it mocks `next/navigation` away, so the Next router patch that makes these calls shallow routing is precisely what it cannot execute, and "no remount" is React keeping the tree rather than App Router behaviour. Stated as an explicit coverage limit.

## Design Notes

Why the native History API rather than `router.push`: the App Router re-renders the route segment on `router.push`, which unmounts everything above the mode panel — exactly what `epics.md:367` forbids (a mode switch must not destroy typed Chat input). Next 15 patches `window.history.pushState`/`replaceState` into its router, so the URL updates with no server round trip and no unmount. This is why the ban is *narrowed*, not lifted.

Why the URL is seeded on load with `replaceState`: without it the first entry carries no `mode`, so Back after one switch lands on an ambiguous entry and the popstate handler has to invent a policy. Seeding makes every entry the shell owns explicit, and `initialMode` is then the single rule for load *and* traversal.

The shape the component ends up with:

```ts
const applyMode = useCallback((next: WorkbenchModeId) => {
  setModeState(next);
  writeStoredMode(next);
  setAnnouncement(workbenchMode(next).label);
  setSettingsOpen(false);
  closeSheet();
}, [closeSheet]);

const selectMode = useCallback((next: WorkbenchModeId) => {
  applyMode(next);
  // Compared against the URL, not against `mode`: no dependency on the state
  // this is about to change, and a re-click adds no entry Back would swallow.
  if (readModeFromSearch(window.location.search) !== next) {
    window.history.pushState(null, "", modeHref(window.location, next));
  }
}, [applyMode]);
```

Storage still gets written on a `popstate` mode change: what is on screen and what a param-less reload would restore should not diverge.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-url.test.ts src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-split.test.ts src/components/workbench/__tests__/workbench-mode-url.test.tsx src/components/workbench/__tests__/workbench-sheet.test.tsx` -- expected: all pass, including both router-ban restatements. `workbench-split.test.ts` is in the list because it carries a third verbatim pin on the mount effect's mode restore.
- `pnpm test` -- expected: both vitest projects green, no pre-existing suite regressed.
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new type errors.
- `pnpm lint` -- expected: no new errors.

## Auto Run Result

Status: done

**Implemented change.** The active Workbench mode is mirrored into a `?mode=` query param using the native History API. A new pure module holds every rule about what the URL says; the shell decides only when a history entry is written. On load the URL beats the stored mode, the resolved mode is seeded back into the URL with `replaceState` (so every entry names its mode) and written to storage (so a deep link and a later param-less reload agree). A rail click pushes one entry, skipping the push when the URL already names the mode. `popstate` re-resolves through the same rule and applies it only when the mode actually moved. The router ban is narrowed to routing, not the URL.

**Files changed.**
- `src/lib/workbench-url.ts` — new pure module: `WORKBENCH_MODE_PARAM`, `readModeFromSearch`, `initialMode`, `locationHref`, `modeHref`, over a `{pathname, search, hash}` shape with no `window` access.
- `src/components/workbench/Workbench.tsx` — URL-first mount resolution feeding both `setModeState` and the layout signature, the `replaceState` seed, `applyMode`/`selectMode` split, the guarded `popstate` listener, both history calls wrapped, and the header note on the analytics coupling.
- `src/lib/__tests__/workbench-url.test.ts` — new node suite executing the URL and precedence rules, including repeated and malformed params and `modeHref` idempotence.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx` — new mounted suite: deep link, seed, unknown value, normalization rewrite, push-without-remount, Back/Forward, re-click, non-mode traversal, restore signature, mode-only boundary, and both history-degrade paths.
- `src/lib/__tests__/workbench-chrome.test.ts` — router ban narrowed to routing; persistence pin moved to the URL-first call site.
- `src/lib/__tests__/workbench-split.test.ts` — the third verbatim mount-effect pin updated to `setModeState(restoredMode)`.

**Review findings breakdown (this pass).** 7 patched (0 high, 1 medium, 6 low), 1 deferred (medium), 11 rejected. Cumulative across both passes: 18 patched, 3 deferred.

**Follow-up review recommendation:** `true`. Patched this pass: 0 high, 1 medium, 6 low → score `3 × 1 + 1 × 6 = 9`, which is ≥ 5.

**Verification performed.**
- Targeted: `npx vitest run` over `workbench-url.test.ts`, `workbench-chrome.test.ts`, `workbench-left-column.test.ts`, `workbench-split.test.ts`, `workbench-mode-url.test.tsx`, `workbench-sheet.test.tsx` — 205 passed, both router-ban restatements holding.
- Full: `npx vitest run` — 217 files, 4496 tests, all passing, no pre-existing suite regressed.
- `npx tsc --noEmit -p tsconfig.json` — clean.
- `npx next lint` — no warnings or errors.
- Mutation-verified both new degrade cases: removing the mount `try` fails the mount case; removing the `selectMode` catch fails the click case. (`pnpm` itself is unusable in this checkout — `ERROR packages field missing or empty` — so every command was run through `npx`, same binaries.)

**Residual risks.**
- Every Next-specific claim (the router's history patch, no server round trip, no segment re-render) is argued from the docs and unreachable from the suite, which mocks `next/navigation` away. Confirmed behaviour under the real App Router remains unverified by test.
- Mode switching now emits a PostHog `$pageview` per rail click plus one on the mount seed. Accepted and documented, not suppressed — if that is unwanted, `Analytics` needs to ignore a `mode`-only delta.
- The first paint of a deep link is still the server's default for one frame; URL-first is an effect, not an SSR guarantee.
- A `popstate` onto an entry carrying no `mode` at all falls back to storage rather than to the mode on screen. Not reachable through any entry the shell writes (all are seeded), but it is why the guard's soundness argument leans on storage.

