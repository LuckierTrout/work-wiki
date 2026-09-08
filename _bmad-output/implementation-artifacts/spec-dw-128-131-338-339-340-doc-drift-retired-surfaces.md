---
title: 'Doc drift on retired surfaces, and the graph canvas escape hatch (DW-128, DW-131, DW-338, DW-339, DW-340)'
type: 'chore'
created: '2026-08-27'
baseline_revision: 'e84d842f730c7d6bc04fb671f6fd25322700a7fd'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The graph-page source scan parses the `<canvas>` opening tag with
      `<canvas\b[^>]*>`, which any `>` inside a prop breaks.
    evidence: |-
      `canvasSpan()`/`canvasFallback()` in
      src/lib/__tests__/retired-surfaces.test.ts stop the opening tag at the
      first `>`. An inline arrow prop (`onClick={(e) => handleClick(e)}`) would
      end the match at the `=>`, so `canvasFallback()` would return attribute
      text concatenated with the real fallback and the fallback/copy assertions
      would silently measure props instead of markup — a false pass, not a
      failure. No canvas prop is an arrow today, so the pin holds as written.
      Inherited verbatim from f342e2f1; a brace/quote-aware scan would fix it.
    location: >-
      src/lib/__tests__/retired-surfaces.test.ts:216
    severity: medium
  - summary: >-
      The DW-131 escape hatch is pinned only by regex over the page's source
      text; no test renders the page and asserts a reachable link.
    evidence: |-
      All nine DW-131 assertions `fs.readFile` the `.tsx` and regex it. A
      reviewer demonstrated that adding `aria-hidden="true" tabIndex={-1}` to
      the visible `<Link>` keeps all 56 tests green while pruning the only
      reachable alternative from the accessibility tree — the exact defect
      DW-131 exists to prevent. `vitest.config.ts` already defines a jsdom
      `dom` project over `src/**/__tests__/**/*.test.tsx` carrying mounted
      a11y suites (e.g. single-main-landmark-mounted.test.tsx), so a
      `getByRole("link", { name: /Knowledge tree/ })` check is available.
    location: >-
      src/lib/__tests__/retired-surfaces.test.ts:192
    severity: medium
  - summary: >-
      Nothing pins the Knowledge *tab* itself, only the route the escape hatch
      points at.
    evidence: |-
      The new pins reference `RETIRED_SURFACES`, `src/app/page.tsx` and the
      mode param; none references `TREE_TABS`, `DEFAULT_TREE_TAB`, `TreePanel`
      or `buildKnowledgeTree`. Removing or renaming the Knowledge tab, or
      changing `DEFAULT_TREE_TAB`, leaves every assertion passing while the
      copy's promise of "a text list of this wiki's pages" stops being kept.
      DW-131's decision said to pin the new target "so it cannot rot into
      another retired route" — the route is pinned, the tree is not.
    location: >-
      src/lib/__tests__/retired-surfaces.test.ts:255
    severity: medium
  - summary: >-
      The graph canvas is keyboard-focusable and click-activated with no
      keyboard activation path.
    evidence: |-
      src/app/wiki/graph/page.tsx:186 sets `tabIndex={0}` on a canvas that has
      `onClick`/`onMouseMove`/`onMouseLeave` and no `onKeyDown`. A keyboard-only
      user gets a focus stop that does nothing on Enter or Space. Pre-existing
      and untouched by this pass, which fixed the screen-reader escape hatch on
      the same element.
    location: >-
      src/app/wiki/graph/page.tsx:186
    severity: medium
  - summary: >-
      `KNOWLEDGE_TREE_HREF` carries no lens scope, while the graph it is an
      alternative to is scoped by `?scope=`.
    evidence: |-
      The graph renders `mine`, a vault, or another owner's silo. The href is
      `/?mode=wiki` with no scope, so a reader following it from a scoped graph
      lands on their own active Wiki's tree — a different set from the one they
      could not see. The restored comment addresses the "this wiki's pages" vs
      "all pages" wording but not the scope mismatch.
    location: >-
      src/lib/workbench-url.ts:59
    severity: low
  - summary: >-
      `ensureDiscussDir()`'s doc comment still says it creates the directory,
      above an empty no-op body.
    evidence: |-
      src/lib/talk.ts:63 reads "Creates the `discuss/` directory if it doesn't
      exist" over a body whose only content is
      `/* Storage provider creates parent directories on write — no-op. */`.
      This pass corrected SCHEMA.md about exactly this fact and left the comment
      a caller actually reads as the stale one.
    location: >-
      src/lib/talk.ts:63
    severity: low
  - summary: >-
      `.yoyo/status.md`'s header metrics are far staler than the two lines this
      pass pinned.
    evidence: |-
      `**Generated:** 2026-06-02`, `- **API routes:** 32` (148 `route.ts` files
      under src/app/api), `- **Test files:** 58` (325), `- **Test count:**
      2,054` (7,461 passing). Pinning the MCP tool list and the lint-check list
      makes the surrounding metrics read as maintained when they are not.
    location: >-
      .yoyo/status.md:4
    severity: low
  - summary: >-
      DESIGN-triggers.md contradicts itself on lint-check counts, and none of
      the three numbers is pinned.
    evidence: |-
      `:141` and `:404` say "15 lint check types"; `:454` says "lint checks
      already detect 14 condition types". 15 matches `ALL_CHECK_TYPES`
      (src/lib/lint-types.ts) today, so `:454` is the wrong one — but all three
      are hand-written, and the file's only pin is the MCP tool count in
      mcp-annotations.test.ts.
    location: >-
      DESIGN-triggers.md:454
    severity: low
