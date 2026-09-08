---
title: 'DW-30: a Wiki is a lens — honest switch copy and the tenant-flat invariant'
type: 'chore'
created: '2026-08-17'
status: 'done'
baseline_revision: 'bf73249a75eaae47bdab93d7dc00a14ebf517929'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      DW-17's stated reopening trigger, and three frozen story records, still quote the
      Story 1.4 AC phrase this change removed.
    evidence: |-
      `deferred-work.md:153` justifies DW-17 with "the per-Wiki Page partitioning that Story 1.4's
      'the trees show that Wiki's files' implies", and the same phrase is quoted at
      `spec-1-2-create-a-wiki-from-a-scenario-template.md:71` and
      `spec-1-4-knowledge-tree-and-file-tree.md:25,132,310`. After this change that citation
      resolves to no live text in `epics.md`, so DW-17's rationale now rests on a phrase that no
      longer exists — which could either keep a migration alive on a dead citation or make it look
      spuriously resolved. The ledger is orchestrator-owned and the story specs are frozen records,
      so neither can be corrected from this story.
    location: >-
      _bmad-output/implementation-artifacts/deferred-work.md:153
    severity: medium
  - summary: >-
      The PRD still glosses the File Tree as a browse of "the Wiki's files", the same
      per-Wiki reading this story removed from the epic.
    evidence: |-
      `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md:99` reads
      "**File Tree** — Left-column browse of the Wiki's files (Pages, Sources, purpose/Schema)",
      which groups Pages and Sources under "the Wiki's" exactly as the corrected AC used to. The
      intent named `epics.md:400` specifically and said nothing about the PRD, so rewording a
      second planning artifact is outside what was authorised here.
    location: >-
      _bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/prd.md:99
    severity: low
  - summary: >-
      The AC edit shifted `epics.md` by two lines, so four line-addressed
      citations in three completed story records now point two lines short.
    evidence: |-
      Verified against the current file: `spec-1-6-drag-resize-and-durable-layout.md:246`
      cites `epics.md:440` (the 320px clause is now at :442), `spec-1-5-view-first-preview-
      with-gfm-and-wikilinks.md:383` cites `:423` (now :425), `:391` cites `:413` and `:414`
      (now :415 and :416), and `spec-1-4-knowledge-tree-and-file-tree.md:136` cites `:530`
      (now :532). The previous pass's triage entry claimed "every other `epics.md:<line>`
      citation in the repo sits above the edit" — that holds for shipped code under `src/`
      (the only other citations there are `epics.md:367`, above the edit, and
      `workbench-split.ts` was corrected) but not for the planning and implementation
      artifacts. The intent's Never clause puts the completed `spec-1-4` record off limits,
      and the same freeze applies to the other completed story records, so none of the four
      can be corrected from this story. Each lands within the same AC block, so a reader is
      misdirected by two lines rather than to unrelated text.
    location: >-
      _bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md:246
    severity: low
---

<intent-contract>

## Intent

**Problem:** Story 1.4's acceptance criterion (`_bmad-output/planning-artifacts/epics.md:400`, "**Then** the trees show that Wiki's files") promises per-Wiki partitioning the kernel deliberately does not have: `src/lib/wikis.ts:16-17` keeps Pages and Sources in the one tenant silo, so switching Wikis changes only `purpose.md` and `schema.md` while the Knowledge and Files trees keep showing the same pages and sources (DW-30). The owner is told nothing about this at the switcher, so the product looks broken, and the AC reads as owed partitioning work rather than as a settled design.

**Approach:** Apply the recorded decision — keep the storage tenant-flat and make the product honest. Reword the AC so it observes what actually changes on a switch, add one sentence of copy under the left-column Wiki switcher saying Pages and Sources are shared, and extend the existing invariant docstring beside `listWorkbenchFilePaths` so it cites the corrected AC. No storage, walk, or tree behaviour changes.

## Boundaries & Constraints

