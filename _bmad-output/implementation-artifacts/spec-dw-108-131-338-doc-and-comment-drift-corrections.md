---
title: 'Doc-and-comment drift corrections: stale no-DOM prose, the graph a11y escape hatch, and SCHEMA.md Talk pages (DW-108, DW-131, DW-338)'
type: 'chore'
created: '2026-08-21'
baseline_revision: 'c1e60ebc7b50afc8c3d02f9706d6e86ac5f38e17'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      Nothing pins SCHEMA.md's "Retired surfaces" prose to `RETIRED_SURFACES`, so
      both retired-surface blocks can rot the same way the Talk block just did.
    evidence: |-
      This change added a second hand-maintained doc/code coupling: SCHEMA.md's
      new Talk-pages "Retired surfaces" paragraph and the DW-129 contributor
      paragraph (`SCHEMA.md:207-217`) both restate entries of `RETIRED_SURFACES`
      (`src/lib/retired.ts`) in prose, and no source or test file references
      either heading. `retired-surfaces.test.ts` derives the constant from the
      tree on disk, so retiring or un-retiring a surface stays honest in code
      and silently stales the docs — the exact mechanism that produced DW-129
      and then DW-338. The graph href got a pin in this pass; the prose did not,
      because the intent named only the marking-retired edit.
    location: >-
      SCHEMA.md:156
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Three pieces of prose now misdescribe the running system. (a) Eighteen source and test files still tell the reader this repository has no DOM test environment — and use that as the stated justification for their design — while `vitest.config.ts` has defined a jsdom `dom` project since commit 39ebb12, so a future agent will reproduce the workaround on a reason that no longer holds. (b) The graph canvas's only accessibility escape hatch (`src/app/wiki/graph/page.tsx:161,164`) sends readers to `/wiki`, which is in `RETIRED_SURFACES` (`src/lib/retired.ts:23`) and 404s. (c) `SCHEMA.md:126-167` still documents all five `/api/wiki/:slug/discuss…` routes and a "Discussion" tab as live surfaces though every one of them is retired.

**Approach:** Rewrite each stale claim to say what is actually true — *the node project runs these as pure functions* — instead of *mounting is impossible*, leaving the design itself untouched. Retarget the graph canvas's `aria-label` and fallback at the Workbench's Knowledge tree, spell that target once as a constant, and pin it against `RETIRED_SURFACES` so it cannot rot into another retired route. Mark SCHEMA.md's Talk-pages API and UI retired the way DW-129 already handled contributor profiles.

## Boundaries & Constraints

**Always:**
- Corrected prose must be TRUE of the repo as it stands: the `node` project (`*.test.ts`) has no DOM, the `dom` project (`*.test.tsx`, jsdom) does. Scope every claim to the project it is about, never to "this repo".
- Keep the existing design decisions and every existing assertion intact — this is a prose-only pass over comments, plus one new constant, one import swap in the graph page, and one new pinning test.
- The graph page must spell no route literal of its own; its target comes from the shared constant.
- SCHEMA.md edits are confined to the `## Talk pages (Phase 2)` section (lines 126-168, i.e. everything between that heading and `## Contributor profiles (Phase 2)`).

**Block If:**
- The Knowledge tree's live href cannot be determined from `src/lib/workbench-url.ts` / `src/lib/workbench-modes.ts` plus `src/app/page.tsx` without guessing.
- Correcting a comment would require changing the code it documents to stay honest.

