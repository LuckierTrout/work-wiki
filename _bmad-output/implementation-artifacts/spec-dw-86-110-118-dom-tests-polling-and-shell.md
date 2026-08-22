---
title: 'DOM tests: polling failure modes, app shell, owner-scoped anchors (DW-86, DW-110, DW-118)'
type: 'chore'
created: '2026-08-19'
baseline_revision: '71d3d3ca40157e0dff9d05f71fc2ae1f498647ff'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true # this pass: patch 2 medium + 6 low -> 3x2 + 6 = 12 >= 5
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Three of the six converted client components -- RecentIngests, ActionInbox and
      BulkDocumentImport -- still have no rendered-anchor coverage, so reverting any of their
      hrefForSlug call sites to slugPath passes the whole suite.
    evidence: |-
      DW-86's verbatim reason names "the six converted use client components"; the bundle
      intent's prose named only four (ArticleView, VaultExplorer, ChatWorkspace,
      KnowledgeStudio) and this story covered those four. `src/components/RecentIngests.tsx:487,568`,
      `src/components/ActionInbox.tsx:387` and `src/components/BulkDocumentImport.tsx:532` call
      `hrefForSlug(...)` from the same conversion, and no `*.test.ts`/`*.test.tsx` under `src/`
      references any of the three. The harness they would need now exists, so this is a
      remaining gap rather than a constraint.
    location: >-
      src/components/RecentIngests.tsx:487
    severity: medium
  - summary: >-
      NavHeader conveys the active route only through inline fontWeight, with no aria-current, so
      the current page is announced to assistive tech not at all.
    evidence: |-
      `getActiveHref` (src/components/NavHeader.tsx:39) drives `fontWeight`, colour and background
      on the active link and nothing else; there is no `aria-current="page"` anywhere in the file.
      The new mounted assertions therefore have to match `link.style.fontWeight === "600"`, which
      couples the suite to styling because it is the only observable signal the component emits.
      Pre-existing; adding the attribute is a production change this coverage-only story walled off.
    location: >-
      src/components/NavHeader.tsx:39
    severity: low
  - summary: >-
      layout.tsx's metadata export and its inline theme script are still guarded only by source
      scans, even though the file now has a mounted suite.
    evidence: |-
      `src/app/layout.tsx:37-56` (title template, metadataBase, OG/Twitter) and the `themeScript`
      at :58-70 (which applies the `light`/`dark` class before paint) live only in this file.
      `app-shell.test.tsx` mounts the layout but asserts neither; the metadata half is pure data
      and needs no mount at all. Deleting the theme script leaves the whole suite green.
    location: >-
      src/app/layout.tsx:58
    severity: low
  - summary: >-
      loadSlugTenants has no exported reset, so no mounted suite can express "map still loading" or
      "/api/wiki/routes failed" -- the DEFAULT_TENANT fallback every converted component is built to
      survive is unasserted at the component level.
    evidence: |-
      The map is cached in a module-level singleton in `src/hooks/useSlugTenants.ts`, warmed once
      per file by `await loadSlugTenants()` in `beforeEach`. Once warmed it cannot be un-warmed, so
      `owner-scoped-anchors.test.tsx` can only ever assert the resolved-map branch.
      `renderer-slug-tenant-adoption.test.tsx` covers the unknown-slug fallback via a slug absent
      from the map, but the degraded-map path (session fetch failed) has no component witness.
    location: >-
      src/hooks/useSlugTenants.ts
    severity: low
  - summary: >-
      ChatWorkspace's save-failure and slug-less-response banner paths are untested; only the
      happy path and the url-absent fallback are pinned.
    evidence: |-
      `saveAnswer` (src/components/ChatWorkspace.tsx:219-238) keeps the banner hidden when the
      response carries no slug and surfaces an error alert when the request fails. The new suite
      always answers `/api/query/save` with an ok body carrying a slug, so a regression rendering
      "Saved as undefined" -- the exact state the comment at :232 says the guard exists to avoid --
      would pass.
    location: >-
      src/components/ChatWorkspace.tsx:232
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three surfaces are asserted only by proxies. (DW-110) The two polling suites mount the happy path and the visibility gate but never a rejecting fetch, a wrong-typed body, a non-2xx probe or a wedged never-settling request — the effect's handling of failure is unobserved. (DW-118) No suite imports `src/app/layout.tsx` or `NavHeader`, so dropping `<ClerkProvider>` or `<ClientProviders>` (with its wrapper) keeps `tsc`, `eslint` and the full Vitest run green; only `readFile` scans touch the shell. (DW-86) The owner-scoped link conversion has per-hook coverage but no per-component anchor assertion for `ArticleView`, `VaultExplorer`, `ChatWorkspace` or `KnowledgeStudio`, so reverting one call site to `slugPath` (or dropping a `slugTenants` prop) passes the whole suite.