---

<intent-contract>

## Intent

**Problem:** Five documentation and copy surfaces still describe retired surfaces as
live. `SCHEMA.md` documents all five `/api/wiki/:slug/discuss…` routes plus the
Discussion UI as shipping features and then calls talk pages and contributor profiles
complete in its roadmap; `DESIGN-triggers.md` designs two trigger types on talk-thread
events; `.yoyo/status.md` advertises `list_contributors`, `get_contributor` and four
discussion MCP tools inside a tool count of 31 (the real count is 40). Worst of the
five is user-facing: the graph canvas's `aria-label` and `<canvas>` fallback — the only
accessible alternative to the visualization — send screen-reader users to `/wiki`,
which is `RETIRED_SURFACES[0]` and answers 404.

**Approach:** Prose-only corrections stating verified current behaviour, plus recovery
of the DW-131/DW-338 fixes that commit `f2458e18` reverted: restore
`KNOWLEDGE_TREE_HREF` and the graph page's link to it from `f342e2f1`, and pin the
corrected `.yoyo/status.md` tool list to the real MCP registration so the count cannot
silently re-stale.

## Boundaries & Constraints

**Always:** Preserve each document's voice, heading structure and ~80-column wrap. State
current behaviour verified against the Code Map, not a changelog — except where the
surrounding document already narrates history, in which case match it. Where a surface
is retired, say so and point at `src/lib/retired.ts` the way the codebase already does.
Restored text from `f342e2f1` must be re-checked against today's code before it lands.

**Block If:** A restored sentence from `f342e2f1` contradicts today's code and the
correct replacement is not derivable from the Code Map.

**Never:** Do not change runtime behaviour beyond the graph page's link/copy. Do not
delete or re-retire `src/lib/talk.ts`, `src/lib/contributors.ts`,
`src/lib/contributor-index.ts` or `src/lib/discuss-stats-index.ts` — all still live. Do
not retire any surface, restore the unrelated DW-108 comment edits that `f2458e18` also
reverted, rewrite unrelated roadmap/PRD paragraphs, or edit
`_bmad-output/implementation-artifacts/deferred-work.md`. Do not touch
`DESIGN-triggers.md:141` or `:402` — those cite talk pages as *detection* infrastructure,
which is still true (the readers and the `unresolved-discussions` lint check are live).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Screen reader on the graph page | Canvas renders; `role="img"` prunes its children | `aria-label` names the Workbench Knowledge tree, and a real `<Link href={KNOWLEDGE_TREE_HREF}>` sits *outside* the canvas where the a11y tree can reach it | No error expected |
| Client cannot render `<canvas>` | Fallback child is exposed | Fallback text is a plain `<a href={KNOWLEDGE_TREE_HREF}>` to the same live route | No error expected |
| Workbench route later retired | Its pathname joins `RETIRED_SURFACES`, or `src/app/page.tsx` starts importing `@/lib/retired` | `retired-surfaces.test.ts` fails | Test failure, not a silent 404 |
| Graph page hand-writes a route again | Any `href` string literal starting with `/` in the file | `retired-surfaces.test.ts` fails | Test failure |
| An MCP tool is added or removed | `src/mcp.ts` registration count changes | `mcp-annotations.test.ts` fails on `.yoyo/status.md` until its count and name list are updated | Test failure |

