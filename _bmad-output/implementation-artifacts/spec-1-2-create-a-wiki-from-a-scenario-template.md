---
title: 'Story 1.2: Create a Wiki from a Scenario Template'
type: 'feature'
created: '2026-08-15'
status: 'done'
baseline_revision: 'a7590087cdd002bcf78ad985f73427ce87a7fcb0'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Creating or re-templating a Wiki overwrites the tenant-global workspace
      profile, including one the owner hand-authored in Settings.
    evidence: |-
      `seedWikiArtifacts()` calls `saveWorkspaceProfile(owner, templateProfile(...))`,
      which is what makes a seeded template reach the seven prompt sites that
      consume `buildWorkspaceGuidance(owner)`. The profile is a per-tenant
      singleton at `tenants/<t>/workspace-profile.json`, so a Wiki create
      silently replaces whatever the owner wrote on the Workspace Purpose
      settings form. Both dialogs say "purpose.md and Schema", which is true in
      substance (the profile is the machine form of purpose) but does not name
      the Settings surface the owner will see change. The inverse also holds: a
      Settings edit does not update the Wiki's `schema.md`, so the two diverge.
      Reconciling the two representations belongs with Story 1.8 (Edit Schema),
      which owns editing both.
    location: >-
      src/lib/wikis.ts
    severity: medium
  - summary: >-
      The repository has no DOM test environment, so the confirm gate and
      "Cancel writes nothing" are pinned only by scans of component source text.
    evidence: |-
      `vitest.config.ts` is `environment: "node"` with
      `include: ["src/**/__tests__/**/*.test.ts"]`, and `@testing-library/*` is
      not a dependency — across ~230 test files the only component tests render
      to a string with `renderToStaticMarkup`. `create-wiki-ui.test.ts` follows
      the established `single-ia.test.ts` fallback and greps the source, so
      rewiring `onConfirm` to call `applyTemplate()` without the dialog would
      leave every assertion passing. Establishing jsdom + testing-library is a
      repo-wide infrastructure change that predates this story; this story is
      simply the first to add a substantial interactive surface on top of the
      gap.
    location: >-
      vitest.config.ts
    severity: medium
  - summary: >-
      `purpose.md` is written at create time but no runtime path reads it.
    evidence: |-
      A grep of `src/` finds no consumer of the seeded `purpose.md`; only
      `schema.md` became executable, via `loadPageConventions()`. The template's
      purpose text does reach prompts through the workspace profile, so nothing
      is lost today, but PRD FR-76 lists `purpose.md` in the file-tree contract
      and prd.md:558/564 puts it in the Chat system-prompt allocation. Story 1.4
      (trees) and Epic 3 (Chat) are where the file itself acquires readers.
    location: >-
      src/lib/wikis.ts
    severity: medium
  - summary: >-
      Wiki artifacts sit at `tenants/<t>/wikis/<id>/`, not at the project root
      beside `wiki/` and `raw/sources/` as FR-76's file contract describes.
    evidence: |-
      The location was chosen so `reconcileSilos()` (`src/lib/silo.ts:230-265`)
      cannot delete the seeded files as unindexed orphans, and Story 1.2 does not
      partition Pages or Sources per Wiki. The consequence is that
      `/api/v1/projects` (Epic 8, FR-76) has no `path` to report and
      `files?root=all` cannot yet return `purpose.md`, `schema.md`, `wiki/` and
      `raw/sources/` from one root. Reopening this requires the per-Wiki Page
      partitioning that Story 1.4's "the trees show that Wiki's files" implies.
    location: >-
      src/lib/wikis.ts
    severity: medium
  - summary: >-
      A Wiki can be created and re-templated but never deleted or renamed, and
      artifact directories are never cleaned up.
    evidence: |-
      `wikis.ts` exposes create/apply/set-current only. The name is baked into
      the `# <name>` heading of `purpose.md` at seed time, so a typo is
      permanent, and an entry dropped by `normalizeRegistry` leaves its
      `wikis/<id>/purpose.md` and `schema.md` on disk with nothing referencing
      them. Story 1.2's acceptance criteria ask for neither operation.
    location: >-
      src/lib/wikis.ts
    severity: low
  - summary: >-
      `loadPageConventions()` resolves the active Wiki deployment-globally from
      `NEXT_PUBLIC_OWNER_HANDLE`, while the guidance beside it at the same
      prompt sites resolves per-caller.
    evidence: |-
      `readActiveWikiSchema()` calls `getOwnerHandle()`, the only place in the
      repo where that value becomes a storage key — every other tenant-scoped
      read/write (`workspace-profile.ts`, `research-projects.ts`,
      `portable-archive.ts`) takes a passed-in owner. At `ingest.ts:1165/1239/
      1511`, `query.ts:226`, `agent-runtime.ts:154` and `source-monitors.ts:386`
      the no-argument `loadPageConventions()` sits directly beside
      `buildWorkspaceGuidance(owner)`, whose `owner` can be `"system"`, an agent
      handle, or a monitor's owner. So a non-site-owner caller now gets the site
      owner's Scenario Template conventions where it previously got the generic
      root `SCHEMA.md`. The spec's Code Map sanctions `getOwnerHandle()` as "how
      a server-side helper with no owner argument resolves the single-owner
      tenant", and `isOwnerHandle()` already makes handle equality the repo's
      owner-trust model, so this is correct for the single-owner deployment
      shipping today. Threading a tenant into the loader is the real fix and it
      belongs with whatever reintroduces multi-tenant prompts.
    location: >-
      src/lib/wikis.ts:398
    severity: medium
  - summary: >-
      Create and re-template are not atomic across the two artifact writes, the
      profile write, and the registry write.
    evidence: |-
      `createWiki` runs `seedWikiArtifacts()` (purpose.md → schema.md →
      `saveWorkspaceProfile`) before `writeRegistry`, with no rollback. A
      failure part-way leaves `wikis/<id>/` on disk with no registry entry and
      a tenant profile already switched to the new template; in
      `applyScenarioTemplate` it can leave purpose.md from one template beside
      schema.md from another. The storage provider exposes no transaction, and
      `research-projects.ts` — the registry idiom the spec directs this module
      to mirror — has the same property, so this is an inherited architectural
      limit rather than a defect in this change. Closing it means a write-ahead
      or compensating-write facility in the storage layer.
    location: >-
      src/lib/wikis.ts
    severity: medium
  - summary: >-
      Switching the active Wiki rewrites the tenant-global workspace profile
      with no confirm at all, unlike the template overwrite it is equivalent to.
    evidence: |-
      `setCurrentWiki` calls `saveWorkspaceProfile(owner, templateProfile(...))`
      — added deliberately so `loadPageConventions()` and
      `buildWorkspaceGuidance()` cannot name two different templates at once.
      The consequence is that the bare `<select>` in `WikiWorkbench` is a
      destructive write on the same tenant singleton that `Change template`
      guards behind `ConfirmDialog`. Gating a switch is not in this story's
      acceptance criteria, and the durable fix is the same reconciliation of the
      per-Wiki and tenant-global representations that Story 1.8 (Edit Schema)
      owns.
    location: >-
      src/lib/wikis.ts
    severity: medium
  - summary: >-
      The `wikis:<tenant>` lock does not serialize against the
      `workspace-profile:<tenant>` lock it writes through.
    evidence: |-
      `withFileLock("wikis:<tenant>", …)` wraps `saveWorkspaceProfile`, which
      takes `withFileLock("workspace-profile:<tenant>", …)` — a different key.
      A concurrent save from the Workspace Purpose settings form can therefore
      interleave, leaving `schema.md` naming one template and the profile
      another. Reachable only from one owner acting in two places at once on a
      single-owner deployment, and the obvious fix (nesting the two locks)
      introduces a lock-ordering hazard with any future caller that takes them
      the other way round.
    location: >-
      src/lib/wikis.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** There is no Wiki entity in the app. A "wiki" today is an implicit per-owner tenant string derived from the owner handle, there is no name, no id, no active-Wiki pointer, and no `purpose.md` or per-Wiki `schema.md` anywhere on disk. The five Scenario Templates already exist as data (`WORKSPACE_SCENARIO_TEMPLATES`) but can only be loaded as an unsaved draft into a Settings form, so a fresh install starts as a blank vault with nothing steering Ingest, Chat, or Lint — and Stories 1.4, 1.5 and 1.8 have no seeded content to render.

