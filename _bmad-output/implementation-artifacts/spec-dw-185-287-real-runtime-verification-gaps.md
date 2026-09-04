---
title: 'DW-185 / DW-287 — settle the two runtime-only claims with real checks'
type: 'chore'
created: '2026-09-04'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The browser half of the two-halves CSS rule this change introduces runs in no
      automated lane — `pnpm test:e2e` is not in CI, so a cascade, geometry or
      hit-test regression is caught only when someone runs it by hand.
    evidence: |-
      `.github/workflows/ci.yml` runs `tsc --noEmit`, `pnpm lint`, `pnpm test`,
      `pnpm build` and `pnpm build:cloudflare`, and no `pnpm test:e2e` step;
      `AGENTS.md` records the Playwright lane as "Not in CI; run it locally".
      No assertion was removed by this change — the stylesheet scans still run on
      every `pnpm test` and still fail when a declaration is deleted — so CI's
      detection power is unchanged. What is new is that the resolved-cascade
      claim now exists somewhere, and that somewhere is opt-in. Enrolling the
      lane needs a CI dev server and browser install, which is the same
      project-level decision DW-185 was originally waiting on.
    location: >-
      .github/workflows/ci.yml (no test:e2e step); e2e/workbench-layout.spec.ts
    severity: medium
baseline_revision: '26df2457b05a06a127c2f1dc0c4a458b0914d25f'
---

<intent-contract>

## Intent

**Problem:** Every CSS layout claim in this repo is pinned by a text scan of `globals.css` — the 900px docked-column reachability, the split-handle geometry and the `[data-sheet-open]` counter-rule are asserted as declaration strings inside a stylesheet slice, which cannot show a rule wins the cascade or that a column is reachable (DW-185). Separately, whether assistive technology re-utters on the `U+200B` live-region repeat mark is asserted in prose only, with nothing recording how a human would check it (DW-287).

**Approach:** A Playwright config and `e2e/` already exist, so DW-185's project-level decision is made: add browser specs that lay out the real shell and assert the three claims from computed style, real geometry and real hit-testing, then re-word the corresponding stylesheet scans as structural. For DW-287, record the manual AT procedure the 2026-08-28 decision names beside `live-region.ts` and in the repo's test-strategy section, and say plainly in the mounted suite which half is manual.

## Boundaries & Constraints

**Always:**
- Browser assertions read the RESOLVED result — `getComputedStyle`, `getBoundingClientRect`, `elementFromPoint`, real scrolling — never the stylesheet text again.
- Shared e2e helpers live in a non-collected module under `e2e/fixtures/`; Playwright collects `*.spec.ts` only, so a helper file there is not a suite.
- New comments must avoid the phrasings `src/lib/__tests__/workbench-chrome.test.ts` bans (no claim that the repo has no DOM environment, no describing the runner as one environment). Name the project or the tool instead.
- The manual AT procedure states which AT, which surface, what to hear, and that it is knowingly manual.

**Block If:** Making a layout claim pass requires editing `src/app/globals.css` — a real browser disagreeing with the stylesheet scan is a product bug, not a test-authoring choice, and closing it is outside this bundle.

**Never:**
- Do not add a Vitest browser project, and do not put `e2e/` into CI — AGENTS.md fixes Playwright as the local browser lane.
- Do not weaken or delete the existing stylesheet scans; they keep pinning the declaration text and source order. Only their prose changes.
- Do not change `src/lib/live-region.ts` behaviour, `nextAnnouncement`'s contract, or any shipped copy.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Wide shell, Preview docked | 1280×800, a page selected in the Knowledge tree | Both separators are 24px wide; the tree strip's left edge sits on `.wb-left`'s right edge and the Preview strip's left edge on `.wb-preview`'s left edge; `elementFromPoint` just inside each boundary returns the separator and just outside it does not | No error expected |
| Narrow shell, Preview docked | 800×600, same selection | `.wb-shell` computes `overflow: visible`; the Preview column scrolls into view and is in the viewport | No error expected |
| Narrow shell, Preview docked, sheet open | as above, then `Modes` pressed | `.wb-shell` computes `overflow: hidden`, and a scroll attempt leaves `window.scrollY` at 0; closing the sheet restores `overflow: visible` | No error expected |
| Narrow shell, collapsed + Preview + sheet | collapsed on a wide viewport, then resized narrow and `Modes` pressed | The three-attribute counter-rule still wins: `overflow: hidden` | No error expected |
| Live-region repeat, AT | a repeated sentence written twice | Node/jsdom prove only the string changed; the utterance is verified by the recorded manual procedure | Not automatable here — documented as manual |

