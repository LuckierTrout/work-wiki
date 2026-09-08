---
title: 'Wiki canvas card: one owner per sentence (DW-176, DW-285)'
type: 'refactor'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
baseline_revision: '9a66cb468090919af1f2bdcfb102719d58bc993a'
deferred: []
---

<intent-contract>

## Intent

**Problem:** `WikiWorkbench.tsx` inlines two sentences the shared copy module already owns — `No wiki yet.` (:369) and `Your wikis couldn’t be loaded. Reload to try again.` (:364-365) — so each wording has two definitions, and in the zero-wiki wiki-mode viewport the left column's `TREE_NO_WIKI_COPY` row and the canvas card say the byte-identical `No wiki yet.` at the same moment (DW-176), which the mounted suite works around with a `within(canvas)` scope.

**Approach:** Settle ownership per the DW-176 decision of 2026-08-19: the canvas card is the one place that says `No wiki yet.`, and the left-column trees drop to a quieter, claim-free row placeholder. Give the card's two sentences exported constants in `workbench-tree.ts` alongside the `WIKI_*` canvas sentences already there, compose the failure sentence from `TREE_UNAVAILABLE_COPY` so its shared opening half keeps one definition, and retire the `within(canvas)` workaround for a document-wide count.

## Boundaries & Constraints

**Always:**
- `TREE_NO_WIKI_COPY` keeps its name and its render sites (`TreePanel.tsx:275`, `SourcesTree.tsx:108`) and changes only its VALUE, to the quieter placeholder. The tree's no-Wiki row is still the constant it always was, so no import or branch-order churn in the tree components and the existing ordering pin in `workbench-left-column.test.ts:223` keeps holding.
- The canvas sentences are new exports named for the surface that renders them, matching the `WIKI_*` family already in that module (`WIKI_READ_ONLY_COPY`, `WIKI_TEMPLATE_READ_ONLY_COPY`, `WIKI_CREATE_READ_ONLY_COPY`, `WIKI_SCOPE_COPY`).
- `Your wikis couldn’t be loaded.` keeps exactly one definition: the card's constant is DERIVED from `TREE_UNAVAILABLE_COPY` by template literal, never retyped. The two surfaces still say the same opening sentence on purpose (that is the standing design in `TREE_UNAVAILABLE_COPY`'s docstring) — what this change removes is the second definition of it, not the second render.
- `No wiki yet.` and `Your wikis couldn’t be loaded. Reload to try again.` keep their exact current wording, character for character. This bundle moves definitions, it does not reword shipped copy.
- Prose in `WikiWorkbench.tsx` that quotes either sentence names the constant instead, because the source-scan pins become `not.toContain(<sentence>)` and a comment quoting the text would either fail them or make them pass vacuously.
- The card's registry-failure branch stays `role="alert"` with no create action; the empty-state branch keeps its `Create Wiki` button, `disabled={awaitingCreate}` latch and `aria-disabled` read-only convention untouched.

**Block If:**
- The chosen tree placeholder wording would collide with an existing sentence in `workbench-tree.ts` or `workbench-modes.ts` (checked at plan time: it does not).