**Approach:** Introduce a named Wiki record (UUID id, name, scenario, timestamps) in a per-tenant registry with a `current` pointer, and a Create Wiki flow that requires picking exactly one of Research, Reading, Personal Growth, Business, General. Creating seeds two markdown artifacts for that Wiki — `purpose.md` and `schema.md` — rendered from the existing template data so their contents genuinely differ per template, and persists the matching workspace profile so the seeded guidance actually reaches the prompt path. Applying a different template later is confirm-gated and rewrites purpose/Schema only. `loadPageConventions()` gains a seam so the active Wiki's `schema.md` is what actually executes, with the repo-root `SCHEMA.md` as fallback.

## Boundaries & Constraints

**Always:**
- Scenario template text has exactly one source: `WORKSPACE_SCENARIO_TEMPLATES` in `src/lib/workspace-profile-schema.ts`. Render `purpose.md`/`schema.md` from it; never re-author template prose in a new file (AD-10: no forked copy of conventions in code).
- Exactly five choices, no blank/custom option. The `custom` scenario must be rejected by the create/apply input parser and must not appear in the picker (FR-38, UX-DR19).
- The five labels are `Research`, `Reading`, `Personal Growth`, `Business`, `General`, in that order, and come from one exported label map.
- Runtime identifiers stay `yopedia` (AD-7): `DEFAULT_TENANT`, `BASE_AGENT_OWNER`, `YOPEDIA_*` env/bindings, `X-Yopedia-*` headers, every `wrangler.jsonc` resource name. Rendered copy says `work-wiki`.
- Wiki artifacts live at `tenants/<tenant>/wikis.json` and `tenants/<tenant>/wikis/<wikiId>/{purpose.md,schema.md}` through `getStorage()` (AD-2). They must NOT be written under `tenants/<tenant>/wiki/` — `reconcileSilos()` (`src/lib/silo.ts:230-265`) deletes any `.md` there that is not in the page index.
- Every registry mutation runs inside `withFileLock("wikis:<tenant>", …)`, mirroring `src/lib/research-projects.ts`.
- Route handlers follow the house shape: `getPrincipal()` → 401 `{ error: "Sign in required." }`; `isReadOnly()` → 403; bad input → 400 `{ error }` via `ClientInputError`/`getErrorMessage`.
- Any Page create/update/delete still goes through `writeWikiPageWithSideEffects`/`deleteWikiPage` (AD-3). This story writes no Pages.
- Cancel writes nothing — no registry entry, no file, no profile change, no partial state.
- Applying a template overwrites `purpose.md`, `schema.md`, and the workspace profile only. It never touches `tenants/<t>/wiki/**`, `tenants/<t>/raw/**`, the page index, or the log.
- Accessibility: the dialog is `role="dialog" aria-modal="true"` with `aria-labelledby`, Esc closes exactly one overlay, every input has a real `<label>` (placeholder is not a label), one primary button per cluster.