**Always:** The new sentence is a single exported constant in `src/lib/workbench-tree.ts` (where every other left-column sentence lives) and is imported by the component — never a literal at the render site. It renders as a plain muted `<p>`, not `role="alert"`: it states a design fact, not a failure. English only, one sentence, sized for the 280px column. The reworded AC must name both halves of the truth: what is per-Wiki (`purpose.md`, Schema) and what is shared (Pages, Sources).

**Block If:** The intent is read as requiring Pages or Sources to actually be partitioned per Wiki — that is DW-17's migration (ingest, index, silo, graph, MCP) and is explicitly not this work.

**Never:** Do not change the behaviour of `listWorkbenchFilePaths`, `buildKnowledgeTree`, or `listReadableWikiPages` — only their surrounding prose. Do not edit `src/components/WikiWorkbench.tsx`: `src/lib/__tests__/create-wiki-ui.test.ts:118-209` asserts in-file occurrence counts there, and repo convention (see `TREE_UNAVAILABLE_COPY`'s docstring) is that this file does not import the shared copy module. Do not edit the completed `spec-1-4-knowledge-tree-and-file-tree.md` record or `deferred-work.md` (the orchestrator owns the ledger). Do not weaken or delete any existing assertion.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner has wikis | `unavailable={false}`, `wikis.length > 0` | The switcher `<select>` renders and the scope sentence renders beneath the switcher row | No error expected |
| Registry read failed | `unavailable={true}` | Only `TREE_UNAVAILABLE_COPY` renders; no `<select>`, and no scope sentence — the component cannot claim anything about wikis it could not read | Already handled by the `unavailable` branch |
| No wiki yet | `unavailable={false}`, `wikis = []` | `New Wiki` renders alone; no `<select>` and no scope sentence — there is nothing to switch between | No error expected |
| Switch in flight | `switching === true` | The sentence stays rendered and unchanged; only controls are disabled | No error expected |

</intent-contract>

## Code Map

- `_bmad-output/planning-artifacts/epics.md:396-401` -- Story 1.4's third AC block. Line 400 is the partitioning promise to reword; line 401 ("I cannot see another owner's Wiki") is a separate authz clause and stays verbatim.
- `src/lib/wikis.ts:16-23` -- the authoritative statement that Pages and Sources are NOT partitioned per Wiki, and that a create/re-template writes only `purpose.md`, `schema.md` and that Wiki's `workspace-profile.json`. Read-only evidence; no edit needed.
- `src/lib/workbench-files.ts:222-237` -- `listWorkbenchFilePaths` docstring. Lines 234-236 already carry the invariant ("`wiki/` and `raw/` are the owner's single silo … a storage fact, not a rendering choice"). Extend it to cite the corrected AC. The function body below it is untouched.
- `src/lib/workbench-tree.ts:66-111` -- the "Copy — every user-visible sentence the tree can show" block: `TREE_NO_WIKI_COPY`, `TREE_UNAVAILABLE_COPY`, `KNOWLEDGE_UNAVAILABLE_COPY`, `FILES_UNAVAILABLE_COPY`, `KNOWLEDGE_EMPTY_COPY`, `FILES_EMPTY_COPY`, `FILES_TRUNCATED_COPY`, `UNTYPED_GROUP_LABEL`. Add the new constant here, same docstring style.
- `src/components/workbench/WikiSwitcher.tsx:247-290` -- the render root: `.wb-wiki-switch` wraps either the `unavailable` note or `.wb-wiki-switch-row` (the `wikis.length > 0` `<select>` gate plus `New Wiki`). It already imports `TREE_UNAVAILABLE_COPY` from `@/lib/workbench-tree` at line 7 — the reuse point.
- `src/app/globals.css:2902-2908` -- `.wb-wiki-switch-note, .wb-wiki-switch-error { margin: 0; color: var(--wb-muted); }`. The note face already exists; only top spacing is new.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- the mounted (jsdom, `dom` vitest project) suite for this component; `mount()` at ~line 69 renders it with two wikis. The outermost-surface home for the new assertions.
- `src/lib/__tests__/workbench-left-column.test.ts:210-250` -- the `describe("WikiSwitcher")` source-scan block; the third test is where `TREE_UNAVAILABLE_COPY` is pinned as sourced-not-literal.
- `src/lib/__tests__/workbench-tree.test.ts:608` -- precedent for pinning a copy constant's exact text (`FILES_TRUNCATED_COPY`).
- `src/lib/__tests__/brand-copy.test.ts:113-125` -- read-only evidence that source scans deliberately exclude `_bmad-output/`, so no test can guard the epics wording; the guard has to be the shipped copy plus the invariant docstring.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-tree.ts` -- add an exported `WIKI_SCOPE_COPY` beside the other copy constants: `"Switching wikis changes purpose.md and Schema. Pages and Sources are shared across your wikis."` Give it a docstring saying why it exists (a Wiki is a lens, not a partition; `src/lib/wikis.ts:16-17` is the storage fact) -- one module owns every left-column sentence, so the wording cannot drift per render site.
- `src/components/workbench/WikiSwitcher.tsx` -- import `WIKI_SCOPE_COPY` alongside `TREE_UNAVAILABLE_COPY` and render it as `<p className="wb-wiki-switch-note wb-wiki-switch-scope">` immediately after `.wb-wiki-switch-row`, inside the same `!unavailable` branch and under the same `wikis.length > 0` condition that gates the `<select>` -- the sentence describes the control directly above it, so it appears exactly when that control does.
- `src/app/globals.css` -- add `.wb-wiki-switch-scope { margin-top: var(--wb-space-1); }` next to the existing `.wb-wiki-switch-note` rule -- the note face is already muted; only separation from the switcher row is new, and the existing `unavailable` note must keep its `margin: 0`.
- `src/lib/workbench-files.ts` -- extend the `listWorkbenchFilePaths` docstring paragraph at :234-236 to name Story 1.4's Wiki-switch AC in `_bmad-output/planning-artifacts/epics.md` and state that it observes `purpose.md` and Schema, not partitioned Pages -- so a later reader who arrives from the AC cannot re-read it as owed partitioning work. Behaviour unchanged.
- `_bmad-output/planning-artifacts/epics.md` -- replace line 400 with wording that observes what a switch actually changes and adds a clause stating Pages and Sources are shared across the owner's Wikis; keep the `Given`/`When` lines and the `I cannot see another owner's Wiki` clause verbatim -- the AC stops promising partitioning without losing the authz criterion.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- add mounted assertions for the matrix: the sentence is on screen with wikis present, absent when `unavailable`, absent with `wikis={[]}`, and still on screen during an in-flight switch. Assert against the imported `WIKI_SCOPE_COPY`, not a retyped string.
- `src/lib/__tests__/workbench-left-column.test.ts` -- extend the `WikiSwitcher` describe: the component contains `WIKI_SCOPE_COPY` and does not inline the sentence's distinctive words as a literal -- the same sourced-not-literal rule already applied to `TREE_UNAVAILABLE_COPY`.
- `src/lib/__tests__/workbench-tree.test.ts` -- pin `WIKI_SCOPE_COPY` (the `FILES_TRUNCATED_COPY` precedent): it names `purpose.md` and Schema as what changes and says Pages and Sources are shared -- a future edit cannot quietly turn it back into a partitioning claim.

**Acceptance Criteria:**
- Given a signed-in owner in Wiki mode with at least one Wiki, when the left column header renders, then a muted sentence beneath the Wiki switcher tells them that switching changes `purpose.md` and Schema and that Pages and Sources are shared across their wikis.
- Given the shipped repository, when `_bmad-output/planning-artifacts/epics.md` Story 1.4 is read, then its Wiki-switch acceptance criterion no longer contains "the trees show that Wiki's files", names `purpose.md` and Schema as what changes, states that Pages and Sources are shared, and still contains "I cannot see another owner's Wiki".
- Given the shipped repository, when `listWorkbenchFilePaths` is read, then its docstring both states the tenant-flat invariant and points at the corrected AC, so the two cannot be read as contradicting each other.
- Given the full test suite, when it runs, then every pre-existing assertion still passes and no test file has been weakened or deleted.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 5, low 6)
- defer: 2: (high 0, medium 1, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The reworded AC was false for one of the two trees it named: `buildKnowledgeTree` builds from the page index and `purpose.md`/`schema.md` are deliberately kept out of it (`src/lib/wikis.ts:12-14`), so only the Files tree emits them. "the trees show" → "the Files tree shows"; the story would otherwise have traded one false plural promise for another.
  - `[medium]` `[patch]` `WIKI_SCOPE_COPY` said a switch "changes" `purpose.md` and Schema, colliding with the destructive sense the same surface already uses ("Pages and Sources are not changed", "This overwrites purpose.md, Schema…") — readable as a warning that switching rewrites the owner's file. Reworded to "shows that wiki's", with a test forbidding `changes`/`overwrites`/`replaces` returning to the sentence.
  - `[medium]` `[patch]` The sourced-not-literal guard hardcoded fragments of the sentence it protects, so any reword would leave it matching nothing and passing — the exact failure it exists to catch. It now derives both halves from the imported constant. The `role=` scan was also anchored at the opening `<p` and bounded by an asserted `</p>`.
  - `[medium]` `[patch]` The mounted placement assertion passed when the note was CONTAINED BY `.wb-wiki-switch-row` (`compareDocumentPosition` returns 20, FOLLOWING bit set), so folding the `<p>` back into that flex row — cramming the sentence beside the `<select>` — stayed green. Added `contains(...) === false` and `nextElementSibling` checks; mutation-verified to fail.
  - `[medium]` `[patch]` The product now tells the owner "Pages and Sources are shared across your wikis" while no test pinned that against the listing: every silo-content case passed `wikiId = null` and the only two-id case seeded an empty silo. Added a case that lists twice under two wiki ids and asserts the `wiki/`/`raw/` slices are identical.
  - `[low]` `[patch]` The note described the `<select>` by proximity only. It now carries a `useId` id that the control's `aria-describedby` points at, so the scope is announced to the one user proximity does nothing for.
  - `[low]` `[patch]` The gate comment's stated reason ("with no Wiki to switch between there is nothing here to explain") described the one-Wiki case it renders into. Reworded to the reason that holds: the sentence tracks the control it describes.
  - `[low]` `[patch]` `buildKnowledgeTree` — named by the ledger alongside `listWorkbenchFilePaths`, and the tab where "why didn't my pages change?" is asked — carried no invariant note. Added.
  - `[low]` `[patch]` The new `listWorkbenchFilePaths` docstring cited the epics file with no anchor and named no ledger id, so a reader arriving with the question could not reach the recorded decision. Now anchored on `### Story 1.4` and naming DW-30 and DW-17.
  - `[low]` `[patch]` The AC edit inserted two lines above `epics.md:440`, leaving `src/lib/workbench-split.ts:44`'s citation two lines short. Updated to `:442`; every other `epics.md:<line>` citation in the repo sits above the edit.
  - `[low]` `[patch]` `.wb-wiki-switch-scope` was pinned by no test, unlike every other left-column rule, so deleting it left the sentence flush against the switcher with the suite green. Added a `globals()` pin; mutation-verified to fail.

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 16: (high 0, medium 0, low 16)
- addressed_findings:
  - `[medium]` `[patch]` The per-Wiki half of the shipped sentence ("shows that wiki's `purpose.md` and Schema") was pinned nowhere: both preview artifact cases hold a ONE-Wiki registry, where `currentId` and `wikis[0].id` are the same string, so swapping the route's resolution left the suite green while an owner on their second Wiki read the first Wiki's Purpose and Schema — and Story 1.8's `Edit` then saves that body into the current Wiki. Added a two-Wiki case with `currentId` on the second; mutation-verified to fail.
  - `[low]` `[patch]` `.wb-wiki-switch-scope` tied with `.wb-wiki-switch-note`'s `margin: 0` on specificity (the element carries both classes) and won only by sitting later in the file, and the new CSS pin asserted the two rules exist but not their order — so moving or sorting either rule flattened the spacing with the suite green. Selector is now compound; the pin matches the compound form. Mutation-verified to fail.
  - `[low]` `[patch]` The new silo test's closing assertion read its own fixture bytes back with `fs`, so it passed regardless of what the product resolved while its comment claimed it proved real per-Wiki storage. It now reads both artifacts through `readWorkbenchFile`, which is the resolution the claim is about.
  - `[low]` `[patch]` `WorkbenchData.tsx` still documented the tree prop as "The Wiki's files" — the same per-Wiki gloss removed from the AC, in live source in the touched area. Reworded to the owner's silo plus the current Wiki's two artifacts, citing the storage fact and DW-30.

## Design Notes

**Why the header switcher and not the canvas card.** `src/components/WikiWorkbench.tsx` ships a second switcher (Story 1.2's card) whose duplication is already recorded as deferred work. It is also the file whose in-file occurrence counts `create-wiki-ui.test.ts` freezes, and whose own `TREE_UNAVAILABLE_COPY` twin is a deliberate literal because it cannot import the shared module. The header switcher is the UX-DR5 surface, and — decisively for this change — it sits directly above the Knowledge and Files trees the sentence is about. One sentence, at the place the misreading happens.

**Why the copy is not an alert.** Nothing failed. `role="alert"` would interrupt a screen-reader user on every mount with a statement of intended design, and would put a permanent fixture in the same channel the switcher's real error uses.

**Rewritten AC (target shape).** Keep the `Given`/`When`; replace the promise line and add the shared clause. The `Then` names the **Files** tree, not "the trees": `purpose.md` and `schema.md` are deliberately kept out of the page index (`src/lib/wikis.ts:12-14`), so the Knowledge tree never shows them and a plural claim would trade one false promise for another.

```
**Given** I switch Wikis from the header
**When** I pick another of my Wikis
**Then** the Files tree shows that Wiki’s `purpose.md` and Schema
**And** Pages and Sources are shared across my Wikis, so Knowledge and Files keep showing the same ones
**And** the left column says so, so a Wiki reads as a lens over shared Pages and Sources
**And** I cannot see another owner’s Wiki
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-tree.test.ts src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- expected: all pass, including the new sourced-not-literal, copy-text and mounted assertions.
- `pnpm test` -- expected: both vitest projects green; no pre-existing suite regressed (`create-wiki-ui.test.ts` and `brand-copy.test.ts` in particular).
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new type errors.
- `pnpm lint` -- expected: no new errors.

**Manual checks (if no CLI):**
- `grep -n "trees show that Wiki’s files" _bmad-output/planning-artifacts/epics.md` -- expected: no match. (The corrected AC names the **Files** tree in the singular, so neither the removed phrase nor the plural claim survives.)

## Auto Run Result

Status: done
Blocking condition: none

**What shipped.** A Wiki is now stated to be a lens rather than a partition, on both the surfaces where the misreading happened. `WIKI_SCOPE_COPY` ("Switching wikis shows that wiki’s purpose.md and Schema. Pages and Sources are shared across your wikis.") renders as a muted note directly beneath the left-column Wiki switcher, under the same gate as the `<select>` and referenced by its `aria-describedby`. Story 1.4's Wiki-switch acceptance criterion no longer promises per-Wiki files: it names the Files tree, `purpose.md` and Schema as what changes, and states that Pages and Sources are shared. The invariant docstrings beside `listWorkbenchFilePaths` and `buildKnowledgeTree` now cite the corrected AC and the ledger ids, so a later reader cannot re-derive the partitioning promise. No storage, walk, or tree behaviour changed. This second review pass added no product behaviour: it closed the verification gap under the sentence's per-Wiki half, made the note's spacing independent of CSS source order, and removed the last "the Wiki's files" gloss from live source.

**Files changed.**
- `src/lib/workbench-tree.ts` -- new `WIKI_SCOPE_COPY` constant with rationale; `buildKnowledgeTree` docstring gained the tenant-wide invariant note.
- `src/components/workbench/WikiSwitcher.tsx` -- renders the sentence beneath the switcher row and associates it with the `<select>` via `aria-describedby` (markup otherwise reindented, not rewritten).
- `src/app/globals.css` -- `.wb-wiki-switch-note.wb-wiki-switch-scope` top-spacing rule, compound so it does not depend on source order, leaving the shared note/error face untouched.
- `src/lib/workbench-files.ts` -- `listWorkbenchFilePaths` docstring extended to cite the corrected AC, DW-30 and DW-17.
- `src/components/workbench/WorkbenchData.tsx` -- the `files` prop is documented as the owner's silo plus the current Wiki's artifacts, not "the Wiki's files".
- `src/lib/workbench-split.ts` -- `epics.md:440` citation updated to `:442` after the AC edit shifted the file.
- `_bmad-output/planning-artifacts/epics.md` -- Story 1.4's Wiki-switch AC reworded.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx`, `src/lib/__tests__/workbench-left-column.test.ts`, `src/lib/__tests__/workbench-tree.test.ts`, `src/lib/__tests__/workbench-preview.test.ts` -- additions only, zero deletions: the four matrix states mounted, the `aria-describedby` association, placement and containment, the sourced-not-literal guard, the order-independent CSS pin, the exact copy pin plus a ban on destructive verbs, a two-wiki-id listing case that pins the shared-silo claim, and a two-Wiki preview case that pins the per-Wiki claim to `currentId` rather than to the registry's first entry.

**Review findings.** Across both passes: 15 patches applied (6 medium, 9 low; no high, no intent_gap, no bad_spec, no repair loopback) — 11 in the first pass, 4 in this one. 3 items deferred: DW-17's rationale and three frozen story records still quote the removed AC phrase; the PRD's File Tree gloss carries the same per-Wiki reading; and four `epics.md:<line>` citations in three completed story records are two lines short after the AC edit, in records the intent's Never clause freezes. 27 findings rejected — this pass's 16 include the redundant-but-deliberate `aria-describedby` ternary (commented, pinned, and harmless), the claim that the copy-verb ban is dead (it runs once the exact-match literal is updated), the reading that the sentence should also explain that a switch re-points the AI's Schema conventions (the intent specifies one sentence for a 280px column), the second switcher on the Story 1.2 canvas card (file frozen by occurrence counts, duplication already a ledger entry), and speculative future-edit guards.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 1, low 3; score = 3x1 + 1x3 = 6, at or above the threshold of 5.

**Verification.** `node_modules/.bin/vitest run` -- 217 files / 4506 tests pass, both projects, `create-wiki-ui.test.ts` and `brand-copy.test.ts` included. `npx tsc --noEmit -p tsconfig.json` -- exit 0. `npx eslint` on the touched files -- exit 0. Both guards added this pass were mutation-checked: reverting the CSS selector to the single class fails the spacing pin, and swapping the preview route's `currentId` for `wikis[0]?.id` fails the new artifact case — each mutation reverted and the full suite re-run green. `pnpm <script>` itself fails in this environment with `ERROR packages field missing or empty`, a pre-existing workspace-config problem unrelated to this change; the underlying binaries those scripts invoke were run directly.

**Residual risks.** The epics wording is the one deliverable no test can guard -- source scans deliberately exclude `_bmad-output/` (`brand-copy.test.ts:113-125`) -- so the shipped copy constant, its pins, and the invariant docstrings are what actually hold the line against a future re-reading. The owner switching from the Story 1.2 canvas card still gets no scope sentence; that file is frozen by occurrence counts and its duplication is already a deferred entry. The sentence explains what a switch shows, not that the switched-to Schema also governs page conventions and prompt guidance downstream -- deliberate, to keep one short sentence in a 280px column. All three deferred items sit in artifacts this story is not permitted to edit.

