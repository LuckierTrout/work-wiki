---
title: 'Doc-drift corrections across seven documentation surfaces (DW-127, DW-129, DW-130, DW-138, DW-171, DW-245, DW-309)'
type: 'chore'
created: '2026-08-20'
baseline_revision: '405d4f147e5e2a11ff509522e16ea64dce0efe66'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      SCHEMA.md's Talk pages section still documents all five
      `/api/wiki/:slug/discuss...` routes as live surfaces.
    evidence: |-
      SCHEMA.md:126-167 lists GET/POST discuss, GET/PATCH the thread, and POST
      comments as live. All five are entries in RETIRED_SURFACES
      (src/lib/retired.ts:37-40) and answer 404. Same drift class as DW-129,
      one heading above the block this change corrected; the intent named only
      the contributor surface.
    location: >-
      SCHEMA.md:126
    severity: medium
  - summary: >-
      SCHEMA.md's planned-evolution status still calls talk pages and
      contributor profiles complete, contradicting the new retired-surfaces
      block.
    evidence: |-
      The Phase 2 status prose later in SCHEMA.md reads that talk pages and
      attribution are complete and contributor profiles are implemented, a few
      hundred lines below the paragraph this change rewrote to say the whole
      contributor product surface was cut.
    location: >-
      SCHEMA.md
    severity: low
  - summary: >-
      DESIGN-triggers.md still designs triggers on `discussion-opened` /
      `discussion-resolved` and talk-thread events that retired with the
      commons.
    evidence: |-
      DESIGN-triggers.md:190-191 and :316-317 build trigger designs on
      discussion events whose routes are all RETIRED_SURFACES entries
      (src/lib/retired.ts:37-40). This change corrected only the tool count at
      :338, which was the only fact the intent named in that file.
    location: >-
      DESIGN-triggers.md:190
    severity: low
  - summary: >-
      The eight-member `fix` list is hand-copied in two documents with nothing
      pinning either to `MaintainFixType`.
    evidence: |-
      src/lib/maintenance.ts's module header and workers/task-consumer/README.md:47-49
      both re-list the union by hand. `MaintainFixType` (src/lib/tasks.ts:164-172)
      appears in no test, so adding a ninth member re-stales both silently --
      exactly the mechanism DW-127 reported. DW-130 got a pin in this pass
      (mcp-annotations.test.ts); this list did not, because the intent did not
      ask for one.
    location: >-
      src/lib/maintenance.ts:11
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Seven documentation surfaces describe code as it no longer is: a stale
`fix` lint-type list, retired contributor routes advertised as live, a stale MCP tool
count, an owner-scoped description of a per-Wiki editor, a per-Wiki gloss of shared
Pages/Sources, a "never enters the vector gate" claim the DW-217 sweep falsified, and
an operator doc reachable from nothing but a test's pin list.

**Approach:** Prose-only edits, each replacing the stale statement with the verified
current-state answer already established in the Code Map below, plus one new link that
makes `tools/work-wiki-sync.md` discoverable and one added entry to the existing MCP
tool-count pin so the corrected count cannot silently go stale again.

## Boundaries & Constraints

**Always:** Preserve each document's existing voice, heading structure, and line-wrap
width (these files wrap at ~80 columns; match the surrounding paragraph). State the
current behaviour, not a changelog of what it used to be — except where the surrounding
document already narrates history, in which case match that. Where a surface is retired,
say so and point at `src/lib/retired.ts` the way the codebase already does.

**Block If:** A stated current-state fact turns out not to hold when checked against the
code cited in the Code Map — do not guess a replacement sentence.

**Never:** Do not change runtime behaviour, delete `src/lib/contributors.ts` or
`src/lib/contributor-index.ts` (both still live), rewrite unrelated roadmap/PRD/DEPLOY
paragraphs, retire any surface, or edit `_bmad-output/implementation-artifacts/deferred-work.md`.
Do not "fix" `docs/llm-wiki-functional-parity-roadmap.md:47`, `:127` or `:205` — verified
during planning as unrelated "owner-scoped" mentions (original-source search APIs, Studio
APIs, and settings generally), not the Workspace Purpose editor. Line `:192` is a
roadmap *plan* item, not a current-state claim; leave it.

