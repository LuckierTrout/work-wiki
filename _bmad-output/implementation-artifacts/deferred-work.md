### DW-1: The CLI still exposes a publish-to-commons command after the REST route and the MCP tool were retired.
origin: spec-deferred 592955d7b1dc
location: src/cli.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/cli.ts` keeps `publish <slug> --agent <id>` calling `publishToCommons` (`src/lib/publish.ts`), and `src/lib/__tests__/cli.test.ts` still asserts the promotion end to end. The intent names routes and the MCP tool list, not the owner-local CLI, so it was left alone; it now writes into an index nothing reads.
status: open

### DW-2: slugPath() addresses every slug-only link through the default tenant, so the URL names the wrong handle until the owner route redirects it.
origin: spec-deferred fe2df3ceb0dd
location: src/lib/links.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `slugPath()` hard-codes `DEFAULT_TENANT` and leans on the 308 in `src/app/u/[handle]/[slug]/page.tsx`. Call sites such as RecentIngests, VaultExplorer, ChatWorkspace, ActionInbox, BulkDocumentImport and KnowledgeStudio already hold (or can fetch) the real owner, so each of those links costs a redirect hop and shows a misleading handle in the address bar and in link previews.
status: open

### DW-3: Alias forwarding for merged or renamed slugs disappeared with the retired commons URL and was never rebuilt on the owner-scoped URL.
origin: spec-deferred 162f1930cc8c
location: src/lib/page-redirect.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `commonsRedirectForMissing` resolved an absorbed slug to its survivor and 308'd to `/wiki/<canonical>`; it now returns null unconditionally. Its only caller was the retired page, so nothing regressed at that URL — but a wikilink to a merged-away slug now resolves through `slugPath()` to `/u/<tenant>/<old-slug>`, which 404s. `resolveAlias` has no routing caller.
status: open

### DW-4: The zh-CN translation catalog has stale keys and still spells the old brand.
origin: spec-deferred ee84aaa25ba2
location: src/lib/i18n.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: medium
reason: `src/lib/i18n.ts` keys on exact English source strings, so the renamed chrome labels ("The commons", "What is WorkWiki", "Browse all") no longer match and silently fall back to English; keys for deleted UI (Browse, Join waitlist, Contributors, Mobile navigation) are now unreachable; and line 43 still ships "WorkWiki" as rendered copy. The spec forbids i18n work in this story, and the recorded user preference is English-only, so the whole module is a later cut.
status: open

### DW-5: Reconcile-from-talk plumbing and the discussion lint checks outlive the talk surface they point at.
origin: spec-deferred af264a332ec0
location: src/lib/reconcile.ts, src/lib/lint-checks.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/api/tasks/run` still dispatches `reconcile`/`maintain:reconcile` through `reconcileFromTalk`, the `reconcile_page` MCP tool remains, and `checkUnresolvedDiscussions` / `checkDisputedPages` still emit warnings whose remediation surface now 404s. Harmless while no surface can create a thread, but it is dead machinery.
status: open

### DW-6: ArticleActions still branches on the commons realm.
origin: spec-deferred 5bb7128d058f
location: src/components/ArticleActions.tsx
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/components/ArticleActions.tsx` keeps `isCommonsPage` gating for Delete and "Save to vault", and `ArticleView` computes and threads the flag purely to feed it. Changing delete authorization was out of this story's scope, so the realm model survives with no commons behind it.
status: open

### DW-7: canWritePage's commons-realm rule lost its escape hatch when talk was retired.
origin: spec-deferred 51476f69db15
location: src/lib/authz.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/lib/authz.ts` still denies `body` and `delete` writes on any public non-agent page to non-admin principals, justified in-comment by humans steering through metadata patches and talk threads. The edit page's copy is now a bare "You don't have write access to this page" with nowhere to go.
status: open

### DW-8: The contributor capability is retired at every page and REST surface but still ships as two MCP tools.
origin: spec-deferred b763192224b5
location: src/lib/mcp-http.ts
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `/wiki/contributors`, `/api/contributors` and `/api/contributors/[handle]` all 404, and `/u/<handle>` is gone — but `list_contributors` and `get_contributor` remain registered in `src/lib/mcp-http.ts` and `mcp.json`, and `mcp-http.test.ts` was updated to keep them passing. They are read-only and bearer-gated, so nothing leaks in a single-owner deployment; whether the capability should survive at MCP after being cut everywhere else is a product call, not a defect.
status: open

### DW-9: Middleware still exempts the retired publish route as an in-route-auth path.
origin: spec-deferred 049dafc8e212
location: src/middleware.ts:73
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `src/middleware.ts` keeps `AGENT_PUBLISH_RE` and documents `/api/agents/<id>/publish` as "the agent's own per-agent token" in its header comment, though the handler is now `retiredRoute()` and inspects nothing. Harmless (the request 404s), but the exemption cannot be removed here: `middleware-write-gate.test.ts:39` pins it, and this story's constraints forbid changing that suite's behavior.
status: open

