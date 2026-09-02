---
title: 'Canvas reflow on dock, and a surfaced revision cap'
type: 'bugfix'
created: '2026-09-02'
baseline_revision: 'a6e1baf1c467e259a9ee21cfe781dff0e9db9fbb'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two surfaces are dishonest about their own state. (DW-180) The Wiki canvas card sits in `grid lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]`; the DW-39 rule only sets `display: none` on the preview note, so at `lg` with a docked Preview the receipt stays pinned at 320px beside an empty `1fr` track. (DW-541) `GET /api/workbench/artifact/revisions` answers a bare `{ revisions }` bounded by `MAX_ARTIFACT_REVISIONS` while the retention prune deletes anything older, and the History panel renders that list with no note — so a capped history reads as a complete one.

**Approach:** Give the canvas grid wrapper a class hook and add a sibling rule beside DW-39 that collapses it to a single full-width track while `.wb-shell[data-preview="true"]`. Add `limit` and `truncated` siblings to the listing envelope, carry them through `fetchArtifactRevisions`, and render one owned sentence under the History list when the listing is at the cap.

## Boundaries & Constraints

**Always:**
- The reflow decision lives in CSS off `.wb-shell[data-preview="true"]`, never as a prop or a `window.innerWidth` read — the canvas is `children` of the shell and cannot see that state (DW-39).
- The new CSS rule sits beside the DW-39 rule, unwrapped by any `@media`/`@supports`, and stays ahead of `.wb-split-handle {` so `workbench-split.test.ts`'s "keeps the docked grid variants the last grid rules in the file" (`lastIndexOf("grid-template-columns")`) still resolves inside the docked block.
- Every owner-facing sentence is a constant or a function in `src/lib/workbench-preview.ts`, never typed into JSX; any numeral in it is derived from the value the server sent, formatted with the pinned `en-US` `Intl.NumberFormat` the sibling truncation copy uses.
- The truncation note is claimed only when the listing is AT the cap. That is the most the server can know — pruned revisions are deleted — so the sentence must not assert a count of what was lost.
- `truncated`/`limit` are ENVELOPE siblings. `ArtifactRevision` and every row's field set stay exactly as they are.
- The client keeps its existing wire posture: an unusable `limit` degrades the sentence rather than typing a number that did not arrive, and a listing whose truncation fields are absent is an ordinary untruncated listing, not an error.
- Truncation state is stored so it cannot desync from the list it describes: one reset clears both.

**Block If:**
- Surfacing the cap would require changing `ArtifactRevision`, the row shape, or `MAX_ARTIFACT_REVISIONS`.

**Never:**
- Do not change `MAX_ARTIFACT_REVISIONS`, the prune, or the default listing bound; do not add pagination, a "load more", or a way to see past the cap.
- Do not touch page revisions (`src/lib/revisions.ts`) or the backup half's truncation surface.
- Do not change `PREVIEW_UNSELECTED_COPY`, the DW-39 `display: none` behaviour, or which surface owns the wiki switcher (DW-33).
- Do not restyle the receipt card itself, add a breakpoint, or move the preview note out of the grid.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Preview docked | `.wb-shell[data-preview="true"]` wraps the canvas | Receipt grid computes a single `minmax(0, 1fr)` track; the preview note is `display: none` | No error expected |
| Nothing docked | `.wb-shell[data-preview="false"]` | Grid keeps its two-track Tailwind value; the note is visible | No error expected |
| History under the cap | 2 stored revisions | `{ revisions, limit: 50, truncated: false }`; panel shows the list and no note | No error expected |
| History at the cap | pre-cap backlog of 60, prune/bound leave 50 | `{ revisions (50), limit: 50, truncated: true }`; panel shows the list and the truncation sentence | No error expected |
| Envelope with no truncation fields | 200 `{ revisions: [...] }` | `{ status: "ok", revisions, truncated: false, limit: null }`; no note | Treated as untruncated, not as a failure |
| Truncated with an unusable `limit` | 200 `{ revisions, truncated: true, limit: "many" }` | `truncated: true`, `limit: null`; panel shows the numeral-free sentence | No numeral is invented |
| Empty history | 200 `{ revisions: [] }` | Existing empty sentence; no truncation note | No error expected |
| Listing refused / non-envelope 200 | 403, or 200 `{}` | Unchanged: the existing error sentence, no truncation note | Server sentence preferred, else the fallback copy |

</intent-contract>

## Code Map