**Never:**
- Touch `SCHEMA.md`'s `## Page conventions` section (lines 29-125) or any other section — it is parsed into LLM prompts at runtime by `src/lib/schema.ts`, so an edit changes production behavior with no deploy.
- Delete the Talk-pages storage/schema documentation. The `discuss/<slug>.json` shape and `src/lib/talk.ts` are still live library code; only the REST routes and the Discussion tab are retired.
- Move a `.test.ts` suite to `.test.tsx`, add mounted coverage, or convert any source-scan assertion into a mounted one. This pass changes prose, not coverage.
- Rewrite prose that is already correctly scoped: `read-only-door-coverage.test.ts:22`, `article-actions-gate.test.ts:26-30`, `new-wiki-page-seam.test.ts:13`, `read-only-copy-parity.test.ts:17`, `create-wiki-ui.test.ts:10`, `single-main-landmark-scan.test.ts:9`, `workbench-split-wiring.test.tsx:24`, `workbench-url.ts:31`, `single-ia.test.ts:9`, `english-only.test.ts:7`, `write-precondition.ts:18`, `live-region.ts:26`, `workbench-tree.ts:398,641`, `app/page.tsx:93`, `html.ts:4`.
- Rename any frozen identifier (AGENTS.md **Frozen identifiers**).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Knowledge-tree target is live | `KNOWLEDGE_TREE_HREF` as shipped | Its pathname is absent from `RETIRED_SURFACES` | Test fails naming the retired pathname |
| Target rots into a retired route | Someone adds the Knowledge target's path to `RETIRED_SURFACES` | The pin fails | Test fails; no silent 404 escape hatch |
| Graph page re-hardcodes a route | `page.tsx` gains a literal `href="/wiki…"` or names `/wiki` in the a11y copy | The pin fails | Test fails naming the literal |
| Constant is derived, not hand-copied | `WORKBENCH_MODE_PARAM` renamed | `KNOWLEDGE_TREE_HREF` moves with it | Compile-time; no drift |

</intent-contract>

## Code Map

**DW-108 — stale "no DOM test environment" prose. Every site, already located; do not re-search.**

Source modules (rewrite the justification, keep the design):
- `src/lib/workbench-data-version.ts:9-12` -- "vitest runs `environment: "node"` and this repo has no DOM test environment".
- `src/lib/workbench-split.ts:8-11` -- "There is no DOM test environment here (`vitest.config.ts` is `environment: "node"`)".
- `src/lib/workbench-settings.ts:9-15` -- "`vitest.config.ts` is `environment: "node"` — there is no DOM and no testing-library".
- `src/lib/workbench-preview.ts:295`, `:433-434`, `:875-877`, `:1056-1059` -- four sites; `:1057` is the strongest ("This repo has no DOM test environment and this story is forbidden from adding one").
- `src/lib/workbench-url.ts:10-11` -- "A precedence typed into the mount effect instead could only ever be grepped for." (`:31` is already correct — leave it.)
- `src/components/workbench/TreePanel.tsx:34-36` -- "this repo has no DOM test environment to verify either (DW-24)".
- `src/components/workbench/PreviewColumn.tsx:96-98`, `:466`, `:596-598`, `:1018-1021`.
- `src/components/workbench/SettingsCanvas.tsx:72-75`.
- `src/components/workbench/SplitHandle.tsx:14-18`.
- `src/components/workbench/Workbench.tsx:288-291` -- "could only ever be grepped for, never executed by a test".

Test headers (same rewrite; assertions unchanged):
- `src/lib/__tests__/workbench-preview.test.ts:12-14`, `:2056-2058`, `:2566-2568`.
- `src/lib/__tests__/workbench-settings.test.ts:11-16`, `:4472`.
- `src/lib/__tests__/workbench-split.test.ts:8-12`, `:1292`.
- `src/lib/__tests__/wiki-schema-edit.test.ts:15-17`.
- `src/lib/__tests__/workbench-url.test.ts:6-8`.
- `src/lib/__tests__/workbench-chrome.test.ts:4-6`.
- `src/lib/__tests__/workbench-left-column.test.ts:4-6`.
- `src/lib/__tests__/workbench-data-version.test.ts:13-14`.

Ground truth to restate against: `vitest.config.ts` -- `test.projects` = `node` (`environment: "node"`, `include: ["src/**/__tests__/**/*.test.ts"]`) and `dom` (`environment: "jsdom"`, `include: ["src/**/__tests__/**/*.test.tsx"]`). The `dom` project's mounted suites live in `src/components/__tests__/*.test.tsx`, `src/components/workbench/__tests__/*.test.tsx`, `src/hooks/__tests__/*.test.tsx`, `src/app/**/__tests__/*.test.tsx`.