### DW-10: Maintainer-facing files still carry the old brand after the display rename.
origin: spec-deferred 4087d7d02acb
location: tools/workwiki-sync.mjs
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
severity: low
reason: `tools/workwiki-sync.mjs`, `tools/WORKWIKI_SYNC.md`, `BACKLOG.md`, `docs/llm-wiki-functional-parity-roadmap.md` and `workers/sandbox-runner/README.md` still say "WorkWiki". None of it is rendered product copy — the intent's rename targets user-visible surfaces — and one of them is a filename, so renaming is a separate, wider cut.
status: open

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
status: open

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

### DW-15: The repository has no DOM test environment, so the confirm gate and "Cancel writes nothing" are pinned only by scans of component source text.
origin: spec-deferred 2b4928bd0582
location: vitest.config.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `vitest.config.ts` is `environment: "node"` with `include: ["src/**/__tests__/**/*.test.ts"]`, and `@testing-library/*` is not a dependency — across ~230 test files the only component tests render to a string with `renderToStaticMarkup`. `create-wiki-ui.test.ts` follows the established `single-ia.test.ts` fallback and greps the source, so rewiring `onConfirm` to call `applyTemplate()` without the dialog would leave every assertion passing. Establishing jsdom + testing-library is a repo-wide infrastructure change that predates this story; this story is simply the first to add a substantial interactive surface on top of the gap.
status: open

### DW-16: `purpose.md` is written at create time but no runtime path reads it.
origin: spec-deferred 0335bb4045db
location: src/lib/wikis.ts
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: A grep of `src/` finds no consumer of the seeded `purpose.md`; only `schema.md` became executable, via `loadPageConventions()`. The template's purpose text does reach prompts through the workspace profile, so nothing is lost today, but PRD FR-76 lists `purpose.md` in the file-tree contract and prd.md:558/564 puts it in the Chat system-prompt allocation. Story 1.4 (trees) and Epic 3 (Chat) are where the file itself acquires readers.
status: open

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

### DW-19: `loadPageConventions()` resolves the active Wiki deployment-globally from `NEXT_PUBLIC_OWNER_HANDLE`, while the guidance beside it at the same prompt sites resolves per-caller.
origin: spec-deferred 54c8fcb81384
location: src/lib/wikis.ts:398
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
severity: medium
reason: `readActiveWikiSchema()` calls `getOwnerHandle()`, the only place in the repo where that value becomes a storage key — every other tenant-scoped read/write (`workspace-profile.ts`, `research-projects.ts`, `portable-archive.ts`) takes a passed-in owner. At `ingest.ts:1165/1239/ 1511`, `query.ts:226`, `agent-runtime.ts:154` and `source-monitors.ts:386` the no-argument `loadPageConventions()` sits directly beside `buildWorkspaceGuidance(owner)`, whose `owner` can be `"system"`, an agent handle, or a monitor's owner. So a non-site-owner caller now gets the site owner's Scenario Template conventions where it previously got the generic root `SCHEMA.md`. The spec's Code Map sanctions `getOwnerHandle()` as "how a server-side helper with no owner argument resolves the single-owner tenant", and `isOwnerHandle()` already makes handle equality the repo's owner-trust model, so this is correct for the single-owner deployment shipping today. Threading a tenant into the loader is the real fix and it b
status: open

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
status: open

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

### DW-28: `HomeDashboard` is no longer mounted by any route, and the test that pinned it as the landing page's `<h1>` owner now guards a component that does not ship.
origin: spec-deferred 8594e9c2456b
location: src/components/HomeDashboard.tsx
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
severity: low
reason: `src/app/page.tsx` no longer renders `<HomeDashboard>`, but `src/components/HomeDashboard.tsx` and `src/lib/home-dashboard.ts` stay on disk because `create-wiki-ui.test.ts:199-204` reads the component file and asserts it contains an `<h1>`, and `home-dashboard.test.ts` exercises `buildHomeDashboardSnapshot`. Deleting either file would modify a pre-existing test, which this story was forbidden to do. So three test files now report green on a surface nothing renders. Retiring the dashboard properly — deleting the modules and retargeting that assertion at the shell's `<h1>` — belongs with whatever cleans up the remaining pre-Workbench surfaces.
status: open

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

### DW-31: The Files tab shows `purpose.md` and `schema.md` at the tree root, so the path the Preview strip prints for them is not the path that addresses their bytes.
origin: spec-deferred 5bb2e2fd9c76
location: src/lib/workbench-files.ts, src/components/workbench/PreviewColumn.tsx
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
severity: medium
reason: The I/O matrix fixes those two artifacts at the root of the file tree, but they physically live at `tenants/<t>/wikis/<id>/<file>` (`wikiArtifactPath`). `listWorkbenchFilePaths` emits them as bare names, and `PreviewColumn` prints the selection path verbatim, so a reader is shown `purpose.md` where storage holds a three-segment key. Nothing reads the printed path in this story, but Story 1.5 has to fetch bytes from a selection — it will need either a real storage path on the node or a resolver that maps root artifacts back to `wikiArtifactPath`.
status: open

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