**Approach:** Add mounted cases to the existing `dom` vitest project. Extend the two polling suites with the missing failure and race cases; add one suite that mounts `RootLayout` and `NavHeader` behind mocked `next/font/google`, `next/navigation` and `@clerk/nextjs`; add one suite that renders each of the four converted components and asserts the rendered `href`.

## Boundaries & Constraints

**Always:**
- Assert on the outermost surface: rendered DOM (`href`, text) and the requests actually issued — never on whether a component imports a hook.
- Every new `.test.tsx` lives under a `__tests__` directory (the `vitest.config.ts` collection guard refuses otherwise) and calls `cleanup()` as the FIRST statement of its own `afterEach`, per the DOM-project convention.
- The Clerk mock must keep `<ClerkProvider>` load-bearing: its `useUser` throws outside the mock provider, the way real Clerk does, so deleting the wrapper from the layout fails the suite.
- Anchor assertions use a map where the canonical answer (`/u/alice/target`) differs from the `DEFAULT_TENANT` fallback (`/u/yopedia/target`), so a reverted call site is a distinguishable failure.
- Drive the sidecar timeout race by advancing wall-clock time past `SIDECAR_PROBE_TIMEOUT_MS`, not by shortening the budget.

**Block If:** Mounting a target requires changing the component under test (adding a test-only prop, seam or export) rather than mocking its module boundary.

**Never:**
- Change `src/app/layout.tsx`, `NavHeader.tsx`, the four converted components, `useSidecarStatus.ts`, `DataVersionWatcher.tsx` or `workbench-data-version.ts` behaviour — this is coverage for what is already there.
- Add a shim to `src/`; browser capability shims belong in `vitest.setup.dom.ts`.
- Add a second vitest config, project or npm script — CI runs `pnpm test` and nothing else.
- Weaken the `vitest.config.ts` collection guard or its `DOM_INCLUDE`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Watcher, transport failure | mounted, visible; `fetch` rejects | no `router.refresh()`; the interval still issues the next poll | rejection swallowed |
| Watcher, wrong-typed body | 200 with `{ dataVersion: "4" }` | no refresh (served 3) | body rejected as unavailable |
| Watcher, wedged poll | `fetch` never settles | each tick issues a fresh request and aborts the stalled one; a later forward answer still refreshes | no refresh while wedged |
| Sidecar, non-2xx | probe resolves `{ ok: false }` | status renders `down` | no throw |
| Sidecar, wedged probe | `fetch` never settles | status renders `down` once the timeout budget elapses | fail-closed |
| Shell, layout mounted | `RootLayout({ children: <Probe/> })` | `<html lang="en">`; children reach the DOM through Clerk + client providers + one `<main id="main-content">` | probe throws if a provider is missing |
| Nav, signed-out | mocked signed-out state | primary links render; Sign in renders; no owner-only links | none |
| Nav, signed-in owner | mocked signed-in owner handle | workspace links plus Settings / Wiki Health render | none |
| Component anchor, slug in map | map `{ target: "alice" }` | rendered href is `/u/alice/target` | none |
| Component anchor, fresh slug | save response carries `url` | banner links via the returned `url`, not the session map | falls back to `hrefForSlug` when absent |