**DW-131 — the graph canvas escape hatch.**
- `src/app/wiki/graph/page.tsx:152-165` -- the `<canvas role="img">`; `:161` `aria-label` and `:164` fallback child both name "the wiki index"; `:148-150` is the visible helper paragraph ("Click a node to open the page.").
- `src/lib/retired.ts:23` -- `/wiki` is a retired surface; `retiredPage()` makes it 404.
- `src/lib/workbench-url.ts:26` -- `WORKBENCH_MODE_PARAM = "mode"`; `:101 modeHref` is the existing mode-href rule. New constant belongs here.
- `src/lib/workbench-modes.ts:36` -- the `wiki` mode id; `src/app/page.tsx` -- the Workbench is `/`, and its `WorkbenchDataProvider` `knowledge` prop is the Knowledge tree's data, so the live text list is `/?mode=wiki`.
- `src/components/workbench/TreePanel.tsx` -- renders the `Knowledge | Files` tabs; `src/lib/workbench-tree.ts:44` -- `DEFAULT_TREE_TAB = "knowledge"`, so the Knowledge tab is what `/?mode=wiki` opens on.
- `src/lib/__tests__/retired-surfaces.test.ts` -- the pin's home. It already imports `RETIRED_SURFACES`, `fs` and `path`, and derives retired routes from disk (`retiredSurfacesOnDisk`, `:42`).

**DW-338 — SCHEMA.md Talk pages.**
- `SCHEMA.md:126-168` -- `## Talk pages (Phase 2)`: Location/Schema tables (still true, keep), `**API routes:**` list at `:158-164` (all retired), `**UI:**` paragraph at `:166-168` (Discussion tab + badge counts — the wiki page view is itself retired).
- `SCHEMA.md:193-206` -- the DW-129 precedent inside `## Contributor profiles (Phase 2)`: a `**Retired surfaces:**` paragraph naming the entries and `retiredRoute()`/`retiredPage()`, followed by a `**Still live:**` paragraph for the library underneath. Mirror that shape.
- `src/lib/retired.ts:35-38` -- the four discuss route entries (five method+route pairs).
- `src/lib/talk.ts` -- still live library code; `src/lib/contributors.ts` reads talk JSON, which is why the storage docs stay.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-url.ts` -- add an exported `KNOWLEDGE_TREE_HREF`, built from `WORKBENCH_MODE_PARAM` and a `WorkbenchModeId`-typed `"wiki"` literal (not `DEFAULT_WORKBENCH_MODE` — the tree lives in Wiki mode whatever the default becomes), with a comment naming it the live text-based list of the active Wiki's pages and pointing at the pin; and correct the stale `:10-11` claim -- one definition of the target, so nothing hand-copies a route.
- `src/app/wiki/graph/page.tsx` -- import `KNOWLEDGE_TREE_HREF`; retarget the canvas `aria-label` and the canvas fallback child at the Workbench Knowledge tree by name, make the fallback child a real `<a href={KNOWLEDGE_TREE_HREF}>`, and add the same link to the visible helper paragraph so the escape hatch is reachable while the canvas renders -- the aria-label promises a text list, so one has to exist and be reachable.
- `src/lib/__tests__/retired-surfaces.test.ts` -- add a `describe` covering the I/O matrix rows: `KNOWLEDGE_TREE_HREF`'s pathname is not in `RETIRED_SURFACES`; the graph page's source references `KNOWLEDGE_TREE_HREF` and contains no `/wiki` route literal in an `href` or in its a11y copy -- pins the target against the same list that made the old one a 404.
- `src/lib/workbench-data-version.ts`, `src/lib/workbench-split.ts`, `src/lib/workbench-settings.ts`, `src/lib/workbench-preview.ts` -- rewrite each site listed in the Code Map so the justification is "these are pure functions the node project executes directly", dropping every "no DOM test environment" / "could only ever be grepped for" premise -- the premise is false and invites re-derivation of the workaround.
- `src/components/workbench/TreePanel.tsx`, `PreviewColumn.tsx`, `SettingsCanvas.tsx`, `SplitHandle.tsx`, `Workbench.tsx` -- same rewrite at the Code Map's sites. `TreePanel.tsx:34-36` additionally justifies NOT using the ARIA tree pattern on the absent DOM environment: restate that as the design choice it is (platform semantics over focus machinery), without claiming verification is impossible.
- `src/lib/__tests__/workbench-preview.test.ts`, `workbench-settings.test.ts`, `workbench-split.test.ts`, `wiki-schema-edit.test.ts`, `workbench-url.test.ts`, `workbench-chrome.test.ts`, `workbench-left-column.test.ts`, `workbench-data-version.test.ts` -- rewrite each header/inline comment at the Code Map's sites: these are node-project suites that execute pure logic and source-scan the wiring; the mounted half, where one exists, lives in the `dom` project -- point readers at the real split instead of a retired constraint.
- `SCHEMA.md` -- inside `## Talk pages (Phase 2)` only: mark the five `/api/wiki/:slug/discuss…` routes and the Discussion tab retired, mirroring the contributor-profiles paragraph pair (`**Retired surfaces:**` naming `RETIRED_SURFACES`/`retiredRoute()`, then `**Still live:**` for `src/lib/talk.ts` and the `discuss/<slug>.json` shape) -- the section reads as a live API today.