**Block If:**
- A required change would force `buildWorkspaceGuidance(owner)` to change signature across its seven prompt call sites. It must keep taking `owner: string`.

**Never:**
- Do not partition Pages or Sources per Wiki, and do not move anything out of `tenants/<t>/wiki/` or `tenants/<t>/raw/`. Page-level multi-Wiki isolation is not in this story.
- Do not build the icon rail, the left-column tree, the Wiki switcher in the tree header, real Preview rendering, drag-resize, or the `dataVersion` counter — Stories 1.3, 1.4, 1.5, 1.6, 1.7.
- Do not build Schema *editing* UI — Story 1.8. This story only seeds and overwrites via template.
- Do not call an LLM anywhere in this story.
- Do not touch `loadPageTemplates()` or the repo-root `SCHEMA.md` content; page templates are a different concept from Scenario Templates.
- Do not add `@testing-library/*`, jsdom, or `.test.tsx` support.
- Do not un-retire anything in `src/lib/retired.ts`, and do not delete or move `src/app/wiki/new/page.tsx` (pinned by `src/lib/__tests__/single-ia.test.ts:74`).
- No i18n work; English only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create a Wiki | `POST /api/wikis` `{ name: "Q3 planning", scenario: "business" }`, owner session | 201 `{ wiki }`; registry gains the record and sets `currentId`; `purpose.md` + `schema.md` written under `wikis/<id>/`; workspace profile saved as `business` | No error expected |
| Contents differ by template | Two Wikis created with `business` and `reading` | Both `purpose.md` pairs and both `schema.md` pairs differ | No error expected |
| Blank Wiki refused | `POST /api/wikis` `{ name: "x", scenario: "custom" }` (or missing/unknown scenario) | 400 `{ error }`; nothing written | `ClientInputError` → 400 |
| Empty name | `POST /api/wikis` `{ name: "   ", scenario: "general" }` | 400 `{ error }`; nothing written | `ClientInputError` → 400 |
| Unauthenticated create | `POST /api/wikis`, no Clerk session | 401 `{ error: "Sign in required." }`; nothing written | No error expected |
| Read-only deployment | `POST /api/wikis` with `YOPEDIA_READONLY=1` | 403 `{ error }`; nothing written | No error expected |
| Apply a different template | `POST /api/wikis/<id>/template` `{ scenario: "reading" }` on a `business` Wiki | 200 `{ wiki }`; `purpose.md`/`schema.md`/profile rewritten to `reading`; Pages and Sources byte-identical | No error expected |
| Apply to unknown Wiki | `POST /api/wikis/<unknown>/template` | 404 `{ error }`; nothing written | No error expected |
| Executable Schema | `loadPageConventions()` with a current Wiki whose `schema.md` has `## Page conventions` | Returns that Wiki's conventions, not the repo-root ones | Read failure → falls back to root `SCHEMA.md` |
| No Wiki yet | `loadPageConventions()` with an empty registry | Returns the repo-root `SCHEMA.md` conventions, unchanged from today | Missing file → `""` |
| Set active Wiki | `PUT /api/wikis/current` `{ id }` | 200; `currentId` persisted; 404 for an unknown id | No error expected |

</intent-contract>

## Code Map

**Reuse as-is (do not fork):**
- `src/lib/workspace-profile-schema.ts:1` `WORKSPACE_SCENARIOS`, `:12` `WorkspaceProfileInput`, `:22` `WorkspaceScenarioTemplate`, `:32` `WORKSPACE_SCENARIO_TEMPLATES` (the five templates, each with `name`/`description`/`purpose`/`keyQuestions`/`inScope`/`outOfScope`/`outputLanguage`/`pageConventions`), `:160` `parseWorkspaceProfileInput` — pure and client-safe, so the dialog may import it.
- `src/lib/workspace-profile.ts:26` `profilePath` (path pattern), `:66` `saveWorkspaceProfile(owner, input)`, `:85` `renderWorkspaceGuidance`, `:106` `buildWorkspaceGuidance(owner)` — the latter is consumed by `ingest.ts:32`, `query.ts:27`, `chat.ts:22`, `agent-runtime.ts:22`, `structured-knowledge.ts:22`, `action-extractor.ts:11`, `source-monitors.ts:10`. Signature is frozen.
- `src/lib/research-projects.ts:58-64,124-156,238` — the exact registry idiom to copy: `tenants/<tenant>/<name>.json`, `lockKey`, `crypto.randomUUID()`, ENOENT → empty, `MAX_*` cap.
- `src/lib/wiki.ts:83` `validateTenant`, `:105` `tenantForOwner`; `src/lib/links.ts:64` `DEFAULT_TENANT` (must stay `"yopedia"`), `:80` `ownerToTenant`.
- `src/lib/storage/index.ts:114` `getStorage()`; `src/lib/storage/types.ts:102` `StorageProvider` (`readFile`/`writeFile`/`fileExists`/`deleteDirectory`) — no interface change needed.
- `src/lib/lock.ts:37` `withFileLock`, `:59` `_resetLocks`.
- `src/lib/auth.ts:66` `getPrincipal`; `src/lib/config.ts:79` `isReadOnly`; `src/lib/errors.ts:7` `getErrorMessage`, `:21` `ClientInputError`.
- `src/lib/owner.ts:16` `getOwnerHandle()` — returns `null` when `NEXT_PUBLIC_OWNER_HANDLE` is unset; this is how a server-side helper with no owner argument resolves the single-owner tenant.

