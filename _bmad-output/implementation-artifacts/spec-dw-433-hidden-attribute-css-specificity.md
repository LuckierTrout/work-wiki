---
title: 'Give the `[hidden]` withdrawal rules a cascade floor (DW-415, recorded as DW-433)'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '144767a4fc2899698ae33bd65f34662aa46eb7c2'
deferred:
  - summary: >-
      The eight `.wb-canvas-pad` mode panes are withdrawn with the same `hidden`
      mechanism but have no backing CSS rule at all, so their withdrawal rests
      on the user-agent default alone.
    evidence: |-
      `src/components/workbench/ModeCanvas.tsx` sets `hidden={mode !== "…" || hidden}`
      on eight `.wb-canvas-pad` divs (lines 185, 206, 218, 233, 249, 263, 280, 299).
      `.wb-canvas-pad` at `src/app/globals.css:2686` declares only `padding` — there is
      no `.wb-canvas-pad[hidden]` rule. The UA sheet's `[hidden] { display: none }` loses
      to ANY author `display` declaration, which is a strictly weaker position than the
      (0,2,0) one DW-415 judged insufficient for the four sibling surfaces. Not caused by
      this change and not named by DW-415, whose scope is the specificity of withdrawal
      rules that already exist; adding a fifth rule is separate work. The new scan
      `every [hidden] withdrawal in the stylesheet carries the floor` would enforce the
      floor on such a rule the moment one is written, but cannot require that it exist.
    location: src/app/globals.css:2686 / src/components/workbench/ModeCanvas.tsx:185
    severity: medium
  - summary: >-
      On Node 26 the vitest dom project cannot run at all — `window.localStorage`
      is undefined, so 229 tests across 13 files die in `beforeEach`.
    evidence: |-
      Every failure is `TypeError: Cannot read properties of undefined (reading 'clear')`
      at `window.localStorage.clear()`. Identical at `baseline_revision` 144767a4 and
      after this change (13 failed files / 229 failed tests both times, +3 passing from
      the new suite). On Node 22.16.0 — the version `.github/workflows/ci.yml` pins — the
      full suite is green: 337 files / 7731 passed, 1 skipped. Raw jsdom 30.0.1 with an
      http URL does provide `localStorage`, so the gap is in how the vitest jsdom
      environment exposes it under Node 26, not in jsdom itself. Not a repository defect
      and not caused by this change, but it makes local verification on a current Node
      look catastrophically broken, and `AGENTS.md` "Test environments" does not warn of it.
    location: vitest.config.ts (dom project) / AGENTS.md "Test environments"
    severity: low
---

<intent-contract>

## Intent

**Problem:** The four `[hidden]` withdrawal rules in `src/app/globals.css` declare a bare `display: none` at specificity (0,2,0). The same stylesheet already writes (0,3,0) shell-scoped rules that set `display` (`.wb-shell[data-collapsed="true"] .wb-left`), so one future `.wb-shell[data-preview="true"] .wb-canvas { display: flex }` silently out-ranks the withdrawal and puts a hidden canvas, mode subtree, Preview or tree panel back on screen — while each rule's own comment claims the attribute "cannot be undone by accident". Nothing asserts otherwise. DW-415 raised this; the sweep bundle keyed to DW-415 implemented DW-411 instead and marked DW-415 `done 2026-08-22`, so the ledger and the code disagree.

**Approach:** Make each withdrawal `display: none !important`, which no later author declaration can out-rank at any specificity, and pin the behaviour with a test that loads the real `globals.css` into jsdom, adds a competing higher-specificity `display` rule, and asserts the hidden elements still compute `display: none`.

## Boundaries & Constraints

**Always:** All four withdrawal rules (`.wb-canvas-mode[hidden]`, `.wb-canvas[hidden]`, `.wb-preview[hidden]`, `.wb-tree-panel[hidden]`) get the same floor — they are one mechanism and a partial fix leaves the identical defect two columns over. Every rule stays outside every media query. Existing source-scan assertions that read these rules back from the real file keep reading them back; update the pattern, do not delete the assertion.

**Block If:** Adding the floor makes any element that should be visible compute `display: none` — i.e. some surface relies on a class rule beating the `hidden` attribute.