**Acceptance Criteria:**
- Given a reader on any file this pass touches, when they look for why a decision was made, then they find the node/dom project split as it exists in `vitest.config.ts` and no claim that the repository lacks a DOM test environment or that mounting is impossible.
- Given the shipped graph page, when a screen-reader user follows its stated text-list alternative, then they reach a live Workbench Knowledge tree route rather than a 404, and that route is named in exactly one place in `src/`.
- Given `SCHEMA.md`, when a reader reaches `## Talk pages (Phase 2)`, then the five discuss routes and the Discussion tab are marked retired with the same treatment contributor profiles already carry, while the `discuss/<slug>.json` storage shape is still documented as live.
- Given `SCHEMA.md`, when `getPageConventions()` loads it after this change, then the `## Page conventions` body it returns is byte-identical to before.
- Given `pnpm test`, when it runs, then every suite passes with no assertion added, removed or weakened outside the new `retired-surfaces.test.ts` block.

## Design Notes

The corrected phrasing should read as a positive statement of the split, not as an apology. Example rewrite for `src/lib/workbench-settings.ts:9-15`:

```
 * That last part is the whole reason the module exists. These are pure
 * functions the `node` project executes directly, so "which categories exist",
 * "may vector search be enabled", "what does Save actually send" and "which
 * sentence does a rejected save show" are each run rather than restated — the
 * rules a rewrite keeps the wording of while changing the behaviour. The `dom`
 * project mounts `SettingsCanvas` itself; what lives here is the decision, not
 * the wiring.
```

Do not add a mounted-coverage inventory to each header — one clause naming the `dom` project is enough, and the inventory would be the next thing to rot.

## Verification

**Commands:**
- `pnpm test` -- expected: full run green, both `node` and `dom` projects reported.
- `pnpm lint` -- expected: no new errors.
- `git diff --stat` -- expected: only the files named in Tasks; `SCHEMA.md` hunks confined to lines within `## Talk pages (Phase 2)`.
- `grep -rn "no DOM test environment" src` -- expected: no matches.
- `grep -n "wiki index" src/app/wiki/graph/page.tsx` -- expected: no matches.

**Manual checks:**
- `git diff SCHEMA.md` shows no hunk above the `## Talk pages (Phase 2)` heading.

## Auto Run Result

Status: done

**Implemented change.** Three prose-drift corrections from the `doc-and-comment-drift-corrections` bundle (DW-108, DW-131, DW-338). Eighteen source and test files stopped claiming this repository has no DOM test environment and now describe the real `node`/`dom` project split in `vitest.config.ts`; the graph canvas's accessibility escape hatch was retargeted from the retired `/wiki` at the Workbench Knowledge tree, spelled once as `KNOWLEDGE_TREE_HREF` and pinned against `RETIRED_SURFACES`; and SCHEMA.md's Talk-pages section marks its five retired discuss routes and the Discussion tab retired, mirroring the DW-129 contributor treatment. The only behavioral change is the graph page's new link; everything else is comments and documentation.