</intent-contract>

## Code Map

- `src/lib/maintenance.ts:11-14` -- stale module-header `fix` list (`unmigrated-page`,
  `supersedes-dangling`, `stale-index`). The scan body emits eight `lintType` values at
  :61 `orphan-page`, :79 `stale-index`, :102 `unmigrated-page`, :111 `supersedes-dangling`,
  :128 `broken-link`, :144 `empty-page`, :161 `stale-page`, :194 `missing-crossref`.
- `src/lib/tasks.ts:164-172` -- `MaintainFixType`, the 8-member union the header must match.
- `workers/task-consumer/README.md:47-49` -- **reuse the exact wording/order already
  corrected there**; the module header is the remaining stale copy.
- `SCHEMA.md:68-69` -- `authors`/`contributors` rows name `/wiki/contributors`,
  `ContributorBadge`, and "contributor profiles API" as consumers. Real live consumers:
  `src/lib/contributor-index.ts` (fed by `src/lib/lifecycle.ts:34`, `src/lib/talk.ts:46`,
  rebuilt by `src/lib/maintenance.ts:232`), `src/lib/contributors.ts` profile building,
  `src/lib/merge.ts:228` author union, and `src/cli.ts:348` `Authors:` display.
- `SCHEMA.md:193-201` -- the "API routes"/"UI" block. `/api/contributors`,
  `/api/contributors/[handle]`, `/wiki/contributors` are all `RETIRED_SURFACES`
  (`src/lib/retired.ts:26,34,35`) answering 404 via `retiredRoute()`/`retiredPage()`;
  `ContributorBadge` is gone from `src/` entirely (grep: zero hits). The *library*
  (`buildContributorProfile()`, `listContributors()`) is still live — keep the section's
  formula and revert-detection prose.
- `DESIGN-triggers.md:338` -- "exposes 21 tools"; real count 40
  (`src/lib/__tests__/mcp-annotations.test.ts:34`). Only one `N tools` match in the file.
- `src/lib/__tests__/mcp-annotations.test.ts:42-45` -- the `it.each` pin list, today
  `public/agent-api.md` and `src/lib/mcp-http.ts`. Its regex flattens JSDoc gutters and
  wrapping, and requires ≥1 match per pinned file, so a plain-markdown line qualifies.
- `docs/llm-wiki-functional-parity-roadmap.md:100-102` -- "Settings now includes an
  owner-scoped Workspace Purpose editor…". `src/lib/workspace-profile.ts:1-8` states the
  profile is PER WIKI at `tenants/<t>/wikis/<wikiId>/workspace-profile.json`.
- `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md:99` -- File Tree
  glossary entry glossing Pages+Sources+purpose/Schema as "the Wiki's files". Corrected
  invariant: `_bmad-output/planning-artifacts/epics.md:401-404` (Pages and Sources are
  shared across Wikis; a Wiki is a lens) and `src/lib/workbench-tree.ts:104`. Only
  `purpose.md`/`schema.md` are per-Wiki (`src/lib/wiki-scenarios.ts:57`
  `WIKI_ARTIFACT_FILES`).
- `DEPLOY.md:111-115` and `DEPLOY.md:190-196` -- the two "flat request" caveats.
  Falsified by `src/app/api/settings/route.ts:444-450`: `validateWorkbenchSettingsPatch`
  now runs for a flat-only body (`hasWorkbenchKey ? body.workbench : {}`), with
  `flatMovableVectorLegs(body)` (`src/lib/workbench-settings.ts:887-902`) scoping the
  refusal to the provider/model legs `/settings` can act on. Two live limits remain and
  must survive the rewrite: the flat branch cannot move `vectorSearchEnabled`, so it
  never refuses in the turning-on frame, and a flat move is **not** gated while vector
  search is off (`src/lib/__tests__/settings-route.test.ts:504-522`) — which is exactly
  why "workers-ai stored silently on a deployment with no binding" is still reachable.
  Suite: `settings-route.test.ts:381-614`.