</intent-contract>

## Code Map

Investigation is done; every path below was read and every mount below was executed against the real files during planning.

**Polling suites (DW-110)**
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- extend. Has `answering(version, ok)`, `settle(ms)`, `mountWatcher(served)`, a hoisted stable router, `_resetDataVersionListeners()` teardown. `ok: false` is covered at "does not refresh on a non-ok answer"; rejection, wrong-typed body and the wedged loop are not.
- `src/components/workbench/DataVersionWatcher.tsx:76-99` -- `run()` aborts the PREVIOUS controller before each request, so a wedged poll is superseded every tick rather than blocking the loop; `result.status !== "ok"` returns before any comparison.
- `src/lib/workbench-data-version.ts:96-118` -- `fetchDataVersion` maps a throw and a non-integer `dataVersion` to `unavailable`; `DATA_VERSION_POLL_MS` = 10_000.
- `src/hooks/__tests__/useSidecarStatus.test.tsx` -- extend. Has a `Harness` rendering the status into `<output data-testid="sidecar-status">`, `FIFTEEN_SECONDS`, `settle(ms)`. Covers rejection; not `{ ok: false }` and not the timeout race.
- `src/hooks/useSidecarStatus.ts:26-70` / `src/lib/sidecar.ts:19,48-90` -- `probeSidecar` races the fetch against a `SIDECAR_PROBE_TIMEOUT_MS` (1500) timer that resolves `"down"`.

**App shell (DW-118)**
- `src/app/layout.tsx:71-105` -- `RootLayout` is a sync server component: call it and render the returned element. React hoists `<html>`/`<head>`/`<body>` onto the real document (verified: `document.documentElement.lang === "en"`, body class applied); it also logs one `In HTML, <html> cannot be a child of <div>` DOM-nesting message, which is expected and harmless.
- Layout imports needing mocks: `next/font/google` (three loaders; return `{ variable, className, style }`), `@clerk/nextjs` (`ClerkProvider`), `next/navigation` (`usePathname` for `SiteChrome`, `useSearchParams` for `Analytics`), and `posthog-js` (`Analytics` really loads and inits it, and its scroll-manager timer outlives the environment otherwise).
- `src/components/ClientProviders.tsx` -- `KeyboardShortcutsProvider` + `ToastProvider` + `ToastContainer`/`ShortcutsHelp`/`Analytics`. `useToast` (`src/hooks/useToast.ts:108-112`) and `useShortcutsHelp` (`src/hooks/useKeyboardShortcuts.ts:192-196`) THROW outside their provider — the probe-child lever.
- `src/components/SiteChrome.tsx` -- renders nav/footer and the single `<main id="main-content">` off `usePathname`; `/` and `/sign-in` take the bare branch.
- `src/components/NavHeader.tsx` -- `usePathname` + Clerk `Show`/`SignInButton`/`UserButton`(+`.MenuItems`/`.Link`)/`useUser`; `primaryLinks` (:19), `workspaceLinks` (:27), `getActiveHref` (:39), `isOwnerHandle(user?.username)` gates Settings and Wiki Health.
- `src/components/__tests__/single-main-landmark-mounted.test.tsx:25-33` -- the established `next/navigation` + `@clerk/nextjs` mock idiom to follow (`create-wiki-flow.test.tsx:17-18` for the hoisted-router half).
- `vitest.config.ts` -- the `dom` project needs `css: { postcss: { plugins: [] } }`. The layout imports `katex/dist/katex.min.css` and `./globals.css`; without it vite loads the repo's Tailwind v4 `postcss.config.mjs` and the suite fails to collect with `Invalid PostCSS Plugin found at: plugins[0]`. Verified fix.