**Extend:**
- `src/lib/schema.ts:31` `readSchema(schemaPath?)`, `:60` `loadPageConventions(schemaPath?)` — add active-Wiki resolution inside `readSchema` when no explicit path is passed. Keep `:82` `loadPageTemplates` on the root file. Callers `ingest.ts:137,1218`, `lint-checks.ts:406,551`, `query.ts:219`, `src/app/api/wiki/templates/route.ts:74` must not change.
- `src/app/page.tsx:33` — currently renders only `<HomeDashboard>`; mount the new Wiki surface above it.
- `src/components/WorkspacePurposeSettings.tsx:14-21` — local `SCENARIO_LABELS` duplicate; replace with the shared export.

**Precedent to copy (read-only):**
- `src/app/api/workspace-profile/route.ts:12,26` — handler shape (401/403/400, `NextResponse.json`).
- `src/app/api/wiki/route.ts:51-161` — create-handler shape incl. 409/400 discrimination.
- `src/components/ShortcutsHelp.tsx:19-67` — the closest existing overlay: Escape handler, backdrop click, `role="dialog"`. It lacks `aria-modal`, focus trap and initial focus; the new shared dialog must add them.
- `src/app/globals.css:494` `.btn`, `:513` `.btn.primary`, `:522` `.btn.ghost`, `:625` `.shell`, `:565` `.fade`, `:421` global `:focus-visible` ring, `:617` reduced-motion block.
- `src/lib/__tests__/workspace-profile.test.ts:24-37` — temp-`DATA_DIR` + `_resetStorage()`/`_resetLocks()` recipe. `src/lib/__tests__/workspace-profile-routes.test.ts:1-52` — `vi.mock` + direct handler-import recipe. `src/lib/__tests__/single-ia.test.ts` — the source-scan recipe for UI invariants (Vitest runs `environment: "node"`, `src/**/__tests__/**/*.test.ts` only; there is no jsdom and no testing-library).