**Never:** Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`; the orchestrator records resolution. Do not write an `@media (max-width: …)` / `@media (min-width: …)` query literal into comment prose — `src/lib/__tests__/workbench-split.test.ts` counts the responsive blocks by that exact text and a mention in a comment is indistinguishable from a third block. Do not solve this by out-specificity-ing the hazard (e.g. `.wb-shell .wb-canvas[hidden]`); that only moves the arms race one step. Do not change which elements carry `hidden`, or any component logic.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Withdrawal, no competitor | Real `globals.css` loaded; `.wb-canvas[hidden]` inside `.wb-shell` | `getComputedStyle(el).display === "none"` | No error expected |
| Withdrawal vs. higher-specificity competitor | Same, plus an appended `.wb-shell[data-preview="true"] .wb-canvas { display: flex }` (0,3,0) | Still `"none"` — the floor holds | No error expected |
| Same, for the other three selectors | Competing (0,3,0) rules for `.wb-canvas-mode`, `.wb-preview`, `.wb-tree-panel` | Still `"none"` for each | No error expected |
| Attribute absent | Same stylesheet, element without `hidden` | Not `"none"` — the floor withdraws nothing that is not marked withdrawn | No error expected |

</intent-contract>

## Code Map

- `src/app/globals.css:2704` -- `.wb-canvas-mode[hidden] { display: none; }` (DW-26). Preceded by a long comment arguing the attribute is only a presentation hint.
- `src/app/globals.css:2722` -- `.wb-canvas[hidden] { display: none; }` (DW-373). Its comment notes `.wb-canvas` already carries author `grid-column`/`overflow`/`background`.
- `src/app/globals.css:2743` -- `.wb-preview[hidden] { display: none; }` (DW-412). `.wb-preview` below already declares `display: flex`.
- `src/app/globals.css:2760` -- `.wb-tree-panel[hidden] { display: none; }` (DW-412 sibling). `.wb-tree-panel` below already declares `display: flex`.
- `src/app/globals.css:2663` -- `.wb-shell[data-collapsed="true"] .wb-left { display: none }` — the existing (0,3,0) `display` rule DW-415 cites as proof the hazard is live, not hypothetical.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx:325-347` -- source scan asserting `/\.wb-canvas-mode\[hidden\] \{\s*display: none;\s*\}/` and brace depth 0. **Breaks** on the new declaration; pattern must be updated.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx:1043-1100` -- two source scans, same shape, covering `.wb-canvas[hidden]` and (in a loop) `.wb-preview[hidden]` / `.wb-tree-panel[hidden]`. **Break** the same way.
- `src/lib/__tests__/workbench-split.test.ts:1762-1763` -- asserts `@media (max-width: 1199px)` and `@media (max-width: 899px)` each appear exactly twice in `globals.css`; constrains comment prose.
- `AGENTS.md` "Test environments" -- `.test.tsx` ⇒ jsdom `dom` project, `.test.ts` ⇒ `node`. A test calling `getComputedStyle` must be `.test.tsx` under a `__tests__` directory.
- Verified read-only: jsdom evaluates this cascade faithfully. With the real `globals.css` injected, a competing (0,3,0) rule currently yields `display: flex` / `grid` for the withdrawn elements; with `!important` on the withdrawal it yields `none`. jsdom logs one benign `Could not parse CSS @import URL "tailwindcss"` warning for the file's first line.

## Tasks & Acceptance

**Execution:**
- `src/app/globals.css` -- change all four `[hidden]` withdrawal declarations to `display: none !important;`, and extend each rule's existing comment with one short passage naming the cascade floor and DW-415 -- the comments currently promise a guarantee the declarations did not deliver.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- update the `.wb-canvas-mode[hidden]` source-scan pattern to require `!important`, and say in the comment why the floor is there -- the assertion is the thing that stops the floor being dropped in a later restyle.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- same update for `.wb-canvas[hidden]` and for the `.wb-preview[hidden]` / `.wb-tree-panel[hidden]` loop.
- `src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` -- new dom-project suite covering the I/O matrix: inject the real `globals.css` into `document.head`, mount the shell markup for each of the four selectors, and assert computed `display` with and without a competing (0,3,0) `display` rule, plus the attribute-absent case. Strip the leading `@import` line before injecting so the jsdom console stays quiet; remove the injected `<style>` in `afterEach`.

**Acceptance Criteria:**
- Given `globals.css` as shipped, when a later author rule of higher specificity sets `display` on `.wb-canvas`, `.wb-canvas-mode`, `.wb-preview` or `.wb-tree-panel`, then an element of that class carrying `hidden` still computes `display: none`.
- Given an element of one of those classes **without** `hidden`, when the same stylesheet applies, then its computed `display` is not forced to `none` by the withdrawal rules.
- Given the repository on the Node version CI pins (22), when `pnpm test` runs, then every suite passes — including the three updated source scans and `workbench-split.test.ts`'s media-query counts. (On Node 26, 229 tests across 13 dom-project files die in `beforeEach` on `window.localStorage` being undefined, before and after this change alike — a local toolchain artifact, not a repository condition; see frontmatter `deferred`.)
- Given a reader at any of the four rules, when they read its comment, then the comment states that the floor (not specificity alone) is what makes the withdrawal un-defeatable, and cites DW-415.

## Spec Change Log

## Review Triage Log

### 2026-08-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 2: (high 0, medium 1, low 1)
- reject: 8: (high 0, medium 2, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The new suite's baseline case claimed to be a presence guard for the withdrawal rules; measured otherwise — with all four rules deleted jsdom still computes `none` for every surface, including `.wb-preview` whose class block declares `display: flex`. Rewrote the case's comment to say what it actually pins and recorded the jsdom deviation in the file's FIDELITY note.
  - `[medium]` `[patch]` Nothing stopped a fifth `[hidden]` withdrawal shipping without the floor: `SURFACES` and the three source scans all name four selectors by hand. Added a scan keyed on the mechanism — every `[hidden]` rule in `globals.css` must declare `display: none !important`, with the selector set asserted so a zero match cannot pass vacuously.
  - `[medium]` `[patch]` The "withdraws nothing that is not carrying the attribute" case read computed styles before injecting the stylesheet, making it vacuous. Moved `applyStylesheet` ahead of the read.
  - `[low]` `[patch]` "Un-defeatable" prose dropped the "normal" qualifier at three `globals.css` rules and both persistence tests. `!important` loses to a competing important declaration, and to an important declaration inside a Tailwind cascade layer. Qualified every site, and added a case asserting an `!important` competitor does win, so the bound is recorded rather than implied.
  - `[low]` `[patch]` A competitor keyed on `.wb-shell[data-mode="chat"]`, an attribute `Workbench` never writes. Switched to `data-collapsed`.
  - `[low]` `[patch]` `cleanup` imported and called from `@testing-library/react` in a file that renders nothing through RTL. Removed.
  - `[low]` `[patch]` The `@import` strip matched only the exact line-1 text and its `beforeAll` assertion escalated a cosmetic console line into a red suite. Made the pattern tolerant of quoting, `layer(…)`/`source(…)`/`url(…)` and a leading BOM or comment, and dropped the assertion.
  - `[low]` `[patch]` ~60 lines of comment restating one argument at four CSS rules and three test files, copying a literal selector into three new sites — a known-fragile pattern in this repo, where `workbench-split.test.ts` counts exact CSS text in `globals.css`. Kept one full statement at the first rule; the rest are short cross-references.

Rejected: the reported ~1-in-10 flakiness of the new suite (20/20 clean runs once no other agent was mutating `globals.css` in the shared tree; three review agents were mutation-testing it concurrently, which reproduces the exact reported failure); the competitor being appended after the stylesheet rather than before (appending after gives the competitor source order as well, which makes the case stronger, not weaker); per-surface failure reporting (the assertions already carry the class name); cascade layers as a separate finding (folded into the prose qualification); the absence of a Playwright assertion (outside this bundle); the `deferred-work.md` ledger still marking DW-415 done (orchestrator-owned, this run is forbidden to edit it — noted in the commit instead); the spec and new test file being untracked (committed at finalize); `!important` also overriding inline `element.style.display` (verified no component sets inline `display` on these four — recorded as a residual risk).

## Design Notes

`!important` rather than a specificity bump is deliberate: raising the withdrawal to (0,3,0) only invites a (0,4,0) competitor later, whereas an important author declaration wins against every normal author declaration regardless of specificity or source order. It is also already an idiom in this stylesheet (e.g. `prefers-reduced-motion` overrides around line 598). The risk it carries — that the rule now beats declarations meant to show the element — is bounded, because it only fires while the element carries `hidden`, which is exactly the state in which nothing should show it.

The cascade test is the part DW-415 asked for that a source scan cannot give: the scans prove the text is present, the cascade test proves the text wins.

```js
document.head.appendChild(styleWith(globalsCss + COMPETING));
// COMPETING = `.wb-shell[data-preview="true"] .wb-canvas { display: flex; }`
expect(getComputedStyle(canvas).display).toBe("none");
```

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` -- expected: all new cases pass; confirm the competing-rule case fails when `!important` is reverted (red-first check).
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- expected: pass with the updated patterns.
- `pnpm test` on Node 22 -- expected: every file green. Measured: 337 files / 7731 passed, 1 skipped. On Node 26 the dom project is unrunnable for an unrelated reason (see frontmatter `deferred`); use Node 22 to verify this change.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** The four `[hidden]` withdrawal rules in `src/app/globals.css` now declare `display: none !important`, which no normal author declaration can out-rank at any specificity or source order — closing the hazard DW-415 raised and that its own bundle never implemented. A new jsdom suite loads the shipped stylesheet, appends the exact (0,3,0) shell-scoped competitor DW-415 describes, and asserts the withdrawn surfaces still compute `display: none`; it also records the floor's real bound (an `!important` competitor does win) and scans the stylesheet so a fifth `[hidden]` rule cannot ship without the floor. Scope note: DW-415 named two rules (`.wb-canvas-mode`, `.wb-canvas`); all four were floored, because `.wb-preview` and `.wb-tree-panel` carry the identical defect and a partial fix would leave it two columns over.