</intent-contract>

## Code Map

- `playwright.config.ts` — `testDir: "./e2e"`, one worker, `next dev` on :4173 with `YOPEDIA_E2E=1` and `DATA_DIR=e2e/.data`. No change needed.
- `e2e/fixtures/owner.ts` — the authenticated `test`/`unsignedTest`/`expect` exports (HMAC cookie, no Clerk). New spec imports from here.
- `e2e/workbench-owner.spec.ts` — currently holds the private helpers `E2E_TENANT_DIR`, `readE2ePage`, `readE2ePageOrEmpty`, `currentWikiId`, `replaceWikiPage`, `seedWikiPages`, `createOwnWiki` (lines ~19–110) plus `seedReviewQueue`. The first seven move to a fixture module; `seedReviewQueue` stays and imports `E2E_TENANT_DIR` + `currentWikiId`.
- `src/app/globals.css` — READ ONLY. `.wb-split-handle` (5221), `--tree` (5307), `--preview` (5313), `::before` (5243); `.wb-shell[data-preview="true"]` (5346); `@media (max-width: 1199px)` (5363, hides handles); `@media (max-width: 899px)` (5413) with the DW-34 clamp release and the `[data-sheet-open]` counter-rule (5449–5455).
- `src/lib/workbench-split.ts` — `SPLIT_HIT_WIDTH = 24` (line 90), `SPLIT_TREE_LABEL`/`SPLIT_PREVIEW_LABEL` (131–132) are the separators' accessible names; `showSplitHandle` (441) gates the Preview separator on `previewOpen`.
- `src/components/workbench/Workbench.tsx` — shell `<div className="wb-shell">` with `data-collapsed` / `data-sheet-open` / `data-preview` (1652–1661); the `Modes` button toggling `sheetOpen` (1675–1685). `previewDocked` from a tree selection (398–401).
- `src/components/workbench/TreePanel.tsx` — Knowledge is the first tab and groups are open by default; each page is a `button.wb-tree-row` labelled by its title (367–381). Clicking one docks the Preview.
- `src/components/workbench/IconRail.tsx` — `.wb-rail-chevron`, `aria-label` `Collapse left column` / `Expand left column` (155–162). It is `display: none` below 900px, so a collapse must be performed wide and then the viewport resized.
- `src/lib/__tests__/workbench-left-column.test.ts` — the scan to re-word: `it("releases the shell's clamp below 900px so a docked column is reachable")` at 1574, inside `describe("globals.css docks the Preview as a fourth column")` at 1538.
- `src/lib/__tests__/workbench-split.test.ts` — the scans to re-word: `describe("globals.css positions the divider from the grid's own properties")` at 1811, `it("reads --wb-tree and --wb-preview for the handle positions")` at 2039, `it("gives the handle the box the pointer path depends on")` at 2089.
- `src/lib/live-region.ts` — `LIVE_REGION_REPEAT_MARK` (45), `nextAnnouncement` (60), `announcementSentence` (76). Callers: `Workbench.tsx:296` (shell region, `p.wb-sr-only[aria-live="polite"]` at 2018) and `PreviewColumn.tsx:713/767/1211` (column region at 1501).
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — header `COVERAGE LIMIT` note (~43) and the repeat-mark cases at 1004–1021 and 1023–1043.
- `AGENTS.md` — `## Test environments` sits OUTSIDE the `bmad:context` markers (closed at line 30), so additions there survive a context refresh. The Playwright bullet is at 114–118.
- `src/lib/__tests__/workbench-chrome.test.ts` — `RETIRED_DOM_CLAIMS` (680–688) scans `src/`, `e2e/`, `AGENTS.md` and the vitest configs with comment-wrapping undone. Every file this spec touches is in that scan.

## Tasks & Acceptance