**Read-only constraints (do not regress):**
- `src/lib/silo.ts:178,230-265` — orphan sweep over `tenants/<t>/wiki/*.md`.
- `src/lib/retired.ts:21` `RETIRED_SURFACES`; `src/lib/__tests__/{retired-surfaces,brand-copy,single-ia,links,tenant-paths}.test.ts`.
- `src/middleware.ts:35` `IN_ROUTE_AUTH_PATHS` — Clerk-session-only routes need no entry; do not add one.
- `src/lib/frontmatter.ts:1-15` — flat frontmatter only (not needed here, but do not attempt nested YAML).

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-scenarios.ts` -- new pure, client-safe module: export `SCENARIO_LABELS` (the five AC labels keyed by scenario, plus `custom: "Custom"` for the existing Settings form), `CREATABLE_SCENARIOS` (ordered `["research","reading","personal-growth","business","general"]`), `renderPurposeMarkdown(name, template)` and `renderSchemaMarkdown(template)` -- one source for labels and for the markdown rendering of template data; client-safe so the dialog can import it.
- `src/lib/wikis.ts` -- new server module: `WikiRecord`/`WikiRegistry` types, `parseCreateWikiInput`/`parseScenarioInput` (reject `custom`, unknown scenarios, blank or >80-char names; throw `ClientInputError`), `listWikis(owner)`, `getCurrentWiki(owner)`, `createWiki(owner, input)`, `applyScenarioTemplate(owner, wikiId, scenario)`, `setCurrentWiki(owner, wikiId)`, and path helpers for `tenants/<t>/wikis.json` and `tenants/<t>/wikis/<id>/{purpose.md,schema.md}` -- the Wiki entity, registry, and seeding, all under `withFileLock`, modelled on `research-projects.ts`.
- `src/lib/wikis.ts` (same module) -- `createWiki` and `applyScenarioTemplate` both write `purpose.md`, `schema.md`, and `saveWorkspaceProfile(owner, templateInput)` in one operation, and touch nothing under `wiki/` or `raw/` -- makes the seeded template executable via the existing prompt path while satisfying "purpose/Schema only".
- `src/lib/schema.ts` -- when `readSchema` is called with no explicit path, resolve the current Wiki's `schema.md` (via `getOwnerHandle()` → tenant → registry) and read that; fall back to `<cwd>/SCHEMA.md` on no-owner, no-Wiki, or read failure -- AD-10: the Schema the template seeds must be the Schema that executes. One loader, no fork.
- `src/app/api/wikis/route.ts` -- new: `GET` returns `{ wikis, currentId }`; `POST` creates (201) -- house handler shape; Clerk-session-only, no middleware change.
- `src/app/api/wikis/current/route.ts` -- new: `PUT { id }` sets the active Wiki, 404 on unknown id -- server-side durable active-Wiki selection (AD-23).
- `src/app/api/wikis/[id]/template/route.ts` -- new: `POST { scenario }` applies a template to that Wiki, 404 on unknown id -- the confirm-gated overwrite's server half.
- `src/components/ConfirmDialog.tsx` -- new shared overlay: props `{ open, title, body, confirmLabel, cancelLabel, onConfirm, onCancel, busy? }`; `role="dialog" aria-modal="true" aria-labelledby`, initial focus on the dialog, focus trap, Esc closes exactly one level, backdrop click cancels -- UX-DR17 one overlay level; Stories 1.5 and 1.8 reuse it.
- `src/components/CreateWikiDialog.tsx` -- new client dialog: labelled "Wiki name" input (prefilled with the selected template's label, required), five selectable cards from `CREATABLE_SCENARIOS` with `aria-current` on the selection and Business preselected, subtitle "Pick one Scenario Template. This writes purpose.md and Schema. There is no blank wiki.", `Cancel` (ghost) + `Create` (primary) -- FR-38/UX-DR19; no blank option, one primary per cluster.
- `src/components/WikiWorkbench.tsx` -- new client surface: empty state "No wiki yet." + a `Create Wiki` primary when the registry is empty; otherwise the active Wiki's name, a `<select>` switcher when more than one exists, the seeded file list (`purpose.md`, `schema.md`), a `Change template` control that opens `ConfirmDialog` warning that purpose and Schema will be overwritten, and a preview region whose empty copy is exactly `Select a file to preview.` -- lands the owner on the Wiki surface after create without building Story 1.3's rail.
- `src/app/page.tsx` -- render `<WikiWorkbench initialWikis={…} initialCurrentId={…} />` above `<HomeDashboard>`, sourcing the registry server-side with the same `.catch(() => …)` degradation the other three sources use -- the owner's landing surface is where first-run Create Wiki belongs.
- `src/components/WorkspacePurposeSettings.tsx` -- import `SCENARIO_LABELS` from `@/lib/wiki-scenarios` and delete the local copy -- one label source.
- `src/lib/__tests__/wikis.test.ts` -- new: temp-`DATA_DIR` tests for create/list/current/apply, that `purpose.md` and `schema.md` exist after create and that the `business` pair differs from the `reading` pair, that applying a template rewrites purpose/Schema while leaving a pre-seeded `tenants/<t>/wiki/*.md` and `tenants/<t>/raw/*` byte-identical, that a failed/rejected input writes nothing, and that `custom`/unknown scenario/blank name throw -- covers the create, differ-by-template, apply, and validation matrix rows.
- `src/lib/__tests__/wikis-routes.test.ts` -- new: `vi.mock` handler tests for 401, 403 read-only, 400 invalid input, 201 create, 200 apply, 404 unknown id, 200 set-current -- covers the auth/validation matrix rows.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- new: `loadPageConventions()` returns the current Wiki's conventions when one exists and the root `SCHEMA.md` conventions when the registry is empty; `loadPageTemplates()` is unchanged -- covers the two executable-Schema matrix rows.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- new source-scan test (the `single-ia.test.ts` convention, since there is no DOM test environment): `CreateWikiDialog` renders exactly the five labels and never `custom`/"Blank"; `ConfirmDialog` carries `role="dialog"` and `aria-modal`; `WikiWorkbench` contains the literals `No wiki yet.` and `Select a file to preview.`; the overwrite warning names purpose and Schema -- pins the UI invariants the AC states.

**Acceptance Criteria:**
- Given a signed-in owner with no Wiki, when they open the app, then the Wiki surface shows `No wiki yet.` with a single primary `Create Wiki` action and no way to proceed without choosing one of the five templates.
- Given the Create Wiki dialog is open, when the owner presses Esc or clicks Cancel, then the dialog closes, exactly one overlay level is dismissed, and no registry, file, or profile write occurred.
- Given an existing Wiki, when the owner applies a different Scenario Template and confirms, then they land back on the Wiki surface with the new template's purpose and Schema and the preview region still reads `Select a file to preview.`
- Given the full suite, when `npx vitest run`, `npx tsc --noEmit` and `npx eslint` run, then all three are clean and no pre-existing test was weakened to make them pass.

## Spec Change Log

## Review Triage Log

### 2026-08-15 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 1, medium 4, low 8)
- defer: 5: (high 0, medium 4, low 1)
- reject: 8: (high 0, medium 1, low 7)
- addressed_findings:
  - `[high]` `[patch]` Activating a Wiki stripped the engine's page conventions from every prompt: once any Wiki existed, `loadPageConventions()` returned only the template's two sentences, dropping the root `SCHEMA.md` slug regex, H1 rule, index-summary rule, the `[Title](other-slug.md)` cross-reference form the graph builder needs, and the whole frontmatter field table. Fixed by composing the engine's `## Page conventions` body into the seeded `schema.md` at seed time (new `src/lib/schema-source.ts` holds the shared primitives so `schema.ts` and `wikis.ts` do not import each other), plus a fallback to the root file when the active Wiki's conventions section has an empty body.
  - `[medium]` `[patch]` `setCurrentWiki` half-applied a switch — `schema.md` followed `currentId` while `buildWorkspaceGuidance` stayed on the last created/re-templated Wiki, so the ingest prompt carried two templates at once. It now re-seeds the workspace profile from the newly active Wiki.
  - `[medium]` `[patch]` `writeRegistry` silently truncated with `slice(-MAX_WIKIS)`, dropping the oldest records and orphaning their artifacts. The cap is now a `ClientInputError` raised in `createWiki` before any write.
  - `[medium]` `[patch]` The template picker announced no selected state (`aria-current` is for navigation links). Switched to `aria-pressed` toggle semantics.
  - `[medium]` `[patch]` `WikiWorkbench` added a second `<h1>` above `HomeDashboard`'s, breaking the document outline. Demoted to `<h2>`.
  - `[low]` `[patch]` `normalizeRegistry` validated only `id` and `scenario`, so a damaged `wikis.json` rendered `undefined` names and `# undefined` purpose headings. It now requires a non-empty string `name`.
  - `[low]` `[patch]` The focus trap was copy-pasted into both dialogs. Extracted to `src/hooks/useDialogA11y.ts`, fixing five defects in the process: focus is restored to the opener, background scroll is locked, focus is pulled back in when `activeElement` is outside, the no-focusables Tab branch calls `preventDefault()`, and Esc originating in a native `<select>` no longer closes the dialog.
  - `[low]` `[patch]` `SEEDED_FILES`, `maxLength={80}` and an inline empty registry duplicated server-side constants. `WIKI_ARTIFACT_FILES` and `MAX_WIKI_NAME_CHARS` moved to the pure `wiki-scenarios.ts`; `emptyRegistry()` exported for `page.tsx`.
  - `[low]` `[patch]` `readActiveWikiSchema` swallowed its error, making a misconfigured owner handle undiagnosable. It now logs a warning.
  - `[low]` `[patch]` The Settings form showed two names for one scenario (shared labels in the `<select>`, template `name` in the feedback message). Both now use `SCENARIO_LABELS`.
  - `[low]` `[patch]` The overwrite confirm preselected the current scenario, so its default action was a destructive no-op. Confirm is disabled while the pending scenario equals the current one.
  - `[low]` `[patch]` Mutations updated local state only, leaving `force-dynamic` server output stale. `router.refresh()` now follows create, apply, and switch.
  - `[low]` `[patch]` Test hardening: a real UUID pattern (the old `/^[0-9a-f-]{36}$/` matched thirty-six dashes), the shared invalid-JSON 400 branch, and traversal-shaped wiki ids.

Note on routing: the absence of behavioral DOM tests for the confirm gate was routed to `defer`, not `bad_spec`. The repository has no DOM test environment at all — `environment: "node"`, no `@testing-library/*`, zero rendering tests across ~230 files — so the gap is pre-existing infrastructure this story is merely the first to stand on, and closing it is a repo-wide change rather than a defect in this change.

### 2026-08-15 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 2, low 9)
- defer: 4: (high 0, medium 3, low 1)
- reject: 22: (high 0, medium 3, low 19)
- addressed_findings:
  - `[medium]` `[patch]` A failed `Change template` was invisible. `applyTemplate`'s catch wrote to the section-level `error`, but the confirm overlay stays open on failure and its `fixed inset-0 z-[120]` backdrop covers everything the component renders behind it — the owner saw the spinner stop and nothing else. `ConfirmDialog` gained an `error` prop rendered inside the dialog as `role="alert"`, and the failure now routes there.
  - `[medium]` `[patch]` A transient registry read failure rendered the ordinary empty state. `page.tsx` caught the error and returned `emptyRegistry()`, so the workbench claimed `No wiki yet.` and offered a primary `Create Wiki` — an action that rewrites the tenant workspace profile — on the strength of a read that failed. Unlike the three sibling sources, an empty wiki registry is actionable, so the failure is now flagged (`unavailable`) and the workbench says the read failed instead.
  - `[low]` `[patch]` `normalizeRegistry` accepted any string `id` and no timestamps at all, so an entry whose id `wikiArtifactPath` rejects reached the client as a selectable Wiki that 400s on every operation, and `currentId` could point at it. The id is now checked for UUID shape against the same regex `validateWikiId` uses, and `createdAt`/`updatedAt` must be strings.
  - `[low]` `[patch]` `normalizeRegistry` dropped unusable entries silently — hiding a Wiki and orphaning its `wikis/<id>/` artifacts with nothing to diagnose from, while every other degradation path in the module logs. It now emits a `logger.warn` with the drop count.
  - `[low]` `[patch]` Focus restore targeted a detached node in this story's primary flow: creating the first Wiki unmounts the empty state that held the opening button, so `openerRef.current?.focus()` was a silent no-op and the keyboard user landed on `<body>`. `useDialogA11y` now checks `isConnected` and falls back to a caller-supplied landmark; both dialogs receive the workbench's `tabIndex={-1}` heading.
  - `[low]` `[patch]` `switchWiki` had no in-flight guard, so the active-wiki `<select>` stayed live during the `PUT` and two rapid switches could settle out of order, rolling the selection back to a stale id. The select is disabled while switching and re-entry returns early.
  - `[low]` `[patch]` The scenario `<select>` inside the confirm dialog was the one control not disabled on `busy`, so the selection could be changed mid-request and end up displaying a template that was not the one applied.
  - `[low]` `[patch]` `CreateWikiDialog` reset its state in an effect keyed to `open === true`, which runs after the reopened dialog has painted — flashing the abandoned attempt's name and card selection for a frame. The reset moved to close.
  - `[low]` `[patch]` `schema.ts` still carried the pre-change docstring claiming `SCHEMA.md` is the single source of truth whose edits reach the prompt on the next call. That is now false for conventions once a Wiki is active (the seeded `schema.md` holds a seed-time snapshot) while remaining true for `loadPageTemplates`; the docstring says so.
  - `[low]` `[patch]` `readSchemaFile` logged `read SCHEMA.md failed` for every path though it is now a shared primitive that also reads a Wiki's `schema.md` and test overrides. The message names the path.
  - `[low]` `[patch]` `createWiki`'s docstring described `parseCreateWikiInput` as a caller precondition while the body re-parses. Corrected to describe the re-parse as the guarantee it is.

Note on routing: the three findings about the owner-resolution seam, write atomicity, and cross-lock serialization were routed to `defer` rather than `patch` or `bad_spec`. Each is real and reachable in principle, but each is a property of infrastructure this story was directed to reuse — `getOwnerHandle()` is named in the spec's Code Map as the resolution mechanism, the storage provider has no transaction, and the two lock namespaces predate this module. The findings about `aria-pressed` versus `radiogroup` semantics, the `<h2>` preceding `HomeDashboard`'s `<h1>`, and the Settings dropdown's relabelled and reordered options were rejected: each names a decision the spec makes explicitly (toggle semantics were chosen in the previous pass, the placement above `HomeDashboard` and the single `<h1>` are both spec-pinned, and one shared label map in the AC's order is a stated boundary), so they are disagreements with the contract rather than defects against it.

### 2026-08-15 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 0
- reject: 29: (high 0, medium 9, low 20)
- addressed_findings:
  - `[medium]` `[patch]` A failed workspace-profile re-seed left the active-Wiki pointer already switched. `setCurrentWiki` wrote `currentId` first, so when `saveWorkspaceProfile` threw, the route answered 500 and the client rolled its `<select>` back — while the server had in fact switched, leaving `loadPageConventions()` on the new Wiki's `schema.md` and `buildWorkspaceGuidance()` on the old template. That is exactly the split the function's own docstring says the re-seed exists to prevent, and the owner was told nothing happened. The pointer is now restored inside the same lock before the error propagates, pinned by a new test that makes the profile path unwritable.
  - `[low]` `[patch]` A 2xx response whose body lacked `wiki` pushed `undefined` into component state before the throw, so the next render crashed on `wiki.id` — a blank surface instead of the error message the catch was writing. Both `create` and `applyTemplate` now check the response shape first.
  - `[low]` `[patch]` `normalizeRegistry` silently re-pointed `currentId` when the stored pointer named no surviving Wiki. That changes which `schema.md` executes in every ingest, chat, and lint prompt, and it was the one degradation path in the module that did not log. It now warns.
  - `[low]` `[patch]` The Change template confirm opens on the Wiki's current scenario, so its default state is the disabled one — a dead primary button with no stated reason. The dialog now says to pick a different template while the confirm is blocked.
  - `[low]` `[patch]` Test coverage: the non-object-but-valid-JSON body (`null`, `"general"`, `["general"]`, `7`) reaches `asObject` on all three write routes and was untested; added alongside the invalid-JSON case.

Note on routing: findings about write atomicity across `seedWikiArtifacts`/`writeRegistry`, the `getOwnerHandle()` resolution seam, the absent DOM test environment, the unconfirmed switch, and the missing delete/rename were **rejected as already recorded** — each is an existing entry in this spec's `deferred` ledger from a prior pass, and re-adding them would double-count work the ledger already owns. Findings about `aria-pressed` versus `radiogroup`, the `<h2>` preceding `HomeDashboard`'s `<h1>`, and the source-scan style of the UI tests were rejected again: all three name decisions the spec or a prior pass makes explicitly. The seeded `schema.md` freezing the engine's conventions at seed time was rejected as intended behavior, not a defect — the intent asks for the Wiki's own file to be what executes, and a non-destructive re-sync belongs with Story 1.8's Schema editing. Throwing on an unparseable `wikis.json` was likewise rejected: degrading to an empty registry would let the next create overwrite a recoverable file.

## Design Notes

**Why a Wiki entity at all, and how far it goes.** FR-38's `[ASSUMPTION: v1 allows more than one named Wiki]`, FR-76's `GET /api/v1/projects → { id, name, path, current }`, and the spine's "Wiki id is a kernel UUID; `current` = active Wiki" all settle that a Wiki is a first-class multi-instance record, not a rename of the singleton workspace profile. What they do *not* require here is per-Wiki Page storage: every AC in this story is observable at `purpose.md`/`schema.md`, and "Confirm overwrites purpose/Schema only — not Pages or Sources" only makes sense if Pages live outside the Wiki record. So Pages and Sources stay in the tenant silo exactly where they are, and `wikis/<id>/` holds only the two seeded artifacts. Partitioning Pages per Wiki is a later, larger cut.

**Why the profile is written alongside the files.** `renderWorkspaceGuidance` is already wired into seven prompt sites through `buildWorkspaceGuidance(owner)`. If create only wrote markdown, the chosen template would never reach a prompt and CAP-2's "purpose and Schema that Chat can cite" would be decorative. Writing both from the same `WorkspaceScenarioTemplate` keeps one source of template prose and leaves `buildWorkspaceGuidance`'s signature untouched. Divergence after a manual edit to only one of the two is a known gap that Story 1.8 (Schema editing) inherits.

**Storage shape:**

```
tenants/<tenant>/wikis.json                       # { version: 1, wikis: WikiRecord[], currentId }
tenants/<tenant>/wikis/<wikiId>/purpose.md
tenants/<tenant>/wikis/<wikiId>/schema.md         # contains "## Page conventions"
tenants/<tenant>/wiki/<slug>.md                   # untouched — reconcileSilos owns this tree
```

`schema.md` must keep the literal `## Page conventions` heading, because `extractSection` in `src/lib/schema.ts` matches on it.

**Landing surface.** "Wiki mode" is Story 1.3's rail; it does not exist yet. `WikiWorkbench` is the minimal honest stand-in on the existing owner landing page: it satisfies the create/land/empty-copy ACs and is expected to be replaced wholesale by 1.3's shell. The seeded file names are deliberately inert text — making them open a rendered preview is Story 1.5.

**dataVersion.** Story 1.7 owns the counter. When it lands, Wiki create/switch/template-apply are kernel writes and must bump it too; nothing here should make that harder.

## Verification

**Commands:**
- `npx vitest run` -- expected: the full suite green, including the four new files, with no pre-existing test modified except `workspace-profile`-label assertions if the shared label map changes rendered text.
- `npx tsc --noEmit` -- expected: exit 0.
- `npx eslint` -- expected: no errors or warnings.
- `npx vitest run src/lib/__tests__/single-ia.test.ts src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/links.test.ts src/lib/__tests__/tenant-paths.test.ts` -- expected: green unchanged; the Story 1.1 retirement and the `yopedia` identifier pins are untouched.
- `grep -rn "custom" src/components/CreateWikiDialog.tsx` -- expected: no match; the blank/custom scenario is unreachable from the picker.

**Manual checks (if no CLI):**
- Inspect `src/lib/wikis.ts` for any write path targeting `tenants/<t>/wiki/` or `tenants/<t>/raw/` — there must be none.

## Auto Run Result

Status: done

**Summary.** The spec arrived at `status: done` with `followup_review_recommended: true`, so this run was a third follow-up review pass over the same diff, not a re-implementation. Four review layers ran against every change since `a7590087cdd002bcf78ad985f73427ce87a7fcb0`. No `intent_gap` and no `bad_spec` finding survived triage — the implementation stands as specified — and five patches were applied, all on failure paths the happy-path suite could not reach. The pass is converging: 13 patches, then 11, now 5, with most of what the reviewers surfaced already sitting in the deferred ledger from earlier passes.

**Files changed in this pass:**
- `src/lib/wikis.ts` — `setCurrentWiki` restores the active-Wiki pointer when the profile re-seed fails; `normalizeRegistry` warns when it re-points a dangling `currentId`.
- `src/components/WikiWorkbench.tsx` — create and apply reject a malformed 2xx body before it reaches state; the confirm dialog explains its disabled primary.
- `src/lib/__tests__/wikis.test.ts` — a failed profile re-seed leaves the pointer where it was (real filesystem, no mocks).
- `src/lib/__tests__/wikis-routes.test.ts` — valid-JSON-but-not-an-object bodies 400 on all three write routes.

**Review findings breakdown:** 5 patches applied (high 0, medium 1, low 4); 0 items newly deferred — everything defer-shaped this pass was already an entry in the frontmatter ledger; 29 rejected (medium 9, low 20).

**Follow-up review recommendation:** `true`. Patched severities this pass: high 0, medium 1, low 4 → `3 × 1 + 1 × 4 = 7`, at or above the threshold of 5. No high-severity patch was applied, and the medium one is a failure-path correction rather than a defect in the shipped behavior.

**Verification performed:**
- `npx vitest run` — 195 files, 3780 tests, all passing (3778 before this pass; the 2 new tests are the patch pins). No pre-existing test was modified.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` — exit 0 (the three `TSNonNullExpression` notices are a `jsx-ast-utils` warning printed on unrelated pre-existing files, not lint errors).
- `npx vitest run src/lib/__tests__/{single-ia,retired-surfaces,brand-copy,links,tenant-paths}.test.ts` — 93 tests green; the Story 1.1 retirements and the `yopedia` identifier pins are untouched.
- `grep -rn "custom" src/components/CreateWikiDialog.tsx` — no match.
- Manual: `src/lib/wikis.ts` writes only `tenants/<t>/wikis.json` and `tenants/<t>/wikis/<id>/{purpose.md,schema.md}`; no path under `tenants/<t>/wiki/` or `tenants/<t>/raw/`.

**Residual risks:**
- The interactive surface is still verified only by source scan — there is no DOM test environment in this repository (deferred ledger entry 2). The confirm gate, the focus trap, and the new response-shape guards would all survive being rewired without a test failing.
- Multi-write operations remain non-atomic (ledger entry 7). This pass closed the one case where the resulting split-brain also contradicted what the owner was told; `createWiki` and `applyScenarioTemplate` can still leave artifacts ahead of the registry if a write fails mid-sequence.
- The per-Wiki `schema.md` embeds the engine's page conventions as a seed-time snapshot, so a later edit to the repo-root `SCHEMA.md` reaches existing Wikis only by re-applying their template, which also overwrites `purpose.md` and the profile. Story 1.8 owns the non-destructive path.

