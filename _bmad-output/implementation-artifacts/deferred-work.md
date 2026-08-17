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
status: open
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
status: open
decision: 2026-08-16 Keep, re-document — Keep the deny (it still usefully stops future non-admin principals from overwriting curated public pages), rewrite its stale rationale comment, and give the edit page's denial copy an accurate explanation.

### DW-8: The contributor capability is retired at every page and REST surface but still ships as two MCP tools.
origin: spec-deferred b763192224b5
location: src/lib/mcp-http.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/wiki/contributors`, `/api/contributors` and `/api/contributors/[handle]` all 404, and `/u/<handle>` is gone — but `list_contributors` and `get_contributor` remain registered in `src/lib/mcp-http.ts` and `mcp.json`, and `mcp-http.test.ts` was updated to keep them passing. They are read-only and bearer-gated, so nothing leaks in a single-owner deployment; whether the capability should survive at MCP after being cut everywhere else is a product call, not a defect.
status: open
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
status: open

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
status: open
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
status: open
decision: 2026-08-16 Build rename+delete — Add rename (updates registry and the purpose.md heading) and confirm-gated delete (removes the registry entry and its wikis/<id>/ directory, refusing to delete the current Wiki), plus an orphan-directory sweep, with matching routes and Workbench controls.

### DW-19: `loadPageConventions()` resolves the active Wiki deployment-globally from `NEXT_PUBLIC_OWNER_HANDLE`, while the guidance beside it at the same prompt sites resolves per-caller.
origin: spec-deferred 54c8fcb81384
location: src/lib/wikis.ts:398
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `readActiveWikiSchema()` calls `getOwnerHandle()`, the only place in the repo where that value becomes a storage key — every other tenant-scoped read/write (`workspace-profile.ts`, `research-projects.ts`, `portable-archive.ts`) takes a passed-in owner. At `ingest.ts:1165/1239/ 1511`, `query.ts:226`, `agent-runtime.ts:154` and `source-monitors.ts:386` the no-argument `loadPageConventions()` sits directly beside `buildWorkspaceGuidance(owner)`, whose `owner` can be `"system"`, an agent handle, or a monitor's owner. So a non-site-owner caller now gets the site owner's Scenario Template conventions where it previously got the generic root `SCHEMA.md`. The spec's Code Map sanctions `getOwnerHandle()` as "how a server-side helper with no owner argument resolves the single-owner tenant", and `isOwnerHandle()` already makes handle equality the repo's owner-trust model, so this is correct for the single-owner deployment shipping today. Threading a tenant into the loader is the real fix and it b
status: open
decision: 2026-08-16 Keep, document the constraint — Leave the getOwnerHandle() resolution in place and document it as an explicit single-owner invariant at src/lib/wikis.ts:540 and at each no-argument loadPageConventions() call site, naming what must change when a second tenant arrives. Add a test that pins the single-owner assumption so a multi-tenant change cannot land silently.

### DW-20: Create and re-template are not atomic across the two artifact writes, the profile write, and the registry write.
origin: spec-deferred 1f1c9143305b
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `createWiki` runs `seedWikiArtifacts()` (purpose.md → schema.md → `saveWorkspaceProfile`) before `writeRegistry`, with no rollback. A failure part-way leaves `wikis/<id>/` on disk with no registry entry and a tenant profile already switched to the new template; in `applyScenarioTemplate` it can leave purpose.md from one template beside schema.md from another. The storage provider exposes no transaction, and `research-projects.ts` — the registry idiom the spec directs this module to mirror — has the same property, so this is an inherited architectural limit rather than a defect in this change. Closing it means a write-ahead or compensating-write facility in the storage layer.
status: open

### DW-21: Switching the active Wiki rewrites the tenant-global workspace profile with no confirm at all, unlike the template overwrite it is equivalent to.
origin: spec-deferred 3671da5ea756
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `setCurrentWiki` calls `saveWorkspaceProfile(owner, templateProfile(...))` — added deliberately so `loadPageConventions()` and `buildWorkspaceGuidance()` cannot name two different templates at once. The consequence is that the bare `<select>` in `WikiWorkbench` is a destructive write on the same tenant singleton that `Change template` guards behind `ConfirmDialog`. Gating a switch is not in this story's acceptance criteria, and the durable fix is the same reconciliation of the per-Wiki and tenant-global representations that Story 1.8 (Edit Schema) owns.
status: open

### DW-22: The `wikis:<tenant>` lock does not serialize against the `workspace-profile:<tenant>` lock it writes through.
origin: spec-deferred 7d6ef98a9b38
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: low
reason: `withFileLock("wikis:<tenant>", …)` wraps `saveWorkspaceProfile`, which takes `withFileLock("workspace-profile:<tenant>", …)` — a different key. A concurrent save from the Workspace Purpose settings form can therefore interleave, leaving `schema.md` naming one template and the profile another. Reachable only from one owner acting in two places at once on a single-owner deployment, and the obvious fix (nesting the two locks) introduces a lock-ordering hazard with any future caller that takes them the other way round.
status: open

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
status: open

### DW-27: The active mode has no URL representation, so a mode cannot be linked or bookmarked and Back leaves the app entirely.
origin: spec-deferred 8ebf6433668a
location: src/components/workbench/Workbench.tsx
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: low
reason: Mode lives in React state plus `yopedia_workbench_mode`. The intent's constraint is that a mode switch must not unmount the shell (`epics.md:367`), which a shallow query-param sync would also satisfy — so this is a design choice the story did not have to make, not a requirement it met. It is cheap now and a breaking change to the persisted-state contract later, so it is worth an explicit decision before Stories 1.4-1.6 build selection state on top of it.
status: open
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
status: open
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
severity: low
reason: `listWorkbenchFilePaths` filters `.md` leaves under the wiki root against the slug set `listReadableWikiPages` returned, so a page hidden from the Knowledge tab cannot surface in Files by filename. `raw/` is not filtered: `saveRawSource` writes `raw/<slug>.md` and `saveRawSourceFor` writes `raw/<slug>/<hash>.md`, so the source tree still spells the slug of a page the filter excludes. In the single-owner Workbench this epic ships, every file under the tenant belongs to the signed-in owner, so nothing crosses an owner boundary today — the exposure is limited to agent-scoped pages and to legacy flat-tree residue. Filtering `raw/` needs a source→page mapping the walk does not have (one raw file can back several pages, and an orphaned source backs none), so it belongs with whichever story gives Sources a real read model — Epic 2.
status: open

### DW-33: Wiki mode now shows two Wiki switchers and two create controls at once — the new header pair and Story 1.2's canvas card.
origin: spec-deferred 6403cc2df74f
location: src/components/WikiWorkbench.tsx
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: low
reason: `create-wiki-ui.test.ts:118-209` counts `btn primary`, `fallbackFocusRef={headingRef}` and `router.refresh()` occurrences inside `src/components/WikiWorkbench.tsx`, so this story was forbidden to edit that file at all — its `Active wiki` <select>, its `New wiki` button and its `Change template` control all stay. The result is a duplicated affordance in one viewport: the header switcher and the card switcher drive the same `PUT /api/wikis/current`, and `page.tsx` keys the card on `currentId` so they cannot disagree, but the owner is offered the same choice twice. Retiring the card's switcher means retargeting those frozen counts, which belongs with whatever story rebuilds the Wiki canvas (Story 1.5 onwards) rather than with the column that now duplicates it.
status: open

### DW-34: Docking and undocking the Preview is a silent layout change, and below 900px the column arrives off screen below the canvas.
origin: spec-deferred 884c300a0a3f
location: src/components/workbench/Workbench.tsx, src/app/globals.css
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: low
reason: Story 1.3 gave the shell a polite live region, but only `selectMode` writes to it — selecting a tree row adds a whole fourth column with no announcement and no focus move, and re-selecting the same row removes it just as quietly. At `max-width: 899px` the shell is one column and the Preview stacks as the last row, so on a phone tapping a tree row appears to do nothing until the owner scrolls. Neither behaviour is wrong against this story's acceptance criteria, which ask only that selection dock the column, and both are cheap to get wrong in isolation: what to announce depends on what the column will say, which is Story 1.5's, and where a docked column goes at narrow widths is the layout question Story 1.6 owns. Deciding either here would pre-empt a story that has the context.
status: open
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
status: open

### DW-37: `PUT /api/wiki/[slug]` has no `isReadOnly()` gate, and this story's `Edit` affordance is the first surface to offer it to a human.
origin: spec-deferred 28559db804f6
location: src/app/api/wiki/[slug]/route.ts
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: Every other mutating route consults `isReadOnly()` and answers 403 — `api/wikis/route.ts`, `api/wikis/current`, `api/wikis/[id]/template`, `api/workspace-profile`. The page write route never has. On a read-only deployment the Preview therefore offers `Edit`, opens the dialog, and the save SUCCEEDS, because gating `editable` in the preview route would only hide a door that is still unlocked. The fix belongs at the write route, where it also covers the MCP and agent callers, not at the affordance that happens to have surfaced it.
status: open

### DW-38: The page write path has no lost-update guard, so a save can silently overwrite a page rewritten since the Preview read it.
origin: spec-deferred 0f0288cf1313
location: src/lib/lifecycle.ts, src/app/api/wiki/[slug]/route.ts
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: `savePreviewBody` PUTs `{ content }` with no `updated`, ETag or `If-Match`, and `writeWikiPageWithSideEffects` takes it. The storage provider already exposes `readFileWithEtag` and `writeFileIfMatch` (`src/lib/storage/types.ts:196,205`) and nothing in the kernel write path uses them. Not reachable in Epic 1 — one operator, no ingest — but Epic 2 gives the same pages a second writer, and Epic 8's loopback API a third, so whichever of those lands first is where the guard has a real reason to exist rather than a hypothetical one.
status: open

### DW-39: Story 1.2's canvas card keeps saying `Select a file to preview.` while a Preview column is docked beside it showing exactly that file.
origin: spec-deferred 6624dcbc2fe7
location: src/components/WikiWorkbench.tsx:254
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
severity: low
reason: The sentence is an unconditional element of `WikiWorkbench.tsx:254`, rendered on the Wiki canvas at every moment, and this story's first acceptance criterion is satisfied by not disturbing it. Once the fourth column docks, one viewport carries a rendered page and a sentence saying nothing is selected. Retiring or conditioning that sentence means editing a file whose in-file occurrence counts `create-wiki-ui.test.ts:118-209` asserts — the same freeze that produced `spec-1-4` deferred entry 4, and the same owner: whichever story rebuilds the Wiki canvas.
status: open

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
status: open
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
status: open
decision: 2026-08-16 Offset the strip off the scrollbar — Keep the visual divider at its current width but move the hit strip fully onto the canvas side of the boundary and widen it toward 24px there, so the scrollbar stays reachable and the target grows. Verify against the tree's scrollbar at both collapsed and expanded widths.

### DW-45: The separators carry no `aria-controls`, and the keyboard surface has no coarse step (PageUp/PageDown).
origin: spec-deferred e99921b6f2d1
location: src/components/workbench/SplitHandle.tsx, src/lib/workbench-split.ts
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: The ARIA window-splitter pattern names the pane a separator resizes via `aria-controls`. The tree divider could point at `LEFT_ID`, which the shell already declares — but the Preview divider would need an id on `.wb-preview`, and `PreviewColumn.tsx` is outside the set of existing files this story's Code Map allows it to edit. Wiring one and not the other is worse than wiring neither. The same applies to PageUp/PageDown: with `SPLIT_KEY_STEP = 16`, crossing the tree's real range is ~30 presses. Both belong with whichever story next opens the Preview column's markup.
status: open

### DW-46: The restore validates a stored row against the two trees and the Wiki id, but never against the tree TAB it restores alongside it.
origin: spec-deferred ce30a7341cbf
location: src/lib/workbench-tree.ts (restorableSelection), src/components/workbench/Workbench.tsx (mount effect)
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: `restorableSelection` takes `(stored, wikiId, knowledge, files)`. The shell's reset effect exists to prevent exactly one state — a docked Preview describing a row the showing tree cannot mark with `aria-current` — and the restore path is the one site that can produce it, because the mount effect's signature guard then protects the mismatch from being cleared. Reaching it needs the two keys to diverge, which needs the persist effect's health guard to skip a write across a tab switch (a transient `knowledgeUnavailable` / `filesUnavailable`), so it is narrow. The obvious fix is not obviously right either: requiring `kind` to agree with `tab` would drop the restore of a page selection made on the Files tab, which `wikilinkSelection` deliberately produces when the walk did not list that page's file (Story 1.5). Whether that pairing should survive a reload is a decision about the wikilink fallback, not about the clamp, and it belongs with whichever story next opens that path.
status: open
decision: 2026-08-16 Restore the tab, not reject the row — When a restored selection's kind disagrees with the restored tab, switch the tab to the one that can mark the row rather than dropping the selection. This keeps the wikilink cross-tab pairing restorable and still guarantees the docked Preview always has a row carrying aria-current.

### DW-47: The tree's scroll effects re-run on tab and collapse only, so crossing the 899px force-show boundary by RESIZING is missed.
origin: spec-deferred 960bd3db4d29
location: src/components/workbench/TreePanel.tsx (the two scroll effects)
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: `treeScrollActive` correctly asks the element rather than the collapse flag, because `@media (max-width: 899px)` force-shows a collapsed column. But both effects are keyed `[tab, collapsed]`, and neither changes when the viewport crosses 900px mid-session — so an owner who is collapsed and narrows the window gets a fully visible, scrollable tree whose offset is neither restored nor recorded until they next switch tabs. A load at that width is fine; only the live transition is missed. Closing it needs a `matchMedia("(max-width: 899px)")` listener in `TreePanel`, which is a second copy of a breakpoint this story deliberately keeps in the stylesheet (and which `workbench-split.test.ts` bans by name). Whether that trade is worth making belongs with whichever story revisits the left column's responsive behaviour.
status: open
decision: 2026-08-16 Allow one shared breakpoint constant — Introduce a single exported breakpoint constant consumed by both the stylesheet build and TreePanel's matchMedia listener, add the listener to both scroll effects so the live 900px transition restores and records the offset, and retarget the workbench-split.test.ts ban to forbid ad-hoc duplicate literals rather than the shared constant.

### DW-48: A refresh whose server re-render still reads the OLD version strands that version: `refreshedFor` has already advanced, so it is never retried.
origin: spec-deferred 50d952f5c317
location: src/components/workbench/DataVersionWatcher.tsx (run), src/lib/workbench-data-version.ts (shouldRefreshForDataVersion)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: `DataVersionWatcher` sets `refreshedForRef.current = result.version` before `router.refresh()` and never checks that the new render's `dataVersion` caught up. Both reads go through the same Worker, so the window is narrow — but if the RSC read answers the pre-bump integer, `served` stays behind while `refreshedFor` is ahead, and `shouldRefreshForDataVersion` returns `false` for that version forever; the trees then wait for the NEXT write. The obvious fix is not obviously right: dropping the guard restores the unbounded re-render loop it exists to prevent (a degraded `page.tsx` read stuck at 0 against a route answering 7 would refresh every tick, forever), so closing this needs a bounded retry policy — how many attempts, how long to wait for the baseline to move — which is a refresh-policy decision for whichever story next revisits the signal (Epic 2's Ingest is its first real consumer).
status: open

### DW-49: Writes that bypass `runPageLifecycleOp` — template seeding of `purpose.md` and `schema.md`, raw source files — never move the signal.
origin: spec-deferred 53e5882c5f58
location: src/lib/wikis.ts (seedWikiArtifacts), src/lib/lifecycle.ts (runPageLifecycleOp)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: The bump is at the kernel pipeline's tail, which is what the story's `When` clause names, and `seedWikiArtifacts` (`wikis.ts:280`) writes through `storage.writeFile` instead. Creating a Wiki is covered because `WikiSwitcher` still calls `router.refresh()` itself, but a confirm-gated template RE-APPLY, and any later writer that lands bytes the Files tab renders, would leave a second open tab stale. Story 1.8 routes Schema edits through the kernel write path, at which point that half needs nothing; the open question is only whether seeding and template re-apply should bump too, and that belongs with whichever story owns those flows.
status: open

### DW-50: A silent same-row refresh swaps the Preview's body with no announcement, so a screen-reader user reading it is not told the content changed.
origin: spec-deferred 6d3ef6e9607b
location: src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: Before this story the body changed only when the owner picked a row, which is their own action. A bump from another actor now replaces it underneath them, and `PreviewColumn` has no live region. The epic's accessibility floor already says mode changes announce the surface name, so the same argument applies here — but any announcement is a new authored sentence, and the epic's Copy table is the only place a Workbench sentence may be born. That makes it a copy decision rather than a wiring fix, and it belongs with whichever story next opens that table for the Preview column.
status: open
decision: 2026-08-16 Author and wire — Add a 'Preview updated'-style sentence to the epic's Copy table and announce it from the fetch effect's response handler when a silent same-row refresh replaces rendered content.

### DW-51: `PUT /api/wiki/[slug]` carries no `If-Match` precondition, so the Preview editor silently clobbers a write another actor made while it was open.
origin: spec-deferred d5ca34c088fa
location: src/app/api/wiki/[slug]/route.ts (PUT), src/lib/workbench-preview.ts (savePreviewBody)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: Pre-existing — the write path has never had one — but this story makes the race visible for the first time by teaching the shell to notice other actors' writes, and it deliberately does NOT disturb an open editor, so the draft can now be knowingly stale. The read side already supports the primitive (`readFileWithEtag` / `writeFileIfMatch` in `storage/types.ts`); what is missing is a version on the preview payload, a precondition on the route, and a decision about what the column shows when it fails. That is a whole conflict-handling design, not a patch.
status: open

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
status: open
decision: 2026-08-16 Undock and announce — Reconcile a live selection against a refreshed tree: when the selected row is gone, undock the Preview and announce a new Copy-table sentence through the shell's existing polite live region, so the change is neither silent nor mistaken for a broken column. Thread the reconciliation without growing the reset effect's pinned deps.

### DW-54: A silent refresh cannot tell "another actor deleted this page" from "the network blipped", so a transient failure replaces the page the owner is reading with the failure copy and does not heal itself.
origin: spec-deferred de2abf5767d2
location: src/lib/workbench-preview.ts (fetchPreview, previewBodyState), src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: `fetchPreview` (`workbench-preview.ts:344-364`) collapses 404, 500, a malformed body, the `REQUEST_TIMEOUT_MS` deadline and a bare transport failure into one `{ status: "failed" }`, and `previewBodyState` (`workbench-preview.ts:152-155`) puts `failed` AHEAD of a payload that is still held. Before this story the flag could only be set right after an explicit pick, behind a `Loading…` the owner had just caused. A silent same-row refresh sets it with `plan.reset === false`, so a page jumps straight from rendered bytes to `PREVIEW_FAILED_COPY` for a reason the owner did not initiate — and because the effect re-runs only on `[selection, dataVersion, editing]`, it stays that way until the next bump or until they click elsewhere and back. The spec's rule ("a failed silent refresh still tells the truth, because a page another actor just deleted must not keep rendering as if it were there") is right about deletion and is what makes the conflation visible; separating "gone" from "could not reach
status: open
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
status: open

### DW-57: A Preview left open on `schema.md` across a Scenario Template re-apply shows pre-template bytes, and saving them silently reverts the re-apply.
origin: spec-deferred a5eae62be08b
location: src/lib/wikis.ts (seedWikiArtifacts / applyScenarioTemplate), src/components/workbench/PreviewColumn.tsx
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: `applyScenarioTemplate` rewrites `schema.md` through `seedWikiArtifacts`, which by this spec's own Never list does not bump `dataVersion` (DW-49). `PreviewPane`'s fetch effect re-runs only on `[selection, dataVersion, editing]`, and a re-apply moves none of the three — the Wiki id, the mode and the tree tab are unchanged, so `Workbench`'s selection-reset effect does not fire either. Before this story that stale column was read-only; it is now writable, so Edit → Save writes the pre-template Schema back over the freshly seeded one with a success message. Closing it means deciding whether seeding and re-apply bump the counter, which belongs with the story that owns those flows.
status: open

### DW-58: FR-34's other half is still unbuilt — `purpose.md` is editable from no surface, and the narrow allowlist now pins that shut.
origin: spec-deferred d9e12a049e09
location: src/lib/wiki-scenarios.ts (EDITABLE_ARTIFACT_FILES)
source_spec: `spec-1-8-edit-schema.md`
severity: low
reason: PRD FR-34 reads "Christian can view/edit purpose and Schema from Settings or Wiki tree", and the UX run names both files. This story's acceptance covers Schema alone, so the exclusion is correct here — but it is now an asserted invariant (`expect(EDITABLE_ARTIFACT_FILES).not.toContain( "purpose.md")`), so a later story must edit a test to open it. Opening it also needs an answer to what `purpose.md` must contain to be valid (the Schema's `hasPageConventions` has no analogue) and to how it reconciles with the tenant-global workspace profile (DW-14, DW-21), which is why it was not simply widened here.
status: open
decision: 2026-08-16 Wait for DW-14

### DW-59: An overwritten Schema has no recovery path — the artifact write takes no revision snapshot, while the page write it is modelled on does.
origin: spec-deferred 3d268db29649
location: src/lib/wikis.ts (writeWikiArtifact / putWikiArtifact), src/lib/revisions.ts
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: `writeWikiPageWithSideEffects` calls `saveRevision(slug, existing, …)` (`src/lib/wiki.ts:442`) before it overwrites, and `GET/POST /api/wiki/[slug]/revisions` can revert a page. `writeWikiArtifact` writes through `putWikiArtifact` with no prior read and no snapshot, so the previous `schema.md` is simply gone. That was harmless while the file was seed-only and immutable; it is not once the file is editable, and this is the single file every ingest, chat and lint prompt reads. The story's Design Notes deliberately enumerate the artifact tail as log + bump, so this is a decided omission rather than a missed one — but revisioning is not an index/backlink concern the artifact class lacks, it is the recovery path, and closing it needs a decision about where artifact revisions live (the `revisions/` silo is slug-keyed) that this story does not own.
status: open
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
status: open
decision: 2026-08-16 Retire the legacy page — Delete the legacy /settings route and ProviderForm now that the Workbench Settings surface covers models, embeddings and keys, redirecting /settings into the shell's Settings mode and updating the tests that pin the old route. Resolves DW-62's shortcut question in the same move.

### DW-62: The `g s` keyboard shortcut still routes out of the shell to the legacy Settings page, doing exactly the route change the rail control stopped doing.
origin: spec-deferred cbeb1a3bf4ed
location: src/hooks/useKeyboardShortcuts.ts:46,161
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `src/hooks/useKeyboardShortcuts.ts:46` maps `g s` to `/settings` and dispatches it with `router.push`, and `KeyboardShortcutsProvider` wraps the Workbench. So from inside the shell the keyboard path unmounts everything above the canvas and lands on a page with none of this story's categories, while the rail button opens the in-shell surface. `keyboard-shortcuts.test.ts:102,203` pin the old route, and this story is forbidden from editing pre-existing test files beyond the one rail pin — closing it means deciding whether the shortcut opens the surface or the legacy page stays a legitimate target.
status: open
decision: 2026-08-16 Retarget to the in-shell surface — Change g s to select the Workbench's Settings mode instead of pushing /settings, so the keyboard path matches the rail control and never unmounts the shell, and retarget the keyboard-shortcuts.test.ts pins at :102-105 and :203. Consistent with retiring the legacy page under DW-61.

### DW-63: Two live Settings surfaces now write one config file with no lost-update protection between them.
origin: spec-deferred b1364ed893f7
location: src/app/api/settings/route.ts, src/lib/config.ts (saveConfig)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: Both the new surface and `/settings` read-modify-write the same `AppConfig` through `loadConfig` → merge → `saveConfig`, with no `If-Match`, no version and no lock. A draft seeded before the other surface (or another tab) saved will overwrite it silently on the next Save. This is the same lost-update shape already recorded for the page and artifact writes (DW-38, DW-51, DW-56) rather than a new mechanism, and closing it needs the conflict-surface design those entries are waiting on.
status: open

### DW-64: The configured deadline bounds a whole STREAM on `callLLMStream`, and a deadline that fires surfaces raw transport vocabulary.
origin: spec-deferred 0d779aa5cece
location: src/lib/llm.ts (callLLMStream, timeoutOption)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `callLLMStream` is not retry-wrapped, so its single `AbortSignal.timeout` measures total stream duration rather than time-to-first-response: a 30s deadline set to catch hangs would truncate every answer that takes longer than 30s to finish. Separately, `AbortSignal.timeout` raises a `TimeoutError` whose message matches none of `RETRYABLE_MESSAGES`, so it propagates verbatim — "The operation was aborted due to timeout" is exactly the transport vocabulary this repo's copy rules exclude. Both need Chat's streaming semantics (Epic 3) to decide what a deadline means for a stream and which sentence the owner should see.
status: open

### DW-65: On a read-only deployment the Settings selects and checkbox are `disabled`, which takes them out of the tab order, so a keyboard user cannot even read the stored provider.
origin: spec-deferred e6bf2b886405
location: src/components/workbench/SettingsCanvas.tsx
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: Text inputs use `readOnly` (focusable, still readable) while selects and the vector checkbox use `disabled`, because HTML has no `readonly` for either. The accessible fix is `aria-disabled` plus a suppressed change handler, and it wants one decision applied to every control class in the shell rather than one made inside this surface.
status: open

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
severity: low
reason: `embeddingApiKeyFor` reads the same stored value for `openai` and `google`, and `settingsSaveBody` omits an untouched secret — so an owner who stored an OpenAI key and then picks Google sends that key to Google while the hint still reads "A key is stored." Keying the field per provider (or labelling which vendor the stored key belongs to) is a store-shape decision this story's acceptance does not settle; the vector gate's env leg was made provider-aware in this pass, but the STORED key deliberately stayed vendor-agnostic so a provider changed in the draft can still answer the gate before it is saved.
status: open

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
status: open

### DW-72: One stored `embeddingBaseUrl` is handed to whichever embedding provider is active, so an endpoint entered for OpenAI is sent to Google after a switch.
origin: spec-deferred 1ed1cc09bf7d
location: src/lib/embeddings.ts:228-238 (_createEmbeddingModel)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `_createEmbeddingModel` reads `loadConfigSync().embeddingBaseUrl` and applies it to the `openai` and `google` branches alike, with nothing tying the value to the provider it was typed for. This is the endpoint twin of the already-recorded vendor-agnostic `embeddingApiKey`, and it has the same resolution: keying the field per provider is a store-shape decision this story's acceptance does not settle. Nothing breaks today — the pair is usually changed together — but the silent reuse is real.
status: open

### DW-73: A `workers-ai` embedding model outside the `@cf/` namespace satisfies the vector gate and is then silently discarded at resolution time.
origin: spec-deferred e96831d64aed
location: src/lib/workbench-settings.ts:427-440, src/lib/embeddings.ts (resolveEmbeddingModelName)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `canEnableVectorSearch` asks `workers-ai` for a provider and a model only (it is keyless and self-transporting), so `{ provider: "workers-ai", model: "text-embedding-3-small" }` turns the switch on. `resolveEmbeddingModelName` then rejects the same value for a namespace mismatch and falls back to `@cf/baai/bge-m3`. The owner's model choice is replaced without a word. The namespace guard is pre-existing; teaching the gate about it means deciding whether the surface refuses the model, rewrites it, or narrows the picker.
status: open
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
status: open

### DW-76: The disputed frontmatter flag is now one-way — ingest still sets disputed: true on contradicting merges and ArticleView still renders the disputed banner, but with reconcile-from-talk and the disputed
origin: spec-deferred 78f255fc65a4
source_spec: `spec-retire-dead-machinery.md`
location: src/lib/ingest.ts
severity: medium
reason: src/lib/ingest.ts parseDisputedMarker still sets the flag; src/components/ArticleView.tsx still renders the "This page is disputed" banner; the bundle intent explicitly directed deleting checkDisputedPages, so the surfacing gap is a knowing consequence to revisit with whatever story owns disputed-page semantics.
status: open
decision: 2026-08-16 Re-surface disputed pages — Give the flag a read model and a way out: a lint check or Workbench view listing disputed pages, and an owner action that clears the flag after review. Restores the loop that reconcile-from-talk used to close, without reviving talk.

### DW-77: authz.ts still carries the commons-realm delete-deny branch with no commons behind it; after this change the client delete gate no longer mirrors it for a hypothetical non-admin owner of a public page
origin: spec-deferred a067ea608790
source_spec: `spec-retire-dead-machinery.md`
location: src/lib/authz.ts:193
severity: low
reason: src/lib/authz.ts:193-198 denies body/delete on belongsInCommons pages for non-service, non-admin principals, pinned by authz.test.ts:228-231; DW-6's ledger explicitly kept delete authorization out of scope, so the server-side realm residue remains dead machinery.
status: open

### DW-78: HomeGraph.tsx had zero references already at the baseline revision — a pre-existing dead component, not orphaned by this story (unlike HomeAsk.tsx, which this story deleted).
origin: spec-deferred 05b39e1a7083
source_spec: `spec-retire-dead-machinery.md`
location: src/components/HomeGraph.tsx
severity: low
reason: git grep HomeGraph at baseline 1aac75ea returns no references outside the component file itself.
status: open

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
status: open

### DW-81: talk.ts getDiscussionStats is newly orphaned by this story — its last production callers were the deleted discussion lint checks — and reports green under talk.test.ts with no reachable caller; the ba
origin: spec-deferred 327d8597cfc7
source_spec: `spec-retire-dead-machinery.md`
location: src/lib/talk.ts:342
severity: low
reason: grep after this change shows no non-test caller of getDiscussionStats; talk.ts itself is intent-protected ("Do not delete src/lib/talk.ts"; AD-21 deliberately keeps talk machinery on disk), so whether to trim the export or leave it as deliberate AD-21 residue belongs to a story that owns talk.ts.
status: open

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
status: open

### DW-84: The edit and raw owner-scoped routes do not alias-forward merged-away slugs, so an old /u/<handle>/<slug>/edit bookmark 404s where the page-view URL now forwards.
origin: spec-deferred 7e750d1a36d0
source_spec: `spec-owner-scoped-linking.md`
location: src/app/u/[handle]/[slug]/edit/page.tsx
severity: low
reason: aliasRedirectForMissing is wired only into src/app/u/[handle]/[slug]/page.tsx; the edit and raw routes keep their pre-existing hard-404 miss behavior. Pre-existing asymmetry surfaced by this change; the intent names only the owner route's page-view miss path.
status: open

### DW-85: The owner route's "Page not found" UI is rendered as a normal HTTP 200 response instead of signalling notFound(), so dead slugs (including alias candidates that fail the forwarding guard) are indexabl
origin: spec-deferred 7952daea88ca
source_spec: `spec-owner-scoped-linking.md`
location: src/app/u/[handle]/[slug]/page.tsx:75
severity: low
reason: The miss branch of src/app/u/[handle]/[slug]/page.tsx returns JSX directly rather than calling next/navigation notFound(); pre-existing behavior that this change extends but did not introduce.
status: open

### DW-86: Converted components' rendered anchors have no executable coverage: reverting any one call site to slugPath (or dropping a slugTenants renderer prop) passes the whole suite, so the story's component-s
origin: spec-deferred 7eeab2ede4b6
source_spec: `spec-owner-scoped-linking.md`
location: vitest.config.ts
severity: medium
reason: vitest.config.ts runs node-only with include src/**/__tests__/**/*.test.ts (no .tsx), and package.json carries no jsdom or @testing-library dependency, so no test can render the six converted "use client" components; ChatWorkspace's saved-banner url fallback and VaultExplorer's owner-direct link are likewise unasserted. The hook's render contract is now pinned via react-dom/server, but per-component adoption above it is not. Surfaced by this story's review; the missing client-component harness pre-dates the story and adopting one is a project-level decision.
status: open

### DW-87: loadSlugTenants caches a non-OK response's empty map for the whole session (no retry) while a rejected fetch is retried, so one transient 401/429/500 from /api/wiki/routes pins DEFAULT_TENANT fallback
origin: spec-deferred e1b670ffa4b7
source_spec: `spec-owner-scoped-linking.md`
location: src/hooks/useSlugTenants.ts
severity: low
reason: In src/hooks/useSlugTenants.ts the non-OK branch's {} flows into the .then that assigns cache, so cache = {} permanently; the .catch path returns {} without assigning cache, so the next caller re-fetches. Byte-identical logic pre-dates this story (only renamed/exported here). Links still work via the 308 fallback, so the consequence is a session of wrong-handle hrefs, not breakage.
status: open

### DW-88: getAliasIndex caches only successful builds, so while any page file has malformed frontmatter every missing-slug request re-runs the full wiki scan behind aliasRedirectForMissing before failing closed
origin: spec-deferred 30b195a5eb4f
source_spec: `spec-owner-scoped-linking.md`
location: src/lib/alias-index.ts:107
severity: low
reason: buildAliasIndex sets cachedIndex only after a complete scan (src/lib/alias-index.ts:100) and getAliasIndex re-invokes it whenever cachedIndex is null, so a mid-loop parse throw leaves nothing cached and the next miss-path request re-scans. The cache-only-on-success behavior pre-dates this story; the owner route's miss path is merely its first routing caller, and the proper fix (failure caching or a cooldown) lives in alias-index.ts, which the intent walls off ("Never: Change resolveAlias / alias-index semantics"). Consequence is bounded: the scan is one readdir plus frontmatter parses, aborts at the corrupt file, and each failure is now logger.warn-visible.
status: open

### DW-89: SlugTenantMap lookups use plain inherited-prototype indexing, so a slug naming an Object.prototype member (a page titled "Constructor" slugifies to "constructor") resolves to the inherited function an
origin: spec-deferred 8c3a40745345
source_spec: `spec-owner-scoped-linking.md`
location: src/lib/links.ts:157
severity: low
reason: resolveSlugPath does slugTenants?.[slug] ?? fallbackTenant (src/lib/links.ts:157) and the map is parsed response JSON, whose objects inherit Object.prototype — map["constructor"] is a function, which ?? does not filter, so pagePath receives it and tenantSegment calls .trim() on a function (TypeError) wherever such a slug renders as a link. The lookup idiom is byte-identical to the pre-story hook and MarkdownRenderer paths; this story only spread the same map to more call sites. Requires a page slug colliding with an Object.prototype member, hence low.
status: open

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
status: open

### DW-92: workers/sandbox-runner/README.md H1 still reads "Yopedia sandbox runner" — stale display prose invisible to both brand scans.
origin: spec-deferred 25a5969a3d48
source_spec: `spec-maintainer-brand-sweep.md`
location: workers/sandbox-runner/README.md:1
severity: low
reason: DW-10 covers only "WorkWiki" strings. Workers markdown is scanned only by the new WorkWiki-only maintainer scan, and the yopedia-identifier test walks workers *.ts only, so this heading can never fail a test.
status: open

### DW-93: AGENTS.md's frozen-identifier list omits the WORKWIKI_* operator family.
origin: spec-deferred 082aa1c5ca08
source_spec: `spec-maintainer-brand-sweep.md`
location: AGENTS.md:12
severity: low
reason: AGENTS.md enumerates only yopedia/YOPEDIA_* identifiers as frozen. WORKWIKI_* env vars, .workwiki-source-sync.json, the workwiki-*.zip archive prefix, and the workwiki.app origin are equally load-bearing for existing operator setups, and a future brand sweep could "fix" them and silently break every operator's environment.
status: open

### DW-94: public/ served static copy (e.g. public/agent-api.md) is outside both brand scans.
origin: spec-deferred b6515946b4ea
source_spec: `spec-maintainer-brand-sweep.md`
location: public/agent-api.md
severity: low
reason: public/agent-api.md is served at the production origin and carries brand-adjacent strings (workwiki.app base URL, yopedia identifier examples), but neither scannedSources() nor maintainerSources() reads public/, so a stale display-brand regression there would ship unseen. Pre-existing coverage gap, not introduced by this change.
status: open

### DW-95: DW-91's recorded premise ("nothing references the doc's path") is now stale — the sweep's vacuity-guard test pins tools/WORKWIKI_SYNC.md by literal path.
origin: spec-deferred 153d65f75801
source_spec: `spec-maintainer-brand-sweep.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: The pin-by-name test in brand-copy.test.ts asserts maintainerSources() contains tools/WORKWIKI_SYNC.md, so the future filename cut DW-91 anticipates must also update that pin list. The failure would be loud and self-locating, but the ledger entry's "safe to rename, nothing references it" evidence no longer holds as written. Existing ledger entries are orchestrator-owned, so this is recorded here instead of amending DW-91.
status: open

