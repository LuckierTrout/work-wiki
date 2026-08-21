### DW-1: The CLI still exposes a publish-to-commons command after the REST route and the MCP tool were retired.
origin: spec-deferred 592955d7b1dc
location: src/cli.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/cli.ts` keeps `publish <slug> --agent <id>` calling `publishToCommons` (`src/lib/publish.ts`), and `src/lib/__tests__/cli.test.ts` still asserts the promotion end to end. The intent names routes and the MCP tool list, not the owner-local CLI, so it was left alone; it now writes into an index nothing reads.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery

### DW-2: slugPath() addresses every slug-only link through the default tenant, so the URL names the wrong handle until the owner route redirects it.
origin: spec-deferred fe2df3ceb0dd
location: src/lib/links.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `slugPath()` hard-codes `DEFAULT_TENANT` and leans on the 308 in `src/app/u/[handle]/[slug]/page.tsx`. Call sites such as RecentIngests, VaultExplorer, ChatWorkspace, ActionInbox, BulkDocumentImport and KnowledgeStudio already hold (or can fetch) the real owner, so each of those links costs a redirect hop and shows a misleading handle in the address bar and in link previews.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-owner-scoped-linking

### DW-3: Alias forwarding for merged or renamed slugs disappeared with the retired commons URL and was never rebuilt on the owner-scoped URL.
origin: spec-deferred 162f1930cc8c
location: src/lib/page-redirect.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `commonsRedirectForMissing` resolved an absorbed slug to its survivor and 308'd to `/wiki/<canonical>`; it now returns null unconditionally. Its only caller was the retired page, so nothing regressed at that URL — but a wikilink to a merged-away slug now resolves through `slugPath()` to `/u/<tenant>/<old-slug>`, which 404s. `resolveAlias` has no routing caller.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-owner-scoped-linking

### DW-4: The zh-CN translation catalog has stale keys and still spells the old brand.
origin: spec-deferred ee84aaa25ba2
location: src/lib/i18n.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `src/lib/i18n.ts` keys on exact English source strings, so the renamed chrome labels ("The commons", "What is WorkWiki", "Browse all") no longer match and silently fall back to English; keys for deleted UI (Browse, Join waitlist, Contributors, Mobile navigation) are now unreachable; and line 43 still ships "WorkWiki" as rendered copy. The spec forbids i18n work in this story, and the recorded user preference is English-only, so the whole module is a later cut.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-zh-cn-locale
decision: 2026-08-16 Retire zh-CN — Remove the zh-CN catalog, LocaleSwitcher, and locale-cookie plumbing (LocaleProvider, layout.tsx cookie read), and drop brand-copy.test.ts's path exemption for i18n.ts — matching the recorded English-only preference.

### DW-5: Reconcile-from-talk plumbing and the discussion lint checks outlive the talk surface they point at.
origin: spec-deferred af264a332ec0
location: src/lib/reconcile.ts, src/lib/lint-checks.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/api/tasks/run` still dispatches `reconcile`/`maintain:reconcile` through `reconcileFromTalk`, the `reconcile_page` MCP tool remains, and `checkUnresolvedDiscussions` / `checkDisputedPages` still emit warnings whose remediation surface now 404s. Harmless while no surface can create a thread, but it is dead machinery.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery

### DW-6: ArticleActions still branches on the commons realm.
origin: spec-deferred 5bb7128d058f
location: src/components/ArticleActions.tsx
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/components/ArticleActions.tsx` keeps `isCommonsPage` gating for Delete and "Save to vault", and `ArticleView` computes and threads the flag purely to feed it. Changing delete authorization was out of this story's scope, so the realm model survives with no commons behind it.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery

### DW-7: canWritePage's commons-realm rule lost its escape hatch when talk was retired.
origin: spec-deferred 51476f69db15
location: src/lib/authz.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/lib/authz.ts` still denies `body` and `delete` writes on any public non-agent page to non-admin principals, justified in-comment by humans steering through metadata patches and talk threads. The edit page's copy is now a bare "You don't have write access to this page" with nowhere to go.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-authz-commons-realm-cleanup
decision: 2026-08-16 Keep, re-document — Keep the deny (it still usefully stops future non-admin principals from overwriting curated public pages), rewrite its stale rationale comment, and give the edit page's denial copy an accurate explanation.

### DW-8: The contributor capability is retired at every page and REST surface but still ships as two MCP tools.
origin: spec-deferred b763192224b5
location: src/lib/mcp-http.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/wiki/contributors`, `/api/contributors` and `/api/contributors/[handle]` all 404, and `/u/<handle>` is gone — but `list_contributors` and `get_contributor` remain registered in `src/lib/mcp-http.ts` and `mcp.json`, and `mcp-http.test.ts` was updated to keep them passing. They are read-only and bearer-gated, so nothing leaks in a single-owner deployment; whether the capability should survive at MCP after being cut everywhere else is a product call, not a defect.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery-round-2
decision: 2026-08-16 Retire the tools — Unregister list_contributors and get_contributor from mcp-http.ts, mcp.ts and mcp.json, and update mcp-http.test.ts — completing the retirement the rest of the surface already had.

### DW-9: Middleware still exempts the retired publish route as an in-route-auth path.
origin: spec-deferred 049dafc8e212
location: src/middleware.ts:73
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/middleware.ts` keeps `AGENT_PUBLISH_RE` and documents `/api/agents/<id>/publish` as "the agent's own per-agent token" in its header comment, though the handler is now `retiredRoute()` and inspects nothing. Harmless (the request 404s), but the exemption cannot be removed here: `middleware-write-gate.test.ts:39` pins it, and this story's constraints forbid changing that suite's behavior.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery

### DW-10: Maintainer-facing files still carry the old brand after the display rename.
origin: spec-deferred 4087d7d02acb
location: tools/workwiki-sync.mjs
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `tools/workwiki-sync.mjs`, `tools/WORKWIKI_SYNC.md`, `BACKLOG.md`, `docs/llm-wiki-functional-parity-roadmap.md` and `workers/sandbox-runner/README.md` still say "WorkWiki". None of it is rendered product copy — the intent's rename targets user-visible surfaces — and one of them is a filename, so renaming is a separate, wider cut.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-maintainer-brand-sweep

### DW-11: Every owner-only page renders a second `<main>` landmark inside the one `SiteChrome` already provides.
origin: spec-deferred 87a650148e71
location: src/components/PrivateWorkspaceNotice.tsx
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `SiteChrome` wraps all children in `<main id="main-content">`, and the signed-out branch of nine pages returns `PrivateWorkspaceNotice`, whose root element is another `<main>`. The nesting predates this story — the baseline `chat/page.tsx` had the same `<main className="shell fade">` — so the refactor into one component inherited it rather than causing it. It is a duplicate-landmark violation in a component whose own docstring cites WCAG 2.2 AA, and the same pattern appears on `settings`, `query` and other signed-in pages, so the fix is a chrome-wide sweep, not a one-file edit.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-single-main-landmark-sweep

### DW-12: The email-ingest worker's attachment-forwarding path has no test, so its byte-copy could silently forward empty files.
origin: spec-deferred 02eeaa536555
location: workers/email-ingest/index.ts:239
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `workers/email-ingest/index.ts:239` copies attachment bytes into a fresh `Uint8Array` before wrapping them in a `Blob` for the `attachments` FormData part. `email-ingest-worker.test.ts` is the only test that imports the worker, and its fixture is a plain-text message with no attachment; both cases assert only on `msg.reply`'s text. Zeroing the copy would still produce a correctly-sized buffer, a `{ ok: true, slug }` response and the same acknowledgement email, so every emailed PDF/DOCX would ingest empty with the suite green. The attachment path is pre-existing; this story only fixed a type error on that line.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-email-ingest-attachment-test

### DW-13: Follow-up review still recommended for 1-1-sign-in-privately-and-retire-commons after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260814-210506-c3ab; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-14: Creating or re-templating a Wiki overwrites the tenant-global workspace profile, including one the owner hand-authored in Settings.
origin: spec-deferred 60cce7b0cff4
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `seedWikiArtifacts()` calls `saveWorkspaceProfile(owner, templateProfile(...))`, which is what makes a seeded template reach the seven prompt sites that consume `buildWorkspaceGuidance(owner)`. The profile is a per-tenant singleton at `tenants/<t>/workspace-profile.json`, so a Wiki create silently replaces whatever the owner wrote on the Workspace Purpose settings form. Both dialogs say "purpose.md and Schema", which is true in substance (the profile is the machine form of purpose) but does not name the Settings surface the owner will see change. The inverse also holds: a Settings edit does not update the Wiki's `schema.md`, so the two diverge. Reconciling the two representations belongs with Story 1.8 (Edit Schema), which owns editing both.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-per-wiki-workspace-profiles
decision: 2026-08-16 Per-Wiki profiles — Store one workspace profile per Wiki; switching Wikis swaps the active profile instead of overwriting a shared singleton, so hand-authored text survives per Wiki and create/re-template only touch their own Wiki's profile.

### DW-15: The repository has no DOM test environment, so the confirm gate and "Cancel writes nothing" are pinned only by scans of component source text.
origin: spec-deferred 2b4928bd0582
location: vitest.config.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `vitest.config.ts` is `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]`, and `@testing-library/*` is not a dependency — across ~230 test files the only component tests render to a string with `renderToStaticMarkup`. `create-wiki-ui.test.ts` follows the established `single-ia.test.ts` fallback and greps the source, so rewiring `onConfirm` to call `applyTemplate()` without the dialog would leave every assertion passing. Establishing jsdom + testing-library is a repo-wide infrastructure change that predates this story; this story is simply the first to add a substantial interactive surface on top of the gap.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-dom-test-environment

### DW-16: `purpose.md` is written at create time but no runtime path reads it.
origin: spec-deferred 0335bb4045db
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: A grep of `src/` finds no consumer of the seeded `purpose.md`; only `schema.md` became executable, via `loadPageConventions()`. The template's purpose text does reach prompts through the workspace profile, so nothing is lost today, but PRD FR-76 lists `purpose.md` in the file-tree contract and prd.md:558/564 puts it in the Chat system-prompt allocation. Story 1.4 (trees) and Epic 3 (Chat) are where the file itself acquires readers.
status: done 2026-08-16
resolution: already resolved: purpose.md now has a runtime reader: src/lib/workbench-files.ts:261 lists it in the Files tree, resolveWorkbenchFile's artifact branch (src/lib/workbench-files.ts:436-438) maps it through readWikiArtifact (src/lib/workbench-files.ts:477), and /api/workbench/preview serves its bytes (src/app/api/workbench/preview/route.ts:167-171). The Chat system-prompt consumption the entry also cites remains Epic 3's and is covered by that epic's own scope.

### DW-17: Wiki artifacts sit at `tenants/<t>/wikis/<id>/`, not at the project root beside `wiki/` and `raw/sources/` as FR-76's file contract describes.
origin: spec-deferred b01b1e432d01
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: The location was chosen so `reconcileSilos()` (`src/lib/silo.ts:230-265`) cannot delete the seeded files as unindexed orphans, and Story 1.2 does not partition Pages or Sources per Wiki. The consequence is that `/api/v1/projects` (Epic 8, FR-76) has no `path` to report and `files?root=all` cannot yet return `purpose.md`, `schema.md`, `wiki/` and `raw/sources/` from one root. Reopening this requires the per-Wiki Page partitioning that Story 1.4's "the trees show that Wiki's files" implies.
status: open

### DW-18: A Wiki can be created and re-templated but never deleted or renamed, and artifact directories are never cleaned up.
origin: spec-deferred 5fa916c79323
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: low
reason: `wikis.ts` exposes create/apply/set-current only. The name is baked into the `# <name>` heading of `purpose.md` at seed time, so a typo is permanent, and an entry dropped by `normalizeRegistry` leaves its `wikis/<id>/purpose.md` and `schema.md` on disk with nothing referencing them. Story 1.2's acceptance criteria ask for neither operation.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-wiki-rename-and-delete
decision: 2026-08-16 Build rename+delete — Add rename (updates registry and the purpose.md heading) and confirm-gated delete (removes the registry entry and its wikis/<id>/ directory, refusing to delete the current Wiki), plus an orphan-directory sweep, with matching routes and Workbench controls.

### DW-19: `loadPageConventions()` resolves the active Wiki deployment-globally from `NEXT_PUBLIC_OWNER_HANDLE`, while the guidance beside it at the same prompt sites resolves per-caller.
origin: spec-deferred 54c8fcb81384
location: src/lib/wikis.ts:398
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `readActiveWikiSchema()` calls `getOwnerHandle()`, the only place in the repo where that value becomes a storage key — every other tenant-scoped read/write (`workspace-profile.ts`, `research-projects.ts`, `portable-archive.ts`) takes a passed-in owner. At `ingest.ts:1165/1239/ 1511`, `query.ts:226`, `agent-runtime.ts:154` and `source-monitors.ts:386` the no-argument `loadPageConventions()` sits directly beside `buildWorkspaceGuidance(owner)`, whose `owner` can be `"system"`, an agent handle, or a monitor's owner. So a non-site-owner caller now gets the site owner's Scenario Template conventions where it previously got the generic root `SCHEMA.md`. The spec's Code Map sanctions `getOwnerHandle()` as "how a server-side helper with no owner argument resolves the single-owner tenant", and `isOwnerHandle()` already makes handle equality the repo's owner-trust model, so this is correct for the single-owner deployment shipping today. Threading a tenant into the loader is the real fix and it b
status: done 2026-08-17
resolution: resolved by sweep bundle dw-single-owner-resolution-invariant
decision: 2026-08-17 Keep, document the constraint — Leave the getOwnerHandle() resolution in place and document it as an explicit single-owner invariant at src/lib/wikis.ts:540 and at each no-argument loadPageConventions() call site, naming what must change when a second tenant arrives. Add a test that pins the single-owner assumption so a multi-tenant change cannot land silently.
decision: 2026-08-16 Keep, document the constraint — Leave the getOwnerHandle() resolution in place and document it as an explicit single-owner invariant at src/lib/wikis.ts:540 and at each no-argument loadPageConventions() call site, naming what must change when a second tenant arrives. Add a test that pins the single-owner assumption so a multi-tenant change cannot land silently.

### DW-20: Create and re-template are not atomic across the two artifact writes, the profile write, and the registry write.
origin: spec-deferred 1f1c9143305b
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `createWiki` runs `seedWikiArtifacts()` (purpose.md → schema.md → `saveWorkspaceProfile`) before `writeRegistry`, with no rollback. A failure part-way leaves `wikis/<id>/` on disk with no registry entry and a tenant profile already switched to the new template; in `applyScenarioTemplate` it can leave purpose.md from one template beside schema.md from another. The storage provider exposes no transaction, and `research-projects.ts` — the registry idiom the spec directs this module to mirror — has the same property, so this is an inherited architectural limit rather than a defect in this change. Closing it means a write-ahead or compensating-write facility in the storage layer.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-wiki-create-and-template-atomicity

### DW-21: Switching the active Wiki rewrites the tenant-global workspace profile with no confirm at all, unlike the template overwrite it is equivalent to.
origin: spec-deferred 3671da5ea756
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `setCurrentWiki` calls `saveWorkspaceProfile(owner, templateProfile(...))` — added deliberately so `loadPageConventions()` and `buildWorkspaceGuidance()` cannot name two different templates at once. The consequence is that the bare `<select>` in `WikiWorkbench` is a destructive write on the same tenant singleton that `Change template` guards behind `ConfirmDialog`. Gating a switch is not in this story's acceptance criteria, and the durable fix is the same reconciliation of the per-Wiki and tenant-global representations that Story 1.8 (Edit Schema) owns.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-per-wiki-workspace-profiles

### DW-22: The `wikis:<tenant>` lock does not serialize against the `workspace-profile:<tenant>` lock it writes through.
origin: spec-deferred 7d6ef98a9b38
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: low
reason: `withFileLock("wikis:<tenant>", …)` wraps `saveWorkspaceProfile`, which takes `withFileLock("workspace-profile:<tenant>", …)` — a different key. A concurrent save from the Workspace Purpose settings form can therefore interleave, leaving `schema.md` naming one template and the profile another. Reachable only from one owner acting in two places at once on a single-owner deployment, and the obvious fix (nesting the two locks) introduces a lock-ordering hazard with any future caller that takes them the other way round.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-per-wiki-workspace-profiles

### DW-23: Follow-up review still recommended for 1-2-create-a-wiki-from-a-scenario-template after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-24: The whole interactive shell is verified only by reading its own source text; nothing renders, mounts, or measures it.
origin: spec-deferred fd8367b6c9be
location: vitest.config.ts
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: medium
reason: `vitest.config.ts` is `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]`, and this story was given "Do not add jsdom, `@testing-library/*`, or `.test.tsx` support" as a Never. So `workbench-chrome.test.ts` is `readFile` + `toContain` throughout: sheet open/close, the Esc handler, focus move-in and restore, the `matchMedia` widening dismissal, the collapse toggle, badge rendering at 0 vs > 0, and every CSS breakpoint are asserted as strings present in the file that implements them. `src/hooks/useSidecarStatus.ts` — the poll schedule, the visibility gating, the abort-on-unmount guard — has no test at all; deleting `startPolling()` from its `visible` branch would leave the suite green and the status dot frozen. Establishing a DOM test environment is a repo-wide change that predates this story (it is also entry 2 of Story 1.2's ledger); this story is simply the first to put a substantial amount of behaviour behind that gap.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-dom-test-environment

### DW-25: Nothing states the cross-origin contract an HTTPS page must satisfy to reach `http://127.0.0.1:19828`, so the probe can fail closed forever for reasons the copy cannot explain.
origin: spec-deferred 344c510011f1
location: src/lib/sidecar.ts
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: medium
reason: `src/lib/sidecar.ts` documents the fail-closed answer but not the CORS headers the sidecar must return for the deployed origin, Chrome's Private Network Access preflight for a public-to-local request, or Safari's mixed-content handling of a loopback URL. Under any of those the probe answers `down` permanently and Chat shows "Start the local sidecar on 127.0.0.1:19828 to use Chat." to an owner whose sidecar is already running. Epic 1 needs only the up/down signal, and Epic 3 owns the sidecar itself — the response contract belongs with whichever story first ships a real one.
status: open

### DW-26: Switching away from Wiki unmounts `WikiWorkbench`, discarding an open Create Wiki dialog, a typed wiki name, and any error already shown.
origin: spec-deferred eb1d417b7c7d
location: src/components/workbench/ModeCanvas.tsx
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: medium
reason: `ModeCanvas` returns a different subtree per mode, so the Wiki branch is removed rather than hidden. The shell-level guarantee the story states — one mounted shell, no route change, so state above the mode panel survives — does hold, and Story 3.2's composer draft can live there. What does not survive is state held *inside* a mode panel. Story 1.3's ACs ask only that a mode switch not destroy typed Chat input, and Epic 1 ships no composer, so nothing here is unmet; but the first mode panel that holds real unsaved input will need the canvas to hide rather than unmount.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-workbench-client-state-and-nav

### DW-27: The active mode has no URL representation, so a mode cannot be linked or bookmarked and Back leaves the app entirely.
origin: spec-deferred 8ebf6433668a
location: src/components/workbench/Workbench.tsx
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: low
reason: Mode lives in React state plus `yopedia_workbench_mode`. The intent's constraint is that a mode switch must not unmount the shell (`epics.md:367`), which a shallow query-param sync would also satisfy — so this is a design choice the story did not have to make, not a requirement it met. It is cheap now and a breaking change to the persisted-state contract later, so it is worth an explicit decision before Stories 1.4-1.6 build selection state on top of it.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-workbench-mode-url-sync
decision: 2026-08-16 Shallow ?mode= sync — Mirror the active mode into a query param via shallow history updates (no shell unmount), accept it on load ahead of localStorage, and update the router-ban pin so deep-linking a mode and Back/Forward work.

### DW-28: `HomeDashboard` is no longer mounted by any route, and the test that pinned it as the landing page's `<h1>` owner now guards a component that does not ship.
origin: spec-deferred 8594e9c2456b
location: src/components/HomeDashboard.tsx
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: low
reason: `src/app/page.tsx` no longer renders `<HomeDashboard>`, but `src/components/HomeDashboard.tsx` and `src/lib/home-dashboard.ts` stay on disk because `create-wiki-ui.test.ts:199-204` reads the component file and asserts it contains an `<h1>`, and `home-dashboard.test.ts` exercises `buildHomeDashboardSnapshot`. Deleting either file would modify a pre-existing test, which this story was forbidden to do. So three test files now report green on a surface nothing renders. Retiring the dashboard properly — deleting the modules and retargeting that assertion at the shell's `<h1>` — belongs with whatever cleans up the remaining pre-Workbench surfaces.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery

### DW-29: Follow-up review still recommended for 1-3-nashsu-icon-rail-and-workbench-chrome after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-30: Switching Wikis changes only `purpose.md` and `schema.md` in the trees; `wiki/` and `raw/` are tenant-flat, so the Knowledge tab shows the same pages under every Wiki.
origin: spec-deferred 166e4d5b97ae
location: src/lib/workbench-files.ts, src/lib/wikis.ts
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: medium
reason: `src/lib/wikis.ts:16-17` states that Pages and Sources are deliberately not partitioned per Wiki, and `deferred-work.md` DW-17 already owns that migration. `listWorkbenchFilePaths` therefore walks the owner's one silo (`tenants/<t>/wiki`, `tenants/<t>/raw`, or the flat roots when the silo is empty) regardless of `wikiId`, and `buildKnowledgeTree` groups `listReadableWikiPages(principal)` — also tenant-wide. The AC's "the trees show that Wiki's files" is met only to the extent anything is per-Wiki on disk today: the two seeded artifacts under `tenants/<t>/wikis/<id>/`. Closing the gap means repartitioning the kernel's storage, which reaches ingest, index, silo, graph and MCP — a migration, not a browse story.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-wiki-lens-copy-and-invariant
decision: 2026-08-17 Reword the AC, keep flat — Keep the tenant-flat storage and make the product honest about it: correct the acceptance wording and the Wiki-switch copy so a Wiki is understood as a lens over shared Pages and Sources plus its own purpose.md/schema.md, and document the invariant beside listWorkbenchFilePaths so no later story re-reads the AC as a partitioning promise.
decision: 2026-08-16 Reword the AC, keep flat — Keep the tenant-flat storage and make the product honest about it: correct the acceptance wording and the Wiki-switch copy so a Wiki is understood as a lens over shared Pages and Sources plus its own purpose.md/schema.md, and document the invariant beside listWorkbenchFilePaths so no later story re-reads the AC as a partitioning promise.

### DW-31: The Files tab shows `purpose.md` and `schema.md` at the tree root, so the path the Preview strip prints for them is not the path that addresses their bytes.
origin: spec-deferred 5bb2e2fd9c76
location: src/lib/workbench-files.ts, src/components/workbench/PreviewColumn.tsx
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: medium
reason: The I/O matrix fixes those two artifacts at the root of the file tree, but they physically live at `tenants/<t>/wikis/<id>/<file>` (`wikiArtifactPath`). `listWorkbenchFilePaths` emits them as bare names, and `PreviewColumn` prints the selection path verbatim, so a reader is shown `purpose.md` where storage holds a three-segment key. Nothing reads the printed path in this story, but Story 1.5 has to fetch bytes from a selection — it will need either a real storage path on the node or a resolver that maps root artifacts back to `wikiArtifactPath`.
status: done 2026-08-16
resolution: already resolved: The resolver the entry said Story 1.5 would need was built: resolveWorkbenchFile (src/lib/workbench-files.ts:426-461, whose header comment names this deferred entry) maps root artifact names back to wikiArtifactPath via readWikiArtifact (src/lib/workbench-files.ts:475-483), consumed by src/app/api/workbench/preview/route.ts:165-174. The root-level display path is the I/O matrix's deliberate abstraction and nothing consumes the printed string.

### DW-32: The read gate covers `wiki/` leaves only; `raw/` filenames are listed unfiltered, and they are derived from page slugs.
origin: spec-deferred 5a6b330e4ac8
location: src/lib/workbench-files.ts
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: medium
reason: `listWorkbenchFilePaths` filters `.md` leaves under the wiki root against the slug set `listReadableWikiPages` returned, so a page hidden from the Knowledge tab cannot surface in Files by filename. `raw/` is not filtered: `saveRawSource` writes `raw/<slug>.md` and `saveRawSourceFor` writes `raw/<slug>/<hash>.md`, so the source tree still spells the slug of a page the filter excludes. In the single-owner Workbench this epic ships, every file under the tenant belongs to the signed-in owner, so nothing crosses an owner boundary today — the exposure is limited to agent-scoped pages and to legacy flat-tree residue. Filtering `raw/` needs a source→page mapping the walk does not have (one raw file can back several pages, and an orphaned source backs none), so it belongs with whichever story gives Sources a real read model — Epic 2.
status: open

### DW-33: Wiki mode now shows two Wiki switchers and two create controls at once — the new header pair and Story 1.2's canvas card.
origin: spec-deferred 6403cc2df74f
location: src/components/WikiWorkbench.tsx
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: low
reason: `create-wiki-ui.test.ts:118-209` counts `btn primary`, `fallbackFocusRef={headingRef}` and `router.refresh()` occurrences inside `src/components/WikiWorkbench.tsx`, so this story was forbidden to edit that file at all — its `Active wiki` <select>, its `New wiki` button and its `Change template` control all stay. The result is a duplicated affordance in one viewport: the header switcher and the card switcher drive the same `PUT /api/wikis/current`, and `page.tsx` keys the card on `currentId` so they cannot disagree, but the owner is offered the same choice twice. Retiring the card's switcher means retargeting those frozen counts, which belongs with whatever story rebuilds the Wiki canvas (Story 1.5 onwards) rather than with the column that now duplicates it.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-retire-duplicate-wiki-canvas-controls

### DW-34: Docking and undocking the Preview is a silent layout change, and below 900px the column arrives off screen below the canvas.
origin: spec-deferred 884c300a0a3f
location: src/components/workbench/Workbench.tsx, src/app/globals.css
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: low
reason: Story 1.3 gave the shell a polite live region, but only `selectMode` writes to it — selecting a tree row adds a whole fourth column with no announcement and no focus move, and re-selecting the same row removes it just as quietly. At `max-width: 899px` the shell is one column and the Preview stacks as the last row, so on a phone tapping a tree row appears to do nothing until the owner scrolls. Neither behaviour is wrong against this story's acceptance criteria, which ask only that selection dock the column, and both are cheap to get wrong in isolation: what to announce depends on what the column will say, which is Story 1.5's, and where a docked column goes at narrow widths is the layout question Story 1.6 owns. Deciding either here would pre-empt a story that has the context.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-workbench-preview-announcements
decision: 2026-08-16 Author and wire — Add dock/undock announcement sentences to the epic's Copy table, write them to the existing polite live region from the selection setters, and scroll the docked column into view at narrow widths.

### DW-35: Follow-up review still recommended for 1-4-knowledge-tree-and-file-tree after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-36: Changing the tree selection while the confirm-gated editor is open discards the owner's unsaved markdown with no warning.
origin: spec-deferred 3c0e066248f5
location: src/components/workbench/PreviewColumn.tsx, src/components/workbench/Workbench.tsx
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: medium
reason: The fetch effect calls `setEditing(false)` unconditionally on every `selection` change, and Cancel discards without a prompt. The story went to real lengths to guarantee the opposite for the failure it owns — a rejected save keeps the text — but the likelier loss path, one stray click on a tree row, has no dirty check at all. Guarding it means intercepting a selection change the SHELL owns, not the Preview: `selection` lives in `Workbench.tsx:86` and its reset effect's deps (`[mode, currentWikiId, treeTab]`) are pinned verbatim by `workbench-left-column.test.ts:86-88`, so a pending-selection handshake would have to be threaded through the component that cannot grow that dependency. The intent asks for a confirm before EDITING, not before leaving; deciding what a second gate looks like belongs with Story 1.6, which owns durable selection, or with whichever story gives the editor a lifecycle of its own.
status: done 2026-08-18
resolution: already resolved: Resolved by commit 6bebc4e (sweep dw-workbench-selection-dirty-guard). `src/components/workbench/PreviewColumn.tsx:187-197` now holds `confirmOpen` state with the comment naming DW-36, `:356` computes `previewDraftDirty({editing, draft, seed: draftSeed})`, `:368` reports it up via `onDirtyChange`, and the tree pick is gated behind the ConfirmDialog at `:676-679`; covered by `src/components/workbench/__tests__/preview-dirty-guard.test.tsx`.

### DW-37: `PUT /api/wiki/[slug]` has no `isReadOnly()` gate, and this story's `Edit` affordance is the first surface to offer it to a human.
origin: spec-deferred 28559db804f6
location: src/app/api/wiki/[slug]/route.ts
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: Every other mutating route consults `isReadOnly()` and answers 403 — `api/wikis/route.ts`, `api/wikis/current`, `api/wikis/[id]/template`, `api/workspace-profile`. The page write route never has. On a read-only deployment the Preview therefore offers `Edit`, opens the dialog, and the save SUCCEEDS, because gating `editable` in the preview route would only hide a door that is still unlocked. The fix belongs at the write route, where it also covers the MCP and agent callers, not at the affordance that happens to have surfaced it.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-read-only-deployment-consistency

### DW-38: The page write path has no lost-update guard, so a save can silently overwrite a page rewritten since the Preview read it.
origin: spec-deferred 0f0288cf1313
location: src/lib/lifecycle.ts, src/app/api/wiki/[slug]/route.ts
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: `savePreviewBody` PUTs `{ content }` with no `updated`, ETag or `If-Match`, and `writeWikiPageWithSideEffects` takes it. The storage provider already exposes `readFileWithEtag` and `writeFileIfMatch` (`src/lib/storage/types.ts:196,205`) and nothing in the kernel write path uses them. Not reachable in Epic 1 — one operator, no ingest — but Epic 2 gives the same pages a second writer, and Epic 8's loopback API a third, so whichever of those lands first is where the guard has a real reason to exist rather than a hypothetical one.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-write-preconditions-and-conflict-surface

### DW-39: Story 1.2's canvas card keeps saying `Select a file to preview.` while a Preview column is docked beside it showing exactly that file.
origin: spec-deferred 6624dcbc2fe7
location: src/components/WikiWorkbench.tsx:254
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: The sentence is an unconditional element of `WikiWorkbench.tsx:254`, rendered on the Wiki canvas at every moment, and this story's first acceptance criterion is satisfied by not disturbing it. Once the fourth column docks, one viewport carries a rendered page and a sentence saying nothing is selected. Retiring or conditioning that sentence means editing a file whose in-file occurrence counts `create-wiki-ui.test.ts:118-209` asserts — the same freeze that produced `spec-1-4` deferred entry 4, and the same owner: whichever story rebuilds the Wiki canvas.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-retire-duplicate-wiki-canvas-controls

### DW-40: A read under `raw/` inherits `resolveRoot`'s fallback to the SHARED flat root, so an owner whose raw silo is empty reads the legacy tree's bytes.
origin: spec-deferred 8926f334b742
location: src/lib/workbench-files.ts (resolveWorkbenchFile, resolveRoot)
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: medium
reason: `resolveWorkbenchFile` gates only `root === "wiki"`; `raw/…` goes straight to `resolveRoot(silo, flat)`, which falls back to the shared `RAW_DIR` when the caller's silo lists empty. That is not a deviation — the intent ties the file gate to what `listWorkbenchFilePaths` would emit, and the listing walks `raw/` with `allowEveryLeaf` through the same `resolveRoot` — so read and listing agree exactly, as required. What changed is the stakes: Story 1.4 disclosed those FILENAMES, and this story serves their contents. Narrowing it here is not available: the intent requires `resolveRoot` to have "exactly one definition", and a read gate narrower than the listing would show rows that refuse to open (the sibling entry below). The real fix is retiring the flat root, or giving `raw/` a per-owner gate — both belong with whichever story completes the silo migration, since `src/lib/silo.ts` already calls the flat tree transitional.
status: open

### DW-41: The Files tab lists `wiki/` leaves that are not pages, and the Preview now answers every one of them with `This file couldn’t be loaded.`
origin: spec-deferred 8ab03831be26
location: src/lib/workbench-files.ts (wikiLeafFilter vs readableWikiLeaf)
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: `wikiLeafFilter` passes every name not ending in `.md`, so `wiki/notes.txt` and `wiki/dump.json` are rows the owner can see and click. The read gate `readableWikiLeaf` refuses them — deliberately, and for a reason the previous review pass recorded at length ("two filters, two reasons — do not re-unify them"), because `resolveRoot`'s flat fallback means those bytes need not be the caller's. The consequence is a visible row that cannot open, which reads as a broken Preview rather than as a gate. The coherent fix is at the LISTING — stop showing a leaf the Preview will refuse — which means editing the filter the previous pass froze on security grounds and re-deciding what the Files tab is for. That is a Story 1.4 surface decision, not a patch to this story's reader.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-workbench-file-listing-gate
decision: 2026-08-17 List only openable leaves — Narrow the listing so the Files tab shows only leaves the read gate will serve: keep the two filters and their two reasons distinct, but derive the listing's admissible set from the same predicate the read gate applies, so no row can be shown that the Preview will refuse. Update the frozen comment at workbench-files.ts:326-339 to record the new rule.
decision: 2026-08-16 List only openable leaves — Narrow the listing so the Files tab shows only leaves the read gate will serve: keep the two filters and their two reasons distinct, but derive the listing's admissible set from the same predicate the read gate applies, so no row can be shown that the Preview will refuse. Update the frozen comment at workbench-files.ts:326-339 to record the new rule.

### DW-42: `editable` is every page the READ gate admits, but the write ACL is narrower, so a readable-but-unwritable page offers `Edit` and fails at Save.
origin: spec-deferred e4b29f3d45f4
location: src/app/api/workbench/preview/route.ts
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: The route sets `editable: true` for any slug in `readableSlugsFromKnowledge(...)`, which is `canReadPage`'s set — everything not `private`. `canWritePage` (`src/lib/authz.ts:190-197`) refuses `writeKind: "body"` for a page where `belongsInCommons(meta)` holds, to any principal that is not the service principal or an admin. So the read set is strictly larger than the body-write set, and for such a principal the Preview shows `Edit`, opens the dialog, seeds the editor and only then relays the write route's 403. Not reachable in Epic 1 — the one operator is an admin through `isOwnerHandle` — and narrowing it is not this story's call either: the intent defines `editable` as "a compiled Page is the one thing this story makes editable", with no clause about write ACLs. Deriving the affordance from `canWritePage` belongs with whichever story introduces a second principal.
status: open

### DW-43: Follow-up review still recommended for 1-5-view-first-preview-with-gfm-and-wikilinks after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-44: The divider's 9px grab strip is under WCAG 2.2 AA's 24px target-size minimum, and its outer half overlaps the tree's own scrollbar.
origin: spec-deferred 223f18c1acac
location: src/app/globals.css (.wb-split-handle), src/lib/workbench-split.ts
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: `--wb-split-hit: 9px` centred on the boundary puts ~4.5px of the strip over the tree column, which is exactly where `.wb-tree-body`'s scrollbar sits, and leaves the target far short of SC 2.5.8's 24×24 CSS px (the spacing exception does not apply — tree rows are adjacent targets). The epic's floor calls AA "a target", and 9px is the width every desktop splitter uses, so this is a deliberate trade rather than an oversight. Widening the strip to 24px is not the obvious fix either: it would cover the scrollbar entirely and eat 12px of the canvas edge. Deciding between a wider strip, an offset strip, and a documented exception is a chrome decision for whichever story revisits the shell's pointer targets.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-split-divider-target-and-responsiveness
decision: 2026-08-17 Offset the strip off the scrollbar — Keep the visual divider at its current width but move the hit strip fully onto the canvas side of the boundary and widen it toward 24px there, so the scrollbar stays reachable and the target grows. Verify against the tree's scrollbar at both collapsed and expanded widths.
decision: 2026-08-16 Offset the strip off the scrollbar — Keep the visual divider at its current width but move the hit strip fully onto the canvas side of the boundary and widen it toward 24px there, so the scrollbar stays reachable and the target grows. Verify against the tree's scrollbar at both collapsed and expanded widths.

### DW-45: The separators carry no `aria-controls`, and the keyboard surface has no coarse step (PageUp/PageDown).
origin: spec-deferred e99921b6f2d1
location: src/components/workbench/SplitHandle.tsx, src/lib/workbench-split.ts
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: The ARIA window-splitter pattern names the pane a separator resizes via `aria-controls`. The tree divider could point at `LEFT_ID`, which the shell already declares — but the Preview divider would need an id on `.wb-preview`, and `PreviewColumn.tsx` is outside the set of existing files this story's Code Map allows it to edit. Wiring one and not the other is worse than wiring neither. The same applies to PageUp/PageDown: with `SPLIT_KEY_STEP = 16`, crossing the tree's real range is ~30 presses. Both belong with whichever story next opens the Preview column's markup.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-split-divider-target-and-responsiveness

### DW-46: The restore validates a stored row against the two trees and the Wiki id, but never against the tree TAB it restores alongside it.
origin: spec-deferred ce30a7341cbf
location: src/lib/workbench-tree.ts (restorableSelection), src/components/workbench/Workbench.tsx (mount effect)
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: `restorableSelection` takes `(stored, wikiId, knowledge, files)`. The shell's reset effect exists to prevent exactly one state — a docked Preview describing a row the showing tree cannot mark with `aria-current` — and the restore path is the one site that can produce it, because the mount effect's signature guard then protects the mismatch from being cleared. Reaching it needs the two keys to diverge, which needs the persist effect's health guard to skip a write across a tab switch (a transient `knowledgeUnavailable` / `filesUnavailable`), so it is narrow. The obvious fix is not obviously right either: requiring `kind` to agree with `tab` would drop the restore of a page selection made on the Files tab, which `wikilinkSelection` deliberately produces when the walk did not list that page's file (Story 1.5). Whether that pairing should survive a reload is a decision about the wikilink fallback, not about the clamp, and it belongs with whichever story next opens that path.
status: done 2026-08-18
resolution: already resolved: Resolved by commit 6bebc4e (sweep dw-workbench-selection-dirty-guard) along the recorded 2026-08-17 decision. `restorableSelection` (`src/lib/workbench-tree.ts:352-362`) now returns `{selection, tab: selectionTab(stored.selection)}` — it switches the tab to the one that can mark the row instead of dropping the restore — and `wikilinkSelection`'s docblock at `:395` cites DW-46 for the pairing.
decision: 2026-08-17 Restore the tab, not reject the row — When a restored selection's kind disagrees with the restored tab, switch the tab to the one that can mark the row rather than dropping the selection. This keeps the wikilink cross-tab pairing restorable and still guarantees the docked Preview always has a row carrying aria-current.
decision: 2026-08-16 Restore the tab, not reject the row — When a restored selection's kind disagrees with the restored tab, switch the tab to the one that can mark the row rather than dropping the selection. This keeps the wikilink cross-tab pairing restorable and still guarantees the docked Preview always has a row carrying aria-current.

### DW-47: The tree's scroll effects re-run on tab and collapse only, so crossing the 899px force-show boundary by RESIZING is missed.
origin: spec-deferred 960bd3db4d29
location: src/components/workbench/TreePanel.tsx (the two scroll effects)
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: `treeScrollActive` correctly asks the element rather than the collapse flag, because `@media (max-width: 899px)` force-shows a collapsed column. But both effects are keyed `[tab, collapsed]`, and neither changes when the viewport crosses 900px mid-session — so an owner who is collapsed and narrows the window gets a fully visible, scrollable tree whose offset is neither restored nor recorded until they next switch tabs. A load at that width is fine; only the live transition is missed. Closing it needs a `matchMedia("(max-width: 899px)")` listener in `TreePanel`, which is a second copy of a breakpoint this story deliberately keeps in the stylesheet (and which `workbench-split.test.ts` bans by name). Whether that trade is worth making belongs with whichever story revisits the left column's responsive behaviour.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-split-divider-target-and-responsiveness
decision: 2026-08-17 Allow one shared breakpoint constant — Introduce a single exported breakpoint constant consumed by both the stylesheet build and TreePanel's matchMedia listener, add the listener to both scroll effects so the live 900px transition restores and records the offset, and retarget the workbench-split.test.ts ban to forbid ad-hoc duplicate literals rather than the shared constant.
decision: 2026-08-16 Allow one shared breakpoint constant — Introduce a single exported breakpoint constant consumed by both the stylesheet build and TreePanel's matchMedia listener, add the listener to both scroll effects so the live 900px transition restores and records the offset, and retarget the workbench-split.test.ts ban to forbid ad-hoc duplicate literals rather than the shared constant.

### DW-48: A refresh whose server re-render still reads the OLD version strands that version: `refreshedFor` has already advanced, so it is never retried.
origin: spec-deferred 50d952f5c317
location: src/components/workbench/DataVersionWatcher.tsx (run), src/lib/workbench-data-version.ts (shouldRefreshForDataVersion)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: `DataVersionWatcher` sets `refreshedForRef.current = result.version` before `router.refresh()` and never checks that the new render's `dataVersion` caught up. Both reads go through the same Worker, so the window is narrow — but if the RSC read answers the pre-bump integer, `served` stays behind while `refreshedFor` is ahead, and `shouldRefreshForDataVersion` returns `false` for that version forever; the trees then wait for the NEXT write. The obvious fix is not obviously right: dropping the guard restores the unbounded re-render loop it exists to prevent (a degraded `page.tsx` read stuck at 0 against a route answering 7 would refresh every tick, forever), so closing this needs a bounded retry policy — how many attempts, how long to wait for the baseline to move — which is a refresh-policy decision for whichever story next revisits the signal (Epic 2's Ingest is its first real consumer).
status: done 2026-08-21
resolution: resolved by sweep bundle dw-data-version-refresh-retry

### DW-49: Writes that bypass `runPageLifecycleOp` — template seeding of `purpose.md` and `schema.md`, raw source files — never move the signal.
origin: spec-deferred 53e5882c5f58
location: src/lib/wikis.ts (seedWikiArtifacts), src/lib/lifecycle.ts (runPageLifecycleOp)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: The bump is at the kernel pipeline's tail, which is what the story's `When` clause names, and `seedWikiArtifacts` (`wikis.ts:280`) writes through `storage.writeFile` instead. Creating a Wiki is covered because `WikiSwitcher` still calls `router.refresh()` itself, but a confirm-gated template RE-APPLY, and any later writer that lands bytes the Files tab renders, would leave a second open tab stale. Story 1.8 routes Schema edits through the kernel write path, at which point that half needs nothing; the open question is only whether seeding and template re-apply should bump too, and that belongs with whichever story owns those flows.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-artifact-seed-data-version-bump

### DW-50: A silent same-row refresh swaps the Preview's body with no announcement, so a screen-reader user reading it is not told the content changed.
origin: spec-deferred 6d3ef6e9607b
location: src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: Before this story the body changed only when the owner picked a row, which is their own action. A bump from another actor now replaces it underneath them, and `PreviewColumn` has no live region. The epic's accessibility floor already says mode changes announce the surface name, so the same argument applies here — but any announcement is a new authored sentence, and the epic's Copy table is the only place a Workbench sentence may be born. That makes it a copy decision rather than a wiring fix, and it belongs with whichever story next opens that table for the Preview column.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-workbench-preview-announcements
decision: 2026-08-16 Author and wire — Add a 'Preview updated'-style sentence to the epic's Copy table and announce it from the fetch effect's response handler when a silent same-row refresh replaces rendered content.

### DW-51: `PUT /api/wiki/[slug]` carries no `If-Match` precondition, so the Preview editor silently clobbers a write another actor made while it was open.
origin: spec-deferred d5ca34c088fa
location: src/app/api/wiki/[slug]/route.ts (PUT), src/lib/workbench-preview.ts (savePreviewBody)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: Pre-existing — the write path has never had one — but this story makes the race visible for the first time by teaching the shell to notice other actors' writes, and it deliberately does NOT disturb an open editor, so the draft can now be knowingly stale. The read side already supports the primitive (`readFileWithEtag` / `writeFileIfMatch` in `storage/types.ts`); what is missing is a version on the preview payload, a precondition on the route, and a decision about what the column shows when it fails. That is a whole conflict-handling design, not a patch.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-write-preconditions-and-conflict-surface

### DW-52: The watcher's effect lifecycle — poll cadence, visibility gating, abort, teardown — is verified only by matching strings in its own source.
origin: spec-deferred 90233d0f0577
location: vitest.config.ts, src/components/workbench/DataVersionWatcher.tsx, src/lib/__tests__/workbench-data-version.test.ts
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: `vitest.config.ts` is `environment: "node"` and the repo has no jsdom, happy-dom, Testing Library or React test plugin, so no suite renders a component, mounts an effect, advances a timer or dispatches a `visibilitychange`. The story's decisions were extracted into pure functions precisely to work around this, and that half IS executed — but "a backgrounded tab does not poll", "becoming visible checks immediately", "one AbortController per run" and "full teardown in the cleanup" are runtime claims pinned by `expect(source).toContain( "clearInterval(timer)")` and friends. Those assertions survive a broken rewrite and break on a reflow. This pass patched the two places where a one-character inversion stayed green (the refresh guard's `!` and the two `setFailed` branches), but the remedy for the class is a DOM test environment, which is a project-level dependency and CI decision rather than something one story should take unilaterally.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-dom-test-environment

### DW-53: A page another actor deletes now disappears from the trees mid-session while the docked selection survives, leaving no row marked current.
origin: spec-deferred a8eec345e2bd
location: src/components/workbench/Workbench.tsx (the selection reset effect), src/lib/workbench-tree.ts (selectionExists)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: Before this story the trees only changed under a `WikiSwitcher` refresh, which also changes `currentWikiId` and so re-runs the selection reset at `Workbench.tsx:194-203`; `restorableSelection` / `selectionExists` are reached only from the `[]` mount effect (`:173`). A watcher-driven refresh changes neither, so the selection outlives the row: the Preview stays docked showing `PREVIEW_FAILED_COPY` (truthful) while no tree row carries `aria-current` — the state Story 1.6's `selectionExists` docblock names as "a shell that looks broken rather than one that forgot". Reconciling a live selection against a refreshed tree is a design decision (does the shell silently undock, fall back to the sibling row, or say something?) and the last of those needs a sentence from the epic's Copy table, so it belongs with whichever story next opens it.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-workbench-preview-announcements
decision: 2026-08-17 Undock and announce — Reconcile a live selection against a refreshed tree: when the selected row is gone, undock the Preview and announce a new Copy-table sentence through the shell's existing polite live region, so the change is neither silent nor mistaken for a broken column. Thread the reconciliation without growing the reset effect's pinned deps.
decision: 2026-08-16 Undock and announce — Reconcile a live selection against a refreshed tree: when the selected row is gone, undock the Preview and announce a new Copy-table sentence through the shell's existing polite live region, so the change is neither silent nor mistaken for a broken column. Thread the reconciliation without growing the reset effect's pinned deps.

### DW-54: A silent refresh cannot tell "another actor deleted this page" from "the network blipped", so a transient failure replaces the page the owner is reading with the failure copy and does not heal itself.
origin: spec-deferred de2abf5767d2
location: src/lib/workbench-preview.ts (fetchPreview, previewBodyState), src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: `fetchPreview` (`workbench-preview.ts:344-364`) collapses 404, 500, a malformed body, the `REQUEST_TIMEOUT_MS` deadline and a bare transport failure into one `{ status: "failed" }`, and `previewBodyState` (`workbench-preview.ts:152-155`) puts `failed` AHEAD of a payload that is still held. Before this story the flag could only be set right after an explicit pick, behind a `Loading…` the owner had just caused. A silent same-row refresh sets it with `plan.reset === false`, so a page jumps straight from rendered bytes to `PREVIEW_FAILED_COPY` for a reason the owner did not initiate — and because the effect re-runs only on `[selection, dataVersion, editing]`, it stays that way until the next bump or until they click elsewhere and back. The spec's rule ("a failed silent refresh still tells the truth, because a page another actor just deleted must not keep rendering as if it were there") is right about deletion and is what makes the conflation visible; separating "gone" from "could not reach
status: done 2026-08-17
resolution: resolved by sweep bundle dw-workbench-preview-announcements
decision: 2026-08-17 Separate gone from unreachable — Have fetchPreview report 404 separately from transport and timeout failures. On a silent same-row refresh, a 404 replaces the body with the existing gone copy, while an unreachable answer keeps the last-good bytes and shows a transient, self-healing indicator with a retry. Author the one new sentence this needs in the epic's Copy table.
decision: 2026-08-16 Separate gone from unreachable — Have fetchPreview report 404 separately from transport and timeout failures. On a silent same-row refresh, a 404 replaces the body with the existing gone copy, while an unreachable answer keeps the last-good bytes and shows a transient, self-healing indicator with a retry. Author the one new sentence this needs in the epic's Copy table.

### DW-55: Follow-up review still recommended for 1-7-dataversion-workbench-refresh after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-56: The Schema write has no lost-update protection, so an editor left open across another actor's save silently clobbers it.
origin: spec-deferred 078a87eb5dc9
location: src/app/api/workbench/artifact/route.ts, src/lib/wikis.ts (writeWikiArtifact)
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: `PUT /api/workbench/artifact` carries no ETag, no `If-Match` and no `updatedAt` precondition, and `writeWikiArtifact` stores the body unconditionally. Story 1.7's refresh deliberately does not disturb an open editor, so a draft can legitimately outlive several bumps and then overwrite them. `PUT /api/wiki/[slug]` has the same property — this is the inherited pattern, not a new one — but the artifact is the single file every ingest, chat and lint prompt reads, so the blast radius is larger. The storage contract already exposes a compare-and-set write; what is missing is a version on the payload and a decision about what the column shows on conflict, which is the same conflict-surface design spec-1-7 deferred for the Preview.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-write-preconditions-and-conflict-surface

### DW-57: A Preview left open on `schema.md` across a Scenario Template re-apply shows pre-template bytes, and saving them silently reverts the re-apply.
origin: spec-deferred a5eae62be08b
location: src/lib/wikis.ts (seedWikiArtifacts / applyScenarioTemplate), src/components/workbench/PreviewColumn.tsx
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: `applyScenarioTemplate` rewrites `schema.md` through `seedWikiArtifacts`, which by this spec's own Never list does not bump `dataVersion` (DW-49). `PreviewPane`'s fetch effect re-runs only on `[selection, dataVersion, editing]`, and a re-apply moves none of the three — the Wiki id, the mode and the tree tab are unchanged, so `Workbench`'s selection-reset effect does not fire either. Before this story that stale column was read-only; it is now writable, so Edit → Save writes the pre-template Schema back over the freshly seeded one with a success message. Closing it means deciding whether seeding and re-apply bump the counter, which belongs with the story that owns those flows.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-artifact-seed-data-version-bump

### DW-58: FR-34's other half is still unbuilt — `purpose.md` is editable from no surface, and the narrow allowlist now pins that shut.
origin: spec-deferred d9e12a049e09
location: src/lib/wiki-scenarios.ts (EDITABLE_ARTIFACT_FILES)
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: PRD FR-34 reads "Christian can view/edit purpose and Schema from Settings or Wiki tree", and the UX run names both files. This story's acceptance covers Schema alone, so the exclusion is correct here — but it is now an asserted invariant (`expect(EDITABLE_ARTIFACT_FILES).not.toContain( "purpose.md")`), so a later story must edit a test to open it. Opening it also needs an answer to what `purpose.md` must contain to be valid (the Schema's `hasPageConventions` has no analogue) and to how it reconciles with the tenant-global workspace profile (DW-14, DW-21), which is why it was not simply widened here.
status: open
decision: 2026-08-16 Wait for DW-14

### DW-59: An overwritten Schema has no recovery path — the artifact write takes no revision snapshot, while the page write it is modelled on does.
origin: spec-deferred 3d268db29649
location: src/lib/wikis.ts (writeWikiArtifact / putWikiArtifact), src/lib/revisions.ts
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: `writeWikiPageWithSideEffects` calls `saveRevision(slug, existing, …)` (`src/lib/wiki.ts:442`) before it overwrites, and `GET/POST /api/wiki/[slug]/revisions` can revert a page. `writeWikiArtifact` writes through `putWikiArtifact` with no prior read and no snapshot, so the previous `schema.md` is simply gone. That was harmless while the file was seed-only and immutable; it is not once the file is editable, and this is the single file every ingest, chat and lint prompt reads. The story's Design Notes deliberately enumerate the artifact tail as log + bump, so this is a decided omission rather than a missed one — but revisioning is not an index/backlink concern the artifact class lacks, it is the recovery path, and closing it needs a decision about where artifact revisions live (the `revisions/` silo is slug-keyed) that this story does not own.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-per-wiki-artifact-revisions
decision: 2026-08-17 Per-Wiki artifact revisions — Snapshot artifacts under their own per-Wiki revision namespace (tenants/<t>/wikis/<id>/revisions/<file>/), read-before-write in writeWikiArtifact, and expose list/revert through the artifact route mirroring the page revisions API. Keeps the slug-keyed revisions silo untouched.
decision: 2026-08-16 Per-Wiki artifact revisions — Snapshot artifacts under their own per-Wiki revision namespace (tenants/<t>/wikis/<id>/revisions/<file>/), read-before-write in writeWikiArtifact, and expose list/revert through the artifact route mirroring the page revisions API. Keeps the slug-keyed revisions silo untouched.

### DW-60: Follow-up review still recommended for 1-8-edit-schema after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-8-edit-schema.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-61: The legacy `/settings` page now offers `Custom` in its provider picker but has no base-URL or key field for it, so selecting it there stores a provider no LLM call can construct.
origin: spec-deferred 172fbd06f98e
location: src/components/ProviderForm.tsx:47, src/lib/providers.ts (PROVIDER_INFO)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `custom` was added to the shared `PROVIDER_INFO`, which `src/components/ProviderForm.tsx:47` spreads into the legacy page's dropdown; that form renders conditional fields only for `ollama` and `ollama-cloud`. Saving `provider: "custom"` there leaves `getModel()` throwing "The Custom provider needs a base URL. Set it in Settings → LLM Models." — actionable, and recoverable from the Workbench surface, which is why it was not patched here: this story's spec forbids modifying `ProviderForm` or the legacy route, and the honest fix is either to give that form the two fields or to retire the page.
status: done 2026-08-20
resolution: resolved by sweep bundle dw-legacy-settings-surface-parity
decision: 2026-08-18 Fix the `custom` gap in place, keep the page — Supersedes the 2026-08-16/17 "Retire the legacy page" decisions, whose premise was false: the Workbench Settings surface does NOT cover the primary provider/model pair. `SettingsCanvas.tsx` `llm-models` offers only chat/ingest providers and models, the custom endpoint and the timeout, and neither `SettingsDraft` nor `WorkbenchSettingsPatch` in `workbench-settings.ts` carries a top-level `provider`/`model` key, so it cannot write the pair even in principle — while `config.ts` `getResolvedCredentials()` reads `cfg.provider` first and every non-workload `callLLM` resolves through `getModel()` built from it, and an unset chat/ingest provider deliberately falls back to it (`llm.ts` `usesPrimary`). `ProviderForm` is the only editor for the pair anywhere, so deleting the route removes the only way to configure it. Retirement also stays blocked on five sections with no Workbench equivalent (StructuredKnowledge, the rebuild-embeddings control, NamesTerms, EmailIngest, VaultExport) whose replacements `epics.md:170` schedules for later epics, and on live inbound links from `NavHeader.tsx`, `ActionInbox.tsx`, `KnowledgeStudio.tsx`, `error-hints.ts` and `cli.ts`. SCOPE NOW: keep the `/settings` route, `ProviderForm` and the tests that pin them exactly as they are, and close only the reported defect — when the selected provider is `custom`, `ProviderForm` renders an inline note directing the owner to Workbench Settings → LLM Models → Custom endpoint for the base URL and API key, so the form no longer silently saves a provider no LLM call can construct. Do NOT add `customBaseUrl`/`customApiKey` inputs to `ProviderForm`: the Workbench surface already writes those two fields, and a second editor for them would extend DW-63's lost-update gap to cover them. Do NOT delete or redirect the route, and do NOT add the primary pair to the Workbench surface — that changes the settings contract `spec-1-9` froze and is a separate, story-sized change.

### DW-62: The `g s` keyboard shortcut still routes out of the shell to the legacy Settings page, doing exactly the route change the rail control stopped doing.
origin: spec-deferred cbeb1a3bf4ed
location: src/hooks/useKeyboardShortcuts.ts:46,161
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `src/hooks/useKeyboardShortcuts.ts:46` maps `g s` to `/settings` and dispatches it with `router.push`, and `KeyboardShortcutsProvider` wraps the Workbench. So from inside the shell the keyboard path unmounts everything above the canvas and lands on a page with none of this story's categories, while the rail button opens the in-shell surface. `keyboard-shortcuts.test.ts:102,203` pin the old route, and this story is forbidden from editing pre-existing test files beyond the one rail pin — closing it means deciding whether the shortcut opens the surface or the legacy page stays a legitimate target.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-workbench-client-state-and-nav
decision: 2026-08-18 Retarget to the in-shell surface — Change `g s` to select the Workbench's Settings mode instead of pushing `/settings`, so the keyboard path matches the rail control and never unmounts the shell, and retarget the `keyboard-shortcuts.test.ts` pins at :102-105 and :203. Unchanged from the 2026-08-16/17 decisions EXCEPT that it no longer rides on retiring the legacy page: DW-61 now keeps `/settings` (see its 2026-08-18 decision), and this entry stands on its own — the rail/keyboard inconsistency is real either way, and the legacy page stays reachable through the `NavHeader.tsx` links, so nothing is orphaned. Land it independently of DW-61; do not delete or redirect the `/settings` route as part of this change.

### DW-63: Two live Settings surfaces now write one config file with no lost-update protection between them.
origin: spec-deferred b1364ed893f7
location: src/app/api/settings/route.ts, src/lib/config.ts (saveConfig)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: Both the new surface and `/settings` read-modify-write the same `AppConfig` through `loadConfig` → merge → `saveConfig`, with no `If-Match`, no version and no lock. A draft seeded before the other surface (or another tab) saved will overwrite it silently on the next Save. This is the same lost-update shape already recorded for the page and artifact writes (DW-38, DW-51, DW-56) rather than a new mechanism, and closing it needs the conflict-surface design those entries are waiting on.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-write-preconditions-and-conflict-surface

### DW-64: The configured deadline bounds a whole STREAM on `callLLMStream`, and a deadline that fires surfaces raw transport vocabulary.
origin: spec-deferred 0d779aa5cece
location: src/lib/llm.ts (callLLMStream, timeoutOption)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `callLLMStream` is not retry-wrapped, so its single `AbortSignal.timeout` measures total stream duration rather than time-to-first-response: a 30s deadline set to catch hangs would truncate every answer that takes longer than 30s to finish. Separately, `AbortSignal.timeout` raises a `TimeoutError` whose message matches none of `RETRYABLE_MESSAGES`, so it propagates verbatim — "The operation was aborted due to timeout" is exactly the transport vocabulary this repo's copy rules exclude. Both need Chat's streaming semantics (Epic 3) to decide what a deadline means for a stream and which sentence the owner should see.
status: open
decision: 2026-08-21 Keep deadline, fix the copy — Leave the whole-stream deadline as the frozen decision has it and only map TimeoutError/AbortError to an owner-facing sentence in src/app/api/query/stream/route.ts, with a test pinning it.
decision: 2026-08-20 Keep deadline, fix the copy — Leave the whole-stream deadline as the frozen decision has it and only map TimeoutError/AbortError to an owner-facing sentence in src/app/api/query/stream/route.ts, with a test pinning it.

### DW-65: On a read-only deployment the Settings selects and checkbox are `disabled`, which takes them out of the tab order, so a keyboard user cannot even read the stored provider.
origin: spec-deferred e6bf2b886405
location: src/components/workbench/SettingsCanvas.tsx
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: Text inputs use `readOnly` (focusable, still readable) while selects and the vector checkbox use `disabled`, because HTML has no `readonly` for either. The accessible fix is `aria-disabled` plus a suppressed change handler, and it wants one decision applied to every control class in the shell rather than one made inside this surface.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-read-only-deployment-consistency

### DW-66: `hasCustomApiKey` / `hasFirecrawlApiKey` conflate an env-supplied key with a stored one, so `Remove` is offered for keys it cannot remove.
origin: spec-deferred a152dc3b5b3f
location: src/lib/config.ts (getWorkbenchSettings), src/components/workbench/SettingsCanvas.tsx
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `apiKeyForProvider("custom")` and `getFirecrawlSettings().hasKey` both count `LLM_CUSTOM_API_KEY` / `FIRECRAWL_API_KEY` alongside the stored value, and the surface renders "A key is stored." plus a `Remove` button from that one boolean. Pressing Remove on an env-supplied key clears nothing and the sentence does not change. The embeddings half of this was closed in the patch pass (`hasEnvEmbeddingApiKey` rides separately); the same split for the other two was left out to keep the payload from growing again.
status: open

### DW-67: Edits typed while a save is in flight are discarded when the response re-seeds the draft.
origin: spec-deferred 7fd1f35ba122
location: src/components/workbench/SettingsCanvas.tsx (save)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `save` re-seeds the whole draft from the stored values the route answers with, which is what clears `dirty` — but the fields stay editable during the request, so anything typed in that window is replaced without a word. The alternatives (freeze the form while saving, or merge only untouched fields) are both behavioural choices this story's acceptance does not settle.
status: open

### DW-68: Storing an embedding key through the new surface flips `hasEmbeddingSupport()` on for the existing ingest caller even with vector search switched off.
origin: spec-deferred 050a745f1202
location: src/lib/embeddings.ts:139 (embeddingApiKeyFor), src/lib/ingest.ts:989
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `embeddingApiKeyFor` now falls back to `loadConfigSync().embeddingApiKey` (which the spec's Execution list requires, or the three stored vector values would have no reader at all). `hasEmbeddingSupport()` → `getEmbeddingModelName()` → `resolveEmbeddingProvider()` → `embeddingApiKeyFor()`, so an owner who pastes a key into Settings → Embeddings and leaves the switch off — the story's headline default — turns `ingest.ts:989` from off to on. Nothing fails: `embeddings.test.ts` drives that path from env vars, which are unchanged. The epic assigns "embed after ingest only when vector is on" to Story 2.9 and the spec's Never list forbids gating the callers here, so closing it is that story's work.
status: open

### DW-69: One `embeddingApiKey` is shared by both keyed embedding vendors, so switching provider silently reuses the other vendor's key.
origin: spec-deferred bddb90da84c0
location: src/lib/embeddings.ts:139, src/lib/config.ts (getWorkbenchSettings)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `embeddingApiKeyFor` reads the same stored value for `openai` and `google`, and `settingsSaveBody` omits an untouched secret — so an owner who stored an OpenAI key and then picks Google sends that key to Google while the hint still reads "A key is stored." Keying the field per provider (or labelling which vendor the stored key belongs to) is a store-shape decision this story's acceptance does not settle; the vector gate's env leg was made provider-aware in this pass, but the STORED key deliberately stayed vendor-agnostic so a provider changed in the draft can still answer the gate before it is saved.
status: open
decision: 2026-08-21 Clear the key on switch — Drop the stored embedding key and its has* flag whenever the embedding provider changes, so a switch never reuses another vendor's secret; no stored shape change, and the owner re-enters the key for the new vendor.
decision: 2026-08-20 Clear the key on switch — Drop the stored embedding key and its has* flag whenever the embedding provider changes, so a switch never reuses another vendor's secret; no stored shape change, and the owner re-enters the key for the new vendor.

### DW-70: The Embeddings category offers an endpoint field that is never read for `ollama` or `workers-ai`.
origin: spec-deferred 9c4aafe22ebe
location: src/lib/embeddings.ts:228-247, src/components/workbench/SettingsCanvas.tsx
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `_createEmbeddingModel` applies `config.embeddingBaseUrl` for `openai` and `google` only; `ollama` reaches its server through `getOllamaBaseUrl()` and `workers-ai` through the Cloudflare binding. The vector gate agrees (both are in `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` and are not asked for an endpoint), so nothing is broken — but the field still accepts a value that goes nowhere. Hiding it per provider, or routing `ollama`'s embedding endpoint through it, both change what `ollamaBaseUrl` means and want one decision rather than a fix inside this surface.
status: open

### DW-71: `LLM_CUSTOM_BASE_URL` wins at runtime but is invisible on the surface, so the Custom endpoint box can be typed into and saved with no effect.
origin: spec-deferred 982384b4e50e
location: src/lib/config.ts (getWorkbenchSettings, getCustomBaseUrl), src/components/workbench/SettingsCanvas.tsx
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `getCustomBaseUrl()` resolves `nonEmpty(process.env.LLM_CUSTOM_BASE_URL) ?? nonEmpty(cfg.customBaseUrl)`, while `getWorkbenchSettings()` serves `customBaseUrl: nonEmpty(cfg.customBaseUrl)` — the STORE only. A deployment that sets the env var therefore renders an empty endpoint box; the owner types a URL, the save succeeds, and the runtime keeps using the variable. This is exactly the failure the follow-up pass fixed for embeddings with `settingsEnvOverrideCopy` / `envEmbeddingModel`, and closing it the same way means another payload field plus another copy function — worth doing beside the already-recorded `hasCustomApiKey` env/store split rather than as a third separate touch of the same rows.
status: done 2026-08-20
resolution: resolved by sweep bundle dw-settings-config-resolution-hardening

### DW-72: One stored `embeddingBaseUrl` is handed to whichever embedding provider is active, so an endpoint entered for OpenAI is sent to Google after a switch.
origin: spec-deferred 1ed1cc09bf7d
location: src/lib/embeddings.ts:228-238 (_createEmbeddingModel)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `_createEmbeddingModel` reads `loadConfigSync().embeddingBaseUrl` and applies it to the `openai` and `google` branches alike, with nothing tying the value to the provider it was typed for. This is the endpoint twin of the already-recorded vendor-agnostic `embeddingApiKey`, and it has the same resolution: keying the field per provider is a store-shape decision this story's acceptance does not settle. Nothing breaks today — the pair is usually changed together — but the silent reuse is real.
status: open
decision: 2026-08-21 Clear the base URL on switch — Clear the stored embeddingBaseUrl whenever the embedding provider changes, so an endpoint typed for one vendor is never sent to another; no stored shape change.
decision: 2026-08-20 Clear the base URL on switch — Clear the stored embeddingBaseUrl whenever the embedding provider changes, so an endpoint typed for one vendor is never sent to another; no stored shape change.

### DW-73: A `workers-ai` embedding model outside the `@cf/` namespace satisfies the vector gate and is then silently discarded at resolution time.
origin: spec-deferred e96831d64aed
location: src/lib/workbench-settings.ts:427-440, src/lib/embeddings.ts (resolveEmbeddingModelName)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `canEnableVectorSearch` asks `workers-ai` for a provider and a model only (it is keyless and self-transporting), so `{ provider: "workers-ai", model: "text-embedding-3-small" }` turns the switch on. `resolveEmbeddingModelName` then rejects the same value for a namespace mismatch and falls back to `@cf/baai/bge-m3`. The owner's model choice is replaced without a word. The namespace guard is pre-existing; teaching the gate about it means deciding whether the surface refuses the model, rewrites it, or narrows the picker.
status: done 2026-08-18
resolution: resolved by sweep bundle dw2-workers-ai-embedding-namespace
decision: 2026-08-17 Validate at the surface — Teach canEnableVectorSearch the provider's namespace rule so a workers-ai model outside @cf/ fails validation with an explanatory message on the Settings surface, instead of enabling the switch and being discarded later at resolution time.
decision: 2026-08-16 Validate at the surface — Teach canEnableVectorSearch the provider's namespace rule so a workers-ai model outside @cf/ fails validation with an explanatory message on the Settings surface, instead of enabling the switch and being discarded later at resolution time.

### DW-74: Follow-up review still recommended for 1-9-settings-for-models-and-embeddings after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-75: LintFilterControls.tsx keeps a hand-copied ALL_CHECK_TYPES with only 11 entries while the lib const in lint-checks.ts has 14, so the lint UI cannot toggle uncited-claims, supersedes-dangling, or incom
origin: spec-deferred e4d2cbfe1b61
source_spec: `spec-retire-dead-machinery.md`
location: src/components/LintFilterControls.tsx:5
severity: medium
reason: Pre-existing drift, not introduced here: src/components/LintFilterControls.tsx:5-16 lacks uncited-claims, supersedes-dangling, incomplete-coverage; src/lib/lint-checks.ts ALL_CHECK_TYPES has 14 entries; no parity test ties the two constants together.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-lint-check-parity-and-disputed-surface

### DW-76: The disputed frontmatter flag is now one-way — ingest still sets disputed: true on contradicting merges and ArticleView still renders the disputed banner, but with reconcile-from-talk and the disputed
origin: spec-deferred 78f255fc65a4
source_spec: `spec-retire-dead-machinery.md`
location: src/lib/ingest.ts
severity: medium
reason: src/lib/ingest.ts parseDisputedMarker still sets the flag; src/components/ArticleView.tsx still renders the "This page is disputed" banner; the bundle intent explicitly directed deleting checkDisputedPages, so the surfacing gap is a knowing consequence to revisit with whatever story owns disputed-page semantics.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-lint-check-parity-and-disputed-surface
decision: 2026-08-17 Re-surface disputed pages — Give the flag a read model and a way out: a lint check or Workbench view listing disputed pages, and an owner action that clears the flag after review. Restores the loop that reconcile-from-talk used to close, without reviving talk.
decision: 2026-08-16 Re-surface disputed pages — Give the flag a read model and a way out: a lint check or Workbench view listing disputed pages, and an owner action that clears the flag after review. Restores the loop that reconcile-from-talk used to close, without reviving talk.

### DW-77: authz.ts still carries the commons-realm delete-deny branch with no commons behind it; after this change the client delete gate no longer mirrors it for a hypothetical non-admin owner of a public page
origin: spec-deferred a067ea608790
source_spec: `spec-retire-dead-machinery.md`
location: src/lib/authz.ts:193
severity: low
reason: src/lib/authz.ts:193-198 denies body/delete on belongsInCommons pages for non-service, non-admin principals, pinned by authz.test.ts:228-231; DW-6's ledger explicitly kept delete authorization out of scope, so the server-side realm residue remains dead machinery.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-authz-commons-realm-cleanup

### DW-78: HomeGraph.tsx had zero references already at the baseline revision — a pre-existing dead component, not orphaned by this story (unlike HomeAsk.tsx, which this story deleted).
origin: spec-deferred 05b39e1a7083
source_spec: `spec-retire-dead-machinery.md`
location: src/components/HomeGraph.tsx
severity: low
reason: git grep HomeGraph at baseline 1aac75ea returns no references outside the component file itself.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery-round-2

### DW-79: The orchestrator's ledger sweep truncates entry headings at a fixed width mid-word — DW-75's heading in deferred-work.md ends "or incom" and DW-76's ends "and the disputed", and DW-75's useLint-length
origin: spec-deferred 5e93c57512b0
source_spec: `spec-retire-dead-machinery.md`
location: _bmad-output/implementation-artifacts/deferred-work.md:609
severity: low
reason: _bmad-output/implementation-artifacts/deferred-work.md:609 and :617 carry the truncated headings; the entries' reason fields hold the evidence text, not the lost summary tails. Ledger entries are orchestrator-owned (invocation constraint), so this pass records the defect instead of editing them.
status: done 2026-08-16
resolution: closed by human decision: Cosmetic and self-limiting: the reason field of each entry carries the full evidence, the two affected headings remain identifiable, and the writer lives outside the product codebase this loop builds.
decision: 2026-08-16 Accept it — Cosmetic and self-limiting: the reason field of each entry carries the full evidence, the two affected headings remain identifiable, and the writer lives outside the product codebase this loop builds.

### DW-80: workers/task-consumer docs still describe reconcile as live work — its README walks through "reconcile a page from a discussion thread" and index.ts's header says the actual work is "(reconcile / inge
origin: spec-deferred 72b5e66c4034
source_spec: `spec-retire-dead-machinery.md`
location: workers/task-consumer/README.md:9
severity: medium
reason: workers/task-consumer/README.md:9 and :35 plus workers/task-consumer/index.ts:6 reference the retired reconcile task kind; the spec's "verified: no reconcile/publish references" parenthetical covered live code paths, not docs and comments. Intent Never: "Do not touch workers/task-consumer/".
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery-round-2

### DW-81: talk.ts getDiscussionStats is newly orphaned by this story — its last production callers were the deleted discussion lint checks — and reports green under talk.test.ts with no reachable caller; the ba
origin: spec-deferred 327d8597cfc7
source_spec: `spec-retire-dead-machinery.md`
location: src/lib/talk.ts:342
severity: low
reason: grep after this change shows no non-test caller of getDiscussionStats; talk.ts itself is intent-protected ("Do not delete src/lib/talk.ts"; AD-21 deliberately keeps talk machinery on disk), so whether to trim the export or leave it as deliberate AD-21 residue belongs to a story that owns talk.ts.
status: done 2026-08-16
resolution: resolved by sweep bundle dw-retire-dead-machinery-round-2

### DW-82: Follow-up review still recommended for dw-retire-dead-machinery after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-retire-dead-machinery.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-83: MarkdownRenderer call sites outside the intent's component list still emit DEFAULT_TENANT wikilinks for in-content [x](slug.md) targets, taking the wrong-handle 308 hop the named components were just
origin: spec-deferred 9c6585bd571d
source_spec: `spec-owner-scoped-linking.md`
location: src/components/QueryResultPanel.tsx:182
severity: medium
reason: QueryResultPanel.tsx:182 renders query answers (which cite [Title](slug.md) per src/lib/query.ts:62) without passing slugTenants even though the component already calls useSlugTenants for its source chips — a one-line adoption; RawSourceBrowser.tsx:90, SlidePreview.tsx:61,77, AgentApiContent.tsx:45 and src/app/wiki/log/page.tsx:66 render with no map either. All pre-date this change; the intent's component list (union of DW-2 and the bundle intent) does not include them.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-owner-scoped-link-and-notfound-hardening

### DW-84: The edit and raw owner-scoped routes do not alias-forward merged-away slugs, so an old /u/<handle>/<slug>/edit bookmark 404s where the page-view URL now forwards.
origin: spec-deferred 7e750d1a36d0
source_spec: `spec-owner-scoped-linking.md`
location: src/app/u/[handle]/[slug]/edit/page.tsx
severity: low
reason: aliasRedirectForMissing is wired only into src/app/u/[handle]/[slug]/page.tsx; the edit and raw routes keep their pre-existing hard-404 miss behavior. Pre-existing asymmetry surfaced by this change; the intent names only the owner route's page-view miss path.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-owner-scoped-link-and-notfound-hardening

### DW-85: The owner route's "Page not found" UI is rendered as a normal HTTP 200 response instead of signalling notFound(), so dead slugs (including alias candidates that fail the forwarding guard) are indexabl
origin: spec-deferred 7952daea88ca
source_spec: `spec-owner-scoped-linking.md`
location: src/app/u/[handle]/[slug]/page.tsx:75
severity: low
reason: The miss branch of src/app/u/[handle]/[slug]/page.tsx returns JSX directly rather than calling next/navigation notFound(); pre-existing behavior that this change extends but did not introduce.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-owner-scoped-link-and-notfound-hardening

### DW-86: Converted components' rendered anchors have no executable coverage: reverting any one call site to slugPath (or dropping a slugTenants renderer prop) passes the whole suite, so the story's component-s
origin: spec-deferred 7eeab2ede4b6
source_spec: `spec-owner-scoped-linking.md`
location: vitest.config.ts
severity: medium
reason: vitest.config.ts runs node-only with include src/**/__tests__/**/*.test.ts (no .tsx), and package.json carries no jsdom or @testing-library dependency, so no test can render the six converted "use client" components; ChatWorkspace's saved-banner url fallback and VaultExplorer's owner-direct link are likewise unasserted. The hook's render contract is now pinned via react-dom/server, but per-component adoption above it is not. Surfaced by this story's review; the missing client-component harness pre-dates the story and adopting one is a project-level decision.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-polling-and-shell

### DW-87: loadSlugTenants caches a non-OK response's empty map for the whole session (no retry) while a rejected fetch is retried, so one transient 401/429/500 from /api/wiki/routes pins DEFAULT_TENANT fallback
origin: spec-deferred e1b670ffa4b7
source_spec: `spec-owner-scoped-linking.md`
location: src/hooks/useSlugTenants.ts
severity: low
reason: In src/hooks/useSlugTenants.ts the non-OK branch's {} flows into the .then that assigns cache, so cache = {} permanently; the .catch path returns {} without assigning cache, so the next caller re-fetches. Byte-identical logic pre-dates this story (only renamed/exported here). Links still work via the 308 fallback, so the consequence is a session of wrong-handle hrefs, not breakage.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-owner-scoped-link-and-notfound-hardening

### DW-88: getAliasIndex caches only successful builds, so while any page file has malformed frontmatter every missing-slug request re-runs the full wiki scan behind aliasRedirectForMissing before failing closed
origin: spec-deferred 30b195a5eb4f
source_spec: `spec-owner-scoped-linking.md`
location: src/lib/alias-index.ts:107
severity: low
reason: buildAliasIndex sets cachedIndex only after a complete scan (src/lib/alias-index.ts:100) and getAliasIndex re-invokes it whenever cachedIndex is null, so a mid-loop parse throw leaves nothing cached and the next miss-path request re-scans. The cache-only-on-success behavior pre-dates this story; the owner route's miss path is merely its first routing caller, and the proper fix (failure caching or a cooldown) lives in alias-index.ts, which the intent walls off ("Never: Change resolveAlias / alias-index semantics"). Consequence is bounded: the scan is one readdir plus frontmatter parses, aborts at the corrupt file, and each failure is now logger.warn-visible.
status: done 2026-08-19
resolution: closed by human decision: The cost is one directory scan per missing-slug request, only while a page file is malformed, and honouring the frozen instruction is worth more than the saving.
decision: 2026-08-19 Accept the rescan — The cost is one directory scan per missing-slug request, only while a page file is malformed, and honouring the frozen instruction is worth more than the saving.

### DW-89: SlugTenantMap lookups use plain inherited-prototype indexing, so a slug naming an Object.prototype member (a page titled "Constructor" slugifies to "constructor") resolves to the inherited function an
origin: spec-deferred 8c3a40745345
source_spec: `spec-owner-scoped-linking.md`
location: src/lib/links.ts:157
severity: low
reason: resolveSlugPath does slugTenants?.[slug] ?? fallbackTenant (src/lib/links.ts:157) and the map is parsed response JSON, whose objects inherit Object.prototype — map["constructor"] is a function, which ?? does not filter, so pagePath receives it and tenantSegment calls .trim() on a function (TypeError) wherever such a slug renders as a link. The lookup idiom is byte-identical to the pre-story hook and MarkdownRenderer paths; this story only spread the same map to more call sites. Requires a page slug colliding with an Object.prototype member, hence low.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-owner-scoped-link-and-notfound-hardening

### DW-90: Follow-up review still recommended for dw-owner-scoped-linking after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-owner-scoped-linking.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-91: tools/WORKWIKI_SYNC.md filename still carries the old WORKWIKI brand after the sweep.
origin: spec-deferred 2182a48bb95c
source_spec: `spec-maintainer-brand-sweep.md`
location: tools/WORKWIKI_SYNC.md
severity: low
reason: DW-10's bundle intent authorized renaming only the sync script file. Nothing references the doc's path anywhere (repo-wide grep), so renaming it is safe whenever a wider filename cut is taken; until then it is the last maintainer-visible old-brand filename and the content-only scan can never flag it.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-brand-scan-coverage-and-residue

### DW-92: workers/sandbox-runner/README.md H1 still reads "Yopedia sandbox runner" — stale display prose invisible to both brand scans.
origin: spec-deferred 25a5969a3d48
source_spec: `spec-maintainer-brand-sweep.md`
location: workers/sandbox-runner/README.md:1
severity: low
reason: DW-10 covers only "WorkWiki" strings. Workers markdown is scanned only by the new WorkWiki-only maintainer scan, and the yopedia-identifier test walks workers *.ts only, so this heading can never fail a test.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-brand-scan-coverage-and-residue

### DW-93: AGENTS.md's frozen-identifier list omits the WORKWIKI_* operator family.
origin: spec-deferred 082aa1c5ca08
source_spec: `spec-maintainer-brand-sweep.md`
location: AGENTS.md:12
severity: low
reason: AGENTS.md enumerates only yopedia/YOPEDIA_* identifiers as frozen. WORKWIKI_* env vars, .workwiki-source-sync.json, the workwiki-*.zip archive prefix, and the workwiki.app origin are equally load-bearing for existing operator setups, and a future brand sweep could "fix" them and silently break every operator's environment.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-brand-scan-coverage-and-residue

### DW-94: public/ served static copy (e.g. public/agent-api.md) is outside both brand scans.
origin: spec-deferred b6515946b4ea
source_spec: `spec-maintainer-brand-sweep.md`
location: public/agent-api.md
severity: low
reason: public/agent-api.md is served at the production origin and carries brand-adjacent strings (workwiki.app base URL, yopedia identifier examples), but neither scannedSources() nor maintainerSources() reads public/, so a stale display-brand regression there would ship unseen. Pre-existing coverage gap, not introduced by this change.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-brand-scan-coverage-and-residue

### DW-95: DW-91's recorded premise ("nothing references the doc's path") is now stale — the sweep's vacuity-guard test pins tools/WORKWIKI_SYNC.md by literal path.
origin: spec-deferred 153d65f75801
source_spec: `spec-maintainer-brand-sweep.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: The pin-by-name test in brand-copy.test.ts asserts maintainerSources() contains tools/WORKWIKI_SYNC.md, so the future filename cut DW-91 anticipates must also update that pin list. The failure would be loud and self-locating, but the ledger entry's "safe to rename, nothing references it" evidence no longer holds as written. Existing ledger entries are orchestrator-owned, so this is recorded here instead of amending DW-91.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-brand-scan-coverage-and-residue

### DW-96: Maintainer-facing surfaces outside the four scan roots remain unscanned: scripts/, journal-site/, and .opencode/commands/*.md.
origin: spec-deferred 7d14595dc7b0
source_spec: `spec-maintainer-brand-sweep.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: maintainerSources() covers tools/, root markdown, docs/ markdown, and workers/ markdown per the bundle intent. scripts/*.sh|*.mjs, journal-site/*.mjs, and .opencode/commands markdown are the same class of maintainer tooling and are clean today (repo-wide grep), but a "WorkWiki" reintroduced there would be invisible to every test — same class of gap as the public/ item already ledgered from this spec.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-brand-scan-coverage-and-residue

### DW-97: A stray empty ~/pnpm-workspace.yaml (outside the repo) breaks every `pnpm <cmd>` on this dev machine, including all of this spec's documented verification commands.
origin: spec-deferred 6a474b2bad10
source_spec: `spec-maintainer-brand-sweep.md`
location: /Users/christianlee/pnpm-workspace.yaml
severity: low
reason: pnpm resolves /Users/christianlee/pnpm-workspace.yaml as the workspace root and fails with "packages field missing or empty" before running any script. Confirmed during this review pass; CI on fresh checkouts is unaffected. Workaround used: invoke ./node_modules/.bin/vitest and `node tools/work-wiki-sync.mjs` directly. Deleting or populating that stray file restores `pnpm test` / `pnpm sync` / `pnpm lint` locally.
status: done 2026-08-16
resolution: closed by human decision: The owner deletes or populates /Users/christianlee/pnpm-workspace.yaml on their machine, restoring pnpm test / pnpm sync / pnpm lint locally. Nothing in the repository changes, so the entry has no code fix to track.
decision: 2026-08-16 Delete the stray file (human action) — The owner deletes or populates /Users/christianlee/pnpm-workspace.yaml on their machine, restoring pnpm test / pnpm sync / pnpm lint locally. Nothing in the repository changes, so the entry has no code fix to track.

### DW-98: The email-ingest route's own byte handoff to `stageBytes` is unverified, so the empty-attachment harm DW-12 names is still reachable one hop past the worker.
origin: spec-deferred 84b8769da573
source_spec: `spec-email-ingest-attachment-test.md`
location: src/app/api/email/ingest/route.ts:194
severity: medium
reason: `src/app/api/email/ingest/route.ts:191-203` reads `await file.arrayBuffer()` and passes it to `stageBytes`. `src/lib/__tests__/email-ingest-route.test.ts:21-24` mocks `@/lib/ingest-staging` with `stageBytes: vi.fn(async (_jobId, filename) => ...)` — the mock ignores the bytes argument entirely, and the attachment assertions (lines 206, 211) check only `supportedAttachmentCount` and `filename`. Demonstrated: replacing `bytes: await file.arrayBuffer()` with `new ArrayBuffer(0)` leaves the full suite green (206 files / 4301 tests). The worker half of the path is now pinned; the route half is not.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-email-ingest-attachment-coverage

### DW-99: The worker's supported-attachment allowlist has drifted from the app's document extractor, so formats the app can read are rejected at the email door.
origin: spec-deferred e07612517bf9
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:42-73
severity: medium
reason: `workers/email-ingest/index.ts:42-68` omits `odt`, `ods`, `odp`, `epub`, `org`, `rtf`, `mobi` and `text/x-markdown`, all of which `src/lib/document-extract.ts:7-64` supports — so those emailed files draw a "not supported" reply even though ingestion would have worked. The worker also matches `mimeType.toLowerCase()` whole, while `detectDocumentFormat` strips `;` parameters first, so a `text/csv; charset=utf-8` part matches only via its extension. Nothing pins the two lists in agreement, and deleting the worker's filter at `index.ts:193-195` outright leaves the suite green.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-email-ingest-attachment-coverage

### DW-100: The `attachmentName` FormData fields the worker sends are unobserved, so names of unsupported attachments can vanish from ingest job metadata undetected.
origin: spec-deferred 92d4586ec775
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:225
severity: medium
reason: `workers/email-ingest/index.ts:225` appends every attachment name (supported or not); `src/app/api/email/ingest/route.ts:58-60` reads them back and persists them into the job's `email` metadata. Demonstrated: deleting the append loop leaves the full suite green. The route's union of names only recovers the *supported* files' names, so anything filtered out at `index.ts:193-195` is lost with nothing failing. The new worker test already parses the outgoing FormData but reads only `getAll("attachments")`.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-email-ingest-attachment-coverage

### DW-101: Only the ArrayBuffer branch of the worker's attachment-content normalization is exercised — including, ironically, not the branch the defensive copy exists for.
origin: spec-deferred 0da5a9e0e5df
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:228-238
severity: low
reason: `workers/email-ingest/index.ts:228-238` has three branches: string content via `TextEncoder`, `ArrayBuffer`, and a typed-array view reconstructed from `.buffer/.byteOffset/.byteLength`. Probing the installed `postal-mime@2.7.5` with a base64 part yields an `ArrayBuffer`, so only `index.ts:230-231` runs. The view branch carries the byteOffset arithmetic most prone to silent corruption, and the copy's own comment names the SharedArrayBuffer view as its reason for existing.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-email-ingest-attachment-coverage

### DW-102: Multi-attachment behaviour is unobserved — the 10-attachment cap, per-index filename/bytes pairing, and both fallbacks are untested.
origin: spec-deferred 376e7071da0f
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:193-246
severity: low
reason: The fixture carries exactly one named attachment with an explicit mimeType, so `.slice(0, 10)` (`index.ts:195`), the `attachment-${index + 1}` filename fallback (`index.ts:227`) and the `"application/octet-stream"` mimeType fallback (`index.ts:243`) never run. Demonstrated: narrowing the cap to `.slice(0, 1)` leaves the full suite green — a regression that forwards only the first of ten attached documents, or pairs attachment i's bytes with attachment j's filename (and therefore the wrong extractor at `route.ts:237-239`), would ship undetected. The `10` also duplicates the route's `MAX_EMAIL_DOCUMENTS` with nothing pinning them in agreement.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-email-ingest-attachment-coverage

### DW-103: The acknowledgement copy a sender receives about their attachments is unpinned.
origin: spec-deferred 929e58770d4a
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:287-292
severity: low
reason: `workers/email-ingest/index.ts:287-292` builds the "N supported attachment(s) were queued" and "N unsupported attachment(s) were recorded but skipped" lines, including their singular/plural branches. Demonstrated: blanking those lines leaves the full suite green. The two existing tests assert on reply text but drive a no-attachment fixture; the new test drives an attachment fixture but reads only the outgoing request.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-email-ingest-attachment-coverage

### DW-104: Base64 expansion makes the route's 10 MB per-document limit unreachable via email, and neither cap is tested against the other.
origin: spec-deferred 4fa3442f8443
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:39
severity: medium
reason: The worker rejects on `message.rawSize > MAX_RAW_EMAIL_BYTES` (10 MB, `index.ts:39/147`) — a raw-message measurement taken *before* MIME decoding. Base64 inflates payloads by roughly a third, so the effective per-attachment ceiling over email is about 7.5 MB, while `MAX_DOCUMENT_SIZE` in `src/lib/constants.ts` is 10 MB. The gap is undocumented and untested in both directions.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-worker-caps-and-accounting
decision: 2026-08-19 Raise the raw cap — Raise `MAX_RAW_EMAIL_BYTES` to about 13.4 MB so a `MAX_DOCUMENT_SIZE` attachment survives base64 expansion, derive it from `MAX_DOCUMENT_SIZE` with a comment naming the expansion factor, and add a test that fails if the two caps drift apart.

### DW-105: The shared dialog hook `useDialogA11y` — the richest DOM-only behaviour in reach — still has no mounted coverage.
origin: spec-deferred 1fd2c04cc42e
source_spec: `spec-dom-test-environment.md`
location: src/hooks/useDialogA11y.ts
severity: medium
reason: Esc dismissal, the deliberate "an open <select> eats its own Esc" carve-out, Tab trapping and pull-back, the `document.body.style.overflow` lock/restore, and the `fallbackFocusRef` path (whose own comment names the case: confirming Create Wiki unmounts the button that opened it) are all invisible to a source scan and all still pinned only by `create-wiki-ui.test.ts`'s greps. The DOM environment this pass established is what makes them testable.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-dialogs-and-rail

### DW-106: WikiWorkbench's other write paths have no mounted coverage — switchWiki's rollback and re-entry guard, the degraded `unavailable` render, and create()'s failure branch.
origin: spec-deferred 684689c6d8cd
source_spec: `spec-dom-test-environment.md`
location: src/components/WikiWorkbench.tsx:108
severity: medium
reason: `switchWiki` exists because overlapping PUTs settle out of order and roll the selection back to a stale id; the `unavailable` branch must NOT show "No wiki yet." or a Create button; the `!wiki?.id` guard's comment says the alternative is "a blank page rather than the error message"; and `create()`'s catch has no equivalent of the template flow's "keeps the dialog open and shows the failure inside it". None of these are observable from a source scan, and this pass covered only the confirm gate the bundle intent named.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-dialogs-and-rail

### DW-107: Nothing pins the `busy` gate on either dialog, so a double-submit would issue two destructive writes with the suite green.
origin: spec-deferred d8fb9fb38bc8
source_spec: `spec-dom-test-environment.md`
location: src/components/ConfirmDialog.tsx:93
severity: medium
reason: No test clicks `Overwrite` or `Create` twice before the first request settles. Dropping `disabled={busy}` from `ConfirmDialog` would double-apply a template overwrite; the labels ("Working…", "Creating…") and the mid-flight refusal of Cancel/Esc are likewise unasserted.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-dialogs-and-rail

### DW-108: Seventeen source files still tell the reader this repository has no DOM test environment, and several use that as the stated justification for their design.
origin: spec-deferred bca5238bf2c5
source_spec: `spec-dom-test-environment.md`
location: src/lib/workbench-data-version.ts:9
severity: medium
reason: `src/lib/workbench-data-version.ts:9`, `workbench-split.ts:8`, `workbench-settings.ts:10`, `workbench-preview.ts:243`, four components under `src/components/workbench/`, and nine `__tests__` files say so in prose — e.g. "a rule living inside a React effect could only ever be grepped for". After this pass that premise is false, so a future agent will reproduce the workaround on a reason that no longer holds. The spec's Never forbade touching `src/` in this pass, which is why it was not done here.
status: open

### DW-109: Most of DW-24's own verbatim list is still scan-only — the collapse toggle, badge rendering at 0 vs > 0, the sidecar dot's three states, and the live-region announcement.
origin: spec-deferred e63cd3a386e5
source_spec: `spec-dom-test-environment.md`
location: src/components/workbench/IconRail.tsx
severity: medium
reason: DW-24 enumerates more surfaces than the bundle intent's shortlist. The shortlist (sheet open/close/Esc/focus-restore) is now mounted and exceeded, but `workbench-chrome.test.ts` is still the only thing covering the rest, by `readFile` + `toContain`. Each is now cheaply mountable against the environment this pass added.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-dialogs-and-rail

### DW-110: The two polling suites have no mounted case for a rejecting fetch, a malformed body, or a wedged (never-settling) probe.
origin: spec-deferred 71d48dcc2b92
source_spec: `spec-dom-test-environment.md`
location: src/components/workbench/__tests__/data-version-watcher.test.tsx
severity: low
reason: `data-version-watcher.test.tsx` covers `ok: false` but not a transport failure or `{ dataVersion: "4" }`; `useSidecarStatus.test.tsx` covers a rejection but not a non-2xx answer or the `SIDECAR_PROBE_TIMEOUT_MS` race. The pure halves are executed by the node suite, so this is about the effect's handling of them, not the parsing.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-polling-and-shell

### DW-111: The new `*.test.tsx` ⇒ jsdom / `*.test.ts` ⇒ node convention is documented only in a `vitest.config.ts` comment.
origin: spec-deferred 781ee7265273
source_spec: `spec-dom-test-environment.md`
location: AGENTS.md
severity: low
reason: `AGENTS.md`'s "Running and verifying" section says nothing about it, so a contributor who names a DOM suite `*.test.ts` gets `document is not defined` with no pointer to why. That section sits inside the `bmad:context` managed block, which a refresh rewrites — so the note needs to be placed deliberately rather than appended here.
status: open

### DW-112: The DOM suites import their shim helpers through a relative ladder out of `src` (`../../../../vitest.setup.dom`), hardcoding each file's directory depth.
origin: spec-deferred 60cbf8e54eb5
source_spec: `spec-dom-test-environment.md`
location: src/hooks/__tests__/useSidecarStatus.test.tsx:5
severity: low
reason: Every other import in the suite uses the `@` alias. Moving a test file requires fixing the depth. The natural fix — helpers in `src/test/dom-helpers.ts` re-exported by the setup file — adds a file under `src/`, which the spec's Never forbade in this pass.
status: open

### DW-113: No mounted test can reach the shell's width-derived decisions, because a mounted `Workbench` measures `shellWidth === 0`.
origin: spec-deferred d7b2d8e349f5
source_spec: `spec-dom-test-environment.md`
location: vitest.setup.dom.ts
severity: low
reason: The DOM setup file shims `getClientRects()` to a fixed 1x1 but deliberately leaves `getBoundingClientRect()` as jsdom's all-zeros, so every `workbench-split` decision the mounted shell makes — the clamp, the divider bounds, whether a `SplitHandle` renders at all — runs at a width no browser reports, and the window `resize` listener is never exercised. The split RULES have their own node-project suite; what stays unpinned is the shell's reaction to a width. A `getBoundingClientRect` shim would open this up, and needs its own fidelity argument rather than being added in passing.
status: open
decision: 2026-08-19 Stub configurable rects — Give the DOM setup a configurable `getBoundingClientRect`/`offsetWidth` harness so a test can declare a shell width, replace the FIDELITY LIMIT note with the new contract, and add mounted cases for the width-derived shell decisions including the resize listener.

### DW-114: Follow-up review still recommended for dw-dom-test-environment after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dom-test-environment.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-115: `pnpm` cannot run any script in this repo, so the documented verification commands (`pnpm test`, `pnpm lint`) are unusable.
origin: spec-deferred becf08fd7220
source_spec: `spec-retire-zh-cn-locale.md`
location: /Users/christianlee/pnpm-workspace.yaml
severity: medium
reason: `pnpm test` exits with `ERROR packages field missing or empty`. The cause is a stray `/Users/christianlee/pnpm-workspace.yaml` (an `allowBuilds:` stub with no `packages:` key) that pnpm picks up as a workspace root for every project under the home directory. Pre-existing and machine-local — not introduced by this change. Verification here ran the verbatim script bodies (`npx vitest run`, `npx eslint`) instead.
status: done 2026-08-19
resolution: closed by human decision: Delete or repair /Users/christianlee/pnpm-workspace.yaml yourself (add a `packages:` key or remove the file); the documented pnpm commands then work unchanged and nothing in the repo needs to move.
decision: 2026-08-19 You delete the stray file — Delete or repair /Users/christianlee/pnpm-workspace.yaml yourself (add a `packages:` key or remove the file); the documented pnpm commands then work unchanged and nothing in the repo needs to move.

### DW-116: `<html lang>` is now unconditionally `"en"` while the wiki deliberately stores CJK and other non-English source content, so assistive technology announces those pages as English.
origin: spec-deferred 98df4f306e4c
source_spec: `spec-retire-zh-cn-locale.md`
location: src/app/layout.tsx:70
severity: low
reason: `src/lib/slugify.ts`, `src/lib/bm25.ts` and `src/lib/ingest.ts` all preserve CJK by design, and nothing sets `lang` on the article or Preview subtree. Pre-existing rather than caused by this change — the old value tracked the UI locale, not the content language, so it was equally wrong — but the retirement removes the last place where a per-content `lang` could have been derived.
status: open

### DW-117: The `walk()` test helper is now copy-pasted across five suites with inconsistent directory exclusions, so the scans silently cover different file sets.
origin: spec-deferred 5ee27cb93f34
source_spec: `spec-retire-zh-cn-locale.md`
location: src/lib/__tests__/
severity: low
reason: `brand-copy.test.ts`, `single-ia.test.ts`, `workbench-left-column.test.ts`, `workbench-data-version.test.ts` and the new `english-only.test.ts` each define their own `walk()`; only some skip `node_modules`, and the include filters differ. A shared `__tests__` helper would stop a future scan from looking thorough while reading a narrower tree.
status: open

### DW-118: No test renders the root layout or the nav, so the app shell's provider tree is guarded only by source-text reads.
origin: spec-deferred 3681ca6a1583
source_spec: `spec-retire-zh-cn-locale.md`
location: src/app/layout.tsx
severity: medium
reason: `src/app/layout.tsx` is re-nested by hand whenever a provider is added or removed, but no suite imports it — the only assertions that touch it are `readFile` scans in `brand-copy.test.ts` and `english-only.test.ts`. If `<ClerkProvider>` or `<ClientProviders>` were dropped along with a wrapper, `npx tsc --noEmit`, `npx eslint` and the full Vitest run all stay green. The same holds for `NavHeader`, which no test renders. Pre-existing: the shell has never had a mounted test. The repo already has a jsdom vitest project (`vitest.config.ts`, `name: "dom"`) with four mounted suites, so the missing coverage is a gap, not a constraint.
status: done 2026-08-19
resolution: resolved by sweep bundle dw2-dom-tests-polling-and-shell

### DW-119: Follow-up review still recommended for dw-retire-zh-cn-locale after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-retire-zh-cn-locale.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-120: The client delete gate still shows "Delete page" to a non-admin owner of a public knowledge page, whose DELETE the same realm gate then refuses with a generic message.
origin: spec-deferred 7cd7a18f81ec
source_spec: `spec-authz-commons-realm-cleanup.md`
location: src/components/ArticleActions.tsx:82
severity: medium
reason: `src/components/ArticleActions.tsx:82` computes `canDelete = isOwner || isSiteOwner` and renders `DeletePageButton` at :137. For a page where `belongsInCommons` is true, `canWritePage(meta, principal, "delete")` returns false for any non-service, non-admin principal — so a non-admin page owner sees the button and gets "You don't have permission to delete this page." from `src/app/api/wiki/[slug]/route.ts:39-49`, the same vague copy this pass replaced on the edit surface. The comment above the gate calls `isOwner || isSiteOwner` "the effective server outcome", which holds only for the site owner (who is an admin). Its pin, `src/lib/__tests__/article-actions-gate.test.ts:22-26`, reads ArticleActions.tsx as TEXT and asserts the literal source string, so it cannot observe the divergence from `canWritePage`. This is DW-77's second clause; the bundle intent scoped this pass to documentation and copy, so no behaviour was changed here.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-authz-realm-parity-and-copy

### DW-121: The edit page gates the whole editor — including the seven metadata fields — on writeKind "body", withholding metadata patches that canWritePage still permits.
origin: spec-deferred fbcd3507e87a
source_spec: `spec-authz-commons-realm-cleanup.md`
location: src/app/u/[handle]/[slug]/edit/page.tsx:34
severity: medium
reason: `src/app/u/[handle]/[slug]/edit/page.tsx:34` denies on `"body"` and returns before building `initialMetadata` (:69-79), yet `canWritePage(..., "metadata")` returns true for the same principal and `src/lib/patch-metadata.ts:91-106` admits the PATCH. The rewritten authz docblock now states that "metadata patches are still collectively editable", while the only UI reaching them is the screen that just refused. The bundle intent explicitly scoped a metadata-only editing surface out of this pass.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-authz-realm-parity-and-read-gates
decision: 2026-08-19 Narrow the authz rule — Make canWritePage refuse "metadata" wherever it refuses "body" for the commons realm, so the docblock's "collectively editable" claim is retired and the edit page's single gate becomes the accurate one; update patch-metadata.ts and the authz tests to match.

### DW-122: Seven other call sites of the same realm deny still emit a generic permission message with no realm explanation.
origin: spec-deferred 8ef6b4ff69c9
source_spec: `spec-authz-commons-realm-cleanup.md`
location: src/app/api/wiki/[slug]/route.ts:126
severity: low
reason: `src/mcp.ts:295` and `:395`, `src/app/api/wiki/[slug]/route.ts:39` and `:123`, `src/app/api/wiki/[slug]/revisions/route.ts:144`, `src/app/api/ingest/reingest/route.ts:39`, `src/app/api/ingest/history/route.ts:195`, and `src/lib/mcp-http.ts:407` all return "You don't have permission to edit/delete this page." for the same deny the edit page now explains. `WikiEditor` renders the API's raw `error` string, so a human who read the new explanation on load would get the old generic one on save. The bundle intent named only `edit/page.tsx:50`, so the other surfaces were left alone.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-authz-realm-parity-and-copy

### DW-123: The edit page's write denial returns before the canonical-tenant redirect, so a non-canonical edit URL renders the refusal instead of its 308.
origin: spec-deferred 20dcb006b261
source_spec: `spec-authz-commons-realm-cleanup.md`
location: src/app/u/[handle]/[slug]/edit/page.tsx:33
severity: low
reason: `src/app/u/[handle]/[slug]/edit/page.tsx` runs the `canWriteFrontmatter` denial branch (:33) before the `permanentRedirect(editPath(pageTenant, slug))` at :65-67. A non-admin opening `/u/bob/transformers/edit` for alice's public knowledge page therefore gets a 200 "Cannot edit" screen whose "← Back to page" link points at `/u/alice/transformers`, while the writable path for the same URL 308s to the canonical handle first. The asymmetry predates this pass — the branch and the redirect were already in this order at `{baseline_revision}`; this pass only rewrote the sentence inside the branch, so the ordering was left alone.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-authz-realm-parity-and-copy

### DW-124: Follow-up review still recommended for dw-authz-commons-realm-cleanup after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-authz-commons-realm-cleanup.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-125: `listContributors` and `buildContributorProfile` in `src/lib/contributors.ts` now have test-only callers — retiring the two contributor MCP tools removed their last production consumers.
origin: spec-deferred 4ca2c6cb527d
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/contributors.ts:278
severity: low
reason: `src/lib/contributors.ts` exports `buildContributorProfile` (:278) and `listContributors` (:331). Their only remaining callers are `src/lib/__tests__/contributors.test.ts` and `src/lib/__tests__/contributor-index.test.ts:13`; the production call sites in `src/mcp.ts` (`handleListContributors` / `handleGetContributor`) were deleted in this pass. The sibling `buildContributorProfiles` (:313) is in the same test-only state, which predates this pass. The module itself must stay: `src/lib/contributor-index.ts:37-43` imports `computeScanData` and `computeTrustScore` from it, and `lifecycle.ts:33`, `talk.ts:46`, `maintenance.ts:231` keep the index live. The spec's Code Map called this residue explicitly out of scope ("record as deferred, do not delete") because deleting the scan functions would mean deciding whether the trust-score surface returns, which is a product call rather than a cleanup.
status: open
decision: 2026-08-19 Retire the scan functions — Delete buildContributorProfile, buildContributorProfiles and listContributors along with their now-orphaned tests, keeping computeScanData and computeTrustScore for contributor-index.ts. Resolve DW-126 the same way by dropping the contributors step from rebuildDerivedIndexes.

### DW-126: The daily maintenance scan still rebuilds the contributor index, but after this pass no production code reads what it builds.
origin: spec-deferred 38e4600a3ab5
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/maintenance.ts:231
severity: low
reason: `src/lib/maintenance.ts:231` registers `["contributors", () => rebuildContributorIndex()]`, and `lifecycle.ts:33` / `talk.ts:46` still write into the index. The read side (`profilesFromIndex`, `contributorProfileFromIndex`) is reached only through `src/lib/contributors.ts`'s fast paths, whose own callers are now test-only. So the cron pays for a full-wiki scan whose output nothing consumes. Removing it is not a cleanup decision: it depends on whether the contributor trust surface returns, the same product call recorded in the entry above.
status: open
decision: 2026-08-19 Drop the contributors step — Remove the ["contributors", rebuildContributorIndex] entry from rebuildDerivedIndexes and the now-dead index writes from lifecycle.ts:33 and talk.ts:46, together with the DW-125 scan functions, and pin that the daily scan no longer walks the wiki for contributor data.

### DW-127: `src/lib/maintenance.ts`'s module header documents only three deterministic `fix` lint types while the scan emits eight.
origin: spec-deferred 3045ad1557a2
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/maintenance.ts:11
severity: medium
reason: The header (`src/lib/maintenance.ts:11-14`) names `unmigrated-page`, `supersedes-dangling`, and `stale-index`; the scan body also emits `orphan-page` (:60), `broken-link` (:127), `empty-page` (:143), `stale-page` (:160), and `missing-crossref` (:193), matching `MaintainFixType` in `src/lib/tasks.ts:164-172`. Pre-existing drift surfaced while correcting the task-consumer README against this file — the README now carries the accurate list, so the module header is the remaining stale copy.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-128: `.yoyo/status.md` still advertises `list_contributors` and `get_contributor` and an MCP tool count of 31.
origin: spec-deferred d19fab62b40d
source_spec: `spec-retire-dead-machinery-round-2.md`
location: .yoyo/status.md:15
severity: low
reason: `.yoyo/status.md:15` lists both retired tool names inside "**MCP tools:** 31 (...)". The count was already stale before this pass (the real count was 42, now 40), so this is pre-existing drift in an agent-written status doc rather than a consequence of this change; it is out of the retirement's file scope and `.yoyo/` is upstream-agent territory.
status: open

### DW-129: `SCHEMA.md` still documents the contributor REST routes, wiki pages, and `ContributorBadge` component as live surfaces.
origin: spec-deferred 08cb76da0f99
source_spec: `spec-retire-dead-machinery-round-2.md`
location: SCHEMA.md:195
severity: low
reason: `SCHEMA.md:195-201` advertises `GET /api/contributors`, `GET /api/contributors/:handle`, the `/wiki/contributors` index, the `/wiki/contributors/:handle` detail pages, and `ContributorBadge` components on wiki pages; `:68-69` cites the same surfaces as the consumers of the `authors`/`contributors` frontmatter fields. All three routes are `retiredRoute()` / `retiredPage()` 404s and `ContributorBadge` no longer exists anywhere under `src/`. This drift predates this pass — the routes were retired earlier, and this pass only removed the MCP tools — but it is the same contributor surface, so it belongs with DW-8's residue.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-130: `DESIGN-triggers.md` states the MCP server exposes 21 tools; the real count is 40.
origin: spec-deferred b88666035d3d
source_spec: `spec-retire-dead-machinery-round-2.md`
location: DESIGN-triggers.md:338
severity: low
reason: `DESIGN-triggers.md:338` reads "work-wiki's MCP server (`src/mcp.ts`) exposes 21 tools over stdio transport." The count guard in `src/lib/__tests__/mcp-annotations.test.ts:41-59` scans only `public/agent-api.md` and `src/lib/mcp-http.ts`, so this third hand-written count is unpinned and was already stale by ~20 before this pass. Out of the retirement's file scope.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-131: The graph page's canvas accessibility fallback points readers at `/wiki`, which is a retired 404.
origin: spec-deferred 0160c928098e
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/app/wiki/graph/page.tsx:161
severity: medium
reason: `src/app/wiki/graph/page.tsx:161` sets `aria-label="Wiki page relationship graph. Visit the wiki index for a text-based list of all pages."` and the canvas fallback text (`:164`) repeats it, but `/wiki` is listed in `RETIRED_SURFACES` (`src/lib/retired.ts:23`) and 404s. Deleting `HomeGraph.tsx` in this pass made this the only remaining graph canvas, so it is now the sole accessibility escape hatch for the visualization and it leads nowhere. The file was not touched by this pass and fixing it means choosing a live replacement target, which is a product call.
status: open
decision: 2026-08-19 Point at the Workbench Knowledge tree — Retarget the graph canvas's aria-label and fallback text at the Workbench's Knowledge tree (the live text-based list of the active Wiki's pages), updating the copy to name that surface and linking to it, and pin the new target so it cannot rot into another retired route.

### DW-132: Two more hand-maintained tool/task inventories have no test pinning them against their source of truth.
origin: spec-deferred b45716b28e31
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/mcp.ts:33
severity: low
reason: `src/mcp.ts`'s header comment carries a per-tool name list (the lines this pass edited at :33-37), and `workers/task-consumer/README.md:7-13` carries the `Task`-kind list. The new parity test pins `MCP_TOOLS` against the registrations and `mcp.json` against them too, and the count test pins the two numeric counts — but a tool or task kind added or retired without touching these two prose lists drifts silently. That is the exact failure mode DW-80 was filed for, one layer over. Pinning prose lists needs a convention decision (a test that greps Markdown/comments) rather than a cleanup edit.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-prose-inventory-parity-tests

### DW-133: No test exercises a `wontfix` thread through the KV-index fast path of `getDiscussionStatsForSlugs`.
origin: spec-deferred ead2056e1663
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/__tests__/discuss-stats-index.test.ts:133
severity: low
reason: `getDiscussionStatsForSlugs` fast-paths through the discuss-stats index when one exists and falls back to a directory scan otherwise. The mixed-status case added in this pass (`src/lib/__tests__/talk.test.ts`, "counts a wontfix thread toward total but not open") seeds no index, so it covers only the scan path, and the fast-path parity test at `src/lib/__tests__/discuss-stats-index.test.ts:133-162` uses only `open` and `resolved` threads. So `wontfix` never reaches `statsFromThreads()`. Pre-existing: the deleted `getDiscussionStats` never touched the index path either, so this pass neither created nor widened the gap.
status: open

### DW-134: `/api/tasks/scan?dry=1` is documented as pure inspection but still rebuilds derived indexes and purges stale jobs.
origin: spec-deferred 7049e961715f
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/app/api/tasks/scan/route.ts:57
severity: low
reason: `src/app/api/tasks/scan/route.ts:57` calls `rebuildDerivedIndexes()` and `:60` calls `purgeStaleJobs()` before the `dry` branch is consulted — both write. `workers/task-consumer/README.md` defines dry-run as "logs/returns what it *would* enqueue and enqueues nothing" without noting them, which matters for the "inspect what it would do" step it recommends. Pre-existing route behavior; documenting it accurately means first deciding whether those two calls should move behind the flag, which is beyond a doc correction.
status: open
decision: 2026-08-19 Make dry actually dry — Move `rebuildDerivedIndexes()` and `purgeStaleJobs()` behind the `!dry` branch so a dry run performs no writes at all, and add a test asserting no storage write occurs when `dry=1`.

### DW-135: Follow-up review still recommended for dw-retire-dead-machinery-round-2 after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-retire-dead-machinery-round-2.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-136: The Workspace Purpose form never refetches after the active Wiki changes, so it can keep naming and editing a Wiki that is no longer current.
origin: spec-deferred eeecef5703cc
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/components/WorkspacePurposeSettings.tsx
severity: medium
reason: `WorkspacePurposeSettings.tsx` loads the active Wiki in a `useEffect` with an empty dependency array, and `router.refresh()` from the Wiki switcher re-renders server components without remounting a client component. The save is now safe — the route refuses on a `wikiId` mismatch — but the owner sees a stale Wiki name until reload.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-purpose-settings-freshness

### DW-137: The legacy tenant-global profile is read through by every pre-change Wiki in a tenant, so one purpose appears under all of them until each is individually saved.
origin: spec-deferred 425c83c35758
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/lib/workspace-profile.ts
severity: low
reason: `getWorkspaceProfile` falls back to `tenants/<t>/workspace-profile.json` whenever a Wiki has no file of its own. Intentional and documented for the migration window, but it has no end date, no backfill, and no removal milestone.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-profile-legacy-backfill
decision: 2026-08-19 Backfill then remove — Write a one-time backfill that copies the legacy tenant profile onto every Wiki that lacks its own, run it on read or via a maintenance op, then delete the read-through and `legacyProfilePath` along with their tests.

### DW-138: `docs/llm-wiki-functional-parity-roadmap.md` still describes the Workspace Purpose editor as owner-scoped rather than per-Wiki.
origin: spec-deferred c3c9cc846535
source_spec: `spec-per-wiki-workspace-profiles.md`
location: docs/llm-wiki-functional-parity-roadmap.md:101
severity: low
reason: Line 101 predates this change; the roadmap is not a spec surface this run owns, but the sentence is now wrong.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-139: `putWorkspaceProfile` is an exported unlocked writer whose only guard is a docblock.
origin: spec-deferred 5cc8cc30ccaa
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/lib/workspace-profile.ts
severity: low
reason: It must be exported so `seedWikiArtifacts` can write inside the non-reentrant `wikis:<tenant>` lock, but a future caller that is NOT holding that lock can write a profile with no serialization and nothing in the suite or the type system flags it. The module-private `putWikiArtifact` does not have this exposure.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-profile-store-hardening

### DW-140: `PUT /api/workspace-profile` has no explicit invalid-JSON branch, so a malformed body surfaces a raw parser message as the 400.
origin: spec-deferred f65e39667a15
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/app/api/workspace-profile/route.ts
severity: low
reason: `/api/wikis/current` catches this and answers "Invalid JSON body."; this route lets `request.json()` throw into the generic catch. Pre-existing behaviour, unchanged here.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-profile-route-preconditions

### DW-141: `buildWorkspaceGuidance` now performs two storage reads per call, uncached, at seven call sites including three in `ingest.ts`.
origin: spec-deferred 4b7d37651866
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/lib/workspace-guidance.ts
severity: low
reason: It resolves `wikis.json` through `getCurrentWiki` and then reads the profile. Resolving the active Wiki once per request and passing it down would halve the I/O.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-guidance-request-caching

### DW-142: The Settings no-Wiki and load-failed states offer no CTA, no retry, and no aria-live announcement, and `loadFailed` is never reset.
origin: spec-deferred f1b70803bbe7
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/components/WorkspacePurposeSettings.tsx
severity: low
reason: "Create a wiki first" does not link to where a Wiki is created, and a transient GET failure leaves the form permanently disabled until a full reload — `WikiWorkbench` at least says "Reload to try again".
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-purpose-settings-freshness

### DW-143: A failure of the profile write in `seedWikiArtifacts` leaves `schema.md` on the new template and the profile on the old one.
origin: spec-deferred 51c4bb218e74
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/lib/wikis.ts
severity: low
reason: The three writes are sequential and untransacted. Pre-existing ordering, not introduced here, and unreachable without a storage fault mid-seed.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-wiki-create-and-template-atomicity

### DW-144: A corrupt per-Wiki `workspace-profile.json` blocks the re-template that would have overwritten it.
origin: spec-deferred 6e541a1b637d
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/lib/workspace-profile.ts
severity: low
reason: `getWorkspaceProfile` rethrows a `SyntaxError` from its own file (only the legacy fallback degrades), and `putWorkspaceProfile` reads existing state before writing. Pre-existing shape — the old tenant-global store behaved the same way.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-profile-store-hardening

### DW-145: Two tabs editing the SAME Wiki's Workspace Purpose still last-write-wins with no warning.
origin: spec-deferred 47d53b63986a
source_spec: `spec-per-wiki-workspace-profiles.md`
location: src/app/api/workspace-profile/route.ts
severity: low
reason: The PUT guard compares Wiki identity only, so a drift check passes when both tabs name the same Wiki. The profile already carries `updatedAt` and the form already tracks `savedAt`, so an `If-Match`-style precondition was available; the store has never had one, so this is pre-existing shape, not new here.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-profile-route-preconditions

### DW-146: Follow-up review still recommended for dw-per-wiki-workspace-profiles after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-per-wiki-workspace-profiles.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-147: The orphan-directory sweep has no trigger other than a successful delete, so a tenant that never deletes never reclaims a directory orphaned by a normalizeRegistry drop.
origin: spec-deferred 68436c804582
source_spec: `spec-wiki-rename-and-delete.md`
location: src/lib/wikis.ts (sweepOrphanWikiDirectories) / src/lib/maintenance.ts
severity: medium
reason: `sweepOrphanWikiDirectories` is exported and locked but has no caller in `src/` outside the test suite; `deleteWiki` is the only production path that reaches the sweep, and deleting the last (always current) Wiki is refused. The repo already has a home for this class of work: `scanForMaintenance` in `src/lib/maintenance.ts`, cron-driven via `src/app/api/tasks/scan/route.ts`, which emits a structurally identical `orphan-page` op for "file on disk, no index entry". DW-18's intent names a registry READ as the orphan's cause but does not say what should trigger the cleanup, so the delete-side-effect reading was chosen at planning time rather than settled by the intent.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-orphan-wiki-sweep-hardening

### DW-148: Wiki names are not unique and both the switcher and the new delete picker render the name alone, so two Wikis with the same name are indistinguishable at the moment of an irreversible delete.
origin: spec-deferred b04ccd5558d3
source_spec: `spec-wiki-rename-and-delete.md`
location: src/components/workbench/WikiSwitcher.tsx
severity: low
reason: Neither `parseWikiName` nor the registry enforces uniqueness, and every `<option>` in `WikiSwitcher` (pre-existing) and in the delete picker (new) carries only `wiki.name` — no scenario, created date, or id fragment.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-wiki-workbench-client-hardening

### DW-149: WikiSwitcher offers its write controls with no client-side read-only signal, so on a read-only deployment the 403 arrives only after the owner has confirmed.
origin: spec-deferred 8a87b42369f8
source_spec: `spec-wiki-rename-and-delete.md`
location: src/components/workbench/WikiSwitcher.tsx
severity: low
reason: All four routes gate on `isReadOnly()`, but the component renders New Wiki, the switcher, Rename and Delete unconditionally. Pre-existing for New Wiki and the switcher; the new controls inherit it. Other surfaces (PreviewColumn, WorkspacePurposeSettings) do carry a read-only signal.
status: done 2026-08-17
resolution: resolved by sweep bundle dw-read-only-deployment-consistency

### DW-150: `withFileLock` is in-process only, so on a multi-isolate deployment the orphan sweep can delete the directory of a Wiki whose registry entry has not landed yet.
origin: spec-deferred 11deb3958f5b
source_spec: `spec-wiki-rename-and-delete.md`
location: src/lib/wikis.ts (sweepOrphans) / src/lib/lock.ts
severity: low
reason: `src/lib/lock.ts` documents the lock as in-process ("does not protect against multiple server processes"), and `createWiki` seeds `wikis/<id>/` BEFORE pushing the entry and writing the registry — both inside the lock, so a single Node process is safe. Under `build:cloudflare` / `open-next.config.ts` two isolates can hold the "same" lock at once: isolate A is mid-create with the directory on disk and no entry, isolate B deletes an unrelated Wiki and its sweep sees A's directory as an orphan. Every other registry operation has the same exposure, but this is the first one whose consequence is byte removal rather than a lost entry. A mtime grace period on sweep candidates, or a cross-process lock, would close it; both are design decisions past DW-18.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-orphan-wiki-sweep-hardening
decision: 2026-08-19 mtime grace period — Skip any directory whose newest entry is younger than a grace window (minutes, not seconds) so an in-flight create can never be swept, document the window beside `sweepOrphans`, and add a test that pins a freshly seeded directory as unsweepable.

### DW-151: Follow-up review still recommended for dw-wiki-rename-and-delete after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-wiki-rename-and-delete.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-152: Demoting KnowledgeStudio's and VaultExplorer's content columns to plain `<div>` leaves each grid with labelled `<aside>` landmarks on both sides and no landmark on the content between them.
origin: spec-deferred e6cd199706ac
source_spec: `spec-single-main-landmark-sweep.md`
location: src/components/KnowledgeStudio.tsx:213, src/components/VaultExplorer.tsx:369
severity: low
reason: `src/components/KnowledgeStudio.tsx:213` (`.studio-main`) sits between `<aside className="studio-nav" aria-label="Knowledge Studio sections">` and `<aside className="studio-evidence" aria-label="Evidence and actions">`. `src/components/VaultExplorer.tsx:369` is the same shape: after the sweep the grid's only landmark children are `<aside aria-label="Vault explorer">` and `<aside aria-label="Document preview">`. A screen-reader user can jump to both rails but not to the substance between them. Three independent reviewers raised it. Not patched here for two reasons: DW-11's intent authorises `<div>` OR `<section>` without selecting between them per site and promises nothing about region navigability, and this spec's frozen intent-contract says "Do not add ARIA roles, headings or landmarks to compensate". Restoring the region means a named `<section>` (or `role="region"` + `aria-label`) on those two wrappers — a deliberate a11y decision, not a mechanical follow-on to the sweep. Note that
status: open
decision: 2026-08-19 Name the KnowledgeStudio region — Give KnowledgeStudio's .studio-main wrapper a named `<section>` (or role="region" with aria-label) matching the shape VaultExplorer already uses, restoring region navigability between the two rails, and update the landmark scan and mounted tests to expect it. Record in the spec record that the frozen "do not add landmarks" clause was deliberately renegotiated for this one wrapper.

### DW-153: The DW-152 entry in the deferred-work ledger is truncated mid-sentence, losing the clause that scopes it away from PrivateWorkspaceNotice.
origin: spec-deferred b0e8da54231b
source_spec: `spec-single-main-landmark-sweep.md`
location: _bmad-output/implementation-artifacts/deferred-work.md (DW-152)
severity: low
reason: `deferred-work.md`'s DW-152 `reason:` ends with "... not a mechanical follow-on to the sweep. Note that" and then jumps straight to `status: open`. The missing tail survives only here, in this spec's `deferred[0]` block scalar: "`single-main-landmark-mounted.test.tsx` pins `PrivateWorkspaceNotice`'s wrapper as a `DIV`; that surface has no aside siblings and is not part of this item." The clause was lost flattening a multi-line block scalar onto one ledger line. It matters because the ledger is what the sweep tooling reads, so a later run picking up DW-152 cannot see which surface the item excludes. Recorded here rather than fixed: this run was invoked under an explicit instruction not to modify, re-open or rewrite deferred-work ledger entries — the orchestrator owns their text, status and resolution.
status: open

### DW-154: Follow-up review still recommended for dw-single-main-landmark-sweep after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-single-main-landmark-sweep.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-155: `readActiveWikiSchema()`'s catch branch — warn and fall back to the root Schema on an unreadable or unparseable registry — has no test.
origin: spec-deferred e7c53a0d9578
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: src/lib/wikis.ts
severity: low
reason: src/lib/wikis.ts logs `logger.warn("wikis", ...)` and returns null when `getCurrentWiki`/`readWikiArtifact` throws. The sibling fallbacks (no owner, no Wiki, missing schema.md, empty conventions section) are all covered in `wiki-schema-source.test.ts`; this one is not. A corrupt `tenants/<t>/wikis.json` would serve the root SCHEMA.md forever, which is exactly the silent-misconfiguration case the warn line exists for. Pre-existing — the branch predates this change.
status: open

### DW-156: Owner-handle case normalization is load-bearing for the single-owner invariant but untested at the Schema path.
origin: spec-deferred d5cca58d2f5d
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: src/lib/links.ts:80
severity: low
reason: `getOwnerHandle()` returns the raw trimmed env value while `isOwnerHandle()` compares case-insensitively; the two only stay consistent because `ownerToTenant()` (src/lib/links.ts) lowercases before the value becomes a storage key. Nothing pins that `NEXT_PUBLIC_OWNER_HANDLE="Alice"` resolves alice's Wiki. Pre-existing, and adjacent to the invariant this change pins.
status: open

### DW-157: The backup scheduler re-implements `getOwnerHandle()` inline, so the owner env var has two readers and a `getOwnerHandle` grep misses one.
origin: spec-deferred 194d538ba460
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: src/app/api/tasks/scan/route.ts:139
severity: low
reason: src/app/api/tasks/scan/route.ts:139 reads `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()` directly into `backupOwner` and passes it to `isOwnerBackupDue()` and `enqueueTask({ owner })` — both tenant-keyed. Routing it through `getOwnerHandle()` would leave exactly one reader of the env var. Pre-existing.
status: open

### DW-158: Neither `lint-checks.ts` detector has any test that it resolves the ACTIVE Wiki's Schema — a mutation pinning both to the repo-root file passes the entire suite.
origin: spec-deferred 517d89b179e4
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: src/lib/lint-checks.ts:414 and src/lib/lint-checks.ts:570
severity: medium
reason: `checkContradictions()` and `checkMissingConceptPages()` call the no-argument `loadPageConventions()`. The only lint-side conventions test, `src/lib/__tests__/lint.test.ts:670`, writes a bare `SCHEMA.md` into its tmpdir and never sets `NEXT_PUBLIC_OWNER_HANDLE` or calls `createWiki`, so it exercises only the repo-root fallback branch. Replacing both detector calls with `loadPageConventions(`${process.cwd()}/SCHEMA.md`)` — lint permanently ignoring the active Wiki's seeded Schema — leaves lint.test.ts (73), wiki-schema-source.test.ts and cli.test.ts (83) all green, 170 tests passing. Pre-existing: this is Wiki-vs-root precedence (Story 1.2 / AD-10), not DW-19 tenancy, and the gap predates this change. DW-19's own pins are at the loader plus the two call sites that carry a principal; the lint detectors carry none, so there is no non-owner caller to pin them with.
status: open

### DW-159: `POST /api/wikis` is gated on sign-in but not ownership, so a non-owner can create a Wiki that every downstream surface then treats as inert.
origin: spec-deferred 0cea96b84531
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: src/app/api/wikis/route.ts:37
severity: low
reason: `src/app/api/wikis/route.ts` checks `getPrincipal()` and `isReadOnly()`, then calls `createWiki(principal.handle, …)` — no `isOwnerHandle` gate. The resulting Wiki's Schema is never resolved (`readActiveWikiSchema()` reads `NEXT_PUBLIC_OWNER_HANDLE`) and its Schema edits are 403'd at `src/app/api/workbench/artifact/route.ts:82`, whose own comment reasons about exactly this inertness for the save path. So the "second tenant" state DW-19 treats as hypothetical is reachable in production today; the creation path is the one door left open. Pre-existing, and a product decision (gate creation, or accept inert non-owner Wikis) rather than a defect of this change.
status: open
decision: 2026-08-19 Gate creation on ownership — Add an `isOwnerHandle(principal.handle)` gate to `POST /api/wikis` so a non-owner cannot create a Wiki no surface will honour, answering the same 403 shape the artifact route already uses, and pin it with a route test alongside the existing sign-in and read-only cases.

### DW-160: Follow-up review still recommended for dw-single-owner-resolution-invariant after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-161: `FilesystemStorageProvider.writeFile` is a bare `fs.writeFile`, not the write-to-tmp + rename that `StorageProvider`'s documented contract claims.
origin: spec-deferred 0d5c376c507a
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
location: src/lib/storage/filesystem.ts:78
severity: medium
reason: `src/lib/storage/types.ts` states "`writeFile` must be atomic from the caller's perspective — partial writes should never be visible. The filesystem provider uses write-to-tmp + rename". `filesystem.ts` does `await fs.writeFile(abs, content, "utf-8")` with no tmp file. A torn write (ENOSPC, process death mid-write) therefore CAN leave a truncated file — including `wikis.json`, which `normalizeRegistry` then degrades to an empty registry. The compensation added for DW-20/DW-143 reasons from the interface contract and cannot detect a torn write; the comment at `applyScenarioTemplate`'s catch now says so explicitly. Pre-existing: both the implementation and the contradicting doc predate this change.
status: done 2026-08-20
resolution: resolved by sweep bundle dw3-storage-write-integrity

### DW-162: A half-created FIRST Wiki's directory is unreclaimable, because the orphan sweep bails on an empty registry and has no scheduled caller.
origin: spec-deferred b2027da91fa3
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
location: src/lib/wikis.ts
severity: low
reason: `sweepOrphans` returns 0 whenever `registry.wikis.length === 0` (a deliberate guard against sweeping a lost registry), and `sweepOrphanWikiDirectories` is referenced only from `deleteWiki` and tests. So when `discardCreatedWikiDirectory` itself fails on a tenant's first-ever create, the bytes sit on disk until that tenant has at least one Wiki AND a delete runs. Pinned as a fact by the new `re-throws the seed error…` test. Pre-existing sweep design; the new code only made the gap visible.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-orphan-wiki-sweep-hardening

### DW-163: Crash durability is still open — compensating cleanup only covers a rejected write, not process death between two writes.
origin: spec-deferred 75712627a6a0
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
location: src/lib/wikis.ts
severity: low
reason: DW-20's own text proposes "a write-ahead or compensating-write facility in the storage layer"; the bundle intent chose compensating cleanup, which runs in the same process as the failure. A SIGKILL or power loss between any two of the four writes still produces exactly the states DW-20 and DW-143 describe, and nothing recovers on next start. Closing this needs an on-disk pending-restore marker plus a reconcile, i.e. the storage-layer route the intent did not take.
status: done 2026-08-19
resolution: closed by human decision: Compensating cleanup covers the rejected-write case, which is the reachable one for a single-process deployment; crash-window states are left to the orphan sweep and recorded as a known limit.
decision: 2026-08-19 Accept in-process compensation — Compensating cleanup covers the rejected-write case, which is the reachable one for a single-process deployment; crash-window states are left to the orphan sweep and recorded as a known limit.

### DW-164: `research-projects.ts` still carries the same untransacted registry property DW-20 names, and was not given a compensation.
origin: spec-deferred b087c7736364
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
location: src/lib/research-projects.ts
severity: low
reason: DW-20's reason cites `research-projects.ts` as "the registry idiom the spec directs this module to mirror — has the same property". `createResearchProject` is still an unguarded push-then-`writeProjects`. The bundle intent scoped the work to `src/lib/wikis.ts`'s two functions, so this was left alone deliberately; recording it so the divergence between the two registries is tracked rather than forgotten.
status: done 2026-08-20
resolution: resolved by sweep bundle dw3-storage-write-integrity

### DW-165: Follow-up review still recommended for dw-wiki-create-and-template-atomicity after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-166: The repo now carries two independent conventions for reading a query param on the client, and neither references the other.
origin: spec-deferred 77952b63c537
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
location: src/app/wiki/graph/page.tsx:35-42
severity: low
reason: `src/app/wiki/graph/page.tsx:41` already does `new URLSearchParams(window.location.search).get("scope")`, with a comment at `:35` giving the same "avoid the useSearchParams bailout" rationale that `src/lib/workbench-url.ts` was introduced under. Pre-existing — DW-27 did not create it — but `workbench-url.ts` is now presented as the home for URL rules, so the divergence is easier to inherit than it was.
status: open

### DW-167: With Settings open the URL still names the underlying mode, so a link copied there reopens the mode canvas and Back on the first entry leaves the app with the unsaved Settings draft.
origin: spec-deferred 1361b6b2b5e9
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
location: src/components/workbench/Workbench.tsx (toggleSettings)
severity: low
reason: DW-27 is scoped to the mode by its own ledger text ("the active mode has no URL representation"), and Settings is a surface, not a mode — so this is not a regression: Back left the app before this change too, on every surface. What changed is that modes now have a Back that stays, which makes Settings the one surface where it still does not. Worth an explicit decision alongside whatever story owns the Settings draft lifecycle.
status: open
decision: 2026-08-19 Give Settings a URL — Represent the open Settings surface in the URL alongside `?mode=` (a `settings=1` param or a `mode=settings` value), accept it on load through the same ordering as the mode restore, and make Back close Settings before it leaves the app — reusing `src/lib/workbench-url.ts` rather than adding a second convention.

### DW-168: A deep link followed by a signed-out browser loses its `?mode=` at the sign-in redirect, which is the case a shared or bookmarked link is most likely to be in.
origin: spec-deferred e025aeb56769
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
location: src/app/page.tsx:38
severity: medium
reason: `src/app/page.tsx:38` is `redirect("/sign-in")` with no return-to, and `src/app/sign-in/[[...sign-in]]/page.tsx` renders `<SignIn />` with no `forceRedirectUrl` / `fallbackRedirectUrl`, so Clerk returns to `/`. The whole original URL is dropped, not just the param — pre-existing, and it predates DW-27 by every commit. DW-27 is what gives it a cost: before this there was nothing in the URL to lose.
status: done 2026-08-20
resolution: already resolved: src/middleware.ts:175 answers an unauthenticated navigation with redirectToSignIn({ returnBackUrl: req.url }) — the full URL, query string included — and the matcher at src/middleware.ts:197-201 covers `/`, so a signed-out deep link keeps its ?mode=. src/app/page.tsx:40's bare redirect("/sign-in") is only reachable for a session middleware already admitted whose getPrincipal() degraded (src/lib/auth.ts:66-94), so the entry's premise does not hold.

### DW-169: Follow-up review still recommended for dw-workbench-mode-url-sync after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-170: DW-17's stated reopening trigger, and three frozen story records, still quote the Story 1.4 AC phrase this change removed.
origin: spec-deferred 96e0e22d612c
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
location: _bmad-output/implementation-artifacts/deferred-work.md:153
severity: medium
reason: `deferred-work.md:153` justifies DW-17 with "the per-Wiki Page partitioning that Story 1.4's 'the trees show that Wiki's files' implies", and the same phrase is quoted at `spec-1-2-create-a-wiki-from-a-scenario-template.md:71` and `spec-1-4-knowledge-tree-and-file-tree.md:25,132,310`. After this change that citation resolves to no live text in `epics.md`, so DW-17's rationale now rests on a phrase that no longer exists — which could either keep a migration alive on a dead citation or make it look spuriously resolved. The ledger is orchestrator-owned and the story specs are frozen records, so neither can be corrected from this story.
status: open

### DW-171: The PRD still glosses the File Tree as a browse of "the Wiki's files", the same per-Wiki reading this story removed from the epic.
origin: spec-deferred 5ba851433aa5
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
location: _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md:99
severity: low
reason: `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md:99` reads "**File Tree** — Left-column browse of the Wiki's files (Pages, Sources, purpose/Schema)", which groups Pages and Sources under "the Wiki's" exactly as the corrected AC used to. The intent named `epics.md:400` specifically and said nothing about the PRD, so rewording a second planning artifact is outside what was authorised here.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-172: The AC edit shifted `epics.md` by two lines, so four line-addressed citations in three completed story records now point two lines short.
origin: spec-deferred 1f39f0c46915
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
location: _bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md:246
severity: low
reason: Verified against the current file: `spec-1-6-drag-resize-and-durable-layout.md:246` cites `epics.md:440` (the 320px clause is now at :442), `spec-1-5-view-first-preview- with-gfm-and-wikilinks.md:383` cites `:423` (now :425), `:391` cites `:413` and `:414` (now :415 and :416), and `spec-1-4-knowledge-tree-and-file-tree.md:136` cites `:530` (now :532). The previous pass's triage entry claimed "every other `epics.md:<line>` citation in the repo sits above the edit" — that holds for shipped code under `src/` (the only other citations there are `epics.md:367`, above the edit, and `workbench-split.ts` was corrected) but not for the planning and implementation artifacts. The intent's Never clause puts the completed `spec-1-4` record off limits, and the same freeze applies to the other completed story records, so none of the four can be corrected from this story. Each lands within the same AC block, so a reader is misdirected by two lines rather than to unrelated text.
status: open

### DW-173: Follow-up review still recommended for dw-wiki-lens-copy-and-invariant after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-174: A header Rename leaves the Wiki canvas card naming the old wiki until a reload.
origin: spec-deferred 3de0090154c7
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:62-63 with src/app/page.tsx:135
severity: medium
reason: `WikiWorkbench` seeds `useState(initialWikis)`/`useState(initialCurrentId)` from props, and `page.tsx:135` keys it on the wiki ID — which a rename does not change. So `router.refresh()` delivers the new name, the key stays the same, the card does not remount, and `current.name` keeps the pre-rename string while the header switcher shows the new one. Pre-existing (it shipped with rename), and the root fix is the one `spec-1-4` recorded as blocked by the now-lifted freeze: have the card read `wikis`/`currentWikiId` from `WorkbenchDataProvider`, which already carries both, instead of seeding local state and keying the remount.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-wiki-workbench-client-hardening

### DW-175: `WikiWorkbench.send()` has no request deadline, so a hung create or re-template leaves the dialog spinning for the session.
origin: spec-deferred f456e0d80acd
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:38-46
severity: medium
reason: `WikiSwitcher.tsx:42-47` documents exactly this failure and guards it with `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`; the near-identical helper at `WikiWorkbench.tsx:46-54` has neither that nor `failureMessage`, and `finally` cannot rescue a promise that never settles — `busy` stays true. It also spreads `...init` AFTER `headers`, the ordering `WikiSwitcher.tsx:50-52` warns against. With switching gone the two helpers differ only in hardening, so they should be one shared module.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-wiki-workbench-client-hardening

### DW-176: The zero-wiki viewport shows two byte-identical `No wiki yet.` sentences.
origin: spec-deferred 5b12d4aa3439
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:160 with src/lib/workbench-tree.ts:71
severity: low
reason: The canvas empty state inlines the literal while the left column's tree renders `TREE_NO_WIKI_COPY` (`src/lib/workbench-tree.ts:71`) — the same string, on two surfaces, at the same moment. Same class of defect as DW-33, and the new mounted suite scopes its assertion to `.wb-canvas` to work around it. Deciding which surface owns the sentence is a UX call, not a mechanical de-duplication.
status: open
decision: 2026-08-19 Canvas owns the sentence — Keep the canvas empty state as the one place that says "No wiki yet." (rendering the shared TREE_NO_WIKI_COPY constant rather than an inline literal) and let the tree render a quieter row-level placeholder, then drop the .wb-canvas scoping workaround from the mounted suite.

### DW-177: `Select a file to preview.` is still an inline literal restated in three files while every sibling sentence is an exported constant.
origin: spec-deferred 1099d47dbb87
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:210
severity: low
reason: `TREE_NO_WIKI_COPY`, `TREE_UNAVAILABLE_COPY`, `WIKI_SCOPE_COPY` and `PREVIEW_EMPTY_COPY` all live in `src/lib/`, so a copy change is one edit and the node suite can execute it. This AC-quoted sentence is inline in the component and restated in `create-wiki-ui.test.ts` and `wiki-canvas-duplication.test.tsx`. Extracting it changes what `create-wiki-ui.test.ts:128` freezes, so it belongs with a deliberate copy-consolidation pass.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-wiki-workbench-client-hardening

### DW-178: Collapsing the left column now leaves no Wiki switch, create, rename or delete control reachable.
origin: spec-deferred e9c63e7fce1e
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/app/globals.css:2645 with src/components/workbench/WikiSwitcher.tsx
severity: low
reason: `globals.css:2645-2647` sets `.wb-shell[data-collapsed="true"] .wb-left { display: none }`, and `collapsed` is durable. Before DW-33 the canvas card's own switcher and `New wiki` survived the collapse; now every Wiki control lives in the hidden column. The rail's collapse chevron is always visible, so nothing is a dead end and this is arguably just what "collapse" means — but it is a reachability change the retirement caused, and whether the rail should carry a Wiki affordance in that state is a UX decision.
status: done 2026-08-19
resolution: closed by human decision: Collapse is an explicit, durable user action and the chevron that restores it is always visible; hiding the Wiki controls is what collapsing the column means.
decision: 2026-08-19 Accept the collapsed state — Collapse is an explicit, durable user action and the chevron that restores it is always visible; hiding the Wiki controls is what collapsing the column means.

### DW-179: The only Wiki switcher's label is `wb-sr-only`, so a sighted user now meets a bare combobox.
origin: spec-deferred 7677137abba0
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/workbench/WikiSwitcher.tsx:262-264
severity: low
reason: The retired card control carried a VISIBLE `Active wiki` label; the survivor's is clipped (`WikiSwitcher.tsx:262-264`), justified on the 280px column width. The accessibility floor is still met — the input is labelled beyond a placeholder — but that tradeoff was made while a visible label existed elsewhere on the same viewport, and it has not been re-examined now that it does not.
status: open
decision: 2026-08-19 Make the label visible — Render the `Active wiki` label visibly above the switcher within the 280px column (a small-caps field label in the existing left-column type scale), drop the `wb-sr-only` class, and update the chrome tests that pin the current markup.

### DW-180: Hiding the preview note leaves the canvas grid's second track empty, so a docked Preview strands the card at 320px beside blank space.
origin: spec-deferred 08dd131042c7
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:172 with src/app/globals.css:2696
severity: low
reason: The card's wrapper is `grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]` (`WikiWorkbench.tsx:172`). `display: none` removes the second child from layout but not the track it sat in, so at the `lg:` breakpoint with `data-preview="true"` the receipt card stays pinned at 320px and the `1fr` column renders empty — space the sentence used to fill. The intent authorized a visibility change only ("Only its visibility while a Preview is docked changes"), so the diff is spec-compliant; whether the card should reflow to the full canvas width when the Preview docks is a UX call, not a mechanical fix. Adding a `grid-template-columns` override to the DW-39 rule would be cascade-safe (`workbench-split.test.ts:1247` keys on `lastIndexOf`, and this rule sits far ahead of the docked grid variants), so the blocker is the design decision, not the mechanism.
status: open
decision: 2026-08-19 Reflow to full width — Extend the DW-39 docked-preview rule with a `grid-template-columns` override so the canvas card takes the full canvas width when a Preview is docked, verifying it sits ahead of the docked grid variants the way `workbench-split.test.ts:1247`'s `lastIndexOf` check expects.

### DW-181: The `Edit` control stays live over a body a 404 has replaced, so the confirm dialog and then a `PUT` can be reached for a page the route says is not there.
origin: spec-deferred 42b15c1d03b0
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: src/components/workbench/PreviewColumn.tsx (the fetch handler's `gone` branch, and `canEdit`)
severity: medium
reason: The `gone` branch deliberately keeps the last payload, so `canEditPreview(payload)` is still true and the header goes on rendering `Edit` while the body shows `This file couldn't be loaded.`. `save()`'s guard compares `previewWriteTarget(payloadRef.current)?.key` against that same stale payload, so it passes and posts. Pre-existing — the old `failed` branch kept the payload the same way — but DW-54 narrowing `gone` to mean exactly "the row is not there" is what makes it legible as a defect rather than as one undifferentiated failure.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-preview-column-refresh-affordances

### DW-182: A live region rewritten with the identical string is not re-announced, so two consecutive silent refreshes that both change the body report as one.
origin: spec-deferred df75dfff157b
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: src/components/workbench/PreviewColumn.tsx and src/components/workbench/Workbench.tsx (both polite regions)
severity: medium
reason: `refreshAnnouncement` is set to the same `PREVIEW_UPDATED_COPY` literal each time, leaving the text node unchanged, and most assistive tech announces only on change. The shell's own region has had this shape since Story 1.3 (`setAnnouncement(workbenchMode(next).label)` re-announces nothing when the mode already showing is re-picked), so this is a house-wide property of both announcers rather than something this change introduced — but repeated same-page rewrites are the common case for DW-50 specifically. Fixing it needs a decision about the mechanism (a keyed node, an alternating suffix) that no test in a node or jsdom project can verify.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-preview-column-refresh-affordances

### DW-183: An unreachable refresh is the one refresh outcome that is never announced — the stale strip is a purely visual affordance.
origin: spec-deferred 0fba34343eca
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: src/components/workbench/PreviewColumn.tsx (the stale strip)
severity: low
reason: A successful silent swap says `Preview updated` and a 404 mounts a `role="alert"` body sentence, but an unreachable read only renders `.wb-preview-stale`, which carries no live region. A screen-reader user goes on reading bytes with no way to learn the column stopped being able to refresh them. Not required by DW-54's recorded decision (which asks for an indicator with a retry, not a sentence), and announcing every blip politely would chatter — so the wording and the threshold are a copy decision rather than a wiring fix.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-preview-column-refresh-affordances

### DW-184: Pressing `Retry` produces no in-flight feedback, so a slow retry is indistinguishable from a broken button.
origin: spec-deferred 8a133c7a6465
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: src/components/workbench/PreviewColumn.tsx (the `Retry` control)
severity: low
reason: A retry takes the silent-refresh path, so `loading` stays false by design (the point is not to flash `Loading…` at a reader), the strip renders unchanged, and a second failure is a no-op re-render. Adding an `aria-busy`/disabled pending state means a fifth flag in the column and a decision about whether the strip's label should change while a read is in flight.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-preview-column-refresh-affordances

### DW-185: No CSS layout rule in this repo is verified by anything that lays out a page — every breakpoint claim is a text scan of `globals.css`.
origin: spec-deferred 8bd6d98814e7
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: vitest.config.ts (no browser project); src/lib/__tests__/workbench-left-column.test.ts (the CSS scans)
severity: low
reason: `vitest.config.ts` has exactly two projects, `node` and `dom` (jsdom), and jsdom has no layout engine; there is no Playwright config, no `e2e/` directory and no browser project anywhere. So DW-34's user-visible payoff — "a docked column below 900px is reachable" — is pinned by `workbench-left-column.test.ts` asserting that declaration strings appear inside a slice of the stylesheet. That scan cannot show the new rule wins the cascade, that the released clamp actually makes the row reachable, or that the `[data-sheet-open]` counter-rule outranks the docked selectors. The mounted suite observes only that the shell ASKS the platform to scroll. Pre-existing and repo-wide: every earlier Workbench story verified its stylesheet half the same way. Closing it means adding a browser test project, which is a project-level decision rather than a fix to this change.
status: open
decision: 2026-08-19 Add a browser project — Add a real browser test project (Playwright, or Vitest browser mode) covering the layout claims the stylesheet scans currently stand in for — the 900px docked-column reachability, the split-handle geometry, and the sheet counter-rule — and mark the corresponding scan assertions as structural rather than behavioural once a real check exists.

### DW-186: Follow-up review still recommended for dw-workbench-preview-announcements after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-187: A read-only deployment still accepts page CREATION, revision revert, and bulk ingest deletion — three page-write doors that never consulted isReadOnly().
origin: spec-deferred 7a425c0e8357
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
location: src/app/api/wiki/route.ts:51, src/app/api/wiki/[slug]/revisions/route.ts:98, src/app/api/ingest/history/route.ts:107
severity: medium
reason: DW-37 gated PUT/PATCH/DELETE /api/wiki/[slug]. `POST /api/wiki` (src/app/api/wiki/route.ts:51), `POST /api/wiki/[slug]/revisions` with {action:"revert"} (src/app/api/wiki/[slug]/revisions/route.ts:98) and `DELETE /api/ingest/history` (src/app/api/ingest/history/route.ts:107) all write or delete pages through the same kernel lifecycle with no isReadOnly() check — verified by grep: the string does not appear in any of the three files. So "read-only" currently means a page cannot be edited or deleted one at a time, but can still be created, reverted to an older body, or deleted in bulk. Pre-existing; none of the three is named by DW-37, DW-65 or DW-149, and the spec's Never clause records them as out of scope.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-read-only-write-doors

### DW-188: The stdio MCP server writes pages through the library directly, so no HTTP route gate can reach the agent callers DW-37's reason claims it covers.
origin: spec-deferred a6adca8dbb43
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
location: src/mcp.ts
severity: low
reason: DW-37's reason says the fix belongs at the write route "where it also covers the MCP and agent callers". src/mcp.ts calls writeWikiPageWithSideEffects / patchMetadata / deleteWikiPage directly and only MIRRORS the REST ACL in comments (src/mcp.ts:283, :381) — it never issues an HTTP request. A read-only deployment therefore still accepts every MCP write. Pre-existing and structural: the gate would have to move into the library, or be restated in src/mcp.ts.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-read-only-write-doors
decision: 2026-08-19 Move the gate into the library — Enforce `isReadOnly()` inside the kernel writers (`writeWikiPageWithSideEffects`, `patchMetadata`, `deleteWikiPage`, `writeWikiArtifact`) so every caller inherits it, and reduce the HTTP-layer checks to the ones that shape the response, resolving DW-196 in the same move.

### DW-189: WikiWorkbench's Change template control opens a confirm dialog onto a route that already answers 403 on a read-only deployment.
origin: spec-deferred ed548e677477
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
location: src/components/WikiWorkbench.tsx:193
severity: low
reason: `PUT /api/wikis/[id]/template` has consulted isReadOnly() since before this work (src/app/api/wikis/[id]/template/route.ts:24), but the canvas card's Change template button (src/components/WikiWorkbench.tsx:193) opens its confirm dialog unconditionally — the same confirm-then-403 shape DW-149 names, one card away from the switcher this bundle fixed. Pre-existing; the bundle names WikiSwitcher only, and the canvas card is not under the shell seam this change threaded readOnly through.
status: done 2026-08-20
resolution: resolved by sweep bundle dw3-read-only-surface-affordances

### DW-190: `POST /api/ingest/reingest` rewrites an entire page body with no isReadOnly() gate, and its control sits on the same article action bar as the Delete button this bundle just gated.
origin: spec-deferred 948ef5e14a2f
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
location: src/app/api/ingest/reingest/route.ts:9, src/components/ArticleActions.tsx:127
severity: medium
reason: src/app/api/ingest/reingest/route.ts has its own comment saying "re-ingest rewrites the page" and runs the realm-aware write ACL, but never consults isReadOnly() (verified by grep: the string appears nowhere under src/app/api/ingest/). On a read-only deployment the owner is refused a one-line edit through the editor while Reingest replaces the whole body. `ArticleActions.tsx` renders Reingest and Graphify beside the now-aria-disabled Delete, and article-actions-gate.test.ts deliberately pins that they are NOT dimmed — correctly, since the routes behind them answer no refusal to mirror. Distinct from DW-187, which names page create, revisions revert and ingest-history delete but not reingest. Pre-existing; not named by DW-37, DW-65 or DW-149.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-read-only-write-doors

### DW-191: WorkspacePurposeSettings wraps its whole form in a `disabled` fieldset on a read-only deployment, so the stored purpose text becomes unreachable by keyboard — the DW-65 defect at full form scale.
origin: spec-deferred af274abf11df
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
location: src/components/WorkspacePurposeSettings.tsx:223
severity: medium
reason: src/components/WorkspacePurposeSettings.tsx:223 is `<fieldset disabled={loading || saving || readOnly || !wiki}>` around every field and the Save button (:331 disables Save again). `disabled` on a fieldset removes every descendant from the tab order, so a keyboard or screen-reader user cannot read the stored Workspace Purpose at all — the exact harm DW-65 names for the Settings selects, on a surface the bundle did not name. The file already renders the read-only sentence at :344, so only the refusal mechanism is wrong. Pre-existing; the spec's Code Map cites this file only as the copy pattern to follow.
status: done 2026-08-20
resolution: resolved by sweep bundle dw3-read-only-surface-affordances

### DW-192: `loadConfig()` answers `{}` for an UNREADABLE config as well as an absent one, so the settings route can merge a patch into an empty object and `saveConfig` writes away every stored field.
origin: spec-deferred 4b41f7d77923
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/lib/config.ts:197, src/app/api/settings/route.ts:156
severity: medium
reason: `src/lib/config.ts:197-209` catches every read/parse error, logs a `logger.warn` for anything that is not ENOENT, and returns `{}`. The settings route uses that value as BOTH the precondition's merge base and the object it spreads into. If a transient storage error hits the `GET`, the surface is seeded with `objectVersion({})`; if the same failure hits the `PUT`, the header matches, the guard reports "no conflict", and the merge lands on an empty config. Pre-existing — the route merged into `{}` and wrote before this change too, and the precondition makes the case strictly rarer, not more likely. Closing it means teaching the config loader to distinguish "absent" from "unreadable", which is a kernel change no DW entry in this bundle names.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-settings-write-precondition-integrity

### DW-193: The artifact route reads current bytes OUTSIDE the very per-owner lock its own writer takes, so the one route that already holds a lock still leaves the concurrent-save window open.
origin: spec-deferred f94acd1bd4a8
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/app/api/workbench/artifact/route.ts:149, src/lib/wikis.ts:556
severity: medium
reason: `src/app/api/workbench/artifact/route.ts` calls `readWikiArtifact` for the precondition, then `writeWikiArtifact`, which wraps its put in `withFileLock(wikiLockKey(owner))` (`src/lib/wikis.ts:556`). Moving the read and the check inside that same critical section would close the window at zero design cost — no new lock and no new lock ordering, which is what this spec's Never clause actually forbids. Not done here because it needs a precondition parameter threaded into `writeWikiArtifact` and an unlocked internal getter, and because the other two routes would then carry a weaker guarantee than this one.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-write-precondition-and-version-freshness

### DW-194: Requiring `If-Match` is an undocumented wire-contract change for the service-token REST path, which `middleware.ts` still describes as an unconditional write.
origin: spec-deferred 40d3b352a7ca
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/middleware.ts:30, src/app/api/wiki/[slug]/route.ts:174
severity: medium
reason: `src/middleware.ts:30-31` documents `/api/wiki/<slug>` mutations as authenticated by "Clerk session OR the system service token", and the PUT handler resolves `getServicePrincipal(req)` for exactly that caller. Any external agent issuing an unconditional `PUT` now receives a 428 carrying a sentence written for a human editor. No in-repo caller exists (verified: `tools/`, `scripts/`, `integrations/`, `workers/`, `skills/` carry no `api/wiki` or `api/settings` request), so nothing breaks in this tree — but no doc, and no test, covers the service-principal path against the guard. DW-38 names "Epic 8's loopback API" as a future third writer that would inherit this requirement.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-write-precondition-and-version-freshness

### DW-195: `readWikiPage`'s in-process `pageCache` can serve the Preview a stale body and now a stale VERSION, producing a 412 against a write the reader was never shown.
origin: spec-deferred e8332ca1afef
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/lib/wiki.ts:334, src/app/api/workbench/preview/route.ts:142
severity: medium
reason: `src/lib/wiki.ts:334-337` returns a cached page whenever `pageCache` is active, and `GET /api/workbench/preview` derives the version from exactly that value. The cache is ref-counted around bulk scans rather than held per-request, so no route in this bundle activates it today; the staleness is pre-existing for `body` and the version merely inherits it.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-write-precondition-and-version-freshness

### DW-196: The kernel page writer stays unguarded, so the ~18 non-HTTP callers of `writeWikiPageWithSideEffects` — including the ingest and agent writers DW-38 names as the reason the guard is needed — still clo
origin: spec-deferred cd37d8d20782
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/lib/lifecycle.ts:731
severity: medium
reason: The guard sits at the HTTP boundary, which is what the intent's operative clause asks for ("enforce `If-Match` on the three routes"), but every DW entry's `location` field also names a kernel writer (`src/lib/lifecycle.ts`, `writeWikiArtifact`, `saveConfig`). `writeWikiPageWithSideEffects` is called unconditionally from `src/mcp.ts`, `src/cli.ts`, `src/lib/agents.ts`, `src/lib/lint-fix.ts`, `src/lib/query.ts`, `src/lib/search.ts`, `src/lib/memory-proposals.ts`, `src/lib/document-sources.ts`, `src/lib/patch-metadata.ts`, `src/app/api/wiki/route.ts` and the revisions route. DW-38's own justification for doing the work now is "Epic 2 gives the same pages a second writer" — and that writer is an ingest path that never travels the guarded route.
status: open
decision: 2026-08-19 Decide with the Epic 2 ingest writer

### DW-197: `stableSerialize` collapses every non-plain object to `{}` and has no cycle or depth bound, so `objectVersion` can report "no change" between two genuinely different values.
origin: spec-deferred 2984302c303e
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/lib/write-precondition.ts:130
severity: low
reason: `Object.entries(new Date(...))` is empty, so two different `Date`s, `Map`s, `Set`s or class instances all serialize identically; a cyclic object recurses until the stack blows, where `JSON.stringify` would at least throw a catchable `TypeError`. Only caller today is the settings route over a parsed-JSON `AppConfig`, where none of these shapes can occur — but `objectVersion` is exported as a general primitive with an inviting name.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-settings-write-precondition-integrity

### DW-198: The Settings write precondition is a hash of the STORED SECRETS, and it is served to the browser beside the comment asserting no secret material crosses that boundary.
origin: spec-deferred d87cea3adf09
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/app/api/settings/route.ts:52, src/lib/write-precondition.ts:150
severity: medium
reason: `GET /api/settings` computes `objectVersion(await loadConfig())` over the whole parsed `AppConfig` — `firecrawlApiKey`, `customApiKey` and the embedding key included — and ships that string twice, at the top level and on `workbench`, four lines below the comment stating that `getWorkbenchSettings()` reduces the three secrets to `has*ApiKey` booleans "(AD-23)". The version is not the secret and the route is owner-only, so this is a weak confirmation oracle rather than key recovery, but it is secret-DERIVED material on a surface whose stated invariant is that none leaves the kernel. It cannot be fixed by hashing a redacted projection: the `PUT` merges into the whole config, so a version blind to the secret fields would miss exactly the lost update it exists to catch. Closing it needs a different scheme — an opaque token stamped on save and stored beside the config — which the intent forecloses by naming "the stored `AppConfig`" as the version's input.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-settings-write-precondition-integrity
decision: 2026-08-19 Stamp an opaque token — Replace the content-derived version with an opaque token generated on each successful `saveConfig` and stored beside the config, served as the precondition and compared on `PUT`. This restores the AD-23 boundary and keeps the guard's coverage of the secret fields; update `write-precondition.ts`'s docs so `objectVersion` is no longer presented as the settings scheme.

### DW-199: `isWorkbenchSettingsPayload` making `version` required turns a save that LANDED into a reported failure, and one absent field into a whole-canvas load failure.
origin: spec-deferred 7dbd4c8d1bf2
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/lib/workbench-settings.ts:359, src/lib/workbench-settings.ts:1028
severity: low
reason: `src/lib/workbench-settings.ts:359` now rejects a payload whose `version` is missing or empty, and `saveWorkbenchSettings` runs the 200 response through it — so a landed write would be answered `{ status: "error" }`, `SettingsCanvas` would keep its superseded version, and every later save would be refused 412 for a change the owner made themselves. `fetchWorkbenchSettings` fails the same way on read, taking every value off screen. Unreachable today: the route derives `version` from `objectVersion(fresh)`, which is always a non-empty string. Recorded because the two sibling clients deliberately chose the opposite tolerance (`isPreviewPayload` accepts absence, `useSettings` accepts a versionless 200), so the three payloads now answer the same question three ways and a fourth surface has no convention to follow.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-settings-write-precondition-integrity

### DW-200: A Schema draft held across an active-Wiki switch can still land on the OTHER Wiki's `schema.md` when both hold the identical seeded bytes.
origin: spec-deferred 18037df81052
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: src/app/api/workbench/artifact/route.ts:129
severity: medium
reason: `PUT /api/workbench/artifact` resolves `currentId` from the registry at request time and checks the precondition against THAT Wiki's artifact. Two Wikis seeded from the same template hold byte-identical `schema.md`, so the version matches and the draft is written to a Wiki it was never read from. Pre-existing and strictly improved by this change — the write was unconditional before, so the same draft landed on the other Wiki whatever its bytes were — but the guard does not close it, because a content version cannot distinguish two files that genuinely hold the same content. Closing it means binding the seeded Wiki id to the request, which no DW entry in this bundle names.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-write-precondition-and-version-freshness

### DW-201: Follow-up review still recommended for dw-write-preconditions-and-conflict-surface after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-202: On a case-sensitive store, `wiki/cased.md` and `wiki/cased.MD` now both list as rows for the one slug `cased`, and an edit from either row writes `<slug>.md`.
origin: spec-deferred 9fb5f09a4780
source_spec: `spec-dw-41-workbench-file-listing-gate.md`
location: src/lib/workbench-files.ts (wikiLeafSlug / wikiLeafFilter)
severity: low
reason: The listing became case-insensitive on the extension by deriving from `wikiLeafSlug` (`src/lib/workbench-files.ts`), which lowercases before testing `.md`. Both names therefore pass `readableWikiLeaf` for the same slug, and `resolveWorkbenchFile` builds a key from the name as written, so the two rows read two different objects. The preview route decides "is this the editable Page" from `wikiLeafSlug` alone, so a save reached from the `.MD` row lands on `wiki/cased.md` and the previewed bytes go stale. Pre-existing at the read and edit layers (the gate was already case-insensitive); this change adds the second visible door. Deciding what the tab should do when both exist — hide one, mark the pair, or refuse the slug — is a Files-tab surface decision beyond DW-41's recorded intent.
status: open
decision: 2026-08-19 List only the canonical file — When two leaves collide on the same wikiLeafSlug, list only the canonical `<slug>.md` row and drop the variant-cased sibling from the Files tab, so every visible row reads and writes the same object; add a test seeding both names on a case-sensitive store.

### DW-203: On a case-sensitive store, `wiki/cased.md` and `wiki/cased.MD` both list as rows for the one slug `cased`, and an edit from either row writes `<slug>.md`.
origin: spec-deferred 83c76aec8291
source_spec: `spec-dw-41-workbench-file-listing-gate.md`
location: src/lib/workbench-files.ts (wikiLeafSlug / wikiLeafFilter); the save half is src/app/api/workbench/preview/route.ts (slug derivation) and the wiki write path
severity: low
reason: The listing is case-insensitive on the extension because it derives from `wikiLeafSlug` (`src/lib/workbench-files.ts`), which lowercases before testing `.md`. Both names therefore pass `readableWikiLeaf` for the same slug, and `resolveWorkbenchFile` builds a key from the name as written, so the two rows read two different objects. The preview route decides "is this the editable Page" from `wikiLeafSlug` alone (`src/app/api/workbench/preview/route.ts`), so a save reached from the `.MD` row lands on `wiki/cased.md` and the previewed bytes go stale. Wholly pre-existing, and NARROWED rather than introduced by DW-41: the old `wikiLeafFilter` opened with `if (!name.endsWith(".md")) return true`, and `cased.MD` does not end in `.md`, so it listed UNGATED next to `cased.md` before this change; deriving from the read gate now at least subjects it to the slug set. Deciding what the tab should do when both exist — hide one, mark the pair, or refuse the slug — is a Files-tab surface decision beyon
status: open

### DW-204: "A direct child of the wiki root" is now spelled three independent times, and only a test binds them together.
origin: spec-deferred 0c82c718ee92
source_spec: `spec-dw-41-workbench-file-listing-gate.md`
location: src/lib/workbench-files.ts (wikiLeafFilter, resolveWorkbenchFile); src/app/api/workbench/preview/route.ts
severity: low
reason: `wikiLeafFilter` says `depth === 1` (`src/lib/workbench-files.ts`), `resolveWorkbenchFile` says `rest.length !== 1` in a different numbering, and the preview route says `segments.length === 2 && segments[0] === "wiki"`. DW-41 derived the NAME half from one predicate (`readableWikiLeaf`) precisely so it could not drift; the DEPTH half was left restated in each place, held together only by the new "never lists a wiki path the read gate would refuse" test and by prose warnings in three doc comments. Extracting a single shared predicate is not blocked by DW-41's Block If, which froze only the two FILTERS as distinct functions — but it touches the preview route's page/file disambiguation, which DW-41's intent puts out of bounds.
status: open

### DW-205: The widened 24px grab strip now overlays the leftmost 24px of the canvas and of the docked Preview, so a click, text selection or touch-pan that starts there hits the divider instead of the content.
origin: spec-deferred 2f67eae2f508
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
location: src/app/globals.css (.wb-split-handle--tree, .wb-split-handle--preview)
severity: low
reason: `.wb-split-handle` is `z-index: 2`, `cursor: col-resize`, `touch-action: none` and full height, and both modifiers now start AT their boundary and extend 24px right. `.wb-canvas-pad` and `.wb-preview-body` are both `padding: ... var(--wb-space-4)` = 16px, so the strip covers the whole gutter plus ~8px of real content in each pane: the first characters of a line, and a wikilink sitting at the left margin, are unclickable and unselectable, and on a touchscreen at 1200px+ that band cannot be panned. DW-44's ledger named "eat 12px of the canvas edge" as the known cost of widening and its decision took the trade anyway, so this is authorised rather than accidental - but the decision reasoned about scrollbars, never about what the strip would cover, and 24px offset to one side eats twice what the entry quantified. Choosing between a narrower strip that misses SC 2.5.8, matching left padding on both panes, and a documented exception is the same chrome decision DW-44 was, one boundary further
status: open
decision: 2026-08-19 Widen the content padding to match — Raise .wb-canvas-pad and .wb-preview-body left padding to at least the hit-strip width so the strip covers only gutter, never text, keeping the 24px target that satisfies SC 2.5.8; pin the relationship between the padding and --wb-split-hit so they cannot drift.

### DW-206: One stored tree scroll offset per tab is shared across the 900px breakpoint, where `.wb-tree-body` is capped at 40vh - so crossing into the narrow layout restores a desktop offset the browser clamps,
origin: spec-deferred d620d0a1c5f8
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
location: src/components/workbench/TreePanel.tsx (the two scroll effects), src/lib/workbench-state.ts (WORKBENCH_TREE_SCROLL_KEY)
severity: low
reason: `globals.css` caps `.wb-tree-body` at `max-height: 40vh` below 900px, a far shorter scroll range than the desktop column. The restore effect assigns `panel.scrollTop = readStoredTreeScroll()[tab]`; a value past the narrow maximum is clamped by the browser, the clamp fires a `scroll` event, and the persist effect writes the clamped number back - so widening again lands the tree somewhere it never was. This is pre-existing in kind: a narrow LOAD already does exactly this, because `WORKBENCH_TREE_SCROLL_KEY` stores one offset per tab and not one per width. DW-47's listener does not create it, but it adds a second route into it (resizing) that used to be inert. Closing it means keying the stored offset by width band, or skipping the persist for a write the restore itself provoked - either is a storage-shape decision, not a patch.
status: open

### DW-207: A divider's hover and focus-visible states paint an identical 1px `var(--wb-border)` line, so keyboard focus is visually indistinguishable from hover, and a border-token hairline is unlikely to clear
origin: spec-deferred 7afb956d7e51
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
location: src/app/globals.css (.wb-split-handle:hover::before, .wb-split-handle:focus-visible::before)
severity: low
reason: `globals.css` declares one rule for both states: `.wb-split-handle:hover::before, .wb-split-handle:focus-visible::before { background: var(--wb-border); }`. Two separate problems sit on it. First, SC 1.4.11 wants a focus indicator at 3:1 against adjacent colours, and `--wb-border` is chosen to be a quiet separator colour against exactly the panel surfaces it now has to stand out from - the last pass's `--wb-split-hit--preview::before { left: 1px }` patch made the indicator VISIBLE (WCAG 2.4.7) without touching whether it is visible ENOUGH. Second, the two states are pixel-identical, so a keyboard user cannot tell focus from a stray pointer, and DW-44's widening enlarges the hover region that produces the focus appearance from 9px to 24px. This is pre-existing from Story 1.6 in kind - neither the colour nor the shared rule changed here - but the widened strip is what makes the ambiguity routine. Fixing it means choosing an indicator token (an outline, a second colour, a wider rule) agai
status: open

### DW-208: TreePanel's persist effect cancels a pending requestAnimationFrame write in its cleanup without flushing it, so a scroll in the last frame before a tab switch, a collapse, or now a breakpoint crossing
origin: spec-deferred 246ae7a17f3f
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
location: src/components/workbench/TreePanel.tsx (the persist effect's cleanup)
severity: low
reason: The persist effect coalesces through one frame (`if (frame !== 0) return; frame = requestAnimationFrame(...)`) and its cleanup ends `if (frame !== 0) cancelAnimationFrame(frame);` - the queued `writeStoredTreeScroll(tab, panel.scrollTop)` never runs. The restore effect then re-runs on the same dep change and assigns the stored value, which is now one frame stale. Pre-existing for `tab` and `collapsed`; DW-47's `narrow` dep adds resizing as a third route into it. The fix is not a safe one-liner: at cleanup time React has already committed the DOM, so on a collapse the panel can be `display: none`, where `scrollTop` reads 0 - and the obvious guard does not help, because `treeBodyShowing(panel, collapsed)` closes over the STALE `collapsed` (still `false`) and `treeScrollActive` returns `!collapsed || rendered`, i.e. `true` regardless of the element. A correct flush has to ask the element directly (`panel.getClientRects().length > 0`), and jsdom answers for every attached element, so the g
status: open

### DW-209: `renameWiki` rewrites `purpose.md` under the tenant lock without moving `dataVersion`, so a Preview open on that artifact keeps the old heading.
origin: spec-deferred 4e2733a570b3
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
location: src/lib/wikis.ts (renameWiki / retitlePurpose)
severity: medium
reason: `retitlePurpose` (src/lib/wikis.ts) writes the retitled `purpose.md` through the same tail-less `putWikiArtifact` the seeder uses, and `renameWiki` adds no bump. Renaming a NON-current Wiki changes no `currentWikiId`, so `Workbench`'s selection-reset effect does not fire either — the same DW-57 shape, one artifact over. Milder than DW-57 because `purpose.md` is not in `EditableArtifactFile`, so the stale column is read-only and there is no silent-revert half. Out of scope here: the bundle intent names the seeding and re-apply paths only.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-wikis-sweep-cap-and-rename-refresh

### DW-210: A re-apply whose `restoreSeededFiles` compensation itself fails leaves changed bytes on disk with no `dataVersion` bump at all.
origin: spec-deferred 6526deb5b008
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
location: src/lib/wikis.ts (applyScenarioTemplate catch / restoreSeededFiles)
severity: low
reason: `restoreSeededFiles` is fail-soft per entry: it warns and swallows, so a restore that cannot write leaves the wiki with some NEW template bytes (the state its own warning calls "may now describe two different scenario templates") while `applyScenarioTemplate` re-throws and skips the tail. An open Preview then holds bytes that really did change with nothing to tell it so. Rare and already-degraded, but the one path where "no commit means nothing to refresh to" is not true.
status: open

### DW-211: DW-49's raw-source half is untouched — no writer under `tenants/<t>/raw/` exists yet, so it needs re-checking when Epic 2 Ingest lands one.
origin: spec-deferred 376f1759e471
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
location: src/lib/wikis.ts, src/lib/lifecycle.ts
severity: medium
reason: DW-49 names three classes of bypassing writer: template seeding, raw source files, and "any later writer that lands bytes the Files tab renders". Only the first is closed here. A grep of `src/lib` finds no writer under `tenants/<t>/raw/` today, so there is nothing to bump; the guard test in `workbench-data-version.test.ts` will fail the moment a fourth bump site appears, which is the intended tripwire.
status: open

### DW-212: `dataVersion` is one global key with no tenant segment, so the two new bumps force a `router.refresh()` in every open Workbench of every other tenant too.
origin: spec-deferred 1e08fbc6dc92
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
location: src/lib/data-version.ts:31 (DATA_VERSION_KEY), src/app/api/workbench/version/route.ts
severity: low
reason: `DATA_VERSION_KEY = "data-version"` (src/lib/data-version.ts:31) has no owner in it, and `GET /api/workbench/version` serves that single integer to everyone. Pre-existing — `writeWikiArtifact` and the page lifecycle already bump the same global key — but this change widens the set of operations that trigger a cross-tenant server re-render from "someone edited a page" to "someone anywhere created a Wiki". Not a correctness bug: a refresh is idempotent and each client re-renders its own tenant's data. The fix is a per-tenant key, which is a storage-layout change well outside this bundle.
status: done 2026-08-20
resolution: closed by human decision: Accept the single global key under the single-owner deployment stance `src/lib/owner.ts` records: a cross-tenant refresh is idempotent and correct, DW-159's ownership gate on `POST /api/wikis` removes the accidental second-tenant path this sweep, and a per-tenant key is a storage-layout change with no correctness payoff while one owner exists.
decision: 2026-08-20 Keep the global key — Accept the single global key under the single-owner deployment stance `src/lib/owner.ts` records: a cross-tenant refresh is idempotent and correct, DW-159's ownership gate on `POST /api/wikis` removes the accidental second-tenant path this sweep, and a per-tenant key is a storage-layout change with no correctness payoff while one owner exists.

### DW-213: A successful re-template overwrites an owner-edited `schema.md` with template bytes and takes no revision snapshot, so DW-59's recovery path does not cover the other operation that destroys the same f
origin: spec-deferred 0847f138003a
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
location: src/lib/wikis.ts (applyScenarioTemplate / seedWikiArtifacts)
severity: medium
reason: `applyScenarioTemplate` -> `seedWikiArtifacts` -> `putWikiArtifact` writes both artifacts with no prior read. `snapshotSeededFiles` holds the pre-seed bytes in memory and `restoreSeededFiles` is called only from the `catch`, so it is a rollback for a FAILED seed, not history: a re-template that COMMITS discards the snapshot and the owner's edited Schema is gone exactly as DW-59 describes. The recorded decision scopes read-before-write to `writeWikiArtifact`, so this is out of scope on the intent's own authority rather than a miss.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-artifact-revision-recovery

### DW-214: The artifact history API has no client — no Workbench surface lists or reverts artifact revisions, so the recovery path is unreachable from the running app.
origin: spec-deferred d5925f928e90
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
location: src/components/workbench/PreviewColumn.tsx, src/lib/workbench-preview.ts
severity: medium
reason: `grep -rn "artifact/revisions" src` returns only the route and its test. The page equivalent has both halves: `GET/POST /api/wiki/[slug]/revisions` plus `src/components/RevisionHistory.tsx` (expand -> list -> view -> revert), and `workbench-preview.ts` owns `ARTIFACT_WRITE_ROUTE`/`artifactWriteUrl` but gained no history helper. The intent named the route as the exposure surface and the spec's Never list excludes UI, so the API-only shape is correct for this story — the follow-up is wiring the Schema editor to it.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-artifact-revision-recovery

### DW-215: Artifact revisions accumulate with no cap or pruning and are walked by the backup scan, which throws rather than degrades at its safety limits.
origin: spec-deferred 5d7e90742d9d
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
location: src/lib/wiki-artifact-revisions.ts, src/lib/backups.ts:56-85
severity: medium
reason: Every `writeWikiArtifact` writes a full copy under `tenants/<t>/wikis/<id>/revisions/<file>/` with no retention policy (deliberate — page revisions have none either), and `listWikiArtifactRevisions` stats every revision on each GET with an unbounded `Promise.all`. `src/lib/backups.ts` walks all of `tenants/<t>` against `MAX_BACKUP_FILES = 10_000` / `MAX_BACKUP_BYTES = 2 GB` and throws "Backup exceeds the safety limit" rather than degrading. Page revisions spread across slugs; these pile into one directory per artifact.
status: open
decision: 2026-08-20 Cap revisions and degrade backups — Add a retention cap with pruning in saveWikiArtifactRevision plus a bounded listing, and make the backup walk truncate-with-a-flag at MAX_BACKUP_FILES/MAX_BACKUP_BYTES instead of throwing.

### DW-216: Follow-up review still recommended for dw2-per-wiki-artifact-revisions after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-217: The legacy flat `PUT /api/settings` branch writes `embeddingModel` without running the vector gate, so a flat-only save can now silently switch effective vector search off.
origin: spec-deferred be65cc16b535
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/app/api/settings/route.ts:243-270
severity: medium
reason: `src/app/api/settings/route.ts:243-256` writes `body.embeddingModel` unconditionally; the gate runs only inside `if (body.workbench !== undefined)` at :270. The live `/settings` page sends exactly that flat shape (`src/hooks/useSettings.ts:245`) and DW-61's 2026-08-18 decision keeps that page. Verified against the real route: store `{ vectorSearchEnabled: true, embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" }`, then PUT `{ embeddingModel: "text-embedding-3-small" }` with no `workbench` key -> 200, and `getVectorSearchSettings().enabled` drops to false. Before DW-73 the same write was harmless (the resolver fell back). The flat branch has never validated anything by explicit design ("a body with no `workbench` produces byte-identically the same saved object"), so closing it is a decision about legacy compatibility, not a patch.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-settings-flat-branch-validation
decision: 2026-08-19 Validate the flat branch too — Run the vector gate on the resulting config in the flat branch as well, so a flat PUT that would turn effective vector search off is refused 400 with the same sentence the Workbench surface shows; pin the reproduction above as a route test.

### DW-218: An `EMBEDDING_MODEL` env override in the wrong namespace refuses vector search with a sentence the owner cannot act on from the Settings box.
origin: spec-deferred 9cfdb86b9ca5
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/workbench-settings.ts (vectorSearchMissingCopy) with src/lib/config.ts:512
severity: medium
reason: All three feeders take the env value ahead of anything typed or stored (`mergedVectorInputs`, `draftVectorInputs`, `src/lib/config.ts:512`), so the refusal stands even after the owner types a `@cf/` id and saves — pinned by the new test "does not let a TYPED matching id lift a refusal the env override owns". The copy names the namespace but never names the variable, and `VectorSearchInputs` carries no origin field, so an origin-aware sentence ("unset EMBEDDING_MODEL") is a shape change to the predicate's inputs rather than a wording fix. Pre-DW-73 that deployment ran with the provider default instead.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-vector-gate-surface-feedback

### DW-219: A deployment already storing a namespace mismatch with vector search on now gets a 400 on EVERY Workbench settings save, including edits to unrelated fields.
origin: spec-deferred 1eee0ecfc70f
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/workbench-settings.ts (validateWorkbenchSettingsPatch)
severity: medium
reason: `settingsSaveBody` always carries `vectorSearchEnabled` (`src/lib/workbench-settings.ts`), and `validateWorkbenchSettingsPatch` re-runs the vector rule whenever the resulting flag is true, so a chat-model or timeout edit is refused with the namespace sentence until the model is fixed or the switch unchecked. The mechanism is pre-existing and identical for the endpoint/key legs; DW-73 adds one more state that triggers it. The owner can recover (the switch may always be turned OFF), so this is friction, not a trap.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-vector-gate-surface-feedback

### DW-220: The gate checks the namespace but not that the id is a usable Workers AI EMBEDDING model, so a bare `@cf/` or a vision id passes.
origin: spec-deferred 90d558e058af
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/providers.ts (embeddingModelMatchesProvider)
severity: low
reason: `"@cf/".startsWith("@cf/")` is true, and `@cf/llava-hf/llava-1.5-7b-hf` (`src/lib/vision.ts:19`) satisfies the leg for `workers-ai`; both fail at `ai.run()` instead. `WORKERS_AI_EMBEDDING_DIMENSIONS` (`src/lib/embeddings.ts:35-43`) already enumerates the four supported ids and could back a membership check, but it is unexported and lives in a module client-safe code cannot import. Pre-existing: both inputs were accepted before DW-73 too.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-embedding-resolution-namespace-hardening

### DW-221: The gate reads a trimmed model while `resolveEmbeddingModelName` reads the raw stored string, so a stored id with leading whitespace passes the gate and is still dropped at resolution.
origin: spec-deferred a3c81a10def4
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/app/api/settings/route.ts:247 with src/lib/embeddings.ts:180-186
severity: low
reason: `getVectorSearchSettings` reads `nonEmpty(cfg.embeddingModel)` (`src/lib/config.ts:512`, trims) and both feeders trim, while `resolveEmbeddingModelName` tests `override.startsWith(...)` on the raw value (`src/lib/embeddings.ts:180-186`). The legacy flat branch stores `body.embeddingModel` untrimmed (`src/app/api/settings/route.ts:247`), so a stored `" @cf/baai/bge-m3"` under `workers-ai` satisfies the gate and is then replaced by the default — the exact substitution DW-73 exists to prevent. Reachable only by a direct API call, since both UIs trim.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-embedding-resolution-namespace-hardening

### DW-222: The refusal calls the provider "Workers AI" while the picker two rows above calls the same selection "Cloudflare Workers AI".
origin: spec-deferred 1b9ba6bd81b9
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/workbench-settings.ts (vectorSearchMissingLegs)
severity: low
reason: `embeddingProviderLabel("workers-ai")` returns "Cloudflare Workers AI" and populates the embedding-provider `<option>` (`SettingsCanvas.tsx:451-455`), while the namespace sentence types "Workers AI". Deriving the name from `embeddingProviderLabel` was implemented during review and then reverted: the frozen I/O matrix in this spec's intent-contract pins the sentence text verbatim, and step-03's matrix audit forbids editing an expectation to match changed code. Worth doing as its own change, matrix text included.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workers-ai-label-parity
decision: 2026-08-19 Derive the label, update the matrix — Derive the provider name in vectorSearchMissingLegs from embeddingProviderLabel so the refusal and the picker always agree, and update spec-dw-73's frozen I/O matrix text in the same change, recording that the frozen expectation was renegotiated deliberately for copy consistency.

### DW-223: The namespace complaint is announced on the vector checkbox, not on the embedding-model field that actually holds the wrong value.
origin: spec-deferred abe456693455
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/components/workbench/SettingsCanvas.tsx (textRow "embeddingModel")
severity: low
reason: `SettingsCanvas.tsx:519` renders `vectorSearchMissingCopy` as the checkbox's `aria-describedby` hint; the model input built by `textRow` has no `aria-invalid` and no description tying the failure to it. Changing the provider select (`:445-448`) leaves the model untouched, so the ordinary way into this state is an edit to a control that shows no error at all.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-vector-gate-surface-feedback

### DW-224: The path that actually embeds is untaught about the namespace rule, so the owner's model choice is still replaced without a word wherever the gate is not consulted.
origin: spec-deferred 29b372e0cc6c
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/embeddings.ts (hasEmbeddingSupport) with src/lib/ingest.ts:989
severity: medium
reason: `getVectorSearchSettings()` has no production consumer — grepping `src/` returns only its own definition (`src/lib/config.ts:506`) and two comments. Ingest embeds on `hasEmbeddingSupport()` (`src/lib/ingest.ts:989`), which `src/lib/workbench-settings.ts:452` deliberately leaves untaught, so a mismatched deployment keeps embedding under the substituted provider default. DW-73 refuses the mismatch at the Settings surface, which is what the ledger decision asked for; the substitution the ledger described as the harm survives on the embed path. Out of scope on the intent's own authority ("the namespace guard is pre-existing"; the decision names the surface, not the resolver), and now documented in `DEPLOY.md` rather than hidden.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-embedding-resolution-namespace-hardening

### DW-225: The vector gate has no Cloudflare-binding leg, so `workers-ai` with a matching `@cf/` id passes on a deployment where nothing can ever embed.
origin: spec-deferred cd8a690ae5d7
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/workbench-settings.ts (vectorSearchMissingLegs) with src/lib/embeddings.ts:55-72
severity: medium
reason: `resolveEmbeddingProvider` returns `getWorkersAiBinding() ? override : null` (`src/lib/embeddings.ts:100-102`), and `getWorkersAiBinding()` returns null off the Workers runtime — silently, by design. `vectorSearchMissingLegs` treats `workers-ai` as self-transporting and asks only for a provider and an in-namespace model, so on Docker the switch turns on and every embed resolves to no provider at all. Pre-existing: the same was true before DW-73 with any model id. Teaching the gate would mean giving a client-safe predicate a runtime-only fact, which is a shape change rather than a leg.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-vector-gate-surface-feedback

### DW-226: `resolveEmbeddingModelName` drops a mismatched override with no log, while its sibling misconfiguration warns.
origin: spec-deferred 75c0edb48a0f
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/embeddings.ts:180-192
severity: low
reason: `resolveEmbeddingProvider` emits a `logger.warn` naming the bad value when `EMBEDDING_PROVIDER` is not embedding-capable (`src/lib/embeddings.ts:93-99`), but the namespace fallback one function below is silent. Since DW-73 the fallback is reached only on paths the gate does not cover (the legacy flat route branch, an env override, a vector-off deployment), which is exactly where a one-line warn naming the dropped id and the model actually used would be diagnosable. Pre-existing silence; the spec's Never list also pins the fallback's behaviour, and a log is not behaviour.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-embedding-resolution-namespace-hardening

### DW-227: A whitespace-only `EMBEDDING_MODEL` is handed to the provider verbatim as the embedding model name, while the vector gate reads the same value as absent.
origin: spec-deferred bebc4469f137
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/lib/config.ts:175-177 with src/lib/embeddings.ts:180-183
severity: low
reason: `getEmbeddingModelOverride()` returns `process.env.EMBEDDING_MODEL` raw (`src/lib/config.ts:175-177`) with no `nonEmpty`, and `resolveEmbeddingModelName` guards on truthiness only, so `" "` is truthy. `embeddingModelMatchesProvider(provider, " ")` is TRUE for every non-`workers-ai` provider (`" ".startsWith("@cf/")` is false, which equals `provider !== "workers-ai"`), so the blank string is returned as the model name and reaches the provider call. `getVectorSearchSettings` reads the same env var through `nonEmpty` (`src/lib/config.ts:512`), which trims it to null, so the gate reports "a model" missing while the resolver embeds with a blank id. Pre-existing: the pre-DW-73 resolver used the same truthiness guard. Distinct from the leading-whitespace item above — that one substitutes the provider default, this one sends an empty name.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-embedding-resolution-namespace-hardening

### DW-228: The new mounted settings test duplicates about sixty lines of an existing workbench test's harness verbatim.
origin: spec-deferred 29c84000c317
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
location: src/components/workbench/__tests__/settings-vector-namespace.test.tsx
severity: low
reason: `payload()`, the `fetchMock` `beforeEach`/`afterEach`, `announcedFor()` and `mount()` are copied word for word — doc comments included — from `src/components/workbench/__tests__/settings-read-only.test.tsx:26-101`. Two independently maintained copies of a screen-reader assertion helper is the same drift the shared `embeddingModelMatchesProvider` predicate exists to prevent on the production side. Extracting a shared workbench test helper edits a passing test file outside this story's surface, so it is a focused cleanup rather than an in-pass patch.
status: open

### DW-229: LintIssueCard's hand-copied `fixableTypes` set omits `supersedes-dangling`, so one of the ten auto-fixable lint checks renders with no Fix button.
origin: spec-deferred f19a42b24e75
source_spec: `spec-dw-75-76-lint-check-parity-and-disputed-surface.md`
location: src/components/LintIssueCard.tsx:25
severity: medium
reason: `src/components/LintIssueCard.tsx:25-35` lists nine types. `fixLintIssue` auto-fixes `supersedes-dangling` via `fixSupersededDangling` (`src/lib/lint-fix.ts:710-712`), and `SCHEMA.md` advertises it as one of the ten fixable checks. This is the same hand-copied-list drift class as DW-75, in the sibling list this story did not touch; nothing observes it.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-hand-copied-list-parity

### DW-230: Disputed transitions still write talk reconciliation threads that no surface can read, since talk's HTTP routes are retired.
origin: spec-deferred 7895126181f4
source_spec: `spec-dw-75-76-lint-check-parity-and-disputed-surface.md`
location: src/lib/patch-metadata.ts:173
severity: medium
reason: `ensureReconciliationThread` (`src/lib/talk.ts:203-229`) is still called on every disputed false->true transition from `src/lib/ingest.ts`, `src/lib/merge.ts` and `src/lib/patch-metadata.ts:173-181`, while the talk HTTP surfaces 404 via `src/lib/retired.ts`. Threads accumulate on disk unreadable. Pre-existing and outside DW-75/DW-76, but it is the other half of the loop the DW-76 decision describes.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-authz-realm-parity-and-read-gates
decision: 2026-08-19 Stop writing the threads — Remove the ensureReconciliationThread calls from ingest.ts, merge.ts and patch-metadata.ts so a disputed transition no longer writes a thread nothing can read, leaving the DW-76 disputed-pages view and clear action as the whole loop; keep the talk module for the surfaces that still read existing threads.

### DW-231: The edit route answers a dead slug with a rendered "Page not found — nothing to edit" body at HTTP 200, the same defect DW-85 fixed on the page view, and this story's tests now pin that 200 in place.
origin: spec-deferred 08fb49a7fb70
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/app/u/[handle]/[slug]/edit/page.tsx:24
severity: low
reason: src/app/u/[handle]/[slug]/edit/page.tsx returns JSX from its miss branch rather than calling notFound(). DW-85's intent text scopes the 200->404 conversion to the page-view route only, so this story deliberately left it; DW-84's own ledger text is inaccurate here, asserting both non-page routes "keep their pre-existing hard-404 miss behavior" when only /raw/ does. The edit/ segment also has no not-found.tsx of its own, so an honest 404 there needs one carrying the surface-specific copy (the sibling [slug]/ and raw/[slug]/ segments each have one). Pre-existing; surfaced by this change's review.
status: open

### DW-232: tenantForSlug still resolves a slug through inherited-prototype indexing, the exact defect DW-89 fixed in resolveSlugPath, one file over.
origin: spec-deferred 2a3579814c9e
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/lib/wiki.ts:126
severity: low
reason: src/lib/wiki.ts:130 does `pageIdx[slug]` and :136 does `map[slug] ?? tenantForOwner(undefined)`, both over plain object literals — so a page titled "Constructor" would short-circuit the fast path on Object.prototype.constructor, or return that function as a tenant. Currently inert: the function's only callers are in tenant-paths.test.ts, no production path. The structural fix is to build these maps with a null prototype at their construction sites (buildSlugTenantMap, /api/wiki/routes, the log page's literal) rather than guarding each lookup. Byte-identical to the pre-story idiom; this story hardened only the link path.
status: open

### DW-233: The machine surfaces GET /api/wiki/[slug] and /api/raw/[slug] still hard-404 a merged-away slug, so agents and MCP clients now get a different answer than the UI for the same bookmark.
origin: spec-deferred f09cb6af046e
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/app/api/wiki/[slug]/route.ts
severity: low
reason: This story wired aliasTargetForMissing into all three /u/ routes, so the page, edit and raw views forward. The JSON routes were never in scope — the intent names only the edit and raw owner-scoped routes — and were already hard-404 before it. The asymmetry is new even though neither side changed: forwarding the HTML surfaces is what made the API's behavior a divergence rather than the uniform rule. Either forward there too, or return the canonical slug in the 404 envelope so a client can follow it.
status: open

### DW-234: A component mounted while /api/wiki/routes was failing keeps DEFAULT_TENANT hrefs for its whole lifetime, because useSlugTenants has no refresh path after its mount effect.
origin: spec-deferred 9d5e0be11183
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/hooks/useSlugTenants.ts:56
severity: low
reason: src/hooks/useSlugTenants.ts's effect has an empty dependency array, so it loads once per mount. DW-87's fix makes the SESSION recover — the next cold caller re-fetches and caches a good map — but a component already mounted during the outage never re-reads it. Links still work through the 308 fallback, so the consequence is a stale wrong-handle hop on one component until it remounts, not breakage. The empty-dep mount effect pre-dates this story; DW-87 only changed what the cache holds.
status: open

### DW-235: scripts/setup-cloudflare.sh:113 prints the stale display brand "yopedia — Cloudflare Infrastructure Setup" to the operator's terminal.
origin: spec-deferred 0ccea9511710
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: scripts/setup-cloudflare.sh:113
severity: low
reason: Same class as the `# Yopedia sandbox runner` heading this bundle fixed, but in a root the intent authorized scanning, not editing. The surrounding `yopedia-raw`, `yopedia-embeddings-bge-m3` etc. on lines 119-163 are Cloudflare resource names and must stay frozen; only the line-113 banner is display copy.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-display-copy-residue

### DW-236: DW-92's fix has no regression guard — "Yopedia" display prose can return to any maintainer surface with CI green.
origin: spec-deferred 28803e5d8656
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: medium
reason: Both maintainer scans test only `workwiki` spellings. Confirmed during review by restoring `# Yopedia sandbox runner` at workers/sandbox-runner/README.md:1 and by planting `<title>Yopedia Growth Journal</title>` in journal-site/build.mjs and `# Using Yopedia as an agent` in public/agent-api.md: all 12 tests still passed. A Yopedia dimension over maintainer roots needs per-path exemptions for the prose in README.md:186,208, BACKLOG.md:1,3, docs/trusted-memory-roadmap.md:4,94 and workers/email-ingest/README.md:1,5,19, which this bundle's intent does not authorize.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-scan-coverage

### DW-237: workers/email-ingest/README.md still says "Yopedia", so the two Worker READMEs in workers/ now disagree on the product name.
origin: spec-deferred bd43323d6e3a
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: workers/email-ingest/README.md:1
severity: low
reason: Lines 1, 5 and 19. Out of this bundle's scope — the intent names only workers/sandbox-runner/README.md:1 — but the pair now reads half-renamed.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-display-copy-residue

### DW-238: The stronger stray-workwiki rule guards only maintainer docs; the shipped app tree still uses the case-sensitive literal check.
origin: spec-deferred f5f2a244a9e7
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: medium
reason: `hasStrayWorkwiki` runs over `maintainerSources()` only, while `scannedSources()` (src/app, src/components, workers/, the browser clipper) keeps `saysStaleDisplayName` alone. Confirmed by planting `// Workwiki local sync` in src/components/LocalSyncPanel.tsx: suite stayed green. Extending the predicate to `scannedSources()` needs three more allowlist entries for real identifiers found there: `workwikiDefaultTags` (integrations/browser-clipper/popup.js:12,13,25), `save-to-workwiki` (integrations/browser-clipper/service-worker.js:3), and the `https://hooks.example.com/workwiki` placeholder (src/components/IntegrationDesk.tsx:114).
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-scan-coverage

### DW-239: This spec's stated reason for keeping the four new roots out of scannedSources() is wrong for three of them.
origin: spec-deferred ff31b1fa5979
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: The intent-contract says they "carry capital-Y Yopedia prose and yologdev/yopedia links that would fail the yopedia-identifier test". Running IDENTIFIER_ALLOWLIST over each root during review gave zero offenders for public/, journal-site/ and .opencode/commands/ — journal-site/build.mjs:11-12's yologdev/yopedia links are already allowlisted. Only scripts/setup-cloudflare.sh actually offends. The exclusion still stands on the intent's authority (it says extend maintainerSources()), but public/ and journal-site/ could be folded into scannedSources() today at no cost.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-scan-coverage

### DW-240: skills/work-wiki-mcp/SKILL.md is hand-authored, brand-named, and read by no scan.
origin: spec-deferred 970d96b7a1a8
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: skills/work-wiki-mcp/SKILL.md
severity: low
reason: Tracked in git and literally named for the product, yet skills/ is in neither scannedSources() nor maintainerSources(). Same class as the public/ gap this bundle closed; the root simply was not named in the intent.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-scan-coverage

### DW-241: AGENTS.md's frozen list still omits four live WORKWIKI_* family members.
origin: spec-deferred 4cafc2bd11e4
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: AGENTS.md:12
severity: low
reason: `workwiki-actions.ics` (src/app/api/integrations/calendar/route.ts:28), the export filename prefix (src/app/api/archive/export/route.ts:14), the clipper's `workwikiDefaultTags` storage key and `save-to-workwiki` context-menu id (integrations/browser-clipper/), and the `www.workwiki.app` variant. The intent enumerated four items; `workwiki-portable-archive` was patched in during review because a rename there breaks re-import of archives already on disk. The rest need per-item verification before being frozen in prose.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-display-copy-residue

### DW-242: The DW-93 freeze fact lives inside a managed block whose own header says inside-block edits are replaced on refresh.
origin: spec-deferred bc5d931b1066
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: AGENTS.md:2
severity: low
reason: AGENTS.md:2 reads "edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers", while bmad-project-context's Refresh step re-verifies existing lines rather than regenerating. The intent asked for the managed block, so placement follows the intent; but whether the fact survives depends on which behavior the next refresh actually has. The machine-checked WORKWIKI_IDENTIFIER_ALLOWLIST is the durable half of the guard.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-display-copy-residue

### DW-243: wrangler.jsonc files and root non-markdown are unscanned though AGENTS.md freezes their resource names.
origin: spec-deferred 49b6ba9ef745
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: maintainerSources() walks workers/ for markdown only, and the root listing is markdown-only, so wrangler.jsonc, workers/*/wrangler.jsonc, package.json, mcp.json and Dockerfile are read by nothing. AGENTS.md explicitly calls "every resource name in both wrangler.jsonc files" frozen.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-scan-coverage

### DW-244: Three overlapping extension filters with no shared definition; each omits types the others cover.
origin: spec-deferred cdc2c1304d4b
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: src/lib/__tests__/brand-copy.test.ts:116
severity: low
reason: TEXT_SOURCES covers .svg but not .tsx/.mdx/.webmanifest/.toml; CLIPPER_SOURCES covers .js/.html but not .svg, so a clipper icon carrying brand text goes unread. Because the pin test anchors only one file per root, adding a file of an uncovered type shrinks coverage with no test failure.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-brand-scan-coverage

### DW-245: tools/work-wiki-sync.md is reachable from nothing but the test's pin list.
origin: spec-deferred 18ccb7a475e4
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
location: tools/work-wiki-sync.md
severity: low
reason: No README, DEPLOY.md, AGENTS.md or UI surface links to the operator sync doc; src/components/LocalSyncPanel.tsx:42-44 emits the env commands inline and points nowhere. Pre-existing under the old filename too, but the rename was the natural moment to add the one link that makes it discoverable.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-246: A third hand-copy of the document allowlist lives in `src/lib/bulk-document-import.ts` and still rejects seven formats the app extractor accepts.
origin: spec-deferred 2da88f7dbb6c
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: src/lib/bulk-document-import.ts:6-18
severity: medium
reason: `src/lib/bulk-document-import.ts:6-18` keeps its own `SUPPORTED_EXTENSIONS` (md, markdown, txt, html, htm, pdf, docx, pptx, xlsx, csv, zip) with none of `odt/ods/odp/epub/org/rtf/mobi`, and its rejection copy at :48 restates the narrow list. `bulk-document-import.test.ts:46` actively pins that stale wording. Unlike the Worker this module lives in `src/lib` and CAN import `SUPPORTED_DOCUMENT_EXTENSIONS`, so the duplication is not forced. Dragging `plan.odt` into bulk import is rejected client-side even though POSTing the same file to `/api/ingest/document` succeeds. The 700-character `accept` string at `src/components/BulkDocumentImport.tsx:26` is a fourth copy, likewise underived and untested.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-hand-copied-list-parity

### DW-247: The acknowledgement tells a sender that a cap-truncated *supported* attachment was "unsupported", and understates the skipped count past 20 attachments.
origin: spec-deferred 21bb2bd1fe8b
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: workers/email-ingest/index.ts:287-292
severity: medium
reason: `workers/email-ingest/index.ts` computes skipped as `attachmentNames.length - supportedAttachments.length`, where the names list is capped at 20 and the supported list at 10. An 11th supported attachment dropped by the cap is reported as "1 unsupported attachment was recorded but skipped" — the sender is never told a supported file was dropped for exceeding the limit. Past 20 attachments the subtraction compares a 20-capped list against a 10-capped one and understates the loss. The route's `skippedAttachmentCount` carries the same semantics. This run pinned the existing copy as-is per its spec Boundaries rather than correcting it.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-worker-caps-and-accounting

### DW-248: Three more forced cross-module duplicate constants in the Worker remain unpinned after this run pinned only the 10-attachment cap.
origin: spec-deferred 5210d48fc471
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: workers/email-ingest/index.ts:210
severity: low
reason: `workers/email-ingest/index.ts` carries `.slice(0, 20)` for the recorded attachment-name list (duplicating `MAX_EMAIL_ATTACHMENTS_RECORDED` in `src/lib/email-ingest.ts:7`), `MAX_EMAIL_CONTENT_CHARS = 100_000` (duplicating the export of the same name), and `MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024`. All are the same "Worker cannot import `src/lib`, so a test must pin it" class as the `MAX_EMAIL_ATTACHMENTS`/`MAX_EMAIL_DOCUMENTS` pair that `email-ingest-allowlist-parity.test.ts` now covers. The 20 is never approached by the 13-part fixture.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-worker-caps-and-accounting

### DW-249: Four hand-written prose lists of supported formats exist and no test asserts any of them against the allowlist they describe.
origin: spec-deferred 1bb1a8484942
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: src/components/EmailIngestSettings.tsx:208
severity: low
reason: `workers/email-ingest/index.ts:201`, `workers/email-ingest/README.md:7`, `src/components/EmailIngestSettings.tsx:208` and `src/app/api/ingest/document/route.ts:35` each restate the format list in prose. This run edited three of them by hand. Adding a format still means remembering four prose edits; a copy test asserting each string names every entry of `SUPPORTED_DOCUMENT_EXTENSIONS` (or generating the sentence) would close the same gap the machine-list parity test closes.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-prose-inventory-parity-tests

### DW-250: The route's own `MAX_EMAIL_DOCUMENTS` rejection branch is never exercised.
origin: spec-deferred 7fe00efe551e
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: src/app/api/email/ingest/route.ts:116
severity: low
reason: `src/app/api/email/ingest/route.ts:116-121` returns 400 with "Attach no more than 10 supported documents" above the cap. The parity test only pins `MAX_EMAIL_ATTACHMENTS === MAX_EMAIL_DOCUMENTS`; no test posts 11 supported files, so the branch and its message could be deleted or inverted with the suite green. The widest route test in this run posts three parts.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-ingest-test-coverage

### DW-251: The Worker's `|| "application/octet-stream"` MIME fallback cannot be observed at the Request boundary, so the assertion pinning it is not discriminating.
origin: spec-deferred b0bbefc71f31
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: workers/email-ingest/index.ts:243
severity: low
reason: `workers/email-ingest/index.ts:243` supplies the fallback when a parsed attachment reports an empty `mimeType`. The multipart/form-data serializer is spec-required to emit `application/octet-stream` for an entry whose `type` is the empty string, so deleting the `||` changes nothing on the wire and fails no assertion made at the outgoing `Request`. The test documents this. Closing it needs a different surface — the Worker's `Blob` construction directly, or the `contentType` the route stores.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-ingest-test-coverage

### DW-252: The forwarded request's `Authorization` header and target URL are asserted nowhere, in a Worker suite that otherwise reads the body closely.
origin: spec-deferred 309fb683efb4
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: workers/email-ingest/index.ts:245-253
severity: low
reason: `workers/email-ingest/index.ts` sends `Authorization: Bearer ${serviceToken}` to `${site}/api/email/ingest`. Both new suites read only `formData()` off the captured `Request`, so a regression dropping or corrupting the service token — the thing `getServicePrincipal` gates on at `route.ts:81` — would ship green.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-ingest-test-coverage

### DW-253: Two attachment-related behaviours have neither a test nor deliberate handling.
origin: spec-deferred fc3cbd828749
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: src/app/api/email/ingest/route.ts:122
severity: medium
reason: (a) An email whose attachments are all unsupported but which has a body: the "queued" line is omitted, the "skipped" line fires, and a zero-attachment form is forwarded — untested end to end. (b) A single attachment over `MAX_DOCUMENT_SIZE` makes the route 400 the *whole* email (`src/app/api/email/ingest/route.ts:122-128`), so the body and every other attachment are lost, and the Worker does no per-attachment size pre-filter before forwarding.
status: open
decision: 2026-08-20 Drop the oversized attachment — Change the route to skip an attachment over `MAX_DOCUMENT_SIZE` rather than 400 the request, ingest the body and the remaining attachments, and name the dropped file in the acknowledgement alongside the existing skipped-attachment sentence. Add a per-attachment size pre-filter in the Worker so an oversized part is never forwarded, and add the missing end-to-end case for an email whose attachments are all unsupported but which carries a body.

### DW-254: The prototype-chain fix applied to `mediaTypeFor` during review is unpinned by any test.
origin: spec-deferred 7ef023996ec5
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
location: src/lib/document-extract.ts:522
severity: low
reason: Closing the `EXTENSION_ALIASES`/`MIME_FORMATS` prototype-chain holes surfaced the identical defect in `mediaTypeFor` (`IMAGE_MEDIA_TYPES[ext] ?? null`) in `src/lib/document-extract.ts`, which reads filenames from *inside* uploaded archives and is therefore attacker-reachable the same way. It was fixed with the same helper, but reverting that third fix fails nothing: `mediaTypeFor` is module-private and reachable only by crafting an archive containing an image entry named e.g. `logo.constructor`.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-email-ingest-test-coverage

### DW-255: `ConfirmDialog`'s `busy` gate is pinned at one consumer only — `WikiSwitcher`'s Rename and Delete confirms reach the same gate with nothing asserting it.
origin: spec-deferred 304df609e829
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
location: src/components/workbench/WikiSwitcher.tsx:236
severity: medium
reason: `dialog-busy-gate.test.tsx` drives the gate through `WikiWorkbench` (template overwrite and create), which is enough to fail on a dropped `disabled={busy}`. But `rename()` and `remove()` in `WikiSwitcher.tsx` have no handler-level `if (busy) return` behind the button's `disabled`, unlike `CreateWikiDialog.submit`. Delete is the irreversible one, and a double-submit there is exactly the failure DW-107 describes.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-wiki-workbench-client-hardening

### DW-256: Only `create()`'s `!wiki?.id` malformed-2xx guard is tested; the identical guards in `applyTemplate`, `rename` and `remove` are not.
origin: spec-deferred 63ffcaa5467c
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
location: src/components/WikiWorkbench.tsx:121
severity: low
reason: `create-wiki-flow.test.tsx` now answers `create` with `{}` and 200 and asserts the message rather than a blank render. `applyTemplate` (WikiWorkbench.tsx:121) and `rename`/`remove` (WikiSwitcher.tsx:225, :244) carry the same guard against the same failure — a 2xx whose body is not the documented shape — and deleting any of them leaves the suite green.
status: done 2026-08-19
resolution: resolved by sweep bundle dw3-wiki-workbench-client-hardening

### DW-257: `IconRail`'s "exactly one `aria-current` control" rule and its mode-select callbacks have no mounted pin.
origin: spec-deferred 336890cf909d
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
location: src/components/workbench/IconRail.tsx:101
severity: low
reason: `icon-rail.test.tsx` mounts the rail with `settingsActive: false` throughout and passes inert stubs for `onSelect`/`onToggleSettings`, so a rail that marked both a mode and Settings current (the case the component's own comment forbids: "two current controls would describe two surfaces the owner cannot both be looking at"), or wired every mode button to the same id, passes. Rail ORDER is likewise unasserted, though UX-DR3 fixes the ten modes top to bottom.
status: open

### DW-258: `Workbench`'s `aria-live="polite"` mode announcement — the OTHER live region — is still pinned only by source scan.
origin: spec-deferred 39bb6b0f1e10
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
location: src/components/workbench/Workbench.tsx:1095
severity: low
reason: DW-109's "live-region announcement" resolved to `IconRail`'s `role="status"` sidecar dot, which is now mounted. `Workbench.tsx`'s own `<p className="wb-sr-only" aria-live="polite">` and its interesting half — a RESTORED mode must not be announced, only a changed one — remain covered by `workbench-chrome.test.ts` greps for `useState("")` and `setAnnouncement(...)`.
status: done 2026-08-19
resolution: already resolved: src/components/workbench/__tests__/workbench-mode-url.test.tsx:164 mounts the shell and reads `.wb-shell > .wb-sr-only[aria-live="polite"]`; :214 pins that a RESTORED mode is not announced and :284/:312/:487 pin the changed-mode announcement, so the region is no longer covered by source scan alone.

### DW-259: Three of the six converted client components -- RecentIngests, ActionInbox and BulkDocumentImport -- still have no rendered-anchor coverage, so reverting any of their hrefForSlug call sites to slugPat
origin: spec-deferred 8332b2aa4a3f
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/components/RecentIngests.tsx:487
severity: medium
reason: DW-86's verbatim reason names "the six converted use client components"; the bundle intent's prose named only four (ArticleView, VaultExplorer, ChatWorkspace, KnowledgeStudio) and this story covered those four. `src/components/RecentIngests.tsx:487,568`, `src/components/ActionInbox.tsx:387` and `src/components/BulkDocumentImport.tsx:532` call `hrefForSlug(...)` from the same conversion, and no `*.test.ts`/`*.test.tsx` under `src/` references any of the three. The harness they would need now exists, so this is a remaining gap rather than a constraint.
status: open

### DW-260: NavHeader conveys the active route only through inline fontWeight, with no aria-current, so the current page is announced to assistive tech not at all.
origin: spec-deferred 22cbe3585ae4
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/components/NavHeader.tsx:39
severity: low
reason: `getActiveHref` (src/components/NavHeader.tsx:39) drives `fontWeight`, colour and background on the active link and nothing else; there is no `aria-current="page"` anywhere in the file. The new mounted assertions therefore have to match `link.style.fontWeight === "600"`, which couples the suite to styling because it is the only observable signal the component emits. Pre-existing; adding the attribute is a production change this coverage-only story walled off.
status: open

### DW-261: layout.tsx's metadata export and its inline theme script are still guarded only by source scans, even though the file now has a mounted suite.
origin: spec-deferred 8326245b9bba
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/app/layout.tsx:58
severity: low
reason: `src/app/layout.tsx:37-56` (title template, metadataBase, OG/Twitter) and the `themeScript` at :58-70 (which applies the `light`/`dark` class before paint) live only in this file. `app-shell.test.tsx` mounts the layout but asserts neither; the metadata half is pure data and needs no mount at all. Deleting the theme script leaves the whole suite green.
status: open

### DW-262: loadSlugTenants has no exported reset, so no mounted suite can express "map still loading" or "/api/wiki/routes failed" -- the DEFAULT_TENANT fallback every converted component is built to survive is
origin: spec-deferred 91b84f773caf
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/hooks/useSlugTenants.ts
severity: low
reason: The map is cached in a module-level singleton in `src/hooks/useSlugTenants.ts`, warmed once per file by `await loadSlugTenants()` in `beforeEach`. Once warmed it cannot be un-warmed, so `owner-scoped-anchors.test.tsx` can only ever assert the resolved-map branch. `renderer-slug-tenant-adoption.test.tsx` covers the unknown-slug fallback via a slug absent from the map, but the degraded-map path (session fetch failed) has no component witness.
status: open

### DW-263: ChatWorkspace's save-failure and slug-less-response banner paths are untested; only the happy path and the url-absent fallback are pinned.
origin: spec-deferred 3149502ae75b
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/components/ChatWorkspace.tsx:232
severity: low
reason: `saveAnswer` (src/components/ChatWorkspace.tsx:219-238) keeps the banner hidden when the response carries no slug and surfaces an error alert when the request fails. The new suite always answers `/api/query/save` with an ok body carrying a slug, so a regression rendering "Saved as undefined" -- the exact state the comment at :232 says the guard exists to avoid -- would pass.
status: open

### DW-264: `/wiki/new` still lets the owner compose an entire page before `POST /api/wiki` refuses it, now that the route answers 403.
origin: spec-deferred ee147ee7465e
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
location: src/app/wiki/new/page.tsx:45
severity: medium
reason: This change is what makes `POST /api/wiki` refuse on a read-only deployment (src/app/api/wiki/route.ts, catch maps ReadOnlyError to 403). `src/app/wiki/new/page.tsx:45` is a client page that fetches that route on submit with no read-only signal, so the owner types a title and a full body and meets the refusal only afterwards — the DW-149 confirm-then-403 harm, on a door this bundle opened. It was left alone because it is not a surface the bundle intent names (DW-190 names only ArticleActions) and it sits on no existing `readOnly` seam: the page is `"use client"`, so the fact would have to arrive through a new server wrapper rather than the ArticleView thread the Re-ingest and Revert mirrors reuse.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-read-only-doors-and-affordances

### DW-265: The `/ingest` page's bulk-delete control confirms an irreversible delete in front of a `DELETE /api/ingest/history` that now answers 403.
origin: spec-deferred 2f18f66dd0d3
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
location: src/components/RecentIngests.tsx:229
severity: medium
reason: `src/components/RecentIngests.tsx:229` raises a `window.confirm` naming permanent removal, then calls the route this change gated at `src/app/api/ingest/history/route.ts:121`. Same confirm-then-403 shape as the Re-ingest and Revert controls that WERE mirrored here. Left alone for the same two reasons: not named by the bundle intent, and `/ingest` (src/app/ingest/page.tsx:414) carries no `readOnly` prop today — though it is a server component, so the thread is one attribute plus a prop, cheaper than `/wiki/new`.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-read-only-doors-and-affordances

### DW-266: `putWikiArtifact` writes `schema.md` and `purpose.md` without the gate `writeWikiArtifact` now carries, so wiki seeding still writes.
origin: spec-deferred 41aab9652a70
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
location: src/lib/wikis.ts (putWikiArtifact)
severity: low
reason: `assertWritable` was added to `writeWikiArtifact` (src/lib/wikis.ts), but the unlocked seeder `putWikiArtifact` — used by `createWiki` inside the registry lock — takes the wider `ArtifactFile` type and has no gate. The residual hole is narrow because `POST /api/wikis` has consulted `isReadOnly()` since before this change, so only a direct library caller (CLI, a future MCP tool) can reach it; it is nonetheless a caller that does not inherit the refusal the module docstring claims every caller inherits.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-profile-store-hardening

### DW-267: `POST /api/tasks/run` answering 403 changes Cloudflare Queue semantics from retry-then-DLQ to ack-and-drop, and the trade-off deserves a human call.
origin: spec-deferred d73cd0e4de4b
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
location: src/app/api/tasks/run/route.ts:78
severity: medium
reason: The route's own status contract maps 4xx to "ack and drop" and 5xx to "retry, DLQ after max_retries". Before this change an ungated write simply succeeded; the new uniform 403 means work queued against a deployment that is read-only for a maintenance window is discarded rather than parked in the DLQ for replay. 403 is what the intent asks for ("the refusal shape the existing gated routes answer") and retrying cannot succeed while the flag is set, so it was implemented and documented in the route comment with the operational note "drain or pause the queue before setting YOPEDIA_READONLY". Whether the queue consumer should instead answer 503 and preserve the work is an operational decision, not a code defect.
status: done 2026-08-20
resolution: closed by human decision: Keep the uniform 403 so the read-only refusal shape stays consistent across every gated route, and treat 'drain or pause the queue before setting the flag' as the operating procedure — already recorded at `src/app/api/tasks/run/route.ts:60-78` and covered by the operator-facing flag documentation this sweep's `read-only-docs-and-copy-parity` bundle adds.
decision: 2026-08-20 Keep 403 and document it — Keep the uniform 403 so the read-only refusal shape stays consistent across every gated route, and treat 'drain or pause the queue before setting the flag' as the operating procedure — already recorded at `src/app/api/tasks/run/route.ts:60-78` and covered by the operator-facing flag documentation this sweep's `read-only-docs-and-copy-parity` bundle adds.

### DW-268: `YOPEDIA_READONLY` has no operator-facing documentation, and this change materially redefines what it refuses.
origin: spec-deferred 726f9f7ae0c5
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
location: src/lib/config.ts:139
severity: low
reason: The flag appears only in code docstrings and spec artifacts — not in README.md and not under docs/. It now means "no page or artifact write through any caller, including MCP and the CLI", while settings, the wikis registry, vaults, agent profiles, tasks, monitors, structured knowledge, `raw/`, the ingest ledger and the revision store all still mutate. An operator setting the flag has nowhere to read that boundary; the new `isReadOnly()` docstring in src/lib/config.ts states it, but only to a reader already in the code.
status: open

### DW-269: The Re-ingest and Revert client affordances are still offered where the same commons-realm gate refuses them — the exact shape DW-120 fixed for Delete.
origin: spec-deferred 58361bfa045c
source_spec: `spec-dw-120-122-123-authz-realm-parity-and-copy.md`
location: src/components/ArticleActions.tsx:161
severity: medium
reason: `src/components/ArticleActions.tsx` renders `<ReingestButton>` on `hasSourceUrl && ownsOrContributes` with no realm term, while `POST /api/ingest/reingest` denies through `canWriteFrontmatter(fm, principal, "body")` — the same realm branch and the same write kind. `RevisionHistory` renders Revert for every viewer with no ownership or realm gate, and the revert route now answers `WRITE_DENIAL_REALM.revert`. Both predate this pass (unchanged at `ffbebf4`), and the bundle intent named only the Delete gate, so both were left alone — but this pass makes the divergence louder by giving those doors the realm sentence to shout. Consequence: on an ordinary URL-ingested public knowledge page, the owner presses a live-looking Re-ingest button and meets the refusal as a red error string.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-authz-realm-parity-and-read-gates

### DW-270: The `jobIds` path of `DELETE /api/ingest/history` reaches the delete ACL holding a page the caller was never read-gated on.
origin: spec-deferred b1232cb9f27f
source_spec: `spec-dw-120-122-123-authz-realm-parity-and-copy.md`
location: src/app/api/ingest/history/route.ts
severity: medium
reason: The route preflights `ingestIds` against `listReadableWikiPages(principal)` and 404s unreadable ones, but the `jobIds` path checks only `job.owner !== principal.handle`; the job's `slug` page is never read-checked. This pass made the *sentence* safe there (the resolver only speaks of a realm it evaluated, pinned by the rewritten leak test), but the missing read-gate itself is a separate authz question this pass did not touch.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-authz-realm-parity-and-read-gates

### DW-271: `src/lib/commons.ts` imports two client-safe predicates through `./wiki`, so every route test that mocks `@/lib/wiki` must stub them or get a 500 where it means 403.
origin: spec-deferred 431f1d62b7a4
source_spec: `spec-dw-120-122-123-authz-realm-parity-and-copy.md`
location: src/lib/commons.ts:17
severity: low
reason: `commons.ts` imports `isAgentScopedType`/`isArtifactType` from `./wiki`, which merely re-exports them from the client-safe `./page-types`. Because `belongsInCommons` is now on the 403 path, two suites (`ingest-history-delete-route.test.ts`, `ingest-routes.test.ts`) had to widen their `vi.mock("@/lib/wiki")` factories to keep the predicate from calling `undefined`. Importing from `./page-types` directly would remove the trap for every future route suite at no behavioural cost. The import is pre-existing and unchanged by this pass.
status: open

### DW-272: The two-file token scheme has no coverage on the Cloudflare R2 backend, where the read-your-writes guarantee the design leans on does not hold across two separate objects.
origin: spec-deferred 8497b4ae1815
source_spec: `spec-dw-192-197-198-199-settings-write-precondition.md`
location: src/lib/config.ts:readConfig / saveConfig
severity: medium
reason: `saveConfig` writes `.llm-wiki-config.version` and then `.llm-wiki-config.json` as two independent objects, and `readConfig` reads them back as two independent objects. On the filesystem backend both are immediately consistent, which is what every new test relies on; R2 offers no such guarantee across two keys, so a read that lands between the two writes — or after both, on a replica that has only seen one — can pair a fresh token with a stale config even without a concurrent save. Both "token unreadable" tests force `EISDIR` by creating a DIRECTORY at the token path, a condition R2 cannot produce, so the Cloudflare backend has no coverage of the scheme at all. Closing it means either a single-object scheme (token inside the config, or the storage layer's own `writeFileIfMatch` compare-and-set, which `src/lib/storage/r2.ts` already exposes) or an R2-backed test harness neither the suite nor this bundle has.
status: done 2026-08-20
resolution: resolved by sweep bundle dw-settings-config-resolution-hardening
decision: 2026-08-20 Single object via writeFileIfMatch — Move the version token inside the config object (or replace the scheme with the storage layer's `writeFileIfMatch` compare-and-set, already exposed at `src/lib/storage/r2.ts:193`) so one object carries both the bytes and the token and no read can pair them inconsistently on any backend. Migrate an existing two-file deployment on first read, delete the now-unreachable token-file branches together with the EISDIR tests that only a filesystem can produce, and add coverage for a compare-and-set that loses.

### DW-273: Both embedding-resolution warnings fire per resolution rather than once per distinct misconfiguration, so a rebuild or a large ingest emits the same sentence hundreds of times.
origin: spec-deferred 7167de6cd16e
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
location: src/lib/embeddings.ts:resolveEmbeddingModelName and resolveEmbeddingProvider
severity: low
reason: `resolveEmbeddingModelName` is re-entered by every embed door, and `rebuildVectorStore` calls `getEmbeddingModelName()` once plus `embedText` per page, so a persistently mismatched `EMBEDDING_MODEL` produces roughly two identical WARN lines per page. Its sibling `resolveEmbeddingProvider` (`src/lib/embeddings.ts:93-99`) has exactly the same property and is the warning this bundle's intent asked the new one to mirror, so throttling only the new one would break the symmetry the intent bought. Closing it means a once-per-(provider, model) guard applied to BOTH warnings, which is a change to the module's logging convention rather than to this bundle.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-embedding-warning-throttle

### DW-274: `getEffectiveSettings` reports a provider-mismatched embedding model as the effective one, so the Settings surface names a model nothing embeds with.
origin: spec-deferred 9bd380a9167d
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
location: src/lib/config.ts:getEffectiveSettings
severity: medium
reason: The embedding-model branch reports `env ?? config` after trimming, but never runs `embeddingModelMatchesProvider`. With `EMBEDDING_MODEL=text-embedding-3-small` under `workers-ai`, `/settings` renders `text-embedding-3-small` in the locked "from env" box (`src/components/EmbeddingSettings.tsx:38-56`) while `embedText` runs on `@cf/baai/bge-m3`. Pre-existing — this bundle only changed which values count as SET on that branch — and now partly mitigated by the new WARN, but the one surface whose job is "what is in effect and where did it come from" still answers wrongly. Closing it means either resolving the reported model through `getEmbeddingModelName()` or adding an "overridden" flag the component can render.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-effective-settings-embedding-truth

### DW-275: The legacy flat `PUT /api/settings` branch still stores `model` and `ollamaBaseUrl` untrimmed, the same gate/resolver split just closed for `embeddingModel`.
origin: spec-deferred 1873c25f4f7d
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
location: src/app/api/settings/route.ts (legacy flat branch)
severity: low
reason: `embeddingModel` and `structuredKnowledgeModel` now trim on the way in; `body.model` and `body.ollamaBaseUrl` are still written raw. `ollamaBaseUrl` is read back by `getOllamaBaseUrl()` without a trim and by the settings surfaces with one, which is the shape of DW-221 for a different field. Pre-existing and untouched by this bundle, whose intent names only the embedding model.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-settings-flat-branch-validation

### DW-276: A mismatched deployment still EMBEDS under the substituted default; this bundle ended the silence, not the substitution.
origin: spec-deferred 5155e62ce7df
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
location: src/lib/embeddings.ts:hasEmbeddingSupport with src/lib/ingest.ts:989
severity: medium
reason: DW-224's ledger coordinates are `hasEmbeddingSupport` with `src/lib/ingest.ts:989`, and neither file changed. Under the intent's reading ("stops embedding under the substituted default WITHOUT A WORD") the fix is the warning, and the spec's Never list pins that reading because `src/lib/workbench-settings.ts` and `src/lib/config.ts` both record that Story 2.9 (embed after ingest) and Story 3.4 (search merge) own teaching `hasEmbeddingSupport()` the vector gate. So the harm the ledger measured — a corpus quietly embedded with a model the owner did not choose — is now diagnosable but not prevented, and the tightened predicate moves two more inputs (a bare `@cf/`, a `@cf/` vision id) from "fails at ai.run()" into "substitutes the default". Closing it means refusing to embed on a mismatch, which belongs to those stories.
status: open

### DW-277: The new Cloudflare-binding refusal is announced only on the vector checkbox; the embedding-provider select that produces the state carries no complaint and no `aria-invalid`.
origin: spec-deferred c1aba6d1ed22
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
location: src/components/workbench/SettingsCanvas.tsx (embeddingProvider select) with src/lib/workbench-settings.ts:vectorSearchModelIssue
severity: low
reason: DW-223's own argument is that "the ordinary way into that state is changing the provider select, which touches neither control" — and selecting Workers AI on a deployment with no binding is exactly that shape. `VectorSearchLegField` now enumerates `provider | endpoint | model | key | binding`, but only the `model` leg has a consumer (`vectorSearchModelIssue`); the provider, endpoint and key rows stay silent. The bundle's intent names only the embedding-model field, so wiring a second field-level complaint is new scope rather than part of this change.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-vector-gate-surface-completeness

### DW-278: Every settings read and save now calls `getWorkersAiBinding()`, so a Workers deployment with `AI` unbound emits one WARN per settings request on a path that previously logged nothing.
origin: spec-deferred cdd17a74d9ff
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
location: src/app/api/settings/route.ts with src/lib/embeddings.ts:56-73
severity: low
reason: `getWorkersAiBinding()` warns when it is ON the Workers runtime with the binding missing (`src/lib/embeddings.ts:64-71`), and the route now calls it unconditionally in `GET` and in `PUT`. The amplification is the same shape as the already-deferred "warnings fire per resolution rather than once per distinct misconfiguration" item from the DW-220 bundle, and closing it means a once-per-misconfiguration guard in `embeddings.ts` rather than a change to this seam.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-embedding-warning-throttle

### DW-279: There is no copy for the "stored on, effectively off" state the DW-219 scoping makes durable — the checkbox renders checked and unrefused beside a sentence saying vector search cannot be turned on.
origin: spec-deferred d35e879954cf
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
location: src/components/workbench/SettingsCanvas.tsx (vectorSearchEnabled hint)
severity: low
reason: `vectorRefused` is `stored.readOnly || (!vectorAllowed && !values.vectorSearchEnabled)`, so an already-on switch stays operable by design (an owner must be able to undo it). Pre-existing — the mounted case "leaves an ALREADY-ON switch checked, refused, and turn-off-able" pinned it before this bundle — but DW-219 makes the state survivable across unrelated saves rather than being cleared at the next one. Closing it means a distinct sentence for "on but inactive", which is a copy decision no ledger entry in this bundle asks for.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-vector-gate-surface-completeness

### DW-280: `textRow` never appends the read-only sentence through `describedBy()`, unlike every other refusable control on the surface.
origin: spec-deferred eedddaf19e0d
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
location: src/components/workbench/SettingsCanvas.tsx:textRow
severity: low
reason: `providerRow`, the embedding-provider select and the vector checkbox all wrap their hint id in `describedBy(...)`, which appends `SETTINGS_READ_ONLY_COPY` on a read-only deployment; `textRow` hardcodes `aria-describedby={hint ? hintId : undefined}`. Pre-existing for all seven text rows. This bundle made the gap slightly more visible by giving the embedding-model row a complaint (the mark itself is now suppressed under `readOnly`), but the fix belongs to every text row at once.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-vector-gate-surface-completeness

### DW-281: With `EMBEDDING_PROVIDER=workers-ai` the binding refusal advises choosing another embedding provider, which the env-locked select cannot do.
origin: spec-deferred d621d1cdd313
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
location: src/lib/workbench-settings.ts (SETTINGS_VECTOR_BINDING_NOTE) with mergedVectorInputs
severity: low
reason: `mergedVectorInputs` and `draftVectorInputs` both take `envEmbeddingProvider` ahead of anything stored or typed, so the provider leg can be owned by the environment exactly as the model leg can — but `VectorSearchInputs` gained an origin field for the MODEL only, which is what this bundle's intent asked for. Naming `EMBEDDING_PROVIDER` in the binding note would need a second origin field, the same shape change DW-218 made for the model.
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-vector-gate-surface-completeness

### DW-282: The Wiki canvas card reads `WorkbenchData` but ignores its `readOnly` flag, so on a read-only deployment `Create Wiki` and `Change template` still open and only meet a 403 after the destructive confir
origin: spec-deferred bdeb7e2db60a
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/components/WikiWorkbench.tsx:152-194
severity: medium
reason: `page.tsx` feeds `readOnly: isReadOnly()` into the provider the card now destructures, and `WikiSwitcher` adopts the same flag with `if (readOnly) return`, `aria-disabled` and `WIKI_READ_ONLY_COPY`. The card does neither, so the header refuses up front while the canvas walks the owner into "This overwrites purpose.md, Schema, and the Workspace Purpose" before the route answers 403. Pre-existing (the card never had the flag as a prop either); this change made it available one line away without wiring it. Every fixture that mounts the card hard-codes `readOnly: false`, so no suite can express the case.
status: done 2026-08-20
resolution: already resolved: Closed by commit b4df800 (sweep dw3-read-only-surface-affordances). src/components/WikiWorkbench.tsx:63 now destructures `readOnly` from useWorkbenchData(); the Create opener guards at :283 with aria-disabled :277 and WIKI_CREATE_READ_ONLY_COPY :291-296, Change template guards at :336 with aria-disabled :333 and WIKI_TEMPLATE_READ_ONLY_COPY :347-352, and both writers carry backstops at :168 and :209. Pinned by src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx.

### DW-283: A write that aborts on the 15s deadline is reported as a flat failure even though the server may have applied it, and no refresh reconciles the screen.
origin: spec-deferred 589216deb264
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/lib/workbench-request.ts (failureMessage) with WikiWorkbench.tsx:91,118
severity: medium
reason: `failureMessage` maps `TimeoutError`/`AbortError` onto the caller's sentence — "Couldn't apply the template." / "Couldn't create the wiki." — and the catch path deliberately skips `router.refresh()`. A re-template that took longer than the client deadline has still rewritten purpose.md, schema.md and the Workspace Purpose, so the owner is told it failed over a write that landed and may retry it. `WikiSwitcher` has shipped this behaviour since the deadline was introduced; this change extended it to the card's two writes, so a fix belongs to both.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-workbench-client-state-and-nav

### DW-284: The Rename and Change-template confirms never name the wiki they act on, which is the same premise DW-148 fixed for the pickers.
origin: spec-deferred 18943a232416
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/components/workbench/WikiSwitcher.tsx (Rename body) and WikiWorkbench.tsx (template body)
severity: low
reason: DW-148's premise is that a bare name does not identify a wiki. The Delete confirm leans entirely on its `<select>`, and the Rename and Change-template bodies say "this wiki" with no target named at all — so the two confirms that rewrite or rename an artifact set identify their target less precisely than the picker that chooses it.
status: open

### DW-285: `No wiki yet.` and `Your wikis couldn't be loaded. Reload to try again.` are still inline literals in the card while every other sentence it shows is an exported constant.
origin: spec-deferred f852398160ce
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/components/WikiWorkbench.tsx:151,146
severity: low
reason: DW-177 named only the preview sentence, and extracting it leaves the card the one component that both imports a copy constant and restates two sentences of its own. `TREE_NO_WIKI_COPY` and `TREE_UNAVAILABLE_COPY` already exist in `workbench-tree.ts` for the left column's versions of the same two states, so the card is a second definition of both wordings.
status: open

### DW-286: A network-level `fetch` rejection reaches the owner verbatim as "Failed to fetch", the same class of defect `failureMessage`'s abort branch exists to prevent.
origin: spec-deferred 7b64629d64ad
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/lib/workbench-request.ts (failureMessage)
severity: low
reason: `failureMessage` special-cases `TimeoutError`/`AbortError` because those name the mechanism rather than the thing that failed, then returns `cause.message` for anything else. An offline browser rejects with `TypeError: Failed to fetch` (or `NetworkError when attempting to fetch resource`), which is exactly as mechanism-named and sails straight through to the dialog. Carried over verbatim from `WikiSwitcher`; nothing covers a `TypeError` rejection.
status: open

### DW-287: Nothing in either vitest project can verify that the live-region repeat mark is actually re-announced by assistive technology.
origin: spec-deferred 0a52fb9a4a49
source_spec: `spec-dw-181-184-preview-refresh-affordances.md`
location: src/lib/live-region.ts and src/components/workbench/__tests__/preview-announcements.test.tsx
severity: low
reason: DW-182's fix is an alternating U+200B appended to a repeated sentence. The node and jsdom suites prove only that the region's string CHANGED — which was never in doubt. Whether NVDA, JAWS or VoiceOver re-utters on that change, and whether any of them normalises the mark away before diffing, is asserted in prose only. The DW-182 ledger entry predicted this ("no test in a node or jsdom project can verify"), and the repo already records the equivalent gap for CSS. Without a browser/AT project the suite reads as if the mechanism is proven.
status: open

### DW-288: The scheduled sweep reclaims only the configured owner's tenant, so DW-147's condition still holds unchanged for every other tenant.
origin: spec-deferred 13ff1f1e878f
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
location: src/lib/maintenance.ts (sweepOrphanWikiDirs)
severity: low
reason: `sweepOrphanWikiDirs` resolves one handle via `getOwnerHandle()` (`NEXT_PUBLIC_OWNER_HANDLE`), but `POST /api/wikis` calls `createWiki(principal.handle, ...)`, so any signed-in principal gets its own tenant and its own registry. For those tenants `deleteWiki` remains the only trigger. This matches the neighbouring backup block in the same route (also owner-only) and `src/lib/owner.ts`'s "single-owner deployment" stance, so it is a deliberate scope, not a bug — but the repo has an owner-enumeration precedent (`listSourceMonitorOwners`) and no equivalent index for Wikis.
status: open

### DW-289: The sweep has no per-pass cap, so one cron request can walk, stat and delete an unbounded number of candidates while holding the tenant lock.
origin: spec-deferred a53600c92e2a
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
location: src/lib/wikis.ts (sweepOrphans)
severity: medium
reason: Every other block in `src/app/api/tasks/scan/route.ts` bounds its work (`.slice(0, 25)`, `listDueOutboxEvents(..., 50)`) and `scanForMaintenance` documents its cap as a "cost + blast-radius bound". `sweepOrphans` runs inside `withFileLock(wikiLockKey(owner))`, so a long pass queues every create, rename and delete for that tenant behind it. Bounded in practice by `MAX_WIKIS` (100) and by orphans being rare, which is why it is recorded rather than fixed.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-wikis-sweep-cap-and-rename-refresh

### DW-290: A future-dated mtime (clock skew, or a restored archive) makes an orphan permanently unsweepable, with no signal that it is leaking.
origin: spec-deferred a38f8ad0290b
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
location: src/lib/wikis.ts (sweepOrphans)
severity: low
reason: `sweepOrphans` skips whenever `newest > Date.now() - ORPHAN_SWEEP_GRACE_MS`. A directory whose newest write time is in the future never satisfies that test, on any pass, forever. R2 reports `head.uploaded` and the filesystem provider reports `mtime`, neither of which is guaranteed monotonic against the isolate's clock. The skip is logged at `info`, so nothing escalates.
status: open

### DW-291: A `.discarded` tombstone is never cleared, so it can outlive the condition it records.
origin: spec-deferred 83a44a70622c
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
location: src/lib/wikis.ts (discardCreatedWikiDirectory)
severity: low
reason: The marker is written when `discardCreatedWikiDirectory`'s `deleteDirectory` fails, and nothing removes it except the directory's own deletion. If a `writeRegistry` landed on the store but reported failure, the compensation runs against a directory the registry DOES name; the tombstone is then harmless while the registry stands (`known.has(id)` skips it) but authorises deletion if that `wikis.json` is later lost. Requires three unlikely faults in sequence, hence low.
status: open

### DW-292: A tmp file stranded by process death is hidden from every listing surface and nothing ever reclaims it.
origin: spec-deferred 470152434e7b
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/lib/storage/filesystem.ts
severity: low
reason: `atomicWrite`'s cleanup only covers a REJECTED write inside a live process. A SIGKILL between `fs.open(tmp)` and `fs.rename` leaves a `.tmp-<uuid>.tmp` on disk, and the new `listFiles` filter now hides it from all ~20 listing call sites, from `sweepOrphans` (which only considers directories matching `WIKI_ID_RE`) and from backups. Nothing sweeps them, so they accumulate silently. Closing it means a reaper — its own story, the way DW-162 was for the orphan-directory sweep.
status: open

### DW-293: Every whole-file write now costs a real fsync, and nothing bounds that on the production paths that write in a loop.
origin: spec-deferred 76acb44f9ed6
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/lib/storage/filesystem.ts
severity: medium
reason: Measured under the full parallel suite: contributors 27ms -> 5091ms, lint 35ms -> 4854ms, query-history 102ms -> 24204ms. The same per-write cost is paid by `portable-archive.ts` on import (one write per archive entry), `backups.ts` on restore (one per asset), `embeddings.ts` on rebuild (each `upsertEmbedding` rewrites AND fsyncs the whole `.indexes/embeddings.json`) and by ingest. The cost is the durability guarantee working as specified, not a defect — but no benchmark, batching, or bound exists for those paths.
status: open
decision: 2026-08-20 Batch the loop paths — Keep fsync as the default for single writes, and give the loop paths a batched form: a bulk-write door that fsyncs once per batch (or a directory sync at the end) for portable-archive import, backup restore and ingest, plus an accumulate-then-flush shape for `upsertEmbedding` so an embeddings rebuild stops rewriting and syncing the whole index per vector. Add a benchmark that fails if any of those paths regresses past a recorded bound.

### DW-294: `POST /api/research` has no `isReadOnly()` gate, unlike ~20 sibling write routes.
origin: spec-deferred a0e0feee7f8f
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/app/api/research/route.ts
severity: medium
reason: `src/app/api/wikis/route.ts` refuses creates with 403 when the deployment is read-only and most write routes do the same. The research create writes to storage and does not. Pre-existing; this change touched only the error classification in the same handler.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-read-only-doors-and-affordances

### DW-295: `POST /api/research` answers 500 for a malformed or non-object JSON body.
origin: spec-deferred eb0c1ee445f5
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/app/api/research/route.ts
severity: low
reason: `await request.json()` sits inside the handler's `try`, and a parser message contains neither "required" nor "invalid", so a caller-fault parse error is reported as a server fault and the raw parser message is echoed to the client. `src/app/api/wikis/route.ts` handles this with an explicit 400. Pre-existing; unchanged by this work.
status: open

### DW-296: The `/required|invalid/i` message regex still routes genuine server faults to 400.
origin: spec-deferred 912df682cec9
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/app/api/research/route.ts:50
severity: low
reason: The regex matches `EINVAL: invalid argument, ...` and any storage or library error mentioning "invalid", so a 5xx can be reported as a 400 the client will retry forever. The clean fix is small and was deliberately not taken here: `cleanInput`'s two plain `Error` throws could become `ClientInputError`, after which the regex can be deleted entirely.
status: open

### DW-297: `readProjects` degrades a non-array registry JSON to an empty list, so a corrupt registry passes the new cap check and is then overwritten.
origin: spec-deferred 92cc58b8d547
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/lib/research-projects.ts:110
severity: low
reason: `Array.isArray(parsed) ? parsed : []` treats a registry that parsed as an object, string or number as "no projects". The create then sees 0, clears the `MAX_PROJECTS` guard, and `writeProjects` replaces the file — the same shape as the `normalizeRegistry` degradation DW-161 was raised about, one module over. Pre-existing and untouched by this change.
status: open

### DW-298: `writeProjects`' `slice(-MAX_PROJECTS)` can still silently evict for a legacy over-cap registry reached through update or delete.
origin: spec-deferred c398ace2e4f5
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/lib/research-projects.ts:117
severity: low
reason: The create guard added here makes the slice unreachable on the create path, but `updateResearchProject`/`deleteResearchProject` still route through it, so a registry that is already over cap (only reachable if `MAX_PROJECTS` is ever lowered) loses its oldest entries with no error and no log. Left deliberately: removing the backstop changes behaviour no ledger entry asks about.
status: open

### DW-299: `/settings` still refuses read-only by disabling its whole form fieldset — the identical DW-191 defect, one section above the form this change fixed.
origin: spec-deferred 32fcc7e0ed24
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
location: src/app/settings/page.tsx:118
severity: medium
reason: `src/app/settings/page.tsx:118` is `<fieldset disabled={readOnly} className="max-w-4xl disabled:opacity-60">` around `ProviderForm`, `StructuredKnowledgeSettings`, `EmbeddingSettings`, the Save submit (`:161`) and `Test Connection` (`:167`) — and that same page renders `<WorkspacePurposeSettings />` at `:205`. So after this change one scroll of `/settings` refuses read-only two contradictory ways: the lower form keeps every stored value readable and in the tab order, the upper one still removes the stored provider, model, base URL, embedding model and the (non-writing) `Test Connection` button from it entirely. `SettingsCanvas` — the Workbench twin of that same form — already refuses per control. No suite mounts `src/app/settings/page.tsx` at all (no test file references it), so the inconsistency is invisible in both directions. Pre-existing; the bundle intent names WorkspacePurposeSettings and WikiWorkbench only.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-read-only-doors-and-affordances

### DW-300: `/api/names-terms` and `/api/email/settings` have no `isReadOnly()` gate, so those Settings forms silently SUCCEED on a read-only deployment.
origin: spec-deferred 62ef6bcca620
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
location: src/app/api/names-terms/route.ts:23
severity: medium
reason: `src/app/api/names-terms/route.ts:23` (POST), `src/app/api/names-terms/[id]/route.ts:15,39` (PUT, DELETE) and `src/app/api/email/settings/route.ts:45` (PUT) contain no `isReadOnly` reference and reach no kernel writer, so `YOPEDIA_READONLY=1` does not refuse them. `NamesTermsSettings` and `EmailIngestSettings` render immediately below `WorkspacePurposeSettings` on the same page, so the owner now meets three behaviours in one column: a form that refuses and says so, a form that refuses by removing itself from the tab order (the entry above), and two that write. Pre-existing and wider than a surface fix — the doors need gating before their surfaces can mirror anything.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-read-only-doors-and-affordances

### DW-301: The `!wiki` leg of WorkspacePurposeSettings' fieldset carries the same tab-order harm DW-191 named, on bytes the route answers so they can be READ.
origin: spec-deferred 4ca76f982d23
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
location: src/components/WorkspacePurposeSettings.tsx:283
severity: medium
reason: After this change the gate is `disabled={loading || saving || !wiki}`. The `!wiki` leg is also true after a FAILED load, and the route deliberately answers a retired tenant-global profile's fields with `wiki: null` "so the owner can SEE them" (the component's own comment at :83-88, pinned by `workspace-purpose-settings.test.tsx:203` which reads `purposeField().value`). A disabled fieldset removes all of it from the tab order, so exactly the text that case exists to show is unreachable by keyboard and screen reader. Not fixed here because the bundle intent names only the read-only refusal mechanism, and the fix is a different decision (a form with nothing to save is not the same as a deployment that refuses to save).
status: done 2026-08-20
resolution: resolved by sweep bundle dw4-workspace-purpose-settings-freshness

### DW-302: `WIKI_READ_ONLY_COPY` is the one client refusal sentence with no case in `read-only-copy-parity.test.ts`, and it demonstrably differs from its route.
origin: spec-deferred c4e48f3e8686
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
location: src/lib/__tests__/read-only-copy-parity.test.ts
severity: low
reason: This change added parity cases for `WIKI_TEMPLATE_READ_ONLY_COPY`, `WIKI_CREATE_READ_ONLY_COPY` and `WORKSPACE_PURPOSE_READ_ONLY_COPY`, and the second of those proves `POST /api/wikis` answers "Wikis cannot be created while this deployment is read-only." — so the switcher's four-verb `WIKI_READ_ONLY_COPY` (src/lib/workbench-tree.ts:120) does not match any single door it sits in front of. That is defensible (it covers four routes at once, like the Revert narrowing already recorded), but it is unrecorded: the suite's own header says every client constant is compared "CHARACTER-IDENTICAL where the door answers its own refusal, and explicitly recorded where it deliberately does not", and this one is neither. Pre-existing (DW-37 shipped it unpinned).
status: open

### DW-303: The flat branch can now be refused for vector legs no flat field can satisfy (endpoint, API key, Workers AI binding), and the legacy /settings page has no control for any of them.
origin: spec-deferred fe4be61a5560
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
location: src/app/api/settings/route.ts:390-410
severity: medium
reason: `vectorSearchMissingLegs` reads provider, endpoint, model, key and binding, but the flat vocabulary carries only `embeddingProvider` and `embeddingModel`, and `src/hooks/useSettings.ts` renders no embedding-provider, endpoint or key control at all. On a deployment already storing an unsatisfied vector config (say openai with no endpoint), an owner editing the embedding model from /settings now gets "Vector search needs an endpoint and an API key before it can be turned on." from a page with no endpoint box. The Workbench surface is the way out, so it is not a dead end, but the refusal names fields the surface that produced it cannot show. Closing it would mean either scoping the flat refusal to legs the request could have moved, or serving `VectorSearchLeg.field` on the response so the surface can say something actionable.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-settings-flat-branch-uniformity

### DW-304: The flat `ollamaBaseUrl` is stored with no absolute-http validation, unlike every endpoint in the `workbench` patch.
origin: spec-deferred 4592c0a3844b
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
location: src/app/api/settings/route.ts:311-327
severity: medium
reason: `validateWorkbenchSettingsPatch` refuses `customBaseUrl`, `embeddingBaseUrl` and `firecrawlBaseUrl` unless `isAbsoluteHttpUrl(raw.trim())`. The flat branch type-checks only, so `"not-a-url"` or a `file:` URL is stored and `getOllamaBaseUrl()` (src/lib/config.ts:239) hands it straight to the provider SDK. Pre-existing; this bundle's intent named only the trim.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-settings-flat-branch-uniformity

### DW-305: `structuredKnowledgeModel` is the one flat text field still deciding its delete on the literal empty string rather than on the trimmed value.
origin: spec-deferred 3bf4aaa1f56f
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
location: src/app/api/settings/route.ts:290-305
severity: low
reason: It already trims on store, and the non-empty check above answers 400 for a whitespace-only value, so there is no observable difference today. It is a uniformity gap rather than a defect: `model`, `ollamaBaseUrl` and `embeddingModel` now all decide the delete on `trimmed.length === 0`.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-settings-flat-branch-uniformity

### DW-306: A body carrying BOTH a flat legacy field and a `workbench` key -- the only case `validateWorkbenchSettingsPatch`'s `baseline` parameter exists for -- has no test at any surface.
origin: spec-deferred 68068f7435ec
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
location: src/lib/workbench-settings.ts:790
severity: medium
reason: DW-219 added the third `baseline` argument precisely so a flat move in the same request is measured against what the store held BEFORE the request rather than against itself. Every test in `settings-route.test.ts` and `workbench-settings.test.ts` sends the flat move and the nested move as separate requests, so the argument that justifies the parameter is unexercised. Pre-existing since DW-219; this change widened the parameter's role without adding the case.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-settings-flat-branch-uniformity

### DW-307: `secretRow` never routes its description through `describedBy()`, so the three API-key rows are the last controls on the Settings surface that a read-only deployment refuses without saying why.
origin: spec-deferred c188b4ff4f4e
source_spec: `spec-dw-277-279-280-281-vector-gate-surface-completeness.md`
location: src/components/workbench/SettingsCanvas.tsx:secretRow with src/lib/__tests__/workbench-settings.test.ts (describedBy call-site count)
severity: low
reason: DW-280 closed this for `textRow`, and the two provider pickers and the vector checkbox already wrap their hint id in `describedBy(...)`. But `secretRow` still hardcodes `aria-describedby={hintId}` while setting `readOnly={stored.readOnly || removing}` and dropping its Remove button under `readOnly` — so on a `YOPEDIA_READONLY` deployment a keyboard user reaches Custom / Embedding / Firecrawl API key, finds a box that will not take a keystroke and an affordance that has vanished, and is told only "A key is stored." No test in the repo mounts a password field on a read-only deployment, and the source-shape guard in `workbench-settings.test.ts` pins the `describedBy(` call-site count at exactly 4, so adopting it in `secretRow` also means bumping that count to 5. This bundle's intent names "all seven text rows" and DW-280's location is `textRow`, so the key rows are a separate decision rather than part of this change.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-vector-gate-copy-and-secret-row

### DW-308: The route's 400 body still frames an already-on deployment as un-turn-on-able, so the two halves of the one rule now describe the same state with different sentences.
origin: spec-deferred 1e2fbab9c662
source_spec: `spec-dw-277-279-280-281-vector-gate-surface-completeness.md`
location: src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch (the `vectorSearchMissingCopy(merged)` refusal) with src/components/workbench/SettingsCanvas.tsx (save bar)
severity: low
reason: DW-279 was closed on the client only: `vectorSearchInactiveCopy` is selected by `SettingsCanvas`, while `validateWorkbenchSettingsPatch` returns `vectorSearchMissingCopy(merged)` — "…before it can be turned on" — for every refusal. The path is reachable: with the switch stored ON and a save that MOVES a vector input into an unmet state, the owner gets a 400 whose sentence lands in the save bar beside a still-ticked box, which is the exact mismatch DW-279 argues against. `validateWorkbenchSettingsPatch` already reads `baseline.vectorSearchEnabled`, so it could pick the frame — but whether an ERROR response should describe a state rather than a refusal is a distinct decision, and DW-279's location names the `vectorSearchEnabled` hint only.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-vector-gate-copy-and-secret-row

### DW-309: DEPLOY.md still says the legacy flat `/settings` branch never enters the vector gate, which DW-217 made false.
origin: spec-deferred bc4653e2dd77
source_spec: `spec-dw-277-279-280-281-vector-gate-surface-completeness.md`
location: DEPLOY.md (the two "flat request" caveats) with src/app/api/settings/route.ts
severity: low
reason: Two sentences claim it: "the older `/settings` page saves the embedding provider through a flat request that never enters this gate" and "saves the embedding model through a flat request that never runs this check". `src/app/api/settings/route.ts` now calls `validateWorkbenchSettingsPatch` for a flat-only body (its comment spells out that "the flat branch cannot move that flag, so `turningOn` is always `false`"), and `settings-route.test.ts` carries a suite for the vector rule on the flat branch. Stale as of the DW-217 sweep (commit a5a50aa, this change's baseline), so pre-existing here — but this change rewrites the paragraphs immediately above and below both sentences, which is how it surfaced.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-doc-drift-corrections

### DW-310: `searchByVector`'s model-drift breadcrumb is the same standing-misconfiguration shape as the three warnings this story throttled, but fires once per search query and was left unguarded.
origin: spec-deferred 23b8e4e79790
source_spec: `spec-dw-273-278-embedding-warning-throttle.md`
location: src/lib/embeddings.ts:656
severity: medium
reason: `src/lib/embeddings.ts:656-662` logs "all N matches dropped by the model filter (active=...) — likely embedding-model drift; rebuild embeddings" whenever the store returns hits and the model filter drops all of them. That condition is standing state (the active model name has drifted from every stored vector) and a search query is a higher-frequency door than either resolver, so a drifted corpus emits the line per query. It stayed unguarded because this bundle's intent named exactly three resolvers, and the sentence embeds a per-query `matches.length`, so it is not literally the same line each time. DW-273's own reason frames the fix as "a change to the module's logging convention", which argues the other way.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-embedding-truth-and-warning-attribution

### DW-311: The non-embedding-capable override warning hardcodes `EMBEDDING_PROVIDER="..."` even when the value came from stored config, and now says it only once.
origin: spec-deferred eb0689dd76b5
source_spec: `spec-dw-273-278-embedding-warning-throttle.md`
location: src/lib/embeddings.ts:134-145
severity: low
reason: `src/lib/embeddings.ts:134` reads `process.env.EMBEDDING_PROVIDER ?? cfg.embeddingProvider`, but the warning text always attributes the value to the env var. Pre-existing, and harmless while the line repeated; now that it is said once per identity, an owner whose bad value came from Settings gets a single line telling them to unset an env var they never set. The fix is to name the source (env vs stored) in the message.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-embedding-truth-and-warning-attribution

### DW-312: The Workbench Settings canvas has its own embedding-model control and still cannot say which model is actually embedding.
origin: spec-deferred f2471935e58a
source_spec: `spec-dw-274-effective-settings-embedding-truth.md`
location: src/components/workbench/SettingsCanvas.tsx:542
severity: low
reason: `src/components/workbench/SettingsCanvas.tsx:542-565` renders the embedding model row from `getWorkbenchSettings`, not `getEffectiveSettings`, so the two new fields never reach it. It names a provider/model mismatch only through the vector-gate refusal copy (`src/lib/workbench-settings.ts:640-659`) — i.e. as a reason the vector switch cannot be turned on, not as "this is not the model embedding". `src/app/api/settings/route.ts:70-77` calls these "Both Settings surfaces", so after this story they answer the DW-274 question differently. Pre-existing and left alone deliberately: DW-274 names `getEffectiveSettings` and `src/components/EmbeddingSettings.tsx`, and the canvas is fed by a different accessor whose payload shape is its own contract.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-embedding-truth-and-warning-attribution

### DW-313: `getEffectiveSettings` reads the config cache several times, so its "what is set" and "what is in effect" halves can in principle describe different snapshots.
origin: spec-deferred 811577823483
source_spec: `spec-dw-274-effective-settings-embedding-truth.md`
location: src/lib/config.ts:1156
severity: low
reason: `src/lib/config.ts:1156` takes `cfg` from `loadConfigSync()`, and both `getEmbeddingModelName()` (:1274) and `hasEmbeddingSupport()` (:1288) re-enter it. `loadConfigSync` has a 5 s TTL and returns an EMPTY config when the cache is cold (:569-578), so a TTL boundary crossed between two of those reads would report a stored model as set while resolving the in-effect half against `{}` — a "Not in effect" note about a substitution that is not happening. The shape is pre-existing (`embeddingSupport` has re-entered the same way since before this story) and the window is between two adjacent synchronous statements with no await, so it is vanishingly narrow; the fix is a `cfg`-taking door on the resolver, which `src/lib/embeddings.ts` does not expose today.
status: done 2026-08-20
resolution: resolved by sweep bundle dw5-embedding-truth-and-warning-attribution

### DW-314: `deleteWiki`, `setCurrentWiki` and `sweepOrphanWikiDirectories` still write and delete bytes with no `assertWritable`, while their three sibling lifecycle doors now refuse.
origin: spec-deferred 844e3a28f040
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
location: src/lib/wikis.ts (deleteWiki, setCurrentWiki, sweepOrphanWikiDirectories); src/app/api/tasks/scan/route.ts
severity: medium
reason: `deleteWiki` rewrites `wikis.json` and calls `getStorage().deleteDirectory(wikiDirPath(...))` — the most destructive operation in the module — and `setCurrentWiki` rewrites the registry; neither calls `assertWritable`. `sweepOrphanWikiDirectories` deletes directories and is reached from `src/app/api/tasks/scan/route.ts`, which carries no `isReadOnly()` gate at all, so it can delete on a timer on a read-only deployment. Their HTTP doors do gate (`src/app/api/wikis/[id]/route.ts:63`, `src/app/api/wikis/current/route.ts:19`), which is exactly the "route gates, kernel does not" shape DW-266 names. Out of scope here: the bundle's intent names `putWikiArtifact` and `putWorkspaceProfile`, and neither of these three writes through either putter.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-read-only-doors-and-affordances

### DW-315: `read-only-door-coverage.test.ts` still registers four kernel writers, so the newly refusing wiki-lifecycle exports are invisible to the scan that guards tomorrow's doors.
origin: spec-deferred 451eef2b76ed
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
location: src/lib/__tests__/read-only-door-coverage.test.ts:36
severity: low
reason: `KERNEL_WRITERS` and `WRITER_EXPORTS` do not name `createWiki`, `applyScenarioTemplate`, `renameWiki` or `saveWorkspaceProfile`, and the file's staleness guard re-derives only from `KERNEL_WRITERS`. A future `route.ts` importing `createWiki` with neither treatment would serve the refusal as a 500 and the scan would not notice. Every route that reaches them today gates first, so nothing is broken now. Deliberately not fixed here: widening that registry re-derives a route-treatment map across the whole app.
status: open

### DW-316: The three wiki lifecycle routes classify a `ReadOnlyError` as 500 rather than mapping it to 403.
origin: spec-deferred 56ea98b9ffae
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
location: src/app/api/wikis/route.ts; src/app/api/wikis/[id]/route.ts; src/app/api/wikis/[id]/template/route.ts
severity: low
reason: `src/app/api/wikis/route.ts`, `src/app/api/wikis/[id]/route.ts` and `src/app/api/wikis/[id]/template/route.ts` branch only on `ClientInputError` (400) and answer 500 for everything else. Every other read-only-aware route carries an `isReadOnlyError(error) -> 403` branch beside its early gate (see `src/app/api/workbench/artifact/route.ts:68`). Reachable only if `YOPEDIA_READONLY` flips between the route's own `isReadOnly()` gate and the kernel call. Route files were fenced out of this change.
status: open

### DW-317: The two putter backstop gates are unreachable through every current caller, so no test observes them firing.
origin: spec-deferred 0b21a169fec9
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
location: src/lib/wikis.ts (putWikiArtifact); src/lib/workspace-profile.ts (putWorkspaceProfile)
severity: low
reason: `putWikiArtifact`'s `assertWritable` is shadowed by `writeWikiArtifact`'s gate and by the three lifecycle entry gates; `putWorkspaceProfile`'s is shadowed by `saveWorkspaceProfile`'s. Deleting either leaves the whole suite green, so they are pinned by inspection only and could be removed as dead code by a future reader. A direct call with a held token under `YOPEDIA_READONLY=1` would pin each.
status: open

### DW-318: Two sibling wiki doors own inline read-only literals with no constant and no parity assertion, and `wikiRename` has no client counterpart.
origin: spec-deferred ad2cf2a1e9d1
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
location: src/app/api/wikis/[id]/route.ts:63; src/app/api/wikis/current/route.ts:19
severity: low
reason: `DELETE /api/wikis/[id]` ("Wikis cannot be deleted while this deployment is read-only.") and `PUT /api/wikis/current` ("The active wiki cannot be changed...") are spelled inline and compared against nothing, which is the drift `read-only-copy-parity.test.ts` exists to prevent. `wikiRename` also has no client constant beside a dimmed control, unlike `WIKI_CREATE_READ_ONLY_COPY` and `WIKI_TEMPLATE_READ_ONLY_COPY`.
status: open

### DW-319: A storage failure inside `saveWorkspaceProfile` is still answered 400 by `PUT /api/workspace-profile`, telling the owner their edit was rejected when the write merely could not reach storage.
origin: spec-deferred 926718bb8f18
source_spec: `spec-dw-140-145-workspace-profile-route-preconditions.md`
location: src/app/api/workspace-profile/route.ts
severity: low
reason: The route's own comment above the registry read states the rule: "a registry that cannot be READ is not the caller's input being wrong. GET answers 500 for that exact condition, and answering 400 here would tell the owner their edit was rejected when storage was merely unreadable." This pass gave the precondition READ its own 500 branch, but `saveWorkspaceProfile` still throws into the generic `catch` that returns 400 — so an unwritable store (an EACCES, a full disk, a lock timeout) surfaces as a raw machine-authored sentence at 400, the same class of message DW-140 removed from this route. Pre-existing: the write has thrown into that catch since the route was written, and this change did not move it.
status: open

### DW-320: `save()` has no unmount guard, so a PUT that resolves after the form unmounts still writes state.
origin: spec-deferred df488f2bd6a3
source_spec: `spec-dw-136-142-301-workspace-purpose-settings-freshness.md`
location: src/components/WorkspacePurposeSettings.tsx (save)
severity: medium
reason: The component's cancelled guard has only ever covered the load path (it was `let cancelled` in the mount effect before this change and is `cancelledRef`/`answerSeqRef` after it). `save()`'s `.then` path calls `placeProfile`, `setVersion`, `setWiki`, `setFeedback` and `setSaving` with no such check. Pre-existing; this change did not introduce or widen it, and it was surfaced incidentally by review.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-workbench-client-state-and-nav

### DW-321: After a 412 write conflict this form still offers no in-page way to re-seed its version; the only recovery is a full reload.
origin: spec-deferred 8ca1e9659b2e
source_spec: `spec-dw-136-142-301-workspace-purpose-settings-freshness.md`
location: src/components/WorkspacePurposeSettings.tsx (save catch / feedback banner)
severity: low
reason: `WRITE_CONFLICT_COPY` tells the owner to copy their text and reload. `load("retry")` would now re-seed `version` from a fresh read, but the Try again control renders only under `loadFailed`, so the conflict banner has no affordance of its own. Out of scope for this bundle — the intent names the no-Wiki and load-failed states, not the conflict one.
status: open

### DW-322: `buildNamesTermsGuidance` is still uncached in the exact same `Promise.all` pairs the DW-141 handle now covers, so one document still pays up to four dictionary reads while paying one profile read.
origin: spec-deferred 8fd5a084ba2f
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
location: src/lib/names-terms.ts:327
severity: medium
reason: All three sites threaded in this change pair `buildWorkspaceGuidance(owner, cache)` with a bare `buildNamesTermsGuidance(owner)`, and `ingest()` calls `listNamesTerms` a fourth time. `buildNamesTermsGuidance` (names-terms.ts:327) has the same read-per-call shape `buildWorkspaceGuidance` had. This spec's "Never" clause deferred it to "a different ledger entry", but no open ledger entry covers dictionary guidance caching, so the deferral has nowhere to land.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-workspace-guidance-request-caching

### DW-323: A manual page merge gets neither Workspace Purpose nor Names & Terms guidance, while an ingest-time reconcile of the same two bodies gets both.
origin: spec-deferred 0fb017929a75
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
location: src/lib/merge.ts:204
severity: medium
reason: `src/lib/merge.ts:204` calls `reconcilePage(into.body, from.body)` with no `owner`, so the guidance branch at ingest.ts:1168 is skipped entirely. The reconcile prompt is the same prompt in both cases, so the merged prose is held to a different standard depending on which door it came through. This change touched that signature (adding the cache parameter) without closing the asymmetry, which is out of DW-141's scope but worth a decision.
status: open
decision: 2026-08-20 Guide the merge door — Resolve the accountable owner from into.frontmatter.owner (falling back to the acting principal) and pass it plus a fresh createWorkspaceGuidanceCache() into reconcilePage from merge.ts, with a test pinning which owner's guidance a cross-owner merge uses.

### DW-324: One HTTP request can still resolve guidance N times when it ingests N documents in a loop; the handle is per-`ingest()`, not per-request.
origin: spec-deferred 3caced74045d
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
location: src/app/api/ingest/batch/route.ts:152
severity: medium
reason: `POST /api/ingest/batch`'s off-Workers fallback (src/app/api/ingest/batch/route.ts:152) loops `ingestUrl` per URL inline when the queue is unavailable, and `POST /api/tasks/run` drains tasks one per request. On Workers each URL is a separate queued request, so per-document and per-request coincide in production and the DW-141 remedy is met there. The inline fallback is the residual case: closing it needs a handle threaded through `IngestOptions` and the `ingestUrl`/`ingestPdf`/`ingestImage` wrappers, which is a design extension beyond this spec.
status: done 2026-08-21
resolution: resolved by sweep bundle dw-workspace-guidance-request-caching

### DW-325: `workspace-purpose-settings.test.tsx` "adopts a recheck that answers no wiki at all" is flaky under full-suite load and can red an unrelated CI run.
origin: spec-deferred 09cd0fe96308
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
location: src/components/__tests__/workspace-purpose-settings.test.tsx:837
severity: medium
reason: Observed failing once during full-suite verification for this story (the badge still read "not configured" when the 1s `waitFor` expired), then passing on re-run and passing 42/42 in isolation. It is entirely fetchMock-driven, touches nothing in this change, and predates it (introduced with DW-136/142/301). It races the mount fetch against the `returnToTab()` recheck.
status: open

### DW-326: DW-304's URL rule is write-time only: a value stored before this change, or one supplied through OLLAMA_BASE_URL, still reaches the provider SDK unvalidated.
origin: spec-deferred b7a9d467256f
source_spec: `spec-dw-303-306-settings-flat-branch-uniformity.md`
location: src/lib/config.ts:239
severity: medium
reason: `getOllamaBaseUrl()` (src/lib/config.ts) returns the stored string literally and prefers `process.env.OLLAMA_BASE_URL` over it; neither path calls `isAbsoluteHttpUrl`. So a deployment that stored `file:///etc/passwd` or `localhost:11434` before this change keeps handing it to the SDK, and an operator can still set the env var to anything. The new refusal closes the write door only. No backfill and no read-side guard were in this bundle's scope — the intent named the workbench branch's check, which is a write-time check.
status: done 2026-08-20
resolution: resolved by sweep bundle dw-settings-config-resolution-hardening

### DW-327: A flat save that the new scoping ALLOWS lands with no signal on /settings that the stored vector switch is on but inactive.
origin: spec-deferred 66f5fc6223a9
source_spec: `spec-dw-303-306-settings-flat-branch-uniformity.md`
location: src/hooks/useSettings.ts
severity: medium
reason: Before this change the owner got a refusal they could not act on; now the save answers 200 and `vectorSearchEnabled` stays stored-on while `getVectorSearchSettings()` still intersects it to off. `vectorSearchInactiveCopy` exists for exactly this "switched on but cannot run" state, but it is rendered only by the Workbench's `SettingsCanvas`; `/settings` shows nothing about vector state at all. Closing it means either an advisory in the 200 response or wiring the existing copy into the flat surface — both were out of scope here (this bundle's intent forbids widening the response shape and adding embedding controls to /settings).
status: done 2026-08-20
resolution: resolved by sweep bundle dw-legacy-settings-surface-parity

### DW-328: All four flat text fields resolve a non-string to `""` before deciding the delete, so the belt-and-braces fallback points AT deletion rather than away from it.
origin: spec-deferred f1908ff9cbf1
source_spec: `spec-dw-303-306-settings-flat-branch-uniformity.md`
location: src/app/api/settings/route.ts:321-395
severity: low
reason: `model`, `ollamaBaseUrl`, `embeddingModel` and now `structuredKnowledgeModel` all read `typeof x === "string" ? x.trim() : ""` and then treat `trimmed.length === 0` as DELETE. Each comment says the ternary "must never be what turns a malformed body into a delete", but `""` is exactly the delete arm — the only thing preventing it is the non-string 400 above the merge. Unreachable today and identical across all four, so fixing one alone would break the uniformity DW-305 was about; the fix is to make all four fall back to leaving the field untouched.
status: open

### DW-329: Every refusal the legacy flat `/settings` path can now produce ends "Turn it off, or supply what is missing." — naming a switch that page does not render.
origin: spec-deferred d479ec58b9cf
source_spec: `spec-dw-307-308-vector-gate-copy-and-secret-row.md`
location: src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch (the frame selection) with src/app/settings/page.tsx
severity: medium
reason: For a flat-only body the gate runs only when the STORED flag is already on (`route.ts` spells out that "the flat branch cannot move that flag, so `turningOn` is always `false`"), so after DW-308 the flat path can receive ONLY the switched-on frame. `src/app/settings/page.tsx` renders the embedding model and nothing else — no vector checkbox anywhere outside `SettingsCanvas` — so "supply what is missing" is actionable there and "Turn it off" is not. That collides with the DW-303 principle already written into the same function ("a refusal has to be one the requesting surface can DO something about"), which DW-308 narrowed to WHETHER-only without extending the same surface-awareness to WHICH sentence is chosen. The intent framed the frame decision as binary on the stored flag and said nothing about surface-awareness, and the repinned expectations in `settings-route.test.ts` lock the current wording in — so whether the frame should additionally read `actionableLegs` is a distinct decision
status: done 2026-08-20
resolution: resolved by sweep bundle dw-legacy-settings-surface-parity

### DW-330: The client picks the refusal's frame from the DRAFT checkbox and the route from the STORED flag, so one composition still shows both sentences on the same screen at the same moment.
origin: spec-deferred 5ca1c85bc38b
source_spec: `spec-dw-307-308-vector-gate-copy-and-secret-row.md`
location: src/components/workbench/SettingsCanvas.tsx (the checkbox hint selector) with src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch
severity: low
reason: `SettingsCanvas` selects between `vectorSearchInactiveCopy` and `vectorSearchMissingCopy` on `values.vectorSearchEnabled` — the draft flag — while `validateWorkbenchSettingsPatch` selects on `baseline.vectorSearchEnabled`. Reachable: with the switch stored OFF and the legs met, the owner ticks the box (`vectorRefused` permits it), then moves a leg into an unmet state in the same draft. The checkbox hint reads "Vector search is switched on, but it needs …" while the 400 that lands in the save bar a few rows below reads "… before it can be turned on". The behaviour is unchanged by DW-308 — that composition answered the same way before — but it is the same two-sentences-for-one-state shape DW-279 and DW-308 exist to remove. DW-308's own intent excluded the literal "same frame the client picks" reading by also requiring both frames to be pinned at the route, so closing this needs a decision the intent does not contain: whether the route should read the REQUEST's flag for the frame while st
status: open

### DW-331: `workspace-purpose-settings.test.tsx` is flaky — one `getByRole("status")` assertion fails intermittently, roughly one run in three.
origin: spec-deferred 9e7a23de70bf
source_spec: `spec-dw-307-308-vector-gate-copy-and-secret-row.md`
location: src/components/__tests__/workspace-purpose-settings.test.tsx
severity: low
reason: Observed during this change's verification: a full `npm test` reported 1 failed / 5514 passed in that file, and two subsequent full runs reported 5515/5515. Run in isolation three times it failed once and passed twice. The file is untouched by this change and shares nothing with the settings or vector-gate surface — the failing assertion is on the active-wiki status line ("This workspace now has an active wiki, ...") — so this is pre-existing suite noise rather than a regression. It makes every future run's green a coin flip on that one file.
status: open

### DW-332: The `drift:<active model>` key is never re-armed, so a corpus that is rebuilt and then drifts again under the same active model is silent for the rest of the process.
origin: spec-deferred 694c7c190212
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/lib/embeddings.ts (searchByVector, warnedMisconfigurations)
severity: medium
reason: `warnedMisconfigurations` is documented as never clearing, on the argument that "a restart (or a new isolate) already fixes" the case. That holds for the three env/binding misconfigurations it was written for, but not for drift: drift is fixed by REBUILDING THE CORPUS, which happens in the same process. `searchByVector` already holds the counter-signal that proves the drift is over — `kept.length > 0` — and could delete the key there. The intent said only "bring it under the same throttle", and the module's recorded trade-off argues the other way, so whether drift should be the one identity that re-arms is a decision neither contains.
status: open
decision: 2026-08-20 Re-arm drift only — Delete only the drift:<active model> key from warnedMisconfigurations on a successful read where kept.length > 0, leaving every other member of the Never clause intact, and cover rebuild-then-re-drift in the embeddings warning suite.

### DW-333: A whitespace-only `EMBEDDING_PROVIDER` is truthy, shadows a valid stored provider, and is now attributed to the environment while quoting a blank string.
origin: spec-deferred 2dbdb2eb9569
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/lib/embeddings.ts:resolveEmbeddingProvider
severity: low
reason: `resolveEmbeddingProvider` reads `process.env.EMBEDDING_PROVIDER ?? cfg.embeddingProvider` with no `nonEmpty`, so `EMBEDDING_PROVIDER=" "` is truthy, wins over the store, fails `isEmbeddingProvider`, and warns `EMBEDDING_PROVIDER=" " is not embedding-capable`. Pre-existing and untouched here — this story's Boundaries forbade changing which value wins — but DW-311 made the sentence attribute it, so the blank now reads as a deliberate env choice. Every sibling reader of the model key (`resolveEmbeddingModelName`, `getVectorSearchSettings`, `embeddingModelAnswer`) goes through `nonEmpty`; this leg does not, and fixing it moves a resolution boundary.
status: open

### DW-334: `getEffectiveSettings` still re-enters the 5 s config cache on its non-embedding legs, so only the embedding half of its answer is snapshot-consistent.
origin: spec-deferred fbbe5abd3cc7
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/lib/config.ts:getEffectiveSettings
severity: low
reason: After DW-313 the embedding legs all resolve against the `cfg` read at the top of the function, but `getStructuredKnowledgeModelSettings()`, `apiKeyForProvider`'s `custom` branch and `getCustomBaseUrl()` each call `loadConfigSync()` themselves. The intent's sentence — "give `getEffectiveSettings` one config snapshot" — reads broader than the ledger entry it came from, which names only `getEmbeddingModelName` and `hasEmbeddingSupport`. Closing the rest means `cfg`-taking doors on three more resolvers, which is a distinct piece of work from the one DW-313 described.
status: open

### DW-335: `settings-vector-namespace.test.tsx`'s default fixture encodes a config whose real payload would carry the substitution note, so several exact-equality announcements pin a state the wire cannot produc
origin: spec-deferred b09de8588471
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/components/workbench/__tests__/settings-vector-namespace.test.tsx
severity: low
reason: The fixture is `embeddingProvider: "workers-ai"` with `embeddingModel: "text-embedding-3-small"` and `embeddingModelOverridden: false, embeddingModelInEffect: null`. For that config `embeddingModelAnswer` returns `overridden: true, inEffect: "@cf/baai/bge-m3"`, so the real GET body would carry a third sentence on the model row. The pre-existing cases assert the announced string with `toBe`, and they are about the vector gate rather than the substitution, so the simplification is deliberate and documented in the fixture comment — but it means those assertions describe a payload the server never serves. Making the fixture faithful would repin every one of them.
status: open

### DW-336: The substitution sentence exists as two hand-maintained twins — the flat page's JSX and the canvas's copy function — with nothing pinning that they keep saying the same thing.
origin: spec-deferred 005b0025a4ed
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/components/EmbeddingSettings.tsx with src/lib/workbench-settings.ts:settingsModelSubstitutedCopy
severity: low
reason: `EmbeddingSettings.tsx` renders "Not in effect. This deployment embeds with <mono/> — the embedding provider cannot serve the model above, …" while `settingsModelSubstitutedCopy` returns the same sentence with "the model that is set". The divergence is deliberate and argued (the canvas box is empty whenever `EMBEDDING_MODEL` owns the value, so it cannot point at a control), and both are separately tested — but a wording fix to one leaves the other stale with no failing test. DW-312 asked for the two surfaces to answer the same question; they now agree on the VALUES, through `embeddingModelAnswer`, and nothing holds the two sentences together.
status: open

### DW-337: The canvas substitution note is payload-derived while the two sentences beside it are draft-derived, so mid-edit the row can describe pre-edit server state.
origin: spec-deferred 30c4576690ec
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/components/workbench/SettingsCanvas.tsx (modelSubstitution)
severity: low
reason: `modelSubstitution` reads `stored.embeddingModelOverridden` / `stored.embeddingModelInEffect`, while the env sentence and `vectorModelIssue` on the same row come from `values`. An owner who corrects the model in the box still reads "Not in effect. This deployment embeds with …" until a PUT lands. This is unavoidable without the server — the rule runs over the env and the store together — and it is documented in code and in DEPLOY.md ("re-reads it on save"), but the same row now mixes two freshness contracts and no test mounts the edit-then-read path. Whether the note should be suppressed while the model or provider field is dirty is a decision the intent does not contain.
status: open

### DW-338: SCHEMA.md's Talk pages section still documents all five `/api/wiki/:slug/discuss...` routes as live surfaces.
origin: spec-deferred d5560fb0b17e
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
location: SCHEMA.md:126
severity: medium
reason: SCHEMA.md:126-167 lists GET/POST discuss, GET/PATCH the thread, and POST comments as live. All five are entries in RETIRED_SURFACES (src/lib/retired.ts:37-40) and answer 404. Same drift class as DW-129, one heading above the block this change corrected; the intent named only the contributor surface.
status: open

### DW-339: SCHEMA.md's planned-evolution status still calls talk pages and contributor profiles complete, contradicting the new retired-surfaces block.
origin: spec-deferred 493f9af093ca
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
location: SCHEMA.md
severity: low
reason: The Phase 2 status prose later in SCHEMA.md reads that talk pages and attribution are complete and contributor profiles are implemented, a few hundred lines below the paragraph this change rewrote to say the whole contributor product surface was cut.
status: open

### DW-340: DESIGN-triggers.md still designs triggers on `discussion-opened` / `discussion-resolved` and talk-thread events that retired with the commons.
origin: spec-deferred 3b9db02a207e
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
location: DESIGN-triggers.md:190
severity: low
reason: DESIGN-triggers.md:190-191 and :316-317 build trigger designs on discussion events whose routes are all RETIRED_SURFACES entries (src/lib/retired.ts:37-40). This change corrected only the tool count at :338, which was the only fact the intent named in that file.
status: open

### DW-341: The eight-member `fix` list is hand-copied in two documents with nothing pinning either to `MaintainFixType`.
origin: spec-deferred 52bccbf1a637
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
location: src/lib/maintenance.ts:11
severity: medium
reason: src/lib/maintenance.ts's module header and workers/task-consumer/README.md:47-49 both re-list the union by hand. `MaintainFixType` (src/lib/tasks.ts:164-172) appears in no test, so adding a ninth member re-stales both silently -- exactly the mechanism DW-127 reported. DW-130 got a pin in this pass (mcp-annotations.test.ts); this list did not, because the intent did not ask for one.
status: open

### DW-342: A fifth supported-format sentence lives in the bulk importer and is already stale, and the private allowlist behind it is narrower than the app's.
origin: spec-deferred fe13901b98f1
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
location: src/lib/bulk-document-import.ts:48
severity: medium
reason: `src/lib/bulk-document-import.ts:48` returns "Use Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, or ZIP." from `validationError`, and its private `SUPPORTED_EXTENSIONS` (:6-18) omits odt/ods/odp/epub/mobi/org/rtf. So bulk upload rejects files `POST /api/ingest/document` accepts. The bundle intent enumerated exactly four format sites, so this one was out of scope for this pass; it is the same drift class and the only one already out of sync. Adopting it means deriving the sentence from the set it actually describes, not from `DOCUMENT_FORMAT_LABELS`.
status: done 2026-08-20
resolution: already resolved: commit ab55322 (DW-229/DW-246 sweep): src/lib/bulk-document-import.ts:22-24 now derives SUPPORTED_EXTENSIONS from SUPPORTED_DOCUMENT_EXTENSIONS and :47-54 generates SUPPORTED_FORMATS_SENTENCE from DOCUMENT_FORMAT_LABELS; the hand-written 'Use Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, or ZIP.' sentence no longer exists anywhere in src/ or workers/.

### DW-343: `MAINTAIN_FIX_TYPES` has no omission pin and the task-consumer README restates the same `lintType` list in unpinned prose.
origin: spec-deferred 7dfb6b825471
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
location: src/lib/tasks.ts:213
severity: medium
reason: `src/lib/tasks.ts:213` builds `new Set<MaintainFixType>([...])`, which rejects extra members but not omitted ones — the exact half `AssertNever` was added to cover for `TASK_KINDS` one screen above. A ninth fix type wired into `src/lib/maintenance.ts` but forgotten here makes `parseTask` return null at :440, so the enqueued task is treated as poison and goes to the DLQ, with `tsc` silent. `workers/task-consumer/README.md:48-50` restates the eight fix types in prose and nothing reads it — a seventh inventory of the same shape as the six this pass pinned.
status: open

### DW-344: The bulk-import file picker advertises formats the very next step refuses.
origin: spec-deferred ec1d252f2b80
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
location: src/components/BulkDocumentImport.tsx:25
severity: low
reason: `src/components/BulkDocumentImport.tsx:25-26` puts `.org,.rtf,.odt,.ods, .odp,.epub,.mobi` in the `accept` attribute of both file inputs, but `documentExtension` (`src/lib/bulk-document-import.ts:33-36`) maps all of them to "file", so `selectBulkDocuments` rejects them. Nothing compares the `accept` list to the allowlist. Pre-existing; surfaced while enumerating format sites.
status: open

### DW-345: The bulk importer's only copy test restates the sentence as a literal, so it can never fail on drift.
origin: spec-deferred 0f7b1eaec336
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
location: src/lib/__tests__/bulk-document-import.test.ts:45
severity: low
reason: `src/lib/__tests__/bulk-document-import.test.ts:45` asserts `/Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, or ZIP/i` — a literal that would have to be edited alongside the very change it is meant to catch. This is the pattern `prose-inventory-parity.test.ts`'s header explicitly rules out; it would be replaced by adopting the site.
status: open

### DW-346: `POST /api/lint/fix`'s JSDoc is a sixth un-derived restatement of the fixable list and names only five of the ten types.
origin: spec-deferred 4043386addcd
source_spec: `spec-dw-229-246-hand-copied-list-parity.md`
location: src/app/api/lint/fix/route.ts:17
severity: medium
reason: `src/app/api/lint/fix/route.ts:17-30` lists `missing-crossref`, `orphan-page`, `stale-index`, `empty-page` and `contradiction` under "Supported issue types", omitting `broken-link`, `missing-concept-page`, `stale-page`, `unmigrated-page` and `supersedes-dangling` — the very type DW-229 was about. This story derived every executable copy of the list and left the one an integrator reads. It is a doc comment, so nothing observes it; the repo's own convention for pinning a prose inventory it cannot generate is `prose-inventory-parity.test.ts`.
status: open

### DW-347: Bulk import's `accept` advertises 21 MIME types its validator never consults, so a file the picker admits by content type alone is still refused client-side.
origin: spec-deferred 4e813d060c28
source_spec: `spec-dw-229-246-hand-copied-list-parity.md`
location: src/lib/bulk-document-import.ts:80
severity: medium
reason: `validationError` (`src/lib/bulk-document-import.ts`) branches only on `documentExtension(file.name)` and ignores `file.type` entirely, while `ACCEPTED_DOCUMENT_ATTRIBUTE` now derives from extensions AND `SUPPORTED_DOCUMENT_MIME_TYPES`. An extension-less file carrying `application/pdf` therefore passes the picker and is rejected by the manifest, though `detectDocumentFormat` at `/api/ingest/document` accepts it on the MIME arm. This is the residual half of DW-246's class (client narrower than server); the intent named the list, not the MIME arm, so it is out of this story's scope.
status: open

### DW-348: The two untrusted lint-fix doors accept an unvalidated `type` even though `AUTO_FIXABLE_CHECK_TYPES` now exists as a tuple to validate against.
origin: spec-deferred ac2df2d3e945
source_spec: `spec-dw-229-246-hand-copied-list-parity.md`
location: src/app/api/lint/fix/route.ts:54
severity: medium
reason: `src/app/api/lint/fix/route.ts:54-56` destructures `type` off a raw `await req.json()` with no schema at all, and `src/lib/mcp-http.ts:490` declares it as free-form `str(...)`. `src/mcp.ts:2465` does validate, but against `z.enum(ALL_CHECK_TYPES)` rather than the fixable subset. The `ownEntry` guard added by this story is currently the only defense; `z.enum(AUTO_FIXABLE_CHECK_TYPES)` at the door would make it a second line rather than the sole one.
status: open

### DW-349: workers/email-ingest/README.md:20 documents a live app menu path with the retired brand ("the address entered under Yopedia **Settings -> Email ingestion**"), so the exemption freezes wrong operator d
origin: spec-deferred 8edfd4178f50
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: workers/email-ingest/README.md:20
severity: low
reason: The file is in YOPEDIA_PROSE_EXEMPT because three of its "Yopedia" mentions are deployment history, but this one names a UI path the display rename should have updated. This bundle's intent authorises exemptions, not copy corrections, and the spec's Never list forbids editing it.
status: open

### DW-350: .github/workflows/ carries brand strings and is read by no scan.
origin: spec-deferred c422dc958830
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: .github/workflows/
severity: low
reason: Reviewer found hits at infra-setup.yml:52, deploy-cloudflare.yml:4,79,97,98 and seed-yoyo.yml:4-18,36,92-102. Neither source list reaches the tree. AGENTS.md marks .github/ protected, so folding it in is a decision the intent did not authorise; seed-yoyo.yml:93 also names a second workers.dev subdomain (yopedia.christianlee-flightwall.workers.dev) that the current single-host allowlist entry would not cover.
status: open

### DW-351: Root non-Markdown files beyond the four AGENTS.md freezes stay unread.
origin: spec-deferred 78dc1d82c3b4
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: maintainerSources() names wrangler.jsonc, package.json, mcp.json and Dockerfile because the root listing is non-recursive markdown-only. That leaves docker-compose.yml, .env.example, next.config.ts, open-next.config.ts, tailwind.config.ts, vitest.config.ts, eslint.config.mjs and postcss.config.mjs unscanned. Widening the root listing to SOURCE_TEXT would cover them but also pull in pnpm-lock.yaml, which needs its own decision.
status: open

### DW-352: IDENTIFIER_ALLOWLIST's /yopedia-[a-z-]+/g swallows display prose, the way the workwiki family did before it was anchored.
origin: spec-deferred 41f20a262d72
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: src/lib/__tests__/brand-copy.test.ts:52
severity: medium
reason: strayYopedia("the yopedia-first workflow") returns no match, so that prose would pass the scan. The workwiki side guards the identical case with its anchored alternation and a "the workwiki-first approach" slip case. The pattern is pre-existing and narrowing it needs evidence about which real Cloudflare resource names depend on it, so the new yopedia case table pins today's behaviour rather than changing it.
status: open

### DW-353: Named single files and newly walked roots surface as ENOENT rather than a pin failure when renamed or removed.
origin: spec-deferred 7e47d62e4062
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: scannedSources() pushes src/mcp.ts and src/middleware.ts by literal path, maintainerSources() pushes four root config files the same way, and walk() calls readdir() on skills/, public/, journal-site/ and .opencode/commands/ without an existence check. A rename throws from inside a content assertion instead of failing the pin test with its diagnostic message. The stat-based pattern already used by the scripts.sync test is the fix.
status: open

### DW-354: .agents/skills/ is tracked installer-generated markdown that no scan reads, while the comparable .opencode/commands/ was folded in.
origin: spec-deferred 41e89080aefb
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: .agents/skills/
severity: low
reason: The test's own comment concedes .opencode/commands/ holds BMAD-installer-generated docs; .agents/skills/ is the same class, several hundred tracked markdown files, currently brand-clean. The split is undocumented either way. The intent named .opencode/commands/ and not this root.
status: open

### DW-355: The browser clipper's shipped product name has no positive coverage: manifest.json's name, description and action.default_title, and popup.html's title and heading, are read only by the negative brand
origin: spec-deferred fb9316c76117
source_spec: `spec-dw-235-237-241-242-brand-display-copy-residue.md`
location: integrations/browser-clipper/manifest.json
severity: low
reason: brand-copy.test.ts pins browser-clipper/{popup.html,manifest.json,service-worker.js} into the scan corpus, but only for saysStaleDisplayName / strayWorkwiki / strayYopedia, all of which fail on a WRONG name and stay silent on a MISSING one. A reviewer edited manifest.json to "name": "Clipper" / "default_title": "Save to the app" and popup.html to "Save to the app", and the full suite still passed with zero `work-wiki` left in either file. This is the same half-renamed state DW-235/DW-237 recorded, on the surface with the widest audience — the Chrome extensions list and context menu, persisted inside already-installed extensions. Out of this bundle's scope: the intent names only scripts/setup-cloudflare.sh and the two Worker READMEs.
status: open

### DW-356: AGENTS.md's frozen list still omits three yopedia-side identifiers that IDENTIFIER_ALLOWLIST waives: the X-Yopedia-* wire headers and the two deployment origins.
origin: spec-deferred b4f795fea992
source_spec: `spec-dw-235-237-241-242-brand-display-copy-residue.md`
location: AGENTS.md
severity: low
reason: IDENTIFIER_ALLOWLIST (src/lib/__tests__/brand-copy.test.ts) waives X-Yopedia-* headers, yopedia.yolog.dev and yopedia.yuanhao-li.workers.dev. The workers.dev origin is what skills/work-wiki-mcp/SKILL.md publishes as the MCP endpoint outside agents connect to, so renaming it is as breaking as anything already listed. DW-241 scoped completeness to the four WORKWIKI_* members only, so the yopedia half was never audited for the same gap.
status: open

### DW-357: The duplicate-Message-ID early return omits skippedAttachmentCount entirely, so a resend of an already-seen message reports supportedAttachmentCount with no skipped figure at all.
origin: spec-deferred 00f8b3678ac9
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
location: src/app/api/email/ingest/route.ts:202
severity: medium
reason: `src/app/api/email/ingest/route.ts` returns `{ accepted, duplicate, ... , supportedAttachmentCount }` on the duplicate path without `skippedAttachmentCount`, while the success path returns both. Pre-dates this change, but it is the same response contract the change corrects. The only test on that path asserts accepted/duplicate/status/slug and nothing about attachment counts.
status: open

### DW-358: Quoted-printable transfer encoding is unaccounted for in the raw-size cap, which is derived from base64 expansion alone.
origin: spec-deferred 18e6b2bf1947
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
location: workers/email-ingest/index.ts
severity: medium
reason: Many clients send text/* attachments and non-ASCII bodies as quoted-printable, which expands up to roughly 3x for byte-dense content — far beyond base64's 4/3. A large .csv or .txt attachment can therefore still be refused below the advertised per-document ceiling, for the same reason DW-104 described for base64.
status: open
decision: 2026-08-20 Widen for worst-case encoding — Derive MAX_RAW_EMAIL_BYTES from the worst-case transfer encoding (a quoted-printable expansion factor rather than base64's ~1.37), re-pin the parity test, and record the new derivation beside the constant.

### DW-359: Inline MIME parts (signature logos, embedded images) are counted as unsupported attachments and reported to the sender as skipped.
origin: spec-deferred b0f13e11e949
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
location: workers/email-ingest/index.ts
severity: low
reason: `parsed.attachments` from postal-mime includes parts with `disposition: "inline"` and a `contentId`. Every ordinary email with a branded signature therefore produces an "N unsupported attachments were recorded but skipped" line. Pre-existing — the old subtraction counted them too — so this is not a regression, but the corrected accounting makes the noise more visible.
status: open

### DW-360: Nothing bounds the aggregate size of the attachments the Worker copies into the forwarded FormData, and raising the raw cap raises that peak.
origin: spec-deferred 9ad9274b13e0
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
location: workers/email-ingest/index.ts
severity: low
reason: The forwarding loop copies each attachment twice (source view, then a fresh Uint8Array) on top of the parsed MIME tree, inside a Cloudflare Worker's memory budget. The cap governs one raw message, not the sum of decoded attachment bytes plus copies. No test or guard covers the aggregate.
status: open

### DW-361: A full-size document and a maximal email body cannot both fit under the derived raw cap, because the 64 KiB envelope allowance is far smaller than MAX_EMAIL_CONTENT_CHARS.
origin: spec-deferred 29968aee1ee7
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
location: workers/email-ingest/index.ts:59
severity: medium
reason: `MAX_RAW_EMAIL_BYTES` leaves 65,533 bytes of slack above the 14,348,938-byte wire size of a base64-encoded `MAX_DOCUMENT_SIZE` document, while the Worker's own `MAX_EMAIL_CONTENT_CHARS` is 100,000 and the body is truncated only *after* the `rawSize` gate. An email carrying a 10 MB attachment plus a body anywhere near the accepted length is refused with a size bounce although every individual limit is respected. Not a regression -- the old 10 MB cap refused that message too -- and the constant's comment now says so, but no test covers the interaction of the two caps.
status: open

### DW-362: The raw cap bounds one full-size document, so several mid-size supported documents are refused wholesale even though every per-document and per-count limit is respected.
origin: spec-deferred 95bfc309fad5
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
location: workers/email-ingest/index.ts:59
severity: medium
reason: `MAX_EMAIL_ATTACHMENTS` is 10 and `MAX_DOCUMENT_SIZE` is 10 MB, so the advertised envelope is up to ten documents; ten 2 MB documents encode to roughly 27 MB and are bounced by `MAX_RAW_EMAIL_BYTES` (14.4 MB) with "larger than 13.7 MB". The per-message cap and the per-email attachment cap describe incompatible envelopes, which also makes the new over-cap acknowledgement line unreachable for anything but small files. Pre-existing and worse before this change (the cap was 10 MB); distinct from the aggregate-memory item above, which is about the forwarding copies rather than the gate.
status: open
decision: 2026-08-20 Derive an aggregate budget — Derive MAX_RAW_EMAIL_BYTES from a stated aggregate budget (up to MAX_EMAIL_ATTACHMENTS documents, or an explicit total) so the advertised attachment count is actually reachable, re-pin the parity test, and add a multi-document aggregate case.

### DW-363: The second copy of the site-URL trim -- the one that builds the sender-visible acknowledgement links -- is pinned by nothing.
origin: spec-deferred 5a52b035362e
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
location: workers/email-ingest/index.ts:386
severity: low
reason: `workers/email-ingest/index.ts` computes `(env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "")` twice: at :325 for the forwarded request (now pinned by the new transport case) and again at :386 for the `Page:` / `Track it under Recent ingests:` lines in the reply. Reverting only the :386 trim leaves both Worker suites green, so a sender would receive `https://host///u/yopedia/slug`. The new `///` fixture already drives the worker with a trailing-slash site and discards `msg.reply` instead of asserting it.
status: open

### DW-364: The Worker's two misconfiguration early-returns -- missing service token and missing site URL -- produce sender-visible replies that no test observes.
origin: spec-deferred def3eb49a02e
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
location: workers/email-ingest/index.ts:255-263
severity: medium
reason: `workers/email-ingest/index.ts:255-263` replies "the ingest service is not configured" and returns without forwarding when `YOPEDIA_SERVICE_TOKEN` is absent; :326 throws `YOPEDIA_SITE_URL is missing`, caught by the surrounding try/catch into the "could not queue this email" reply. Neither branch is exercised anywhere, so deleting either -- and forwarding an unauthenticated request, or one to a relative URL -- fails nothing. The new `forwardedRequest(siteUrl)` helper already parameterises the site, so the second is one fixture away.
status: open

### DW-365: `assetFromArchive` still indexes the unzipped file map with a raw `files[target]`, one line above the `ownLookup` call added to close exactly that pattern.
origin: spec-deferred d5c3b8bba1b8
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
location: src/lib/document-extract.ts:458
severity: low
reason: `src/lib/document-extract.ts:458` does `const bytes = files[target]`, where `target` is resolved from a relationship `Target` attribute inside an attacker-supplied archive. `resolveArchiveTarget` can produce a bare `constructor` (e.g. from `../constructor`), which would answer an inherited function. It is unreachable today only because `mediaTypeFor` rejects an extensionless name first and the `!bytes || !mediaType` guard short-circuits -- an accident of ordering, not a guard. Routing it through `ownLookup` would make it match its neighbour.
status: open

### DW-366: The route's `MAX_EMAIL_CONTENT_CHARS` 400 branch is unexercised -- the same defect class as DW-250, two gates above it.
origin: spec-deferred a47249ac6557
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
location: src/app/api/email/ingest/route.ts:152
severity: low
reason: `src/app/api/email/ingest/route.ts:152-157` returns 400 with "Email body exceeds 100,000 characters" for an over-long body. Nothing in the repo posts a body above the cap, so the branch and its `toLocaleString` copy could be deleted or inverted with the suite green. The Worker truncates at the same number before forwarding, so -- like DW-250's branch -- this is a route contract for direct callers.
status: open

### DW-367: The route's "no text body or supported document attachment" 400 asserts only its status, in the same file as a new block arguing at length that the copy must be pinned.
origin: spec-deferred 96774befabcc
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
location: src/app/api/email/ingest/route.ts:146
severity: low
reason: `src/lib/__tests__/email-ingest-route.test.ts`'s "rejects attachment-only email when its file type is unsupported" checks `status === 400` and that nothing was enqueued, leaving "The email has no text body or supported document attachment to ingest" (`route.ts:146-151`) unmatched by anything in the repo -- the same gap DW-250 named for the neighbouring branch.
status: open

### DW-368: The Extraction provider picker on the same flat /settings page also offers Custom and renders no base-URL or API-key field, so it stores a provider the runtime refuses to construct with no on-page poi
origin: spec-deferred ab8661d17322
source_spec: `spec-dw-61-327-329-legacy-settings-surface-parity.md`
location: src/components/StructuredKnowledgeSettings.tsx:84-99
severity: medium
reason: StructuredKnowledgeSettings.tsx populates its select from the same PROVIDER_INFO list that carries `custom`; the route accepts structuredKnowledgeProvider: "custom" and config.ts resolves it through getConfiguredModel, which throws "The Custom provider needs a base URL. Set it in Settings -> LLM Models." (src/lib/llm.ts:395-408) - the twin of the primary path's throw at :285-301 that DW-61 closed. Pre-existing: the DW-61 ledger entry and this bundle's intent both scope the fix to ProviderForm's picker, so the extraction picker was never in scope. There is no test file for StructuredKnowledgeSettings at all.
status: open

### DW-369: The five "Settings -> LLM Models" literals in llm.ts are hand-typed rather than derived from settingsCategory, so renaming that category leaves five runtime errors naming something the nav no longer s
origin: spec-deferred b8ca25f1e6cd
source_spec: `spec-dw-61-327-329-legacy-settings-surface-parity.md`
location: src/lib/llm.ts:287
severity: low
reason: src/lib/llm.ts:287, :292, :301, :402, :407 spell the destination as string literals. workbench-settings.ts now derives its own pointers from SETTINGS_CATEGORIES precisely to prevent that drift, and documents why llm.ts deliberately keeps the shorter form - but nothing enforces the category half of either string. Pre-existing; surfaced by the new settingsPointer helper rather than caused by it.
status: open

### DW-370: `detectEnvProvider()` and the embedding provider detection still select `ollama` from the mere presence of `OLLAMA_BASE_URL`, including a value `getOllamaBaseUrl` now refuses.
origin: spec-deferred 9a66b32844ef
source_spec: `spec-dw-71-326-272-settings-config-resolution-hardening.md`
location: src/lib/config.ts:739
severity: medium
reason: src/lib/config.ts:739-742 and src/lib/embeddings.ts:217 branch on the variable's presence, not on its usability. After DW-326 a typo'd `OLLAMA_BASE_URL=localhost:11434` both SELECTS the ollama provider and resolves to no endpoint, so generation and embed silently go to the SDK's own localhost default instead of failing against the address the owner typed. Pre-existing detection logic; the fall-through this bundle chose over a refusal is what makes the outcome silent. Closing it means either detecting through the validated accessor or writing down why detection deliberately answers a wider question.
status: open

### DW-371: The filesystem provider's compare-and-set is best-effort: its etag is `mtime-size` and its read pairs `readFile` with `stat`, so a losing compare-and-set can still win there.
origin: spec-deferred 4c28f233b6f3
source_spec: `spec-dw-71-326-272-settings-config-resolution-hardening.md`
location: src/lib/storage/filesystem.ts:266
severity: medium
reason: src/lib/storage/filesystem.ts:266-299. `readFileWithEtag` resolves `fs.readFile` and `fs.stat` through `Promise.all` — an unordered pair, so a write landing between them can yield old content with a fresh etag, and the CAS then MATCHES on a stale merge base. The etag itself is `${mtime.getTime()}-${size}`, so two saves in the same millisecond that swap equal-length values collide. Measured ~190/200 identical etags for back-to-back rewrites without fsync on a scratch file, 0/100 through the provider's fsync+rename path. Never worse than the unconditional write it replaced, and R2's server-side conditional put is exact — but the fs guard is narrower than "refuses instead" reads. Closing it means a content hash or stat-then-read ordering in the storage layer, whose contract and other consumer (graphify-jobs.ts) are outside this bundle. Documented at src/lib/config.ts's saveConfig docblock rather than hidden.
status: open

### DW-372: A pre-DW-272 build reading the new single-object config carries `__settingsVersion` through as an ordinary key and writes it back, so the stamp stops rotating on a rollback.
origin: spec-deferred 9589cff245eb
source_spec: `spec-dw-71-326-272-settings-config-resolution-hardening.md`
location: src/lib/config.ts (CONFIG_VERSION_KEY)
severity: low
reason: The retired scheme's `readStoredConfig` returned the parsed object verbatim and `saveConfig` wrote whatever it was handed, so an older build round-trips the reserved key untouched while stamping its sibling file. The new build then keeps reading the same frozen token out of the object. The guard degrades to always-matching rather than losing data, and this fork deploys manually via wrangler with no rolling releases, so the window is a deliberate rollback. Namespacing the key per scheme, or refusing a token whose config predates the scheme, would close it.
status: open

### DW-373: Opening the in-shell Settings surface still unmounts the whole mode canvas, so the Wiki subtree DW-26 keeps mounted across mode switches is destroyed — dialog, typed name and error — whenever Settings
origin: spec-deferred 125b109b6d09
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
location: src/components/workbench/Workbench.tsx (settingsOpen canvas swap)
severity: medium
reason: `Workbench.tsx` renders `settingsOpen ? <SettingsCanvas …/> : <ModeCanvas …>{children}</ModeCanvas>`, so `children` (`WikiWorkbench`) leaves the tree when the rail's Settings control — or, since this change, `g s` — opens the surface. Pre-existing: the rail control has behaved this way since Story 1.9, and DW-26 names `ModeCanvas` and mode switching only. Closing it means deciding how `SettingsCanvas` keeps owning discard-on-leave for its own draft while no longer being the thing that unmounts the canvas beside it.
status: open

### DW-374: Only `TimeoutError`/`AbortError` are treated as unconfirmed, so a dropped connection or a 502/504 is reported as a known failure — with transport vocabulary — and no refresh runs.
origin: spec-deferred e6705ae0513e
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
location: src/lib/workbench-request.ts (writeFailure)
severity: medium
reason: `writeFailure` returns `unconfirmed: true` for the two abort names and otherwise prefers `cause.message`. A mid-write network drop arrives as `TypeError: Failed to fetch` (Safari: `Load failed`) and a gateway timeout as `send`'s `Request failed (504)`; in both the server may have applied the write, so the owner is told it failed over something unknown, and the screen is not reconciled. `Failed to fetch` also reaches the owner verbatim, which `workbench-settings.ts` already calls transport vocabulary no copy table contains. Pre-existing shape: `failureMessage` classified these the same way before this change.
status: open

### DW-375: `WikiSwitcher`'s create, rename and delete confirms stay live after an unconfirmed write, so a retry can seed a duplicate wiki or paint a 404 over a delete that landed.
origin: spec-deferred be4b261f912b
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
location: src/components/workbench/WikiSwitcher.tsx (create, rename, remove)
severity: medium
reason: The card holds its create door shut with `awaitingCreate` on the unconfirmed path; the switcher has no equivalent. `busy` is cleared in `finally`, the dialog stays open, and the confirm is pressable — over a POST that may have created the wiki (nothing enforces unique names) or a DELETE whose second attempt answers 404, which the switcher's own comment calls "a failure over an operation that in fact succeeded". Pre-existing: the retry window is the same one an aborted write has always left open; this change only renamed the message.
status: open

### DW-376: `SettingsCanvas.save` and `PreviewColumn` carry their own deadlines and still report a blown one as a flat failure, which is the claim DW-283 says the client cannot make.
origin: spec-deferred 5d49180cca3b
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
location: src/components/workbench/SettingsCanvas.tsx (save), src/components/workbench/PreviewColumn.tsx
severity: medium
reason: Both arm their own `AbortSignal` rather than using `send` (each needs the controller), so neither reaches `writeFailure`. `SettingsCanvas.save` resolves an abort to `SETTINGS_SAVE_FAILED_COPY` ("Settings couldn’t be saved.") over a PUT the server may have applied — on the surface this change just made keyboard-reachable through `g s`. Out of DW-283's stated scope, which names `workbench-request.ts` and the wiki writes.
status: open

### DW-377: Retry attempts are counted per qualifying poll rather than per settled re-render, so a nudge or visibility burst — or a merely slow refresh — can spend the whole budget before any new baseline has had
origin: spec-deferred eb490a039820
source_spec: `spec-dw-48-data-version-refresh-retry.md`
location: src/components/workbench/DataVersionWatcher.tsx (run), src/lib/workbench-data-version.ts (DATA_VERSION_REFRESH_ATTEMPTS)
severity: medium
reason: `run()` has three triggers: the `DATA_VERSION_POLL_MS` interval, `visibilitychange` -> visible, and the `requestDataVersionCheck()` save nudge (`PreviewColumn.tsx`). Every qualifying poll from any of them spends an attempt, so three alt-tabs or three saves that all still answer the same version drive `attempts` from 0 to `DATA_VERSION_REFRESH_ATTEMPTS` in milliseconds and re-strand that version — the DW-48 symptom, now probabilistic rather than certain. The same shape covers an in-flight `router.refresh()` still rendering when the next tick fires: a merely slow re-render reads as "did not catch up" and burns an attempt. A wall-clock window (which DW-48's own wording offered as an alternative to a count) or an in-flight guard would close it; both are refresh-policy decisions beyond the bounded-count reading this story implemented, and the count reading is strictly better than the single-shot stamp it replaced in every case.
status: open

### DW-378: `readWikiPage` answers `null` for a page that is UNREADABLE as well as one that is absent, so a storage blip on the page write's merge-base read is reported as `404 page not found`.
origin: spec-deferred e2c2f3bbd280
source_spec: `spec-dw-193-194-195-200-write-precondition-and-version-freshness.md`
location: src/lib/wiki.ts:409, src/app/api/wiki/[slug]/route.ts:161
severity: medium
reason: `src/lib/wiki.ts:409-419` warns and returns `null` for every non-ENOENT read failure, and `PUT /api/wiki/[slug]` turns that `null` into `page not found: <slug>` before the precondition is ever consulted. This bundle made exactly the opposite call one layer over: when `writeWikiArtifact` is given an `expectedVersion`, a failed pre-write read rethrows rather than being read as "absent", because "absent" is answered as a conflict and a blip is not one. The page path keeps the older behaviour, so the same transient failure is a 404 on one surface and a 500 on the other. Pre-existing — the swallow predates the precondition and this change only added the `fresh` option beside it — and closing it means changing `readWikiPage`'s null contract, which ~40 callers depend on.
status: open

### DW-379: The other read-modify-write merge bases still read through `pageCache`, so the staleness DW-195 closed for the precondition-bearing reads is open on every path that merges into cached bytes and writes
origin: spec-deferred 620dd58d504a
source_spec: `spec-dw-193-194-195-200-write-precondition-and-version-freshness.md`
location: src/lib/patch-metadata.ts, src/lib/merge.ts, src/lib/lint-fix.ts
severity: medium
reason: `src/lib/patch-metadata.ts` (the `PATCH` frontmatter merge), the page revert in `src/app/api/wiki/[slug]/revisions/route.ts`, `src/lib/merge.ts` and several sites in `src/lib/lint-fix.ts` all call `readWikiPage` / `readWikiPageWithFrontmatter` without `{ fresh: true }` and then write the merged result. A bulk scan (`lint.ts`, `search.ts`, `query.ts`, `dataview.ts`) holding a superseded entry open across one of those requests makes the merge base a file that is no longer stored, and the write lands it back. Pre-existing and unrelated to the precondition — none of these routes is gated, and the spec's Never clause forbids gating them — but "do not gate it" is a different decision from "let it merge into cached bytes". Closing it is a sweep over those call sites, not a change to this guard.
status: open

### DW-380: A fresh read still falls back from a FAILED silo read to the flat copy, so a version can describe bytes at a path the write will not target.
origin: spec-deferred 60eded0bf0fa
source_spec: `spec-dw-193-194-195-200-write-precondition-and-version-freshness.md`
location: src/lib/wiki.ts:389
severity: medium
reason: `src/lib/wiki.ts:389-401` warns on a non-ENOENT silo failure and falls through to `wikiRelPath(...)`, which is the legacy flat file. `fresh` bypasses `pageCache` but not that fallback, so a transient silo failure on a precondition-bearing read hands the editor the version of the flat copy while `writeWikiPageWithSideEffects` resolves the tenant path — a precondition computed over one file and compared against another. Pre-existing: the fallback predates the version entirely and exists so a not-yet-migrated page still reads. Closing it means letting a precondition-bearing read refuse rather than widen, which needs the same null-contract change the entry above names.
status: open

### DW-381: The re-template confirm still presents the Schema overwrite as unrecoverable, which DW-213 has just made false.
origin: spec-deferred 612a8939a001
source_spec: `spec-dw-213-214-artifact-revision-recovery.md`
location: src/components/WikiWorkbench.tsx:415-419
severity: low
reason: `src/components/WikiWorkbench.tsx:415-419` tells the owner "This overwrites purpose.md, Schema, and the Workspace Purpose for this wiki", and the comments at `:222` and `:348` call it "an irreversible rewrite" / "an irreversible overwrite". Since this story a committed re-template records the replaced `schema.md` as a revision the Preview's History panel can list and revert, so the confirm understates what the owner can get back. `purpose.md` and the Workspace Purpose are still unrecoverable, so the sentence is not simply wrong — it needs to separate the two halves. Copy only; no behaviour.
status: open

### DW-382: `deleteWiki` removes a Wiki's `purpose.md` and `schema.md` outright and moves no `dataVersion`, so a Preview open on those artifacts in a second client keeps rendering bytes whose Wiki is gone.
origin: spec-deferred e419c472892c
source_spec: `spec-dw-209-289-wiki-rename-refresh-and-sweep-cap.md`
location: src/lib/wikis.ts (deleteWiki)
severity: medium
reason: DW-209 established the rule this change generalises: a registry operation that also moves bytes a Preview renders must bump, because a non-current Wiki's operations change no `currentWikiId` and the Workbench's selection-reset effect never fires. `deleteWiki` (src/lib/wikis.ts) meets that description exactly — it deletes the artifact directory — and still carries no tail. `WikiSwitcher.tsx` calls `router.refresh()` itself, which covers the client that performed the delete but not any other open client. Pre-existing; surfaced by generalising the rule, not caused by it.
status: open

### DW-383: A sweep candidate whose age cannot be read is skipped but still consumes one of the per-pass cap slots on every pass, so enough of them could starve the tail of the list.
origin: spec-deferred 5c402c238ab7
source_spec: `spec-dw-209-289-wiki-rename-refresh-and-sweep-cap.md`
location: src/lib/wikis.ts (sweepOrphans / ORPHAN_SWEEP_CANDIDATE_CAP)
severity: low
reason: `ORPHAN_SWEEP_CANDIDATE_CAP` truncates the candidate list before `newestWriteTime`, and an unreadable age is treated as too young — a deliberate skip that never clears on its own if the underlying storage error is permanent. The tombstone half of this shape was closed during review (the probe now resolves before the cap); the age half cannot be, because reading the age IS the expensive walk the cap exists to bound. Related to DW-290, which records the future-mtime variant of the same permanently-unsweepable candidate.
status: open

### DW-384: The sibling research routes (PATCH/DELETE `/api/research/[id]`, POST `/api/research/[id]/run`) still write and delete research-project records with no read-only gate.
origin: spec-deferred 4a4bbd173b0f
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
location: src/app/api/research/[id]/route.ts; src/app/api/research/[id]/run/route.ts
severity: medium
reason: DW-294 named only `POST /api/research`, which this change gated. The `[id]` handlers reach `updateResearchProject`/`deleteResearchProject`, reach no kernel writer, and contain no `isReadOnly` reference — so the feature refuses creates and accepts edits, deletes and runs.
status: open

### DW-385: The research, Names & Terms and email-ingest stores carry no `assertWritable`, so a CLI, MCP or agent-runtime caller still writes them on a read-only deployment.
origin: spec-deferred 192b376cbc62
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
location: src/lib/research-projects.ts; src/lib/names-terms.ts; src/lib/email-ingest.ts
severity: medium
reason: DW-314's whole argument is that a route gate is not enough because a direct library caller reaches the kernel with no route in front. This change applied that argument to `wikis.ts` only; `createResearchProject`, `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm` and `saveEmailIngestConfig` got HTTP gates alone.
status: open

### DW-386: Three surfaces now compose a write in front of a door this change taught to answer 403, with no read-only mirror — the DW-264/DW-265 shape, one bundle later.
origin: spec-deferred 56c9d9c9eb3d
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
location: src/components/NamesTermsSettings.tsx; src/components/EmailIngestSettings.tsx; src/components/KnowledgeStudio.tsx
severity: medium
reason: `NamesTermsSettings` and `EmailIngestSettings` render immediately below the `/settings` form that now refuses per control, and `KnowledgeStudio` posts to `/api/research`; all three submit and meet the new 403 afterwards. `READ_ONLY_REFUSAL.namesTerms` and `.emailSettings` consequently have no client counterpart and no parity-test entry.
status: open

### DW-387: `/settings` now states three different sentences for one deployment state, none of them owned by `READ_ONLY_REFUSAL` and none pinned by the parity suite.
origin: spec-deferred cba66956e0ae
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
location: src/app/settings/page.tsx:147; src/app/api/settings/route.ts:130; src/app/api/settings/rebuild-embeddings/route.ts
severity: medium
reason: The banner every refused control now points at reads "Read-only mode — This deployment has explicitly disabled settings changes."; `PUT /api/settings` answers "Settings are read-only in this deployment."; `POST /api/settings/rebuild-embeddings` answers a third wording. Only the banner is on screen, so the owner reads one sentence before pressing and another if anything reaches the route.
status: open

### DW-388: Nothing outside code comments records that `POST /api/tasks/scan` now answers 403 on every cron pass of a read-only deployment.
origin: spec-deferred 49c9a3138d42
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
location: DEPLOY.md; src/app/api/tasks/scan/route.ts:62
severity: low
reason: The scan is the only trigger for the DW-137 workspace-profile backfill and the only scheduled trigger for the orphan-directory sweep, and a monitor that treats non-2xx as failure will now alert once per tick while `YOPEDIA_READONLY` is set. DEPLOY.md's read-only section documents the Workbench settings affordances and says nothing about the scan.
status: open

### DW-389: The `disputed-page` lint guidance still tells the reader to clear the Disputed toggle with a PATCH that DW-121 now refuses for every non-admin.
origin: spec-deferred 63617f440c96
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
location: src/lib/lint-fix.ts:729-730 and src/lib/lint-checks.ts:727
severity: medium
reason: `src/lib/lint-fix.ts:729-730` and the check's own `suggestion` at `src/lib/lint-checks.ts:727` both say: clear the Disputed toggle in the page editor (PATCH /api/wiki/<slug> with metadata { disputed: false }). After DW-121 that PATCH is refused for every non-admin principal on a public knowledge page, so the instruction names a loop only an agent token's owner-as-admin, a service principal or a site admin can complete. In this deployment the human IS the site owner and therefore an admin, so the action still works for them; the copy is inaccurate for anyone else. The spec scoped lint copy out of this pass (Design Notes, "Non-admin metadata loop"). Both sites must move together — closing only lint-fix.ts leaves half the copy wrong.
status: open

### DW-390: Deleting the reconciliation-thread writer took the last programmatic caller of the whole talk thread API with it.
origin: spec-deferred 83dd95b177cf
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
location: src/lib/talk.ts, src/lib/browse.ts:184
severity: medium
reason: `listThreads`, `createThread`, `getThread`, `addComment`, `resolveThread` and `hasOpenThread` now have no non-test callers; only `deleteDiscussions` (lifecycle.ts), `getDiscussRelPrefix` (discuss-stats-index.ts, contributors.ts) and `getDiscussionStatsForSlugs` (browse.ts) are still read, and the talk HTTP surfaces that drove the rest are retired. A knock-on: `browse.ts:184` still renders a per-page discussion count that nothing can increase any more, and pre-existing reconciliation threads stay on disk feeding it. Retiring that surface — and the discuss-stats/contributor indexes hanging off it — is wider than DW-230 asked, and the spec's Never list forbids touching talk.ts's remaining readers, so it is recorded rather than resolved. The retirement banner in talk.ts says the same thing so the dead surface is not mistaken for live API.
status: open

### DW-391: A non-admin page owner can no longer take their own public knowledge page private — the realm became a one-way door for them.
origin: spec-deferred d981f87caa54
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
location: src/lib/patch-metadata.ts:106-140
severity: medium
reason: `patchMetadata`'s realm ACL (`src/lib/patch-metadata.ts:106`) runs above the owner-only visibility guard, so `{ visibility: "private" }` on a public, non-agent-scoped, non-artifact page is now refused for its own owner over both REST and MCP, and that guard is unreachable for them. This follows directly from the recorded DW-121 decision (metadata is refused wherever body is), and the visibility-guard suite had to reseed onto an `html` artifact to keep exercising the guard at all — which is the signal that the plain-public path changed underneath it. In this deployment the human is the site owner and therefore an admin, so it does not bite here; a multi-user deployment would feel it, and there is no non-admin exit from the realm.
status: open

### DW-392: Revert is still offered to signed-out viewers on every page the realm does not restrict.
origin: spec-deferred 5acd94afc307
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
location: src/components/RevisionHistory.tsx
severity: medium
reason: `canRevert` in `src/components/RevisionHistory.tsx` carries a realm term and a site-owner term but no `isSignedIn` term, so an anonymous viewer of a public artifact or an agent-scoped page is still shown Revert and its irreversible-sounding confirm in front of a write the middleware 401s. This predates DW-269 (the control was ungated for everyone), and the recorded intent asked only for "the same realm term the Delete gate got", with the spec's Never list forbidding an ownership term — so the signed-in half was deliberately left alone. `ArticleActions` reads `isSignedIn` for exactly this purpose one component over.
status: open

### DW-393: An orphan page — on disk but absent from the page index — now makes its ingest-history row undeletable and fails the whole batch.
origin: spec-deferred a01843f3f763
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
location: src/app/api/ingest/history/route.ts
severity: medium
reason: The DW-270 gate keys on `listReadableWikiPages`, which filters the page INDEX, not a per-page read. `src/lib/lint.ts:94`'s `checkOrphanPages` exists because index/disk drift is a real state here. A done job whose page is in that state used to delete the page and clear the job record; it now answers 404 for the entire request, clearing nothing else selected alongside it. This is exact parity with the pre-existing `ingestIds` preflight, which has always behaved this way, so DW-270 inherited the behaviour rather than inventing it.
status: open

### DW-394: Both guidance memos are keyed by `owner`, but the files they memoize are addressed by TENANT, so two owner strings in one tenant key two entries over one file.
origin: spec-deferred 1eea774dfd5c
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
location: src/lib/names-terms.ts:214
severity: low
reason: `dictionaryPath` (src/lib/names-terms.ts:88) and `getCurrentWiki` both route the owner through `tenantForOwner` -> `ownerToTenant`, which lowercases and collapses punctuation. `"Alice"` and `"alice"` therefore occupy two `Map` slots pointing at one file: two reads instead of one, and two snapshots that can diverge under a single handle. Latent today — `owner` is one fixed string inside an `ingest()` and inside a batch request (`principal.handle`) — and inherited from DW-141, which set the owner-keying precedent. Keying on `tenantForOwner(owner)` would collapse both.
status: open

### DW-395: `src/mcp.ts`'s batch ingest tool loops `ingestUrl` over up to MAX_BATCH_URLS URLs with no handle — the same one-action-N-documents shape DW-324 just closed for the HTTP batch route.
origin: spec-deferred a07d00ea301f
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
location: src/mcp.ts:528
severity: medium
reason: `handleIngestBatch` (src/mcp.ts:526-532) calls `ingestUrl(url, {...})` sequentially inside a `for` loop, so every URL of one agent action resolves the Workspace Purpose and re-reads the dictionary from scratch. The remedy is now one line — add `guidanceCache: createGuidanceCache()` to that options literal — but DW-324 names `src/app/api/ingest/batch/route.ts` specifically and this spec's scope was held to the HTTP door, so the MCP door was deliberately not touched.
status: open

### DW-396: `IngestOptions` now carries a live, non-serializable object guarded only by the convention that queue task payloads are hand-written literals.
origin: spec-deferred f8d8c4c6caab
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
location: src/lib/ingest.ts:1328
severity: low
reason: `IngestOptions.guidanceCache` holds two `Map`s. The batch route keeps it out of the queue by building `enqueueTask`'s payload as a separate literal (src/app/api/ingest/batch/route.ts:143-150), and `tasks/run` and the agent ingest route do the same by hand. Nothing structural stops a future `enqueueTask({ kind: "ingest", ...ingestOptions })`: TypeScript does not excess-property-check spread properties, so it would compile and fail at structured-clone/JSON time. An `Omit<IngestOptions, "guidanceCache">` on the payload builders, or a handle passed as its own argument rather than a field on the data bag, would make it a compile error.
status: open

### DW-397: Under a handle the dictionary ENTRY OBJECTS are shared across every caller of the operation; only the top-level array is copied.
origin: spec-deferred db45e54ae4f5
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
location: src/lib/names-terms.ts:236
severity: low
reason: `listNamesTerms` returns `[...(await memo)]`, so a caller that sorts or splices its result cannot corrupt the next one (pinned by a test). The entries inside are the same objects, where before the memo each read produced fresh objects from `JSON.parse`. No caller in the repo mutates an entry (`canonicalizeNamesTerm`, `renderNamesTermsGuidance` and `applyNamesTermsToGeneratedText` all read), and the docblock says so, but nothing enforces it — one future `entry.aliases.push(...)` would leak into every later caller of that request. `Object.freeze` on resolve, or a test pinning the object-level invariant, would close it.
status: open