**Execution:**
- `e2e/fixtures/wiki.ts` -- new: move `E2E_TENANT_DIR`, `readE2ePage`, `readE2ePageOrEmpty`, `currentWikiId`, `seedWikiPages`, `createOwnWiki` out of `workbench-owner.spec.ts` and export them (`replaceWikiPage` stays module-private) -- a second spec needs the same seeding, and a copied helper is the drift this repo keeps filing.
- `e2e/workbench-owner.spec.ts` -- delete the moved helpers and import them from `./fixtures/wiki`; keep `seedReviewQueue` -- one definition, both specs.
- `e2e/workbench-layout.spec.ts` -- new: the three browser cases plus the collapsed variant, asserting computed style, geometry, hit-testing and real scrolling -- this is the check DW-185 was waiting for.
- `src/lib/__tests__/workbench-left-column.test.ts` -- re-word the 900px case (title and comment) as a structural scan and name `e2e/workbench-layout.spec.ts` as where the reachability itself is observed; leave every assertion intact -- the scan's claim, not its coverage, was the overstatement.
- `src/lib/__tests__/workbench-split.test.ts` -- same re-wording for the divider-geometry describe block and its two geometry cases -- same reason.
- `src/lib/live-region.ts` -- append a manual AT verification procedure to the module comment: which AT, which surface, what to hear, and that it is knowingly manual -- the mechanism's last half has no automated home, so the procedure has to live where the mechanism does.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` -- state in the header and at the repeat-mark cases that these prove the region's string changed and that the utterance is the manual procedure's half -- so the suite stops reading as if the mechanism were proven end to end.
- `AGENTS.md` -- extend the Playwright bullet in `## Test environments` with the layout spec's role and the manual AT procedure's location -- it is this repo's test-strategy document and it sits outside the refreshed block.

**Acceptance Criteria:**
- Given a signed-in owner with a seeded page and a docked Preview at 1280×800, when `e2e/workbench-layout.spec.ts` runs, then each separator measures `SPLIT_HIT_WIDTH` wide, its left edge coincides with its column boundary within a pixel, and a point just inside the boundary hit-tests to the separator while a point just outside it does not.
- Given the same shell at 800×600 with a docked Preview, when the spec inspects the shell, then `getComputedStyle(shell).overflow` is `visible` and the Preview column can be scrolled into the viewport.
- Given that narrow shell with the `Modes` sheet open, when the spec inspects the shell and tries to scroll the document, then `overflow` computes to `hidden` and `window.scrollY` stays 0; closing the sheet returns `overflow` to `visible`.
- Given a shell collapsed while wide and then resized below 900px with a docked Preview and the sheet open, when the spec inspects the shell, then `overflow` still computes to `hidden`.
- Given `pnpm test`, when the suite runs, then every existing stylesheet-scan assertion still passes and `workbench-chrome.test.ts`'s retired-claim scan reports no offender in the edited files.
- Given a reader of `src/lib/live-region.ts` or `AGENTS.md`, when they look for how the repeat mark is verified, then they find a named AT, a named surface, the sentence to listen for, and a statement that this half is manual.

## Design Notes

The browser cases must anchor on things the stylesheet scan cannot reach:

```ts
const shell = page.locator(".wb-shell");
await expect(shell).toHaveAttribute("data-preview", "true");
// The cascade, resolved — not the declaration text.
await expect(shell).toHaveCSS("overflow", "visible");
await preview.scrollIntoViewIfNeeded();
await expect(preview).toBeInViewport();
```

Geometry is compared between two live boxes rather than against a retyped number, except for the strip width, which is checked against `SPLIT_HIT_WIDTH` imported from `src/lib/workbench-split.ts` — the same import `workbench-owner.spec.ts` already makes of shared copy constants.

`elementFromPoint` is what makes the hit-testing claim real: the strip is 24px of `z-index: 2` and it must start AT the boundary and extend right of it, so the scrollbar to its left stays clickable.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean.
- `pnpm exec eslint e2e src/lib/live-region.ts` -- expected: clean.
- `pnpm test` -- expected: the full Vitest run passes, including the re-worded scans and the retired-claim scan over `e2e/` and `AGENTS.md`.
- `pnpm test:e2e workbench-layout` -- expected: every case in the new spec passes against a real Chromium.
- `pnpm test:e2e` -- expected: the pre-existing specs still pass after the helper move.

## Auto Run Result

Status: done

### Summary

DW-185 and DW-287 both closed as their recorded decisions describe.

DW-185: `e2e/workbench-layout.spec.ts` (new, 7 cases) settles in a real browser the three claims the stylesheet scans could only state — separator geometry measured between live boxes and hit-tested with `document.elementFromPoint`, the 900px clamp release read through `getComputedStyle` and exercised with a real document scroll, and the `[data-sheet-open]` counter-rule proved to outrank both the two- and three-attribute docked selectors. Every assertion reads a resolved value; none re-parses `globals.css`. The corresponding node scans keep every assertion and are re-worded as structural, each naming the browser spec as where the resolved result is observed.

DW-287: the manual AT procedure the 2026-08-28 decision names is recorded in `src/lib/live-region.ts`'s header — which AT, which two regions, which gestures, what to hear, and that the utterance half is knowingly manual — and in `AGENTS.md`'s test-strategy section. `preview-announcements.test.tsx` now says plainly that it proves the region's string was re-written, not that a screen reader spoke.