### DW-96: Maintainer-facing surfaces outside the four scan roots remain unscanned: scripts/, journal-site/, and .opencode/commands/*.md.
origin: spec-deferred 7d14595dc7b0
source_spec: `spec-maintainer-brand-sweep.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: maintainerSources() covers tools/, root markdown, docs/ markdown, and workers/ markdown per the bundle intent. scripts/*.sh|*.mjs, journal-site/*.mjs, and .opencode/commands markdown are the same class of maintainer tooling and are clean today (repo-wide grep), but a "WorkWiki" reintroduced there would be invisible to every test — same class of gap as the public/ item already ledgered from this spec.
status: open

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
status: open

### DW-99: The worker's supported-attachment allowlist has drifted from the app's document extractor, so formats the app can read are rejected at the email door.
origin: spec-deferred e07612517bf9
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:42-73
severity: medium
reason: `workers/email-ingest/index.ts:42-68` omits `odt`, `ods`, `odp`, `epub`, `org`, `rtf`, `mobi` and `text/x-markdown`, all of which `src/lib/document-extract.ts:7-64` supports — so those emailed files draw a "not supported" reply even though ingestion would have worked. The worker also matches `mimeType.toLowerCase()` whole, while `detectDocumentFormat` strips `;` parameters first, so a `text/csv; charset=utf-8` part matches only via its extension. Nothing pins the two lists in agreement, and deleting the worker's filter at `index.ts:193-195` outright leaves the suite green.
status: open

### DW-100: The `attachmentName` FormData fields the worker sends are unobserved, so names of unsupported attachments can vanish from ingest job metadata undetected.
origin: spec-deferred 92d4586ec775
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:225
severity: medium
reason: `workers/email-ingest/index.ts:225` appends every attachment name (supported or not); `src/app/api/email/ingest/route.ts:58-60` reads them back and persists them into the job's `email` metadata. Demonstrated: deleting the append loop leaves the full suite green. The route's union of names only recovers the *supported* files' names, so anything filtered out at `index.ts:193-195` is lost with nothing failing. The new worker test already parses the outgoing FormData but reads only `getAll("attachments")`.
status: open

### DW-101: Only the ArrayBuffer branch of the worker's attachment-content normalization is exercised — including, ironically, not the branch the defensive copy exists for.
origin: spec-deferred 0da5a9e0e5df
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:228-238
severity: low
reason: `workers/email-ingest/index.ts:228-238` has three branches: string content via `TextEncoder`, `ArrayBuffer`, and a typed-array view reconstructed from `.buffer/.byteOffset/.byteLength`. Probing the installed `postal-mime@2.7.5` with a base64 part yields an `ArrayBuffer`, so only `index.ts:230-231` runs. The view branch carries the byteOffset arithmetic most prone to silent corruption, and the copy's own comment names the SharedArrayBuffer view as its reason for existing.
status: open

### DW-102: Multi-attachment behaviour is unobserved — the 10-attachment cap, per-index filename/bytes pairing, and both fallbacks are untested.
origin: spec-deferred 376e7071da0f
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:193-246
severity: low
reason: The fixture carries exactly one named attachment with an explicit mimeType, so `.slice(0, 10)` (`index.ts:195`), the `attachment-${index + 1}` filename fallback (`index.ts:227`) and the `"application/octet-stream"` mimeType fallback (`index.ts:243`) never run. Demonstrated: narrowing the cap to `.slice(0, 1)` leaves the full suite green — a regression that forwards only the first of ten attached documents, or pairs attachment i's bytes with attachment j's filename (and therefore the wrong extractor at `route.ts:237-239`), would ship undetected. The `10` also duplicates the route's `MAX_EMAIL_DOCUMENTS` with nothing pinning them in agreement.
status: open

### DW-103: The acknowledgement copy a sender receives about their attachments is unpinned.
origin: spec-deferred 929e58770d4a
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:287-292
severity: low
reason: `workers/email-ingest/index.ts:287-292` builds the "N supported attachment(s) were queued" and "N unsupported attachment(s) were recorded but skipped" lines, including their singular/plural branches. Demonstrated: blanking those lines leaves the full suite green. The two existing tests assert on reply text but drive a no-attachment fixture; the new test drives an attachment fixture but reads only the outgoing request.
status: open

### DW-104: Base64 expansion makes the route's 10 MB per-document limit unreachable via email, and neither cap is tested against the other.
origin: spec-deferred 4fa3442f8443
source_spec: `spec-email-ingest-attachment-test.md`
location: workers/email-ingest/index.ts:39
severity: low
reason: The worker rejects on `message.rawSize > MAX_RAW_EMAIL_BYTES` (10 MB, `index.ts:39/147`) — a raw-message measurement taken *before* MIME decoding. Base64 inflates payloads by roughly a third, so the effective per-attachment ceiling over email is about 7.5 MB, while `MAX_DOCUMENT_SIZE` in `src/lib/constants.ts` is 10 MB. The gap is undocumented and untested in both directions.
status: open

### DW-105: The shared dialog hook `useDialogA11y` — the richest DOM-only behaviour in reach — still has no mounted coverage.
origin: spec-deferred 1fd2c04cc42e
source_spec: `spec-dom-test-environment.md`
location: src/hooks/useDialogA11y.ts
severity: medium
reason: Esc dismissal, the deliberate "an open <select> eats its own Esc" carve-out, Tab trapping and pull-back, the `document.body.style.overflow` lock/restore, and the `fallbackFocusRef` path (whose own comment names the case: confirming Create Wiki unmounts the button that opened it) are all invisible to a source scan and all still pinned only by `create-wiki-ui.test.ts`'s greps. The DOM environment this pass established is what makes them testable.
status: open

### DW-106: WikiWorkbench's other write paths have no mounted coverage — switchWiki's rollback and re-entry guard, the degraded `unavailable` render, and create()'s failure branch.
origin: spec-deferred 684689c6d8cd
source_spec: `spec-dom-test-environment.md`
location: src/components/WikiWorkbench.tsx:108
severity: medium
reason: `switchWiki` exists because overlapping PUTs settle out of order and roll the selection back to a stale id; the `unavailable` branch must NOT show "No wiki yet." or a Create button; the `!wiki?.id` guard's comment says the alternative is "a blank page rather than the error message"; and `create()`'s catch has no equivalent of the template flow's "keeps the dialog open and shows the failure inside it". None of these are observable from a source scan, and this pass covered only the confirm gate the bundle intent named.
status: open

### DW-107: Nothing pins the `busy` gate on either dialog, so a double-submit would issue two destructive writes with the suite green.
origin: spec-deferred d8fb9fb38bc8
source_spec: `spec-dom-test-environment.md`
location: src/components/ConfirmDialog.tsx:93
severity: medium
reason: No test clicks `Overwrite` or `Create` twice before the first request settles. Dropping `disabled={busy}` from `ConfirmDialog` would double-apply a template overwrite; the labels ("Working…", "Creating…") and the mid-flight refusal of Cancel/Esc are likewise unasserted.
status: open

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
status: open

### DW-110: The two polling suites have no mounted case for a rejecting fetch, a malformed body, or a wedged (never-settling) probe.
origin: spec-deferred 71d48dcc2b92
source_spec: `spec-dom-test-environment.md`
location: src/components/workbench/__tests__/data-version-watcher.test.tsx
severity: low
reason: `data-version-watcher.test.tsx` covers `ok: false` but not a transport failure or `{ dataVersion: "4" }`; `useSidecarStatus.test.tsx` covers a rejection but not a non-2xx answer or the `SIDECAR_PROBE_TIMEOUT_MS` race. The pure halves are executed by the node suite, so this is about the effect's handling of them, not the parsing.
status: open

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

### DW-114: Follow-up review still recommended for dw-dom-test-environment after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dom-test-environment.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open
