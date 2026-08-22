---
title: 'Story 1.3: Nashsu icon rail and Workbench chrome'
type: 'feature'
created: '2026-08-15'
status: 'done'
baseline_revision: '0e497042144d903285fd61a3c17213080dd21593'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The whole interactive shell is verified only by reading its own source
      text; nothing renders, mounts, or measures it.
    evidence: |-
      `vitest.config.ts` is `environment: "node"` with
      `include: ["src/**/__tests__/**/*.test.ts"]`, and this story was given
      "Do not add jsdom, `@testing-library/*`, or `.test.tsx` support" as a
      Never. So `workbench-chrome.test.ts` is `readFile` + `toContain`
      throughout: sheet open/close, the Esc handler, focus move-in and restore,
      the `matchMedia` widening dismissal, the collapse toggle, badge rendering
      at 0 vs > 0, and every CSS breakpoint are asserted as strings present in
      the file that implements them. `src/hooks/useSidecarStatus.ts` — the poll
      schedule, the visibility gating, the abort-on-unmount guard — has no test
      at all; deleting `startPolling()` from its `visible` branch would leave
      the suite green and the status dot frozen. Establishing a DOM test
      environment is a repo-wide change that predates this story (it is also
      entry 2 of Story 1.2's ledger); this story is simply the first to put a
      substantial amount of behaviour behind that gap.
    location: >-
      vitest.config.ts
    severity: medium
  - summary: >-
      Nothing states the cross-origin contract an HTTPS page must satisfy to
      reach `http://127.0.0.1:19828`, so the probe can fail closed forever for
      reasons the copy cannot explain.
    evidence: |-
      `src/lib/sidecar.ts` documents the fail-closed answer but not the CORS
      headers the sidecar must return for the deployed origin, Chrome's Private
      Network Access preflight for a public-to-local request, or Safari's
      mixed-content handling of a loopback URL. Under any of those the probe
      answers `down` permanently and Chat shows "Start the local sidecar on
      127.0.0.1:19828 to use Chat." to an owner whose sidecar is already
      running. Epic 1 needs only the up/down signal, and Epic 3 owns the
      sidecar itself — the response contract belongs with whichever story first
      ships a real one.
    location: >-
      src/lib/sidecar.ts
    severity: medium
  - summary: >-
      Switching away from Wiki unmounts `WikiWorkbench`, discarding an open
      Create Wiki dialog, a typed wiki name, and any error already shown.
    evidence: |-
      `ModeCanvas` returns a different subtree per mode, so the Wiki branch is
      removed rather than hidden. The shell-level guarantee the story states —
      one mounted shell, no route change, so state above the mode panel
      survives — does hold, and Story 3.2's composer draft can live there. What
      does not survive is state held *inside* a mode panel. Story 1.3's ACs ask
      only that a mode switch not destroy typed Chat input, and Epic 1 ships no
      composer, so nothing here is unmet; but the first mode panel that holds
      real unsaved input will need the canvas to hide rather than unmount.
    location: >-
      src/components/workbench/ModeCanvas.tsx
    severity: medium
  - summary: >-
      The active mode has no URL representation, so a mode cannot be linked or
      bookmarked and Back leaves the app entirely.
    evidence: |-
      Mode lives in React state plus `yopedia_workbench_mode`. The intent's
      constraint is that a mode switch must not unmount the shell
      (`epics.md:367`), which a shallow query-param sync would also satisfy —
      so this is a design choice the story did not have to make, not a
      requirement it met. It is cheap now and a breaking change to the
      persisted-state contract later, so it is worth an explicit decision
      before Stories 1.4-1.6 build selection state on top of it.
    location: >-
      src/components/workbench/Workbench.tsx
    severity: low
  - summary: >-
      `HomeDashboard` is no longer mounted by any route, and the test that
      pinned it as the landing page's `<h1>` owner now guards a component that
      does not ship.
    evidence: |-
      `src/app/page.tsx` no longer renders `<HomeDashboard>`, but
      `src/components/HomeDashboard.tsx` and `src/lib/home-dashboard.ts` stay on
      disk because `create-wiki-ui.test.ts:199-204` reads the component file and
      asserts it contains an `<h1>`, and `home-dashboard.test.ts` exercises
      `buildHomeDashboardSnapshot`. Deleting either file would modify a
      pre-existing test, which this story was forbidden to do. So three test
      files now report green on a surface nothing renders. Retiring the
      dashboard properly — deleting the modules and retargeting that assertion
      at the shell's `<h1>` — belongs with whatever cleans up the remaining
      pre-Workbench surfaces.
    location: >-
      src/components/HomeDashboard.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** There is no Workbench shell. The signed-in owner lands on `/` where a sticky `NavHeader` (two flat link rows: Ask/Chat/Ingest/Save/To-do plus Studio/Vault/Agents/Review/Monitors/Knowledge/Integrations/System), a `Footer`, Story 1.2's `WikiWorkbench` card and a `HomeDashboard` metrics block coexist inside a 1180px centered `.shell`. Every mode is a separate page with its own chrome, there is no icon rail, no single active-mode container, no sidecar signal, and none of the DESIGN.md tokens or the 13px system-sans density exist in code (`globals.css` still carries the public-commons `--paper`/`--ink`/`--accent` navy palette). Stories 1.4, 1.5 and 1.6 have no container to build inside.

**Approach:** Add a full-bleed, full-height Workbench shell at `/`: a 48px icon rail that switches ten modes in-place (no navigation), a collapsible left column whose header carries the product title `work-wiki`, and a canvas that hosts the active mode. Wiki mode's canvas hosts Story 1.2's `WikiWorkbench` unchanged; the other nine modes render one muted sentence each, with Chat gated on a browser-side loopback probe of the sidecar so it fails closed. Chrome tokens, type and density come from DESIGN.md as a `--wb-*` layer scoped to the shell, so the rest of the app is not restyled.

## Boundaries & Constraints

**Always:**
- Rail is exactly 48px wide with exactly these ten modes, in this order, top → bottom: Wiki · Chat · Sources · Search · Graph · Lint · Todos · Review · Deep Research · Skills. Below a flexible spacer: sidecar status dot · Settings · collapse chevron (UX-DR3, `epics.md:356-357`).
- Active icon is a filled rounded square wash (`#E5E5E5`) behind a `#171717` glyph — never a hue change (UX-DR3, `DESIGN.md:245,255`).
- Chrome tokens are DESIGN.md's, light theme only, hard-coded literals so the app's `.dark` class cannot reach them: surface `#FFFFFF`, surface-subtle/rail `#FAFAFA`, foreground `#171717`, muted `#737373`, border `#E5E5E5`, primary `#171717`, primary-foreground `#FFFFFF`, live `#16A34A`, badge `#171717`/`#FFFFFF`, radii 4/6/8/9999, spacing 4/8/12/16, rail 48px, tree 280px, mins tree 200 / chat 320 / preview 200 (UX-DR1, `DESIGN.md:7-92`).
- Chrome type is system sans only: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` at 13px/1.45 (600 weight for strong, 18px/1.3 for surface titles). Georgia/serif must not appear anywhere in the shell — it belongs to Story 1.5's Preview body (UX-DR2, `DESIGN.md:225-233`).
- Every rail control is a real `<button>`/`<a>` with both `title` and `aria-label`; the active mode carries `aria-current="page"`; the rail is `<nav aria-label="Modes">` (mockups `chat-cited.html:138-151`, `todos.html:160-180`).
- Count badges appear on Todos and Review only, are hidden at 0, and their accessible name carries count + noun (`"3 todo candidates"`, `"62 pending reviews"`) (UX-DR21, `EXPERIENCE.md:112`).
- Mode change announces the surface name through a polite live region (UX-DR21, `EXPERIENCE.md:172`).
- DOM order is rail → left column → canvas, so Tab order matches UX-DR20 without `tabindex` juggling.
- Mode switching is React state inside one mounted shell — never `router.push`, never a route change. Last mode and left-column collapse persist to `localStorage` under `yopedia_`-prefixed keys, read through an SSR-guarded, try/catch, value-validating accessor modelled on `src/lib/recent-ingests.ts:8-40` (FR-8; AD-7 keeps runtime identifiers `yopedia`).
- Every mode not yet built renders exactly one muted sentence, no illustration, no emoji, no encouragement (UX-DR15, UX-DR23, `EXPERIENCE.md:107`). Where EXPERIENCE.md supplies the string, use it character-exact.
- The sidecar probe is browser-side to `http://127.0.0.1:19828/health` — never a server route, because the Worker cannot reach localhost (`epic-1-context.md:36`). Any failure, timeout, or non-2xx is `down`. Chat fails closed with a message; it never degrades into a client-side stub.
- Responsive behaviour is CSS/width-driven only. `single-ia.test.ts:41-69` forbids a second navigation component, the identifier `mobile-navigation`, and any `navigator.userAgent` / `isMobileDevice` branch anywhere in `src/app` or `src/components` — including inside comments.
- `src/components/WikiWorkbench.tsx` keeps its filename and every literal `create-wiki-ui.test.ts:118-209` reads out of it: `No wiki yet.`, `Select a file to preview.`, `Your wikis couldn’t be loaded.`, `WIKI_ARTIFACT_FILES`, `Change template`, exactly one `btn primary`, no `<h1`, `tabIndex={-1}`, two `fallbackFocusRef={headingRef}`, three `router.refresh()`. `src/app/page.tsx` keeps the literals `unavailable: true` and `unavailable={wikiRegistry.unavailable}`.
- Rendered copy says `work-wiki`; `brand-copy.test.ts:123-141` forbids `WorkWiki` and any `yopedia` spelling outside its allowlist (`yopedia_…` snake_case keys are allowed).

**Block If:**
- Satisfying the rail requires deleting or renaming `src/components/WikiWorkbench.tsx`, or removing `src/app/{knowledge,query,wiki/new}/page.tsx` (pinned by `single-ia.test.ts:71-78`).

**Never:**
- Do not build the Knowledge | Files tabs, the tree contents, the Wiki switcher in the left-column header, or New Wiki in that header — Story 1.4. The left column in this story is a header plus the surface label.
- Do not build Preview rendering or dock a Preview column — Story 1.5. Do not build drag-resize splitters or tree-selection/scroll restore — Story 1.6. Do not build `dataVersion` refresh — Story 1.7. Do not build Settings panes or bring Settings inside the shell — Story 1.9; the rail's Settings control links to the existing `/settings` route.
- Do not implement Chat, Sources/Ingest, Search, Graph, Lint, Todos, Review, Deep Research or Skills behaviour; do not wire real Review/Todos badge counts (Epics 4 and 5 own them — default 0, hidden).
- Do not write the sidecar itself, a sidecar proxy route, or a `503 sidecar_required` server path — Epic 3.
- Do not restyle the rest of the app: no global font swap in `layout.tsx`, no change to the existing `--paper`/`--ink`/`--accent` tokens or `@theme inline` block, no removal of the `.dark` class machinery. Add tokens; do not rewrite them.
- Do not remove `LocaleProvider`/`LocaleSwitcher`/`src/lib/i18n.ts` — English-only cleanup is not this story (`brand-copy.test.ts:86-92`), and the locale picker lives in `NavHeader`, which `/` simply stops rendering.
- Do not add jsdom, `@testing-library/*`, or `.test.tsx` support; `vitest.config.ts` stays `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]`.
- Do not add a dark theme, a shadcn component, an illustration, an emoji, or a second overlay level.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Default mode | No stored mode | `readStoredMode()` → `"wiki"`; rail marks Wiki active | No error expected |
| Restore last mode | `localStorage.yopedia_workbench_mode = "lint"` | `readStoredMode()` → `"lint"` | No error expected |
| Corrupt stored mode | value is `"chatt"`, `""`, or `"[1,2]"` | `readStoredMode()` → `"wiki"` | Unknown value ignored |
| localStorage unavailable | accessor throws (private mode / quota) | read → default, write → silent no-op | try/catch swallows |
| Server render | `typeof window === "undefined"` | read → default, write → no-op | No error expected |
| Collapse persists | `yopedia_workbench_left_collapsed = "1"` | `readStoredCollapsed()` → `true`; any other value → `false` | No error expected |
| Sidecar up | probe fetch resolves `ok: true` | `probeSidecar()` → `"up"` | No error expected |
| Sidecar 500 | probe resolves `ok: false` | `probeSidecar()` → `"down"` | Non-2xx is down |
| Sidecar refused | probe rejects (`TypeError: fetch failed`) | `probeSidecar()` → `"down"` | Rejection swallowed |
| Sidecar hangs | probe exceeds the timeout | `probeSidecar()` → `"down"`, request aborted | AbortSignal timeout |
| Badge at zero | `todoCount = 0` | no badge element, no accessible name | No error expected |
| Badge non-zero | `reviewCount = 62` | badge renders `62`, accessible name `Review, 62 pending reviews` | No error expected |

</intent-contract>

## Code Map

**Reuse as-is (do not fork):**
- `src/lib/recent-ingests.ts:8-40` — the localStorage idiom to copy verbatim in shape: `const KEY = "yopedia_recent_ingests"`, `typeof window === "undefined"` guard, try/catch around every access, runtime narrowing of the parsed value.
- `src/components/folio/ThemeToggle.tsx:34-43` — the mount-guard pattern for state that only exists in the browser (render the server default, apply the stored value in an effect); the mode/collapse restore needs the same to avoid a hydration mismatch.
- `src/components/WikiWorkbench.tsx` — Story 1.2's Wiki surface, mounted whole as the Wiki mode canvas. Props `{ initialWikis, initialCurrentId, unavailable? }` (`:25-36`); root is `<section className="shell py-8" aria-labelledby="wiki-workbench-heading">` (`:152`) with an `<h2 tabIndex={-1}>Wiki</h2>` (`:154-161`) that is both dialogs' `fallbackFocusRef`. Only its root className changes.
- `src/lib/links.ts` — `pagePath`/`rawPath`/`slugPath`. Any link this story emits (only `/settings`) must not be hand-written under `/wiki/` (`links.test.ts:189-193`).
- `src/lib/brand.ts:1-8` — `APP_NAME === "work-wiki"`; the display-vs-runtime rule.

**Extend:**
- `src/components/SiteChrome.tsx:24-33` — `const bare = Boolean(pathname?.startsWith("/sign-in"))`. Add `/` (exact match) so the Workbench renders full-bleed with no `NavHeader`/`Footer`; the bare branch already keeps `<main id="main-content" className="flex-1">`. Its doc comment `:12-13` ("no device-specific alternate navigation") stays true — this is a per-route chrome opt-out, not a second IA.
- `src/app/page.tsx:15-60` — server component. Keep the `getPrincipal()`/`redirect("/sign-in")` gate (`:16-17`) and the wiki-registry read with its `unavailable` flag (`:34-44`). Drop the `listReadableWikiPages` / `listActionItems` / `listChatConversations` / `buildHomeDashboardSnapshot` loads and the `<HomeDashboard>` mount (`:54-56`) — a metrics block below a full-height shell contradicts "one shell" and `DESIGN.md:199` ("no metric dashboard as home"). `HomeDashboard.tsx` and `src/lib/home-dashboard.ts` stay on disk (still read by `create-wiki-ui.test.ts:201` and `home-dashboard.test.ts`).
- `src/app/globals.css` — add a `--wb-*` token block plus `.wb-*` chrome rules at the end of the file. Do NOT touch `:204-291` (`:root`), `:293-321` (`.dark`), or `:324-357` (`@theme inline`). Existing primitives worth honouring: global focus ring `:421-425` (`outline: 2px solid var(--accent); outline-offset: 3px`) — the rail must not clip it, so give rail items room or set a shell-local `outline-offset: 1px`; reduced-motion blanket `:615-622` already neutralises any collapse transition; `.shell` `:625-629` is a 1180px centered container and is the wrong primitive for the shell.

**Precedent to copy (read-only):**
- `_bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/mockups/todos.html:77-94,160-180` — the complete rail: 48px container, `padding: 8px 0`, `gap: 4px`, 32×32 items at `border-radius: 6px`, `.icon.active { background: #E5E5E5 }`, 16×16 SVG at `stroke-width: 1.6`, badge `min-width:14px; height:14px; font-size:9px` pill, 8px status dot, spacer, Settings, chevron `M15 6 9 12l6 6`. `chat-cited.html:44-60` is the same rail without the chevron.
- `src/components/folio/icons.tsx:9-70` — the existing inline-SVG icon style (`Icon.search/doc/folder/check/chat/spark/plus/link/arrow`). Seven or so new glyphs are needed; match this authoring style, do not add an icon dependency.
- `src/hooks/useDialogA11y.ts:42-48` (`focusables`), `:87-128` (capture-phase Esc with `stopPropagation`) — the modal primitive. The rail sheet is navigation, not a modal: it must NOT use this hook (it locks `document.body.style.overflow`), and its own Esc listener must be bubble-phase so an open `ConfirmDialog` still wins Esc first.
- `src/lib/__tests__/single-ia.test.ts:19-38` — the `walk()` + read-as-text + `expect(offenders).toEqual([])` source-scan recipe. `src/lib/__tests__/create-wiki-ui.test.ts:1-10,143-146` — the same recipe applied to UI copy, including `source.replace(/\s+/g, " ")` before matching a wrapped sentence.

**Read-only constraints (do not regress):**
- `src/lib/__tests__/single-ia.test.ts:41-78` — no `MobileNavigationDock`/`mobile-navigation-dock` identifier in `src/app`/`src/components`, no `mobile-navigation` string in `globals.css`, no `/navigator\.userAgent|user-agent["']\s*\)|isMobileDevice/i` match anywhere in those trees, and `src/app/{knowledge,query,wiki/new}/page.tsx` must remain readable.
- `src/lib/__tests__/create-wiki-ui.test.ts:118-209` — the `WikiWorkbench.tsx` / `page.tsx` literals listed under **Always**.
- `src/lib/__tests__/brand-copy.test.ts:66-83,123-141` — `APP_NAME`/`APP_TITLE`, the `layout.tsx` metadata template, no `WorkWiki`, and the `yopedia` allowlist.
- `src/lib/__tests__/retired-surfaces.test.ts:43-131` — `RETIRED_SURFACES` must stay exactly the set of route files importing `@/lib/retired`. This story adds and retires nothing, so do not touch `src/lib/retired.ts`.
- `src/components/LocaleProvider.tsx:135-146` — a body-wide `MutationObserver` rewrites text nodes and `aria-label`/`title` when locale ≠ `en`. Mark the rail and the live-region announcer `data-no-localize` (the opt-out at `:43-45`) so chrome labels are not rewritten mid-interaction.
- `src/app/layout.tsx:88` — `<body className="min-h-screen antialiased flex flex-col">` with `<main className="flex-1">`; the shell must claim height inside that flex column rather than assuming it owns `<body>`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-modes.ts` -- new pure, client-safe module: `WorkbenchModeId` union and `WORKBENCH_MODES` — an ordered readonly array of `{ id, label, emptyState }` in exactly the AC order — plus `DEFAULT_WORKBENCH_MODE = "wiki"`, `BADGE_MODE_NOUNS = { todos: "todo candidates", review: "pending reviews" }`, `CHAT_SIDECAR_DOWN_COPY`, `CHAT_SIDECAR_UP_COPY`, `GRAPH_NARROW_COPY`, `isWorkbenchModeId()`, and `badgeAccessibleName(label, count, noun)` returning `` `${label}, ${count} ${noun}` `` -- one source for rail order, labels, empty copy and accessible names, importable by both the rail and a node-environment test. Copy strings are fixed by **Design Notes → Mode copy**; do not paraphrase.
- `src/lib/workbench-state.ts` -- new: `WORKBENCH_MODE_KEY = "yopedia_workbench_mode"`, `WORKBENCH_COLLAPSED_KEY = "yopedia_workbench_left_collapsed"`, `readStoredMode()`, `writeStoredMode()`, `readStoredCollapsed()`, `writeStoredCollapsed()` -- SSR-guarded, try/catch, validated through `isWorkbenchModeId`; FR-8 durability without a server round-trip (`epic-1-context.md:27` permits browser-local layout state).
- `src/lib/sidecar.ts` -- new pure module: `SIDECAR_ORIGIN = "http://127.0.0.1:19828"`, `SIDECAR_HEALTH_URL`, `SIDECAR_PROBE_TIMEOUT_MS`, `type SidecarStatus = "unknown" | "up" | "down"`, and `probeSidecar(fetchImpl = fetch)` resolving `"up"` only on a 2xx and `"down"` on any rejection, non-2xx, or timeout -- the loopback contract (AD-6/AD-22) in one testable place, with the fetch injected so the test needs no network.
- `src/hooks/useSidecarStatus.ts` -- new client hook: `"unknown"` until the first probe settles, probe on mount, re-probe on `visibilitychange` → visible, and on an interval while the document is visible; abort in-flight probes on unmount -- Epic 1 needs only up/down (`epic-1-context.md:64`), and a hidden tab must not keep hammering a refused port.
- `src/components/workbench/RailIcons.tsx` -- new: one 16×16 inline SVG per rail control (ten modes + Settings gear + collapse chevron `M15 6 9 12l6 6`), `stroke="currentColor" fill="none" stroke-width="1.6"` with round caps/joins, exported as a `RAIL_ICONS` record keyed by mode id plus named exports for the two bottom glyphs -- matches the mockups' geometry and `folio/icons.tsx`'s authoring style without a new dependency.
- `src/components/workbench/IconRail.tsx` -- new client component: `<nav className="wb-rail" aria-label="Modes" data-no-localize>` containing the ten mode buttons in `WORKBENCH_MODES` order (each `title`+`aria-label`, `aria-current="page"` when active, `.wb-rail-item--active` for the wash, badge span for Todos/Review when count > 0 with `badgeAccessibleName` folded into the button's `aria-label`), a flex spacer, the sidecar dot (`role="status"`, `aria-label`/`title` = `Sidecar running` when up else `Sidecar not running`, `.wb-status--live` only when up), a Settings `<a href="/settings">`, and the collapse chevron button (`aria-expanded`, label `Collapse left column` / `Expand left column`) -- UX-DR3 and UX-DR21 in one component.
- `src/components/workbench/ModeCanvas.tsx` -- new client component: renders the active mode's canvas. Wiki → `children` (the server-rendered `WikiWorkbench`); Chat → `CHAT_SIDECAR_DOWN_COPY` unless status is `"up"`, in which case `CHAT_SIDECAR_UP_COPY`; Graph → the mode's `emptyState` and `GRAPH_NARROW_COPY` both rendered, with CSS showing exactly one per breakpoint; every other mode → its `emptyState` as a single muted `<p>`. Each canvas is `<section aria-labelledby>` with the surface name as its heading -- UX-DR15's one-sentence rule with no dead links, and the `<900px` Graph rule without width JS.
- `src/components/workbench/Workbench.tsx` -- new client shell: `"use client"`, props `{ children, todoCount = 0, reviewCount = 0 }`. Holds `mode`, `collapsed`, `sheetOpen`, `mounted`; restores mode/collapse from `src/lib/workbench-state` in a mount effect and writes on change; renders `<div className="wb-shell" data-collapsed data-sheet-open>` → `<IconRail>` → left column (`<h1 className="wb-title">work-wiki</h1>` plus the active surface name as a section label) → `<ModeCanvas>`; a visually-hidden `<p aria-live="polite" data-no-localize>` announcing the surface name on change; a `Modes` sheet trigger button (CSS-hidden ≥900px) plus a backdrop rendered only while `sheetOpen`; Esc (bubble phase) and backdrop click and mode selection all close the sheet; a `matchMedia("(min-width: 900px)")` listener closes it on widening; focus moves to the first rail item on open and back to the trigger on close -- the container Stories 1.4–1.7 build inside. Mode selection is `setMode` only: no `router.push`, no `<Link>`, so nothing above the mode panel unmounts.
- `src/components/SiteChrome.tsx` -- treat `/` as bare alongside `/sign-in` -- the shell owns the full viewport; `NavHeader`'s link rows and `Footer` are the "separate apps" the rail replaces. Update the doc comment to name both routes.
- `src/app/page.tsx` -- render `<Workbench><WikiWorkbench initialWikis={…} initialCurrentId={…} unavailable={wikiRegistry.unavailable} /></Workbench>`; delete the three dashboard data loads, the `buildHomeDashboardSnapshot`/`HomeDashboard` imports and mount, and any import left unused -- the owner lands in the Workbench, and the registry read keeps its `unavailable` discrimination.
- `src/components/WikiWorkbench.tsx` -- change only the root className from `shell py-8` to `wb-canvas-pad` -- a 1180px centered container inside the canvas would fight the shell grid; every literal the tests read is untouched.
- `src/app/globals.css` -- append a `.wb-shell` block defining the `--wb-*` DESIGN.md tokens as literals (so `.dark` cannot reach them) and the `.wb-*` chrome rules: shell grid `48px minmax(200px, 280px) minmax(0, 1fr)` at `height: 100dvh` with `min-height: 0` scroll containers; rail geometry per the mockups; `.wb-rail-item--active { background: var(--wb-active-wash) }`; `[data-collapsed="true"]` hides the left column; `@media (max-width: 1199px)` clamps the left column to `var(--wb-split-min-tree)`; `@media (max-width: 899px)` makes the rail a fixed off-canvas sheet (`transform: translateX(-100%)`, restored when `[data-sheet-open="true"]`), collapses the shell to one column, shows the `Modes` trigger and the backdrop, and swaps the Graph canvas to `GRAPH_NARROW_COPY`; `.wb-*` type is system sans at 13px/1.45 with no `serif`/`Georgia` anywhere -- UX-DR1/2/22/24 in CSS, width-driven, no UA branching.
- `src/lib/__tests__/workbench-modes.test.ts` -- new: `WORKBENCH_MODES.map(m => m.id)` equals the ten ids in AC order and `.map(m => m.label)` equals `["Wiki","Chat","Sources","Search","Graph","Lint","Todos","Review","Deep Research","Skills"]`; every `emptyState` is a non-empty single sentence with no emoji; the five EXPERIENCE.md-sourced strings match character-exact; `badgeAccessibleName("Review", 62, "pending reviews") === "Review, 62 pending reviews"`; `isWorkbenchModeId` rejects `"chatt"`/`""`; `CHAT_SIDECAR_DOWN_COPY` names `127.0.0.1:19828` -- pins rail order, labels and copy.
- `src/lib/__tests__/workbench-state.test.ts` -- new: with a stubbed `globalThis.window.localStorage`, cover every row of the persistence half of the I/O matrix (default, restore, corrupt value, throwing accessor, no `window`, collapse round-trip) and assert both keys start with `yopedia_` -- FR-8 and AD-7.
- `src/lib/__tests__/sidecar.test.ts` -- new: cover every sidecar row of the I/O matrix with an injected fake fetch (2xx → up; non-2xx → down; rejection → down; a never-resolving fetch → down without hanging the test), and assert `SIDECAR_HEALTH_URL === "http://127.0.0.1:19828/health"` -- fail-closed is a behaviour, not a comment.
- `src/lib/__tests__/workbench-chrome.test.ts` -- new source-scan test (the `single-ia.test.ts` / `create-wiki-ui.test.ts` convention, since there is no DOM test environment): `IconRail.tsx` contains `aria-label="Modes"`, `aria-current`, renders badges only when the count is `> 0`, and gives the dot both states; `Workbench.tsx` contains `aria-live="polite"`, `<h1` with `work-wiki`, `aria-expanded`, and no `router.push`/`next/link`; `ModeCanvas.tsx` sources every sentence from `@/lib/workbench-modes` rather than inlining copy; no file under `src/components/workbench/` contains `Georgia` or `serif`; `globals.css` contains `48px`-wide `.wb-rail`, `@media (max-width: 899px)` and `@media (max-width: 1199px)` blocks, and no `mobile-navigation`; `SiteChrome.tsx` treats `/` as bare; `page.tsx` no longer mounts `HomeDashboard` -- pins the AC's structural invariants.

**Acceptance Criteria:**
- Given a signed-in owner with a Wiki at ≥1200px, when `/` renders, then the shell is rail + left column + canvas with no `NavHeader` and no `Footer`, the rail is 48px carrying the ten modes in order above a spacer and the three bottom controls, the active icon shows the filled wash, the left column header reads `work-wiki`, and the Wiki canvas is Story 1.2's surface with its `Select a file to preview.` copy intact.
- Given Chat mode with no sidecar answering on `127.0.0.1:19828`, when the canvas renders, then Chat is a rail icon rather than a permanent column, the canvas shows only the fail-closed sentence naming the sidecar and the port, the status dot is not live, and no request is made to a server route to compensate.
- Given any of Sources, Search, Graph, Lint, Todos, Review, Deep Research or Skills, when the owner selects it, then the canvas shows that mode's single muted sentence, the live region announces the surface name, and nothing navigates away from `/`.
- Given a chosen mode and a collapsed left column, when the page is reloaded, then the same mode is active and the left column is still collapsed.
- Given a viewport under 900px, when the shell lays out, then the rail is an off-canvas sheet reachable from a visible trigger and dismissible with Esc, a backdrop click, or a mode choice, and the Graph canvas states that the graph needs a wider window — all through CSS width queries, with no user-agent branch anywhere in `src/app` or `src/components`.
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and no pre-existing test was modified or weakened.

## Spec Change Log

- **Implementation, 2026-08-15 — `<h1>` renders `APP_NAME`, not the literal.** The Execution note asks `workbench-chrome.test.ts` to find `<h1` with `work-wiki` inside `Workbench.tsx`. Hard-coding the string there would give the display name a second definition, which `brand-copy.test.ts` exists to prevent. The shell renders `<h1 className="wb-title">{APP_NAME}</h1>` and the test pins that exact JSX plus `APP_NAME === "work-wiki"` — same invariant, one source.
- **Implementation, 2026-08-15 — `probeSidecar` takes an options bag and races its timeout.** Signature is `probeSidecar(fetchImpl = defaultFetch, { signal, timeoutMs })`. Two departures from the sketch: (a) the default is a wrapper, because a detached `window.fetch` throws "Illegal invocation" in browsers that check the receiver; (b) the timeout is a `Promise.race`, not an `AbortSignal` alone — a transport that ignores abort (or the spec's own "never-resolving fetch" test case) would otherwise leave the rail on `unknown` forever, which reads as "still checking" instead of the fail-closed answer. `timeoutMs` is overridable so the test does not wait out the real 1500ms budget.
- **Implementation, 2026-08-15 — below 900px the left column stacks, it does not vanish.** "Collapses the shell to one column" is implemented as a single grid column with the left panel as a header strip above the canvas, because that panel carries the page's only `<h1>`; hiding it outright would leave the narrow viewport with no top-level heading.
- **Implementation, 2026-08-15 — Design Notes prose vs. table.** The prose says five `emptyState` strings come from `EXPERIENCE.md` and four are authored; the table beneath it marks six as sourced (chat, search, lint, todos, review, research) and three as authored (sources, graph, skills). The table is the value source and was implemented as written; `workbench-modes.test.ts` pins all six sourced strings character-exact.
- **Implementation, 2026-08-15 — the Wiki canvas borrows `WikiWorkbench`'s heading.** `ModeCanvas` labels every other mode's `<section>` with a heading it renders itself; for Wiki it uses `aria-labelledby="wiki-workbench-heading"`, the `<h2 tabIndex={-1}>` Story 1.2 already owns (and both its dialogs use as `fallbackFocusRef`). A second "Wiki" heading would announce the surface twice.

## Review Triage Log

### 2026-08-15 — Review pass (follow-up 2)

- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 0
- reject: 36: (high 0, medium 5, low 31)
- addressed_findings:
  - `[medium]` `[patch]` The sheet's focus containment did not contain. The Tab loop took `rail.querySelectorAll("button, a[href]")` raw, so its wrap point was the collapse chevron — the rail's last child, and `display: none` below 900px, which is the only width where the sheet exists. Shift+Tab off the first mode called `focus()` on a hidden element (a silent no-op) and dead-ended; forward Tab off the Settings link never matched `last`, so it was not prevented and focus walked out of the rail onto the canvas the backdrop had just made unclickable — the exact outcome the previous pass added this loop to prevent. The list is filtered by `getClientRects()` now (not `offsetParent`: the rail is `position: fixed` at that breakpoint). The previous pass's own three string assertions stayed true throughout, which is why the new test pins the filter itself.
  - `[low]` `[patch]` `toggleCollapsed` wrote to `localStorage` from inside a `setCollapsed` updater — the same impurity the previous pass fixed for `setSheetClosed`, left in place one function below it. React runs updaters twice under StrictMode. The write moved out of the updater.
  - `[low]` `[patch]` The type lock had only its negative half tested. "System sans only, 13px/1.45, 600 strong, 18px/1.3 titles" is the intent's most explicit visual constraint, and while `Georgia`/`serif` were banned by scan, no test named the stack, `13px`, `1.45`, `18px` or `1.3` — every one of them could drift with the suite green. Also unlinked: the active mode's wash. `.wb-rail-item--active` painting through `--wb-active-wash` was asserted nowhere; only that the literal `#e5e5e5` appeared in the token block.
  - `[low]` `[patch]` The active mode vanished in forced-colours modes. UX-DR3 forbids a hue change, so the wash is the only indicator — and Windows High Contrast discards author backgrounds, leaving all ten rail items identical to a sighted user. `aria-current` still carried it to assistive tech. A `@media (forced-colors: active)` outline restores it, still without a hue.

Note on routing: nothing was deferred in this pass, and no ledger entry was reopened. Four of the reviewers' medium-or-worse findings are re-finds of entries 1, 2, 3 and 5 of this spec's `deferred` list — the shell being verified by source scan rather than by rendering, `useSidecarStatus` having no test at all, the missing CORS/Private Network Access contract that may keep the loopback probe answering `down` against a healthy sidecar, `ModeCanvas` unmounting the Wiki surface on a mode switch, and the orphaned `HomeDashboard` (including `create-wiki-ui.test.ts:199-204` now guarding a component nothing mounts). They were routed to reject as re-finds rather than duplicated into the ledger; the entries stand as written. Rejected on the intent's own authority: `/` reaching only `/settings` and losing the account menu (the intent's Design Notes accept this consequence explicitly and hand account controls to Story 1.9), empty-state copy that names surfaces which still exist as standalone routes (the copy is character-exact from `EXPERIENCE.md` by instruction), `aria-current="page"` (fixed by the **Always** list), Chat's `up` sentence naming a New Chat control Story 3.2 owns, Graph rendering two `<p>`s, the six declared-but-unused `--wb-*` tokens (the intent enumerates them; Stories 1.5 and 1.6 consume them), the icon-only rail below 900px, the unwired badge counts, and the light-only shell. Rejected as the previous passes' logged calls: the status dot announcing on its first probe, the sheet deliberately not being a modal, and the two derived token values. Rejected as noise: a `matchMedia.addListener` fallback, badge overflow past two digits, singular/plural in `badgeAccessibleName` (unreachable while Epics 4 and 5 own the counts), a `prefers-reduced-motion` guard on the sheet slide (the global blanket at `globals.css:614-622` already covers it), the restored-state flash before the mount effect (the mount-guard pattern is what the Code Map prescribes; the alternative is a pre-paint script), the identical grey for `unknown` and `down`, re-selecting the active mode not re-announcing, and assorted test-anchor, cross-file-string and stale-comment nits.