One repair outside the bundle's scope was required and is reported as such: the e2e lane could not run at all. `src/lib/research-panel.ts` (imported by four Workbench canvases) value-imported two constants from `src/lib/research-projects.ts`, dragging `./storage` and `node:fs/promises` into the browser graph; Turbopack refused to chunk it and `next dev` rendered nothing, so every browser spec — the pre-existing ones included — failed. Introduced 2026-09-03 by commit bd8ed03e on this branch. The two constants moved to a new leaf module, `src/lib/research-contract.ts`, which imports nothing; `research-projects.ts` re-exports both names so no existing import site changed. Verified by reverting only those three files: all layout cases fail, `createOwnWiki` never sees the Wiki heading.

### Files changed

- `e2e/workbench-layout.spec.ts` (new) — the seven browser cases for DW-185's three claims, plus the negative controls.
- `e2e/fixtures/wiki.ts` (new) — the wiki-seeding helpers lifted out of `workbench-owner.spec.ts` so both specs share one definition, plus `resetOwnerTenant()`.
- `e2e/workbench-owner.spec.ts` — helpers deleted and imported; `beforeAll` reset so it no longer depends on file order.
- `src/lib/research-contract.ts` (new) — `REPAIR_HINT` and `URL_MAX_CHARS`, in a module that imports nothing.
- `src/lib/__tests__/research-contract-client-safety.test.ts` (new) — pins that invariant in the always-run node lane.
- `src/lib/research-panel.ts` — takes both constants from the leaf module; the `research-projects` import stays type-only.
- `src/lib/research-projects.ts` — imports both from the leaf module and re-exports them.
- `src/lib/__tests__/workbench-left-column.test.ts` — the 900px case re-worded as structural; assertions untouched.
- `src/lib/__tests__/workbench-split.test.ts` — the divider-geometry describe and its two geometry cases re-worded as structural; assertions untouched.
- `src/lib/live-region.ts` — the manual AT procedure. No behaviour change.
- `src/components/workbench/__tests__/preview-announcements.test.tsx` — states which half is proved and which is manual.
- `AGENTS.md` — `## Test environments` gains the two-halves CSS rule, the fixtures convention, and the manual-AT bullet. Outside the `bmad:context` markers, so it survives a refresh.

### Review findings

- Patches applied: 14 (high 1, medium 5, low 8).
- Items deferred: 1 (medium) — the browser half runs in no automated lane.
- Items rejected: 4 — a `toBeInViewport` ratio floor (the `overflow` assertion already catches the regression class, and any ratio would be an arbitrary flake source); an attestation log for the manual procedure (not asked for, and a stale date is its own liability); flipping the ledger entries to resolved (the orchestrator records resolution, and this run was told not to touch the ledger); a repo-wide lint rule against client components value-importing the store (speculative, and the added guard covers the module that actually broke).
- Follow-up review recommended: **true** — one patched finding was high severity (patched counts: high 1, medium 5, low 8; score = true because high > 0).

### Verification performed

- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec eslint e2e src/lib` — clean.
- `pnpm test` — 379 files, 9452 passed, 1 skipped. Includes the re-worded scans, the new client-safety scan, and `workbench-chrome.test.ts`'s retired-claim scan over `e2e/` and `AGENTS.md`.
- `pnpm test:e2e` — 26 passed against a real Chromium, on a clean tree with no temporary edits.
- Both e2e specs also run alone (7 and 10 passing), which is what the `beforeAll` reset buys.
- Every row of the I/O matrix is covered by a case that ran and passed; the AT row's automatable half is covered by the repeat-mark cases in `pnpm test`, and its manual half is documented, which is that row's stated expectation.
- Two mutation checks: reverting `research-panel.ts`'s import fails the new client-safety case; forcing a viewport the shell cannot overflow fails the sheet case's positive control.

### Residual risks

- The e2e lane is not in CI, so the browser half fires only when run by hand (deferred above).
- `touch-action: none` on the grab strip is still pinned by the stylesheet scan alone — no case performs a pointer down/move/up. The comment says so rather than implying the browser settles it.
- The collapse gesture in the layout spec uses `Enter` rather than a click, because `next dev`'s overlay portal occludes the rail's bottom-left corner. A harness artifact, noted in the spec.
- `e2e/.data` is shared by one worker across all specs; the discipline that keeps that safe (`beforeAll` where an empty store is required, `afterAll` where one is dirtied) is convention, not enforcement.