**Owner-scoped anchors (DW-86)**
- `src/components/__tests__/renderer-slug-tenant-adoption.test.tsx` -- the sibling suite for the FIVE renderer call sites; reuse its shape: stub `/api/wiki/routes` to `{ target: "alice" }` and `await loadSlugTenants()` in `beforeEach` to warm the module-level session cache so the map is present on first paint.
- `src/hooks/useSlugTenants.ts` -- `loadSlugTenants()`, `hrefForSlug`, `slugTenants`; session-cached, fetched once per file.
- `src/components/ArticleView.tsx:158,425,441,466` -- async server component. `await ArticleView({...})` then render the element; partial-mock `@/lib/wiki` via `importOriginal` (`buildSlugTenantMap`, `findBacklinks`, `findSimilarPages`) — a full mock breaks `isVaultEligible`'s `isAgentScopedType` import. In-content link via `slugTenants` prop; backlinks/related via `resolveSlugPath(slug, slugTenants, pageTenant)`. Verified: in-content `/u/alice/target`, backlink to a `bob`-owned slug `/u/bob/other`.
- `src/components/VaultExplorer.tsx:551,646-647` -- props `{vault, vaults, initialEntries}` (`Vault` from `src/lib/vault.ts:37`, `VaultExplorerEntry` from `src/lib/vault-explorer.ts:30`). "Open full page" is `pagePath(ownerToTenant(entry.owner), slug)` — owner-direct, no map. The preview `MarkdownRenderer` needs `/api/vaults/<id>/pages/<slug>` → `{ page: { slug, title, body, rawHref } }`. Both verified `/u/alice/target`.
- `src/components/ChatWorkspace.tsx:267,350,354` -- no props; mount fetches `/api/chat/conversations`, `/api/vaults`, `/api/agents?mine=1`, `/api/chat/hermes`. Clicking a thread fetches `/api/chat/conversations/<id>`. Assistant message → `MarkdownRenderer slugTenants`; `message.sources` → `hrefForSlug` chips; "Save to wiki" POSTs `/api/query/save` and the banner links `savedMessage.url ?? hrefForSlug(slug)`. Verified.
- `src/components/KnowledgeStudio.tsx:377,400,604,781` -- no props; `refresh()` awaits eight endpoints (`/api/vaults`, `/api/agents?mine=1`, `/api/ingest/jobs?limit=16`, `/api/review/proposals?status=pending`, `/api/knowledge/insights?scope=mine`, `/api/research`, `/api/agent-skills`, `/api/knowledge/compilation`). A contribution row opens the evidence drawer whose link (`:294`, label "Open compiled page") is `hrefForSlug(pageSlug)`; the "Research desk" section renders `project.synthesis` through `MarkdownRenderer slugTenants`. Verified.
- `vitest.setup.dom.ts` -- `setVisibilityState` / `fireVisibilityChange` exports; registers the backstop `cleanup()`.

## Tasks & Acceptance

**Execution:**
- `vitest.config.ts` -- add `css: { postcss: { plugins: [] } }` to the `dom` project only, with a comment naming the Tailwind-v4 PostCSS load failure it avoids -- the shell suite cannot collect otherwise. Leave the collection guard and both `include`s untouched.
- `src/components/workbench/__tests__/data-version-watcher.test.tsx` -- add the three DW-110 cases: `fetch` rejects (no refresh, next tick still polls); 200 with `{ dataVersion: "4" }` against served 3 (no refresh); a never-settling `fetch` (each tick issues a new request and aborts the previous signal, and a forward answer after the wedge still refreshes exactly once).
- `src/hooks/__tests__/useSidecarStatus.test.tsx` -- add the two DW-110 cases: a resolved `{ ok: false }` renders `down`; a never-settling `fetch` still renders `down` once time advances past the probe's timeout budget, and stays `unknown` before it.
- `src/app/__tests__/app-shell.test.tsx` -- NEW. Mount `RootLayout` with a probe child that calls `useToast()`, `useShortcutsHelp()` and Clerk's `useUser()`; assert `document.documentElement.lang === "en"`, that the probe's text is in the DOM, and exactly one `main#main-content`. Mock `@clerk/nextjs` with a real context whose `useUser` throws outside `ClerkProvider`. Mount `NavHeader` separately for signed-out, signed-in non-owner and signed-in owner, asserting the link sets and the active-link marking.
- `src/components/__tests__/owner-scoped-anchors.test.tsx` -- NEW. One `describe` per converted component, each asserting rendered `href`s against a `{ target: "alice" }` map: `ArticleView` (in-content + backlink to a differently-owned slug), `VaultExplorer` ("Open full page" + preview in-content), `ChatWorkspace` (source chip + assistant in-content + saved banner via the response `url`, and the `hrefForSlug` fallback when the response carries none), `KnowledgeStudio` (evidence-drawer link + research synthesis in-content).