**Files changed.**
- `src/app/globals.css` -- all four `[hidden]` withdrawals get the `!important` floor; one full statement of the cascade argument at the first rule, short cross-references at the other three.
- `src/components/workbench/__tests__/hidden-withdrawal-cascade.test.tsx` (new) -- five cases: baseline control, the load-bearing (0,3,0) competitor case, the `!important`-competitor bound, the attribute-absent bound, and a mechanism-keyed scan requiring the floor on every `[hidden]` rule.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- `.wb-canvas-mode[hidden]` source scan tightened to require the floor.
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- same for `.wb-canvas[hidden]`, `.wb-preview[hidden]`, `.wb-tree-panel[hidden]`.

**Review findings.** 8 patched (medium 3, low 5), 2 deferred (medium 1, low 1), 8 rejected. Details and rejection reasoning in the Review Triage Log above.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 3, low 5. Score = 3x3 + 1x5 = 14, which is >= 5.

**Verification performed.**
- `pnpm test` on Node 22.16.0 (the version `.github/workflows/ci.yml` pins): 337 files / 7731 passed, 1 skipped — fully green, including all three updated suites and `workbench-split.test.ts`'s media-query counts.
- `hidden-withdrawal-cascade.test.tsx`: 5/5, and 20 consecutive clean runs (a reported ~1-in-10 flake was three review agents mutation-testing `globals.css` in the shared working tree, not the suite).
- Red-first confirmed: dropping `!important` from each of the four rules individually turns the competitor case red (`block`/`flex`); the mechanism scan goes red for a fifth withdrawal written without the floor, including one smuggled inside a width query.
- The four source-scan regexes and their brace-depth-0 checks were also evaluated directly against the shipped `globals.css`; `@media (max-width: 1199px)` and `@media (max-width: 899px)` each still appear exactly twice.
- `pnpm lint` exit 0; `pnpm exec tsc --noEmit` exit 0.

**Residual risks.**
- `!important` has a wider blast radius than a specificity bump: it also defeats inline `element.style.display` and any JS-driven show on an element still carrying `hidden`. Verified no component sets inline `display` on these four classes today, but a future show-by-inline-style would silently no-op and need `setProperty(..., "important")` or removal of the attribute.
- jsdom does not model the UA `hidden` default the way a browser does (a (0,1,0) author `display` loses to it there, wins in a browser), so the baseline case is a control rather than a presence guard. Recorded in the suite's FIDELITY note; text presence is carried by the source scans and the mechanism scan instead. No real-browser assertion exists for these withdrawals.
- The ledger still reads `DW-415: status: done 2026-08-22 / resolved by sweep bundle dw3-pnpm-workspace-root`. This run is forbidden to edit `deferred-work.md`; the mis-marking is noted in the commit message for the orchestrator.