### 2026-08-15 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 16: (high 0, medium 3, low 13)
- defer: 0
- reject: 31: (high 0, medium 5, low 26)
- addressed_findings:
  - `[medium]` `[patch]` The skip link added by the previous pass skipped nothing. `SiteChrome`'s bare branch pointed `#main-content` at the `<main>` that *contains* the shell, and the rail is the shell's first child — so the bypass landed the user ahead of all twelve rail controls, exactly where they already were. `ModeCanvas` now exports `CANVAS_ID` and both canvas branches carry `id="wb-canvas" tabIndex={-1}`; `SiteChrome` targets it on `/` and `#main-content` everywhere else. The previous pass's own test (`skip-nav` appears twice) passed throughout, which is why the defect survived it.
  - `[medium]` `[patch]` Collapsing the left column at ≥900px took the page's only `<h1>` out of the accessibility tree. The previous pass fixed this for the narrow breakpoint and left the wide one — the same `display: none` on the same column — in place. The shell now renders a clipped restatement of the title, revealed by `[data-collapsed="true"]` and withdrawn again below 900px where the column is force-shown, so exactly one `<h1>` is ever exposed.
  - `[medium]` `[patch]` Tab escaped the open narrow sheet. The sheet's backdrop makes the canvas unclickable, but nothing stopped focus walking out of the rail onto controls behind it. The existing Esc listener now also cycles Tab within the rail. This does not make the sheet a modal: it still owns no body overflow and still takes Esc on the bubble phase, so an open `ConfirmDialog` keeps precedence.
  - `[low]` `[patch]` The shell's focus-ring rule omitted `select` — the one element type its own neighbouring comment names as living in the Wiki canvas — leaving both `<select>`s on the global 3px offset the rule exists to pull in.
  - `[low]` `[patch]` The same rule restated `border-radius: 4px`, visibly reshaping the 6px rail items and the pill-shaped count badge on focus. Only the outline is set now.
  - `[low]` `[patch]` The collapse chevron carried `aria-expanded` with nothing naming the region it expands. The left column has a stable id and the chevron points at it with `aria-controls`, matching what the sheet trigger already does.
  - `[low]` `[patch]` Below 900px the chevron was inert: the narrow block force-shows the column, so the control reported a state the layout contradicted and persisted it back to the desktop. It is hidden at that width.
  - `[low]` `[patch]` `IconRail`'s `COUNTS` map was typed `Record<string, …>`, so a mistyped mode id would compile and silently resolve to a count of 0 — indistinguishable from "this mode has no badge". Keyed by `WorkbenchModeId` now.
  - `[low]` `[patch]` `CHAT_SIDECAR_UP_COPY` retyped the `chat` entry's `emptyState` verbatim eight lines below it, in the module whose docblock says handoff copy has exactly one definition. It is derived from the entry.
  - `[low]` `[patch]` `setSheetClosed` wrote the focus-restore flag from inside a `setSheetOpen` updater. Idempotent in practice, but updaters must be pure; "was it open?" now reads from a ref.
  - `[low]` `[patch]` The serif scan banned `sans-serif` — the shell's own generic fallback — because it tested for the bare substring, and it would throw `EISDIR` on the first subdirectory Stories 1.4-1.7 add under `components/workbench`. It strips `sans-serif` first and filters to files.
  - `[low]` `[patch]` The persistence assertions were satisfied by the import line alone: inverting `setCollapsed(readStoredCollapsed())` left the suite green (demonstrated by a reviewer). They pin the call-site expressions now.
  - `[low]` `[patch]` Nothing pinned the canvas title as a sub-heading; promoting `ModeCanvas`'s `<h2>` to `<h1>` would have put two `<h1>`s on `/` with the suite still green.
  - `[low]` `[patch]` The Folio light-pin was asserted against ~28 literals retyped inside the test, so changing a `:root` value would have diverged `/` from every other route with nothing failing. A new test parses `:root`, `.dark` and `.wb-shell` out of the stylesheet and requires every token `.dark` overrides to be restated at its exact `:root` value.
  - `[low]` `[patch]` `<body>` is `min-h-screen` (100vh, the large viewport height) while the shell is `100dvh`, so wherever the browser's own UI shows, the body outgrew the shell and the page gained an outer scrollbar. `body:has(.wb-shell)` matches the shell's unit; no other route is touched.
  - `[low]` `[patch]` "Thirteen rail controls" appeared in three comments and a test. Twelve are focusable — the status dot is a `<span>`.