**Acceptance Criteria:**
- Given the full suite passes, when `<ClerkProvider>` or `<ClientProviders>` is deleted from `src/app/layout.tsx` (keeping the tree otherwise valid), then `pnpm test` fails.
- Given the full suite passes, when any one of the four components' converted call sites is reverted to `slugPath(...)` or has its `slugTenants` prop dropped, then `pnpm test` fails naming that component.
- Given the full suite passes, when a poll answers with a rejection, a non-2xx, or a 200 whose `dataVersion` is not an integer, then no `router.refresh()` is issued and the loop still polls on the next tick. (Amended in review: the original wording asked for a failure when `DataVersionWatcher`'s `result.status !== "ok"` guard is deleted. That is unachievable by any black-box test -- `fetchDataVersion` never carries a `version` on a non-`ok` result, so with the guard gone `shouldRefreshForDataVersion` compares `undefined > n`, which is `false`. The guard is runtime-redundant defence-in-depth; this is its observable half.)
- Given the full suite passes, when `probeSidecar`'s `response.ok ? "up" : "down"` is weakened to `"up"`, or its timeout race is removed, then `pnpm test` fails.
- Given `pnpm test` on an unmodified tree, then both projects (`node`, `dom`) run and every suite passes with no unhandled error.

## Spec Change Log

## Review Triage Log

### 2026-08-19 -- Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 5: (high 0, medium 1, low 4)
- reject: 17: (high 0, medium 0, low 17)
- addressed_findings:
  - `[medium]` `[patch]` ArticleView's THIRD owner-scoped call site (the "related pages" list, `ArticleView.tsx:464`) was mocked out of the render by `findSimilarPages: async () => []`, so reverting it to `/u/yopedia/<slug>` left the entire suite green -- defeating this spec's own component-revert acceptance criterion. The stub now returns a related row owned by a FOURTH handle (`sibling -> dana`), so the correct answer, the page-tenant fallback and the DEFAULT_TENANT revert are three distinct hrefs; mutation-checked in both wrong directions.
  - `[medium]` `[patch]` Every `mountLayout()` ran signed-out, so `EnsureYoyo` never fired and deleting either `<EnsureYoyo />` or `<RegisterSW />` from the layout kept the suite green -- the same hand-re-nesting failure mode DW-118 exists to close. Added a signed-in layout mount asserting the `POST /api/agents/ensure`, its signed-out negative, and a `/sw.js` registration case (with `navigator.serviceWorker` stubbed in the suite, not in `src/`).
  - `[low]` `[patch]` NavHeader's hamburger panel -- a second copy of the primary links and a SECOND independent `isOwner &&` gate on Settings and Wiki Health -- had no coverage. Added panel cases for signed-out, signed-in member and owner, plus the `username === null` signed-in case.
  - `[low]` `[patch]` The wedged-sidecar case stopped at the timeout budget and never showed the poll loop survived it; it now advances another cadence tick and requires a recovered probe to move the status back to `up`.
  - `[low]` `[patch]` Two comments overstated what their tests prove: the wedged-poll comment claimed the abort stops requests piling up (the stub ignores its signal, so the assertion is on which signals are aborted), and `useSidecarStatus`'s header read as self-contradicting once the new case imported `SIDECAR_PROBE_TIMEOUT_MS`. Both reworded, the latter stating why an exported contract constant and a module-private cadence get opposite treatment.
  - `[low]` `[patch]` Dropped the unfalsifiable `expect(document.activeElement).not.toBe(document.body)` left behind in `useDialogA11y.test.tsx` after the flake fix promoted the identity assertion into a `waitFor`.
  - `[low]` `[patch]` The shell suite's `afterEach` document-attribute restore was verified by experiment rather than argument and found genuinely dead -- after `cleanup()` React takes back the `lang`, both classNames and the injected `<head>` script -- so it was deleted and the comment now records the measurement.
  - `[low]` `[patch]` Amended the acceptance criterion that asked for a failure when `DataVersionWatcher`'s `result.status !== "ok"` guard is deleted. Mutation-testing showed it unachievable by any black-box test (the guard is runtime-redundant: a non-`ok` result carries no `version`, so the comparison is `undefined > n`). The AC now states the observable contract instead; no code changed.

## Design Notes

The Clerk mock is the load-bearing piece of DW-118 and the one thing a passthrough stub would silently void:

```tsx
const ClerkCtx = React.createContext(false);
vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children }) => <ClerkCtx.Provider value>{children}</ClerkCtx.Provider>,
  useUser: () => {
    if (!React.useContext(ClerkCtx)) throw new Error("useUser outside ClerkProvider");
    return authState;                     // moved per test: signed-out / owner / non-owner
  },
  Show: ({ when, children }) => (when === signedLabel(authState) ? <>{children}</> : null),
  // SignInButton / UserButton (+ .MenuItems, .Link) render their children through.
}));
```

`EnsureYoyo` and `NavHeader` both call `useUser`, so the throw is what makes a deleted `<ClerkProvider>` red. The `ClientProviders` half is covered by the probe child: `useToast`/`useShortcutsHelp` already throw outside their providers, and the child reaches them only through the layout's own nesting.

## Verification

**Commands:**
- `npx vitest run --project dom` -- expected: all mounted suites pass, including the five new/extended files.
- `pnpm test` -- expected: both projects green, no unhandled errors, no suite reported as empty.
- `npx tsc --noEmit` -- expected: clean (the `@ts-expect-error` idiom in the sibling suite shows type-level assertions are part of this project's contract).
- `npx eslint` -- expected: clean.

## Auto Run Result

Status: done

**What was implemented.** Coverage only — no production source changed. Three surfaces that were asserted only by proxies now have mounted, executable tests in the existing `dom` vitest project: the two polling suites gained their missing failure and race cases; the app shell (`RootLayout` + `NavHeader`) is mounted for the first time; and each of the four converted components' rendered anchors is pinned against a slug→tenant map built so every wrong answer is a distinguishable failure.

**Files changed**
- [`../../vitest.config.ts`](../../vitest.config.ts) — `css: { postcss: { plugins: [] } }` on the `dom` project only. Without it the shell suite cannot collect: the layout imports `globals.css` and `katex.min.css`, vite loads the repo's Tailwind-v4 `postcss.config.mjs`, and the run dies with `Invalid PostCSS Plugin found at: plugins[0]`. The collection guard and both `include`s are untouched.
- [`../../src/components/workbench/__tests__/data-version-watcher.test.tsx`](../../src/components/workbench/__tests__/data-version-watcher.test.tsx) — +3 cases (DW-110): a transport rejection is swallowed and the loop recovers on a later tick; a 200 carrying `{ dataVersion: "4" }` refreshes nothing; a never-settling poll is superseded every tick and the answer that finally lands still refreshes exactly once.
- [`../../src/hooks/__tests__/useSidecarStatus.test.tsx`](../../src/hooks/__tests__/useSidecarStatus.test.tsx) — +2 cases (DW-110): a resolved non-2xx renders `down`; a wedged probe stays `unknown` up to `SIDECAR_PROBE_TIMEOUT_MS - 1`, renders `down` one millisecond later, and the probe loop still polls and recovers afterwards.
- [`../../src/app/__tests__/app-shell.test.tsx`](../../src/app/__tests__/app-shell.test.tsx) — NEW (DW-118). Mounts `RootLayout` with a probe child calling `useToast()`, `useShortcutsHelp()` and Clerk's `useUser()`; asserts `<html lang="en">`, the font variables, the probe's text, one `main#main-content` on both chrome branches, nav + footer, the signed-in `POST /api/agents/ensure`, and `/sw.js` registration. Mounts `NavHeader` for signed-out / signed-in member / owner / null-handle, desktop menu and hamburger panel, plus active-link marking.
- [`../../src/components/__tests__/owner-scoped-anchors.test.tsx`](../../src/components/__tests__/owner-scoped-anchors.test.tsx) — NEW (DW-86). One `describe` per converted component, every assertion on a rendered `href`: `ArticleView` (in-content, backlink, related pages), `VaultExplorer` ("Open full page" owner-direct link, preview in-content), `ChatWorkspace` (source chips, assistant in-content, saved banner via the response `url` and its map fallback), `KnowledgeStudio` (evidence drawer, research synthesis).
- [`../../src/hooks/__tests__/useDialogA11y.test.tsx`](../../src/hooks/__tests__/useDialogA11y.test.tsx) — unplanned but caused by this change: adding two suites pushed the `dom` project's parallel load past a tipping point and exposed a latent race in the post-close focus assertion (the close is driven by a settled `fetch`, so the removal commit and the focus-restoring effect cleanup land in separate turns). The focus assertion moved into its own `waitFor`; confirmed it still fails when `fallbackRef.current?.current?.focus()` is deleted.

**Review findings.** 8 patched (2 medium, 6 low), 5 deferred (1 medium, 4 low), 17 rejected. See the Review Triage Log for each patch and the frontmatter `deferred` list for the rest. Follow-up review recommended: **true** — 3 × 2 medium + 6 low = 12, at or above the threshold of 5.

**Verification**
- `npx vitest run` — 241 files / 4969 tests passed, no unhandled errors. The only new stderr is the expected `In HTML, <html> cannot be a child of <div>` nesting message from mounting the layout into a container div.
- `npx vitest run --project dom` — 307 passed, stable across repeated runs; the parallel-load flake is fixed.
- `npx tsc --noEmit` — exit 0. `npx eslint` — exit 0.
- Mutation-checked, each restored afterwards: deleting `<ClerkProvider>` → 6 failures; deleting `<ClientProviders>` → 6 failures; deleting `<EnsureYoyo />` or `<RegisterSW />` → 1 failure each; `lang="en"` → `"de"` → 1 failure; all ten converted call sites reverted one at a time (ArticleView ×3, VaultExplorer ×2, ChatWorkspace ×3, KnowledgeStudio ×2) → each fails naming that component; `probeSidecar`'s `ok` check weakened, and its `Promise.race` removed → both fail; a probe loop that stops after a `down` answer → fails; the mobile owner gate forced always-on → fails; `servedVersion`'s type check weakened → fails.

**Residual risks**
- The mounted shell pins the *nesting relation*, not Clerk itself: `ClerkProvider` is a stub context whose `useUser` throws outside it, so swapping in a different auth provider of the same shape would pass. That is the limit of any mocked-boundary shell test.
- The `dom` project now deliberately does not load the repo's real PostCSS config, so no Tailwind-derived computed style is meaningful there. Assertions in that project must stay on `className` and inline style, never on `getComputedStyle` output.
- One acceptance criterion was amended in review after mutation-testing proved it unachievable (the `result.status !== "ok"` guard is runtime-redundant); its observable half is pinned. Recorded in the triage log rather than silently dropped.
- `useSidecarStatus`'s cadence is pinned only one tick deep — swapping its `setInterval` for a `setTimeout` still passes, in the new case and in the pre-existing one. Not in this story's scope; noted so it is not mistaken for covered.