- `tools/work-wiki-sync.md` -- operator sync doc; grep shows the only referents are
  `src/lib/__tests__/brand-copy.test.ts:237` (a scan pin) — no README/DEPLOY/AGENTS/UI link.
- `src/components/LocalSyncPanel.tsx:40-51` -- builds the `pnpm sync watch` /
  `pnpm sync source-watch` env block inline and points nowhere; the natural in-app anchor.

## Tasks & Acceptance

**Execution:**
- `src/lib/maintenance.ts` -- rewrite the `**fix**` bullet in the module header (:11-14) to
  name all eight `lintType` values, matching `workers/task-consumer/README.md:47-49` --
  DW-127: the header is the last stale copy of a list `MaintainFixType` already fixes.
- `SCHEMA.md` -- rewrite the "API routes"/"UI" block at :193-201 to state the two REST
  routes and both `/wiki/contributors` pages are retired 404s (citing `src/lib/retired.ts`)
  and that `ContributorBadge` no longer exists, while keeping the live
  `buildContributorProfile()`/`listContributors()` library description; and retarget the
  `Consumed by` cells at :68-69 to the real consumers listed in the Code Map -- DW-129.
- `DESIGN-triggers.md` -- change `21 tools` to `40 tools` at :338 -- DW-130.
- `src/lib/__tests__/mcp-annotations.test.ts` -- add `DESIGN-triggers.md` to the
  `it.each` pin list at :42-45 -- DW-130: pins the third hand-written count so it cannot
  drift again.
- `docs/llm-wiki-functional-parity-roadmap.md` -- reword :100-102 so the Workspace Purpose
  editor reads as per-Wiki (stored beside that Wiki's `purpose.md`/`schema.md`, switching
  Wikis swaps which profile is live) rather than owner-scoped -- DW-138.
- `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md` -- reword the
  **File Tree** glossary entry at :99 so Pages and Sources read as shared across Wikis and
  only `purpose.md`/Schema as the active Wiki's -- DW-171.
- `DEPLOY.md` -- rewrite both flat-request caveats (:111-115, :190-196) to say the flat
  `/settings` branch now runs the same vector rule, and replace the false "never enters
  the gate" premise with the two real limits (no turning-on frame; not gated while vector
  search is off) so the surrounding "still stored silently" consequence stays true --
  DW-309.
- `DEPLOY.md` -- add one link to `tools/work-wiki-sync.md` from the local-sync/backup
  prose, so the operator doc is reachable from a document operators already read -- DW-245.

**Acceptance Criteria:**
- Given `src/lib/maintenance.ts`'s module header, when its `fix` bullet is read, then all
  eight members of `MaintainFixType` (`src/lib/tasks.ts:164-172`) appear in it and no
  member is missing.
- Given `SCHEMA.md`, when the contributor-profiles section and the `authors`/`contributors`
  frontmatter rows are read, then no retired surface (`/api/contributors`,
  `/api/contributors/:handle`, `/wiki/contributors`, `/wiki/contributors/:handle`,
  `ContributorBadge`) is presented as live, and the still-live
  `buildContributorProfile()`/`listContributors()` library is still described.
- Given `DESIGN-triggers.md:338`, when the MCP capability sentence is read, then it states
  40 tools.
- Given the pinned-count test, when `pnpm test src/lib/__tests__/mcp-annotations.test.ts`
  runs, then it passes with `DESIGN-triggers.md` among the pinned files.
- Given `docs/llm-wiki-functional-parity-roadmap.md`, when the 2026-08-06 local
  implementation status is read, then the Workspace Purpose editor is described as
  per-Wiki, consistent with `src/lib/workspace-profile.ts:5`.
- Given the PRD glossary, when the **File Tree** entry is read, then Pages and Sources are
  not attributed to a single Wiki and only `purpose.md`/Schema are the active Wiki's.