**Files changed.**
- `src/lib/workbench-url.ts` -- new `KNOWLEDGE_TREE_HREF`, derived from `WORKBENCH_MODE_PARAM` and a `WorkbenchModeId`-typed `"wiki"`; stale header claim corrected.
- `src/app/wiki/graph/page.tsx` -- `aria-label`, canvas fallback and a new visible `next/link` all target the Knowledge tree; the page spells no route of its own.
- `src/lib/__tests__/retired-surfaces.test.ts` -- new `describe` (9 tests) pinning the target, the reachable link, the label, the one-canvas invariant and the absence of route literals.
- `src/lib/workbench-data-version.ts`, `workbench-split.ts`, `workbench-settings.ts`, `workbench-preview.ts` -- justification prose rewritten to the node/dom split.
- `src/components/workbench/TreePanel.tsx`, `PreviewColumn.tsx`, `SettingsCanvas.tsx`, `SplitHandle.tsx`, `Workbench.tsx` -- same; `TreePanel`'s ARIA-tree rationale restated as the design choice it is.
- `src/lib/__tests__/workbench-preview.test.ts`, `workbench-settings.test.ts`, `workbench-split.test.ts`, `wiki-schema-edit.test.ts`, `workbench-url.test.ts`, `workbench-chrome.test.ts`, `workbench-left-column.test.ts`, `workbench-data-version.test.ts` -- headers and inline banners rewritten; no assertion added, removed or weakened.
- `SCHEMA.md` -- `## Talk pages (Phase 2)` only: past-tense opening plus a `**Retired surfaces:**` / `**Still live:**` pair.

**Review findings breakdown.** 10 patches applied (medium 6, low 4), 1 item deferred (medium), 7 rejected. No intent gaps, no spec repairs.

**Follow-up review recommendation.** `true`. Patched severities: high 0, medium 6, low 4; score = 3x6 + 1x4 = 22, at or above the threshold of 5.

**Verification.**
- `npx vitest run` (the `pnpm test` script; `pnpm` itself errors on this machine with "packages field missing or empty") -- 274 files / 6200 tests pass, both projects reported (231 `node`, 43 `dom`).
- `npx tsc --noEmit` -- exit 0.
- `npx eslint` -- clean apart from three pre-existing `jsx-ast-utils` informational lines.
- `grep -rn "no DOM test environment" src` -- no matches. `grep -n "wiki index" src/app/wiki/graph/page.tsx` -- no matches.
- `git diff -U0 SCHEMA.md | grep '^@@'` -- two hunks, at 128 and 156, both inside `## Talk pages (Phase 2)`; `## Page conventions` (lines 29-125) hashes identical to `HEAD` (`205f1062...`), so `getPageConventions()` returns the same bytes.
- Every new pin was mutation-tested: deleting the visible link, shortening the `aria-label`, hardcoding `href="/?mode=wiki"`, adding a brace-wrapped `href={"/wiki"}`, adding a second canvas (self-closing before, self-closing after, and full element), and making `src/app/page.tsx` import `@/lib/retired` each fail; adding external/`mailto:`/`#anchor` hrefs does not (no false positive).

**Residual risks.**
- `KNOWLEDGE_TREE_HREF` carries only the mode. A returning owner whose browser-local state has the Files tab selected, or the left column collapsed, lands on the Workbench but not on the Knowledge tree. The comment now says so rather than promising otherwise; carrying the tab in the URL would change DW-27's contract and was out of scope.
- The `<a>` inside `<canvas role="img">` is inert for assistive technology (canvas children are presentational, and the fallback renders only where canvas is unsupported). It is kept as the correct fallback for canvas-less clients; the visible `Link` is what the accessibility promise now rests on, and it is the pinned one.
- The graph page has no mounted suite, so the DW-131 fix is pinned by source scan. The spec's **Never** forbade adding mounted coverage in this pass.
- `SCHEMA.md:705` still says Phase 2 (talk pages) is complete, contradicting the new retired block. Pre-existing and already tracked as DW-339; out of scope by intent.