**DW-180 — canvas reflow**
- `src/components/WikiWorkbench.tsx:526` -- the wrapper `<div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">`; it has no class hook today. `:586` is the `wb-canvas-preview-note` child. The card's header doc-comment (`:26-50`) explains the DW-39 seam and should gain a line about the reflow.
- `src/app/globals.css:3606` -- `.wb-shell[data-preview="true"] .wb-canvas-preview-note { display: none; }`, unlayered (the file is `@import "tailwindcss"` only, so unlayered rules beat Tailwind's layered utilities regardless of specificity). Add the sibling rule immediately after this block, inside the same comment's scope.
- `src/lib/__tests__/workbench-split.test.ts:2131` -- "keeps the docked grid variants the last grid rules in the file": asserts `css.lastIndexOf("grid-template-columns") > css.indexOf(".wb-split-handle {")`. `.wb-split-handle {` is at ~line 5175 and the last `grid-template-columns` at ~5370, so a rule added at ~3608 keeps this green. `:2117` also caps `@media (max-width: 1199px)` occurrences at 2 — do NOT add a media block.
- `src/lib/__tests__/workbench-split.test.ts:2118` -- "paints the new rules from --wb-* tokens only" slices from `.wb-split-handle {`; the new rule is far above that slice and carries no colour anyway.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx:87` -- `previewNoteRule()` slices the REAL DW-39 rule out of `globals.css` (comment-stripped brace-depth check, then matching-brace walk) and injects it into jsdom. Generalise it to take a selector so the new grid rule can be sliced and exercised the same way; `PREVIEW_NOTE_SELECTOR` is at `:63`.
- `src/lib/__tests__/create-wiki-ui.test.ts:357` -- pins that `WikiWorkbench.tsx` names `wb-canvas-preview-note` and that `globals.css` declares the DW-39 selector. The same shape is the place to pin the new hook and rule.

**DW-541 — revision cap surface**
- `src/app/api/workbench/artifact/revisions/route.ts:222` -- `return json({ revisions: await listWikiArtifactRevisions(...) })`. This is the only line that changes; the gate ladder, the `?timestamp=` branch and the POST are untouched.
- `src/lib/wiki-artifact-revisions.ts:182` -- `MAX_ARTIFACT_REVISIONS = 50`, exported, and both the retention cap and the listing's default bound (`:364-368`). Importable by the route (server-side), NOT by the client module — it pulls `./storage`.
- `src/lib/workbench-preview.ts:1586` -- `ArtifactRevisionSummary` (re-declared, not imported, for exactly that bundle reason — keep that rule). `:1601` `ArtifactRevisionsResult`. `:1668` `isRevisionSummary`. `:1698` `fetchArtifactRevisions` — the `Array.isArray(body?.revisions)` envelope check and the "non-empty envelope, nothing usable" rule are both load-bearing and must survive.
- `src/lib/workbench-preview.ts:796-830` -- the History copy block (`PREVIEW_HISTORY_COPY`, `..._LOADING_COPY`, `..._EMPTY_COPY`, `..._FAILED_COPY`). The new sentence belongs here.
- `src/lib/workbench-tree.ts:246` (`FILES_TRUNCATED_COPY`) and `src/lib/workbench-preview.ts:614` (`PREVIEW_TRUNCATED_COPY`) -- the reuse pointers: derived numeral, pinned `en-US` locale, one owned constant. Match their register.
- `src/components/workbench/PreviewColumn.tsx:384` -- `revisions` state; `:638` and `:1040` are the two places it is reset to `null`; `:1019` is the only place it is set from a landed listing; reads at `:1049`, `:1588`, `:1594`, `:1598`, `:1600`, `:1720`. Holding the listing as ONE object with `revisions` kept as a derived local keeps every existing read untouched and makes desync impossible.
- `src/components/workbench/PreviewColumn.tsx:1598-1600` -- the `<ul className="wb-preview-history-list">`; the note goes after it, using the existing `wb-preview-history-note` class (already used at `:1589` and `:1595`).
- `src/lib/__tests__/wiki-artifact-revisions.test.ts:1125` -- "bounds a pre-cap backlog…" already drives a 60-deep backlog through the route and asserts the row key set at `:1153`; the envelope siblings belong in this test and in "GET lists revisions newest-first" (`:666`).
- `src/lib/__tests__/workbench-preview.test.ts:3114-3190` -- `fetchArtifactRevisions` cases assert the whole result with `toEqual`; every `status: "ok"` expectation needs the new fields.
- `src/components/workbench/__tests__/preview-revision-history.test.tsx:182` -- `listAnswer` stub returns `ok({ revisions: [...] })`; the panel cases add a truncated variant here.

## Tasks & Acceptance

**Execution:**
- `src/components/WikiWorkbench.tsx` -- add a `wb-canvas-receipt-grid` class to the grid wrapper at `:526` and extend the file's header doc-comment to say that the same shell attribute both hides the note and collapses this grid -- a CSS rule needs a stable hook, and the comment is where the DW-39 seam is already explained.
- `src/app/globals.css` -- immediately after the DW-39 rule, add `.wb-shell[data-preview="true"] .wb-canvas-receipt-grid { grid-template-columns: minmax(0, 1fr); }` with a comment naming why it must stay unwrapped and why it beats the Tailwind utility (unlayered) -- hiding a grid child does not release its track, which is the whole defect.
- `src/lib/workbench-preview.ts` -- add the truncation copy beside the other History sentences (a function taking the server's `limit`, numeral formatted with the pinned `en-US` formatter, numeral-free when the limit is unusable); widen `ArtifactRevisionsResult`'s `ok` variant with `truncated: boolean` and `limit: number | null`; read both from the envelope in `fetchArtifactRevisions`, defaulting absent/unusable values to `false`/`null` -- the panel cannot say "newest 50" without the server's own number, and must not invent one.
- `src/app/api/workbench/artifact/revisions/route.ts` -- answer the listing with `limit: MAX_ARTIFACT_REVISIONS` and `truncated` set when the returned list is at that bound, with a comment stating precisely what the flag can and cannot claim -- the prune deletes; "at the cap" is the most the server knows.
- `src/components/workbench/PreviewColumn.tsx` -- hold the landed listing as one object (`revisions` + `truncated` + `limit`) with `revisions` derived from it, so the two existing reset sites clear both at once; render the sentence in a `wb-preview-history-note` paragraph after the list when `truncated` -- a second state variable beside the list is how the note comes to describe a list it no longer belongs to.
- `src/lib/__tests__/wiki-artifact-revisions.test.ts` -- assert the envelope siblings on both an under-cap listing and the existing 60-deep backlog case, and that the row key set is unchanged -- the matrix's server rows.
- `src/lib/__tests__/workbench-preview.test.ts` -- update the `fetchArtifactRevisions` `ok` expectations and add cases for an absent-fields envelope, a truncated envelope, and a truncated envelope with an unusable `limit`; cover the copy function's two shapes -- the matrix's wire rows.
- `src/components/workbench/__tests__/preview-revision-history.test.tsx` -- add a truncated listing that shows the sentence, an untruncated one that does not, and confirm the note goes away when the owner re-points the panel -- the matrix's panel rows.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- generalise the rule-slicing helper to any selector, inject the new grid rule alongside the DW-39 one, and assert the wrapper's computed `grid-template-columns` docked vs. undocked -- a spelled-out rule that is never exercised is the failure mode this file already exists to prevent.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- extend the DW-39 case to pin the new hook in the component and the new selector in the stylesheet -- so a renamed hook cannot silently orphan the rule.

**Acceptance Criteria:**
- Given the canvas rendered inside a host carrying `data-preview="true"`, when the grid wrapper's computed style is read, then `grid-template-columns` is the single `minmax(0, 1fr)` track, and the preview note is `display: none`.
- Given the same canvas inside a host carrying `data-preview="false"`, when the wrapper's computed style is read, then the docked override does not apply and the preview note is visible.
- Given `globals.css`, when the new rule's position is checked, then it sits after the DW-39 rule, at brace depth zero, and before `.wb-split-handle {`.
- Given an artifact history at the retention cap, when the owner expands History, then the list renders as before and one sentence beneath it names the number of versions shown and says older ones are not kept.
- Given an artifact history under the cap, or an empty one, or a refused listing, when the owner expands History, then no truncation sentence appears anywhere in the panel.
- Given a truncated listing followed by the owner picking another row, when the panel is re-expanded on a listing that is not truncated, then the sentence is gone.
- Given the listing route, when it answers a listing, then the response carries `revisions` unchanged plus `limit` and `truncated`, and every row's field set is byte-for-byte what it was.

## Spec Change Log

_No bad_spec loopback occurred; this spec was implemented as written._

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 0
- reject: 12: (high 0, medium 1, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `truncated` was re-derived in the route from `revisions.length`, but the lister drops a stem whose `stat` throws — a sixty-deep directory with one unreadable snapshot returned 49 rows and answered `truncated: false`, in exactly the case the flag exists for. Split `listWikiArtifactRevisionsPage` out of `listWikiArtifactRevisions` (the latter is now a thin delegate, signature and return shape unchanged) and counted `truncated` from the canonical stems before any per-revision I/O. Kept `>=`: the prune leaves exactly the cap on disk, so a strict `>` would report every swept history as whole. New route test rejects `stat` for one stem in a 60-deep backlog and asserts 49 rows with `truncated: true`.
  - `[medium]` `[patch]` The truncation note rendered after the list, inside a `max-height: 40vh; overflow-y: auto` panel that only carries the note when the list is at the cap — so it always sat below ~50 rows. Moved above the list, beside the read-only note; the panel test's `compareDocumentPosition` assertion flipped to pin note-before-list.
  - `[low]` `[patch]` `fetchArtifactRevisions` accepted `limit: 0` (`>= 0`), which would have printed a sentence naming zero versions above a populated list. Tightened to `> 0`; `0` added to the unusable-limit test loop.
  - `[low]` `[patch]` The copy said "Showing the 50 most recent versions", a claim about the rows on screen — which can legitimately be 49 once a snapshot is unreadable. Reworded to name the cap ("History is capped at the 50 most recent versions; older ones are not kept."), matching `FILES_TRUNCATED_COPY`'s register, with the doc comment corrected to match.
  - `[low]` `[patch]` The CSS ordering test's name claimed "adjacent, unwrapped" while asserting only two index comparisons. It now calls `dockedRule(RECEIPT_GRID_SELECTOR)` (the helper that throws on an `@media`/`@supports` wrapper) and bounds the gap between the two rules by both character distance and brace count.
  - `[low]` `[patch]` The undocked grid test called `getComputedStyle(grid as Element)` with no null guard, so a renamed hook would fail with an opaque `TypeError`. Guard added, matching its sibling; unused `async` dropped from both new grid tests.
  - `[low]` `[patch]` Redundant render condition — `listing?.truncated` already implies `listing !== null`. Reduced to `!historyLoading && listing?.truncated && listing.revisions.length > 0`.

## Design Notes

The two halves share one shape: a bound that is already enforced, reported at the surface that reads it.

The reflow must be a second rule, not a declaration added to the DW-39 rule — that rule targets the note, which is not a grid container. Both rules keyed on the same `.wb-shell[data-preview="true"]` ancestor is the point: one attribute, two consequences, adjacent in source.

```css
.wb-shell[data-preview="true"] .wb-canvas-preview-note { display: none; }
.wb-shell[data-preview="true"] .wb-canvas-receipt-grid {
  grid-template-columns: minmax(0, 1fr);
}
```

For the cap, `truncated` means "this listing is AT the bound", which is exactly what a reader needs and all the server can prove. The sentence follows `FILES_TRUNCATED_COPY`'s register — state the cap, state the consequence — but takes its numeral from the wire rather than a client constant, because the cap lives in a module the browser bundle must not pull.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/wiki-artifact-revisions.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/workbench-split.test.ts src/lib/__tests__/create-wiki-ui.test.ts src/components/workbench/__tests__/preview-revision-history.test.tsx src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- expected: all pass
- `npm test` -- expected: no new failures against the pre-change baseline
- `npx tsc --noEmit` -- expected: clean
- `npx eslint src/components/WikiWorkbench.tsx src/components/workbench/PreviewColumn.tsx src/lib/workbench-preview.ts src/app/api/workbench/artifact/revisions/route.ts` -- expected: clean

## Auto Run Result

Status: done

**Implemented change.** Two surface-honesty fixes from the `canvas-reflow-and-revision-cap` bundle (DW-180, DW-541).

DW-180: the Wiki canvas receipt card sat in a two-track grid whose second track was still claimed after the DW-39 rule hid the preview note, so a docked Preview stranded the card at 320px beside blank space. The wrapper gained a `wb-canvas-receipt-grid` hook and a second rule, keyed on the same `.wb-shell[data-preview="true"]` ancestor and sitting immediately after its sibling, collapses the grid to one full-width track. A second rule rather than a declaration on the first, because that one targets the note, which is not the grid container.

DW-541: `GET /api/workbench/artifact/revisions` answered a bare `{ revisions }` bounded by the retention cap, and the History panel rendered it as a complete-looking list. The envelope now carries `limit` and `truncated` siblings — `ArtifactRevision`'s row shape untouched — `fetchArtifactRevisions` carries both through, and the panel prints one owned sentence above the list when the listing is at the cap. `truncated` is counted from the canonical stems before any per-revision I/O, so a snapshot the lister could not `stat` cannot withdraw the notice.

**Files changed.**
- `src/components/WikiWorkbench.tsx` — `wb-canvas-receipt-grid` hook on the receipt grid wrapper; header doc-comment records the attribute's second consequence.
- `src/app/globals.css` — the docked receipt-grid rule, beside the DW-39 rule, unwrapped and ahead of `.wb-split-handle {`.
- `src/lib/wiki-artifact-revisions.ts` — `listWikiArtifactRevisionsPage` returns `{ revisions, truncated }` with `truncated` counted from the stems; `listWikiArtifactRevisions` is now a thin delegate with an unchanged signature and return shape.
- `src/app/api/workbench/artifact/revisions/route.ts` — the listing answers `{ revisions, limit, truncated }`, reporting the lister's flag verbatim.
- `src/lib/workbench-preview.ts` — `previewHistoryTruncatedCopy(limit)`; `ArtifactRevisionsResult`'s `ok` variant widened; `fetchArtifactRevisions` reads both siblings, defaulting absent or unusable values to `false`/`null`.
- `src/components/workbench/PreviewColumn.tsx` — the landed listing held as one object so rows and truncation state cannot desync; the note rendered above the list.
- Tests: `src/lib/__tests__/wiki-artifact-revisions.test.ts`, `src/lib/__tests__/workbench-preview.test.ts`, `src/lib/__tests__/create-wiki-ui.test.ts`, `src/components/workbench/__tests__/preview-revision-history.test.tsx`, `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` (the rule-slicing helper generalised to any selector so the new rule is exercised from the stylesheet's own bytes).

**Review findings breakdown.** 7 patches applied (2 medium, 5 low), 0 deferred, 12 rejected. Notable rejections: closing the DW ledger entries (this run is forbidden to edit the ledger — the orchestrator records resolution); adopting `backups.ts`'s optional `truncated?: true` + reason idiom (DW-541's own entry asks for `limit`/`truncated` siblings); naming the artifact in the truncation sentence; hoisting a shared `Intl.NumberFormat`; per-test stylesheet injection; leaving the note standing beside a failed re-list (it describes the rows that are still on screen, so it is consistent rather than stale); and pinning the card's docked max-width (the intent's decision authorized full width, and the spec forbids restyling the card).

**Follow-up review recommendation.** Patched findings: 0 high, 2 medium, 5 low. Score = 3x2 + 1x5 = 11, which is >= 5, so `followup_review_recommended: true`.

**Verification performed.**
- `npx vitest run` over the six touched test files: 484 passed, 0 failed.
- `npx tsc --noEmit`: clean.
- `npx eslint` over the five changed source files: clean.
- `npm test`: 362 of 363 files pass. The one failure is `src/lib/__tests__/storage-fs.test.ts`'s `reapStrandedScratchFiles` cases, which plant scratch files at a fixed mtime age and assert against a wall-clock grace window. It reproduces on the unmodified baseline (verified by stashing this work and re-running the full suite), and the file passes 95/95 in isolation. Nothing in this change imports that module.
- Matrix test audit: all eight I/O rows are covered by tests that ran and passed — the two CSS rows in `wiki-canvas-duplication.test.tsx`, the two route rows in `wiki-artifact-revisions.test.ts`, and the wire and panel rows across `workbench-preview.test.ts` and `preview-revision-history.test.tsx`.

**Residual risks.**
- The CSS fix's load-bearing cascade claim — that this unlayered rule beats the element's layered `lg:grid-cols-[...]` Tailwind utility — is true of the current `@import "tailwindcss"` setup but is asserted in prose, not exercised: jsdom loads no Tailwind, so the docked test proves the override applies without the competing declaration present. The repository's e2e suite is API-level and has no browser-layout tier to close this in.
- `truncated` means "this listing is at the retention bound". An artifact sitting at exactly the cap with nothing yet pruned shows the note — a false positive in the safe direction, since the sentence claims only that older versions are not kept. The inverse is not survivable: a pruned history holds exactly the cap, so anything stricter than `>=` would report every swept history as whole.