Note on routing: nothing was deferred in this pass. Every pre-existing issue the reviewers raised — the whole shell being verified by source scan rather than by rendering, `useSidecarStatus` having no test, the missing CORS/Private Network Access contract for the loopback probe, `ModeCanvas` unmounting the Wiki surface on a mode switch, and the orphaned `HomeDashboard` — is already entry 1, 2, 3 or 5 of this spec's `deferred` list from the previous pass. They were re-found, not newly found, so they were routed to reject rather than duplicated into the ledger; the ledger entries stand as written. Rejected on the intent's own authority: `aria-current="page"` (the **Always** list fixes that value), the Folio palette redeclaration disabling dark mode on `/` and the monospace exception to "system sans only" (both are the previous pass's deliberate, logged calls), the narrow sheet as scope expansion (the AC requires it explicitly, and `matchMedia` is a width query, not the user-agent branch the ban names), the two Graph sentences (spec-prescribed), and the badge path being unreachable (Epics 4 and 5 own the counts). Rejected as noise: a `matchMedia.addListener` fallback and badge overflow past two digits (both rejected in the previous pass too), the 899px/900px fractional-width gap, `Chat` showing the fail-closed sentence while the probe is `unknown` (failing closed is the requirement), and assorted comment and test-style nits.

### 2026-08-15 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 1, medium 3, low 7)
- defer: 5: (high 0, medium 3, low 2)
- reject: 12: (high 0, medium 1, low 11)
- addressed_findings:
  - `[high]` `[patch]` The shell painted a hard white canvas over a subtree that still resolved through the app's `.dark`-swappable Folio tokens. `.wb-shell`'s `--wb-*` layer was `.dark`-proof, but `WikiWorkbench` — the only real content the shell hosts — uses `text-foreground`, `bg-background`, `border-foreground/15`, `.btn` and `.receipt`, all of which read `--ink`/`--paper`/`--rule`, which `.dark` (set from `localStorage.theme` at `layout.tsx:63`) redefines. Any owner who had ever toggled dark mode would land on `/` with near-white text on white, with no `ThemeToggle` left on the page to undo it. `.wb-shell` now re-declares the whole Folio palette at its exact `:root` light values, plus the legacy and `--color-*` aliases and `color-scheme: light`; `:root`, `.dark` and `@theme inline` are byte-identical.
  - `[medium]` `[patch]` A persisted desktop collapse stripped the left column — and the page's only `<h1>` — at narrow widths. The unscoped `.wb-shell[data-collapsed="true"] .wb-left { display: none }` (0-3-0) outranked the `@media (max-width: 899px)` block's own `.wb-left` rule, contradicting that block's comment that the panel stacks rather than vanishes. The narrow block now re-shows it.
  - `[medium]` `[patch]` The closed sheet was hidden only by `transform: translateX(-100%)`, so all thirteen rail controls stayed focusable and in the accessibility tree below 900px. Added `visibility: hidden`, restored under `[data-sheet-open="true"]` and transitioned so it does not blank mid-slide.
  - `[medium]` `[patch]` Routing `/` into `SiteChrome`'s bare branch dropped the "Skip to main content" anchor, leaving thirteen rail controls ahead of `<main>` with no bypass — a WCAG 2.4.1 regression that did not exist while `/` carried the site nav. The bare branch now renders the skip link.
  - `[low]` `[patch]` Widening past 900px closed the sheet and returned focus to a trigger that is `display: none` at that width, dropping the keyboard user on `<body>`. The widening path no longer arms the restore, and the restore is guarded by `offsetParent`.
  - `[low]` `[patch]` The status dot collapsed three states into two, so it read "Sidecar not running" before any probe answered — indefinitely in a tab that starts hidden, since the hook does not probe while hidden. It now has a third `Checking sidecar` label, and that label moved inside the `role="status"` region as visually-hidden content, because a live region announces content mutations, not `aria-label` changes. Chat's canvas stays fail-closed for both `unknown` and `down`.
  - `[low]` `[patch]` `probeSidecar` only listened for the `abort` event, so an already-aborted signal still issued a real loopback request and spent the full timeout budget. It now short-circuits.
  - `[low]` `[patch]` The mount effect's restore of the stored mode changed the polite live region's text on every page load, announcing a mode switch the owner did not make. The region now reads a separate state that only `selectMode` sets.
  - `[low]` `[patch]` The `.wb-shell *` blanket that keeps Georgia out of the chrome was also flattening monospace: `WikiWorkbench`'s seeded file list uses `.receipt` (tabular mono), and DESIGN.md specifies mono for paths. Added `--wb-font-mono` and a `code, pre, kbd, samp, .receipt` rule inside the shell.
  - `[low]` `[patch]` The canvas heading and empty-state sentences lacked `data-no-localize` while the rail beside them had it; `src/lib/i18n.ts` carries entries for "Chat", "Review" and "Settings", so a non-`en` locale would have rewritten the canvas while the rail stayed English.
  - `[low]` `[patch]` The sheet trigger carried `aria-expanded` with nothing naming what it expands. The rail has a stable id and the trigger points at it with `aria-controls`.

Note on routing: the reviewers' calls for a URL-addressable mode, for deleting the now-unmounted `HomeDashboard`, and for DOM-level tests of the sheet and the sidecar hook were routed to `defer` — each is real, none is a defect against this contract, and the last is blocked by a "Never" this story was given rather than by anything it did. `aria-current="page"` was rejected in favour of `aria-current="true"`: the value is transcribed from the UX mockups the spec's Code Map names as the rail's source. Losing the account menu from `/` was rejected as out of scope on the intent's own authority — Story 1.3's AC enumerates the rail's bottom controls as sidecar status, Settings and the collapse chevron, and account controls are not among them. Badge overflow past two digits, the unused `--wb-split-min-chat`/`--wb-split-min-preview` tokens (Stories 1.5 and 1.6 consume them), a `matchMedia.addListener` fallback, and reduced-motion handling (already covered by the global blanket at `globals.css:615-622`) were rejected as noise.

### 2026-08-15 — Patch detail

| # | Sev | Fix |
|---|---|---|
| P1 | high | `.wb-shell` re-declares the Folio palette (`--paper`/`--ink`/`--rule`/`--accent`/… plus the `--background`/`--foreground`/`--surface`/`--border` aliases, `--accent-hover`/`--accent-foreground`/`--agent-foreground`, `--shadow*`, and the `--color-*` counterparts) at its exact `:root` light values, and sets `color-scheme: light`. The `--wb-*` tokens were already `.dark`-proof, but the shell's SUBTREE is ordinary app markup painting through Folio tokens — and `ThemeToggle` only mounts in `NavHeader`, which `/` no longer renders. `:root`, `.dark` and `@theme inline` are byte-identical (`git diff --numstat`: 433 insertions, 0 deletions). |
| P2 | med | `@media (max-width: 899px)` re-shows the left column under `[data-collapsed="true"]` (`display: flex`). The unscoped 0-3-0 collapse rule outranked the narrow block's `.wb-left`, so a desktop collapse persisted into a narrow load left the shell with no `<h1>`. |
| P3 | med | Narrow `.wb-rail` gains `visibility: hidden` (visible when `[data-sheet-open="true"]`, transitioned so it does not blank mid-slide). `transform` alone left all thirteen controls focusable. |
| P4 | med | `SiteChrome`'s bare branch now renders the `skip-nav` anchor. `/` puts thirteen rail controls ahead of `<main>`, so the WCAG 2.4.1 bypass matters more there, not less. |
| P5 | low | The widening path calls `setSheetClosed(false)` — it no longer arms the focus restore onto a `display: none` trigger. The restore is additionally guarded by `trigger?.offsetParent`. |
| P6 | low | The status dot has three labels (`Checking sidecar` / `Sidecar running` / `Sidecar not running`); `wb-status--live` stays `"up"`-only and Chat stays fail-closed for both `unknown` and `down`. The label moved into the live region as visually-hidden CONTENT, since `role="status"` does not announce attribute changes. |
| P7 | low | `probeSidecar` short-circuits `signal?.aborted` before issuing a request. |
| P8 | low | The live region reads a separate `announcement` state that only `selectMode` sets, so a restored mode is no longer announced as a switch on every load. |
| P9 | low | Added `--wb-font-mono` and a `code, pre, kbd, samp, .receipt` rule inside the shell. The `.wb-shell *` blanket that keeps the Preview serif out was also flattening `.receipt`'s tabular mono. Serif lock still holds. |
| P10 | low | `data-no-localize` on the non-Wiki canvas section. Left OFF the Wiki branch deliberately: it renders no copy of its own, and opting Story 1.2's surface out of localization is not this story's call. |
| P11 | low | The rail carries a stable `RAIL_ID`; the sheet trigger points at it with `aria-controls`. |

## Design Notes

**Mode copy (character-exact; the implementer must not paraphrase).** Five strings are quoted from `EXPERIENCE.md:123-133`; four are authored here because EXPERIENCE.md supplies none for Sources, Graph, Review or Skills, and Story 1.3's AC requires all eight. Authored copy follows UX-DR23's voice: one unsentimental sentence, state first, next step only where one exists today.

| Mode | `label` | `emptyState` | Source |
|---|---|---|---|
| `wiki` | Wiki | — canvas is `WikiWorkbench` | Story 1.2 |
| `chat` | Chat | `Start a new conversation. Click New Chat to begin.` | `EXPERIENCE.md:123` |
| `sources` | Sources | `No sources yet. Ingest a file to add one.` | authored |
| `search` | Search | `Press Enter to search.` | `EXPERIENCE.md:125` |
| `graph` | Graph | `No graph yet. Ingest sources to build one.` | authored |
| `lint` | Lint | `Run lint to check wiki health.` | `EXPERIENCE.md:127` |
| `todos` | Todos | `No candidates. Meeting ingest will propose them.` | `EXPERIENCE.md:133` |
| `review` | Review | `No pending cards.` | `EXPERIENCE.md:129` |
| `research` | Deep Research | `No research tasks yet. Enter a topic above or click Deep Research in Review.` | `EXPERIENCE.md:131` |
| `skills` | Skills | `No skills enabled yet.` | authored |

`CHAT_SIDECAR_DOWN_COPY` = `Start the local sidecar on 127.0.0.1:19828 to use Chat.` (authored: EXPERIENCE.md:140 specifies the behaviour — "Fail closed (start sidecar / check `:19828`)" — but no sentence). `CHAT_SIDECAR_UP_COPY` is the Chat row above, used verbatim per UX-DR15 even though the `New Chat` control it names arrives with Story 3.2; that path is unreachable until a sidecar exists. `GRAPH_NARROW_COPY` = `The graph needs a wider window.`

**Two token values DESIGN.md does not name.** The active wash is specified as a `{colors.foreground}` wash (`DESIGN.md:255`) and as "a slightly darker gray wash" (`:245`) but only the mockups give a number: `#E5E5E5` (`todos.html:85`). Use it as `--wb-active-wash: #E5E5E5`. Rail hover is specified as `{colors.surface-subtle}` (`:245`), which equals the rail's own background — unusable there — so `--wb-rail-hover: #F0F0F0`, the midpoint of the same ramp, is derived here. Both are shell-scoped and are the only chrome values not lifted straight from DESIGN.md.

**Why the shell is at `/` and bare.** The Workbench is the product, not a page inside a site; a sticky 56px nav with twelve links above a 48px rail would restate the IA the rail replaces, and `.shell`'s 1180px centre-column cannot hold a full-bleed grid. Going bare on `/` reuses `SiteChrome`'s existing single-branch mechanism rather than inventing a layout API. Consequence to accept knowingly: the Clerk `UserButton` (and sign-out) lives in `NavHeader`, so from the Workbench it is one click away via the rail's Settings link to `/settings`, which still renders the site chrome. Bringing account controls into the shell belongs with Story 1.9.

**Why mode switching is state, not routing.** `epics.md:367` requires that switching modes not destroy typed Chat input. Epic 1 ships no composer, so the requirement has no observable surface yet; it is honoured structurally by keeping one mounted shell whose state lives above the mode panel, so Story 3.2's composer draft can be lifted there without a rewrite. Routing per mode would make that impossible and is therefore forbidden rather than merely unnecessary.

**Why the sheet is not a modal.** `useDialogA11y` sets `document.body.style.overflow` and captures Esc with `stopPropagation` so exactly one overlay closes. The rail sheet is navigation that can be open while a `ConfirmDialog` opens on top of it; reusing the hook would give two competing body-overflow owners and let Esc close the wrong layer. A bubble-phase Esc listener loses to the dialog's capture-phase handler, which is the correct precedence.

## Verification

**Commands:**
- `npx vitest run` -- expected: the full suite green (195 files, 3780 tests at baseline) plus the four new files; no pre-existing test file modified.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors.
- `npx vitest run src/lib/__tests__/single-ia.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/links.test.ts` -- expected: green unchanged; the single-IA ban, the Story 1.2 UI literals, the `work-wiki`/`yopedia` pins and the Story 1.1 retirements all still hold.
- `grep -rniE "navigator\.userAgent|isMobileDevice|mobile-navigation" src/app src/components` -- expected: no match.
- `grep -rn "Georgia\|serif" src/components/workbench` -- expected: no match.
- `grep -rn "yopedia_workbench" src/lib/workbench-state.ts` -- expected: both keys, `yopedia_`-prefixed.

**Manual checks (if no CLI):**
- Inspect `src/components/workbench/Workbench.tsx` for `router.push`, `next/link`, or any `<a href>` that leaves `/` other than the rail's Settings control — there must be none.
- Inspect the appended `globals.css` block for any edit above it: `:root`, `.dark` and `@theme inline` must be byte-identical to baseline.

## Auto Run Result

Status: done

**Summary.** Story 1.3 was already implemented and reviewed twice; this run is the follow-up review pass the previous pass recommended. No intent gap and no spec defect surfaced, so no code was re-derived. Four findings were patched on top of the existing implementation. The one that matters is a real keyboard-accessibility defect: the focus containment the previous pass added to the narrow-viewport sheet did not actually contain, because its wrap point was a control that CSS hides at exactly the widths where the sheet exists. The other three are a state-updater purity fix, a forced-colours indicator for the active mode, and assertions for the type lock — the intent's most explicit visual constraint, which until now had only its negative half tested. Shell behaviour and structure are otherwise unchanged.

**Files changed in this pass:**
- `src/components/workbench/Workbench.tsx` — the sheet's Tab loop wraps on visible controls only; the collapse toggle's storage write moved out of the state updater.
- `src/app/globals.css` — a `@media (forced-colors: active)` outline for the active rail item. Still append-only: `git diff --numstat` against the baseline reports 482 insertions, 0 deletions, so `:root`, `.dark` and `@theme inline` remain byte-identical.
- `src/lib/__tests__/workbench-chrome.test.ts` — three new tests (focus wraps on visible controls; the system-sans stack and 13px/1.45/600/18px/1.3 density; the active wash and its forced-colours fallback) and one tightened (updater purity now covers the collapse toggle as well as the sheet).

**Review findings breakdown:** 4 patched (0 high, 1 medium, 3 low); 0 deferred — every pre-existing issue the reviewers raised was already entry 1, 2, 3 or 5 of this spec's `deferred` list and was rejected as a re-find rather than duplicated, leaving those entries untouched; 36 rejected (5 medium, 31 low), covering intent-authorized design decisions, the earlier passes' logged calls, and noise.

**Follow-up review recommendation:** `true`. Patched counts by severity: high 0, medium 1, low 3. Score = 3 × 1 + 3 = 6, which is ≥ 5.

**Verification performed:**
- `npx vitest run` — 199 files, 3850 tests, all passing (3847 at the start of this pass; the three added tests are all in this story's own `workbench-chrome.test.ts`). No pre-existing test file was modified.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0 (the same three `jsx-ast-utils` informational notices about `TSNonNullExpression` as before; not errors).
- `grep -rniE "navigator\.userAgent|isMobileDevice|mobile-navigation" src/app src/components` — no match.
- `grep -rn "Georgia\|serif" src/components/workbench` — no match.
- `grep -rn "yopedia_workbench" src/lib/workbench-state.ts` — both keys present and `yopedia_`-prefixed.
- Manual: `Workbench.tsx` still contains no `router.push`, no `next/link` and no `<a href>`; the shell's only outbound link remains the rail's `/settings` control in `IconRail.tsx`.

**Residual risks:**
- The Tab-containment fix is rendered-DOM behaviour verified by source scan, because this story is forbidden a DOM test environment. `getClientRects()` is the right predicate on paper — it is empty for a `display: none` element and unaffected by the rail's `position: fixed` — but nothing in the suite exercises it against a real layout. This is `deferred` entry 1, and this pass widened what sits behind it.
- The restored mode and collapse state are applied in a mount effect, so a returning owner sees one frame of the expanded column and the Wiki canvas before their stored state lands. `data-mounted="false"` suppresses the transition but not the jump. This follows the mount-guard pattern the Code Map prescribes; removing the flash needs a pre-paint inline script, which is a larger call than a review patch.
- `badgeAccessibleName` has no singular form, so a count of 1 would announce "Review, 1 pending reviews". Unreachable in Epic 1 — the counts are hard-0 and the badge is hidden — but Epics 4 and 5 will be the first to wire real numbers into it.