</intent-contract>

## Code Map

**Recover from `f342e2f1` (reverted by `f2458e18`) — re-verify, do not paste blind:**

- `src/lib/workbench-url.ts:27` -- `f2458e18` deleted `KNOWLEDGE_TREE_HREF` and its
  `KNOWLEDGE_TREE_MODE` constant from just after `WORKBENCH_MODE_PARAM`. Restore both
  verbatim from `git show f342e2f1:src/lib/workbench-url.ts`. Restore *only* the
  constants — the module header prose `f2458e18` also changed is DW-108, out of scope.
  Verified still true: `"wiki"` is a `WorkbenchModeId` (`src/lib/workbench-modes.ts:12`).
- `src/app/wiki/graph/page.tsx:146-166` -- restore the `next/link` and
  `KNOWLEDGE_TREE_HREF` imports, the explanatory comment block, the visible link
  paragraph, the `aria-label`, and the `<a href={KNOWLEDGE_TREE_HREF}>` canvas fallback
  from `git show f342e2f1:src/app/wiki/graph/page.tsx`. Current stale copy: `:161`
  `aria-label="… Visit the wiki index for a text-based list of all pages."` and `:164`
  `"… see wiki index for accessible page listing."`.
- `src/lib/__tests__/retired-surfaces.test.ts:171` -- restore the deleted
  `describe("the graph canvas's text-list alternative is a live route", …)` block and
  its `KNOWLEDGE_TREE_HREF, WORKBENCH_MODE_PARAM, readModeFromSearch` import from
  `git show f342e2f1:src/lib/__tests__/retired-surfaces.test.ts`. It reinserts between
  the existing `describe("retired helpers")` and the `syncCommonsForPage is inert`
  banner comment. Its `APP_DIR` helper is still defined in the current file.
  Verified still true: `src/app/page.tsx` exists and does not import `@/lib/retired`.

**Verified current state (write fresh prose, the `f342e2f1` text is now wrong):**

- `SCHEMA.md:126-167` -- the Talk pages section. Its `**API routes:**` list and `**UI:**`
  paragraph are false: all four `discuss` route files are `retiredRoute()` bodies
  (`src/app/api/wiki/[slug]/discuss/route.ts`, `…/[threadIndex]/route.ts`,
  `…/comments/route.ts`, `…/ask-yoyo/route.ts`) and the five method+route pairs plus
  ask-yoyo are `RETIRED_SURFACES` entries (`src/lib/retired.ts:37-41`). `/wiki` and
  `/wiki/[slug]`, which carried the Discussion tab and badge counts, are entries too
  (`:23-24`). `**Location:**` is also false: `ensureDiscussDir()`
  (`src/lib/talk.ts:64-66`) is an explicit no-op — the storage provider creates parents.
  **Caveat:** `f342e2f1`'s replacement prose claimed the thread-writing half of
  `talk.ts` "was deleted (DW-390)". `f2458e18` restored it — `listThreads`, `getThread`,
  `createThread`, `addComment`, `resolveThread`, `hasOpenThread` are all exported today
  (`src/lib/talk.ts:123-323`) with **no non-test callers**. Say that, not "deleted".
  Still live and worth keeping in the section: `getDiscussionStatsForSlugs`
  (`src/lib/talk.ts:325`, called by `src/lib/browse.ts:184`), `deleteDiscussions`
  (`:390`, called by `src/lib/lifecycle.ts:677`), `src/lib/discuss-stats-index.ts`, and
  `src/lib/contributors.ts`'s scan of the same files.
- `SCHEMA.md:694` -- "Phase 1 (schema evolution) and Phase 2 (talk pages + attribution)
  are complete." Contradicts the retired-surfaces blocks at `:126-167` and `:193-201`.
- `SCHEMA.md:702` -- "…and contributor profiles are implemented." Same contradiction;
  `:193-201` (already corrected by DW-129) is the wording to align with.
- `DESIGN-triggers.md:190-191` -- the proposed `WikiTrigger["on"]` union includes
  `"discussion-opened" | "discussion-resolved"`.