**Never:**
- Do not reword `No wiki yet.`, `Your wikis couldn’t be loaded.`, or `Reload to try again.`
- Do not change what any surface RENDERS beyond the two card literals and the tree row's new value — no new branch, no removed branch, no `role` change, no markup restructure.
- Do not touch `e2e/workbench-owner.spec.ts`. Its `#wb-canvas`-scoped literals assert production copy from outside the app, which is what an e2e pin is for; it is not the mounted-suite workaround DW-176 names.
- Do not touch `src/app/page.tsx`'s comment, `WikiSwitcher.tsx`'s render, or any Preview/Settings copy module.
- No new deferred-work rows for nearby test pins or sibling call sites.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Zero wikis, wiki mode | `wikis: []`, `currentWikiId: null`, `registryUnavailable: false` | Canvas card shows `WIKI_EMPTY_COPY` + `Create Wiki`; left tree shows the quieter `TREE_NO_WIKI_COPY`. `No wiki yet.` appears exactly once in the document. | No error expected |
| Registry read failed | `registryUnavailable: true` (any `wikis`, any `currentWikiId`) | Canvas card's `role="alert"` reads exactly `WIKI_UNAVAILABLE_COPY`; no `Create Wiki` anywhere; `WIKI_EMPTY_COPY` absent from the document | Degraded render, no throw |
| Current id names a record that vanished | `wikis: [OTHER]`, `currentWikiId: CURRENT.id` | Card falls back to the empty state (`WIKI_EMPTY_COPY`); tree does NOT, because it gates on `currentWikiId !== null` | No error expected |
| Sources mode, no wiki | `mode: "sources"`, `currentWikiId: null` | `SourcesTree` shows the quieter `TREE_NO_WIKI_COPY`; nothing on screen says `No wiki yet.` | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-tree.ts` -- owns every Workbench sentence for this column and card. `TREE_NO_WIKI_COPY` at :84 (value changes here), `TREE_UNAVAILABLE_COPY` at :92 (its docstring's "its own copy continues …" clause now points at the new derived constant), `WIKI_READ_ONLY_COPY` :133, `WIKI_TEMPLATE_READ_ONLY_COPY` :155, `WIKI_CREATE_READ_ONLY_COPY` :166 — the `WIKI_*` naming precedent for canvas-card sentences the two new constants follow. Add both new exports beside that family.
- `src/components/WikiWorkbench.tsx` -- the two literals: `:364-365` (inside the `registryUnavailable` branch's `<p role="alert">`) and `:369` (`<p className="text-sm text-foreground/60">`). Already imports `WIKI_CREATE_READ_ONLY_COPY`/`WIKI_TEMPLATE_READ_ONLY_COPY` from `@/lib/workbench-tree` at :16-19 — extend that import. Comments quoting `No wiki yet.` at :26, :95, :285, :358, :375.
- `src/components/workbench/TreePanel.tsx:270-276` -- `body()`; `if (unavailable) → TREE_UNAVAILABLE_COPY` then `if (!hasWiki) → TREE_NO_WIKI_COPY`. NO CODE CHANGE — it inherits the quieter wording through the constant.
- `src/components/workbench/SourcesTree.tsx:107-109` -- the sources-mode tree's `!hasWiki` row, same constant. NO CODE CHANGE.
- `src/components/workbench/Workbench.tsx:1747-1793` -- proof the duplication is wiki-mode-only: `TreePanel` renders under `mode === "wiki"` (beside the card), `SourcesTree` under `mode === "sources"`; both take `hasWiki={currentWikiId !== null}`.
- `src/components/workbench/WikiSwitcher.tsx:455-458` -- also renders `TREE_UNAVAILABLE_COPY` inside a `role="alert"`. Read-only evidence: this is why the duplication suite's alert query must stay `within(canvas)` even though its text assertion moves to a constant.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- the workaround at :350-358 (`within(canvas).getByText("No wiki yet.")` plus the comment explaining the scope) and the read-failure literals at :558-561. `PREVIEW_SENTENCE` at :56 is the in-file precedent for sourcing a pinned sentence from its module.
- `src/lib/__tests__/create-wiki-ui.test.ts:148-151` and `:295-311` -- node-project source scans that currently assert the literals are PRESENT in `WikiWorkbench.tsx`; both break, and both would pass vacuously off the file's comments if left as `toContain`. `:154-171` is the `PREVIEW_UNSELECTED_COPY` precedent to mirror (import the constant, assert the symbol present and the sentence absent).
- `src/lib/__tests__/workbench-left-column.test.ts:197-236` -- `sources every sentence from the shared module` and `distinguishes a failed registry read from an owner with no Wiki`; the ordering regex at :223 and the distinctness pins at :234-235 are where the new ownership invariants belong. `:412-427` pins `WikiSwitcher.tsx` on `TREE_UNAVAILABLE_COPY` with a comment about "same sentence as the canvas card" that becomes "same opening sentence".
- `src/components/__tests__/create-wiki-flow.test.tsx` (:316, :344, :424, :473, :575, :706, :710) and `src/components/__tests__/dialog-busy-gate.test.tsx` (:259, :338) and `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` (:187) -- mounted card suites restating the two sentences as literals; these are further definitions of the wording DW-285 is about.
- `src/lib/workbench-modes.ts:36-54` -- read-only: checked at plan time that no mode `emptyState` collides with the new placeholder wording.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-tree.ts` -- change `TREE_NO_WIKI_COPY`'s value to the quieter row placeholder `"Nothing to show yet."` and rewrite its docstring to say the canvas card owns `No wiki yet.` and why this row makes no registry claim; add `WIKI_EMPTY_COPY = "No wiki yet."` and `WIKI_UNAVAILABLE_COPY = \`${TREE_UNAVAILABLE_COPY} Reload to try again.\`` beside the `WIKI_*` family, each documented with its render site and the DW it settles; update `TREE_UNAVAILABLE_COPY`'s docstring to name `WIKI_UNAVAILABLE_COPY` as the derived card sentence -- one definition per wording, and the derivation makes the shared opening half impossible to drift.
- `src/components/WikiWorkbench.tsx` -- import both new constants from `@/lib/workbench-tree` and render them in place of the two literals; reword the five comments that quote `No wiki yet.` to name `WIKI_EMPTY_COPY` -- the card stops being a second definition of either sentence, and no comment can satisfy a source scan the render site no longer does.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- drop the `within(canvas)` workaround on the empty-state assertion, replacing it with a document-wide `getAllByText(WIKI_EMPTY_COPY)` count of 1 plus a containment check that the one node is inside `.wb-canvas`; move the read-failure text assertions onto `WIKI_UNAVAILABLE_COPY`/`WIKI_EMPTY_COPY` (keeping `within(canvas)` for `getByRole("alert")`, since `WikiSwitcher` renders its own alert); rewrite the scope comment to record that the duplicate is retired -- the count is what keeps it retired.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- flip the two literal-presence scans to the `PREVIEW_UNSELECTED_COPY` shape: import `WIKI_EMPTY_COPY`/`WIKI_UNAVAILABLE_COPY`, assert `WikiWorkbench.tsx` contains each symbol and `'@/lib/workbench-tree'` and contains NEITHER sentence -- a `toContain` on the text would now pass off the file's own prose.
- `src/lib/__tests__/workbench-left-column.test.ts` -- add ownership pins: `TREE_NO_WIKI_COPY !== WIKI_EMPTY_COPY`, `WIKI_UNAVAILABLE_COPY.startsWith(TREE_UNAVAILABLE_COPY)` with `WIKI_UNAVAILABLE_COPY !== TREE_UNAVAILABLE_COPY`, and neither `TreePanel.tsx` nor `SourcesTree.tsx` containing `WIKI_EMPTY_COPY`; refresh the two comments that quote the old wording -- the invariant DW-176 settles becomes executable rather than incidental.
- `src/components/__tests__/create-wiki-flow.test.tsx`, `src/components/__tests__/dialog-busy-gate.test.tsx`, `src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` -- replace the restated `No wiki yet.` / `Your wikis couldn’t be loaded.` literals with the imported constants -- a test literal is a definition too, and these are the ones that would go green against text nobody renders.