- Given `DEPLOY.md`, when either former "flat request" caveat is read, then neither claims
  the flat branch skips the vector gate, and both still state the conditions under which a
  bad value is accepted silently.
- Given `DEPLOY.md`, when it is searched for `tools/work-wiki-sync.md`, then exactly one
  link to that path is present and it sits in prose about local sync or backup.
- Given the whole change, when `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` run,
  then all pass — no runtime behaviour changed.

## Spec Change Log

_No bad_spec loopback occurred. Empty._

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 5, low 1)
- defer: 4: (high 0, medium 2, low 2)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[medium]` `[patch]` DEPLOY.md's rewritten provider caveat claimed the flat gate is scoped to "the provider and model legs that page can actually act on" — false three ways: `/settings` renders no provider select (`useSettings` never sends `embeddingProvider`), the scoping keys off the request body rather than the page, and it is suppressed only when the save did not break a working configuration (`workbench-settings.ts:1256-1262`). Paragraph rewritten to state the move-plus-already-on precondition, the normal leg narrowing, and the breaks-a-working-config exception; the "still stored silently" consequence re-aimed at the flat `/api/settings` route; the removed "nothing gates `EMBEDDING_PROVIDER` or the config file" fact restored.
  - `[medium]` `[patch]` DEPLOY.md's rewritten model caveat implied the already-on precondition was the only limit. Added the breaks-a-working-config exception with a pointer to the provider rule above.
  - `[low]` `[patch]` SCHEMA.md said all three retired contributor surfaces "answer a bodiless 404 through `retiredRoute()` / `retiredPage()`"; `retiredPage()` calls Next's `notFound()` and renders the app's 404 UI. Claim split between the two route handlers and the page.
  - `[medium]` `[patch]` SCHEMA.md's rewritten `authors`/`contributors` `Consumed by` cells injected repo-internal `src/lib/...` paths into live prompt text: `### Work-wiki frontmatter fields` sits inside `## Page conventions`, which `loadPageConventions()` ships verbatim into ingest, chat and lint prompts and snapshots into every newly seeded Wiki `schema.md`. Both cells rewritten in the product register the rest of the table uses.
  - `[medium]` `[patch]` The `src/lib/maintenance.ts` header traded per-fix semantics for a bare list of eight names, hiding that `empty-page` deletes the page outright (`fixEmptyPage` → `deleteWikiPage`) — in the header whose stated job is guardrails. Added a clause flagging the one destructive fix.
  - `[medium]` `[patch]` The new DEPLOY.md sync link sat in the Docker Volume Mounts section while the companion defaults `WORKWIKI_URL` to `https://workwiki.app` and `tools/work-wiki-sync.md` never mentions the variable, so a self-hoster following it verbatim would pull from the hosted instance. Added the precondition.

## Design Notes