- `DESIGN-triggers.md:316-317` -- the trigger-type table repeats both rows ("A new talk
  thread is created", "A talk thread is resolved"). Both sit inside the
  `### 3.5 Schema section for SCHEMA.md (proposed)` block, which the doc already frames
  as a proposal for a future implementer.
- `.yoyo/status.md:15` -- `- **MCP tools:** 31 (…)`. Names `list_contributors`,
  `get_contributor`, `list_discussions`, `create_discussion`, `resolve_discussion`,
  `add_comment` (all retired, pinned absent at
  `src/lib/__tests__/mcp-annotations.test.ts:64-77`) and `batch_ingest` (renamed
  `batch_ingest_urls`); omits 15 tools that do exist.
- `.yoyo/status.md:25` -- the Phase 4 row's "MCP server (31 tools)" repeats the count.
- `src/mcp.ts` -- 40 `server.registerTool(…)` calls, in order: `search_wiki`,
  `read_page`, `list_pages`, `create_page`, `update_page`, `update_metadata`,
  `delete_page`, `merge_pages`, `ingest_url`, `batch_ingest_urls`, `ingest_text`,
  `ingest_x_mention`, `ingest_pdf`, `ingest_image`, `query_wiki`, `save_query_answer`,
  `query_history`, `agent_context`, `seed_agent`, `list_agents`, `update_agent`,
  `delete_agent`, `lint_wiki`, `fix_lint_issue`, `reingest`, `ingest_history`,
  `dataview_query`, `list_revisions`, `read_revision`, `revert_revision`, `wiki_graph`,
  `vault_curate`, `vault_uncurate`, `list_vaults`, `vault_pages`, `vault_create`,
  `vault_rename`, `vault_delete`, `maintenance_scan`, `activity_trail`.
- `src/lib/__tests__/mcp-annotations.test.ts:41-62` -- the existing `it.each` count pin
  over `public/agent-api.md`, `src/lib/mcp-http.ts`, `DESIGN-triggers.md`. It matches
  `\b(\d+) tools\b`, so it catches `.yoyo/status.md:25` but *not* `:15`'s
  `**MCP tools:** 40 (…)` — the name list needs its own assertion.

## Tasks & Acceptance

**Execution:**

- `src/lib/workbench-url.ts` -- restore `KNOWLEDGE_TREE_MODE` and the exported
  `KNOWLEDGE_TREE_HREF` (with their doc comments) from `f342e2f1`, after
  `WORKBENCH_MODE_PARAM` -- one spelling of the Workbench route for any copy offering a
  readable alternative to a visual surface.
- `src/app/wiki/graph/page.tsx` -- restore the `f342e2f1` imports, comment, visible
  `<Link>`, `aria-label` and `<a>` canvas fallback, all targeting
  `KNOWLEDGE_TREE_HREF` -- DW-131: the graph's only accessible escape hatch currently
  404s, and the 2026-08-19 decision names the Knowledge tree as the replacement.
- `src/lib/__tests__/retired-surfaces.test.ts` -- restore the `f342e2f1` DW-131
  `describe` block and its `../workbench-url` import -- pins the escape hatch against
  `RETIRED_SURFACES` so the next retirement fails a test instead of the reader.
- `SCHEMA.md` -- rewrite the Talk pages section's `**Location:**`, `**API routes:**` and
  `**UI:**` blocks as a `**Retired surfaces:**` / `**Still live:**` pair matching the
  contributor section's existing shape at `:193-201`, using the verified caveat above
  (the write half is present but caller-less, not deleted) -- DW-338.
- `SCHEMA.md` -- amend `:694` and `:702` so the Phase 2 / Phase 4 roadmap prose says the
  talk-page and contributor *product surfaces* were cut while the storage, readers and
  attribution remain -- DW-339, so the roadmap stops contradicting the same file's own
  retired-surfaces blocks.
- `DESIGN-triggers.md` -- drop `discussion-opened` / `discussion-resolved` from the `on`
  union at `:190-191` and their two rows from the table at `:316-317`, and add one short
  note in the doc's voice recording that talk-thread events retired with the commons
  (`src/lib/retired.ts`) -- DW-340, so an implementer building §3.5 does not design
  against dead events.
- `.yoyo/status.md` -- replace `:15`'s count and parenthetical with the real 40 tools in
  `src/mcp.ts` registration order, and correct `:25`'s "(31 tools)" -- DW-128.
- `src/lib/__tests__/mcp-annotations.test.ts` -- add `.yoyo/status.md` to the existing
  count-pin `it.each` list, and add one test asserting the `**MCP tools:**` line's
  parenthetical names exactly the registered tool set -- the count alone would not have
  caught the six retired names DW-128 reported.

**Acceptance Criteria:**

- Given a reader of `src/app/wiki/graph/page.tsx`, when they search it for an `href`
  string literal beginning with `/`, then they find none — every route comes from
  `KNOWLEDGE_TREE_HREF`.
- Given `KNOWLEDGE_TREE_HREF`, when its pathname is checked against `RETIRED_SURFACES`
  and against the App Router tree, then it is absent from the list and its backing
  `page.tsx` exists and does not import `@/lib/retired`.
- Given the graph page's accessible copy (`aria-label`s plus the canvas fallback), when
  it is scanned, then it names the Knowledge tree, contains no `RETIRED_SURFACES` entry,
  and contains no "wiki index".
- Given `SCHEMA.md`, when a reader searches it for `/api/wiki/:slug/discuss`, then every
  occurrence is described as retired and points at `src/lib/retired.ts`.
- Given `SCHEMA.md`'s Planned evolution section, when it is read against the Talk pages
  and Contributor profiles sections in the same file, then no sentence calls a retired
  product surface complete or implemented.
- Given `DESIGN-triggers.md`, when a reader searches it for `discussion-opened` or
  `discussion-resolved`, then the only occurrences are in the note explaining that those
  events retired — not in the proposed schema or trigger-type table.
- Given `.yoyo/status.md`, when its `**MCP tools:**` list is compared to
  `src/mcp.ts`'s registrations, then the count and the names match exactly, and
  `mcp-annotations.test.ts` fails if either drifts.
- Given the full suite, when `npx vitest run` completes, then no test regresses relative
  to `e84d842f`.

## Spec Change Log

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 8: (high 0, medium 4, low 4)
- reject: 11: (high 0, medium 1, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `KNOWLEDGE_TREE_MODE` was unpinned — the mode assertion only required *some* valid `WorkbenchModeId`, so flipping it to `"graph"` or `"chat"` kept all 56 tests green while silently retargeting the accessibility escape hatch at another visual surface. Tightened to pin `"wiki"`; mutation-tested (flip now fails).
  - `[medium]` `[patch]` SCHEMA.md's `**Still live:**` paragraph presented `getDiscussionStatsForSlugs()` → `src/lib/browse.ts` as a live call chain, but `browse.ts` has no non-test importers and `/api/wiki/browse` is a `RETIRED_SURFACES` entry. Split out a `**Present but unreached:**` paragraph applying the same caller-less caveat the spec required for `talk.ts`'s write half.
  - `[medium]` `[patch]` `.yoyo/status.md:22` still asserted the retired Discussion UI, contributor badges and contributor profiles as ✅ Complete — the same claim DW-339 corrects in SCHEMA.md, in the file DW-128 covers, one row above a cell this pass had already edited. Reframed both the Phase 2 and Phase 4 rows as shipped-then-cut.
  - `[low]` `[patch]` SCHEMA.md called six method+route pairs "entries in `RETIRED_SURFACES`"; the list holds four routes. Reworded to distinguish the four listed routes from the six methods they once served.
  - `[low]` `[patch]` SCHEMA.md's Talk pages section still opened in the present tense ~30 lines above its own retirement block. Rewritten so the opening sentence carries the retirement.
  - `[low]` `[patch]` `.yoyo/status.md:16` advertised 16 lint checks including the retired `unresolved-discussions`; `ALL_CHECK_TYPES` has 15 without it. Corrected the count and list (and the same stale count in the Phase 1 cell, which would otherwise have contradicted it).
  - `[low]` `[patch]` The new `.yoyo/status.md` name pin used an anchored single-line regex that would fail with a misleading message if that line were ever wrapped to the ~80-column convention the spec itself imposes. Now flattens whitespace like the count pin above it; mutation-tested against a 78-column re-wrap.
  - `[low]` `[patch]` `mcp-annotations.test.ts` read as self-contradicting ("five discussion tools" vs. "four"). Disambiguated which set the new comment means.

## Design Notes

The five entries share one recovery rule: `f2458e18` ("sweep
dw3-embedding-readiness-truthfulness") reverted 16,429 lines across 151 files, taking
already-shipped DW-131/DW-338 fixes with it. Recover from `f342e2f1` rather than
re-deriving — but `f2458e18` also *restored* `talk.ts`'s write half, so `f342e2f1`'s
SCHEMA.md sentence about DW-390 deleting `listThreads`/`createThread`/etc. is false
today. That is the one place a verbatim restore would ship a new falsehood; the Code
Map records the replacement fact.

The DW-131 test's load-bearing assertion is the one that checks for a link *outside* the
`<canvas>` span: a `<canvas>` fallback child renders only where canvas is unsupported,
and `role="img"` prunes descendants from the accessibility tree, so the in-canvas link
alone reaches nobody.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/mcp-annotations.test.ts` -- expected: all pass, including the restored DW-131 block and the new `.yoyo/status.md` pins.
- `npx tsc --noEmit` -- expected: zero errors (`KNOWLEDGE_TREE_HREF` is re-exported and re-imported).
- `npx eslint src/app/wiki/graph/page.tsx src/lib/workbench-url.ts src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/mcp-annotations.test.ts` -- expected: clean.
- `npx vitest run` -- expected: no regressions against the `e84d842f` baseline.
- `grep -n "discussion-opened\|discussion-resolved" DESIGN-triggers.md` -- expected: hits only inside the retirement note.

## Auto Run Result

Status: done

**Summary.** Corrected five documentation and copy surfaces that still described retired
surfaces as live, and recovered the DW-131/DW-338 fixes that commit `f2458e18` reverted.
The user-visible half: the graph canvas's `aria-label` and `<canvas>` fallback no longer
send screen-reader users to `/wiki` (a `RETIRED_SURFACES` entry answering 404) — both
now name the Workbench Knowledge tree and take their href from a single
`KNOWLEDGE_TREE_HREF` constant that `retired-surfaces.test.ts` pins against
`RETIRED_SURFACES`, the App Router tree, and the Wiki mode id.

**Files changed:**
- `src/lib/workbench-url.ts` — restored `KNOWLEDGE_TREE_MODE` and the exported `KNOWLEDGE_TREE_HREF` from `f342e2f1`.
- `src/app/wiki/graph/page.tsx` — restored the visible `<Link>`, the Knowledge-tree `aria-label`, and the `<a>` canvas fallback, all targeting the constant.
- `src/lib/__tests__/retired-surfaces.test.ts` — restored the nine DW-131 pins, with the mode assertion tightened to `"wiki"`.
- `SCHEMA.md` — Talk pages section rewritten as retired-surfaces / still-live / present-but-unreached; `**Location:**` corrected (`ensureDiscussDir()` is a no-op); Planned evolution no longer calls the talk-page and contributor product surfaces complete.
- `DESIGN-triggers.md` — `discussion-opened` / `discussion-resolved` dropped from the proposed `on` union and the trigger table, with a note recording why.
- `.yoyo/status.md` — MCP tool list and count corrected to the real 40; lint-check list corrected to the real 15; Phase 2 and Phase 4 rows reframed as shipped-then-retired.
- `src/lib/__tests__/mcp-annotations.test.ts` — `.yoyo/status.md` added to the tool-count pin, plus a new set-equality pin over the tool-name list.

**Review findings:** 8 patches applied (0 high, 3 medium, 5 low), 8 items deferred
(4 medium, 4 low), 11 rejected. No intent gaps and no spec defects.

**Follow-up review recommended:** `true` — patched severities 0 high / 3 medium / 5 low,
score `3 × 3 + 1 × 5 = 14`, at or above the threshold of 5.

**Verification:**
- `npx vitest run src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/mcp-annotations.test.ts` — 103 passed.
- `npx vitest run` — 325 files, 7,461 passed, 1 skipped, 0 failed; no regressions against `e84d842f`.
- `npx tsc --noEmit` — exit 0. `npx eslint` on the four changed source files — exit 0.
- `grep -n "discussion-opened\|discussion-resolved" DESIGN-triggers.md` — one hit, inside the retirement note.
- `grep -n "href=" src/app/wiki/graph/page.tsx` — both hrefs are `{KNOWLEDGE_TREE_HREF}`; no `/`-prefixed literals.
- Every I/O matrix row is covered by a named test that ran and passed in the targeted run.

**Residual risks:**
- The accessibility fix is asserted by regex over the page's source, not by rendering it — see the deferred entry; a benign refactor (`aria-label={label}`, extracting the paragraph into a component) would break the pins, and an `aria-hidden` wrapper would defeat them.
- The escape hatch guarantees the Workbench *surface*, not the Knowledge *tab*: a returning owner whose stored tree tab is Files, or whose left column is collapsed, lands on a shell that is not showing the list. This is DW-27's URL rule, stated openly in `KNOWLEDGE_TREE_HREF`'s docblock, not a defect introduced here.
- One pre-existing DOM timing flake was observed once mid-run (`workspace-purpose-settings.test.tsx`, DW-136 recheck) and passed on re-run and in isolation. No overlap with this diff, but it may resurface in CI.