### DW-47: The tree's scroll effects re-run on tab and collapse only, so crossing the 899px force-show boundary by RESIZING is missed.
origin: spec-deferred 960bd3db4d29
location: src/components/workbench/TreePanel.tsx (the two scroll effects)
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
severity: low
reason: `treeScrollActive` correctly asks the element rather than the collapse flag, because `@media (max-width: 899px)` force-shows a collapsed column. But both effects are keyed `[tab, collapsed]`, and neither changes when the viewport crosses 900px mid-session — so an owner who is collapsed and narrows the window gets a fully visible, scrollable tree whose offset is neither restored nor recorded until they next switch tabs. A load at that width is fine; only the live transition is missed. Closing it needs a `matchMedia("(max-width: 899px)")` listener in `TreePanel`, which is a second copy of a breakpoint this story deliberately keeps in the stylesheet (and which `workbench-split.test.ts` bans by name). Whether that trade is worth making belongs with whichever story revisits the left column's responsive behaviour.
status: open

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
status: open

### DW-53: A page another actor deletes now disappears from the trees mid-session while the docked selection survives, leaving no row marked current.
origin: spec-deferred a8eec345e2bd
location: src/components/workbench/Workbench.tsx (the selection reset effect), src/lib/workbench-tree.ts (selectionExists)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: low
reason: Before this story the trees only changed under a `WikiSwitcher` refresh, which also changes `currentWikiId` and so re-runs the selection reset at `Workbench.tsx:194-203`; `restorableSelection` / `selectionExists` are reached only from the `[]` mount effect (`:173`). A watcher-driven refresh changes neither, so the selection outlives the row: the Preview stays docked showing `PREVIEW_FAILED_COPY` (truthful) while no tree row carries `aria-current` — the state Story 1.6's `selectionExists` docblock names as "a shell that looks broken rather than one that forgot". Reconciling a live selection against a refreshed tree is a design decision (does the shell silently undock, fall back to the sibling row, or say something?) and the last of those needs a sentence from the epic's Copy table, so it belongs with whichever story next opens it.
status: open

### DW-54: A silent refresh cannot tell "another actor deleted this page" from "the network blipped", so a transient failure replaces the page the owner is reading with the failure copy and does not heal itself.
origin: spec-deferred de2abf5767d2
location: src/lib/workbench-preview.ts (fetchPreview, previewBodyState), src/components/workbench/PreviewColumn.tsx (the fetch effect's response handler)
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
severity: medium
reason: `fetchPreview` (`workbench-preview.ts:344-364`) collapses 404, 500, a malformed body, the `REQUEST_TIMEOUT_MS` deadline and a bare transport failure into one `{ status: "failed" }`, and `previewBodyState` (`workbench-preview.ts:152-155`) puts `failed` AHEAD of a payload that is still held. Before this story the flag could only be set right after an explicit pick, behind a `Loading…` the owner had just caused. A silent same-row refresh sets it with `plan.reset === false`, so a page jumps straight from rendered bytes to `PREVIEW_FAILED_COPY` for a reason the owner did not initiate — and because the effect re-runs only on `[selection, dataVersion, editing]`, it stays that way until the next bump or until they click elsewhere and back. The spec's rule ("a failed silent refresh still tells the truth, because a page another actor just deleted must not keep rendering as if it were there") is right about deletion and is what makes the conflation visible; separating "gone" from "could not reach
status: open

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

### DW-59: An overwritten Schema has no recovery path — the artifact write takes no revision snapshot, while the page write it is modelled on does.
origin: spec-deferred 3d268db29649
location: src/lib/wikis.ts (writeWikiArtifact / putWikiArtifact), src/lib/revisions.ts
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: `writeWikiPageWithSideEffects` calls `saveRevision(slug, existing, …)` (`src/lib/wiki.ts:442`) before it overwrites, and `GET/POST /api/wiki/[slug]/revisions` can revert a page. `writeWikiArtifact` writes through `putWikiArtifact` with no prior read and no snapshot, so the previous `schema.md` is simply gone. That was harmless while the file was seed-only and immutable; it is not once the file is editable, and this is the single file every ingest, chat and lint prompt reads. The story's Design Notes deliberately enumerate the artifact tail as log + bump, so this is a decided omission rather than a missed one — but revisioning is not an index/backlink concern the artifact class lacks, it is the recovery path, and closing it needs a decision about where artifact revisions live (the `revisions/` silo is slug-keyed) that this story does not own.
status: open

### DW-60: Follow-up review still recommended for 1-8-edit-schema after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-8-edit-schema.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260815-022700-cd29; this entry preserves the lingering recommendation for a deliberate later review.
status: open