The two DEPLOY.md caveats are not simply deletable: the paragraphs around them depend on
the consequence ("`workers-ai` selected there is still stored silently", "a mismatch
entered there is accepted silently"), and that consequence is still true — just for a
different reason. The gate runs on the flat branch, but only bites when the flat body
moves a vector input *while vector search is already stored on*; with the switch off the
save passes through untouched. Rewrite the premise, keep the consequence, and name the
condition that now produces it.

`SCHEMA.md`'s contributor section has no existing "retired" convention (grep: zero hits
for "retired" in that file), so introduce the plainest one — state the 404 and cite
`src/lib/retired.ts`, matching how `src/app/api/contributors/route.ts` documents itself.

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/mcp-annotations.test.ts` -- expected: pass, including the
  newly pinned `DESIGN-triggers.md`
- `pnpm test src/lib/__tests__/brand-copy.test.ts` -- expected: pass (the maintainer brand
  sweep reads the docs this change edits)
- `pnpm test` -- expected: full suite passes
- `pnpm lint` -- expected: clean
- `pnpm exec tsc --noEmit` -- expected: clean

**Manual checks (if no CLI):**
- `grep -n "work-wiki-sync.md" DEPLOY.md` -- expected: exactly one hit.
- `grep -n "flat request" DEPLOY.md` -- expected: no hits, or only hits that no longer
  claim the gate is skipped.

## Auto Run Result

Status: done

**Summary.** Seven documentation surfaces that described the code as it no
longer is were corrected to the verified current state, plus one new inbound
link and one new regression pin. Prose and comments only — no runtime behaviour
changed.

**Files changed:**
- `src/lib/maintenance.ts` — module header's `fix` bullet now names all eight
  `MaintainFixType` members (was three) and flags `empty-page` as the one
  destructive fix (DW-127).
- `SCHEMA.md` — the `authors`/`contributors` `Consumed by` cells retargeted to
  real consumers in product language, and the contributor "API routes"/"UI"
  block replaced with **Retired surfaces** (the two REST routes' bodiless 404
  via `retiredRoute()`, the page's `notFound()` render) plus **Still live** (the
  profile library) (DW-129).
- `DESIGN-triggers.md` — MCP tool count `21` → `40` (DW-130).
- `src/lib/__tests__/mcp-annotations.test.ts` — `DESIGN-triggers.md` added to
  the tool-count pin list so that third hand-written count cannot drift again
  (DW-130).
- `docs/llm-wiki-functional-parity-roadmap.md` — the 2026-08-06 status now
  describes the Workspace Purpose editor as per-Wiki (DW-138).
- `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md` — the
  **File Tree** glossary entry no longer attributes shared Pages and Sources to
  one Wiki (DW-171).
- `DEPLOY.md` — both "flat request never enters the gate" caveats rewritten to
  the real rule and its real limits (DW-309), and one link to
  `tools/work-wiki-sync.md` added with the `WORKWIKI_URL` precondition (DW-245).

**Review findings breakdown:** 6 patches applied (5 medium, 1 low), 4 items
deferred (2 medium, 2 low), 15 rejected. No intent gaps, no spec repairs.

**Follow-up review recommendation:** `true`. Patched severities: high 0, medium
5, low 1 → score `3 × 5 + 1 × 1 = 16`, which is ≥ 5.

**Verification performed** (`pnpm` is broken in this checkout — `pnpm test` /
`pnpm lint` / `pnpm exec` all fail with `ERROR packages field missing or empty`,
a pre-existing workspace-resolution problem unrelated to this change — so the
equivalent `npx` invocations were used):
- `npx vitest run` — 256 files / 5537 tests passed.
- `npx vitest run src/lib/__tests__/mcp-annotations.test.ts` — passes with
  `DESIGN-triggers.md` pinned.
- `npx vitest run src/lib/__tests__/brand-copy.test.ts` — passes (the maintainer
  sweep scans the edited docs).
- `npx tsc --noEmit` — clean. `npx eslint` — clean (exit 0).
- `grep -c "work-wiki-sync.md" DEPLOY.md` → 1. `grep -c "flat request" DEPLOY.md`
  → 2, both in rewritten sentences that no longer claim the gate is skipped.

**Residual risks:**
- The corrected `fix` list in `src/lib/maintenance.ts` (and its twin in
  `workers/task-consumer/README.md`) is still hand-copied with nothing pinning
  it to `MaintainFixType` — deferred above; a ninth member re-stales both.
- The new `DESIGN-triggers.md` pin is a whole-file regex: a future sentence in
  that design doc containing a different `N tools` count fails the suite, and a
  rephrase away from that exact phrasing escapes the pin. This is the pin
  design already in use for the two files pinned before, not a new mechanism.
- `SCHEMA.md`'s `## Page conventions` section ships into live prompts, so any
  future edit to that frontmatter table changes model-facing text; the patched
  cells stay in product language for that reason.
- DEPLOY.md's DW-309 correction is prose against behaviour pinned only by
  `settings-route.test.ts`, with no link between them — the next change to that
  route can re-stale it the same way DW-217 did.