**Acceptance Criteria:**
- Given the assembled shell with `wikis: []`, `currentWikiId: null` and `registryUnavailable: false`, when it renders, then `No wiki yet.` appears exactly once in the document and that node is inside `.wb-canvas`.
- Given that same render, when the left column's tree body is read, then it shows the quieter placeholder and makes no claim that no wiki exists.
- Given `registryUnavailable: true`, when the card renders, then its `role="alert"` text is exactly `Your wikis couldn’t be loaded. Reload to try again.`, no `Create Wiki` control exists anywhere in the document, and `No wiki yet.` appears nowhere.
- Given `src/components/WikiWorkbench.tsx` read as text, when scanned, then it contains neither sentence anywhere — code or comment — and imports both constants from `@/lib/workbench-tree`.
- Given the shipped constants, when compared, then `WIKI_UNAVAILABLE_COPY` starts with `TREE_UNAVAILABLE_COPY` and is not equal to it, and `TREE_NO_WIKI_COPY` is not equal to `WIKI_EMPTY_COPY`.
- Given sources mode with `currentWikiId: null`, when `SourcesTree` renders its no-Wiki row, then it shows the quieter placeholder and nothing on screen says `No wiki yet.`

## Spec Change Log

No spec repairs. The review pass found no intent gaps and no bad-spec findings; every finding was a patch, a defer, or noise.

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 0
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[low]` `[patch]` `create-wiki-ui.test.ts`'s two new pins were vacuous and claimed the opposite in their own comments — `toContain("WIKI_EMPTY_COPY")` was satisfied by the five comments this same diff reworded to name the symbol, demonstrated by swapping the render site back to a literal and staying 22/22 green. Repinned on the RENDER SHAPE (`">{WIKI_EMPTY_COPY}</p>"`, and a `role="alert"` → `{WIKI_UNAVAILABLE_COPY}` window), comments corrected.
  - `[medium]` `[patch]` The change deleted the only unit-level pin of the AC's exact wording: with every assertion reading the constant, rewording it left all tests green and only e2e would have noticed. Restored an AC value pin for both sentences in the AC-invariants file, citing the `SETTINGS_LOAD_FAILED_COPY` idiom for why this one file pins values.
  - `[low]` `[patch]` `startsWith` did not enforce composition — it passes against a retyped literal, leaving the docstring's "DERIVED …, never retyped" claim unenforced. Added a source scan asserting the template-literal derivation is literally the definition.
  - `[low]` `[patch]` `workbench-tree.ts`'s module docstring and copy-section banner still said "every sentence the tree can render", so `WIKI_EMPTY_COPY`'s appeal to "the reason the module docstring gives" was untrue. Both updated to cover the canvas card and to state the one-owner-per-wording rule explicitly.
  - `[low]` `[patch]` The Sources test's rationale was stale within its own diff — it justified pressing the rail by a `?mode=` leak that the `afterEach` reset added in the same diff removes. Reworded to the reason that survives: pressing the rail drives the control an owner drives, so the test never depends on opening-mode precedence.
  - `[low]` `[patch]` No mounted assertion covered the left column's row in the zero-Wiki WIKI-mode viewport (only the Sources half had one); a reviewer replaced `TreePanel.tsx:275` with `return null` and the whole DOM suite stayed green. Added the mirror assertion — the row on screen, outside `.wb-canvas`, and `KNOWLEDGE_EMPTY_COPY` absent.
  - `[low]` `[patch]` The Sources test's mode guard matched the word "Sources" anywhere in the surface and failed unreadably when the surface was missing. Now asserts the element exists (with a diagnostic) and then that `.wb-left-surface-label` is exactly `Sources`.
  - `[low]` `[patch]` The tree ban covered only the card's empty-state sentence. Extended to `WIKI_UNAVAILABLE_COPY` and its symbol for both trees, with a note on why that is safe beside their own `TREE_UNAVAILABLE_COPY` render.

Rejected as out of scope on the intent's own authority, or as noise: the three e2e literals in `workbench-owner.spec.ts` and the card's other inline sentences (`Couldn't create the wiki.` and friends) — nearby test pins and sibling call sites the intent does not name; renaming `TREE_NO_WIKI_COPY` (the spec fixes the name deliberately); moving the `?mode=` reset into `vitest.setup.dom.ts`; `page.tsx:71`'s comment; a count pin on the read-failure alert pair (documented as two alerts by design, and DW-176 adjudicated only the empty state); the redundant `.length` guards (the file's own established idiom); `SourcesTree` having no registry-unavailable branch (pre-existing, and this change makes that case less wrong, not more); asserting all nine non-wiki modes; the stale Story 1.4 spec and UX mockup records that DW-176's decision already overrode; concatenation baking in English word order (this build is deliberately English-only); the Sources-mode create affordance (`New Wiki` sits in `.wb-left-head`, outside the mode branch, so it is on screen in every mode); and one reviewer's concurrent-modification warning, which was another reviewer's own mutation experiment — the working tree was verified byte-identical to the reviewed diff afterward.

## Design Notes

Why the value of `TREE_NO_WIKI_COPY` moves instead of the constant being renamed or replaced: the tree's row and the card's empty state are two different claims that happened to share one sentence. Keeping each render site pointing at the constant named for its own surface — `TREE_*` for the left column, `WIKI_*` for the canvas card, the split this module already uses — means the ownership decision lands entirely in the copy module, the tree components need no diff at all, and the existing branch-order pin (`if (unavailable) … TREE_UNAVAILABLE_COPY … if (!hasWiki) … TREE_NO_WIKI_COPY`) goes on protecting the thing it was written for.

The new failure constant is derived, not typed:

```ts
export const WIKI_UNAVAILABLE_COPY = `${TREE_UNAVAILABLE_COPY} Reload to try again.`;
```

`TREE_UNAVAILABLE_COPY`'s docstring already states that the card deliberately opens with the same sentence, so the two surfaces must keep saying it. Composition is what makes that a shared fact rather than a coincidence: rewording the tree's sentence carries the card with it, and no edit can leave the two halves disagreeing.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/create-wiki-ui.test.ts src/lib/__tests__/workbench-left-column.test.ts --project node` -- expected: pass, including the new ownership pins
- `pnpm exec vitest run src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx src/components/__tests__/create-wiki-flow.test.tsx src/components/__tests__/dialog-busy-gate.test.tsx --project dom` -- expected: pass with no `within(canvas)` scoping on the empty-state assertion
- `pnpm test` -- expected: full suite green (both projects), no regression in the brand/copy scans
- `pnpm exec tsc --noEmit` -- expected: clean
- `pnpm lint` -- expected: clean

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** The Wiki canvas card no longer authors any copy of its own. `No wiki yet.` and `Your wikis couldn't be loaded. Reload to try again.` are now exported constants, and DW-176's ownership decision is settled in the copy module rather than in the components: the card is the one surface that says a Wiki does not exist yet, and the left column's tree row drops to a claim-free placeholder. Shipped wording is unchanged character for character on every surface except that tree row.

**Files changed.**
- `../../src/lib/workbench-tree.ts` — `TREE_NO_WIKI_COPY` keeps its name and both render sites, value moves to the quieter `Nothing to show yet.`; new `WIKI_EMPTY_COPY` and `WIKI_UNAVAILABLE_COPY` (the latter composed from `TREE_UNAVAILABLE_COPY`) join the `WIKI_*` canvas family; module docstring and copy-section banner now cover the card.
- `../../src/components/WikiWorkbench.tsx` — renders both constants in place of the two literals; the five comments that quoted the empty-state sentence now name it.
- `../../src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` — the `within(canvas)` workaround retired for a document-wide count of 1 plus canvas containment, with the column's own row asserted alongside it; new Sources-mode case; read-failure text on the constants; an `afterEach` URL reset so a mode switch cannot leak `?mode=` into the next test.
- `../../src/lib/__tests__/create-wiki-ui.test.ts` — render-shape pins plus `not.toContain` for both sentences, and a restored AC value pin.
- `../../src/lib/__tests__/workbench-left-column.test.ts` — four ownership pins: the row/card inequality, the composition (`startsWith`, `!==`, and a source scan of the derivation), and a ban on both card sentences in either tree.
- `../../src/components/__tests__/create-wiki-flow.test.tsx`, `../../src/components/__tests__/dialog-busy-gate.test.tsx`, `../../src/components/workbench/__tests__/wiki-canvas-read-only.test.tsx` — restated literals replaced with the constants.
- `TreePanel.tsx` and `SourcesTree.tsx` are deliberately untouched: they inherit the quieter wording through the constant they already render.

**Review findings.** 8 patches applied (1 medium, 7 low), 0 deferred, 13 rejected. No intent gaps and no spec repairs.

**Follow-up review recommended: true.** Patched severities: high 0, medium 1, low 7. Score = 3x1 + 1x7 = 10, which is at or above 5.

**Verification.**
- `pnpm exec vitest run` over the six touched suites — 138 passed (node + dom).
- `pnpm exec tsc --noEmit` — exit 0. `pnpm lint` — exit 0.
- `pnpm test` — 361 files, 8922 passed / 1 skipped, with one unrelated failure (below).
- Non-vacuity checked by mutation rather than by a green run: reverting `TREE_NO_WIKI_COPY` to the card's sentence, swapping either render site back to a literal, deleting `TreePanel`'s `!hasWiki` guard so it falls through to `KNOWLEDGE_EMPTY_COPY`, and retyping `WIKI_UNAVAILABLE_COPY` are each caught by a failing test. Every mutation was reverted and the working tree confirmed byte-identical to the reviewed diff.
- I/O matrix rows are each covered by an executing test: rows 1 and 4 by the zero-Wiki wiki-mode and Sources-mode cases in `wiki-canvas-duplication.test.tsx`, row 2 by the read-failure case, row 3 by "closes the template confirm when the wiki goes away under the id".

**Residual risks.**
- `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP` fails intermittently under full-suite parallel load (`Test timed out in 5000ms`, taking the next case in the file down with an `ENOTEMPTY` cascade). Not caused by this work: it passes in isolation, references nothing in this diff, and reproduces identically on the stashed baseline tree. No ledger row filed — a load-sensitive test budget is not an owner-facing defect.
- The derivation pin in `workbench-left-column.test.ts` matches the constant's definition line verbatim, so reformatting or wrapping that line will fail it. That is the cost of pinning composition at all; the failure names the line.
- Three `No wiki yet.` literals remain in `e2e/workbench-owner.spec.ts`, out of scope by the spec's Never list. They are `#wb-canvas`-scoped and would go vacuous if the sentence were reworded; the restored AC value pin in `create-wiki-ui.test.ts` is what catches a reword first.
